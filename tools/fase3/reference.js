// Fase 3 (prototipo): a REFERENCIA. O codigo do app (state/catalog.js e a grade de browse/Catalog.jsx) rodando no qjs
// 0.15 (o motor do ps5-react), com o @ps5-react/core de tools/memory/qjs-core.js e a pasta de trabalho que o
// tools/memory/scenarios.js "prep-orbit" deixou (cache do catalogo ao vivo + lista Orbit ligada).
// Grava um JSON com: contagens, os jogos listados (campos usados pela loja), as opcoes de cada filtro e, para cada consulta
// de tools/fase3/queries.json, a lista inteira de ids na ordem da grade (gridOf de browse/Catalog.jsx).
// Argumentos: <pasta de trabalho> <pasta app/> <queries.json> <saida.json>
import * as std from 'qjs:std';
import * as os from 'qjs:os';

let pumping = true;
const pump = () => { if (pumping) os.setTimeout(pump, 1); };
pump();

const [, fsDir, appDir, queriesFile, outFile] = scriptArgs;
globalThis.__MEM_FS = fsDir;
globalThis.__MEM_APP = appDir.endsWith('/') ? appDir : appDir + '/';
globalThis.__MEM_HTTP = async (url) => ({ status: 404, ok: false, url, headers: {}, text: async () => '', json: async () => ({}) });

const t0 = os.now();
const index = await import('../../app/data/catalog-index.js');
const catalog = await import('../../app/state/catalog.js');
const built = (os.now() - t0) / 1e3;
const { libraryCount } = await import('../../app/state/library-count.js');
const counter = libraryCount(); // o contador da loja: titulos e diretos de todas as listas
const { games } = index;
const { FACETS, NO_FILTERS, activeCount, filterGames, oneEach, sortGames, catalogEntries } = catalog;

// Os valores "@first"/"@second" de uma consulta: a 1a/2a opcao daquele filtro (na ordem do app).
const facetValues = Object.fromEntries(FACETS.map((facet) => [facet.key, facet.options.map((option) => option.value)]));
const resolve = (key, value) => value === '@first' ? facetValues[key][0] : value === '@second' ? facetValues[key][1] : value;

// browse/Catalog.jsx gridOf: sem filtro e sem busca, o catalogo inteiro; uma carta por jogo (oneEach), menos com
// plataforma escolhida ou busca (todas as copias).
function grid(query) {
  const filters = { ...NO_FILTERS };
  for (const facet of FACETS) if (query[facet.key]) filters[facet.key] = String(query[facet.key]).split(',').map((value) => resolve(facet.key, value));
  const q = query.q ?? '';
  const pool = activeCount(filters) === 0 && !q.trim() ? games : filterGames({ filters, query: q, wishlist: [] });
  const everyCopy = Boolean(filters.platform?.length || q.trim());
  const list = everyCopy ? sortGames(pool, query.sort) : oneEach(sortGames(pool, query.sort));
  const resolved = { ...query };
  for (const facet of FACETS) if (filters[facet.key].length) resolved[facet.key] = filters[facet.key].join(',');
  return { query: resolved, ids: list.map((game) => game.id) };
}

const queries = JSON.parse(std.loadFile(queriesFile));
const t1 = os.now();
const results = queries.map(grid);
const queryMs = (os.now() - t1) / 1e3;
const row = (game) => [game.id, game.title, game.platform, (game.formats ?? []).join(' '), game.direct ? 1 : 0, game.sizeGb ?? null,
  game.stars ?? null, game.ratingCount ?? null, (game.providers ?? []).join(','), (game.genres ?? []).join('|'), game.releaseDate ?? '',
  game.recommendations ?? null, game.metacritic ?? null, game.year ?? null, (game.features ?? []).join('|'), game.work ?? null];
const out = {
  engine: 'qjs 0.15 (app)',
  listed: games.length,
  direct: games.filter((game) => game.direct).length,
  entries: catalogEntries().length,
  counter,
  buildMs: Math.round(built),
  queryMs: Math.round(queryMs),
  facets: facetValues,
  games: games.map(row),
  results,
};
const file = std.open(outFile, 'w');
file.puts(JSON.stringify(out));
file.close();
pumping = false;
print(`DONE counter ${counter.titles}/${counter.direct} listed ${out.listed} direct ${out.direct} entries ${out.entries} build ${out.buildMs} ms queries ${out.queryMs} ms`);
std.exit(0);
