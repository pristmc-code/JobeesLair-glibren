// glibren.9: a Biblioteca TorBox (state/torbox-library.js) contra um TorBox falso: links em lotes (no máximo 50
// links web, 100 hashes, por chamada), a conta e a lista de hashes lidas uma vez, retomada depois de cancelar, a
// espera num 429, o lote recusado partido ao meio, o banco e a lista do payload gravados e lidos, as fontes
// escolhidas; e a loja TorBox (state/store-mode.js): a lista da loja trocada no lugar e as linhas refeitas.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const lib = await load('app/state/torbox-library.js');
const { md5 } = await load('app/services/torbox.js');

// Jogos de mentira: cada um com um link web; os pares têm o TorBox guardando o link.
const game = (n, extra = {}) => ({ id: `PPSA${String(100000 + n).slice(1)}`, title: `Game Number ${n}`, platform: 'ps5', genres: ['Action'], art: { cover: `https://img/${n}.png` }, sizeGb: n, formats: ['exfat'], releases: [{ id: `r${n}`, url: `https://host.example/file/${n}/game-${n}.exfat`, filename: `game-${n}.exfat` }], ...extra });
const entriesOf = (games, sources = ['bundled']) => games.map((g) => ({ game: g, sources }));

function fakeApi({ holds = (link) => /\/(\d+)\//.exec(link)?.[1] % 2 === 0, account = { webdl: [], torrent: [] }, rateLimitOnce = false, refuseOver = Infinity, network = false } = {}) {
  const calls = [];
  let limited = rateLimitOnce;
  return {
    calls,
    async myList(kind) {
      calls.push({ kind: `myList ${kind}` });
      return account[kind] ?? [];
    },
    async cachedEntries(links) {
      calls.push({ kind: 'cachedEntries', links: [...links] });
      if (network) throw Object.assign(new Error("TorBox didn't answer"), { code: 'NETWORK' });
      if (limited) {
        limited = false;
        throw Object.assign(new Error('slow down'), { code: 'RATE_LIMITED' });
      }
      if (links.length > refuseOver) throw Object.assign(new Error('TorBox answered HTTP 414.'), { code: 'HTTP_414' });
      const held = new Map();
      for (const link of links) {
        if (link.startsWith('magnet:')) {
          if (link.includes('aaaa')) held.set(link, { name: 'Game Number 7 PS5', size: 7e9, files: [{ id: 0, name: 'Game Number 7/PPSA00007.exfat', size: 7e9 }] });
        } else if (holds(link)) {
          const n = /\/(\d+)\//.exec(link)[1];
          held.set(link, { name: `game-${n}.exfat`, size: n * 1e9, files: [{ id: 0, name: `game-${n}.exfat`, size: n * 1e9 }, { id: 1, name: 'readme.txt', size: 10 }] });
        }
      }
      return held;
    }
  };
}
// Um relógio e um sleep que não esperam de verdade: o tempo anda o que se pediu.
function clock() {
  let at = 1_793_960_000_000;
  const waits = [];
  return { now: () => at, waits, sleep: async (ms, signal) => {
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
    waits.push(ms);
    at += ms;
  } };
}
const quiet = { pace: 400, rateWait: 61_000, chunk: 10, saveEvery: 0 };

test('every game is checked in batches: at most 50 links (100 hashes) a call, the account read once', async () => {
  const games = Array.from({ length: 120 }, (_, i) => game(i + 1));
  const api = fakeApi();
  const time = clock();
  const saves = [];
  const { library, progress } = await lib.buildLibrary({ entries: entriesOf(games), api, ...quiet, chunk: 120, ...time, save: (value, { final }) => saves.push(final) });
  const batches = api.calls.filter((call) => call.kind === 'cachedEntries');
  assert.equal(api.calls.filter((call) => call.kind.startsWith('myList')).length, 2, 'webdl and torrent, once');
  assert.deepEqual(batches.map((call) => call.links.length), [50, 50, 20], 'the block of 120 links in three calls');
  assert.equal(progress.total, 120);
  assert.equal(progress.done, 120);
  assert.equal(progress.found, 60, 'the even ones');
  assert.equal(progress.calls, 5);
  assert.ok(time.waits.filter((ms) => ms > 0).every((ms) => ms <= 400), 'paced, never more than the gap');
  assert.equal(saves.at(-1), true, 'the last save is the final one');
  const held = library.games.PPSA00002;
  assert.equal(held.torbox.confirmed, true);
  assert.equal(held.torbox.hash, md5('https://host.example/file/2/game-2.exfat'));
  assert.deepEqual(held.torbox.files, [{ name: 'game-2.exfat', size: 2e9, format: 'exfat', via: 'webdl', hash: md5('https://host.example/file/2/game-2.exfat'), release: 'r2', link: 'https://host.example/file/2/game-2.exfat' }], 'the small text file is left out; glibren.18: the public catalog link, for the payload');
  assert.equal(held.code, 'PPSA00002');
  assert.equal(library.games.PPSA00001.torbox.confirmed, false);
  assert.ok(library.builtAt && library.run.finishedAt);
});

test('a game is also found in the account (by its code or by every word of its name) and in the hash list', async () => {
  const games = [game(3, { id: 'PPSA01467', title: 'Astro Bot' }), game(5, { id: 'CUSA12345', title: 'Sifu', platform: 'ps4' }), game(7, { id: 'PPSA00007', title: 'Game Number 7' })];
  const account = {
    webdl: [{ id: 11, hash: 'w11', name: 'PPSA-01467 something.exfat', size: 9e9, files: [{ id: 0, name: 'PPSA-01467 something.exfat', size: 9e9 }] }],
    torrent: [{ id: 22, hash: 'abc', name: 'Sifu Deluxe [PS4]', size: 5e9, files: [{ id: 3, name: 'Sifu Deluxe/sifu.pkg', size: 5e9 }] }]
  };
  const api = fakeApi({ holds: () => false, account });
  const hashList = { files: 1, entries: [{ hash: 'aaaa'.padEnd(40, '0'), code: null }, { hash: 'bbbb'.padEnd(40, '0'), code: 'PPSA09999' }] };
  const { library } = await lib.buildLibrary({ entries: entriesOf(games), api, hashList, ...quiet, ...clock() });
  assert.deepEqual(library.games.PPSA01467.torbox.files.map((f) => [f.via, f.item, f.file]), [['account', { kind: 'webdl', id: 11 }, 0]]);
  assert.deepEqual(library.games.CUSA12345.torbox.files.map((f) => [f.name, f.format, f.via]), [['sifu.pkg', 'pkg', 'account']], 'by the words of its name');
  assert.equal(library.games.CUSA12345.platform, 'ps4');
  const seven = library.games.PPSA00007.torbox;
  assert.equal(seven.confirmed, true, 'the hash list, matched by name');
  assert.equal(seven.hash, 'aaaa'.padEnd(40, '0'));
  assert.equal(seven.name, 'Game Number 7 PS5');
  assert.deepEqual(seven.files.map((f) => [f.name, f.via]), [['PPSA00007.exfat', 'torrent']]);
});

// glibren.13: TorBox kept the original site's error page (170 bytes) as a game's .pkg (a user's log, 07/11/2026).
test('glibren.13: a game file under 1 MiB is a broken copy: marked, listed last and never the recommended one', async () => {
  const games = [game(3, { id: 'CUSA20002', title: 'Carrion', platform: 'ps4' }), game(5, { id: 'PPSA20003', title: 'Misto' })];
  const account = {
    webdl: [
      { id: 31, hash: 'w31', name: 'Carrion - [EU] [EN] [1.04].pkg', size: 170, files: [{ id: 0, name: 'Carrion - [EU] [EN] [1.04].pkg', size: 170 }] },
      { id: 32, hash: 'w32', name: 'Misto', size: 9e9, files: [{ id: 0, name: 'Misto.exfat', size: 170 }, { id: 1, name: 'Misto.pkg', size: 9e9 }] }
    ],
    torrent: []
  };
  const api = fakeApi({ holds: () => false, account });
  const { library, progress } = await lib.buildLibrary({ entries: entriesOf(games), api, ...quiet, ...clock() });
  const carrion = library.games.CUSA20002.torbox;
  assert.deepEqual(carrion.files.map((f) => [f.name, f.size, f.broken]), [['Carrion - [EU] [EN] [1.04].pkg', 170, true]]);
  // glibren.13 (Crysis 2 on a real PS5): only broken copies is not "confirmed": out of the store and the phone, counted.
  assert.deepEqual([carrion.confirmed, carrion.broken], [false, 1]);
  assert.deepEqual([progress.found, progress.broken, library.run.broken], [1, 1, 1]);
  assert.deepEqual(lib.exportList(library).games.map((g) => g.id), ['PPSA20003']);
  // A record from a run before the rule (confirmed, no "broken"): left out when read, without building again.
  const old = { ...library, games: { ...library.games, CUSA20002: { ...library.games.CUSA20002, torbox: { ...carrion, confirmed: true, broken: void 0 } } } };
  assert.deepEqual(lib.exportList(old).games.map((g) => g.id), ['PPSA20003']);
  assert.equal(lib.brokenOnly(old.games.CUSA20002), true);
  assert.equal(lib.stillConfirmed(old.games.PPSA20003), true);
  const files = new Map();
  const fs = { exists: (p) => files.has(p), readFile: (p) => files.get(p), writeFile: (p, text) => files.set(p, String(text)), mkdir() {}, rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); } };
  const paths = lib.libraryPaths('/home/x/JobeesLair', false);
  lib.writeLibrary(fs, paths, old);
  // The store's ids and the payload's list as an older version wrote them (no "rules"): rewritten once from the library.
  files.set(paths.ids, JSON.stringify({ version: 1, builtAt: old.builtAt, ids: ['CUSA20002', 'PPSA20003'] }));
  files.set(paths.list, JSON.stringify({ version: 1, builtAt: old.builtAt, games: [{ id: 'CUSA20002' }, { id: 'PPSA20003' }] }));
  assert.deepEqual([...lib.readConfirmedIds(fs, paths)], ['PPSA20003']);
  assert.deepEqual(JSON.parse(files.get(paths.ids)).ids, ['PPSA20003']);
  assert.deepEqual(JSON.parse(files.get(paths.list)).games.map((g) => g.id), ['PPSA20003'], 'the phone list too');
  files.set(paths.library, '{}');
  assert.deepEqual([...lib.readConfirmedIds(fs, paths)], ['PPSA20003'], 'after that, the ids as written (the library not read again)');
  const misto = library.games.PPSA20003.torbox;
  assert.deepEqual(misto.files.map((f) => [f.name, Boolean(f.broken)]), [['Misto.pkg', false], ['Misto.exfat', true]], 'the broken exFAT goes last, the good .pkg first');
  assert.equal(misto.hash, 'w32');
  assert.equal(lib.brokenFile({ size: 170, format: 'pkg' }), true);
  assert.equal(lib.brokenFile({ size: lib.BROKEN_BYTES, format: 'pkg' }), false, '1 MiB and up is not');
  assert.equal(lib.brokenFile({ size: 170, format: '' }), false, 'a small readme is not a game file');
  assert.equal(lib.brokenFile({ size: 300000, format: 'pkg' }), false, 'a small DLC unlock package is real (64 KiB and up)');
  assert.equal(lib.brokenFile({ size: 300000, format: 'exfat' }), true, 'an image that small is not');
  assert.equal(lib.brokenFile({ name: 'Crysis 2 - [EU] [EN] [1.01].pkg', size: 170 }), true, 'the format from the name');
  // The phone's "Download" of the broken one never reaches the queue.
  const { libraryFile } = await load('app/state/phone-library.js');
  assert.throws(() => libraryFile({ via: 'account', item: { kind: 'webdl', id: 31 }, fileId: '0', file: 'Carrion - [EU] [EN] [1.04].pkg', size: 170, title: 'Carrion' }, null), /TorBox has a broken copy of this file \(170 B\)/);
  assert.equal(libraryFile({ via: 'account', item: { kind: 'webdl', id: 32 }, fileId: '1', file: 'Misto.pkg', size: 9e9, title: 'Misto' }, null).name, 'Misto.pkg');
});

test('cancelled halfway, a run continues where it stopped (the games already checked are not asked again)', async () => {
  const games = Array.from({ length: 40 }, (_, i) => game(i + 1));
  const listeners = new Set();
  const signal = { aborted: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  const api = fakeApi();
  let saved = null;
  const save = (value) => { saved = JSON.parse(JSON.stringify(value)); };
  await assert.rejects(lib.buildLibrary({ entries: entriesOf(games), api, ...quiet, ...clock(), signal, save, onProgress: (p) => {
    if (p.done >= 20 && !signal.aborted) {
      signal.aborted = true;
      for (const fn of listeners) fn();
    }
  } }), { name: 'AbortError' });
  assert.ok(saved, 'saved before stopping');
  assert.equal(saved.run.finishedAt, null);
  assert.equal(saved.run.done, 20);
  const runId = saved.run.id;
  const again = fakeApi();
  const { library, progress } = await lib.buildLibrary({ entries: entriesOf(games), api: again, library: saved, ...quiet, ...clock(), save: () => {} });
  assert.equal(progress.resumed, true);
  assert.equal(library.run.id, runId, 'the same run');
  const asked = again.calls.filter((call) => call.kind === 'cachedEntries').flatMap((call) => call.links);
  assert.equal(asked.length, 20, 'only the 20 left');
  assert.ok(!asked.some((link) => /\/(1|2|3|4|5|6|7|8|9|10)\//.test(link)), 'none of the first ones');
  assert.equal(progress.done, 40);
  assert.equal(progress.found, 20);
  // Fresh: a new run from the first game.
  const fresh = fakeApi();
  const rebuilt = await lib.buildLibrary({ entries: entriesOf(games), api: fresh, library, fresh: true, ...quiet, ...clock() });
  assert.notEqual(rebuilt.library.run.id, runId);
  assert.equal(fresh.calls.filter((call) => call.kind === 'cachedEntries').flatMap((call) => call.links).length, 40);
});

test('a 429 waits a minute and asks again; a batch TorBox refuses is split until it passes', async () => {
  const games = Array.from({ length: 30 }, (_, i) => game(i + 1));
  const time = clock();
  const api = fakeApi({ rateLimitOnce: true, refuseOver: 8 });
  const seen = [];
  const { progress } = await lib.buildLibrary({ entries: entriesOf(games), api, ...quiet, chunk: 30, ...time, onProgress: (p) => p.waitingUntil && seen.push(p.waitingUntil) });
  assert.ok(time.waits.includes(61_000), `waited a minute: ${time.waits}`);
  assert.equal(seen.length, 1, 'the screen hears the wait');
  assert.equal(progress.done, 30);
  assert.equal(progress.found, 15, 'every game answered in the end');
  assert.equal(progress.errors, 0);
  assert.ok(api.calls.filter((call) => call.kind === 'cachedEntries').every((call, i, list) => call.links.length <= 30), 'split');
});

test('a game nothing found is looked for by its files\' names and by "<code>.<type>": known, not confirmed (no link to ask for)', async () => {
  const games = [game(9), game(11), game(12), game(13)];
  const asked = [];
  const api = { ...fakeApi({ holds: (link) => link.includes('/12/') }), async cachedByHash(hashes) {
    asked.push(hashes);
    const out = [];
    if (hashes.includes(md5('PPSA00009.exfat'))) out.push({ hash: 'k9', name: 'PPSA00009.exfat', size: 9e9, files: [{ id: 0, name: 'PPSA00009.exfat', size: 9e9 }] });
    if (hashes.includes(md5('game-11.exfat'))) out.push({ hash: 'k11', name: 'game-11.exfat', size: 11e9, files: [] });
    out.push({ hash: 'stranger', name: 'Unrelated.exfat', size: 1e9, files: [] });
    return out;
  } };
  const { library, progress } = await lib.buildLibrary({ entries: entriesOf(games), api, ...quiet, ...clock() });
  assert.equal(asked.length, 1, 'one call for the block');
  assert.ok(!asked[0].includes(md5('PPSA00012.exfat')), 'a game already found is not asked again');
  assert.equal(asked[0].length, 3 * 5, 'four types of the code and the file name, for the three left');
  assert.deepEqual(library.games.PPSA00009.torbox.known, [{ name: 'PPSA00009.exfat', size: 9e9, format: 'exfat', via: 'code', hash: 'k9' }]);
  assert.deepEqual(library.games.PPSA00011.torbox.known, [{ name: 'game-11.exfat', size: 11e9, format: 'exfat', via: 'name', hash: 'k11' }]);
  assert.equal(library.games.PPSA00009.torbox.confirmed, false);
  assert.equal(library.games.PPSA00013.torbox.known, undefined);
  assert.equal(progress.found, 1);
  assert.equal(progress.known, 2);
  assert.deepEqual(lib.exportList(library).games.map((g) => g.id), ['PPSA00012'], 'the payload list has only what can be downloaded');
});

test('TorBox out of reach stops the run with the error, the rest left for Continue', async () => {
  const games = Array.from({ length: 12 }, (_, i) => game(i + 1));
  const time = clock();
  let saved = null;
  await assert.rejects(lib.buildLibrary({ entries: entriesOf(games), api: fakeApi({ network: true }), ...quiet, ...time, save: (value) => { saved = value; } }), { code: 'NETWORK' });
  assert.ok(time.waits.includes(5000) && time.waits.includes(10000), 'tried again twice first');
  assert.equal(saved.run.finishedAt, null);
});

test('only the sources picked are checked, and each game keeps where it comes from', async () => {
  const feed = 'https://feeds.example/mine.json';
  const entries = [...entriesOf([game(2), game(4)], ['bundled']), ...entriesOf([game(6)], ['bundled', feed]), ...entriesOf([game(8)], [feed])];
  const api = fakeApi();
  const { library } = await lib.buildLibrary({ entries, api, sources: [feed], ...quiet, ...clock() });
  assert.deepEqual(Object.keys(library.games).sort(), ['PPSA00006', 'PPSA00008']);
  assert.deepEqual(library.games.PPSA00006.sources, ['bundled', feed]);
  assert.deepEqual(library.run.sources, [feed]);
});

test('the library and the payload list are written and read back; the list has only what TorBox confirmed', async () => {
  const files = new Map();
  const fs = { exists: (p) => files.has(p), readFile: (p) => files.get(p), writeFile: (p, text) => files.set(p, String(text)), mkdir() {}, rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); } };
  const ps5 = lib.libraryPaths('/download0/JobeesLair', true);
  assert.deepEqual(ps5, { library: '/download0/JobeesLair/torbox-biblioteca.json', backup: '/data/JobeesLair/torbox-biblioteca.json', list: '/data/JobeesLair/torbox-lista.json', ids: '/download0/JobeesLair/torbox-loja.json', details: '/data/JobeesLair/torbox-fichas.json' });
  assert.deepEqual(lib.libraryPaths('/home/x/JobeesLair', false), { library: '/home/x/JobeesLair/torbox-biblioteca.json', backup: null, list: '/home/x/JobeesLair/torbox-lista.json', ids: '/home/x/JobeesLair/torbox-loja.json', details: '/home/x/JobeesLair/torbox-fichas.json' });
  assert.equal(lib.readConfirmedIds(fs, ps5), null, 'never built');
  const { library } = await lib.buildLibrary({ entries: entriesOf([game(1), game(2), game(4)]), api: fakeApi(), ...quiet, ...clock() });
  lib.writeLibrary(fs, ps5, library, { backup: true });
  lib.writeList(fs, ps5, library);
  assert.ok(files.has(ps5.backup), 'a copy on /data');
  assert.deepEqual(lib.readLibrary(fs, ps5), library);
  files.delete(ps5.library);
  assert.deepEqual(lib.readLibrary(fs, ps5), library, 'read from the copy when the data folder lost it');
  const list = JSON.parse(files.get(ps5.list));
  assert.equal(list.version, 1);
  assert.equal(list.builtAt, library.builtAt);
  assert.deepEqual(list.games.map((g) => g.id), ['PPSA00002', 'PPSA00004']);
  assert.deepEqual(Object.keys(list.games[0]), ['id', 'title', 'code', 'platform', 'genres', 'sizeBytes', 'formats', 'hash', 'files', 'cover']);
  assert.deepEqual(list.games[0].files[0], { name: 'game-2.exfat', size: 2e9, format: 'exfat', via: 'webdl', hash: md5('https://host.example/file/2/game-2.exfat'), release: 'r2', link: 'https://host.example/file/2/game-2.exfat' });
  // glibren.18: only the public catalog links (webdl) go in the list, for the payload; never a signed one or a key.
  assert.ok(!/token=|apikey|key=/i.test(files.get(ps5.list)), 'no signed links or keys in the list');
  assert.deepEqual([...lib.readConfirmedIds(fs, ps5)], ['PPSA00002', 'PPSA00004']);
  assert.deepEqual(JSON.parse(files.get(ps5.ids)), { version: 1, builtAt: library.builtAt, rules: ['broken'], ids: ['PPSA00002', 'PPSA00004'] }, 'the store reads only the ids');
  files.delete(ps5.ids);
  assert.deepEqual([...lib.readConfirmedIds(fs, ps5)], ['PPSA00002', 'PPSA00004'], 'else the list');
  files.set(ps5.library, '{not json');
  files.delete(ps5.backup);
  assert.deepEqual(lib.readLibrary(fs, ps5), lib.emptyLibrary(), 'unreadable: an empty one');
  assert.ok(!files.has(ps5.details), 'no details without the catalog games');
});

test('glibren.9: the phone details (torbox-fichas.json): cover, photos, videos and store facts of the listed games, https only', async () => {
  const files = new Map();
  const fs = { exists: (p) => files.has(p), readFile: (p) => files.get(p), writeFile: (p, text) => files.set(p, String(text)), mkdir() {}, rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); } };
  const ps5 = lib.libraryPaths('/download0/JobeesLair', true);
  const shot = (n) => ({ url: `https://shots.example/${n}.1920x1080.jpg`, thumb: `https://shots.example/${n}.600x338.jpg` });
  const rich = game(2, {
    developer: 'Studio\nTwo', publisher: 'Pub', releaseDate: '2024-03-01', metacritic: 88, stars: 4.567, ratingCount: 1200, features: ['Single-player', 'Co-op'],
    art: { cover: 'https://img/2.png?w=384', coverFallbacks: ['https://img/2.png?w=384', 'https://steam/2.jpg', 'http://plain/2.jpg'], hero: 'https://steam/2-hero.jpg' },
    shortDescription: 'Short\ttext.', about: ['First paragraph.', '', 'x'.repeat(5000), 'Third.', 'Fourth.', 'Fifth.'],
    shots: [...Array.from({ length: 10 }, (_, i) => shot(i)), 'javascript:alert(1)', shot(1)],
    videos: ['dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=M7lc1UVf-VE&t=3', 'https://youtu.be/M7lc1UVf-VE', 'not a video', 'https://evil.example/watch?v=aaaaaaaaaaa']
  });
  // A página do jogo que não lê (getter que falha) só deixa a ficha mais curta.
  const broken = Object.defineProperty(game(4, { shots: 'nope' }), 'about', { get() { throw new Error('no page'); } });
  const { library } = await lib.buildLibrary({ entries: entriesOf([game(1), rich, broken]), api: fakeApi(), ...quiet, ...clock() });
  const byId = new Map([rich, broken].map((g) => [g.id, g]));
  lib.writeList(fs, ps5, library, undefined, (id) => byId.get(id) ?? null);
  const details = JSON.parse(files.get(ps5.details));
  assert.equal(details.version, 1);
  assert.deepEqual(details.games.map((g) => g.id), JSON.parse(files.get(ps5.list)).games.map((g) => g.id), 'the same games as the list, in its order');
  const two = details.games.find((g) => g.id === 'PPSA00002');
  assert.equal(Object.keys(two)[0], 'id', 'the id first (the payload looks for it)');
  assert.equal(two.summary, 'Short text.');
  assert.deepEqual(two.about.slice(0, 1), ['First paragraph.']);
  assert.equal(two.about.length, 4);
  assert.ok(two.about[1].length <= 900);
  assert.equal(two.shots.length, 8, 'at most 8 photos, no repeats, nothing but https');
  assert.deepEqual(two.shots[0], shot(0));
  assert.deepEqual(two.videos, ['dQw4w9WgXcQ', 'M7lc1UVf-VE'], 'YouTube ids from ids and addresses, once each');
  assert.equal(two.cover, 'https://img/2.png?w=384');
  assert.deepEqual(two.coverFallbacks, ['https://steam/2.jpg'], 'the cover itself and http left out');
  assert.equal(two.hero, 'https://steam/2-hero.jpg');
  assert.deepEqual([two.developer, two.publisher, two.releaseDate, two.metacritic, two.stars, two.ratingCount], ['Studio Two', 'Pub', '2024-03-01', 88, 4.57, 1200]);
  assert.deepEqual(two.features, ['Single-player', 'Co-op']);
  const four = details.games.find((g) => g.id === 'PPSA00004');
  assert.deepEqual(four, { id: 'PPSA00004', cover: 'https://img/4.png' });
  assert.ok(!files.get(ps5.details).includes('host.example'), 'no download links in the details');
  assert.deepEqual(lib.exportDetails({ builtAt: 'x', games: [{ id: 'A' }] }, () => null), { version: 1, builtAt: 'x', games: [{ id: 'A' }] }, 'a game the catalog lost: just the id');
});

test('glibren.9: youtubeId takes ids and YouTube addresses only; a feed keeps its "videos"', async () => {
  const { youtubeId } = await load('app/state/youtube.js');
  for (const [value, id] of [['M7lc1UVf-VE', 'M7lc1UVf-VE'], ['https://www.youtube.com/watch?v=M7lc1UVf-VE', 'M7lc1UVf-VE'], ['https://m.youtube.com/watch?feature=x&v=M7lc1UVf-VE', 'M7lc1UVf-VE'],
    ['https://youtu.be/M7lc1UVf-VE?t=9', 'M7lc1UVf-VE'], ['https://www.youtube-nocookie.com/embed/M7lc1UVf-VE', 'M7lc1UVf-VE'], ['https://www.youtube.com/shorts/M7lc1UVf-VE', 'M7lc1UVf-VE'], [{ id: 'M7lc1UVf-VE' }, 'M7lc1UVf-VE'],
    ['https://evil.example/watch?v=M7lc1UVf-VE', null], ['https://www.youtube.com/watch?v=short', null], ['<script>', null], [null, null], ['M7lc1UVf-VE1', null]]) assert.equal(youtubeId(value), id, String(value?.id ?? value));
  const { parseFeed } = await load('app/state/feed-format.js');
  const feed = (videos) => parseFeed({ version: 1, name: 'T', games: [{ id: 'PPSA01234', title: 'Game', releases: [{ url: 'https://host.example/a.exfat' }], ...(videos ? { videos } : {}) }] }, 'https://example.com/f.json');
  assert.deepEqual(feed(['https://youtu.be/M7lc1UVf-VE', 'M7lc1UVf-VE', 'nope']).games[0].page.videos, ['M7lc1UVf-VE']);
  assert.equal('videos' in feed(null).games[0].page, false, 'no videos: no field');
});

test('the TorBox store: the store list narrowed in place, the rows and search worked out again, back to full', async () => {
  const { games } = await load('app/data/catalog-index.js');
  const catalog = await load('app/state/catalog.js');
  const full = games.length;
  const ids = games.slice(0, 40).filter((g, i) => i % 4 === 0).map((g) => g.id);
  globalThis.__stubFiles = new Map([['/download0/JobeesLair/torbox-lista.json', JSON.stringify({ version: 1, builtAt: '2026-11-06T12:00:00.000Z', games: ids.map((id) => ({ id })) })]]);
  const mode = await load('app/state/store-mode.js');
  const featured = await load('app/browse/featured.js');
  const { searchGames } = await load('app/search/match.js');
  assert.equal(mode.storeMode(), 'full');
  const before = mode.storeEpoch();
  const result = mode.applyStoreMode('torbox');
  assert.deepEqual(result, { ok: true, reason: '' });
  assert.equal(mode.storeMode(), 'torbox');
  assert.equal(mode.storeEpoch(), before + 1);
  assert.ok(games.length >= ids.length && games.length < full, `${games.length} of ${full}`);
  assert.ok(games.every((g) => ids.includes(g.id) || catalog.editionsOf(g).some((e) => ids.includes(e.id))), 'only confirmed games (or another edition of one)');
  assert.ok(featured.featured.every((g) => games.includes(g)), 'the carousel picked again from them');
  assert.ok(searchGames('').length === games.length && searchGames(games[0].title.slice(0, 5)).every((g) => games.includes(g)), 'search over them');
  assert.ok(catalog.filterGames({ filters: catalog.NO_FILTERS, query: '', wishlist: [] }).length === games.length, 'the filters over them');
  assert.equal(mode.torBoxStoreCount(), games.length);
  const settings = JSON.parse(globalThis.__stubFiles.get('/download0/JobeesLair/settings.json'));
  assert.equal(settings.storeMode, 'torbox', 'the choice is kept');
  assert.deepEqual(mode.applyStoreMode('full'), { ok: true, reason: '' });
  assert.equal(games.length, full);
  // No list: the TorBox store says why and the store stays as it is.
  globalThis.__stubFiles.delete('/download0/JobeesLair/torbox-lista.json');
  assert.deepEqual(mode.applyStoreMode('torbox'), { ok: false, reason: 'never' });
  globalThis.__stubFiles.set('/download0/JobeesLair/torbox-lista.json', JSON.stringify({ version: 1, builtAt: 'x', games: [] }));
  assert.deepEqual(mode.applyStoreMode('torbox'), { ok: false, reason: 'empty' });
  assert.equal(mode.storeMode(), 'full');
  assert.equal(games.length, full);
  delete globalThis.__stubFiles;
});
