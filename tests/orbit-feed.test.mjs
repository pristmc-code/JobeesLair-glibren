// glibren.20: a lista Orbit Store no app (state/orbit-feed.js + state/feeds.js) e os limites novos dos feeds (5000 jogos,
// 20000 links, 8 MiB): desligada por padrao; ligada, o arquivo que o payload grava entra como um feed do PS5 e sai ao
// desligar; a regra de "parou de atualizar" igual a do payload; a opcao chega ao payload mesmo antes de ele ser registrado;
// e o aviso ao abrir o app sai uma vez por problema. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const href = (rel) => pathToFileURL(path.join(repo, rel)).href;
const core = await import('@ps5-react/core');
const files = new Map();
const times = new Map();
globalThis.__stubFiles = files;
let clock = 1000;
const put = (file, text) => {
  files.set(file, text);
  times.set(file, ++clock);
};
core.FileSystem.stat = (file) => files.has(file) ? { name: file.slice(file.lastIndexOf('/') + 1), isFile: true, isDirectory: false, size: files.get(file).length, modified: times.get(file) ?? 0 } : null;
core.FileSystem.remove = (file) => files.delete(file);
core.Http.request = async () => {
  throw new Error('offline');
};
const told = [];
core.Notifications.notify = (text) => told.push(text);

const orbit = await import(href('app/state/orbit-feed.js'));
const { MAX_GAMES, parseFeed } = await import(href('app/state/feed-format.js'));
let launches = 0;
const launch = () => import(`${href('app/state/feeds.js')}?launch=${++launches}`);
const game = (id, links = 1) => ({ id, title: `Jogo ${id}`, about: ['Uma descricao.'], art: { cover: `https://img.example/${id}.png`, hero: `https://img.example/${id}-hero.png` },
  releases: Array.from({ length: links }, (_, index) => ({ url: `https://archive.org/download/${id}/${index}.pkg`, record: `orbit-${id}-${index}` })) });
const id = (n, prefix = 'PPSA') => `${prefix}${String(n).padStart(5, '0')}`;
const NOW = 1_800_000_000;

test('the limits: 5000 games and 20000 links per feed (the Orbit list alone has ~2400 games and ~5200 links)', () => {
  assert.equal(MAX_GAMES, 5000);
  const big = { version: 1, name: 'Grande', games: Array.from({ length: 5001 }, (_, n) => game(id(n % 2 ? n : n, n % 2 ? 'CUSA' : 'PPSA'), 4)) };
  const feed = parseFeed(big, '/data/grande.json');
  assert.equal(feed.games.length, 5000, 'the 5001st is left out');
  const releases = feed.games.reduce((sum, item) => sum + item.releases.length, 0);
  assert.equal(releases, 20000, 'and no more than 20000 links in all');
  assert.equal(feed.games[0].page.about[0], 'Uma descricao.');
  assert.equal(feed.games[0].game.art.hero, 'https://img.example/PPSA00000-hero.png');
});

test('stale: in step, broken at once, failing after 24 h without a good update, quiet after 14 days on one revision', () => {
  const { orbitStale } = orbit;
  const fine = { enabled: true, enabledAt: NOW - 100, lastTry: NOW - 60, lastOk: NOW - 60, revisionSince: NOW - 86400, kind: '' };
  assert.equal(orbitStale(fine, true, NOW), '');
  assert.equal(orbitStale(fine, false, NOW), '', 'off: never a warning');
  assert.equal(orbitStale(null, true, NOW), '');
  assert.equal(orbitStale({ ...fine, kind: 'broken' }, true, NOW), 'broken');
  assert.equal(orbitStale({ ...fine, kind: 'network', lastOk: NOW - 23 * 3600 }, true, NOW), '', 'a failure inside 24 h is not yet a warning');
  assert.equal(orbitStale({ ...fine, kind: 'network', lastOk: NOW - 25 * 3600 }, true, NOW), 'failing');
  assert.equal(orbitStale({ ...fine, lastOk: 0, enabledAt: NOW - 25 * 3600 }, true, NOW), 'failing', 'never worked since it was turned on');
  assert.equal(orbitStale({ ...fine, lastTry: 0, lastOk: 0, enabledAt: NOW - 25 * 3600 }, true, NOW), 'failing', 'on for a day and the payload never tried');
  assert.equal(orbitStale({ ...fine, revisionSince: NOW - 15 * 86400 }, true, NOW), 'quiet');
});

test('off by default; on, the payload file is a feed on the console; off again, it is gone; it cannot be added by hand', async () => {
  files.clear();
  const sent = [];
  orbit.setOrbitSource(null);
  assert.equal(orbit.orbitFeedOn(), false);
  const feeds = await launch();
  assert.equal(feeds.orbitFeedSnapshot(), null);
  await feeds.refreshFeeds();
  assert.equal(feeds.loadFeedGames().length, 0);
  // Turned on before the payload client exists: the setting waits and goes as soon as it registers.
  orbit.setOrbitFeed(true);
  assert.equal(JSON.parse(files.get('/download0/JobeesLair/settings.json')).orbitFeed, true);
  orbit.setOrbitSource(async (body) => {
    sent.push(body);
    return { enabled: body.enabled };
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, [{ enabled: true, refresh: true }]);
  // Not written yet: the list says why; then the payload writes it.
  await feeds.refreshFeeds();
  assert.equal(feeds.orbitFeedSnapshot().state, 'failed');
  put(orbit.ORBIT_FEED, JSON.stringify({ version: 1, name: 'Orbit Store', games: Array.from({ length: 2421 }, (_, n) => game(id(n), 2)) }));
  await feeds.refreshFeeds();
  const card = feeds.orbitFeedSnapshot();
  assert.equal(card.games, 2421, 'past the old limit of 1500');
  assert.equal(card.local, true);
  assert.equal(feeds.feedsSnapshot().length, 0, 'not among the player\'s own feeds');
  const next = await launch();
  assert.equal(next.loadFeedGames().length, 2421);
  // On the console the path passes the drive check and the Orbit rule refuses it; here the stub data dir is not /data.
  assert.throws(() => next.addFeed(orbit.ORBIT_FEED), /Orbit Store list|internal drive/);
  // Settings' Refresh feeds asks the payload for a fresh copy too.
  await next.refreshFeedsNow();
  assert.deepEqual(sent.at(-1), { enabled: true, refresh: true });
  orbit.setOrbitFeed(false);
  assert.deepEqual(sent.at(-1), { enabled: false, refresh: false });
  assert.equal(next.orbitFeedSnapshot(), null);
  const after = await launch();
  assert.equal(after.loadFeedGames().length, 0, 'off: its games are gone');
  assert.ok(files.has(orbit.ORBIT_FEED), 'the payload file itself is kept');
});

test('at launch: the setting goes to the payload, and a stopped list notifies once per problem', async () => {
  files.clear();
  told.length = 0;
  const sent = [];
  orbit.setOrbitSource(async (body) => {
    sent.push(body);
    return null;
  });
  orbit.setOrbitFeed(true);
  const now = Math.floor(Date.now() / 1e3);
  put(orbit.ORBIT_STATUS, JSON.stringify({ enabled: true, enabledAt: now - 30 * 86400, lastTry: now - 3600, lastOk: now - 26 * 3600, revisionSince: now - 3 * 86400, kind: 'network', error: 'download failed: HTTP 503' }));
  const t = (key) => `[${key}]`;
  assert.equal(orbit.startOrbitFeed(t), 'failing');
  assert.deepEqual(told, ['[orbit.stale.failing]']);
  assert.deepEqual(sent.at(-1), { enabled: true });
  assert.equal(orbit.startOrbitFeed(t), 'failing');
  assert.equal(told.length, 1, 'the same problem is not told again');
  put(orbit.ORBIT_STATUS, JSON.stringify({ enabled: true, enabledAt: now - 30 * 86400, lastTry: now - 60, lastOk: now - 60, revisionSince: now - 3 * 86400, kind: 'broken' }));
  orbit.startOrbitFeed(t);
  assert.deepEqual(told, ['[orbit.stale.failing]', '[orbit.stale.broken]'], 'a different problem is');
  put(orbit.ORBIT_STATUS, JSON.stringify({ enabled: true, enabledAt: now - 30 * 86400, lastTry: now - 60, lastOk: now - 60, revisionSince: now - 3 * 86400, kind: '' }));
  assert.equal(orbit.startOrbitFeed(t), '');
  assert.equal(told.length, 2);
  orbit.setOrbitFeed(false);
  orbit.setOrbitSource(null);
});

// glibren.25: no PS5 o app le a pasta que o payload grava (/data/JobeesLair/orbit), nao a sua pasta de dados
// (/download0 ou /data/ps5-react/<ID>): ate a .24 a lista nunca aparecia no console.
test('on the PS5 the list is read where the payload writes it (/data/JobeesLair/orbit)', async () => {
  const before = core.Platform.OS;
  core.Platform.OS = 'ps5';
  try {
    const ps5 = await import(`${href('app/state/orbit-feed.js')}?ps5`);
    assert.equal(ps5.ORBIT_FEED, '/data/JobeesLair/orbit/orbit-store.json');
    assert.equal(ps5.ORBIT_STATUS, '/data/JobeesLair/orbit/orbit-store-status.json');
  } finally {
    core.Platform.OS = before;
  }
});
