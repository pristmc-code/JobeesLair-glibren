// Fase 3 (prototipo B): o nucleo QuickJS sem tela. Importa o catalogo do app como ele e (state/catalog.js monta a loja ao
// carregar, de uma vez, fora do ps5-react) e responde /api/catalog com a grade de browse/Catalog.jsx (gridOf), paginada.
// O host C (tools/fase3/b_host.c) chama globalThis.__catalogRequest(caminho, consulta) e devolve o texto.
import { games } from '../../app/data/catalog-index.js';
import { FACETS, NO_FILTERS, activeCount, catalogBuildStats, catalogEntries, filterGames, oneEach, sortGames } from '../../app/state/catalog.js';

const H = globalThis.__host;
const SORT_IDS = ['relevance', 'newest', 'rating', 'size', 'title'];
const decode = (text) => { try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; } };
function parse(query) {
  const out = {};
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=');
    if (at > 0) out[decode(pair.slice(0, at))] = decode(pair.slice(at + 1));
  }
  return out;
}
// As ultimas listas montadas (a grade guarda as dela por pool e ordem; aqui por consulta): as paginas seguintes de uma
// consulta nao filtram e ordenam de novo.
const kept = new Map();
const KEEP = 8;
function grid(params) {
  const filters = { ...NO_FILTERS };
  for (const facet of FACETS) if (params[facet.key]) filters[facet.key] = params[facet.key].split(',');
  const q = params.q ?? '';
  const sort = SORT_IDS.includes(params.sort) ? params.sort : 'relevance';
  const key = JSON.stringify([filters, q, sort]);
  let list = kept.get(key);
  if (list) { kept.delete(key); kept.set(key, list); return { list, sort }; }
  const pool = activeCount(filters) === 0 && !q.trim() ? games : filterGames({ filters, query: q, wishlist: [] });
  const everyCopy = Boolean(filters.platform?.length || q.trim());
  list = everyCopy ? sortGames(pool, sort) : oneEach(sortGames(pool, sort));
  kept.set(key, list);
  if (kept.size > KEEP) kept.delete(kept.keys().next().value);
  return { list, sort };
}
const card = (game) => ({ id: game.id, title: game.title, platform: game.platform, formats: game.formats ?? [], direct: Boolean(game.direct),
  sizeGb: game.sizeGb ?? null, stars: game.ratingCount ? game.stars : null, ratingCount: game.ratingCount || null, cover: game.art?.cover ?? '' });

globalThis.__catalogRequest = (path, query) => {
  if (path === '/api/catalog/options') {
    const out = Object.fromEntries(FACETS.map((facet) => [facet.key, facet.options.map((option) => option.value)]));
    return JSON.stringify({ ...out, listed: games.length, entries: catalogEntries().length, build: catalogBuildStats() });
  }
  if (path !== '/api/catalog') return null;
  const params = parse(query);
  const per = Math.min(500, Math.max(1, Number(params.per) || 60));
  const page = Math.max(0, Number(params.page) || 0);
  const { list, sort } = grid(params);
  return JSON.stringify({ ok: true, sort, page, per, games: list.slice(page * per, page * per + per).map(card), total: list.length });
};
H.log(`catalog core: ${games.length} listed, ${catalogEntries().length} entries, build work ${catalogBuildStats().total} ms`);
