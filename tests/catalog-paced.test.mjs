// glibren.45: no console a loja e montada em partes (state/catalog.js buildSteps), um quadro de cada vez, a partir da
// abertura; o resultado tem de ser o mesmo da montagem de uma vez, e os modulos que tiraram linhas da lista vazia refazem
// as suas (state/store-mode.js) antes de a loja aparecer.
// Run: node --import ./tests/stub-loader.mjs --test tests/catalog-paced.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './catalog-paced-flag.mjs';
import './catalog-paced-load.mjs';

const index = await import('../app/data/catalog-index.js');
const catalog = await import('../app/state/catalog.js');
const storeMode = await import('../app/state/store-mode.js');
const search = await import('../app/search/match.js');

const bundled = JSON.parse(readFileSync(new URL('../app/data/catalog/index.json', import.meta.url), 'utf8'));

// The modules loaded with nothing built: the parts run on timers after them. The awaits above already let some run, so the
// look at load time is taken by tests/catalog-paced-load.mjs, imported statically before them.
const atLoad = globalThis.__catalogAtLoad;

test('glibren.45: paced: nothing is built as the modules load; the store waits for it', async () => {
  assert.equal(index.CATALOG_PACED, true);
  assert.deepEqual(atLoad, { ready: false, games: 0, formatOptions: 0, facets: catalog.FACETS.length });
  const format = catalog.FACETS.find((facet) => facet.key === 'format');
  assert.equal(format, globalThis.__catalogFormatFacet, 'the same facet object from the start (search/index.jsx keeps it)');
  let told = 0;
  catalog.whenCatalogReady((paced) => { told++; assert.equal(paced, true); });
  await catalog.catalogReady();
  assert.equal(told, 1);
  assert.equal(catalog.isCatalogReady(), true);
  assert.ok(format.options.length > 1, 'the same facet object got its options');
  assert.equal(format.options[0].value, 'ready');
  catalog.whenCatalogReady(() => told++);
  assert.equal(told, 2, 'once built, at once');
});

test('glibren.45: paced: the store is the same as built at once, in many short parts', async () => {
  await catalog.catalogReady();
  const stats = catalog.catalogBuildStats();
  assert.equal(stats.paced, true);
  assert.ok(stats.steps > 5, `parts: ${stats.steps}`);
  // glibren.49: com a suite inteira em paralelo uma parte chegou a 329 ms (CPU disputada): o tempo absoluto so vale
  // sem carga; o que nao muda com a carga e a parte mais longa ser uma fracao pequena da montagem toda.
  assert.ok(stats.longest < 200 || stats.longest * 4 < stats.total, `the longest part ${stats.longest} ms of ${stats.total} ms`);
  const ids = catalog.catalogEntries().map(({ game }) => game.id);
  assert.equal(ids.length, bundled.games.length + (bundled.twins ?? []).length);
  assert.equal(index.games.length, bundled.games.length);
  const first = catalog.getGame(bundled.games[0].id);
  assert.ok(first && typeof first.title === 'string' && Array.isArray(first.genres), 'a game, decoded');
  assert.equal(typeof first.platform, 'string', 'names decoded from the index lists');
  assert.ok(Array.isArray(first.formats));
  assert.ok(catalog.genres.length > 3, 'genres');
  assert.ok(catalog.allListed.length === index.games.length, 'allListed');
  const genre = catalog.FACETS.find((facet) => facet.key === 'genre');
  assert.ok(genre.options.length > 3);
  assert.ok(catalog.FACETS.find((facet) => facet.key === 'feature').options.length > 0);
});

test('glibren.45: paced: what was worked out from the empty list is worked out again (store-mode rebuilders)', async () => {
  await catalog.catalogReady();
  assert.ok(storeMode.storeEpoch() >= 1, 'the store was rebuilt once the catalog was');
  const someone = index.games.find((game) => game.title?.length > 4);
  const word = someone.title.slice(0, 4);
  assert.ok(search.searchGames(word).length > 0, 'search finds games (its texts were made again)');
});
