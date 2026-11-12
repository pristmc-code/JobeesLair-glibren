// glibren-video-cap: the cap while a video plays takes the lower of the two and never touches the saved limit.
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../app/state/speed-limit.js');
const { setSpeedLimit, speedLimitNow, speedLimitEffective, setVideoCap, onVideoCap } = mod;

test('video cap: lower of saved and cap; cleared on close; saved untouched', () => {
  const seen = [];
  const stop = onVideoCap((value) => seen.push(value));
  setSpeedLimit(0);
  setVideoCap(5);
  assert.equal(speedLimitEffective(), 5, 'no saved limit: the cap');
  assert.equal(speedLimitNow(), 0, 'the saved one stays 0');
  setSpeedLimit(3);
  assert.equal(speedLimitEffective(), 3, 'a saved limit lower than the cap wins');
  setSpeedLimit(20);
  assert.equal(speedLimitEffective(), 5, 'the cap is lower');
  setVideoCap(0);
  assert.equal(speedLimitEffective(), 20, 'closed: the saved limit again');
  setVideoCap(-1);
  assert.equal(speedLimitEffective(), 20, 'nonsense clears');
  assert.deepEqual(seen, [5, 0]);
  stop();
  setSpeedLimit(0);
});
