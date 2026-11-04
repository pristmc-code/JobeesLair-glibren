// The bundled catalog as the console reads it (tools/catalog/catalog-index.mjs, app/data/catalog-index.js):
// app/data/catalog/ is current with app/data/catalog.js, reads back as the very same games, and the art that
// waits in its art files is read only when a game's is asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const tool = await load('tools/catalog/catalog-index.mjs');
const source = await tool.readCatalog();
// Loaded first and alone: what the launch reads before any screen draws.
const index = await load('app/data/catalog-index.js');
const readAtLaunch = index.artFilesRead();
const catalog = await load('app/state/catalog.js');
await load('app/browse/featured.js');
const readByLists = index.artFilesRead();

test('catalog index: app/data/catalog/ is current with app/data/catalog.js (run tools/catalog/catalog-index.mjs)', () => {
  const files = tool.indexFiles(source);
  const dir = path.join(repo, 'app/data/catalog');
  const shipped = ['index.json', ...readdirSync(path.join(dir, 'art')).map((name) => `art/${name}`)].sort();
  assert.deepEqual(shipped, Object.keys(files).sort(), 'the same files, none left over');
  for (const [name, text] of Object.entries(files)) assert.equal(readFileSync(path.join(dir, name), 'utf8'), text, name);
});

test('catalog index: the app bundles no data/catalog.js and packages data/catalog/', () => {
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(js|jsx)$/.test(entry.name)) sources.push(file);
    }
  };
  walk(path.join(repo, 'app'));
  const inData = (file) => path.dirname(file) === path.join(repo, 'app', 'data');
  const importers = sources.filter((file) => {
    const text = readFileSync(file, 'utf8');
    return /from '[./]*data\/catalog\.js'/.test(text) || (inData(file) && /from '\.\/catalog\.js'/.test(text));
  });
  assert.deepEqual(importers.map((file) => path.relative(repo, file)), []);
  const app = JSON.parse(readFileSync(path.join(repo, 'app/app.json'), 'utf8'));
  assert.ok(app.resources.includes('data/catalog'), 'app.json resources');
});

test('catalog index: the package reads back every game of data/catalog.js, every field and every picture', () => {
  const { coverSize } = index;
  // state/catalog.js has since sized the covers, split the genres and added its own fields: compare the source
  // with what the index gives for each of the source's own fields, read through the lazy art.
  const byId = new Map([...index.games, ...index.twins].map((game) => [game.id, game]));
  assert.equal(index.features.join(), source.features.join());
  for (const want of [...source.games, ...source.twins]) {
    const got = byId.get(want.id);
    assert.ok(got, want.id);
    for (const [key, value] of Object.entries(want)) {
      if (key === 'art' || key === 'genres') continue;
      assert.deepEqual(got[key], value, `${want.id} ${key}`);
    }
    for (const [key, value] of Object.entries(want.art)) {
      const expected = key === 'cover' ? coverSize(value) : key === 'coverFallbacks' ? value.map(coverSize) : value;
      assert.deepEqual(got.art[key], expected, `${want.id} art.${key}`);
    }
    for (const name of ['hero', 'logo', 'coverFallbacks']) assert.equal(index.hasArt(got, name), Boolean(want.art[name]), `${want.id} has ${name}`);
  }
  assert.equal(index.games.length >= source.games.length, true);
});

test('catalog index: the launch, the filters, the sorts and the Discover picks read no art file', () => {
  assert.equal(readAtLaunch, 0, 'reading the index');
  assert.equal(readByLists, 0, 'state/catalog.js and browse/featured.js');
  const before = index.artFilesRead();
  const { FACETS, NO_FILTERS, facetCounts, filterGames, sortGames, topRated } = catalog;
  const all = { filters: NO_FILTERS, query: 'the', wishlist: [] };
  for (const facet of FACETS) facetCounts(all, facet);
  for (const sort of catalog.SORTS) sortGames(filterGames(all), sort.id);
  topRated(index.games);
  assert.equal(index.artFilesRead(), before);
});

test('catalog index: a banner reads its art file once, and the files kept stay few', () => {
  const before = index.artFilesRead();
  const withHero = index.games.filter((game) => index.hasArt(game, 'hero'));
  const first = withHero[0];
  assert.match(first.art.hero, /^https:\/\//);
  assert.equal(index.artFilesRead(), before + 1, 'one file for the first banner');
  first.art.hero;
  first.art.logo;
  assert.equal(index.artFilesRead(), before + 1, 'kept: no second read');
  // Every banner, one pass: each file is read once in catalog order, never once a game.
  for (const game of withHero) assert.ok(game.art.hero);
  const files = readdirSync(path.join(repo, 'app/data/catalog/art')).length;
  assert.ok(index.artFilesRead() - before <= files, `${index.artFilesRead() - before} reads for ${files} files`);
  // A game with no art file entry asks nothing.
  const plain = { id: 'X', art: { cover: 'https://example.com/a.png' } };
  assert.equal(index.hasArt(plain, 'hero'), false);
  assert.equal(index.hasArt({ art: { hero: 'https://example.com/h.png' } }, 'hero'), true);
});
