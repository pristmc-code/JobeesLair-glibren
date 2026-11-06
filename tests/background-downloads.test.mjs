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
  const state = { up, pid, jobs: [], calls: [], secrets: [], configs: [], queues: [], next: 0 };
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
      if (method === 'POST' && path === '/config') { state.configs.push(JSON.parse(body)); return respond(200, { ok: true }); }
      if (method === 'POST' && path === '/queue') { state.queues.push(JSON.parse(body)); return respond(200, { ok: true }); }
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
        if (action[2] === 'follow') job.followed = true;
        // glibren.8: "park" pausa e devolve o job a fila entregue (ahead, sem follow); um payload antigo nao conhece.
        if (action[2] === 'park') {
          if (state.noPark) return respond(404, { error: 'unknown action' });
          Object.assign(job, { state: 'paused', ahead: true, followed: false, by: '' });
        }
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

test('downloads simultaneos: o payload recebe o numero ao comecar um job e a cada mudanca; o motor nativo tambem', async () => {
  const payload = fakePayload();
  const engine = fakeEngine();
  const told = [];
  engine.downloads.setConcurrency = (n) => { told.push(n); return n; };
  let count = 2;
  const wrapper = make(payload, engine, { concurrency: () => count });
  wrapper.enqueue(queueOptions());
  await wait(30);
  assert.deepEqual(payload.configs, [{ concurrency: 2 }], 'vai junto com o primeiro job');
  wrapper.enqueue(queueOptions({ destination: '/mnt/ext0/downloads/images/Other.exfat' }));
  await wait(30);
  assert.equal(payload.configs.length, 1, 'o mesmo numero para o mesmo payload nao e mandado de novo');
  count = 3;
  assert.equal(wrapper.setConcurrency(3), 3);
  await wait(30);
  assert.deepEqual(told, [3]);
  assert.deepEqual(payload.configs.at(-1), { concurrency: 3 });
  for (const job of payload.jobs) job.state = 'completed';
  await wait(30);
});

// ---- glibren: a pagina do celular (porta 34201 do payload) ----

test('pagina do celular: a configuracao vai junto com o numero de downloads, e o IP do payload chega ao app', async () => {
  const payload = fakePayload();
  payload.http.request = ((request) => async (url, options = {}) => {
    const answer = await request(url, options);
    if (url.endsWith('/health') && answer.status === 200) return { ...answer, json: async () => ({ ok: true, version: '1.0.0', pid: payload.pid, ip: '192.168.0.20' }) };
    return answer;
  })(payload.http.request);
  const seen = [];
  let monitor = { monitor: true, pinSalt: '', pinHash: '', monitorText: 'veja em {address}' };
  const wrapper = make(payload, fakeEngine(), { monitor: () => monitor, addressSeen: (ip) => seen.push(ip) });
  wrapper.enqueue(queueOptions());
  await wait(30);
  assert.deepEqual(payload.configs, [{ concurrency: 1, monitor: true, pinSalt: '', pinHash: '', monitorText: 'veja em {address}' }]);
  assert.ok(seen.includes('192.168.0.20'), 'o endereco que o payload informa vai para as Configuracoes');
  monitor = { ...monitor, pinSalt: 'a'.repeat(64), pinHash: 'b'.repeat(64) };
  await wrapper.refreshConfig();
  assert.equal(payload.configs.at(-1).pinHash, 'b'.repeat(64), 'um PIN novo chega ao payload no ar');
  const before = payload.configs.length;
  await wrapper.refreshConfig();
  assert.equal(payload.configs.length, before, 'a mesma configuracao nao e mandada de novo');
  assert.ok(!JSON.stringify(payload.configs).includes('1234'), 'nunca o PIN em texto');
  for (const job of payload.jobs) job.state = 'completed';
  await wait(30);
});

test('pausado no celular: o app nao retoma sozinho e a fila passa a mostra-lo pausado (onRemote)', async () => {
  const payload = fakePayload();
  const remote = [];
  const task = make(payload, fakeEngine(), { onRemote: (destination, action) => remote.push([destination, action]) }).enqueue(queueOptions());
  await wait(30);
  Object.assign(payload.jobs[0], { state: 'paused', by: 'remote' });
  await wait(40);
  assert.equal(payload.calls.filter((call) => call.path === '/jobs/b1/resume').length, 0, 'a pausa do celular nao e desfeita');
  assert.deepEqual(remote, [['/mnt/ext0/downloads/images/Game.exfat', 'pause']], 'uma vez so');
  // Uma pausa do proprio payload (sem "by") continua sendo retomada, como antes.
  Object.assign(payload.jobs[0], { state: 'paused', by: '' });
  await wait(30);
  assert.ok(payload.calls.some((call) => call.path === '/jobs/b1/resume'));
  task.cancel();
  await assert.rejects(task.done, (error) => error.name === 'AbortError');
});

test('cancelado no celular: a fila cancela como se fosse no app (apaga o que sobrou), sem trocar de fonte', async () => {
  const payload = fakePayload();
  payload.jobs.push({ id: 'b5', state: 'cancelled', by: 'remote', destination: '/mnt/ext0/downloads/images/Game.exfat' });
  const remote = [];
  const task = make(payload, fakeEngine(), { onRemote: (destination, action) => remote.push(action) }).enqueue(queueOptions());
  await assert.rejects(task.done, (error) => error.name === 'AbortError');
  assert.deepEqual(remote, ['cancel']);
  assert.equal(payload.jobs.length, 0, 'o job cancelado e esquecido no payload');
});

// ---- glibren: a fila inteira entregue ao payload com antecedencia (syncQueue, POST /queue) ----

test('fila inteira: o que o payload baixa sozinho (direto, TorBox) vai como job; o resto vira marcador; sem reenviar igual', async () => {
  const payload = fakePayload();
  let enabled = true;
  const handoff = (source) => source?.debrid?.service === 'torbox' ? { provider: 'torbox', kind: 'webdl', id: 42, fileId: 3, zip: false } : source?.debrid?.service === 'alldebrid' ? { provider: 'alldebrid' } : null;
  const wrapper = make(payload, fakeEngine(), { on: () => enabled, queueDelayMs: 0, handoff });
  const req = (name, source = {}) => queueOptions({ destination: `/mnt/ext0/downloads/images/${name}`, background: { title: name, publishTo: '', source } });
  const items = [
    { key: 'j1', name: 'Direto', total: 10, request: req('A.exfat') },
    { key: 'j2', name: 'MediaFire', total: 20 },
    { key: 'j3', name: 'TorBox', total: 30, request: req('C.exfat', { debrid: { service: 'torbox' } }) },
    { key: 'j4', name: 'AllDebrid', total: 40, request: req('D.exfat', { debrid: { service: 'alldebrid' } }) },
  ];
  wrapper.syncQueue(items);
  await wrapper.flushQueue();
  const sent = payload.queues.at(-1).items;
  assert.deepEqual(sent.map((item) => [item.key, Boolean(item.job)]), [['j1', true], ['j2', false], ['j3', true], ['j4', false]], 'na ordem da fila');
  assert.equal(sent[0].job.destination, '/mnt/ext0/downloads/images/A.exfat');
  assert.equal(sent[0].job.rangeBytes, 16 * MiB, 'o mesmo rangeBytes do app (a parcial e a mesma)');
  assert.deepEqual(sent[2].job.source, { provider: 'torbox', kind: 'webdl', id: 42, fileId: 3, zip: false });
  assert.deepEqual(sent[1], { key: 'j2', name: 'MediaFire', total: 20 }, 'o marcador nao leva link nenhum');
  assert.ok(payload.secrets.some((secret) => secret.service === 'torbox'), 'a chave do TorBox vai antes, por /secret');
  assert.ok(!JSON.stringify(payload.queues).includes('SECRET-KEY'), 'nunca a chave na fila');
  const count = payload.queues.length;
  wrapper.syncQueue(items);
  await wrapper.flushQueue();
  assert.equal(payload.queues.length, count, 'a mesma fila nao e mandada de novo');
  enabled = false;
  wrapper.syncQueue(items);
  await wrapper.flushQueue();
  assert.deepEqual(payload.queues.at(-1), { items: [] }, 'opcao desligada: a fila entregue e retirada');
});

test('fila inteira: ao comecar no app um job ja entregue com antecedencia, o app o acompanha (follow) sem criar outro', async () => {
  const payload = fakePayload();
  payload.jobs.push({ id: 'b7', state: 'queued', ahead: true, followed: false, destination: '/mnt/ext0/downloads/images/Game.exfat' });
  const task = make(payload, fakeEngine()).enqueue(queueOptions());
  await wait(30);
  assert.ok(payload.calls.some((call) => call.path === '/jobs/b7/follow'));
  assert.equal(payload.calls.filter((call) => call.method === 'POST' && call.path === '/jobs').length, 0, 'nada baixa duas vezes');
  task.cancel();
  await assert.rejects(task.done, (error) => error.name === 'AbortError');
});

// ---- glibren.8: um download pausado (no celular, na web ou no app) continua na lista do celular ----
// Antes: a fila pausava a tarefa com cancel() -> release, o payload esquecia o job, e a fila do app so mandava os
// "queued" no POST /queue: o pausado sumia da pagina do celular.

const DEST = '/mnt/ext0/downloads/images/Game.exfat';
// A fila do app de mentira: a pausa vinda do celular pausa a tarefa como pauseJob (pause(), ou cancel() sem ele).
const pausingQueue = (holder, remote) => (destination, action, key) => {
  remote.push([destination, action, key]);
  if (action === 'pause' && holder.task) (holder.task.pause ?? holder.task.cancel)();
};

test('glibren.8: pausa no celular com o app aberto: o job fica no payload, pausado (park), e nao e esquecido', async () => {
  const payload = fakePayload();
  const remote = [], holder = {};
  holder.task = make(payload, fakeEngine(), { onRemote: pausingQueue(holder, remote) }).enqueue(queueOptions());
  await wait(30);
  Object.assign(payload.jobs[0], { state: 'downloading', written: 60, total: 123 });
  await wait(20);
  Object.assign(payload.jobs[0], { state: 'paused', by: 'remote' });
  await assert.rejects(holder.task.done, (error) => error.name === 'AbortError');
  assert.deepEqual(remote.map(([, action]) => action), ['pause']);
  assert.ok(payload.calls.some((call) => call.path === '/jobs/b1/park'), 'pausa: park, nao release');
  assert.ok(!payload.calls.some((call) => /\/jobs\/b1\/(release|forget)$/.test(call.path)), 'o payload nao esquece o job');
  assert.equal(payload.jobs.length, 1, 'continua na lista do celular');
  assert.deepEqual([payload.jobs[0].state, payload.jobs[0].written, payload.jobs[0].ahead], ['paused', 60, true], 'pausado, com o progresso');
});

test('glibren.8: pausa no proprio app de um download do payload: park; payload antigo (sem park) cai no release de antes', async () => {
  for (const noPark of [false, true]) {
    const payload = fakePayload();
    payload.noPark = noPark;
    const task = make(payload, fakeEngine()).enqueue(queueOptions());
    await wait(30);
    task.pause();
    await assert.rejects(task.done, (error) => error.name === 'AbortError');
    assert.equal(payload.jobs.length, noPark ? 0 : 1, noPark ? 'sem park: release, como antes' : 'com park: fica pausado no payload');
  }
  // No motor do app (sem payload), pausar e cancelar a tarefa nativa, como antes.
  const engine = fakeEngine();
  const native = make(fakePayload({ up: false }), engine, { startWaitMs: 5 }).enqueue(queueOptions());
  for (let i = 0; i < 50 && !engine.started.length; i++) await wait(10);
  native.pause();
  assert.equal(engine.started[0].task.cancelled, true);
});

test('glibren.8: a fila manda os pausados (paused, written), com o job quando o payload sabe baixa-lo', async () => {
  const payload = fakePayload();
  const wrapper = make(payload, fakeEngine(), { queueDelayMs: 0 });
  wrapper.syncQueue([
    { key: 'j1', name: 'Pausado', total: 100, paused: true, written: 40, request: queueOptions({ destination: '/mnt/ext0/downloads/images/A.exfat' }) },
    { key: 'j2', name: 'Pausado de site', total: 50, paused: true, written: 5 },
    { key: 'j3', name: 'Na fila', total: 10 }
  ]);
  await wrapper.flushQueue();
  const sent = payload.queues.at(-1).items;
  assert.deepEqual(sent.map((item) => [item.key, item.paused, item.written, Boolean(item.job)]), [['j1', true, 40, true], ['j2', true, 5, false], ['j3', undefined, undefined, false]]);
  assert.deepEqual(sent[2], { key: 'j3', name: 'Na fila', total: 10 }, 'o que nao esta pausado vai como antes');
});

test('glibren.8: retomar, pausar e cancelar no celular um item da fila do app chegam a fila (onRemote com a chave), uma vez so', async () => {
  const payload = fakePayload();
  const remote = [];
  const wrapper = make(payload, fakeEngine(), { queueDelayMs: 0, heartbeatMs: 10, onRemote: (destination, action, key) => remote.push([destination, action, key]) });
  payload.jobs.push(
    { id: 'b1', key: 'j1', ahead: true, followed: false, state: 'queued', by: 'remote', destination: '/mnt/ext0/downloads/images/A.exfat' }, // retomado no celular
    { id: 'b2', key: 'j2', placeholder: true, state: 'paused', by: 'remote', destination: '' }, // pausado no celular (so o app baixa)
    { id: 'b3', key: 'j3', placeholder: true, state: 'cancelled', by: 'remote', destination: '' }, // cancelado no celular
    { id: 'b4', key: 'j4', ahead: true, state: 'paused', by: '', destination: '/mnt/ext0/downloads/images/D.exfat' } // pausado no app: nada
  );
  wrapper.syncQueue([
    { key: 'j1', name: 'A', total: 1, paused: true, request: queueOptions({ destination: '/mnt/ext0/downloads/images/A.exfat' }) },
    { key: 'j2', name: 'B', total: 1 },
    { key: 'j3', name: 'C', total: 1, paused: true },
    { key: 'j4', name: 'D', total: 1, paused: true, request: queueOptions({ destination: '/mnt/ext0/downloads/images/D.exfat' }) }
  ]);
  await wrapper.flushQueue();
  await wait(60); // alguns batimentos: nada repete
  assert.deepEqual(remote, [['/mnt/ext0/downloads/images/A.exfat', 'resume', 'j1'], ['', 'pause', 'j2'], ['', 'cancel', 'j3']]);
  wrapper.syncQueue([]);
  await wrapper.flushQueue();
});

test('glibren.8: ao retomar no app um job pausado no payload (park), ele e acompanhado e retomado ali mesmo', async () => {
  const payload = fakePayload();
  payload.jobs.push({ id: 'b9', key: 'j1', ahead: true, followed: false, state: 'paused', by: '', destination: DEST, written: 70 });
  const task = make(payload, fakeEngine()).enqueue(queueOptions());
  await wait(40);
  assert.ok(payload.calls.some((call) => call.path === '/jobs/b9/follow'));
  assert.ok(payload.calls.some((call) => call.path === '/jobs/b9/resume'), 'continua da parcial no payload');
  assert.equal(payload.calls.filter((call) => call.method === 'POST' && call.path === '/jobs').length, 0);
  payload.jobs[0].state = 'completed';
  assert.equal((await task.done).state, 'completed');
});

// ---- glibren.5: a pausa ao fechar o app (POST /config "pauseOnCloseSeconds", 0 a 30 s) e o botao "Sair" (POST /bye) ----

test('pausa ao fechar: o tempo vai no POST /config junto com o resto, e a mudanca chega ao payload no ar', async () => {
  const payload = fakePayload();
  let seconds = 30;
  const wrapper = make(payload, fakeEngine(), { pauseOnCloseSeconds: () => seconds });
  wrapper.enqueue(queueOptions());
  await wait(30);
  assert.deepEqual(payload.configs, [{ concurrency: 1, pauseOnCloseSeconds: 30 }], 'o padrao, junto com o primeiro job');
  for (const value of [10, 0]) {
    seconds = value;
    await wrapper.refreshConfig();
    assert.deepEqual(payload.configs.at(-1), { concurrency: 1, pauseOnCloseSeconds: value }, `${value} s: o payload no ar recebe na hora`);
  }
  const count = payload.configs.length;
  await wrapper.refreshConfig();
  assert.equal(payload.configs.length, count, 'a mesma configuracao nao e mandada de novo');
  for (const job of payload.jobs) job.state = 'completed';
  await wait(30);
});

test('pausa ao fechar: sem a opcao (null), o POST /config sai sem o campo, como antes', async () => {
  const payload = fakePayload();
  const wrapper = make(payload, fakeEngine(), { pauseOnCloseSeconds: () => null });
  wrapper.enqueue(queueOptions());
  await wait(30);
  assert.deepEqual(payload.configs, [{ concurrency: 1 }]);
  for (const job of payload.jobs) job.state = 'completed';
  await wait(30);
});

test('pausa ao fechar: 0 a 30 s de 5 em 5, guardada em settings.json so quando diferente de 30, lida de volta e avisada', async () => {
  const FILE = '/download0/JobeesLair/settings.json';
  const fresh = (tag) => import(`../app/state/background-downloads.js?pause=${Date.now()}-${tag}`);
  globalThis.__stubFiles = new Map([[FILE, JSON.stringify({ backgroundDownloads: true, simultaneousDownloads: 2 })]]);
  try {
    const mod = await fresh('a');
    assert.deepEqual(mod.PAUSE_CHOICES, [0, 5, 10, 15, 20, 25, 30]);
    assert.equal(mod.pauseOnCloseSeconds(), 30, 'padrao: 30 s');
    const heard = [];
    const stop = mod.onPauseOnClose((value) => heard.push(value));
    mod.setPauseOnCloseSeconds(10);
    assert.deepEqual(JSON.parse(globalThis.__stubFiles.get(FILE)), { backgroundDownloads: true, simultaneousDownloads: 2, pauseOnCloseSeconds: 10 }, 'as outras opcoes ficam');
    assert.equal((await fresh('b')).pauseOnCloseSeconds(), 10, 'lida de volta do settings.json');
    mod.setPauseOnCloseSeconds(0);
    assert.equal((await fresh('c')).pauseOnCloseSeconds(), 0, '0 = sem pausa, guardado');
    for (const bad of [7, 31, -5, '10', null]) mod.setPauseOnCloseSeconds(bad);
    assert.equal(mod.pauseOnCloseSeconds(), 0, 'um valor fora da lista nao muda nada');
    mod.setPauseOnCloseSeconds(30);
    assert.deepEqual(JSON.parse(globalThis.__stubFiles.get(FILE)), { backgroundDownloads: true, simultaneousDownloads: 2 }, '30 s (o padrao): o campo sai');
    stop();
    mod.setPauseOnCloseSeconds(5);
    assert.deepEqual(heard, [10, 0, 30], 'quem parou de ouvir nao e chamado');
    for (const [saved, expected] of [[{ pauseOnCloseSeconds: 12 }, 30], [{ pauseOnCloseSeconds: 'x' }, 30], [{ pauseOnClose: false }, 0], [{ pauseOnClose: true }, 30]]) {
      globalThis.__stubFiles.set(FILE, JSON.stringify(saved));
      assert.equal((await fresh(JSON.stringify(saved))).pauseOnCloseSeconds(), expected, JSON.stringify(saved));
    }
  } finally {
    delete globalThis.__stubFiles;
  }
});

test('sair: bye() avisa o payload no ar (POST /bye com o token); sem token ou sem payload, falso e nada trava', async () => {
  const payload = fakePayload();
  const wrapper = make(payload, fakeEngine());
  payload.http.request = ((request) => async (url, options = {}) => {
    if (url.endsWith('/bye') && payload.up) {
      payload.calls.push({ method: options.method, path: '/bye', token: options.headers?.['X-Jobe-Token'] });
      return { status: 200, ok: true, json: async () => ({ ok: true, quietMs: 30000 }) };
    }
    return request(url, options);
  })(payload.http.request);
  assert.equal(await wrapper.bye(), true);
  assert.deepEqual(payload.calls.filter((call) => call.path === '/bye'), [{ method: 'POST', path: '/bye', token: TOKEN }]);
  payload.tokenOnDisk = false;
  assert.equal(await wrapper.bye(), false, 'sem payload (sem token): nada a avisar');
  assert.equal(payload.calls.filter((call) => call.path === '/bye').length, 1);
  payload.tokenOnDisk = true;
  payload.up = false;
  const down = make(payload, fakeEngine());
  assert.equal(await down.bye(), false, 'payload fora do ar: falso, sem excecao');
});

test('sair: sayByeToPayload usa o Downloads embrulhado em uso', async () => {
  const { sayByeToPayload } = await import('../app/state/background-downloads.js');
  const payload = fakePayload();
  make(payload, fakeEngine());
  const answer = await sayByeToPayload();
  assert.equal(answer, false, 'o payload falso responde 404 a /bye');
  assert.ok(payload.calls.some((call) => call.method === 'POST' && call.path === '/bye'));
});

test('sair: leaveApp avisa o payload e so depois fecha o app; sem resposta em waitMs, fecha mesmo assim', async () => {
  const { leaveApp, BYE_WAIT_MS } = await import('../app/state/exit-app.js');
  assert.equal(BYE_WAIT_MS, 1000, 'espera no maximo ~1 s');
  const order = [];
  assert.equal(await leaveApp({ bye: async () => { order.push('bye'); return true; }, exit: () => order.push('exit'), log: () => {} }), 'told');
  assert.deepEqual(order, ['bye', 'exit']);
  let closed = 0;
  const started = Date.now();
  assert.equal(await leaveApp({ bye: () => new Promise(() => {}), exit: () => ++closed, waitMs: 60, log: () => {} }), 'no answer in time');
  assert.equal(closed, 1);
  assert.ok(Date.now() - started < 1000, 'nao espera alem do limite');
  assert.equal(await leaveApp({ bye: () => { throw new Error('boom'); }, exit: () => ++closed, log: () => {} }), 'not told');
  assert.equal(await leaveApp({ bye: async () => false, exit: () => ++closed, log: () => {} }), 'not told');
  assert.equal(closed, 3, 'um aviso que falha nunca impede o app de fechar');
  // O padrao fecha pelo BackHandler.exitApp do ps5-react (o stub conta em __stubExits).
  const before = globalThis.__stubExits ?? 0;
  await leaveApp({ bye: async () => true, log: () => {} });
  assert.equal(globalThis.__stubExits, before + 1);
});

test('sair: a folha conta os downloads do app (param) e os do payload (continuam)', async () => {
  const { exitSummary } = await import('../app/state/exit-app.js');
  const jobs = [
    { state: 'downloading', downloadDestination: '/d/a' },
    { state: 'downloading', downloadDestination: '/d/b' },
    { state: 'extracting', downloadDestination: '/d/c' },
    { state: 'queued', downloadDestination: '/d/d' },
    { state: 'queued', downloadDestination: '/d/e' },
    { state: 'installed', downloadDestination: '/d/f' },
    { state: 'failed', downloadDestination: '/d/g' }
  ];
  const owned = (destination) => destination === '/d/b' || destination === '/d/e';
  assert.deepEqual(exitSummary(jobs, owned), { app: 2, background: 2 });
  assert.deepEqual(exitSummary([], owned), { app: 0, background: 0 });
  assert.deepEqual(exitSummary(undefined, owned), { app: 0, background: 0 });
});

// ---- glibren.8: downloads simultaneos e conexoes escolhidos na pagina do celular / APK ----

test('glibren.8: o app adota os downloads simultaneos escolhidos no celular (uma vez por stamp) e nao os sobrescreve', async () => {
  const payload = fakePayload();
  // O payload diz que o celular escolheu 3 (stamp 1); depois, 2 (stamp 2), visto no GET /jobs do acompanhamento.
  const remote = { concurrency: 3, concurrencyBy: 'remote', concurrencyStamp: 1 };
  payload.http.request = ((request) => async (url, options = {}) => {
    const answer = await request(url, options);
    if (answer.status !== 200) return answer;
    const data = await answer.json();
    if (url.endsWith('/health') || url.endsWith('/jobs')) return { ...answer, json: async () => ({ ...data, ...remote }) };
    return { ...answer, json: async () => data };
  })(payload.http.request);
  let count = 1;
  const adopted = [];
  const wrapper = make(payload, fakeEngine(), {
    concurrency: () => count,
    // Como setSimultaneousDownloads: grava e avisa a fila, que passa o numero ao payload (setConcurrency).
    adoptConcurrency: (n) => { adopted.push(n); count = n; wrapper.setConcurrency(n); }
  });
  wrapper.enqueue(queueOptions({ background: { ...queueOptions().background, key: 'job-7' } }));
  await wait(40);
  assert.deepEqual(adopted, [3], 'adotou o numero do celular');
  assert.ok(payload.configs.length >= 1 && payload.configs.every((config) => config.concurrency === 3), `nunca mandou o 1 antigo: ${JSON.stringify(payload.configs)}`);
  assert.equal(payload.jobs[0].key, 'job-7', 'o item da fila vai no POST /jobs (conexoes escolhidas para ele no celular)');
  // O celular muda de novo com o download rodando: o acompanhamento (GET /jobs) traz o stamp novo.
  Object.assign(remote, { concurrency: 2, concurrencyStamp: 2 });
  await wait(40);
  assert.deepEqual(adopted, [3, 2]);
  assert.equal(payload.configs.at(-1).concurrency, 2);
  // O jogador muda no app: o stamp do celular ja foi adotado, entao o app nao volta ao 2 (mesmo antes de o payload
  // responder que agora e do app).
  count = 4;
  wrapper.setConcurrency(4);
  await wait(40);
  assert.deepEqual(adopted, [3, 2], 'nao desfaz a escolha feita no app');
  assert.equal(count, 4);
  assert.equal(payload.configs.at(-1).concurrency, 4);
  for (const job of payload.jobs) job.state = 'completed';
  await wait(30);
});

test('glibren.8: sem escolha no celular (concurrencyBy "app"), nada e adotado; uma chave invalida nao vai no POST /jobs', async () => {
  const payload = fakePayload();
  payload.http.request = ((request) => async (url, options = {}) => {
    const answer = await request(url, options);
    if (answer.status !== 200 || !url.endsWith('/health')) return answer;
    const data = await answer.json();
    return { ...answer, json: async () => ({ ...data, concurrency: 4, concurrencyBy: 'app', concurrencyStamp: 9 }) };
  })(payload.http.request);
  const adopted = [];
  const wrapper = make(payload, fakeEngine(), { concurrency: () => 1, adoptConcurrency: (n) => adopted.push(n) });
  wrapper.enqueue(queueOptions({ background: { ...queueOptions().background, key: 'tem espaco/e barra' } }));
  await wait(30);
  assert.deepEqual(adopted, []);
  assert.deepEqual(payload.configs, [{ concurrency: 1 }]);
  assert.ok(!('key' in payload.jobs[0]));
  for (const job of payload.jobs) job.state = 'completed';
  await wait(30);
});
