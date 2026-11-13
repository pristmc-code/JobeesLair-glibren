// Pareamento por aparelho da pagina do celular (app/native/bg_pair.c), com o payload compilado para o PC e rodado de
// verdade, e a pagina (app/native/bg_monitor.html) e o estado do app (app/state/device-pairing.js):
//   - fluxo completo: pedir o codigo (notificacao, nunca no diario nem na resposta), a Jobe le o codigo em GET /pair,
//     confirmar, o token so do aparelho (X-Session ou Authorization: Bearer), so o SHA-256 em devices.json (0600),
//     sobrevive a reiniciar o payload;
//   - codigo errado: 5 tentativas, bloqueio crescente (30 s, 60 s...), codigo vencido em 2 min, um pedido a cada 10 s;
//   - token removido (pela pagina ou pela Jobe) recusado na hora;
//   - PIN antigo na transicao: continua valendo ate desligar; desligado, as sessoes caem e /api/unlock recusa;
//   - 127.0.0.1 isento (BGDL_TEST_LOCAL=1 no PC), menos com Origin de outro site;
//   - a lista de rotas protegidas (401 sem credencial);
//   - a pagina: sem prompt/alert/confirm (WebView do JobeControle), 14 idiomas, botoes da mesma linha com a mesma largura.
// O relogio do payload (BGDL_TEST_CLOCK_FILE) anda sem dormir. Run: node --import ./tests/stub-loader.mjs --test tests/bg-pairing.test.mjs
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePortFrom } from './free-port.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (file) => import(pathToFileURL(path.join(repo, file)).href);
const embed = await load('tools/bg-monitor/embed.mjs');
const pairing = await load('app/state/device-pairing.js');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const freePort = freePortFrom(19); // pareamento: bloco de portas so deste arquivo (tests/free-port.mjs)

const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-pair-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 400)}` : false;
const children = new Set();
beforeEach(async () => {
  const left = [...children];
  for (const child of left) child.kill('SIGKILL');
  await Promise.all(left.map((child) => child.exitCode !== null || child.signalCode ? null : new Promise((resolve) => child.once('exit', resolve))));
});
after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

test('bg_downloader.c (com bg_pair.c) compila sem avisos', { skip: !compiler || missing ? 'no compiler or headers' : false }, () => {
  assert.equal(built.status, 0, built.stderr);
});

const CLOCK_START = 1_800_000_000;
let run = 0;
// Sobe o payload; `base` repetido = o mesmo estado em disco (um "reinicio").
async function startPayload({ base, env = {} } = {}) {
  base ??= path.join(dir, `run${++run}`);
  mkdirSync(path.join(base, 'state'), { recursive: true });
  const clockFile = path.join(base, 'clock');
  if (!existsSync(clockFile)) writeFileSync(clockFile, String(CLOCK_START));
  const api = await freePort(), monitor = await freePort();
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor),
    BGDL_ORBIT_DIR: path.join(base, 'orbit'), BGDL_LIBRARY: path.join(base, 'lista.json'), BGDL_KEYFILE: path.join(base, 'debrid.json'),
    BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_TEST_CLOCK_FILE: clockFile, BGDL_GLIBREN_BASE: 'http://127.0.0.1:9', ...env }, stdio: ['ignore', 'ignore', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const app = async (method, route, body) => {
    const token = readFileSync(path.join(base, 'state/token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const page = async (route, { method = 'GET', body, session, bearer, origin } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (session) headers['X-Session'] = session;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (origin) headers.Origin = origin;
    const res = await fetch(`http://127.0.0.1:${monitor}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  for (const end = performance.now() + 30000; ; await wait(50)) {
    try { if (existsSync(path.join(base, 'state/token')) && (await app('GET', '/health')).status === 200 && (await page('/api/status')).status === 200) break; } catch {}
    if (performance.now() > end) throw new Error('payload did not start');
  }
  let at = Number(readFileSync(clockFile, 'utf8'));
  const advance = (seconds) => { at += seconds; writeFileSync(clockFile, String(at)); };
  const notices = () => { try { return readFileSync(path.join(base, 'notify.txt'), 'utf8'); } catch { return ''; } };
  // O ultimo codigo mostrado na TV (a notificacao: "123 456").
  const lastCode = () => { const all = [...notices().matchAll(/(\d{3}) (\d{3})/g)]; return all.length ? all.at(-1)[1] + all.at(-1)[2] : ''; };
  const stop = () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); });
  const log = () => { try { return readFileSync(path.join(base, 'state/bgdl.log'), 'utf8'); } catch { return ''; } };
  return { base, app, page, advance, lastCode, notices, stop, log };
}
// Pareia um aparelho do comeco ao fim e devolve { token, id }.
async function pair(p, name) {
  const asked = await p.page('/api/pair/request', { method: 'POST', body: { name } });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  const done = await p.page('/api/pair/confirm', { method: 'POST', body: { code: p.lastCode(), name } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  p.advance(11); // o proximo pedido de codigo nao esbarra no intervalo de 10 s
  return done.data;
}
const PIN = '246810';
const pinConfig = (pin = PIN) => { const salt = sha(`sal-${pin}-${Math.random()}`); return { pinSalt: salt, pinHash: sha(`${salt}:${pin}`) }; };

test('fluxo completo: codigo na TV e na Jobe, token so do aparelho, so o hash em disco, sobrevive a reiniciar', { skip }, async () => {
  const p = await startPayload();
  let info = (await p.page('/api/pair')).data;
  assert.deepEqual(info, { ok: true, paired: false, local: false, allowed: false, devices: 0, retryIn: 0, pinOn: true, pinSet: false });
  assert.equal((await p.page('/api/jobs/x/pause', { method: 'POST' })).status, 401, 'sem credencial: 401');

  const asked = await p.page('/api/pair/request', { method: 'POST', body: { name: '  Celular do João <script>  ' } });
  assert.deepEqual(asked.data, { ok: true, validFor: 120 }, 'a resposta nao traz o codigo');
  const code = p.lastCode();
  assert.match(code, /^\d{6}$/);
  assert.match(p.notices(), /Jobe: codigo de pareamento \d{3} \d{3} para "Celular do João script" \(vale 2 min\)/, 'notificacao em portugues sem pairText');
  // A Jobe aberta le o codigo (API local, com o token do app) e mostra na tela.
  const shown = (await p.app('GET', '/pair')).data;
  assert.equal(shown.code, code);
  assert.equal(shown.name, 'Celular do João script');
  assert.ok(shown.expiresIn > 0 && shown.expiresIn <= 120);
  assert.deepEqual(shown.devices, []);
  // Outro pedido antes de 10 s: espera (nao enche a TV de notificacoes).
  const again = await p.page('/api/pair/request', { method: 'POST', body: { name: 'outro' } });
  assert.equal(again.status, 429);
  assert.equal(again.data.error, 'wait');

  const done = await p.page('/api/pair/confirm', { method: 'POST', body: { code, name: 'Celular do João' } });
  assert.equal(done.status, 200);
  assert.match(done.data.token, /^[0-9a-f]{64}$/);
  assert.match(done.data.id, /^[0-9a-f]{16}$/);
  const { token, id } = done.data;
  assert.equal((await p.page('/api/pair/confirm', { method: 'POST', body: { code, name: 'x' } })).status, 409, 'um codigo, um aparelho');
  assert.equal((await p.app('GET', '/pair')).data.code, '', 'o codigo some da tela da Jobe');

  assert.equal((await p.page('/api/session', { session: token })).status, 200, 'X-Session com o token');
  assert.equal((await p.page('/api/session', { bearer: token })).status, 200, 'Authorization: Bearer');
  assert.equal((await p.page('/api/session', { session: 'f'.repeat(64) })).status, 401, 'outro token nao vale');
  info = (await p.page('/api/pair', { session: token })).data;
  assert.equal(info.paired, true);
  assert.equal(info.allowed, true);
  assert.equal(info.devices, 1);
  const list = (await p.page('/api/pair/devices', { session: token })).data;
  assert.equal(list.devices.length, 1);
  assert.deepEqual({ ...list.devices[0], at: 0 }, { id, name: 'Celular do João', at: 0, self: true });

  // Em disco so o SHA-256 do token, com nome e data; o codigo e o token nunca no diario.
  const file = path.join(p.base, 'state/devices.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = readFileSync(file, 'utf8');
  assert.ok(!saved.includes(token));
  assert.equal(JSON.parse(saved).devices[0].hash, sha(token));
  assert.equal(JSON.parse(saved).devices[0].at, CLOCK_START);
  assert.ok(!p.log().includes(token) && !p.log().includes(code) && !p.log().includes(`${code.slice(0, 3)} ${code.slice(3)}`), 'nem codigo nem token no diario');
  assert.match(p.log(), /aparelho "Celular do João" pareado/);

  // pairText (o aviso no idioma do jogador) vem no POST /config do app.
  assert.equal((await p.app('POST', '/config', { pairText: 'Pairing code {code} for "{name}"' })).status, 200);
  await p.stop();
  // Reinicio: o aparelho continua pareado.
  const q = await startPayload({ base: p.base });
  assert.equal((await q.page('/api/session', { session: token })).status, 200, 'o pareamento sobrevive a reiniciar o payload');
  q.advance(11);
  assert.equal((await q.page('/api/pair/request', { method: 'POST', body: { name: 'PC' } })).status, 200);
  assert.match(q.notices(), /Pairing code \d{3} \d{3} for "PC"/, 'o pairText guardado vale depois de reiniciar');
  await q.stop();
});

test('codigo errado: 5 tentativas, bloqueio crescente, codigo vence em 2 min', { skip }, async () => {
  const p = await startPayload();
  assert.equal((await p.page('/api/pair/request', { method: 'POST', body: { name: 'A' } })).status, 200);
  const code = p.lastCode();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let left = 4; left >= 1; left--) {
    const r = await p.page('/api/pair/confirm', { method: 'POST', body: { code: left === 2 ? '12' : wrong } }); // tamanho errado tambem conta
    assert.equal(r.status, 403);
    assert.deepEqual(r.data, { error: 'wrong', left });
  }
  let r = await p.page('/api/pair/confirm', { method: 'POST', body: { code: wrong } });
  assert.equal(r.status, 429);
  assert.deepEqual(r.data, { error: 'blocked', retryIn: 30 });
  assert.equal((await p.page('/api/pair/confirm', { method: 'POST', body: { code } })).status, 429, 'nem o certo passa no bloqueio');
  r = await p.page('/api/pair/request', { method: 'POST', body: { name: 'A' } });
  assert.deepEqual([r.status, r.data.error], [429, 'blocked'], 'nem um codigo novo');
  assert.equal((await p.page('/api/pair')).data.retryIn, 30);
  p.advance(31);
  assert.equal((await p.page('/api/pair/confirm', { method: 'POST', body: { code } })).status, 409, 'o codigo do bloqueio foi descartado');
  // Segunda rodada errada: 60 s.
  assert.equal((await p.page('/api/pair/request', { method: 'POST', body: { name: 'A' } })).status, 200);
  const second = p.lastCode();
  const bad = second === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) await p.page('/api/pair/confirm', { method: 'POST', body: { code: bad } });
  r = await p.page('/api/pair/confirm', { method: 'POST', body: { code: bad } });
  assert.deepEqual(r.data, { error: 'blocked', retryIn: 60 }, 'bloqueio crescente');
  p.advance(61);
  // Vencido: 2 min depois o codigo certo nao vale mais.
  assert.equal((await p.page('/api/pair/request', { method: 'POST', body: { name: 'A' } })).status, 200);
  const third = p.lastCode();
  p.advance(121);
  assert.equal((await p.app('GET', '/pair')).data.code, '', 'vencido some da tela da Jobe');
  r = await p.page('/api/pair/confirm', { method: 'POST', body: { code: third } });
  assert.ok([409, 410].includes(r.status), `vencido: ${r.status}`);
  // Um acerto zera o nivel do bloqueio.
  p.advance(1);
  const ok = await pair(p, 'A');
  assert.match(ok.token, /^[0-9a-f]{64}$/);
  assert.match(p.log(), /codigos de pareamento errados; bloqueado por 30 s/);
  await p.stop();
});

test('token removido e recusado na hora (pela pagina e pela Jobe); remover a si mesmo', { skip }, async () => {
  const p = await startPayload();
  const a = await pair(p, 'Aparelho A');
  const b = await pair(p, 'Aparelho B');
  assert.equal((await p.page('/api/session', { session: b.token })).status, 200);
  const list = (await p.page('/api/pair/devices', { session: a.token })).data.devices;
  assert.deepEqual(list.map((d) => [d.name, d.self]), [['Aparelho B', false], ['Aparelho A', true]], 'o mais novo primeiro, este aparelho marcado');
  // A remove B pela pagina.
  let r = await p.page('/api/pair/remove', { method: 'POST', session: a.token, body: { id: b.id } });
  assert.deepEqual(r.data, { ok: true, self: false });
  assert.equal((await p.page('/api/session', { session: b.token })).status, 401, 'B recusado na hora');
  assert.equal((await p.page('/api/config', { method: 'POST', session: b.token, body: { concurrency: 2 } })).status, 401);
  assert.equal((await p.page('/api/pair/remove', { method: 'POST', session: b.token, body: { id: a.id } })).status, 401, 'B nao remove mais ninguem');
  // A Jobe (API local) ve a lista e remove A.
  const fromApp = (await p.app('GET', '/pair')).data;
  assert.deepEqual(fromApp.devices.map((d) => d.name), ['Aparelho A']);
  assert.ok(!('self' in fromApp.devices[0]));
  assert.equal((await p.app('POST', '/pair/remove', { id: a.id })).status, 200);
  assert.equal((await p.page('/api/session', { session: a.token })).status, 401, 'A recusado na hora');
  assert.equal((await p.app('POST', '/pair/remove', { id: a.id })).status, 404);
  // Remover a si mesmo pela pagina.
  const c = await pair(p, 'C');
  r = await p.page('/api/pair/remove', { method: 'POST', session: c.token, body: { id: c.id } });
  assert.deepEqual(r.data, { ok: true, self: true });
  assert.equal((await p.page('/api/session', { session: c.token })).status, 401);
  assert.deepEqual(JSON.parse(readFileSync(path.join(p.base, 'state/devices.json'), 'utf8')).devices, []);
  await p.stop();
});

test('PIN antigo na transicao: vale ate desligar; desligado derruba as sessoes e /api/unlock recusa; ligar de novo', { skip }, async () => {
  const p = await startPayload();
  assert.equal((await p.app('POST', '/config', pinConfig())).status, 200);
  const old = (await p.page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data.session;
  assert.match(old, /^[0-9a-f]{32}$/);
  assert.equal((await p.page('/api/config', { method: 'POST', session: old, body: { concurrency: 2 } })).status, 200, 'o PIN antigo continua valendo');
  assert.equal((await p.page('/api/pair/devices', { session: old })).status, 401, 'o PIN nao gere aparelhos');
  assert.equal((await p.page('/api/pair/pin', { method: 'POST', session: old, body: { on: false } })).status, 401, 'nem desliga o proprio PIN');
  const dev = await pair(p, 'Novo');
  let info = (await p.page('/api/pair/devices', { session: dev.token })).data;
  assert.equal(info.pinOn, true);
  assert.equal(info.pinSet, true);
  const off = await p.page('/api/pair/pin', { method: 'POST', session: dev.token, body: { on: false } });
  assert.deepEqual(off.data, { ok: true, pinOn: false });
  assert.equal((await p.page('/api/config', { method: 'POST', session: old, body: { concurrency: 3 } })).status, 401, 'a sessao do PIN caiu na hora');
  assert.deepEqual((await p.page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data, { pinOff: true, retryIn: 0 });
  assert.equal((await p.page('/api/config', { method: 'POST', session: dev.token, body: { concurrency: 3 } })).status, 200, 'o aparelho pareado continua');
  assert.equal((await p.page('/api/pair')).data.pinOn, false);
  assert.match(p.log(), /PIN antigo desligado/);
  await p.stop();
  // Desligado continua desligado depois de reiniciar; a Jobe liga de novo pela API local.
  const q = await startPayload({ base: p.base });
  assert.deepEqual((await q.page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data, { pinOff: true, retryIn: 0 });
  assert.equal((await q.app('GET', '/pair')).data.pinOn, false);
  assert.deepEqual((await q.app('POST', '/pair/pin', { on: true })).data, { ok: true, pinOn: true });
  const back = (await q.page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data.session;
  assert.match(back, /^[0-9a-f]{32}$/);
  assert.equal((await q.page('/api/session', { session: back })).status, 200);
  assert.equal((await q.page('/api/session', { session: old })).status, 401, 'a sessao antiga nao volta');
  await q.stop();
});

test('127.0.0.1 isento (a Jobe e o navegador do PS5), menos com Origin de outro site', { skip }, async () => {
  const p = await startPayload({ env: { BGDL_TEST_LOCAL: '1' } });
  const info = (await p.page('/api/pair')).data;
  assert.equal(info.local, true);
  assert.equal(info.allowed, true);
  assert.equal((await p.page('/api/session')).status, 200);
  assert.equal((await p.page('/api/pair/devices')).status, 200, 'o proprio PS5 gere os aparelhos');
  assert.equal((await p.page('/api/config', { method: 'POST', body: { concurrency: 2 } })).status, 200);
  assert.equal((await p.page('/api/config', { method: 'POST', body: { concurrency: 2 }, origin: `http://127.0.0.1:1` })).status, 200, 'Origin do proprio PS5');
  assert.equal((await p.page('/api/config', { method: 'POST', body: { concurrency: 2 }, origin: 'http://localhost' })).status, 200);
  for (const origin of ['http://evil.example', 'https://127.0.0.1', 'http://127.0.0.1.evil.example', 'null']) {
    assert.equal((await p.page('/api/config', { method: 'POST', body: { concurrency: 2 }, origin })).status, 401, `Origin ${origin}: sem isencao`);
  }
  await p.stop();
});

// As rotas da pagina que mudam algo ou mostram dados sensiveis (lista em bg_pair.c e no ESTUDO): 401 sem credencial,
// e passam com o token de um aparelho. A leitura simples (status, loja, Biblioteca, BACKUP, a pagina) continua livre.
test('rotas protegidas: 401 sem credencial e liberadas com o token; leitura da loja continua livre', { skip }, async () => {
  const p = await startPayload();
  const protectedRoutes = [
    ['POST', '/api/jobs/x1/pause'], ['POST', '/api/jobs/x1/resume'], ['POST', '/api/jobs/x1/cancel'], ['POST', '/api/jobs/x1/connections'],
    ['POST', '/api/config'], ['POST', '/api/power'], ['POST', '/api/cancelled/clear'], ['POST', '/api/library/add'], ['POST', '/api/store/add'],
    ['GET', '/api/log'], ['POST', '/api/backup/delete'], ['POST', '/api/backup/convert'], ['POST', '/api/backup/convert-all'],
    ['GET', '/api/diag'], ['POST', '/api/diag/key'], ['POST', '/api/diag/key/remove'], ['POST', '/api/diag/send'], ['GET', '/api/diag/zip'],
    ['GET', '/api/jobe'], ['POST', '/api/jobe/update'], ['GET', '/api/payload'], ['POST', '/api/payload/update'], ['POST', '/api/payload/revert'],
    ['GET', '/api/teste/estado'], ['POST', '/api/teste/enviar'], ['GET', '/api/session'],
    ['GET', '/api/pair/devices'], ['POST', '/api/pair/remove'], ['POST', '/api/pair/pin']
  ];
  for (const [method, route] of protectedRoutes) {
    const r = await p.page(route, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 401, `${method} ${route} sem credencial`);
  }
  const { token } = await pair(p, 'Teste');
  for (const [method, route] of protectedRoutes) {
    if (route === '/api/payload/update' || route === '/api/diag/send' || route === '/api/teste/enviar' || route === '/api/power') continue; // efeitos de rede/sistema
    const r = await p.page(route, { method, session: token, body: method === 'POST' ? {} : undefined });
    assert.notEqual(r.status, 401, `${method} ${route} com o token`);
  }
  for (const route of ['/', '/api/status', '/api/store', '/api/library', '/api/backup', '/api/pair']) {
    const r = await p.page(route);
    assert.notEqual(r.status, 401, `${route} continua livre`);
  }
  await p.stop();
});

test('a pagina: pareamento sem prompt/alert/confirm (WebView do JobeControle), 14 idiomas, botoes iguais, sem reticencias', () => {
  const page = readFileSync(embed.PAGE, 'utf8');
  assert.equal(readFileSync(embed.HEADER, 'utf8'), embed.header(readFileSync(embed.PAGE)), 'o .h embutido em dia');
  assert.ok(!/\b(prompt|alert|confirm)\(/.test(page), 'sem caixa nativa do navegador');
  for (const piece of ['/api/pair/request', '/api/pair/confirm', '/api/pair/devices', '/api/pair/remove', '/api/pair/pin', 'id="pairForm"', 'id="usePin"', 'id="usePair"',
    'const CRED = /^([0-9a-f]{32}|[0-9a-f]{64})$/;', 'r.data.pinOff', 'window.openDevices', 'autocomplete="one-time-code"', 'inputmode="numeric"']) assert.ok(page.includes(piece), piece);
  const dict = /const PAIR_T = (\{[\s\S]*?\n\});/.exec(page)[1];
  const texts = new Function(`return ${dict}`)();
  assert.deepEqual(Object.keys(texts).sort(), ['ar', 'bn', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'pt', 'ru', 'ur', 'zh'], '14 idiomas');
  const keys = Object.keys(texts.en).sort();
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const [lang, t] of Object.entries(texts)) {
    assert.deepEqual(Object.keys(t).sort(), keys, `${lang}: as mesmas chaves`);
    for (const k of keys) {
      assert.ok(t[k].trim(), `${lang}.${k} vazio`);
      assert.equal(vars(t[k]), vars(texts.en[k]), `${lang}.${k}: as mesmas variaveis`);
      assert.ok(!t[k].includes('…') && !t[k].includes('...'), `${lang}.${k}: sem reticencias`);
    }
  }
  // Botoes da mesma linha com a mesma largura e texto que quebra linha.
  assert.ok(page.includes('.dialog .row .btn,.pair-box .row .btn{flex:1 1 0;min-width:0;white-space:normal;overflow-wrap:anywhere}'));
  const pairCss = page.slice(page.indexOf('/* Pareamento por aparelho'), page.indexOf('/* glibren.8: conexoes'));
  assert.ok(!/ellipsis|nowrap/.test(pairCss), 'nada cortado com reticencias no pareamento');
  const devCss = page.slice(page.indexOf('.pair-box .pd{'), page.indexOf('</style>', page.indexOf('.pair-box .pd{')));
  assert.ok(!/ellipsis|nowrap/.test(devCss));
  // Texto do jogador so por textContent.
  const block = page.slice(page.indexOf('const box = document.createElement("details"); box.className = "diag pair-box"'));
  assert.ok(!/innerHTML/.test(block.slice(0, block.indexOf('</script>'))));
});

test('device-pairing.js: limpa o que o payload manda e fala com ele pela fonte', async () => {
  assert.equal(pairing.cleanPairing(null), null);
  assert.equal(pairing.cleanPairing({ ok: true }), null);
  const clean = pairing.cleanPairing({ ok: true, code: '123456', name: 'Cel\u0007ular', expiresIn: 90, pinOn: false, pinSet: true,
    devices: [{ id: '0123456789abcdef', name: 'A', at: 5 }, { id: 'ruim', name: 'B' }, { id: 'fedcba9876543210', name: 'x'.repeat(80), at: -1 }] });
  assert.deepEqual(clean, { code: '123456', name: 'Celular', expiresIn: 90, pinOn: false, pinSet: true,
    devices: [{ id: '0123456789abcdef', name: 'A', at: 5 }, { id: 'fedcba9876543210', name: 'x'.repeat(48), at: 0 }] });
  assert.equal(pairing.cleanPairing({ ok: true, code: '12345', expiresIn: 9, devices: [] }).code, '', 'codigo invalido nao aparece');
  assert.equal(pairing.cleanPairing({ ok: true, code: '123456', expiresIn: 0, devices: [] }).code, '', 'vencido nao aparece');
  const calls = [];
  pairing.setPairingSource({
    status: async () => ({ status: 200, data: { ok: true, code: '654321', name: 'PC', expiresIn: 30, devices: [], pinOn: true, pinSet: false } }),
    remove: async (id) => { calls.push(['remove', id]); return { status: 200, data: { ok: true } }; },
    pin: async (on) => { calls.push(['pin', on]); return { status: 200, data: { ok: true, pinOn: on } }; }
  });
  assert.equal((await pairing.pairingStatus()).code, '654321');
  assert.equal(await pairing.removePairedDevice('0123456789abcdef'), true);
  assert.equal(await pairing.removePairedDevice('../x'), false, 'id invalido nem vai ao payload');
  assert.equal(await pairing.setLegacyPin(false), true);
  assert.deepEqual(calls, [['remove', '0123456789abcdef'], ['pin', false]]);
  const state = await pairing.pairingTick(() => 1000);
  assert.equal(state.code, '654321');
  pairing.setPairingSource({ status: async () => { throw new Error('fora do ar'); } });
  assert.equal(await pairing.pairingStatus(), null, 'payload fora do ar: null');
  pairing.setPairingSource(null);
  assert.equal(await pairing.pairingStatus(), null);
  assert.equal(pairing.startPairingWatch({ platform: 'desktop' })(), undefined, 'so no PS5');
});
