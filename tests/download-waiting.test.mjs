// glibren.44 (PS5 real, .43): um download que espera a proxima tentativa sozinho tem um estado so ("waiting"), diz quem
// esta ocupado e nao conta como falha; o TorBox preparando o arquivo passa o progresso ao cartao. O desenho do cartao e
// da tela esta em tests/render/download-card.mjs.
// Run: node --import ./tests/stub-loader.mjs --test tests/download-waiting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const { readinessOf, waitingRetry, cardPick } = await import('../app/state/readiness.js');
const { busyServer } = await import('../app/downloads/errors.js');
const { createSourceResolver } = await import('../app/state/download-sources.js');
const { shapeOf } = await import('../app/downloads/shape.js');

test('glibren.44: a failed download with its own next try is "waiting" (one state), a real failure stays failed', () => {
  const waiting = { state: 'failed', error: 'HTTP 429', retryAt: Date.now() + 6e4 };
  assert.equal(waitingRetry(waiting), true);
  assert.deepEqual(readinessOf(waiting), { stage: 'waiting', icon: 'restart', tone: 'wait', note: null, action: null });
  const failed = { state: 'failed', error: 'HTTP 404' };
  assert.equal(waitingRetry(failed), false);
  assert.equal(readinessOf(failed).stage, 'downloading');
  assert.equal(readinessOf(failed).tone, 'bad');
  assert.equal(cardPick([waiting]).ready.stage, 'waiting');
  // O cartao redesenha quando a espera ou o preparo mudam.
  assert.notEqual(shapeOf(waiting), shapeOf({ ...waiting, retryAt: waiting.retryAt + 1 }));
  assert.notEqual(shapeOf({ id: 'a', state: 'resolving', preparing: { service: 'torbox', progress: 0.1 } }), shapeOf({ id: 'a', state: 'resolving', preparing: { service: 'torbox', progress: 0.2 } }));
});

test('glibren.44: busyServer says which HTTP status made a server busy (or TorBox\'s own error); other errors are not', () => {
  assert.deepEqual(busyServer('HTTP 429 Too Many Requests'), { code: '429', torbox: false });
  assert.deepEqual(busyServer('Download failed: HTTP 503'), { code: '503', torbox: false });
  assert.deepEqual(busyServer('TorBox had a server error. Try again in a while.'), { code: null, torbox: true });
  assert.equal(busyServer('HTTP 404'), null);
  assert.equal(busyServer(''), null);
});

test('glibren.44: the source resolver hands the debrid service\'s preparing progress on (onProgress)', async () => {
  const seen = [];
  const debrid = { async resolve(release, { onProgress }) { onProgress?.(0.25); onProgress?.(0.5); return { url: 'https://cdn.example/file.exfat' }; } };
  const sources = createSourceResolver({ http: { request: async () => assert.fail('no host call') }, debrid });
  const resolved = await sources.resolve({ id: 'r~torbox', provider: 'Vikingfile', url: 'https://vikingfile.com/f/abc', debrid: { service: 'torbox' } }, { onProgress: (p) => seen.push(p) });
  assert.equal(resolved.url, 'https://cdn.example/file.exfat');
  assert.deepEqual(seen, [0.25, 0.5]);
});
