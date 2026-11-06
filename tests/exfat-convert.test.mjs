// glibren.12: a conversao dos jogos de PS5 para .exfat na fila (app/state/download-queue.js + exfat-convert.js), com
// um sistema de arquivos em memoria, um motor de download falso, um extrator falso e um conversor falso (o payload real
// e testado em bg-convert.test.mjs). Testa: para onde cada download vai (formato, PS5/PS4, opcao ligada/desligada), o
// original no BACKUP, a conversao direta do compactado, a volta para extrair (not-direct), PS4 nunca convertido (.pkg em
// PS4/, inclusive o de dentro de um RAR), erro e recuperacao (Tentar de novo / Usar sem converter), espaco no inicio,
// reabrir o app no meio e cancelar. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const { createDownloadQueue } = await load('app/state/download-queue.js');
const convert = await load('app/state/exfat-convert.js');
const { stillNeeded } = await load('app/state/space.js');
const { configure } = await load('app/i18n/core.js');
const { DownloadFormats } = await load('ps5-react/runtime/js/download-formats.js');
const en = JSON.parse(readFileSync(path.join(repo, 'app/i18n/locales/en.json'), 'utf8'));
configure(() => en, en);
const GB = 1e9;

function memoryFs() {
  const nodes = new Map([['/', { dir: true, inode: 1 }]]);
  let inode = 2;
  const name = (p) => p.slice(p.lastIndexOf('/') + 1);
  const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const fs = {
    nodes,
    free: 1e12,
    stat(p) {
      const n = nodes.get(p);
      return n ? { name: name(p), isDirectory: !!n.dir, isFile: !n.dir, size: n.dir ? 0 : n.size, modified: 0, device: '1', inode: String(n.inode) } : null;
    },
    exists: (p) => nodes.has(p),
    mkdir(p) {
      let at = '';
      for (const part of p.split('/').filter(Boolean)) {
        at += `/${part}`;
        if (!nodes.has(at)) nodes.set(at, { dir: true, inode: inode++ });
      }
    },
    file(p, size, text) {
      fs.mkdir(parent(p));
      nodes.set(p, { size: text === undefined ? size : Buffer.byteLength(text), text, inode: inode++ });
    },
    readFile(p) {
      const n = nodes.get(p);
      if (!n || n.dir) throw new Error(`ENOENT ${p}`);
      return n.text ?? '';
    },
    writeFile(p, text) { fs.file(p, 0, text); },
    readDir(p) {
      if (!nodes.get(p)?.dir) throw new Error(`ENOENT ${p}`);
      return [...nodes.keys()].filter((k) => k !== p && parent(k) === p).map((k) => fs.stat(k));
    },
    rename(a, b) {
      if (!nodes.has(a)) throw new Error(`ENOENT ${a}`);
      fs.mkdir(parent(b));
      nodes.delete(b);
      for (const k of [...nodes.keys()]) {
        if (k === a || k.startsWith(`${a}/`)) {
          nodes.set(b + k.slice(a.length), nodes.get(k));
          nodes.delete(k);
        }
      }
    },
    remove(p) { nodes.delete(p); },
    async removeAsync(p) { for (const k of [...nodes.keys()]) if (k === p || k.startsWith(`${p}/`)) nodes.delete(k); },
    diskUsage: () => ({ total: 1e13, free: fs.free }),
    mounts: () => [],
  };
  fs.mkdir('/data');
  return fs;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function engine(fs) {
  const requests = [];
  return {
    requests,
    enqueue(options) {
      requests.push(options);
      const done = tick().then(() => {
        const size = options.expectedBytes ?? 1000;
        fs.remove(`${options.destination}.part`);
        fs.file(options.destination, size);
        fs.file(`${options.destination}.complete`, 0, 'receipt');
        return { written: size, total: size };
      });
      return { subscribe: () => () => {}, done, cancel() {} };
    },
  };
}
// O extrator falso: `produce(options)` grava o que o arquivo "tinha" e devolve os artifacts (imagens e pacotes).
function extractor(fs, produce) {
  const started = [];
  return {
    started,
    streams: false,
    inspect: ([p]) => ({ kind: /\.zip$/.test(p) ? 'zip' : /\.rar$/.test(p) ? 'rar' : /\.7z$/.test(p) ? '7z' : null }),
    extract(options) {
      started.push(options);
      const done = tick().then(() => {
        fs.mkdir(options.destination);
        return { artifacts: produce(options) };
      });
      return { subscribe: () => () => {}, done, cancel() {} };
    },
  };
}
const gameIn = (fs, folder, code = 'PPSA01234') => {
  fs.file(`${folder}/eboot.bin`, 4096);
  fs.file(`${folder}/sce_sys/param.json`, 0, `{"titleId":"${code}"}`);
  return [];
};
// O conversor falso (o payload): `plan(request)` -> { error } (falha com essa mensagem), { gate } (espera), ou nada
// (termina: grava a imagem e apaga a pasta de trabalho, como bg_convert.c).
function converter(fs, plan = () => null) {
  const requests = [];
  const cancelled = [];
  return {
    requests,
    cancelled,
    convert(request) {
      requests.push(request);
      const step = plan(request, requests.length - 1) || {};
      let cancel, listener = null;
      const done = new Promise((resolve, reject) => {
        cancel = () => { cancelled.push(request.key); reject(Object.assign(new Error('Conversion cancelled.'), { name: 'AbortError' })); };
        (step.gate ?? tick()).then(() => {
          if (step.error) return reject(new Error(step.error));
          listener?.({ state: 'converting', written: 500, total: 1000 });
          fs.file(request.output, step.size ?? 5000);
          if (request.work) fs.removeAsync(request.work);
          resolve({ state: 'done', imageBytes: step.size ?? 5000 });
        });
      });
      return { subscribe(fn) { listener = fn; return () => { listener = null; }; }, done, cancel: () => cancel() };
    },
  };
}
function queueWith({ fs, downloads = engine(fs), archives = null, conv = null, on = true, notices = [], packages = null, platform = 'desktop' }) {
  return createDownloadQueue({
    fs, downloads, http: { request: async () => ({ ok: false, status: 404, json: async () => ({}) }) }, formats: DownloadFormats,
    dataDir: '/data/app', platform, notifications: { show: (title) => notices.push(title) }, power: { keepAwake() {} }, linking: null,
    sources: { resolve: async (release) => ({ url: release.url }) }, archives, packages, wait: async () => {},
    convertExfat: () => on, converter: conv,
  });
}
async function until(queue, id, done, rounds = 600) {
  for (let i = 0; i < rounds; i++) {
    const job = queue.snapshot().find((item) => item.id === id);
    if (job && done(job)) return job;
    await tick();
  }
  throw new Error(`job ${id} never got there: ${JSON.stringify(queue.snapshot().find((item) => item.id === id))}`);
}
const settled = (job) => !['queued', 'resolving', 'connecting', 'downloading', 'verifying', 'extracting', 'installing', 'converting'].includes(job.state);
const ps5 = { id: 'PPSA01234', titleId: 'PPSA01234', title: 'Test Game' };
const ps4 = { id: 'CUSA01234', titleId: 'CUSA01234', title: 'Old Game' };
const release = (filename, sizeBytes = 1000, extra = {}) => ({ id: `${filename}@host`, provider: 'host', url: `https://example.com/${filename}`, filename, sizeBytes, ...extra });

test('destino: com a opcao ligada, compactado e .pkg de PS5 no BACKUP, .pkg de PS4 em PS4/, imagens como antes; desligada, tudo como antes', () => {
  const root = '/mnt/usb0';
  const artifact = (name) => DownloadFormats.artifact({ filename: name }, root);
  const plan = (name, game = ps5, on = true, role = 'game') => convert.destinationFor({ on, role, artifact: artifact(name), release: release(name), root, title: game.title, titleId: game.titleId });
  assert.deepEqual([plan('g.rar').artifact.destination, plan('g.rar').convert], ['/mnt/usb0/BACKUP/Test Game/g.rar', true]);
  assert.deepEqual([plan('g.7z').artifact.destination, plan('g.zip').artifact.destination], ['/mnt/usb0/BACKUP/Test Game/g.7z', '/mnt/usb0/BACKUP/Test Game/g.zip']);
  assert.deepEqual([plan('g.pkg').artifact.destination, plan('g.pkg').convert], ['/mnt/usb0/BACKUP/Test Game/g.pkg', true]);
  assert.deepEqual([plan('o.pkg', ps4).artifact.destination, plan('o.pkg', ps4).convert, plan('o.pkg', ps4).backupDir], ['/mnt/usb0/PS4/o.pkg', false, null]);
  // PS4 compactado: baixa no BACKUP (o original fica), mas nao converte.
  assert.deepEqual([plan('o.rar', ps4).artifact.destination, plan('o.rar', ps4).convert], ['/mnt/usb0/BACKUP/Old Game/o.rar', false]);
  for (const name of ['g.exfat', 'g.ffpkg', 'g.ffpfs', 'g.ffpfsc']) assert.deepEqual([plan(name).artifact.destination, plan(name).convert], [`/mnt/usb0/homebrew/${name}`, false], name);
  for (const name of ['g.rar', 'g.pkg', 'g.exfat']) assert.deepEqual(plan(name, ps5, false).artifact, artifact(name), `${name} com a opcao desligada`);
  assert.equal(plan('o.pkg', ps4, false).artifact.destination, '/mnt/usb0/downloads/packages/o.pkg');
  // Backport e DLC: como antes.
  assert.equal(plan('b.rar', ps5, true, 'backport').artifact.destination, '/mnt/usb0/downloads/archives/b.rar');
  // Plataforma pelo codigo do jogo ou do arquivo; nomes de pasta seguros; pasta ja usada ganha (2).
  assert.equal(convert.platformOf({ name: 'CUSA00001-x.pkg' }), 'ps4');
  assert.equal(convert.platformOf({ titleId: 'PPSA00001' }), 'ps5');
  assert.equal(convert.safeFolderName('a/b:c*?'), 'a b c');
  assert.equal(convert.backupFolder('/data', 'Jogo', (p) => p === '/data/BACKUP/Jogo'), '/data/BACKUP/Jogo (2)');
  assert.equal(convert.exfatOutput('/data', { titleId: 'ppsa01234' }), '/data/homebrew/PPSA01234.exfat');
  assert.equal(convert.exfatOutput('/data', { titleId: 'PPSA01234' }, (p) => p.endsWith('PPSA01234.exfat')), '/data/homebrew/PPSA01234-2.exfat');
  assert.equal(convert.exfatLabel('PPSA01234'), 'PPSA01234');
  assert.deepEqual(['space: x', 'not-direct: y', 'bobagem'].map(convert.errorCode), ['space', 'not-direct', 'other']);
});

test('espaco no inicio: o .exfat conta (~2x); um .pkg de PS5 que nao cabe com a imagem e recusado antes de baixar', () => {
  assert.equal(stillNeeded({ release: { sizeBytes: 100 }, artifact: { nextAction: 'installer-required' }, total: 100, written: 0, convertPlanned: true }), 200);
  assert.equal(stillNeeded({ release: { sizeBytes: 100 }, artifact: { nextAction: 'installer-required' }, total: 100, written: 0 }), 100);
  assert.equal(stillNeeded({ state: 'converting', total: 100, written: 30 }), 70);
  const fs = memoryFs();
  fs.free = 1000 * GB;
  const queue = queueWith({ fs, conv: converter(fs) });
  assert.throws(() => queue.enqueue(ps5, release('big.pkg', 600 * GB), '/data'), (error) => /Not enough space/.test(error.message) && error.shortfall.need > 1200 * GB);
  const off = queueWith({ fs, conv: converter(fs), on: false });
  assert.doesNotThrow(() => off.enqueue(ps5, release('big.pkg', 600 * GB), '/data'));
});

test('RAR de PS5: baixa no BACKUP, vira .exfat direto (sem extrair), o original fica; o card diz Pronto (EXFAT)', async () => {
  const fs = memoryFs();
  const conv = converter(fs);
  const archives = extractor(fs, () => []);
  const notices = [];
  const queue = queueWith({ fs, archives, conv, notices });
  const id = queue.enqueue(ps5, release('Test.Game.rar'), '/data');
  const job = await until(queue, id, settled);
  assert.equal(job.state, 'downloaded', job.error);
  assert.equal(job.message, 'Ready (EXFAT)');
  assert.equal(job.artifact.destination, '/data/homebrew/PPSA01234.exfat');
  assert.equal(job.artifact.nextAction, 'shadowmount');
  assert.deepEqual(job.payload, [{ path: '/data/homebrew/PPSA01234.exfat', size: 5000 }]);
  assert.equal(conv.requests.length, 1);
  assert.deepEqual({ ...conv.requests[0], passwords: undefined }, { key: id, name: 'Test Game', kind: 'archive', root: '/data', output: '/data/homebrew/PPSA01234.exfat', label: 'PPSA01234', work: '', source: '/data/BACKUP/Test Game/Test.Game.rar', sources: ['/data/BACKUP/Test Game/Test.Game.rar'], passwords: undefined });
  assert.ok(conv.requests[0].passwords.includes('DLPSGAME.COM'), 'as senhas que o app tenta');
  assert.ok(fs.exists('/data/BACKUP/Test Game/Test.Game.rar'), 'o original fica no BACKUP');
  assert.equal(archives.started.length, 0, 'nada extraido');
  assert.ok(!fs.exists('/data/downloads/archives/Test.Game.rar'));
  assert.ok(notices.includes('Download complete'));
});

test('.pkg de PS5: baixa no BACKUP e vira .exfat; um que nao e o jogo (not-a-game) fica como pacote', async () => {
  const fs = memoryFs();
  const conv = converter(fs, (request, index) => index === 1 ? { error: 'not-a-game: the package is an update' } : null);
  const queue = queueWith({ fs, conv });
  const id = queue.enqueue(ps5, release('PPSA01234-game.pkg'), '/data');
  const job = await until(queue, id, settled);
  assert.equal(job.state, 'downloaded', job.error);
  assert.deepEqual([conv.requests[0].kind, conv.requests[0].source], ['pkg', '/data/BACKUP/Test Game/PPSA01234-game.pkg']);
  const id2 = queue.enqueue({ ...ps5, id: 'PPSA01234-upd' }, release('PPSA01234-update.pkg'), '/data');
  const job2 = await until(queue, id2, settled);
  assert.equal(job2.state, 'installer-required');
  assert.deepEqual(job2.packages, ['/data/BACKUP/Test Game (2)/PPSA01234-update.pkg']);
});

test('PS4: o .pkg vai para PS4/ e nao converte; um .pkg de PS4 dentro de um RAR e extraido, vai para PS4/ e o RAR fica no BACKUP', async () => {
  const fs = memoryFs();
  const conv = converter(fs);
  const archives = extractor(fs, (options) => {
    fs.file(`${options.destination}/CUSA01234-game.pkg`, 2000);
    fs.file(`${options.destination}/leia.nfo`, 10);
    return ['CUSA01234-game.pkg'];
  });
  const installs = [];
  const packages = { install: ({ path: p }) => { installs.push(p); return { subscribe: () => () => {}, done: Promise.resolve() }; } };
  const queue = queueWith({ fs, archives, conv, packages, platform: 'ps5' });
  const loose = queue.enqueue(ps4, release('CUSA01234-loose.pkg'), '/data');
  let job = await until(queue, loose, settled);
  assert.equal(job.state, 'installed', job.error);
  assert.deepEqual(installs, ['/data/PS4/CUSA01234-loose.pkg'], 'instalado de PS4/, como antes (Packages.install)');
  assert.ok(fs.exists('/data/PS4/CUSA01234-loose.pkg'), 'o .pkg fica (nao e apagado depois de instalar)');
  const packed = queue.enqueue({ ...ps4, id: 'CUSA01234-r' }, release('Old.Game.rar'), '/data');
  job = await until(queue, packed, settled);
  assert.equal(job.state, 'installed', job.error);
  assert.equal(installs[1], '/data/PS4/CUSA01234-game.pkg');
  assert.ok(fs.exists('/data/BACKUP/Old Game/Old.Game.rar'), 'o RAR original fica no BACKUP');
  assert.equal(conv.requests.length, 0, 'PS4 nunca converte');
});

test('compactado que nao vai direto (not-direct): extrai do BACKUP e converte a pasta; a pasta de trabalho some, o original fica', async () => {
  const fs = memoryFs();
  const conv = converter(fs, (request) => request.kind === 'archive' ? { error: 'not-direct: no size in the headers' } : null);
  const archives = extractor(fs, (options) => gameIn(fs, `${options.destination}/PPSA01234-app`));
  const queue = queueWith({ fs, archives, conv });
  const id = queue.enqueue(ps5, release('Test.Game.zip'), '/data');
  const job = await until(queue, id, settled);
  assert.equal(job.state, 'downloaded', job.error);
  assert.deepEqual(conv.requests.map((request) => request.kind), ['archive', 'dir']);
  assert.equal(archives.started[0].sources[0], '/data/BACKUP/Test Game/Test.Game.zip', 'extraido de dentro do BACKUP');
  assert.deepEqual([conv.requests[1].source, conv.requests[1].work], ['/data/downloads/extracted/Test.Game.zip/PPSA01234-app', '/data/downloads/extracted/Test.Game.zip']);
  assert.ok(fs.exists('/data/BACKUP/Test Game/Test.Game.zip') && !fs.exists('/data/downloads/extracted/Test.Game.zip'));
  assert.equal(job.output, undefined);
});

test('erro e recuperacao: sem espaco falha com o motivo, "Tentar de novo" recomeca; "Usar sem converter" extrai como antes', async () => {
  const fs = memoryFs();
  let fail = 2;
  const conv = converter(fs, () => fail-- > 0 ? { error: 'space: the .exfat needs 12.0 GB free on the drive and it has 3.0 GB' } : null);
  const archives = extractor(fs, (options) => { fs.file(`${options.destination}/game.exfat`, 900); return ['game.exfat']; });
  const queue = queueWith({ fs, archives, conv });
  const id = queue.enqueue(ps5, release('Test.Game.rar'), '/data');
  let job = await until(queue, id, settled);
  assert.equal(job.state, 'failed');
  assert.match(job.error, /^Not enough space for the \.exfat: the \.exfat needs 12\.0 GB/);
  assert.equal(job.convert.kind, 'archive');
  assert.ok(fs.exists('/data/BACKUP/Test Game/Test.Game.rar'), 'nada se perde');
  queue.resume(id); // o botao "Tentar de novo" (retryConversion) ou Retry
  job = await until(queue, id, (item) => item.state === 'failed' && conv.requests.length === 2);
  queue.retryConversion(id);
  job = await until(queue, id, (item) => settled(item) && conv.requests.length === 3);
  assert.equal(job.state, 'downloaded', job.error);
  // Outro jogo: falha e o jogador escolhe usar sem converter: extrai como antes (aqui, uma imagem dentro).
  fail = 1;
  const other = queue.enqueue({ ...ps5, id: 'PPSA05678', titleId: 'PPSA05678', title: 'Other' }, release('Other.rar'), '/data');
  job = await until(queue, other, settled);
  assert.equal(job.state, 'failed');
  await queue.skipConversion(other);
  job = await until(queue, other, settled);
  assert.equal(job.state, 'downloaded', job.error);
  assert.equal(job.artifact.destination, '/data/homebrew/game.exfat');
  assert.ok(fs.exists('/data/BACKUP/Other/Other.rar'), 'o original continua no BACKUP');
});

test('reabrir o app no meio: a conversao e acompanhada de novo pela mesma chave e termina; cancelar para no payload e o original fica', async () => {
  const fs = memoryFs();
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const conv = converter(fs, () => ({ gate: new Promise(() => {}) }));
  const queue = queueWith({ fs, archives: extractor(fs, () => []), conv });
  const id = queue.enqueue(ps5, release('Test.Game.7z'), '/data');
  await until(queue, id, (job) => job.state === 'converting');
  // O app fecha: uma fila nova le o que foi salvo e pergunta ao payload pela mesma chave.
  const conv2 = converter(fs, () => ({ gate }));
  const reopened = queueWith({ fs, archives: extractor(fs, () => []), conv: conv2 });
  await until(reopened, id, () => conv2.requests.length === 1);
  assert.equal(conv2.requests[0].key, id);
  assert.equal(reopened.snapshot().find((job) => job.id === id).state, 'converting');
  open();
  assert.equal((await until(reopened, id, settled)).state, 'downloaded');
  // Cancelar uma em andamento.
  const conv3 = converter(fs, () => ({ gate: new Promise(() => {}) }));
  const q3 = queueWith({ fs, archives: extractor(fs, () => []), conv: conv3 });
  const id3 = q3.enqueue({ ...ps5, id: 'PPSA09999', titleId: 'PPSA09999', title: 'Third' }, release('Third.rar'), '/data');
  await until(q3, id3, (job) => job.state === 'converting');
  await q3.cancel(id3);
  assert.deepEqual(conv3.cancelled, [id3]);
  assert.ok(!q3.snapshot().some((job) => job.id === id3), 'saiu da fila');
  assert.ok(fs.exists('/data/BACKUP/Third/Third.rar'), 'o original fica no BACKUP');
});

test('BACKUP nas Configuracoes: lista por jogo com o tamanho; apagar um; nomes invalidos e original em uso recusados', async () => {
  const fs = memoryFs();
  fs.file('/data/BACKUP/A/a.rar', 3000);
  fs.file('/mnt/usb0/BACKUP/B/b.part1.rar', 1000);
  fs.file('/mnt/usb0/BACKUP/B/sub/b.part2.rar', 500);
  const listed = convert.listBackup(fs, ['/data', '/mnt/usb0', '/mnt/usb1']);
  assert.deepEqual(listed.games.map((game) => [game.root, game.name, game.bytes, game.files]), [['/data', 'A', 3000, 1], ['/mnt/usb0', 'B', 1500, 2]]);
  assert.equal(listed.totalBytes, 4500);
  for (const name of ['..', 'a/b', '.x', '']) await assert.rejects(convert.deleteBackup(fs, '/data', name), /Invalid/);
  await assert.rejects(convert.deleteBackup(fs, '/mnt/usb0', 'B', () => true), (error) => error.busy);
  await convert.deleteBackup(fs, '/data', 'A');
  assert.ok(!fs.exists('/data/BACKUP/A') && fs.exists('/mnt/usb0/BACKUP/B'));
});

test('BACKUP (glibren.12: detalhes): sistema, codigo, formato, partes, nomes e o .exfat convertido; o marcador gravado e lido', () => {
  const fs = memoryFs();
  fs.file('/data/BACKUP/Jogo/Game.PPSA01234.part1.rar', 3000);
  fs.file('/data/BACKUP/Jogo/sub/Game.PPSA01234.part2.rar', 1000);
  convert.writeBackupMarker(fs, '/data/BACKUP/Jogo', { titleId: 'ppsa01234', platform: 'ps5', format: 'rar', source: 'mediafire.com' });
  assert.deepEqual(JSON.parse(fs.readFile('/data/BACKUP/Jogo/.jobe-backup.json')), { titleId: 'PPSA01234', platform: 'ps5', format: 'rar', source: 'mediafire.com' });
  fs.file('/data/homebrew/PPSA01234.exfat', 10);
  fs.file('/mnt/usb0/BACKUP/Velho CUSA00900/Bloodborne.pkg', 500);
  for (let i = 0; i < 12; i++) fs.file(`/mnt/usb0/BACKUP/Muitos/M.part${String(i + 1).padStart(2, '0')}.rar`, 1);
  const listed = convert.listBackup(fs, ['/data', '/mnt/usb0']);
  const jogo = listed.games.find((game) => game.name === 'Jogo');
  assert.deepEqual([jogo.platform, jogo.code, jogo.format, jogo.parts, jogo.files, jogo.bytes, jogo.converted], ['ps5', 'PPSA01234', 'rar', 2, 2, 4000, 'PPSA01234.exfat'], 'o marcador nao conta');
  assert.deepEqual(jogo.fileNames, ['Game.PPSA01234.part1.rar', 'Game.PPSA01234.part2.rar']);
  const velho = listed.games.find((game) => game.name === 'Velho CUSA00900');
  assert.deepEqual([velho.platform, velho.code, velho.format, velho.converted], ['ps4', 'CUSA00900', 'pkg', ''], 'sem marcador: pelo nome da pasta');
  const muitos = listed.games.find((game) => game.name === 'Muitos');
  assert.deepEqual([muitos.fileNames.length, muitos.moreFiles, muitos.parts, muitos.platform], [10, 2, 12, '']);
});
