// Back from rest mode (state/rest-wake.js): the wake is seen from the clock, logged with how long the console
// slept, and a download that was running and fails on the network after it is tried again by itself, a few
// times, while one that fails for another reason, or was not running, is left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const { createRestWake, NETWORK_ERROR } = await import(pathToFileURL(path.join(repo, 'app/state/rest-wake.js')).href);

function harness(jobs) {
  let clock = 1e6;
  let tick = null;
  const timers = [];
  const lines = [];
  const resumed = [];
  let listener = null;
  const queue = {
    subscribe(fn) { listener = fn; fn(jobs); return () => { listener = null; }; },
    resume(id) { resumed.push(id); const job = jobs.find((j) => j.id === id); job.state = 'queued'; job.error = ''; listener?.(jobs); }
  };
  const wake = createRestWake({
    queue,
    now: () => clock,
    every: (fn) => { tick = fn; return 1; },
    stopEvery: () => {},
    later: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer; },
    log: (line) => lines.push(line)
  });
  return {
    wake, lines, resumed, jobs,
    advance(ms) {
      clock += ms;
      for (const timer of timers.filter((t) => !t.done && t.at <= clock)) { timer.done = true; timer.fn(); }
    },
    tick(ms = 5e3) { clock += ms; tick(); },
    emit() { listener?.(jobs); }
  };
}

test('rest wake: a long gap between ticks is a sleep; short ones are not', () => {
  const h = harness([{ id: 'a', state: 'downloading' }]);
  h.tick(5e3);
  h.tick(30e3);
  assert.equal(h.wake.state.wakes, 0, 'a slow frame is no sleep');
  h.tick(5e3 + 2 * 3600e3);
  assert.equal(h.wake.state.wakes, 1);
  assert.match(h.lines.at(-1), /back from rest mode after 7200 s asleep; watching a/);
});

test('rest wake: a running download that fails on the network after the wake is tried again, a few times at most', () => {
  const jobs = [
    { id: 'net', state: 'downloading' },
    { id: 'http', state: 'downloading' },
    { id: 'idle', state: 'failed', error: "Couldn't resolve host name" }
  ];
  const h = harness(jobs);
  h.tick(5e3 + 600e3);
  jobs[0].state = 'failed'; jobs[0].error = "Couldn't resolve host name";
  jobs[1].state = 'failed'; jobs[1].error = 'HTTP 404';
  h.emit();
  assert.deepEqual(h.resumed, [], 'not at once: the network takes a while');
  h.advance(20e3);
  assert.deepEqual(h.resumed, ['net'], 'the network failure, not the 404, nor the one that failed before the sleep');
  // It fails again (no network yet): the next try is later, then they stop.
  for (const wait of [60e3, 120e3, 300e3]) {
    jobs[0].state = 'failed'; jobs[0].error = 'Timeout was reached';
    h.emit();
    h.advance(wait - 1);
    const before = h.resumed.length;
    h.advance(1);
    assert.equal(h.resumed.length, before + 1, `tried again after ${wait / 1e3} s`);
  }
  jobs[0].state = 'failed'; jobs[0].error = 'Timeout was reached';
  h.emit();
  h.advance(600e3);
  assert.equal(h.resumed.length, 4, 'four tries, then it waits for the player');
  assert.match(h.lines.at(-1), /still failing after 4 tries/);
});

test('rest wake: the network errors the engine reports, and not the others', () => {
  for (const text of ["Couldn't resolve host name", "Couldn't connect to server", 'Timeout was reached', 'Failure when receiving data from the peer', 'SSL connect error', 'Server returned nothing (no headers, no data)']) assert.match(text, NETWORK_ERROR, text);
  for (const text of ['HTTP 404', 'Not enough space', 'The file is not the one the catalog names']) assert.doesNotMatch(text, NETWORK_ERROR, text);
});

test('rest wake: the download queue says when it holds the console awake', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(path.join(repo, 'app/state/download-queue.js'), 'utf8');
  assert.match(source, /\[download-queue\] keepAwake \$\{busy \? "on" : "off"\}/);
  const native = readFileSync(path.join(repo, 'ps5-react/native/ps5/host_platform.cpp'), 'utf8');
  assert.match(native, /keepAwake on: sceSystemServicePowerTick now and every/);
  assert.match(native, /sceSystemServicePowerTick=0x%08x \(tick %u\)/);
});
