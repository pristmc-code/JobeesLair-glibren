// glibren.44 (fotos do PS5 real, .43, download "Dispatch" EXFAT · Vikingfile · via TorBox): o cartao de download.
//   1) um download que espera a proxima tentativa sozinho (HTTP 429/5xx) tem UM estado: secao AGUARDANDO, selo
//      ESPERANDO, quem esta ocupado ("TorBox busy (HTTP 429)" / "Vikingfile busy"), a hora e a contagem da tentativa, o
//      botao "Try now"; nao conta como "failed" (antes: PARADO + BAIXANDO + "1 falhou" + "Tentar novamente");
//   2) o TorBox preparando o arquivo antes do primeiro byte: "TorBox preparing the file: 40%" ou "Waiting for TorBox to
//      prepare the file" no lugar de "Downloading · 0%" parado;
//   3) nenhum texto do cartao cortado com "…": quebram em mais linhas e o cartao cresce.
// Run: npm run test:render
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.screen = { width: 1920, height: 1080 };
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const en = (await load('app/i18n/locales/en.json')).default;
(await load('app/i18n/core.js')).configure(() => en, en);
const GB = 1e9;

const styles = [];
function texts(element) {
  const out = [];
  styles.length = 0;
  (function walk(node) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const { type, props = {} } = node;
    if (typeof props.style === 'function') props.style({ focused: true, pressed: false });
    if (typeof type === 'function') return walk(type(props));
    if (type === 'Text') {
      styles.push(props.style);
      const children = [props.children].flat().filter((child) => typeof child === 'string' || typeof child === 'number');
      if (children.length) out.push(children.join(''));
      return;
    }
    walk(props.children);
  })(element);
  return out;
}
const fs = { exists: () => false, stat: () => null, readDir: () => [], readFile: () => { throw new Error('ENOENT'); }, writeFile() {}, mkdir() {}, rename() {}, remove() {}, removeAsync: async () => {}, diskUsage: () => ({ total: 2000 * GB, free: 900 * GB }) };
const LONG = 'Continues with the app closed. The download button beside Pause brings it back to the app, with everything it already has, and the payload stops it.';
const job = (extra) => ({ id: 'PPSA20001/r~torbox', gameId: 'PPSA20001', titleId: 'PPSA20001', title: 'Dispatch', role: 'game', release: { id: 'r~torbox', provider: 'Vikingfile', format: 'exfat', debrid: { service: 'torbox' } }, root: '/mnt/ext0', state: 'downloading', written: 0, total: 22.9 * GB, error: '', message: '', ...extra });
const waitingJob = job({ id: 'w1', state: 'failed', error: 'HTTP 429 from the server.', retryAt: Date.now() + 4 * 6e4 + 30e3 });
const hostJob = job({ id: 'w2', state: 'failed', error: 'HTTP 503', retryAt: Date.now() + 6e4, release: { id: 'r', provider: 'Vikingfile', format: 'exfat' } });
const failedJob = job({ id: 'f1', state: 'failed', error: 'HTTP 404 Not Found' });
globalThis.__fake = { os: 'ps5', jobs: [waitingJob, failedJob], fs, focused: true,
  queue: new Proxy({ snapshot: () => globalThis.__fake.jobs, subscribe: () => () => {}, quietNetwork: (reason, work) => work(), transferring: () => false, lendNetwork: () => null }, { get: (target, key) => key in target ? target[key] : () => Promise.resolve({}) }),
  drives: { roots: ['/data', '/mnt/ext0'], ready: true, usage: { '/data': { total: 667 * GB, free: 40 * GB }, '/mnt/ext0': { total: 2000 * GB, free: 900 * GB } } } };

const { DownloadCard } = await load('app/downloads/DownloadCard.jsx');
const card = (j) => texts({ type: DownloadCard.type ?? DownloadCard, props: { job: j, game: { title: j.title, art: {} }, autoFocus: false, run() {}, onOpenGame() {}, onFocusRow() {} } });
const noCut = (name) => {
  for (const style of styles.flat(Infinity)) assert.ok(!style || style.numberOfLines === undefined && style.ellipsizeMode === undefined, `${name}: a text is still cut (${JSON.stringify(style)})`);
};

// 1) esperando a proxima tentativa: um estado so.
const waiting = card(waitingJob);
console.log(`--- waiting\n${waiting.join('\n')}`);
assert.ok(waiting.includes('WAITING'), 'the chip');
assert.ok(!waiting.includes('DOWNLOADING') && !waiting.includes('Retry'), waiting.join('|'));
assert.ok(waiting.includes('Try now'), 'the button');
assert.ok(waiting.some((line) => /^TorBox busy \(HTTP 429\) · Tries again by itself at \d\d:\d\d \(in 4:[23]\d\)$/.test(line)), waiting.join('|'));
noCut('waiting');
const host = card(hostJob);
assert.ok(host.some((line) => /^Vikingfile busy \(HTTP 503\) · Tries again by itself at \d\d:\d\d \(in [01]:\d\d\)$/.test(line)), host.join('|'));
const failed = card(failedJob);
assert.ok(failed.includes('Choose another source') || failed.includes('Retry') || failed.some((line) => /another source/i.test(line)), failed.join('|'));
assert.ok(!failed.includes('WAITING'), 'a real failure is not waiting');

// 2) o TorBox preparando o arquivo antes do primeiro byte.
const preparing = card(job({ id: 'p1', state: 'resolving', preparing: { service: 'torbox', progress: 0.4 } }));
assert.ok(preparing.includes('TorBox preparing the file: 40%'), preparing.join('|'));
const unknown = card(job({ id: 'p2', state: 'resolving', preparing: { service: 'torbox', progress: null } }));
assert.ok(unknown.includes('Waiting for TorBox to prepare the file'), unknown.join('|'));
const zero = card(job({ id: 'p3', state: 'downloading' }));
assert.ok(zero.includes('Waiting for TorBox to prepare the file'), `0% through TorBox says why: ${zero.join('|')}`);
const plain = card(job({ id: 'p4', state: 'downloading', release: { id: 'r', provider: 'Vikingfile', format: 'exfat' } }));
assert.ok(!plain.some((line) => /prepar/.test(line)), 'a direct download says nothing about TorBox');

// glibren.55: o recurso mudou no servidor (b136/b139 no PS5): o cartao diz que o arquivo mudou, cita o botao que existe
// ("Restart from zero") e o oferece no lugar de "Retry", que so repetiria o erro.
const changed = card(job({ id: 'c1', state: 'failed', error: 'Downloads.enqueue /mnt/ext0/x.pkg: server changed the resource (ETag, Last-Modified or size differ)' }));
assert.ok(changed.includes('Restart from zero') && !changed.includes('Retry'), changed.join('|'));
assert.ok(changed.some((line) => line.includes(en['errors.fileChanged']) && line.includes('Press Restart from zero')), changed.join('|'));
const orphan = card(job({ id: 'c2', state: 'failed', error: 'partial file has no matching durable checkpoint; remove .part/.resume or choose another destination' }));
assert.ok(orphan.includes('Restart from zero') && !orphan.includes('Retry'), orphan.join('|'));
const busyAgain = card(job({ id: 'c3', state: 'failed', error: 'HTTP 404 Not Found' }));
assert.ok(!busyAgain.includes('Restart from zero'), 'other errors keep their own button');

// 3) textos longos quebram em vez de cortar.
const long = card(job({ id: 'l1', state: 'failed', error: `${LONG} ${LONG}` }));
assert.ok(long.some((line) => line.includes(LONG)), 'the whole text');
noCut('long');

// A tela: a secao AGUARDANDO e a contagem sem "failed" para quem espera.
const { DownloadsScreen } = await load('app/downloads/DownloadsScreen.jsx');
const screenTexts = texts({ type: DownloadsScreen, props: { onBack() {}, onOpenGame() {} } });
console.log(`--- screen\n${screenTexts.slice(0, 12).join('\n')}`);
assert.ok(screenTexts.some((l) => /^WAITING +1$/.test(l)) && screenTexts.some((l) => /^STOPPED +1$/.test(l)), screenTexts.join('|'));
// O resumo ao lado do titulo (um Text dentro de outro: o walker para no primeiro) e o painel ACTIVE/ON HOLD/FAILED.
const titleOf = (element) => {
  let found = null;
  (function walk(node) {
    if (found || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const { type, props = {} } = node;
    if (typeof type === 'function') return walk(type(props));
    if (type === 'Text' && [props.children].flat().some((child) => child === 'Downloads')) {
      found = [props.children].flat().map((child) => (typeof child === 'string' ? child : child?.props?.children ?? '')).join('');
      return;
    }
    walk(props.children);
  })(element);
  return found ?? '';
};
const screenEl = { type: DownloadsScreen, props: { onBack() {}, onOpenGame() {} } };
assert.match(titleOf(screenEl), /1 waiting · 1 failed/);
globalThis.__fake.jobs = [waitingJob];
const onlyWaiting = texts(screenEl);
assert.ok(!onlyWaiting.some((l) => /^STOPPED/.test(l)), onlyWaiting.join('|'));
assert.ok(!/failed/.test(titleOf(screenEl)), titleOf(screenEl));
console.log('OK: a download waiting on its own retry has one state; TorBox preparing says so; card texts wrap');
