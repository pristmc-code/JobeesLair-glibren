// The app's link health (the checker itself is state/link-health.js): kept in link-health.json, checked on
// the download queue's terms (lendNetwork in the background, quietNetwork when the gamer asks), and asked
// for when someone looks at a game:
//   - its page: SETTLE_MS after it opens (not for a page passed through on the way elsewhere), then every
//     AGAIN_MS while it stays open; only links whose last verdict has run out are asked again (TTL)
//   - its quick preview on a catalog card, once, after the same settle
//   - "Check link health" in its source list, every link at once
// A download that fails with "gone" reports its link too (download-queue.js reportLink).

import { useEffect, useMemo, useState } from 'react';
import { createLinkHealth, onLinkReport, onOutcome } from './link-health.js';
import { createFormatProbe } from './format-probe.js';
import { formatFromName, formatKeyOf, onFormatReport } from './link-formats.js';
import { activeService, heldByTorBox, torBoxFileNames, torBoxFormatNames } from './debrid.js';
import { refreshShared, reportShared, sharedDead, subscribeShared } from './shared-links.js';
import { downloadQueue } from './downloads.js';
import { savedList } from './saved.js';
import { memorySample } from './memory-meter.js';
import { Http } from '@ps5-react/core';

  var SETTLE_MS = 2e3;
  var AGAIN_MS = 15 * 6e4;
  var instance = null;
  function linkHealth() {
    return instance ?? (instance = createLinkHealth({
      http: Http,
      store: savedList("link-health.json", "link health"),
      lend: (onYield) => downloadQueue().lendNetwork?.(onYield) ?? null,
      quiet: (reason, work) => {
        const queue = downloadQueue();
        return queue.quietNetwork ? queue.quietNetwork(reason, work) : work();
      },
      sharedDead
    }));
  }
  onLinkReport((url, message) => linkHealth().report(url, message));
  // 0.5.5: dead links other players found (state/shared-links.js), and this console's downloads told to them.
  subscribeShared(() => linkHealth().sharedChanged());
  onOutcome((link, ok) => reportShared(link, ok));
  /** Fetches the shared dead links once; the app calls it a while after launch. */
  var startSharedLinks = () => void refreshShared();
  // Asks for `key`'s links to be checked in the background (`releases` read when the time comes), again
  // every AGAIN_MS when `repeat`. Returns the function that stops it.
  function watchLinks(key, releases, { settleMs = SETTLE_MS, repeat = true } = {}) {
    let timer = setTimeout(function tick() {
      try {
        linkHealth().want(key, releases());
      } catch (error) {
        console.log(`[links] ${key}: ${error.message}`);
      }
      timer = repeat ? setTimeout(tick, AGAIN_MS) : null;
    }, settleMs);
    return () => {
      if (timer !== null) clearTimeout(timer);
      linkHealth().drop(key);
    };
  }
  /** Checks a game's links while `game` is shown (its page, or a quick preview with `repeat: false`). */
  function useLinkWatch(key, game, options) {
    (0, useEffect)(() => game ? watchLinks(key, () => game.releases || [], options) : void 0, [key]);
  }
  /** `releases` with what is known of their links (link-health.js overlay); re-renders when that changes. */
  function useHealthyReleases(releases) {
    const health = linkHealth();
    const [, setVersion] = (0, useState)(health.version);
    (0, useEffect)(() => health.subscribe(setVersion), []);
    return health.overlay(releases);
  }
  /** How the check of `key`'s links stands (link-health.js progressOf), updated as it goes. */
  function useLinkCheck(key) {
    const health = linkHealth();
    const [progress, setProgress] = (0, useState)(() => health.progressOf(key));
    (0, useEffect)(() => {
      setProgress(health.progressOf(key));
      return health.subscribe(() => setProgress(health.progressOf(key)));
    }, [key]);
    return progress;
  }
  /** Checks every link of `releases` now; resolves with the counts (or null). */
  var checkLinksNow = (key, releases) => linkHealth().checkNow(key, releases);
  // glibren: "Find formats" (state/format-probe.js), kept in link-formats.json, on the same terms as a check the
  // gamer asks for (quietNetwork); with a TorBox key, TorBox's cached items' file names are asked first.
  var formats = null;
  function linkFormats() {
    return formats ?? (formats = createFormatProbe({
      http: Http,
      store: savedList("link-formats.json", "link formats"),
      quiet: (reason, work) => {
        const queue = downloadQueue();
        return queue.quietNetwork ? queue.quietNetwork(reason, work) : work();
      },
      torbox: (links) => torBoxFileNames(links),
      debridOn: () => Boolean(activeService())
    }));
  }
  // A download's first bytes name its format (download-queue.js reportFormat): kept for the source list too.
  onFormatReport((release, format) => linkFormats().report(release, format));
  /** The saved formats' reader (link-formats.js effectiveFormat), re-rendering when one is found. */
  function useLinkFormats() {
    const probe = linkFormats();
    const [version, setVersion] = (0, useState)(probe.version);
    (0, useEffect)(() => probe.subscribe(setVersion), []);
    return { recordOf: probe.recordOf, version };
  }
  /** How "Find formats" of `key` stands (format-probe.js progressOf), updated as it goes. */
  function useFormatSearch(key) {
    const probe = linkFormats();
    const [progress, setProgress] = (0, useState)(() => probe.progressOf(key));
    (0, useEffect)(() => {
      setProgress(probe.progressOf(key));
      return probe.subscribe(() => setProgress(probe.progressOf(key)));
    }, [key]);
    return progress;
  }
  // glibren (medidor de memoria): mede no fim (state/memory-meter.js); o que discover devolve passa como veio.
  function findFormatsNow(key, releases) {
    memorySample("descobrir-formatos:inicio");
    const done = () => memorySample("descobrir-formatos");
    const result = linkFormats().discover(key, releases);
    if (result && typeof result.then === "function") result.then(done, done);
    else done();
    return result;
  }
  /** What a game's links are known to be now (format-probe.js summaryOf), re-read when a format is found. */
  function useFormatSummary(releases) {
    const { version } = useLinkFormats();
    return (0, useMemo)(() => linkFormats().summaryOf(releases), [releases, version]);
  }
  // glibren: "Find via the browser": the gamer passes a host's check in the console's browser, the file link is
  // captured (download-queue.js captureFileLink) and only the file's name or first bytes read; nothing is
  // downloaded. One link at a time. Per link: { state: "capturing" | "failed", reason }, kept until the list
  // closes or another starts; a format found shows in the row's name (link-formats.json).
  var browserFinds = /* @__PURE__ */ new Map();
  var browserVersion = 0;
  var browserListeners = /* @__PURE__ */ new Set();
  function setBrowserFind(key, value) {
    if (value) browserFinds.set(key, value);
    else browserFinds.delete(key);
    browserVersion++;
    for (const listener of [...browserListeners]) listener(browserVersion);
  }
  /** (release) -> its "Find via the browser" state, or null; re-renders as it changes. */
  function useBrowserFinds() {
    const [, setVersion] = (0, useState)(browserVersion);
    (0, useEffect)(() => {
      browserListeners.add(setVersion);
      return () => browserListeners.delete(setVersion);
    }, []);
    return (release) => browserFinds.get(formatKeyOf(release)) ?? null;
  }
  var findingViaBrowser = () => [...browserFinds.values()].some((find) => find.state === "capturing");
  async function findViaBrowser(release, game) {
    const key = formatKeyOf(release);
    if (!key || findingViaBrowser()) return null;
    setBrowserFind(key, { state: "capturing" });
    try {
      const queue = downloadQueue();
      if (!queue.captureFileLink) throw Object.assign(new Error("no capture"), { console: true });
      const captured = await queue.captureFileLink(release, game);
      const format = await linkFormats().learn(release, captured);
      setBrowserFind(key, format ? null : { state: "failed", reason: "unread" });
      return format;
    } catch (error) {
      setBrowserFind(key, error?.stopped ? null : { state: "failed", reason: error?.console ? "console" : error?.message || "" });
      return null;
    }
  }
  // glibren: when a source list opens, the links TorBox holds already ("Instant") with no format are asked of it at
  // once (checkcached list_files: nothing added to the account), so their rows say "exFAT image" without a press.
  function askTorBoxFormats(releases) {
    if (activeService() !== "torbox") return Promise.resolve(0);
    const held = new Set((releases || []).filter((release) => heldByTorBox(release) === true).map(formatKeyOf).filter(Boolean));
    return held.size ? linkFormats().askTorBox(releases, (key) => held.has(key)) : Promise.resolve(0);
  }
  // glibren: "Find via TorBox": a link TorBox takes but does not hold, added to the account only to read its files'
  // names and removed right after (debrid.js torBoxFormatNames). Nothing is downloaded. One at a time, cancellable.
  var torBoxStop = null;
  async function findViaTorBox(release) {
    const key = formatKeyOf(release);
    if (!key || findingViaBrowser()) return null;
    const aborts = /* @__PURE__ */ new Set();
    const signal = { aborted: false, addEventListener: (type, fn) => type === "abort" && aborts.add(fn), removeEventListener: (type, fn) => aborts.delete(fn) };
    torBoxStop = () => {
      signal.aborted = true;
      for (const fn of [...aborts]) fn();
    };
    setBrowserFind(key, { state: "capturing", via: "torbox" });
    try {
      const { names, removed } = await torBoxFormatNames(release, { signal });
      let format = null;
      for (const name of names || []) {
        if (!formatFromName(name)) continue;
        format = await linkFormats().learn(release, { name });
        if (format) break;
      }
      if (!removed) console.log(`[formats] TorBox: the request for ${key.slice(0, 60)} stayed in the account (it was there before, or TorBox did not remove it)`);
      setBrowserFind(key, format ? null : { state: "failed", reason: "unread" });
      return format;
    } catch (error) {
      const stopped = signal.aborted || error?.name === "AbortError";
      setBrowserFind(key, stopped ? null : { state: "failed", reason: error?.message || "" });
      return null;
    } finally {
      torBoxStop = null;
    }
  }
  function cancelFindViaBrowser() {
    if (torBoxStop) {
      torBoxStop();
      return;
    }
    try {
      downloadQueue().cancelFileLinkCapture?.();
    } catch {
    }
  }
  var cancelFindFormats = (key) => linkFormats().cancel(key);

export { askTorBoxFormats, cancelFindFormats, cancelFindViaBrowser, checkLinksNow, findFormatsNow, findViaBrowser, findViaTorBox, findingViaBrowser, linkFormats, useBrowserFinds, useFormatSummary, linkHealth, startSharedLinks, useFormatSearch, useHealthyReleases, useLinkCheck, useLinkFormats, useLinkWatch, watchLinks };
