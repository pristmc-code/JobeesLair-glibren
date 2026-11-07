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

test('glibren.13: any whole MB/s from 0 to 1000 (an old save still counts); setting one saves and applies it in bytes', async () => {
  files.set(SETTINGS, JSON.stringify({ vibration: true, speedLimit: 40 }));
  const { MAX_SPEED_LIMIT, applySpeedLimit, setSpeedLimit, onSpeedLimit } = await load('app/state/speed-limit.js');
  assert.equal(MAX_SPEED_LIMIT, 1000, 'the most the background payload takes');
  const heard = [];
  const stop = onSpeedLimit((limit) => heard.push(limit));
  applySpeedLimit();
  assert.deepEqual(applied, [40 * 1024 ** 2], 'the saved 40 MB/s as it was (no list to round to)');
  setSpeedLimit(37);
  assert.equal(applied.at(-1), 37 * 1024 ** 2);
  assert.deepEqual(JSON.parse(files.get(SETTINGS)), { vibration: true, speedLimit: 37 }, 'the other settings kept');
  for (const bad of [1001, -1, 2.5, '7', null]) setSpeedLimit(bad);
  assert.equal(applied.length, 2, 'out of range, fractions and text are ignored');
  setSpeedLimit(0);
  assert.equal(applied.at(-1), 0);
  assert.deepEqual(JSON.parse(files.get(SETTINGS)), { vibration: true }, 'no limit: nothing saved');
  assert.deepEqual(heard, [37, 0], 'onSpeedLimit hears each change (not the ignored ones)');
  stop();
  setSpeedLimit(1);
  assert.deepEqual(heard, [37, 0], 'and stops when asked');
  assert.equal(applied.at(-1), 1024 ** 2);
});

test('glibren.13: − / + step by 1 MB/s and stay within 0..1000', async () => {
  const { setSpeedLimit, stepSpeedLimit, speedLimitNow } = await load('app/state/speed-limit.js');
  setSpeedLimit(1);
  stepSpeedLimit(-1);
  assert.equal(speedLimitNow(), 0, '1 − 1 = no limit');
  stepSpeedLimit(-1);
  assert.equal(speedLimitNow(), 0, 'never below 0');
  stepSpeedLimit(1);
  stepSpeedLimit(1);
  assert.equal(speedLimitNow(), 2);
  setSpeedLimit(999);
  stepSpeedLimit(10);
  assert.equal(speedLimitNow(), 1000, 'never above 1000');
});

test('glibren.13: a limit chosen on the phone page is adopted exactly (37 stays 37)', async () => {
  const { adoptSpeedLimit, speedLimitNow } = await load('app/state/speed-limit.js');
  adoptSpeedLimit(37);
  assert.equal(speedLimitNow(), 37);
  assert.equal(applied.at(-1), 37 * 1024 ** 2);
  adoptSpeedLimit(0);
  assert.equal(speedLimitNow(), 0);
  adoptSpeedLimit(-3);
  adoptSpeedLimit('5');
  adoptSpeedLimit(NaN);
  assert.equal(speedLimitNow(), 0, 'nonsense is ignored');
});

test("the app's own update downloads unlimited", () => {
  const source = readFileSync(path.join(repo, 'app/state/auto-update.js'), 'utf8');
  assert.match(source, /downloads\.enqueue\(\{[^}]*unlimited: true/);
});
