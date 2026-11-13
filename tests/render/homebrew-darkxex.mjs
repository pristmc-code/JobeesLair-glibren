// glibren.48: o catalogo darkxex na aba Homebrew, desenhado: o selo "darkxex" no cartao, a lista de onde veio e o aviso
// de mesmo title ID na pagina do app, os creditos e a chave no fim da secao, e o cartao Homebrew em Configuracoes
// (ligado por padrao; desligado, nada do darkxex). Os textos novos nao tem numberOfLines (quebram a linha, sem
// reticencias). Run: npm run test:render
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.screen = { width: 1920, height: 1080 };
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
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

// A copia guardada do catalogo (o que refreshDarkxex grava), feita do feed real das fixtures.
const dx = await load('app/state/darkxex-catalog.js');
const feed = dx.parseDarkxexFeed(readFileSync(path.join(repo, 'tests/fixtures/darkxex/catalog-v1.sample.json'), 'utf8'));
files.set('/download0/JobeesLair/homebrew-darkxex.json', JSON.stringify({ version: 1, fetched: Date.now(), commit: feed.commit, apps: feed.apps }));

const texts = [];
const wrapped = [];
function walk(node) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(walk);
  const { type, props = {} } = node;
  const style = typeof props.style === 'function' ? props.style({ focused: true, pressed: false }) : props.style;
  if (typeof type === 'function') return walk(type(props));
  if (type === 'Text') {
    const children = [props.children].flat().filter((child) => typeof child === 'string' || typeof child === 'number');
    if (children.length) {
      const text = children.join('');
      texts.push(text);
      const flat = [style].flat(4).filter(Boolean);
      wrapped.push({ text, cut: flat.some((s) => s.numberOfLines || s.ellipsizeMode) });
    }
    return;
  }
  walk(props.children);
}
const draw = (element) => {
  texts.length = 0;
  wrapped.length = 0;
  walk(element);
  return texts.slice();
};
const whole = (text) => wrapped.filter((item) => item.text === text).every((item) => !item.cut);

const store = await load('app/state/homebrew-store.js');
const { HomebrewApp } = await load('app/homebrew/HomebrewApp.jsx');
const { HomebrewTile } = await load('app/homebrew/HomebrewTile.jsx');
const { HomebrewScreen } = await load('app/homebrew/HomebrewScreen.jsx');
const { SettingsScreen } = await load('app/ui/Settings.jsx');

assert.equal(store.darkxexCatalogOn(), true, 'ligado por padrao');
const index = store.homebrew().index;
assert.ok(index.darkxex && index.darkxex.added > 0, 'a copia guardada entrou na lista');

// O cartao de um app so do darkxex: o selo.
const subway = index.apps.find((app) => app.titleId === 'PPSA26370');
let shown = draw({ type: HomebrewTile, props: { app: subway, focusKey: 'hb:t' } });
assert.ok(shown.includes('darkxex'), shown.join('|'));

// A pagina de um app das duas listas: a lista de onde veio, sem reticencias.
const olise = store.homebrew().app('marice/oliseplayer');
shown = draw({ type: HomebrewApp, props: { id: olise.id, onBack() {} } });
assert.ok(shown.includes('Jobe (nexgen999) + darkxex'), shown.join('|'));
assert.ok(whole('Jobe (nexgen999) + darkxex'), 'a lista quebra a linha');

// Mesmo title ID, outro app: o aviso, inteiro.
const vita = index.apps.find((app) => app.repo.toLowerCase() === 'tsuramatsu1/vita3k-ps5');
shown = draw({ type: HomebrewApp, props: { id: vita.id, onBack() {} } });
const conflict = en['homebrew.conflict'].replace('{name}', 'Spider-Man: Edge of Time');
assert.ok(shown.includes(conflict), shown.join('|'));
assert.ok(whole(conflict));

// glibren.49: os apps que a .48 escondia aparecem, com a linha informativa inteira (Alembic esta no feed de exemplo).
const alembic = index.apps.find((app) => app.titleId === 'PPSA99594');
assert.ok(alembic, 'Alembic na aba');
shown = draw({ type: HomebrewApp, props: { id: alembic.id, onBack() {} } });
assert.ok(shown.includes(en['homebrew.notice.ownCopies']), shown.join('|'));
assert.ok(whole(en['homebrew.notice.ownCopies']), 'a linha informativa quebra sem reticencias');
assert.ok(!shown.includes(en['homebrew.notice.thirdPartyStore']), 'so a linha dele');

// A secao: a linha das listas, os creditos e a chave.
shown = draw({ type: HomebrewScreen, props: { onBack() {}, onOpenApp() {} } });
for (const text of [en['homebrew.listByBoth'], en['homebrew.creditsDarkxex'], en['settings.darkxex']]) {
  assert.ok(shown.includes(text), `${text} | ${shown.join('|')}`);
  assert.ok(whole(text), text);
}

// Configuracoes > Feeds: o cartao Homebrew, ligado, com os numeros; o texto inteiro.
shown = draw({ type: SettingsScreen, props: { onBack() {}, start: 'feeds' } });
assert.ok(shown.includes(en['settings.card.homebrew']), shown.join('|'));
const on = en['settings.darkxexOn'].replace('{added}', String(index.darkxex.added)).replace('{duplicates}', String(index.darkxex.duplicates));
assert.ok(shown.includes(on), shown.join('|'));
assert.ok(shown.join(' ').includes('darkxex/ps5-homebrew-catalog'), 'o texto explicativo');

// Desligada: a lista sem o darkxex, a chave e a configuracao dizem "Off".
await store.setDarkxexCatalog(false);
assert.equal(store.homebrew().app(subway.id), null);
assert.ok(!store.homebrew().index.apps.some((app) => app.sources?.includes('darkxex')));
assert.equal(JSON.parse(files.get('/download0/JobeesLair/settings.json')).homebrewDarkxex, false);
shown = draw({ type: SettingsScreen, props: { onBack() {}, start: 'feeds' } });
assert.ok(shown.includes(en['settings.darkxexOff']), shown.join('|'));
await store.setDarkxexCatalog(true);
assert.ok(store.homebrew().index.apps.some((app) => app.sources?.includes('darkxex')));
console.log('OK: darkxex catalog in the Homebrew section (badge, list, title ID warning, credits, switch on and off)');
