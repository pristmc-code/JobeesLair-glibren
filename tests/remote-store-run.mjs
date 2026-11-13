// Fase 4: uma abertura do app com um payload falso (um caso por processo: a loja e estado do modulo). Usado por
// tests/remote-store.test.mjs. Run: node --import ./tests/stub-loader.mjs tests/remote-store-run.mjs <caso>
globalThis.__jobeHoldCatalog = true;
const kase = process.argv[2];
const { FileSystem } = await import('@ps5-react/core');
const catalog = await import('../app/state/catalog.js');
const { games } = await import('../app/data/catalog-index.js');
const { createRemoteCatalog } = await import('../app/state/catalog-remote.js');
const { beginRemoteStore, remoteHome, remoteStoreState, remoteCounts } = await import('../app/state/remote-store.js');
const { storeEpoch } = await import('../app/state/store-mode.js');

const card = (id, extra = {}) => ({ id, title: `Jogo ${id}`, platform: 'ps5', formats: ['exfat'], ready: true, direct: true, sizeGb: 10, stars: 4.5, ratingCount: 300, year: 2024, releaseDate: '2024-01-01', cover: 'https://image.api.playstation.com/x.png?w=440', genres: ['Action'], metacritic: null, providers: ['archive.org'], platforms: ['ps5'], features: [], work: null, recommendations: 1, pos: 0, ...extra });
let broken = false;
const http = {
  async request(url) {
    const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
    const reply = (status, data) => ({ status, json: async () => data });
    if (kase === 'down') throw new Error('connection refused');
    if (path === '/health') return reply(200, { ok: true, api: kase === 'old' ? 36 : 37 });
    if (path === '/api/catalog/status') return reply(200, { ok: true, state: kase === 'overlimit' ? 'over-limit' : kase === 'notready' ? 'no-data' : 'ready', key: 'payload-t' });
    if (broken || kase === 'limit-later' && path.startsWith('/api/catalog?')) return reply(503, { ok: false, error: 'over-limit' });
    if (path.startsWith('/api/catalog/options')) return reply(200, { ok: true, platform: ['ps5', 'ps4'], format: ['ready', 'exfat'], access: ['direct'], genre: ['Action', 'RPG'], feature: ['Online'], release: ['recent', 'current', 'older'], size: ['small', 'medium', 'large'], provider: ['archive.org'], counts: { access: [{ value: 'direct', name: 'direct', count: 7 }] }, listed: 9, shown: 9, entries: 10 });
    if (path.startsWith('/api/catalog/home')) return reply(200, { ok: true, carousel: [{ ...card('C1'), art: { hero: 'https://h/1.jpg' }, summary: 'resumo' }], featured: [card('F1')], recent: [card('R1')], top: [], newWeek: [], newWeekCount: 0, ready: [card('Y1')], readyCount: 4, popular: [], cdn: [], genres: [{ genre: 'Action', count: 9, covers: [card('G1'), card('G2'), card('G3')] }] });
    if (path.startsWith('/api/catalog/cards')) return reply(200, { ok: true, games: [] });
    if (path.startsWith('/api/catalog?')) return reply(200, { ok: true, total: 1, games: [card('P1')] });
    return reply(404, { ok: false, error: 'not found' });
  },
};
const client = createRemoteCatalog({ http, readToken: () => 'a'.repeat(64), waitMs: 300, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
const out = { kase };
out.opened = await beginRemoteStore({ client, fs: FileSystem, platform: 'ps5', log: () => {} });
const snap = () => ({ remote: catalog.isRemoteCatalog(), local: catalog.isLocalCatalogBuilt(), ready: catalog.isCatalogReady(), games: games.length, home: Boolean(remoteHome()), state: remoteStoreState(), counts: remoteCounts(), epoch: storeEpoch(), genres: catalog.genres.length });
out.start = snap();
out.carousel = remoteHome()?.carousel?.[0]?.art?.hero ?? null;
out.getC1 = catalog.getGame('C1')?.title ?? null;
if (kase === 'drop') {
  broken = true;
  out.page = await client.page({ filters: catalog.NO_FILTERS, query: '', sort: 'relevance' }, 0);
}
if (kase === 'limit-later') out.page = await client.page({ filters: catalog.NO_FILTERS, query: '', sort: 'title' }, 0);
if (kase === 'torbox-later') await catalog.ensureLocalCatalog('torbox');
out.end = snap();
console.log(`RESULT ${JSON.stringify(out)}`);
process.exit(0);
