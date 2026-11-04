// The debrid API keys sealed in debrid.json (app/state/debrid.js, app/state/secret-box.js): the cipher against Node's
// own SHA-256 and HMAC, the move of a plain key saved by an earlier build, and what a copy of debrid.json without its
// secret gives (nothing). The runtime's FileSystem is the test loader's stub over globalThis.__stubFiles. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const url = (rel) => pathToFileURL(path.join(repo, rel)).href;
const box = await import(url('app/state/secret-box.js'));
let copies = 0;
const freshDebrid = () => import(`${url('app/state/debrid.js')}?copy=${copies++}`);

const TORBOX = '0123abcd-4567-89ef-0123-456789abcdef';
const ALLDEBRID = 'abcDEF1234567890abcd';
const FILE = '/download0/JobeesLair/debrid.json';
const SECRET = '/download0/JobeesLair/.debrid.secret';

test('secret box: SHA-256 and HMAC-SHA-256 match Node\'s, at every padding boundary', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const text = 'x'.repeat(length);
    assert.equal(box.hex(box.sha256(box.utf8(text))), createHash('sha256').update(text).digest('hex'), `sha256 of ${length} bytes`);
  }
  assert.equal(box.hex(box.sha256(box.utf8('é ✓ 𝄞'))), createHash('sha256').update('é ✓ 𝄞').digest('hex'));
  for (const key of ['k', 'k'.repeat(64), 'k'.repeat(100)]) {
    assert.equal(box.hex(box.hmac(box.utf8(key), box.utf8('message'))), createHmac('sha256', key).update('message').digest('hex'));
  }
});

test('secret box: opens only with its own secret and only unchanged; never the same box twice', () => {
  const secret = box.newSecret('entropy');
  assert.match(secret, /^[0-9a-f]{64}$/);
  const sealed = box.seal(TORBOX, secret, 'more entropy');
  assert.match(sealed, /^v1\.[0-9a-f]{32}\.[0-9a-f]+\.[0-9a-f]{64}$/);
  assert.ok(!sealed.includes(TORBOX));
  assert.equal(box.open(sealed, secret), TORBOX);
  assert.notEqual(box.seal(TORBOX, secret), sealed, 'a fresh nonce each time');
  assert.equal(box.open(sealed, box.newSecret('another')), null, 'another secret');
  const [v, nonce, cipher, mac] = sealed.split('.');
  const flipped = (cipher[0] === '0' ? '1' : '0') + cipher.slice(1);
  assert.equal(box.open([v, nonce, flipped, mac].join('.'), secret), null, 'a changed byte');
  assert.equal(box.open('v2.00.00.00', secret), null);
  assert.equal(box.open(TORBOX, secret), null);
  assert.equal(box.open(box.seal('ünïcode ✓', secret), secret), 'ünïcode ✓');
});

test('debrid keys: a plain key from an earlier build is sealed on first read; the secret is kept apart', async () => {
  globalThis.__stubFiles = new Map([[FILE, JSON.stringify({ torbox: { key: TORBOX, items: { abc: { kind: 'webdl', id: 7, at: 1 } } }, alldebrid: { key: ALLDEBRID } })]]);
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const debrid = await freshDebrid();
    const view = debrid.debridSnapshot();
    assert.equal(view.configured, true);
    assert.equal(view.masked, '•••• cdef');
    assert.equal(view.allDebrid.masked, '•••• abcd');
    assert.equal(debrid.activeService(), 'torbox');
    const saved = JSON.parse(globalThis.__stubFiles.get(FILE));
    assert.ok(!('key' in saved.torbox) && !('key' in saved.alldebrid), 'no plain key left');
    assert.match(saved.torbox.keyBox, /^v1\./);
    assert.deepEqual(saved.torbox.items, { abc: { kind: 'webdl', id: 7, at: 1 } }, 'the rest of the record kept');
    const text = globalThis.__stubFiles.get(FILE);
    assert.ok(!text.includes(TORBOX) && !text.includes(ALLDEBRID));
    assert.match(globalThis.__stubFiles.get(SECRET), /^[0-9a-f]{64}$/);
    assert.ok(!text.includes(globalThis.__stubFiles.get(SECRET)), 'the secret is not in debrid.json');
    // A new key is sealed too; removing it leaves neither form.
    debrid.setTorBoxKey('ffffffff-4567-89ef-0123-456789abcdef');
    assert.equal(debrid.debridSnapshot().masked, '•••• cdef');
    assert.ok(!globalThis.__stubFiles.get(FILE).includes('ffffffff-4567'));
    debrid.setTorBoxKey('');
    const cleared = JSON.parse(globalThis.__stubFiles.get(FILE)).torbox;
    assert.ok(!('key' in cleared) && !('keyBox' in cleared));
    assert.equal(debrid.activeService(), 'alldebrid');
  } finally {
    console.log = log;
  }
  assert.ok(lines.every((line) => !line.includes(TORBOX) && !line.includes(ALLDEBRID) && !line.includes('ffffffff-4567')), 'no key in any log line');
  delete globalThis.__stubFiles;
});

test('debrid keys: debrid.json copied without its secret (or altered) gives no key, and says to add it again', async () => {
  globalThis.__stubFiles = new Map([[FILE, JSON.stringify({ torbox: { key: TORBOX } })]]);
  (await freshDebrid()).debridSnapshot();
  const sealed = globalThis.__stubFiles.get(FILE);
  // Another console, or the file alone: the same debrid.json, no secret beside it.
  globalThis.__stubFiles = new Map([[FILE, sealed]]);
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const elsewhere = await freshDebrid();
    assert.equal(elsewhere.debridSnapshot().configured, false);
    assert.equal(elsewhere.activeService(), null);
  } finally {
    console.log = log;
  }
  assert.ok(lines.some((line) => /could not be unsealed/.test(line)));
  delete globalThis.__stubFiles;
});

test('debrid keys: where no secret can be kept, a key stays as it was rather than be lost', async () => {
  // No files at all behind the stub: nothing written can be read back.
  delete globalThis.__stubFiles;
  const log = console.log;
  console.log = () => {};
  try {
    const debrid = await freshDebrid();
    debrid.setTorBoxKey(TORBOX);
    assert.equal(debrid.debridSnapshot().configured, true);
    assert.equal(debrid.activeService(), 'torbox');
    debrid.setTorBoxKey('');
  } finally {
    console.log = log;
  }
});
