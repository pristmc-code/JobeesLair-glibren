// glibren: the source list with the format filter and "Find formats" (state/format-filter.js, format-probe.js):
// each row's format and how it is known, the filter's row, what it hides (never the selected source) and a game
// it would empty. Run: npm run test:render
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.screen = { width: 1920, height: 1080 };
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const en = (await load('app/i18n/locales/en.json')).default;
(await load('app/i18n/core.js')).configure(() => en, en);

const FICHIER = 'https://1fichier.com/?dnhw7qsrfbpobye29r8s';
const GOFILE = 'https://gofile.io/d/aY3sL9';
const now = Date.now();
const files = new Map([
  ['/download0/JobeesLair/link-formats.json', JSON.stringify({ version: 1, links: { [FICHIER]: { f: 'exfat', how: 'found', at: now } } })],
]);
const fs = {
  exists: (p) => files.has(p), stat: (p) => files.has(p) ? { isFile: true, size: files.get(p).length } : null,
  readFile: (p) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
  readDir: () => [], writeFile: (p, text) => files.set(p, String(text)), mkdir() {}, rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); }, remove() {}, diskUsage: () => ({ free: 1e12, total: 2e12 }),
};
globalThis.__fake = { os: 'ps5', fs, arms: [], exits: [], jobs: [], focused: false,
  queue: { snapshot: () => [], subscribe: () => () => {}, lendNetwork: () => null, transferring: () => false, quietNetwork: (r, work) => work() },
  drives: { roots: ['/data'], ready: true, usage: { '/data': { free: 1e12, total: 2e12 } } } };

const { withReleaseTypes } = await load('app/state/release-sets.js');
const hosted = (id, provider, url, extra = {}) => ({ id, provider, url, browserUrl: url, format: 'binary', filename: `PPSA01285-game-unknown-${id}.binary`, requiresBrowser: true, sizeBytes: null, label: `EUR 4.03 Base - ${provider}`, ...extra });
const catalog = withReleaseTypes([
  { id: 'img', provider: 'cdn.example.com', url: 'https://cdn.example.com/Game.exfat', format: 'exfat', filename: 'Game.exfat', sizeBytes: 30e9, label: 'USA Base (v01.00) - Direct' },
  { id: 'pkg', provider: 'pkg.example', url: 'https://pkg.example/PPSA01285.pkg', format: 'pkg', filename: 'PPSA01285.pkg', sizeBytes: 30e9, label: 'USA Base (v01.00) - Direct' },
  hosted('mf', 'mediafire', 'https://www.mediafire.com/file/bjtizpldwyreiuy/PPSA01285.rar/file', { label: 'EUR 4.03 Base - Mediafire' }),
  hosted('fi', '1fichier.com', FICHIER),
  hosted('go', 'gofile.io', GOFILE),
  hosted('pw', 'vikingfile', 'https://vikingfile.com/f/jjeEUkyPki', { archivePassword: 'DLPSGAME.COM' }),
], 'ps5');

function texts(element) {
  const out = [];
  (function walk(node) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const { type, props = {} } = node;
    if (typeof props.style === 'function') props.style({ focused: false, pressed: false });
    if (typeof type === 'function') return walk(type(props));
    if (type === 'Text') {
      const children = [props.children].flat().filter((child) => typeof child === 'string' || typeof child === 'number');
      if (children.length) out.push(children.join(''));
      return;
    }
    walk(props.children);
  })(element);
  return out;
}
const { SourcePicker } = await load('app/game/SourcePicker.jsx');
const { setFormatFilter, DEFAULT_FORMAT_FILTER } = await load('app/state/format-filter.js');
const sheet = (selected = 0, releases = catalog) => texts({ type: SourcePicker, props: { title: 'Returnal', releases, selected, submit() {}, current: 'PPSA01285', onClose() {}, checkLinks: async () => {} } });

const all = sheet(3);
console.log(`--- source list, no filter\n${all.join('\n')}`);
for (const chip of ['Show formats', 'All', 'Image', 'PKG', 'Archive', 'Unknown format: shown']) assert.ok(all.includes(chip), chip);
assert.ok(all.some((text) => text.startsWith('exFAT image (found)')), 'the 1fichier link TorBox or its page named');
assert.ok(all.some((text) => text.startsWith('RAR archive (by name)')), 'MediaFire\'s URL names a .rar');
assert.ok(all.some((text) => text.startsWith('Archive (likely)')), 'an archive password');
assert.ok(all.some((text) => text.startsWith('Format unknown until downloaded')), 'gofile says nothing');
assert.ok(!all.some((text) => /hidden by the filter/.test(text)));
assert.ok(all.includes('Find formats') && all.includes('Asks what 2 links hold, without downloading them.'), 'gofile and the guessed archive');

// Only images, unknown hidden: the selected package stays, the rest is counted and can be shown.
setFormatFilter({ kinds: ['image'], unknown: false });
const images = sheet(1);
console.log(`--- source list, images only (the package selected)\n${images.join('\n')}`);
assert.ok(images.some((text) => text.startsWith('Package')), 'the selected source is never hidden');
assert.ok(images.some((text) => /^Show 1 web browser source/.test(text)), 'only the found image among the browser sources');
assert.ok(!images.some((text) => /\(by name\)|\(likely\)|until downloaded/.test(text)));
assert.ok(images.includes('3 links hidden by the filter') && images.includes('Show all'));
assert.ok(images.includes('Unknown format: hidden'));

// A game with nothing the filter wants: its selected source stays (so it never looks empty), and the rest is
// counted. (formats.allHidden, "The filter hides all N links", is for a list whose selected source is not among
// the filtered groups; tests/link-formats.test.mjs counts that case.)
setFormatFilter({ kinds: ['pkg'], unknown: false });
const emptied = sheet(0, catalog.slice(2, 5));
console.log(`--- source list, nothing the filter wants\n${emptied.join('\n')}`);
assert.ok(emptied.some((text) => text.startsWith('RAR archive (by name)')), 'the selected source stays');
assert.ok(emptied.includes('2 links hidden by the filter') && emptied.includes('Show all'), emptied.join(' | '));
setFormatFilter(DEFAULT_FORMAT_FILTER);
assert.ok(!files.get('/download0/JobeesLair/settings.json')?.includes('linkFormats'), 'the default leaves no key');
// glibren: image types, Find via the browser, the badges' row.
setFormatFilter(DEFAULT_FORMAT_FILTER);
const typed = sheet(3);
for (const chip of ['Image types', 'Every image', 'exFAT', 'FFPKG', 'FFPFS / FFPFSC']) assert.ok(typed.includes(chip), chip);
assert.ok(typed.some((text) => text.startsWith('exFAT image')), 'the exact image type in the name');
assert.ok(typed.includes('Find'), 'Find beside a link of no known format whose site needs the browser');
setFormatFilter({ kinds: ['image'], unknown: false, images: ['ffpkg'] });
const ffpkgOnly = sheet(3);
assert.ok(!ffpkgOnly.some((text) => /^exFAT image/.test(text) && !text.includes('found')) || ffpkgOnly.some((text) => /hidden by the filter/.test(text)), 'exFAT hidden with FFPKG only');
setFormatFilter(DEFAULT_FORMAT_FILTER);
const { findViaBrowser } = await load('app/state/links.js');
const gofile = catalog.find((release) => release.id === 'go');
assert.equal(await findViaBrowser(gofile, { title: 'Returnal', titleId: 'PPSA01285' }), null, 'no console browser in a test');
const after = sheet(3);
assert.ok(after.includes("Format not found: only on the PS5, it needs the console's browser"), after.join(' | '));
// The badges wrap within the text column: a style with flexWrap and the column's width, never unbounded.
const styles = [];
(function walk(node) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(walk);
  const { type, props = {} } = node;
  const style = typeof props.style === 'function' ? props.style({ focused: false }) : props.style;
  for (const each of [style].flat()) if (each && each.marginTop === 3 && each.flexDirection === 'row') styles.push(each);
  if (typeof type === 'function') return walk(type(props));
  walk(props.children);
})({ type: SourcePicker, props: { title: 'Returnal', releases: catalog, selected: 3, submit() {}, current: 'PPSA01285', onClose() {}, checkLinks: async () => {} } });
assert.ok(styles.length > 0 && styles.every((style) => style.flexWrap === 'wrap' && [220, 330, 450].includes(style.width)), JSON.stringify(styles));
console.log('OK: source list with the format filter and Find formats');
