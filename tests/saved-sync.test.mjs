// glibren.4: the files a lost write would cost the gamer to type again are written through to the disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem } from '@ps5-react/core';
import { saveList } from '../app/state/saved.js';

test('saved: debrid.json, settings and the hand-filled lists are synced; caches are not', () => {
  const writes = [];
  const original = FileSystem.writeFile;
  FileSystem.writeFile = (path, text, options) => writes.push([path.split('/').pop(), options?.sync === true]);
  try {
    for (const name of ['debrid.json', 'settings.json', 'wishlist.json', 'feeds.json', 'feed-mirrors.json', 'themes.json', 'link-health.json', 'online.json'])
      saveList(name, 'test', {});
  } finally {
    FileSystem.writeFile = original;
  }
  assert.deepEqual(Object.fromEntries(writes), {
    'debrid.json.tmp': true, 'settings.json.tmp': true, 'wishlist.json.tmp': true, 'feeds.json.tmp': true,
    'feed-mirrors.json.tmp': true, 'themes.json.tmp': true, 'link-health.json.tmp': false, 'online.json.tmp': false,
  });
});
