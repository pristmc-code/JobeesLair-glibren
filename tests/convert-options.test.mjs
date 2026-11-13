// pac1: o lado da Jobe das opcoes da conversao e do aviso de queda.
//   - state/convert-options.js: pausa entre conversoes, limite de escrita e gravar em pedacos (padrao 0, settings.json);
//   - background-downloads.js: as tres no POST /config, a espera do GET /convert (waitSeconds) e o GET /crash;
//   - state/payload-conversions.js: a contagem da pausa ("m:ss");
//   - state/crash-notice.js: o aviso uma vez por queda (o visto em settings.json "crashSeen").
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const { createBackgroundDownloads, PAYLOAD_API } = await import('../app/state/background-downloads.js');
const FILE = '/download0/JobeesLair/settings.json';
const TOKEN = 'a'.repeat(64);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakePayload({ crash = null, waitSeconds = 0 } = {}) {
  const state = { configs: [], crash, waitSeconds };
  const respond = (status, data) => ({ status, ok: status < 300, json: async () => data });
  state.http = {
    async request(url, { method = 'GET', headers = {}, body } = {}) {
      const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
      if (headers['X-Jobe-Token'] !== TOKEN) return respond(401, { error: 'token' });
      if (method === 'GET' && path === '/health') return respond(200, { ok: true, version: '1.0.0', api: PAYLOAD_API, pid: 7, running: 0 });
      if (method === 'POST' && path === '/config') { state.configs.push(JSON.parse(body)); return respond(200, { ok: true }); }
      if (method === 'GET' && path === '/convert') return respond(200, { conversions: [], waitSeconds: state.waitSeconds, pauseSeconds: 120, writeLimit: 0 });
      if (method === 'GET' && path === '/crash') return respond(200, { crash: state.crash });
      return respond(404, {});
    }
  };
  state.fs = { readFile: (path) => path === '/data/JobeesLair/bg/token' ? TOKEN : '' };
  return state;
}
const make = (payload, extra = {}) => createBackgroundDownloads({
  downloads: { enqueue() { throw new Error('no'); }, setRateLimit() {} }, http: payload.http, fs: payload.fs, platform: 'ps5', on: () => true,
  payloads: { send: () => ({ ok: true }) }, log: () => {}, pollMs: 5, startWaitMs: 50, ...extra
});

test('pac1: PAYLOAD_API 24 (pausa/limite/pedacos na conversao e GET /crash); item 2: 26 (loja completa); glibren.38: 27 (a rede da Biblioteca TorBox); glibren.43: 28 (primeiro plano no /switch, ritmo unico do TorBox)', () => {
  assert.equal(PAYLOAD_API, 28);
});

test('pac1: opcoes da conversao desligadas por padrao, guardadas so quando ligadas, avisadas e lidas de volta', async () => {
  const fresh = (tag) => import(`../app/state/convert-options.js?t=${Date.now()}-${tag}`);
  globalThis.__stubFiles = new Map([[FILE, JSON.stringify({ backgroundDownloads: true })]]);
  try {
    const mod = await fresh('a');
    assert.deepEqual(mod.convertOptions(), { convertPauseSeconds: 0, convertWriteLimit: 0, convertSyncMB: 0 });
    assert.deepEqual(mod.CONVERT_OPTIONS.convertSyncMB, [0, 64, 128, 256, 512]);
    const heard = [];
    const stop = mod.onConvertOptions((values) => heard.push(values));
    mod.setConvertOption('convertPauseSeconds', 120);
    mod.setConvertOption('convertSyncMB', 256);
    assert.deepEqual(JSON.parse(globalThis.__stubFiles.get(FILE)), { backgroundDownloads: true, convertPauseSeconds: 120, convertSyncMB: 256 });
    for (const [key, bad] of [['convertPauseSeconds', 7], ['convertWriteLimit', -1], ['convertSyncMB', '256'], ['nope', 0]]) mod.setConvertOption(key, bad);
    assert.equal(heard.length, 2, 'valor fora da lista nao muda nada');
    assert.deepEqual((await fresh('b')).convertOptions(), { convertPauseSeconds: 120, convertWriteLimit: 0, convertSyncMB: 256 });
    mod.setConvertOption('convertPauseSeconds', 0);
    assert.deepEqual(JSON.parse(globalThis.__stubFiles.get(FILE)), { backgroundDownloads: true, convertSyncMB: 256 }, 'desligada: o campo sai');
    stop();
    globalThis.__stubFiles.set(FILE, JSON.stringify({ convertWriteLimit: 33 }));
    assert.equal((await fresh('c')).convertOptions().convertWriteLimit, 0, 'um valor salvo fora da lista vale 0');
  } finally {
    delete globalThis.__stubFiles;
  }
});

test('pac1: as opcoes da conversao vao no POST /config; a mudanca chega ao payload no ar', async () => {
  const payload = fakePayload();
  let options = { convertPauseSeconds: 0, convertWriteLimit: 0, convertSyncMB: 0 };
  const wrapper = make(payload, { convertOptions: () => options });
  await wrapper.refreshConfig();
  assert.deepEqual(payload.configs.at(-1), { concurrency: 1, convertPauseSeconds: 0, convertWriteLimit: 0, convertSyncMB: 0 });
  options = { convertPauseSeconds: 120, convertWriteLimit: 50, convertSyncMB: 256 };
  await wrapper.refreshConfig();
  assert.deepEqual(payload.configs.at(-1), { concurrency: 1, convertPauseSeconds: 120, convertWriteLimit: 50, convertSyncMB: 256 });
  // Sem a opcao (null) ou com lixo: nenhum campo.
  const other = fakePayload();
  await make(other, { convertOptions: () => ({ convertPauseSeconds: 'x', convertSyncMB: -3 }) }).refreshConfig();
  assert.deepEqual(other.configs.at(-1), { concurrency: 1 });
});

test('pac1: a pausa entre conversoes do GET /convert vira a contagem da tela de Downloads', async () => {
  const conv = await import('../app/state/payload-conversions.js');
  const payload = fakePayload({ waitSeconds: 105 });
  make(payload);
  await conv.refreshConversions();
  assert.ok([104, 105].includes(conv.conversionWaitSeconds()), String(conv.conversionWaitSeconds()));
  assert.equal(conv.waitClock(105), '1:45');
  assert.equal(conv.waitClock(9), '0:09');
  payload.waitSeconds = 0;
  await conv.refreshConversions();
  assert.equal(conv.conversionWaitSeconds(), 0);
  conv.noteConversionWait(30, 1000);
  assert.equal(conv.conversionWaitSeconds(1000), 30);
  assert.equal(conv.conversionWaitSeconds(31000), 0);
  conv.noteConversionWait(0);
});

const CRASH = { id: '1762890000', upAt: 1762890000, lastTime: '2026-11-11 14:32:05', lastAt: 1762889525, activity: 'convert', name: 'Astro Bot',
  milestone: 'escrita do exFAT: 3.20 GB de 7.80 GB (85.0 MB/s)', lastLine: '2026-11-11 14:32:05 conversao c3 [marco] escrita do exFAT: 3.20 GB de 7.80 GB (85.0 MB/s)',
  lines: ['2026-11-11 14:31:40 conversao c3 [marco] inicio: Astro Bot (archive)', '2026-11-11 14:32:05 conversao c3 [marco] escrita do exFAT: 3.20 GB de 7.80 GB (85.0 MB/s)'] };

test('pac1: queda nova avisa uma vez; OK marca como vista (settings.json) e nao volta; outra queda avisa de novo', async () => {
  const notice = await import('../app/state/crash-notice.js');
  globalThis.__stubFiles = new Map([[FILE, JSON.stringify({ backgroundDownloads: true })]]);
  try {
    notice.resetCrashNotice();
    const payload = fakePayload({ crash: CRASH });
    make(payload); // setCrashSource(wrapper.crash)
    const shown = await notice.checkCrash();
    assert.equal(shown.id, CRASH.id);
    assert.equal(shown.activity, 'convert');
    assert.equal(notice.crashTime(shown), '14:32');
    assert.equal(shown.lines.length, 2);
    assert.equal((await notice.checkCrash()).id, CRASH.id, 'a mesma pendente');
    notice.dismissCrash();
    assert.equal(notice.pendingCrash(), null);
    assert.equal(JSON.parse(globalThis.__stubFiles.get(FILE)).crashSeen, CRASH.id);
    assert.equal(await notice.checkCrash(), null, 'vista: nao avisa de novo');
    payload.crash = { ...CRASH, id: '1762899999', activity: 'none', name: '' };
    assert.equal((await notice.checkCrash()).id, '1762899999', 'outra queda avisa');
    notice.dismissCrash();
    // Sem queda, sem payload ou resposta estranha: nada.
    payload.crash = null;
    assert.equal(await notice.checkCrash(), null);
    assert.equal(await notice.checkCrash(async () => ({ id: 'x; rm' })), null);
    assert.equal(await notice.checkCrash(async () => { throw new Error('down'); }), null);
  } finally {
    notice.resetCrashNotice();
    delete globalThis.__stubFiles;
  }
});
