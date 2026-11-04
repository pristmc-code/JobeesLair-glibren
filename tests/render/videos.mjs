// "Videos" on a game's page: the button beside Favorite, and its sheet with a YouTube app installed (two searches,
// gameplay and trailer) and without one (how to get one). Fails on any exception. Run: npm run test:render
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.screen = { width: 1920, height: 1080 };
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const en = (await load('app/i18n/locales/en.json')).default;
(await load('app/i18n/core.js')).configure(() => en, en);
const { games } = await load('app/data/catalog.js');
const { getGame } = await load('app/state/catalog.js');
const game = games.map((entry) => getGame(entry.id)).find(Boolean);

let paths = new Set();
const fs = {
  exists: (p) => paths.has(p),
  stat: (p) => paths.has(p) ? { name: p, isDirectory: false, isFile: true, size: 0, modified: 0, device: '1', inode: '1' } : null,
  readDir: () => [], readFile: () => { throw new Error('ENOENT'); },
  writeFile() {}, mkdir() {}, rename() {}, remove() {},
};
globalThis.__fake = { jobs: [], fs, focused: true, queue: { snapshot: () => [], subscribe: () => () => {} }, drives: { roots: ['/data'], ready: true, usage: {} } };

const SKIP = new Set(['BackLink', 'DownloadButton', 'ReadyPill', 'Backdrop', 'GameLogo', 'Cover']);
const texts = [];
const pressable = new Map();
function walk(node) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(walk);
  const { type, props = {} } = node;
  if (typeof props.style === 'function') props.style({ focused: true, pressed: false });
  if (props.focusKey && props.onPress) pressable.set(props.focusKey, props);
  // The page's other parts need the navigation and the queue (smoke.mjs and links.mjs cover them).
  if (typeof type === 'function' && SKIP.has(type.name)) return;
  if (typeof type === 'function') return walk(type(props));
  if (type === 'Text') {
    const children = [props.children].flat().filter((child) => typeof child === 'string' || typeof child === 'number');
    if (children.length) texts.push(children.join(''));
    return;
  }
  walk(props.children);
}
const screen = (name, element) => {
  texts.length = 0;
  walk(element);
  console.log(`--- ${name}\n${[...new Set(texts)].join('\n')}`);
  return [...texts];
};

const { GameHero } = await load('app/game/GameHero.jsx');
const asked = [];
const hero = screen(`Game page (${game.title})`, { type: GameHero, props: { game, onBack() {}, onDownloaded() {}, onRequestDialog: (dialog) => asked.push(dialog) } });
assert.ok(hero.includes('Videos'), hero.join('|'));
pressable.get(`videos:${game.id}`).onPress();
assert.deepEqual(asked, [{ kind: 'videos', title: game.title, from: `videos:${game.id}` }], 'the button opens the sheet, for this game');

const { VideosSheet } = await load('app/game/VideosSheet.jsx');
const none = screen('Videos (no YouTube app)', { type: VideosSheet, props: { title: game.title, onClose() {} } });
assert.ok(none.includes('No homebrew YouTube app is installed.'), none.join('|'));
assert.ok(none.some((text) => /ytps5 \(PPSA99350\)/.test(text)) && none.some((text) => /never opened/.test(text)), none.join('|'));

paths = new Set(['/data/homebrew/PPSA99991/eboot.bin']);
const maxd = screen("Videos (YouTube Max'd)", { type: VideosSheet, props: { title: 'ASTRO BOT™', onClose() {} } });
assert.ok(maxd.includes('Gameplay') && maxd.includes('Trailer'), maxd.join('|'));
assert.ok(maxd.includes('Searches "ASTRO BOT gameplay" in YouTube Max\'d'), maxd.join('|'));
paths = new Set(['/data/homebrew/PPSA99350/eboot.bin', '/data/homebrew/PPSA99991/eboot.bin']);
const both = screen('Videos (both installed)', { type: VideosSheet, props: { title: 'ASTRO BOT', onClose() {} } });
assert.ok(both.includes('Searches "ASTRO BOT trailer" in ytps5'), 'ytps5 first');
console.log('\nOK: Videos button and sheet');
