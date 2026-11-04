// The launch's cover warming (state/cover-warm.js, state/catalog.js warmCovers): every game's cover is still
// warmed, and the first covers of the Discover rows and the catalog grid come first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const { noteRow, warmOrder, ROW_FIRST } = await load('app/state/cover-warm.js');
const game = (id) => ({ id, art: { cover: `https://example.com/${id}.png` } });

test('cover warming: every cover, each row\'s first ones first, each once', () => {
  const all = Array.from({ length: 40 }, (_, i) => game(`g${i}`));
  const rowA = [all[30], all[31], all[32]];
  const rowB = [all[35], all[30], all[36], { id: 'none', art: {} }];
  noteRow(rowA);
  noteRow(rowB);
  const order = warmOrder(all);
  assert.equal(order.length, all.length, 'every game\'s cover, none twice');
  assert.deepEqual(new Set(order), new Set(all.map((g) => g.art.cover)));
  // Row by row: each row's first card, then each row's second...
  assert.deepEqual(order.slice(0, 5), [all[30], all[35], all[31], all[32], all[36]].map((g) => g.art.cover));
  assert.deepEqual(order.slice(5, 8), [all[0], all[1], all[2]].map((g) => g.art.cover), 'then the rest in the given order');
  assert.equal(ROW_FIRST, 10);
});

test('cover warming: a long row puts only its first ROW_FIRST ahead', () => {
  const all = Array.from({ length: 30 }, (_, i) => game(`h${i}`));
  noteRow([...all].reverse());
  const order = warmOrder(all).filter((url) => url.includes('/h'));
  assert.equal(order.length, all.length);
  assert.equal(order[0], all[29].art.cover);
  const at = (i) => order.indexOf(all[i].art.cover);
  assert.ok(at(20) < at(0), 'the row\'s 10th card leads');
  assert.ok(at(19) > at(0), 'its 11th waits its turn in the catalog\'s order');
});
