// glibren.27: um feed da web (o catalogo ao vivo, ps5/live.jlx, ~1,8 MB) lido do texto um jogo por vez, sem a arvore do
// documento inteiro no heap de 32 MiB do app. No PS5 a glibren.26 ficou sem memoria ao ler o catalogo ao vivo ("out of
// memory in regexp execution") e fechou. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const { jsonMembers } = await import('../app/state/json-scan.js');
const { parseFeed, parseFeedText, parseFeedTextAsync, checkFeedTextAsync, feedDocument } = await import('../app/state/feed-format.js');
const { encodeJlx, readJlx } = await import('../app/state/jlx.js');
const { PS5_LIVE } = await import('../tools/catalog/lists-dir.mjs');

const URL_ = 'https://example.com/feed.json';
const sample = (count) => ({
  version: 1, name: 'Sample', mirrors: ['https://mirror.example/feed.json', 'nope'],
  ratings: { PPSA00001: [4.5, 10], bad: [1, 1] },
  games: Array.from({ length: count }, (_, i) => ({
    id: `PPSA${String(i % (count - 3) + 1).padStart(5, '0')}`, // a few repeated ids
    title: `Game "${i}" \\ é`,
    about: [`About ${i}: ${'x'.repeat(200)}`], summary: `About ${i}`,
    releases: i % 50 === 7 ? [] : [{ url: `https://example.com/files/${i}/game.exfat`, label: 'Main' }, { url: `https://host.example/f/${i}`, provider: 'Host' }],
  })),
});

test('jsonMembers: the members and the streamed list, by position, and SyntaxError for what is not JSON', () => {
  const text = ' {"a": 1, "s":"x\\"}y\\\\", "games" : [ {"id":"[" } , 2 ,"t"], "z":{"k":[1,{"q":"}"}]}} ';
  const parts = [...jsonMembers(text, 0, text.length, 'games')].map((p) => p.open ? 'open' : `${p.item ? 'item ' : `${p.key} `}${text.slice(p.start, p.end)}`);
  assert.deepEqual(parts, ['a 1', 's "x\\"}y\\\\"', 'open', 'item {"id":"[" }', 'item 2', 'item "t"', 'z {"k":[1,{"q":"}"}]}']);
  for (const bad of ['', '[]', '{', '{"a":}', '{"a":1,}', '{"a":1} x', '{"games":[1,]}', '{"a":"b}', '{"a" 1}', '{"games":[1 2]}'])
    assert.throws(() => [...jsonMembers(bad, 0, bad.length, 'games')], SyntaxError, bad);
  assert.deepEqual([...jsonMembers('{}', 0, 2)], []);
});

test('parseFeedText gives what parseFeed(JSON.parse(text)) gives, for any feed form', async () => {
  const docs = [
    sample(300),
    { ...sample(20), games: sample(20).games, version: 2 }, // not a feed
    { name: 'P', version: 1, packages: [{ titleId: 'PPSA11111', title: 'Big', downloadLinks: [{ name: 'Dump - VikingFile', url: 'https://vikingfile.com/f/c' }] }] },
    { version: 1, games: 'no' },
    [1, 2],
  ];
  const outcome = (fn) => { try { return fn(); } catch (error) { return `throws ${error.message}`; } };
  for (const doc of docs) for (const text of [JSON.stringify(doc), JSON.stringify(doc, null, 2)]) {
    const expected = outcome(() => parseFeed(JSON.parse(text), URL_));
    assert.deepEqual(outcome(() => parseFeedText(text, URL_)), expected);
    let got;
    try { got = await parseFeedTextAsync(text, URL_, async () => {}); } catch (error) { got = `throws ${error.message}`; }
    assert.deepEqual(got, expected);
  }
  // "games" twice: the last one counts, as in JSON.parse; a range inside a bigger text (a cache's document).
  const twice = '{"version":1,"games":[],"games":' + JSON.stringify(sample(5).games) + '}';
  assert.deepEqual(parseFeedText(twice, URL_), parseFeed(JSON.parse(twice), URL_));
  const doc = JSON.stringify(sample(40));
  const wrapped = `{"url":"u","document":${doc}}`;
  assert.deepEqual(parseFeedText(wrapped, URL_, wrapped.indexOf(doc), wrapped.lastIndexOf('}')), parseFeed(JSON.parse(doc), URL_));
  assert.throws(() => parseFeedText('{"version":1,"games":[{"id":1},]}', URL_), SyntaxError);
  // A refresh checks every game the same way but keeps only what the index and the count use.
  const text = JSON.stringify(sample(300));
  const full = parseFeed(JSON.parse(text), URL_);
  const lean = await checkFeedTextAsync(text, URL_, async () => {});
  assert.deepEqual(lean, { ...full, games: full.games.map(({ game }) => ({ game: { id: game.id, direct: game.direct } })) });
});

test('the live catalog reads the same from its text as from the whole document', { skip: existsSync(PS5_LIVE) ? false : `no lists clone at ${PS5_LIVE}` }, () => {
  const text = readJlx(readFileSync(PS5_LIVE, 'utf8'));
  const url = 'https://raw.githubusercontent.com/JVK3R/JobeesLair/main/catalog/live.json';
  assert.deepEqual(parseFeedText(text, url), parseFeed(JSON.parse(text), url));
});

test('a refresh and the next launch read a big JLX feed without JSON.parse of the whole document, and the cache is written in pieces', async () => {
  const core = await import('@ps5-react/core');
  const keptFiles = globalThis.__stubFiles, keptRequest = core.Http.request, keptParse = JSON.parse;
  const files = new Map();
  globalThis.__stubFiles = files;
  const doc = sample(3000);
  const plain = JSON.stringify(doc);
  const body = encodeJlx(plain);
  assert.ok(body.length > 900_000, `${body.length} characters`);
  let biggest = 0, appends = 0;
  core.Http.request = async () => ({ ok: true, status: 200, headers: { etag: '"big1"' }, text: async () => body });
  core.FileSystem.appendFile = (file, text) => { appends++; files.set(file, (files.get(file) ?? '') + text); };
  JSON.parse = function (text, ...rest) {
    if (typeof text === 'string') biggest = Math.max(biggest, text.length);
    return keptParse.call(this, text, ...rest);
  };
  try {
    const feeds = await import(`../app/state/feeds.js?big=${Date.now()}`);
    await feeds.refreshFeeds();
    assert.equal(feeds.feedsSnapshot([feeds.LIVE_FEED])[0].state, 'ok');
    const loaded = feeds.loadFeedGames();
    JSON.parse = keptParse;
    assert.ok(biggest < 20_000, `the largest JSON.parse was ${biggest} characters`);
    assert.ok(appends > 1, 'the document went to the cache in pieces');
    const cache = [...files].find(([file]) => file.includes('/feeds/') && !file.endsWith('.tmp'));
    assert.ok(cache, 'the cache is there');
    assert.deepEqual(JSON.parse(cache[1]).document, doc, 'the cache keeps the text that came, decoded');
    const expected = parseFeed(doc, feeds.LIVE_FEED).games;
    assert.deepEqual(loaded.map(({ game }) => game.id), expected.map(({ game }) => game.id));
    assert.deepEqual(loaded.map(({ releases }) => releases.map((r) => r.id)), expected.map(({ releases }) => releases.map((r) => r.id)));
    // A cache from before (the normalized document) still reads.
    const old = { url: feeds.LIVE_FEED, from: feeds.LIVE_FEED, hash: 'h', etag: null, fetchedAt: 't', name: 'n', games: 1, skipped: 0, mirrors: [] };
    files.set(cache[0], `${JSON.stringify(old).slice(0, -1)},"document":${JSON.stringify(feedDocument(parseFeed(sample(10), feeds.LIVE_FEED)))}}`);
    assert.equal(feeds.loadFeedGames().length, parseFeed(sample(10), feeds.LIVE_FEED).games.length);
  } finally {
    JSON.parse = keptParse;
    delete core.FileSystem.appendFile;
    globalThis.__stubFiles = keptFiles;
    core.Http.request = keptRequest;
  }
});

test('the web feed path keeps no copy it does not need: the response goes once read, no regex over the text', () => {
  const feeds = readFileSync(new URL('../app/state/feeds.js', import.meta.url), 'utf8');
  const fetchFrom = feeds.slice(feeds.indexOf('async function fetchFrom('), feeds.indexOf('async function refreshLocal('));
  assert.match(fetchFrom, /let text2 = await response\.text\(\);\n\s+response = null;/, 'the response (and the text it holds) goes once read');
  assert.match(fetchFrom, /text2 = await readJlxAsync\(text2, nextFrame\)/, 'the encoded text goes once decoded');
  assert.doesNotMatch(fetchFrom, /JSON\.parse\(/, 'no tree of the whole document');
  const fetchFeed = feeds.slice(feeds.indexOf('async function fetchFeed('), feeds.indexOf('var refreshing = null'));
  assert.doesNotMatch(fetchFeed, /feedDocument\(|JSON\.stringify\(feedDocument/, 'no document rebuilt for the cache');
  assert.match(fetchFeed, /writeCacheText\(/);
  const scan = readFileSync(new URL('../app/state/json-scan.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(scan, /\.(?:match|replace|test|exec|split)\(|new RegExp/, 'json-scan.js runs no regex');
});
