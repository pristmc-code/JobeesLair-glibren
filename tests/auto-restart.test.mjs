// glibren.44: "Instalar atualizacoes automaticamente" reinicia sozinha quando ninguem usa a Jobee'sLair
// (state/auto-restart.js), e os avisos da abertura que so tem OK passam sozinhos em 10 s (ui/useAutoDismiss.js).
// Run: node --import ./tests/stub-loader.mjs --test tests/auto-restart.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const { restartBlocker, createAutoRestart, IDLE_MS, COUNTDOWN_MS, POSTPONE_MS } = await import('../app/state/auto-restart.js');
const { autoDismiss, withCountdown } = await import('../app/ui/useAutoDismiss.js');
const activity = await import('../app/state/activity.js');

const SAFE = { automatic: true, phase: 'armed', version: '0.5.5-glibren.45', foreground: true, media: false, converting: false, busy: false, dialog: false, idleMs: IDLE_MS + 1 };

test('glibren.44: restartBlocker: only with automatic on, the update ready, the app in front, nothing playing or running, no dialog and 60 s idle', () => {
  assert.equal(restartBlocker(SAFE), '');
  assert.equal(restartBlocker({ ...SAFE, foreground: null }), '', 'unknown focus: the console freezes an app in the background anyway');
  for (const [change, reason] of [[{ automatic: false }, 'off'], [{ phase: 'downloading' }, 'not-ready'], [{ version: null }, 'not-ready'], [{ foreground: false }, 'background'],
    [{ media: true }, 'playing'], [{ converting: true }, 'converting'], [{ busy: true }, 'busy'], [{ dialog: true }, 'dialog'], [{ idleMs: IDLE_MS - 1 }, 'in-use']]) {
    assert.equal(restartBlocker({ ...SAFE, ...change }), reason, JSON.stringify(change));
  }
});

function world(inputs = SAFE) {
  let clock = 1e6;
  const w = { inputs: { ...inputs }, restarts: 0, presses: new Set(), lines: [] };
  w.now = () => clock;
  w.advance = (ms) => { clock += ms; };
  w.press = (button) => { for (const listener of [...w.presses]) listener({ type: 'press', button }); };
  w.watch = createAutoRestart({ read: async () => ({ ...w.inputs }), restart: () => { w.restarts++; return w.refuse ?? ''; }, now: w.now, log: (line) => w.lines.push(line),
    subscribePress: (listener) => { w.presses.add(listener); return () => w.presses.delete(listener); } });
  return w;
}

test('glibren.44: idle and safe: a 10 s notice, then the restart to apply', async () => {
  const w = world();
  await w.watch.tick();
  assert.equal(w.watch.state().phase, 'countdown');
  assert.equal(w.watch.state().version, '0.5.5-glibren.45');
  assert.equal(w.watch.state().endsAt, w.now() + COUNTDOWN_MS);
  w.advance(COUNTDOWN_MS - 1);
  await w.watch.tick();
  assert.equal(w.restarts, 0, 'not before the 10 s');
  w.advance(1);
  await w.watch.tick();
  assert.equal(w.restarts, 1);
  assert.equal(w.watch.state().phase, 'restarting');
});

test('glibren.44: never with a video playing, a conversion running or the app in the background; a video that starts during the notice stops it', async () => {
  for (const change of [{ media: true }, { converting: true }, { foreground: false }, { busy: true }, { dialog: true }]) {
    const w = world({ ...SAFE, ...change });
    for (let n = 0; n < 5; n++) { await w.watch.tick(); w.advance(COUNTDOWN_MS); }
    assert.equal(w.restarts, 0, JSON.stringify(change));
    assert.equal(w.watch.state().phase, 'idle');
  }
  const w = world();
  await w.watch.tick();
  w.inputs.media = true;
  w.advance(COUNTDOWN_MS);
  await w.watch.tick();
  assert.equal(w.restarts, 0);
  assert.equal(w.watch.state().phase, 'idle');
  assert.equal(w.watch.state().reason, 'playing');
});

test('glibren.44: during the notice, Circle (or X on "Postpone") postpones 30 min; any other button cancels it', async () => {
  const w = world();
  await w.watch.tick();
  w.press('circle');
  assert.equal(w.watch.state().phase, 'idle');
  assert.equal(w.watch.state().postponedUntil, w.now() + POSTPONE_MS);
  await w.watch.tick();
  assert.equal(w.watch.state().phase, 'idle', 'postponed');
  w.advance(POSTPONE_MS);
  await w.watch.tick();
  assert.equal(w.watch.state().phase, 'countdown', 'back after the 30 min');
  w.press('up');
  assert.equal(w.watch.state().phase, 'idle');
  assert.equal(w.watch.state().reason, 'input');
  assert.equal(w.presses.size, 0, 'stops listening');
  w.advance(COUNTDOWN_MS);
  await w.watch.tick();
  assert.equal(w.restarts, 0);
  // Um restart recusado (algo do app que fechar cortaria) volta a esperar.
  const refused = world();
  refused.refuse = 'A download is running in the app.';
  await refused.watch.tick();
  refused.advance(COUNTDOWN_MS);
  await refused.watch.tick();
  assert.equal(refused.restarts, 1);
  assert.equal(refused.watch.state().phase, 'idle');
  assert.equal(refused.watch.state().reason, 'A download is running in the app.');
});

test('glibren.44: the startup notices: "OK (10)" counts down and does what OK does; any button cancels the count', async () => {
  assert.equal(withCountdown('OK', 10), 'OK (10)');
  assert.equal(withCountdown('OK', null), 'OK');
  const timers = [];
  const every = (fn) => { timers.push(fn); return timers.length; };
  const presses = new Set();
  const press = (listener) => { presses.add(listener); return () => presses.delete(listener); };
  // 1) sem botao: 10, 9, ..., 1 e o OK.
  const left = [];
  let done = 0;
  autoDismiss({ seconds: 10, onLeft: (n) => left.push(n), onDone: () => done++, press, every, stopEvery: () => {} });
  for (let n = 0; n < 10; n++) timers[0]();
  assert.deepEqual(left, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, null]);
  assert.equal(done, 1);
  assert.equal(presses.size, 0);
  // 2) um botao no meio: a contagem some e o OK nao acontece.
  const left2 = [];
  let done2 = 0;
  let stopped = false;
  autoDismiss({ seconds: 10, onLeft: (n) => left2.push(n), onDone: () => done2++, press, every, stopEvery: () => { stopped = true; } });
  timers[1]();
  for (const listener of [...presses]) listener({ type: 'press', button: 'down' });
  assert.equal(stopped, true);
  assert.deepEqual(left2, [10, 9, null]);
  assert.equal(done2, 0);
  // 3) o vigia de atividade: o botao vira a hora do ultimo uso e avisa quem ouve.
  activity.resetActivity(0);
  let heard = 0;
  const off = activity.onPress(() => heard++);
  activity.noteInput({ type: 'press', button: 'cross' }, 5e3);
  assert.equal(heard, 1);
  assert.equal(activity.idleFor(65e3), 60e3);
  off();
  const release = activity.holdMedia();
  assert.equal(activity.mediaPlaying(), true);
  release();
  release();
  assert.equal(activity.mediaPlaying(), false);
});
