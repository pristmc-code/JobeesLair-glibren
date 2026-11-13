#!/usr/bin/env node
// Builds app/data/catalog/: the bundled catalog (app/data/catalog.js) as the app reads it on the console.
//
//   node tools/catalog/catalog-index.mjs
//
// app/data/catalog.js stays the catalog's source (the tools and the tests read it), but the app no longer
// bundles it: 1.5 MB of object literals the console parsed and compiled at every launch, every URL in it kept
// in the script heap. The app reads instead:
//   index.json      every game with what the lists, the search, the filters and the sorts use: names, platform,
//                   hosts, genres, features, dates, ratings, size, the cover and its tint. The repeated names
//                   (platform, hosts, studios, genres, features) are listed once and each game gives their
//                   places, so a name is one string in the heap, not one a game.
//   art/<n>.json    the art only a game's page or a banner draws (hero, logo, the other covers), SHARD games a
//                   file, read when first asked for (app/data/catalog-index.js).
// Run it again whenever app/data/catalog.js changes; tests/app.test.mjs checks the files are current.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The games one art file holds. Small, so a banner reads little; the app keeps the last few files and the
// art of the last games it drew (app/data/catalog-index.js).
export const SHARD = 32;
// The game fields given as places in a list of names (`names` in index.json), one name or a list of them.
export const NAMED = ['platform', 'providers', 'developer', 'publisher', 'genres', 'features'];
// The art read when asked for, and its bit in a game's art `lazy` mask: which of them the game has, so a list
// can ask "has a banner?" without reading its file.
export const LAZY_ART = ['hero', 'logo', 'logoAspect', 'logoDark', 'coverFallbacks'];

export function buildIndex({ games, twins, features }) {
  const names = Object.fromEntries(NAMED.map((field) => [field, []]));
  const places = Object.fromEntries(NAMED.map((field) => [field, new Map()]));
  const place = (field, value) => {
    let at = places[field].get(value);
    if (at === undefined) {
      at = names[field].length;
      names[field].push(value);
      places[field].set(value, at);
    }
    return at;
  };
  const shards = [];
  let count = 0;
  const encode = (game) => {
    const out = {};
    for (const [key, value] of Object.entries(game)) {
      if (key === 'art') {
        const art = {};
        const lazy = {};
        let mask = 0;
        for (const [name, part] of Object.entries(value ?? {})) {
          const bit = LAZY_ART.indexOf(name);
          if (bit < 0) art[name] = part;
          else {
            lazy[name] = part;
            mask |= 1 << bit;
          }
        }
        if (mask) {
          const shard = Math.floor(count / SHARD);
          (shards[shard] ??= []).push(lazy);
          art.lazy = [shard, shards[shard].length - 1, mask];
          count++;
        }
        out.art = art;
      } else if (NAMED.includes(key) && value != null) {
        out[key] = Array.isArray(value) ? value.map((item) => place(key, item)) : place(key, value);
      } else out[key] = value;
    }
    return out;
  };
  const index = { version: 1, names, features, games: games.map(encode), twins: twins.map(encode) };
  return { index, shards };
}

// One game a line: the file reads in a diff, and parses as fast as a single line.
const jsonLines = (value, lists) => {
  const head = JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => !lists.includes(key))));
  const body = lists.map((key) => `${JSON.stringify(key)}: [\n${value[key].map((item) => JSON.stringify(item)).join(',\n')}\n]`);
  return `${head.slice(0, -1)},\n${body.join(',\n')}\n}\n`;
};

export function indexFiles(catalog) {
  const { index, shards } = buildIndex(catalog);
  const files = { 'index.json': jsonLines(index, ['games', 'twins']) };
  shards.forEach((shard, at) => {
    files[`art/${at}.json`] = `[\n${shard.map((item) => JSON.stringify(item)).join(',\n')}\n]\n`;
  });
  return files;
}

export async function readCatalog(file = path.join(repo, 'app/data/catalog.js')) {
  // A fresh copy: the module's arrays are shared with whoever imported it before.
  const { games, twins, features } = await import(`${pathToFileURL(file).href}?read=${Date.now()}`);
  return structuredClone({ games, twins, features });
}

export function writeIndex(files, dir = path.join(repo, 'app/data/catalog')) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'art'), { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = await readCatalog();
  const files = indexFiles(catalog);
  writeIndex(files);
  const bytes = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  console.log(`${catalog.games.length} games, ${catalog.twins.length} other editions: index.json ${Buffer.byteLength(files['index.json'])} bytes, ${Object.keys(files).length - 1} art files, ${bytes} bytes in all`);
  // glibren.47: com o catalogo, os pacotes dos links e das fichas (tools/catalog/data-pack.mjs).
  (await import('./data-pack.mjs')).writePacks();
}
