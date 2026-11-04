// Downloads em segundo plano (app/state/background-downloads.js): o Downloads embrulhado que entrega o download da
// fila ao payload bg-downloader.elf, com um payload, um Http e um FileSystem de mentira. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const { createBackgroundDownloads } = await import('../app/state/background-downloads.js');

const TOKEN = 'a'.repeat(64);
const MiB = 1024 * 1024;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Um payload falso: guarda os jobs e responde a API (GET /health, GET /jobs, POST /jobs, /secret, acoes).
function fakePayload({ up = true, pid = 7 } = {}) {
  const state = { up, pid, jobs: [], calls: [], secrets: [], next: 0 };
  const respond = (status, data) => ({ status, ok: status < 300, json: async () => data });
  state.http = {
    async request(url, { method = 'GET', headers = {}, body } = {}) {
      const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
      state.calls.push({ method, path, body: body ? JSON.parse(body) : undefined, token: headers['X-Jobe-Token'] });
      if (!state.up) throw new Error('Couldn\'t connect to server');
      if (headers['X-Jobe-Token'] !== TOKEN) return respond(401, { error: 'token' });
      if (method === 'GET' && path === '/health') return respond(200, { ok: true, version: '1.0.0', pid: state.pid });
      if (method === 'GET' && path === '/jobs') return respond(200, { jobs: state.jobs.map((job) => ({ ...job })) });
      if (method === 'POST' && path === '/secret') { state.secrets.push(JSON.parse(body)); return respond(200, { ok: true }); }
      if (method === 'POST' && path === '/jobs') {
        const job = { ...JSON.parse(body), id: `b${++state.next}`, state: 'queued', written: 0, total: 0, published: '' };
        state.jobs.push(job);
        return respond(201, { id: job.id });
      }
      const action = /^\/jobs\/([^/]+)\/(\w+)$/.exec(path);
      if (method === 'POST' && action) {
        const job = state.jobs.find((item) => item.id === action[1]);
        if (!job) return respond(404, { error: 'no such job' });
        if (action[2] === 'release' || action[2] === 'forget') state.jobs = state.jobs.filter((item) => item !== job);
        if (action[2] === 'resume') job.state = 'queued';
        return respond(200, { ok: true });
      }
      return respond(404, {});
    }
  };
  state.fs = { readFile: (path) => path === '/data/JobeesLair/bg/token' && state.tokenOnDisk !== false ? TOKEN : '' };
  return state;
}

// O motor nativo falso: guarda o que pediram e deixa o teste terminar a tarefa.
function fakeEngine() {
  const engine = { started: [] };
  engine.downloads = {
    enqueue(options) {
      let resolve, reject;
      const done = new Promise((ok, fail) => { resolve = ok; reject = fail; });
      done.catch(() => {});
      const listeners = new Set();
      const task = { id: engine.started.length + 1, done, cancelled: false, cancel() { task.cancelled = true; const e = new Error('cancelled'); e.name = 'AbortError'; reject(e); }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, resolve, reject, listeners };
      engine.started.push({ options, task });
      return task;
    },
    setRateLimit() {}
  };
  return engine;
}

const queueOptions = (extra = {}) => ({
  url: 'https://cdn.example/file.exfat?sig=1', rejectHtml: true, mirrors: undefined, connections: 64, adaptive: true,
  rangeBytes: 16 * MiB, destination: '/mnt/ext0/downloads/images/Game.exfat', storageRoot: '/mnt/ext0', recoverCompleted: true,
  sha256: 'b'.repeat(64), expectedBytes: 123,
  background: { title: 'Game', publishTo: '/mnt/ext0/homebrew/Game.exfat', source: { debrid: { service: 'torbox' } } },
  ...extra
});

function make(payload, engine, extra = {}) {
  return createBackgroundDownloads({
    downloads: engine.downloads, http: payload.http, fs: payload.fs, platform: 'ps5', on: () => true,
    payloads: { send: () => { payload.sent = (payload.sent || 0) + 1; return { ok: true }; } },
    handoff: (source) => source?.debrid?.service === 'torbox' ? { provider: 'torbox', kind: 'webdl', id: 42, fileId: 3, zip: false } : null,
    secret: (service) => service === 'torbox' ? 'SECRET-KEY-123456789012' : '',
    text: (key, vars) => `${key}:${vars?.name}`, log: () => {}, pollMs: 5, startWaitMs: 50, ...extra
  });
}

test('com a opcao ligada, o download da fila vai para o payload com o que a parcial compartilhada precisa', async () => {
  const payload = fakePayload();
  const engine = fakeEngine();
  const task = make(payload, engine).enqueue(queueOptions());
  const seen = [];
  task.subscribe((progress) => seen.push(progress.state));
  await wait(30);
  assert.equal(engine.started.length, 0, 'o motor do app nao baixa o mesmo arquivo');
  const created = payload.calls.find((call) => call.method === 'POST' && call.path === '/jobs').body;
  assert.equal(created.rangeBytes, 16 * MiB, 'mesmo rangeBytes do app: senao a parcial nao seria a mesma');
  assert.equal(created.destination, '/mnt/ext0/downloads/images/Game.exfat');
  assert.equal(created.storageRoot, '/mnt/ext0');
  assert.equal(created.sha256, 'b'.repeat(64));
  assert.equal(created.expectedBytes, 123);
  assert.equal(created.publishTo, '/mnt/ext0/homebrew/Game.exfat');
  assert.deepEqual(created.source, { provider: 'torbox', kind: 'webdl', id: 42, fileId: 3, zip: false });
  assert.equal(created.notifyDone, 'downloads.background.notifyDone:Game');
  assert.ok(!JSON.stringify(created).includes('SECRET-KEY'), 'a chave nunca vai no job');
  assert.deepEqual(payload.secrets, [{ service: 'torbox', key: 'SECRET-KEY-123456789012' }], 'a chave vai so por /secret');
  Object.assign(payload.jobs[0], { state: 'downloading', written: 50, total: 123, bytesPerSecond: 10 });
  await wait(30);
  assert.ok(seen.includes('downloading'));
  Object.assign(payload.jobs[0], { state: 'completed', written: 123 });
  const result = await task.done;
  assert.equal(result.state, 'completed');
  assert.equal(payload.jobs.length, 0, 'o job concluido e esquecido no payload');
});

test('opcao desligada, fora do PS5, sem dados de segundo plano ou com pecas: o motor do app, como antes', () => {
  for (const [extra, options] of [[{ on: () => false }, queueOptions()], [{ platform: 'desktop' }, queueOptions()],
    [{}, queueOptions({ background: undefined })], [{}, queueOptions({ pieces: [{ url: 'https://x/1', offset: 0, size: 1 }] })]]) {
    const payload = fakePayload();
    const engine = fakeEngine();
    make(payload, engine, extra).enqueue(options);
    assert.equal(engine.started.length, 1);
    assert.equal(engine.started[0].options.background, undefined, 'o motor nativo nao recebe o campo background');
    assert.equal(payload.calls.filter((call) => call.path === '/jobs').length, 0);
  }
});

test('com espelhos: o payload baixa do link principal e, ao voltar para o app, os espelhos voltam junto', async () => {
  const { takeOverDownload } = await import('../app/state/background-downloads.js');
  const payload = fakePayload();
  const engine = fakeEngine();
  const mirrors = ['https://mirror-a.example/file.exfat', 'https://mirror-b.example/file.exfat'];
  make(payload, engine).enqueue(queueOptions({ mirrors }));
  await wait(30);
  assert.equal(engine.started.length, 0, 'continua com o app fechado: quem baixa e o payload');
  const created = payload.calls.find((call) => call.method === 'POST' && call.path === '/jobs').body;
  assert.equal(created.url, 'https://cdn.example/file.exfat?sig=1', 'so o link principal');
  assert.equal(created.mirrors, undefined, 'o payload nao recebe os espelhos');
  assert.equal(await takeOverDownload('/mnt/ext0/downloads/images/Game.exfat'), true);
  assert.deepEqual(engine.started[0].options.mirrors, mirrors, 'o motor do app volta a usar os espelhos');
});

test('payload que nao sobe: o app baixa ele mesmo', async () => {
  const payload = fakePayload({ up: false });
  payload.tokenOnDisk = false;
  const engine = fakeEngine();
  make(payload, engine).enqueue(queueOptions());
  await wait(120);
  assert.equal(payload.sent, 1, 'tentou enviar o ELF ao elfldr');
  assert.equal(engine.started.length, 1);
  assert.equal(engine.started[0].options.rangeBytes, 16 * MiB);
});

test('ao abrir o app, segue o job que o payload terminou com o app fechado (imagem ja publicada em homebrew/)', async () => {
  const payload = fakePayload();
  payload.jobs.push({ id: 'b9', state: 'completed', destination: '/mnt/ext0/downloads/images/Game.exfat', published: '/mnt/ext0/homebrew/Game.exfat', written: 9, total: 9 });
  const engine = fakeEngine();
  const task = make(payload, engine).enqueue(queueOptions({ destination: '/mnt/ext0/homebrew/Game.exfat' }));
  const result = await task.done;
  assert.equal(result.state, 'completed');
  assert.equal(payload.calls.filter((call) => call.method === 'POST' && call.path === '/jobs').length, 0, 'nao cria outro job');
  assert.equal(engine.started.length, 0);
});

test('um job que falhou com o app fechado entrega o erro como o motor nativo o diria (a fila renova o link)', async () => {
  const payload = fakePayload();
  payload.jobs.push({ id: 'b3', state: 'needs-app', destination: '/mnt/ext0/downloads/images/Game.exfat', error: 'provider denied the file; link expired or browser verification required (HTTP 403)' });
  const task = make(payload, fakeEngine()).enqueue(queueOptions());
  await assert.rejects(task.done, /^Error: Downloads\.enqueue \/mnt\/ext0\/downloads\/images\/Game\.exfat: provider denied the file; link expired or browser verification required \(HTTP 403\)$/);
  assert.equal(payload.jobs.length, 0);
});

test('pausar (cancel da tarefa) libera o job no payload e termina como AbortError', async () => {
  const payload = fakePayload();
  const task = make(payload, fakeEngine()).enqueue(queueOptions());
  await wait(30);
  task.cancel();
  await assert.rejects(task.done, (error) => error.name === 'AbortError');
  assert.ok(payload.calls.some((call) => call.path === '/jobs/b1/release'));
  assert.equal(payload.jobs.length, 0);
});

test('"Baixar pelo app": libera no payload e continua no motor do app com as mesmas opcoes', async () => {
  const { takeOverDownload, inBackground } = await import('../app/state/background-downloads.js');
  const payload = fakePayload();
  const engine = fakeEngine();
  const task = make(payload, engine).enqueue(queueOptions());
  await wait(30);
  assert.ok(inBackground('/mnt/ext0/downloads/images/Game.exfat'));
  assert.equal(await takeOverDownload('/mnt/ext0/downloads/images/Game.exfat'), true);
  assert.equal(payload.jobs.length, 0, 'o payload largou o arquivo antes');
  assert.equal(engine.started.length, 1);
  assert.equal(engine.started[0].options.rangeBytes, 16 * MiB);
  assert.ok(!inBackground('/mnt/ext0/downloads/images/Game.exfat'));
  engine.started[0].task.resolve({ state: 'completed' });
  assert.equal((await task.done).state, 'completed');
});

test('o payload que para de responder: o app continua sozinho do ultimo checkpoint', async () => {
  const payload = fakePayload();
  const engine = fakeEngine();
  make(payload, engine).enqueue(queueOptions());
  await wait(30);
  payload.up = false;
  await wait(250);
  assert.equal(engine.started.length, 1);
});
