// glibren: link formats (app/state/link-formats.js), the format filter (format-filter.js) and "Find formats"
// (format-probe.js): names from real catalog links, Content-Disposition, first bytes, host pages saved in
// tests/fixtures/host-pages, the filter's counts and saved choice, and the search's queue on scripted answers
// (one request at a time, spaced per host, 429, cancel, TorBox's file names, the download's own reading).
// Nothing here reaches a real host. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
globalThis.__stubFiles = new Map();
const formats = await load('app/state/link-formats.js');
const { deduceFormat, effectiveFormat, formatFromContentType, formatFromDisposition, formatFromMagic, formatFromName, nameFromDisposition, pageReaderOf, readHostPage, reportFormat, onFormatReport } = formats;
const filters = await load('app/state/format-filter.js');
const { createFormatProbe, unknownLinks } = await load('app/state/format-probe.js');
const { sourceSections } = await load('app/game/sources.js');
const { releaseSets } = await load('app/state/release-sets.js');
const { createTorBox } = await load('app/services/torbox.js');
const { configure, t } = await load('app/i18n/core.js');
const en = JSON.parse(readFileSync(path.join(repo, 'app/i18n/locales/en.json'), 'utf8'));
configure(() => en, en);
const page = (name) => readFileSync(path.join(repo, 'tests/fixtures/host-pages', name), 'utf8');

// Links as the catalog (app/data/releases) lists them.
const catalogLink = (fields) => ({ id: `r${Math.random().toString(16).slice(2, 10)}`, format: 'binary', filename: 'PPSA01285-game-unknown-r1c34eca4275b.binary', sizeBytes: null, version: '', category: 'game', source: 'pegasus-0', requiresBrowser: true, label: 'EUR 4.03 Base', ...fields });
const MEDIAFIRE = catalogLink({ provider: 'MediaFire', flow: 'mediafire', url: 'https://www.mediafire.com/file/bjtizpldwyreiuy/[DLPSGAME.COM]+-+03.005+PPSA01285.part01.rar/file', browserUrl: 'https://www.mediafire.com/file/bjtizpldwyreiuy/[DLPSGAME.COM]+-+03.005+PPSA01285.part01.rar/file', archivePassword: 'DLPSGAME.COM' });
const RAPIDGATOR = catalogLink({ provider: 'rapidgator.net', flow: 'browser', url: 'https://rapidgator.net/file/0310dfe9a309ac1d9b26aa3cbcd904b7/PPSA02210-PS5.rar.html', browserUrl: 'https://rapidgator.net/file/0310dfe9a309ac1d9b26aa3cbcd904b7/PPSA02210-PS5.rar.html' });
const FICHIER = catalogLink({ provider: '1fichier.com', flow: 'browser', url: 'https://1fichier.com/?dnhw7qsrfbpobye29r8s', browserUrl: 'https://1fichier.com/?dnhw7qsrfbpobye29r8s' });
const FICHIER_PW = { ...FICHIER, id: 'rpw', archivePassword: 'DLPSGAME.COM' };
const VIKING = catalogLink({ provider: 'vikingfile', flow: 'vikingfile', url: 'https://vikingfile.com/f/jjeEUkyPki', browserUrl: 'https://vikingfile.com/f/jjeEUkyPki' });
const DATAVAULTS = catalogLink({ provider: 'datavaults.co', flow: 'browser', url: 'https://datavaults.co/ta62iyaam4jr', browserUrl: 'https://datavaults.co/ta62iyaam4jr', filename: 'PPSA01325-game-v01.905-rbaa238eb9a88.binary' });

test('names: real catalog links, archive volumes, Rapidgator\'s .html, the .binary placeholder', () => {
  assert.equal(deduceFormat(MEDIAFIRE), 'rar', 'MediaFire keeps the name before /file');
  assert.equal(deduceFormat(RAPIDGATOR), 'rar', 'PPSA02210-PS5.rar.html');
  assert.equal(deduceFormat(FICHIER), null, '1fichier\'s URL names nothing');
  assert.equal(deduceFormat(catalogLink({ url: 'https://archive.org/download/item/PPSA01234%20Game.exfat', provider: 'archive.org' })), 'exfat');
  const cases = { 'Game.ffpkg': 'ffpkg', 'Game.FFPFSC': 'ffpfsc', 'Game.ffpfs': 'ffpfs', 'PPSA01234.pkg': 'pkg', 'Game.part03.rar': 'rar', 'Game.7z.001': '7z', 'Game.zip.002': 'zip', 'Game.r00': 'rar', 'Game.z01': 'zip', 'Game.tar.gz': 'tar', 'Game.pkg.rar': 'rar', 'Game.binary': null, 'Game.bin': null, 'Game': null, '': null };
  for (const [name, format] of Object.entries(cases)) assert.equal(formatFromName(name), format, name);
  // A set's first part names the set; the set itself is an archive set by the catalog.
  const [set] = releaseSets([{ ...MEDIAFIRE, label: 'EUR 4.03 Base - Mediafire part 1', volume: 'part 1' }, { ...MEDIAFIRE, id: 'r2', url: MEDIAFIRE.url.replace('part01', 'part02'), browserUrl: MEDIAFIRE.url.replace('part01', 'part02'), label: 'EUR 4.03 Base - Mediafire part 2', volume: 'part 2' }]);
  assert.equal(set.format, 'archive-set');
  assert.deepEqual(effectiveFormat(set), { format: 'archive-set', how: 'catalog' });
});

test('effective format: catalog, then the name, then what was found, then an archive password', () => {
  const found = { [FICHIER.browserUrl]: { f: 'exfat', how: 'found' } };
  assert.deepEqual(effectiveFormat({ ...FICHIER, format: 'pkg' }), { format: 'pkg', how: 'catalog' });
  assert.deepEqual(effectiveFormat(MEDIAFIRE), { format: 'rar', how: 'name' }, 'the name before the password');
  assert.deepEqual(effectiveFormat(FICHIER, (key) => found[key]), { format: 'exfat', how: 'found' });
  assert.deepEqual(effectiveFormat(FICHIER_PW), { format: 'archive', how: 'password' });
  assert.deepEqual(effectiveFormat(FICHIER_PW, (key) => found[key]), { format: 'exfat', how: 'found' }, 'what was found before the guess');
  assert.deepEqual(effectiveFormat(FICHIER, () => ({ s: 'browser' })), { format: null, how: 'browser' });
  assert.deepEqual(effectiveFormat(FICHIER), { format: null, how: null });
});

test('Content-Disposition, Content-Type and first bytes', () => {
  assert.equal(nameFromDisposition(`attachment; filename*=UTF-8''PPSA01234%20Jogo%20%C3%A9pico.exfat`), 'PPSA01234 Jogo épico.exfat');
  assert.equal(formatFromDisposition(`attachment; filename="Game Backup.part1.rar"; filename*=UTF-8''Game%20Backup.part1.rar`), 'rar', 'filename* wins');
  assert.equal(formatFromDisposition('attachment; filename="Game.ffpkg"'), 'ffpkg');
  assert.equal(formatFromDisposition('attachment; filename=Game.7z'), '7z');
  assert.equal(formatFromDisposition('inline'), null);
  assert.equal(formatFromDisposition(undefined), null);
  assert.equal(formatFromContentType('application/x-7z-compressed'), '7z');
  assert.equal(formatFromContentType('application/vnd.rar; charset=binary'), 'rar');
  assert.equal(formatFromContentType('application/octet-stream'), null);
  const pad = (head, length = 64) => (head + '\0'.repeat(length)).slice(0, length);
  assert.equal(formatFromMagic(pad('Rar!\x1A\x07\x01\x00')), 'rar');
  assert.equal(formatFromMagic(pad('PK\x03\x04')), 'zip');
  assert.equal(formatFromMagic(pad('7z\xBC\xAF\x27\x1C')), '7z');
  assert.equal(formatFromMagic(pad('\x7FCNT')), 'pkg');
  assert.equal(formatFromMagic(pad('\x7FFIH')), 'pkg');
  assert.equal(formatFromMagic(pad('\x7FLIH')), 'pkg');
  assert.equal(formatFromMagic(pad('\xEB\x76\x90EXFAT   ')), 'exfat');
  assert.equal(formatFromMagic(pad('\x01\x00\x00\x00\x00\x00\x00\x00\x0B\x2A\x33\x01\x00\x00\x00\x00')), 'ffpfs', 'PFS: 20130315 LE at 8');
  assert.equal(formatFromMagic(pad('PFSC')), 'ffpfsc');
  assert.equal(formatFromMagic(pad('<!DOCTYPE html>')), null);
  assert.equal(formatFromMagic(''), null);
});

test('host pages: VikingFile, 1fichier, DataVaults, MediaFire; a gone file and a check say nothing', () => {
  assert.equal(pageReaderOf(VIKING.url), 'vikingfile');
  assert.equal(pageReaderOf(FICHIER.url), '1fichier');
  assert.equal(pageReaderOf(DATAVAULTS.url), 'xfs');
  assert.equal(pageReaderOf('https://filekeeper.net/0hg67hg34hlv'), 'xfs');
  assert.equal(pageReaderOf('https://gofile.io/d/aY3sL9'), null);
  assert.deepEqual(readHostPage('vikingfile', page('vikingfile.html')), { name: '[DLPSGAME.COM] - 03.005 PPSA01285.part01.rar', format: 'rar' });
  assert.deepEqual(readHostPage('1fichier', page('1fichier.html')), { name: 'Returnal PPSA01285 V03.000.004 EUR.rar', format: 'rar' });
  assert.deepEqual(readHostPage('xfs', page('datavaults.html')), { name: 'PPSA01325.exfat', format: 'exfat' });
  assert.deepEqual(readHostPage('mediafire', page('mediafire.html')), { name: 'PPSA01234-Game.part1.rar', format: 'rar' });
  assert.deepEqual(readHostPage('xfs', page('datanodes-gone.html')), { gone: true }, 'its placeholder "Download" is no name');
  assert.deepEqual(readHostPage('xfs', page('buzzheavier-challenge.html')), { check: true });
  assert.deepEqual(readHostPage('xfs', '<html><title>Download</title></html>'), {});
});

test('the filter: groups, several at once, unknown switch, the selected source kept, counts', () => {
  const { normalizeFilter, toggleKind, toggleUnknown, showAllKinds, passes, filterSections, isFiltering } = filters;
  let filter = normalizeFilter(undefined);
  assert.deepEqual(filter, { kinds: [], unknown: true });
  assert.equal(isFiltering(filter), false);
  filter = toggleKind(filter, 'image');
  assert.deepEqual(filter.kinds, ['image'], 'from All, the chip pressed is the only one');
  filter = toggleKind(filter, 'archive');
  assert.deepEqual(filter.kinds, ['image', 'archive']);
  assert.deepEqual(toggleKind(toggleKind(filter, 'pkg'), 'pkg').kinds, ['pkg'], 'from All again, the one pressed');
  assert.deepEqual(toggleKind(filter, 'pkg').kinds, [], 'all three is All');
  assert.deepEqual(toggleKind(toggleKind(filter, 'image'), 'archive').kinds, [], 'none left is All');
  assert.deepEqual(showAllKinds(filter).kinds, []);
  assert.equal(passes(filter, 'pkg'), false);
  assert.equal(passes(filter, null), true);
  assert.equal(passes(toggleUnknown(filter), null), false);
  const image = { id: 'i', provider: 'cdn.example.com', url: 'https://cdn.example.com/Game.exfat', format: 'exfat', label: 'USA' };
  const pkg = { id: 'p', provider: 'pkg.example', url: 'https://pkg.example/Game.pkg', format: 'pkg', label: 'USA' };
  const releases = [image, pkg, MEDIAFIRE, FICHIER, RAPIDGATOR];
  const sections = sourceSections(releases);
  const onlyImages = filterSections(sections, { kinds: ['image'], unknown: false }, { selected: 0 });
  assert.equal(onlyImages.shown, 1);
  assert.equal(onlyImages.hidden, 4);
  const keptSelected = filterSections(sections, { kinds: ['image'], unknown: false }, { selected: 1 });
  assert.ok(keptSelected.sections.some((section) => section.items.some(({ index }) => index === 1)), 'the selected package stays');
  assert.equal(keptSelected.hidden, 3);
  const archives = filterSections(sections, { kinds: ['archive'], unknown: true }, { selected: 2 });
  assert.equal(archives.hidden, 2, 'the image and the package');
  const order = (result) => result.sections.flatMap((section) => section.items.map(({ index }) => index));
  assert.deepEqual(order(archives), order({ sections }).filter((index) => index >= 2), 'order kept, only hidden');
  const found = filterSections(sections, { kinds: ['image'], unknown: false }, { selected: 0, recordOf: (key) => key === FICHIER.browserUrl ? { f: 'exfat', how: 'found' } : null });
  assert.equal(found.shown, 2, 'a found image counts as an image');
  const none = filterSections(sections, { kinds: ['pkg'], unknown: false }, { selected: -1 });
  assert.equal(none.shown, 1);
  const empty = filterSections(sourceSections([FICHIER]), { kinds: ['pkg'], unknown: false }, { selected: -1 });
  assert.deepEqual([empty.shown, empty.hidden], [0, 1], 'all hidden: the picker says so (formats.allHidden)');
});

test('the filter is saved in settings.json, the same for every game, and the default leaves no key', () => {
  const file = '/download0/JobeesLair/settings.json';
  globalThis.__stubFiles.set(file, JSON.stringify({ language: 'pt-BR', speedLimit: 10 }));
  filters.setFormatFilter({ kinds: ['image', 'pkg'], unknown: false });
  assert.deepEqual(JSON.parse(globalThis.__stubFiles.get(file)), { language: 'pt-BR', speedLimit: 10, linkFormats: { kinds: ['image', 'pkg'], unknown: false } });
  assert.deepEqual(filters.formatFilter(), { kinds: ['image', 'pkg'], unknown: false });
  filters.setFormatFilter(filters.DEFAULT_FORMAT_FILTER);
  assert.deepEqual(JSON.parse(globalThis.__stubFiles.get(file)), { language: 'pt-BR', speedLimit: 10 });
});

test('row names: the format and how it is known', () => {
  assert.equal(t('sources.kind.byName', { kind: t('sources.kind.archive') }), 'Archive (by name)');
  assert.equal(t('formats.find.summary', { image: 5, archive: 3, pkg: 0 }), '5 images · 3 archives · 0 packages');
  assert.equal(t('formats.hidden', { count: 1 }), '1 link hidden by the filter');
  assert.equal(t('formats.allHidden', { count: 4 }), 'The filter hides all 4 links of this game');
});

// A search on a clock that only moves when it waits; answers per URL (a status, or a response object).
function world({ table = {}, torbox = () => null, quiet, debridOn = () => false } = {}) {
  const state = { clock: 1e9, saved: null, calls: [], quiet: 0, inFlight: 0, most: 0 };
  const http = {
    async request(url, options) {
      state.calls.push({ url, at: state.clock, method: options.method, headers: options.headers, binary: options.binary, maxBytes: options.maxBytes });
      state.inFlight++;
      state.most = Math.max(state.most, state.inFlight);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        const answers = table[`${options.method} ${url}`] ?? table[url] ?? [404];
        const answer = answers.length > 1 ? answers.shift() : answers[0];
        if (answer === 'hang') return await new Promise((_, reject) => {
          if (options.signal.aborted) reject(new Error('cancelled'));
          options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
        });
        const response = typeof answer === 'number' ? { status: answer } : answer;
        return { status: response.status, ok: response.status < 300, url: response.url ?? url, headers: response.headers ?? {}, text: async () => response.body ?? '', bytes: async () => response.bytes ?? '' };
      } finally {
        state.inFlight--;
      }
    },
  };
  const probe = createFormatProbe({
    http,
    store: { get: () => state.saved, set: (value) => { state.saved = JSON.parse(JSON.stringify(value)); } },
    quiet: quiet ?? (async (reason, work) => { state.quiet++; try { return await work(); } finally { state.quiet--; } }),
    torbox,
    debridOn,
    now: () => state.clock,
    wait: async (ms) => { state.clock += ms; await new Promise((resolve) => setImmediate(resolve)); },
    timeout: () => () => {},
    log: () => {},
  });
  return { state, probe };
}
const fileLink = (id, url, fields = {}) => ({ id, provider: new URL(url).hostname, url, format: 'binary', filename: `${id}.binary`, label: 'USA', ...fields });

test('search: a file link\'s HEAD (Content-Disposition), then its first 64 bytes; host pages; the browser left alone', async () => {
  const A = 'https://cdn.example.com/get?id=1', B = 'https://cdn.example.com/get?id=2', C = 'https://files.example.net/blob/3';
  const { state, probe } = world({ table: {
    [`HEAD ${A}`]: [{ status: 200, headers: { 'content-disposition': `attachment; filename*=UTF-8''PPSA01234%20Game.exfat`, 'content-type': 'application/octet-stream' } }],
    [`HEAD ${B}`]: [{ status: 200, headers: { 'content-type': 'application/octet-stream' } }],
    [`GET ${B}`]: [{ status: 302, headers: { location: 'https://edge.example.com/blob/2' } }],
    'GET https://edge.example.com/blob/2': [{ status: 206, bytes: 'Rar!\x1A\x07\x01\x00' + '\0'.repeat(56) }],
    [`HEAD ${C}`]: [{ status: 200, headers: { 'content-type': 'text/html' } }],
    [`GET ${VIKING.url}`]: [{ status: 200, body: page('vikingfile.html') }],
    [`GET ${DATAVAULTS.url}`]: [{ status: 200, body: page('datavaults.html') }],
    [`GET ${FICHIER.url}`]: [{ status: 200, body: page('1fichier.html') }],
  } });
  const gofile = catalogLink({ provider: 'gofile.io', url: 'https://gofile.io/d/aY3sL9', browserUrl: 'https://gofile.io/d/aY3sL9' });
  const releases = [fileLink('a', A), fileLink('b', B), fileLink('c', C), VIKING, DATAVAULTS, FICHIER, gofile, MEDIAFIRE];
  assert.equal(probe.unknownLinks(releases).length, 7, 'MediaFire\'s name says rar already');
  const summary = await probe.discover('PPSA01234', releases);
  assert.deepEqual(summary, { image: 2, pkg: 0, archive: 3, browser: 1, none: 1, total: 7 });
  assert.equal(state.most, 1, 'one request at a time');
  assert.equal(state.quiet, 0, 'the download queue gets the network back');
  const range = state.calls.find((call) => call.url === B && call.method === 'GET');
  assert.deepEqual([range.headers.Range, range.binary], ['bytes=0-63', true]);
  assert.ok(!state.calls.some((call) => call.url.includes('gofile')), 'a browser-only host without a reader is not asked');
  assert.equal(probe.recordOf(A).f, 'exfat');
  assert.equal(probe.recordOf(B).f, 'rar');
  assert.equal(probe.recordOf(VIKING.url).f, 'rar');
  assert.equal(probe.recordOf(DATAVAULTS.url).f, 'exfat');
  assert.equal(probe.recordOf(FICHIER.url).f, 'rar');
  assert.equal(probe.recordOf(gofile.url).s, 'browser');
  assert.equal(probe.recordOf(C), null, 'a web page in place of the file: nothing learned');
  assert.equal(effectiveFormat(DATAVAULTS, probe.recordOf).how, 'found');
  assert.deepEqual(probe.progressOf('PPSA01234'), { state: 'done', done: 7, total: 7, summary, at: state.clock });
  probe.flush();
  assert.equal(state.saved.version, 1);
  assert.equal(state.saved.links[A].f, 'exfat');
  // Asked again: nothing left but the ones that did not answer.
  assert.deepEqual(probe.unknownLinks(releases).map((link) => link.key), [C]);
});

test('search: spaced per host, a 429 leaves the host alone, a cancel stops it and keeps what was found', async () => {
  const urls = [1, 2, 3, 4].map((n) => `https://cdn.example.com/f${n}`);
  const table = {};
  table[`HEAD ${urls[0]}`] = [{ status: 200, headers: { 'content-type': 'application/zip' } }];
  table[`HEAD ${urls[1]}`] = [{ status: 429, headers: { 'retry-after': '30' } }];
  const { state, probe } = world({ table });
  const summary = await probe.discover('G', urls.map((url, i) => fileLink(`f${i}`, url)));
  const heads = state.calls.filter((call) => call.method === 'HEAD');
  assert.equal(heads.length, 2, 'after the 429, the host is not asked again in this run');
  assert.ok(heads[1].at - heads[0].at >= 750, 'spaced per host');
  assert.deepEqual([summary.archive, summary.none], [1, 3]);
  // Cancel: the request in flight is aborted, the run ends, what was found stands.
  const slow = world({ table: { [`HEAD ${urls[0]}`]: [{ status: 200, headers: { 'content-type': 'application/zip' } }], [`HEAD https://other.example.org/x`]: ['hang'] } });
  const running = slow.probe.discover('H', [fileLink('a', urls[0]), fileLink('b', 'https://other.example.org/x'), fileLink('c', 'https://third.example.org/y')]);
  while (!slow.state.calls.some((call) => call.url.includes('other.example.org'))) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slow.probe.busy(), true);
  slow.probe.cancel('H');
  assert.equal(await running, null);
  assert.equal(slow.probe.progressOf('H').state, 'cancelled');
  assert.equal(slow.probe.recordOf(urls[0]).f, 'zip');
  assert.ok(!slow.state.calls.some((call) => call.url.includes('third.example.org')));
});

test('search: TorBox\'s file names first, with a key; a magnet only through it', async () => {
  const MAGNET = 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=Game';
  const asked = [];
  const { state, probe } = world({ torbox: async (links) => { asked.push(...links); return new Map([[FICHIER.url, ['Game.ffpkg', 'readme.txt']], [MAGNET, ['PPSA01234/Game.exfat']]]); } });
  const summary = await probe.discover('T', [FICHIER, { id: 'm', provider: 'Torrent', url: MAGNET, format: 'binary', label: 'USA' }]);
  assert.deepEqual(asked, [FICHIER.url, MAGNET]);
  assert.equal(summary.image, 2);
  assert.equal(state.calls.length, 0, 'no host asked');
  // The API call: checkcached with list_files, the largest file's name first.
  const calls = [];
  const api = createTorBox({ key: () => '0123abcd-4567-89ef-0123-456789abcdef', http: { async request(url) {
    calls.push(url);
    const hash = /hash=([^&]+)/.exec(url)[1].split('%2C')[0];
    const data = url.includes('/torrents/') ? { c12fe1c06bba254a9dc9f519b335aa7c1367a88a: { name: 'Game', files: [{ name: 'Game/readme.txt', size: 10 }, { name: 'Game/Game.exfat', size: 9e9 }] } } : { [hash]: { name: 'Returnal.rar', size: 6e10 } };
    return { status: 200, json: async () => ({ success: true, data }) };
  } } });
  const names = await api.cachedFiles([FICHIER.url, MAGNET]);
  assert.ok(calls.every((url) => /list_files=true/.test(url) && /format=object/.test(url)));
  assert.ok(calls.some((url) => url.includes('/webdl/checkcached')) && calls.some((url) => url.includes('/torrents/checkcached')));
  assert.deepEqual(names.get(FICHIER.url), ['Returnal.rar']);
  assert.deepEqual(names.get(MAGNET), ['Game/Game.exfat', 'Game/readme.txt', 'Game']);
});

test('a download\'s first bytes are kept for the source list (reportFormat)', () => {
  const { probe } = world();
  const off = onFormatReport((release, format) => probe.report(release, format));
  reportFormat(FICHIER, '7z');
  reportFormat(VIKING, 'tar.zst');
  reportFormat(DATAVAULTS, 'something');
  off();
  assert.deepEqual(effectiveFormat(FICHIER, probe.recordOf), { format: '7z', how: 'download' });
  assert.equal(probe.recordOf(VIKING.url).f, 'tar');
  assert.equal(probe.recordOf(DATAVAULTS.url), null);
  assert.equal(unknownLinks([FICHIER], probe.recordOf).length, 0);
});

// ---- glibren: TorBox after "needs the browser", the exact image type, Find via the browser ----
const FICHIER_GONE_BROWSER = { id: 'gb', provider: 'gofile.io', url: 'https://gofile.io/d/aY3sL9', browserUrl: 'https://gofile.io/d/aY3sL9', format: 'binary', filename: 'x.binary', requiresBrowser: true, label: 'USA' };
test('a "needs the browser" answer is asked of TorBox again once a key is set; the counts are what is known now', async () => {
  let key = false;
  const asked = [];
  const { probe } = world({ debridOn: () => key, torbox: async (links) => { if (!key) return null; asked.push(...links); return new Map([[FICHIER_GONE_BROWSER.url, ['Game.exfat']]]); } });
  // Without a key: gofile needs the browser, recorded so (with debrid: false) and not asked again.
  await probe.discover('K', [FICHIER_GONE_BROWSER]);
  assert.equal(probe.recordOf(FICHIER_GONE_BROWSER.url).s, 'browser');
  assert.equal(probe.recordOf(FICHIER_GONE_BROWSER.url).debrid, false);
  assert.equal(probe.unknownLinks([FICHIER_GONE_BROWSER]).length, 0, 'its week stands without a key');
  assert.deepEqual(probe.summaryOf([FICHIER_GONE_BROWSER]), { image: 0, pkg: 0, archive: 0, browser: 1 });
  // A key now: asked again, TorBox names the file, and the count says so at once.
  key = true;
  assert.equal(probe.unknownLinks([FICHIER_GONE_BROWSER]).length, 1, 'a key came since: TorBox may hold it');
  await probe.discover('K', [FICHIER_GONE_BROWSER]);
  assert.deepEqual(asked, [FICHIER_GONE_BROWSER.url]);
  assert.equal(probe.recordOf(FICHIER_GONE_BROWSER.url).f, 'exfat');
  assert.deepEqual(probe.summaryOf([FICHIER_GONE_BROWSER]), { image: 1, pkg: 0, archive: 0, browser: 0 });
  // A browser answer given with a key is not asked again while it stands.
  const other = { ...FICHIER_GONE_BROWSER, id: 'o', url: 'https://gofile.io/d/other', browserUrl: 'https://gofile.io/d/other' };
  await probe.discover('K2', [other]);
  assert.equal(probe.recordOf(other.url).debrid, true);
  assert.equal(probe.unknownLinks([other]).length, 0);
});

test('a UFS2 image (.ffpkg) is told by its superblock 66 KiB in, asked only when the first bytes say nothing', async () => {
  const { UFS_MAGIC_AT, formatFromUfsMagic } = formats;
  assert.equal(formatFromUfsMagic('\x19\x01\x54\x19'), 'ffpkg');
  assert.equal(formatFromUfsMagic('\x00\x00\x00\x00'), null);
  const U = 'https://cdn.example.com/blob/u';
  const { state, probe } = world({ table: {
    [`HEAD ${U}`]: [{ status: 200, headers: { 'content-type': 'application/octet-stream' } }],
    [`GET ${U}`]: [{ status: 206, bytes: '\0'.repeat(64) }, { status: 206, bytes: '\x19\x01\x54\x19' }],
  } });
  await probe.discover('U', [fileLink('u', U)]);
  assert.equal(probe.recordOf(U).f, 'ffpkg');
  const ranges = state.calls.filter((call) => call.method === 'GET').map((call) => call.headers.Range);
  assert.deepEqual(ranges, ['bytes=0-63', `bytes=${UFS_MAGIC_AT}-${UFS_MAGIC_AT + 3}`]);
});

test('learn: a link captured through the browser, by its file name, else its first bytes; saved as found', async () => {
  const B = 'https://dl.example.com/x/abc';
  const { state, probe } = world({ table: { [`GET ${B}`]: [{ status: 206, bytes: 'Rar!\x1A\x07\x01\x00' + '\0'.repeat(56) }] } });
  assert.equal(await probe.learn(FICHIER, { url: 'https://cdn.example.com/PPSA01285.exfat', name: 'PPSA01285 Game.exfat' }), 'exfat');
  assert.deepEqual(effectiveFormat(FICHIER, probe.recordOf), { format: 'exfat', how: 'found' });
  assert.equal(state.calls.length, 0, 'the name said it');
  assert.equal(await probe.learn(VIKING, { url: B, name: '' }), 'rar');
  assert.equal(state.calls[0].headers.Range, 'bytes=0-63');
  assert.equal(await probe.learn(DATAVAULTS, { url: 'https://nothing.example/none', name: 'readme' }), null);
  assert.equal(probe.recordOf(DATAVAULTS.url), null);
});

test('image types: the filter picks exFAT, FFPKG or FFPFS (with FFPFSC); a filter saved before them reads as it did', () => {
  const { normalizeFilter, passes, toggleImageType, isFiltering } = filters;
  assert.deepEqual(normalizeFilter({ kinds: ['image'], unknown: true }), { kinds: ['image'], unknown: true }, 'no images key');
  const exfat = toggleImageType({ kinds: [], unknown: true }, 'exfat');
  assert.deepEqual(exfat.images, ['exfat']);
  assert.ok(isFiltering(exfat));
  assert.ok(passes(exfat, 'image', 'exfat'));
  assert.ok(!passes(exfat, 'image', 'ffpkg'));
  assert.ok(passes(exfat, 'archive', 'rar'), 'archives and packages go by their own chips');
  const pfs = toggleImageType(exfat, 'ffpfs');
  assert.ok(passes(pfs, 'image', 'ffpfsc'), 'FFPFSC goes with FFPFS');
  assert.deepEqual(toggleImageType(pfs, 'exfat').images, ['ffpfs']);
  assert.equal(toggleImageType(pfs, 'ffpkg').images, undefined, 'all three is every type');
  assert.equal(normalizeFilter({ images: ['exfat', 'ffpkg', 'ffpfs'] }).images, undefined, 'every type is no type');
  assert.ok(isFiltering({ kinds: ['pkg'], unknown: true, images: ['exfat'] }), 'packages only still filters');
});

test('the catalog calling a link an exFAT image names it so, after the file names (an archive of one stays an archive)', () => {
  const labelled = { ...FICHIER, dumpType: 'image', imageFormat: 'exfat' };
  assert.deepEqual(effectiveFormat(labelled), { format: 'exfat', how: 'name' });
  const archived = { ...MEDIAFIRE, dumpType: 'image', imageFormat: 'exfat' };
  assert.equal(effectiveFormat(archived).format, 'rar');
});

test('TorBox only: kept only when on; the links the service fetches stay, the selected one always, and they are counted', () => {
  const { normalizeFilter, toggleDebridOnly, isFiltering, filterSections: sectionsOf } = filters;
  assert.deepEqual(normalizeFilter({ kinds: [], unknown: true, debridOnly: false }), { kinds: [], unknown: true });
  const on = toggleDebridOnly({ kinds: [], unknown: true });
  assert.equal(on.debridOnly, true);
  assert.ok(isFiltering(on));
  const sections = sourceSections([FICHIER, VIKING, DATAVAULTS]);
  const fetched = (release) => release === VIKING;
  const kept = sectionsOf(sections, on, { selected: 0, debrid: fetched });
  const ids = kept.sections.flatMap(({ items }) => items.map(({ release }) => release.id));
  assert.deepEqual(ids.sort(), [FICHIER.id, VIKING.id].sort(), 'VikingFile through the service, 1fichier because it is selected');
  assert.equal(kept.viaDebrid, 1);
  assert.equal(kept.hidden, 1);
  const none = sectionsOf(sections, on, { selected: 0, debrid: () => false });
  assert.equal(none.viaDebrid, 0, 'a game with none says so');
});
