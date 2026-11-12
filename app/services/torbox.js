// TorBox (torbox.app), a debrid service: it fetches a file from a file host or a torrent onto its own
// servers, then hands out a fast direct link to it. This module is its API and nothing else; the app's
// wiring (the saved key, when to ask, the download queue) is state/debrid.js.
//
// Endpoints (https://api.torbox.app/v1/api, docs: api-docs.torbox.app):
//   GET  /user/me                    the account: plan (0 Free, 1 Essential, 2 Pro, 3 Standard) and expiry
//   GET  /webdl/hosters              the file hosts it supports, each with a regex and whether it works now
//   GET  /webdl/checkcached?hash=    which links it already holds (instant); a link's hash is its MD5
//   GET  /torrents/checkcached?hash= which torrents it already holds; a torrent's hash is its info hash
//   POST /webdl/createwebdownload    link=… (form)             -> { webdownload_id, hash }
//   POST /torrents/createtorrent     magnet=… (multipart form) -> { torrent_id, hash }
//   GET  /webdl/mylist?id=, /torrents/mylist?id=   an item's state: progress, download_finished, files
//   POST /webdl/controlwebdownload  {webdl_id, operation: "delete"} (JSON)  removes an item (glibren: after
//   POST /torrents/controltorrent   {torrent_id, operation: "delete"} (JSON)  "Find via TorBox" read its names)
//   GET  /webdl/requestdl, /torrents/requestdl     a direct link to one of its files, open for 3 hours
//                                                  (zip_link=true: a torrent's files as one zip)
//   glibren.6 ("Search TorBox" on a game's page): GET /webdl/mylist, /torrents/mylist without an id (the whole
//   account), checkcached with list_files (the files of what it holds), and the search API's
//   GET https://search-api.torbox.app/torrents/search/<text>?check_cache=true&cached_only=true
// Every call answers { success, error, detail, data }. The key goes in an Authorization header, except
// on requestdl, which only takes it as a `token` query parameter: those URLs are built here, used once and
// never returned, logged or saved, and no error message carries the key.
//
// The runtime's Http (ps5-react docs/NETWORKING.md): string bodies only, 30 s per request, custom headers
// turn off automatic redirects (none of these endpoints redirect). No Date objects anywhere: the console's JS
// engine has only Date.now() (state/clock.js parseStamp reads TorBox's ISO times).

import { parseStamp } from '../state/clock.js';
import { jsonMembers } from '../state/json-scan.js';
import { formatFromName } from '../state/link-formats.js';

  var BASE = "https://api.torbox.app/v1/api";
  // glibren.6: TorBox's search API (torrents by name), a service of its own.
  var SEARCH_BASE = "https://search-api.torbox.app";
  var PLANS = ["free", "essential", "pro", "standard"];
  // glibren.23: 10 minutes (was 6 hours), as Orbit Store reads it: the daily quotas in it change all day.
  var HOSTERS_MS = 10 * 6e4;
  // glibren.23: at most one createwebdownload per CREATE_GAP_MS, and a 429 on it waits at least RATE_WAIT_MS (Orbit Store
  // does the same: TorBox throttles accounts that add links in bursts).
  var CREATE_GAP_MS = 61e3;
  var RATE_WAIT_MS = 6e4;
  var CREATE_TRIES = 3;
  // How long a resolve waits for TorBox to finish fetching a file it did not hold, asking every POLL_MS.
  // A held (cached) file is ready at once; one it has to fetch can take longer than anyone should wait on a
  // console, so past this the resolve stops and says how far TorBox got (resuming asks again).
  var WAIT_MS = 3 * 6e4;
  var POLL_MS = 5e3;
  // TorBox's error codes the gamer can act on, in the words the app shows (everything else: its `detail`).
  var MESSAGES = {
    NO_AUTH: "TorBox needs an API key. Add it in Settings.",
    BAD_TOKEN: "TorBox didn't accept the API key. Check it in Settings.",
    AUTH_ERROR: "TorBox couldn't check the API key. Try again in a moment.",
    UNSUPPORTED_SITE: "TorBox doesn't support this host.",
    INVALID_LINK: "TorBox couldn't read this link.",
    DOWNLOAD_TOO_LARGE: "This file is larger than your TorBox plan allows.",
    ACTIVE_LIMIT: "Your TorBox plan has no free download slot right now.",
    MONTHLY_LIMIT: "Your TorBox plan's monthly limit is used up.",
    COOLDOWN_LIMIT: "Your TorBox plan is in a cooldown. Try again later.",
    TEMPORARILY_DISABLED: "TorBox has this host turned off for now.",
    RATE_LIMITED: "TorBox asked to slow down. Try again in a minute.",
    // 0.5.5 (GitHub issue #2): TorBox's own download server failing for a while, which its `detail` words as a link
    // that may not be online. It is TorBox's side, and the download queue tries again by itself.
    DOWNLOAD_SERVER_ERROR: "TorBox had a server error. Try again in a few minutes."
  };
  // An error from TorBox: `code` is its error code (or HTTP_<status>, NETWORK, PENDING, NO_FILE).
  var TorBoxError = class extends Error {
    constructor(code, message, extra = {}) {
      super(message);
      this.name = "TorBoxError";
      this.code = code;
      Object.assign(this, extra);
    }
  };
  // The key's shape (TorBox hands out UUIDs); anything else is a typing slip, caught before it is sent.
  var validKey = (key) => typeof key === "string" && /^[A-Za-z0-9-]{20,64}$/.test(key);
  var isMagnet = (link) => /^magnet:\?/i.test(link || "");
  // A magnet link's info hash (40 hex, or 32 base32 turned to hex), lower case; null when it has none.
  function magnetHash(magnet) {
    const value = /[?&]xt=urn:btih:([a-z0-9]+)/i.exec(magnet || "")?.[1];
    if (!value) return null;
    if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
    if (!/^[a-z2-7]{32}$/i.test(value)) return null;
    let bits = "";
    for (const char of value.toUpperCase()) bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char).toString(2).padStart(5, "0");
    return bits.match(/.{4}/g).map((nibble) => parseInt(nibble, 2).toString(16)).join("");
  }

  // MD5 of a UTF-8 string, lower-case hex (RFC 1321): a web download's hash on TorBox.
  var SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  var SINES = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  function utf8(text) {
    const bytes = [];
    for (const char of String(text)) {
      const code = char.codePointAt(0);
      if (code < 128) bytes.push(code);
      else if (code < 2048) bytes.push(192 | code >> 6, 128 | code & 63);
      else if (code < 65536) bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
      else bytes.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
    }
    return bytes;
  }
  function md5(text) {
    const bytes = utf8(text);
    const bitLength = bytes.length * 8;
    bytes.push(128);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 0; i < 8; i++) bytes.push(i < 4 ? bitLength >>> 8 * i & 255 : Math.floor(bitLength / 2 ** (8 * i)) & 255);
    let [a0, b0, c0, d0] = [1732584193, 4023233417, 2562383102, 271733878];
    for (let offset = 0; offset < bytes.length; offset += 64) {
      const words = Array.from({ length: 16 }, (_, i) => bytes[offset + i * 4] | bytes[offset + i * 4 + 1] << 8 | bytes[offset + i * 4 + 2] << 16 | bytes[offset + i * 4 + 3] << 24);
      let [a, b, c, d] = [a0, b0, c0, d0];
      for (let i = 0; i < 64; i++) {
        const round = i >> 4;
        const f = round === 0 ? b & c | ~b & d : round === 1 ? d & b | ~d & c : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
        const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : 7 * i % 16;
        const sum = a + f + SINES[i] + words[g] | 0;
        const shift = SHIFTS[round * 4 + i % 4];
        [a, d, c] = [d, c, b];
        b = b + (sum << shift | sum >>> 32 - shift) | 0;
      }
      [a0, b0, c0, d0] = [a0 + a | 0, b0 + b | 0, c0 + c | 0, d0 + d | 0];
    }
    return [a0, b0, c0, d0].map((word) => Array.from({ length: 4 }, (_, i) => (word >>> 8 * i & 255).toString(16).padStart(2, "0")).join("")).join("");
  }
  // The hashes TorBox may know a link by: the link as it is, and without its query (its own normalization).
  // MODIFIED (glibren.6): without its query only when a path is left after the host. A 1fichier link is all query
  // (https://1fichier.com/?f7gu1n...), and the bare host's hash answered for every 1fichier file TorBox holds
  // (19,194 entries, 9 MB, on 2026-11-05): past the 4 MB answer limit, so the whole check failed, and any 1fichier
  // link in it read as held by TorBox.
  var linkHashes = (link) => {
    const bare = String(link).split(/[?#]/)[0];
    return [...new Set([md5(link), .../^[a-z][a-z0-9+.-]*:\/\/[^/]+\/./i.test(bare) ? [md5(bare)] : []])];
  };
  var query = (params) => Object.entries(params).filter(([, value]) => value !== void 0 && value !== null).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");
  var sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("Stopped."), { name: "AbortError" }));
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", stop);
    };
    const stop = () => {
      done();
      reject(Object.assign(new Error("Stopped."), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", stop);
  });
  /** glibren: an item's (or checkcached entry's) file names, the largest first, then its own name. */
  // glibren.29: `limit`: so os `limit` maiores (cachedFiles guarda NAMES_KEPT por link, nao os milhares de um dump).
  function fileNamesOf(entry, limit = Infinity) {
    if (!entry || typeof entry !== "object") return [];
    const files = Array.isArray(entry.files) ? [...entry.files].sort((a, b) => (Number(b?.size) || 0) - (Number(a?.size) || 0)).slice(0, limit).map((file) => file?.short_name || file?.name) : [];
    return [...files, entry.name].filter((name) => typeof name === "string" && name);
  }
  // glibren.29: checkcached com list_files. No PS5 (glibren.28, lista Orbit Store ligada: heap perto do limite de 32 MiB)
  // "Find formats" fechou o app logo depois de /webdl/hosters: 100 hashes por chamada (ate 4 MiB de texto; um dump de
  // pasta lista milhares de arquivos por link), o JSON.parse da resposta inteira ao lado do texto, a copia ordenada de
  // cada lista e, em cachedFiles, todos os nomes de todos os links guardados ate o fim. Agora: LIST_GROUP hashes por
  // chamada (10: no qjs com 20 MB ja ocupados, 30 links com dumps de 2000 arquivos subiam o pico de +14 MB para +3,8 MB),
  // a resposta lida uma entrada por vez (state/json-scan.js; o texto sai de cena ao fim da chamada), de cada
  // arquivo so nome, tamanho e id (cachedFile), e de cada link so os NAMES_KEPT maiores nomes (cachedFiles).
  var LIST_GROUP = 10;
  var NAMES_KEPT = 32;
  var cachedFile = (file) => {
    const kept = { name: file.name, size: Number(file.size) || 0 };
    if (file.id !== void 0 && file.id !== null) kept.id = file.id;
    if (file.short_name && file.short_name !== file.name) kept.short_name = file.short_name;
    return kept;
  };
  // glibren.29: o maximo de arquivos guardados de uma entrada (um dump de pasta lista milhares; quem usa a lista quer as
  // linhas que valem: torbox-search.js worthShowing = um formato no nome ou >= ENTRY_SMALL; a Biblioteca guarda 40).
  var ENTRY_FILES = 100;
  var ENTRY_SMALL = 1e6;
  var BACKPORT_PATH = (path) => /(?:^|\/)backports?\//i.test(path) || /backport/i.test(path) && /\.(?:bin|prx|sprx)$/i.test(path);
  var baseOf = (name) => String(name || "").replace(/^.*[\\/]/, "");
  /**
   * glibren.29: uma entrada do checkcached como o app a usa: { name, size, files: [{ name, size, id?, short_name? }] }, e
   * so os arquivos que valem: os de nome com formato (imagem, pacote, compactado e suas partes) primeiro, depois os
   * maiores, ate ENTRY_FILES, na ordem original; sem nenhum que valha, o maior. O que fica de fora vira resumo: `total`
   * (quantos arquivos a entrada lista; a linha "All" de torbox-search.js rowsOf) e `backport` ({ path, count, size }:
   * a linha da pasta de backport), so quando algo foi cortado.
   */
  function cachedEntry(entry) {
    const raw = Array.isArray(entry.files) ? entry.files.filter((file) => file && typeof file === "object") : [];
    const out = { name: entry.name || "", size: Number(entry.size) || 0, files: [] };
    if (!raw.length) return out;
    const worth = [];
    let backport = null, largest = -1;
    for (let i = 0; i < raw.length; i++) {
      const file = raw[i];
      const size = Number(file.size) || 0;
      if (largest < 0 || size > (Number(raw[largest].size) || 0)) largest = i;
      const path = String(file.name || file.short_name || "");
      if (BACKPORT_PATH(path)) {
        if (!backport) backport = { path, count: 0, size: 0, first: i };
        backport.count++;
        backport.size += size;
        continue;
      }
      const named = Boolean(formatFromName(baseOf(file.short_name || file.name)));
      if (named || size >= ENTRY_SMALL) worth.push({ i, named, size });
    }
    const kept = worth.sort((a, b) => Number(b.named) - Number(a.named) || b.size - a.size).slice(0, ENTRY_FILES).map((item) => item.i);
    if (backport) kept.push(backport.first);
    if (!worth.length && !kept.includes(largest)) kept.push(largest);
    kept.sort((a, b) => a - b);
    out.files = kept.map((i) => cachedFile(raw[i]));
    if (out.files.length < raw.length) {
      out.total = raw.length;
      if (backport && backport.count > 1) out.backport = { path: backport.path, count: backport.count, size: backport.size };
    }
    return out;
  }
  /**
   * glibren.29: { success, error, detail, data } de uma resposta do TorBox lida do texto sem a arvore inteira: cada membro
   * de `data` passa por `each(chave, valor)` um por vez (JSON.parse so dele), e so quando success e true; `data` volta
   * null. Um texto que nao e JSON: null.
   */
  function scanAnswer(text, each) {
    const answer = { success: false, error: null, detail: null, data: null };
    let data = null;
    try {
      for (const member of jsonMembers(text)) {
        if (member.key === "data") data = member;
        else if (member.key === "success" || member.key === "error" || member.key === "detail") answer[member.key] = JSON.parse(text.slice(member.start, member.end));
      }
      if (!data) return answer;
      if (!answer.success) {
        answer.data = JSON.parse(text.slice(data.start, data.end));
        return answer;
      }
      const open = text.charCodeAt(data.start);
      if (open === 123) {
        for (const member of jsonMembers(text, data.start, data.end)) each(member.key, JSON.parse(text.slice(member.start, member.end)));
      } else if (open === 91) {
        const list = JSON.parse(text.slice(data.start, data.end));
        for (const item of list) if (item && typeof item === "object" && item.hash) each(String(item.hash), item);
      }
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    return answer;
  }
  // The file of an item to download: the one named like the release's file, else the largest.
  function pickFile(files, wanted) {
    const list = (files || []).filter((file) => file && file.id !== void 0);
    if (!list.length) return null;
    const stem = (name) => String(name || "").toLowerCase().replace(/^.*\//, "");
    return list.find((file) => wanted && [file.name, file.short_name].map(stem).includes(stem(wanted))) ?? list.reduce((best, file) => (file.size || 0) > (best.size || 0) ? file : best);
  }
  // Which of a torrent's files to download (0.5.1): the one named like the release's file; a lone file; the
  // largest when the rest is small change beside it (a game image with its text files); otherwise all of
  // them as one zip (a folder dump of many files: the queue extracts it like any archive).
  var ZIP_BELOW = 0.9;
  function chooseFiles(files, wanted) {
    const list = (files || []).filter((file) => file && file.id !== void 0);
    if (!list.length) return null;
    const stem = (name) => String(name || "").toLowerCase().replace(/^.*\//, "");
    const named = wanted ? list.find((file) => [file.name, file.short_name].map(stem).includes(stem(wanted))) : null;
    if (named) return { file: named };
    if (list.length === 1) return { file: list[0] };
    const total = list.reduce((sum, file) => sum + (file.size || 0), 0);
    const largest = list.reduce((best, file) => (file.size || 0) > (best.size || 0) ? file : best);
    return total > 0 && (largest.size || 0) >= total * ZIP_BELOW ? { file: largest } : { zip: true };
  }
  var finished = (item) => Boolean(item?.download_finished && item.download_present !== false);
  // glibren.26: myList em paginas (TorBox mylist: offset e limit), ate os 1000 itens que ele sempre pediu.
  var MYLIST_PAGE = 250, MYLIST_MAX = 1e3;
  // Um item da conta como o app o usa (state/torbox-search.js filesOf, state/torbox-library.js indexAccount).
  var accountItem = (item) => ({
    id: item.id,
    name: item.name,
    hash: item.hash,
    size: item.size,
    download_state: item.download_state,
    download_finished: item.download_finished,
    download_present: item.download_present,
    progress: item.progress,
    files: Array.isArray(item.files) ? item.files.map((file) => ({ id: file?.id, name: file?.name, short_name: file?.short_name, size: file?.size })) : []
  });
  var failed = (item) => /error|fail|stalled|dead/i.test(item?.download_state || "") && !finished(item);

  /**
   * TorBox's API for one account. `key()` reads the API key (empty: not set up); `http` is the runtime's
   * Http (request(url, options) -> { status, ok, json() }); `wait(ms, signal)` pauses between polls.
   */
  function createTorBox({ http, key, wait = sleep, now = Date.now, log = () => {}, createGapMs = CREATE_GAP_MS, rateWaitMs = RATE_WAIT_MS }) {
    let hosterList = null;
    // glibren.23: when the next createwebdownload may go (CREATE_GAP_MS after the last one).
    let nextCreate = 0;
    const secret = () => {
      const value = String(key() || "").trim();
      if (!value) throw new TorBoxError("NO_AUTH", MESSAGES.NO_AUTH);
      if (!validKey(value)) throw new TorBoxError("BAD_TOKEN", MESSAGES.BAD_TOKEN);
      return value;
    };
    // Whatever a failure says, never the key (a transport error can quote the URL it was asked for).
    const scrub = (message, value) => value ? String(message).split(value).join("…") : String(message);
    // glibren.29: `each(chave, valor)`: os membros de `data` um por vez (scanAnswer), sem a resposta inteira na memoria.
    async function call(path, { method = "GET", params, form, multipart, json, signal, token = false, auth = true, base = BASE, each = null } = {}) {
      const value = auth || token ? secret() : null;
      const url = `${base}${path}${params || token ? `?${query({ ...token ? { token: value } : {}, ...params })}` : ""}`;
      const headers = {};
      if (auth && !token) headers.Authorization = `Bearer ${value}`;
      let body;
      if (form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = query(form);
      } else if (json) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(json);
      } else if (multipart) {
        const boundary = `----JobeesLair${now().toString(16)}`;
        headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
        body = Object.entries(multipart).filter(([, field]) => field !== void 0 && field !== null).map(([name, field]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${field}\r\n`).join("") + `--${boundary}--\r\n`;
      }
      let response;
      const started = now();
      try {
        response = await http.request(url, { method, headers, body, signal, maxBytes: 4 * 1024 * 1024 });
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        log(`${method} ${path} failed after ${now() - started} ms: ${scrub(error?.message || error, value)}`);
        throw new TorBoxError("NETWORK", `TorBox didn't answer: ${scrub(error?.message || error, value)}`);
      }
      log(`${method} ${path} -> HTTP ${response.status} in ${now() - started} ms`);
      if (response.status === 429) throw new TorBoxError("RATE_LIMITED", MESSAGES.RATE_LIMITED);
      let answer = null;
      if (each && typeof response.text === "function") {
        let text = null;
        try {
          text = await response.text();
        } catch {
        }
        response = { status: response.status };
        answer = typeof text === "string" ? scanAnswer(text, each) : null;
        text = null;
      } else {
        try {
          answer = await response.json();
        } catch {
        }
        if (each && answer?.success && answer.data && typeof answer.data === "object") {
          const data = answer.data;
          answer = { ...answer, data: null };
          if (Array.isArray(data)) {
            for (const item of data) if (item && typeof item === "object" && item.hash) each(String(item.hash), item);
          } else for (const [hash, entry] of Object.entries(data)) each(hash, entry);
        }
      }
      // 0.5.2: a page instead of an answer, on a redirect or a server error, is TorBox having trouble (on 2026-10-25 every
      // request got a 307 for a while, then a 502): it says so, rather than a bare status.
      const trouble = response.status >= 500 || response.status >= 300 && response.status < 400;
      if (!answer || typeof answer !== "object") throw new TorBoxError(`HTTP_${response.status}`, trouble ? `TorBox isn't answering right now (HTTP ${response.status}). Try again in a few minutes.` : `TorBox answered HTTP ${response.status}.`);
      if (!answer.success) {
        const code = answer.error || `HTTP_${response.status}`;
        log(`${method} ${path} refused: ${code}`);
        throw new TorBoxError(code, MESSAGES[code] || scrub(answer.detail || `TorBox: ${code}.`, value), { data: answer.data ?? null });
      }
      return answer.data;
    }
    const api = {
      /** The account, without anything personal: { plan, planName, premium, expiresAt, cooldownUntil }. */
      async me({ signal } = {}) {
        const data = await call("/user/me", { signal });
        const plan = Number(data?.plan) || 0;
        const expiresAt = data?.premium_expires_at || null;
        return {
          plan,
          planName: PLANS[plan] ?? "unknown",
          premium: plan > 0 && (!expiresAt || (parseStamp(expiresAt) ?? Infinity) > now()),
          expiresAt,
          cooldownUntil: data?.cooldown_until || null
        };
      },
      /** The hosts TorBox can fetch from: [{ name, domains, working, regex }], kept for six hours. */
      async hosters({ signal, fresh = false } = {}) {
        if (!fresh && hosterList && now() - hosterList.at < HOSTERS_MS) return hosterList.list;
        const data = await call("/webdl/hosters", { signal });
        // glibren.23: with each host's daily quota (links and bytes; 0 = no limit), as /webdl/hosters gives it.
        const count = (value) => Math.max(0, Number(value) || 0);
        const list = (Array.isArray(data) ? data : []).map((host) => ({
          name: host.name,
          domains: host.domains || [],
          working: host.status !== false,
          regex: host.regex || null,
          linkLimit: count(host.daily_link_limit),
          linkUsed: count(host.daily_link_used),
          bytesLimit: count(host.daily_bandwidth_limit),
          bytesUsed: count(host.daily_bandwidth_used)
        }));
        hosterList = { at: now(), list };
        return list;
      },
      /** Which of `hashes` (torrent info hashes) TorBox holds: a Set of them, lower case. */
      async checkCached(hashes, { signal } = {}) {
        const wanted = [...new Set(hashes.map((hash) => String(hash).toLowerCase()))].filter(Boolean);
        const held = /* @__PURE__ */ new Set();
        for (let i = 0; i < wanted.length; i += 100) {
          const data = await call("/torrents/checkcached", { params: { hash: wanted.slice(i, i + 100).join(","), format: "object" }, signal });
          for (const hash of Object.keys(data || {})) held.add(hash.toLowerCase());
        }
        return held;
      },
      /** Which of `links` (file host URLs, or magnets) TorBox holds already: a Set of those links. */
      async checkCachedLinks(links, { signal } = {}) {
        const magnets = links.filter(isMagnet);
        const web = links.filter((link) => !isMagnet(link));
        const held = /* @__PURE__ */ new Set();
        const byHash = new Map(web.flatMap((link) => linkHashes(link).map((hash) => [hash, link])));
        const hashes = [...byHash.keys()];
        for (let i = 0; i < hashes.length; i += 100) {
          const data = await call("/webdl/checkcached", { params: { hash: hashes.slice(i, i + 100).join(","), format: "object" }, signal });
          for (const hash of Object.keys(data || {})) if (byHash.has(hash.toLowerCase())) held.add(byHash.get(hash.toLowerCase()));
        }
        if (magnets.length) {
          const torrents = await api.checkCached(magnets.map(magnetHash).filter(Boolean), { signal });
          for (const magnet of magnets) if (torrents.has(magnetHash(magnet))) held.add(magnet);
        }
        return held;
      },
      /**
       * glibren: the file names of the `links` TorBox holds already (checkcached with list_files=true), largest
       * first: a Map of link -> names. Asking adds nothing to the account and spends no quota. list_files is
       * documented for torrents; a web download's answer may carry only the item's `name`, or nothing more,
       * and both are taken as they come.
       */
      async cachedFiles(links, { signal } = {}) {
        const found = /* @__PURE__ */ new Map();
        // glibren.29: LIST_GROUP hashes por chamada, a resposta lida uma entrada por vez e so os NAMES_KEPT maiores nomes.
        const ask = async (path, byHash) => {
          const hashes = [...byHash.keys()];
          for (let i = 0; i < hashes.length; i += LIST_GROUP) {
            await call(path, { params: { hash: hashes.slice(i, i + LIST_GROUP).join(","), format: "object", list_files: true }, signal, each: (hash, entry) => {
              const link = byHash.get(hash.toLowerCase());
              if (!link || found.has(link)) return;
              const names = fileNamesOf(entry, NAMES_KEPT);
              if (names.length) found.set(link, names);
            } });
          }
        };
        const web = links.filter((link) => !isMagnet(link));
        await ask("/webdl/checkcached", new Map(web.flatMap((link) => linkHashes(link).map((hash) => [hash, link]))));
        const magnets = links.filter(isMagnet).map((link) => [magnetHash(link), link]).filter(([hash]) => hash);
        if (magnets.length) await ask("/torrents/checkcached", new Map(magnets));
        return found;
      },
      /** Adds `link` (a file host URL or a magnet) to the account: { kind: "webdl" | "torrent", id, hash }. */
      async createDownload(link, { password, signal } = {}) {
        if (isMagnet(link)) {
          const data = await call("/torrents/createtorrent", { method: "POST", multipart: { magnet: link }, signal });
          return { kind: "torrent", id: data?.torrent_id, hash: data?.hash ?? magnetHash(link) };
        }
        // glibren.23: the link already in the account (an earlier try, or added on torbox.app) is used again, not added a
        // second time; a new one waits for its turn (one per CREATE_GAP_MS), and a 429 waits RATE_WAIT_MS and tries again.
        const existing = await api.findWebDownload(link, { signal }).catch((error) => {
          if (error?.name === "AbortError" || signal?.aborted) throw error;
          return null;
        });
        if (existing) {
          log(`createwebdownload skipped: the link is already item ${existing.id}`);
          return existing;
        }
        for (let tries = 1; ; tries++) {
          const gap = nextCreate - now();
          if (gap > 0) {
            log(`createwebdownload waits ${Math.ceil(gap / 1e3)} s for its turn`);
            await wait(gap, signal);
          }
          nextCreate = now() + createGapMs;
          try {
            const data = await call("/webdl/createwebdownload", { method: "POST", form: { link, password }, signal });
            return { kind: "webdl", id: data?.webdownload_id, hash: data?.hash ?? md5(link) };
          } catch (error) {
            if (error?.code !== "RATE_LIMITED" || tries >= CREATE_TRIES) throw error;
            nextCreate = Math.max(nextCreate, now() + rateWaitMs);
            log(`createwebdownload: TorBox asked to slow down; trying again in ${Math.ceil(rateWaitMs / 1e3)} s`);
          }
        }
      },
      /** glibren.23: the account's web download of `link` (mylist, matched by original_url): { kind, id, hash } or null. */
      // glibren.26: em paginas de MYLIST_PAGE, parando no achado (como myList): era a conta inteira (ate 4 MiB de JSON) a
      // cada link mandado ao TorBox; no PS5, com a lista Orbit Store ligada, o app fechou logo depois de /webdl/hosters.
      async findWebDownload(link, { signal } = {}) {
        const seen = /* @__PURE__ */ new Set();
        for (let offset = 0; offset < MYLIST_MAX; offset += MYLIST_PAGE) {
          const data = await call("/webdl/mylist", { params: { bypass_cache: true, offset, limit: MYLIST_PAGE }, signal });
          const page = Array.isArray(data) ? data : [];
          const found = page.find((item) => item && item.original_url === link && item.id !== void 0 && item.id !== null);
          if (found) return { kind: "webdl", id: found.id, hash: found.hash ?? md5(link) };
          const fresh = page.filter((item) => item?.id != null && !seen.has(item.id));
          for (const item of fresh) seen.add(item.id);
          if (page.length < MYLIST_PAGE || !fresh.length) break;
        }
        return null;
      },
      /** glibren: removes an item from the account (control…, operation delete); true when TorBox said so. */
      async remove(kind, id, { signal } = {}) {
        try {
          await call(kind === "torrent" ? "/torrents/controltorrent" : "/webdl/controlwebdownload", { method: "POST", json: kind === "torrent" ? { torrent_id: Number(id) || id, operation: "delete" } : { webdl_id: Number(id) || id, operation: "delete" }, signal });
          return true;
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          log(`could not remove ${kind} ${id}: ${error?.code || error?.message}`);
          return false;
        }
      },
      /**
       * glibren: "Find via TorBox": `link` added to the account only to read its files' names (largest first),
       * waited for as a resolve waits (up to `maxWaitMs`), then removed again. Nothing is downloaded. ->
       * { names, removed }. The request counts on the account's plan while it lasts.
       */
      async inspect(link, { password, signal, onProgress, maxWaitMs = WAIT_MS, pollMs = POLL_MS } = {}) {
        const entry = await api.createDownload(link, { password, signal });
        if (entry.id === void 0 || entry.id === null) throw new TorBoxError("NO_ITEM", "TorBox didn't say where it put the file. Try again in a moment.");
        try {
          const started = now();
          let item = await api.item(entry.kind, entry.id, { signal });
          while (!(item && (fileNamesOf(item).some((name) => /\.[a-z0-9]{2,6}$/i.test(name)) || finished(item)))) {
            if (item && failed(item)) throw new TorBoxError("FAILED", `TorBox couldn't fetch the file${item.download_state ? ` (${item.download_state})` : ""}.`);
            onProgress?.(Math.max(0, Math.min(1, Number(item?.progress) || 0)));
            if (now() - started >= maxWaitMs) throw new TorBoxError("PENDING", "TorBox is still fetching this file. Try again in a while.");
            await wait(pollMs, signal);
            item = await api.item(entry.kind, entry.id, { signal });
          }
          return { names: fileNamesOf(item), removed: await api.remove(entry.kind, entry.id) };
        } catch (error) {
          await api.remove(entry.kind, entry.id).catch(() => false);
          throw error;
        }
      },
      /** One item of the account (mylist?id=), or null when it is not there (any more). */
      async item(kind, id, { signal } = {}) {
        try {
          const data = await call(kind === "torrent" ? "/torrents/mylist" : "/webdl/mylist", { params: { id, bypass_cache: true }, signal });
          return (Array.isArray(data) ? data.find((entry) => String(entry.id) === String(id)) : data) ?? null;
        } catch (error) {
          if (["ITEM_NOT_FOUND", "HTTP_404"].includes(error.code)) return null;
          throw error;
        }
      },
      /**
       * glibren.6: everything in the account of `kind` ("webdl" or "torrent"; mylist without an id), newest first:
       * the items as TorBox gives them ({ id, name, size, download_finished, files }). An empty account answers 404,
       * read as an empty list.
       */
      // glibren.26: em paginas de MYLIST_PAGE (offset/limit), ate os mesmos 1000 itens de antes, e de cada item so o que o
      // app usa: uma conta grande respondia de uma vez ate 4 MiB de JSON (com md5, s3_path, mimetype... de cada arquivo),
      // texto e objetos juntos no heap de 32 MiB; no PS5, com a lista Orbit Store ligada, a Biblioteca TorBox caiu aqui
      // com "out of memory". Uma pagina que so repete itens ja vistos (offset ignorado) encerra a leitura.
      async myList(kind, { signal } = {}) {
        const out = [];
        const seen = /* @__PURE__ */ new Set();
        for (let offset = 0; offset < MYLIST_MAX; offset += MYLIST_PAGE) {
          let data;
          try {
            data = await call(kind === "torrent" ? "/torrents/mylist" : "/webdl/mylist", { params: { bypass_cache: true, offset, limit: MYLIST_PAGE }, signal });
          } catch (error) {
            if (["ITEM_NOT_FOUND", "HTTP_404"].includes(error.code)) break;
            throw error;
          }
          const page = Array.isArray(data) ? data : data ? [data] : [];
          data = null;
          let fresh = 0;
          for (const item of page) {
            if (!item || typeof item !== "object" || item.id != null && seen.has(item.id)) continue;
            if (item.id != null) seen.add(item.id);
            out.push(accountItem(item));
            fresh++;
          }
          if (page.length < MYLIST_PAGE || !fresh) break;
        }
        return out;
      },
      /**
       * glibren.6: what TorBox holds of `links` (file host URLs or magnets), with its files: a Map of link -> { name,
       * size, files: [{ id, name, size }] }. Like cachedFiles, nothing is added to the account.
       */
      // glibren.29: `pick(entrada)`: o que guardar de cada link (askInstant so quer saber se a copia e quebrada), em vez da
      // lista de arquivos; LIST_GROUP hashes por chamada, lidos uma entrada por vez, de cada arquivo so cachedFile.
      async cachedEntries(links, { signal, pick = (entry) => entry } = {}) {
        const found = /* @__PURE__ */ new Map();
        const ask = async (path, byHash) => {
          const hashes = [...byHash.keys()];
          for (let i = 0; i < hashes.length; i += LIST_GROUP) {
            await call(path, { params: { hash: hashes.slice(i, i + LIST_GROUP).join(","), format: "object", list_files: true }, signal, each: (hash, entry) => {
              const link = byHash.get(hash.toLowerCase());
              if (link && entry && typeof entry === "object" && !found.has(link)) found.set(link, pick(cachedEntry(entry)));
            } });
          }
        };
        const web = links.filter((link) => !isMagnet(link));
        await ask("/webdl/checkcached", new Map(web.flatMap((link) => linkHashes(link).map((hash) => [hash, link]))));
        const magnets = links.filter(isMagnet).map((link) => [magnetHash(link), link]).filter(([hash]) => hash);
        if (magnets.length) await ask("/torrents/checkcached", new Map(magnets));
        return found;
      },
      /**
       * glibren.9: what TorBox holds under any of `hashes` (other MD5s it knows a file by besides its link's: the
       * file's name, "<code>.exfat"; the TorBox library, state/torbox-library.js), up to 100 a call, with the files:
       * [{ hash, name, size, files }]. `hash` is the key TorBox answers with (the MD5 of the link the file was first
       * fetched from), not one of those asked: the caller tells the entries apart by their names.
       */
      async cachedByHash(hashes, { signal } = {}) {
        const list = [...new Set(hashes.map((hash) => String(hash).toLowerCase()))].filter(Boolean);
        const found = [];
        // glibren.29: LIST_GROUP hashes por chamada, lidos uma entrada por vez (cachedEntry).
        for (let i = 0; i < list.length; i += LIST_GROUP) {
          await call("/webdl/checkcached", { params: { hash: list.slice(i, i + LIST_GROUP).join(","), format: "object", list_files: true }, signal, each: (hash, entry) => {
            if (entry && typeof entry === "object") found.push({ hash: hash.toLowerCase(), ...cachedEntry(entry) });
          } });
        }
        return found;
      },
      /**
       * glibren.6: TorBox's torrent search (search-api.torbox.app/torrents/search/<text>), only what TorBox holds
       * already (cached_only): [{ hash, title, magnet, size, seeders }]. The service was not answering on 2026-11-05
       * (its name did not resolve); callers treat a failure as "search not available".
       */
      async searchTorrents(text, { signal } = {}) {
        const data = await call(`/torrents/search/${encodeURIComponent(String(text || "").trim())}`, { base: SEARCH_BASE, params: { check_cache: true, cached_only: true }, signal });
        const list = Array.isArray(data?.torrents) ? data.torrents : [];
        return list.filter((entry) => entry && entry.magnet && entry.cached !== false).map((entry) => ({ hash: String(entry.hash || magnetHash(entry.magnet) || "").toLowerCase(), title: entry.raw_title || entry.title || "", magnet: entry.magnet, size: Number(entry.size) || 0, seeders: Number(entry.last_known_seeders) || 0 }));
      },
      /**
       * A direct link to file `fileId` of item `id` (or, `zip`, to all of a torrent's files as one zip), open
       * for three hours; the key stays out of it.
       */
      async getUnrestrictedLink(kind, id, fileId, { signal, zip = false } = {}) {
        const params = kind === "torrent" ? zip ? { torrent_id: id, zip_link: true } : { torrent_id: id, file_id: fileId, zip_link: false } : { web_id: id, file_id: fileId, zip_link: false };
        const data = await call(kind === "torrent" ? "/torrents/requestdl" : "/webdl/requestdl", { params, signal, token: true, auth: false });
        if (typeof data !== "string" || !/^https:\/\//i.test(data)) throw new TorBoxError("NO_LINK", "TorBox gave no download link. Try again in a moment.");
        return data;
      },
      /**
       * `link` as a direct link: added to the account if `known` (a { kind, id } from before) is not there,
       * waited for while TorBox fetches it (up to `maxWaitMs`, telling `onProgress(fraction)`), then its file
       * (`filename`'s, else the largest) asked for. -> { url, kind, id, fileId, name, size }. A torrent of many
       * files (chooseFiles) comes as one zip: { url, kind, id, fileId: null, name: null, size: null, repacked: true }.
       * Past the wait it throws PENDING with `progress`; asking again later picks up the same item.
       * glibren.6: `zip` asks for a torrent's files as one zip whatever they are ("All" in Search TorBox).
       */
      async resolve(link, { known, filename, password, signal, onProgress, onItem, maxWaitMs = WAIT_MS, pollMs = POLL_MS, zip = false } = {}) {
        let entry = known?.id !== void 0 && known?.id !== null ? { kind: known.kind || (isMagnet(link) ? "torrent" : "webdl"), id: known.id } : null;
        let item = entry ? await api.item(entry.kind, entry.id, { signal }) : null;
        if (!item) {
          entry = await api.createDownload(link, { password, signal });
          if (entry.id === void 0 || entry.id === null) throw new TorBoxError("NO_ITEM", "TorBox didn't say where it put the file. Try again in a moment.");
          onItem?.(entry);
          item = await api.item(entry.kind, entry.id, { signal });
        }
        const started = now();
        while (!finished(item)) {
          if (failed(item)) throw new TorBoxError("FAILED", `TorBox couldn't fetch the file${item.download_state ? ` (${item.download_state})` : ""}. Choose another source.`);
          const progress = Math.max(0, Math.min(1, Number(item?.progress) || 0));
          onProgress?.(progress);
          if (now() - started >= maxWaitMs) throw new TorBoxError("PENDING", `TorBox is still fetching this file (${Math.floor(progress * 100)}%). Resume the download in a while.`, { progress, item: entry });
          await wait(pollMs, signal);
          item = await api.item(entry.kind, entry.id, { signal });
        }
        const choice = entry.kind === "torrent" ? zip ? { zip: true } : chooseFiles(item.files, filename) : { file: pickFile(item.files, filename) };
        if (!choice || !choice.file && !choice.zip) throw new TorBoxError("NO_FILE", "TorBox fetched the link but found no file in it. Choose another source.");
        if (choice.zip) {
          const url2 = await api.getUnrestrictedLink(entry.kind, entry.id, null, { signal, zip: true });
          return { url: url2, kind: entry.kind, id: entry.id, fileId: null, name: null, size: null, repacked: true };
        }
        const file = choice.file;
        const url = await api.getUnrestrictedLink(entry.kind, entry.id, file.id, { signal });
        return { url, kind: entry.kind, id: entry.id, fileId: file.id, name: file.name || null, size: file.size || null };
      }
    };
    return api;
  }
  // Each hoster's pattern compiled once (null when TorBox sent one that does not compile), not on every check.
  var patterns = /* @__PURE__ */ new Map();
  function patternOf(source) {
    if (!patterns.has(source)) {
      try {
        patterns.set(source, new RegExp(source, "i"));
      } catch {
        patterns.set(source, null);
      }
    }
    return patterns.get(source);
  }
  // glibren.23: whether a host still has today's quota (links and bytes; a limit of 0 is none).
  var quotaLeft = (hoster) => (!hoster.linkLimit || (hoster.linkUsed ?? 0) < hoster.linkLimit) && (!hoster.bytesLimit || (hoster.bytesUsed ?? 0) < hoster.bytesLimit);
  // Whether TorBox lists `url`'s host and has it working: true, false, or null when its list is not known.
  // MODIFIED (glibren.23): and with quota left today (a host out of it is refused by TorBox until the next day).
  function hostSupported(hosters, url) {
    if (!hosters) return null;
    if (isMagnet(url)) return true;
    const host = /^https?:\/\/([^/?#:]+)/i.exec(url || "")?.[1]?.toLowerCase();
    if (!host) return false;
    return hosters.some((hoster) => {
      if (!hoster.working || !quotaLeft(hoster)) return false;
      if (hoster.domains.some((domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`))) return true;
      return Boolean(hoster.regex) && patternOf(hoster.regex)?.test(url) === true;
    });
  }

export { LIST_GROUP, NAMES_KEPT, cachedEntry, fileNamesOf, MESSAGES, PLANS, TorBoxError, chooseFiles, createTorBox, hostSupported, quotaLeft, isMagnet, linkHashes, magnetHash, md5, pickFile, validKey };
