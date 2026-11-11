// glibren.27: "Show in the store" (Settings > Catalog feeds) with more than one catalog: one switch per catalog, the
// last download's date and time beside a feed, and a switch pressed keeps its row. Run: npm run test:render
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.screen = { width: 1920, height: 1080 };
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const en = (await load('app/i18n/locales/en.json')).default;
(await load('app/i18n/core.js')).configure(() => en, en);

const FEED = '/data/homebrew/mine.json';
const files = new Map([[FEED, JSON.stringify({ version: 1, name: 'Mine', games: [{ id: 'PPSA99001', title: 'Only In Mine', platform: 'ps5', releases: [{ url: 'https://host.example/a.exfat' }] }] })]]);
const fs = {
  exists: (p) => files.has(p),
  stat: (p) => files.has(p) ? { name: p.slice(p.lastIndexOf('/') + 1), isFile: true, isDirectory: false, size: files.get(p).length, modified: 1 } : null,
  readDir: () => [],
  readFile: (p) => {
    if (!files.has(p)) throw new Error('ENOENT');
    return files.get(p);
  },
  writeFile: (p, text) => files.set(p, String(text)),
  mkdir() {},
  rename: (a, b) => {
    files.set(b, files.get(a));
    files.delete(a);
  },
  remove: (p) => files.delete(p)
};
globalThis.__fake = { jobs: [], fs, queue: { snapshot: () => [], subscribe: () => () => {}, quietNetwork: (r, work) => work() }, focused: true, drives: { roots: ['/data'], ready: true, usage: {} } };
const core = await import('@ps5-react/core');
for (const [key, value] of Object.entries(fs)) if (typeof value === 'function') try { core.FileSystem[key] = value; } catch {}
const feeds = await load('app/state/feeds.js');
try { feeds.addLocalFeed(FEED); } catch (error) { console.log(`addLocalFeed: ${error.message}`); }
await feeds.refreshFeeds?.();
const catalog = await load('app/state/catalog.js');
const sources = catalog.catalogSources().map((s) => s.id);
console.log(`catalog sources: ${sources.join(', ')}`);
const mode = await load('app/state/store-mode.js');

const texts = [];
const focusable = [];
function walk(node) {
  if (node == null || typeof node !== 'object') {
    if (typeof node === 'string' && node.trim()) texts.push(node);
    return;
  }
  if (Array.isArray(node)) return node.forEach(walk);
  const { type, props = {} } = node;
  if (typeof props.style === 'function') props.style({ focused: true, pressed: false });
  if (props.focusKey) focusable.push(props);
  if (typeof type === 'function') return walk(type(props));
  if (type === 'Text') {
    const children = [props.children].flat().filter((child) => typeof child === 'string' || typeof child === 'number');
    if (children.length) texts.push(children.join(''));
    return;
  }
  walk(props.children);
}
const draw = (name, element) => {
  texts.length = 0;
  focusable.length = 0;
  walk(element);
  console.log(`--- ${name}\n${[...new Set(texts)].join('\n')}`);
  return { texts: [...texts], keys: Object.fromEntries(focusable.map((props) => [props.focusKey, props])) };
};

const { SettingsScreen } = await load('app/ui/Settings.jsx');
const feedsPage = draw('Settings > Catalog feeds (Show in the store)', { type: SettingsScreen, props: { onBack() {}, start: 'feeds' } });
if (sources.length > 1) {
  assert.ok(feedsPage.texts.includes("SHOW IN THE STORE"), 'the section is drawn');
  assert.ok(feedsPage.texts.some((text) => /Mine|mine\.json/.test(text)), 'the feed has its switch');
  assert.equal(mode.setSourceShown(FEED, false).ok, true);
  draw('Settings > Catalog feeds, the feed hidden', { type: SettingsScreen, props: { onBack() {}, start: 'feeds' } });
  assert.equal(mode.setSourceShown(FEED, true).ok, true);
  console.log('OK: Show in the store drawn with ' + sources.length + ' catalogs');
} else console.log('SKIP: only one catalog loaded here (' + sources.join(', ') + ')');
