// glibren-tube: YouTube inside Jobee'sLair. The Videos sheet with the service payload in the package (searches here,
// even with no video app), the "tube" screen's results (search, filters, cards with title, channel and duration,
// pages) and its loading/error states, and the player (the HLS link, the subtitles as WebVTT, the hints). Fails on any
// exception. glibren-a: and the screen opened by glibren (Back to glibren, Circle at the root, the service down).
// Run: npm run test:render
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.screen = { width: 1920, height: 1080 };
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const en = (await load('app/i18n/locales/en.json')).default;
(await load('app/i18n/core.js')).configure(() => en, en);

let paths = new Set();
const fs = {
  exists: (p) => paths.has(p),
  stat: (p) => paths.has(p) ? { name: p, isDirectory: false, isFile: true, size: 0, modified: 0, device: '1', inode: '1' } : null,
  readDir: () => [], readFile: () => { throw new Error('ENOENT'); },
  writeFile() {}, mkdir() {}, rename() {}, remove() {},
};
globalThis.__fake = { jobs: [], fs, focused: true, queue: { snapshot: () => [], subscribe: () => () => {} }, drives: { roots: ['/data'], ready: true, usage: {} } };

const texts = [];
const pressable = new Map();
const videos = [];
const backs = [];
const players = [];
function walk(node) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(walk);
  const { type, props = {} } = node;
  if (typeof props.style === 'function') props.style({ focused: true, pressed: false });
  if (props.focusKey && props.onPress) pressable.set(props.focusKey, props);
  if (type === 'Video') videos.push(props);
  if (type === 'FocusScope' && props.onBack) backs.push(props.onBack);
  if (typeof type === 'function' && type.name === 'TubePlayer') players.push(props);
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
  videos.length = 0;
  backs.length = 0;
  players.length = 0;
  pressable.clear();
  walk(element);
  console.log(`--- ${name}\n${[...new Set(texts)].join('\n')}`);
  return [...texts];
};

// The Videos sheet: with tube-service.elf in the package the videos are searched here, even without ytps5/Max'd.
const { VideosSheet } = await load('app/game/VideosSheet.jsx');
const { setTubeService, createTubeService } = await load('app/state/tube-service.js');
setTubeService(createTubeService({ http: {}, fs, payloads: null, platform: 'desktop', log: () => {} }));
paths = new Set(['/app0/tube-service.elf']);
const here = screen('Videos (tube-service.elf in the package, no video app)', { type: VideosSheet, props: { title: 'ASTRO BOT™', from: 'videos:x', onClose() {} } });
assert.ok(here.includes('Gameplay') && here.includes('Trailer'), here.join('|'));
assert.ok(here.includes('Searches "ASTRO BOT trailer" here in Jobee\'sLair'), here.join('|'));
assert.ok(!here.includes('No homebrew YouTube app is installed.'), 'not the "install an app" note');
paths = new Set(['/data/homebrew/PPSA99991/eboot.bin']);
const old = screen('Videos (no tube-service.elf: the video app, as before)', { type: VideosSheet, props: { title: 'ASTRO BOT', onClose() {} } });
assert.ok(old.includes('Searches "ASTRO BOT gameplay" in YouTube Max\'d'), old.join('|'));
paths = new Set();
const none = screen('Videos (neither)', { type: VideosSheet, props: { title: 'ASTRO BOT', onClose() {} } });
assert.ok(none.includes('No homebrew YouTube app is installed.'), none.join('|'));

// The results screen: one page.
const { TubeScreen } = await load('app/tube/TubeScreen.jsx');
const fake = { search: async () => ({ items: [], cursor: '' }), more: async () => ({ items: [], cursor: '' }), resolve: async () => ({}), sponsor: async () => [] };
const items = [
  { id: 'normal00001', title: 'ASTRO BOT - Launch Trailer | PS5 Games', channel: 'PlayStation', seconds: 125, live: false, short: false, upcoming: false },
  { id: 'livelive001', title: 'ASTRO BOT live', channel: 'Streamer', seconds: 0, live: true, short: false, upcoming: false },
  { id: 'shortshort1', title: 'Tiny bot', channel: 'Shorts guy', seconds: 40, live: false, short: true, upcoming: false },
  { id: 'later000001', title: 'Premiere', channel: 'Studio', seconds: 0, live: false, short: false, upcoming: true },
  { id: 'normal00002', title: 'Second video', channel: 'Other', seconds: 3723, live: false, short: false, upcoming: false }
];
const results = screen('Tube (results, page 2)', { type: TubeScreen, props: { query: 'ASTRO BOT trailer', service: fake, onBack() {}, start: { page: { state: 'ready', items, cursor: 'next-cursor', index: 1, error: '' } } } });
for (const label of ['ASTRO BOT trailer', 'Results for "ASTRO BOT trailer"', 'Relevance', 'Any length', 'Any date', 'Videos',
  'ASTRO BOT - Launch Trailer | PS5 Games', 'PlayStation', '2:05', '1:02:03', 'LIVE', 'Short', 'Upcoming', 'Previous page', 'Page 2', 'Next page']) {
  assert.ok(results.includes(label), `${label}: ${results.join('|')}`);
}
for (const key of ['tube:field', 'tube:filter:order', 'tube:filter:duration', 'tube:filter:upload_date', 'tube:filter:type', 'tube:item:normal00001', 'tube:item:normal00002', 'tube:page:next', 'tube:page:previous']) {
  assert.ok(pressable.has(key), key);
}
const loading = screen('Tube (searching)', { type: TubeScreen, props: { query: 'ASTRO BOT gameplay', service: fake, onBack() {}, start: { page: { state: 'loading', items: [], cursor: '', index: 0, error: '' } } } });
assert.ok(loading.includes('Searching…'), loading.join('|'));
const failed = screen('Tube (service failed)', { type: TubeScreen, props: { query: 'x', service: fake, onBack() {}, start: { page: { state: 'error', items: [], cursor: '', index: 0, error: 'timeout' } } } });
assert.ok(failed.includes('The video service didn\'t answer (timeout).') && failed.includes('Try again'), failed.join('|'));
const empty = screen('Tube (nothing found)', { type: TubeScreen, props: { query: 'zzzz', service: fake, onBack() {}, start: { page: { state: 'ready', items: [], cursor: '', index: 0, error: '' } } } });
assert.ok(empty.includes('No videos found for "zzzz".'), empty.join('|'));

// The player: the screen with a video open is the player.
const playing = screen('Tube (a video open)', { type: TubeScreen, props: { query: 'x', service: fake, onBack() {}, start: { page: { state: 'ready', items, cursor: '', index: 0, error: '' }, playing: { item: items[0], back: false } } } });
assert.ok(playing.includes('Loading the video…'), playing.join('|'));
const { TubePlayer } = await load('app/tube/TubePlayer.jsx');
const m = (name) => `http://127.0.0.1:34210/media/s/${name}`;
const info = { title: 'ASTRO BOT - Launch Trailer', channel: 'PlayStation', duration: 125,
  choices: [{ label: '1080p H264 / AAC', height: 1080, url: m('v0.m3u8'), hls: true }, { label: '720p H264 / AAC', height: 720, url: m('v1.m3u8'), hls: true }],
  caption: { uri: `${m('c0.srt')}?format=vtt`, language: 'en', title: 'English' } };
const player = screen('Player (playing, 1080p)', { type: TubePlayer, props: { item: items[0], service: fake, onClose() {}, start: { info, choice: 0, phase: 'playing' } } });
for (const label of ['ASTRO BOT - Launch Trailer', 'PlayStation  ·  1080p H264 / AAC', '0:00', '2:05', 'Pause / Play', '-10 s / +10 s', 'Subtitles', 'Quality', 'Close']) {
  assert.ok(player.includes(label), `${label}: ${player.join('|')}`);
}
assert.equal(videos.length, 1);
assert.equal(videos[0].source, m('v0.m3u8'), 'the master HLS of the chosen quality, a plain URL (no headers)');
assert.deepEqual(videos[0].subtitles, [info.caption], 'WebVTT from the service');
assert.equal(videos[0].subtitleTrack, -1, 'subtitles off by default');
const broken = screen('Player (failed)', { type: TubePlayer, props: { item: items[0], service: fake, onClose() {}, start: { info: null, choice: -1, phase: 'failed', problem: 'unsupported_media' } } });
assert.ok(broken.includes('This video didn\'t play (unsupported_media).'), broken.join('|'));
assert.equal(videos.length, 0);
console.log('\nOK: YouTube inside the app (sheet, results, player)');

// glibren-a: aberta pelo pedido do glibren (state/tube-request.js) com voltar=: o botao "Back to glibren" no topo, e o
// Circulo na raiz (e ao fechar o video do modo auto) pede a volta (goBack -> POST /switch); sem voltar=, onBack.
const asked = [];
const goBack = async (to) => { asked.push(to); return { ok: true }; };
let popped = 0;
const pop = () => { popped += 1; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const fromGlibren = screen('Tube (opened by glibren, results)', { type: TubeScreen, props: { query: 'gta trailer', back: 'PMGL00001', ensure: true, goBack, service: fake, onBack: pop, start: { page: { state: 'ready', items, cursor: '', index: 0, error: '' } } } });
assert.ok(fromGlibren.includes('Back to glibren'), fromGlibren.join('|'));
assert.ok(pressable.has('tube:page:glibren'), 'the button at the top');
assert.equal(backs.length, 1);
assert.equal(backs[0](), true);
await tick();
assert.deepEqual(asked, ['PMGL00001'], 'Circle at the root asks to go back to glibren');
assert.equal(popped, 0, 'not to the start of Jobee\'sLair');
backs[0]();
await tick();
assert.deepEqual(asked, ['PMGL00001'], 'once: a second Circle while leaving does nothing');
screen('Tube (opened by glibren, again)', { type: TubeScreen, props: { query: 'gta trailer', back: 'PMGL00001', goBack, service: fake, onBack: pop, start: { page: { state: 'ready', items, cursor: '', index: 0, error: '' } } } });
pressable.get('tube:page:glibren').onPress();
await tick();
assert.deepEqual(asked, ['PMGL00001', 'PMGL00001'], 'the top button too');
const refused = screen('Tube (opened by glibren, the switch refused)', { type: TubeScreen, props: { query: 'gta', back: 'PMGL00001', goBack: async () => ({ ok: false, error: 'HTTP 409' }), service: fake, onBack: pop, start: { page: { state: 'ready', items, cursor: '', index: 0, error: '' } } } });
assert.ok(refused.includes('Back to glibren'));
backs[0]();
await new Promise((resolve) => setTimeout(resolve, 2700));
assert.equal(popped, 1, 'refused: a short notice, then the start of Jobee\'sLair');
popped = 0;

const normal = screen('Tube (from the Videos sheet: no glibren)', { type: TubeScreen, props: { query: 'gta', goBack, service: fake, onBack: pop, start: { page: { state: 'ready', items, cursor: '', index: 0, error: '' } } } });
assert.ok(!normal.includes('Back to glibren') && !pressable.has('tube:page:glibren'), normal.join('|'));
backs[0]();
await tick();
assert.equal(popped, 1, 'Circle goes back as before');
assert.equal(asked.length, 2);

const auto = screen('Tube (opened by glibren with auto=1: the video playing)', { type: TubeScreen, props: { query: 'gta', auto: true, back: 'PMGL00001', goBack, service: fake, onBack: pop, start: { page: { state: 'ready', items, cursor: '', index: 0, error: '' }, playing: { item: items[0], back: true } } } });
assert.ok(auto.includes('Loading the video…'), auto.join('|'));
assert.equal(players.length, 1);
players[0].onClose();
await tick();
assert.deepEqual(asked.slice(2), ['PMGL00001'], 'closing the auto video goes back to glibren');

const starting = screen('Tube (opened by glibren, starting the service)', { type: TubeScreen, props: { query: 'gta', back: 'PMGL00001', ensure: true, goBack, service: fake, onBack: pop } });
assert.ok(starting.includes('Starting the video service…') && starting.includes('Back to glibren'), starting.join('|'));
const down = screen('Tube (opened by glibren, the service did not start)', { type: TubeScreen, props: { query: 'gta', back: 'PMGL00001', ensure: true, goBack, service: fake, onBack: pop, start: { page: { state: 'down', items: [], cursor: '', index: 0, error: 'missing: tube-service.elf' } } } });
assert.ok(down.includes('The video service didn\'t start (missing: tube-service.elf).') && down.includes('Back to glibren') && down.includes('Try again'), down.join('|'));
assert.ok(pressable.has('tube:page:glibren-down') && pressable.has('tube:page:retry'));
const leaving = screen('Tube (going back to glibren)', { type: TubeScreen, props: { query: 'gta', back: 'PMGL00001', goBack, service: fake, onBack: pop, start: { leaving: { text: 'Going back to glibren…' } } } });
assert.ok(leaving.includes('Going back to glibren…'), leaving.join('|'));
console.log('\nOK: opened by glibren (Back to glibren, Circle, service down)');
