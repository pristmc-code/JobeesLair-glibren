// Catalog feeds the player added in Settings: the list (feeds.json), each feed's last good copy (one
// cache file per feed, in feed form) and its refresh state. The catalog reads the caches once, as it
// loads (state/catalog.js), so what a refresh brings in is shown from the next launch.
//
// A feed is its address plus any number of mirrors: other addresses serving the same feed. A feed that
// lists its own `mirrors` brings them along; the player can add more (feed-mirrors.json), from the
// console or the phone. A refresh tries the address that worked last first, then the feed's own address,
// then the mirrors, and stops at the first that gives a usable feed. So a feed whose domain is taken down
// keeps refreshing from a mirror, and when every address is down the last good copy on the console is
// kept. Nothing here touches the download handlers: a feed only ever supplies catalog records.
//
// glibren.14: a feed can also be a .json file on the console (state/local-feed.js): its entry in feeds.json is the
// file's path. It is read from the disk at every launch, as the catalog loads (so an edited file shows the next time
// the app opens), and again on Refresh feeds. A file that is missing or unreadable (its drive unplugged) keeps its
// link and the games of its last good read, as a feed whose every address is down keeps its last good copy. Removing
// the link never touches the file itself. No mirrors for a file.

import { useEffect, useState } from 'react';
import { MAX_MIRRORS, feedDocument, parseFeed, parseFeedAsync, stableKey, stableKeyAsync } from './feed-format.js';
import { isoStamp } from './clock.js';
import { DATA_DIR, LEGACY_DATA_DIR } from './data-dir.js';
import { webURL } from './download-sources.js';
import { checkLocalPath, isLocalFeed } from './local-feed.js';
import { savedList } from './saved.js';
import { FileSystem, Http } from '@ps5-react/core';

  // The JS heap is 32 MiB for everything: a few modest feeds, each read whole. glibren.14: no longer three of the
  // player's own; MAX_FEEDS is only a safety ceiling, far above what anyone links.
  var MAX_FEEDS = 50, MAX_BYTES = 2 * 1024 * 1024;
  // MODIFIED (0.5.1): the live catalog, built every few hours from the public Pegasus catalogs
  // (tools/catalog/live-feed.mjs, .github/workflows/catalog-live.yml): games and links newer than this build's
  // bundled catalog. Every console reads it like a feed the player added, without being listed in Settings,
  // so a game added there shows up in the store the next time Jobee'sLair starts.
  var LIVE_FEED = "https://raw.githubusercontent.com/JVK3R/JobeesLair/main/catalog/live.json";
  // The feeds read and refreshed: the live catalog first, then the player's.
  var allFeeds = () => [LIVE_FEED, ...feedList.get().filter((url) => url !== LIVE_FEED)];
  var DIR = `${DATA_DIR}/feeds`;
  // Caches an earlier build left in the old data folder are read until the feed refreshes into this one.
  var LEGACY_DIR = `${LEGACY_DATA_DIR}/feeds`;
  var feedList = savedList("feeds.json", "feeds");
  // The player's mirrors, by feed address: { "<feed url>": ["<mirror url>", …] }.
  var mirrorStore = savedList("feed-mirrors.json", "feed mirrors");
  var cacheFile = (url) => `${DIR}/${stableKey(url)}.json`;
  function readCache(url) {
    for (const path of [cacheFile(url), `${LEGACY_DIR}/${stableKey(url)}.json`]) {
      try {
        const cache = JSON.parse(FileSystem.readFile(path));
        if (cache?.url === url && cache.document) return cache;
      } catch {
      }
    }
    return null;
  }
  // What the catalog loaded from each feed this launch, by URL: a later refresh that differs needs a restart.
  var loaded = /* @__PURE__ */ new Map();
  // Each feed's last good copy, summarized for Settings ({ name, games, fetchedAt, from, mirrors }), so
  // drawing the list never reads a cache file.
  var meta = /* @__PURE__ */ new Map();
  // What each feed's last good copy lists, as [id, direct] pairs: all the live game counter (state/library-count.js)
  // needs, kept apart from the games themselves so counting never touches a cache file.
  var indexes = /* @__PURE__ */ new Map();
  var indexVersion = 0;
  var setIndex = (url, games) => {
    indexes.set(url, games.map(({ game: game2 }) => [game2.id, game2.direct ? 1 : 0]));
    indexVersion++;
  };
  var summary = (cache) => ({ name: cache.name, games: cache.games, fetchedAt: cache.fetchedAt, from: cache.from ?? cache.url, mirrors: Array.isArray(cache.mirrors) ? cache.mirrors : [], hash: cache.hash, etag: typeof cache.etag === "string" ? cache.etag : null, stamp: typeof cache.stamp === "string" ? cache.stamp : null });
  // glibren.14: a linked file, read off the disk. Its size and time say whether it changed since the cached copy;
  // they also stand for its hash (`loaded` and the "reopen to see it" notice compare them).
  var stampOf = (info) => `${info.size ?? ""}:${info.modified ?? ""}`;
  function statLocal(path) {
    let info;
    try {
      info = FileSystem.stat(path);
    } catch (error2) {
      throw new Error(`File not readable (${error2.message}).`);
    }
    if (!info) throw new Error("File not found. Is its drive connected?");
    if (info.isDirectory) throw new Error("That is a folder, not a file.");
    if (typeof info.size === "number" && info.size > MAX_BYTES) throw new Error("The file is larger than 2 MiB.");
    return info;
  }
  function readLocalDocument(path) {
    let text2;
    try {
      text2 = FileSystem.readFile(path);
    } catch (error2) {
      throw new Error(`File not readable (${error2.message}).`);
    }
    if (typeof text2 !== "string") throw new Error("File not readable.");
    if (text2.length > MAX_BYTES) throw new Error("The file is larger than 2 MiB.");
    try {
      return JSON.parse(text2);
    } catch {
      throw new Error("Not JSON.");
    }
  }
  // The cache of a file's good read: the same form as a fetched feed's, with the file's stamp.
  function saveLocal(url, feed, stamp) {
    const text2 = JSON.stringify(feedDocument({ ...feed, mirrors: [] }));
    const cache = { url, from: url, hash: `file:${stamp}`, etag: null, stamp, fetchedAt: isoStamp(Date.now()), name: feed.name, games: feed.games.length, skipped: feed.skipped, mirrors: [] };
    try {
      FileSystem.mkdir(DIR, { recursive: true });
      FileSystem.writeFile(`${cacheFile(url)}.tmp`, `${JSON.stringify(cache).slice(0, -1)},"document":${text2}}`);
      FileSystem.rename(`${cacheFile(url)}.tmp`, cacheFile(url));
    } catch (error2) {
      console.log(`feeds: copy of ${url} not kept: ${error2.message}`);
    }
    meta.set(url, summary(cache));
    setIndex(url, feed.games);
    return cache;
  }
  // At launch: the file as it is on the disk now, or (missing, unreadable, not a feed) its last good read, with the
  // reason in its status. The cached copy stands in for the file when its stamp says nothing changed.
  function loadLocal(url) {
    const cache = readCache(url);
    let failure = null;
    try {
      const info = statLocal(url);
      const stamp = stampOf(info);
      if (cache && cache.stamp === stamp) {
        const feed2 = parseFeed(cache.document, url);
        loaded.set(url, cache.hash);
        meta.set(url, { ...summary(cache), fetchedAt: isoStamp(Date.now()) });
        setIndex(url, feed2.games);
        return feed2;
      }
      const feed = parseFeed(readLocalDocument(url), url);
      if (!feed.games.length) throw new Error("No usable games in this file.");
      const saved = saveLocal(url, feed, stamp);
      loaded.set(url, saved.hash);
      console.log(`feeds: ${url}: read, ${feed.games.length} games, ${feed.skipped} skipped`);
      return feed;
    } catch (error2) {
      failure = error2;
    }
    console.log(`feeds: ${url} not read: ${failure.message}`);
    status.set(url, { state: "failed", error: failure.message });
    if (!cache) return null;
    const feed = parseFeed(cache.document, url);
    loaded.set(url, cache.hash);
    meta.set(url, summary(cache));
    setIndex(url, feed.games);
    return feed;
  }
  // Every listed feed's cached games, validated again: { game, page, releases } as parseFeed gives them.
  // The store ratings the feeds carry (0.5.1), [stars, count] by title ID; the live catalog's first, as it is listed first.
  var feedRatings = {};
  function loadFeedGames() {
    const out = [];
    for (const url of allFeeds()) {
      const cache = isLocalFeed(url) ? null : readCache(url);
      if (!cache && !isLocalFeed(url)) continue;
      try {
        let feed;
        if (isLocalFeed(url)) {
          feed = loadLocal(url);
          if (!feed) continue;
        } else {
          feed = parseFeed(cache.document, url);
          loaded.set(url, cache.hash);
          meta.set(url, summary(cache));
          setIndex(url, feed.games);
        }
        // glibren.9: each game says which feed it came from (the TorBox library's sources, state/torbox-library.js).
        for (const item of feed.games) item.feed = url;
        out.push(...feed.games);
        for (const [id, pair] of Object.entries(feed.ratings ?? {})) if (!feedRatings[id]) feedRatings[id] = pair;
      } catch (error2) {
        console.log(`feeds: cached ${url} unreadable: ${error2.message}`);
      }
    }
    return out;
  }
  // Refresh state per URL: { state: "refreshing" | "ok" | "failed", error, changed }.
  var status = /* @__PURE__ */ new Map();
  var listeners = /* @__PURE__ */ new Set();
  var notify = () => {
    for (const listener of listeners) listener();
  };
  function setStatus(url, value) {
    status.set(url, value);
    notify();
  }
  function checkURL(value) {
    const url = (value || "").trim();
    let parsed;
    try {
      parsed = webURL(url);
    } catch {
      throw new Error("Enter a full http:// or https:// address.");
    }
    if (parsed.path === "/" && !url.endsWith("/")) throw new Error("Enter the feed file's full address, not just its site.");
    return url;
  }
  var hostOf = (url) => {
    try {
      return webURL(url).host;
    } catch {
      return url;
    }
  };
  // The player's mirrors of a feed.
  var userMirrors = (url) => {
    const list = mirrorStore.get()[url];
    return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
  };
  // Every mirror of a feed: the player's, then the ones the feed names itself (none for a file on the console).
  var mirrorsOf = (url) => isLocalFeed(url) ? [] : [...new Set([...userMirrors(url), ...meta.get(url)?.mirrors ?? []])].filter((mirror) => mirror !== url);
  // glibren.14: what the player typed or picked: a file's path (or file:// address), else a web address.
  var addressOf = (value) => /^\s*(?:\/|file:\/\/)/i.test(value || "") ? checkLocalPath(value) : checkURL(value);
  // The addresses a refresh tries, in order: the one that worked last, the feed's own, then its mirrors.
  function sourcesOf(url) {
    const all = [url, ...mirrorsOf(url)];
    const last = meta.get(url)?.from;
    return [...new Set(last && all.includes(last) ? [last, ...all] : all)];
  }
  // One fetch per feed at a time: adding a feed while every feed refreshes (or a phone and the console
  // both asking) shares the fetch instead of writing the same cache file twice at once.
  var inflight = /* @__PURE__ */ new Map();
  function refreshFeed(url) {
    if (!inflight.has(url)) inflight.set(url, fetchFeed(url).finally(() => inflight.delete(url)));
    return inflight.get(url);
  }
  var listed = (url) => url === LIVE_FEED || feedList.get().includes(url);
  // A refresh runs while the store or Settings is on screen, and checking a 2 MiB feed took the console's
  // interpreter about a second per feed in one piece: the screen stopped answering (Settings froze when
  // opened just after launch, when the feeds refresh, or on Refresh feeds). Its checking and hashing now
  // stop for a frame every few milliseconds of work.
  var nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
  // One address: the parsed feed, or an error saying why not (so the next address gets its turn). It is
  // parsed as the feed's own address (`url`), so a copy from a mirror has the same release ids and
  // downloads started from either keep their identity.
  // A strong ETag names exactly one copy of a file; a weak one (W/) does not.
  var strongTag = (tag) => typeof tag === "string" && tag !== "" && !tag.startsWith("W/") ? tag : null;
  async function fetchFrom(source, url) {
    // No custom headers: with them the transport will not follow a redirect (raw file hosts redirect).
    const response = await Http.request(source, { maxBytes: MAX_BYTES });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // 0.5.3: the copy the cache holds already, as the server's ETag says: it is not read, checked, hashed or
    // written again. Reading the live catalog (2 MiB at most) and building its copies held the console for
    // over a second after every launch, and its heap filled until a collection stopped the screen; the live
    // catalog changes every few hours, so most launches fetch the same copy.
    const etag = strongTag(response.headers?.etag);
    const known = meta.get(url);
    if (etag && known?.etag === etag && known.from === source) return { unchanged: true };
    let document2;
    try {
      document2 = JSON.parse(await response.text());
    } catch {
      throw new Error("Not JSON.");
    }
    const feed = await parseFeedAsync(document2, url, nextFrame);
    document2 = null; // the raw document can go before the normalized copy is built
    if (!feed.games.length) throw new Error("No usable games in this feed.");
    feed.etag = etag;
    return feed;
  }
  // glibren.14: a linked file, read again (Refresh feeds, and the refresh after launch): an unchanged stamp reads
  // nothing; a missing or broken file keeps its last good read and says why.
  async function refreshLocal(url) {
    setStatus(url, { state: "refreshing" });
    try {
      const info = statLocal(url);
      const stamp = stampOf(info);
      const known = meta.get(url);
      if (known && known.stamp === stamp) {
        meta.set(url, { ...known, fetchedAt: isoStamp(Date.now()) });
        setStatus(url, { state: "ok", changed: loaded.get(url) !== known.hash });
        return;
      }
      const feed = await parseFeedAsync(readLocalDocument(url), url, nextFrame);
      if (!feed.games.length) throw new Error("No usable games in this file.");
      if (!listed(url)) return;
      const cache = saveLocal(url, feed, stamp);
      setStatus(url, { state: "ok", changed: loaded.get(url) !== cache.hash });
      console.log(`feeds: ${url}: read, ${feed.games.length} games, ${feed.skipped} skipped`);
    } catch (error2) {
      console.log(`feeds: ${url} not read: ${error2.message}`);
      if (listed(url)) setStatus(url, { state: "failed", error: error2.message });
    }
  }
  async function fetchFeed(url) {
    if (isLocalFeed(url)) return refreshLocal(url);
    setStatus(url, { state: "refreshing" });
    try {
      const sources = sourcesOf(url);
      let feed = null, from = null;
      const failures = [];
      for (const source of sources) {
        try {
          feed = await fetchFrom(source, url);
          from = source;
          break;
        } catch (error2) {
          failures.push(error2.message);
          console.log(`feeds: ${source} failed: ${error2.message}`);
        }
      }
      if (!feed) throw new Error(failures.length > 1 ? `${failures[0]} (${failures.length - 1} mirror${failures.length > 2 ? "s" : ""} also failed)` : failures[0]);
      // Removed while it downloaded: nothing is cached for it, and it leaves no status behind.
      if (!listed(url)) return;
      // The cache's copy: only when it was fetched changes (kept until the next launch; the file keeps the time
      // its copy was written).
      if (feed.unchanged) {
        const known = meta.get(url);
        meta.set(url, { ...known, fetchedAt: isoStamp(Date.now()) });
        setStatus(url, { state: "ok", changed: loaded.get(url) !== known.hash });
        console.log(`feeds: ${url}${from === url ? "" : ` (via ${hostOf(from)})`}: unchanged, ${known.games} games`);
        return;
      }
      // 0.5.3: the normalized copy is held only while its text is made, not through the hash's many frames: the
      // interpreter frees it as soon as nothing holds it, and the console's heap is tight while a feed refreshes.
      const text = JSON.stringify(feedDocument(feed));
      await nextFrame();
      const hash = await stableKeyAsync(text, nextFrame);
      if (!listed(url)) return;
      const cache = { url, from, hash, etag: feed.etag, fetchedAt: isoStamp(Date.now()), name: feed.name, games: feed.games.length, skipped: feed.skipped, mirrors: feed.mirrors };
      FileSystem.mkdir(DIR, { recursive: true });
      // The document goes in as the text already made for the hash: one stringify of the feed, not two.
      FileSystem.writeFile(`${cacheFile(url)}.tmp`, `${JSON.stringify(cache).slice(0, -1)},"document":${text}}`);
      FileSystem.rename(`${cacheFile(url)}.tmp`, cacheFile(url));
      meta.set(url, summary(cache));
      setIndex(url, feed.games);
      setStatus(url, { state: "ok", changed: loaded.get(url) !== hash });
      console.log(`feeds: ${url}${from === url ? "" : ` (via ${hostOf(from)})`}: ${feed.games.length} games, ${feed.skipped} skipped`);
    } catch (error2) {
      console.log(`feeds: ${url} failed: ${error2.message}`);
      if (listed(url)) setStatus(url, { state: "failed", error: error2.message });
    }
  }
  var refreshing = null;
  // One refresh at a time, feed by feed: they share the console's connection with downloads.
  function refreshFeeds() {
    return refreshing ?? (refreshing = (async () => {
      try {
        for (const url of allFeeds()) await refreshFeed(url);
      } finally {
        refreshing = null;
      }
    })());
  }
  // Adds a feed and fetches it; throws (for the address dialog to show) when it cannot be added.
  // glibren.14: a path (or file://) links a file on the console instead; it must be there when it is linked.
  function addFeed(value) {
    const url = addressOf(value);
    const urls = feedList.get();
    if (urls.includes(url) || url === LIVE_FEED) throw new Error("That feed is already added.");
    if (urls.length >= MAX_FEEDS) throw new Error(`Up to ${MAX_FEEDS} feeds. Remove one first.`);
    if (isLocalFeed(url)) statLocal(url);
    feedList.set([...urls, url]);
    void refreshFeed(url);
  }
  // glibren.14: Settings' "Add a file from the PS5" (ui/FeedFilePicker.jsx): only a path.
  function addLocalFeed(path) {
    addFeed(checkLocalPath(path));
  }
  // Adds a fallback address for a feed (kept in feed-mirrors.json); throws when it cannot be added.
  function addMirror(feedUrl, value) {
    if (!listed(feedUrl)) throw new Error("No such feed.");
    if (isLocalFeed(feedUrl)) throw new Error("A file on the console has no mirrors.");
    const mirror = checkURL(value);
    if (mirror === feedUrl) throw new Error("That is the feed's own address.");
    const mine = userMirrors(feedUrl);
    if (mine.includes(mirror) || meta.get(feedUrl)?.mirrors.includes(mirror)) throw new Error("That mirror is already added.");
    if (mine.length >= MAX_MIRRORS) throw new Error(`Up to ${MAX_MIRRORS} mirrors for a feed. Remove one first.`);
    mirrorStore.set({ ...mirrorStore.get(), [feedUrl]: [...mine, mirror] });
    notify();
  }
  function removeMirror(feedUrl, mirror) {
    const mine = userMirrors(feedUrl);
    if (!mine.includes(mirror)) return;
    const rest = mine.filter((item) => item !== mirror);
    const next = { ...mirrorStore.get() };
    if (rest.length) next[feedUrl] = rest;
    else delete next[feedUrl];
    mirrorStore.set(next);
    notify();
  }
  function forget(url) {
    status.delete(url);
    meta.delete(url);
    if (indexes.delete(url)) indexVersion++;
    try {
      if (FileSystem.exists(cacheFile(url))) FileSystem.remove(cacheFile(url));
    } catch (error2) {
      console.log(`feeds: cache of ${url} not removed: ${error2.message}`);
    }
  }
  function removeFeed(url) {
    feedList.set(feedList.get().filter((item) => item !== url));
    if (url in mirrorStore.get()) {
      const next = { ...mirrorStore.get() };
      delete next[url];
      mirrorStore.set(next);
    }
    forget(url);
    notify();
  }
  // Edits a feed's address in place (the phone's Edit): checked like a new one, kept in its position,
  // and fetched; the old address's cache goes and its mirrors move to the new address. Throws when the
  // new address cannot be used.
  function replaceFeed(from, value) {
    const urls = feedList.get();
    const index = urls.indexOf(from);
    if (index < 0) throw new Error("No such feed.");
    const url = addressOf(value);
    if (url === from) {
      void refreshFeed(url);
      return;
    }
    if (urls.includes(url) || url === LIVE_FEED) throw new Error("That feed is already added.");
    if (isLocalFeed(url)) statLocal(url);
    feedList.set(urls.map((item, at) => at === index ? url : item));
    const mine = isLocalFeed(url) ? [] : userMirrors(from).filter((mirror) => mirror !== url);
    const next = { ...mirrorStore.get() };
    delete next[from];
    if (mine.length) next[url] = mine;
    mirrorStore.set(next);
    forget(from);
    notify();
    void refreshFeed(url);
  }
  // The feeds: address, last good copy (name, games, when), where it came from, its mirrors and refresh
  // state, for Settings and the phone companion alike.
  function feedsSnapshot(urls = feedList.get()) {
    return urls.map((url) => {
      const known = meta.get(url);
      return {
        url,
        // glibren.14: a file on the console (`url` is its path); `fetchedAt` is when it was last read.
        local: isLocalFeed(url),
        name: known?.name ?? null,
        games: known?.games ?? 0,
        fetchedAt: known?.fetchedAt ?? null,
        // The mirrors in order (the player's first) and the address the last good copy came from.
        mirrors: mirrorsOf(url),
        own: userMirrors(url),
        via: known?.from && known.from !== url ? known.from : null,
        // A refresh that brought a different copy (a new feed's first) shows its games after a restart.
        restart: status.get(url)?.changed === true,
        ...status.get(url) ?? (known ? { state: "ok" } : { state: "failed", error: "Not loaded yet." })
      };
    });
  }
  // The games each feed lists right now, by feed: [[id, direct], …]. `feedIndexVersion` changes whenever
  // that does (a refresh, a mirror answering instead of the feed, a feed removed); `subscribeFeeds` calls
  // back on every change to the feeds or their state.
  var feedIndexes = () => [...indexes.values()];
  var feedIndexVersion = () => indexVersion;
  function subscribeFeeds(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  function useFeeds() {
    const urls = feedList.useList();
    const [, redraw] = (0, useState)(0);
    (0, useEffect)(() => {
      const listener = () => redraw((n) => n + 1);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);
    return feedsSnapshot(urls);
  }

/** glibren.9: a feed's name as its last good copy says (null when none is cached). */
var feedName = (url) => meta.get(url)?.name ?? null;

export { LIVE_FEED, MAX_FEEDS, feedName, MAX_MIRRORS, addFeed, addLocalFeed, addMirror, feedIndexVersion, feedIndexes, feedRatings, feedsSnapshot, loadFeedGames, refreshFeeds, removeFeed, removeMirror, replaceFeed, subscribeFeeds, useFeeds };
