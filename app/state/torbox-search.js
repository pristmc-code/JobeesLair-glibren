// glibren.6: "Search TorBox" on a game's page (game/TorBoxSheet.jsx). Everything TorBox has of the game, found by
// its code (PPSA02384, CUSA12345) and by its name, as one list of files: name, size and type (.exfat first):
//   - the account: what is in it already (/webdl/mylist, /torrents/mylist), its files' names matched;
//   - the catalog: the game's own links TorBox holds (checkcached with list_files);
//   - the search API: torrents TorBox holds, by code and by name (search-api.torbox.app; not answering on
//     2026-11-05, so a failure there only says the search is not available).
// A file picked is queued at once (downloadFile): no source list, no format check. It goes as a TorBox source
// (state/debrid.js), so the queue's resolver asks TorBox for its link, renews it before its three hours run out,
// and the background payload can ask for a new one by itself (debridHandoff: the item and the file are kept).

import { debridSource, rememberTorBoxItem, torBoxApi } from './debrid.js';
import { rememberDrive } from './last-drive.js';
import { formatFromName } from './link-formats.js';
import { magnetHash } from '../services/torbox.js';

  // The order the list is shown in: disk images first (exFAT before the rest), then packages, then archives.
  var FORMAT_RANK = ["exfat", "ffpkg", "ffpfsc", "ffpfs", "pkg", "fpkg", "rar", "7z", "zip", "tar"];
  var ORIGIN_RANK = ["account", "catalog", "search"];
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
  // The files of a TorBox item or cached entry (the entry itself when it lists none).
  var filesOf = (item) => Array.isArray(item?.files) && item.files.length ? item.files.map((file) => ({ id: file.id, name: file.short_name || file.name, size: Number(file.size) || 0 })) : [{ id: 0, name: item?.name || "", size: Number(item?.size) || 0 }];
  /** The list in the order it is shown: type (exFAT first), then where it is (the account first), then the largest. */
  function sortFiles(files) {
    const rank = (list, value) => {
      const index = list.indexOf(value);
      return index < 0 ? list.length : index;
    };
    return [...files].sort((a, b) => a.piece - b.piece || rank(FORMAT_RANK, a.format) - rank(FORMAT_RANK, b.format) || rank(ORIGIN_RANK, a.origin) - rank(ORIGIN_RANK, b.origin) || (b.size || 0) - (a.size || 0) || a.name.localeCompare(b.name));
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
   * `onUpdate({ files, sources })` hears each part as it comes in. -> { files, sources }, `sources` saying for each
   * of account, catalog and search how it went: { state: "done" | "failed" | "unavailable", count, error }.
   */
  async function searchTorBox(game, { api = torBoxApi(), signal, onUpdate = () => {} } = {}) {
    const found = [];
    const sources = { account: { state: "searching", count: 0 }, catalog: { state: "searching", count: 0 }, search: { state: "searching", count: 0 } };
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
          const list = filesOf(item);
          const whole = matchesGame(item.name || "", game);
          for (const file of list) {
            if (!(whole || matchesGame(file.name, game)) || !worthShowing(file)) continue;
            files.push(entry({ origin: "account", kind, id: item.id, fileId: file.id, name: file.name, size: file.size, ready: Boolean(item.download_finished) }));
          }
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
    await run("search", async () => {
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
        for (const file of filesOf(item)) if (worthShowing(file)) files.push(entry({ origin: "search", link: magnet, fileId: file.id, name: file.name, size: file.size, seeders: torrent.seeders, title: torrent.title }));
      }
      return files;
    });
    return { files: unique(found), sources };
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
  /** The download a file of the list is: a TorBox source, with the file's name, type and size. */
  function releaseFor(file) {
    const filename = safeName(file.name);
    const fields = { filename, format: formatFromName(filename), sizeBytes: file.size || null, sha256: void 0, checksum: void 0 };
    if (file.origin === "catalog") {
      const base = debridSource(file.release);
      return { ...base, ...fields, id: `${base.id}~file~${file.fileId ?? 0}`, label: file.release.label || "" };
    }
    const link = file.origin === "account" ? itemLink(file.kind, file.id) : file.link;
    if (file.origin === "account") rememberTorBoxItem(link, { kind: file.kind, id: file.id, fileId: file.fileId });
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
    const id = queue.enqueue(game, releaseFor(file), root2, []);
    rememberDrive(root2);
    return id;
  }

export { codePattern, downloadFile, matchesGame, releaseFor, searchTexts, searchTorBox, sortFiles, typeLabel };
