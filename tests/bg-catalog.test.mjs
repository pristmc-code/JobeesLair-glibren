// Fase 3: o catalogo da loja no payload residente (app/native/bg_catalog_api.c), compilado para o PC e rodado de verdade.
// A igualdade com o app fica com tests/fase3-nucleo.test.mjs; aqui, o que e do payload:
//   - sem a copia do embutido: 503 "no-data" e a loja do celular continua no store-index.json do app;
//   - o teto de memoria: passou, "over-limit", 503, e a loja do celular volta ao arquivo do app (o caminho antigo);
//   - a troca: um feed que muda e montado de novo e trocado sob o lock (o catalogo antigo sai);
//   - os feeds baixados pelo payload: o catalogo ao vivo com ETag (If-None-Match -> 304), uma lista da web que falha e
//     vem do espelho do jogador, o estado de cada uma (/api/catalog/status), tudo so com BGDL_FEEDS_ON no PC;
//   - a loja do celular a partir do catalogo (/api/store, /api/store/game com os links e o "solo");
//   - os codigos conhecidos da lista Orbit: a uniao do que o app manda (POST /orbit) com o que o catalogo conhece;
//   - /api/teste/catalogo (a medicao da pagina /teste) so com a sessao.
// Run: node --import ./tests/stub-loader.mjs --test tests/bg-catalog.test.mjs
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortFrom } from './free-port.mjs';
import { stageBundled } from '../tools/fase3/stage-bundled.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = path.join(repo, 'tests/fixtures/fase3');
const LIVE = 'https://raw.githubusercontent.com/JVK3R/JobeesLair/main/catalog/live.json';
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-catalog-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 600)}` : false;
const freePort = freePortFrom(10); // Fase 3: bloco de portas so deste arquivo (tests/free-port.mjs)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const stableKey = (value) => { let a = 2166136261, b = 5381; for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(i); } return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`; };
const children = new Set();
const servers = [];
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

let run = 0;
// Uma pasta de payload: a copia do embutido (opcional), o catalogo ao vivo do fixture e a configuracao.
function workspace({ bundled = true, live = true, config = {} } = {}) {
  const base = path.join(dir, `run${++run}`);
  const cat = path.join(base, 'state/catalog');
  for (const sub of ['state/catalog/feeds', 'store', 'orbit']) mkdirSync(path.join(base, sub), { recursive: true });
  if (bundled) stageBundled(path.join(repo, 'app'), path.join(cat, 'bundled'), '0.5.5-teste');
  if (live) copyFileSync(path.join(FIXTURE, 'live.jlx'), path.join(cat, `feeds/${stableKey(LIVE)}.json`));
  writeFileSync(path.join(cat, 'config.json'), JSON.stringify({ feeds: [], orbit: { on: false }, ...config }));
  return base;
}
async function start(base, env = {}) {
  const api = await freePort(), monitor = await freePort();
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor),
    BGDL_STORE_DIR: path.join(base, 'store'), BGDL_STORE_CHECK_MS: '0', BGDL_ORBIT_DIR: path.join(base, 'orbit'), BGDL_LIBRARY: path.join(base, 'none.json'),
    BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_CATALOG_FIRST_MS: '0', BGDL_CATALOG_CHECK_MS: '100', ...env }, stdio: ['ignore', 'ignore', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const tokenFile = path.join(base, 'state/token');
  for (const end = performance.now() + 30000; !existsSync(tokenFile); await wait(50)) if (performance.now() > end) throw new Error('payload did not start');
  const token = readFileSync(tokenFile, 'utf8').trim();
  const fetchJson = async (url, init = {}) => {
    for (let attempt = 0; ; attempt++) {
      try { const res = await fetch(url, init); return { status: res.status, data: await res.json().catch(() => ({})) }; } catch (problem) { if (attempt > 60) throw problem; await wait(100); }
    }
  };
  const call = (method, route, body) => fetchJson(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const page = (route, { method = 'GET', body, session } = {}) => fetchJson(`http://127.0.0.1:${monitor}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Session': session } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const status = async (check, ms = 60000) => {
    let last;
    for (const end = performance.now() + ms; performance.now() < end; await wait(100)) { last = (await call('GET', '/api/catalog/status')).data; if (check(last)) return last; }
    throw new Error(`o estado nunca chegou: ${JSON.stringify(last).slice(0, 400)}`);
  };
  return { child, call, page, status };
}

test('sem a copia do embutido: 503 no-data, e a loja do celular continua no arquivo do app', { skip }, async () => {
  const base = workspace({ bundled: false });
  const p = await start(base);
  const s = await p.status((x) => x.state === 'no-data');
  assert.match(s.error, /version\.json/);
  const answer = await p.call('GET', '/api/catalog');
  assert.equal(answer.status, 503);
  assert.equal(answer.data.error, 'no-data');
  assert.equal((await p.page('/api/store')).status, 404, 'sem o store-index.json do app: no-store, como antes');
});

test('o teto de memoria: passou, over-limit, 503, e /api/store volta ao store-index.json do app', { skip }, async () => {
  const base = workspace();
  writeFileSync(path.join(base, 'store/store-index.json'), JSON.stringify({ version: 1, key: 'do-app', games: [{ id: 'PPSA00001', title: 'Jogo do arquivo do app', platform: 'ps5', rank: [0, 0, 0, 0, 0] }] }));
  const p = await start(base, { BGDL_CATALOG_MAX_MB: '1' });
  const s = await p.status((x) => x.state === 'over-limit');
  assert.match(s.error, /teto de 1 MiB/);
  const answer = await p.call('GET', '/api/catalog?per=5');
  assert.equal(answer.status, 503);
  assert.equal(answer.data.error, 'over-limit');
  const store = (await p.page('/api/store')).data;
  assert.equal(store.key, 'do-app');
  assert.deepEqual(store.games.map((game) => game.id), ['PPSA00001']);
});

test('monta numa thread, troca quando um feed muda e a loja do celular sai do catalogo', { skip }, async () => {
  const base = workspace();
  const p = await start(base);
  const first = await p.status((x) => x.state === 'ready' && x.soloDone);
  assert.ok(first.listed > 1500, `listados ${first.listed}`);
  assert.ok(first.bytes > 0 && first.peak >= first.bytes && first.limit === 32 << 20);
  assert.ok(first.phasesMs && first.phasesMs.feeds >= 0);
  // um jogo novo no catalogo ao vivo: o payload ve o arquivo mudar e monta de novo
  const live = JSON.parse(readFileSync(path.join(FIXTURE, 'live.jlx'), 'utf8').startsWith('JLX1:') ? (await import('../app/state/jlx.js')).decodeJlx(readFileSync(path.join(FIXTURE, 'live.jlx'), 'utf8')) : readFileSync(path.join(FIXTURE, 'live.jlx'), 'utf8'));
  live.games.push({ id: 'PPSA99001', title: 'Jogo Novo Do Teste', releaseDate: '2026-11-01', releases: [{ url: 'https://archive.org/download/teste/Jogo.Novo.exfat', sizeBytes: 5000000000 }] });
  writeFileSync(path.join(base, `state/catalog/feeds/${stableKey(LIVE)}.json`), JSON.stringify(live));
  const second = await p.status((x) => x.builds >= 2 && x.state === 'ready' && x.listed === first.listed + 1);
  assert.equal(second.listed, first.listed + 1);
  const found = (await p.call('GET', '/api/catalog?q=jogo%20novo%20do%20teste')).data;
  assert.deepEqual(found.games.map((game) => game.id), ['PPSA99001']);
  // a loja do celular: do catalogo, com o "solo" e a ficha com os links
  await p.status((x) => x.soloDone);
  const store = (await p.page('/api/store?q=jogo%20novo%20do%20teste')).data;
  assert.equal(store.source, 'catalog');
  assert.match(store.key, /^payload-/);
  assert.deepEqual(store.games.map((game) => [game.id, game.solo]), [['PPSA99001', true]]);
  assert.ok(store.facets.genre && store.facets.solo[0].count === 1);
  const game = (await p.page('/api/store/game?id=PPSA99001')).data;
  assert.equal(game.download, 'payload');
  assert.equal(game.detailsState, 'ok');
  assert.deepEqual(game.links.map((link) => [link.kind, link.host, link.format, link.solo]), [['direct', 'archive.org', 'exfat', true]]);
  assert.equal((await p.page('/api/store/game?id=XXXX00000')).status, 404);
  // as outras rotas da TV respondem
  const home = (await p.call('GET', '/api/catalog/home?seed=3&today=2026-11-13')).data;
  assert.ok(home.carousel.length === 5 && home.recent.length === 15);
  const ficha = (await p.call('GET', '/api/catalog/game?id=PPSA99001')).data;
  assert.equal(ficha.releases[0].dumpType, 'image');
  assert.equal((await p.call('GET', '/api/catalog/game?id=PPSA00000')).status, 404);
  const sources = (await p.call('GET', '/api/catalog/sources')).data;
  assert.deepEqual(sources.sources.map((s) => s.id), ['bundled', LIVE]);
});

test('os feeds pelo payload: ETag (304), espelho do jogador, estado de cada lista', { skip }, async () => {
  const live = readFileSync(path.join(FIXTURE, 'live.jlx'));
  const web = readFileSync(path.join(FIXTURE, 'feed-web.jlx'));
  const seen = [];
  const port = await freePort();
  const server = http.createServer((req, res) => {
    seen.push(`${req.url} ${req.headers['if-none-match'] ?? ''}`);
    if (req.url === '/lists/ps5/live.jlx') {
      if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304, { ETag: '"v1"' }); return res.end(); }
      res.writeHead(200, { ETag: '"v1"', 'Content-Length': live.length });
      return res.end(live);
    }
    if (req.url === '/broken.json') { res.writeHead(500); return res.end('no'); }
    if (req.url === '/mirror.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(web); }
    res.writeHead(404); res.end('no');
  }).listen(port, '127.0.0.1');
  servers.push(server);
  const own = `http://127.0.0.1:${port}/broken.json`;
  const base = workspace({ live: false, config: { feeds: [own], mirrors: [{ url: own, list: [`http://127.0.0.1:${port}/mirror.json`] }] } });
  const p = await start(base, { BGDL_FEEDS_ON: '1', BGDL_FEEDS_FIRST_S: '0', BGDL_LIVE_URL: `http://127.0.0.1:${port}/lists/ps5/live.jlx` });
  const s = await p.status((x) => x.state === 'ready' && x.feeds?.length === 2 && x.feeds.every((feed) => feed.fetchedAt) && x.listed > 1500);
  const [liveState, webState] = s.feeds;
  assert.equal(liveState.from, `http://127.0.0.1:${port}/lists/ps5/live.jlx`);
  assert.equal(webState.from, `http://127.0.0.1:${port}/mirror.json`, 'a lista que falhou veio do espelho do jogador');
  assert.ok(webState.games >= 6);
  const meta = JSON.parse(readFileSync(path.join(base, `state/catalog/feeds/${stableKey(LIVE)}.meta`), 'utf8'));
  assert.equal(meta.etag, '"v1"');
  // a copia nova da lista da web faz o payload montar de novo (o arquivo mudou): o jogo dela aparece na loja
  let found = false;
  for (const end = performance.now() + 30000; !found && performance.now() < end; await wait(200)) {
    const pokemon = (await p.call('GET', '/api/catalog/search?q=pokemon')).data;
    found = Boolean(pokemon.games?.some((game) => game.id === 'PPSA90001'));
  }
  assert.ok(found, 'o jogo da lista da web entrou na loja');
  // de novo: o catalogo ao vivo responde 304 ao If-None-Match e nao e baixado de novo
  seen.length = 0;
  await p.call('POST', '/api/catalog/refresh');
  for (const end = performance.now() + 20000; !seen.some((line) => line.startsWith('/lists/ps5/live.jlx')) && performance.now() < end;) await wait(100);
  await wait(300);
  assert.ok(seen.includes('/lists/ps5/live.jlx "v1"'), seen.join(' | '));
});

test('lista Orbit: os codigos conhecidos sao a uniao do app com o catalogo do payload', { skip }, async () => {
  const base = workspace();
  const p = await start(base);
  await p.status((x) => x.state === 'ready');
  const known = path.join(base, 'orbit/orbit-known.txt');
  for (const end = performance.now() + 10000; !existsSync(known) && performance.now() < end;) await wait(100);
  const fromCatalog = new Set(readFileSync(known, 'utf8').split('\n').filter(Boolean));
  assert.ok(fromCatalog.size > 1500, `conhecidos ${fromCatalog.size}`);
  assert.equal((await p.call('POST', '/orbit', { known: ['CUSA77777'] })).status, 200);
  const merged = new Set(readFileSync(known, 'utf8').split('\n').filter(Boolean));
  assert.ok(merged.has('CUSA77777'), 'o do app entra');
  for (const id of fromCatalog) assert.ok(merged.has(id), `${id} do catalogo continua`);
});

test('/api/teste/catalogo: so com a sessao; mede a montagem e as consultas', { skip }, async () => {
  const base = workspace();
  const p = await start(base);
  await p.status((x) => x.state === 'ready');
  assert.equal((await p.page('/api/teste/catalogo')).status, 401);
  const salt = randomBytes(32).toString('hex');
  assert.equal((await p.call('POST', '/config', { pinSalt: salt, pinHash: sha(`${salt}:246810`) })).status, 200);
  const { session } = (await p.page('/api/unlock', { method: 'POST', body: { pin: '246810' } })).data;
  assert.ok(session);
  const m = (await p.page('/api/teste/catalogo', { session })).data;
  assert.equal(m.state, 'ready');
  assert.ok(m.listed > 1500 && m.buildMs > 0 && m.rssAfterQueries > 0);
  assert.ok(m.queries.length >= 8 && m.queries.every((q) => q.status === 200 && q.ms >= 0), JSON.stringify(m.queries));
  assert.ok(m.queries.some((q) => q.name === 'ficha'));
});
