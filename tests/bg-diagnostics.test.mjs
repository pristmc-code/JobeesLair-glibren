// glibren.44: o diagnostico pelo GitHub (app/native/bg_diag.c + state/diagnostics.js). O payload compilado para o PC
// contra um GitHub FALSO local (nunca o de verdade) e um glibren falso (/diario):
//   - recusa sem chave (pagina e app), sem sessao do PIN (401) e chave que nao parece do GitHub (400);
//   - a chave fica em <diag>/token (0600) e nunca aparece num GET nem no diario (so "termina em ...xxxx");
//   - higienizacao: tokens, chaves (TorBox/AllDebrid/GitHub), Bearer, cookies, consultas de links assinados e e-mails
//     saem de tudo que vai; tube/account.json e os tokens nunca vao; cada log cortado nos ultimos ~2 MB;
//   - envio: um PUT por arquivo em /repos/pristmc-code/ps5-diagnosticos/contents/<AAAA-MM-DD_HHMMSS>/<arquivo>, com o
//     committer PristMC e a mensagem "diagnostico <pasta> <versao>"; uma rodada por vez (409); 401/403/404/sem rede;
//   - o .zip da pagina do celular com os mesmos arquivos higienizados;
//   - o lado do app (diagnosticsBody / sendDiagnostics / diagnosticsMessageKey).
// Run: node --import ./tests/stub-loader.mjs --test tests/bg-diagnostics.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePortFrom } from './free-port.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const { diagnosticsBody, diagnosticsKeyState, diagnosticsMessageKey, sendDiagnostics } = await import(pathToFileURL(path.join(repo, 'app/state/diagnostics.js')).href);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const freePort = freePortFrom(17); // glibren.44: bloco de portas so deste arquivo (tests/free-port.mjs)

// ---- Segredos falsos (nada aqui vale em lugar nenhum) ----
const GITHUB_KEY = 'github_pat_11TESTE0000000000_FakeFakeFakeFakeFakeFake1234567890abcdefXYZ';
const TORBOX_KEY = 'abcdef12-3456-7890-abcd-ef1234567890';
const ALLDEBRID_KEY = 'AdKeyFalsa20c4r4ct3r';
const TUBE_TOKEN = 'tubetokenFALSO-998877';
const SECRETS = [
  GITHUB_KEY, TORBOX_KEY, ALLDEBRID_KEY, TUBE_TOKEN, 'sk_live_bearerFALSO', 'XYZSIGFALSA', 'TBTOKENQUERY', 'QSECRET123', 'pw-secreto', 'cookiesecretFALSO',
  'jsonsecretvalue', 'hunter2pass', 'jogador.teste@gmail.com', 'fulano@exemplo.com.br', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', '0123456789abcdef0123456789abcdef01234567',
  'ABCDEFGHJKLMNPQRSTUVWXYZ23456789ABCDEFGHJKLMNPQRSTUV', 'CONTA-SECRETA-YT', 'refreshFALSO123', 'expire=1700000000',
];
const SECRET_LINES = [
  'pedido: Authorization: Bearer sk_live_bearerFALSO',
  'video https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1700000000&signature=XYZSIGFALSA',
  'torbox https://api.torbox.app/v1/api/torrents/requestdl?token=TBTOKENQUERY&torrent_id=1',
  'site https://example.com/jogos/file.zip?token=QSECRET123 fim',
  'login https://usuario:pw-secreto@host.example/x',
  'Cookie: SAPISID=cookiesecretFALSO; SID=outra',
  '{"apiKey":"jsonsecretvalue","name":"Astro Bot","refresh_token":"refreshFALSO123"}',
  'password=hunter2pass',
  'conta jogador.teste@gmail.com entrou',
  'chave ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 colada',
  'hash 0123456789abcdef0123456789abcdef01234567',
  'rd ABCDEFGHJKLMNPQRSTUVWXYZ23456789ABCDEFGHJKLMNPQRSTUV',
  `torbox key ${TORBOX_KEY} e alldebrid ${ALLDEBRID_KEY} e tube ${TUBE_TOKEN} e github ${GITHUB_KEY}`,
  'baixando Astro Bot (PPSA01234) 45% em /mnt/usb0/homebrew',
];
const HARMLESS = 'baixando Astro Bot (PPSA01234) 45% em /mnt/usb0/homebrew';

// ---- O payload de verdade, compilado para o PC ----
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-diag-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 400)}` : false;
const children = new Set();
const servers = new Set();
after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const server of servers) { server.closeAllConnections?.(); server.close(); }
  rmSync(dir, { recursive: true, force: true });
});

// O GitHub falso: guarda cada PUT; `mode` = 201 (ok) ou o codigo de erro a devolver.
async function fakeGitHub() {
  const state = { mode: 201, delay: 0, puts: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      if (state.delay) await wait(state.delay);
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      state.puts.push({ method: req.method, url: req.url, headers: req.headers, body, text: body?.content ? Buffer.from(body.content, 'base64').toString('utf8') : '' });
      res.writeHead(state.mode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.mode === 201 ? { content: { path: req.url } } : { message: 'Bad credentials' }));
    });
  });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  servers.add(server);
  return { state, port };
}
async function fakeGlibren() {
  const server = http.createServer((req, res) => {
    if (req.url === '/diario') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('glibren: icone baixado\nconta fulano@exemplo.com.br pareada\n'); return; }
    res.writeHead(404); res.end();
  });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  servers.add(server);
  return port;
}

let run = 0;
async function startPayload(githubBase, glibrenPort) {
  const base = path.join(dir, `run${++run}`);
  for (const sub of ['state', 'tube', 'apps/PPSA99471/logs', 'diag']) mkdirSync(path.join(base, sub), { recursive: true });
  writeFileSync(path.join(base, 'debrid.json'), JSON.stringify({ torbox: { key: TORBOX_KEY }, alldebrid: { key: ALLDEBRID_KEY } }));
  // os logs: um jobeeslair.log de 3 MB (o corte de ~2 MB) com os segredos no fim
  const filler = Array.from({ length: 90000 }, (_, i) => `[12:00:00.000] INFO enchimento linha ${i} do log do app`).join('\n');
  writeFileSync(path.join(base, 'apps/PPSA99471/logs/jobeeslair.log'), `${'X'.repeat(200)}\n${filler}\n${SECRET_LINES.join('\n')}\n`);
  writeFileSync(path.join(base, 'apps/PPSA99471/logs/jobeeslair.1.log'), `${SECRET_LINES.join('\n')}\n`);
  writeFileSync(path.join(base, 'state/bgdl.log.old'), `${SECRET_LINES.join('\n')}\n`);
  writeFileSync(path.join(base, 'state/last-crash.json'), JSON.stringify({ at: '2026-11-12 10:00:00', lines: SECRET_LINES.slice(0, 4) }));
  writeFileSync(path.join(base, 'tube/tube.log'), `${SECRET_LINES.join('\n')}\n`);
  writeFileSync(path.join(base, 'tube/account.json'), JSON.stringify({ refresh: 'CONTA-SECRETA-YT' }));
  writeFileSync(path.join(base, 'tube/token'), `${TUBE_TOKEN}\n`);
  const api = await freePort(), monitor = await freePort();
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor), BGDL_ORBIT_DIR: path.join(base, 'orbit'),
    BGDL_LIBRARY: path.join(base, 'lista.json'), BGDL_KEYFILE: path.join(base, 'debrid.json'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_DIAG_DIR: path.join(base, 'diag'),
    BGDL_TUBE_DIR: path.join(base, 'tube'), BGDL_APP_LOGS_ROOT: path.join(base, 'apps'), BGDL_GITHUB_BASE: githubBase, BGDL_GLIBREN_BASE: `http://127.0.0.1:${glibrenPort}` },
    stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const call = async (method, route, body) => {
    const token = readFileSync(path.join(base, 'state/token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text };
  };
  const page = async (route, { method = 'GET', body, session } = {}) => {
    const res = await fetch(`http://127.0.0.1:${monitor}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Session': session } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const buffer = Buffer.from(await res.arrayBuffer());
    let data = {};
    try { data = JSON.parse(buffer.toString('utf8')); } catch {}
    return { status: res.status, data, text: buffer.toString('utf8'), buffer, type: res.headers.get('content-type') };
  };
  for (const end = Date.now() + 30000; ; await wait(50)) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call('GET', '/health')).status === 200) break; } catch {}
    if (Date.now() > end) throw new Error('payload did not start');
  }
  const PIN = '2468';
  const salt = randomBytes(32).toString('hex');
  assert.equal((await call('POST', '/config', { pinSalt: salt, pinHash: sha(`${salt}:${PIN}`) })).status, 200);
  const session = (await page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data.session;
  assert.match(session, /^[0-9a-f]{32}$/);
  const until = async () => {
    for (const end = Date.now() + 60000; Date.now() < end; await wait(100)) {
      const state = (await call('GET', '/diag')).data;
      if (state.state !== 'running') return state;
    }
    throw new Error('the diagnostics round never ended');
  };
  return { base, child, call, page, session, until, monitorPort: monitor };
}

// Um .zip lido a mao (diretorio central), para nao depender de unzip.
function readZip(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'zip sem EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const method = buffer.readUInt16LE(at + 10), size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32), local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    files[name] = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    at += 46 + nameLength + extra + comment;
  }
  return files;
}
const leaks = (text) => SECRETS.filter((secret) => text.includes(secret));

test('bg_diag.c compila junto com o payload, sem avisos (-Wall -Wextra -Werror)', { skip: !compiler || missing ? 'no compiler or headers' : false }, () => {
  assert.equal(built.status, 0, built.stderr);
});

test('glibren.44: sem chave nada sai (pagina e app), sem PIN 401, chave estranha 400; a chave nunca volta num GET nem no diario', { skip }, async () => {
  const gh = await fakeGitHub();
  const p = await startPayload(`http://127.0.0.1:${gh.port}`, await fakeGlibren());
  assert.equal((await p.page('/api/diag')).status, 401, 'sem a sessao do PIN');
  assert.equal((await p.page('/api/diag/key', { method: 'POST', body: { key: GITHUB_KEY } })).status, 401);
  assert.equal((await p.page('/api/diag/zip')).status, 401);
  const none = await p.page('/api/diag', { session: p.session });
  assert.equal(none.status, 200);
  assert.equal(none.data.configured, false);
  const refused = await p.page('/api/diag/send', { method: 'POST', body: {}, session: p.session });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error, 'no-key');
  const refusedApp = await p.call('POST', '/diag/send', diagnosticsBody({ jobe: '0.5.5-glibren.44' }));
  assert.equal(refusedApp.status, 400);
  assert.equal(refusedApp.data.error, 'no-key');
  assert.equal(gh.state.puts.length, 0, 'nada chegou ao GitHub');
  for (const bad of ['curta', 'tem espaco no meio de uma chave longa', 'x'.repeat(300), 'chave-com-hifen-0000000000000']) {
    const r = await p.page('/api/diag/key', { method: 'POST', body: { key: bad }, session: p.session });
    assert.equal(r.status, 400, bad);
    assert.equal(r.data.error, 'key');
  }
  const saved = await p.page('/api/diag/key', { method: 'POST', body: { key: `  ${GITHUB_KEY} ` }, session: p.session });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.configured, true);
  assert.equal(saved.data.tail, GITHUB_KEY.slice(-4));
  assert.ok(!saved.text.includes(GITHUB_KEY));
  const file = path.join(p.base, 'diag/token');
  assert.equal(readFileSync(file, 'utf8'), GITHUB_KEY);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const answer of [await p.page('/api/diag', { session: p.session }), await p.call('GET', '/diag'), await p.page('/api/status'), await p.call('GET', '/health')]) {
    assert.ok(!answer.text.includes(GITHUB_KEY), 'a chave nunca volta');
    assert.ok(!answer.text.includes(GITHUB_KEY.slice(0, 30)), 'nem um pedaco grande');
  }
  assert.equal((await p.call('GET', '/diag')).data.tail, GITHUB_KEY.slice(-4));
  const removed = await p.page('/api/diag/key/remove', { method: 'POST', body: {}, session: p.session });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.configured, false);
  assert.ok(!existsSync(file));
  await wait(300);
  const log = readFileSync(path.join(p.base, 'state/bgdl.log'), 'utf8');
  assert.match(log, /diagnostico: chave do GitHub gravada/);
  assert.match(log, /diagnostico: chave do GitHub removida/);
  assert.ok(!log.includes(GITHUB_KEY) && !log.includes(GITHUB_KEY.slice(-12)), 'a chave nunca vai ao diario');
  p.child.kill('SIGTERM');
});

test('glibren.44: envio pelo app contra o GitHub falso: um PUT por arquivo, pasta com a hora, tudo higienizado, 409 numa segunda rodada', { skip }, async () => {
  const gh = await fakeGitHub();
  gh.state.delay = 150;
  const p = await startPayload(`http://127.0.0.1:${gh.port}`, await fakeGlibren());
  assert.equal((await p.page('/api/diag/key', { method: 'POST', body: { key: GITHUB_KEY }, session: p.session })).status, 200);
  const snapshot = { last: { used: 20 * 2 ** 20, limit: 64 * 2 ** 20, action: 'tela:loja', at: 1 }, peak: { used: 35 * 2 ** 20, limit: 64 * 2 ** 20, action: 'biblioteca-torbox:gravar', at: 2 },
    top: [{ action: 'biblioteca-torbox:gravar', used: 35 * 2 ** 20 }, { action: 'tela:loja', used: 20 * 2 ** 20 }] };
  const first = await p.call('POST', '/diag/send', diagnosticsBody({ snapshot, jobe: '0.5.5-glibren.44', tube: '0.2.1', title: 'PPSA99471' }));
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.state, 'running');
  const second = await p.page('/api/diag/send', { method: 'POST', body: {}, session: p.session });
  assert.equal(second.status, 409, 'uma rodada por vez');
  assert.equal(second.data.error, 'busy');
  const end = await p.until();
  assert.equal(end.state, 'done', JSON.stringify(end));
  assert.match(end.folder, /^\d{4}-\d{2}-\d{2}_\d{6}$/);
  assert.equal(end.sent, end.total);
  const names = gh.state.puts.map((put) => put.url.split('/').pop()).sort();
  for (const name of ['bgdl.log', 'bgdl.log.old', 'config.json', 'glibren.log', 'info.json', 'jobeeslair.1.log', 'jobeeslair.log', 'last-crash.json', 'tube.log']) assert.ok(names.includes(name), `${name} em ${names}`);
  assert.ok(!names.some((name) => /account|token|debrid/.test(name)), `nunca: ${names}`);
  for (const put of gh.state.puts) {
    assert.equal(put.method, 'PUT');
    assert.equal(put.url, `/repos/pristmc-code/ps5-diagnosticos/contents/${end.folder}/${put.url.split('/').pop()}`);
    assert.equal(put.headers.authorization, `Bearer ${GITHUB_KEY}`);
    assert.equal(put.headers.accept, 'application/vnd.github+json');
    assert.equal(put.body.branch, 'main');
    assert.deepEqual(put.body.committer, { name: 'PristMC', email: '285300718+pristmc-code@users.noreply.github.com' });
    assert.equal(put.body.message, `diagnostico ${end.folder} 0.5.5-glibren.44`);
    assert.deepEqual(leaks(put.text), [], `${put.url} vazou`);
  }
  const file = (name) => gh.state.puts.find((put) => put.url.endsWith(`/${name}`)).text;
  // as regras: o que sai e o que fica
  const log = file('jobeeslair.1.log');
  for (const piece of [HARMLESS, 'Authorization: [segredo]', 'googlevideo.com/[...]', 'api.torbox.app/[...]', 'https://example.com/jogos/file.zip?[...] fim', 'https://[segredo]@host.example/x', 'Cookie: [segredo]',
    '"apiKey":"[segredo]"', '"name":"Astro Bot"', 'password=[segredo]', 'conta [email] entrou', 'chave [segredo] colada', 'hash [segredo]', 'rd [segredo]']) assert.ok(log.includes(piece), `${piece}\n---\n${log}`);
  assert.ok(file('glibren.log').includes('conta [email] pareada'), 'o diario do glibren vem e e higienizado');
  const big = file('jobeeslair.log');
  assert.ok(big.length <= 2 * 1024 * 1024 + 4096, `cortado nos ~2 MB: ${big.length}`);
  assert.ok(big.includes(HARMLESS), 'o fim (o mais novo) fica');
  assert.ok(!big.includes('X'.repeat(200)), 'o comeco sai');
  const info = JSON.parse(file('info.json'));
  assert.equal(info.folder, end.folder);
  assert.equal(info.from, 'app');
  assert.equal(info.app.jobe, '0.5.5-glibren.44');
  assert.equal(info.app.tube, '0.2.1');
  assert.equal(info.app.title, 'PPSA99471');
  assert.equal(info.app.memory.peak.action, 'biblioteca-torbox:gravar');
  assert.equal(info.app.memory.top.length, 2);
  assert.equal(info.payload.api, 30);
  assert.equal(info.files.find((f) => f.name === 'jobeeslair.log').cut, true);
  // o config.json do payload vai sem o sal/hash do PIN
  assert.ok(!/[0-9a-f]{64}/.test(file('config.json')), file('config.json'));
  const diario = readFileSync(path.join(p.base, 'state/bgdl.log'), 'utf8');
  assert.match(diario, new RegExp(`diagnostico: enviado \\(\\d+ arquivo\\(s\\), pasta ${end.folder}, pedido pelo app\\)`));
  assert.ok(!diario.includes(GITHUB_KEY));
  // pela pagina do celular tambem (usa a Memoria/versoes que o app mandou por ultimo)
  await wait(1100); // outra pasta (a hora tem segundos)
  gh.state.puts = [];
  assert.equal((await p.page('/api/diag/send', { method: 'POST', body: {}, session: p.session })).status, 200);
  const again = await p.until();
  assert.equal(again.state, 'done');
  assert.notEqual(again.folder, end.folder);
  assert.equal(JSON.parse(gh.state.puts.find((put) => put.url.endsWith('/info.json')).text).from, 'celular');
  p.child.kill('SIGTERM');
});

test('glibren.44: erros claros: 401 chave invalida, 403 sem permissao, 404 sem o repositorio, sem internet', { skip }, async () => {
  const gh = await fakeGitHub();
  const glibren = await fakeGlibren();
  const p = await startPayload(`http://127.0.0.1:${gh.port}`, glibren);
  assert.equal((await p.page('/api/diag/key', { method: 'POST', body: { key: GITHUB_KEY }, session: p.session })).status, 200);
  for (const [code, error] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'no-repo'], [422, 'http']]) {
    gh.state.mode = code;
    gh.state.puts = [];
    assert.equal((await p.page('/api/diag/send', { method: 'POST', body: {}, session: p.session })).status, 200);
    const end = await p.until();
    assert.equal(end.state, 'failed');
    assert.equal(end.error, error);
    assert.equal(end.http, code);
    assert.equal(gh.state.puts.length, 1, 'para no primeiro erro');
    await wait(1100);
  }
  p.child.kill('SIGTERM');
  // sem rede: o GitHub nao responde (porta fechada)
  const closed = await freePort();
  const q = await startPayload(`http://127.0.0.1:${closed}`, glibren);
  assert.equal((await q.page('/api/diag/key', { method: 'POST', body: { key: GITHUB_KEY }, session: q.session })).status, 200);
  assert.equal((await q.call('POST', '/diag/send', {})).status, 200);
  const end = await q.until();
  assert.equal(end.state, 'failed');
  assert.equal(end.error, 'network');
  assert.match(readFileSync(path.join(q.base, 'state/bgdl.log'), 'utf8'), /diagnostico: falhou \(network/);
  q.child.kill('SIGTERM');
});

test('glibren.44: "Baixar diagnostico (.zip)": os mesmos arquivos, higienizados, sem precisar da chave', { skip }, async () => {
  const gh = await fakeGitHub();
  const p = await startPayload(`http://127.0.0.1:${gh.port}`, await fakeGlibren());
  const r = await p.page('/api/diag/zip', { session: p.session });
  assert.equal(r.status, 200);
  assert.equal(r.type, 'application/zip');
  const files = readZip(r.buffer);
  const names = Object.keys(files).map((name) => name.split('/').pop()).sort();
  for (const name of ['bgdl.log.old', 'glibren.log', 'info.json', 'jobeeslair.1.log', 'jobeeslair.log', 'last-crash.json', 'tube.log']) assert.ok(names.includes(name), `${name} em ${names}`);
  assert.ok(Object.keys(files).every((name) => /^\d{4}-\d{2}-\d{2}_\d{6}\//.test(name)), 'numa pasta com a hora');
  assert.ok(!names.some((name) => /account|token/.test(name)));
  for (const [name, text] of Object.entries(files)) assert.deepEqual(leaks(text), [], `${name} vazou`);
  assert.ok(files[Object.keys(files).find((name) => name.endsWith('/tube.log'))].includes(HARMLESS));
  assert.equal(gh.state.puts.length, 0, 'o .zip nao fala com o GitHub');
  // o app JobeControle (WebView da pagina): Host com o IP do PS5 e a porta, User-Agent com "JobeControle/": nada de 403 (J6)
  const viaWebView = (route, { method = 'GET', body = null, host } = {}) => new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: p.monitorPort, path: route, method, headers: { Host: host, 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 JobeControle/1.0',
      'X-Session': p.session, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  const host = `192.168.0.20:${p.monitorPort}`;
  assert.equal((await viaWebView('/', { host })).status, 200, 'a pagina abre na WebView');
  assert.equal((await viaWebView('/api/diag', { host })).status, 200);
  const keyed = await viaWebView('/api/diag/key', { method: 'POST', body: { key: GITHUB_KEY }, host });
  assert.equal(keyed.status, 200, keyed.text);
  assert.ok(!keyed.text.includes(GITHUB_KEY));
  assert.equal((await viaWebView('/api/diag', { host: `jobe.example:${p.monitorPort}` })).status, 403, 'nome de dominio continua recusado (J6)');
  p.child.kill('SIGTERM');
});

test('glibren.44: o lado do app: corpo enxuto, acompanha a rodada e escolhe a mensagem', async () => {
  const snapshot = { last: { used: 1, limit: 2, action: 'a', at: 3, extra: 'x' }, peak: null, top: Array.from({ length: 30 }, (_, i) => ({ action: `t${i}`, used: i })) };
  const body = diagnosticsBody({ snapshot, jobe: '0.5.5-glibren.44', tube: null, title: 'PPSA99471' });
  assert.deepEqual(body.versions, { jobe: '0.5.5-glibren.44', tube: '', title: 'PPSA99471' });
  assert.equal(body.memory.top.length, 10);
  assert.equal(body.memory.peak, null);
  assert.equal(body.memory.last.extra, undefined);
  const states = [{ state: 'running', sent: 1, total: 5 }, { state: 'done', folder: '2026-11-12_101010', sent: 5, total: 5 }];
  const seen = [];
  const link = { send: async (b) => { seen.push(b); return { status: 200, data: { ok: true } }; }, status: async () => ({ status: 200, data: states.shift() }) };
  const progress = [];
  assert.deepEqual(await sendDiagnostics(body, { link, pause: async () => {}, progress: (p) => progress.push(p) }), { state: 'done', folder: '2026-11-12_101010' });
  assert.deepEqual(seen, [body]);
  assert.deepEqual(progress[0], { sent: 1, total: 5 });
  assert.deepEqual(await sendDiagnostics(body, { link: { send: async () => ({ status: 400, data: { error: 'no-key' } }) } }), { state: 'failed', error: 'no-key' });
  assert.deepEqual(await sendDiagnostics(body, { link: { send: async () => ({ status: 409, data: { error: 'busy' } }) } }), { state: 'failed', error: 'busy' });
  assert.deepEqual(await sendDiagnostics(body, { link: null }), { state: 'failed', error: 'no-payload' });
  const failed = await sendDiagnostics(body, { link: { send: async () => ({ status: 200, data: {} }), status: async () => ({ status: 200, data: { state: 'failed', error: 'unauthorized', http: 401 } }) }, pause: async () => {} });
  assert.deepEqual(failed, { state: 'failed', error: 'unauthorized', http: 401 });
  assert.equal(diagnosticsMessageKey(failed), 'settings.diag.unauthorized');
  assert.equal(diagnosticsMessageKey({ state: 'failed', error: 'no-repo' }), 'settings.diag.forbidden');
  assert.equal(diagnosticsMessageKey({ state: 'failed', error: 'zzz' }), 'settings.diag.failed');
  assert.equal(diagnosticsMessageKey({ state: 'done' }), 'settings.diag.sent');
  assert.equal(await diagnosticsKeyState({ link: { status: async () => ({ status: 200, data: { configured: true, tail: 'abcd' } }) } }), true);
  assert.equal(await diagnosticsKeyState({ link: { status: async () => ({ status: 200, data: { configured: false } }) } }), false);
  assert.equal(await diagnosticsKeyState({ link: { status: async () => ({ status: 0, data: {} }) } }), null, 'sem payload: nao se sabe');
  assert.equal(await diagnosticsKeyState({ link: null }), null);
  const en = JSON.parse(readFileSync(path.join(repo, 'app/i18n/locales/en.json'), 'utf8'));
  for (const key of ['row', 'hint', 'keySet', 'keyMissing', 'sending', 'sent', 'noKey', 'busy', 'noPayload', 'unauthorized', 'forbidden', 'network', 'failed']) assert.ok(en[`settings.diag.${key}`], key);
});

test('glibren.44: a pagina do celular tem o Diagnostico (chave, enviar, .zip) e o app o "Enviar diagnostico"', () => {
  const page = readFileSync(path.join(repo, 'app/native/bg_monitor.html'), 'utf8');
  for (const piece of ['/api/diag/key', '/api/diag/key/remove', '/api/diag/send', '/api/diag/zip', 'Chave do GitHub para diagnóstico', 'Enviar diagnóstico', 'Baixar diagnóstico (.zip)', 'Enviado ✓ (pasta {f})', 'input.type = "password"', '/JobeControle\\//.test(navigator.userAgent)']) assert.ok(page.includes(piece), piece);
  const settings = readFileSync(path.join(repo, 'app/ui/Settings.jsx'), 'utf8');
  assert.ok(settings.includes('jsx(DiagnosticsRow, { Row, Callout })'));
  assert.ok(!/prompt\(|navigator\.clipboard/.test(page), 'nada que a WebView do JobeControle possa nao ter');
  const bg = readFileSync(path.join(repo, 'app/state/background-downloads.js'), 'utf8');
  assert.ok(bg.includes('backupCall(true, "POST", "/diag/send", body)'));
  const c = readFileSync(path.join(repo, 'app/native/bg_diag.c'), 'utf8');
  assert.equal(c.match(/static const char\* const DIAG_SECRET_NAMES\[\]/g).length, 1, 'a lista de regras num lugar so');
  assert.ok(!/logk?f?_\([^;]*key\b[^;]*\);/.test(c.replace(/chave do GitHub (gravada|removida)/g, '')), 'nenhuma linha do diario com a chave');
});
