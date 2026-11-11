// glibren (medidor de memoria): a linha "Memory" em Settings > About (ui/Settings.jsx MemoryRows, state/memory-meter.js).
// Com um host que mede: "now X MB · peak Y MB (in <action>)" e, aberta, as telas/acoes de maior pico, da maior para
// a menor, com os nomes traduzidos (YouTube para a tela do tube). Em portugues o mesmo texto. Sem medida: "Not measured".
// Run: npm run test:render
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.screen = { width: 1920, height: 1080 };
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const en = (await load('app/i18n/locales/en.json')).default;
const pt = (await load('app/i18n/locales/pt-BR.json')).default;
const core = await load('app/i18n/core.js');
core.configure(() => en, en);

function texts(element) {
  const out = [];
  (function walk(node) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const { type, props = {} } = node;
    if (typeof props.style === 'function') props.style({ focused: true, pressed: false });
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

const { MemoryRows, SettingsScreen } = await load('app/ui/Settings.jsx');

// 1) Sem DeviceInfo.memory (um ps5-react antigo): a linha diz que nao ha medida.
let shown = texts({ type: SettingsScreen, props: { onBack() {}, start: 'about' } });
assert.ok(shown.includes(en['settings.memory.row']), shown.join('|'));
assert.ok(shown.includes(en['settings.memory.none']), shown.join('|'));

// 2) Um host que mede (64 MB de limite): picos em acoes diferentes, a ultima amostra mais baixa.
const { DeviceInfo } = await import('@ps5-react/core');
const MB = 1024 * 1024;
let used = 0;
DeviceInfo.memory = () => ({ heapUsed: used, heapLimit: 64 * MB, processUsed: null, processSize: null, processPeak: null });
const meter = await load('app/state/memory-meter.js');
for (const [action, mb] of [['tela:browse', 12.5], ['loja:montar', 21.4], ['tela:tube', 17], ['biblioteca-torbox:gravar', 19.2], ['tela:game', 14]]) {
  used = Math.round(mb * MB);
  meter.memorySample(action);
}
used = Math.round(18.2 * MB); // a amostra que a linha tira ao abrir (na tela da vez)
meter.memoryScreen('settings');
shown = texts({ type: SettingsScreen, props: { onBack() {}, start: 'about' } });
assert.ok(shown.includes('now 18.2 MB · peak 21.4 MB (in Store built)'), shown.join('|'));

// 3) Aberta: as maiores, da maior para a menor, com os nomes de cada acao.
used = Math.round(18.2 * MB);
const open = texts({ type: MemoryRows, props: { startOpen: true } });
assert.ok(open.includes("The app's script memory, out of 64 MB. Press to see where it went."), open.join('|'));
assert.deepEqual(open.filter((line) => /^\d+\. /.test(line)), [
  '1. Store built: 21.4 MB',
  '2. TorBox library saved: 19.2 MB',
  '3. Screen settings: 18.2 MB',
  '4. YouTube: 17.0 MB',
  '5. Screen game: 14.0 MB',
  '6. Screen browse: 12.5 MB'
]);

// 4) Em portugues.
core.configure((code) => (code === 'pt-BR' ? pt : en), en);
core.setLocale('pt-BR');
const ptShown = texts({ type: MemoryRows, props: { startOpen: true } });
assert.ok(ptShown.some((line) => /^agora 18,2 MB · pico 21,4 MB \(em Loja montada\)$/.test(line)), ptShown.join('|'));
assert.ok(ptShown.includes('2. Biblioteca TorBox gravada: 19,2 MB'), ptShown.join('|'));
console.log('OK: Settings > About shows the memory now, its peak and the actions that used the most');
