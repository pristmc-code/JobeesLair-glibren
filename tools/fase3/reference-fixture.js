// Fase 3: a REFERENCIA do teste de paridade, sobre o fixture (tests/fixtures/fase3). O codigo do app (state/catalog.js,
// feeds.js, store-mode.js, search/match.js, featured.js, as fileiras de browse/Lanes.jsx, game/sources.js, store-export.js)
// rodando no qjs 0.15, o motor do ps5-react, com o @ps5-react/core de tools/fase3/qjs-core-f3.js.
// Dois passos, cada um num processo (o catalogo e montado quando o modulo carrega):
//   prep <fs> <app/> <fixture/> <variante>        baixa os feeds do fixture (um Http de mentira) e grava os caches do app
//   ref  <fs> <app/> <fixture/> <variante> <saida> monta a loja e grava o que o payload tem de dar igual
// Variantes: ps5 (tudo), low (firmware 9.60), ps4 (o app do PS4), hidden (a lista Pegasus escondida da loja).
import * as std from 'qjs:std';
import * as os from 'qjs:os';

let pumping = true;
const pump = () => { if (pumping) os.setTimeout(pump, 1); };
pump();

const [, mode, fsDir, appDir, fixture, variant, outFile] = scriptArgs;
globalThis.__MEM_FS = fsDir;
globalThis.__MEM_APP = appDir.endsWith('/') ? appDir : appDir + '/';
globalThis.__MEM_OS = variant === 'ps4' ? 'ps4' : 'ps5';
globalThis.__MEM_FIRMWARE = variant === 'low' ? '9.60' : '';
const WEB = 'https://feeds.example/fase3.json';
const PKG = 'https://pegasus.example/catalogs/fase3.json';
const LOCAL = '/data/fixture/feed-local.json';
const reply = (status, body, url) => ({ status, ok: status >= 200 && status < 300, url, headers: { etag: '"fixture"' }, text: async () => body, json: async () => JSON.parse(body) });
const files = { [WEB]: 'feed-web.jlx', [PKG]: 'feed-pegasus.jlx' };
globalThis.__MEM_HTTP = async (url) => {
  if (/live\.(jlx|json)$/.test(url)) return reply(200, std.loadFile(`${fixture}/live.jlx`), url);
  if (files[url]) return reply(200, std.loadFile(`${fixture}/${files[url]}`), url);
  return reply(404, 'not found', url);
};
const done = (text) => { pumping = false; print(`DONE ${text}`); std.exit(0); };

if (mode === 'prep') {
  const { FileSystem } = await import('@ps5-react/core');
  FileSystem.writeFile(LOCAL, std.loadFile(`${fixture}/feed-local.json`));
  if (variant !== 'ps4') {
    const orbit = await import('../../app/state/orbit-feed.js');
    const { readJlx } = await import('../../app/state/jlx.js');
    FileSystem.writeFile(orbit.ORBIT_FEED, readJlx(std.loadFile(`${fixture}/orbit-store.jlx`)));
    FileSystem.writeFile(orbit.ORBIT_STATUS, JSON.stringify({ conv: 3, known: 50, ok: 1763000000, rev: 96 }));
    orbit.setOrbitFeed(true);
  }
  const feeds = await import('../../app/state/feeds.js');
  for (const url of [WEB, PKG]) feeds.addFeed(url);
  feeds.addLocalFeed(LOCAL);
  await feeds.refreshFeeds();
  done(`feeds ${feeds.feedsSnapshot().map((feed) => `${feed.url}=${feed.state}:${feed.games}`).join(' ')}`);
}

const index = await import('../../app/data/catalog-index.js');
const catalog = await import('../../app/state/catalog.js');
const storeMode = await import('../../app/state/store-mode.js');
const { searchGames } = await import('../../app/search/match.js');
const { pickFeatured } = await import('../../app/browse/featured.js');
const { sourceOrder } = await import('../../app/game/sources.js');
const { soloLink } = await import('../../app/state/store-export.js');
const { orbitKnownIds } = await import('../../app/state/orbit-feed.js');
const { isoDate } = await import('../../app/state/clock.js');
const { games, hasArt } = index;
const { FACETS, NO_FILTERS, activeCount, filterGames, facetCounts, oneEach, otherThan, sortGames, topRated, readyHere, fromArchive, ratingScore, onCdn,
  relatedGames, editionsOf, getGame, catalogEntries, catalogSources } = catalog;
if (variant === 'hidden') storeMode.setSourceShown(PKG, false);

const facetValues = () => Object.fromEntries(FACETS.map((facet) => [facet.key, facet.options.map((option) => option.value)]));
const resolve = (values, key, value) => value === '@first' ? values[key][0] : value === '@second' ? values[key][1] : value;
const filtersOf = (query) => {
  const values = facetValues();
  const filters = { ...NO_FILTERS };
  for (const facet of FACETS) if (query[facet.key]) filters[facet.key] = String(query[facet.key]).split(',').map((value) => resolve(values, facet.key, value));
  return filters;
};
const resolved = (query, filters) => { const out = { ...query }; for (const facet of FACETS) if (filters[facet.key].length) out[facet.key] = filters[facet.key].join(','); return out; };
// browse/Catalog.jsx gridOf
function grid(query) {
  const filters = filtersOf(query);
  const q = query.q ?? '';
  const pool = activeCount(filters) === 0 && !q.trim() ? games : filterGames({ filters, query: q, wishlist: [] });
  const everyCopy = Boolean(filters.platform?.length || q.trim());
  const list = everyCopy ? sortGames(pool, query.sort) : oneEach(sortGames(pool, query.sort));
  return { query: resolved(query, filters), ids: list.map((game) => game.id) };
}
// filter sheet: facetCounts de cada filtro
function counts(query) {
  const filters = filtersOf(query);
  const state = { filters, query: query.q ?? '', wishlist: [] };
  return { query: resolved(query, filters), counts: Object.fromEntries(FACETS.map((facet) => [facet.key, facetCounts(state, facet)])) };
}
// search/index.jsx GameResults
function search(query) {
  const filters = filtersOf(query);
  const passing = filterGames({ filters, query: '', wishlist: [] });
  const trimmed = (query.q ?? '').trim();
  const passed = new Set(passing);
  const list = trimmed ? sortGames(searchGames(trimmed).filter((game) => passed.has(game)), query.sort) : sortGames(passing, query.sort);
  return { query: resolved(query, filters), ids: list.map((game) => game.id) };
}
// featured.js + browse/Lanes.jsx rows() + PopularRail + CdnRail, com o sorteio de semente (o C usa o mesmo).
function home(seed, today) {
  let state = seed;
  const random = () => { state = Number((BigInt(state) * 1103515245n + 12345n) % 2147483648n); return state / 2147483648; };
  const featured = pickFeatured(games, random);
  const FEATURED = oneEach(otherThan([...games].filter((game) => hasArt(game, 'hero')).sort((a, b) => fromArchive(b) - fromArchive(a) || b.recommendations - a.recommendations), featured)).slice(0, 12);
  const RECENT = oneEach(sortGames(games.filter((game) => game.releaseDate), 'newest')).slice(0, 15);
  const TOP = topRated(games).slice(0, 20);
  const WEEK_AGO = isoDate(Date.parse(`${today}T00:00:00Z`) - 7 * 864e5);
  const NEW_ALL = oneEach(games.filter((game) => game.addedAt && game.addedAt >= WEEK_AGO).sort((a, b) => b.addedAt.localeCompare(a.addedAt) || ratingScore(b) - ratingScore(a)));
  const READY_ALL = games.filter(readyHere);
  const READY = oneEach(otherThan(sortGames(READY_ALL, 'relevance'), [...featured, ...FEATURED])).slice(0, 15);
  const POPULAR = oneEach(otherThan(games.filter((game) => game.ratingCount > 0).sort((a, b) => b.ratingCount - a.ratingCount || b.recommendations - a.recommendations), [...featured, ...FEATURED, ...TOP, ...READY])).slice(0, 15);
  const SERVED = oneEach(sortGames(games.filter(onCdn), 'relevance'));
  const ids = (list) => list.map((game) => game.id);
  return { seed, today, carousel: ids(featured), featured: ids(FEATURED), recent: ids(RECENT), top: ids(TOP), newWeek: ids(NEW_ALL.slice(0, 20)), newWeekCount: NEW_ALL.length,
    ready: ids(READY), readyCount: READY_ALL.length, popular: ids(POPULAR), cdn: ids(SERVED) };
}
const row = (game) => [game.id, game.title, game.platform, (game.formats ?? []).join(' '), game.direct ? 1 : 0, game.sizeGb ?? null, game.stars ?? null, game.ratingCount ?? null,
  (game.providers ?? []).join(','), (game.genres ?? []).join('|'), game.releaseDate ?? '', game.year ?? null, (game.features ?? []).join('|'), Boolean(readyHere(game))];

const queries = JSON.parse(std.loadFile(`${appDir}/../tools/fase3/queries.json`));
const extra = [
  { name: 'q-nfc', sort: 'title', q: 'pokémon' }, { name: 'q-nfc2', sort: 'title', q: 'pokémon' }, { name: 'q-sigma', sort: 'title', q: 'σοφος' },
  { name: 'q-istanbul', sort: 'title', q: 'i̇stanbul' }, { name: 'fpkg-ready', sort: 'size', format: 'ready,fpkg' }, { name: 'feature-second', sort: 'rating', feature: '@second' },
];
const out = { variant, engine: 'qjs 0.15 (app)', listed: games.length, entries: catalogEntries().length, facets: facetValues(), games: games.map(row) };
const small = variant !== 'ps5';
out.results = (small ? queries.slice(0, 12) : [...queries, ...extra]).map(grid);
out.counts = (small ? [{ sort: 'relevance' }, { sort: 'title', platform: 'ps5', format: 'ready' }] : [{ sort: 'relevance' }, ...queries.slice(5, 30)]).map(counts);
out.sources = catalogSources();
if (!small || variant === 'ps4') out.home = [home(7, '2026-11-13'), home(12345, '2026-11-13')];
if (!small) {
  out.search = [{ q: 'pokemon', sort: 'title' }, { q: 'POKÉMON', sort: 'relevance' }, { q: 'final', sort: 'newest', platform: 'ps5' }, { q: 'sofos', sort: 'title' },
    { q: 'σοφοσ', sort: 'title' }, { q: '', sort: 'rating', genre: 'Action' }, { q: 'the', sort: 'size', format: 'ready' }, { q: 'resident evil', sort: 'title' }].map(search);
  // as fichas: os jogos dos feeds do fixture, alguns do embutido (com e sem conjuntos em partes) e alguns da Orbit e do ao vivo
  const ids = new Set(['PPSA90001', 'PPSA90002', 'CUSA90003', 'PPSA90004', 'PPSA90005', 'PPSA90010', 'CUSA90011', 'PPSA90020', 'CUSA90021']);
  const entries = catalogEntries().map(({ game }) => game);
  for (const game of entries.filter((game) => !game.feedPage).slice(0, 12)) ids.add(game.id);
  for (const game of entries) { if (ids.size >= 40) break; try { if (!game.feedPage && game.releases.some((release) => release.parts)) ids.add(game.id); } catch {} }
  for (const game of entries.filter((game) => game.feedPage).slice(0, 12)) ids.add(game.id);
  for (const game of entries) { if (ids.size >= 60) break; try { if ((game.providers ?? []).length > 2) ids.add(game.id); } catch {} }
  out.fichas = [...ids].filter((id) => getGame(id)).map((id) => {
    const game = getGame(id);
    const releases = JSON.parse(JSON.stringify(game.releases));
    return { id, releases, order: sourceOrder(game.releases), editions: editionsOf(game).map((edition) => edition.id), related: relatedGames(game).map((other) => other.id) };
  });
  out.solo = Object.fromEntries(games.map((game) => { let solo = false; try { solo = game.releases.some(soloLink); } catch {} return [game.id, solo]; }));
  out.known = orbitKnownIds() ?? [];
}
const file = std.open(outFile, 'w');
file.puts(JSON.stringify(out));
file.close();
done(`${variant} listed ${out.listed} entries ${out.entries}`);
