// Renders the beta 4 screens once each, every function component and style function called, against a
// library with games in every state (moving, a stopped move, won't start, kept, on USB, untracked), play
// time, ShadowMount's health and a Make Room run. Fails on any exception and prints what the screens say.
// Run: npm run test:render
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

globalThis.screen = { width: 1920, height: 1080 };
const repo = process.env.JL_REPO || fileURLToPath(new URL('../..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const en = (await load('app/i18n/locales/en.json')).default;
(await load('app/i18n/core.js')).configure(() => en, en);
const { games } = await load('app/data/catalog-index.js');
const { getGame } = await load('app/state/catalog.js');
const picks = games.slice(0, 60).map((game) => getGame(game.id)).filter(Boolean).slice(0, 6);
assert.equal(picks.length, 6, 'six catalog games');
const GB = 1e9;
const now = Date.now();

const nodes = new Map();
const file = (p, size) => nodes.set(p, { size });
const dir = (p) => nodes.set(p, { dir: true });
for (const p of ['/data', '/data/homebrew', '/data/homebrew/backports', '/data/downloads', '/data/downloads/images', '/mnt/usb0', '/mnt/usb0/homebrew']) dir(p);
file('/data/homebrew/FTP Game PPSA05555.exfat', 12 * GB);
dir('/data/homebrew/backports/PPSA07777');
file('/data/downloads/images/Old.exfat.part', 3 * GB);
// 0.5.2: three announcements up, as online.json has them from the last launch (state/online.js).
const ONLINE = JSON.stringify({ notes: [
  { id: 3, text: 'Do not update ShadowMount yet', level: 'warning', until: null },
  { id: 2, text: 'Fix it is in 0.5.2', level: 'info', until: null },
  { id: 1, text: '0.5.2 is out. Update from Settings, About.', level: 'info', until: null }
] });
const fs = {
  exists: (p) => nodes.has(p) || p.endsWith('/online.json'),
  stat: (p) => nodes.has(p) ? { name: p.slice(p.lastIndexOf('/') + 1), isDirectory: !!nodes.get(p).dir, isFile: !nodes.get(p).dir, size: nodes.get(p).size ?? 0, modified: now - 40 * 864e5, device: '1', inode: '2' } : null,
  readDir: (p) => {
    if (!nodes.get(p)?.dir) throw new Error(`ENOENT ${p}`);
    return [...nodes.keys()].filter((k) => k !== p && k.slice(0, k.lastIndexOf('/')) === p).map(fs.stat);
  },
  readFile: (p) => { if (p.endsWith('/online.json')) return ONLINE; throw new Error('ENOENT'); },
  writeFile() {}, mkdir() {}, rename() {}, remove() {},
  removeAsync: async () => {},
  diskUsage: () => ({ total: 667 * GB, free: 40 * GB }),
  diskUsageAsync: async () => ({ total: 667 * GB, free: 40 * GB }),
};
const artifact = (root, name) => ({ destination: `${root}/homebrew/${name}.exfat`, images: [`${root}/homebrew/${name}.exfat`], nextAction: 'shadowmount' });
const job = (game, state, extra = {}) => ({ id: `${game.id}/r`, gameId: game.id, titleId: game.titleId || game.id, title: game.title, role: 'game', release: { id: 'r', url: 'https://example.com' }, root: '/data', artifact: artifact(extra.root ?? '/data', game.id), state, written: 20 * GB, total: 20 * GB, error: '', message: '', launch: null, ...extra });
const [a, b, c, d, e, f] = picks;
const jobs = [
  job(a, 'installed', { launch: { outcome: 'played', verdict: 'ran' } }),
  job(b, 'installed', { moving: { to: '/mnt/usb0', total: 20 * GB, written: 9 * GB, at: now } }),
  job(c, 'installed', { moving: { to: '/mnt/usb0', total: 20 * GB, written: 0, interrupted: true, error: 'write the copy: Input/output error' } }),
  job(d, 'downloaded', { root: '/mnt/usb0' }),
  job(e, 'installed', { launch: { outcome: 'wontStart', verdict: 'notStarted' } }),
  job(f, 'downloading', { written: 3 * GB }),
];
const calls = [];
const queue = new Proxy({ snapshot: () => jobs, subscribe: () => () => {}, quietNetwork: (reason, work) => work(), transferring: () => false }, {
  get: (target, key) => key in target ? target[key] : (...args) => (calls.push([key, ...args]), Promise.resolve({ note: null })),
});
globalThis.__fake = { jobs, fs, queue, focused: true, drives: { roots: ['/data', '/mnt/usb0'], ready: true, usage: { '/data': { total: 667 * GB, free: 40 * GB }, '/mnt/usb0': { total: 2000 * GB, free: 900 * GB } } } };

const { createPlaytime, playtimeStore } = await load('app/state/playtime.js');
const memory = { ...fs, exists: () => false };
const store = playtimeStore(() => createPlaytime({ fs: memory, file: '/x/playtime.json', log: () => {} }));
const title = a.titleId || a.id;
store.learn(`[10:00:00]   [GAME] started: ${title} pid=5 app_id=0x1\n[12:00:00]   [GAME] process exited, awaiting same-app handoff: ${title} pid=5 app_id=0x1\n`);
const { createMountMonitor, mountMonitor } = await load('app/state/mount-monitor.js');
const monitor = mountMonitor(() => createMountMonitor({ fs, log: () => {}, client: { background: async (route) => route === 'images' ? { images: [] } : { games: [{ title_id: e.titleId || e.id, path: '/data/homebrew/missing.exfat', source_type: 'image', managed: true }] } } }));
await monitor.refresh();

const texts = [];
let rendered = 0;
function walk(node) {
  if (node == null || typeof node !== 'object') {
    if (typeof node === 'string' && node.trim()) texts.push(node);
    return;
  }
  if (Array.isArray(node)) return node.forEach(walk);
  const { type, props = {} } = node;
  if (typeof props.style === 'function') props.style({ focused: true, pressed: false });
  if (typeof type === 'function') {
    rendered++;
    return walk(type(props));
  }
  if (type === 'Text') {
    const children = [props.children].flat().filter((child) => typeof child === 'string' || typeof child === 'number');
    if (children.length) texts.push(children.join(''));
    return;
  }
  walk(props.children);
}
const screen = async (name, element) => {
  texts.length = 0;
  walk(element);
  console.log(`--- ${name} (${rendered} components so far)\n${[...new Set(texts)].join('\n')}`);
  return [...texts];
};

const { LibraryScreen } = await load('app/library/LibraryScreen.jsx');
const library = await screen('Library', { type: LibraryScreen, props: { onBack() {}, onOpenGame() {} } });
assert.ok(library.some((text) => /Moving to USB drive 1 · 45/.test(text)), 'a moving game shows its progress');
assert.ok(library.some((text) => /Move to USB drive 1 stopped/.test(text)), 'a stopped move says so');
assert.ok(library.some((text) => /2 hours played · Last played (today|yesterday)/.test(text)), 'play time on the tile');
assert.ok(library.some((text) => /ShadowMount can't find its file/.test(text)), "the health check's finding");
assert.ok(library.includes('Fix it'), "0.5.2: a game that won't start offers Fix it on ✕");

const { DiagnosisSheet } = await load('app/game/DiagnosisSheet.jsx');
const why = await screen("Why won't it start? (a Homebrew app, by its title ID)", { type: DiagnosisSheet, props: { title: 'PS5X360', titleId: 'PPSA50011', folders: ['/data/homebrew/PPSA50011'], root: '/data', onClose() {} } });
assert.ok(why.some((text) => /^Reading ShadowMount's logs/.test(text)), why.join('|'));
const { RemoveSheet } = await load('app/homebrew/RemoveSheet.jsx');
const ask = await screen('Remove an app that saved things (0.5.2)', { type: RemoveSheet, props: { name: 'PS5X360', saved: { whole: false, keptAt: '/data/homebrew-saves/brinootk__ps5x360', paths: ['saves'] }, onClose() {}, onChoose() {} } });
assert.ok(ask.includes('Remove PS5X360?') && ask.includes('Keep what it saved') && ask.includes('Delete everything'), ask.join('|'));
assert.ok(ask.some((text) => text.includes('/data/homebrew-saves/brinootk__ps5x360')), 'it says where they will be');

const { MakeRoomSheet } = await load('app/library/MakeRoomSheet.jsx');
const sheet = await screen('Make Room (library)', { type: MakeRoomSheet, props: { onClose() {} } });
assert.ok(sheet.includes('Reclaim') && sheet.includes('Move to another drive') && sheet.includes('Delete'));
assert.ok(sheet.some((text) => /Leftover download file/.test(text)));
const asked = await screen('Make Room (for a download)', { type: MakeRoomSheet, props: { target: '/data', need: 120 * GB, then: { game: f, release: { id: 'r', sizeBytes: 80 * GB }, root: '/data' }, onClose() {} } });
assert.ok(asked.some((text) => /needs 80 GB more on Internal storage/.test(text)), asked.join('|'));

const { runner } = await load('app/library/services.js');
const { planRoom, ticked0 } = await load('app/library/make-room.js');
const plan = planRoom({ target: '/data', need: 60 * GB, drives: globalThis.__fake.drives.usage, leftovers: [{ id: 'orphan:x', kind: 'orphan', root: '/data', path: '/data/downloads/images/Old.exfat.part', bytes: 3 * GB, title: 'Old.exfat', action: { type: 'path', path: '/data/downloads/images/Old.exfat.part' } }] });
await runner().run({ plan, ticked: ticked0(plan), entries: new Map() });
const done = await screen('Make Room (finished)', { type: MakeRoomSheet, props: { onClose() {} } });
assert.ok(done.some((text) => /^Freed .* on Internal storage\.$/.test(text)), done.join('|'));
runner().dismiss();

const { GameFacts } = await load('app/game/GameFacts.jsx');
const facts = await screen('Game facts', { type: GameFacts, props: { game: a } });
assert.ok(facts.includes('Play time') && facts.includes('2 hours played') && (facts.includes('Today') || facts.includes('Yesterday')));
const { SettingsScreen } = await load('app/ui/Settings.jsx');
const settingsHome = await screen('Settings', { type: SettingsScreen, props: { onBack() {} } });
assert.ok(settingsHome.includes('Settings') && settingsHome.includes('Downloads') && settingsHome.includes('About & credits'), settingsHome.join('|'));
const settings = await screen('Settings (About)', { type: SettingsScreen, props: { onBack() {}, start: 'about' } });
const settingsDownloads = await screen('Settings (Downloads)', { type: SettingsScreen, props: { onBack() {}, start: 'downloads' } });
// glibren.5: the pause when the app closes, 0 (Off) to 30 s (with background downloads on), and "Exit Jobee'sLair" under the categories.
assert.ok(settingsDownloads.includes('Pause when the app closes'), settingsDownloads.join('|'));
for (const label of ['Off', '5 s', '10 s', '15 s', '20 s', '25 s', '30 s']) assert.ok(settingsDownloads.includes(label), label);
assert.ok(settingsHome.includes("Exit Jobee'sLair"), settingsHome.join('|'));
const { ExitSheet } = await load('app/ui/ExitSheet.jsx');
const exitSheet = await screen('Exit (glibren.5)', { type: ExitSheet, props: { summary: { app: 1, background: 2 }, onClose() {}, onExit() {} } });
assert.ok(exitSheet.includes("Exit Jobee'sLair?") && exitSheet.includes('Exit') && exitSheet.includes('Stay'), exitSheet.join('|'));
assert.ok(exitSheet.some((text) => /^Downloads in the app stop: 1 download\./.test(text)), exitSheet.join('|'));
assert.ok(exitSheet.includes('Background downloads keep going: 2 downloads.'), exitSheet.join('|'));
const quietSheet = await screen('Exit, nothing downloading', { type: ExitSheet, props: { summary: { app: 0, background: 0 }, onClose() {}, onExit() {} } });
assert.ok(!quietSheet.some((text) => /Downloads|downloads keep/.test(text)), 'no download lines when nothing downloads');
assert.ok(settings.includes('Support development') && settings.includes('Optional. Every feature stays free either way.'), settings.join('|'));
assert.ok(!settings.some((text) => /buymeacoffee/.test(text)), 'the QR code and address show only once the row is opened');
assert.ok(settings.includes("From Jobee'sLair: Fix it is in 0.5.2"), 'every announcement up, whole, in About');
const { AnnouncementBar } = await load('app/ui/AnnouncementBar.jsx');
const bar = await screen('Announcements (0.5.2)', { type: AnnouncementBar, props: {} });
assert.deepEqual(bar, ["FROM JOBEE'SLAIR", 'Do not update ShadowMount yet'], 'the first up, warnings first, under its label');
const { SearchScreen } = await load('app/search/index.jsx');
const search = await screen('Search', { type: SearchScreen, props: { onBack() {} } });
assert.ok(search.includes('13.60 Ready') && search.includes('.exfat Image') && search.includes('Filters'), search.join('|'));
assert.ok(search.includes('Space'), 'the keyboard is up when the page opens');
// 0.5.3: X on a carousel thumbnail opens its game; it only showed its slide, and the game was a trip back to View
// game away.
const { HeroThumbs } = await load('app/browse/HeroThumbs.jsx');
const focusable = [];
const collect = (node) => {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(collect);
  const { type, props = {} } = node;
  if (typeof type === 'function') return collect(type(props));
  if (props.focusKey) focusable.push(props);
  collect(props.children);
};
const selected = [], opened = [];
const slides = { active: 0, left: 7000, paused: false, select: (index) => selected.push(index), focus() {}, blur() {} };
collect({ type: HeroThumbs, props: { games: picks.slice(0, 5), slides, open: (index) => opened.push(index), nextFocusDown: 'lane:featured:x' } });
assert.deepEqual(focusable.map((props) => props.focusKey), ['spotlight:0', 'spotlight:1', 'spotlight:2', 'spotlight:3', 'spotlight:4']);
focusable[2].onPress();
assert.deepEqual({ selected, opened }, { selected: [2], opened: [2] }, 'X shows the slide and opens its game');
// glibren.14: no "Up to 3 feeds" any more, and "Add a file from the PS5" opens a picker over the drives.
const settingsFeeds = await screen('Settings (Catalog feeds, glibren.14)', { type: SettingsScreen, props: { onBack() {}, start: 'feeds' } });
assert.ok(settingsFeeds.includes('Add a feed') && settingsFeeds.includes('Add a file from the PS5'), settingsFeeds.join('|'));
assert.ok(!settingsFeeds.some((text) => /Up to \d+ feeds/.test(text)), 'no limit of three feeds');
const { FeedFilePicker } = await load('app/ui/FeedFilePicker.jsx');
const picker = await screen('Feed file picker (glibren.14)', { type: FeedFilePicker, props: { roots: ['/data', '/mnt/usb0'], onPick() {}, onClose() {} } });
assert.ok(picker.includes('Choose a feed file') && picker.includes('/data') && picker.includes('/mnt/usb0') && picker.includes("Jobee'sLair folder"), picker.join('|'));
// glibren.16: the Downloads screen shows the conversions to .exfat: a download being converted (it was in no section,
// so it never showed), with Cancel conversion, its speed and the summary's "1 converting"; and one the payload converts
// outside the queue (state/payload-conversions.js), as its own card. Then the PS5 .pkg warning: its Settings row and
// the dialog Install opens on firmware 12.00.
const { noteConversions } = await load('app/state/payload-conversions.js');
const { DownloadsScreen } = await load('app/downloads/DownloadsScreen.jsx');
file('/data/homebrew/PPSA08888.exfat', 30 * GB);
const nowS = Math.floor(Date.now() / 1e3);
noteConversions([
  { id: 'c2', key: 'gone', name: 'Payload Game', state: 'converting', written: 12 * GB, total: 40 * GB, output: '/data/homebrew/PPSA05555.exfat', label: 'PPSA05555', updated: nowS },
  { id: 'c5', key: 'gone2', name: 'Payload Done', state: 'done', written: 30 * GB, total: 30 * GB, output: '/data/homebrew/PPSA08888.exfat', label: 'PPSA08888', updated: nowS - 60 },
  { id: 'c7', key: 'gone3', name: 'Payload Failed', state: 'failed', error: 'space: needs 40 GB, 12 GB free', output: '/data/homebrew/PPSA01111.exfat', updated: nowS - 60 }
]);
const libraryJobs = globalThis.__fake.jobs;
globalThis.__fake.jobs = [job(a, 'converting', { written: 8 * GB, total: 20 * GB, bytesPerSecond: 150e6, message: en['downloads.convert.running'], convert: { kind: 'archive', output: `/data/homebrew/${a.id}.exfat` } })];
const downloadsScreen = await screen('Downloads (glibren.16: conversions)', { type: DownloadsScreen, props: { onBack() {}, onOpenGame() {} } });
globalThis.__fake.jobs = libraryJobs;
const { downloadsSummary } = await load('app/downloads/DownloadsScreen.jsx');
const { outsideQueue } = await load('app/state/payload-conversions.js');
const { payloadConversions } = await load('app/state/payload-conversions.js');
const converting = [job(a, 'converting'), job(b, 'downloading'), job(c, 'installed')];
assert.equal(downloadsSummary(converting, outsideQueue(payloadConversions(), converting, { exists: fs.exists })), '1 in progress · 2 converting · 1 completed', 'the summary counts the conversions');
assert.ok(downloadsScreen.includes('Cancel conversion'), 'Cancel conversion on the card being converted and on the payload one');
assert.ok(downloadsScreen.includes(a.title) && downloadsScreen.includes('Payload Game') && downloadsScreen.includes('Payload Done') && downloadsScreen.includes('Payload Failed'), downloadsScreen.join('|'));
assert.ok(downloadsScreen.some((text) => /^12 GB of 40 GB/.test(text)), 'the payload conversion says how far it is');
assert.ok(downloadsScreen.includes(en['downloads.payloadConv.hint']), 'one outside the queue says so');
assert.ok(downloadsScreen.some((text) => text.startsWith('Not enough space for the .exfat: needs 40 GB, 12 GB free')), 'a failed one says why');
assert.ok(downloadsScreen.includes('Ready (EXFAT)'), 'a finished one');
// glibren.22: the BACKUP folder sheet: each original with what became of it, Convert all and the log button.
const { noteBackup } = await load('app/state/payload-conversions.js');
const { BackupSheet } = await load('app/downloads/BackupSheet.jsx');
noteBackup({ totalBytes: 90 * GB, games: [
  { root: '/mnt/usb0', name: 'Game A', bytes: 40 * GB, files: 3, platform: 'ps5', code: 'PPSA01234', format: 'rar', parts: 3, converted: '' },
  { root: '/mnt/usb0', name: 'Game B', bytes: 30 * GB, files: 1, platform: 'ps5', code: 'PPSA05678', format: 'zip', parts: 0, converted: '', conversion: { id: 'c9', state: 'extracting', error: '', written: 10 * GB, total: 40 * GB } },
  { root: '/mnt/usb0', name: 'Game C', bytes: 15 * GB, files: 1, platform: 'ps5', code: 'PPSA09999', format: 'rar', parts: 0, converted: '', conversion: { id: 'c8', state: 'failed', error: 'source: none of the known passwords opens this RAR', written: 0, total: 0 } },
  { root: '/mnt/usb0', name: 'Old PS4', bytes: 5 * GB, files: 1, platform: 'ps4', code: 'CUSA01234', format: 'pkg', parts: 0, converted: '' },
  { root: '/data', name: 'Done', bytes: 1, files: 1, platform: 'ps5', code: 'PPSA07777', format: 'pkg', parts: 0, converted: 'PPSA07777.exfat', conversion: { id: 'c1', state: 'done', error: '', written: 1, total: 1 } },
] });
const backupSheet = await screen('BACKUP folder (glibren.22)', { type: BackupSheet, props: { onClose() {} } });
for (const text of ['BACKUP folder', 'Convert all', 'Payload log', 'Game A', 'Not converted yet', 'Unpacking to convert: 25%', 'PS4 game: install it from the Files tab', 'Converted: PPSA07777.exfat', 'Convert again', 'Delete', '2 not converted yet'])
  assert.ok(backupSheet.includes(text), `${text}: ${backupSheet.join('|')}`);
assert.ok(backupSheet.some((text) => text.startsWith('The conversion failed: source: none of the known passwords')), backupSheet.join('|'));
const downloadsBackup = await screen('Downloads (glibren.22: BACKUP folder button)', { type: DownloadsScreen, props: { onBack() {}, onOpenGame() {} } });
assert.ok(downloadsBackup.includes('BACKUP folder'), downloadsBackup.join('|'));
const settingsWarn = await screen('Settings (Downloads, glibren.16)', { type: SettingsScreen, props: { onBack() {}, start: 'downloads' } });
assert.ok(settingsWarn.includes("Warn that PS5 .pkg files won't open on this firmware"), settingsWarn.join('|'));
const { Ps5PkgWarning } = await load('app/ui/Ps5PkgWarning.jsx');
const warning = await load('app/state/ps5-pkg-warning.js');
assert.equal(await screen('PS5 .pkg warning (closed)', { type: Ps5PkgWarning, props: {} }).then((out) => out.length), 0, 'nothing until Install asks');
warning.installWithPs5Warning({ id: 'PPSA01234/r', titleId: 'PPSA01234', title: 'Test Game', packages: ['/data/BACKUP/Test Game/PPSA01234.pkg'] }, () => {}, '12.00');
const warned = await screen('PS5 .pkg warning (glibren.16)', { type: Ps5PkgWarning, props: {} });
assert.ok(warned.includes("This PS5 .pkg won't open") && warned.includes('Install anyway') && warned.includes('Cancel') && warned.includes("Don't warn me again"), warned.join('|'));
assert.ok(warned.some((text) => /don't open on firmware 12\.00 \(only up to 11\.60\)/.test(text)), warned.join('|'));
warning.answerPs5PkgWarning('cancel');
console.log(`\nOK: ${rendered} components rendered without an exception`);
