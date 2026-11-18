// glibren.71: o payload (app/native/bg_downloader.c + bg_convert.c) compilado para o PC e rodado de verdade contra um
// ps5-dump-forge FALSO (um servidor minimo com as rotas que o payload usa: POST /api/start_job, GET /api/jobs,
// POST /api/cancel_job, no formato da v0.5.6: o id do job como numero, {"error": "..."} nos erros, a lista com
// {instance, jobs:[{done, id, log, log_total, progress, request, stages}]} e o fim como {"result": {"Ok"|"Err"}}).
//   - ok: .ffpkg (sem nivel), .exfat+zstd ("rapido" = zstd_level 1), .pkg "sem" (kraken stored), .ffpfsc "menor"
//     (zlib 9), pasta_lz4 "menor" (lz4 12): o pedido certo, "verifying" no caminho, a saida no lugar, a pasta de trabalho
//     apagada so depois do Ok;
//   - erro do Dump Forge: "failed" com "forge: <texto dele>", a fonte intacta;
//   - Dump Forge ausente: "waiting" com "forge-missing: ...", e quando ele aparece a conversao segue sozinha;
//   - cancelar no meio: cancel_job no Dump Forge, "cancelled", nada na saida;
//   - "pasta": a pasta do jogo muda para homebrew/<nome> sem chamar o Dump Forge;
//   - POST /config convertFormat/convertLevel (lista fechada) gravados no config.json.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortFrom } from './free-port.mjs';
import { before as whenBuilt } from 'node:test';
import { assertBuilt, compileTo } from './payload-build.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-forge-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l(?:curl|crypto|archive)/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : false;
whenBuilt(() => { if (!skip) assertBuilt(built); });
const children = new Set();
const servers = new Set();
beforeEach(async () => {
  const left = [...children];
  for (const child of left) child.kill('SIGKILL');
  await Promise.all(left.map((child) => child.exitCode !== null || child.signalCode ? null : new Promise((resolve) => child.once('exit', resolve))));
});
after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const server of servers) { server.closeAllConnections?.(); server.close(); }
  rmSync(dir, { recursive: true, force: true });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = freePortFrom(20);
let api, monitorPort, smpPort;
if (!skip) {
  api = await freePort();
  monitorPort = await freePort();
  smpPort = await freePort();
  const smp = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":0}'); }).listen(smpPort, '127.0.0.1');
  servers.add(smp);
}

// O Dump Forge falso. mode: "ok" (termina), "error" (termina com Err), "slow" (so termina cancelado).
function fakeForge(port, mode = 'ok') {
  const state = { mode, requests: [], cancels: [], jobs: new Map(), next: 1, instance: '0123456789abcdef' };
  const job = (id) => state.jobs.get(id);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'POST' && req.url === '/api/start_job') {
        let request;
        try { request = JSON.parse(body).request; } catch { return send(400, { error: 'bad request: not JSON' }); }
        if (!request?.source || !request.output || !request.format) return send(400, { error: 'bad request: missing field' });
        if (existsSync(request.output)) return send(400, { error: `${request.output} already exists` });
        state.requests.push(request);
        const id = state.next++;
        const entry = { done: null, id, log: [], log_total: 0, progress: null, request, stages: ['scan', 'write', 'verify'] };
        state.jobs.set(id, entry);
        setTimeout(() => { if (!entry.done) entry.progress = { kind: 'progress', job: id, stage: 'write', done: 40, total: 100 }; }, 60);
        setTimeout(() => { if (!entry.done) entry.progress = { kind: 'progress', job: id, stage: 'verify', done: 90, total: 100 }; }, 250);
        if (state.mode !== 'slow') setTimeout(() => {
          if (entry.done) return;
          if (state.mode === 'error') { entry.done = { kind: 'done', job: id, result: { Err: 'preflight: no eboot.bin in the source' } }; return; }
          if (/^(folder|lz4)$/.test(request.format)) { mkdirSync(path.join(request.output, 'sce_sys'), { recursive: true }); writeFileSync(path.join(request.output, 'eboot.bin'), 'x'.repeat(3000)); }
          else writeFileSync(request.output, 'x'.repeat(7000));
          entry.done = { kind: 'done', job: id, result: { Ok: { output: request.output, bytes: 7000, files: 3, checks: [], verify: { mode: 'fast', checked_bytes: 1, total_bytes: 1, samples: 1, seed: 1 } } } };
        }, 500);
        return send(200, id);
      }
      if (req.method === 'GET' && req.url === '/api/jobs') return send(200, { instance: state.instance, jobs: [...state.jobs.values()] });
      if (req.method === 'POST' && req.url === '/api/cancel_job') {
        const { id } = JSON.parse(body || '{}');
        state.cancels.push(id);
        const entry = job(id);
        if (entry && !entry.done) setTimeout(() => { entry.done = { kind: 'done', job: id, result: { Err: 'cancelled' } }; }, 30);
        return send(200, null);
      }
      send(404, { error: 'unknown route' });
    });
  }).listen(port, '127.0.0.1');
  servers.add(server);
  state.server = server;
  state.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); servers.delete(server); });
  return state;
}

let run = 0;
async function workspace() {
  const base = path.join(dir, `run${++run}`);
  mkdirSync(path.join(base, 'state'), { recursive: true });
  mkdirSync(path.join(base, 'disk/homebrew'), { recursive: true });
  mkdirSync(path.join(base, 'disk/downloads/extracted'), { recursive: true });
  return base;
}
function start(base, forgePort, env = {}) {
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitorPort),
    BGDL_SMP_BASE: `http://127.0.0.1:${smpPort}/api/v1`, BGDL_BACKUP_ROOTS: path.join(base, 'disk'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'),
    BGDL_FORGE_BASE: `http://127.0.0.1:${forgePort}`, BGDL_FORGE_POLL_MS: '40', BGDL_FORGE_RETRY_MS: '300', ...env }, stdio: ['ignore', 'ignore', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
const stop = (child) => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); });
async function call(base, method, route, body) {
  const tok = readFileSync(path.join(base, 'state/token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': tok, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function up(base, ms = 30000) {
  for (const end = performance.now() + ms; performance.now() < end; await wait(50)) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call(base, 'GET', '/health')).status === 200) return; } catch {}
  }
  throw new Error('payload did not start');
}
const conversion = async (base, id) => (await call(base, 'GET', '/convert')).data.conversions.find((item) => item.id === id);
async function until(base, id, states, ms = 30000) {
  const seen = new Set();
  for (const end = performance.now() + ms; performance.now() < end; await wait(20)) {
    let item;
    try { item = await conversion(base, id); } catch { continue; }
    if (item) seen.add(item.state);
    if (item && states.includes(item.state)) return { ...item, seen };
  }
  throw new Error(`conversion ${id} never reached ${states}: ${JSON.stringify(await conversion(base, id).catch(() => null))}`);
}
function request(base, n, format, extra = {}) {
  const work = path.join(base, `disk/downloads/extracted/G${n}`);
  mkdirSync(path.join(work, 'sce_sys'), { recursive: true });
  writeFileSync(path.join(work, 'eboot.bin'), randomBytes(4096));
  writeFileSync(path.join(work, 'sce_sys/param.json'), `{"titleId":"PPSA0123${n}"}`);
  const ext = { exfat: '.exfat', ffpkg: '.ffpkg', ffpfs: '.ffpfs', ffpfsc: '.ffpfsc', pkg: '.pkg', exfat_zstd: '.exfat', ffpkg_zstd: '.ffpkg', ffpfs_zstd: '.ffpfs', ffpfsc_zstd: '.ffpfsc' }[format] ?? '';
  return { key: `PPSA0123${n}/rel`, name: `Jogo ${n}`, label: `PPSA0123${n}`, kind: 'dir', source: work, work, root: path.join(base, 'disk'), output: path.join(base, `disk/homebrew/PPSA0123${n}${ext}`), format, ...extra };
}

test('glibren.71: Dump Forge ok: o pedido de cada formato/nivel, verifying, a saida no lugar e a pasta de trabalho apagada depois', { skip }, async () => {
  const base = await workspace();
  const port = await freePort();
  const forge = fakeForge(port);
  const child = start(base, port);
  await up(base);
  const cases = [
    ['ffpkg', 'menor', { format: 'ffpkg' }],
    ['exfat_zstd', 'rapido', { format: 'exfat', zstd_pack: true, zstd_level: 1 }],
    ['pkg', 'sem', { format: 'pkg', kraken_level: 'stored' }],
    ['ffpfsc', 'menor', { format: 'ffpfsc', ffpfsc_level: 9 }],
    ['pasta_lz4', 'menor', { format: 'lz4', lz4_level: 12 }],
    ['pasta_zstd', 'padrao', { format: 'folder', zstd_pack: true }],
  ];
  for (const [n, [format, level, expected]] of cases.entries()) {
    const body = request(base, n + 1, format, { level });
    const made = await call(base, 'POST', '/convert', body);
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const done = await until(base, made.data.id, ['done', 'failed']);
    assert.equal(done.state, 'done', done.error);
    assert.equal(done.format, format);
    if (n === 0) assert.ok(done.seen.has('verifying'), `estados vistos: ${[...done.seen]}`);
    const sent = forge.requests.at(-1);
    assert.equal(sent.source, body.source);
    assert.equal(sent.output, body.output);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(sent[key], value, `${format}: ${key}`);
    for (const key of ['zstd_level', 'kraken_level', 'ffpfsc_level', 'lz4_level', 'zstd_pack']) if (!(key in expected)) assert.equal(sent[key], undefined, `${format}: ${key} nao vai`);
    assert.equal(sent.delete_source, undefined, 'o Dump Forge nunca apaga a fonte');
    assert.ok(existsSync(body.output), 'a saida esta no lugar');
    assert.ok(!existsSync(body.work), 'a pasta de trabalho sai depois do Ok');
    assert.ok(done.imageBytes > 0);
  }
  assert.match(readFileSync(path.join(base, 'notify.txt'), 'utf8'), /pronto \(FFPKG\)/);
  // A saida que nao bate com o formato e recusada.
  const wrong = await call(base, 'POST', '/convert', { ...request(base, 9, 'ffpkg'), output: path.join(base, 'disk/homebrew/X.exfat') });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /\.ffpkg/);
  assert.equal((await call(base, 'POST', '/convert', request(base, 8, 'iso'))).status, 400);
  await stop(child);
});

test('glibren.71: erro do Dump Forge vira "forge: <texto>" e a fonte fica', { skip }, async () => {
  const base = await workspace();
  const port = await freePort();
  fakeForge(port, 'error');
  const child = start(base, port);
  await up(base);
  const body = request(base, 1, 'ffpkg');
  const made = await call(base, 'POST', '/convert', body);
  const failed = await until(base, made.data.id, ['failed', 'done']);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'forge: preflight: no eboot.bin in the source');
  assert.ok(existsSync(path.join(body.source, 'eboot.bin')), 'a fonte intacta');
  assert.ok(!existsSync(body.output));
  await stop(child);
});

test('glibren.71: Dump Forge ausente: "waiting" (forge-missing) e segue sozinha quando ele aparece', { skip }, async () => {
  const base = await workspace();
  const port = await freePort();
  const child = start(base, port);
  await up(base);
  const body = request(base, 1, 'ffpfs');
  const made = await call(base, 'POST', '/convert', body);
  const waiting = await until(base, made.data.id, ['waiting', 'failed']);
  assert.equal(waiting.state, 'waiting');
  assert.match(waiting.error, /^forge-missing: /);
  assert.ok(existsSync(body.source), 'nada foi tocado');
  const phone = await (await fetch(`http://127.0.0.1:${monitorPort}/api/status`)).json();
  assert.equal(phone.conversions.find((item) => item.name === 'Jogo 1')?.state, 'waiting');
  const forge = fakeForge(port);
  const done = await until(base, made.data.id, ['done', 'failed']);
  assert.equal(done.state, 'done', done.error);
  assert.equal(forge.requests.length, 1);
  assert.ok(existsSync(body.output));
  // Cancelar uma que espera: sai na hora (sem Dump Forge).
  await forge.close();
  const second = await call(base, 'POST', '/convert', request(base, 2, 'ffpkg'));
  await until(base, second.data.id, ['waiting']);
  assert.equal((await call(base, 'POST', `/convert/${second.data.id}/cancel`)).status, 200);
  assert.equal((await until(base, second.data.id, ['cancelled'])).state, 'cancelled');
  await stop(child);
});

test('glibren.71: cancelar no meio pede cancel_job ao Dump Forge e nada fica na saida', { skip }, async () => {
  const base = await workspace();
  const port = await freePort();
  const forge = fakeForge(port, 'slow');
  const child = start(base, port);
  await up(base);
  const body = request(base, 1, 'ffpkg_zstd');
  const made = await call(base, 'POST', '/convert', body);
  await until(base, made.data.id, ['converting', 'verifying']);
  for (let i = 0; i < 100 && !forge.requests.length; i++) await wait(20);
  assert.equal((await call(base, 'POST', `/convert/${made.data.id}/cancel`)).status, 200);
  const end = await until(base, made.data.id, ['cancelled', 'failed', 'done']);
  assert.equal(end.state, 'cancelled');
  assert.deepEqual(forge.cancels, [1]);
  assert.ok(!existsSync(body.output));
  assert.ok(existsSync(body.source), 'a fonte fica (pasta de trabalho de downloads/)');
  await stop(child);
});

test('glibren.71: "pasta" muda a pasta do jogo para homebrew/<nome> sem o Dump Forge; formato/nivel no POST /config', { skip }, async () => {
  const base = await workspace();
  const port = await freePort();
  const forge = fakeForge(port);
  const child = start(base, port);
  await up(base);
  const body = request(base, 1, 'pasta');
  body.source = body.work; // a pasta extraida inteira e o jogo
  const made = await call(base, 'POST', '/convert', body);
  const done = await until(base, made.data.id, ['done', 'failed']);
  assert.equal(done.state, 'done', done.error);
  assert.ok(statSync(body.output).isDirectory());
  assert.ok(existsSync(path.join(body.output, 'eboot.bin')));
  assert.ok(!existsSync(body.work));
  assert.equal(forge.requests.length, 0, 'sem Dump Forge');
  // Configuracoes: lista fechada, gravadas no config.json.
  assert.equal((await call(base, 'POST', '/config', { convertFormat: 'iso' })).status, 400);
  assert.equal((await call(base, 'POST', '/config', { convertLevel: 'max' })).status, 400);
  assert.equal((await call(base, 'POST', '/config', { convertFormat: 'ffpkg_zstd', convertLevel: 'rapido' })).status, 200);
  const saved = JSON.parse(readFileSync(path.join(base, 'state/config.json'), 'utf8'));
  assert.equal(saved.convertFormat, 'ffpkg_zstd');
  assert.equal(saved.convertLevel, 'rapido');
  await stop(child);
});

test('glibren.71: compactado + .ffpkg: o payload extrai em BACKUP/_temp, o Dump Forge le a pasta, o .zip fica e a _temp sai', { skip }, async () => {
  const base = await workspace();
  const port = await freePort();
  const forge = fakeForge(port);
  const child = start(base, port);
  await up(base);
  const backup = path.join(base, 'disk/BACKUP/Jogo Zip');
  mkdirSync(backup, { recursive: true });
  const zip = path.join(backup, 'jogo.zip');
  const made = spawnSync('python3', ['-I', '-c', [
    'import sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1], "w")',
    'z.writestr("PPSA01239-app/eboot.bin", b"x" * 4096)',
    'z.writestr("PPSA01239-app/sce_sys/param.json", "{\\"titleId\\":\\"PPSA01239\\"}")',
    'z.close()'].join('\n'), zip], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const output = path.join(base, 'disk/homebrew/PPSA01239.ffpkg');
  const answer = await call(base, 'POST', '/convert', { key: 'zip-ffpkg', name: 'Jogo Zip', label: 'PPSA01239', root: path.join(base, 'disk'), output, kind: 'archive', source: zip, sources: [zip], format: 'ffpkg' });
  assert.equal(answer.status, 201, JSON.stringify(answer.data));
  const done = await until(base, answer.data.id, ['done', 'failed']);
  assert.equal(done.state, 'done', done.error);
  assert.ok(done.seen.has('extracting') || forge.requests[0].source.includes('/BACKUP/_temp/'), `estados: ${[...done.seen]}`);
  assert.match(forge.requests[0].source, /\/BACKUP\/_temp\/c\d+\/PPSA01239-app$/);
  assert.equal(forge.requests[0].format, 'ffpkg');
  assert.ok(existsSync(output));
  assert.ok(existsSync(zip), 'o original fica no BACKUP');
  assert.ok(!existsSync(path.join(base, `disk/BACKUP/_temp/${answer.data.id}`)), 'a pasta extraida sai depois do Ok');
  await stop(child);
});


test('glibren.74: imagem (kind "image") vira outro formato SEMPRE pelo Dump Forge (.exfat e pasta tambem); a mesma extensao e recusada; o original fica', { skip }, async () => {
  const base = await workspace();
  const port = await freePort();
  const forge = fakeForge(port);
  const child = start(base, port);
  await up(base);
  const root = path.join(base, 'disk');
  const backup = path.join(root, 'BACKUP/Jogo Imagem');
  mkdirSync(backup, { recursive: true });
  const exfat = path.join(backup, 'PPSA04444.exfat');
  writeFileSync(exfat, randomBytes(8192));
  const ffpkg = path.join(backup, 'PPSA05555.ffpkg');
  writeFileSync(ffpkg, randomBytes(8192));
  const exfat2 = path.join(backup, 'PPSA04444 copia.exfat'); // a mesma fonte ja pronta so seria acompanhada (attached)
  writeFileSync(exfat2, randomBytes(8192));
  for (const [n, source, format, output, target] of [
    [1, exfat, 'ffpkg', 'homebrew/PPSA04444.ffpkg', 'ffpkg'],
    [2, ffpkg, 'exfat', 'homebrew/PPSA05555.exfat', 'exfat'],
    [3, exfat2, 'pasta', 'homebrew/PPSA04444', 'folder'],
  ]) {
    const made = await call(base, 'POST', '/convert', { key: `img-${n}`, name: 'Jogo Imagem', label: 'PPSA04444', kind: 'image', source, root, output: path.join(root, output), format });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const done = await until(base, made.data.id, ['done', 'failed']);
    assert.equal(done.state, 'done', done.error);
    const sent = forge.requests.at(-1);
    assert.deepEqual([sent.source, sent.output, sent.format], [source, path.join(root, output), target]);
    assert.equal(sent.delete_source, undefined);
    assert.ok(existsSync(source), 'o original nunca e tocado pelo payload');
  }
  assert.equal(forge.requests.length, 3, 'as tres pelo Dump Forge');
  const same = await call(base, 'POST', '/convert', { key: 'img-same', name: 'X', kind: 'image', source: exfat, root, output: path.join(root, 'homebrew/PPSA04444-2.exfat'), format: 'exfat_zstd' });
  assert.equal(same.status, 400);
  assert.match(same.data.error, /already \.exfat/);
  const notImage = await call(base, 'POST', '/convert', { key: 'img-bad', name: 'X', kind: 'image', source: path.join(backup, 'x.zip'), root, output: path.join(root, 'homebrew/X.ffpkg'), format: 'ffpkg' });
  assert.equal(notImage.status, 400);
  await stop(child);
});

test('glibren.74: imagem no BACKUP (POST /backup/convert): converte para o formato das Configuracoes; com a mesma extensao, nada a converter', { skip }, async () => {
  const base = await workspace();
  const port = await freePort();
  const forge = fakeForge(port);
  const child = start(base, port);
  await up(base);
  const root = path.join(base, 'disk');
  const backup = path.join(root, 'BACKUP/Jogo Seis');
  mkdirSync(backup, { recursive: true });
  writeFileSync(path.join(backup, '.jobe-backup.json'), JSON.stringify({ titleId: 'PPSA06666', platform: 'ps5', format: 'exfat', source: 'glibren' }));
  writeFileSync(path.join(backup, 'PPSA06666.exfat'), randomBytes(8192));
  assert.equal((await call(base, 'POST', '/config', { convertFormat: 'exfat' })).status, 200);
  const nothing = await call(base, 'POST', '/backup/convert', { root, name: 'Jogo Seis' });
  assert.notEqual(nothing.status, 200, JSON.stringify(nothing.data));
  assert.equal(forge.requests.length, 0);
  assert.equal((await call(base, 'POST', '/config', { convertFormat: 'ffpfsc' })).status, 200);
  const asked = await call(base, 'POST', '/backup/convert', { root, name: 'Jogo Seis' });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  const all = (await call(base, 'GET', '/convert')).data.conversions;
  const conv = all.at(-1);
  assert.equal(conv.kind, 'image');
  const done = await until(base, conv.id, ['done', 'failed']);
  assert.equal(done.state, 'done', done.error);
  assert.equal(forge.requests[0].format, 'ffpfsc');
  assert.equal(forge.requests[0].output, path.join(root, 'homebrew/PPSA06666.ffpfsc'));
  assert.ok(existsSync(path.join(backup, 'PPSA06666.exfat')), 'o original fica no BACKUP');
  // A lista do BACKUP aceita o marcador com source "glibren" (o da outra ferramenta).
  const list = await call(base, 'GET', '/backup');
  const game = list.data.games.find((item) => item.name === 'Jogo Seis');
  assert.equal(game.code, 'PPSA06666');
  await stop(child);
});
