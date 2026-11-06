// O payload de downloads em segundo plano (app/native/bg_downloader.c), compilado para o desktop (Linux) e rodado
// de verdade contra um servidor HTTP local com Range/If-Range/ETag e um TorBox falso: token obrigatorio e so em
// 127.0.0.1, uma copia so, varias conexoes com sha256, retomada depois de matar o processo (a fila sobrevive),
// sha256 errado recusado, link vencido trocado por um novo do TorBox preservando a parcial, e um arquivo > 4 GB
// (esparso: so as faixas depois dos 4 GB sao baixadas). Precisa de cc e dos cabecalhos do libcurl e do OpenSSL;
// sem eles o teste e pulado. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, openSync, ftruncateSync, closeSync, readSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-bgdl-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
// Sem os cabecalhos do libcurl/OpenSSL o teste e pulado; qualquer outro erro de compilacao (um aviso, com -Werror) falha.
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|cannot find -lcurl|cannot find -lcrypto/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL headers' : built.status !== 0 ? 'did not compile (see the test above)' : false;
const MiB = 1024 * 1024;
const KEY = 'TESTKEY-1234567890abcdef-0000';
const children = new Set();
let server;
after(() => {
  for (const child of children) child.kill('SIGKILL');
  // fetch mantem conexoes vivas (keep-alive): sem fecha-las, o servidor segura o node e o teste nunca termina.
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

// O servidor: /f/<nome> (ETag forte), /t/<token>/<nome> (403 depois que os tokens vencem), /v1/api/webdl/requestdl
// (o TorBox falso), /big.bin (virtual, 4 GiB + 40 MiB). `rate` limita cada resposta (bytes/s).
const files = { 'a.bin': randomBytes(40 * MiB) };
const BIG = 4 * 1024 ** 3 + 40 * MiB;
const block = randomBytes(MiB);
const bigSlice = (start, end) => { const out = Buffer.alloc(end - start); for (let p = start; p < end;) { const off = p % MiB, n = Math.min(MiB - off, end - p); block.copy(out, p - start, off, off + n); p += n; } return out; };
const srv = { rate: 0, tokens: new Set(), served: {}, requestdl: 0 };
let port, api;
if (!skip) {
  port = await freePort();
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.endsWith('/requestdl')) {
      srv.requestdl++;
      if (url.searchParams.get('token') !== KEY) { res.writeHead(403); return res.end('{"success":false,"error":"BAD_TOKEN"}'); }
      const token = randomBytes(6).toString('hex');
      srv.tokens.add(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // glibren.6: como o TorBox de verdade (05/11/2026), o link leva a chave da conta em token=.
      return res.end(JSON.stringify({ success: true, data: `http://127.0.0.1:${port}/t/${token}/${url.searchParams.get('file_id')}.bin?token=${KEY}` }));
    }
    const parts = url.pathname.split('/').filter(Boolean);
    let name = parts[parts.length - 1];
    if (parts[0] === 't' && !srv.tokens.has(parts[1])) { res.writeHead(403); return res.end('expired'); }
    const size = name === 'big.bin' ? BIG : files[name]?.length;
    if (size === undefined) { res.writeHead(404); return res.end(); }
    const etag = `"e-${name}-${size}"`;
    let start = 0, end = size - 1, partial = false;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) { start = Number(range[1]); end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1); partial = true; }
    res.writeHead(partial ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, ETag: etag, ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    for (let p = start; p <= end && !res.destroyed;) {
      const n = Math.min(64 * 1024, end - p + 1);
      const chunk = name === 'big.bin' ? bigSlice(p, p + n) : files[name].subarray(p, p + n);
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      srv.served[name] = (srv.served[name] || 0) + n;
      p += n;
      if (srv.rate) await wait(n / srv.rate * 1000);
    }
    res.end();
  }).listen(port, '127.0.0.1');
  api = await freePort();
}

let run = 0;
function workspace() {
  const base = path.join(dir, `run${++run}`);
  mkdirSync(path.join(base, 'state'), { recursive: true });
  mkdirSync(path.join(base, 'disk/downloads'), { recursive: true });
  return base;
}
function start(base, env = {}) {
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_TORBOX_BASE: `http://127.0.0.1:${port}/v1/api`, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
async function call(base, method, route, body, token) {
  const tok = token ?? readFileSync(path.join(base, 'state/token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': tok, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function up(base) {
  for (let i = 0; i < 100; i++) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call(base, 'GET', '/health')).status === 200) return; } catch {}
    await wait(50);
  }
  throw new Error('payload did not start');
}
async function until(base, id, states, check = () => true, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    let job;
    try { job = (await call(base, 'GET', '/jobs')).data.jobs.find((item) => item.id === id); } catch { continue; }
    if (job && states.includes(job.state) && check(job)) return job;
  }
  throw new Error(`job ${id} never reached ${states}`);
}
// Declarado so depois dos awaits do topo: um test() antes deles faz o node:test encerrar a raiz cedo (e o after()
// apagar a pasta do binario antes dos outros testes).
test('bg_downloader.c compila sem avisos (-Wall -Wextra -Werror)', { skip: !compiler || missing ? 'no compiler or headers' : false }, () => {
  assert.equal(built.status, 0, built.stderr);
});
const stop = (child) => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); });

test('token obrigatorio em toda chamada, e so em 127.0.0.1', { skip }, async () => {
  const base = workspace();
  const child = start(base);
  await up(base);
  assert.equal((await call(base, 'GET', '/health', undefined, '')).status, 401);
  assert.equal((await call(base, 'GET', '/jobs', undefined, '0'.repeat(64))).status, 401);
  assert.equal((await call(base, 'GET', '/health')).status, 200);
  assert.equal(statSync(path.join(base, 'state/token')).mode & 0o777, 0o600);
  await stop(child);
});

test('uma copia so: a nova pede para a antiga sair e fica com o lock', { skip }, async () => {
  const base = workspace();
  const first = start(base);
  await up(base);
  const second = start(base);
  await new Promise((resolve) => first.once('exit', resolve));
  await up(base);
  assert.equal((await call(base, 'GET', '/health')).data.pid, second.pid);
  assert.equal(Number(readFileSync(path.join(base, 'state/bgdl.pid'), 'utf8')), second.pid);
  await stop(second);
});

test('varias conexoes, sha256 conferido, recibo .complete no formato do motor; sha errado recusado', { skip }, async () => {
  const base = workspace();
  const child = start(base);
  await up(base);
  const dest = path.join(base, 'disk/downloads/a.bin');
  const { data } = await call(base, 'POST', '/jobs', { url: `http://127.0.0.1:${port}/f/a.bin`, destination: dest, storageRoot: path.join(base, 'disk'), rangeBytes: 16 * MiB, connections: 4, sha256: sha(files['a.bin']), expectedBytes: files['a.bin'].length });
  const job = await until(base, data.id, ['completed', 'failed']);
  assert.equal(job.state, 'completed', job.error);
  assert.equal(sha(readFileSync(dest)), sha(files['a.bin']));
  const receipt = readFileSync(`${dest}.complete`);
  assert.equal(receipt.length, 168);
  assert.equal(receipt.subarray(0, 8).toString(), 'PS5DONE1');
  assert.equal(receipt.subarray(73, 137).toString(), sha(files['a.bin']));
  assert.ok(!existsSync(`${dest}.part`) && !existsSync(`${dest}.resume`));
  const wrong = path.join(base, 'disk/downloads/wrong.bin');
  const bad = await call(base, 'POST', '/jobs', { url: `http://127.0.0.1:${port}/f/a.bin`, destination: wrong, storageRoot: path.join(base, 'disk'), sha256: '0'.repeat(64) });
  const failed = await until(base, bad.data.id, ['completed', 'failed']);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /SHA-256 mismatch/);
  assert.ok(!existsSync(wrong));
  await stop(child);
});

test('retomada por Range depois de matar o processo no meio: a fila volta e so o que faltava e baixado', { skip }, async () => {
  const base = workspace();
  // 1 MiB/s por conexao, 2 conexoes: as duas primeiras faixas (16 MiB) fecham em ~16 s; a ultima (8 MiB) ainda nao.
  srv.rate = MiB;
  let child = start(base);
  await up(base);
  const dest = path.join(base, 'disk/downloads/r.bin');
  const { data } = await call(base, 'POST', '/jobs', { url: `http://127.0.0.1:${port}/f/a.bin`, destination: dest, storageRoot: path.join(base, 'disk'), rangeBytes: 16 * MiB, connections: 2, sha256: sha(files['a.bin']) });
  await until(base, data.id, ['downloading'], (job) => job.written > 33 * MiB);
  await wait(5500); // um checkpoint (a cada 5 s)
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  srv.rate = 0;
  const checkpoint = readFileSync(`${dest}.resume`);
  assert.equal(checkpoint.subarray(0, 8).toString(), 'P5RDL001');
  const missing = [...checkpoint.subarray(96)].reduce((sum, done, i) => sum + (done ? 0 : Math.min(16 * MiB, files['a.bin'].length - i * 16 * MiB)), 0);
  assert.ok(missing < files['a.bin'].length, 'alguma faixa ja estava salva');
  const before = srv.served['a.bin'];
  child = start(base);
  await up(base);
  const job = await until(base, data.id, ['completed', 'failed']);
  assert.equal(job.state, 'completed', job.error);
  assert.equal(sha(readFileSync(dest)), sha(files['a.bin']));
  assert.equal(srv.served['a.bin'] - before, missing + 1, 'so as faixas que faltavam (+1 byte da sonda)');
  await stop(child);
});

test('link vencido (403): pede outro ao TorBox com a chave e continua a mesma parcial; a chave nao vai para o diario', { skip }, async () => {
  const base = workspace();
  writeFileSync(path.join(base, 'debrid.json'), JSON.stringify({ torbox: { key: KEY } }));
  srv.tokens.add('first');
  srv.rate = 3 * MiB;
  const child = start(base, { BGDL_KEYFILE: path.join(base, 'debrid.json') });
  await up(base);
  const dest = path.join(base, 'disk/downloads/t.bin');
  const before = srv.served['a.bin'] || 0;
  const { data } = await call(base, 'POST', '/jobs', { url: `http://127.0.0.1:${port}/t/first/a.bin`, destination: dest, storageRoot: path.join(base, 'disk'), rangeBytes: 16 * MiB, connections: 2, sha256: sha(files['a.bin']), source: { provider: 'torbox', kind: 'webdl', id: 1, fileId: 'a' } });
  await until(base, data.id, ['downloading'], (job) => job.written > 18 * MiB);
  srv.tokens.clear();
  srv.rate = 0;
  const job = await until(base, data.id, ['completed', 'failed', 'needs-app']);
  assert.equal(job.state, 'completed', job.error);
  assert.ok(job.renewals >= 1 && !job.url.includes('first'));
  assert.equal(sha(readFileSync(dest)), sha(files['a.bin']));
  assert.ok(srv.served['a.bin'] - before < files['a.bin'].length + 2 * 16 * MiB, 'a parcial foi aproveitada');
  assert.ok(!readFileSync(path.join(base, 'state/bgdl.log'), 'utf8').includes(KEY));
  assert.ok(!readFileSync(path.join(base, 'state/jobs.json'), 'utf8').includes(KEY));
  await stop(child);
});

test('glibren.6: o jobs.json guarda o link do TorBox sem a chave (token=); ao reabrir, pede outro link e termina a parcial', { skip }, async () => {
  const base = workspace();
  writeFileSync(path.join(base, 'debrid.json'), JSON.stringify({ torbox: { key: KEY } }));
  srv.tokens.add('second');
  srv.rate = 3 * MiB;
  const env = { BGDL_KEYFILE: path.join(base, 'debrid.json') };
  let child = start(base, env);
  await up(base);
  const dest = path.join(base, 'disk/downloads/k.bin');
  const { data } = await call(base, 'POST', '/jobs', { url: `http://127.0.0.1:${port}/t/second/a.bin?token=${KEY}`, destination: dest, storageRoot: path.join(base, 'disk'), rangeBytes: 16 * MiB, connections: 2, sha256: sha(files['a.bin']), source: { provider: 'torbox', kind: 'webdl', id: 1, fileId: 'a' } });
  await until(base, data.id, ['downloading'], (job) => job.written > 18 * MiB);
  await stop(child);
  const saved = readFileSync(path.join(base, 'state/jobs.json'), 'utf8');
  assert.ok(!saved.includes(KEY), 'a chave nao fica no disco');
  const kept = JSON.parse(saved).jobs.find((job) => job.id === data.id);
  assert.match(kept.url, /\/t\/second\/a\.bin\?token=$/);
  srv.rate = 0;
  const asked = srv.requestdl;
  child = start(base, env);
  await up(base);
  const job = await until(base, data.id, ['completed', 'failed', 'needs-app']);
  assert.equal(job.state, 'completed', job.error);
  assert.ok(srv.requestdl > asked, 'pediu um link novo ao TorBox');
  assert.equal(sha(readFileSync(dest)), sha(files['a.bin']));
  assert.ok(!readFileSync(path.join(base, 'state/jobs.json'), 'utf8').includes(KEY));
  assert.ok(!readFileSync(path.join(base, 'state/bgdl.log'), 'utf8').includes(KEY));
  await stop(child);
});

test('arquivo > 4 GB: retoma uma parcial esparsa e baixa so as faixas depois dos 4 GB', { skip }, async () => {
  const base = workspace();
  const root = path.join(base, 'disk');
  const dest = path.join(root, 'downloads/big.bin');
  const rb = 16 * MiB, count = Math.ceil(BIG / rb), done = 257;
  const st = statSync(root, { bigint: true });
  const identity = createHash('sha256');
  for (const value of ['etag:"e-big.bin-' + BIG + '"', '', String(BIG)]) identity.update(Buffer.concat([Buffer.from(value), Buffer.alloc(1)]));
  identity.update(`${st.dev}:${st.ino}`);
  const header = Buffer.alloc(96);
  header.write('P5RDL001', 0);
  header.writeBigUInt64LE(BigInt(BIG), 8);
  header.writeBigUInt64LE(BigInt(rb), 16);
  header.writeUInt32LE(count, 24);
  header.write(identity.digest('hex'), 28);
  writeFileSync(`${dest}.resume`, Buffer.concat([header, Buffer.from([...Array(count)].map((_, i) => i < done ? 1 : 0))]));
  const fd = openSync(`${dest}.part`, 'w');
  ftruncateSync(fd, done * rb);
  closeSync(fd);
  const child = start(base);
  await up(base);
  const before = srv.served['big.bin'] || 0;
  const { data } = await call(base, 'POST', '/jobs', { url: `http://127.0.0.1:${port}/f/big.bin`, destination: dest, storageRoot: root, rangeBytes: rb, expectedBytes: BIG });
  const job = await until(base, data.id, ['completed', 'failed'], () => true, 120000);
  assert.equal(job.state, 'completed', job.error);
  assert.equal(statSync(dest).size, BIG);
  assert.equal(srv.served['big.bin'] - before, BIG - done * rb + 1);
  const tail = Buffer.alloc(BIG - done * rb);
  const read = openSync(dest, 'r');
  readSync(read, tail, 0, tail.length, done * rb);
  closeSync(read);
  assert.ok(tail.equals(bigSlice(done * rb, BIG)), 'os bytes depois dos 4 GB estao no lugar certo');
  await stop(child);
});

// ---- glibren: a pagina do celular na porta 34201 (0.0.0.0) ----

let monitorPort = 0; // escolhida em cada teste (um await aqui fora encerraria a raiz do node:test cedo)
const PIN = '246810';
const pinConfig = (pin = PIN) => { const salt = randomBytes(32).toString('hex'); return { pinSalt: salt, pinHash: sha(`${salt}:${pin}`) }; };
async function page(route, { method = 'GET', body, session } = {}) {
  const res = await fetch(`http://127.0.0.1:${monitorPort}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Session': session } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text, type: res.headers.get('content-type'), length: Number(res.headers.get('content-length')), csp: res.headers.get('content-security-policy') || '', referrer: res.headers.get('referrer-policy') || '' };
}
async function pageUp() {
  for (let i = 0; i < 100; i++) { try { if ((await page('/api/status')).status === 200) return; } catch {} await wait(50); }
  throw new Error('monitor did not start');
}
// Le a resposta devagar, 512 bytes de cada vez, como um celular numa Wi-Fi ruim: tem de chegar inteira.
const slowRead = () => new Promise((resolve, reject) => {
  const socket = net.connect(monitorPort, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
  const chunks = [];
  socket.on('data', (chunk) => { chunks.push(chunk); socket.pause(); setTimeout(() => socket.resume(), 5); });
  socket.setTimeout(20000, () => reject(new Error('slow read timed out')));
  socket.on('end', () => { socket.end(); resolve(Buffer.concat(chunks)); });
  socket.on('error', reject);
});

test('pagina do celular: a tela embutida inteira (leitura lenta), status sem segredos, PIN certo/errado/bloqueio, controles remotos', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  srv.rate = 2 * MiB;
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_SESSION_SECONDS: '2', BGDL_NOTIFY_FILE: path.join(base, 'notify.txt') });
  await up(base);
  await pageUp();
  const html = await slowRead();
  const head = html.subarray(0, html.indexOf('\r\n\r\n')).toString();
  const declared = Number(/Content-Length: (\d+)/i.exec(head)[1]);
  assert.equal(html.length - head.length - 4, declared, 'o corpo chega inteiro, do tamanho anunciado');
  assert.equal(declared, readFileSync(path.join(repo, 'app/native/bg_monitor.html')).length);
  assert.match(head, /Cache-Control: no-store/);
  // Sem PIN: ve, mas os controles respondem que falta o PIN.
  assert.equal((await page('/api/status')).data.pinSet, false);
  assert.deepEqual((await page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data, { noPin: true, retryIn: 0 });
  assert.equal((await call(base, 'POST', '/config', { ...pinConfig(), monitorText: 'Siga em {address}' })).status, 200);
  const dest = path.join(base, 'disk/downloads/m.bin');
  const secretUrl = `http://127.0.0.1:${port}/f/a.bin?token=SECRET-TOKEN`;
  const { data } = await call(base, 'POST', '/jobs', { url: secretUrl, destination: dest, storageRoot: path.join(base, 'disk'), name: 'Jogo Teste', connections: 2 });
  await until(base, data.id, ['downloading'], (job) => job.written > 0);
  const status = await page('/api/status');
  assert.equal(status.data.pinSet, true);
  assert.deepEqual(Object.keys(status.data.jobs[0]).sort(), ['by', 'bytesPerSecond', 'connections', 'connectionsActive', 'connectionsSet', 'error', 'file', 'host', 'id', 'name', 'state', 'total', 'written']);
  assert.equal(status.data.jobs[0].file, 'm.bin', 'glibren.12: so o nome base do arquivo, sem a pasta');
  assert.equal(status.data.jobs[0].host, '127.0.0.1', 'glibren.12: so o site do link (aqui um IP), sem porta, caminho ou consulta');
  assert.equal(status.data.jobs[0].name, 'Jogo Teste');
  assert.ok(!('via' in status.data.jobs[0]), 'um link direto nao diz via');
  for (const secret of ['SECRET-TOKEN', '/f/a.bin', dest, path.join(base, 'disk')]) assert.ok(!status.text.includes(secret), `a pagina nao ve ${secret}`);
  // Sem sessao, nada muda.
  assert.equal((await page(`/api/jobs/${data.id}/pause`, { method: 'POST' })).status, 401);
  const ok = await page('/api/unlock', { method: 'POST', body: { pin: PIN } });
  assert.equal(ok.status, 200);
  assert.match(ok.data.session, /^[0-9a-f]{32}$/);
  assert.equal((await page(`/api/jobs/${data.id}/pause`, { method: 'POST', session: ok.data.session })).status, 200);
  let job = await until(base, data.id, ['paused']);
  assert.equal(job.by, 'remote', 'o app sabe que a pausa veio do celular');
  assert.equal((await page(`/api/jobs/${data.id}/resume`, { method: 'POST', session: ok.data.session })).status, 200);
  job = await until(base, data.id, ['downloading', 'queued', 'connecting']);
  assert.equal(job.by, 'remote', 'glibren.8: a retomada do celular tambem fica marcada, ate o app confirmar');
  assert.equal((await page(`/api/jobs/${data.id}/cancel`, { method: 'POST', session: ok.data.session })).status, 200);
  job = await until(base, data.id, ['cancelled']);
  assert.equal(job.by, 'remote');
  for (let i = 0; i < 50 && existsSync(`${dest}.part`); i++) await wait(100);
  assert.ok(!existsSync(`${dest}.part`), 'cancelar pelo celular apaga a parcial');
  assert.ok(!(await page('/api/status')).data.jobs.some((item) => item.id === data.id), 'um cancelado sai da pagina');
  assert.equal((await page('/api/jobs/b999/pause', { method: 'POST', session: ok.data.session })).status, 404);
  assert.equal((await page(`/api/jobs/${data.id}/forget`, { method: 'POST', session: ok.data.session })).status, 404, 'o celular so pausa, retoma e cancela');
  // A sessao vence (2 s neste teste; 12 h de verdade).
  await wait(2200);
  assert.equal((await page(`/api/jobs/${data.id}/resume`, { method: 'POST', session: ok.data.session })).status, 401);
  // PIN errado: 4 tentativas livres, a 5a bloqueia por 30 s, e nem o certo passa enquanto isso.
  for (let i = 1; i <= 4; i++) assert.deepEqual((await page('/api/unlock', { method: 'POST', body: { pin: '111111' } })).data, { retryIn: 0 });
  const blocked = await page('/api/unlock', { method: 'POST', body: { pin: '111111' } });
  assert.equal(blocked.status, 403);
  assert.ok(blocked.data.retryIn >= 29, JSON.stringify(blocked.data));
  assert.ok((await page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data.retryIn > 0);
  assert.equal((await page('/api/unlock', { method: 'POST', body: { pin: 'abc' } })).status, 400);
  // A notificacao com o endereco saiu uma vez, quando o primeiro download chegou.
  assert.match(readFileSync(path.join(base, 'notify.txt'), 'utf8'), new RegExp(`Siga em http://[\\d.]+:${monitorPort}`));
  const log = readFileSync(path.join(base, 'state/bgdl.log'), 'utf8');
  assert.ok(!log.includes(PIN) && !log.includes(ok.data.session), 'nem PIN nem sessao no diario');
  srv.rate = 0;
  await stop(child);
});

test('pagina do celular desligada: a porta fecha; ligada de novo, volta; um PIN novo derruba as sessoes', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort) });
  await up(base);
  await pageUp();
  assert.equal((await call(base, 'POST', '/config', pinConfig())).status, 200);
  const { session } = (await page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data;
  assert.ok(session);
  assert.equal((await call(base, 'POST', '/config', pinConfig('135792'))).status, 200);
  assert.equal((await page('/api/jobs/b1/pause', { method: 'POST', session })).status, 401, 'PIN trocado: a sessao antiga nao vale');
  assert.equal((await call(base, 'POST', '/config', { monitor: false })).data.monitor, false);
  await wait(800);
  await assert.rejects(page('/api/status'), 'porta fechada');
  assert.equal((await call(base, 'POST', '/config', { monitor: true })).status, 200);
  await pageUp();
  const health = (await call(base, 'GET', '/health')).data;
  assert.equal(health.monitor, true);
  assert.equal(health.monitorPort, monitorPort);
  assert.equal(health.pinSet, true);
  assert.equal((await call(base, 'POST', '/config', { pinSalt: 'x', pinHash: 'y' })).status, 400, 'sal/hash invalidos sao recusados');
  const saved = JSON.parse(readFileSync(path.join(base, 'state/config.json'), 'utf8'));
  assert.equal(saved.monitor, true);
  assert.match(saved.pinHash, /^[0-9a-f]{64}$/);
  assert.equal(statSync(path.join(base, 'state/config.json')).mode & 0o777, 0o600);
  await stop(child);
});

// ---- glibren: a fila do app entregue com antecedencia (POST /queue) ----

const small = (name, size = 3 * MiB) => { files[name] = randomBytes(size); return name; };
// glibren.8: chaves como as do app (download-queue.js: "<jogo>/<release>"), com a barra que o payload recusava.
const queued = (base, name, extra = {}) => ({ key: `PPSA01234/k-${name.replace(/\W/g, '')}`, name, total: files[name]?.length || 0, job: { url: `http://127.0.0.1:${port}/f/${name}`, destination: path.join(base, 'disk/downloads', name), storageRoot: path.join(base, 'disk'), connections: 1, expectedBytes: files[name]?.length || 0, ...extra } });
async function statusUntil(check, ms = 60000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) {
    try { last = (await page('/api/status')).data; if (check(last)) return last; } catch {}
  }
  throw new Error(`status never got there: ${JSON.stringify(last)}`);
}

test('fila entregue: com o app fechado, N=1 baixa um depois do outro na ordem; o item de site fica waiting-app', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  ['q1.bin', 'q2.bin', 'q3.bin'].forEach((name) => small(name));
  srv.rate = 6 * MiB;
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_APP_SILENCE_MS: '600' });
  await up(base);
  await pageUp();
  const answer = await call(base, 'POST', '/queue', { items: [queued(base, 'q1.bin'), { key: 'PPSA09999/mediafire-1', name: 'Jogo do MediaFire', total: 5000 }, queued(base, 'q2.bin'), queued(base, 'q3.bin')] });
  assert.equal(answer.status, 200);
  assert.deepEqual([answer.data.created, answer.data.waiting], [3, 1]);
  assert.equal((await call(base, 'POST', '/queue', { items: [{ key: 'tem "aspas"', name: 'x', total: 1 }] })).status, 400, 'aspas na chave: recusada');
  assert.equal((await call(base, 'POST', '/queue', { items: [queued(base, 'q1.bin'), { key: 'PPSA09999/mediafire-1', name: 'Jogo do MediaFire', total: 5000 }, queued(base, 'q2.bin'), queued(base, 'q3.bin')] })).status, 200);
  // Daqui em diante o "app" fica calado (fechado): so a pagina do celular, sem token, e consultada.
  const done = [];
  let most = 0;
  const final = await statusUntil((status) => {
    most = Math.max(most, status.jobs.filter((job) => ['connecting', 'downloading', 'verifying'].includes(job.state)).length);
    for (const job of status.jobs) if (job.state === 'completed' && !done.includes(job.name)) done.push(job.name);
    return done.length === 3;
  });
  assert.deepEqual(done, ['q1.bin', 'q2.bin', 'q3.bin'], 'na ordem da fila do app');
  assert.equal(most, 1, 'um de cada vez (N=1)');
  const waiting = final.jobs.find((job) => job.name === 'Jogo do MediaFire');
  assert.deepEqual([waiting.state, waiting.total], ['waiting-app', 5000]);
  for (const name of ['q1.bin', 'q2.bin', 'q3.bin']) assert.equal(sha(readFileSync(path.join(base, 'disk/downloads', name))), sha(files[name]));
  srv.rate = 0;
  await stop(child);
});

test('fila entregue: com o app aberto nada comeca sozinho (so com follow); reordenar e retirar refletem no payload', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  ['r1.bin', 'r2.bin', 'r3.bin'].forEach((name) => small(name, MiB));
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_APP_SILENCE_MS: '1500' });
  await up(base);
  await pageUp();
  await call(base, 'POST', '/queue', { items: [queued(base, 'r1.bin'), queued(base, 'r2.bin')] });
  for (let i = 0; i < 8; i++) { await wait(100); await call(base, 'GET', '/health'); } // o app esta aberto
  let jobs = (await call(base, 'GET', '/jobs')).data.jobs;
  assert.ok(jobs.every((job) => job.state === 'queued' && job.ahead), 'com o app aberto, quem comeca e o app');
  const r1 = jobs.find((job) => job.name === 'r1.bin');
  assert.equal((await call(base, 'POST', `/jobs/${r1.id}/follow`)).status, 200);
  await until(base, r1.id, ['completed']);
  await call(base, 'POST', '/queue', { items: [queued(base, 'r3.bin'), queued(base, 'r2.bin')] });
  jobs = (await call(base, 'GET', '/jobs')).data.jobs;
  assert.deepEqual(['r3.bin', 'r2.bin'].map((name) => jobs.find((job) => job.name === name).order), [1, 2], 'a nova ordem do app');
  const answer = await call(base, 'POST', '/queue', { items: [queued(base, 'r3.bin')] });
  assert.equal(answer.data.removed, 1);
  jobs = (await call(base, 'GET', '/jobs')).data.jobs;
  assert.ok(!jobs.some((job) => job.name === 'r2.bin'), 'cancelado/pausado no app: sai da fila do payload');
  assert.ok(jobs.some((job) => job.name === 'r1.bin' && job.state === 'completed'), 'o terminado fica para o app conferir ao abrir');
  // O app fecha: r3 segue sozinho.
  await statusUntil((status) => status.jobs.some((job) => job.name === 'r3.bin' && job.state === 'completed'));
  assert.ok(!existsSync(path.join(base, 'disk/downloads/r2.bin')) && !existsSync(path.join(base, 'disk/downloads/r2.bin.part')));
  await stop(child);
});

test('fila entregue: sem espaco no disco vira needs-app; link vencido (403) vira needs-app sem repetir', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  small('s1.bin', MiB);
  let child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_APP_SILENCE_MS: '300', BGDL_FAKE_FREE_BYTES: '1000' });
  await up(base);
  await pageUp();
  await call(base, 'POST', '/queue', { items: [queued(base, 's1.bin')] });
  const full = await statusUntil((status) => status.jobs.some((job) => job.state === 'needs-app'));
  assert.match(full.jobs[0].error, /Not enough space/);
  assert.ok(!existsSync(path.join(base, 'disk/downloads/s1.bin.part')), 'nem comecou');
  await stop(child);
  const other = workspace();
  child = start(other, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_APP_SILENCE_MS: '300' });
  await up(other);
  await pageUp();
  await call(other, 'POST', '/queue', { items: [{ key: 'kgone', name: 'gone', total: MiB, job: { url: `http://127.0.0.1:${port}/t/vencido/gone.bin`, destination: path.join(other, 'disk/downloads/gone.bin'), storageRoot: path.join(other, 'disk') } }] });
  const expired = await statusUntil((status) => status.jobs.some((job) => ['needs-app', 'failed'].includes(job.state)));
  assert.equal(expired.jobs[0].state, 'needs-app', 'a Jobee\'sLair renova ao abrir');
  await wait(1500);
  assert.equal((await page('/api/status')).data.jobs[0].state, 'needs-app', 'sem repetir sozinho');
  await stop(child);
});

// glibren-fechar: fechar a Jobee'sLair com o payload baixando travou o console (relato de 04/11/2026, sem diario).
// Defesa: ao perceber o fechamento o payload fica quieto (sem rede nem disco) por um tempo e volta devagar; o diario
// registra o fechamento, o modo quieto, se a sessao anterior terminou limpa, e a saida limpa.
test('fechar o app: modo quieto sem rede, volta sozinho e termina; diario com fechamento, sessao anterior e saida limpa', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const flag = path.join(base, 'app-running');
  writeFileSync(flag, '');
  small('close.bin', 12 * MiB);
  srv.rate = 2 * MiB;
  const env = { BGDL_MONITOR_PORT: String(monitorPort), BGDL_APP_RUNNING: flag, BGDL_QUIET_MS: '3000', BGDL_APP_SILENCE_MS: '600000' };
  let child = start(base, env);
  await up(base);
  const dest = path.join(base, 'disk/downloads/close.bin');
  const { data } = await call(base, 'POST', '/jobs', { url: `http://127.0.0.1:${port}/f/close.bin`, destination: dest, storageRoot: path.join(base, 'disk'), rangeBytes: 4 * MiB, connections: 2, expectedBytes: files['close.bin'].length });
  await until(base, data.id, ['downloading'], (job) => job.written > MiB);
  // O app fecha: em ate ~1 s o payload solta as conexoes e para de baixar.
  rmSync(flag);
  await wait(1600);
  const quietJob = (await call(base, 'GET', '/jobs')).data.jobs.find((job) => job.id === data.id);
  assert.equal(quietJob.connectionsActive, 0, 'sem conexoes no modo quieto');
  assert.notEqual(quietJob.state, 'completed', 'ainda nao terminou (estava quieto)');
  const before = srv.served['close.bin'] || 0;
  await wait(1000);
  assert.ok((srv.served['close.bin'] || 0) - before < 512 * 1024, 'nada baixado no modo quieto');
  srv.rate = 0;
  const job = await until(base, data.id, ['completed', 'failed']);
  assert.equal(job.state, 'completed', job.error);
  assert.equal(sha(readFileSync(dest)), sha(files['close.bin']));
  let log = readFileSync(path.join(base, 'state/bgdl.log'), 'utf8');
  for (const line of ['sessao anterior: nenhuma', 'app aberto ao iniciar', 'app FECHOU (sceLncUtilGetAppId): modo quieto por 3 s',
    `job ${data.id}: quieto (o app fechou)`, 'modo quieto terminou', `job ${data.id}: saiu do modo quieto; recomecando com 2 conexao(oes)`, `job ${data.id}: concluido`])
    assert.ok(log.includes(line), `diario sem "${line}":\n${log}`);
  // Saida limpa marcada; a proxima sessao diz que a anterior terminou limpa. Morto com SIGKILL: a seguinte diz que nao.
  await stop(child);
  assert.match(readFileSync(path.join(base, 'state/bgdl.log'), 'utf8').trimEnd().split('\n').pop(), /parado \(saida limpa\)$/);
  child = start(base, env);
  await up(base);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  child = start(base, env);
  await up(base);
  log = readFileSync(path.join(base, 'state/bgdl.log'), 'utf8');
  assert.ok(log.includes('sessao anterior: terminou limpa'), log);
  assert.match(log, /sessao anterior: NAO terminou limpa \(morta, travamento do console ou energia\); ultima linha: .+/);
  // powerTick (sceSystemServicePowerTick) desligado por padrao; so com o pedido explicito.
  assert.match(log, /powerTick: desligado/);
  assert.equal((await call(base, 'POST', '/config', { powerTick: true })).status, 200);
  assert.match(readFileSync(path.join(base, 'state/config.json'), 'utf8'), /"powerTick":true/);
  await stop(child);
});

test('varios jobs ao mesmo tempo dividem o limite de conexoes (nunca 4 x 32)', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  ['c1.bin', 'c2.bin', 'c3.bin', 'c4.bin'].forEach((name) => small(name, 24 * MiB));
  srv.rate = 512 * 1024;
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort) });
  await up(base);
  assert.equal((await call(base, 'POST', '/config', { concurrency: 4 })).status, 200);
  const ids = [];
  for (const name of ['c1.bin', 'c2.bin', 'c3.bin', 'c4.bin']) {
    const { data } = await call(base, 'POST', '/jobs', { url: `http://127.0.0.1:${port}/f/${name}`, destination: path.join(base, 'disk/downloads', name), storageRoot: path.join(base, 'disk'), rangeBytes: MiB, connections: 32 });
    ids.push(data.id);
  }
  let most = 0;
  for (const end = Date.now() + 8000; Date.now() < end; await wait(200)) {
    let jobs;
    try { jobs = (await call(base, 'GET', '/jobs')).data.jobs; } catch { continue; } // como until(): uma conexao reaproveitada pode cair
    most = Math.max(most, jobs.reduce((sum, job) => sum + (job.connectionsActive || 0), 0));
  }
  assert.ok(most > 4, `baixou com varias conexoes (${most})`);
  assert.ok(most <= 32, `no maximo 32 conexoes somadas (${most})`);
  srv.rate = 0;
  for (const id of ids) assert.equal((await until(base, id, ['completed', 'failed'])).state, 'completed');
  await stop(child);
});

// ---- glibren.8: conexoes por download e downloads simultaneos mudados pelo celular, com tudo baixando ----

async function unlocked(base) {
  assert.equal((await call(base, 'POST', '/config', pinConfig())).status, 200);
  const { session } = (await page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data;
  assert.ok(session);
  return session;
}
const statusJob = async (id) => (await page('/api/status')).data.jobs.find((job) => job.id === id);

test('glibren.8: conexoes de um job mudadas ao vivo pelo celular (sobe, desce sem perder nada, volta ao do app); o app nao sobrescreve', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  small('live.bin', 24 * MiB);
  srv.rate = 256 * 1024;
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort) });
  await up(base);
  await pageUp();
  const session = await unlocked(base);
  const dest = path.join(base, 'disk/downloads/live.bin');
  const body = { url: `http://127.0.0.1:${port}/f/live.bin`, destination: dest, storageRoot: path.join(base, 'disk'), rangeBytes: MiB, connections: 2, expectedBytes: files['live.bin'].length, sha256: sha(files['live.bin']) };
  const { data } = await call(base, 'POST', '/jobs', body);
  await until(base, data.id, ['downloading'], (job) => job.connectionsActive > 0);
  let job = await statusJob(data.id);
  assert.deepEqual([job.connections, job.connectionsSet], [2, false], 'o alvo do app');
  // Sem sessao, nada muda; valores fora de 0..64 sao recusados; job que nao existe, 404.
  assert.equal((await page(`/api/jobs/${data.id}/connections`, { method: 'POST', body: { connections: 8 } })).status, 401);
  assert.equal((await page(`/api/jobs/${data.id}/connections`, { method: 'POST', body: { connections: 65 }, session })).status, 400);
  assert.equal((await page(`/api/jobs/${data.id}/connections`, { method: 'POST', body: { connections: 'oito' }, session })).status, 400);
  assert.equal((await page('/api/jobs/b999/connections', { method: 'POST', body: { connections: 4 }, session })).status, 404);
  // Sobe para 8: o motor abre mais faixas sem recomecar o download.
  const more = await page(`/api/jobs/${data.id}/connections`, { method: 'POST', body: { connections: 8 }, session });
  assert.equal(more.status, 200);
  assert.deepEqual(more.data, { ok: true, connections: 8, connectionsSet: true });
  const up8 = await statusUntil((status) => status.jobs.find((item) => item.id === data.id)?.connectionsActive > 2, 10000);
  const live = up8.jobs.find((item) => item.id === data.id);
  assert.deepEqual([live.connections, live.connectionsSet, live.state], [8, true, 'downloading']);
  assert.match(readFileSync(path.join(base, 'state/jobs.json'), 'utf8'), /"connectionsSet":8/, 'gravado em jobs.json');
  // O app manda o mesmo job de novo: o numero do celular continua.
  assert.equal((await call(base, 'POST', '/jobs', body)).status, 409);
  assert.equal((await call(base, 'GET', '/jobs')).data.jobs.find((item) => item.id === data.id).connectionsSet, 8);
  // Desce para 1: as conexoes que sobram terminam a faixa delas e nao abrem outra.
  assert.equal((await page(`/api/jobs/${data.id}/connections`, { method: 'POST', body: { connections: 1 }, session })).status, 200);
  await statusUntil((status) => { const item = status.jobs.find((x) => x.id === data.id); return item.connections === 1 && item.connectionsActive === 1; }, 15000);
  // null (ou 0) volta ao numero do app.
  const back = await page(`/api/jobs/${data.id}/connections`, { method: 'POST', body: { connections: null }, session });
  assert.deepEqual(back.data, { ok: true, connections: 2, connectionsSet: false });
  // A API do app (com token) faz o mesmo.
  assert.equal((await call(base, 'POST', `/jobs/${data.id}/connections`, { connections: 4 })).data.job.connectionsSet, 4);
  srv.rate = 0;
  job = await until(base, data.id, ['completed', 'failed']);
  assert.equal(job.state, 'completed', job.error);
  assert.equal(sha(readFileSync(dest)), sha(files['live.bin']), 'nada se perdeu ao subir e descer');
  assert.equal((await page(`/api/jobs/${data.id}/connections`, { method: 'POST', body: { connections: 8 }, session })).status, 404, 'terminado: nao muda');
  const log = readFileSync(path.join(base, 'state/bgdl.log'), 'utf8');
  assert.ok(log.includes(`job ${data.id}: conexoes 2 -> 8 (escolhido no celular)`), log);
  assert.ok(log.includes(`job ${data.id}: conexoes 8 -> 1`), log);
  await stop(child);
});

test('glibren.8: conexoes escolhidas para um item na fila (waiting-app ou antecipado) valem quando ele comeca', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  small('w1.bin', MiB);
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_APP_SILENCE_MS: '600000' });
  await up(base);
  await pageUp();
  const session = await unlocked(base);
  await call(base, 'POST', '/queue', { items: [{ key: 'kwait', name: 'Jogo do site', total: MiB }, queued(base, 'w1.bin')] });
  let status = (await page('/api/status')).data;
  const waiting = status.jobs.find((job) => job.name === 'Jogo do site');
  const ahead = status.jobs.find((job) => job.name === 'w1.bin');
  assert.deepEqual([waiting.connections, waiting.connectionsSet], [0, false], 'sem escolha, o app decide');
  assert.equal(ahead.connections, 1);
  assert.equal((await page(`/api/jobs/${waiting.id}/connections`, { method: 'POST', body: { connections: 16 }, session })).data.connections, 16);
  assert.equal((await page(`/api/jobs/${ahead.id}/connections`, { method: 'POST', body: { connections: 4 }, session })).status, 200);
  // O app manda a fila de novo (o mesmo item antecipado, agora com outro numero dele): o do celular fica.
  await call(base, 'POST', '/queue', { items: [{ key: 'kwait', name: 'Jogo do site', total: MiB }, queued(base, 'w1.bin', { connections: 2 })] });
  status = (await page('/api/status')).data;
  assert.deepEqual(status.jobs.map((job) => [job.name, job.connections, job.connectionsSet]), [['Jogo do site', 16, true], ['w1.bin', 4, true]]);
  // O app abre e comeca o item do site: ele sai da fila do payload e chega o POST /jobs com a mesma chave.
  await call(base, 'POST', '/queue', { items: [queued(base, 'w1.bin')] });
  assert.ok(!(await page('/api/status')).data.jobs.some((job) => job.name === 'Jogo do site'));
  const { data } = await call(base, 'POST', '/jobs', { key: 'kwait', url: `http://127.0.0.1:${port}/f/w1.bin`, destination: path.join(base, 'disk/downloads/site.bin'), storageRoot: path.join(base, 'disk'), connections: 2, connectionsSet: 64 });
  const created = (await call(base, 'GET', '/jobs')).data.jobs.find((job) => job.id === data.id);
  assert.equal(created.connectionsSet, 16, 'o numero do celular (e nao um connectionsSet no corpo do app)');
  assert.equal((await until(base, data.id, ['completed', 'failed'])).state, 'completed');
  await stop(child);
});

test('glibren.8: downloads simultaneos pelo celular: valem na hora, gravados, o app nao desfaz; diminuir nao para ninguem', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  ['p1.bin', 'p2.bin', 'p3.bin'].forEach((name) => small(name, 6 * MiB));
  srv.rate = 768 * 1024;
  let child = start(base, { BGDL_MONITOR_PORT: String(monitorPort) });
  await up(base);
  await pageUp();
  assert.equal((await call(base, 'POST', '/config', { concurrency: 1 })).status, 200);
  const session = await unlocked(base);
  const ids = [];
  for (const name of ['p1.bin', 'p2.bin', 'p3.bin']) {
    const { data } = await call(base, 'POST', '/jobs', { url: `http://127.0.0.1:${port}/f/${name}`, destination: path.join(base, 'disk/downloads', name), storageRoot: path.join(base, 'disk'), rangeBytes: MiB, connections: 2 });
    ids.push(data.id);
  }
  const running = (status) => status.jobs.filter((job) => ['connecting', 'downloading', 'verifying'].includes(job.state)).length;
  await statusUntil((status) => running(status) === 1);
  let status = (await page('/api/status')).data;
  assert.deepEqual([status.limit, status.maxLimit, status.limitSet], [1, 4, false]);
  assert.equal((await page('/api/config', { method: 'POST', body: { concurrency: 3 } })).status, 401);
  assert.equal((await page('/api/config', { method: 'POST', body: { concurrency: 5 }, session })).status, 400);
  assert.equal((await page('/api/config', { method: 'POST', body: { concurrency: 0 }, session })).status, 400);
  const set = await page('/api/config', { method: 'POST', body: { concurrency: 3 }, session });
  assert.deepEqual(set.data, { ok: true, limit: 3, limitSet: true });
  await statusUntil((s) => running(s) === 3, 10000);
  let health = (await call(base, 'GET', '/health')).data;
  assert.deepEqual([health.concurrency, health.concurrencyBy], [3, 'remote']);
  const stamp = health.concurrencyStamp;
  assert.ok(stamp >= 1);
  assert.equal((await call(base, 'GET', '/jobs')).data.concurrencyBy, 'remote');
  // O app, ao adotar, manda o mesmo numero: continua "do celular".
  assert.equal((await call(base, 'POST', '/config', { concurrency: 3 })).data.concurrencyBy, 'remote');
  // Menos pelo celular: os que estao baixando continuam (nenhum volta para a fila ou pausa).
  assert.equal((await page('/api/config', { method: 'POST', body: { concurrency: 1 }, session })).status, 200);
  await wait(1500);
  status = (await page('/api/status')).data;
  assert.equal(status.limit, 1);
  assert.ok(!status.jobs.some((job) => ['paused', 'queued'].includes(job.state)), JSON.stringify(status.jobs.map((job) => job.state)));
  health = (await call(base, 'GET', '/health')).data;
  assert.equal(health.concurrencyStamp, stamp + 1, 'outro stamp a cada escolha no celular');
  srv.rate = 0;
  for (const id of ids) assert.equal((await until(base, id, ['completed', 'failed'])).state, 'completed');
  // Gravado: volta igual depois de reiniciar.
  await stop(child);
  assert.match(readFileSync(path.join(base, 'state/config.json'), 'utf8'), /"concurrency":1,.*"concurrencyBy":"remote"/s);
  child = start(base, { BGDL_MONITOR_PORT: String(monitorPort) });
  await up(base);
  health = (await call(base, 'GET', '/health')).data;
  assert.deepEqual([health.concurrency, health.concurrencyBy, health.concurrencyStamp], [1, 'remote', stamp + 1]);
  // O jogador muda no app: passa a ser do app.
  assert.equal((await call(base, 'POST', '/config', { concurrency: 2 })).data.concurrencyBy, 'app');
  await stop(child);
});

// ---- glibren: desligar o PS5 / modo de repouso pela pagina do celular (POST /api/power) ----

test('energia pelo celular: sem sessao 401; com sessao desliga/repousa depois de responder (no PC so anota); um pedido por vez', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const powerFile = path.join(base, 'power.txt');
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_POWER_FILE: powerFile, BGDL_NOTIFY_FILE: path.join(base, 'notify.txt') });
  await up(base);
  await pageUp();
  const powered = () => (existsSync(powerFile) ? readFileSync(powerFile, 'utf8').split('\n').filter(Boolean) : []);
  // Sem sessao (e sem PIN definido): nada acontece.
  assert.equal((await page('/api/power', { method: 'POST', body: { action: 'off' } })).status, 401);
  assert.equal((await page('/api/power', { method: 'POST', body: { action: 'off' }, session: '0'.repeat(32) })).status, 401);
  assert.equal((await page('/api/power', { method: 'GET' })).status, 404, 'GET nunca desliga (pre-carregamento do navegador)');
  assert.equal((await call(base, 'POST', '/config', pinConfig())).status, 200);
  const { session } = (await page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data;
  assert.ok(session);
  assert.equal((await page('/api/power', { method: 'POST', body: { action: 'explodir' }, session })).status, 400);
  assert.equal((await page('/api/power', { method: 'POST', session })).status, 400, 'sem corpo');
  // Com sessao: 200 na hora, e a chamada so vem depois do atraso (a resposta sai antes).
  assert.equal((await page('/api/power', { method: 'POST', body: { action: 'rest' }, session })).status, 200);
  assert.equal((await page('/api/power', { method: 'POST', body: { action: 'off' }, session })).status, 409, 'um pedido por vez');
  assert.deepEqual(powered(), [], 'ainda nao: espera a resposta sair');
  for (let i = 0; i < 80 && !powered().length; i++) await wait(100);
  assert.deepEqual(powered(), ['rest']);
  // Repouso: o processo segue vivo e aceita outro pedido.
  assert.equal((await page('/api/status')).status, 200);
  assert.equal((await page('/api/power', { method: 'POST', body: { action: 'off' }, session })).status, 200);
  for (let i = 0; i < 80 && powered().length < 2; i++) await wait(100);
  assert.deepEqual(powered(), ['rest', 'off']);
  const log = readFileSync(path.join(base, 'state/bgdl.log'), 'utf8');
  assert.match(log, /celular: pedido de energia: modo de repouso/);
  assert.match(log, /energia: desligar \(pedido pelo celular\); gravando a fila e o disco/);
  assert.match(log, /energia: desligar -> 0x00000000/);
  assert.ok(existsSync(path.join(base, 'state/jobs.json')), 'a fila foi gravada antes');
  assert.match(readFileSync(path.join(base, 'notify.txt'), 'utf8'), /desligando o PS5/);
  await stop(child);
});

// ---- glibren.8: um download pausado (no celular, na web ou no app) continua na pagina do celular ----
// Antes: a pausa no app (e a do celular, que o app repete) liberava o job (release: o payload o esquecia) e a fila do
// app so mandava os "queued" no POST /queue: o pausado sumia da lista do celular.

const shown = async (id) => (await page('/api/status')).data.jobs.find((job) => job.id === id);
const stateBy = (jobs, id) => ((job) => [job?.state, job?.by])(jobs.find((job) => job.id === id));

test('glibren.8: app aberto: pausado no app (park) fica na pagina com o progresso; a fila o mantem; o celular retoma e o app termina da parcial', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  small('p1.bin', 8 * MiB);
  srv.rate = 2 * MiB;
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_APP_SILENCE_MS: '2000' });
  await up(base);
  await pageUp();
  const session = await unlocked(base);
  const item = queued(base, 'p1.bin', { rangeBytes: MiB }); // faixas de 1 MiB: a parcial guarda as que vieram
  const { data } = await call(base, 'POST', '/jobs', item.job);
  await call(base, 'POST', `/jobs/${data.id}/follow`);
  await until(base, data.id, ['downloading'], (job) => job.written > 0);
  // A pausa no app (ou a do celular repetida pelo app): park, e nao release.
  assert.equal((await call(base, 'POST', `/jobs/${data.id}/park`)).status, 200);
  let job = await until(base, data.id, ['paused']);
  assert.ok(job.ahead && !job.followed, 'volta para a fila entregue (o app nao o acompanha mais)');
  const written = job.written;
  assert.ok(written > 0);
  const mine = await shown(data.id);
  assert.deepEqual([mine?.state, mine?.written], ['paused', written], 'a pagina mostra Pausado, com o progresso');
  // A fila do app manda o pausado: ele fica, ganha a chave e continua pausado.
  await call(base, 'POST', '/queue', { items: [{ ...item, paused: true, written }] });
  job = (await call(base, 'GET', '/jobs')).data.jobs.find((entry) => entry.id === data.id);
  assert.deepEqual([job?.state, job?.key], ['paused', item.key]);
  assert.equal((await shown(data.id))?.state, 'paused');
  // Retomado no celular com o app aberto: vai para a fila, marcado (by remote) para o app retomar; nao comeca sozinho.
  assert.equal((await page(`/api/jobs/${data.id}/resume`, { method: 'POST', session })).status, 200);
  for (let i = 0; i < 6; i++) { await wait(100); await call(base, 'GET', '/health'); }
  assert.deepEqual(stateBy((await call(base, 'GET', '/jobs')).data.jobs, data.id), ['queued', 'remote']);
  // Uma fila do app que ainda nao soube (pausado) nao desfaz o pedido do celular.
  await call(base, 'POST', '/queue', { items: [{ ...item, paused: true, written }] });
  assert.deepEqual(stateBy((await call(base, 'GET', '/jobs')).data.jobs, data.id), ['queued', 'remote'], 'o celular vale ate o app confirmar');
  // O app retoma (follow): continua da parcial e termina.
  const before = srv.served['p1.bin'] || 0;
  await call(base, 'POST', `/jobs/${data.id}/follow`);
  srv.rate = 0;
  await until(base, data.id, ['completed']);
  assert.equal(sha(readFileSync(item.job.destination)), sha(files['p1.bin']));
  assert.ok((srv.served['p1.bin'] || 0) - before < files['p1.bin'].length, 'so o que faltava');
  await stop(child);
});

test('glibren.8: app fechado: o celular pausa e retoma um da fila entregue; um pausado so do app aparece e aceita os botoes; a fila do app confirma', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  small('p2.bin', 8 * MiB);
  srv.rate = 2 * MiB;
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_APP_SILENCE_MS: '600' });
  await up(base);
  await pageUp();
  const session = await unlocked(base);
  const item = queued(base, 'p2.bin');
  const site = (extra = {}) => ({ key: 'kpg', name: 'Jogo do site', total: 5000, ...extra });
  await call(base, 'POST', '/queue', { items: [item, site({ paused: true, written: 1000 })] });
  // O "app" fica calado (fechado): so a pagina do celular.
  let status = await statusUntil((s) => s.jobs.some((job) => job.name === 'p2.bin' && job.state === 'downloading' && job.written > 0));
  const p2 = status.jobs.find((job) => job.name === 'p2.bin').id;
  const pg = status.jobs.find((job) => job.name === 'Jogo do site');
  assert.deepEqual([pg.state, pg.written, pg.total], ['paused', 1000, 5000], 'o pausado so do app aparece Pausado, com o progresso');
  assert.equal((await page(`/api/jobs/${p2}/pause`, { method: 'POST', session })).status, 200);
  status = await statusUntil((s) => s.jobs.some((job) => job.id === p2 && job.state === 'paused'));
  assert.ok(status.jobs.find((job) => job.id === p2).written > 0, 'pausado no celular com o app fechado: fica, com o progresso');
  await wait(800);
  assert.equal((await shown(p2))?.state, 'paused', 'e continua pausado');
  srv.rate = 0;
  assert.equal((await page(`/api/jobs/${p2}/resume`, { method: 'POST', session })).status, 200);
  await statusUntil((s) => s.jobs.some((job) => job.id === p2 && job.state === 'completed'));
  assert.equal(sha(readFileSync(item.job.destination)), sha(files['p2.bin']));
  // O pausado so do app: retomar vira "aguardando o app" (o app retoma ao abrir); pausar e cancelar tambem valem.
  assert.equal((await page(`/api/jobs/${pg.id}/resume`, { method: 'POST', session })).status, 200);
  assert.equal((await shown(pg.id))?.state, 'waiting-app');
  // O app abre ainda achando que esta pausado: o pedido do celular fica ate o app confirmar.
  await call(base, 'POST', '/queue', { items: [site({ paused: true, written: 1000 })] });
  assert.deepEqual(stateBy((await call(base, 'GET', '/jobs')).data.jobs, pg.id), ['waiting-app', 'remote']);
  // O app retomou (manda sem "paused"): confirmado, a marca sai.
  await call(base, 'POST', '/queue', { items: [site()] });
  assert.deepEqual(stateBy((await call(base, 'GET', '/jobs')).data.jobs, pg.id), ['waiting-app', '']);
  // Pausado no app: a fila manda paused e o marcador fica Pausado.
  await call(base, 'POST', '/queue', { items: [site({ paused: true, written: 1000 })] });
  assert.equal((await shown(pg.id))?.state, 'paused');
  assert.equal((await page(`/api/jobs/${pg.id}/cancel`, { method: 'POST', session })).status, 200);
  assert.ok(!(await shown(pg.id)), 'cancelado no celular: sai da pagina');
  assert.deepEqual(stateBy((await call(base, 'GET', '/jobs')).data.jobs, pg.id), ['cancelled', 'remote'], 'o app ve o cancelamento');
  // O app cancelou: a fila vem sem ele, e o marcador sai.
  await call(base, 'POST', '/queue', { items: [] });
  assert.ok(!(await call(base, 'GET', '/jobs')).data.jobs.some((job) => job.id === pg.id));
  await stop(child);
});

test('glibren.8: um da fila entregue pausado no celular com o app aberto fica pausado ate o app confirmar; pausados sobrevivem a reinicio', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  small('p3.bin', MiB);
  let child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_APP_SILENCE_MS: '1500' });
  await up(base);
  await pageUp();
  const session = await unlocked(base);
  const item = queued(base, 'p3.bin');
  const other = { key: 'kpz', name: 'Outro', total: 9, paused: true, written: 3 };
  await call(base, 'POST', '/queue', { items: [item, other] });
  const p3 = (await call(base, 'GET', '/jobs')).data.jobs.find((job) => job.key === item.key).id;
  assert.equal((await page(`/api/jobs/${p3}/pause`, { method: 'POST', session })).status, 200);
  // A fila do app ainda acha que esta na fila: o pedido do celular vale.
  await call(base, 'POST', '/queue', { items: [item, other] });
  assert.deepEqual(stateBy((await call(base, 'GET', '/jobs')).data.jobs, p3), ['paused', 'remote']);
  // O app pausou tambem (confirmou): a marca sai e ele continua pausado.
  await call(base, 'POST', '/queue', { items: [{ ...item, paused: true }, other] });
  assert.deepEqual(stateBy((await call(base, 'GET', '/jobs')).data.jobs, p3), ['paused', '']);
  // O payload reinicia (e o app fica fechado): os dois continuam pausados; o marcador nao volta a "aguardando o app".
  await stop(child);
  child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_APP_SILENCE_MS: '300' });
  await up(base);
  await pageUp();
  await wait(800);
  const status = (await page('/api/status')).data;
  assert.deepEqual(status.jobs.map((job) => [job.name, job.state]).sort(), [['Outro', 'paused'], ['p3.bin', 'paused']]);
  assert.ok(!existsSync(item.job.destination), 'pausado nao baixa sozinho');
  await stop(child);
});

// ---- glibren: a Biblioteca TorBox na pagina do celular (GET /api/library, /api/library/game, POST /api/library/add) ----

const GiB = 1024 ** 3;
const GENRES = ['Acao', 'RPG', 'Corrida', 'Esporte', 'Terror'];
// Uma lista como a que o app grava (torbox-lista.json): 260 jogos variados e alguns itens tortos.
function library(count = 260) {
  const games = [];
  for (let i = 0; i < count; i++) {
    const ps5 = i % 3 !== 0;
    const code = `${ps5 ? 'PPSA' : 'CUSA'}${String(10000 + i).padStart(5, '0')}`;
    const size = [5, 15, 45, 80][i % 4] * GiB + i;
    const kind = ['exfat', 'pkg', 'rar'][i % 3];
    const files = kind === 'rar'
      ? [{ name: `Jogo ${i}/Jogo.${i}.part1.rar`, size: size / 2, format: 'rar' }, { name: `Jogo ${i}/Jogo.${i}.part2.rar`, size: size / 2, format: 'rar' }]
      : [{ name: `Jogo ${i}/Jogo-${i}.${kind}`, size, format: kind }, { name: `Jogo ${i}/leia-me.nfo`, size: 1000 }];
    games.push({ id: `g${i}`, title: `Jogo ${String(i).padStart(3, '0')} ${i % 7 === 0 ? 'Especial' : 'Normal'}`, code, platform: ps5 ? 'ps5' : 'ps4', genres: [GENRES[i % 5]], sizeBytes: size, formats: [kind], hash: (i.toString(16).padStart(2, '0')).repeat(20), files, cover: 'https://example.invalid/c.jpg', extra: { a: [1, 2, { b: null }] } });
  }
  // Tortos: sem id (usa o hash), sem id nem hash (fica de fora), titulo numero, generos como texto, sem formatos (vem dos
  // arquivos), tamanho como texto, um valor que nao e objeto, e um titulo enorme.
  games.push({ hash: 'ab'.repeat(20), title: 'Sem Id', platform: 'PS5', genres: 'RPG', sizeBytes: '1234', files: [{ name: 'Sem.exfat', size: 1234 }] });
  games.push({ title: 'Sem nada' });
  games.push({ id: 'num', title: 12345, code: 'cusa99999', files: [{ name: 'x.ffpkg', size: 7 * GiB }], hash: 'cd'.repeat(20) });
  games.push('isto nao e um jogo');
  games.push({ id: 'longo', title: 'Ç'.repeat(400), hash: 'ef'.repeat(20), sizeBytes: null, formats: null });
  return { version: 1, builtAt: '2026-11-06T10:00:00Z', games };
}
const lib = (query = '') => page(`/api/library${query}`);

test('biblioteca TorBox: lista resumida, filtros com contagens, paginacao, campos ausentes; arquivo ausente e malformado', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const file = path.join(base, 'torbox-lista.json');
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_LIBRARY: file });
  await up(base);
  await pageUp();
  assert.deepEqual((await lib()).data, { error: 'no-library' });
  assert.equal((await lib()).status, 404);
  const data = library();
  writeFileSync(file, JSON.stringify(data));
  await wait(2100); // o arquivo e olhado no maximo a cada 2 s
  const first = await lib('?limit=500');
  assert.equal(first.status, 200);
  assert.equal(first.data.total, 263, '260 + sem id + titulo numero + titulo enorme (o sem nada e o texto ficam de fora)');
  assert.equal(first.data.count, 263);
  assert.equal(first.data.limit, 200, 'no maximo 200 por pagina');
  assert.equal(first.data.games.length, 200);
  assert.equal(first.data.builtAt, '2026-11-06T10:00:00Z');
  assert.equal(first.data.partial, false);
  const titles = first.data.games.map((game) => game.title);
  assert.deepEqual(titles, [...titles].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0), 'em ordem de titulo');
  for (const secret of ['ab'.repeat(20), '0101010101', base]) assert.ok(!first.text.includes(secret), `a lista nao mostra ${secret}`);
  // glibren.9: a capa (https) vai junto, para a pagina mostrar.
  const g0 = first.data.games.find((game) => game.id === 'g0');
  assert.deepEqual(Object.keys(g0).sort(), ['code', 'cover', 'files', 'formats', 'genres', 'id', 'platform', 'queued', 'sizeBytes', 'title']);
  assert.equal(g0.cover, 'https://example.invalid/c.jpg');
  assert.equal('cover' in first.data.games.find((game) => game.id === 'num'), false, 'sem capa: sem o campo');
  const rest = await lib('?offset=200&limit=200');
  assert.equal(rest.data.games.length, 63);
  const all = [...first.data.games, ...rest.data.games];
  assert.equal(new Set(all.map((game) => game.id)).size, 263, 'paginas sem repetir');
  const byId = Object.fromEntries(all.map((game) => [game.id, game]));
  assert.deepEqual(byId[('ab'.repeat(20))], { id: 'ab'.repeat(20), title: 'Sem Id', code: '', platform: 'ps5', sizeBytes: 1234, files: 1, queued: false, formats: ['exfat'], genres: ['RPG'] });
  assert.deepEqual([byId.num.title, byId.num.code, byId.num.platform, byId.num.formats, byId.num.sizeBytes], ['12345', 'CUSA99999', 'ps4', ['ffpkg'], 7 * GiB]);
  assert.ok(byId.longo.title.length < 400 && byId.longo.title.startsWith('ÇÇ'), 'titulo enorme cortado sem quebrar o UTF-8');
  assert.deepEqual(byId.g1.formats, ['pkg'], 'o .nfo do lado nao vira formato');
  // Filtros.
  const ps4 = await lib('?platform=ps4&limit=200');
  assert.ok(ps4.data.games.every((game) => game.platform === 'ps4'));
  assert.equal(ps4.data.count, 88, '87 CUSA da lista + o de codigo cusa');
  const exfat = await lib('?format=exfat&limit=200');
  assert.ok(exfat.data.games.every((game) => game.formats.includes('exfat')));
  assert.equal(exfat.data.count, 88);
  const two = await lib('?format=exfat,.PKG&limit=1');
  assert.equal(two.data.count, 88 + 87, 'varios formatos: qualquer um deles');
  assert.equal((await lib('?format=iso')).data.count, 0, 'formato que nao existe: nada');
  const rpg = await lib(`?genre=${encodeURIComponent('rpg')}&limit=200`);
  assert.ok(rpg.data.games.every((game) => game.genres.includes('RPG')));
  assert.equal(rpg.data.count, 53);
  const mid = await lib(`?minSize=${10 * GiB}&maxSize=${30 * GiB}&limit=200`);
  assert.ok(mid.data.games.every((game) => game.sizeBytes >= 10 * GiB && game.sizeBytes < 30 * GiB));
  assert.equal(mid.data.count, 65);
  const text = await lib('?q=especial+ppsa');
  assert.ok(text.data.games.length && text.data.games.every((game) => /Especial/.test(game.title) && game.code.startsWith('PPSA')));
  assert.equal((await lib(`?q=${encodeURIComponent('jogo 007')}`)).data.games[0].id, 'g7');
  // Contagens: cada filtro conta com os outros aplicados.
  const mixed = await lib(`?platform=ps5&format=exfat&minSize=${30 * GiB}`);
  const everything = all;
  const count = (fn) => everything.filter(fn).length;
  const big = (game) => game.sizeBytes >= 30 * GiB;
  assert.equal(mixed.data.count, count((game) => game.platform === 'ps5' && game.formats.includes('exfat') && big(game)));
  assert.equal(mixed.data.facets.platforms.ps4, count((game) => game.platform === 'ps4' && game.formats.includes('exfat') && big(game)));
  assert.equal(mixed.data.facets.formats.find((item) => item.name === 'pkg').count, count((game) => game.platform === 'ps5' && game.formats.includes('pkg') && big(game)));
  assert.equal(mixed.data.facets.sizes.lt10, count((game) => game.platform === 'ps5' && game.formats.includes('exfat') && game.sizeBytes && game.sizeBytes < 10 * GiB));
  assert.deepEqual(Object.keys(mixed.data.facets.sizes), ['lt10', '10to30', '30to60', 'gt60', 'unknown']);
  assert.ok(mixed.data.facets.genres.length >= 5);
  // Ordem por tamanho.
  const sizes = (await lib('?sort=big&limit=10')).data.games.map((game) => game.sizeBytes);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
  const small = (await lib('?sort=small&limit=5')).data.games;
  assert.equal(small[0].sizeBytes, 1234);
  // Os arquivos de um jogo, so quando pedidos.
  const detail = await page('/api/library/game?id=g3');
  assert.equal(detail.status, 200);
  assert.equal(detail.data.suggested, 'Jogo 3/Jogo-3.exfat', 'o exFAT, nao o .nfo');
  assert.deepEqual(detail.data.files.map((item) => [item.format, item.piece]), [['exfat', false], ['', false]]);
  assert.equal((await page('/api/library/game?id=g2')).data.suggested, '', 'so pedacos de rar: o torrent inteiro');
  assert.equal((await page('/api/library/game?id=nao-existe')).status, 404);
  // Arquivo cortado no meio: o que deu para ler aparece, marcado.
  const textAll = JSON.stringify(data);
  writeFileSync(file, textAll.slice(0, Math.floor(textAll.length / 2)));
  await wait(2100);
  const cut = await lib('?limit=1');
  assert.equal(cut.status, 200);
  assert.equal(cut.data.partial, true);
  assert.ok(cut.data.total > 50 && cut.data.total < 260, String(cut.data.total));
  writeFileSync(file, '{ isto nao e json');
  await wait(2100);
  assert.deepEqual([(await lib()).status, (await lib()).data.error], [500, 'bad-library']);
  rmSync(file);
  await wait(2100);
  assert.equal((await lib()).status, 404);
  await stop(child);
});

// glibren.9: as capas na lista e a ficha de cada jogo (torbox-fichas.json ao lado da lista): fotos, videos e detalhes.
test('biblioteca TorBox: capa na lista, ficha do jogo com fotos e videos (so https e ids do YouTube), CSP da pagina', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const file = path.join(base, 'torbox-lista.json');
  const fichas = path.join(base, 'torbox-fichas.json'); // o caminho padrao: ao lado da lista
  const data = library(8);
  data.games[1].cover = 'http://sem-tls.example/c.jpg';
  data.games[2].cover = 'https://aspas.example/"onerror=x.jpg';
  data.games[3].cover = `https://longa.example/${'a'.repeat(300)}.jpg`;
  data.games[4].cover = { url: 'https://objeto.example/c.jpg' };
  writeFileSync(file, JSON.stringify(data));
  const shot = (n) => ({ url: `https://shots.example/${n}.1920x1080.jpg`, thumb: `https://shots.example/${n}.600x338.jpg` });
  const rich = { id: 'g0', summary: 'Resumo curto.', about: ['Primeiro.', 'x'.repeat(3000), 'Terceiro.', 'Quarto.', 'Quinto.'],
    shots: [...Array.from({ length: 10 }, (_, i) => shot(i)), 'https://shots.example/texto.jpg', { url: 'javascript:alert(1)' }],
    videos: ['M7lc1UVf-VE', 'M7lc1UVf-VE', 'curto', '<script>xx', 'abcdefghij_'], cover: 'https://img.example/c.png?w=384',
    coverFallbacks: ['https://steam.example/c.jpg', 'http://x.example/c.jpg', 'https://outra.example/c.jpg', 'https://terceira.example/c.jpg'],
    hero: 'https://steam.example/hero.jpg', developer: 'Estudio', publisher: 'Editora', releaseDate: '2024-03-01', metacritic: 88, stars: 4.567,
    ratingCount: 1200, features: ['Single-player', 'Co-op'], extra: { ignorado: [1, 2, 3] } };
  writeFileSync(fichas, JSON.stringify({ version: 1, builtAt: '2026-11-06T10:00:00Z', games: [
    { id: 'outro', summary: 'nao e este', shots: [shot(99)] },
    rich,
    { summary: 'campos antes do id', releaseDate: 'ontem', metacritic: 500, stars: 9, id: 'g1' },
    { id: 'g0', summary: 'repetido: vale o primeiro' }
  ] }));
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_LIBRARY: file });
  await up(base);
  await pageUp();
  // A pagina: imagens https e o player do YouTube sem cookies; o resto continua so daqui.
  const html = await page('/');
  assert.match(html.csp, /img-src data: https:;/);
  assert.match(html.csp, /frame-src https:\/\/www\.youtube-nocookie\.com https:\/\/www\.youtube\.com/);
  assert.match(html.csp, /default-src 'none'.*script-src 'unsafe-inline'.*connect-src 'self'/);
  assert.equal(html.referrer, 'no-referrer');
  assert.equal((await page('/api/status')).csp, '', 'o JSON nao leva CSP');
  const list = (await lib('?limit=50')).data.games;
  const cover = Object.fromEntries(list.map((game) => [game.id, game.cover]));
  assert.equal(cover.g0, 'https://example.invalid/c.jpg');
  assert.deepEqual([cover.g1, cover.g2, cover.g3, cover.g4], [undefined, undefined, undefined, undefined], 'sem https, com aspas, longa demais ou objeto: sem capa');
  const g0 = await page('/api/library/game?id=g0');
  assert.equal(g0.status, 200);
  assert.equal(g0.data.game.cover, 'https://example.invalid/c.jpg');
  const d = g0.data.details;
  assert.equal(d.summary, 'Resumo curto.');
  assert.equal(d.about.length, 4, 'ate 4 paragrafos');
  assert.ok(d.about[1].length < 1200 && d.about[1].startsWith('xxx'), 'paragrafo longo cortado');
  assert.equal(d.shots.length, 8, 'ate 8 fotos');
  assert.deepEqual(d.shots[0], shot(0));
  assert.deepEqual(d.videos, ['M7lc1UVf-VE', 'abcdefghij_'], 'so ids de 11 caracteres, uma vez cada');
  assert.equal(d.cover, 'https://img.example/c.png?w=384');
  assert.deepEqual(d.coverFallbacks, ['https://steam.example/c.jpg', 'https://outra.example/c.jpg']);
  assert.deepEqual([d.hero, d.developer, d.publisher, d.releaseDate, d.metacritic, d.stars, d.ratingCount], ['https://steam.example/hero.jpg', 'Estudio', 'Editora', '2024-03-01', 88, 4.57, 1200]);
  assert.deepEqual(d.features, ['Single-player', 'Co-op']);
  assert.ok(!g0.text.includes('nao e este') && !g0.text.includes('ignorado') && !g0.text.includes('javascript'), 'so a ficha do jogo, so os campos conhecidos');
  const g1 = (await page('/api/library/game?id=g1')).data.details;
  assert.deepEqual(g1, { summary: 'campos antes do id' }, 'id no fim tambem vale; data, nota e estrelas fora da faixa ficam de fora');
  const g5 = await page('/api/library/game?id=g5');
  assert.equal(g5.status, 200);
  assert.equal('details' in g5.data, false, 'sem ficha: sem details');
  writeFileSync(fichas, '{ "games": [ {"id": "g0", "summary": ');
  assert.equal('details' in (await page('/api/library/game?id=g0')).data, false, 'ficha cortada: o jogo continua abrindo');
  rmSync(fichas);
  assert.equal((await page('/api/library/game?id=g0')).status, 200, 'sem o arquivo das fichas tambem');
  await stop(child);
});

test('biblioteca TorBox: incluir download pelo celular (sessao, duplicado, arquivo escolhido, recusa do app, cancelar, reinicio)', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const file = path.join(base, 'torbox-lista.json');
  // Como a lista real: cada arquivo diz de onde vem (via), com o hash dele.
  const list = library(30);
  list.games.push({ id: 'web', title: 'So no catalogo', code: 'PPSA20000', hash: 'aa'.repeat(16), files: [
    { name: 'Web.exfat', size: 5 * GiB, format: 'exfat', via: 'webdl', hash: 'aa'.repeat(16), release: 'rel-web' },
    { name: 'Web.part1.rar', size: GiB, via: 'webdl', hash: 'bb'.repeat(16), release: 'rel-rar', piece: true }] });
  list.games.push({ id: 'acc', title: 'Na conta', code: 'PPSA20001', files: [
    { name: 'Conta.ffpkg', size: 6 * GiB, format: 'ffpkg', via: 'account', hash: 'cc'.repeat(16), item: { kind: 'torrent', id: 77 }, file: 5 },
    { name: 'Conta-2.pkg', size: GiB, via: 'account', item: { kind: 'torrent', id: 77 }, file: 6 }] });
  list.games.push({ id: 'tor', title: 'Torrent por arquivo', files: [
    { name: 'T/T.part1.rar', size: GiB, via: 'torrent', hash: 'dd'.repeat(20), piece: true },
    { name: 'T/T.part2.rar', size: GiB, via: 'torrent', hash: 'dd'.repeat(20), piece: true }] });
  writeFileSync(file, JSON.stringify(list));
  let child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_LIBRARY: file, BGDL_APP_SILENCE_MS: '400', BGDL_NOTIFY_FILE: path.join(base, 'notify.txt') });
  await up(base);
  await pageUp();
  assert.equal((await page('/api/library/add', { method: 'POST', body: { id: 'g3' } })).status, 401, 'sem o PIN, nada entra na fila');
  const session = await unlocked(base);
  await wait(600); // o app calado = fechado
  const add = await page('/api/library/add', { method: 'POST', session, body: { id: 'g3' } });
  assert.equal(add.status, 200);
  assert.equal(add.data.appOpen, false);
  assert.match(add.data.id, /^b\d+$/);
  let shownJob = (await page('/api/status')).data.jobs.find((job) => job.id === add.data.id);
  assert.deepEqual([shownJob.name, shownJob.state, shownJob.requested, shownJob.via, shownJob.total], ['Jogo 003 Normal', 'waiting-app', true, 'TorBox', 80 * GiB + 3]);
  assert.ok(!JSON.stringify(shownJob).includes('03'.repeat(20)), 'o hash nao vai para a pagina');
  let job = (await call(base, 'GET', '/jobs')).data.jobs.find((item) => item.id === add.data.id);
  assert.deepEqual(job.library, { id: 'g3', hash: '03'.repeat(20), file: 'Jogo 3/Jogo-3.exfat', code: 'CUSA10003', platform: 'ps4', via: 'torrent', release: '', item: { kind: '', id: '' }, fileId: '', whole: false, size: 80 * GiB + 3 });
  assert.equal(job.placeholder, true);
  assert.match(job.key, /^lib-[0-9a-f]{24}$/);
  assert.match(readFileSync(path.join(base, 'notify.txt'), 'utf8'), /Jogo 003 Normal entrou na fila pelo celular/);
  // Duplicado: o mesmo jogo de novo nao cria outro.
  const again = await page('/api/library/add', { method: 'POST', session, body: { id: 'g3' } });
  assert.deepEqual(again.data, { ok: true, already: true, id: add.data.id });
  assert.equal((await lib('?q=jogo+003')).data.games[0].queued, true, 'a lista mostra "na fila"');
  // Arquivo escolhido; arquivo que nao e do jogo; pedaco de rar; jogo que nao existe; torrent inteiro.
  assert.equal((await page('/api/library/add', { method: 'POST', session, body: { id: 'g4', file: 'outro.exfat' } })).data.error, 'file');
  assert.equal((await page('/api/library/add', { method: 'POST', session, body: { id: 'g5', file: 'Jogo 5/Jogo.5.part1.rar' } })).data.error, 'piece');
  assert.equal((await page('/api/library/add', { method: 'POST', session, body: { id: 'zzz' } })).status, 404);
  const rar = await page('/api/library/add', { method: 'POST', session, body: { id: 'g5' } });
  const picked = await page('/api/library/add', { method: 'POST', session, body: { id: 'g4', file: 'Jogo 4/Jogo-4.pkg' } });
  let jobs = (await call(base, 'GET', '/jobs')).data.jobs;
  assert.deepEqual([jobs.find((item) => item.id === rar.data.id).library.whole, jobs.find((item) => item.id === rar.data.id).library.file], [true, '']);
  assert.equal(jobs.find((item) => item.id === picked.data.id).library.file, 'Jogo 4/Jogo-4.pkg');
  // Fontes por arquivo: webdl (a fonte do catalogo, so o app pede), conta (item + arquivo), torrent de partes (inteiro).
  const web = await page('/api/library/add', { method: 'POST', session, body: { id: 'web' } });
  const acc = await page('/api/library/add', { method: 'POST', session, body: { id: 'acc', file: 'Conta-2.pkg' } });
  const tor = await page('/api/library/add', { method: 'POST', session, body: { id: 'tor' } });
  assert.equal((await page('/api/library/add', { method: 'POST', session, body: { id: 'web', file: 'Web.part1.rar' } })).data.error, 'piece');
  const webDetail = (await page('/api/library/game?id=web')).data;
  assert.deepEqual([webDetail.wholeOk, webDetail.suggested, webDetail.files.map((item) => [item.via, item.piece, item.ok])], [false, 'Web.exfat', [['webdl', false, true], ['webdl', true, true]]]);
  assert.ok(!JSON.stringify(webDetail).includes('aa'.repeat(16)) && !JSON.stringify(webDetail).includes('rel-web'), 'nem hash nem fonte na pagina');
  jobs = (await call(base, 'GET', '/jobs')).data.jobs;
  const libOf = (id) => jobs.find((item) => item.id === id).library;
  assert.deepEqual([libOf(web.data.id).via, libOf(web.data.id).release, libOf(web.data.id).hash, libOf(web.data.id).file, libOf(web.data.id).whole], ['webdl', 'rel-web', 'aa'.repeat(16), 'Web.exfat', false]);
  assert.deepEqual([libOf(acc.data.id).via, libOf(acc.data.id).item, libOf(acc.data.id).fileId, libOf(acc.data.id).file], ['account', { kind: 'torrent', id: '77' }, '6', 'Conta-2.pkg']);
  assert.deepEqual([libOf(tor.data.id).via, libOf(tor.data.id).hash, libOf(tor.data.id).whole, libOf(tor.data.id).file], ['torrent', 'dd'.repeat(20), true, '']);
  for (const id of [web.data.id, acc.data.id, tor.data.id]) await page(`/api/jobs/${id}/cancel`, { method: 'POST', session });
  // Ja na fila do app (mesmo nome): conta como duplicado.
  await call(base, 'POST', '/queue', { items: [{ key: 'kapp', name: 'Jogo 006 Normal', total: 10 }] });
  assert.equal((await page('/api/library/add', { method: 'POST', session, body: { id: 'g6' } })).data.already, true);
  // A fila do app (POST /queue) nao tira os pedidos do celular.
  await call(base, 'POST', '/queue', { items: [] });
  jobs = (await call(base, 'GET', '/jobs')).data.jobs;
  assert.deepEqual(jobs.filter((item) => item.library).map((item) => item.id).sort(), [add.data.id, rar.data.id, picked.data.id].sort());
  // O app nao conseguiu por na fila: o celular ve o motivo; pedir de novo volta a esperar o app.
  assert.equal((await call(base, 'POST', `/jobs/${add.data.id}/refuse`, { error: 'Destination already exists at /mnt/ext0/x' })).status, 200);
  shownJob = (await page('/api/status')).data.jobs.find((item) => item.id === add.data.id);
  assert.deepEqual([shownJob.state, shownJob.error], ['failed', 'Destination already exists at [...]']);
  assert.equal((await call(base, 'POST', '/jobs/b999/refuse', { error: 'x' })).status, 404);
  const retry = await page('/api/library/add', { method: 'POST', session, body: { id: 'g3' } });
  assert.equal(retry.data.retried, true);
  assert.equal((await shown(add.data.id)).state, 'waiting-app');
  // Retomar pelo celular tambem pede de novo (depois de outra recusa).
  await call(base, 'POST', `/jobs/${add.data.id}/refuse`, { error: 'sem espaco' });
  assert.equal((await page(`/api/jobs/${add.data.id}/resume`, { method: 'POST', session })).status, 200);
  assert.equal((await shown(add.data.id)).state, 'waiting-app');
  // Cancelar no celular: o pedido some.
  assert.equal((await page(`/api/jobs/${picked.data.id}/cancel`, { method: 'POST', session })).status, 200);
  assert.ok(!(await call(base, 'GET', '/jobs')).data.jobs.some((item) => item.id === picked.data.id));
  // O payload reinicia: os pedidos continuam (com o jogo e o arquivo).
  await stop(child);
  child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_LIBRARY: file });
  await up(base);
  jobs = (await call(base, 'GET', '/jobs')).data.jobs;
  assert.deepEqual(jobs.filter((item) => item.library).map((item) => [item.id, item.state, item.library.id]).sort(), [[add.data.id, 'waiting-app', 'g3'], [rar.data.id, 'waiting-app', 'g5']].sort());
  // O app pos na fila dele: tira o pedido (forget).
  assert.equal((await call(base, 'POST', `/jobs/${add.data.id}/forget`)).status, 200);
  assert.ok(!(await call(base, 'GET', '/jobs')).data.jobs.some((item) => item.id === add.data.id));
  // POST /jobs nao cria pedido do celular.
  const fake = await call(base, 'POST', '/jobs', { url: `http://127.0.0.1:${port}/f/a.bin`, destination: path.join(base, 'disk/downloads/fake.bin'), library: { id: 'g1', hash: '01'.repeat(20) } });
  assert.equal(fake.status, 201);
  assert.ok(!('library' in fake.data.job));
  await call(base, 'POST', `/jobs/${fake.data.id}/cancel`);
  await stop(child);
});

// ---- glibren.12: selos de origem e formato na pagina do celular (host/format/parts no /api/status) ----

test('glibren.12: origem e formato no /api/status (do url, do /queue e do /jobs), validados, sem caminho nem consulta, gravados', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  let child = start(base, { BGDL_MONITOR_PORT: String(monitorPort) });
  await up(base);
  await pageUp();
  const dl = (name) => path.join(base, 'disk/downloads', name);
  const items = [
    // Job antecipado sem origem do app: o site sai do url (aqui um IP) e o formato da extensao do destino.
    { key: 'PPSA1/a', name: 'Do url', total: 10, job: { url: `http://127.0.0.1:${port}/f/a.bin?token=SEGREDO`, destination: dl('Jogo.part01.rar'), storageRoot: path.join(base, 'disk') } },
    // Job antecipado com origem do app (no item e no job): vale a do app, em minusculas.
    { key: 'PPSA1/b', name: 'Do app', total: 10, host: 'MediaFire.com', format: 'RAR', parts: 3, job: { url: `http://127.0.0.1:${port}/f/a.bin`, destination: dl('b.binary'), storageRoot: path.join(base, 'disk') } },
    // Marcadores: so o que o app manda.
    { key: 'PPSA1/c', name: 'Marcador site', total: 10, host: 'www.1fichier.com', format: 'exfat' },
    { key: 'PPSA1/d', name: 'Marcador TorBox', total: 10, via: 'torbox', host: 'tb-cdn.cx', format: 'ffpkg' },
    { key: 'PPSA1/e', name: 'Invalido', total: 10, host: 'evil.com/path?q=1', format: 'r-a-r', parts: 1, via: 'x' },
    { key: 'PPSA1/f', name: 'Comprido', total: 10, host: `${'a'.repeat(70)}.com`, format: 'ffpfsclong' },
  ];
  assert.equal((await call(base, 'POST', '/queue', { items })).status, 200);
  // POST /jobs (o app comecou): com usuario, porta e consulta no link.
  const posted = await call(base, 'POST', '/jobs', { url: `http://user:pw@127.0.0.1:${port}/f/a.bin?x=1#frag`, destination: dl('Direto.exfat'), storageRoot: path.join(base, 'disk'), name: 'Direto.exfat' });
  assert.equal(posted.status, 201);
  const check = (status) => {
    const by = (name) => status.jobs.find((job) => job.name === name);
    assert.deepEqual([by('Do url').host, by('Do url').format, by('Do url').parts], ['127.0.0.1', 'rar', undefined]);
    assert.deepEqual([by('Do app').host, by('Do app').format, by('Do app').parts], ['mediafire.com', 'rar', 3]);
    assert.deepEqual([by('Marcador site').host, by('Marcador site').format], ['1fichier.com', 'exfat']);
    assert.deepEqual([by('Marcador TorBox').via, by('Marcador TorBox').host, by('Marcador TorBox').format], ['TorBox', undefined, 'ffpkg'], 'pelo TorBox: so o via');
    assert.deepEqual([by('Invalido').host, by('Invalido').format, by('Invalido').parts, by('Invalido').via], [undefined, undefined, undefined, undefined], 'invalido: descartado');
    assert.deepEqual([by('Comprido').host, by('Comprido').format], [undefined, undefined], 'longo demais: descartado, nao cortado');
    assert.deepEqual([by('Direto.exfat').host, by('Direto.exfat').format], ['127.0.0.1', 'exfat']);
    const text = JSON.stringify(status);
    for (const secret of ['SEGREDO', 'token', 'user', 'pw@', '/f/', '?x=1', 'frag', 'evil', '/path', ':' + port]) assert.ok(!text.includes(secret), secret);
  };
  check((await page('/api/status')).data);
  // jobs.json guarda a origem; ao reabrir, a pagina mostra o mesmo.
  const saved = JSON.parse(readFileSync(path.join(base, 'state/jobs.json'), 'utf8')).jobs.find((job) => job.key === 'PPSA1/b');
  assert.deepEqual([saved.host, saved.format, saved.parts], ['mediafire.com', 'rar', 3]);
  await call(base, 'POST', `/jobs/${posted.data.id}/cancel`);
  await stop(child);
  child = start(base, { BGDL_MONITOR_PORT: String(monitorPort) });
  await up(base);
  await pageUp();
  const again = (await page('/api/status')).data;
  const b = again.jobs.find((job) => job.name === 'Do app');
  assert.deepEqual([b.host, b.format, b.parts], ['mediafire.com', 'rar', 3]);
  assert.equal(again.jobs.find((job) => job.name === 'Marcador TorBox').via, 'TorBox');
  await stop(child);
});

test('glibren.12: sistema, codigo e arquivo no /api/status (sem caminho); descompactando; cancelados guardados (20), gravados e limpos com o PIN', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  let child = start(base, { BGDL_MONITOR_PORT: String(monitorPort) });
  await up(base);
  await pageUp();
  const dl = (name) => path.join(base, 'disk/downloads', name);
  const items = [
    { key: 'K/a', name: 'Fila PS4', total: 5, platform: 'PS4', code: 'cusa00552', file: 'TLOU.CUSA00552.pkg', format: 'pkg' },
    { key: 'K/b', name: 'Ruim', total: 5, platform: 'ps3', code: 'ABC12', file: '../x/y.rar' },
    { key: 'K/c', name: 'Extraindo', total: 5, extracting: true, platform: 'ps5', file: 'G.part1.rar' },
    { key: 'K/d', name: 'Job', total: 5, job: { url: `http://127.0.0.1:${port}/f/a.bin`, destination: dl('Game.PPSA01234.rar'), storageRoot: path.join(base, 'disk'), platform: 'ps5', code: 'PPSA01234' } },
  ];
  assert.equal((await call(base, 'POST', '/queue', { items })).status, 200);
  let status = (await page('/api/status')).data;
  const by = (name) => status.jobs.find((job) => job.name === name);
  assert.deepEqual([by('Fila PS4').platform, by('Fila PS4').code, by('Fila PS4').file], ['ps4', 'CUSA00552', 'TLOU.CUSA00552.pkg']);
  assert.deepEqual([by('Ruim').platform, by('Ruim').code, by('Ruim').file], [undefined, undefined, undefined], 'invalidos: descartados');
  assert.equal(by('Extraindo').state, 'extracting');
  assert.deepEqual([by('Job').platform, by('Job').code, by('Job').file], ['ps5', 'PPSA01234', 'Game.PPSA01234.rar'], 'so o nome base do destino');
  assert.ok(!JSON.stringify(status).includes(base), 'nenhum caminho');
  const extracting = (await call(base, 'GET', '/jobs')).data.jobs.find((job) => job.key === 'K/c');
  assert.equal((await call(base, 'POST', `/jobs/${extracting.id}/cancel`)).status, 409, 'o que o app descompacta nao se cancela daqui');
  // A fila seguinte sem "extracting": volta a esperar o app.
  assert.equal((await call(base, 'POST', '/queue', { items: items.map((item) => item.key === 'K/c' ? { ...item, extracting: false } : item) })).status, 200);
  status = (await page('/api/status')).data;
  assert.equal(by('Extraindo').state, 'waiting-app');
  // Cancelados: o mais novo primeiro, so nome/quando/sistema/formato/origem, ate 20.
  const ps4 = (await call(base, 'GET', '/jobs')).data.jobs.find((job) => job.key === 'K/a');
  assert.equal((await call(base, 'POST', `/jobs/${ps4.id}/cancel`)).status, 200);
  status = (await page('/api/status')).data;
  assert.deepEqual(status.cancelledRecent[0], { name: 'Fila PS4', at: status.cancelledRecent[0].at, platform: 'ps4', code: 'CUSA00552', format: 'pkg' });
  assert.ok(Math.abs(status.cancelledRecent[0].at - Date.now() / 1000) < 60);
  const many = Array.from({ length: 22 }, (_, i) => ({ key: `K/m${i}`, name: `Muitos ${i}`, total: 1 }));
  assert.equal((await call(base, 'POST', '/queue', { items: many })).status, 200);
  for (const job of (await call(base, 'GET', '/jobs')).data.jobs.filter((item) => item.key.startsWith('K/m'))) await call(base, 'POST', `/jobs/${job.id}/cancel`);
  status = (await page('/api/status')).data;
  assert.equal(status.cancelledRecent.length, 20, 'so os ultimos 20');
  assert.equal(status.cancelledRecent[0].name, 'Muitos 21', 'o mais novo primeiro');
  assert.ok(!status.cancelledRecent.some((item) => item.name === 'Fila PS4'), 'o mais antigo saiu');
  // Gravados: voltam depois de reiniciar.
  await stop(child);
  child = start(base, { BGDL_MONITOR_PORT: String(monitorPort) });
  await up(base);
  await pageUp();
  assert.equal((await page('/api/status')).data.cancelledRecent.length, 20);
  assert.equal((await page('/api/cancelled/clear', { method: 'POST' })).status, 401, 'limpar pede o PIN');
  const session = await unlocked(base);
  assert.equal((await page('/api/cancelled/clear', { method: 'POST', session })).status, 200);
  assert.deepEqual((await page('/api/status')).data.cancelledRecent, []);
  await stop(child);
});

test('glibren.12: a lista do BACKUP diz o sistema, o codigo, o formato, as partes, os nomes e o .exfat convertido; o download para o BACKUP grava o marcador', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const root = path.join(base, 'disk');
  const put = (rel, text = 'x') => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
  put('BACKUP/Jogo Marcado/Game.PPSA01234.part1.rar', 'aaaa');
  put('BACKUP/Jogo Marcado/Game.PPSA01234.part2.rar', 'bb');
  put('BACKUP/Jogo Marcado/sub/leia.txt', 'c');
  put('BACKUP/Jogo Marcado/.jobe-backup.json', JSON.stringify({ titleId: 'PPSA01234', platform: 'ps5', format: 'rar', source: 'mediafire.com' }));
  put('homebrew/PPSA01234.exfat', 'img');
  put('BACKUP/Velho/Bloodborne.CUSA00900.pkg', 'pkg');
  const child = start(base, { BGDL_MONITOR_PORT: String(monitorPort), BGDL_BACKUP_ROOTS: root });
  await up(base);
  await pageUp();
  const games = (await page('/api/backup')).data.games;
  const marked = games.find((game) => game.name === 'Jogo Marcado');
  assert.deepEqual([marked.platform, marked.code, marked.format, marked.parts, marked.files, marked.bytes, marked.converted], ['ps5', 'PPSA01234', 'rar', 2, 3, 7, 'PPSA01234.exfat'], 'o marcador nao conta como arquivo');
  assert.deepEqual([...marked.fileNames].sort(), ['Game.PPSA01234.part1.rar', 'Game.PPSA01234.part2.rar', 'leia.txt'], 'so os nomes base');
  const old = games.find((game) => game.name === 'Velho');
  assert.deepEqual([old.platform, old.code, old.format, old.parts, old.converted], ['ps4', 'CUSA00900', 'pkg', 0, ''], 'sem marcador: pelo nome');
  // Um download que termina dentro de BACKUP/<jogo>/ grava o marcador (com o codigo e o sistema do app).
  mkdirSync(path.join(root, 'BACKUP/Novo'), { recursive: true }); // a pasta, como o app a cria
  const posted = await call(base, 'POST', '/jobs', { url: `http://127.0.0.1:${port}/f/a.bin`, destination: path.join(root, 'BACKUP/Novo/Novo.PPSA05555.rar'), storageRoot: root, platform: 'ps5', code: 'PPSA05555', name: 'Novo' });
  assert.equal(posted.status, 201);
  await until(base, posted.data.id, ['completed']);
  const marker = JSON.parse(readFileSync(path.join(root, 'BACKUP/Novo/.jobe-backup.json'), 'utf8'));
  assert.deepEqual(marker, { titleId: 'PPSA05555', platform: 'ps5', format: 'rar', source: '127.0.0.1' });
  await stop(child);
});
