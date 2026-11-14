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
const images = [];
function walk(node) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(walk);
  const { type, props = {} } = node;
  if (typeof props.style === 'function') props.style({ focused: true, pressed: false });
  if (props.focusKey && props.onPress) pressable.set(props.focusKey, props);
  if (type === 'Video') videos.push(props);
  if (type === 'Image') images.push(props.source?.uri);
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
  images.length = 0;
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
// glibren-fast: um instante de foco num card resolve aquele video em segundo plano; sair dele cancela.
const asks = [];
const prefetching = { ...fake, prefetch: (id, options) => (asks.push(['prefetch', id, options.locale]), true), cancelPrefetch: (except) => asks.push(['cancel', except]) };
screen('Tube (results, prefetch on focus)', { type: TubeScreen, props: { query: 'ASTRO BOT trailer', service: prefetching, onBack() {}, start: { page: { state: 'ready', items, cursor: '', index: 0, error: '' } } } });
pressable.get('tube:item:normal00001').onFocus();
pressable.get('tube:item:normal00001').onBlur();
pressable.get('tube:item:normal00002').onFocus();
await new Promise((resolve) => setTimeout(resolve, 400));
assert.deepEqual(asks, [['cancel', ''], ['prefetch', 'normal00002', 'en']], 'passing by quickly asks nothing; staying resolves');
const loading = screen('Tube (searching)', { type: TubeScreen, props: { query: 'ASTRO BOT gameplay', service: fake, onBack() {}, start: { page: { state: 'loading', items: [], cursor: '', index: 0, error: '' } } } });
assert.ok(loading.includes('Searching…'), loading.join('|'));
const failed = screen('Tube (service failed)', { type: TubeScreen, props: { query: 'x', service: fake, onBack() {}, start: { page: { state: 'error', items: [], cursor: '', index: 0, error: 'timeout' } } } });
assert.ok(failed.includes('The video service didn\'t answer (timeout).') && failed.includes('Try again'), failed.join('|'));
const empty = screen('Tube (nothing found)', { type: TubeScreen, props: { query: 'zzzz', service: fake, onBack() {}, start: { page: { state: 'ready', items: [], cursor: '', index: 0, error: '' } } } });
assert.ok(empty.includes('No videos found for "zzzz".'), empty.join('|'));

// The player: the screen with a video open is the player.
const playing = screen('Tube (a video open)', { type: TubeScreen, props: { query: 'x', service: fake, onBack() {}, start: { page: { state: 'ready', items, cursor: '', index: 0, error: '' }, playing: { item: items[0], back: false } } } });
assert.ok(playing.includes('Loading the video…'), playing.join('|'));
// glibren-fast: o player abre na hora, em "carregando": a miniatura do video, o indicador e o titulo; sem <Video> ainda.
assert.ok(playing.includes('ASTRO BOT - Launch Trailer | PS5 Games'), playing.join('|'));
assert.deepEqual(images, ['https://i.ytimg.com/vi/normal00001/mqdefault.jpg'], 'the thumbnail the list showed');
assert.equal(videos.length, 0);
const { TubePlayer } = await load('app/tube/TubePlayer.jsx');
const m = (name) => `http://127.0.0.1:34210/media/s/${name}`;
const info = { title: 'ASTRO BOT - Launch Trailer', channel: 'PlayStation', duration: 125,
  choices: [{ label: '1080p H264 / AAC', height: 1080, url: m('v0.m3u8'), hls: true }, { label: '720p H264 / AAC', height: 720, url: m('v1.m3u8'), hls: true }],
  caption: { uri: `${m('c0.srt')}?format=vtt`, language: 'en', title: 'English' } };
// glibren-fast: resolvido, o <Video> ja abrindo por baixo e o "carregando" (miniatura) por cima ate o primeiro quadro.
const opening = screen('Player (resolved, opening: waiting for the first frame)', { type: TubePlayer, props: { item: items[0], service: fake, onClose() {}, start: { info, choice: 0, phase: 'opening' } } });
assert.ok(opening.includes('Loading the video…') && opening.includes('ASTRO BOT - Launch Trailer'), opening.join('|'));
assert.equal(videos.length, 1, 'the player is already opening the stream');
assert.equal(videos[0].source, m('v0.m3u8'));
assert.equal(typeof videos[0].onLoad, 'function');
assert.ok(images.includes('https://i.ytimg.com/vi/normal00001/mqdefault.jpg'), 'the thumbnail over it');
const player = screen('Player (playing, 1080p)', { type: TubePlayer, props: { item: items[0], service: fake, onClose() {}, start: { info, choice: 0, phase: 'playing' } } });
for (const label of ['ASTRO BOT - Launch Trailer', 'PlayStation  ·  1080p H264 / AAC', '0:00', '2:05', 'Pause / Play', '-10 s / +10 s', 'Subtitles', 'Quality', 'Close']) {
  assert.ok(player.includes(label), `${label}: ${player.join('|')}`);
}
assert.equal(videos.length, 1);
assert.equal(videos[0].source, m('v0.m3u8'), 'the master HLS of the chosen quality, a plain URL (no headers)');
assert.deepEqual(videos[0].subtitles, [info.caption], 'WebVTT from the service');
assert.equal(videos[0].subtitleTrack, -1, 'subtitles off by default');
assert.ok(!player.includes('Loading the video…') && images.length === 0, 'playing: no loading cover');
// glibren.55: o R2 com o formato: a linha Automatico (prefere H.264) e o aviso das VP9 (quebra linha, sem reticencias).
const formats = { ...info, choices: [
  { label: '1440p 60 fps VP9 / OPUS', height: 1440, codec: 'vp9', family: 'vp9', hdr: false, url: m('v0.m3u8'), hls: true },
  { label: '1080p 60 fps H264 / AAC', height: 1080, codec: 'h264', family: 'h264', hdr: false, url: m('v1.m3u8'), hls: true },
  { label: '1080p 60 fps VP9 / OPUS', height: 1080, codec: 'vp9', family: 'vp9', hdr: false, url: m('v2.m3u8'), hls: true },
  { label: '1080p 60 fps VP9 / OPUS HDR10', height: 1080, codec: 'vp9', family: 'vp9', hdr: true, url: m('v3.m3u8'), hls: true }
] };
const menuShown = screen('Player (R2: quality and format)', { type: TubePlayer, props: { item: items[0], service: fake, onClose() {}, start: { info: formats, choice: 1, phase: 'playing', menu: true } } });
for (const label of ['Quality', 'Automatic (prefers H.264, the smoothest on the PS5)', '1440p 60 fps VP9 / OPUS', 'Only VP9 at this resolution: may stutter.',
  '1080p 60 fps H264 / AAC', '1080p 60 fps VP9 / OPUS', 'VP9: may stutter on the PS5. H.264 is the most stable.', 'May stutter: decoded by the processor (VP9 HDR).']) {
  assert.ok(menuShown.includes(label), `${label}: ${menuShown.join('|')}`);
}
assert.ok(!menuShown.some((line) => line.includes('…')), 'no ellipsis');
assert.ok(pressable.has('tube:quality:auto') && pressable.has('tube:quality:1080p 60 fps VP9 / OPUS'));
const broken = screen('Player (failed)', { type: TubePlayer, props: { item: items[0], service: fake, onClose() {}, start: { info: null, choice: -1, phase: 'failed', problem: 'unsupported_media' } } });
assert.ok(broken.includes('This video didn\'t play (unsupported_media).'), broken.join('|'));
assert.equal(videos.length, 0);
// glibren.42: a video that asks for an account says where to sign in (with a service that can), or that this one can't;
// an expired sign-in and a refusal say so; a video opened through the account says it.
const withAccount = { ...fake, hasAccount: () => true };
const needs = screen('Player (needs sign-in)', { type: TubePlayer, props: { item: items[0], service: withAccount, onClose() {}, start: { info: null, choice: -1, phase: 'failed', problem: 'authentication_required' } } });
assert.ok(needs.includes('This video asks you to sign in. Sign in under Settings > Videos.'), needs.join('|'));
const needsOld = screen('Player (needs sign-in, old service)', { type: TubePlayer, props: { item: items[0], service: fake, onClose() {}, start: { info: null, choice: -1, phase: 'failed', problem: 'authentication_required' } } });
assert.ok(needsOld.some((line) => /can't do that yet/.test(line)), needsOld.join('|'));
const expired = screen('Player (account expired)', { type: TubePlayer, props: { item: items[0], service: withAccount, onClose() {}, start: { info: null, choice: -1, phase: 'failed', problem: 'account_expired' } } });
assert.ok(expired.some((line) => /sign-in expired/.test(line)), expired.join('|'));
const refusedVideo = screen('Player (account not allowed)', { type: TubePlayer, props: { item: items[0], service: withAccount, onClose() {}, start: { info: null, choice: -1, phase: 'failed', problem: 'account_not_allowed' } } });
assert.ok(refusedVideo.some((line) => /Not even your YouTube account/.test(line)), refusedVideo.join('|'));
// glibren.44: a Google account without its age confirmed; codes with a suffix (service 0.2.2) keep their own text by
// the start, and the generic one shows the whole code.
const ageCheck = screen('Player (account age not confirmed)', { type: TubePlayer, props: { item: items[0], service: withAccount, onClose() {}, start: { info: null, choice: -1, phase: 'failed', problem: 'account_age_unverified' } } });
assert.ok(ageCheck.includes('Your Google account needs to confirm its age on youtube.com to watch this video.'), ageCheck.join('|'));
const suffixed = screen('Player (code with a suffix)', { type: TubePlayer, props: { item: items[0], service: withAccount, onClose() {}, start: { info: null, choice: -1, phase: 'failed', problem: 'extraction_failed: HTTP 400 INVALID_ARGUMENT (the request was refused by the player)' } } });
assert.ok(suffixed.includes('This video didn\'t play (extraction_failed: HTTP 400 INVALID_ARGUMENT (the request was refused by the player)).'), suffixed.join('|'));
const { problemText } = await load('app/tube/TubePlayer.jsx');
const t2 = (key, values) => (values ? `${key}:${JSON.stringify(values)}` : key);
assert.equal(problemText(t2, 'account_age_unverified: AGE_CHECK_REQUIRED', true), 'tube.accountAgeUnverified');
assert.equal(problemText(t2, 'authentication_required: LOGIN_REQUIRED', false), 'tube.needsSignInOld');
assert.equal(problemText(t2, 'authentication_requiredX', true), 'tube.playFailed:{"error":"authentication_requiredX"}', 'only the code or the code and a suffix');
// glibren.44: the player's retry: a video that asks for an account on an old service with a newer one ready swaps the
// service (upgradeNow) and plays, once per video; anything else fails as before.
{
  const { resolveWithUpgrade } = await load('app/tube/TubePlayer.jsx');
  const needs = Object.assign(new Error('needs'), { code: 'authentication_required' });
  const fake = (extra) => ({ hasAccount: () => false, newerReady: () => '0.2.1', cancelPrefetch() { this.cancelled = (this.cancelled ?? 0) + 1; }, upgradeNow: async () => { fake.swaps++; return { ok: true, version: '0.2.1', upgraded: true }; }, ...extra });
  fake.swaps = 0;
  // 1) antigo + novo pronto: troca e o segundo resolve toca.
  let tries = 0;
  const service = fake();
  const state = { upgraded: false };
  const info = await resolveWithUpgrade(service, async () => { if (++tries === 1) throw needs; return { title: 'ok' }; }, { state });
  assert.deepEqual(info, { title: 'ok' });
  assert.equal(tries, 2);
  assert.equal(fake.swaps, 1);
  assert.equal(service.cancelled, 1, 'the prefetches go first (a job running would hold the swap)');
  // 2) uma vez so: o mesmo video pedindo login de novo mostra o erro.
  await assert.rejects(resolveWithUpgrade(service, async () => { throw needs; }, { state }), { code: 'authentication_required' });
  assert.equal(fake.swaps, 1);
  // 3) servico com a conta, nada novo pronto, troca recusada, outro erro, player fechado: o erro como antes.
  for (const [extra, stopped, error] of [[{ hasAccount: () => true }, false, needs], [{ newerReady: () => null }, false, needs], [{ upgradeNow: async () => ({ ok: false, reason: 'busy' }) }, false, needs],
    [{}, false, Object.assign(new Error('x'), { code: 'extraction_failed: UNPLAYABLE' })], [{}, true, needs]]) {
    let calls = 0;
    await assert.rejects(resolveWithUpgrade(fake(extra), async () => { calls++; throw error; }, { state: { upgraded: false }, stopped: () => stopped }), { code: error.code });
    assert.equal(calls, 1);
  }
}
const throughAccount = screen('Player (playing through the account)', { type: TubePlayer, props: { item: items[0], service: withAccount, onClose() {}, start: { info: { ...info, signedIn: true }, choice: 0, phase: 'playing' } } });
assert.ok(throughAccount.includes('PlayStation  ·  1080p H264 / AAC  ·  through your account'), throughAccount.join('|'));
console.log('\nOK: YouTube inside the app (sheet, results, player)');

// glibren.42: the YouTube account in Settings > Videos (ui/TubeAccount.jsx); the walker runs no effects, so each state
// is drawn from `start`.
const { TubeAccountRows, TubeRevertRow, offeredBy } = await load('app/ui/TubeAccount.jsx');
const account = (extra) => ({ isReady: () => true, hasAccount: () => true, ensure: async () => ({ ok: true }), account: async () => ({ signedIn: false, name: '', pending: false }), hold: () => () => {}, ...extra });
assert.equal(offeredBy(account({ hasAccount: () => false }), null), 'no', 'a service up without the feature');
assert.equal(offeredBy({ isReady: () => false }, { source: 'embedded', version: '0.1.0' }), 'no', 'an older one would start');
assert.equal(offeredBy({ isReady: () => false }, { source: 'embedded', version: '0.2.0' }), 'unknown');
// glibren.44: an older service no longer hides the row: it says which version can't sign in and, with a newer one ready,
// offers "Update the service now"; without one, says so.
const oldRow = screen('Settings (old service, newer ready)', { type: TubeAccountRows, props: { service: account({ hasAccount: () => false, runningVersion: () => '0.1.0', newerReady: () => '0.2.1' }) } });
for (const label of ['YouTube account', 'The YouTube service in use (0.1.0) can\'t sign in to an account yet.', 'Update the service now', 'Version 0.2.1 is ready. After the update, the sign-in shows here.']) assert.ok(oldRow.includes(label), `${label}: ${oldRow.join('|')}`);
assert.ok(pressable.has('settings:tubeAccountUpdate') && pressable.has('settings:tubeAccount'));
const oldNone = screen('Settings (old service, nothing newer)', { type: TubeAccountRows, props: { service: account({ hasAccount: () => false, runningVersion: () => '0.1.0', newerReady: () => null }) } });
assert.ok(oldNone.includes('The YouTube service in use (0.1.0) can\'t sign in to an account yet. No newer version of the service is available yet.'), oldNone.join('|'));
assert.ok(!pressable.has('settings:tubeAccountUpdate'));
const oldIdle = screen('Settings (old service not up, Settings knows its version)', { type: TubeAccountRows, props: { service: { isReady: () => false, newerReady: (v) => (v === '0.1.0' ? '0.2.1' : null) }, info: { source: 'embedded', version: '0.1.0' } } });
assert.ok(oldIdle.includes('Update the service now'), oldIdle.join('|'));
const unknown = screen('Settings (service not up yet)', { type: TubeAccountRows, props: { service: { isReady: () => false }, info: null } });
assert.ok(unknown.includes('YouTube account') && unknown.includes('Press to check'), unknown.join('|'));
assert.ok(pressable.has('settings:tubeAccount'));
const out = screen('Settings (signed out)', { type: TubeAccountRows, props: { service: account(), start: { state: 'out' } } });
assert.ok(out.includes('Sign in to your YouTube account'), out.join('|'));
const code = screen('Settings (sign-in code)', { type: TubeAccountRows, props: { service: account(), start: { state: 'code', code: { code: 'ABC-DEF-GHI', url: 'https://www.google.com/device', expiresIn: 1800, interval: 5 } } } });
for (const label of ['On your phone or computer, open https://www.google.com/device and enter this code:', 'ABC-DEF-GHI', 'Waiting for you to confirm (the code is valid for 30 min)…', 'Cancel']) assert.ok(code.includes(label), `${label}: ${code.join('|')}`);
const signedIn = screen('Settings (signed in)', { type: TubeAccountRows, props: { service: account(), start: { state: 'in', name: 'PristMC' } } });
assert.ok(signedIn.includes('Connected: PristMC') && signedIn.includes('Sign out'), signedIn.join('|'));
assert.ok(pressable.has('settings:tubeAccountSignOut'));
const updater = (ahead) => ({ aheadOfEmbedded: () => ahead, subscribe: () => () => {}, revertToEmbedded: () => ['0.3.0'], candidates: () => [{ source: 'embedded', version: '0.2.0' }] });
assert.equal(screen('Settings (no downloaded service ahead)', { type: TubeRevertRow, props: { updater: updater(false), service: {} } }).length, 0);
const revert = screen('Settings (downloaded service ahead)', { type: TubeRevertRow, props: { updater: updater(true), service: {} } });
assert.ok(revert.includes('Back to the built-in version'), revert.join('|'));
console.log('\nOK: YouTube account rows and "Back to the built-in version"');


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
