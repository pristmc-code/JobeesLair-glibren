// Fase 4: o cliente do catalogo do payload na TV (app/state/catalog-remote.js), com um payload falso: liga so com
// BG_API >= 36 e catalogo "ready"; fallback com payload parado, antigo, 503 over-limit, no-data demorado e erro depois de
// ligado; cache pequeno (paginas e fichas com limite); Favoritos ficam no caminho local.
// Run: node --import ./tests/stub-loader.mjs --test tests/catalog-remote.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const { createRemoteCatalog, remoteQuery, cardToGame, KEPT_PAGES, KEPT_GAMES, PAGE } = await import('../app/state/catalog-remote.js');

function fakePayload({ api = 37, state = 'ready', down = false, routes = true, fail = null } = {}) {
  const seen = [];
  const http = {
    async request(url, options) {
      const path = url.replace('http://127.0.0.1:34200', '');
      seen.push(path);
      assert.equal(options.headers['X-Jobe-Token'], 't'.repeat(64));
      if (down) throw new Error('connection refused');
      const reply = (status, data) => ({ status, json: async () => data });
      if (fail && fail(path)) return fail(path);
      if (path === '/health') return reply(200, { ok: true, api });
      if (!routes) return reply(404, { ok: false, error: 'not found' });
      if (path === '/api/catalog/status') return reply(200, { ok: true, state: typeof state === 'function' ? state() : state, key: 'payload-abc' });
      if (path.startsWith('/api/catalog?')) {
        const q = new URLSearchParams(path.split('?')[1]);
        const offset = Number(q.get('offset'));
        return reply(200, { ok: true, total: 100, games: Array.from({ length: Math.min(Number(q.get('limit')), 100 - offset) }, (_, i) => ({ id: `G${offset + i}`, title: `T${offset + i}`, platform: 'ps5', formats: ['exfat'], ready: true, direct: false, sizeGb: 1.5, stars: 4.5, ratingCount: 10, cover: 'https://x/c.png', genres: ['Action'] })) });
      }
      if (path.startsWith('/api/catalog/game?id=NOPE')) return reply(404, { ok: false, error: 'not-found' });
      if (path.startsWith('/api/catalog/game')) return reply(200, { ok: true, game: { id: path.split('=')[1] } });
      if (path.startsWith('/api/catalog/options')) return reply(200, { ok: true, facets: [] });
      return reply(404, { ok: false });
    },
  };
  return { http, seen };
}
const make = (payload, extra = {}) => {
  let clock = 0;
  return createRemoteCatalog({ http: payload.http, readToken: () => 't'.repeat(64), now: () => clock, sleep: async (ms) => { clock += ms; }, ...extra });
};

test('liga com BG_API 37 e catalogo pronto', async () => {
  const p = fakePayload();
  const c = make(p);
  assert.equal(await c.probe(), true);
  assert.equal(c.on(), true);
  assert.equal(c.status().key, 'payload-abc');
});

test('fallback: payload parado, sem token, antigo (36), sem as rotas', async () => {
  for (const [payload, extra, why] of [
    [fakePayload({ down: true }), {}, 'no-payload'],
    [fakePayload(), { readToken: () => '' }, 'no-payload'],
    [fakePayload({ api: 36 }), {}, 'old-api'],
    [fakePayload({ routes: false }), {}, 'old-api'],
  ]) {
    const c = make(payload, extra);
    const events = [];
    c.listen((on, r) => events.push([on, r]));
    assert.equal(await c.probe(), false, why);
    assert.equal(c.status().reason, why);
    assert.deepEqual(events, [[false, why]]);
    assert.equal(await c.page({ sort: 'title' }), null, 'desligado: caminho local');
  }
});

test('fallback: over-limit na sonda e 503 over-limit depois de ligado', async () => {
  const c1 = make(fakePayload({ state: 'over-limit' }));
  assert.equal(await c1.probe(), false);
  assert.equal(c1.status().reason, 'over-limit');
  let limit = false;
  const p = fakePayload({ fail: (path) => limit && path.startsWith('/api/catalog?') ? { status: 503, json: async () => ({ ok: false, error: 'over-limit' }) } : null });
  const c2 = make(p);
  assert.equal(await c2.probe(), true);
  assert.ok(await c2.page({ sort: 'title' }, 0));
  limit = true;
  assert.equal(await c2.page({ sort: 'title' }, PAGE), null);
  assert.equal(c2.on(), false);
  assert.equal(c2.status().reason, 'over-limit');
});

test('sonda espera o catalogo montar (no-data -> ready) e desiste depois do prazo', async () => {
  let n = 0;
  const c = make(fakePayload({ state: () => (++n < 3 ? 'no-data' : 'ready') }));
  assert.equal(await c.probe(), true);
  const never = make(fakePayload({ state: 'building' }));
  assert.equal(await never.probe(), false);
  assert.equal(never.status().reason, 'not-ready');
});

test('erro de rede depois de ligado desliga de vez nesta abertura', async () => {
  let broken = false;
  const p = fakePayload({ fail: (path) => broken && path !== '/health' ? (() => { throw new Error('reset'); })() : null });
  const c = make(p);
  assert.equal(await c.probe(), true);
  broken = true;
  assert.equal(await c.game('X'), null);
  assert.equal(c.on(), false);
  broken = false;
  assert.equal(await c.probe(), false, 'nao religa sozinho');
});

test('paginas e fichas com cache pequeno (LRU)', async () => {
  const p = fakePayload();
  const c = make(p);
  await c.probe();
  const first = await c.page({ sort: 'title' }, 0);
  assert.equal(first.games.length, PAGE);
  assert.equal(first.total, 100);
  assert.equal(first.games[0].art.cover, 'https://x/c.png');
  const before = p.seen.length;
  assert.equal(await c.page({ sort: 'title' }, 0), first, 'mesma pagina vem do cache');
  assert.equal(p.seen.length, before);
  for (let i = 0; i < KEPT_PAGES + 4; i++) await c.page({ sort: 'title', query: `q${i}` }, 0);
  assert.equal(c.status().keptPages, KEPT_PAGES);
  for (let i = 0; i < KEPT_GAMES + 5; i++) await c.game(`G${i}`);
  assert.equal(c.status().keptGames, KEPT_GAMES);
  assert.deepEqual(await c.game('NOPE'), { notFound: true });
  assert.equal(c.on(), true, 'ficha desconhecida nao desliga');
});

test('consulta: filtros do app -> parametros do payload; Favoritos ficam locais', () => {
  assert.equal(remoteQuery({ sort: 'title', filters: { platform: ['ps5', 'ps4'], genre: ['Action'], wishlist: false }, query: ' Final Fantasy ' }),
    'sort=title&platform=ps5%2Cps4&genre=Action&q=%20Final%20Fantasy%20');
  assert.equal(remoteQuery({ sort: 'relevance', filters: { wishlist: true } }), null);
  assert.equal(remoteQuery({}), 'sort=relevance');
  const g = cardToGame({ id: 'A', title: 'B', platform: 'ps4', stars: null, cover: '' });
  assert.equal(g.stars, undefined);
  assert.equal(g.ratingCount, undefined);
  assert.equal(g.metacritic, undefined);
  assert.equal(g.releaseDate, '');
  assert.deepEqual(g.providers, []);
  assert.deepEqual(g.genres, []);
});
