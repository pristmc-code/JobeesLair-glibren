// glibren.17: "Search TorBox" (state/torbox-search.js) offers what the game's source list offers through TorBox. The
// case of System Shock (PPSA06389): three catalog releases point to the same Vikingfile link, which TorBox holds, so
// the source list showed three releases with the "TorBox Instant" badge and eight more TorBox can fetch, while the
// search showed one file. Now the search asks the same links in one call, says how many catalog links a file is, and
// lists the links TorBox can fetch but does not hold yet. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const search = await load('app/state/torbox-search.js');
const { releaseSets } = await load('app/state/release-sets.js');

const VIKING = 'https://vikingfile.com/f/AAAAAAAAAA';
const RAPID = 'https://rapidgator.net/file/0123/Game.Release.PPSA06389-PS5.rar.html';
const RAW = [
  { id: 'r1', url: VIKING, browserUrl: VIKING, filename: 'PPSA06389.exfat', format: 'exfat', provider: 'Vikingfile', label: '', sizeBytes: 9.4e9, requiresBrowser: true },
  { id: 'r2', url: 'https://vikingfile.com/f/BBBBBBBBBB', browserUrl: 'https://vikingfile.com/f/BBBBBBBBBB', filename: 'x.binary', format: 'binary', provider: 'VikingFile', label: 'USA Base - Vikingfile', requiresBrowser: true },
  { id: 'r3', url: 'https://1fichier.com/?abcdefghijklmnopqrst', browserUrl: 'https://1fichier.com/?abcdefghijklmnopqrst', filename: 'y.binary', format: 'binary', provider: '1fichier.com', label: 'USA Base - 1fichier', requiresBrowser: true },
  { id: 'r4', url: 'https://vikingfile.com/f/PART111111', browserUrl: 'https://vikingfile.com/f/PART111111', filename: 'p1.binary', format: 'binary', provider: 'VikingFile', label: 'BackPort - Vikingfile part 1', volume: 'part 1', record: 'rec', requiresBrowser: true },
  { id: 'r5', url: 'https://vikingfile.com/f/PART222222', browserUrl: 'https://vikingfile.com/f/PART222222', filename: 'p2.binary', format: 'binary', provider: 'VikingFile', label: 'BackPort - Vikingfile part 2', volume: 'part 2', record: 'rec', requiresBrowser: true },
  { id: 'r6', url: RAPID, browserUrl: RAPID, filename: 'z.binary', format: 'binary', provider: 'rapidgator.net', label: 'Release 2 Base - Rapidgator', requiresBrowser: true },
  { id: 'r7', url: VIKING, browserUrl: VIKING, filename: 'a.binary', format: 'binary', provider: 'VikingFile', label: 'Release 2 Base - Vikingfile', requiresBrowser: true },
  { id: 'r8', url: VIKING, browserUrl: VIKING, filename: 'b.binary', format: 'binary', provider: 'VikingFile', label: 'VikingFile', requiresBrowser: true },
  { id: 'r9', url: 'https://datanodes.to/xqfks64itnvk', browserUrl: 'https://datanodes.to/xqfks64itnvk', filename: 'c.binary', format: 'binary', provider: 'DataNodes', label: 'DataNodes', requiresBrowser: true }
];
const GAME = { id: 'PPSA06389', title: 'System Shock', releases: releaseSets(RAW) };
// What TorBox would fetch (state/debrid.js debridSupports): every host but rapidgator (not working there).
const supports = (release) => !release.unavailableReason && !(release.browserUrl || release.url || '').includes('rapidgator');
// The links the source list's "TorBox Instant" asks about (state/debrid.js useTorBoxInstant: sourcesOf/linkOf).
const instantLinks = (releases) => [...new Set(releases.filter(supports).flatMap((release) => (release.parts ? release.parts.map((part) => part.sources[0]) : [release]).map((source) => source.browserUrl || source.url)))];

function fakeClient({ account = [] } = {}) {
  const asked = [];
  return {
    asked,
    async myList(kind) {
      asked.push({ call: `myList ${kind}` });
      return kind === 'webdl' ? account : [];
    },
    async cachedEntries(links) {
      asked.push({ call: 'cachedEntries', links: [...links] });
      const held = new Map();
      for (const link of links) {
        if (link === VIKING) held.set(link, { name: 'PPSA06389.exfat', size: 9402580992, files: [{ id: 0, name: 'PPSA06389.exfat', size: 9402580992 }] });
        if (link.includes('1fichier')) held.set(link, { name: 'PPSA06389-v1.000.rar', size: 8e9, files: [{ id: 0, name: 'PPSA06389-v1.000.rar', size: 8e9 }] });
      }
      return held;
    }
  };
}

test('System Shock: the search asks, in one call, every link the source list asks TorBox about', async () => {
  const api = fakeClient();
  await search.searchTorBox(GAME, { api, supports });
  const calls = api.asked.filter((entry) => entry.call === 'cachedEntries');
  assert.equal(calls.length, 1, 'one checkcached for the catalog, as before');
  for (const link of instantLinks(GAME.releases)) assert.ok(calls[0].links.includes(link), `asked: ${link}`);
  assert.equal(new Set(calls[0].links).size, calls[0].links.length, 'each link once, however many releases share it');
});

test('System Shock: the held files show with how many catalog links they are, and every link TorBox can fetch has a row', async () => {
  const { files, sources } = await search.searchTorBox(GAME, { api: fakeClient(), supports });
  const held = files.filter((file) => !file.fetch);
  assert.deepEqual(held.map((file) => file.name), ['PPSA06389.exfat', 'PPSA06389-v1.000.rar']);
  assert.deepEqual(held[0].releases, ['r1', 'r7', 'r8'], 'the three releases of the Vikingfile link the source list badges');
  assert.deepEqual(held[1].releases, ['r3']);
  const fetch = files.filter((file) => file.fetch);
  assert.deepEqual(fetch.map((file) => file.release.id).sort(), ['r2', 'r9', GAME.releases.find((release) => release.parts).id].sort(), 'the not-held links TorBox takes: Vikingfile, DataNodes and the set in parts (not rapidgator)');
  assert.ok(fetch.every((file) => file.origin === 'catalog' && !file.piece));
  assert.equal(fetch.find((file) => file.release.parts).parts, 2);
  assert.deepEqual(files.slice(0, 2).map((file) => file.name), held.map((file) => file.name), 'what TorBox holds comes first');
  assert.equal(sources.catalog.count, 2, 'the catalog counts the files TorBox holds');
  assert.equal(sources.catalog.fetch, 3, 'and the links it can fetch apart');
  // Together: the source list's TorBox options, all of them (held or not), are in the search's list.
  const offered = new Set(files.flatMap((file) => file.releases ?? []));
  for (const release of GAME.releases.filter(supports)) assert.ok(offered.has(release.id), `offered: ${release.id}`);
});

test('System Shock: a file in the account and among the catalog links is one row that keeps the catalog links', async () => {
  const account = [{ id: 7, name: 'PPSA06389.exfat', size: 9402580992, download_finished: true, files: [{ id: 0, name: 'PPSA06389.exfat', size: 9402580992 }] }];
  const { files } = await search.searchTorBox(GAME, { api: fakeClient({ account }), supports });
  const exfat = files.filter((file) => file.name === 'PPSA06389.exfat');
  assert.equal(exfat.length, 1);
  assert.equal(exfat[0].origin, 'account', 'kept where it is closest');
  assert.deepEqual(exfat[0].releases, ['r1', 'r7', 'r8']);
});

test('a link TorBox can only fetch is queued as the page queues it: the release through TorBox', async () => {
  const { files } = await search.searchTorBox(GAME, { api: fakeClient(), supports });
  const single = files.find((file) => file.fetch && file.release.id === 'r9');
  const release = search.releaseFor(single);
  assert.equal(release.id, 'r9~torbox');
  assert.equal(release.debrid?.service, 'torbox');
  assert.equal(release.url, 'https://datanodes.to/xqfks64itnvk');
  const set = files.find((file) => file.fetch && file.release.parts);
  const parts = search.releaseFor(set);
  assert.equal(parts.parts.length, 2);
  assert.ok(parts.parts.every((part) => part.sources[0].debrid?.service === 'torbox'));
});

test('without TorBox set up (the default check), no fetch rows: only what TorBox holds', async () => {
  const { files } = await search.searchTorBox(GAME, { api: fakeClient() });
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => !file.fetch));
});

test('fetchRow names a host page by its label and a file link by its file name', () => {
  const page = search.fetchRow(GAME.releases.find((release) => release.id === 'r9'), 'https://datanodes.to/xqfks64itnvk', []);
  assert.equal(page.name, 'DataNodes');
  assert.equal(page.type, '?');
  const file = search.fetchRow({ id: 'x', label: 'Mirror', provider: 'MediaFire', url: 'https://www.mediafire.com/file/k/PPSA06389.exfat/file', format: 'binary' }, 'https://www.mediafire.com/file/k/PPSA06389.exfat/file', []);
  assert.equal(file.name, 'PPSA06389.exfat');
  assert.equal(file.format, 'exfat');
});
