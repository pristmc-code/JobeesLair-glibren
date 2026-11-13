// glibren.44: "Atualizar a Jobe" pela pagina do celular (app/native/bg_jobe.c + state/jobe-remote.js):
//   - o payload so guarda o pedido (sobrevive a reiniciar o payload) e o estado que o app manda; nenhuma rota instala;
//   - o app ve o pedido, o assume ("taken") e roda procurar -> baixar -> reiniciar (o fluxo de state/update.js);
//   - recusa com uma conversao rodando, fora do console, e quando o reiniciar e recusado; "ja na mais nova";
//   - a pagina mostra o estado (procurando, baixando N%, reiniciando, erro) e "Abra a Jobe" com o app fechado;
//   - PIN obrigatorio e o J6 (Host) igual para o app JobeControle.
// Run: node --import ./tests/stub-loader.mjs --test tests/bg-jobe-update.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePortFrom } from './free-port.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const { createJobeRemote } = await import(pathToFileURL(path.join(repo, 'app/state/jobe-remote.js')).href);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const freePort = freePortFrom(18); // glibren.44: bloco de portas so deste arquivo (tests/free-port.mjs)
const VERSION = '0.5.5-glibren.44';

// ---- O lado do app, com um payload e uma atualizacao de mentira ----
function fakeLink({ request = null, conversions = [] } = {}) {
  const link = { pending: request, reports: [], conversions: async () => conversions,
    request: async () => ({ status: 200, data: { request: link.pending } }),
    report: async (body) => { link.reports.push(body); if (body.taken && link.pending?.id === body.taken) link.pending = null; return { status: 200, data: { ok: true } }; } };
  return link;
}
function fakeUpdate({ newer = '0.5.5-glibren.45', canInstall = true, refuse = '' } = {}) {
  const u = { canInstall, checks: 0, downloads: 0, restarts: 0, steps: 0,
    view: { update: { update: null, checking: false, checkedAt: 1731400000000, failed: false }, install: { phase: 'idle', version: null, written: 0, total: 0, error: '' }, auto: false } };
  u.check = async () => { u.checks++; u.view.update = { ...u.view.update, update: newer ? { version: newer, assets: {} } : null }; return u.view.update; };
  u.snapshot = () => {
    // cada olhada anda o download (0 -> 50% -> pronta)
    if (u.view.install.phase === 'downloading') {
      u.view.install = u.view.install.written >= 50 ? { ...u.view.install, phase: 'ready', written: 100 } : { ...u.view.install, written: u.view.install.written + 50 };
    }
    return u.view;
  };
  u.download = () => { u.downloads++; u.view.install = { phase: 'downloading', version: newer, written: 0, total: 100, error: '' }; return true; };
  u.restart = () => { u.restarts++; return refuse; };
  return u;
}
const make = (link, update, extra = {}) => createJobeRemote({ link: () => link, update, version: VERSION, text: (key, vars) => vars?.version ? `${key}:${vars.version}` : key, pause: async () => {}, ...extra });

test('glibren.44: o app ve o pedido do celular, o assume e roda procurar -> baixar -> reiniciar', async () => {
  const link = fakeLink({ request: { id: '1700', at: 1 } });
  const update = fakeUpdate();
  const notes = [];
  const remote = make(link, update, { notify: (text) => notes.push(text) });
  await remote.tick();
  assert.equal(link.reports[0].taken, '1700', 'o primeiro estado assume o pedido');
  assert.equal(link.reports[0].phase, 'checking');
  assert.equal(link.pending, null, 'saiu da fila do payload');
  assert.deepEqual(notes, ['update.remote.requested']);
  assert.equal(update.checks, 1);
  assert.equal(update.downloads, 1);
  assert.ok(link.reports.some((r) => r.phase === 'downloading' && r.percent === 50), JSON.stringify(link.reports.map((r) => `${r.phase}:${r.percent}`)));
  assert.equal(update.restarts, 1, 'reiniciar para aplicar (restartToApply)');
  const last = link.reports.at(-1);
  assert.equal(last.phase, 'restarting');
  assert.equal(last.installed, VERSION);
  assert.equal(last.latest, '0.5.5-glibren.45');
  // o mesmo pedido nunca roda duas vezes; sem pedido, so manda o estado
  link.pending = { id: '1700', at: 1 };
  await remote.tick();
  assert.equal(update.checks, 1);
});

test('glibren.44: recusa com uma conversao rodando, fora do console e quando o reiniciar e recusado; ja na mais nova', async () => {
  for (const state of ['converting', 'queued', 'extracting', 'verifying']) {
    const link = fakeLink({ request: { id: '1', at: 1 }, conversions: [{ id: 'c1', state: 'done' }, { id: 'c2', state }] });
    const update = fakeUpdate();
    await make(link, update).tick();
    const last = link.reports.at(-1);
    assert.equal(last.phase, 'failed');
    assert.equal(last.error, 'busy-convert');
    assert.equal(last.detail, 'update.remote.busyConvert');
    assert.equal(update.checks + update.downloads + update.restarts, 0, `nada comecou com ${state}`);
  }
  const off = fakeLink({ request: { id: '2', at: 1 } });
  await make(off, fakeUpdate({ canInstall: false })).tick();
  assert.equal(off.reports.at(-1).error, 'console-only');
  const refused = fakeLink({ request: { id: '3', at: 1 } });
  await make(refused, fakeUpdate({ refuse: 'Extraindo Astro Bot' })).tick();
  assert.equal(refused.reports.at(-1).error, 'restart-refused');
  assert.equal(refused.reports.at(-1).detail, 'Extraindo Astro Bot');
  const current = fakeLink({ request: { id: '4', at: 1 } });
  const none = fakeUpdate({ newer: null });
  await make(current, none).tick();
  assert.equal(current.reports.at(-1).phase, 'current');
  assert.equal(current.reports.at(-1).detail, `update.remote.current:${VERSION}`);
  assert.equal(none.downloads, 0);
});

// ---- O payload de verdade, compilado para o PC ----
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-jobe-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 400)}` : false;
const children = new Set();
after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});
async function startPayload(base, env = {}) {
  mkdirSync(path.join(base, 'state'), { recursive: true });
  const api = await freePort(), monitor = await freePort();
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor), BGDL_ORBIT_DIR: path.join(base, 'orbit'),
    BGDL_LIBRARY: path.join(base, 'lista.json'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_DIAG_DIR: path.join(base, 'diag'), BGDL_GLIBREN_BASE: 'http://127.0.0.1:9', ...env },
    stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const call = async (method, route, body) => {
    const token = readFileSync(path.join(base, 'state/token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  // como o navegador / o app JobeControle (WebView): Host com o IP do PS5 e a porta
  const page = (route, { method = 'GET', body = null, session = '', host = `192.168.0.20:${monitor}`, agent = 'Mozilla/5.0 (Linux; Android 14; wv) JobeControle/1.0' } = {}) => new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: monitor, path: route, method, headers: { Host: host, 'User-Agent': agent, ...(session ? { 'X-Session': session } : {}),
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, data: json, text }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  for (const end = Date.now() + 30000; ; await wait(50)) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call('GET', '/health')).status === 200) break; } catch {}
    if (Date.now() > end) throw new Error('payload did not start');
  }
  return { child, call, page };
}
async function unlock(p) {
  const PIN = '1357';
  const salt = randomBytes(32).toString('hex');
  assert.equal((await p.call('POST', '/config', { pinSalt: salt, pinHash: sha(`${salt}:${PIN}`) })).status, 200);
  const session = (await p.page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data.session;
  assert.match(session, /^[0-9a-f]{32}$/);
  return session;
}
const stop = (child) => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); });

test('bg_jobe.c compila junto com o payload, sem avisos (-Wall -Wextra -Werror)', { skip: !compiler || missing ? 'no compiler or headers' : false }, () => {
  assert.equal(built.status, 0, built.stderr);
});

test('glibren.44: a area Jobe no payload: PIN, J6, o pedido guardado, visto e assumido pelo app, e o estado na pagina', { skip }, async () => {
  const base = path.join(dir, 'run1');
  let p = await startPayload(base, { BGDL_APP_SILENCE_MS: '600000' });
  // sem a sessao do PIN: 401; nome de dominio no Host: 403 (J6), como no resto da pagina
  assert.equal((await p.page('/api/jobe')).status, 401);
  assert.equal((await p.page('/api/jobe/update', { method: 'POST', body: {} })).status, 401);
  const session = await unlock(p);
  assert.equal((await p.page('/api/jobe', { session, host: 'jobe.example:34201' })).status, 403, 'J6 vale tambem aqui');
  assert.equal((await p.page('/', { host: '192.168.0.20:34201' })).status, 200, 'a pagina abre no JobeControle (Host com IP)');
  // antes de o app falar: nada sabido, app fechado
  let s = (await p.page('/api/jobe', { session })).data;
  assert.equal(s.ok, true);
  assert.equal(s.installed, '');
  assert.equal(s.requested, false);
  assert.equal(s.appOpen, false);
  // o app manda o estado; a pagina ve a versao, a ultima publicada e o app aberto
  assert.equal((await p.call('POST', '/jobe/state', { installed: VERSION, latest: '0.5.5-glibren.45', checkedAt: 1731400000, phase: 'idle', percent: 0, error: '', detail: '', auto: true })).status, 200);
  s = (await p.page('/api/jobe', { session })).data;
  assert.equal(s.installed, VERSION);
  assert.equal(s.latest, '0.5.5-glibren.45');
  assert.equal(s.appOpen, true);
  assert.equal(s.auto, true);
  // estado invalido: 400 (nada de texto livre nas versoes, fase conhecida)
  assert.equal((await p.call('POST', '/jobe/state', { installed: '<script>', latest: '', phase: 'idle' })).status, 400);
  assert.equal((await p.call('POST', '/jobe/state', { installed: VERSION, latest: '', phase: 'instalar-ja' })).status, 400);
  // o pedido: guardado e visto pelo app; um segundo pedido e o mesmo
  assert.deepEqual((await p.call('GET', '/jobe')).data, { request: null });
  const asked = await p.page('/api/jobe/update', { method: 'POST', body: {}, session });
  assert.equal(asked.status, 200);
  assert.equal(asked.data.requested, true);
  const seen = (await p.call('GET', '/jobe')).data.request;
  assert.match(seen.id, /^\d+$/);
  await p.page('/api/jobe/update', { method: 'POST', body: {}, session });
  assert.equal((await p.call('GET', '/jobe')).data.request.id, seen.id, 'o mesmo pedido');
  // o pedido sobrevive a reiniciar o payload (a Jobe fechada atende quando abrir)
  await stop(p.child);
  p = await startPayload(base, { BGDL_APP_SILENCE_MS: '600000' });
  const session2 = await unlock(p);
  assert.equal((await p.call('GET', '/jobe')).data.request.id, seen.id);
  // o app roda o fluxo (jobe-remote com a atualizacao de mentira) contra o payload de verdade
  const link = { request: () => p.call('GET', '/jobe'), report: (body) => p.call('POST', '/jobe/state', body), conversions: async () => [] };
  const update = fakeUpdate();
  const phases = [];
  const remote = createJobeRemote({ link: () => link, update, version: VERSION, pause: async () => { phases.push((await p.page('/api/jobe', { session: session2 })).data); } });
  await remote.tick();
  assert.equal(update.restarts, 1);
  assert.deepEqual((await p.call('GET', '/jobe')).data, { request: null }, 'o app assumiu: saiu da fila');
  assert.ok(phases.some((x) => x.phase === 'downloading' && x.percent === 50), JSON.stringify(phases.map((x) => `${x.phase}:${x.percent}`)));
  s = (await p.page('/api/jobe', { session: session2 })).data;
  assert.equal(s.phase, 'restarting');
  assert.equal(s.requested, false);
  // a recusa (conversao rodando) chega a pagina com o motivo
  await p.page('/api/jobe/update', { method: 'POST', body: {}, session: session2 });
  const busy = { ...link, conversions: async () => [{ id: 'c', state: 'converting' }] };
  await createJobeRemote({ link: () => busy, update: fakeUpdate(), version: VERSION, text: (key) => key, pause: async () => {} }).tick();
  s = (await p.page('/api/jobe', { session: session2 })).data;
  assert.equal(s.phase, 'failed');
  assert.equal(s.error, 'busy-convert');
  assert.equal(s.detail, 'update.remote.busyConvert');
  const log = readFileSync(path.join(base, 'state/bgdl.log'), 'utf8');
  assert.match(log, /jobe: atualizacao pedida pela pagina do celular/);
  assert.match(log, /jobe: o app assumiu o pedido de atualizacao/);
  await stop(p.child);
});

test('glibren.44: com a Jobe fechada a pagina diz "Abra a Jobe para concluir"', { skip }, async () => {
  const p = await startPayload(path.join(dir, 'run2'), { BGDL_APP_SILENCE_MS: '300' });
  const session = await unlock(p);
  await p.call('POST', '/jobe/state', { installed: VERSION, latest: VERSION, phase: 'idle', auto: false });
  await p.page('/api/jobe/update', { method: 'POST', body: {}, session });
  await wait(700); // o app ficou calado
  const s = (await p.page('/api/jobe', { session })).data;
  assert.equal(s.requested, true);
  assert.equal(s.appOpen, false);
  await stop(p.child);
});

test('glibren.44: GET /focus diz se o foco do controle esta na Jobe (kern.msgbuf), so leitura', { skip }, async () => {
  const base = path.join(dir, 'run3');
  const msgbuf = path.join(base, 'msgbuf.txt');
  const p = await startPayload(base, { BGDL_MSGBUF_FILE: msgbuf, BGDL_APPIDS: '0x60000010=PPSA99471,0x60000020=PPSA99991' });
  assert.deepEqual((await p.call('GET', '/focus')).data, { ok: true, known: false, jobe: null, focus: null, at: null }, 'sem msgbuf');
  writeFileSync(msgbuf, 'linha qualquer\nVideoOut: shared (pid=0x5f, appId=0x60000010)\n');
  assert.deepEqual((await p.call('GET', '/focus')).data, { ok: true, known: false, jobe: null, focus: null, at: null }, 'sem SetControllerFocus');
  writeFileSync(msgbuf, 'SetControllerFocus(0x60000020)\nSetControllerFocus(0x60000010)\n');
  assert.deepEqual((await p.call('GET', '/focus')).data, { ok: true, known: true, jobe: true, focus: '0x60000010', at: null }, 'a ultima linha: a Jobe');
  writeFileSync(msgbuf, 'SetControllerFocus(0x60000010)\nSetControllerFocus(0x7)\n');
  assert.deepEqual((await p.call('GET', '/focus')).data, { ok: true, known: true, jobe: false, focus: '0x7', at: null }, 'a tela do sistema');
  writeFileSync(msgbuf, 'SetControllerFocus(0x60000020)\n');
  assert.equal((await p.call('GET', '/focus')).data.jobe, false, 'outro app');
  await stop(p.child);
});

test('glibren.44: a pagina tem a area Jobe e nenhuma rota instala pelo payload', () => {
  const page = readFileSync(path.join(repo, 'app/native/bg_monitor.html'), 'utf8');
  for (const piece of ['/api/jobe', '/api/jobe/update', 'Atualizar a Jobe', 'Update Jobe', 'Abra a Jobe para concluir', 'Baixando a atualização: {p}%', 'Pronto: reiniciando a Jobe para aplicar.']) assert.ok(page.includes(piece), piece);
  const c = readFileSync(path.join(repo, 'app/native/bg_jobe.c'), 'utf8');
  assert.ok(!/SelfUpdate|updater\.elf"|curl_easy|apply\.txt/.test(c.replace(/\/\/.*$/gm, '')), 'o payload nao baixa nem instala nada');
  const index = readFileSync(path.join(repo, 'app/index.jsx'), 'utf8');
  assert.ok(index.includes('startJobeRemote()'));
});
