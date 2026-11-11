// glibren.26: o console recusa um pedido HTTP com maxBytes acima de 4 MiB (ps5-react native/shared/network_api.cpp);
// com 8 MiB (glibren.20 a .25) todo feed da web, inclusive o catalogo ao vivo, falhava no PS5. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const href = (rel) => pathToFileURL(path.join(repo, rel)).href;
const core = await import('@ps5-react/core');
globalThis.__stubFiles = new Map();
const asked = [];
core.Http.request = async (url, options = {}) => {
  asked.push({ url, maxBytes: options.maxBytes });
  // O mesmo limite do transporte do console.
  if (!(options.maxBytes >= 1 && options.maxBytes <= 4 * 1024 * 1024)) throw new TypeError('network.request: invalid method/body/maxBytes/binary');
  throw new Error('offline');
};

test('a web feed (the live catalog too) is asked with at most 4 MiB, the most the console transport takes', async () => {
  const feeds = await import(href('app/state/feeds.js'));
  assert.equal(feeds.NET_MAX_BYTES, 4 * 1024 * 1024);
  await feeds.refreshFeeds();
  assert.ok(asked.length > 0, 'the live catalog was asked for');
  for (const call of asked) assert.ok(call.maxBytes <= 4 * 1024 * 1024, `${call.url}: maxBytes ${call.maxBytes}`);
  const native = readFileSync(path.join(repo, 'ps5-react/native/shared/network_api.cpp'), 'utf8');
  assert.match(native, /"maxBytes", request\.max_bytes, 1, 4\*1024\*1024/, 'the console limit is still 4 MiB');
});
