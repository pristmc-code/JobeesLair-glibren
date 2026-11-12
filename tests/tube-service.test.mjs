// glibren-tube: o cliente do tube-service.elf (app/state/tube-service.js) com um servico, um Http, um FileSystem e um
// loader de mentira: subir sob demanda, health, token, jobs (busca, resolve), SponsorBlock, o fallback quando nao sobe,
// e a escolha do primeiro video / da qualidade / da legenda. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const tube = await import('../app/state/tube-service.js');
const { createTubeService, pageItems, pickFirstVideo, playableChoices, defaultChoice, pickCaption, captionLanguage, sponsorSkipTo, searchRequest, clockText, TUBE_API } = tube;

const TOKEN = 'c'.repeat(64);
const BASE = 'http://127.0.0.1:34210';

// O servico falso: /v1/health sem token; /v1/jobs, /v1/sponsor com "Authorization: Bearer <token>".
function fakeService({ up = true, api = TUBE_API, pending = 1, results = {}, failWith = null } = {}) {
  const state = { up, api, calls: [], jobs: new Map(), next: 0, sends: [], token: up ? TOKEN : '', elfs: new Set(['/app0/tube-service.elf']) };
  const respond = (status, data) => ({ status, ok: status < 300, json: async () => data });
  state.http = {
    async request(url, { method = 'GET', headers = {}, body } = {}) {
      const path = url.slice(BASE.length);
      state.calls.push({ method, path, body: body ? JSON.parse(body) : undefined, auth: headers.Authorization });
      if (!url.startsWith(BASE)) throw new Error('wrong port');
      if (!state.up) throw new Error("Couldn't connect to server");
      if (method === 'GET' && path === '/v1/health') return respond(200, { api_version: 1, api: state.api, version: '0.1.0', service: 'tube-service', pid: 42 });
      if (method === 'HEAD' && path.startsWith('/media/')) return respond(200, null);
      if (headers.Authorization !== `Bearer ${TOKEN}`) return respond(401, { error: { code: 'unauthorized' } });
      if (method === 'POST' && path === '/v1/jobs') {
        const id = `j${++state.next}`;
        state.jobs.set(id, { payload: JSON.parse(body), polls: 0 });
        return respond(200, { api_version: 1, job: id, state: 'pending' });
      }
      const poll = /^\/v1\/jobs\/(\w+)$/.exec(path);
      if (poll && method === 'DELETE') { state.jobs.delete(poll[1]); state.cancelled = (state.cancelled ?? 0) + 1; return respond(200, { state: 'cancelled' }); }
      if (poll) {
        const job = state.jobs.get(poll[1]);
        if (!job) return respond(410, { error: { code: 'expired_job' } });
        if (job.polls++ < pending) return respond(200, { api_version: 1, state: 'pending' });
        if (failWith) return respond(200, { api_version: 1, state: 'failed', error: failWith });
        const action = job.payload.action === 'library' ? job.payload.library.action : job.payload.action;
        return respond(200, { api_version: 1, state: 'done', result: results[action] ?? {} });
      }
      const sponsor = /^\/v1\/sponsor\/([\w-]{11})\?categories=sponsor,selfpromo$/.exec(path);
      if (sponsor) return respond(200, { segments: [{ start: 10, end: 30, category: 'sponsor' }, { start: 5, end: 5, category: 'poi_highlight' }, { start: 'x' }], enabled: true });
      return respond(404, {});
    }
  };
  state.fs = {
    readFile: (path) => path === '/data/JobeesLair/tube/token' && state.token ? `${state.token}\n` : '',
    exists: (path) => state.elfs.has(path)
  };
  state.payloads = {
    send(path, options) {
      state.sends.push({ path, options });
      if (state.refuse) return { ok: false, error: 'loader refused' };
      // O payload sobe um pouco depois e grava o token.
      setTimeout(() => { state.up = true; state.api = TUBE_API; state.token = TOKEN; }, 20);
      return { ok: true };
    }
  };
  return state;
}
const make = (service, extra = {}) => createTubeService({ http: service.http, fs: service.fs, payloads: service.payloads, platform: 'ps5', log: () => {}, startWaitMs: 600, startPollMs: 10, jobPollMs: 5, jobTimeoutMs: 2000, ...extra });

const ITEMS = [
  { kind: 'channel', id: 'channel:UCabcdefghijklmnopqrstuv', title: 'A channel', is_folder: true },
  { kind: 'playlist', id: 'PLxxxxxxxxxxxx', title: 'A playlist', is_folder: true },
  { kind: 'video', id: 'upcoming001', title: 'Premiere', subtitle: 'Studio', duration_sec: 0, is_upcoming: true },
  { kind: 'video', id: 'livelive001', title: 'Live now', subtitle: 'Studio', duration_sec: 0, is_live: true },
  { kind: 'video', id: 'shortshort1', title: 'A short', subtitle: 'Studio', duration_sec: 40, is_short: true },
  { kind: 'video', id: 'normal00001', title: 'ASTRO BOT - Launch Trailer | PS5 Games', subtitle: 'PlayStation', duration_sec: 125, art_url: 'https://i.ytimg.com/x.jpg', overview: 'long text '.repeat(200) },
  { kind: 'video', id: 'normal00002', title: 'Second', subtitle: 'Other', duration_sec: 61 },
  { kind: 'video', id: 'bad id', title: 'Broken' }
];

test('pageItems: only videos, only the fields the screen uses, at most the page limit', () => {
  const items = pageItems({ items: ITEMS });
  assert.deepEqual(items.map((item) => item.id), ['upcoming001', 'livelive001', 'shortshort1', 'normal00001', 'normal00002']);
  assert.deepEqual(items[3], { id: 'normal00001', title: 'ASTRO BOT - Launch Trailer | PS5 Games', channel: 'PlayStation', seconds: 125, live: false, short: false, upcoming: false });
  assert.equal(pageItems({ items: Array.from({ length: 40 }, (_, i) => ({ kind: 'video', id: `v${String(i).padStart(10, '0')}`, title: 't' })) }).length, 24);
  assert.equal(pageItems({ items: [{ id: 'a'.repeat(11), title: 'x'.repeat(500) }] })[0].title.length, 120, 'long titles are cut');
  assert.deepEqual(pageItems(null), []);
  // The plain search (no kind): the service's item() rows.
  assert.equal(pageItems({ items: [{ id: 'abcdefghijk', title: 'plain', subtitle: 'c', duration_sec: 3 }] })[0].channel, 'c');
});

test('pickFirstVideo: the first normal video; live or Short only when there is no normal one; never a scheduled one', () => {
  const items = pageItems({ items: ITEMS });
  assert.equal(pickFirstVideo(items).id, 'normal00001', 'channels, playlists, scheduled, live and Shorts skipped');
  assert.equal(pickFirstVideo(items.filter((item) => !item.id.startsWith('normal'))).id, 'livelive001', 'no normal video: live or Short');
  assert.equal(pickFirstVideo(items.filter((item) => item.upcoming)), null, 'only scheduled: nothing to play');
  assert.equal(pickFirstVideo([]), null);
});

test('playableChoices/defaultChoice: the HLS link of each choice, no AV1 nor DASH alone, best up to 1080p by default', () => {
  const m = (name) => `${BASE}/media/s/${name}`;
  const choices = [
    { label: '2160p VP9 / OPUS', container: 'dash', video_codec: 'vp9', height: 2160, fps: 30, url: m('d0.mpd'), hls_url: m('v0.m3u8') },
    { label: '1440p AV1 / OPUS', container: 'dash', video_codec: 'av1', height: 1440, url: m('d1.mpd'), hls_url: m('v1.m3u8') },
    { label: '1080p VP9 / OPUS', container: 'dash', video_codec: 'vp9', height: 1080, url: m('d2.mpd') },
    { label: '1080p H264 / AAC', container: 'dash', video_codec: 'h264', height: 1080, fps: 60, url: m('d3.mpd'), hls_url: m('v3.m3u8') },
    { label: '720p H264 / AAC', container: 'dash', video_codec: 'h264', height: 720, url: m('d4.mpd'), hls_url: m('v4.m3u8') },
    { label: '360p H264 / AAC', container: 'mp4', video_codec: 'h264', height: 360, url: m('p5') },
    { label: 'evil', container: 'hls', video_codec: 'h264', height: 480, url: 'https://elsewhere.example/x.m3u8' }
  ];
  const list = playableChoices(choices);
  assert.deepEqual(list.map((choice) => choice.label), ['2160p VP9 / OPUS', '1080p H264 / AAC', '720p H264 / AAC', '360p H264 / AAC']);
  assert.equal(list[1].url, m('v3.m3u8'), 'the master HLS, not the .mpd');
  assert.equal(list[3].url, m('p5'), 'a muxed file: its redirect address');
  assert.equal(list[1].hls, true);
  assert.equal(defaultChoice(list), 1, '1080p, not 2160p');
  assert.equal(defaultChoice(list, 720), 2);
  assert.equal(defaultChoice([{ height: 1440, hls: true }, { height: 1200, hls: true }]), 1, 'none up to 1080p: the smallest');
  assert.equal(defaultChoice([{ height: 1080, hls: false, label: 'a' }, { height: 1080, hls: true, label: 'b' }]), 1, 'HLS before a file at the same height');
  assert.equal(defaultChoice([]), -1);
  // Live: YouTube's own HLS variants (container hls).
  assert.equal(playableChoices([{ label: '720p', container: 'hls', video_codec: 'h264', height: 720, url: m('h0.m3u8') }])[0].url, m('h0.m3u8'));
});

test('pickCaption: the app language (written before automatic, original before translated), else English, as WebVTT', () => {
  const m = (name) => `${BASE}/media/s/${name}`;
  const captions = [
    { language: 'en', name: 'English', url: m('c0.srt'), automatic: false, translated: false },
    { language: 'pt', name: 'Portuguese (auto)', url: m('c1.srt'), automatic: true, translated: false },
    { language: 'pt-BR', name: 'Portuguese (Brazil)', url: m('c2.srt'), automatic: false, translated: false },
    { language: 'en', name: 'Portuguese', url: m('c3.srt'), automatic: false, translated: true, target: 'pt' }
  ];
  assert.deepEqual(pickCaption(captions, 'pt-BR'), { uri: `${m('c2.srt')}?format=vtt`, language: 'pt-BR', title: 'Portuguese (Brazil)' });
  assert.equal(pickCaption(captions, 'de').uri, `${m('c0.srt')}?format=vtt`, 'no German: English');
  assert.equal(pickCaption([], 'pt-BR'), null);
  assert.equal(pickCaption([{ language: 'ja', url: m('c9.srt') }], 'pt-BR'), null, 'neither the language nor English: none');
});

test('sponsorSkipTo, searchRequest and clockText', () => {
  const segments = [{ start: 10, end: 30, category: 'sponsor' }, { start: 50, end: 50, category: 'poi_highlight' }];
  assert.equal(sponsorSkipTo(segments, 12), 30);
  assert.equal(sponsorSkipTo(segments, 9.9), null);
  assert.equal(sponsorSkipTo(segments, 29.8), null, 'at the very end: nothing to jump over');
  assert.equal(sponsorSkipTo(segments, 50), null, 'a highlight is not skipped');
  assert.deepEqual(searchRequest('  ASTRO BOT   trailer ', { order: 'view_count', duration: 'long', upload_date: 'week', type: 'all' }),
    { action: 'search', query: 'ASTRO BOT trailer', order: 'view_count', duration: 'long', upload_date: 'week', type: 'all' });
  assert.deepEqual(searchRequest('x', { order: 'date', duration: 'huge', upload_date: 1, type: 'channel' }),
    { action: 'search', query: 'x', order: 'relevance', duration: 'any', upload_date: 'any', type: 'video' }, 'unknown values fall back');
  assert.equal(clockText(125), '2:05');
  assert.equal(clockText(3723), '1:02:03');
  assert.equal(clockText(-4), '0:00');
});

test('ensure: a service already up with its token is used as it is (no ELF sent)', async () => {
  const service = fakeService();
  const client = make(service);
  assert.deepEqual(await client.ensure(), { ok: true, version: '0.1.0' });
  assert.deepEqual(service.sends, []);
  assert.equal(client.isReady(), true);
});

test('ensure: on demand, the ELF goes to the loader (port 9021, no answer awaited) and the app waits for /v1/health and the token', async () => {
  const service = fakeService({ up: false });
  const client = make(service);
  const [a, b] = await Promise.all([client.ensure(), client.ensure()]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(service.sends, [{ path: '/app0/tube-service.elf', options: { answer: false } }], 'sent once for two callers');
});

test('ensure: an older service (lower api) is replaced by this app\'s ELF; a copy in /data/JobeesLair is used without one in the package', async () => {
  const older = fakeService({ api: 0 });
  assert.equal((await make(older).ensure()).ok, true);
  assert.equal(older.sends.length, 1);
  const copied = fakeService({ up: false });
  copied.elfs = new Set(['/data/JobeesLair/tube-service.elf']);
  assert.equal((await make(copied).ensure()).ok, true);
  assert.equal(copied.sends[0].path, '/data/JobeesLair/tube-service.elf');
});

test('ensure fails (and the Videos sheet falls back to the video app): no ELF, loader refused, no answer, desktop', async () => {
  const none = fakeService({ up: false });
  none.elfs = new Set();
  const client = make(none);
  assert.equal(client.offered(), false, 'no ELF: the sheet keeps the old flow');
  assert.deepEqual(await client.ensure(), { ok: false, reason: 'missing', error: 'tube-service.elf' });
  assert.deepEqual(none.sends, []);
  const refused = fakeService({ up: false });
  refused.refuse = true;
  assert.equal((await make(refused).ensure()).reason, 'send');
  const silent = fakeService({ up: false });
  silent.payloads.send = (path) => (silent.sends.push(path), { ok: true }); // sent, never answers
  const started = Date.now();
  assert.equal((await make(silent, { startWaitMs: 100 }).ensure()).reason, 'timeout');
  assert.ok(Date.now() - started < 1000);
  assert.equal((await make(fakeService({ up: false }), { platform: 'desktop' }).ensure()).reason, 'desktop');
  assert.equal(make(fakeService()).offered(), true);
});

test('search and more: library jobs with the token, polled until done; one page of videos and the cursor', async () => {
  const service = fakeService({ pending: 2, results: {
    search: { kind: 'catalog', items: ITEMS, cursor: '0f9d0c1e-1111-2222-3333-444455556666', has_more: true },
    continue: { kind: 'catalog', items: ITEMS.slice(5), cursor: '', has_more: false }
  } });
  const client = make(service);
  const page = await client.search('ASTRO BOT trailer', { order: 'relevance', duration: 'any', upload_date: 'any', type: 'video' });
  assert.equal(page.items.length, 5);
  assert.equal(page.cursor, '0f9d0c1e-1111-2222-3333-444455556666');
  const created = service.calls.find((call) => call.method === 'POST');
  assert.deepEqual(created.body, { action: 'library', library: { action: 'search', query: 'ASTRO BOT trailer', order: 'relevance', duration: 'any', upload_date: 'any', type: 'video' } });
  assert.equal(created.auth, `Bearer ${TOKEN}`);
  assert.equal(service.calls.filter((call) => call.method === 'GET' && call.path.startsWith('/v1/jobs/')).length, 3, 'two pending, then done');
  const next = await client.more(page.cursor);
  assert.deepEqual(next.items.map((item) => item.id), ['normal00001', 'normal00002']);
  assert.equal(next.cursor, '');
  assert.deepEqual(service.calls.filter((call) => call.method === 'POST').at(-1).body, { action: 'library', library: { action: 'continue', cursor: page.cursor } });
});

test('a failed job throws the service\'s code; a cancelled one is given up (DELETE)', async () => {
  const failing = fakeService({ failWith: { code: 'upstream_limit', message: 'too many' } });
  await assert.rejects(make(failing).search('x'), (error) => error.code === 'upstream_limit');
  const slow = fakeService({ pending: 1000 });
  const listeners = new Set();
  const signal = { aborted: false, addEventListener: (type, fn) => listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn) };
  const asked = make(slow).search('x', undefined, { signal });
  setTimeout(() => { signal.aborted = true; for (const fn of listeners) fn(); }, 30);
  await assert.rejects(asked, (error) => error.code === 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(slow.cancelled, 1);
  const wrongToken = fakeService();
  wrongToken.fs.readFile = () => 'd'.repeat(64);
  await assert.rejects(make(wrongToken).search('x'), (error) => error.code === 'unauthorized');
});

test('resolve: the playable choices and the caption; fresh links on request; sponsor segments (and [] when it fails)', async () => {
  const m = (name) => `${BASE}/media/s/${name}`;
  const service = fakeService({ results: { resolve: {
    title: 'ASTRO BOT', channel: 'PlayStation', duration_sec: 125,
    choices: [{ label: '1080p H264 / AAC', container: 'dash', video_codec: 'h264', height: 1080, url: m('d0.mpd'), hls_url: m('v0.m3u8') }],
    captions: [{ language: 'en', name: 'English', url: m('c0.srt') }]
  } } });
  const client = make(service);
  const info = await client.resolve('normal00001', { locale: 'pt-BR' });
  assert.equal(info.title, 'ASTRO BOT');
  assert.equal(info.duration, 125);
  assert.equal(info.choices[0].url, m('v0.m3u8'));
  assert.equal(info.caption.uri, `${m('c0.srt')}?format=vtt`);
  const playback = service.calls.find((call) => call.method === 'POST').body.playback;
  assert.deepEqual(playback, { id: 'normal00001', max_height: 2160, codec: 'auto', caption_language: 'pt', automatic_captions: true });
  await client.resolve('normal00001', { fresh: true });
  assert.equal(service.calls.filter((call) => call.method === 'POST').at(-1).body.playback.fresh, true);
  await assert.rejects(client.resolve('bad'), (error) => error.code === 'invalid_video');
  const none = fakeService({ results: { resolve: { choices: [{ label: 'x', container: 'dash', video_codec: 'av1', height: 1080, url: m('d.mpd'), hls_url: m('v.m3u8') }] } } });
  await assert.rejects(make(none).resolve('normal00001'), (error) => error.code === 'unsupported_media');
  assert.deepEqual(await client.sponsor('normal00001'), [{ start: 10, end: 30, category: 'sponsor' }, { start: 5, end: 5, category: 'poi_highlight' }].filter((segment) => segment.end > segment.start));
  const down = fakeService();
  down.up = false;
  assert.deepEqual(await make(down).sponsor('normal00001'), []);
});

// glibren-fast: o pre-resolve (o item focado resolvido em segundo plano), o cancelamento, o cache curto e a validade.
const RESOLVED = (m) => ({ resolve: {
  title: 'ASTRO BOT', channel: 'PlayStation', duration_sec: 125,
  choices: [
    { label: '2160p VP9 / OPUS', container: 'dash', video_codec: 'vp9', height: 2160, url: m('d0.mpd'), hls_url: m('v0.m3u8') },
    { label: '1080p H264 / AAC', container: 'dash', video_codec: 'h264', height: 1080, url: m('d2.mpd'), hls_url: m('v2.m3u8') }
  ],
  captions: []
} });
const media = (name) => `${BASE}/media/s${'x'.repeat(31)}/${name}`;
const posts = (service) => service.calls.filter((call) => call.method === 'POST' && call.path === '/v1/jobs').length;
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test('prefetch: the focused video is resolved in the background; the player then uses it (no second job) and the default quality is warmed with HEAD', async () => {
  const service = fakeService({ results: RESOLVED(media) });
  const client = make(service);
  assert.equal(client.prefetch('normal00001'), false, 'service not up yet: nothing');
  await client.ensure();
  assert.equal(client.prefetch('bad id'), false);
  assert.equal(client.prefetch('normal00001', { locale: 'pt-BR' }), true);
  await settle();
  assert.equal(posts(service), 1);
  const heads = service.calls.filter((call) => call.method === 'HEAD').map((call) => call.path);
  assert.deepEqual(heads, [`/media/s${'x'.repeat(31)}/v2v.m3u8`, `/media/s${'x'.repeat(31)}/v2a.m3u8`], 'the 1080p playlists (the service already reads v0 by itself); no token');
  assert.ok(service.calls.filter((call) => call.method === 'HEAD').every((call) => !call.auth));
  const info = await client.resolve('normal00001', { locale: 'pt-BR' });
  assert.equal(info.choices[1].url, media('v2.m3u8'));
  assert.equal(posts(service), 1, 'the ready resolve, no new job');
  assert.equal(client.prefetch('normal00001', { locale: 'pt-BR' }), true, 'already there');
  assert.equal(posts(service), 1);
  await client.resolve('normal00001', { locale: 'de' });
  assert.equal(posts(service), 2, 'another caption language: its own resolve');
  await client.resolve('normal00001', { locale: 'pt-BR', fresh: true });
  assert.equal(posts(service), 3, 'fresh links always ask the service');
});

test('prefetch: the player joins a resolve still running; a new focus cancels the old one (DELETE), never the one the player waits for', async () => {
  const service = fakeService({ pending: 6, results: RESOLVED(media) });
  const client = make(service);
  await client.ensure();
  client.prefetch('normal00001');
  await settle(10);
  const playing = client.resolve('normal00001');
  client.prefetch('normal00002');
  await settle(10);
  assert.equal(service.cancelled ?? 0, 0, 'the one the player waits for goes on');
  client.prefetch('normal00003');
  await settle(30);
  assert.equal(service.cancelled, 1, 'normal00002 lost the focus: given up');
  assert.equal((await playing).title, 'ASTRO BOT');
  assert.equal(posts(service), 3, 'one job each, the player\'s included');
  client.cancelPrefetch();
  await settle(30);
  assert.equal(service.cancelled, 2, 'cancelPrefetch gives up normal00003 too');
});

test('prefetch: at most two running (with the ones the player waits for); a cancelled player wait does not stop the resolve', async () => {
  const service = fakeService({ pending: 8, results: RESOLVED(media) });
  const client = make(service);
  await client.ensure();
  client.prefetch('normal00001');
  const a = client.resolve('normal00001');
  client.prefetch('normal00002');
  const listeners = new Set();
  const signal = { aborted: false, addEventListener: (type, fn) => listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn) };
  const b = client.resolve('normal00002', { signal });
  assert.equal(client.prefetch('normal00003'), false, 'two running already');
  signal.aborted = true;
  for (const fn of listeners) fn();
  await assert.rejects(b, (error) => error.code === 'cancelled');
  await a;
  await settle(60);
  assert.equal(service.cancelled ?? 0, 0);
  assert.equal(posts(service), 2);
  await client.resolve('normal00002');
  assert.equal(posts(service), 2, 'normal00002 finished in the background and was kept');
});

test('prefetch cache: only the last three, and only for a short while (well before the links run out)', async () => {
  let clock = 1000;
  const service = fakeService({ results: RESOLVED(media) });
  const client = make(service, { now: () => clock });
  await client.ensure();
  for (const id of ['normal00001', 'normal00002', 'normal00003', 'normal00004']) {
    client.prefetch(id);
    await settle();
  }
  assert.equal(posts(service), 4);
  await client.resolve('normal00004');
  await client.resolve('normal00002');
  assert.equal(posts(service), 4, 'kept');
  await client.resolve('normal00001');
  assert.equal(posts(service), 5, 'the oldest was dropped (three kept)');
  clock += 6e5 + 1;
  await client.resolve('normal00001');
  assert.equal(posts(service), 6, 'after 10 min: resolved again');
});

// glibren-captions: a legenda no idioma configurado na Jobe (manual > automatica > traducao tlang > ingles).
test('captionLanguage: the app languages as YouTube writes them', () => {
  assert.equal(captionLanguage('pt-BR').request, 'pt');
  assert.equal(captionLanguage('zh-Hans').request, 'zh-Hans');
  for (const code of ['en', 'es', 'fr', 'de', 'it', 'ru', 'ja', 'hi', 'ar', 'bn', 'id', 'ur']) assert.equal(captionLanguage(code).request, code);
  assert.equal(captionLanguage('').request, 'en');
});

test('pickCaption: written in the app language, else automatic, else YouTube translation (tlang), else English', () => {
  const m = (name) => `http://127.0.0.1:34210/media/s/${name}`;
  const manualEn = { language: 'en', name: 'English', url: m('en.srt'), automatic: false, translated: false };
  const autoPt = { language: 'pt', name: 'Portuguese (auto)', url: m('pt-asr.srt'), automatic: true, translated: false };
  const manualPtPt = { language: 'pt-PT', name: 'Portuguese (Portugal)', url: m('pt-pt.srt'), automatic: false, translated: false };
  const trPt = { language: 'pt-en', name: 'Portuguese', url: m('tr-pt.srt'), automatic: true, translated: true, target: 'pt' };
  const manualPtBr = { language: 'pt-BR', name: 'Portuguese (Brazil)', url: m('pt-br.srt'), automatic: false, translated: false };
  const pick = (list, locale) => pickCaption(list, locale)?.uri.replace(/\?format=vtt$/, '').split('/').pop();
  assert.equal(pick([manualEn, trPt, autoPt, manualPtBr], 'pt-BR'), 'pt-br.srt', 'written first');
  assert.equal(pick([manualEn, trPt, autoPt], 'pt-BR'), 'pt-asr.srt', 'then automatic');
  assert.equal(pick([manualEn, trPt, manualPtPt], 'pt-BR'), 'tr-pt.srt', 'then the translation to pt, before pt-PT');
  assert.equal(pick([manualEn, manualPtPt], 'pt-BR'), 'pt-pt.srt', 'then another Portuguese');
  assert.equal(pick([manualEn], 'pt-BR'), 'en.srt', 'else English (as before)');
  // An automatic track keyed "<lang>-asr" when a written one has that language.
  assert.equal(pick([manualEn, { language: 'de-asr', url: m('de-asr.srt'), automatic: true }], 'de'), 'de-asr.srt');
  // Chinese: Simplified (zh-Hans/zh-CN), then the translation to zh-Hans, before Traditional.
  const zhTw = { language: 'zh-TW', url: m('zh-tw.srt'), automatic: false, translated: false };
  const zhCn = { language: 'zh-CN', url: m('zh-cn.srt'), automatic: false, translated: false };
  const trZh = { language: 'zh-Hans-en', url: m('tr-zh.srt'), automatic: true, translated: true, target: 'zh-Hans' };
  assert.equal(pick([zhTw, trZh, zhCn, manualEn], 'zh-Hans'), 'zh-cn.srt');
  assert.equal(pick([zhTw, trZh, manualEn], 'zh-Hans'), 'tr-zh.srt');
  assert.equal(pick([zhTw, manualEn], 'zh-Hans'), 'zh-tw.srt');
  // Spanish: any regional variant, the plain code first.
  const es419 = { language: 'es-419', url: m('es-419.srt'), automatic: false, translated: false };
  const es = { language: 'es', url: m('es.srt'), automatic: false, translated: false };
  assert.equal(pick([es419, es], 'es'), 'es.srt');
  assert.equal(pick([es419, manualEn], 'es'), 'es-419.srt');
  // Indonesian: YouTube's old code "in" too.
  assert.equal(pick([manualEn, { language: 'in', url: m('in.srt'), automatic: false }], 'id'), 'in.srt');
  // Japanese with only a translation.
  assert.equal(pick([manualEn, { language: 'ja-en', url: m('tr-ja.srt'), automatic: true, translated: true, target: 'ja' }], 'ja'), 'tr-ja.srt');
  assert.equal(pickCaption([], 'pt-BR'), null);
});
