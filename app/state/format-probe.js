// "Find formats" (glibren fork): the format of each of a game's links that nothing names yet, found without
// downloading the file, then saved (state/link-formats.js effectiveFormat reads it). The wiring (the network,
// the saved file) is state/links.js.
//
// It keeps link health's terms (state/link-health.js): the runtime runs one network task at a time, so a run
// the gamer asks for pauses the download in progress (`quiet`, the queue's quietNetwork) and gives it back
// when done; requests go one at a time, spaced per host, a host that answers 429 is left alone for the rest
// of the run (and a while after, Retry-After or longer), and the run is bounded in links and in time.
//
// What is asked, per link:
//   file link    HEAD: Content-Disposition's file name, Content-Type, the URL it ends on. Undecided, its first
//                64 bytes (a Range request, `binary: true`, redirects followed by hand, as download-queue.js
//                rangeOf does) and their signature. A server that ignores Range answers past maxBytes: the
//                request fails and nothing is learned.
//   host page    a GET of the page only (text, bounded) and the file name on it (link-formats.js
//                readHostPage). Never a captcha, never the file behind the page.
//   TorBox       with a key: which links TorBox holds already, with their files' names (checkcached,
//                list_files), first and in one call per hundred links. Nothing is added to the account.
//   the rest     a host that needs the console's browser, with no page reader: not asked; recorded as such.
//                glibren: recorded with whether a debrid key was set; a key added since asks TorBox again.
  // A link the gamer passes the browser's check for ("Find via the browser", state/links.js) is learned too
  // (learn): the captured file's name, else its first bytes; nothing is downloaded.

import { BYTES_ASKED, FORMAT_GROUP, UFS_MAGIC_AT, formatFromContentType, formatFromDisposition, formatFromMagic, formatFromName, formatFromUfsMagic, formatKeyOf, effectiveFormat, pageReaderOf, readHostPage } from './link-formats.js';
import { sourceKind, webURL } from './download-sources.js';

  var MINUTE = 6e4;
  var DAY = 24 * 60 * MINUTE;
  // A file's format does not change: a found one stands half a year; "needs the browser", a week.
  var TTL = { found: 180 * DAY, download: 365 * DAY, browser: 7 * DAY };
  var REQUEST_MS = 15e3;
  var HOST_GAP_MS = 750;
  var COOL_MS = 5 * MINUTE;
  var RETRY_AFTER_MAX_MS = MINUTE;
  var RUN_LINKS = 48;
  var RUN_MS = 9e4;
  var PAGE_BYTES = 4 * 1024 * 1024;
  var KEPT = 4e3;
  var SAVE_MS = 2e3;
  var stopped = () => Object.assign(new Error("Format search stopped."), { stopped: true });
  // The links of `releases` whose format nothing names yet (a guess from an archive password included), one
  // per release: its first source (a set's first part names the set's kind).
  function unknownLinks(releases, recordOf, debridOn = () => false) {
    const seen = /* @__PURE__ */ new Set();
    const links = [];
    for (const release of releases || []) {
      if (!release || release.unavailableReason) continue;
      const known = effectiveFormat(release, recordOf);
      // Known, or found a short while ago to need the browser (TTL.browser): not asked again yet, unless a
      // debrid key came since that answer (TorBox may hold the file).
      if (known.format && known.how !== "password") continue;
      const key = formatKeyOf(release);
      if (known.how === "browser" && !(debridOn() && key && !recordOf(key)?.debrid)) continue;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const first = release.parts?.[0]?.sources?.[0] ?? release;
      let kind = "unavailable";
      let host = "";
      try {
        kind = sourceKind(first);
        if (kind !== "torrent") host = webURL(key).host;
      } catch {
      }
      links.push({ key, host, kind, reader: pageReaderOf(key), browser: Boolean(first.requiresBrowser), fileURL: first.url || null });
    }
    return links;
  }
  function createFormatProbe({
    http,
    store,
    quiet = (reason, work) => work(),
    // (links) -> Promise<Map<link, string[]>> | null: TorBox's cached items' file names (state/debrid.js).
    torbox = () => null,
    // Whether a debrid key is set now (state/debrid.js activeService): kept with a "needs the browser" answer.
    debridOn = () => false,
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeout = (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    log = (line) => console.log(`[formats] ${line}`)
  }) {
    let records = null;
    let version = 0;
    let saving = false;
    const listeners = /* @__PURE__ */ new Set();
    const lastAsked = /* @__PURE__ */ new Map();
    const cooled = /* @__PURE__ */ new Map();
    const progress = /* @__PURE__ */ new Map();
    let running = null;
    function load() {
      if (records) return records;
      const saved = store.get();
      records = saved?.version === 1 && saved.links && typeof saved.links === "object" ? { ...saved.links } : {};
      return records;
    }
    // A record past its time is as good as none.
    function recordOf(key) {
      const record = load()[key];
      if (!record) return null;
      const kind = record.f ? record.how === "download" ? "download" : "found" : record.s;
      return now() - (record.at || 0) < (TTL[kind] ?? 0) ? record : null;
    }
    function emit() {
      version++;
      for (const listener of [...listeners]) {
        try {
          listener(version);
        } catch (error) {
          log(`listener failed: ${error.message}`);
        }
      }
    }
    function save() {
      saving = false;
      const keys = Object.keys(records);
      if (keys.length > KEPT) for (const key of keys.sort((a, b) => records[a].at - records[b].at).slice(0, keys.length - KEPT)) delete records[key];
      store.set({ version: 1, links: records });
    }
    function saveSoon() {
      if (saving) return;
      saving = true;
      wait(SAVE_MS).then(save, save);
    }
    function remember(key, record) {
      load()[key] = { ...record, at: now() };
      saveSoon();
      emit();
    }
    const setProgress = (key, next) => {
      progress.set(key, { ...progress.get(key), ...next });
      emit();
    };
    async function pause(run, ms) {
      if (ms > 0) await Promise.race([wait(ms), run.stopping]);
      if (run.stop) throw stopped();
    }
    // One request under the run's rules: spaced from the last one to its host, bounded in time, cut short by a
    // cancel. Resolves with the response, or { failed } when the transport gave up.
    async function ask(run, host, url, options) {
      await pause(run, (lastAsked.get(host) ?? -Infinity) + HOST_GAP_MS - now());
      lastAsked.set(host, now());
      const aborts = /* @__PURE__ */ new Set();
      const signal = { aborted: false, addEventListener: (type, fn) => type === "abort" && aborts.add(fn), removeEventListener: (type, fn) => aborts.delete(fn) };
      const abort = () => {
        signal.aborted = true;
        for (const fn of [...aborts]) fn();
      };
      run.abort = abort;
      let timedOut = false;
      const cancel = timeout(() => {
        timedOut = true;
        abort();
      }, REQUEST_MS);
      try {
        return await http.request(url, { ...options, signal });
      } catch (error) {
        if (run.stop) throw stopped();
        return { failed: timedOut ? "timeout" : error?.message || "network" };
      } finally {
        cancel();
        run.abort = null;
      }
    }
    // 429: the host is left alone for the rest of the run and a while after.
    function limited(host, response) {
      if (response?.status !== 429) return false;
      const seconds = Number(response.headers?.["retry-after"]);
      const ms = Math.max(Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1e3, RETRY_AFTER_MAX_MS) : 0, COOL_MS);
      cooled.set(host, now() + ms);
      log(`${host} asked us to slow down: no format checks there for ${Math.round(ms / 1e3)} s`);
      return true;
    }
    const cooling = (host) => (cooled.get(host) ?? 0) > now();
    // The first bytes of a file link: a Range of BYTES_ASKED, redirects followed by hand (a request with
    // headers follows none by itself), up to five.
    async function firstBytes(run, link, url) {
      let target = url;
      for (let hops = 0; hops <= 5; hops++) {
        const response = await ask(run, link.host, target, { method: "GET", headers: { Range: `bytes=0-${BYTES_ASKED - 1}` }, binary: true, maxBytes: 64 * 1024, followRedirects: false });
        if (response.failed || limited(link.host, response)) return null;
        const location = response.headers?.location;
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          target = location.startsWith("/") && !location.startsWith("//") ? webURL(target).origin + location : location;
          webURL(target);
          continue;
        }
        if (response.status !== 206 && response.status !== 200 || typeof response.bytes !== "function") return null;
        const magic = formatFromMagic(await response.bytes());
        // glibren: nothing at the start, and the host answers ranges: a UFS2 image (.ffpkg) says so 66 KiB in.
        if (magic || response.status !== 206) return magic;
        return ufsMagic(run, link, target);
      }
      return null;
    }
    async function ufsMagic(run, link, url) {
      const response = await ask(run, link.host, url, { method: "GET", headers: { Range: `bytes=${UFS_MAGIC_AT}-${UFS_MAGIC_AT + 3}` }, binary: true, maxBytes: 64 * 1024, followRedirects: false });
      if (response.failed || limited(link.host, response) || response.status !== 206 || typeof response.bytes !== "function") return null;
      return formatFromUfsMagic(await response.bytes());
    }
    // What one link turns out to be: { f } (a format), { s: "browser" }, { s: "gone" } or { s: "none" }.
    async function probe(run, link) {
      if (link.host && cooling(link.host)) return { s: "none", skipped: true };
      if (link.kind === "direct") {
        const head = await ask(run, link.host, link.key, { method: "HEAD", maxBytes: 4096 });
        if (head.failed || limited(link.host, head)) return { s: "none" };
        if (head.status === 404 || head.status === 410) return { s: "gone" };
        if (/(?:text\/html|application\/xhtml)/i.test(head.headers?.["content-type"] || "")) return { s: "none" };
        const named = formatFromDisposition(head.headers?.["content-disposition"]) ?? formatFromName((head.url || "").split(/[?#]/)[0].split("/").pop()) ?? formatFromContentType(head.headers?.["content-type"]);
        if (named) return { f: named };
        if (head.status >= 400) return { s: "none" };
        const magic = await firstBytes(run, link, head.url || link.key);
        return magic ? { f: magic } : { s: "none" };
      }
      if (link.reader) {
        const page = await ask(run, link.host, link.key, { method: "GET", maxBytes: PAGE_BYTES });
        if (page.failed || limited(link.host, page)) return { s: "none" };
        if (page.status === 404 || page.status === 410) return { s: "gone" };
        // A download straight away (the host sent the file, not a page): its name says it.
        const disposition = formatFromDisposition(page.headers?.["content-disposition"]);
        if (disposition) return { f: disposition };
        if (page.status === 401 || page.status === 403) return link.browser ? { s: "browser" } : { s: "none" };
        let html = "";
        try {
          html = await page.text();
        } catch {
        }
        const read = readHostPage(link.reader, html);
        if (read.format) return { f: read.format };
        if (read.gone) return { s: "gone" };
        return read.check || link.browser ? { s: "browser" } : { s: "none" };
      }
      return link.browser || link.kind === "browser" ? { s: "browser" } : { s: "none" };
    }
    async function lookTorBox(run, links) {
      const asked = links.filter((link) => link.kind !== "unavailable").map((link) => link.key);
      if (!asked.length) return /* @__PURE__ */ new Map();
      try {
        const names = await Promise.race([Promise.resolve(torbox(asked)), run.stopping]);
        if (run.stop) throw stopped();
        return names instanceof Map ? names : /* @__PURE__ */ new Map();
      } catch (error) {
        if (error.stopped) throw error;
        log(`TorBox did not list files: ${error.message}`);
        return /* @__PURE__ */ new Map();
      }
    }
    // The format a TorBox item's files say: a lone or the largest named file's (names come largest first).
    function fromNames(names) {
      for (const name of names || []) {
        const format = formatFromName(name);
        if (format) return format;
      }
      return null;
    }
    async function search(key, releases, run) {
      const all = unknownLinks(releases, recordOf, debridOn);
      const links = all.slice(0, RUN_LINKS);
      const summary = { image: 0, pkg: 0, archive: 0, browser: 0, none: all.length - links.length, total: all.length };
      const started = now();
      setProgress(key, { state: "checking", done: 0, total: links.length });
      const count = (format) => summary[FORMAT_GROUP[format]]++;
      const held = await lookTorBox(run, links);
      for (const link of links) {
        if (run.stop) throw stopped();
        let found = null;
        const fromTorBox = fromNames(held.get(link.key));
        if (fromTorBox) found = { f: fromTorBox };
        else if (now() - started > RUN_MS) found = { s: "none", skipped: true };
        else found = await probe(run, link);
        if (found.f) {
          remember(link.key, { f: found.f, how: "found" });
          count(found.f);
        } else {
          if (found.s === "browser") remember(link.key, { s: "browser", debrid: Boolean(debridOn()) });
          summary[found.s === "browser" ? "browser" : "none"]++;
        }
        setProgress(key, { done: progress.get(key).done + 1 });
      }
      return summary;
    }
    return {
      /** The saved, still valid record of a link: { f, how, at } or { s, at }; null when none. */
      recordOf,
      /** The links of `releases` a search would ask about (link-formats.js effectiveFormat names none). */
      unknownLinks: (releases) => unknownLinks(releases, recordOf, debridOn),
      /**
       * What is known now of `releases`' links that a search or a download learned: { image, pkg, archive,
       * browser } (each link once). "Find formats" shows these, so a format found later counts at once.
       */
      summaryOf(releases) {
        const seen = /* @__PURE__ */ new Set();
        const counts = { image: 0, pkg: 0, archive: 0, browser: 0 };
        for (const release of releases || []) {
          if (!release || release.unavailableReason) continue;
          const key = formatKeyOf(release);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const info = effectiveFormat(release, recordOf);
          if ((info.how === "found" || info.how === "download") && FORMAT_GROUP[info.format]) counts[FORMAT_GROUP[info.format]]++;
          else if (info.how === "browser") counts.browser++;
        }
        return counts;
      },
      /**
       * A link captured through the console's browser (state/links.js findViaBrowser): its format from the
       * file's name, else from its first bytes (a Range, as a search asks). Saved as found; resolves with the
       * format or null. Nothing is downloaded.
       */
      async learn(release, { url, name } = {}) {
        const key = formatKeyOf(release);
        if (!key) return null;
        let format = formatFromName(name || "") ?? formatFromName(String(url || "").split(/[?#]/)[0].split("/").pop());
        if (!format && url) {
          let host = "";
          try {
            host = webURL(url).host;
          } catch {
            return null;
          }
          const run = { stop: false, abort: null, stopping: new Promise(() => {
          }) };
          format = await quiet(`find format ${key}`, () => firstBytes(run, { host, key }, url)).catch(() => null);
        }
        if (!format || !FORMAT_GROUP[format]) return null;
        remember(key, { f: format, how: "found" });
        return format;
      },
      /**
       * Finds the formats of `releases`' links now (the gamer asked), under `quiet`: resolves with
       * { image, pkg, archive, browser, none, total }, or null when cancelled or failed.
       */
      discover(key, releases) {
        if (running) return Promise.resolve(null);
        const run = { stop: false, abort: null };
        run.stopping = new Promise((resolve) => {
          run.halt = () => {
            run.stop = true;
            run.abort?.();
            resolve();
          };
        });
        running = { key, run };
        setProgress(key, { state: "waiting", done: 0, total: 0, summary: null });
        return quiet(`find formats ${key}`, () => search(key, releases, run)).then((summary) => {
          setProgress(key, { state: "done", summary, at: now() });
          return summary;
        }, (error) => {
          if (!error?.stopped) log(`search ${key} failed: ${error?.message}`);
          setProgress(key, { state: error?.stopped ? "cancelled" : "failed", at: now() });
          return null;
        }).finally(() => {
          running = null;
          emit();
        });
      },
      /** Stops the search of `key` (what was found stands). */
      cancel(key) {
        if (running?.key === key) running.run.halt();
      },
      busy: () => Boolean(running),
      /** A download's own reading of its first bytes (download-queue.js via link-formats.js reportFormat). */
      report(release, format) {
        const key = formatKeyOf(release);
        if (!key || !FORMAT_GROUP[format] || format === "archive") return;
        const before = load()[key];
        if (before?.f === format && before.how === "download") return;
        remember(key, { f: format, how: "download" });
      },
      /** { state: waiting | checking | done | cancelled | failed, done, total, summary, at } for `key`, or null. */
      progressOf: (key) => progress.get(key) ?? null,
      version: () => version,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      /** Writes what is known now (tests; the app saves by itself). */
      flush: () => records && save()
    };
  }

export { RUN_LINKS, TTL, createFormatProbe, unknownLinks };
