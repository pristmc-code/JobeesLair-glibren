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
  const { files, sources } = await search.searchTorBox(GAME, { textSearch: true, api, onUpdate: (update) => updates.push(update) });
  assert.deepEqual(files.map((file) => [file.origin, file.type, file.name]), [
    ['account', 'EXFAT', 'PPSA05132.exfat'],
    ['search', 'EXFAT', 'PPSA05132-sifu.exfat'],
    ['catalog', 'FFPFSC', 'PPSA05132 sifu.ffpfsc'],
    ['account', 'PKG', 'sifu.pkg'],
    ['catalog', 'RAR', 'PPSA05132v1 024 000 PS5-[DLPSGAME.COM].rar'],
    ['account', 'RAR', 'sifu.part1.rar']
  ]);
  assert.ok(files.at(-1).piece, 'a .part1.rar is one piece of a set');
  assert.deepEqual(Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, value.state])), { account: 'done', catalog: 'done', search: 'done', list: 'absent' });
  assert.equal(updates.length, 3, 'one update per part');
  assert.ok(api.asked.includes('cachedEntries 2'), 'the two single-file links of the catalog; the set in parts is left out');
  assert.ok(api.asked.includes('search PPSA05132') && api.asked.includes('search sifu'));
});

// glibren.13 (Crysis 2 on a real PS5): TorBox kept the original site's 500 page (170 B) as the .pkg.
test('glibren.13: a game file under 1 MiB is TorBox\'s broken copy: marked, listed last, not counted, never queued', async () => {
  const api = fakeClient();
  const list = api.myList;
  api.myList = async (kind) => kind === 'webdl' ? [...await list(kind), { id: 120, name: 'Sifu - [EU] [EN] [1.01].pkg', size: 170, download_finished: true, files: [{ id: 0, name: 'Sifu - [EU] [EN] [1.01].pkg', size: 170 }] }] : list(kind);
  const { files } = await search.searchTorBox(GAME, { api });
  const broken = files.filter((file) => file.broken);
  assert.deepEqual(broken.map((file) => [file.name, file.size]), [['Sifu - [EU] [EN] [1.01].pkg', 170]]);
  assert.equal(files.at(-1).broken, true, 'listed last');
  assert.ok(files.filter((file) => file.name === 'sifu.pkg').every((file) => !file.broken), 'the real .pkg is not');
  assert.throws(() => search.downloadFile({ enqueue: () => assert.fail('queued') }, GAME, broken[0], '/data'), /TorBox has a broken copy of this file/);
});

test('the search API not answering only says so: the account and the catalog still come back', async () => {
  const { files, sources } = await search.searchTorBox(GAME, { textSearch: true, api: fakeClient({ searchFails: true }) });
  assert.equal(sources.search.state, 'unavailable');
  assert.ok(files.length >= 4 && files.every((file) => file.origin !== 'search'));
});

test('a file picked is a TorBox download: its item and file kept for the resolver, the renewal and the payload', async () => {
  const { files } = await search.searchTorBox(GAME, { textSearch: true, api: fakeClient() });
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
  const { files } = await search.searchTorBox(GAME, { textSearch: true, api: fakeClient() });
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

// ---- glibren.6: the gamer's list of hashes, a torrent's backport folder and "All", a PS5 fake package's warning ----
const MAFIA = { id: 'PPSA14299', title: 'Mafia The Old Country', releases: [] };
const H_CODED = 'a9da69905bdac2dc7eb9891bedf7c1a0720e646e';
const H_NAMED = 'b6ab3cefe2357655b5061b5c704a141d3ecd26b4';
const H_OTHER = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const H_ELSE = '0000000000000000000000000000000000000001';
const TORRENT_DIR = '[PS5] Mafia The Old Country (Deluxe Edition) [EUR v01.011.000 fpkg exfat]';
const mafiaFiles = [
  { id: 0, name: `${TORRENT_DIR}/[PPSA14299]Mafia Domovina[01.011].exfat`, size: 63.31 * 2 ** 30 },
  { id: 1, name: `${TORRENT_DIR}/[PPSA14299]Mafia Domovina[01.011].pkg`, size: 40.11 * 2 ** 30 },
  { id: 2, name: `${TORRENT_DIR}/UPDATE 4xx-9xx.pkg`, size: 0.39 * 2 ** 30 },
  { id: 3, name: `${TORRENT_DIR}/DLC Mafia1.pkg`, size: 300000 },
  { id: 4, name: `${TORRENT_DIR}/backports/PPSA14299/eboot.bin`, size: 0.15 * 2 ** 30 },
  { id: 5, name: `${TORRENT_DIR}/backports/PPSA14299/sce_module/libSceNpCppWebApi.prx`, size: 10e6 },
  { id: 6, name: `${TORRENT_DIR}/backports/PPSA14299/fakelib/libScePsml.sprx`, size: 4000 }
];
function listClient() {
  const asked = [];
  const held = {
    [H_CODED]: { name: TORRENT_DIR, size: 103.97 * 2 ** 30, files: mafiaFiles },
    [H_NAMED]: { name: 'Mafia.The.Old.Country.PS5-GROUP', size: 60e9, files: [{ id: 0, name: 'Mafia.The.Old.Country.PS5-GROUP/game.exfat', size: 60e9 }] },
    [H_OTHER]: { name: 'Some Other Game', size: 5e9, files: [{ id: 0, name: 'Some Other Game/other.exfat', size: 5e9 }] }
  };
  return {
    asked,
    async myList() { return []; },
    async searchTorrents() { throw Object.assign(new Error('no search'), { code: 'NETWORK' }); },
    async cachedEntries(links) {
      asked.push(...links);
      const found = new Map();
      for (const link of links) {
        const hash = /btih:([0-9a-f]{40})/i.exec(link)?.[1]?.toLowerCase();
        if (hash && held[hash]) found.set(link, held[hash]);
      }
      return found;
    }
  };
}
const LIST_TEXT = [
  '# my torrents',
  '',
  `PPSA14299 magnet:?xt=urn:btih:${H_CODED.toUpperCase()}&dn=Mafia`,
  `${H_NAMED}   a note without a code`,
  `${H_OTHER} PPSA99999 another game`,
  `   ${H_ELSE}`,
  'a line with nothing to read',
  'CUSA-12345 MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U'
].join('\n');

test('torbox-hashes.txt: a magnet or a bare hash a line, any code on it; comments, blank and unreadable lines skipped', () => {
  const entries = search.parseHashList(LIST_TEXT);
  assert.deepEqual(entries.map((item) => [item.hash, item.code]), [
    [H_CODED, 'PPSA14299'],
    [H_NAMED, null],
    [H_OTHER, 'PPSA99999'],
    [H_ELSE, null],
    ['6162636465666768696a6b6c6d6e6f7071727374', 'CUSA12345']
  ], 'a base32 hash is turned to hex');
  const fs = { exists: (p) => p === '/data/JobeesLair/torbox-hashes.txt' || p === '/mnt/usb0/torbox-hashes.txt', readFile: (p) => p.includes('usb0') ? `${H_CODED}\n` : LIST_TEXT };
  const paths = search.hashListPaths('/data/JobeesLair', ['/data', '/mnt/usb0']);
  assert.deepEqual(paths, ['/data/JobeesLair/torbox-hashes.txt', '/data/torbox-hashes.txt', '/mnt/usb0/torbox-hashes.txt']);
  const list = search.readHashList(fs, paths);
  assert.equal(list.files, 2);
  assert.equal(list.entries.find((item) => item.hash === H_CODED).code, 'PPSA14299', 'a code on one line of a hash holds');
  assert.deepEqual(search.readHashList({ exists: () => false }, paths), { files: 0, entries: [] });
});

test("the list: hashes of the game's code, and of no code when the torrent is the game's by name; asked once a session", async () => {
  const api = listClient();
  const hashList = { files: 1, entries: search.parseHashList(LIST_TEXT) };
  const { files, sources } = await search.searchTorBox(MAFIA, { api, hashList });
  assert.equal(sources.list.state, 'done');
  assert.ok(!api.asked.some((link) => link.includes(H_OTHER)), "another game's coded hash is not even asked");
  assert.deepEqual(files.map((file) => [file.origin, file.type, file.name]), [
    ['list', 'EXFAT', '[PPSA14299]Mafia Domovina[01.011].exfat'],
    ['list', 'EXFAT', 'game.exfat'],
    ['list', 'PKG', '[PPSA14299]Mafia Domovina[01.011].pkg'],
    ['list', 'PKG', 'UPDATE 4xx-9xx.pkg'],
    ['list', 'PKG', 'DLC Mafia1.pkg'],
    ['list', 'ZIP', TORRENT_DIR],
    ['list', 'BACKPORT', 'backports/PPSA14299']
  ], 'the backport files become one row; the torrent of many files gets an All row; the one-file torrent does not');
  const backport = files.find((file) => file.backport);
  assert.equal(backport.count, 3);
  assert.throws(() => search.downloadFile({ enqueue() { throw new Error('not here'); } }, MAFIA, backport, '/data'), /backport/);
  const before = api.asked.length;
  await search.searchTorBox(MAFIA, { api, hashList });
  assert.equal(api.asked.length, before, 'what TorBox said of each hash is kept for the session');
  const { sources: none } = await search.searchTorBox(MAFIA, { api, hashList: { files: 0, entries: [] } });
  assert.equal(none.list.state, 'absent');
});

test('"All" is the whole torrent as one zip: a link of its own, the zip kept for the renewal and the payload', async () => {
  const { files } = await search.searchTorBox(MAFIA, { api: listClient(), hashList: { files: 1, entries: search.parseHashList(LIST_TEXT) } });
  const all = search.releaseFor(files.find((file) => file.whole));
  assert.equal(all.format, 'zip');
  assert.equal(all.torboxZip, true);
  assert.match(all.filename, /\.zip$/);
  assert.equal(all.url, `magnet:?xt=urn:btih:${H_CODED}&x.glibren=all`);
  assert.notEqual(all.url, search.releaseFor(files[0]).url, 'apart from the link of one of its files');
  // An account torrent's All: TorBox's item kept as a zip, so the payload asks for the zip link again by itself.
  const account = search.releaseFor({ origin: 'account', kind: 'torrent', id: 77, fileId: 'all', name: 'Big torrent', size: 9e9, whole: true, count: 4 });
  assert.equal(account.url, 'https://torbox.app/torrents/77?all');
  assert.deepEqual(debrid.debridHandoff(account), { provider: 'torbox', kind: 'torrent', id: 77, fileId: null, zip: true });
});

test("resolve with zip asks TorBox for the torrent's zip link even when a file is named like the release", async () => {
  const { createTorBox } = await load('app/services/torbox.js');
  const http = { async request(url) {
    const { pathname, searchParams } = new URL(url);
    const body = pathname.endsWith('/torrents/mylist') ? { success: true, data: { id: 5, download_finished: true, files: [{ id: 0, name: 'a.exfat', size: 9 }, { id: 1, name: 'b.pkg', size: 8 }] } }
      : pathname.endsWith('/torrents/requestdl') ? { success: true, data: `https://cdn.example/${searchParams.get('zip_link') === 'true' ? 'zip' : searchParams.get('file_id')}` } : { success: false, error: 'HTTP_404' };
    return { status: 200, ok: true, json: async () => body };
  } };
  const api = createTorBox({ http, key: () => '0123abcd-4567-89ef-0123-456789abcdef', wait: async () => {} });
  const zip = await api.resolve(`magnet:?xt=urn:btih:${H_CODED}`, { known: { kind: 'torrent', id: 5 }, filename: 'a.exfat', zip: true });
  assert.deepEqual([zip.url, zip.repacked, zip.fileId], ['https://cdn.example/zip', true, null]);
  const one = await api.resolve(`magnet:?xt=urn:btih:${H_CODED}`, { known: { kind: 'torrent', id: 5 }, filename: 'a.exfat' });
  assert.equal(one.url, 'https://cdn.example/0', 'without zip, the file named');
});

test("a PS5 game's .pkg is flagged on a console that won't launch fake packages; an .exfat and a PS4 game's are not", () => {
  const pkg = { format: 'pkg' };
  assert.equal(search.fakePackageWarning(pkg, MAFIA, false), true);
  assert.equal(search.fakePackageWarning(pkg, MAFIA, null), true, 'firmware not known: said as the source list says it');
  assert.equal(search.fakePackageWarning(pkg, MAFIA, true), false, 'at 11.60 or below it launches');
  assert.equal(search.fakePackageWarning({ format: 'exfat' }, MAFIA, false), false);
  assert.equal(search.fakePackageWarning(pkg, { id: 'CUSA12345' }, false), false);
});

test('the text search is off unless asked: search-api.torbox.app is gone, and asking it broke the next requests', async () => {
  const api = fakeClient();
  const { sources } = await search.searchTorBox(GAME, { api });
  assert.equal(sources.search.state, 'absent');
  assert.ok(!api.asked.some((line) => line.startsWith('search ')));
});
