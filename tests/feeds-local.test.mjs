// glibren.14: catalog feeds without the limit of three, and feeds that are a .json file on the console (state/feeds.js,
// state/local-feed.js): linked by path, read again at every launch, kept with their last good read when the file is
// gone, and never deleted when the link is removed. Each "launch" imports feeds.js afresh over the same files.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const href = (rel) => pathToFileURL(path.join(repo, rel)).href;
const core = await import('@ps5-react/core');
const { checkLocalPath, feedFolder, isLocalFeed, parentFolder } = await import(href('app/state/local-feed.js'));

// The console's files (the stub's FileSystem reads globalThis.__stubFiles), with a time per file for stat.
const files = new Map();
const times = new Map();
const removed = [];
globalThis.__stubFiles = files;
let clock = 1000;
const put = (file, text) => {
  files.set(file, text);
  times.set(file, ++clock);
};
core.FileSystem.stat = (file) => files.has(file) ? { name: file.slice(file.lastIndexOf('/') + 1), isFile: true, isDirectory: false, size: files.get(file).length, modified: times.get(file) ?? 0 } : null;
core.FileSystem.remove = (file) => {
  removed.push(file);
  files.delete(file);
};
// Nothing answers on the web: the live catalog and any web feed fail their refresh, and that is all.
core.Http.request = async () => {
  throw new Error('offline');
};
let launches = 0;
const launch = () => import(`${href('app/state/feeds.js')}?launch=${++launches}`);
const savedFeeds = () => JSON.parse(files.get('/download0/JobeesLair/feeds.json') ?? '[]');
const feed = (name, ids) => JSON.stringify({ version: 1, name, games: ids.map((id, index) => ({ id, title: `Jogo ${index + 1}`, releases: [{ url: `https://example.com/${id}.pkg` }] })) });
const FILE = '/data/feeds/meu-catalogo.json';

test('no limit of three feeds: dozens of web feeds can be added, up to the safety ceiling of 50', async () => {
  files.clear();
  const feeds = await launch();
  assert.equal(feeds.MAX_FEEDS, 50);
  for (let index = 1; index <= 50; index++) feeds.addFeed(`https://feeds.example.com/catalog-${index}.json`);
  assert.equal(savedFeeds().length, 50);
  assert.equal(feeds.feedsSnapshot().length, 50);
  assert.throws(() => feeds.addFeed('https://feeds.example.com/one-too-many.json'), /Up to 50 feeds/);
  await feeds.refreshFeeds();
});

test('a file on the console is linked by its path, read, and shows its path, games and when it was read', async () => {
  files.clear();
  put(FILE, feed('Meu catalogo', ['PPSA01234']));
  const feeds = await launch();
  feeds.addLocalFeed(FILE);
  assert.deepEqual(savedFeeds(), [FILE], 'the link is the path, saved in feeds.json');
  await feeds.refreshFeeds();
  const [card] = feeds.feedsSnapshot();
  assert.equal(card.url, FILE);
  assert.equal(card.local, true);
  assert.equal(card.state, 'ok');
  assert.equal(card.name, 'Meu catalogo');
  assert.equal(card.games, 1);
  assert.match(card.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(card.mirrors, []);
  assert.equal(card.restart, true, 'what it brings shows from the next launch');
  assert.throws(() => feeds.addMirror(FILE, 'https://mirror.example.com/x.json'), /no mirrors/);
  assert.throws(() => feeds.addLocalFeed(FILE), /already added/);
});

test('every launch reads the file again: an edited file shows at the next opening, without any refresh', async () => {
  files.clear();
  put(FILE, feed('Meu catalogo', ['PPSA01234']));
  (await launch()).addLocalFeed(FILE);
  let feeds = await launch();
  let games = feeds.loadFeedGames().filter((item) => item.feed === FILE);
  assert.deepEqual(games.map((item) => item.game.id), ['PPSA01234'], 'read at launch, before any refresh');
  put(FILE, feed('Meu catalogo v2', ['PPSA01234', 'CUSA05678']));
  feeds = await launch();
  games = feeds.loadFeedGames().filter((item) => item.feed === FILE);
  assert.deepEqual(games.map((item) => item.game.id).sort(), ['CUSA05678', 'PPSA01234']);
  const [card] = feeds.feedsSnapshot();
  assert.equal(card.name, 'Meu catalogo v2');
  assert.equal(card.games, 2);
  assert.equal(card.state, 'ok');
  // Changed while the app is open: Refresh feeds reads it and says to reopen the app.
  put(FILE, feed('Meu catalogo v3', ['PPSA01234']));
  await feeds.refreshFeeds();
  assert.equal(feeds.feedsSnapshot()[0].games, 1);
  assert.equal(feeds.feedsSnapshot()[0].restart, true);
});

test('a missing file (drive unplugged) keeps its link and the games of its last good read, and says why', async () => {
  files.clear();
  const usb = '/mnt/usb0/feeds/pen.json';
  put(usb, feed('Do pendrive', ['PPSA01234', 'PPSA04321']));
  (await launch()).addLocalFeed(usb);
  (await launch()).loadFeedGames();
  files.delete(usb);
  const feeds = await launch();
  const games = feeds.loadFeedGames().filter((item) => item.feed === usb);
  assert.equal(games.length, 2, 'the last good read is still in the store');
  const [card] = feeds.feedsSnapshot();
  assert.equal(card.url, usb);
  assert.equal(card.state, 'failed');
  assert.match(card.error, /not found/i);
  assert.equal(card.games, 2);
  assert.deepEqual(savedFeeds(), [usb], 'the link stays');
  // A refresh with the drive still out says the same; plugged back in, it reads again.
  await feeds.refreshFeeds();
  assert.equal(feeds.feedsSnapshot()[0].state, 'failed');
  put(usb, feed('Do pendrive', ['PPSA01234']));
  await feeds.refreshFeeds();
  assert.equal(feeds.feedsSnapshot()[0].state, 'ok');
  assert.equal(feeds.feedsSnapshot()[0].games, 1);
});

test('a file that is not a feed, or too big, is reported and changes nothing', async () => {
  files.clear();
  put(FILE, feed('Bom', ['PPSA01234']));
  (await launch()).addLocalFeed(FILE);
  (await launch()).loadFeedGames();
  put(FILE, '{ isto nao e json');
  let feeds = await launch();
  assert.equal(feeds.loadFeedGames().filter((item) => item.feed === FILE).length, 1, 'the last good read');
  assert.match(feeds.feedsSnapshot()[0].error, /Not JSON/);
  put(FILE, 'x'.repeat(8 * 1024 * 1024 + 1)); // glibren.20: 8 MiB (was 2)
  feeds = await launch();
  feeds.loadFeedGames();
  assert.match(feeds.feedsSnapshot()[0].error, /larger than 8 MiB/);
});

test('removing the link never deletes the file', async () => {
  files.clear();
  removed.length = 0;
  put(FILE, feed('Meu catalogo', ['PPSA01234']));
  (await launch()).addLocalFeed(FILE);
  const feeds = await launch();
  feeds.loadFeedGames();
  feeds.removeFeed(FILE);
  assert.deepEqual(savedFeeds(), []);
  assert.ok(files.has(FILE), 'the file is still there');
  assert.ok(!removed.includes(FILE), 'it was never removed');
  assert.ok(removed.every((file) => file.startsWith('/download0/JobeesLair/feeds/')), 'only the app copy goes');
  assert.equal(feeds.feedsSnapshot().length, 0);
});

test('a path typed in Add a feed (or file://) links the file too; bad paths are refused', async () => {
  files.clear();
  put(FILE, feed('Meu catalogo', ['PPSA01234']));
  const feeds = await launch();
  feeds.addFeed(`file://${FILE}`);
  assert.deepEqual(savedFeeds(), [FILE]);
  for (const [value, reason] of [
    ['feeds/x.json', /full http/],
    ['/data/../etc/x.json', /not valid/],
    ['/data/./x.json', /not valid/],
    ['/data//x.json', /not valid/],
    ['/data/feeds/x.txt', /\.json/],
    ['/etc/passwd.json', /internal drive/],
    ['/system/x.json', /internal drive/],
    ['/mnt/sandbox/x.json', /internal drive/],
    ['/data\\x.json', /not valid/],
    ['/data/feeds/nao-existe.json', /not found/i]
  ]) assert.throws(() => feeds.addFeed(value), reason, value);
  assert.throws(() => feeds.addLocalFeed('https://example.com/x.json'), /full path/);
  assert.deepEqual(savedFeeds(), [FILE], 'nothing else was linked');
  await feeds.refreshFeeds();
});

test('local-feed: paths, folders and the picker listing', () => {
  assert.equal(checkLocalPath(' /data/JobeesLair/feeds.json '), '/data/JobeesLair/feeds.json');
  assert.equal(checkLocalPath('file:///mnt/ext1/meu%20feed.json'), '/mnt/ext1/meu feed.json');
  assert.equal(checkLocalPath('/mnt/usb3/a/B.JSON'), '/mnt/usb3/a/B.JSON');
  assert.throws(() => checkLocalPath('/data'), /\.json/);
  assert.throws(() => checkLocalPath('/mnt/usbx/a.json'), /internal drive/);
  assert.equal(isLocalFeed('/data/a.json'), true);
  assert.equal(isLocalFeed('https://example.com/a.json'), false);
  assert.equal(parentFolder('/data'), null);
  assert.equal(parentFolder('/mnt/usb0'), null);
  assert.equal(parentFolder('/data/JobeesLair'), '/data');
  assert.equal(parentFolder('/mnt/usb0/a/b'), '/mnt/usb0/a');
  const fs = { readDir: () => [
    { name: 'zeta.json', isFile: true, isDirectory: false, size: 10 },
    { name: 'Alfa', isFile: false, isDirectory: true },
    { name: '.oculto', isFile: false, isDirectory: true },
    { name: 'leia.txt', isFile: true, isDirectory: false, size: 5 },
    { name: 'beta.JSON', isFile: true, isDirectory: false, size: 20 },
    { name: '.ps5-react-tmp', isFile: false, isDirectory: true }
  ] };
  const listed = feedFolder(fs, '/data/feeds');
  assert.deepEqual(listed.folders, [{ name: 'Alfa', path: '/data/feeds/Alfa' }]);
  assert.deepEqual(listed.files.map((file) => file.path), ['/data/feeds/beta.JSON', '/data/feeds/zeta.json']);
  assert.equal(listed.more, 0);
});
