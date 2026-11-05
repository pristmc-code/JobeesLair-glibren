// glibren.6: "Search TorBox" (state/torbox-search.js) against a fake TorBox client: the game's files from the account,
// the catalog's links and the search API, matched by code and by name, .exfat first; each file as the download the
// queue gets (a TorBox source whose item and file are kept, so its link can be renewed); and the default drive
// (state/last-drive.js). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const search = await load('app/state/torbox-search.js');
const { md5 } = await load('app/services/torbox.js');
const debrid = await load('app/state/debrid.js');
const { startingDrive } = await load('app/state/last-drive.js');

const GAME = { id: 'PPSA05132', title: 'Sifu', releases: [
  { id: 'r1', url: 'https://archive.org/download/sifu/PPSA05132 sifu.ffpfsc', filename: 'PPSA05132 sifu.ffpfsc', format: 'ffpfsc', sizeBytes: 10e9, provider: 'Archive.org' },
  { id: 'r2', url: 'https://1fichier.com/?g33gctfci18h2jg6syy2', browserUrl: 'https://1fichier.com/?g33gctfci18h2jg6syy2', filename: 'PPSA05132-game-unknown.binary', format: 'binary', provider: '1fichier.com', requiresBrowser: true, archivePassword: 'DLPSGAME.COM' },
  { id: 'r3', url: 'https://vikingfile.com/f/none', filename: 'x.exfat', provider: 'VikingFile', parts: [{ sources: [] }] }
] };
const MAGNET = 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=Sifu';

function fakeClient({ searchFails = false } = {}) {
  const asked = [];
  return {
    asked,
    async myList(kind) {
      asked.push(`myList ${kind}`);
      if (kind === 'torrent') return [];
      return [
        { id: 2178351, name: 'PPSA05132.exfat', size: 21e9, download_finished: true, files: [{ id: 0, name: 'PPSA05132.exfat/PPSA05132.exfat', short_name: 'PPSA05132.exfat', size: 21e9 }] },
        { id: 99, name: 'Other Game PPSA00001.exfat', size: 5e9, download_finished: true, files: [{ id: 0, name: 'Other Game PPSA00001.exfat', size: 5e9 }] },
        { id: 100, name: 'Sifu Deluxe [PS5]', size: 22e9, download_finished: true, files: [{ id: 4, name: 'Sifu Deluxe/readme.txt', size: 900 }, { id: 5, name: 'Sifu Deluxe/sifu.part1.rar', size: 11e9 }, { id: 6, name: 'Sifu Deluxe/sifu.pkg', size: 9e9 }] }
      ];
    },
    async cachedEntries(links) {
      asked.push(`cachedEntries ${links.length}`);
      const held = new Map();
      for (const link of links) {
        if (link.includes('archive.org')) held.set(link, { name: 'PPSA05132 sifu.ffpfsc', size: 10e9, files: [{ id: 0, name: 'PPSA05132 sifu.ffpfsc', size: 10e9 }] });
        if (link.includes('1fichier')) held.set(link, { name: 'PPSA05132v1 024 000 PS5-[DLPSGAME.COM].rar', size: 20e9, files: [{ id: 0, name: 'PPSA05132v1 024 000 PS5-[DLPSGAME.COM].rar', size: 20e9 }] });
        if (link === MAGNET) held.set(link, { name: 'Sifu', size: 21e9, files: [{ id: 1, name: 'Sifu/PPSA05132-sifu.exfat', size: 21e9 }] });
      }
      return held;
    },
    async searchTorrents(text) {
      asked.push(`search ${text}`);
      if (searchFails) throw Object.assign(new Error("TorBox didn't answer"), { code: 'NETWORK' });
      return [{ hash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a', title: 'Sifu PS5 PPSA05132', magnet: MAGNET, size: 21e9, seeders: 9 }, { hash: 'ff', title: 'Unrelated Movie 2024', magnet: 'magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff', size: 1e9, seeders: 1 }];
    }
  };
}

test('a game is matched by its code (PPSA-05132, PPSA_05132 too) or by every word of its name', () => {
  assert.ok(search.matchesGame('PPSA05132.exfat', GAME));
  assert.ok(search.matchesGame('[X] PPSA-05132 v1.24.rar', GAME));
  assert.ok(search.matchesGame('Sifu Deluxe [PS5]', GAME));
  assert.ok(!search.matchesGame('PPSA05133.exfat', GAME));
  assert.ok(!search.matchesGame('Sifuxyz.exfat', GAME), 'a whole word, not a piece of one');
  const yakuza = { id: 'PPSA02384', title: 'Yakuza: Like A Dragon' };
  assert.ok(search.matchesGame('Yakuza.Like.a.Dragon.PS5.exfat', yakuza));
  assert.ok(!search.matchesGame('Yakuza 0.exfat', yakuza));
  assert.deepEqual(search.searchTexts(yakuza), ['PPSA02384', 'yakuza like dragon']);
});

test('the account, the catalog and the search, as one list: .exfat first, pieces of a split archive last, nothing twice', async () => {
  const api = fakeClient();
  const updates = [];
  const { files, sources } = await search.searchTorBox(GAME, { api, onUpdate: (update) => updates.push(update) });
  assert.deepEqual(files.map((file) => [file.origin, file.type, file.name]), [
    ['account', 'EXFAT', 'PPSA05132.exfat'],
    ['search', 'EXFAT', 'PPSA05132-sifu.exfat'],
    ['catalog', 'FFPFSC', 'PPSA05132 sifu.ffpfsc'],
    ['account', 'PKG', 'sifu.pkg'],
    ['catalog', 'RAR', 'PPSA05132v1 024 000 PS5-[DLPSGAME.COM].rar'],
    ['account', 'RAR', 'sifu.part1.rar']
  ]);
  assert.ok(files.at(-1).piece, 'a .part1.rar is one piece of a set');
  assert.deepEqual(Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, value.state])), { account: 'done', catalog: 'done', search: 'done' });
  assert.equal(updates.length, 3, 'one update per part');
  assert.ok(api.asked.includes('cachedEntries 2'), 'the two single-file links of the catalog; the set in parts is left out');
  assert.ok(api.asked.includes('search PPSA05132') && api.asked.includes('search sifu'));
});

test('the search API not answering only says so: the account and the catalog still come back', async () => {
  const { files, sources } = await search.searchTorBox(GAME, { api: fakeClient({ searchFails: true }) });
  assert.equal(sources.search.state, 'unavailable');
  assert.ok(files.length >= 4 && files.every((file) => file.origin !== 'search'));
});

test('a file picked is a TorBox download: its item and file kept for the resolver, the renewal and the payload', async () => {
  const { files } = await search.searchTorBox(GAME, { api: fakeClient() });
  // An account file: its own address stands for the link, and TorBox's item and file are kept under its hash.
  const account = search.releaseFor(files[0]);
  assert.equal(account.debrid.service, 'torbox');
  assert.equal(account.url, 'https://torbox.app/webdl/2178351');
  assert.equal(account.filename, 'PPSA05132.exfat');
  assert.equal(account.format, 'exfat');
  assert.equal(account.sizeBytes, 21e9);
  assert.deepEqual(debrid.debridHandoff(account), { provider: 'torbox', kind: 'webdl', id: 2178351, fileId: 0, zip: false });
  // A catalog link: the catalog's source through TorBox, named as TorBox names the file (so the queue routes it).
  const rar = search.releaseFor(files.find((file) => file.origin === 'catalog' && file.format === 'rar'));
  assert.equal(rar.debrid.service, 'torbox');
  assert.equal(rar.url, GAME.releases[1].url);
  assert.equal(rar.filename, 'PPSA05132v1 024 000 PS5-[DLPSGAME.COM].rar');
  assert.equal(rar.format, 'rar');
  assert.equal(rar.archivePassword, 'DLPSGAME.COM', 'the catalog\'s password goes with it');
  // A search result: the magnet, through TorBox.
  const torrent = search.releaseFor(files.find((file) => file.origin === 'search'));
  assert.equal(torrent.url, MAGNET);
  assert.equal(torrent.filename, 'PPSA05132-sifu.exfat');
  assert.match(torrent.id, /^torbox-torrent-c12fe1c06bba254a9dc9f519b335aa7c1367a88a-1$/);
  assert.ok(md5(account.url));
});

test('a file is queued as it is, on the drive given; a piece of a split archive is refused before the queue', async () => {
  const { files } = await search.searchTorBox(GAME, { api: fakeClient() });
  const queued = [];
  const queue = { enqueue: (game, release, root, alternatives) => (queued.push({ game: game.id, release, root, alternatives }), `${game.id}/${release.id}`) };
  assert.equal(search.downloadFile(queue, GAME, files[0], '/mnt/ext0'), 'PPSA05132/torbox-webdl-2178351-0');
  assert.deepEqual([queued[0].root, queued[0].alternatives, queued[0].release.filename], ['/mnt/ext0', [], 'PPSA05132.exfat']);
  assert.throws(() => search.downloadFile(queue, GAME, files.find((file) => file.piece), '/data'), /split archive/);
  assert.equal(queued.length, 1);
});

test('the default drive goes first while it is there and fits; Automatic is the last drive used', () => {
  const roots = ['/data', '/mnt/ext0', '/mnt/usb0'];
  assert.equal(startingDrive(roots, () => true, '/mnt/usb0'), 2);
  assert.equal(startingDrive(roots, (root) => root !== '/mnt/usb0', '/mnt/usb0'), 0, 'no room there: the first that fits');
  assert.equal(startingDrive(roots, () => true, '/mnt/usb9'), 0, 'not plugged in: the first');
});
