// glibren.28: a tela congelou no PS5 (glibren.27) quando um download virou conversao para .exfat enquanto outra conversao
// do payload rodava (c16 convertendo, c17 na fila): "Cannot convert undefined or null to object" dentro da renderizacao.
// A causa: o botao da pagina do jogo (game/DownloadLabel.jsx) nao tinha entrada para "converting" e desestruturava
// undefined. Aqui: o botao em todos os estados da fila (e um desconhecido), a tela Downloads, a Pasta BACKUP e o
// contador com as duas conversoes como o payload as devolve agora (GET /convert e GET /backup, bg_convert.c), e o
// error boundary das telas (ui/ScreenGuard.jsx) trocando uma tela que falha por um aviso.
// Run: npm run test:render
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.screen = { width: 1920, height: 1080 };
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const en = (await load('app/i18n/locales/en.json')).default;
(await load('app/i18n/core.js')).configure(() => en, en);
const { games } = await load('app/data/catalog-index.js');
const { getGame } = await load('app/state/catalog.js');
const [horizon, walking] = games.slice(0, 60).map((game) => getGame(game.id)).filter(Boolean);
assert.ok(horizon && walking, 'two catalog games');
const GB = 1e9;
const nowS = Math.floor(Date.now() / 1e3);

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

// 1) O botao da pagina do jogo em todo estado que a fila tem, "converting" inclusive (antes: TypeError ao desenhar).
const { DownloadLabel, statusLine, DISABLED } = await load('app/game/DownloadLabel.jsx');
const { BUSY, COMPLETE } = await load('app/state/download-queue.js');
const states = [...new Set(['idle', 'unavailable', 'no-space', 'stale', 'refused', 'played', 'wontStart', 'finishing', 'converting', 'awaiting-browser', 'paused', 'failed', 'removing', ...BUSY, ...COMPLETE])];
for (const status of states) {
  const shown = texts({ type: DownloadLabel, props: { status, amount: '10%', dark: false } });
  assert.ok(shown.length && shown[0], `${status}: ${shown.join('|')}`);
  assert.ok(Array.isArray(statusLine(status, 0.1, 30)), status);
}
assert.deepEqual(texts({ type: DownloadLabel, props: { status: 'converting', amount: '', dark: false } }), ['Converting to EXFAT']);
assert.ok(DISABLED.includes('converting'), 'a conversion is not paused from the game page');
assert.ok(texts({ type: DownloadLabel, props: { status: 'some-new-state', amount: '', dark: false } }).length, 'a state it does not know yet still draws');

// 2) A fila e o payload naquele momento: Horizon (c16) convertendo e seguido de novo; The Walking Dead logo depois de
// queueConversion (total null, written 0, a mensagem "na fila"), e c17 na fila do payload.
const fs = { exists: () => false, stat: () => null, readDir: () => [], readFile: () => { throw new Error('ENOENT'); }, writeFile() {}, mkdir() {}, rename() {}, remove() {}, removeAsync: async () => {}, diskUsage: () => ({ total: 2000 * GB, free: 900 * GB }) };
const jobs = [
  { id: `${horizon.id}/r`, gameId: horizon.id, titleId: horizon.titleId || horizon.id, title: horizon.title, role: 'game', release: { id: 'r', provider: 'example.com' }, root: '/mnt/ext0', artifact: { format: '7z' }, state: 'converting', written: 5 * GB, total: 40 * GB, bytesPerSecond: 1e8, error: '', message: en['downloads.convert.running'], convert: { kind: 'archive', sources: ['/mnt/ext0/BACKUP/H/h.7z'], output: '/mnt/ext0/homebrew/PPSA00001.exfat' } },
  { id: `${walking.id}/feed-x~torbox`, gameId: walking.id, titleId: walking.titleId || walking.id, title: walking.title, role: 'game', requestedId: 'feed-x~torbox', release: { id: 'feed-x~torbox', provider: 'example.com', format: '7z', debrid: { service: 'torbox' } }, root: '/mnt/ext0', downloadDestination: '/mnt/ext0/BACKUP/W/w.7z', artifact: { format: '7z' }, state: 'converting', written: 0, total: null, bytesPerSecond: 0, error: '', message: en['downloads.convert.queued'], convert: { kind: 'archive', sources: ['/mnt/ext0/BACKUP/W/w.7z'], output: '/mnt/ext0/homebrew/PPSA38510.exfat' }, backupDir: '/mnt/ext0/BACKUP/W' },
];
globalThis.__fake = { os: 'ps5', jobs, fs, focused: true,
  queue: new Proxy({ snapshot: () => jobs, subscribe: () => () => {}, quietNetwork: (reason, work) => work(), transferring: () => false, lendNetwork: () => null }, { get: (target, key) => key in target ? target[key] : () => Promise.resolve({}) }),
  drives: { roots: ['/data', '/mnt/ext0'], ready: true, usage: { '/data': { total: 667 * GB, free: 40 * GB }, '/mnt/ext0': { total: 2000 * GB, free: 900 * GB } } } };
const full = (id, key, name, state, written, total, output) => ({ id, key, name, state, error: '', kind: 'archive', source: '', output, work: '', root: '/mnt/ext0', label: '', sources: [], passwords: [], imageBytes: 0, created: nowS, updated: nowS, written, total });
const { noteConversions, noteBackup } = await load('app/state/payload-conversions.js');
noteConversions([full('c16', jobs[0].id, horizon.title, 'converting', 5 * GB, 40 * GB, jobs[0].convert.output), full('c17', jobs[1].id, walking.title, 'queued', 0, 0, jobs[1].convert.output)]);
noteBackup({ totalBytes: 50 * GB, games: [
  { root: '/mnt/ext0', name: 'H', bytes: 40 * GB, files: 1, platform: 'ps5', code: 'PPSA00001', format: '7z', parts: 0, converted: '', conversion: { id: 'c16', state: 'converting', error: '', written: 5 * GB, total: 40 * GB } },
  { root: '/mnt/ext0', name: 'W', bytes: 10 * GB, files: 1, platform: 'ps5', code: 'PPSA38510', format: '7z', parts: 0, converted: '', conversion: { id: 'c17', state: 'queued', error: '', written: 0, total: 0 } },
] });
const { DownloadsScreen } = await load('app/downloads/DownloadsScreen.jsx');
const downloads = texts({ type: DownloadsScreen, props: { onBack() {}, onOpenGame() {} } });
assert.ok(downloads.includes(horizon.title) && downloads.includes(walking.title), downloads.join('|'));
assert.ok(downloads.includes(en['downloads.convert.queued']), 'the one waiting says so');
const { BackupSheet } = await load('app/downloads/BackupSheet.jsx');
const backup = texts({ type: BackupSheet, props: { onClose() {} } });
assert.ok(backup.some((text) => /12%/.test(text)), backup.join('|'));
const { DownloadsBadge } = await load('app/ui/DownloadsBadge.jsx');
texts({ type: DownloadsBadge, props: {} });

// 3) O error boundary: sem erro, a tela; com erro, o aviso (Voltar sai) no lugar dela.
const { ScreenGuard } = await load('app/ui/ScreenGuard.jsx');
const child = { type: 'Text', props: { children: 'the screen' } };
assert.deepEqual(texts(new ScreenGuard({ children: child }).render()), ['the screen']);
const broken = new ScreenGuard({ children: child });
let caught = null;
try {
  const missing = undefined;
  const { icon } = missing;
  caught = icon;
} catch (error) {
  caught = error;
}
broken.state = { ...broken.state, ...ScreenGuard.getDerivedStateFromError(caught) };
const notice = texts(broken.render());
assert.ok(notice.includes(en['app.screenFailed']), notice.join('|'));
console.log('OK: the conversion queue draws; a screen that fails shows a notice');
