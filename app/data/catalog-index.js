// The bundled catalog, read from the package at launch (tools/catalog/catalog-index.mjs builds it from
// data/catalog.js, which the app no longer bundles): data/catalog/index.json holds every game with what the
// lists, search, filters and sorts read; the art only a game's page or a banner draws (hero, logo, the other
// covers) is in data/catalog/art/<n>.json, read the first time a game's is asked for. `games`, `twins` and
// `features` are what data/catalog.js exported, the same arrays every importer shares (state/catalog.js adds
// the feeds' games to them).

import { FileSystem } from '@ps5-react/core';

  var DIR = "/app0/data/catalog";
  // The fields index.json gives as places in its `names` lists, and the art read when asked for, in the order of
  // the bits of a game's art mask (tools/catalog/catalog-index.mjs NAMED, LAZY_ART).
  var NAMED = ["platform", "providers", "developer", "publisher", "genres", "features"];
  var LAZY_ART = ["hero", "logo", "logoAspect", "logoDark", "coverFallbacks"];
  // Covers are asked of the PlayStation Store at the width a card draws them (state/catalog.js).
  var COVER_WIDTH = 440;
  var coverSize = (url) => url.startsWith("https://image.api.playstation.com/") ? url.replace(/([?&]w=)\d+/, `$1${COVER_WIDTH}`) : url;
  // Where a game's art waits in the art files: [file, place, mask].
  var LAZY = Symbol("lazy art");
  // The art files kept parsed, and the art of the last games drawn: a lane of banners from as many files reads
  // each file once, not at every draw.
  var KEPT_FILES = 4;
  var KEPT_ART = 256;
  var files = /* @__PURE__ */ new Map();
  var kept = /* @__PURE__ */ new Map();
  var artReads = 0;
  var noted = false;
  function artFile(at) {
    let list = files.get(at);
    if (list) files.delete(at);
    else {
      try {
        list = JSON.parse(FileSystem.readFile(`${DIR}/art/${at}.json`));
        artReads++;
      } catch (error) {
        // A package without its art files: the games keep their covers and names; say so once.
        if (!noted) console.log(`[catalog] art file ${at} not read: ${error.message}`);
        noted = true;
        list = [];
      }
      if (files.size >= KEPT_FILES) files.delete(files.keys().next().value);
    }
    files.set(at, list);
    return list;
  }
  function artOf(where) {
    const key = where[0] * 65536 + where[1];
    let art = kept.get(key);
    if (art) kept.delete(key);
    else {
      art = artFile(where[0])[where[1]] ?? {};
      if (art.coverFallbacks) art.coverFallbacks = art.coverFallbacks.map(coverSize);
      if (kept.size >= KEPT_ART) kept.delete(kept.keys().next().value);
    }
    kept.set(key, art);
    return art;
  }
  // A bundled game's art: its cover and tint are its own; the rest reads its art file when asked for.
  var LazyArt = {};
  LAZY_ART.forEach((name, bit) => {
    Object.defineProperty(LazyArt, name, { enumerable: true, get() {
      const where = this[LAZY];
      return where && where[2] & 1 << bit ? artOf(where)[name] : void 0;
    } });
  });
  /** Whether a game has a banner (`hero`) or a logo, without reading its art file. */
  function hasArt(game, name) {
    const art = game?.art;
    const where = art?.[LAZY];
    return where ? Boolean(where[2] & 1 << LAZY_ART.indexOf(name)) : Boolean(art?.[name]);
  }
  function decode(list, names) {
    for (const game of list) {
      for (const field of NAMED) {
        const at = game[field];
        if (typeof at === "number") game[field] = names[field][at];
        else if (Array.isArray(at)) game[field] = at.map((place) => names[field][place]);
      }
      const raw = game.art ?? {};
      const art = Object.create(LazyArt);
      for (const key in raw) if (key !== "lazy") art[key] = raw[key];
      if (raw.lazy) art[LAZY] = raw.lazy;
      game.art = art;
    }
    return list;
  }
  // How the launch read the index, for the debug log (it opens after this module loads; state/catalog.js
  // warmCovers writes it there): { ms, games, twins, bytes, error }.
  var catalogLoad = { ms: 0, games: 0, twins: 0, bytes: 0, error: "" };
  function readIndex() {
    const started = Date.now();
    try {
      const text = FileSystem.readFile(`${DIR}/index.json`);
      const index = JSON.parse(text);
      if (index?.version !== 1 || !Array.isArray(index.games)) throw new Error("not a version 1 index; run tools/catalog/catalog-index.mjs");
      const games2 = decode(index.games, index.names);
      const twins2 = decode(index.twins ?? [], index.names);
      Object.assign(catalogLoad, { ms: Date.now() - started, games: games2.length, twins: twins2.length, bytes: text.length });
      return { games: games2, twins: twins2, features: index.features ?? [] };
    } catch (error) {
      // The store opens with the feeds' games alone rather than not at all: downloads and the library still work.
      catalogLoad.error = error.message;
      console.log(`[catalog] the bundled catalog is not read: ${error.message}`);
      return { games: [], twins: [], features: [] };
    }
  }
  var { games, twins, features } = readIndex();
  /** How many art files were read since launch (tests). */
  var artFilesRead = () => artReads;

export { COVER_WIDTH, artFilesRead, catalogLoad, coverSize, features, games, hasArt, twins };
