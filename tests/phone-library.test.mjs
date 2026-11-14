// glibren: a Biblioteca TorBox na pagina do celular, do lado do app: um pedido feito no celular (o payload o mostra no
// GET /jobs com "library") entra na fila como um arquivo do "Procurar no TorBox" (state/phone-library.js), e o
// background-downloads.js le os pedidos, os poe na fila e os devolve ao payload (forget, ou refuse com o motivo).
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const { libraryFile, libraryGame, queueLibraryRequest, queueStoreRequest } = await load('app/state/phone-library.js');
const { setDefaultDrive } = await load('app/state/last-drive.js');
const { createBackgroundDownloads } = await load('app/state/background-downloads.js');

const HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const REQUEST = { id: 'g3', hash: HASH.toUpperCase(), file: 'Sifu/PPSA05132 sifu.exfat', code: 'ppsa05132', platform: 'ps5', whole: false, title: 'Sifu', size: 10e9 };
const fakeQueue = () => {
  const queued = [];
  return { queued, enqueue(game, release, root, alternatives) { queued.push({ game, release, root, alternatives }); return `${game.id}/${release.id}`; } };
};

test('phone-library: o pedido vira um arquivo TorBox do torrent (pelo hash), no disco padrao, com o jogo do catalogo', () => {
  setDefaultDrive('/mnt/ext0');
  const queue = fakeQueue();
  const catalog = { id: 'PPSA05132', title: 'Sifu (catalogo)', releases: [] };
  const id = queueLibraryRequest(REQUEST, { queue, roots: ['/data', '/mnt/ext0'], getGame: (code) => code === 'PPSA05132' ? catalog : null });
  const [{ game, release, root, alternatives }] = queue.queued;
  assert.equal(game, catalog, 'o jogo do catalogo, pelo codigo');
  assert.equal(root, '/mnt/ext0', 'o disco padrao das Configuracoes');
  assert.deepEqual(alternatives, []);
  assert.equal(release.url, `magnet:?xt=urn:btih:${HASH}`);
  assert.equal(release.filename, 'PPSA05132 sifu.exfat');
  assert.equal(release.format, 'exfat');
  assert.equal(release.sizeBytes, 10e9);
  assert.deepEqual([release.provider, release.flow, release.debrid], ['TorBox', 'debrid', { service: 'torbox' }]);
  assert.equal(release.id, `torbox-torrent-${HASH}-PPSA05132-sifu-exfat`);
  assert.equal(id, `PPSA05132/${release.id}`);
  // Disco padrao que nao esta ligado: o primeiro da lista (como o "Procurar no TorBox").
  const other = fakeQueue();
  queueLibraryRequest(REQUEST, { queue: other, roots: ['/data'], getGame: () => null });
  assert.equal(other.queued[0].root, '/data');
  assert.deepEqual(other.queued[0].game, { id: 'PPSA05132', titleId: 'PPSA05132', title: 'Sifu', releases: [] }, 'fora do catalogo: titulo e codigo da lista');
  setDefaultDrive(null);
});

test('phone-library: o torrent inteiro vira um zip; sem codigo, um id pelo hash; sem hash, recusado', () => {
  const whole = libraryFile({ ...REQUEST, whole: true, file: '' });
  assert.deepEqual([whole.whole, whole.fileId, whole.name], [true, 'all', 'Sifu']);
  const queue = fakeQueue();
  queueLibraryRequest({ ...REQUEST, whole: true, file: '', code: '' }, { queue, roots: ['/data'] });
  const { game, release } = queue.queued[0];
  assert.equal(game.id, `torbox-${HASH.slice(0, 12)}`);
  assert.equal(release.filename, 'Sifu.zip');
  assert.equal(release.torboxZip, true);
  assert.equal(release.url, `magnet:?xt=urn:btih:${HASH}&x.glibren=all`);
  assert.equal(libraryGame({ title: 'X', code: 'NADA', hash: HASH }).id, `torbox-${HASH.slice(0, 12)}`);
  assert.throws(() => queueLibraryRequest({ ...REQUEST, hash: 'xyz' }, { queue, roots: ['/data'] }), /no torrent hash/);
  assert.throws(() => queueLibraryRequest(REQUEST, { roots: ['/data'] }), /queue is not ready/);
});

test('phone-library: arquivo da conta TorBox (item + arquivo) e link do catalogo (webdl, pela fonte do jogo)', () => {
  const queue = fakeQueue();
  queueLibraryRequest({ ...REQUEST, via: 'account', item: { kind: 'torrent', id: '77' }, fileId: '6', file: 'Sifu/b.pkg' }, { queue, roots: ['/data'], getGame: () => null });
  const account = queue.queued[0].release;
  assert.deepEqual([account.url, account.id, account.filename], ['https://torbox.app/torrents/77', 'torbox-torrent-77-6', 'b.pkg']);
  const whole = libraryFile({ via: 'account', item: { kind: 'torrent', id: '77' }, whole: true, title: 'Sifu' });
  assert.deepEqual([whole.origin, whole.whole, whole.fileId], ['account', true, 'all']);
  assert.throws(() => libraryFile({ via: 'account', item: {}, file: 'x' }), /no account item/);
  const catalog = { id: 'PPSA05132', title: 'Sifu', releases: [{ id: 'rel-1', url: 'https://1fichier.com/?abc', filename: 'Sifu.exfat', format: 'exfat', sizeBytes: 9e9, provider: '1fichier.com' }] };
  const web = libraryFile({ via: 'webdl', release: 'rel-1', hash: 'a'.repeat(32), file: 'Sifu.exfat', size: 9e9 }, catalog);
  assert.deepEqual([web.origin, web.link, web.release.id, web.name, web.host], ['catalog', 'https://1fichier.com/?abc', 'rel-1', 'Sifu.exfat', '1fichier.com']);
  assert.throws(() => queueLibraryRequest({ ...REQUEST, via: 'webdl', release: 'nao-tem' }, { queue, roots: ['/data'], getGame: () => catalog }), /not in the catalog/);
});

test('background-downloads: pedidos do celular vao para a fila e saem do payload (forget); recusados voltam com o motivo (refuse)', async () => {
  const TOKEN = 'a'.repeat(64);
  const calls = [];
  const jobs = [
    { id: 'b1', placeholder: true, state: 'waiting-app', name: 'Sifu', total: 10e9, library: { id: 'g1', hash: HASH, file: 'Sifu/a.exfat', code: 'PPSA05132', platform: 'ps5', whole: false, size: 10e9 } },
    { id: 'b2', placeholder: true, state: 'waiting-app', name: 'Sem espaco', total: 90e9, library: { id: 'g2', hash: HASH, file: '', code: '', platform: 'ps4', whole: true, size: 90e9 } },
    { id: 'b3', placeholder: true, state: 'paused', name: 'Pausado', library: { id: 'g3', hash: HASH } },
    { id: 'b4', placeholder: true, state: 'waiting-app', name: 'Da fila do app' }
  ];
  const http = {
    async request(url, { method = 'GET', body } = {}) {
      const route = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
      calls.push([method, route, body ? JSON.parse(body) : undefined]);
      const data = route === '/jobs' ? { jobs } : { ok: true };
      return { status: 200, json: async () => data };
    }
  };
  const asked = [];
  const wrapper = createBackgroundDownloads({
    downloads: { enqueue() {}, setRateLimit() {} }, http, fs: { readFile: () => TOKEN }, platform: 'ps5', on: () => true, log: () => {},
    requestsMs: 0,
    onLibraryRequest: async (request) => { asked.push(request); if (request.id === 'g2') throw new Error('Not enough space on /mnt/ext0'); }
  });
  assert.equal(await wrapper.adoptRequests(), 1);
  assert.deepEqual(asked.map((request) => [request.id, request.title, request.size, request.file, request.whole]), [['g1', 'Sifu', 10e9, 'Sifu/a.exfat', false], ['g2', 'Sem espaco', 90e9, '', true]], 'so os que esperam o app, com o titulo e o tamanho');
  assert.deepEqual(calls.filter(([method]) => method === 'POST'), [['POST', '/jobs/b1/forget', undefined], ['POST', '/jobs/b2/refuse', { error: 'Not enough space on /mnt/ext0' }]]);
  // Sem a funcao (outro app, testes antigos): nada e lido.
  const quiet = createBackgroundDownloads({ downloads: { enqueue() {}, setRateLimit() {} }, http, fs: { readFile: () => TOKEN }, platform: 'ps5', on: () => true, log: () => {} });
  calls.length = 0;
  assert.equal(await quiet.adoptRequests(), 0);
  assert.deepEqual(calls, []);
});

test('glibren (item 2): pedido da Loja completa vai como o Baixar da ficha; o comecado pelo payload, com a mesma fonte e o disco padrao', () => {
  setDefaultDrive('/mnt/ext0');
  const calls = [];
  const start = (game, source, options) => { calls.push({ game, source, options }); return { id: `${game.id}/x` }; };
  const game = { id: 'PPSA01001', title: 'Jogo', releases: [] };
  const getGame = (id) => id === 'PPSA01001' ? game : null;
  const roots = ['/data', '/mnt/ext0'];
  // O marcador (Jobe aberta, ou sem link solo): a Jobe escolhe a fonte e o disco, como na ficha.
  assert.equal(queueStoreRequest({ store: 'ppsa01001', source: -1, autoStarted: false }, { start, getGame, roots }), 'PPSA01001/x');
  assert.deepEqual([calls[0].game, calls[0].source, calls[0].options], [game, null, {}]);
  // Comecado pelo payload com a Jobe fechada: a fonte dele e o disco padrao (o mesmo destino: a fila acha a parcial).
  queueStoreRequest({ store: 'PPSA01001', source: 3, autoStarted: true }, { start, getGame, roots });
  assert.deepEqual([calls[1].source, calls[1].options], [3, { root: '/mnt/ext0' }]);
  // glibren.55: a fonte escolhida na /app (marcador com source): ela mesma, pelo TorBox quando ele aceita (preferDebrid).
  queueStoreRequest({ store: 'PPSA01001', source: 2, autoStarted: false }, { start, getGame, roots });
  assert.deepEqual([calls[2].source, calls[2].options], [2, { preferDebrid: true }]);
  assert.throws(() => queueStoreRequest({ store: 'PPSA09999' }, { start, getGame, roots }), /not in the store/);
  assert.throws(() => queueStoreRequest({ store: 'x' }, { start, getGame, roots }), /not in the store/);
  assert.throws(() => queueStoreRequest({ store: 'PPSA01001' }, { getGame, roots }), /not ready/);
});
