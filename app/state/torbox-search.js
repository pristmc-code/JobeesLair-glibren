// glibren.6: "Search TorBox" on a game's page (game/TorBoxSheet.jsx). Everything TorBox has of the game, found by
// its code (PPSA02384, CUSA12345) and by its name, as one list of files: name, size and type (.exfat first):
//   - the account: what is in it already (/webdl/mylist, /torrents/mylist), its files' names matched;
//   - the catalog: the game's own links TorBox holds (checkcached with list_files);
//   - the search API: torrents TorBox holds, by code and by name (search-api.torbox.app; not answering on
//     2026-11-05, so a failure there only says the search is not available).
//   - the gamer's own list of torrent hashes (torbox-hashes.txt in the app's data folder or at a drive's root; see
//     parseHashList): the ones TorBox holds whose line names the game's code, or whose torrent is the game's by name.
// A file picked is queued at once (downloadFile): no source list, no format check. It goes as a TorBox source
// (state/debrid.js), so the queue's resolver asks TorBox for its link, renews it before its three hours run out,
// and the background payload can ask for a new one by itself (debridHandoff: the item and the file are kept).
// A torrent of many files also gets an "All" row (the whole torrent as one zip, extracted like any archive), and
// its backport folder (backports/<TITLE_ID>/: an eboot and libraries ShadowMount+ lays over the game) one row that
// says what it is, instead of a row per library: a folder of loose files is not a download the queue can place.

import { debridSource, rememberTorBoxItem, torBoxApi } from './debrid.js';
import { rememberDrive } from './last-drive.js';
import { formatFromName } from './link-formats.js';
import { magnetHash } from '../services/torbox.js';

  // The order the list is shown in: disk images first (exFAT before the rest), then packages, then archives.
  var FORMAT_RANK = ["exfat", "ffpkg", "ffpfsc", "ffpfs", "pkg", "fpkg", "rar", "7z", "zip", "tar"];
  var ORIGIN_RANK = ["account", "catalog", "list", "search"];
  // Where a row goes among the rest: files first, then a torrent's "All", then what only says what it is.
  var ROW_RANK = (file) => file.backport ? 3 : file.piece ? 2 : file.whole ? 1 : 0;
  // A file smaller than this with no known type is a text file or a picture beside the game, not shown.
  var SMALL = 1e6;
  // Words a release name leaves out or adds, not to be matched on.
  var NOISE = /* @__PURE__ */ new Set(["the", "and", "of", "a", "an", "edition", "deluxe", "ultimate", "complete", "remastered", "definitive", "standard", "digital", "ps5", "ps4", "game", "of", "for", "e", "o", "de", "da", "do"]);
  var plain = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  /** The game's code ("PPSA02384") as a pattern that also takes "PPSA-02384" and "PPSA_02384"; null when it has none. */
  function codePattern(id) {
    const match = /^(PPSA|CUSA)[-_ ]?(\d{5})$/i.exec(String(id || ""));
    return match ? new RegExp(`${match[1]}[-_ ]?${match[2]}`, "i") : null;
  }
  /** The words of a game's name worth matching (at least three letters, not edition words). */
  var titleWords = (title) => [...new Set(plain(title).split(" ").filter((word) => word.length >= 3 && !NOISE.has(word)))];
  /** Whether `name` is the game's: its code in it, or every word of its name. */
  function matchesGame(name, game) {
    const code = codePattern(game.id);
    if (code && code.test(name)) return true;
    const words = titleWords(game.title);
    if (!words.length) return false;
    const text = ` ${plain(name)} `;
    return words.every((word) => text.includes(` ${word} `));
  }
  // The text the search API is asked for: the code, and the name without its edition words.
  function searchTexts(game) {
    const texts = [];
    if (codePattern(game.id)) texts.push(String(game.id).toUpperCase());
    const words = titleWords(game.title);
    if (words.length) texts.push(words.join(" "));
    return texts;
  }
  var baseName = (name) => String(name || "").replace(/^.*[\\/]/, "");
  // A split archive's piece ("Game.part2.rar", "Game.7z.001", "Game.r01"): one of a set, not a download by itself.
  var isPiece = (name) => /\.part\d{1,4}\.(?:rar|zip|7z)$/i.test(name) || /\.(?:rar|zip|7z|tar)\.\d{3}$/i.test(name) || /\.[rz]\d{2}$/i.test(name);
  /** What the list says of a file's type: its format in capitals ("EXFAT"), else its extension, else "?". */
  function typeLabel(name) {
    const format = formatFromName(name);
    if (format) return format.toUpperCase();
    const extension = /\.([a-z0-9]{1,6})$/i.exec(name)?.[1];
    return extension ? extension.toUpperCase() : "?";
  }
  // One row of the list.
  function entry(fields) {
    const name = baseName(fields.name);
    return { ...fields, name, format: formatFromName(name), type: typeLabel(name), piece: isPiece(name), key: `${fields.origin}:${fields.kind ?? ""}:${fields.id ?? fields.link ?? ""}:${fields.fileId ?? name}` };
  }
  var worthShowing = (file) => formatFromName(baseName(file.name)) || (Number(file.size) || 0) >= SMALL;
  // The files of a TorBox item or cached entry (the entry itself when it lists none); `path` keeps the folders.
  var filesOf = (item) => Array.isArray(item?.files) && item.files.length ? item.files.map((file) => ({ id: file.id, name: file.short_name || file.name, path: String(file.name || file.short_name || ""), size: Number(file.size) || 0 })) : [{ id: 0, name: item?.name || "", path: item?.name || "", size: Number(item?.size) || 0 }];
  // A backport's file: anything under a backports/ folder, or a loose eboot or library whose path names a backport.
  var isBackportFile = (file) => /(?:^|\/)backports?\//i.test(file.path) || /backport/i.test(file.path) && /\.(?:bin|prx|sprx)$/i.test(file.path);
  /**
   * A TorBox item's rows: its files (backport files left out), one row for its backport folder when it has one, and
   * one "All" row for a torrent of more than one file. `fields` are the rows' own (origin, kind, id, link...).
   */
  function rowsOf(item, fields, { torrent = false, accept = () => true } = {}) {
    const all = filesOf(item);
    const backport = all.filter(isBackportFile);
    const rows = all.filter((file) => !isBackportFile(file) && worthShowing(file) && accept(file)).map((file) => entry({ ...fields, fileId: file.id, name: file.name, size: file.size }));
    if (backport.length) {
      const folder = /(?:^|\/)(backports?\/[^/]+)/i.exec(backport[0].path)?.[1] ?? "backports";
      rows.push({ ...entry({ ...fields, fileId: `backport:${folder}`, name: folder, size: backport.reduce((sum, file) => sum + file.size, 0) }), name: folder, type: "BACKPORT", format: null, backport: true, count: backport.length });
    }
    if (torrent && all.length > 1) {
      const total = Number(item?.size) || all.reduce((sum, file) => sum + file.size, 0);
      rows.push({ ...entry({ ...fields, fileId: "all", name: item?.name || fields.title || "torrent", size: total }), type: "ZIP", format: "zip", whole: true, count: all.length });
    }
    return rows;
  }
  /** The list in the order it is shown: type (exFAT first), then where it is (the account first), then the largest. */
  function sortFiles(files) {
    const rank = (list, value) => {
      const index = list.indexOf(value);
      return index < 0 ? list.length : index;
    };
    return [...files].sort((a, b) => ROW_RANK(a) - ROW_RANK(b) || rank(FORMAT_RANK, a.format) - rank(FORMAT_RANK, b.format) || rank(ORIGIN_RANK, a.origin) - rank(ORIGIN_RANK, b.origin) || (b.size || 0) - (a.size || 0) || a.name.localeCompare(b.name));
  }
  // The same file found twice (in the account and among the catalog's links): kept once, where it is closest.
  function unique(files) {
    const seen = /* @__PURE__ */ new Set();
    return sortFiles(files).filter((file) => {
      const key = `${file.name.toLowerCase()}|${file.size || 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  // The game's own single-file links, as the catalog lists them (a set in parts is not offered here).
  function catalogLinks(game) {
    const links = /* @__PURE__ */ new Map();
    for (const release of game.releases || []) {
      if (release.parts || release.unavailableReason) continue;
      const link = release.browserUrl || release.url;
      if (link && !links.has(link)) links.set(link, release);
    }
    return links;
  }

  /**
   * Looks for the game's files in TorBox. `api` is the TorBox client (state/debrid.js torBoxApi by default);
   * `onUpdate({ files, sources })` hears each part as it comes in; `hashList` is readHashList's answer (null: none).
   * -> { files, sources }, `sources` saying for each of account, catalog, search and list how it went:
   * { state: "done" | "failed" | "unavailable" | "absent", count, error } ("absent": no list of hashes was found).
   */
  async function searchTorBox(game, { api = torBoxApi(), signal, onUpdate = () => {}, hashList = null, textSearch = false } = {}) {
    const found = [];
    const sources = { account: { state: "searching", count: 0 }, catalog: { state: "searching", count: 0 }, search: { state: textSearch ? "searching" : "absent", count: 0 }, list: { state: hashList?.files ? "searching" : "absent", count: 0 } };
    const report = () => onUpdate({ files: unique(found), sources: { ...sources } });
    const run = async (name, work) => {
      try {
        const files = await work();
        found.push(...files);
        sources[name] = { state: "done", count: files.length };
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        sources[name] = { state: name === "search" ? "unavailable" : "failed", count: 0, error: error?.message || String(error) };
      }
      report();
    };
    // The account: every item whose name, or one of whose files' names, is the game's.
    await run("account", async () => {
      const files = [];
      for (const kind of ["webdl", "torrent"]) {
        for (const item of await api.myList(kind, { signal })) {
          const whole = matchesGame(item.name || "", game);
          const fields = { origin: "account", kind, id: item.id, ready: Boolean(item.download_finished) };
          if (whole) files.push(...rowsOf(item, fields, { torrent: kind === "torrent" }));
          else files.push(...rowsOf(item, fields, { accept: (file) => matchesGame(file.name, game) }).filter((row) => !row.backport));
        }
      }
      return files;
    });
    // The catalog's links TorBox holds, with their files.
    const links = catalogLinks(game);
    await run("catalog", async () => {
      if (!links.size) return [];
      const held = await api.cachedEntries([...links.keys()], { signal });
      const files = [];
      for (const [link, item] of held) {
        const release = links.get(link);
        for (const file of filesOf(item)) if (worthShowing(file)) files.push(entry({ origin: "catalog", link, release, fileId: file.id, name: file.name || release.filename, size: file.size || release.sizeBytes || 0, host: release.provider || "" }));
      }
      return files;
    });
    // TorBox's search, by code and by name: torrents it holds whose title is the game's, with their files.
    // Off unless asked (textSearch): search-api.torbox.app is gone (no address, 2026-11-05), and a request to a
    // name that does not resolve leaves the console's HTTP transport refusing the next requests (the hash list's).
    if (!textSearch) sources.search = { state: "absent", count: 0 };
    else await run("search", async () => {
      const torrents = /* @__PURE__ */ new Map();
      let failure = null, answered = false;
      for (const text of searchTexts(game)) {
        try {
          for (const torrent of await api.searchTorrents(text, { signal })) if (matchesGame(torrent.title, game) && !torrents.has(torrent.magnet)) torrents.set(torrent.magnet, torrent);
          answered = true;
        } catch (error) {
          if (error?.name === "AbortError" || signal?.aborted) throw error;
          failure = error;
        }
      }
      if (!answered && failure) throw failure;
      if (!torrents.size) return [];
      const held = await api.cachedEntries([...torrents.keys()], { signal });
      const files = [];
      for (const [magnet, torrent] of torrents) {
        const item = held.get(magnet) ?? { name: torrent.title, size: torrent.size, files: [] };
        files.push(...rowsOf(item, { origin: "search", link: magnet, seeders: torrent.seeders, title: torrent.title }, { torrent: true }));
      }
      return files;
    });
    // The gamer's own list of hashes: those whose line names the game's code, and those of no code whose torrent
    // turns out to be the game's by name. What TorBox says of each hash is kept for the session (listHeld), so a
    // long list is asked once, not again on every game's page.
    if (!hashList || !hashList.files) sources.list = { state: "absent", count: 0 };
    else {
      await run("list", async () => {
        const code = codePattern(game.id) ? String(game.id).toUpperCase() : null;
        const mine = hashList.entries.filter((item) => item.code ? item.code === code : true);
        const unknown = [...new Set(mine.map((item) => item.hash))].filter((hash) => !listHeld.has(hash));
        if (unknown.length) {
          const held = await api.cachedEntries(unknown.map(magnetOf), { signal });
          for (const hash of unknown) listHeld.set(hash, held.get(magnetOf(hash)) ?? null);
        }
        const files = [];
        for (const item of mine) {
          const cached = listHeld.get(item.hash);
          if (!cached) continue;
          const named = item.code === code || matchesGame(cached.name || "", game) || filesOf(cached).some((file) => matchesGame(file.path, game));
          if (named) files.push(...rowsOf(cached, { origin: "list", link: magnetOf(item.hash), title: cached.name || "" }, { torrent: true }));
        }
        return files;
      });
    }
    return { files: unique(found), sources };
  }

  // ---- The gamer's list of hashes (torbox-hashes.txt) ----
  // One torrent a line: a magnet link, or its info hash alone (40 hex digits, or 32 base32 letters), and anywhere on
  // the line the game's code (PPSA01467, CUSA12345, also PPSA-01467) when the gamer knows it. Empty lines and lines
  // starting with # are skipped; anything else on a line (a name, a note) is left alone. Nothing of it goes anywhere
  // but TorBox's checkcached, as hashes.
  var HASH_LIST = "torbox-hashes.txt";
  var listHeld = /* @__PURE__ */ new Map();
  var magnetOf = (hash) => `magnet:?xt=urn:btih:${hash}`;
  /** The hashes in a list's text: [{ hash (40 hex, lower case), code ("PPSA01467" or null) }], in order, once each. */
  function parseHashList(text) {
    const entries = /* @__PURE__ */ new Map();
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const magnet = /magnet:\?\S+/i.exec(line)?.[0];
      const value = magnet ? magnetHash(magnet) : magnetHash(magnetOf(/\b[0-9a-f]{40}\b/i.exec(line)?.[0] ?? /\b[a-z2-7]{32}\b/i.exec(line.toUpperCase())?.[0] ?? ""));
      if (!value) continue;
      const code = /(PPSA|CUSA)[-_ ]?(\d{5})/i.exec(line);
      const known = entries.get(value);
      entries.set(value, { hash: value, code: code ? `${code[1].toUpperCase()}${code[2]}` : known?.code ?? null });
    }
    return [...entries.values()];
  }
  /** Where the list is looked for: the app's data folder, then the root of each drive. */
  var hashListPaths = (dataDir, roots) => [...new Set([`${dataDir}/${HASH_LIST}`, ...roots.map((root2) => `${root2.replace(/\/+$/, "")}/${HASH_LIST}`)])];
  /** The lists found at `paths` (read with `fs`), as one: { files (how many were read), entries }. */
  function readHashList(fs, paths) {
    const texts = [];
    for (const path of paths) {
      try {
        if (fs.exists(path)) texts.push(String(fs.readFile(path)));
      } catch {
      }
    }
    return { files: texts.length, entries: parseHashList(texts.join("\n")) };
  }

  // A file name the queue takes as a download's (state/download-queue.js, DownloadFormats.artifact): no folders, no
  // control characters, not too long.
  function safeName(name) {
    const clean = baseName(name).replace(/[\x00-\x1f\\]/g, "").trim() || "torbox-file";
    if (clean.length <= 200) return clean;
    const extension = /\.[a-z0-9]{1,6}$/i.exec(clean)?.[0] ?? "";
    return clean.slice(0, 200 - extension.length) + extension;
  }
  // An account item's own address, which stands for its link: the queue and the payload know it by its hash.
  var itemLink = (kind, id) => `https://torbox.app/${kind === "torrent" ? "torrents" : "webdl"}/${id}`;
  /**
   * The download a file of the list is: a TorBox source, with the file's name, type and size. An "All" row is the
   * whole torrent as one zip (`torboxZip`: the resolver asks TorBox for its zip link, the queue extracts it).
   */
  function releaseFor(file) {
    const filename = file.whole ? /\.zip$/i.test(safeName(file.name)) ? safeName(file.name) : `${safeName(file.name).slice(0, 196)}.zip` : safeName(file.name);
    const fields = { filename, format: file.whole ? "zip" : formatFromName(filename), sizeBytes: file.whole ? null : file.size || null, sha256: void 0, checksum: void 0, ...file.whole ? { torboxZip: true } : {} };
    if (file.origin === "catalog") {
      const base = debridSource(file.release);
      return { ...base, ...fields, id: `${base.id}~file~${file.fileId ?? 0}`, label: file.release.label || "" };
    }
    // An "All" row's link is told apart from its files' (a query on the item's address, an x. field on the magnet,
    // which BitTorrent clients ignore), so what is kept for the zip and for a file of the same torrent stays apart.
    const link = file.origin === "account" ? `${itemLink(file.kind, file.id)}${file.whole ? "?all" : ""}` : file.whole ? `${file.link}&x.glibren=all` : file.link;
    // A zip has no file of its own: kept as one (zip, no file id), so a renewal or the payload asks for the zip again.
    if (file.origin === "account") rememberTorBoxItem(link, file.whole ? { kind: file.kind, id: file.id, fileId: null, repacked: true } : { kind: file.kind, id: file.id, fileId: file.fileId });
    return {
      ...fields,
      id: file.origin === "account" ? `torbox-${file.kind}-${file.id}-${file.fileId ?? 0}` : `torbox-torrent-${magnetHash(file.link) ?? "unknown"}-${file.fileId ?? 0}`,
      url: link,
      provider: "TorBox",
      source: "torbox-search",
      category: "game",
      flow: "debrid",
      version: "",
      label: "",
      debrid: { service: "torbox" }
    };
  }
  /**
   * Queues `file` (a row of searchTorBox's list) for `game` on drive `root` in `queue` (the download queue), as it
   * is: -> the job's id. Throws what the queue says (no room, already there).
   */
  function downloadFile(queue, game, file, root2) {
    if (file.piece) throw new Error("This file is one piece of a split archive. Pick the whole set from the game's links.");
    if (file.backport) throw new Error("A backport is a folder of loose files. Get it with All (the whole package).");
    const id = queue.enqueue(game, releaseFor(file), root2, []);
    rememberDrive(root2);
    return id;
  }
  /**
   * Whether a row is a PS5 fake package (a .pkg of a PPSA game) that this console won't launch: `launches` is
   * state/firmware.js ps5FakePackagesLaunch for its firmware (true only at 11.60 or below).
   */
  var fakePackageWarning = (file, game, launches) => (file.format === "pkg" || file.format === "fpkg") && /^PPSA/i.test(String(game?.id || "")) && launches !== true;

export { codePattern, downloadFile, fakePackageWarning, hashListPaths, matchesGame, parseHashList, readHashList, releaseFor, searchTexts, searchTorBox, sortFiles, typeLabel };
