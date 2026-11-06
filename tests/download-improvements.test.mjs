// The download queue's transfer improvements (app/state/download-queue.js and the modules beside it), against an
// in-memory filesystem, a fake download engine and fake extractor, and fake debrid answers. Nothing here reaches a
// real host or service. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const { createDownloadQueue, BUSY } = await load('app/state/download-queue.js');
const { DEFAULT_TUNING, HOST_TUNING, hostGroup, rangeFor, tuningFor } = await load('app/state/download-tuning.js');
const { configure } = await load('app/i18n/core.js');
const { DownloadFormats } = await load('ps5-react/runtime/js/download-formats.js');
const en = JSON.parse(readFileSync(path.join(repo, 'app/i18n/locales/en.json'), 'utf8'));
configure(() => en, en);

const MiB = 1024 ** 2;

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
    diskUsage: () => ({ total: 1e12, free: fs.free }),
    mounts: () => [],
  };
  fs.mkdir('/data');
  return fs;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A fake engine: every request is recorded; `plan(options, index)` may return { error } (fails), { gate } (a promise
// the test resolves to let it end) or nothing (ends at once, publishing the expected bytes).
// A step's `written` is reported as progress as soon as the queue subscribes; `tasks[i].emit(progress)` reports more.
function engine(fs, plan = () => null) {
  const requests = [];
  const tasks = [];
  return {
    requests,
    tasks,
    enqueue(options) {
      const index = requests.push(options) - 1;
      const step = plan(options, index) || {};
      let cancel;
      const finish = () => {
        if (step.error) throw step.error;
        const size = options.expectedBytes ?? 1000;
        fs.remove(`${options.destination}.part`);
        fs.file(options.destination, size);
        fs.file(`${options.destination}.complete`, 0, 'receipt');
        return { written: size, total: size };
      };
      const done = new Promise((resolve, reject) => {
        cancel = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        (step.gate ?? tick()).then(() => { try { resolve(finish()); } catch (error) { reject(error); } });
      });
      let listener = null;
      const task = {
        subscribe(fn) {
          listener = fn;
          if (step.written !== undefined) fn({ state: 'downloading', written: step.written, total: options.expectedBytes ?? null });
          return () => { listener = null; };
        },
        emit: (progress) => listener?.(progress),
        done,
        cancel: () => cancel(),
      };
      tasks.push(task);
      return task;
    },
  };
}

function queueWith({ fs, downloads, archives = null, sources, platform = 'desktop', notices = [], wait, concurrency }) {
  return createDownloadQueue({
    ...(concurrency ? { concurrency } : {}),
    fs, downloads, http: { request: async () => ({ ok: false, status: 404, json: async () => ({}) }) }, formats: DownloadFormats,
    dataDir: '/data/app', platform, notifications: { show: (title) => notices.push(title) }, power: { keepAwake() {} }, linking: null,
    sources: sources ?? { resolve: async (release) => ({ url: release.url }) }, archives, packages: null, wait: wait ?? (async () => {}),
  });
}

async function until(queue, id, done, rounds = 400) {
  for (let i = 0; i < rounds; i++) {
    const job = queue.snapshot().find((item) => item.id === id);
    if (job && done(job)) return job;
    await tick();
  }
  throw new Error(`job ${id} never got there: ${JSON.stringify(queue.snapshot().find((item) => item.id === id)?.state)}`);
}
const settle = (queue, id) => until(queue, id, (job) => !BUSY.includes(job.state));

const game = { id: 'PPSA01234', titleId: 'PPSA01234', title: 'Test Game' };
const image = (name, url = `https://example.com/${name}`, sizeBytes = 1000, extra = {}) => ({ id: `${name}@${url}`, provider: 'host', url, filename: name, sizeBytes, ...extra });

// A fake extractor: one image per archive (named after it), with its receipt. `gates` (promises, in order) hold
// extractions until the test lets them end; `log.max` is the most extractions that ever ran at once.
function extractor(fs, gates = []) {
  const log = { max: 0, running: 0, started: [] };
  return {
    log,
    streams: false,
    inspect: ([p]) => ({ kind: /\.zip$/.test(p) ? 'zip' : null }),
    extract(options) {
      log.running++;
      log.max = Math.max(log.max, log.running);
      log.started.push(options.destination);
      const gate = gates.shift() ?? tick();
      let settled = false, cancel;
      const done = new Promise((resolve, reject) => {
        cancel = () => {
          if (settled) return;
          settled = true;
          log.running--;
          reject(Object.assign(new Error('Extraction cancelled.'), { name: 'AbortError' }));
        };
        gate.then(() => {
          if (settled) return;
          settled = true;
          log.running--;
          const name = `${options.destination.slice(options.destination.lastIndexOf('/') + 1).replace(/\.zip$/, '')}.exfat`;
          fs.mkdir(options.destination);
          fs.file(`${options.destination}/${name}`, 900);
          fs.file(`${options.destination}/.ps5-react-extraction`, 0, `P5AR001:1:2\n${'a'.repeat(64)}|${name}\n`);
          resolve({ artifacts: [name] });
        });
      });
      return { subscribe: () => () => {}, done, cancel: () => cancel() };
    },
  };
}
const gated = () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  return { gate, open };
};

// ---- 2. Extraction beside the next download ----

test('extraction: the next download starts while an archive extracts; one extraction at a time, in order', async () => {
  const fs = memoryFs();
  const downloads = engine(fs);
  const first = gated(), second = gated();
  const archives = extractor(fs, [first.gate, second.gate]);
  const notices = [];
  const queue = queueWith({ fs, downloads, archives, notices });
  const a = queue.enqueue(game, image('Alpha.zip'), '/data');
  const b = queue.enqueue({ ...game, id: 'PPSA05678', titleId: 'PPSA05678' }, image('Beta.zip'), '/data');
  const c = queue.enqueue({ ...game, id: 'PPSA09999', titleId: 'PPSA09999' }, image('Gamma.exfat'), '/data');
  // Alpha extracts; Beta and Gamma download meanwhile; Beta's extraction waits for Alpha's.
  await until(queue, c, (job) => job.state === 'downloaded');
  const [alpha, beta] = [a, b].map((id) => queue.snapshot().find((job) => job.id === id));
  assert.equal(alpha.state, 'extracting');
  assert.equal(alpha.phase, undefined, 'Alpha is the one extracting');
  assert.equal(beta.state, 'extracting');
  assert.equal(beta.phase, 'queued', 'Beta waits its turn');
  const { shownState, stateLabel } = await load('app/downloads/labels.js');
  assert.equal(stateLabel(shownState(beta)), 'Waiting to extract…');
  assert.equal(downloads.requests.length, 3, 'every download ran while Alpha extracted');
  assert.equal(archives.log.started.length, 1);
  first.open();
  await until(queue, b, (job) => job.state === 'extracting' && !job.phase);
  second.open();
  for (const id of [a, b]) assert.equal((await settle(queue, id)).state, 'downloaded');
  assert.equal(archives.log.max, 1, 'never two extractions at once');
  assert.deepEqual(archives.log.started, ['/data/downloads/extracted/Alpha.zip', '/data/downloads/extracted/Beta.zip']);
  assert.ok(fs.exists('/data/homebrew/Alpha.exfat') && fs.exists('/data/homebrew/Beta.exfat'));
  assert.ok(!fs.exists('/data/downloads/archives/Alpha.zip'), 'the archive goes once unpacked');
  assert.equal(notices.filter((text) => text === 'Download complete').length, 3);
});

test('extraction: pausing, resuming and cancelling a waiting or running extraction', async () => {
  const fs = memoryFs();
  const downloads = engine(fs);
  const first = gated();
  const archives = extractor(fs, [first.gate]);
  const queue = queueWith({ fs, downloads, archives, wait: tick });
  const a = queue.enqueue(game, image('Alpha.zip'), '/data');
  const b = queue.enqueue({ ...game, id: 'PPSA05678', titleId: 'PPSA05678' }, image('Beta.zip'), '/data');
  await until(queue, b, (job) => job.phase === 'queued');
  // Beta, waiting: paused at once, its archive kept; resumed, it takes the engine's receipt and waits again.
  queue.pause(b);
  let beta = queue.snapshot().find((job) => job.id === b);
  assert.equal(beta.state, 'paused');
  assert.ok(fs.exists('/data/downloads/archives/Beta.zip'));
  queue.resume(b);
  await until(queue, b, (job) => job.phase === 'queued');
  // Alpha, extracting: cancelling stops it and deletes everything it put on the drive.
  await queue.cancel(a);
  assert.ok(!queue.snapshot().some((job) => job.id === a), 'Alpha is gone');
  assert.ok(!fs.exists('/data/downloads/archives/Alpha.zip') && !fs.exists('/data/downloads/extracted/Alpha.zip'));
  first.open();
  // Beta goes on once the lane is free.
  beta = await settle(queue, b);
  assert.equal(beta.state, 'downloaded', beta.error);
  assert.equal(archives.log.max, 1);
});

test('extraction: one cut off by closing the app queues again when it opens, from the downloaded archive', async () => {
  const fs = memoryFs();
  const downloads = engine(fs);
  const queue = queueWith({ fs, downloads, archives: extractor(fs, [new Promise(() => {})]) });
  const a = queue.enqueue(game, image('Alpha.zip'), '/data');
  await until(queue, a, (job) => job.state === 'extracting' && !job.phase);
  // The app closes now: a new queue reads what was saved.
  const downloads2 = engine(fs);
  const archives2 = extractor(fs);
  const reopened = queueWith({ fs, downloads: downloads2, archives: archives2 });
  const job = await settle(reopened, a);
  assert.equal(job.state, 'downloaded', job.error);
  assert.equal(downloads2.requests[0].recoverCompleted, true, 'the finished archive is taken from its receipt');
  assert.equal(archives2.log.started.length, 1);
});

test('extraction: a download that fits only once the extraction on its drive is done waits for it, then starts', async () => {
  const fs = memoryFs();
  // Alpha's download holds until the drive has filled up (below).
  const alphaDownload = gated();
  const downloads = engine(fs, (options, index) => index === 0 ? { gate: alphaDownload.gate } : null);
  const first = gated();
  const archives = extractor(fs, [first.gate]);
  const queue = queueWith({ fs, downloads, archives });
  const a = queue.enqueue(game, image('Alpha.zip', 'https://example.com/Alpha.zip', 100 * MiB), '/data');
  const b = queue.enqueue({ ...game, id: 'PPSA05678', titleId: 'PPSA05678' }, image('Beta.zip', 'https://example.com/Beta.zip', 100 * MiB), '/data');
  await until(queue, a, () => downloads.requests.length === 1);
  // Now Alpha (100 MiB) will extract, and Beta (an archive of 100 MiB: 200 with its own extraction) fits only
  // without what Alpha's extraction still has to write.
  fs.free = 16 * MiB + 250 * MiB;
  alphaDownload.open();
  let beta = await until(queue, b, (job) => job.roomWait);
  assert.equal(beta.state, 'queued');
  assert.equal(beta.message, en['downloads.waitingForExtraction']);
  assert.equal(downloads.requests.length, 1, 'Beta was not handed to the engine');
  assert.equal(queue.snapshot().find((job) => job.id === a).state, 'extracting');
  first.open();
  beta = await settle(queue, b);
  assert.equal(beta.state, 'downloaded', beta.error);
  assert.ok(!String(beta.message).includes(en['downloads.waitingForExtraction']));
  assert.equal(downloads.requests.length, 2);
});

test('extraction: the room an extraction still needs counts as taken for the space checks', async () => {
  const { stillNeeded } = await load('app/state/space.js');
  const release = { sizeBytes: 100 };
  const artifact = { nextAction: 'extraction-required' };
  assert.equal(stillNeeded({ state: 'downloading', release, artifact, total: 100, written: 40 }), 160, 'its file and its extraction');
  assert.equal(stillNeeded({ state: 'extracting', phase: 'queued', release, artifact, total: 100, written: 100 }), 100, 'waiting: what it unpacks to, about its size');
  assert.equal(stillNeeded({ state: 'extracting', release, artifact, total: 300, written: 120 }), 180, 'extracting: what is left of what it unpacks to');
});

// ---- 3. Connections and range size per host ----

test('tuning: one table per host; unknown hosts keep 64 x 16 MiB; subdomains match; bad entries fall back', () => {
  assert.deepEqual(tuningFor('https://example.com/a.exfat'), { connections: 64, rangeBytes: 16 * MiB });
  assert.deepEqual(DEFAULT_TUNING, { connections: 64, rangeBytes: 16 * MiB });
  assert.equal(tuningFor('https://archive.org/download/x/a.zip').connections, 8);
  assert.equal(tuningFor('https://ia800300.us.archive.org/1/items/x/a.zip').connections, 8);
  assert.equal(tuningFor('https://notarchive.org/a.zip').connections, 64, 'a domain only matches itself and its subdomains');
  assert.equal(tuningFor('https://download1234.mediafire.com/x/a.rar').connections, 16);
  assert.ok(HOST_TUNING.every((entry) => entry.hosts.length));
  const table = [{ hosts: ['slow.example'], connections: 500, rangeBytes: 3 }];
  assert.deepEqual(tuningFor('https://slow.example/x', table), { connections: 64, rangeBytes: 16 * MiB }, 'out of the engine\'s limits: the default');
  assert.deepEqual(tuningFor('not a url'), { connections: 64, rangeBytes: 16 * MiB });
});

test('tuning: a partial keeps the range size it started with, an earlier build\'s partial its old one', () => {
  const tuned = { connections: 8, rangeBytes: 32 * MiB };
  const fresh = {};
  assert.equal(rangeFor(fresh, tuned, false, 16 * MiB), 32 * MiB);
  assert.equal(fresh.rangeBytes, 32 * MiB, 'recorded for its resume');
  assert.equal(rangeFor(fresh, { connections: 8, rangeBytes: 64 * MiB }, true, 16 * MiB), 32 * MiB, 'the table changed: the partial keeps its own');
  const legacy = {};
  assert.equal(rangeFor(legacy, tuned, true, 16 * MiB), 16 * MiB, 'started before sizes were recorded');
  assert.equal(rangeFor({}, tuned, true, null), null, 'a set\'s part used the engine default');
  assert.equal(rangeFor({ rangeBytes: 8 * MiB }, tuned, false, null), 32 * MiB, 'its partial is gone (restart): the table again');
});

test('tuning: the queue asks the engine for the host\'s connections and records the range size with the job', async () => {
  const fs = memoryFs();
  const downloads = engine(fs);
  const queue = queueWith({ fs, downloads });
  const id = queue.enqueue(game, image('Game.exfat', 'https://archive.org/download/item/Game.exfat'), '/data');
  const job = await settle(queue, id);
  assert.equal(job.state, 'downloaded', job.error);
  assert.equal(downloads.requests[0].connections, 8);
  assert.equal(downloads.requests[0].rangeBytes, 16 * MiB);
  assert.equal(downloads.requests[0].adaptive, true, 'the AIMD window still runs');
  assert.equal(job.rangeBytes, 16 * MiB);
});

test('tuning: a set\'s new parts get the table\'s range size; one an earlier build started keeps the engine default', async () => {
  const fs = memoryFs();
  const downloads = engine(fs);
  const queue = queueWith({ fs, downloads });
  const part = (n) => ({ number: n, sources: [{ url: `https://example.com/Game.part${n}.rar`, sizeBytes: 100 }] });
  // Part 2 has a partial from before this build (no range size recorded).
  fs.file('/data/downloads/sets/Game/part-2.bin.part', 50);
  const id = queue.enqueue(game, { id: 'set', provider: 'host', filename: 'Game', parts: [part(1), part(2)] }, '/data');
  await settle(queue, id);
  assert.equal(downloads.requests[0].rangeBytes, 16 * MiB);
  assert.equal(downloads.requests[1].rangeBytes, undefined, 'the engine default it started with');
  assert.equal(downloads.requests[1].connections, 64);
});

// ---- 1. Mirrors ----

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

test('mirrors: same SHA-256 when the file has one; same size and name otherwise; only plain direct links', async () => {
  const { mirrorsFor, sameFile } = await load('app/state/download-mirrors.js');
  const primary = image('Game.exfat', 'https://a.example/Game.exfat', 5000, { sha256: SHA });
  const options = { url: 'https://a.example/Game.exfat', sha256: SHA, expectedBytes: 5000 };
  const candidates = [
    image('Game.exfat', 'https://b.example/Game.exfat', 5000, { sha256: SHA }),
    image('Game.exfat', 'https://c.example/Game.exfat', 5000, { sha256: OTHER_SHA }),
    image('Game.exfat', 'https://d.example/Game.exfat', 5000),
    image('Game.exfat', 'https://www.mediafire.com/file/abc/Game.exfat/file', 5000, { sha256: SHA }),
    image('Game.exfat', 'https://e.example/Game.exfat', 5000, { sha256: SHA, debrid: { service: 'torbox' } }),
    image('Game.exfat', 'https://f.example/Game.exfat', 5000, { sha256: SHA, browserUrl: 'https://f.example/page' }),
    image('Game.exfat', 'https://g.example/Game.exfat', 5000, { sha256: SHA, requiresBrowser: true }),
    image('Game.exfat', 'https://a.example/Game.exfat', 5000, { sha256: SHA }),
    image('Game.exfat', 'https://b.example/Game.exfat', 5000, { sha256: SHA }),
  ];
  assert.deepEqual(mirrorsFor(primary, options, candidates), ['https://b.example/Game.exfat'], 'one checksum match; pages, debrid, browser and duplicates left out');
  // No checksum: the same size and name (the engine then also wants the same strong ETag).
  const plain = image('Game.exfat', 'https://a.example/Game.exfat', 5000);
  assert.deepEqual(mirrorsFor(plain, { url: plain.url }, [
    image('Game.exfat', 'https://b.example/dl/Game.exfat', 5000),
    image('game.EXFAT', 'https://c.example/x?id=1', 5000),
    image('Game.exfat', 'https://d.example/Game.exfat', 4999),
    image('Other.exfat', 'https://e.example/Other.exfat', 5000),
    image('Game.exfat', 'https://f.example/Game.exfat', 5000, { sha256: SHA }),
    image('Game.exfat', 'https://g.example/Game.exfat'),
  ]), ['https://b.example/dl/Game.exfat', 'https://c.example/x?id=1']);
  assert.equal(sameFile({ filename: 'a', sizeBytes: null }, { filename: 'a', sizeBytes: null }), false, 'an unknown size proves nothing');
  // The resolved size wins over the listing's.
  assert.deepEqual(mirrorsFor(plain, { url: plain.url, expectedBytes: 4000 }, [image('Game.exfat', 'https://b.example/Game.exfat', 5000)]), []);
  // Never with a split manifest or a debrid repack, and at most four.
  assert.deepEqual(mirrorsFor(primary, { ...options, pieces: [{}] }, candidates), []);
  assert.deepEqual(mirrorsFor(primary, { ...options, repacked: true }, candidates), []);
  const many = Array.from({ length: 6 }, (_, i) => image('Game.exfat', `https://m${i}.example/Game.exfat`, 5000, { sha256: SHA }));
  assert.equal(mirrorsFor(primary, options, many).length, 4);
});

test('mirrors: the queue offers the game\'s other direct sources of the same file to the engine', async () => {
  const fs = memoryFs();
  const downloads = engine(fs);
  const queue = queueWith({ fs, downloads });
  const primary = image('Game.exfat', 'https://a.example/Game.exfat', 1000, { sha256: SHA });
  const alternatives = [
    image('Game.exfat', 'https://b.example/Game.exfat', 1000, { sha256: SHA }),
    image('Game.exfat', 'https://www.mediafire.com/file/abc/Game.exfat/file', 1000, { sha256: SHA }),
    image('Game.exfat', 'https://c.example/Game.exfat', 1000, { sha256: OTHER_SHA }),
  ];
  const job = await settle(queue, queue.enqueue(game, primary, '/data', alternatives));
  assert.equal(job.state, 'downloaded', job.error);
  assert.deepEqual(downloads.requests[0].mirrors, ['https://b.example/Game.exfat']);
  assert.equal(downloads.requests[0].sha256, SHA, 'the checksum that makes them safe goes along');
  // Nothing alike: no mirrors at all (the option stays unset).
  const fs2 = memoryFs();
  const downloads2 = engine(fs2);
  const queue2 = queueWith({ fs: fs2, downloads: downloads2 });
  await settle(queue2, queue2.enqueue(game, image('Game.exfat'), '/data', [image('Other.exfat', 'https://b.example/Other.exfat')]));
  assert.equal(downloads2.requests[0].mirrors, undefined);
});

test('mirrors: a set\'s part gets its other direct sources of the same volume', async () => {
  const fs = memoryFs();
  const downloads = engine(fs);
  const queue = queueWith({ fs, downloads });
  const volume = (n, host, extra = {}) => ({ url: `https://${host}/Game.part${n}.rar`, filename: `Game.part${n}.rar`, sizeBytes: 100, ...extra });
  const parts = [
    { number: 1, sources: [volume(1, 'a.example'), volume(1, 'b.example'), volume(1, 'vikingfile.com', { requiresBrowser: true, browserUrl: 'https://vikingfile.com/f/x' })] },
    { number: 2, sources: [volume(2, 'a.example')] },
  ];
  const id = queue.enqueue(game, { id: 'set', provider: 'host', filename: 'Game', parts }, '/data');
  await settle(queue, id);
  assert.deepEqual(downloads.requests[0].mirrors, ['https://b.example/Game.part1.rar']);
  assert.equal(downloads.requests[1].mirrors, undefined);
});

// ---- 10. Network failures while resolving a link; 5. a debrid service still preparing the file ----

const page = (name = 'Game.exfat', extra = {}) => image(name, `https://www.mediafire.com/file/abc123/${name}/file`, 1000, { provider: 'MediaFire', ...extra });
const MIN = 60e3;

test('resolving: a network failure is tried again by itself after 30 s, 2 min, 10 min, before any other source', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = memoryFs();
  const downloads = engine(fs);
  let calls = 0;
  const failures = ["Couldn't resolve host name", 'Timeout was reached', 'TorBox didn\'t answer: Failure when receiving data from the peer'];
  const sources = { resolve: async (release) => {
    calls++;
    if (release.url.includes('mediafire') && calls <= failures.length) throw new Error(failures[calls - 1]);
    return { url: 'https://download.example/Game.exfat' };
  } };
  const queue = queueWith({ fs, downloads, sources });
  const id = queue.enqueue(game, page(), '/data', [image('Game.exfat', 'https://other.example/Game.exfat')]);
  let job = await until(queue, id, (item) => item.state === 'failed' && item.retryAt);
  assert.match(job.error, /Couldn't resolve host name/);
  assert.equal(job.release.provider, 'MediaFire', 'no switch to another source for the network');
  assert.ok(job.retryAt - Date.now() <= 30e3 && job.retryAt - Date.now() > 25e3);
  t.mock.timers.tick(30e3);
  job = await until(queue, id, (item) => calls === 2 && item.state === 'failed' && item.retryAt);
  assert.ok(job.retryAt - Date.now() > 100e3, 'then 2 minutes');
  t.mock.timers.tick(2 * MIN);
  job = await until(queue, id, (item) => calls === 3 && item.state === 'failed' && item.retryAt);
  assert.ok(job.retryAt - Date.now() > 9 * MIN, 'then 10 minutes');
  t.mock.timers.tick(10 * MIN);
  job = await settle(queue, id);
  assert.equal(job.state, 'downloaded', job.error);
  assert.equal(downloads.requests[0].url, 'https://download.example/Game.exfat');
  assert.equal(job.networkRetries, undefined, 'the count starts over once a link is had');
});

test('resolving: past its tries, a network failure fails over as before; a host refusal still fails over at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = memoryFs();
  const downloads = engine(fs);
  const sources = { resolve: async (release) => {
    if (release.url.includes('gone')) throw new Error('Source unavailable: HTTP 404. Choose another source.');
    if (release.url.includes('mediafire')) throw new Error('Timeout was reached');
    return { url: release.url };
  } };
  const queue = queueWith({ fs, downloads, sources });
  const id = queue.enqueue(game, page(), '/data', [image('Game.exfat', 'https://other.example/Game.exfat')]);
  for (const wait of [30e3, 2 * MIN, 10 * MIN]) {
    await until(queue, id, (item) => item.state === 'failed' && item.retryAt);
    t.mock.timers.tick(wait);
  }
  const job = await settle(queue, id);
  assert.equal(job.state, 'downloaded', job.error);
  assert.equal(job.release.url, 'https://other.example/Game.exfat', 'switched once the tries were used');
  // A 404 is the source, not the network: no wait.
  const fs2 = memoryFs();
  const queue2 = queueWith({ fs: fs2, downloads: engine(fs2), sources });
  const gone = queue2.enqueue(game, page('Gone.exfat', { url: 'https://www.mediafire.com/file/gone/Gone.exfat/file' }), '/data');
  const failed = await settle(queue2, gone);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retryAt, undefined);
});

const pending = (percent) => Object.assign(new Error(`TorBox is still fetching this file (${percent}%). Resume the download in a while.`), { code: 'PENDING' });
const debridPage = (extra = {}) => image('Game.exfat', 'https://1fichier.com/?abc123', 1000, { id: 'Game~torbox', provider: '1fichier', debrid: { service: 'torbox' }, ...extra });

test('debrid pending: asked again every 5 minutes by itself, the card saying so; RATE_LIMITED waits longer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = memoryFs();
  const downloads = engine(fs);
  const answers = [pending(10), Object.assign(new Error('TorBox asked to slow down. Try again in a minute.'), { code: 'RATE_LIMITED' }), pending(80)];
  let calls = 0;
  const sources = { resolve: async () => {
    const answer = answers[calls++];
    if (answer) throw answer;
    return { url: 'https://store.torbox.example/dl/1' };
  } };
  const queue = queueWith({ fs, downloads, sources });
  const id = queue.enqueue(game, debridPage(), '/data', [image('Game.exfat', 'https://other.example/Game.exfat')]);
  let job = await until(queue, id, (item) => item.state === 'failed' && item.retryAt);
  assert.equal(job.error, 'TorBox is still fetching this file (10%).', 'no "resume it yourself": it does');
  assert.deepEqual(job.pending.tries, 1);
  assert.ok(job.retryAt - Date.now() > 4 * MIN);
  assert.equal(job.release.debrid?.service, 'torbox', 'no other source meanwhile');
  t.mock.timers.tick(5 * MIN);
  job = await until(queue, id, (item) => calls === 2 && item.state === 'failed' && item.retryAt);
  assert.match(job.error, /asked to slow down/);
  assert.ok(job.retryAt - Date.now() > 1.5 * MIN, 'a rate limit waits its own 2 minutes');
  t.mock.timers.tick(2 * MIN);
  job = await until(queue, id, (item) => calls === 3 && item.state === 'failed' && item.retryAt);
  assert.equal(job.pending.tries, 2);
  t.mock.timers.tick(5 * MIN);
  job = await settle(queue, id);
  assert.equal(job.state, 'downloaded', job.error);
  assert.equal(job.pending, undefined);
});

test('debrid pending: cancelling stops the tries; one waiting when the app closed is asked again a minute after it opens', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = memoryFs();
  let calls = 0;
  const sources = { resolve: async () => { calls++; throw pending(50); } };
  const queue = queueWith({ fs, downloads: engine(fs), sources });
  const id = queue.enqueue(game, debridPage(), '/data');
  await until(queue, id, (item) => item.state === 'failed' && item.retryAt);
  await queue.cancel(id);
  t.mock.timers.tick(10 * MIN);
  await tick();
  assert.equal(calls, 1, 'nothing asked after the cancel');
  assert.equal(queue.snapshot().length, 0);
  // The app closed while it waited: the saved job keeps its count, and the next launch asks again after a minute.
  const id2 = queue.enqueue(game, debridPage(), '/data');
  await until(queue, id2, (item) => item.state === 'failed' && item.retryAt);
  assert.equal(calls, 2);
  const reopened = queueWith({ fs, downloads: engine(fs), sources });
  const restored = reopened.snapshot().find((item) => item.id === id2);
  assert.equal(restored.pending.tries, 1);
  assert.ok(restored.retryAt - Date.now() <= 60e3);
  t.mock.timers.tick(60e3);
  await until(reopened, id2, () => calls >= 3);
});

test('debrid pending: gives up after its tries, as a failure the gamer resumes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = memoryFs();
  const sources = { resolve: async () => { throw pending(1); } };
  const notices = [];
  const queue = queueWith({ fs, downloads: engine(fs), sources, notices });
  const id = queue.enqueue(game, debridPage(), '/data');
  for (let i = 0; i < 24; i++) {
    await until(queue, id, (item) => item.state === 'failed' && item.retryAt && item.pending?.tries === i + 1);
    t.mock.timers.tick(5 * MIN);
  }
  const job = await until(queue, id, (item) => item.state === 'failed' && !item.retryAt);
  assert.match(job.error, /still fetching/);
  assert.equal(notices.length, 1, 'told once, at the end');
});

// ---- 4. TorBox links renewed whenever they expire ----

const refused = () => new Error('provider denied the file; link expired or browser verification required');

test('debrid link: renewed every time the engine is refused while bytes keep coming, never the browser', async () => {
  const fs = memoryFs();
  let links = 0;
  const sources = { resolve: async () => ({ url: `https://store.torbox.example/dl/${++links}` }) };
  // Four refusals in a row, each after more bytes arrived; the fifth link finishes it.
  const downloads = engine(fs, (options, index) => index < 4 ? { error: refused(), written: (index + 1) * 100 } : null);
  const queue = queueWith({ fs, downloads, sources });
  const states = new Set();
  queue.subscribe((jobs) => jobs.forEach((item) => states.add(item.state)));
  const job = await settle(queue, queue.enqueue(game, debridPage(), '/data'));
  assert.equal(job.state, 'downloaded', job.error);
  assert.equal(links, 5, 'a new link each time, past the old limit of two');
  assert.deepEqual(downloads.requests.map((request) => request.url), [1, 2, 3, 4, 5].map((n) => `https://store.torbox.example/dl/${n}`));
  assert.ok(!states.has('awaiting-browser'));
  assert.equal(downloads.requests[4].destination, downloads.requests[0].destination, 'the same partial carries on');
  assert.equal(job.renewal, undefined);
});

test('debrid link: renewals that bring no bytes back off (30 s, 2 min, 10 min), then it fails saying why', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = memoryFs();
  let links = 0;
  const sources = { resolve: async () => ({ url: `https://store.torbox.example/dl/${++links}` }) };
  const downloads = engine(fs, () => ({ error: refused() }));
  const queue = queueWith({ fs, downloads, sources });
  const id = queue.enqueue(game, debridPage(), '/data', [image('Game.exfat', 'https://other.example/Game.exfat')]);
  for (const wait of [30e3, 2 * MIN, 10 * MIN]) {
    const job = await until(queue, id, (item) => item.state === 'failed' && item.retryAt);
    assert.ok(job.retryAt - Date.now() <= wait && job.retryAt - Date.now() > wait / 2, `waits ${wait} ms`);
    t.mock.timers.tick(wait);
  }
  const job = await until(queue, id, (item) => item.state === 'failed' && !item.retryAt && links === 5);
  assert.match(job.error, /link kept expiring/);
  assert.equal(job.release.debrid?.service, 'torbox', 'not switched to another source: the link, not the source');
});

test('debrid link: at most six renewals an hour', async () => {
  const fs = memoryFs();
  let links = 0;
  const sources = { resolve: async () => ({ url: `https://store.torbox.example/dl/${++links}` }) };
  const downloads = engine(fs, (options, index) => ({ error: refused(), written: (index + 1) * 100 }));
  const queue = queueWith({ fs, downloads, sources });
  const job = await settle(queue, queue.enqueue(game, debridPage(), '/data'));
  assert.equal(job.state, 'failed');
  assert.equal(links, 7, 'the first link and six renewals');
  assert.match(job.error, /link kept expiring/);
});

test('debrid link: one about to expire is renewed during the download, and before a resume starts on it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  const fs = memoryFs();
  let links = 0;
  const sources = { resolve: async () => ({ url: `https://store.torbox.example/dl/${++links}` }) };
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const downloads = engine(fs, (options, index) => index === 0 ? { gate, written: 10 } : null);
  const queue = queueWith({ fs, downloads, sources });
  const id = queue.enqueue(game, debridPage(), '/data');
  await until(queue, id, () => downloads.tasks.length === 1);
  t.mock.timers.tick(151 * MIN);
  for (let i = 0; i < 20; i++) downloads.tasks[0].emit({ state: 'downloading', written: 20 + i });
  const job = await settle(queue, id);
  open();
  assert.equal(job.state, 'downloaded', job.error);
  assert.equal(links, 2, 'renewed while it downloaded');
  assert.equal(downloads.requests[1].url, 'https://store.torbox.example/dl/2');
  // A paused job whose link aged past the limit asks for a new one before it resumes.
  const fs2 = memoryFs();
  let links2 = 0;
  const downloads2 = engine(fs2, (options, index) => index === 0 ? { error: Object.assign(new Error('cancelled'), { name: 'AbortError' }) } : null);
  const queue2 = queueWith({ fs: fs2, downloads: downloads2, sources: { resolve: async () => ({ url: `https://store.torbox.example/x/${++links2}` }) } });
  const id2 = queue2.enqueue(game, debridPage(), '/data');
  await until(queue2, id2, (item) => item.state === 'failed');
  t.mock.timers.tick(151 * MIN);
  queue2.resume(id2);
  const resumed = await settle(queue2, id2);
  assert.equal(resumed.state, 'downloaded', resumed.error);
  assert.equal(links2, 2);
  assert.equal(downloads2.requests[1].url, 'https://store.torbox.example/x/2');
});


// ---- glibren: simultaneous downloads (Settings, state/simultaneous-downloads.js) ----

const other = (n) => ({ ...game, id: `PPSA0${n}000`, titleId: `PPSA0${n}000` });
const requested = (downloads, name) => downloads.requests.some((options) => options.destination.endsWith(name));

test('simultaneous: with 2, two download at once and the third waits; one ending starts it', async () => {
  const fs = memoryFs();
  const gates = [gated(), gated(), gated()];
  const downloads = engine(fs, (options, index) => ({ gate: gates[index].gate }));
  const queue = queueWith({ fs, downloads, concurrency: () => 2 });
  const ids = ['Alpha', 'Beta', 'Gamma'].map((name, i) => queue.enqueue(other(i + 1), image(`${name}.exfat`), '/data'));
  await until(queue, ids[1], () => downloads.requests.length === 2);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(downloads.requests.length, 2, 'the third waits for a free lane');
  assert.equal(queue.running, 2);
  assert.equal(queue.snapshot().find((job) => job.id === ids[2]).state, 'queued');
  gates[1].open();
  await until(queue, ids[2], () => downloads.requests.length === 3);
  assert.ok(requested(downloads, 'Gamma.exfat'));
  gates[0].open(); gates[2].open();
  for (const id of ids) assert.equal((await settle(queue, id)).state, 'downloaded');
});

test('simultaneous: the default is one at a time, as the queue always was', async () => {
  const fs = memoryFs();
  const first = gated();
  const downloads = engine(fs, (options, index) => index === 0 ? { gate: first.gate } : null);
  const queue = queueWith({ fs, downloads });
  const a = queue.enqueue(other(1), image('Alpha.exfat'), '/data');
  const b = queue.enqueue(other(2), image('Beta.exfat'), '/data');
  await until(queue, a, () => downloads.requests.length === 1);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(downloads.requests.length, 1);
  first.open();
  assert.equal((await settle(queue, b)).state, 'downloaded');
});

test('simultaneous: pausing one of those running starts the next', async () => {
  const fs = memoryFs();
  const gates = [gated(), gated(), gated()];
  const downloads = engine(fs, (options, index) => ({ gate: gates[index].gate }));
  const queue = queueWith({ fs, downloads, concurrency: () => 2 });
  const ids = ['Alpha', 'Beta', 'Gamma'].map((name, i) => queue.enqueue(other(i + 1), image(`${name}.exfat`), '/data'));
  await until(queue, ids[1], () => downloads.requests.length === 2);
  queue.pause(ids[0]);
  await until(queue, ids[0], (job) => job.state === 'paused');
  await until(queue, ids[2], () => downloads.requests.length === 3);
  assert.equal(queue.snapshot().find((job) => job.id === ids[1]).state !== 'paused', true, 'the other keeps going');
  gates[1].open(); gates[2].open();
  for (const id of ids.slice(1)) assert.equal((await settle(queue, id)).state, 'downloaded');
});

test('simultaneous: lowering the number stops none; raising it starts more at once; the engine hears each', async () => {
  const fs = memoryFs();
  const gates = [gated(), gated(), gated(), gated()];
  const downloads = engine(fs, (options, index) => ({ gate: gates[index].gate }));
  const told = [];
  downloads.setConcurrency = (n) => { told.push(n); return n; };
  let count = 2;
  const queue = queueWith({ fs, downloads, concurrency: () => count });
  assert.deepEqual(told, [2], 'the engine hears it when the queue starts');
  const ids = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((name, i) => queue.enqueue(other(i + 1), image(`${name}.exfat`), '/data'));
  await until(queue, ids[1], () => downloads.requests.length === 2);
  count = 1;
  queue.concurrencyChanged();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(queue.running, 2, 'both keep running');
  assert.ok(!downloads.tasks.some((task) => task.cancelled), 'none was cancelled');
  gates[0].open();
  await settle(queue, ids[0]);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(downloads.requests.length, 2, 'one still runs, so none starts while it is over the new number');
  count = 3;
  queue.concurrencyChanged();
  await until(queue, ids[3], () => downloads.requests.length === 4);
  assert.deepEqual(told, [2, 1, 3]);
  gates[1].open(); gates[2].open(); gates[3].open();
  for (const id of ids) assert.equal((await settle(queue, id)).state, 'downloaded');
});

test('simultaneous: what the other downloads on the drive still need counts as taken; one that fits only after them waits', async () => {
  const fs = memoryFs();
  const first = gated();
  const downloads = engine(fs, (options, index) => index === 0 ? { gate: first.gate } : null);
  let count = 1;
  const queue = queueWith({ fs, downloads, concurrency: () => count });
  const a = queue.enqueue(other(1), image('Alpha.exfat', 'https://example.com/Alpha.exfat', 100 * MiB), '/data');
  const b = queue.enqueue(other(2), image('Beta.exfat', 'https://example.com/Beta.exfat', 100 * MiB), '/data');
  await until(queue, a, () => downloads.requests.length === 1);
  // Alone, Beta (100 MiB) would fit in 150 MiB; beside Alpha's 100 MiB still to come, it does not yet.
  fs.free = 16 * MiB + 150 * MiB;
  count = 2;
  queue.concurrencyChanged();
  let beta = await until(queue, b, (job) => job.roomWait);
  assert.equal(beta.state, 'queued');
  assert.equal(beta.message, en['downloads.waitingForDownloads']);
  assert.equal(downloads.requests.length, 1, 'Beta was not handed to the engine');
  first.open();
  beta = await settle(queue, b);
  assert.equal(beta.state, 'downloaded', beta.error);
  assert.equal(downloads.requests.length, 2);
});

test('simultaneous: downloads from the same host share its connections (at least 2 each)', async () => {
  const fs = memoryFs();
  const gates = [gated(), gated(), gated()];
  const downloads = engine(fs, (options, index) => ({ gate: gates[index].gate, written: 1 }));
  const queue = queueWith({ fs, downloads, concurrency: () => 3 });
  const ids = ['Alpha', 'Beta', 'Gamma'].map((name, i) => queue.enqueue(other(i + 1), image(`${name}.exfat`, i < 2 ? `https://archive.org/download/item/${name}.exfat` : `https://example.com/${name}.exfat`), '/data'));
  await until(queue, ids[2], () => downloads.requests.length === 3);
  const byName = (name) => downloads.requests.find((options) => options.destination.endsWith(name));
  assert.equal(byName('Alpha.exfat').connections, 8, 'the first from archive.org: its whole table entry');
  assert.equal(byName('Beta.exfat').connections, 4, 'the second shares it: 8 / 2');
  assert.equal(byName('Gamma.exfat').connections, 64, 'another host keeps its own');
  for (const gate of gates) gate.open();
  for (const id of ids) assert.equal((await settle(queue, id)).state, 'downloaded');
});

test('simultaneous: the setting is 1 to 4 and heard by those listening', async () => {
  const settings = await load('app/state/simultaneous-downloads.js');
  const heard = [];
  const stop = settings.onSimultaneousDownloads((n) => heard.push(n));
  assert.equal(settings.simultaneousDownloads(), 1);
  settings.setSimultaneousDownloads(3);
  settings.setSimultaneousDownloads(7);
  assert.equal(settings.simultaneousDownloads(), 3, 'anything but 1 to 4 is ignored');
  settings.setSimultaneousDownloads(1);
  stop();
  settings.setSimultaneousDownloads(2);
  assert.deepEqual(heard, [3, 1]);
  settings.setSimultaneousDownloads(1);
});

// ---- glibren: the whole queue handed to the background payload ahead (background-downloads.js syncQueue) ----

const later = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

test('handoff: the queue not started goes to the payload in order; a host page only waits; pausing or cancelling here takes it out', async () => {
  const fs = memoryFs();
  const first = gated();
  const downloads = engine(fs, (options, index) => index === 0 ? { gate: first.gate } : null);
  const handed = [];
  let ahead = true;
  downloads.queueAhead = () => ahead;
  downloads.syncQueue = (items) => handed.push(items);
  const queue = queueWith({ fs, downloads });
  const a = queue.enqueue(other(1), image('Alpha.exfat'), '/data');
  const b = queue.enqueue(other(2), image('Beta.exfat'), '/data');
  const c = queue.enqueue(other(3), page('Gamma.exfat'), '/data');
  const d = queue.enqueue(other(4), image('Delta.exfat'), '/data');
  await until(queue, a, () => downloads.requests.length === 1);
  await later();
  let last = handed.at(-1);
  assert.deepEqual(last.map((item) => item.key), [b, c, d], 'the one running in the app is not handed; the rest in order');
  assert.equal(last[0].request.url, 'https://example.com/Beta.exfat');
  assert.equal(last[0].request.background.title, 'Test Game');
  assert.ok(last[0].request.destination.startsWith('/data/'));
  assert.equal(last[1].request, undefined, 'a host page needs the app to read its link: it only waits');
  assert.equal(last[1].total, 1000);
  assert.equal(queue.snapshot().find((job) => job.id === b).downloadDestination, last[0].request.destination, 'the app downloads it where the payload would');
  queue.pause(b);
  await queue.cancel(d);
  await later();
  last = handed.at(-1);
  // glibren.8: paused here it stays (paused, with its progress) so the phone page still shows it; cancelled leaves.
  assert.deepEqual(last.map((item) => [item.key, Boolean(item.paused)]), [[b, true], [c, false]], 'paused stays (marked), cancelled leaves the payload');
  assert.equal(last[0].written, 0);
  assert.ok(last[0].request, 'with its job, so the payload can resume it alone when the app is closed');
  ahead = false;
  queue.resume(b);
  await later();
  assert.deepEqual(handed.at(-1), [], 'with the background off nothing is handed');
  first.open();
  for (const id of [a, b]) assert.equal((await settle(queue, id)).state, 'downloaded');
});

test('handoff (glibren.8): the phone pauses, resumes and cancels queue items here by key; a waiting item (no path) too', async () => {
  const fs = memoryFs();
  const first = gated();
  const downloads = engine(fs, (options, index) => index === 0 ? { gate: first.gate } : null);
  const handed = [];
  downloads.queueAhead = () => true;
  downloads.syncQueue = (items) => handed.push(items);
  const queue = queueWith({ fs, downloads });
  const a = queue.enqueue(other(1), image('Alpha.exfat'), '/data');
  const b = queue.enqueue(other(2), image('Beta.exfat'), '/data');
  const c = queue.enqueue(other(3), page('Gamma.exfat'), '/data');
  await until(queue, a, () => downloads.requests.length === 1);
  const state = (id) => queue.snapshot().find((job) => job.id === id)?.state;
  queue.remoteAction('', 'pause', c);
  assert.equal(state(c), 'paused', 'a waiting item, by its key');
  queue.remoteAction('', 'pause', 'nope');
  queue.remoteAction('', 'resume');
  assert.equal(state(b), 'queued', 'no key and no path: nothing (an empty path matches no job)');
  queue.pause(b);
  await later();
  assert.deepEqual(handed.at(-1).map((item) => [item.key, Boolean(item.paused)]), [[b, true], [c, true]], 'both shown paused on the phone');
  const destination = handed.at(-1)[0].request.destination;
  queue.remoteAction(destination, 'resume', b);
  assert.equal(state(b), 'queued', 'resumed on the phone: back in the queue here');
  queue.remoteAction('', 'cancel', c);
  await later();
  assert.ok(!queue.snapshot().some((job) => job.id === c), 'cancelled on the phone: gone here too');
  assert.deepEqual(handed.at(-1).map((item) => [item.key, Boolean(item.paused)]), [[b, false]]);
  first.open();
  for (const id of [a, b]) assert.equal((await settle(queue, id)).state, 'downloaded');
});

test('handoff: a TorBox link is asked ahead (at most a few, one at a time) so the payload can download it alone', async () => {
  const fs = memoryFs();
  const first = gated();
  const downloads = engine(fs, (options, index) => index === 0 ? { gate: first.gate } : null);
  const handed = [];
  downloads.queueAhead = () => true;
  downloads.syncQueue = (items) => handed.push(items);
  const asked = [];
  const sources = { resolve: async (release) => { asked.push(release.url); return { url: `https://torbox.example/dl/${asked.length}` }; } };
  const queue = queueWith({ fs, downloads, sources });
  const a = queue.enqueue(other(1), image('Alpha.exfat'), '/data');
  const t = queue.enqueue(other(2), debridPage(), '/data');
  await until(queue, a, () => downloads.requests.length === 1);
  for (let i = 0; i < 20 && !handed.at(-1)?.[0]?.request; i++) await later(100);
  const item = handed.at(-1).find((entry) => entry.key === t);
  assert.ok(item.request, 'once its link was had, it goes to the payload');
  assert.match(item.request.url, /^https:\/\/torbox\.example\/dl\//);
  assert.equal(asked.length, 1, 'asked once');
  first.open();
  assert.equal((await settle(queue, t)).state, 'downloaded');
  assert.equal(asked.length, 1, 'the app downloads it with the link asked ahead, without a second TorBox request');
});

test('tuning (glibren.7): the TorBox CDN gets 8 connections, shared by every download from any of its nodes', () => {
  assert.equal(tuningFor('https://nexus-244.latm.tb-cdn.cx/dld/x?token=').connections, 8);
  assert.equal(hostGroup('https://nexus-244.latm.tb-cdn.cx/dld/x'), 'tb-cdn.cx');
  assert.equal(hostGroup('https://store-031.weur.tb-cdn.cx/dld/y'), 'tb-cdn.cx', 'another node, the same group');
  assert.equal(hostGroup('https://ia800300.us.archive.org/1/items/x/a.zip'), 'archive.org');
  assert.equal(hostGroup('https://example.com/a.exfat'), 'example.com', 'a host not in the table is its own group');
});

test('simultaneous (glibren.7): two TorBox downloads on different CDN nodes share TorBox\'s 8 connections', async () => {
  const fs = memoryFs();
  const gates = [gated(), gated()];
  const downloads = engine(fs, (options, index) => ({ gate: gates[index].gate, written: 1 }));
  const queue = queueWith({ fs, downloads, concurrency: () => 2 });
  const ids = [['Alpha', 'nexus-244.latm'], ['Beta', 'store-031.weur']].map(([name, node], i) => queue.enqueue(other(i + 1), image(`${name}.exfat`, `https://${node}.tb-cdn.cx/dld/${name}`), '/data'));
  await until(queue, ids[1], () => downloads.requests.length === 2);
  const byName = (name) => downloads.requests.find((options) => options.destination.endsWith(name));
  assert.equal(byName('Alpha.exfat').connections, 8, 'the first: all of TorBox\'s 8');
  assert.equal(byName('Beta.exfat').connections, 4, 'the second, on another node, shares them: 8 / 2');
  for (const gate of gates) gate.open();
  for (const id of ids) assert.equal((await settle(queue, id)).state, 'downloaded');
});
