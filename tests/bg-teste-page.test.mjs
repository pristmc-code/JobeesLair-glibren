// glibren.47: a pagina de testes da Fase 0 (app/native/bg_teste.c + bg_teste.html, servida pelo payload em /teste na
// porta da pagina do celular). O payload compilado para o PC, com um GitHub FALSO local:
//   - /teste sai sem sessao (como "/"), igual ao .h embutido; /api/teste/* pedem a sessao do PIN (401) e o Host com IP (403);
//   - /api/teste/estado: pid, inicio, uptime, memoria residente e pico (bytes), versao/api, contagem e hora do pedido anterior;
//     grava <dir>/teste-estado.json e o proximo processo devolve o anterior em "previous" (repouso: reiniciou?);
//   - /api/teste/enviar grava os resultados e manda o diagnostico com eles, higienizados;
//   - a pagina: pt-BR + en, sem reticencias, botoes da mesma linha com a mesma largura, sem ?. / ?? (navegador do PS5).
// Run: node --import ./tests/stub-loader.mjs --test tests/bg-teste-page.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePortFrom } from './free-port.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const embed = await import(pathToFileURL(path.join(repo, 'tools/bg-monitor/embed.mjs')).href);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const freePort = freePortFrom(14); // glibren.47: bloco de portas so deste arquivo (tests/free-port.mjs)
const GITHUB_KEY = 'github_pat_11TESTE0000000000_FakeFakeFakeFakeFakeFake1234567890abcdefXYZ';
const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-teste-'));
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

async function fakeGitHub() {
  const state = { puts: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      state.puts.push({ url: req.url, text: body?.content ? Buffer.from(body.content, 'base64').toString('utf8') : '' });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{"content":{}}');
    });
  });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  servers.add(server);
  return { state, port };
}

let run = 0;
// Sobe o payload; `base` repetido = o mesmo estado em disco (um "reinicio").
async function startPayload({ base, github = 'http://127.0.0.1:9' } = {}) {
  base ??= path.join(dir, `run${++run}`);
  for (const sub of ['state', 'tube', 'apps', 'diag']) mkdirSync(path.join(base, sub), { recursive: true });
  const api = await freePort(), monitor = await freePort();
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor), BGDL_ORBIT_DIR: path.join(base, 'orbit'),
    BGDL_LIBRARY: path.join(base, 'lista.json'), BGDL_KEYFILE: path.join(base, 'debrid.json'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_DIAG_DIR: path.join(base, 'diag'),
    BGDL_TUBE_DIR: path.join(base, 'tube'), BGDL_APP_LOGS_ROOT: path.join(base, 'apps'), BGDL_GITHUB_BASE: github, BGDL_GLIBREN_BASE: 'http://127.0.0.1:9' },
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
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text, type: res.headers.get('content-type') };
  };
  // Um pedido com outro cabecalho Host (fetch nao deixa trocar o Host).
  const withHost = (route, host, session) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: monitor, path: route, headers: { Host: host, ...(session ? { 'X-Session': session } : {}) } }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, text: raw }));
    });
    req.on('error', reject);
    req.end();
  });
  for (const end = Date.now() + 30000; ; await wait(50)) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call('GET', '/health')).status === 200) break; } catch {}
    if (Date.now() > end) throw new Error('payload did not start');
  }
  const PIN = '2468';
  const salt = randomBytes(32).toString('hex');
  assert.equal((await call('POST', '/config', { pinSalt: salt, pinHash: sha(`${salt}:${PIN}`) })).status, 200);
  const session = (await page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data.session;
  assert.match(session, /^[0-9a-f]{32}$/);
  const stop = async () => {
    const gone = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await gone;
  };
  return { base, child, call, page, withHost, session, stop };
}

test('bg_teste.c compila junto com o payload, sem avisos (-Wall -Wextra -Werror)', { skip: !compiler || missing ? 'no compiler or headers' : false }, () => {
  assert.equal(built.status, 0, built.stderr);
});

test('glibren.47: bg_teste_html.h esta em dia com bg_teste.html (rode tools/bg-monitor/embed.mjs)', () => {
  assert.equal(readFileSync(embed.TESTE_HEADER, 'utf8'), embed.testeHeader(readFileSync(embed.TESTE_PAGE)));
  assert.equal(readFileSync(embed.HEADER, 'utf8'), embed.header(readFileSync(embed.PAGE)), 'o da pagina do celular continua igual');
});

test('glibren.47: a pagina /teste tem os 5 testes, os botoes de resultado, pt-BR e en, e segue o padrao de tela', () => {
  const page = readFileSync(embed.TESTE_PAGE, 'utf8');
  for (const piece of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen', 'fullscreenElement', 'innerWidth', 'devicePixelRatio',
    'navigator.getGamepads', 'requestAnimationFrame', 'keydown', 'keyup', 'e.preventDefault()', '/api/store?offset=', '&limit=200', '"/api/teste/estado"', '"/api/teste/enviar"',
    '"/api/unlock"', '"/api/diag"', 'SESSION_KEY = "jobe.session"', 'SEEN_KEY = "jobe.teste.visto"',
    'Tela cheia', 'Controle', 'Loja grande', 'Memória do payload', 'Repouso', 'Copiar resultados', 'Enviar diagnóstico', 'Continuou vivo', 'Reiniciou',
    'Copy results', 'Send diagnostics', 'document.execCommand("copy")', 'visibilitychange']) assert.ok(page.includes(piece), piece);
  assert.ok(!/text-overflow|nowrap/.test(page), 'texto quebra a linha, sem reticencias');
  assert.match(page, /\.row\{display:grid;grid-auto-flow:column;grid-auto-columns:minmax\(0,1fr\)/, 'botoes de uma linha com a mesma largura');
  const script = page.slice(page.indexOf('<script>'));
  assert.ok(!/\?\.|\?\?/.test(script), 'sem ?. nem ?? (navegador do PS5)');
  assert.ok(!/innerHTML/.test(script), 'texto do payload nunca por innerHTML');
  const fixed = page.match(/https?:\/\/[^`'"\s$]+/g) || [];
  assert.deepEqual(fixed, [], 'fala so com a mesma origem');
  // a pagina do celular aponta para ela
  assert.ok(readFileSync(embed.PAGE, 'utf8').includes('test.href = "/teste"'));
});

test('glibren.47: /teste sai sem sessao; /api/teste pede o PIN (401) e o Host com IP (403)', { skip }, async () => {
  const p = await startPayload();
  const html = await p.page('/teste');
  assert.equal(html.status, 200);
  assert.match(html.type, /text\/html/);
  assert.equal(html.text, readFileSync(embed.TESTE_PAGE, 'utf8'));
  assert.equal((await p.page('/teste/')).status, 200);
  assert.equal((await p.page('/api/teste/estado')).status, 401);
  assert.equal((await p.page('/api/teste/enviar', { method: 'POST', body: { texto: 'x' } })).status, 401);
  assert.equal((await p.page('/api/teste/estado', { session: 'f'.repeat(32) })).status, 401, 'sessao inventada');
  assert.equal((await p.withHost('/teste', 'exemplo.com')).status, 403, 'nome de dominio (DNS rebinding)');
  assert.equal((await p.withHost('/api/teste/estado', 'exemplo.com:34201', p.session)).status, 403);
  assert.equal((await p.withHost('/api/teste/estado', '192.168.0.20:34201', p.session)).status, 200, 'IP literal passa');
  assert.equal((await p.page('/api/teste/estado', { method: 'POST', body: {}, session: p.session })).status, 404, 'estado e so GET');
  assert.equal((await p.page('/api/teste/enviar', { session: p.session })).status, 404, 'enviar e so POST');
  await p.stop();
});

test('glibren.47: /api/teste/estado da pid, uptime, memoria (bytes), api e o pedido anterior; o proximo processo ve o anterior', { skip }, async () => {
  const p = await startPayload();
  const first = await p.page('/api/teste/estado', { session: p.session });
  assert.equal(first.status, 200);
  const d = first.data;
  assert.equal(d.ok, true);
  assert.equal(d.pid, p.child.pid);
  assert.ok(Number.isInteger(d.started) && Math.abs(d.started - Date.now() / 1000) < 120);
  assert.ok(d.uptimeSeconds >= 0 && d.uptimeSeconds < 120);
  assert.ok(Math.abs(d.now - Date.now() / 1000) < 5);
  assert.equal(d.api, Number(/#define BG_API (\d+)/.exec(readFileSync(path.join(repo, 'app/native/bg_downloader.c'), 'utf8'))[1]));
  assert.equal(d.version, '1.0.0');
  assert.equal(d.rssSource, 'proc');
  assert.ok(d.rssBytes > 1024 * 1024 && d.rssBytes < 4 * 1024 ** 3, `rss ${d.rssBytes}`);
  assert.equal(d.peakSource, 'getrusage');
  assert.ok(d.peakBytes >= d.rssBytes * 0.5 && d.peakBytes < 4 * 1024 ** 3, `pico ${d.peakBytes}`);
  assert.equal(d.requests, 1);
  assert.equal(d.lastRequest, null, 'nenhum pedido antes');
  assert.equal(d.previous, null, 'primeira vez nesta pasta');
  const file = path.join(p.base, 'state/teste-estado.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { pid: d.pid, started: d.started, last: d.now });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const second = (await p.page('/api/teste/estado', { session: p.session })).data;
  assert.equal(second.requests, 2);
  assert.equal(second.lastRequest, d.now, 'a hora do pedido anterior');
  const old = second.pid;
  await p.stop();
  // "acordou do repouso" com outro processo: o estado do anterior vem em previous
  const again = await startPayload({ base: p.base });
  const third = (await again.page('/api/teste/estado', { session: again.session })).data;
  assert.notEqual(third.pid, old);
  assert.deepEqual(third.previous, { pid: old, started: d.started, last: second.now });
  assert.equal(third.lastRequest, null);
  await again.stop();
});

test('glibren.47: Enviar diagnostico da pagina /teste leva os resultados (higienizados) e o teste-estado.json', { skip }, async () => {
  const gh = await fakeGitHub();
  const p = await startPayload({ github: `http://127.0.0.1:${gh.port}` });
  const texto = `Jobee'sLair /teste (Fase 0)\n[1 tela cheia] requestFullscreen: pedido aceito\n[3 loja] 2639 jogos; chave colada ${SECRET} por engano\n[5 repouso] continuou vivo`;
  assert.equal((await p.page('/api/teste/enviar', { method: 'POST', body: {}, session: p.session })).status, 400, 'sem texto');
  const noKey = await p.page('/api/teste/enviar', { method: 'POST', body: { texto }, session: p.session });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.data.error, 'no-key');
  assert.equal(gh.state.puts.length, 0);
  assert.equal((await p.page('/api/teste/estado', { session: p.session })).status, 200);
  assert.equal((await p.page('/api/diag/key', { method: 'POST', body: { key: GITHUB_KEY }, session: p.session })).status, 200);
  const sent = await p.page('/api/teste/enviar', { method: 'POST', body: { texto }, session: p.session });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.state, 'running');
  const saved = path.join(p.base, 'diag/teste-resultados.txt');
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  let state = null;
  for (const end = Date.now() + 60000; Date.now() < end; await wait(100)) {
    state = (await p.page('/api/diag', { session: p.session })).data;
    if (state.state !== 'running') break;
  }
  assert.equal(state.state, 'done', JSON.stringify(state));
  const byName = Object.fromEntries(gh.state.puts.map((put) => [put.url.split('/').pop(), put.text]));
  assert.ok(byName['teste-resultados.txt'], Object.keys(byName).join(','));
  assert.match(byName['teste-resultados.txt'], /\[1 tela cheia\] requestFullscreen: pedido aceito/);
  assert.match(byName['teste-resultados.txt'], /continuou vivo/);
  assert.ok(!byName['teste-resultados.txt'].includes(SECRET), 'higienizado');
  assert.match(byName['teste-estado.json'], /"pid":\d+/);
  for (const text of Object.values(byName)) assert.ok(!text.includes(GITHUB_KEY) && !text.includes(SECRET));
  assert.match(byName['info.json'], /"from":"teste"/);
  await p.stop();
});
