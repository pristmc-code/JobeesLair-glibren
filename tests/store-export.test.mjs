// glibren (item 2): a loja completa exportada para o payload (app/state/store-export.js) e a equivalencia com o app: o
// payload (app/native/bg_store.c, compilado para o desktop) le o store-index.json exportado do catalogo embutido e da os
// mesmos jogos, na mesma ordem e com as mesmas contagens que app/state/catalog.js (filterGames, sortGames, facetCounts).
// Run: node --import ./tests/stub-loader.mjs --test tests/store-export.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const core = await import('@ps5-react/core');
const catalog = await import('../app/state/catalog.js');
const { exportStore, soloLink, storeGameEntry, storeIndexDocument, STORE_DIR } = await import('../app/state/store-export.js');
const { FACETS, NO_FILTERS, SORTS, facetCounts, filterGames, sortGames } = catalog;

test('o indice: os jogos da loja na ordem dela, rank de cada ordem igual ao sortGames, facetas do app', () => {
  const doc = storeIndexDocument();
  const all = filterGames({ filters: NO_FILTERS, query: '', wishlist: [] });
  assert.deepEqual(doc.games.map((game) => game.id), all.map((game) => game.id));
  SORTS.forEach(({ id }, at) => {
    const byRank = [...doc.games].sort((a, b) => a.rank[at] - b.rank[at]).map((game) => game.id);
    assert.deepEqual(byRank, sortGames(all, id).map((game) => game.id), id);
  });
  assert.deepEqual(doc.facets.format, FACETS.find((facet) => facet.key === 'format').options.map((option) => option.value));
  assert.deepEqual(doc.facets.genre.map((option) => option.value), FACETS.find((facet) => facet.key === 'genre').options.map((option) => option.value));
  assert.ok(doc.games.every((game) => game.solo === null), 'sem store-games, solo ainda nao se sabe');
  assert.equal(doc.readyFirmware, '13.60');
  const sample = doc.games[0];
  assert.equal(sample.s, `${all[0].title} ${all[0].developer} ${all[0].publisher}`.toLowerCase());
});

test('solo: so link direto, publico, de um arquivo, nem add-on, nem backport, nem morto', () => {
  const base = { url: 'https://archive.org/download/x/Jogo.exfat', filename: 'Jogo.exfat', provider: 'archive.org', label: 'Archive' };
  assert.equal(soloLink(base), true);
  assert.equal(soloLink({ ...base, parts: [{}] }), false, 'partes');
  assert.equal(soloLink({ ...base, requiresBrowser: true }), false, 'navegador');
  assert.equal(soloLink({ ...base, url: 'magnet:?xt=urn:btih:abc' }), false, 'torrent');
  assert.equal(soloLink({ ...base, debrid: { service: 'torbox' } }), false, 'debrid (link temporario)');
  assert.equal(soloLink({ ...base, label: 'Archive DLC' }), false, 'add-on');
  assert.equal(soloLink({ ...base, label: 'Backport 4.xx' }), false, 'backport');
  assert.equal(soloLink({ ...base, linkHealth: { status: 'dead' } }), false, 'morto');
  assert.equal(soloLink({ ...base, url: 'https://vikingfile.com/f/abc' }), false, 'host com captura no navegador');
  assert.equal(soloLink({ ...base, unavailableReason: 'x' }), false);
});

test('a ficha: links na ordem da Jobe, url so nos solo, indice de cada link', () => {
  const game = catalog.catalogEntries().map(({ game: item }) => item).find((item) => item.releases.length > 2);
  const entry = storeGameEntry(game);
  assert.equal(entry.id, game.id);
  assert.equal(entry.links.length, game.releases.length);
  assert.deepEqual(new Set(entry.links.map((link) => link.source)).size, game.releases.length);
  for (const link of entry.links) assert.equal('url' in link, link.solo, `${link.host}: url so num link solo`);
});

test('exportStore grava indice, fichas (chave antes dos jogos) e o solo; a segunda vez nao regrava', async () => {
  const files = new Map();
  globalThis.__stubFiles = files;
  core.FileSystem.appendFile = (file, text) => files.set(file, (files.get(file) ?? '') + text);
  try {
    const first = await exportStore({ pause: async () => {}, log: () => {} });
    assert.equal(first.written, 'all');
    const index = JSON.parse(files.get(`${STORE_DIR}/store-index.json`));
    const gamesText = files.get(`${STORE_DIR}/store-games.json`);
    assert.ok(gamesText.startsWith(`{"version":1,"key":${JSON.stringify(index.key)},"games":[`));
    const games = JSON.parse(gamesText);
    assert.equal(games.games.length, index.games.length);
    assert.ok(index.games.every((game) => typeof game.solo === 'boolean'));
    const solo = new Map(games.games.map((game) => [game.id, game.links.some((link) => link.solo)]));
    assert.ok(index.games.every((game) => game.solo === solo.get(game.id)));
    const second = await exportStore({ pause: async () => {}, log: () => {} });
    assert.equal(second.written, 'none');
  } finally {
    globalThis.__stubFiles = undefined;
    delete core.FileSystem.appendFile;
  }
});

// ---- Equivalencia com o payload (bg_store.c) sobre o indice exportado do catalogo embutido ----
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-export-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O1', '-o', binary, path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
const skip = !compiler ? 'no C compiler' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 300)}` : false;
const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('o payload da os mesmos ids, ordem e contagens que catalog.js para o indice exportado', { skip }, async () => {
  for (const sub of ['state', 'store']) mkdirSync(path.join(dir, sub), { recursive: true });
  const doc = storeIndexDocument();
  writeFileSync(path.join(dir, 'store/store-index.json'), JSON.stringify(doc));
  const api = await freePort(), monitor = await freePort();
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(dir, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor),
    BGDL_STORE_DIR: path.join(dir, 'store'), BGDL_STORE_CHECK_MS: '0', BGDL_LIBRARY: path.join(dir, 'none.json'), BGDL_NOTIFY_FILE: path.join(dir, 'n.txt') }, stdio: 'ignore' });
  try {
    const get = async (query) => {
      for (const end = Date.now() + 20000; ; await wait(100)) {
        try {
          const res = await fetch(`http://127.0.0.1:${monitor}/api/store?${query}`);
          return await res.json();
        } catch (problem) {
          if (Date.now() > end) throw problem;
        }
      }
    };
    const facet = (key) => FACETS.find((item) => item.key === key);
    const genre = facet('genre').options[1].value;
    const cases = [
      [{}, '', 'relevance'],
      [{ platform: ['ps5'] }, '', 'newest'],
      [{ format: ['ready'] }, '', 'rating'],
      [{ format: ['ready', facet('format').options.at(-1).value], genre: [genre] }, '', 'size'],
      [{ genre: [genre, facet('genre').options[2].value] }, 'the', 'title'],
      [{ release: ['recent', 'older'], size: ['large'] }, '', 'relevance'],
      [{ access: ['direct'], provider: [facet('provider').options[0].value] }, 'a', 'newest'],
    ];
    for (const [picked, query, sort] of cases) {
      const state = { filters: { ...NO_FILTERS, ...picked }, query, wishlist: [] };
      const expected = sortGames(filterGames(state), sort).map((game) => game.id);
      const params = new URLSearchParams({ q: query, sort, limit: '200' });
      for (const [key, values] of Object.entries(picked)) params.set(key, values.join(','));
      const ids = [];
      let answer;
      for (let offset = 0; ; offset += 200) {
        params.set('offset', String(offset));
        answer = await get(params.toString());
        assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 200));
        ids.push(...answer.games.map((game) => game.id));
        if (ids.length >= answer.total || !answer.games.length) break;
      }
      const label = `${JSON.stringify(picked)} q=${query} ${sort}`;
      assert.equal(answer.total, expected.length, label);
      assert.deepEqual(ids, expected, label);
      for (const item of FACETS) {
        const counts = facetCounts(state, item);
        const fromC = Object.fromEntries((answer.facets[item.key] ?? []).map(({ value, count }) => [value, count]));
        for (const [value, count] of Object.entries(counts)) assert.equal(fromC[value] ?? 0, count, `${label}: ${item.key}=${value}`);
      }
    }
  } finally {
    child.kill('SIGKILL');
  }
});
