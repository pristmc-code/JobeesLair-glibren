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
const { DEFAULT_TUNING, HOST_TUNING, rangeFor, tuningFor } = await load('app/state/download-tuning.js');
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
function engine(fs, plan = () => null) {
  const requests = [];
  return {
    requests,
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
      return { subscribe: () => () => {}, done, cancel: () => cancel() };
    },
  };
}

function queueWith({ fs, downloads, archives = null, sources, platform = 'desktop', notices = [], wait }) {
  return createDownloadQueue({
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
