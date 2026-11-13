// glibren.45: menos desenho quando ninguem usa a Jobee'sLair (state/power.js): o repouso depois de 15 s sem botao, o ritmo
// das telas ao vivo (paced) e o "Economizar energia" em settings.json.
// Run: node --import ./tests/stub-loader.mjs --test tests/power.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__stubFiles = new Map();
const power = await import('../app/state/power.js');
const activity = await import('../app/state/activity.js');
const { REST_MS, REST_REDRAW_MS, SAVER_REDRAW_MS } = power;

// Um relogio e temporizadores de mentira: `advance` dispara o que venceu, na ordem.
function world() {
  let clock = 1e6, next = 1;
  const pending = new Map();
  const w = {
    now: () => clock,
    set: (fn, ms) => { const id = next++; pending.set(id, { at: clock + ms, fn }); return id; },
    clear: (id) => pending.delete(id),
    advance(ms) {
      const end = clock + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        clock = due[1].at;
        due[1].fn();
      }
      clock = end;
    },
    press() { activity.noteInput({ type: 'press' }, clock); },
    pending: () => pending.size,
  };
  return w;
}

function start(w, saver = false) {
  power.resetPower(saver);
  activity.resetActivity(w.now());
  power.startPower({ controller: { subscribe() {} }, now: w.now, set: w.set, clear: w.clear });
}

test('glibren.45: at rest after 15 s without a button; any button wakes it at once', () => {
  const w = world();
  start(w);
  const seen = [];
  power.onPowerChange((now) => seen.push(now.resting));
  assert.equal(power.isResting(), false);
  w.advance(REST_MS - 1);
  assert.equal(power.isResting(), false, 'not before 15 s');
  w.advance(1);
  assert.equal(power.isResting(), true);
  assert.equal(power.isQuiet(), true);
  w.press();
  assert.equal(power.isResting(), false, 'a button wakes it');
  w.advance(REST_MS / 2);
  w.press();
  w.advance(REST_MS - 1);
  assert.equal(power.isResting(), false, 'each button starts the 15 s again');
  w.advance(1);
  assert.equal(power.isResting(), true);
  assert.deepEqual(seen, [true, false, true]);
  assert.equal(w.pending(), 0, 'at rest nothing ticks: no polling');
  power.stopPower();
});

test('glibren.45: live screens: as they come in use, every 5 s at rest, every 2 s with the energy saver', () => {
  assert.equal(REST_REDRAW_MS, 5000);
  assert.equal(SAVER_REDRAW_MS, 2000);
  const w = world();
  start(w);
  assert.equal(power.redrawEvery(500), 500);
  w.advance(REST_MS);
  assert.equal(power.redrawEvery(500), REST_REDRAW_MS);
  assert.equal(power.redrawEvery(10000), 10000, 'never faster than asked');
  power.stopPower();
  start(w, true);
  assert.equal(power.redrawEvery(500), SAVER_REDRAW_MS);
  assert.equal(power.redrawEvery(0), SAVER_REDRAW_MS);
  assert.equal(power.isQuiet(), true, 'the energy saver keeps it quiet in use too');
  power.stopPower();
});

test('glibren.45: paced: the last value wins, at rest one draw per 5 s, and waking draws the waiting one at once', () => {
  const w = world();
  start(w);
  const drawn = [];
  const pace = power.paced((value) => drawn.push(value), 0);
  pace.feed(1);
  pace.feed(2);
  assert.deepEqual(drawn, [1, 2], 'in use: every value, at once');
  w.advance(REST_MS);
  drawn.length = 0;
  for (let i = 0; i < 10; i++) {
    pace.feed(10 + i);
    w.advance(1000);
  }
  // 10 s at rest, a value a second: the first at once, then one per 5 s, the latest that had come by then (at 5 s and
  // at 10 s the draw goes before that second's value).
  assert.deepEqual(drawn, [10, 14, 19], JSON.stringify(drawn));
  pace.feed(99);
  w.press();
  power.stopPower(); // stop listening to the clock; the wake was already sent
  assert.equal(drawn.at(-1), 99, 'a button draws what waited');
  pace.stop();
});

test('glibren.45: "Economizar energia" is off by default and kept in settings.json', () => {
  globalThis.__stubFiles = new Map();
  power.resetPower(null);
  assert.equal(power.energySaverOn(), false);
  const changes = [];
  power.onPowerChange((now) => changes.push(now.saver));
  power.setEnergySaver(true);
  assert.equal(power.energySaverOn(), true);
  assert.deepEqual(changes, [true]);
  const saved = [...globalThis.__stubFiles].find(([path]) => path.endsWith('/settings.json'));
  assert.ok(saved, 'settings.json written');
  assert.equal(JSON.parse(saved[1]).energySaver, true);
  power.resetPower(null);
  assert.equal(power.energySaverOn(), true, 'read back from settings.json');
  power.setEnergySaver(false);
  power.resetPower(null);
  assert.equal(power.energySaverOn(), false);
});

test('glibren.45: frame pace: parts grow while frames stay short, halve when one runs long, and come with a still clock', async () => {
  const { createFramePace, finishFramed } = await import('../app/state/frame-pace.js');
  let clock = 0;
  const pace = createFramePace({ start: 4, now: () => clock });
  assert.equal(pace.begin(), 4);
  clock += 16;
  assert.equal(pace.begin(), 5, 'a 16 ms frame: 25% more');
  clock += 16;
  assert.equal(pace.begin(), 7);
  clock += 40;
  assert.equal(pace.begin(), 3, 'a 40 ms frame: half');
  clock += 22;
  assert.equal(pace.begin(), 3, 'between: as it was');
  assert.equal(pace.slowest(), 40);
  pace.hurry();
  clock += 40;
  assert.equal(pace.begin(), 4, 'hurried: 40 ms is calm enough');
  // A clock that never moves (the console's inside a frame): the parts still come, and grow.
  function* steps(n) { for (let i = 0; i < n; i++) yield; return 'done'; }
  let frames = 0;
  assert.equal(await finishFramed(steps(1000), async () => { frames++; }, createFramePace({ now: () => 0 })), 'done');
  assert.ok(frames > 5 && frames < 100, `${frames} frames`);
});
