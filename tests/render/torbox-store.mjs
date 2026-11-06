// glibren.9: a escolha da versão da loja no topo do Discover (browse/StoreModeBar.jsx) e o cartão Biblioteca TorBox
// em Configurações: desenhados sem exceção, a loja trocada pelo controle (o botão TorBox da barra), o aviso quando
// a biblioteca nunca foi montada (e o atalho para o botão de montar), e a volta para a loja completa.
// Run: npm run test:render
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.screen = { width: 1920, height: 1080 };
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
// O idioma da tela segue o do aparelho (aqui en-US): os textos conferidos são os em inglês.
const en = (await load('app/i18n/locales/en.json')).default;
(await load('app/i18n/core.js')).configure(() => en, en);

const files = new Map();
const fs = {
  exists: (p) => files.has(p),
  stat: () => null,
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

const { games } = await load('app/data/catalog-index.js');
const full = games.length;
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

const { StoreModeBar } = await load('app/browse/StoreModeBar.jsx');
const bar = draw('Barra da loja (biblioteca nunca montada)', { type: StoreModeBar, props: {} });
assert.ok(bar.texts.includes('STORE') && bar.texts.includes('Full') && bar.texts.includes('TorBox'), bar.texts.join('|'));
assert.deepEqual(Object.keys(bar.keys), ['storemode:full', 'storemode:torbox'], 'the two choices, reachable with the controller');
bar.keys['storemode:torbox'].onPress();
assert.equal(mode.storeMode(), 'full', 'no library: the store stays whole');
assert.equal(games.length, full);

// A lista gravada (o que a montagem escreve: state/torbox-library.js writeList).
const ids = games.slice(0, 30).map((game) => game.id);
files.set('/download0/JobeesLair/torbox-lista.json', JSON.stringify({ version: 1, builtAt: '2026-11-06T12:00:00.000Z', games: ids.map((id) => ({ id })) }));
const before = mode.storeEpoch();
draw('Barra da loja (com biblioteca)', { type: StoreModeBar, props: {} }).keys['storemode:torbox'].onPress();
assert.equal(mode.storeMode(), 'torbox', 'the TorBox button switches the store');
assert.equal(mode.storeEpoch(), before + 1, 'the store is built again');
assert.ok(games.length >= 30 && games.length < full, `${games.length} games`);
assert.equal(JSON.parse(files.get('/download0/JobeesLair/settings.json')).storeMode, 'torbox', 'kept for the next launch');
const after = draw('Barra da loja (loja TorBox)', { type: StoreModeBar, props: {} });
assert.ok(after.texts.includes(`TorBox · ${games.length}`), after.texts.join('|'));

const { BrowsePage } = await load('app/browse/BrowsePage.jsx');
const page = draw('Discover na loja TorBox', { type: BrowsePage, props: {} });
assert.ok(page.texts.includes('STORE'), 'the bar is at the top of Discover');

const { SettingsScreen } = await load('app/ui/Settings.jsx');
const settings = draw('Configurações > Biblioteca TorBox', { type: SettingsScreen, props: { onBack() {}, start: 'torboxLibrary' } });
for (const text of ['TorBox library', 'Build TorBox library', 'TorBox store', 'SOURCES', "Jobee'sLair catalog", 'Not built yet.']) assert.ok(settings.texts.includes(text), `${text}: ${settings.texts.join('|')}`);
assert.ok(settings.texts.includes('Add your TorBox API key first (Settings, Debrid providers).'), 'without a key it says so');
assert.ok(settings.keys['settings:tblib:build'] && settings.keys['settings:tblib:store'], 'the build button and the store switch');
settings.keys['settings:tblib:store'].onPress();
assert.equal(mode.storeMode(), 'full', 'the switch in Settings goes back to the full store');
assert.equal(games.length, full);
console.log(`OK: TorBox store bar and Settings card (${ids.length} confirmed ids)`);
