// Fase 4: a TV pedindo as paginas ao payload mostra a mesma loja que a montagem local do app. O payload de verdade
// (app/native/bg_downloader.c compilado para o PC, com o fixture da Fase 3) e o cliente da TV (app/state/catalog-remote.js,
// o mesmo que as telas usam) contra a referencia do app (tests/fixtures/fase3/reference.json.gz, o codigo do app no qjs):
//   - a grade (browse/Catalog.jsx) de cada consulta, pagina por pagina como a tela pede (48 por vez): mesma ordem e total;
//   - as contagens dos filtros (browse/FilterDrawer.jsx);
//   - a tela Procurar (search/index.jsx), pagina por pagina;
//   - a pagina inicial (browse/Lanes.jsx, featured.js, PopularRail.jsx, CdnRail.jsx) e a fileira de generos (GenreRail.jsx:
//     a contagem de cada genero = a do filtro, 3 capas, os com mais jogos primeiro);
//   - as fichas (links como game.releases, edicoes, relacionados) e as cartas pelo codigo (/cards);
//   - os Favoritos: as cartas filtradas e ordenadas no app (state/catalog.js) dao a ordem da montagem local, nas 5 ordens.
// Nas variantes ps5 e firmware 9.60. Run: node --import ./tests/stub-loader.mjs --test tests/fase4-tela.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { freePortFrom } from './free-port.mjs';
import { compileTo } from './payload-build.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const skip = !compiler ? 'no C compiler' : false;
const ports = freePortFrom(11); // Fase 4: bloco de portas so deste arquivo (tests/free-port.mjs)
const { startPayload } = await import('../tools/fase3/parity.mjs');
const { createRemoteCatalog, PAGE } = await import('../app/state/catalog-remote.js');
const { filterList, oneEach, sortGames, NO_FILTERS } = await import('../app/state/catalog.js');
const refs = JSON.parse(gunzipSync(readFileSync(path.join(repo, 'tests/fixtures/fase3/reference.json.gz'))).toString('utf8'));
// O motor do PS5 (QuickJS-ng 0.15) compara textos assim no localeCompare: NFC e code points, sem idioma (PROTOTIPO-fase3).
// O Node usa o ICU; para os Favoritos ordenados no app darem a ordem do console, o teste usa a regra do QuickJS.
String.prototype.localeCompare = function (other) {
  const a = [...String(this).normalize('NFC')].map((ch) => ch.codePointAt(0)), b = [...String(other).normalize('NFC')].map((ch) => ch.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};
const canonical = (value) => JSON.stringify(value, (key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);

// A consulta da referencia ({name, sort, platform: "ps5,ps4", q, ...}) como a vista da tela (store.filters/query/sort).
function viewOf(query) {
  const filters = { ...NO_FILTERS };
  for (const [key, value] of Object.entries(query)) if (!['name', 'sort', 'q'].includes(key)) filters[key] = String(value).split(',');
  return { filters, query: query.q ?? '', sort: query.sort ?? 'relevance' };
}
// Todas as paginas como a tela pede (a proxima quando a lista chega ao fim).
async function allPages(client, view, route = '') {
  const ids = [];
  let total = Infinity, asked = 0;
  while (ids.length < total) {
    const page = await client.page(view, ids.length, route);
    assert.ok(page, `pagina ${ids.length} de ${JSON.stringify(view)} (${client.status().reason})`);
    total = page.total;
    if (!page.games.length) break;
    assert.ok(page.games.length <= PAGE);
    ids.push(...page.games.map((game) => game.id));
    asked++;
  }
  return { ids, total, asked };
}

async function checkVariant(binary, variant) {
  const ref = refs[variant];
  const work = mkdtempSync(path.join(os.tmpdir(), 'jl-fase4-'));
  const p = await startPayload(binary, work, variant, ports);
  const token = readFileSync(path.join(p.base, 'state/token'), 'utf8').trim();
  const http = { async request(url, { method, headers }) { const res = await fetch(url, { method, headers }); return { status: res.status, json: () => res.json() }; } };
  const client = createRemoteCatalog({ http, readToken: () => token, port: p.api });
  const problems = [];
  try {
    assert.equal(await client.probe(), true, `sonda: ${client.status().reason}`);
    // a grade
    for (const { query, ids } of ref.results) {
      const mine = await allPages(client, viewOf(query));
      if (canonical(mine.ids) !== canonical(ids) || mine.total !== ids.length) problems.push(`grade ${query.name}: ${mine.ids.length}/${mine.total} x ${ids.length}`);
    }
    // as contagens dos filtros
    for (const { query, counts } of ref.counts) {
      const options = await client.options(viewOf(query));
      for (const [key, values] of Object.entries(counts)) {
        const mine = Object.fromEntries((options.counts?.[key] ?? []).map(({ value, count }) => [value, count]));
        if (canonical(mine) !== canonical(values)) problems.push(`contagens ${query.name ?? query.sort} ${key}`);
      }
    }
    // a tela Procurar
    for (const { query, ids } of ref.search ?? []) {
      const mine = await allPages(client, viewOf(query), 'search');
      if (canonical(mine.ids) !== canonical(ids)) problems.push(`busca ${JSON.stringify(query)}: ${mine.ids.length} x ${ids.length}`);
    }
    // a pagina inicial
    for (const rows of ref.home ?? []) {
      const home = await client.home(rows.seed, rows.today);
      for (const key of ['carousel', 'featured', 'recent', 'top', 'newWeek', 'ready', 'popular', 'cdn']) {
        if (canonical(home[key].map((game) => game.id)) !== canonical(rows[key])) problems.push(`inicio ${key}`);
      }
      if (home.newWeekCount !== rows.newWeekCount || home.readyCount !== rows.readyCount) problems.push('inicio contagens');
      // o carrossel e Destaques com a arte (cartas largas): todo jogo deles tem banner
      for (const game of [...home.carousel, ...home.featured]) if (!game.art.hero) problems.push(`inicio sem banner: ${game.id}`);
      for (const game of home.carousel) if (typeof game.summary !== 'string') problems.push(`carrossel sem resumo: ${game.id}`);
      // GenreRail: contagem = a do filtro de genero sem filtros; 3 capas; mais jogos primeiro
      const genreCounts = Object.fromEntries((await client.options({ filters: NO_FILTERS, sort: 'relevance' })).counts.genre.map(({ value, count }) => [value, count]));
      let last = Infinity;
      for (const { genre, count, covers } of home.genres) {
        if (count !== genreCounts[genre]) problems.push(`genero ${genre}: ${count} x ${genreCounts[genre]}`);
        if (count < 3 || covers.length !== 3 || count > last) problems.push(`genero ${genre}: ${count} jogos, ${covers.length} capas`);
        last = count;
      }
      if (!home.genres.length) problems.push('sem fileira de generos');
    }
    // as fichas
    for (const ficha of ref.fichas ?? []) {
      const game = await client.game(ficha.id);
      if (!game || game.notFound) { problems.push(`ficha ${ficha.id}: ${client.status().reason}`); continue; }
      if (canonical(game.releases) !== canonical(ficha.releases)) problems.push(`ficha ${ficha.id} links`);
      if (canonical(game.editionList.map((e) => e.id)) !== canonical(ficha.editions)) problems.push(`ficha ${ficha.id} edicoes`);
      if (canonical(game.related.map((g) => g.id)) !== canonical(ficha.related)) problems.push(`ficha ${ficha.id} relacionados`);
      if (!Array.isArray(game.about) || !Array.isArray(game.shots) || typeof game.art?.cover !== 'string') problems.push(`ficha ${ficha.id} pagina/arte`);
      if (client.lookup(ficha.id) !== game) problems.push(`ficha ${ficha.id} nao achada pelo getGame`);
    }
    // as cartas pelo codigo e os Favoritos
    const byRelevance = ref.results.find((r) => r.query.name === 'relevance').ids;
    const wishlist = byRelevance.filter((_, i) => i % 7 === 0).slice(0, 150);
    const cards = await client.cards([...wishlist, 'NAO-EXISTE']);
    if (canonical(cards.map((g) => g.id)) !== canonical(wishlist)) problems.push(`cartas: ${cards.length} x ${wishlist.length}`);
    for (const sort of ['relevance', 'newest', 'rating', 'size', 'title']) {
      // a ordem esperada: todas as copias na ordem (a grade com as duas plataformas lista todas; a de "newest" e conferida com
      // a referencia acima) so com os favoritos. A de relevancia (uma por jogo) e a propria referencia.
      const every = sort === 'relevance' ? ref.results.find((r) => r.query.name === 'relevance').ids : (await allPages(client, { filters: { ...NO_FILTERS, platform: ['ps5', 'ps4'] }, query: '', sort })).ids;
      const expected = every.filter((id) => wishlist.includes(id));
      const list = oneEach(sortGames(filterList([...cards].sort((a, b) => a.pos - b.pos), { filters: { ...NO_FILTERS, wishlist: true }, query: '', wishlist }), sort));
      if (canonical(list.map((g) => g.id)) !== canonical(expected)) {
        const at = expected.findIndex((id, i) => list[i]?.id !== id);
        problems.push(`favoritos ${sort}: 1a diferenca em ${at}: ${list.slice(at, at + 2).map((g) => g.id)} x ${expected.slice(at, at + 2)}`);
      }
    }
    assert.equal(client.on(), true, `ligado ate o fim (${client.status().reason})`);
    const status = client.status();
    assert.ok(status.keptPages <= 8 && status.keptGames <= 16 && status.keptCards <= 400, JSON.stringify(status));
    return { problems, status };
  } finally {
    p.child.kill('SIGTERM');
    await new Promise((resolve) => p.child.exitCode !== null ? resolve() : p.child.once('exit', resolve));
    rmSync(work, { recursive: true, force: true });
  }
}

test('a TV pelo payload mostra a mesma loja que a montagem local (ps5 e firmware 9.60)', { skip, timeout: 900000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-fase4-bin-'));
  try {
    const binary = path.join(dir, 'bgdl');
    const built = compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
    assert.equal(built.status, 0, built.stderr.slice(0, 2000));
    for (const variant of ['ps5', 'low']) {
      const { problems, status } = await checkVariant(binary, variant);
      assert.deepEqual(problems.slice(0, 30), [], `${variant}: ${problems.length} diferencas`);
      console.log(`${variant}: ${status.requests} pedidos, ${status.hits} do cache`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
