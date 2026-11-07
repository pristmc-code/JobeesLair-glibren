// The download speed limit (state/speed-limit.js): saved in settings.json, handed to the engine in bytes per
// second, and the app's own update exempt. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const core = await import('@ps5-react/core');
const applied = [];
core.Downloads.setRateLimit = (bytes) => applied.push(bytes);
// settings.json in memory, where the stub's FileSystem keeps nothing.
const files = new Map();
Object.assign(core.FileSystem, {
  exists: (p) => files.has(p), readFile: (p) => files.get(p), writeFile: (p, text) => files.set(p, text),
  rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); }, mkdir() {},
});
const SETTINGS = '/download0/JobeesLair/settings.json';

test('a saved limit no longer offered becomes the nearest one; setting one saves and applies it in bytes', async () => {
  files.set(SETTINGS, JSON.stringify({ vibration: true, speedLimit: 40 }));
  const { LIMITS, applySpeedLimit, setSpeedLimit, onSpeedLimit } = await load('app/state/speed-limit.js');
  // glibren.13: the phone page offers the same list; the old choices (25, 10, 5) are still in it.
  assert.deepEqual(LIMITS, [0, 50, 25, 15, 10, 5, 3, 2, 1]);
  const heard = [];
  const stop = onSpeedLimit((limit) => heard.push(limit));
  applySpeedLimit();
  assert.deepEqual(applied, [50 * 1024 ** 2], '40 MB/s is not offered: the nearest, 50');
  setSpeedLimit(10);
  assert.equal(applied.at(-1), 10 * 1024 ** 2);
  assert.deepEqual(JSON.parse(files.get(SETTINGS)), { vibration: true, speedLimit: 10 }, 'the other settings kept');
  setSpeedLimit(7);
  assert.equal(applied.length, 2, 'a value not offered is ignored');
  setSpeedLimit(0);
  assert.equal(applied.at(-1), 0);
  assert.deepEqual(JSON.parse(files.get(SETTINGS)), { vibration: true }, 'no limit: nothing saved');
  assert.deepEqual(heard, [10, 0], 'onSpeedLimit hears each change (not the ignored one)');
  stop();
  setSpeedLimit(1);
  assert.deepEqual(heard, [10, 0], 'and stops when asked');
  assert.equal(applied.at(-1), 1024 ** 2);
});

test('glibren.13: a limit chosen on the phone page is adopted as the nearest one offered', async () => {
  const { adoptSpeedLimit, speedLimitNow } = await load('app/state/speed-limit.js');
  adoptSpeedLimit(25);
  assert.equal(speedLimitNow(), 25);
  adoptSpeedLimit(12);
  assert.equal(speedLimitNow(), 10);
  assert.equal(applied.at(-1), 10 * 1024 ** 2);
  adoptSpeedLimit(0);
  assert.equal(speedLimitNow(), 0);
  adoptSpeedLimit(-3);
  adoptSpeedLimit('5');
  assert.equal(speedLimitNow(), 0, 'nonsense is ignored');
});

test("the app's own update downloads unlimited", () => {
  const source = readFileSync(path.join(repo, 'app/state/auto-update.js'), 'utf8');
  assert.match(source, /downloads\.enqueue\(\{[^}]*unlimited: true/);
});
