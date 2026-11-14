// glibren.57 (abertura minima): desenha a abertura (ui/Opening.jsx) e o que saiu dela. Com a chave ligada: a abertura nao
// tem nenhum texto nem botao (nada de "OK (10)"); o aviso de queda nao abre por cima (ui/CrashNotice.jsx vazio) e fica em
// Configuracoes > Sobre na linha do diagnostico (ui/DiagnosticsRow.jsx) com a marca amarela ATE o jogador apertar "Ver
// detalhes" (decisao do usuario 13/11: sair de Sobre nao apaga); as novidades ficam em Sobre ("O que mudou na versao X").
// Run: npm run test:render
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

globalThis.screen = { width: 1920, height: 1080 };
globalThis.__stubFiles = new Map();
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const en = (await load('app/i18n/locales/en.json')).default;
const core = await load('app/i18n/core.js');
core.configure(() => en, en);

// Desenha a arvore chamando os componentes; junta os textos, os rotulos e as linhas (Row) com as props.
function draw(element) {
  const out = { texts: [], labels: [], rows: [], amber: 0 };
  (function walk(node) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const { type, props = {} } = node;
    if (typeof props.style === 'function') props.style({ focused: true, pressed: false });
    if (typeof props.label === 'string') out.labels.push(props.label);
    if (props.style?.backgroundColor === '#fbbf24') out.amber++;
    if (type === Row) { out.rows.push(props); walk(props.end); return; }
    if (typeof type === 'function') return walk(type(props));
    if (type === 'Text') {
      const children = [props.children].flat().filter((child) => typeof child === 'string' || typeof child === 'number');
      if (children.length) out.texts.push(children.join(''));
      return;
    }
    walk(props.children);
  })(element);
  return out;
}
function Row() { return null; }
function Callout() { return null; }

const opening = await load('app/state/opening.js');
opening.resetOpening();
assert.equal(opening.minimalOpening(), true, 'ligada por padrao');

// 1) A abertura: so o logo e o anel; nenhum texto, nenhum botao, nenhum OK com contagem.
const { Opening, DOTS } = await load('app/ui/Opening.jsx');
for (const leaving of [false, true]) {
  const shown = draw({ type: Opening, props: { leaving } });
  assert.deepEqual(shown.texts, [], `sem texto (leaving=${leaving})`);
  assert.deepEqual(shown.labels, [], `sem botao (leaving=${leaving})`);
}
assert.equal(DOTS, 12);

// 2) Uma queda pendente com a chave ligada: o aviso nao abre por cima.
const notice = await load('app/state/crash-notice.js');
const { CrashNotice } = await load('app/ui/CrashNotice.jsx');
const crash = { id: '1762890000', lastTime: '2026-11-11 14:32:05', activity: 'convert', name: 'Astro Bot', milestone: 'escrita do exFAT: 3.20 GB de 7.80 GB',
  lines: ['2026-11-11 14:31:40 conversao c3 inicio: Astro Bot'] };
notice.resetCrashNotice();
await notice.checkCrash(async () => crash);
assert.ok(notice.pendingCrash(), 'a queda esta pendente');
let shown = draw({ type: CrashNotice, props: {} });
assert.deepEqual(shown.texts, [], 'nenhum aviso por cima');
assert.ok(!shown.labels.some((label) => /\(\d+\)/.test(label)), 'nenhum "OK (10)"');

// 3) Em Configuracoes > Sobre: a linha do diagnostico diz a queda, com a marca amarela e "See details".
const { DiagnosticsRow } = await load('app/ui/DiagnosticsRow.jsx');
const about = () => draw({ type: DiagnosticsRow, props: { Row, Callout } });
shown = about();
const diag = shown.rows.find((row) => row.focusKey === 'settings:diagnostics');
assert.ok(diag.detail.includes('turned off at 14:32 during the conversion of Astro Bot'), diag.detail);
assert.equal(shown.amber, 1, 'a marca amarela');
const details = shown.rows.find((row) => row.focusKey === 'settings:crashDetails');
assert.equal(details?.name, en['crash.details']);

// 4) Sair de Sobre e voltar (desenhar de novo) NAO apaga a marca: so "See details" apaga.
shown = about();
assert.equal(shown.amber, 1, 'a marca continua depois de sair de Sobre');
assert.ok(notice.pendingCrash(), 'a queda segue pendente');
details.onPress();
assert.equal(notice.pendingCrash(), null, '"See details" marca a queda como vista');
shown = about();
assert.equal(shown.amber, 0, 'a marca saiu');
assert.equal(shown.rows.find((row) => row.focusKey === 'settings:crashDetails'), undefined);
assert.equal(await notice.checkCrash(async () => crash), null, 'a mesma queda nao volta');

// 5) As novidades e os termos ficam em Sobre; a chave fica em Aparencia.
const settings = fs.readFileSync(path.join(repo, 'app/ui/Settings.jsx'), 'utf8');
assert.match(settings, /jsx\(WhatsNewRow, \{\}\)/, 'O que mudou na versao X em Sobre');
assert.match(settings, /focusKey: "settings:terms"/, 'os termos em Sobre > aviso legal');
assert.match(settings, /jsx\(OpeningCard, \{\}, "opening"\)/, 'o cartao Abertura em Aparencia');
const whatsNew = await load('app/state/whats-new.js');
let opened = 0;
const off = whatsNew.onOpenWhatsNew(() => opened++);
assert.equal(whatsNew.openWhatsNew(), true);
assert.equal(opened, 1, 'a linha de Sobre abre o painel de novidades');
off();
for (const key of ['settings.card.opening', 'settings.opening.minimal', 'settings.whatsNew.row', 'settings.terms.row']) assert.ok(en[key], key);

console.log('opening render: ok');
