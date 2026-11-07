// glibren.14: o atalho R3 que troca a versão da loja (Completa <-> TorBox) de qualquer tela da loja: a troca e a
// volta (state/store-mode.js toggleStoreMode), sem biblioteca o motivo e a loja como estava; o glifo R3 no rodapé
// (ui/ButtonHints.jsx), a dica nas telas da loja (ui/Legend.jsx), o atalho ouvido no Header (ui/StoreKey.jsx) e a
// barra do topo do Discover de novo ao alcance do Cima (browse/Spotlight.jsx, HeroThumbs.jsx).
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const source = (rel) => readFileSync(path.join(repo, rel), 'utf8');
const LIST = '/download0/JobeesLair/torbox-lista.json';

test('R3: troca a loja para a TorBox e volta para a completa; sem biblioteca diz por que e não troca', async () => {
  const { games } = await load('app/data/catalog-index.js');
  const full = games.length;
  globalThis.__stubFiles = new Map();
  const mode = await load('app/state/store-mode.js');
  assert.equal(mode.storeMode(), 'full');
  // Nunca montada: o motivo, e a loja fica como estava.
  assert.deepEqual(mode.toggleStoreMode(), { ok: false, reason: 'never', mode: 'full', count: full });
  globalThis.__stubFiles.set(LIST, JSON.stringify({ version: 1, builtAt: 'x', games: [] }));
  assert.deepEqual(mode.toggleStoreMode(), { ok: false, reason: 'empty', mode: 'full', count: full });
  assert.equal(games.length, full);
  // Montada: R3 vai para a TorBox ...
  const ids = games.slice(0, 20).map((game) => game.id);
  globalThis.__stubFiles.set(LIST, JSON.stringify({ version: 1, builtAt: 'x', games: ids.map((id) => ({ id })) }));
  const before = mode.storeEpoch();
  const torbox = mode.toggleStoreMode();
  assert.equal(torbox.ok, true);
  assert.equal(torbox.mode, 'torbox');
  assert.equal(torbox.count, games.length);
  assert.ok(torbox.count >= ids.length && torbox.count < full, `${torbox.count} of ${full}`);
  assert.equal(mode.storeEpoch(), before + 1, 'the store is built again');
  assert.equal(JSON.parse(globalThis.__stubFiles.get('/download0/JobeesLair/settings.json')).storeMode, 'torbox', 'kept for the next launch');
  // ... e outro R3 volta para a completa.
  assert.deepEqual(mode.toggleStoreMode(), { ok: true, reason: '', mode: 'full', count: full });
  assert.equal(games.length, full);
  assert.equal(JSON.parse(globalThis.__stubFiles.get('/download0/JobeesLair/settings.json')).storeMode, 'full');
  delete globalThis.__stubFiles;
});

test('R3: o glifo, a dica no rodapé das telas da loja, o atalho no Header, e Cima do destaque volta para a barra', () => {
  assert.match(source('app/ui/ButtonHints.jsx'), /r3: \["R3"\]/, 'R3 drawn like L1/R1');
  const legend = source('app/ui/Legend.jsx');
  assert.match(legend, /STORE_KEY_SCREENS = \/\* @__PURE__ \*\/ new Set\(\["browse", "game", "search"\]\)/);
  assert.match(legend, /full: \{ button: "r3", label: "hints\.storeTorbox" \}, torbox: \{ button: "r3", label: "hints\.storeFull" \}/, 'the hint names the store R3 goes to');
  assert.match(legend, /hints: withStoreKey\(hints \?\? HINTS\[screen2\], screen2, mode\)/);
  const header = source('app/ui/Header.jsx');
  assert.match(header, /import \{ StoreKey \} from '\.\/StoreKey\.jsx';/);
  assert.match(header, /jsx\(StoreKey, \{\}\)/);
  const key = source('app/ui/StoreKey.jsx');
  assert.match(key, /useControllerEvents\(listening \?/, 'R3 is not an input action: it comes from the controller events');
  assert.match(key, /event\.type !== "press" \|\| event\.button !== "r3"/);
  // Nada mais no app usa R3.
  for (const file of ['app/companion/api.js', 'app/ui/haptics.js', 'app/game/ShotViewer.jsx']) assert.doesNotMatch(source(file), /"r3"/, file);
  // A barra do topo do Discover: Cima do destaque leva a ela (antes ia direto para a ilha e ela ficava sem alcance).
  const spotlight = source('app/browse/Spotlight.jsx');
  assert.equal((spotlight.match(/nextFocusUp: STORE_BAR_UP\(\)/g) ?? []).length, 2, 'View game and Favorite');
  assert.doesNotMatch(spotlight, /nextFocusUp: "nav:current"/);
  assert.match(source('app/browse/HeroThumbs.jsx'), /nextFocusUp: STORE_BAR_UP\(\)/);
  const bar = source('app/browse/StoreModeBar.jsx');
  assert.match(bar, /STORE_BAR_UP = \(\) => `storemode:\$\{storeMode\(\)\}`/);
  assert.match(bar, /nextFocusUp: "nav:current"/, 'Up from the bar goes to the island');
});

test('R3: as chaves novas traduzidas nos 13 idiomas além do inglês (não o inglês copiado)', () => {
  const dir = path.join(repo, 'app/i18n/locales');
  const en = JSON.parse(readFileSync(path.join(dir, 'en.json'), 'utf8'));
  for (const file of ['ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'pt-BR', 'ru', 'ur', 'zh-Hans']) {
    const messages = JSON.parse(readFileSync(path.join(dir, `${file}.json`), 'utf8'));
    for (const name of ['hints.storeTorbox', 'hints.storeFull', 'storeMode.switched', 'storeMode.cantSwitch']) {
      assert.ok(messages[name], `${file} ${name}`);
      assert.notEqual(messages[name], en[name], `${file} ${name} translated`);
      // Curtas: cabem no rodapé ao lado das outras dicas.
      if (name.startsWith('hints.')) assert.ok(messages[name].length <= 18, `${file} ${name}: ${messages[name]}`);
    }
  }
});
