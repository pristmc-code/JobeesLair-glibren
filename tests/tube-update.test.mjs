// glibren-tube-update: o servico do YouTube (tube-service.elf) se atualizando sozinho (app/state/tube-update.js), o
// Ed25519/SHA-512 em JS puro (app/state/ed25519.js) contra o node:crypto, o verificador do app ignorando as tags
// tube-service-* (app/state/updater.js), e a subida com volta para a anterior/embutida (app/state/tube-service.js). Run: node --import ./tests/stub-loader.mjs --test tests/tube-update.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { sha512, verify, fromHex } = await import('../app/state/ed25519.js');
const { createTubeUpdater, manifestMessage, parseManifest, tubeTags, PUBLIC_KEY } = await import('../app/state/tube-update.js');
const { createUpdateChecker, describe, isTubeServiceTag } = await import('../app/state/updater.js');
const { createTubeService, TUBE_API } = await import('../app/state/tube-service.js');

// ---- chaves e manifestos de teste (nunca a chave real) ----
function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, hex: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex') };
}
const KEY = keyPair();
const OTHER = keyPair();
function manifest(fields = {}, key = KEY) {
  const m = { format: 1, name: 'tube-service', version: '0.2.0', api: 1, min_jobe: 1, size: 1000, sha256: 'ab'.repeat(32), ...fields };
  const signature = crypto.sign(null, Buffer.from(manifestMessage(m), 'ascii'), key.privateKey).toString('hex');
  return { ...m, signature, ...(fields.signature ? { signature: fields.signature } : {}) };
}

test('sha512 matches node:crypto (empty, block edges, several blocks)', () => {
  for (const n of [0, 1, 111, 112, 127, 128, 129, 255, 256, 1000]) {
    const bytes = crypto.randomBytes(n);
    assert.equal(Buffer.from(sha512([...bytes])).toString('hex'), crypto.createHash('sha512').update(bytes).digest('hex'), `${n} bytes`);
  }
});

test('Ed25519 verify: node:crypto signatures pass; another key, another message, a flipped bit or s >= L fail', () => {
  const message = [...Buffer.from('jobe-tube-service\nformat=1\n')];
  const signature = [...crypto.sign(null, Buffer.from(message), KEY.privateKey)];
  assert.equal(verify(signature, message, fromHex(KEY.hex)), true);
  assert.equal(verify(signature, message, fromHex(OTHER.hex)), false, 'other key');
  assert.equal(verify(signature, [...message, 10], fromHex(KEY.hex)), false, 'other message');
  for (const index of [0, 31, 32, 63]) {
    const bad = signature.slice();
    bad[index] ^= 1;
    assert.equal(verify(bad, message, fromHex(KEY.hex)), false, `bit flipped at ${index}`);
  }
  // s + L: the same point, but not canonical (RFC 8032 rejects it).
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = s << 8n | BigInt(signature[i]);
  s += L;
  const malleable = signature.slice(0, 32);
  for (let i = 0; i < 32; i++) malleable.push(Number(s >> BigInt(8 * i) & 255n));
  assert.equal(verify(malleable, message, fromHex(KEY.hex)), false, 's >= L');
  assert.equal(verify([], message, fromHex(KEY.hex)), false);
  assert.equal(verify(signature, message, null), false);
});

test('the embedded public key is the glibren one (32 bytes)', () => {
  assert.match(PUBLIC_KEY, /^[0-9a-f]{64}$/);
  assert.equal(PUBLIC_KEY, 'ce2767604727310aa1b2a5713fe7b76774b7ecd8c68240fef789819a473847c0');
});

test('parseManifest: valid; bad JSON, missing field, wrong signature, tampered sha256/size, other version, old api, newer Jobe', () => {
  const opts = { publicKey: KEY.hex, version: '0.2.0', api: 1, clientApi: 1 };
  const good = manifest();
  assert.equal(parseManifest(JSON.stringify(good), opts).ok, true);
  assert.equal(parseManifest(good, opts).manifest.sha256, good.sha256);
  assert.equal(parseManifest('{', opts).reason, 'json');
  assert.equal(parseManifest({ ...good, sha256: undefined }, opts).reason, 'fields');
  assert.equal(parseManifest({ ...good, size: 64 * 1024 * 1024 }, opts).reason, 'fields', 'too big');
  assert.equal(parseManifest(manifest({}, OTHER), opts).reason, 'signature', 'signed by another key');
  assert.equal(parseManifest({ ...good, sha256: 'cd'.repeat(32) }, opts).reason, 'signature', 'sha256 changed after signing');
  assert.equal(parseManifest({ ...good, size: 999 }, opts).reason, 'signature', 'size changed after signing');
  assert.equal(parseManifest(manifest({ version: '0.3.0' }), opts).reason, 'version', 'not the tag version');
  assert.equal(parseManifest(manifest({ api: 1 }), { ...opts, api: 2 }).reason, 'api');
  assert.equal(parseManifest(manifest({ min_jobe: 2 }), opts).reason, 'jobe');
  assert.equal(parseManifest(good, { publicKey: PUBLIC_KEY, version: '0.2.0' }).reason, 'signature', 'the real key did not sign the test manifest');
});

test('tubeTags: only tube-service-<version> tags, newest first', () => {
  const refs = ['refs/tags/v0.5.5-glibren.37', 'refs/tags/tube-service-0.1.0', 'refs/tags/tube-service-0.10.0', 'refs/tags/tube-service-0.2.0', 'refs/tags/tube-service-banana', 'refs/tags/tube-service-0.2.0'].map((ref) => ({ ref }));
  assert.deepEqual(tubeTags(refs), ['0.10.0', '0.2.0', '0.1.0']);
  assert.deepEqual(tubeTags(null), []);
});

// ---- o verificador do app nunca toma uma tag tube-service-* por versao do app ----
test('the app update checker ignores tube-service-* tags, even as the latest release', async () => {
  assert.equal(isTubeServiceTag('tube-service-0.2.0'), true);
  assert.equal(isTubeServiceTag('v0.5.5-glibren.38'), false);
  assert.equal(describe({ tag_name: 'tube-service-0.2.0', assets: [] }, 'o/r'), null);
  const asked = [];
  const app = { tag_name: 'v0.5.5-glibren.38', html_url: 'https://github.com/o/r/releases/tag/v0.5.5-glibren.38', body: '', assets: [] };
  const tube = { tag_name: 'tube-service-0.2.0', html_url: 'https://github.com/o/r/releases/tag/tube-service-0.2.0', body: '', assets: [] };
  const http = {
    async request(url) {
      asked.push(url);
      if (url.endsWith('/releases/latest')) return { status: 200, ok: true, json: async () => tube };
      if (url.includes('/releases?')) return { status: 200, ok: true, json: async () => [tube, { ...app, tag_name: 'v9.9.9', draft: true }, { ...app, tag_name: 'v9.9.8', prerelease: true }, app] };
      throw new Error(url);
    }
  };
  let saved = {};
  const checker = createUpdateChecker({ http, store: { get: () => saved, set: (value) => { saved = value; } }, version: '0.5.5-glibren.37', repo: 'o/r' });
  const { update } = await checker.check();
  assert.equal(update?.version, '0.5.5-glibren.38', 'the app release under the tube-service one');
  assert.equal(asked.length, 2);
  // Only tube-service releases: no app update.
  const onlyTube = { async request(url) { return url.endsWith('/latest') ? { status: 200, ok: true, json: async () => tube } : { status: 200, ok: true, json: async () => [tube] }; } };
  saved = {};
  const none = await createUpdateChecker({ http: onlyTube, store: { get: () => saved, set: (value) => { saved = value; } }, version: '0.5.5-glibren.37', repo: 'o/r' }).check();
  assert.equal(none.update, null);
});

// ---- um FileSystem, um Http e um Downloads de mentira ----
function fakeFs(initial = {}) {
  const files = new Map();
  let clock = 1;
  const put = (path, text, size) => files.set(path, { text: String(text), size: size ?? String(text).length, modified: clock++ });
  for (const [path, value] of Object.entries(initial)) typeof value === 'number' ? put(path, '', value) : put(path, value);
  return {
    files,
    put,
    exists: (path) => files.has(path),
    readFile(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path).text;
    },
    writeFile: (path, text) => put(path, text),
    rename(from, to) {
      if (!files.has(from)) throw new Error(`ENOENT ${from}`);
      files.set(to, { ...files.get(from), modified: clock++ });
      files.delete(from);
    },
    remove(path) {
      files.delete(path);
    },
    removeTree(path) {
      for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
    },
    mkdir() {},
    stat: (path) => files.has(path) ? { size: files.get(path).size, modified: files.get(path).modified, isFile: true } : null
  };
}
const DIR = '/data/JobeesLair/tube';
const REPO = 'o/r';
const releaseUrl = (version, name) => `https://github.com/${REPO}/releases/download/tube-service-${version}/${name}`;
function world({ tags = ['0.2.0'], manifests = {}, embedded = '0.1.0', files = {}, downloadFails = false, wrongSize = false } = {}) {
  const fs = fakeFs({ '/app0/tube-service.elf': 900, ...(embedded ? { '/app0/tube-service.json': JSON.stringify({ version: embedded, api: 1 }) } : {}), ...files });
  const asked = [];
  const http = {
    async request(url, options = {}) {
      asked.push(url);
      if (url.endsWith('/git/matching-refs/tags/tube-service-')) {
        assert.equal(options.headers['User-Agent'], 'JobeesLair');
        return { status: 200, ok: true, json: async () => tags.map((version) => ({ ref: `refs/tags/tube-service-${version}` })) };
      }
      const hit = Object.entries(manifests).find(([version]) => url === releaseUrl(version, 'tube-service.json'));
      if (hit) {
        assert.equal(options.headers, undefined, 'no custom headers: the GitHub download redirect is followed');
        return { status: 200, ok: true, text: async () => JSON.stringify(hit[1]) };
      }
      return { status: 404, ok: false, text: async () => '', json: async () => ({}) };
    }
  };
  const enqueued = [];
  const downloads = {
    enqueue(options) {
      enqueued.push(options);
      const done = downloadFails ? Promise.reject(new Error('SHA-256 mismatch')) : Promise.resolve().then(() => fs.put(options.destination, '', wrongSize ? options.expectedBytes - 1 : options.expectedBytes));
      return { done, cancel() {}, subscribe: () => () => {} };
    }
  };
  let t = 1e12;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const logs = [];
  const installed = [];
  const make = (extra = {}) => createTubeUpdater({ http, fs, downloads, repo: REPO, jobeVersion: '0.5.5-glibren.38', publicKey: KEY.hex, now: clock.now, log: (line) => logs.push(line), onInstalled: (version) => installed.push(version), ...extra });
  return { fs, http, asked, enqueued, downloads, clock, logs, installed, make };
}

test('check: a newer signed version is downloaded natively (sha256 + size, unlimited), installed atomically and preferred', async () => {
  const w = world({ manifests: { '0.2.0': manifest() } });
  const updater = w.make();
  assert.deepEqual(updater.candidates().map((c) => `${c.source}:${c.version}`), ['embedded:0.1.0']);
  const result = await updater.check();
  assert.deepEqual(result, { state: 'installed', version: '0.2.0' });
  assert.equal(w.enqueued.length, 1);
  assert.deepEqual({ ...w.enqueued[0] }, { url: releaseUrl('0.2.0', 'tube-service.elf'), destination: `${DIR}/incoming/tube-service.elf`, sha256: 'ab'.repeat(32), expectedBytes: 1000, unlimited: true });
  assert.equal(w.fs.stat(`${DIR}/tube-service.elf`).size, 1000);
  assert.equal(JSON.parse(w.fs.readFile(`${DIR}/tube-service.json`)).version, '0.2.0');
  assert.equal(w.fs.exists(`${DIR}/tube-service.json.tmp`), false);
  assert.equal(w.fs.exists(`${DIR}/incoming/tube-service.elf`), false);
  assert.deepEqual(updater.candidates().map((c) => `${c.source}:${c.version}`), ['downloaded:0.2.0', 'embedded:0.1.0']);
  assert.deepEqual(w.installed, ['0.2.0']);
  // At most once every 6 h.
  w.asked.length = 0;
  assert.equal((await updater.check()).state, 'recent');
  assert.equal(w.asked.length, 0);
  w.clock.advance(6 * 3600e3 + 1);
  assert.equal((await updater.check()).state, 'current', 'nothing newer than 0.2.0');
});

test('check: a second update keeps the first as the previous one (to go back to)', async () => {
  const w = world({ tags: ['0.2.0', '0.3.0'], manifests: { '0.2.0': manifest(), '0.3.0': manifest({ version: '0.3.0', size: 1200 }) } });
  const updater = w.make();
  w.fs.put(`${DIR}/tube-service.elf`, '', 1000);
  w.fs.put(`${DIR}/tube-service.json`, JSON.stringify(manifest()));
  assert.equal((await updater.check()).version, '0.3.0');
  assert.equal(JSON.parse(w.fs.readFile(`${DIR}/tube-service.prev.json`)).version, '0.2.0');
  assert.equal(w.fs.stat(`${DIR}/tube-service.prev.elf`).size, 1000);
  assert.deepEqual(updater.candidates().map((c) => `${c.source}:${c.version}`), ['downloaded:0.3.0', 'downloaded:0.2.0', 'embedded:0.1.0']);
});

test('check: an older or equal version than the built-in one is not downloaded; the built-in one goes first', async () => {
  const w = world({ embedded: '0.3.0', manifests: { '0.2.0': manifest() }, files: { [`${DIR}/tube-service.elf`]: 1000, [`${DIR}/tube-service.json`]: JSON.stringify(manifest()) } });
  const updater = w.make();
  assert.deepEqual(updater.candidates().map((c) => `${c.source}:${c.version}`), ['embedded:0.3.0', 'downloaded:0.2.0'], 'a newer Jobe brings a newer built-in service');
  assert.equal((await updater.check()).state, 'current');
  assert.equal(w.enqueued.length, 0);
});

test('check: a wrong signature, a manifest for another version or one that needs a newer Jobe is never downloaded', async () => {
  for (const [bad, state] of [[manifest({}, OTHER), 'refused'], [manifest({ version: '0.9.0' }), 'refused'], [{ ...manifest(), sha256: 'cd'.repeat(32) }, 'refused'], [manifest({ min_jobe: 2 }), 'needs-app']]) {
    const w = world({ manifests: { '0.2.0': bad } });
    const result = await w.make().check();
    assert.equal(result.state, state);
    assert.equal(w.enqueued.length, 0);
    assert.equal(w.fs.exists(`${DIR}/tube-service.elf`), false);
  }
});

test('check: a download that fails its sha256 (or comes out the wrong size) changes nothing and is retried in 1 h', async () => {
  for (const options of [{ downloadFails: true }, { wrongSize: true }]) {
    const w = world({ manifests: { '0.2.0': manifest() }, ...options });
    const updater = w.make();
    const result = await updater.check();
    assert.equal(result.state, 'failed');
    assert.equal(w.fs.exists(`${DIR}/tube-service.elf`), false);
    assert.deepEqual(updater.candidates().map((c) => c.source), ['embedded']);
    w.clock.advance(30 * 60e3);
    assert.equal((await updater.check()).state, 'recent');
    w.clock.advance(31 * 60e3);
    assert.equal((await updater.check()).state, 'failed', 'tried again after an hour');
  }
});

test('check: off with the setting off; a version marked bad is neither used nor downloaded again', async () => {
  const off = world({ manifests: { '0.2.0': manifest() } });
  assert.equal((await off.make({ enabled: () => false }).check()).state, 'off');
  assert.equal(off.asked.length, 0);
  const w = world({ manifests: { '0.2.0': manifest() } });
  const updater = w.make();
  await updater.check();
  updater.markBad('0.2.0', 'did not answer', { now: true });
  assert.deepEqual(updater.candidates().map((c) => `${c.source}:${c.version}`), ['embedded:0.1.0']);
  assert.equal((await updater.check({ force: true })).state, 'current');
  assert.equal(w.enqueued.length, 1, 'not downloaded again');
});

test('candidates: a downloaded file whose manifest was altered, or whose ELF has another size, is not used', () => {
  const w = world({ files: { [`${DIR}/tube-service.elf`]: 999, [`${DIR}/tube-service.json`]: JSON.stringify(manifest()) } });
  assert.deepEqual(w.make().candidates().map((c) => c.source), ['embedded'], 'size differs');
  const v = world({ files: { [`${DIR}/tube-service.elf`]: 1000, [`${DIR}/tube-service.json`]: JSON.stringify({ ...manifest(), version: '0.9.0' }) } });
  assert.deepEqual(v.make().candidates().map((c) => c.source), ['embedded'], 'altered manifest');
  // The built-in version unknown (no tube-service.json in the package): a valid download goes first; once the
  // built-in one ran, its version (from /v1/health) is remembered for this Jobe.
  const u = world({ embedded: null, files: { [`${DIR}/tube-service.elf`]: 1000, [`${DIR}/tube-service.json`]: JSON.stringify(manifest()) } });
  const updater = u.make();
  assert.deepEqual(updater.candidates().map((c) => `${c.source}:${c.version}`), ['downloaded:0.2.0', 'embedded:null']);
  updater.noteRunning('embedded', '0.4.0');
  assert.deepEqual(updater.candidates().map((c) => `${c.source}:${c.version}`), ['embedded:0.4.0', 'downloaded:0.2.0']);
  assert.deepEqual(updater.inUse(), { source: 'embedded', version: '0.4.0' });
});

// ---- a subida: o baixado que nao responde volta para o embutido ----
function serviceWorld({ broken = [], versions = {} } = {}) {
  const w = world({ manifests: { '0.2.0': manifest() } });
  w.fs.put(`${DIR}/token`, 'c'.repeat(64));
  const net = { up: null, sends: [], quits: 0 };
  const http = {
    async request(url, { method = 'GET' } = {}) {
      const path = url.replace('http://127.0.0.1:34210', '');
      if (!net.up) throw new Error("Couldn't connect to server");
      if (path === '/v1/health') return { status: 200, ok: true, json: async () => ({ api_version: 1, api: TUBE_API, version: net.up, service: 'tube-service', pid: 7 }) };
      if (method === 'POST' && path === '/v1/quit') {
        net.quits++;
        net.up = null;
        return { status: 200, ok: true, json: async () => ({ state: 'stopping' }) };
      }
      return { status: 404, ok: false, json: async () => ({}) };
    }
  };
  const payloads = {
    send(path) {
      net.sends.push(path);
      if (!broken.includes(path)) net.up = versions[path] ?? '0.1.0';
      return { ok: true };
    }
  };
  return { w, net, http, payloads };
}

// glibren.42 (A6): marked bad only after BAD_AFTER failures in a row (it was the first one); the built-in one starts
// each time meanwhile.
test('ensure: a downloaded version that does not answer 3 times is marked bad; the built-in one starts instead each time', async () => {
  const { w, net, http, payloads } = serviceWorld({ broken: [`${DIR}/tube-service.elf`], versions: { '/app0/tube-service.elf': '0.1.0' } });
  const updater = w.make();
  await updater.check();
  const service = createTubeService({ http, fs: w.fs, payloads, platform: 'ps5', updater, startWaitMs: 60, startPollMs: 5, log: () => {} });
  const ready = await service.ensure();
  assert.deepEqual(ready, { ok: true, version: '0.1.0' });
  assert.deepEqual(net.sends, [`${DIR}/tube-service.elf`, '/app0/tube-service.elf']);
  assert.ok(!(JSON.parse(w.fs.readFile(`${DIR}/update.json`)).bad ?? []).includes('0.2.0'), 'one failure is not enough');
  assert.deepEqual(updater.candidates().map((c) => c.source), ['downloaded', 'embedded'], 'tried again next time');
  for (let n = 0; n < 2; n++) {
    net.up = null;
    assert.equal((await service.ensure()).version, '0.1.0');
  }
  assert.ok(JSON.parse(w.fs.readFile(`${DIR}/update.json`)).bad.includes('0.2.0'));
  assert.deepEqual(updater.candidates().map((c) => c.source), ['embedded']);
  assert.deepEqual(updater.inUse(), { source: 'embedded', version: '0.1.0' });
});

test('ensure: the downloaded version starts; an older service already up is used, and restarted only once nobody uses it', async () => {
  const { w, net, http, payloads } = serviceWorld({ versions: { [`${DIR}/tube-service.elf`]: '0.2.0' } });
  const updater = w.make();
  net.up = '0.1.0'; // the built-in one, started earlier
  const service = createTubeService({ http, fs: w.fs, payloads, platform: 'ps5', updater, startWaitMs: 60, startPollMs: 5, log: () => {} });
  const release = service.hold();
  assert.equal((await service.ensure()).version, '0.1.0', 'the video does not wait for the new version');
  await updater.check();
  assert.equal(await service.refreshIfIdle(), false, 'a screen still uses it');
  assert.equal(net.quits, 0);
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(net.quits, 1, 'restarted once idle');
  assert.deepEqual(await service.ensure(), { ok: true, version: '0.2.0' });
  assert.deepEqual(net.sends, [`${DIR}/tube-service.elf`]);
  assert.deepEqual(updater.inUse(), { source: 'downloaded', version: '0.2.0' });
});

// glibren.42 (A6): "Back to the built-in version" (Settings > Videos) marks the downloaded ones ahead of it as bad at once.
test('revertToEmbedded: the downloaded version ahead of the built-in one is set aside; a newer one is still downloaded later', async () => {
  const w = world({ manifests: { '0.2.0': manifest() } });
  const updater = w.make();
  await updater.check();
  assert.equal(updater.aheadOfEmbedded(), true);
  assert.deepEqual(updater.revertToEmbedded(), ['0.2.0']);
  assert.deepEqual(updater.candidates().map((c) => `${c.source}:${c.version}`), ['embedded:0.1.0']);
  assert.equal(updater.aheadOfEmbedded(), false);
  assert.deepEqual(updater.revertToEmbedded(), [], 'nothing left to set aside');
});

test('markBad: a version that started again forgets its failures', () => {
  const w = world({});
  const updater = w.make();
  assert.equal(updater.markBad('0.3.0', 'x'), false);
  assert.equal(updater.markBad('0.3.0', 'x'), false);
  updater.noteRunning('downloaded', '0.3.0');
  assert.equal(updater.markBad('0.3.0', 'x'), false, 'counted from zero again');
  assert.equal(updater.markBad('0.3.0', 'x'), false);
  assert.equal(updater.markBad('0.3.0', 'x'), true);
});
