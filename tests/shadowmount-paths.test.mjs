// glibren.12: ShadowMount paths are compared whole (app/state/shadowmount.js within2), and a delete in the Files tab
// never uninstalls Jobee'sLair itself without its own confirmation (app/files/useFiles.js). The bug: deleting a copy of
// an image on one drive matched the image of the same name ShadowMount runs from another drive by its ending
// ("/homebrew/JobeesLair.exfat") and uninstalled that title, Jobee'sLair (PPSA99471) included, settings and all.
// Run: npm test (node --import ./tests/stub-loader.mjs --test tests/*.test.mjs)
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { FileSystem, Http, Platform } from '@ps5-react/core';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const shadowmount = await load('app/state/shadowmount.js');
const { within2, mountedImages } = shadowmount;
const { deleteFile } = await load('app/files/useFiles.js');
const { configure } = await load('app/i18n/core.js');
const en = JSON.parse(readFileSync(path.join(repo, 'app/i18n/locales/en.json'), 'utf8'));
configure(() => en, en);

const SELF = 'PPSA99471';
const USB0 = '/mnt/usb0/homebrew/JobeesLair.exfat';
const USB1 = '/mnt/usb1/homebrew/JobeesLair.exfat';

// ---- within2 / mountedImages

test('within2: an image of the same name on another drive is not the same file', () => {
  assert.equal(within2(USB0, [USB1], '/mnt/usb1'), false);
  assert.equal(within2('/mnt/ext1/homebrew/Game.exfat', ['/data/homebrew/Game.exfat'], '/data'), false);
  assert.equal(within2('/user/data/homebrew/Game.exfat', ['/mnt/ext0/homebrew/Game.exfat'], '/mnt/ext0'), false);
  assert.equal(within2('/mnt/usb0/homebrew/Game', ['/mnt/usb1/homebrew/Game/sce_sys'], '/mnt/usb1'), false);
});

test('within2: the same path, a path inside a folder, trailing and doubled slashes', () => {
  assert.equal(within2(USB1, [USB1], '/mnt/usb1'), true);
  assert.equal(within2(`${USB1}/`, [USB1], '/mnt/usb1'), true);
  assert.equal(within2('/mnt/usb1//homebrew/Game/eboot.bin', ['/mnt/usb1/homebrew/Game'], '/mnt/usb1'), true);
  assert.equal(within2('/mnt/usb1/homebrew/Game2', ['/mnt/usb1/homebrew/Game'], '/mnt/usb1'), false);
  assert.equal(within2(undefined, [USB1], '/mnt/usb1'), false);
  assert.equal(within2(USB1, [], '/mnt/usb1'), false);
});

test('within2: /user/data is the internal drive the app calls /data (the one real alias)', () => {
  assert.equal(within2('/user/data/homebrew/Game.exfat', ['/data/homebrew/Game.exfat'], '/data'), true);
  assert.equal(within2('/data/homebrew/Game/sce_sys/param.json', ['/user/data/homebrew/Game'], '/data'), true);
  assert.equal(within2('/user/database/homebrew/Game.exfat', ['/data/homebrew/Game.exfat'], '/data'), false);
});

test('within2: a path on no known drive that ends the same is only a maybe, never a match', () => {
  const odd = '/mnt/sandbox/NPXS40000_000/homebrew/Game.exfat';
  assert.equal(within2(odd, ['/data/homebrew/Game.exfat'], '/data'), false);
  assert.equal(shadowmount.mayBeWithin(odd, ['/data/homebrew/Game.exfat'], '/data'), true);
  assert.equal(shadowmount.mayBeWithin(USB0, [USB1], '/mnt/usb1'), false);
});

test('mountedImages: the same name mounted on another drive is not among the files; a maybe comes back uncertain', async () => {
  const images = [
    { path: USB0, mounted: true },
    { path: '/user/data/homebrew/Other.exfat', mounted: true },
    { path: '/mnt/sandbox/x/homebrew/JobeesLair.exfat', mounted: true },
    { path: USB1, mounted: false }
  ];
  const request = async () => ({ images });
  // /mnt/usb0's image is not /mnt/usb1's; the one on no known drive may be (kept, never unmounted).
  assert.deepEqual((await mountedImages(request, [USB1], '/mnt/usb1')).map((item) => [item.path, item.uncertain]), [[images[2].path, true]]);
  assert.deepEqual(await mountedImages(async () => ({ images: images.slice(0, 2) }), [USB1], '/mnt/usb1'), []);
  assert.deepEqual(await mountedImages(request, ['/data/homebrew/Other.exfat'], '/data'), [images[1]]);
  const maybe = await mountedImages(request, ['/data/homebrew/JobeesLair.exfat'], '/data');
  assert.equal(maybe.length, 1);
  assert.equal(maybe[0].uncertain, true);
});

// ---- deleteFile (the Files tab) against a fake ShadowMount

const files = new Map();
let shadow;
let asked;
beforeEach(() => {
  Platform.OS = 'ps5';
  globalThis.__stubFiles = files;
  files.clear();
  asked = [];
  shadow = { games: [], images: [] };
  FileSystem.removeAsync = async (p) => { files.delete(p); };
  Http.request = async (url, options) => {
    const route = url.replace(/^.*\/api\/v1\//, '');
    const body = JSON.parse(options.body || '{}');
    asked.push({ route, body });
    const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (route === 'games') return reply(200, { games: shadow.games });
    if (route === 'images') return reply(200, { images: shadow.images });
    if (route === 'games/uninstall') return reply(200, { ok: true });
    return reply(404, { error: 'no route' });
  };
});
after(() => {
  Platform.OS = 'desktop';
  delete globalThis.__stubFiles;
  delete FileSystem.removeAsync;
  delete Http.request;
});
const image = (p) => ({ path: p, name: p.slice(p.lastIndexOf('/') + 1), kind: 'images', isDirectory: false });
const uninstalled = () => asked.filter((item) => item.route === 'games/uninstall').map((item) => item.body.title_id);

test('Files tab: deleting a copy on another drive never uninstalls the title installed from the same name (the bug)', async () => {
  files.set(USB1, 'copy');
  shadow.games = [{ title_id: SELF, path: USB0 }, { title_id: 'PPSA01234', path: '/mnt/usb0/homebrew/Game.exfat' }];
  shadow.images = [{ path: USB0, mounted: false }];
  await deleteFile(image(USB1), '/mnt/usb1');
  assert.equal(files.has(USB1), false);
  assert.deepEqual(uninstalled(), []);

  files.set('/mnt/usb1/homebrew/Game.exfat', 'copy');
  await deleteFile(image('/mnt/usb1/homebrew/Game.exfat'), '/mnt/usb1');
  assert.equal(files.has('/mnt/usb1/homebrew/Game.exfat'), false);
  assert.deepEqual(uninstalled(), []);
});

test('Files tab: a copy on another drive is deleted even while the image of that name is mounted elsewhere', async () => {
  files.set(USB1, 'copy');
  shadow.games = [{ title_id: SELF, path: USB0 }];
  shadow.images = [{ path: USB0, mounted: true }];
  await deleteFile(image(USB1), '/mnt/usb1');
  assert.equal(files.has(USB1), false);
  assert.deepEqual(uninstalled(), []);
});

test('Files tab: the image a title was installed from is still uninstalled after its delete, as before', async () => {
  const game = '/mnt/usb1/homebrew/Game.exfat';
  files.set(game, 'image');
  files.set(`${game}.complete`, '');
  shadow.games = [{ title_id: 'PPSA01234', path: game }, { title_id: 'PPSA05678', path: '/mnt/usb0/homebrew/Game.exfat' }];
  const { note } = await deleteFile(image(game), '/mnt/usb1');
  assert.equal(files.has(game), false);
  assert.equal(files.has(`${game}.complete`), false);
  assert.deepEqual(uninstalled(), ['PPSA01234']);
  assert.equal(note, null);
});

test('Files tab: /user/data from ShadowMount is the internal drive\'s /data: still uninstalled', async () => {
  const game = '/data/homebrew/Game.exfat';
  files.set(game, 'image');
  shadow.games = [{ title_id: 'PPSA01234', path: '/user/data/homebrew/Game.exfat' }];
  await deleteFile(image(game), '/data');
  assert.equal(files.has(game), false);
  assert.deepEqual(uninstalled(), ['PPSA01234']);
});

test('Files tab: a mounted image is still kept, as before', async () => {
  files.set(USB1, 'image');
  shadow.games = [{ title_id: 'PPSA01234', path: USB1 }];
  shadow.images = [{ path: USB1, mounted: true }];
  await assert.rejects(deleteFile(image(USB1), '/mnt/usb1'), /still has it mounted/);
  assert.equal(files.has(USB1), true);
  assert.deepEqual(uninstalled(), []);
});

test('Files tab: an image that only may be the mounted one (unknown alias) is kept, not unmounted or uninstalled', async () => {
  const game = '/data/homebrew/Game.exfat';
  files.set(game, 'image');
  shadow.games = [{ title_id: 'PPSA01234', path: '/mnt/sandbox/x/homebrew/Game.exfat' }];
  shadow.images = [{ path: '/mnt/sandbox/x/homebrew/Game.exfat', mounted: true }];
  await assert.rejects(deleteFile(image(game), '/data'), /still has it mounted/);
  assert.equal(files.has(game), true);
  assert.deepEqual(uninstalled(), []);
});

test('Files tab: Jobee\'sLair\'s own title is never uninstalled without its specific confirmation', async () => {
  files.set(USB1, 'image');
  shadow.games = [{ title_id: SELF, path: USB1 }];
  const { note } = await deleteFile(image(USB1), '/mnt/usb1');
  assert.equal(files.has(USB1), false);
  assert.deepEqual(uninstalled(), []);
  assert.equal(note, en['files.delete.selfKept']);

  files.set(USB1, 'image');
  await deleteFile(image(USB1), '/mnt/usb1', { confirmUninstallSelf: 'PPSA01234' });
  assert.deepEqual(uninstalled(), [], 'a confirmation for another title is not one for Jobee\'sLair');

  files.set(USB1, 'image');
  await deleteFile(image(USB1), '/mnt/usb1', { confirmUninstallSelf: SELF });
  assert.deepEqual(uninstalled(), [SELF]);
});

test('Files tab: the Homebrew edition\'s title (PPSA99472) is guarded the same way', async () => {
  const p = '/mnt/usb1/homebrew/JobeesLair-Homebrew.exfat';
  files.set(p, 'image');
  shadow.games = [{ title_id: 'PPSA99472', path: p }];
  await deleteFile(image(p), '/mnt/usb1');
  assert.deepEqual(uninstalled(), []);
});
