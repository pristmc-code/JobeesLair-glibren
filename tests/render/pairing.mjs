// Pareamento por aparelho: o codigo na tela da Jobe (ui/PairCodeNotice.jsx) e "Aparelhos pareados" em Configuracoes >
// Downloads (ui/PairedDevicesRows.jsx). Desenha em en (o pt-BR e os outros 12 idiomas: tests/locales.test.mjs): o codigo em dois grupos ("123 456") com o nome do aparelho
// e os segundos que faltam, some quando vence; nenhum texto com reticencias ou corte (numberOfLines/ellipsizeMode); o
// aviso nao pega o foco (sem FocusScope nem focusKey). Run: npm run test:render
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.screen = { width: 1920, height: 1080 };
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const en = (await load('app/i18n/locales/en.json')).default;
const pt = (await load('app/i18n/locales/pt-BR.json')).default;
const core = await load('app/i18n/core.js');

// Os textos e os estilos de cada Text; os componentes de funcao sao chamados direto (como os outros testes de render).
function walk(element) {
  const out = { texts: [], styles: [], focus: 0 };
  (function go(node) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(go);
    const { type, props = {} } = node;
    if (props.focusKey || type === 'FocusScope' || type?.name === 'FocusScope') out.focus++;
    if (typeof props.style === 'function') props.style({ focused: true, pressed: false });
    if (typeof type === 'function') return go(type(props));
    if (type === 'Text') {
      const children = [props.children].flat().filter((child) => typeof child === 'string' || typeof child === 'number');
      if (children.length) { out.texts.push(children.join('')); out.styles.push(props.style || {}); }
      return;
    }
    go(props.children);
  })(element);
  return out;
}

const { PairCodeNotice } = await load('app/ui/PairCodeNotice.jsx');
const now = () => 1_000_000;
for (const [lang, messages] of [['en', en]]) { // a tela le o idioma pelo LocaleProvider (en aqui; os 14 idiomas: locales.test)
  core.configure(() => messages, en);
  const shown = walk({ type: PairCodeNotice, props: { state: { code: '048213', name: 'Celular do João', until: 1_000_000 + 87_400 }, now } });
  assert.ok(shown.texts.includes('048 213'), `${lang}: ${shown.texts.join('|')}`);
  const fill = (key, vars) => messages[key].replace(/\{(\w+)\}/g, (_, name) => vars[name]);
  assert.ok(shown.texts.includes(fill('pair.notice.title', { name: 'Celular do João' })), `${lang}: ${shown.texts.join('|')}`);
  assert.ok(shown.texts.includes(fill('pair.notice.detail', { seconds: '88' })), `${lang}: os segundos que faltam`);
  for (const style of shown.styles) assert.ok(!('numberOfLines' in style) && !('ellipsizeMode' in style), 'texto quebra linha, sem reticencias');
  assert.equal(shown.focus, 0, 'o aviso nao pega o foco');
  // Vencido ou sem codigo: nada.
  assert.deepEqual(walk({ type: PairCodeNotice, props: { state: { code: '048213', name: 'x', until: 999_000 }, now } }).texts, []);
  assert.deepEqual(walk({ type: PairCodeNotice, props: { state: { code: '', name: '', until: 0 }, now } }).texts, []);
}

// Configuracoes: a linha "Aparelhos pareados" desenha (o estado chega depois, pelo payload) e sem corte de texto.
const { PairedDevicesRows } = await load('app/ui/PairedDevicesRows.jsx');
const Switch = ({ on }) => ({ type: 'View', props: { children: on ? 'on' : 'off' } });
const rows = walk({ type: PairedDevicesRows, props: { Switch } });
assert.ok(rows.texts.includes(en['settings.devices']), rows.texts.join('|'));
for (const style of rows.styles) assert.ok(!('numberOfLines' in style) && !('ellipsizeMode' in style), 'linhas sem reticencias');
assert.ok(pt['pair.notice.title'].includes('{name}'));
console.log('OK: pairing code notice and the paired devices row');
