// glibren.8: the files the gamer fills in by hand survive the title being uninstalled and installed again (its
// download0 image goes with it): on the PS5 they are also copied to /data/JobeesLair/saved, and read from there
// when the data folder came back without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem, Platform } from '@ps5-react/core';
import { loadList, saveList } from '../app/state/saved.js';
import { BACKUP_DIR, DATA_DIR } from '../app/state/data-dir.js';

function onConsole(run) {
  const os = Platform.OS;
  const files = globalThis.__stubFiles;
  Platform.OS = 'ps5';
  globalThis.__stubFiles = new Map();
  try {
    return run(globalThis.__stubFiles);
  } finally {
    Platform.OS = os;
    globalThis.__stubFiles = files;
  }
}

test('saved backup: settings and keys are copied to /data; caches are not', () => onConsole((files) => {
  saveList('settings.json', 'settings', { language: 'pt-BR' });
  saveList('debrid.json', 'debrid', { torbox: { keyBox: 'v1.x' } });
  saveList('link-health.json', 'link health', { a: 1 });
  assert.equal(files.get(`${DATA_DIR}/settings.json`), '{"language":"pt-BR"}');
  assert.equal(files.get(`${BACKUP_DIR}/settings.json`), '{"language":"pt-BR"}');
  assert.ok(files.has(`${BACKUP_DIR}/debrid.json`));
  assert.ok(!files.has(`${BACKUP_DIR}/link-health.json`));
  assert.ok(![...files.keys()].some((path) => path.endsWith('.tmp')));
}));

test('saved backup: an emptied download0 is read from the copy, and the next save puts it back', () => onConsole((files) => {
  saveList('settings.json', 'settings', { language: 'pt-BR', vibration: false });
  files.delete(`${DATA_DIR}/settings.json`);
  assert.deepEqual(loadList('settings.json', 'settings'), { language: 'pt-BR', vibration: false });
  saveList('settings.json', 'settings', { ...loadList('settings.json', 'settings'), screenSaver: false });
  assert.deepEqual(JSON.parse(files.get(`${DATA_DIR}/settings.json`)), { language: 'pt-BR', vibration: false, screenSaver: false });
  assert.equal(files.get(`${BACKUP_DIR}/settings.json`), files.get(`${DATA_DIR}/settings.json`));
}));

test('saved backup: the data folder wins over the copy', () => onConsole((files) => {
  files.set(`${BACKUP_DIR}/settings.json`, '{"language":"en"}');
  files.set(`${DATA_DIR}/settings.json`, '{"language":"pt-BR"}');
  assert.equal(loadList('settings.json', 'settings').language, 'pt-BR');
}));

test('saved backup: a failed write to download0 still leaves the copy', () => onConsole((files) => {
  const write = FileSystem.writeFile;
  FileSystem.writeFile = function (path, ...rest) {
    if (path.startsWith(`${DATA_DIR}/`)) throw new Error('No space left on device');
    return write.call(this, path, ...rest);
  };
  try {
    saveList('settings.json', 'settings', { language: 'pt-BR' });
  } finally {
    FileSystem.writeFile = write;
  }
  assert.ok(!files.has(`${DATA_DIR}/settings.json`));
  assert.equal(files.get(`${BACKUP_DIR}/settings.json`), '{"language":"pt-BR"}');
}));

test('saved backup: off the console nothing is copied', () => {
  const files = globalThis.__stubFiles;
  globalThis.__stubFiles = new Map();
  try {
    saveList('settings.json', 'settings', { language: 'pt-BR' });
    assert.ok(![...globalThis.__stubFiles.keys()].some((path) => path.startsWith(BACKUP_DIR)));
  } finally {
    globalThis.__stubFiles = files;
  }
});
