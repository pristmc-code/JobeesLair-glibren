// glibren (item 2): a loja completa na pagina do celular (app/native/bg_store.c), compilado para o desktop: o indice da
// loja (store-index.json) filtrado, ordenado, buscado e contado como app/state/catalog.js faz (o teste de equivalencia
// compara com uma copia em JS das regras de FACETS/passes/matching/facetCounts, num indice grande gerado), a ficha e os
// links (store-games.json, so com a mesma key), e o Baixar: marcador para a Jobe (aberta, ou sem link que o payload baixe
// sozinho) ou o download comecado pelo payload com a Jobe fechada (o primeiro link "solo"). Run: npm test
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortFrom } from './free-port.mjs';
import { before as whenBuilt } from 'node:test';
import { assertBuilt, buildSkip, compileTo } from './payload-build.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-store-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : false;
// glibren.51: um binario que nao compilou (erro, aviso com -Werror ou o compilador morto por sinal) FALHA todos os
// testes deste arquivo na hora, com o motivo; antes eles viravam "pulados" e ninguem via. So a falta do ambiente pula.
whenBuilt(() => { if (!skip) assertBuilt(built); });
const children = new Set();
let server;
beforeEach(async () => {
  const left = [...children];
  for (const child of left) child.kill('SIGKILL');
  await Promise.all(left.map((child) => child.exitCode !== null || child.signalCode ? null : new Promise((resolve) => child.once('exit', resolve))));
});
after(() => {
  for (const child of children) child.kill('SIGKILL');
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = freePortFrom(4); // glibren.41 (T1): bloco de portas so deste arquivo (tests/free-port.mjs)
const sha = (data) => createHash('sha256').update(data).digest('hex');
const PIN = '135790';
const pinConfig = () => { const salt = randomBytes(32).toString('hex'); return { pinSalt: salt, pinHash: sha(`${salt}:${PIN}`) }; };

// Um servidor de arquivos para o download direto.
const FILE = randomBytes(256 * 1024);
let port, api, monitorPort;
if (!skip) {
  port = await freePort();
  server = http.createServer((req, res) => {
    if (!req.url.startsWith('/files/')) { res.writeHead(404); return res.end('no'); }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const from = Number(range[1]), to = range[2] ? Number(range[2]) : FILE.length - 1;
      res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': to - from + 1, 'Content-Range': `bytes ${from}-${to}/${FILE.length}`, 'Accept-Ranges': 'bytes' });
      return res.end(FILE.subarray(from, to + 1));
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': FILE.length, 'Accept-Ranges': 'bytes' });
    res.end(FILE);
  }).listen(port, '127.0.0.1');
  api = await freePort();
  monitorPort = await freePort();
}

let run = 0;
function workspace() {
  const base = path.join(dir, `run${++run}`);
  for (const sub of ['state', 'store', 'disk']) mkdirSync(path.join(base, sub), { recursive: true });
  return base;
}
function start(base, env = {}) {
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitorPort),
    BGDL_STORE_DIR: path.join(base, 'store'), BGDL_STORE_CHECK_MS: '0', BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_LIBRARY: path.join(base, 'none.json'), ...env }, stdio: ['ignore', 'ignore', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
async function retryGet(method, ask) {
  for (let attempt = 0, end = Date.now() + 10000; ; attempt++) {
    try { return await ask(); } catch (problem) {
      if (method !== 'GET' || Date.now() >= end) throw problem;
      await wait(Math.min(50 * 2 ** attempt, 1000));
    }
  }
}
async function call(base, method, route, body) {
  const tok = readFileSync(path.join(base, 'state/token'), 'utf8').trim();
  const res = await retryGet(method, () => fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': tok, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function page(route, { method = 'GET', body, session } = {}) {
  const res = await retryGet(method, () => fetch(`http://127.0.0.1:${monitorPort}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Session': session } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
}
async function up(base, ms = 30000) {
  for (const end = performance.now() + ms; performance.now() < end; await wait(50)) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call(base, 'GET', '/health')).status === 200 && (await page('/api/status')).status === 200) return; } catch {}
  }
  throw new Error('payload did not start');
}
async function unlocked(base) {
  assert.equal((await call(base, 'POST', '/config', pinConfig())).status, 200);
  const { session } = (await page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data;
  assert.ok(session);
  return session;
}
async function statusUntil(check, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const status = (await page('/api/status')).data;
    if (check(status)) return status;
  }
  throw new Error('the status never got there');
}

// ---- As regras do app (app/state/catalog.js), em JS, para comparar ----
const ANY = new Set(['platform', 'format', 'release', 'size', 'provider']);
const KEYS = ['platform', 'format', 'access', 'genre', 'feature', 'release', 'size', 'provider', 'solo'];
const SORTS = ['relevance', 'newest', 'rating', 'size', 'title'];
const RELEASES = { recent: (y) => y >= 2024, current: (y) => y >= 2020 && y <= 2023, older: (y) => y < 2020 };
const SIZES = { small: (gb) => gb < 10, medium: (gb) => gb >= 10 && gb <= 50, large: (gb) => gb > 50 };
function has(g, key, value) {
  switch (key) {
    case 'platform': return g.platform === value;
    case 'format': return value === 'ready' ? g.ready : g.formats.includes(value);
    case 'access': return value === 'direct' && Boolean(g.direct);
    case 'genre': return g.genres.includes(value);
    case 'feature': return g.features.includes(value);
    case 'release': return g.year != null && Boolean(RELEASES[value]?.(g.year));
    case 'size': return g.sizeGb != null && Boolean(SIZES[value]?.(g.sizeGb));
    case 'provider': return g.providers.includes(value);
    case 'solo': return value === '1' && g.solo === true;
  }
  return false;
}
const passes = (g, key, picked) => !picked?.length || (ANY.has(key) ? picked.some((v) => has(g, key, v)) : picked.every((v) => has(g, key, v)));
const optionValues = (index, key) => key === 'solo' ? ['1'] : (index.facets[key] ?? []).map((o) => typeof o === 'string' ? o : o.value);
function reference(index, query) {
  const q = (query.q ?? '').trim().toLowerCase();
  const hit = index.games.map((g, i) => ({ g, i })).filter(({ g }) => !q || g.s.includes(q));
  const ok = (g, skip) => KEYS.every((key) => key === skip || passes(g, key, query[key]));
  const sort = SORTS.indexOf(query.sort ?? 'relevance');
  const list = hit.filter(({ g }) => ok(g)).sort((a, b) => a.g.rank[sort] - b.g.rank[sort] || a.i - b.i).map(({ g }) => g.id);
  const facets = {};
  for (const key of KEYS) {
    const pool = hit.filter(({ g }) => ok(g, ANY.has(key) ? key : undefined));
    facets[key] = optionValues(index, key).map((value) => [value, pool.filter(({ g }) => has(g, key, value)).length]);
  }
  return { list, facets };
}
const queryString = (query, offset = 0, limit = 200) => {
  const p = new URLSearchParams();
  if (query.q !== undefined) p.set('q', query.q);
  for (const key of KEYS) if (query[key]?.length) p.set(key, query[key].join(','));
  if (query.sort) p.set('sort', query.sort);
  p.set('offset', String(offset));
  p.set('limit', String(limit));
  return `/api/store?${p}`;
};
async function everything(query) {
  const ids = [];
  let first = null;
  for (let offset = 0; ; offset += 200) {
    const r = await page(queryString(query, offset));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    first ??= r.data;
    ids.push(...r.data.games.map((g) => g.id));
    if (ids.length >= r.data.count || !r.data.games.length) break;
  }
  return { ids, data: first };
}

// Um indice grande e variado (semente fixa).
function makeIndex(count, seed = 11) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const some = (list, max) => [...new Set(Array.from({ length: Math.floor(rnd() * (max + 1)) }, () => pick(list)))];
  const genres = ['Action', 'Adventure', 'RPG', 'Racing', 'Fighting', 'Sports', 'Shooter', 'Puzzle', 'Horror', 'Simulation', 'Strategy', 'Platformer'];
  const features = ['Online', 'Single player', 'VR', 'Co-op', 'DualSense', 'HDR'];
  const providers = ['archive.org', 'overdrive cdn', 'mediafire', '1fichier', 'gofile', 'rapidgator', 'torrent', 'datanodes'];
  const kinds = ['exfat', 'ffpkg', 'ffpfs', 'fpkg', 'pkg', 'rar', '7z', 'zip', 'binary'];
  const words = ['star', 'night', 'blade', 'quest', 'racer', 'dark', 'souls', 'legend', 'zero', 'king', 'storm', 'iron'];
  const games = [];
  for (let i = 0; i < count; i++) {
    const ps5 = rnd() < 0.6;
    const id = `${ps5 ? 'PPSA' : 'CUSA'}${String(10000 + i).padStart(5, '0')}`;
    const title = `${pick(words)} ${pick(words)} ${i}`.replace(/^./, (c) => c.toUpperCase());
    const developer = `Studio ${pick(words)}`, publisher = `Pub ${pick(words)}`;
    const formats = some(kinds, 3);
    const year = rnd() < 0.1 ? null : 2010 + Math.floor(rnd() * 16);
    games.push({ id, code: id, title, platform: ps5 ? 'ps5' : 'ps4', s: `${title} ${developer} ${publisher}`.toLowerCase(), genres: some(genres, 3), features: some(features, 2),
      formats, ready: formats.some((k) => ['exfat', 'ffpkg', 'ffpfs'].includes(k)), direct: rnd() < 0.5, providers: some(providers, 3), year,
      sizeGb: rnd() < 0.1 ? null : Math.round(rnd() * 1200) / 10, stars: rnd() < 0.3 ? null : Math.round(rnd() * 500) / 100, ratingCount: Math.floor(rnd() * 5000),
      cover: rnd() < 0.9 ? `https://image.api.playstation.com/cdn/${id}.png` : '', developer, publisher, releaseDate: year ? `${year}-01-02` : '',
      solo: rnd() < 0.15 ? null : rnd() < 0.6, rank: [] });
  }
  // As ordens: permutacoes ao acaso (o console as calcula; aqui so importa seguir o rank).
  for (let k = 0; k < SORTS.length; k++) {
    const order = games.map((_, i) => i).sort(() => rnd() - 0.5);
    order.forEach((at, pos) => { games[at].rank[k] = pos; });
  }
  return {
    version: 1, key: 'k1', builtAt: '2026-11-11T20:00:00Z', console: 'ps5', readyFirmware: '13.60',
    facets: {
      platform: [{ value: 'ps5', name: 'PS5' }, { value: 'ps4', name: 'PS4' }],
      format: ['ready', ...kinds.filter((k) => k !== 'binary')], access: ['direct'],
      genre: genres.map((g) => ({ value: g, name: g })), feature: features.slice(0, 4).map((f) => ({ value: f, name: f })),
      release: ['recent', 'current', 'older'], size: ['small', 'medium', 'large'],
      provider: providers.slice(0, 5).map((p) => ({ value: p, name: p.toUpperCase() })),
    },
    games,
  };
}
function randomQuery(index, rnd) {
  const sub = (list, p) => list.filter(() => rnd() < p);
  const opt = (key) => optionValues(index, key);
  const g = index.games[Math.floor(rnd() * index.games.length)];
  const q = {};
  const r = rnd();
  if (r < 0.2) q.q = g.title.split(' ')[0];
  else if (r < 0.3) q.q = `  ${g.title.split(' ')[1].toUpperCase()} `;
  else if (r < 0.35) q.q = 'studio';
  if (rnd() < 0.4) q.platform = sub(opt('platform'), 0.5);
  if (rnd() < 0.4) q.format = sub(opt('format'), 0.25);
  if (rnd() < 0.3) q.access = ['direct'];
  if (rnd() < 0.4) q.genre = sub(opt('genre'), 0.15);
  if (rnd() < 0.2) q.feature = sub([...opt('feature'), 'HDR'], 0.3);
  if (rnd() < 0.3) q.release = sub(opt('release'), 0.5);
  if (rnd() < 0.3) q.size = sub(opt('size'), 0.5);
  if (rnd() < 0.3) q.provider = sub([...opt('provider'), 'datanodes'], 0.3);
  if (rnd() < 0.2) q.solo = ['1'];
  if (rnd() < 0.8) q.sort = SORTS[Math.floor(rnd() * SORTS.length)];
  return q;
}
const facetPairs = (data) => Object.fromEntries(KEYS.map((key) => [key, (data.facets[key] ?? []).map((o) => [o.value, o.count])]));

test('bg_store.c compila junto do payload sem avisos (-Wall -Wextra -Werror)', { skip: !compiler || missing ? 'no compiler or headers' : false }, () => {
  assert.equal(built.status, 0, built.stderr);
});

test('equivalencia: filtros, busca, ordens, contagens e paginas iguais as regras do app num indice de 5000 jogos', { skip }, async () => {
  const base = workspace();
  const index = makeIndex(5000);
  writeFileSync(path.join(base, 'store/store-index.json'), JSON.stringify(index));
  start(base);
  await up(base);
  let s = 99;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const queries = [{}, { sort: 'title' }, { q: '' }, { format: ['ready'] }, { genre: ['Action', 'RPG'] }, { platform: ['ps5', 'ps4'], size: ['small', 'large'] },
    { provider: ['datanodes'] }, { feature: ['HDR'] }, { solo: ['1'], sort: 'size' }, { genre: ['Nada'] }, { platform: ['ps3'] }];
  for (let i = 0; i < 70; i++) queries.push(randomQuery(index, rnd));
  for (const query of queries) {
    const want = reference(index, query);
    const got = await everything(query);
    assert.equal(got.data.count, want.list.length, `count ${JSON.stringify(query)}`);
    assert.deepEqual(got.ids, want.list, `ids/ordem ${JSON.stringify(query)}`);
    assert.deepEqual(facetPairs(got.data), want.facets, `contagens ${JSON.stringify(query)}`);
  }
  // Paginas: offset e limit.
  const all = reference(index, { sort: 'newest' }).list;
  const p2 = await page(queryString({ sort: 'newest' }, 40, 40));
  assert.deepEqual(p2.data.games.map((g) => g.id), all.slice(40, 80));
  assert.deepEqual([p2.data.offset, p2.data.limit, p2.data.total, p2.data.sort, p2.data.readyFirmware, p2.data.key], [40, 40, 5000, 'newest', '13.60', 'k1']);
  const big = await page('/api/store?limit=9999');
  assert.equal(big.data.games.length, 200, 'no maximo 200 por pagina');
  const def = await page('/api/store');
  assert.equal(def.data.games.length, 40, '40 sem limit');
});

test('filtros "any" e "todos", busca, solo, opcoes e campos de cada jogo', { skip }, async () => {
  const base = workspace();
  const game = (id, extra) => ({ id, code: id, title: id, platform: 'ps5', s: id.toLowerCase(), genres: [], features: [], formats: [], ready: false, direct: false, providers: [],
    year: null, sizeGb: null, stars: null, ratingCount: 0, cover: '', developer: '', publisher: '', releaseDate: '', solo: null, rank: [0, 0, 0, 0, 0], ...extra });
  const index = { version: 1, key: 'kx', builtAt: 'x', console: 'ps5', readyFirmware: '9.60',
    facets: { platform: ['ps5', 'ps4'], format: ['ready', 'exfat', 'pkg'], access: ['direct'], genre: [{ value: 'Action', name: 'Acao' }, { value: 'RPG', name: 'RPG' }],
      feature: [], release: ['recent', 'current', 'older'], size: ['small', 'medium', 'large'], provider: [] },
    games: [
      game('PPSA00001', { title: 'Alpha Blade', s: 'alpha blade studio x', genres: ['Action', 'RPG'], formats: ['exfat'], ready: true, year: 2024, sizeGb: 10, solo: true, rank: [2, 0, 1, 0, 1] }),
      game('PPSA00002', { title: 'Beta', s: 'beta', genres: ['Action'], formats: ['pkg'], year: 2023, sizeGb: 50, solo: false, direct: true, rank: [1, 1, 0, 1, 0] }),
      game('CUSA00003', { platform: 'ps4', title: 'Gamma', s: 'gamma', genres: ['RPG'], formats: ['pkg', 'exfat'], ready: true, year: 2019, sizeGb: 50.1, rank: [0, 2, 2, 2, 2] }),
      game('CUSA00004', { platform: 'ps4', title: 'Delta', s: 'delta', rank: [3, 3, 3, 3, 3] }),
    ] };
  writeFileSync(path.join(base, 'store/store-index.json'), JSON.stringify(index));
  start(base);
  await up(base);
  const ids = async (qs) => (await page(`/api/store?${qs}`)).data.games.map((g) => g.id);
  assert.deepEqual(await ids(''), ['CUSA00003', 'PPSA00002', 'PPSA00001', 'CUSA00004'], 'relevance pelo rank');
  assert.deepEqual(await ids('sort=newest'), ['PPSA00001', 'PPSA00002', 'CUSA00003', 'CUSA00004']);
  assert.deepEqual(await ids('genre=Action,RPG&sort=title'), ['PPSA00001'], 'genero: todos os escolhidos');
  assert.deepEqual(await ids('format=pkg,exfat&sort=title'), ['PPSA00002', 'PPSA00001', 'CUSA00003'], 'formato: qualquer um');
  assert.deepEqual(await ids('format=ready&sort=title'), ['PPSA00001', 'CUSA00003'], '"ready" pelo campo ready');
  assert.deepEqual(await ids('size=medium&sort=title'), ['PPSA00002', 'PPSA00001'], 'medio = 10..50, sem tamanho fica fora');
  assert.deepEqual(await ids('size=large'), ['CUSA00003']);
  assert.deepEqual(await ids('release=recent,older&sort=title'), ['PPSA00001', 'CUSA00003'], 'sem ano fica fora');
  assert.deepEqual(await ids('access=direct'), ['PPSA00002']);
  assert.deepEqual(await ids('solo=1'), ['PPSA00001'], 'solo: so true (null e false fora)');
  assert.deepEqual(await ids('q=%20%20STUDIO%20'), ['PPSA00001'], 'busca sem espacos nas pontas e sem diferenca de caixa');
  assert.deepEqual(await ids('q=zzz'), []);
  assert.deepEqual(await ids('platform=ps3'), [], 'valor desconhecido: nada');
  const r = await page('/api/store?genre=Action&sort=title');
  assert.equal(r.data.readyFirmware, '9.60');
  assert.deepEqual(r.data.facets.genre, [{ value: 'Action', name: 'Acao', count: 2 }, { value: 'RPG', name: 'RPG', count: 1 }], 'genero (nao "any"): contado com ele mesmo aplicado');
  assert.deepEqual(r.data.facets.platform.map((o) => o.count), [2, 0]);
  assert.deepEqual(r.data.facets.solo, [{ value: '1', name: 'solo', count: 1 }]);
  const p = await page('/api/store?platform=ps4');
  assert.deepEqual(p.data.facets.platform.map((o) => o.count), [2, 2], 'plataforma ("any"): contada sem ela mesma');
  const one = r.data.games.find((g) => g.id === 'PPSA00001');
  assert.deepEqual(one, { id: 'PPSA00001', title: 'Alpha Blade', code: 'PPSA00001', platform: 'ps5', cover: '', sizeGb: 10, formats: ['exfat'], ready: true, stars: null, ratingCount: 0, year: 2024, solo: true, queued: false, genres: ['Action', 'RPG'] });
});

test('sem o indice, indice invalido e indice regravado (relido quando muda)', { skip }, async () => {
  const base = workspace();
  start(base);
  await up(base);
  assert.deepEqual((await page('/api/store')).data, { error: 'no-store' });
  assert.equal((await page('/api/store')).status, 404);
  writeFileSync(path.join(base, 'store/store-index.json'), 'nao e json');
  assert.equal((await page('/api/store')).status, 500);
  const index = makeIndex(30);
  writeFileSync(path.join(base, 'store/store-index.json'), JSON.stringify(index));
  assert.equal((await page('/api/store')).data.total, 30);
  index.games = index.games.slice(0, 7);
  index.key = 'k2';
  writeFileSync(path.join(base, 'store/store-index.json'), JSON.stringify(index));
  const again = await page('/api/store');
  assert.deepEqual([again.data.total, again.data.key], [7, 'k2']);
  assert.equal((await page('/api/store/game?id=NADA')).status, 404);
});

function storeFiles(base, { key = 'kg', links } = {}) {
  const url = (name) => `http://127.0.0.1:${port}/files/${name}`;
  const index = { version: 1, key: 'kg', builtAt: 'x', console: 'ps5', readyFirmware: '13.60', facets: {},
    games: [
      { id: 'PPSA01001', code: 'PPSA01001', title: 'Jogo Direto', platform: 'ps5', s: 'jogo direto', genres: ['Action'], formats: ['exfat'], ready: true, solo: true, sizeGb: 0.3, rank: [0, 0, 0, 0, 0] },
      { id: 'PPSA01002', code: 'PPSA01002', title: 'Jogo Navegador', platform: 'ps5', s: 'jogo navegador', formats: ['rar'], solo: false, rank: [1, 1, 1, 1, 1] },
      { id: 'PPSA01003', code: 'PPSA01003', title: 'Sem Ficha', platform: 'ps5', s: 'sem ficha', formats: [], solo: null, rank: [2, 2, 2, 2, 2] },
    ] };
  const games = { version: 1, key,
    games: [
      { id: 'PPSA01001', summary: 'Resumo.', about: ['P1', 'P2', 'P3', 'P4'], shots: ['https://img.example/1.jpg', 'http://inseguro/2.jpg'], hero: 'https://img.example/h.jpg',
        links: links ?? [
          { kind: 'browser', host: 'Vikingfile', format: 'rar', size: 100, label: 'Viking', filename: 'x.rar', url: 'https://vikingfile.com/x', parts: 0, solo: false, source: 0 },
          { kind: 'direct', host: 'Archive.org', format: 'exfat', size: FILE.length, label: 'Archive', filename: 'Jogo Direto.exfat', url: url('jogo.exfat'), sha256: sha(FILE), parts: 0, solo: true, source: 3 },
          { kind: 'direct', host: 'Archive.org', format: 'rar', size: 10, label: 'Partes', filename: 'set', url: url('p1.rar'), parts: 3, solo: false, source: 1 }] },
      { id: 'PPSA01002', summary: '', about: [], shots: [], links: [{ kind: 'browser', host: '1fichier', format: 'rar', size: null, label: '1fichier', filename: 'y.rar', url: 'https://1fichier.com/y', parts: 0, solo: false, source: 0 },
        { kind: 'torrent', host: 'Torrent', format: 'zip', label: 'Torrent', filename: 'z', parts: 0, solo: false, source: 1 }] },
    ] };
  writeFileSync(path.join(base, 'store/store-index.json'), JSON.stringify(index));
  writeFileSync(path.join(base, 'store/store-games.json'), JSON.stringify(games));
}

test('a ficha: texto, fotos (so https), links sem URL, solo por link e "download"; de outra key fica sem ficha', { skip }, async () => {
  const base = workspace();
  storeFiles(base);
  start(base);
  await up(base);
  const g = await page('/api/store/game?id=PPSA01001');
  assert.equal(g.status, 200);
  assert.deepEqual(g.data.details, { summary: 'Resumo.', about: ['P1', 'P2', 'P3'], shots: ['https://img.example/1.jpg'], hero: 'https://img.example/h.jpg' });
  assert.deepEqual(g.data.links.map((l) => [l.kind, l.host, l.solo, l.parts]), [['browser', 'Vikingfile', false, 0], ['direct', 'Archive.org', true, 0], ['direct', 'Archive.org', false, 3]]);
  assert.ok(!JSON.stringify(g.data).includes('http://127.0.0.1'), 'nenhuma URL de download sai para a pagina');
  assert.equal(g.data.download, 'payload');
  assert.deepEqual([g.data.game.title, g.data.game.genres, g.data.game.solo], ['Jogo Direto', ['Action'], true]);
  const b = await page('/api/store/game?id=PPSA01002');
  assert.deepEqual([b.data.download, b.data.links.length, b.data.links.every((l) => !l.solo)], ['app', 2, true]);
  const none = await page('/api/store/game?id=PPSA01003');
  assert.deepEqual([none.data.download, none.data.links, none.data.details, none.data.detailsState], ['app', [], undefined, 'none']);
  storeFiles(base, { key: 'velha' });
  const stale = await page('/api/store/game?id=PPSA01001');
  assert.deepEqual([stale.data.download, stale.data.links, stale.data.detailsState], ['app', [], 'stale']);
});

// glibren.42 (J7): o store-games.json e lido inteiro uma vez (monta a tabela de deslocamentos); cada ficha depois e so o
// pedaco do jogo. Regravado (tmp + rename, como a Jobe faz), a tabela e montada de novo e a ficha nova aparece.
test('a ficha le so o pedaco do jogo (tabela de deslocamentos), remontada quando o arquivo muda', { skip }, async () => {
  const base = workspace();
  storeFiles(base);
  start(base);
  await up(base);
  const built = () => (readFileSync(path.join(base, 'state/bgdl.log'), 'utf8').match(/indice de deslocamentos do store-games\.json montado/g) || []).length;
  for (let i = 0; i < 5; i++) {
    const g = await page('/api/store/game?id=PPSA01001');
    assert.equal(g.data.details.summary, 'Resumo.');
    const b = await page('/api/store/game?id=PPSA01002');
    assert.equal(b.data.links.length, 2);
  }
  assert.equal(built(), 1, 'o arquivo inteiro foi lido uma vez so');
  // A Jobe regrava (tmp + rename): a ficha nova aparece e a tabela e remontada.
  const file = path.join(base, 'store/store-games.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.games[0].summary = 'Resumo novo, com acento: ação ™ 日本語.';
  doc.games.unshift({ id: 'PPSA09999', summary: 'x'.repeat(5000), about: [], shots: [], links: [] });
  writeFileSync(`${file}.tmp`, JSON.stringify(doc));
  renameSync(`${file}.tmp`, file);
  const g = await page('/api/store/game?id=PPSA01001');
  assert.equal(g.data.details.summary, 'Resumo novo, com acento: ação ™ 日本語.');
  assert.equal(built(), 2);
  assert.deepEqual((await page('/api/store/game?id=PPSA01003')).data.detailsState, 'none');
});

test('Baixar: sem PIN nao; Jobe aberta vira marcador para ela; repetido "ja esta"; o pedido vai ao app em GET /jobs', { skip }, async () => {
  const base = workspace();
  storeFiles(base);
  start(base, { BGDL_APP_SILENCE_MS: '600000' });
  await up(base);
  assert.equal((await page('/api/store/add', { method: 'POST', body: { id: 'PPSA01001' } })).status, 401);
  const session = await unlocked(base);
  assert.equal((await page('/api/store/add', { method: 'POST', session, body: { id: 'NADA' } })).status, 404);
  const add = await page('/api/store/add', { method: 'POST', session, body: { id: 'PPSA01001' } });
  assert.deepEqual([add.status, add.data.via, add.data.appOpen, add.data.reason], [200, 'app', true, 'open']);
  const again = await page('/api/store/add', { method: 'POST', session, body: { id: 'PPSA01001' } });
  assert.deepEqual(again.data, { ok: true, already: true, id: add.data.id });
  const job = (await call(base, 'GET', '/jobs')).data.jobs.find((j) => j.id === add.data.id);
  assert.deepEqual([job.placeholder, job.state, job.library.store, job.library.source, job.library.code, job.library.autoStarted, job.library.autoNote], [true, 'waiting-app', 'PPSA01001', -1, 'PPSA01001', false, 'store']);
  const shown = (await page('/api/status')).data.jobs.find((j) => j.id === add.data.id);
  assert.deepEqual([shown.requested, shown.store, shown.via], [true, true, undefined], 'na pagina: pedido da loja, nao "via TorBox"');
  assert.equal((await page('/api/store?q=jogo%20direto')).data.games[0].queued, true, 'a lista mostra "na fila"');
  // O app pos na fila dele: o marcador sai (forget) e um novo pedido volta a valer.
  assert.equal((await call(base, 'POST', `/jobs/${add.data.id}/forget`)).status, 200);
  // O app recusou: o pedido "failed" da lugar a um novo.
  const next = await page('/api/store/add', { method: 'POST', session, body: { id: 'PPSA01001' } });
  assert.notEqual(next.data.id, add.data.id);
  assert.equal((await call(base, 'POST', `/jobs/${next.data.id}/refuse`, { error: 'sem espaco' })).status, 200);
  const retry = await page('/api/store/add', { method: 'POST', session, body: { id: 'PPSA01001' } });
  assert.ok(retry.data.ok && !retry.data.already, JSON.stringify(retry.data));
});

test('Baixar com a Jobe fechada: o payload baixa o primeiro link solo sozinho (destino do app), sem solo vira marcador; arquivo ja no disco', { skip }, async () => {
  const base = workspace();
  storeFiles(base);
  const disk = path.join(base, 'disk');
  start(base, { BGDL_APP_SILENCE_MS: '600' });
  await up(base);
  const session = await unlocked(base);
  assert.equal((await call(base, 'POST', '/config', { autoRoot: disk, autoConvert: false })).status, 200);
  await wait(900); // o app calado = fechado
  const add = await page('/api/store/add', { method: 'POST', session, body: { id: 'PPSA01001' } });
  assert.deepEqual([add.status, add.data.via], [200, 'payload'], JSON.stringify(add.data));
  const status = await statusUntil((s) => s.jobs.find((j) => j.id === add.data.id)?.state === 'completed', 60000);
  const shown = status.jobs.find((j) => j.id === add.data.id);
  assert.deepEqual([shown.store, shown.auto, shown.format], [true, true, 'exfat']);
  assert.equal(sha(readFileSync(path.join(disk, 'homebrew/Jogo Direto.exfat'))), sha(FILE), 'imagem publicada em homebrew/ como o app faz');
  const job = (await call(base, 'GET', '/jobs')).data.jobs.find((j) => j.id === add.data.id);
  assert.deepEqual([job.library.store, job.library.source, job.library.autoStarted, job.library.via], ['PPSA01001', 3, true, 'direct'], 'a fonte escolhida (o 2o link, o 1o solo) vai ao app para a adocao');
  assert.match(readFileSync(path.join(base, 'notify.txt'), 'utf8'), /Jogo Direto entrou na fila pelo celular e vai baixar pelo payload/);
  // Sem link solo: marcador que espera a Jobe.
  await wait(700);
  const app = await page('/api/store/add', { method: 'POST', session, body: { id: 'PPSA01002' } });
  assert.deepEqual([app.data.via, app.data.appOpen, app.data.reason], ['app', false, 'needs-app']);
  assert.equal((await page('/api/status')).data.jobs.find((j) => j.id === app.data.id).autoNote, 'needs-app');
  // O arquivo ja esta no disco: 409.
  assert.equal((await call(base, 'POST', `/jobs/${add.data.id}/forget`)).status, 200);
  await wait(700);
  const exists = await page('/api/store/add', { method: 'POST', session, body: { id: 'PPSA01001' } });
  assert.deepEqual([exists.status, exists.data.error], [409, 'exists']);
});

test('o pedido da loja sobrevive a reiniciar o payload (jobs.json) e o auto_loop do TorBox nao o pega', { skip }, async () => {
  const base = workspace();
  storeFiles(base, { links: [{ kind: 'browser', host: 'x', format: 'rar', label: 'x', filename: 'x.rar', parts: 0, solo: false, source: 0 }] });
  let child = start(base, { BGDL_APP_SILENCE_MS: '400', BGDL_AUTO_RETRY_MS: '200' });
  await up(base);
  const session = await unlocked(base);
  assert.equal((await call(base, 'POST', '/config', { autoRoot: path.join(base, 'disk') })).status, 200);
  await wait(700);
  const add = await page('/api/store/add', { method: 'POST', session, body: { id: 'PPSA01001' } });
  assert.equal(add.data.via, 'app');
  await wait(1200);
  let shown = (await page('/api/status')).data.jobs.find((j) => j.id === add.data.id);
  assert.deepEqual([shown.state, shown.autoNote], ['waiting-app', 'needs-app'], 'o auto_loop nao troca a nota (no-key) de um pedido da loja');
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  child = start(base, { BGDL_APP_SILENCE_MS: '400' });
  await up(base);
  const job = (await call(base, 'GET', '/jobs')).data.jobs.find((j) => j.id === add.data.id);
  assert.deepEqual([job?.placeholder, job?.library?.store], [true, 'PPSA01001']);
});
