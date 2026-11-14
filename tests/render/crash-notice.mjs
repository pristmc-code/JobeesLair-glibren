// pac1: o aviso de queda (ui/CrashNotice.jsx, state/crash-notice.js) e a pausa entre conversoes na tela Downloads e em
// Configuracoes > Downloads. Desenha com o en e o pt-BR: o aviso com a hora e a atividade (conversao com a sugestao,
// download, nada), some depois do OK e nao volta para a mesma queda; a contagem "1:45" na tela Downloads; as tres opcoes
// da conversao em Configuracoes (desligadas por padrao).
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
const labels = (element) => {
  const out = [];
  (function walk(node) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const { type, props = {} } = node;
    if (typeof props.label === 'string') out.push(props.label);
    if (typeof type === 'function' && !/^Button/.test(type.name)) return walk(type(props));
    walk(props.children);
  })(element);
  return out;
};

// glibren.57: este teste e o aviso antigo (por cima da loja, com o OK de 10 s): so com a "Abertura minima" desligada
// (a ligada, o padrao, esta em tests/render/opening.mjs).
globalThis.__stubFiles ??= new Map();
(await load('app/state/opening.js')).setMinimalOpening(false);
const notice = await load('app/state/crash-notice.js');
const { CrashNotice } = await load('app/ui/CrashNotice.jsx');
const crash = { id: '1762890000', lastTime: '2026-11-11 14:32:05', activity: 'convert', name: 'Astro Bot', milestone: 'escrita do exFAT: 3.20 GB de 7.80 GB (85.0 MB/s)',
  lines: ['2026-11-11 14:31:40 conversao c3 [marco] inicio: Astro Bot', '2026-11-11 14:32:05 conversao c3 [marco] escrita do exFAT: 3.20 GB de 7.80 GB (85.0 MB/s)'] };

// 1) Sem queda: nada.
notice.resetCrashNotice();
assert.deepEqual(texts({ type: CrashNotice, props: {} }), []);

// 2) Queda durante uma conversao: hora, atividade, sugestao; "See details" e "OK".
await notice.checkCrash(async () => crash);
let shown = texts({ type: CrashNotice, props: {} });
assert.ok(shown.includes(en['crash.title']), shown.join('|'));
assert.ok(shown.some((line) => line.includes('turned off at 14:32 during the conversion of Astro Bot')), shown.join('|'));
assert.ok(shown.includes(en['crash.suggest']), 'during a conversion it suggests the conversion options');
const buttons = labels({ type: CrashNotice, props: {} });
// glibren.44: o OK mostra a contagem de 10 s (ui/useAutoDismiss.js): passa sozinho se ninguem apertar nada.
assert.ok(buttons.includes(`${en['crash.ok']} (10)`) && buttons.includes(en['crash.details']), buttons.join('|'));

// 3) Em portugues (o mesmo texto com as mesmas variaveis; a tela le o idioma pelo LocaleProvider).
const fillPt = (key, vars) => pt[key].replace(/\{(\w+)\}/g, (_, name) => vars[name]);
assert.equal(fillPt('crash.detail', { time: '14:32', activity: fillPt('crash.activity.convert', { name: 'Astro Bot' }) }), 'O console desligou às 14:32 durante a conversão de Astro Bot.');

// 4) OK: some e nao volta para a mesma queda; um download depois avisa sem a sugestao.
globalThis.__stubFiles = new Map();
notice.dismissCrash();
assert.deepEqual(texts({ type: CrashNotice, props: {} }), []);
assert.equal(await notice.checkCrash(async () => crash), null, 'the same crash is not told twice');
await notice.checkCrash(async () => ({ ...crash, id: '1762899999', activity: 'download', name: 'Gran Turismo 7', milestone: '' }));
shown = texts({ type: CrashNotice, props: {} });
assert.ok(shown.some((line) => line.includes('during the download of Gran Turismo 7')), shown.join('|'));
assert.ok(!shown.includes(en['crash.suggest']));
notice.dismissCrash();
await notice.checkCrash(async () => ({ ...crash, id: '1762899998', activity: 'none', name: '', milestone: '', lastTime: '', lines: ['(epoch 1762899990) FATAL: SIGSEGV no bg-downloader; o processo vai morrer'] }));
shown = texts({ type: CrashNotice, props: {} });
assert.ok(shown.includes('The console turned off during no background work.'), shown.join('|'));
assert.ok(labels({ type: CrashNotice, props: {} }).includes(en['crash.details']), 'glibren.60: the FATAL line to detail');
notice.dismissCrash();
delete globalThis.__stubFiles;

// 5) A pausa entre conversoes na tela Downloads: "the next one starts in 1:45".
globalThis.__fake = { os: 'ps5', jobs: [], fs: { exists: () => false, stat: () => null, readDir: () => [], readFile: () => { throw new Error('ENOENT'); }, writeFile() {}, mkdir() {}, rename() {}, remove() {}, removeAsync: async () => {}, diskUsage: () => ({ total: 1e12, free: 5e11 }) }, focused: true,
  queue: new Proxy({ snapshot: () => [], subscribe: () => () => {}, quietNetwork: (reason, work) => work(), transferring: () => false, lendNetwork: () => null }, { get: (target, key) => key in target ? target[key] : () => Promise.resolve({}) }),
  drives: { roots: ['/data'], ready: true, usage: { '/data': { total: 667e9, free: 40e9 } } } };
const conv = await load('app/state/payload-conversions.js');
const nowS = Math.floor(Date.now() / 1e3);
conv.noteConversions([{ id: 'c2', key: 'x', name: 'Astro Bot', state: 'queued', error: '', output: '/data/homebrew/PPSA01234.exfat', label: '', written: 0, total: 0, updated: nowS }]);
conv.noteConversionWait(105);
const { DownloadsScreen } = await load('app/downloads/DownloadsScreen.jsx');
const downloads = texts({ type: DownloadsScreen, props: { onBack() {}, onOpenGame() {} } });
assert.ok(downloads.some((line) => /^Pause between conversions: the next one starts in 1:4[45]$/.test(line)), downloads.join('|'));
conv.noteConversionWait(0);
assert.ok(!texts({ type: DownloadsScreen, props: { onBack() {}, onOpenGame() {} } }).some((line) => line.startsWith('Pause between conversions')), 'no wait, no line');

// 6) Configuracoes > Downloads: as tres opcoes da conversao (com "Convert to EXFAT" ligada), desligadas por padrao.
const { SettingsScreen } = await load('app/ui/Settings.jsx');
const settings = texts({ type: SettingsScreen, props: { onBack() {}, start: 'downloads' } });
for (const key of ['settings.convertPause', 'settings.convertWrite', 'settings.convertSync']) assert.ok(settings.includes(en[key]), `${key}: ${settings.join('|')}`);
assert.ok(settings.includes('256 MB') && settings.includes('120 s') && settings.includes('50 MB/s'), 'the choices');
console.log('OK: the crash notice tells once per crash; the pause between conversions and the conversion options draw');
