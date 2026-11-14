// glibren.49 (Fase 2): o lado do app da atualizacao propria do payload (app/state/background-downloads.js +
// app/state/payload-self.js): app.json (PAYLOAD_API + versao do embutido) antes de subir, copia do embutido, troca de um
// payload posto de lado ("replace") ou de API maior sem compatibilidade declarada (minAppApi), ate 3 subidas quando
// ninguem responde, um pedido de procura por abertura, e o texto/estado das Configuracoes. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const { createBackgroundDownloads, PAYLOAD_API, BG_EMBEDDED_VERSION } = await import('../app/state/background-downloads.js');
const self = await import('../app/state/payload-self.js');
const { isTubeServiceTag } = await import('../app/state/updater.js').then((m) => ({ isTubeServiceTag: m.isTubeServiceTag })).catch(() => ({}));

const TOKEN = 'a'.repeat(64);
// sobe o payload (a mesma subida da fila) pela troca de app, que chama ensurePayload
const up = (bg) => bg.switchApp('PPSA99991', 'PPSA99471');
const respond = (status, data) => ({ status, ok: status < 300, json: async () => data });

function setup({ health = () => ({ api: PAYLOAD_API }), files = {}, startTries = 1, selfUpdate = false } = {}) {
  const s = { calls: [], sent: 0, files: { '/data/JobeesLair/bg/token': TOKEN, ...files }, copies: [], up: true };
  const http = {
    async request(url, { method = 'GET', body } = {}) {
      const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
      s.calls.push({ method, path, body: body ? JSON.parse(body) : undefined });
      if (!s.up) throw new Error('no payload');
      if (path === '/health') return respond(200, { ok: true, version: BG_EMBEDDED_VERSION, pid: 7, running: 0, ...health(s) });
      if (path === '/self-update') return respond(200, { ok: true, version: '1.33.0', source: 'embedded', embedded: '1.33.0', phase: 'checking', bad: [] });
      return respond(200, { ok: true });
    }
  };
  const fs = {
    readFile: (p) => s.files[p] ?? '',
    writeFile: (p, text) => { s.files[p] = text; },
    rename: (a, b) => { s.files[b] = s.files[a]; delete s.files[a]; },
    mkdir: () => {},
    exists: (p) => p in s.files,
    stat: (p) => p === '/app0/bg-downloader.elf' ? { size: 900 } : p in s.files ? { size: String(s.files[p]).length } : null,
    remove: (p) => { delete s.files[p]; },
    copyAsync: (from, to) => { s.copies.push([from, to]); return { done: Promise.resolve() }; }
  };
  const bg = createBackgroundDownloads({
    downloads: { enqueue() {}, setRateLimit() {} }, http, fs, platform: 'ps5', on: () => true, log: () => {}, pollMs: 5, startWaitMs: 40, startTries, selfUpdate,
    payloads: { send: (elf) => { s.sent++; s.elf = elf; s.onSend?.(); return { ok: true }; } }
  });
  return { s, bg };
}

test('o contrato: PAYLOAD_API 37 e a versao do embutido 1.37.5 (= BG_VERSION; o bg-self-update.test confere com o C)', () => {
  assert.equal(PAYLOAD_API, 37);
  assert.equal(BG_EMBEDDED_VERSION, '1.37.5');
});

test('antes de subir: app.json com a PAYLOAD_API e o embutido, e a copia do ELF embutido (embedded.elf), uma vez', async () => {
  const { s, bg } = setup({ health: (st) => ({ api: st.sent ? PAYLOAD_API : 32 }) });
  await up(bg);
  assert.equal(s.sent, 1);
  assert.deepEqual(JSON.parse(s.files['/data/JobeesLair/bg/app.json']), { api: PAYLOAD_API, embedded: BG_EMBEDDED_VERSION });
  assert.deepEqual(s.copies.filter(([, to]) => to.endsWith('embedded.elf')), [['/app0/bg-downloader.elf', '/data/JobeesLair/bg/embedded.elf']]);
});

test('payload posto de lado (replace) ou de API maior sem compatibilidade declarada: o app manda o embutido', async () => {
  for (const [what, h, expected] of [
    ['em dia', { api: PAYLOAD_API }, 0],
    ['replace', { api: PAYLOAD_API, replace: true }, 1],
    ['api maior e minAppApi maior', { api: PAYLOAD_API + 2, minAppApi: PAYLOAD_API + 1 }, 1],
    ['api maior e compativel', { api: PAYLOAD_API + 2, minAppApi: PAYLOAD_API }, 0],
    ['api menor', { api: PAYLOAD_API - 1 }, 1],
    ['glibren.56: versao menor que a embutida, ocioso', { api: PAYLOAD_API, version: '1.0.0' }, 1],
    ['glibren.56: versao menor, baixando', { api: PAYLOAD_API, version: '1.0.0', running: 1 }, 0]
  ]) {
    const { s, bg } = setup({ health: () => h });
    await up(bg);
    assert.equal(s.sent, expected, what);
    if (expected) assert.equal(s.elf, '/app0/bg-downloader.elf', what);
  }
});

test('ninguem responde: ate startTries subidas (o payload conta as tentativas de um baixado que cai); a 2a que sobe para', async () => {
  const { s, bg } = setup({ startTries: 3 });
  s.up = false;
  s.onSend = () => { if (s.sent === 2) s.up = true; };
  const token = await up(bg).then(() => s.calls.length);
  assert.ok(token > 0);
  assert.equal(s.sent, 2, 'parou na que respondeu');
  const { s: one, bg: bg1 } = setup({ startTries: 1 });
  one.up = false;
  await up(bg1);
  assert.equal(one.sent, 1, 'padrao: uma vez, como antes');
});

test('selfUpdate: um POST /self-update {action: check} por abertura, com o payload no ar; desligado, nenhum', async () => {
  const { s, bg } = setup({ selfUpdate: true });
  await up(bg);
  await up(bg);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(s.calls.filter((c) => c.path === '/self-update').map((c) => c.body), [{ action: 'check' }]);
  const { s: off, bg: bgOff } = setup();
  await up(bgOff);
  assert.equal(off.calls.filter((c) => c.path === '/self-update').length, 0);
});

test('Configuracoes: estado validado, texto da linha e quando mostrar "Voltar ao payload embutido"', async () => {
  const base = { ok: true, version: '1.33.0', source: 'embedded', embedded: '1.33.0', installed: null, latest: '1.33.0', phase: 'idle', percent: 0, error: '', bad: [] };
  assert.equal(self.cleanStatus({ ok: true, version: 'x' }), null);
  assert.equal(self.cleanStatus(base).source, 'embedded');
  assert.deepEqual(self.statusLine(null), { key: 'settings.payload.off', vars: {} });
  assert.deepEqual(self.statusLine(self.cleanStatus(base)), { key: 'settings.payload.embedded', vars: { version: '1.33.0' } });
  assert.deepEqual(self.statusLine(self.cleanStatus({ ...base, phase: 'downloading', latest: '1.33.5', percent: 40 })), { key: 'settings.payload.downloading', vars: { version: '1.33.5', percent: 40 } });
  assert.equal(self.statusLine(self.cleanStatus({ ...base, phase: 'waiting', latest: '1.33.5' })).key, 'settings.payload.ready');
  assert.equal(self.statusLine(self.cleanStatus({ ...base, phase: 'needs-app', latest: '1.40.0' })).key, 'settings.payload.needsApp');
  assert.equal(self.revertable(self.cleanStatus(base)), false);
  assert.equal(self.revertable(self.cleanStatus({ ...base, version: '1.33.5', source: 'downloaded' })), true);
  assert.equal(self.revertable(self.cleanStatus({ ...base, installed: '1.33.5' })), true, 'baixado a frente, ainda nao em uso');
  assert.equal(self.revertable(self.cleanStatus({ ...base, installed: '1.33.5', bad: ['1.33.5'] })), false, 'ja posto de lado');
  // a fonte: sem payload, null; com a ligacao, o que o payload diz
  self.setPayloadSelfSource(null);
  assert.equal(await self.payloadSelfStatus(), null);
  const asked = [];
  self.setPayloadSelfSource({ status: async () => ({ status: 200, data: base }), check: async (force) => { asked.push(['check', force]); return { status: 200, data: { ...base, phase: 'checking' } }; },
    revert: async () => { asked.push(['revert']); return { status: 200, data: base }; } });
  assert.equal((await self.payloadSelfStatus()).version, '1.33.0');
  assert.equal((await self.checkPayloadSelf()).phase, 'checking');
  await self.revertPayloadSelf();
  assert.deepEqual(asked, [['check', true], ['revert']]);
  self.setPayloadSelfSource(null);
});

test('o verificador de versoes da Jobe nunca oferece uma tag bg-downloader-* como versao do app', async () => {
  const { createUpdateChecker } = await import('../app/state/updater.js');
  const http = { request: async () => respond(200, { tag_name: 'bg-downloader-1.33.0', html_url: 'https://github.com/x/y/releases/tag/bg-downloader-1.33.0', assets: [] }) };
  http.request = async (url) => url.endsWith('/releases/latest') ? { ...respond(200, {}), json: async () => ({ tag_name: 'bg-downloader-1.33.0', assets: [] }) } : { ...respond(200, {}), json: async () => [] };
  const store = { value: {}, get() { return this.value; }, set(v) { this.value = v; } };
  const checker = createUpdateChecker({ http, store, version: '0.5.5-glibren.49', repo: 'x/y', log: () => {} });
  const result = await checker.check();
  assert.equal(result.update, null);
  void isTubeServiceTag;
});
