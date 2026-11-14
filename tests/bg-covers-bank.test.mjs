// Banco de capas pelo celular (app/native/bg_covers_bank.c), com o payload compilado para o PC e rodado de verdade:
//   - rotas /api/capas/* so com aparelho pareado (401 sem credencial; o token do pareamento em X-Session);
//   - /api/capas/lista: as pedidas primeiro, depois o catalogo; as urls da Sony vao ao celular (o payload nao baixa);
//     sem os jogos que ja tem capa no banco, no cache do proxy ou instalados; "falhou" tira por 24 h;
//   - /api/capas/enviar: so PNG/JPEG/WebP pelos bytes, so ids do catalogo (ou pedidos), ate 512 KiB, banco com teto
//     de bytes e de arquivos (507 cheio), um arquivo por jogo; sobrevive a reiniciar;
//   - /app/capa?id= usa o banco PRIMEIRO (X-Capa-Fonte: banco) e o que nada serviu vira pedida;
//   - /app/capa?u=<url do catalogo> (a TV): acha o jogo pela URL (sem o ?w=) e serve do banco;
//   - /api/capas/apagar esvazia.
// Run: node --import ./tests/stub-loader.mjs --test tests/bg-covers-bank.test.mjs
import test, { after, before as whenBuilt } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuilt, buildSkip, compileTo } from './payload-build.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-capas-banco-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
const skip = buildSkip(compiler, built);
whenBuilt(() => { if (!skip) assertBuilt(built); });
const children = new Set();
after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

// Os 20 blocos de tests/free-port.mjs (12000-31999) ja tem dono: este arquivo usa 32000-32767 (abaixo da faixa
// automatica do Linux, 32768+), uma porta por vez nesta execucao.
let nextPort = 32000;
const canListen = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});
async function freePort() {
  while (nextPort < 32768) { const port = nextPort++; if (await canListen(port)) return port; }
  throw new Error('sem porta livre em 32000-32767');
}

const SONY = (n) => `https://image.api.playstation.com/vulcan/ap/rnd/2026/capa${n}.png?w=440`;
const GAMES = [
  { id: 'PPSA10001', title: 'Um', cover: SONY(1) },
  { id: 'PPSA10002', title: 'Dois', cover: SONY(2) },
  { id: 'PPSA10003', title: 'Tres', cover: SONY(3) },
  { id: 'PPSA10004', title: 'Instalado', cover: SONY(4) },
  { id: 'PPSA10005', title: 'No cache', cover: SONY(5) },
  { id: 'CUSA10006', title: 'Avif', cover: 'https://cdn.exemplo.invalid/capa.avif' },
];
function storeIndex(games) {
  return JSON.stringify({ version: 1, key: 'kc', builtAt: 'x', console: 'ps5', readyFirmware: '13.60', facets: {},
    games: games.map((g, i) => ({ code: g.id, platform: g.id.startsWith('CUSA') ? 'ps4' : 'ps5', s: g.title.toLowerCase(), formats: [], solo: null, rank: [i, i, i, i, i], ...g })) });
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7), Buffer.from([0xff, 0xd9])]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(28, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40, 0)]);

let run = 0;
async function startPayload({ base, env = {} } = {}) {
  base ??= path.join(dir, `run${++run}`);
  for (const sub of ['state', 'store', 'appmeta/PPSA10004', 'capas-cache']) mkdirSync(path.join(base, sub), { recursive: true });
  if (!existsSync(path.join(base, 'store/store-index.json'))) {
    writeFileSync(path.join(base, 'store/store-index.json'), storeIndex(GAMES));
    writeFileSync(path.join(base, 'appmeta/PPSA10004/icon0.png'), PNG);
    writeFileSync(path.join(base, 'capas-cache/PPSA10005.png'), PNG);
  }
  const api = await freePort(), monitor = await freePort();
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor),
    BGDL_ORBIT_DIR: path.join(base, 'orbit'), BGDL_LIBRARY: path.join(base, 'lista.json'), BGDL_KEYFILE: path.join(base, 'debrid.json'),
    BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_GLIBREN_BASE: 'http://127.0.0.1:9', BGDL_GITHUB_BASE: 'http://127.0.0.1:9', BGDL_STORE_DIR: path.join(base, 'store'),
    BGDL_APPMETA_DIR: path.join(base, 'appmeta'), BGDL_CAPAS_DIR: path.join(base, 'capas-cache'), BGDL_CAPA_DOH: 'off', BGDL_CAPA_PATCHES: 'off',
    BGDL_CAPAS_BANCO_DIR: path.join(base, 'banco'), BGDL_CAPAS_BANCO_LIVRE: '0', ...env }, stdio: ['ignore', 'ignore', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const req = (route, { method = 'GET', session, body, json } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (session) headers['X-Session'] = session;
    let data;
    if (json !== undefined) { data = Buffer.from(JSON.stringify(json)); headers['Content-Type'] = 'application/json'; }
    else if (body !== undefined) { data = body; headers['Content-Type'] = 'application/octet-stream'; }
    if (data) headers['Content-Length'] = data.length;
    const r = http.request({ host: '127.0.0.1', port: monitor, path: route, method, headers }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c));
      res.on('end', () => { const buf = Buffer.concat(parts); let parsed = {}; try { parsed = JSON.parse(buf.toString('utf8')); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: buf, data: parsed }); });
    });
    r.on('error', reject);
    r.end(data);
  });
  for (const end = performance.now() + 30000; ; await wait(50)) {
    try { if ((await req('/api/status')).status === 200) break; } catch {}
    if (performance.now() > end) throw new Error('payload did not start');
  }
  const notices = () => { try { return readFileSync(path.join(base, 'notify.txt'), 'utf8'); } catch { return ''; } };
  const stop = () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); });
  return { base, req, notices, stop };
}
// Pareia um aparelho (o codigo vem da notificacao da TV) e devolve o token.
async function pair(p) {
  assert.equal((await p.req('/api/pair/request', { method: 'POST', json: { name: 'Celular' } })).status, 200);
  const all = [...p.notices().matchAll(/(\d{3}) (\d{3})/g)];
  const done = await p.req('/api/pair/confirm', { method: 'POST', json: { code: all.at(-1)[1] + all.at(-1)[2], name: 'Celular' } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return done.data.token;
}

test('bg_covers_bank.c compila junto com o payload, sem avisos (-Wall -Wextra -Werror)', { skip: !compiler ? 'no compiler' : skip }, () => {
  assert.equal(built.status, 0, built.stderr);
});

test('capas: as rotas pedem aparelho pareado; lista com a Sony para o celular, sem instalado/cache/avif; pedida vai primeiro', { skip }, async () => {
  const p = await startPayload();
  for (const [route, method] of [['/api/capas/estado', 'GET'], ['/api/capas/lista', 'GET'], ['/api/capas/enviar?id=PPSA10001', 'POST'], ['/api/capas/falhou?ids=PPSA10001', 'POST'], ['/api/capas/apagar', 'POST']])
    assert.equal((await p.req(route, { method, body: method === 'POST' ? JPEG : undefined })).status, 401, `${route} sem credencial`);
  assert.equal((await p.req('/api/capas/estado', { session: 'f'.repeat(64) })).status, 401, 'token inventado');
  const token = await pair(p);
  assert.equal((await p.req('/api/capas/nada', { session: token })).status, 404);
  assert.equal((await p.req('/api/capas/enviar?id=PPSA10001', { session: token })).status, 404, 'enviar so por POST');

  const estado = (await p.req('/api/capas/estado', { session: token })).data;
  assert.equal(estado.ok, true);
  assert.equal(estado.enviadas, 0);
  assert.equal(estado.catalogo, 6);
  assert.equal(estado.faltando, 4, 'sem o instalado (icon0) e o que ja esta no cache do proxy');
  assert.equal(estado.maxImagem, 512 * 1024);
  assert.equal(estado.cheio, false);

  let lista = (await p.req('/api/capas/lista?max=10', { session: token })).data;
  assert.deepEqual(lista.itens.map((i) => i.id), ['PPSA10001', 'PPSA10002', 'PPSA10003'], 'na ordem da loja; o avif nao vai (o celular nao abre)');
  assert.deepEqual(lista.itens[0].urls, [SONY(1)], 'a url da Sony vai ao celular, que baixa pela internet dele');
  assert.equal(lista.faltando, 4);

  // /app/capa sem nada (a Sony o payload nunca baixa): 404 e vira pedida, a primeira da lista
  const nada = await p.req('/app/capa?id=PPSA10003');
  assert.equal(nada.status, 404);
  lista = (await p.req('/api/capas/lista?max=2', { session: token })).data;
  assert.deepEqual(lista.itens.map((i) => i.id), ['PPSA10003', 'PPSA10001'], 'a pedida primeiro; max respeitado');
  assert.equal(lista.pedidas, 1);

  // falhou: sai da lista (e da conta) por 24 h
  assert.deepEqual((await p.req('/api/capas/falhou?ids=PPSA10003,PPSA10002,lixo', { method: 'POST', session: token })).data, { ok: true, marcadas: 2 });
  lista = (await p.req('/api/capas/lista', { session: token })).data;
  assert.deepEqual(lista.itens.map((i) => i.id), ['PPSA10001']);
  assert.equal(lista.faltando, 2);
  assert.equal(lista.pedidas, 0);
  await p.stop();
});

test('capas: enviar confere tipo pelos bytes, id, catalogo e tamanho; /app/capa (id e url da TV) serve do banco primeiro; sobrevive a reiniciar; apagar', { skip }, async () => {
  const p = await startPayload();
  const token = await pair(p);
  const send = (id, body) => p.req(`/api/capas/enviar?id=${id}`, { method: 'POST', session: token, body });
  assert.equal((await send('ppsa10001', JPEG)).status, 400, 'id em minusculas');
  assert.equal((await send('../../x', JPEG)).status, 400);
  assert.equal((await send('PPSA10001', Buffer.alloc(0))).data.error, 'vazio');
  const gif = await send('PPSA10001', GIF);
  assert.equal(gif.status, 415, 'GIF nao');
  assert.equal(gif.data.error, 'tipo');
  assert.equal((await send('PPSA10001', Buffer.from('<html>erro</html>'))).status, 415, 'HTML no lugar da imagem');
  const fora = await send('PPSA99999', JPEG);
  assert.equal(fora.status, 404, 'fora do catalogo');
  assert.equal(fora.data.error, 'fora-do-catalogo');
  const grande = await send('PPSA10001', Buffer.concat([JPEG, Buffer.alloc(512 * 1024, 1)])).catch((error) => ({ status: 413, error }));
  assert.equal(grande.status, 413, 'acima de 512 KiB');

  const ok = await send('PPSA10001', JPEG);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data, { ok: true, id: 'PPSA10001', enviadas: 1, bytes: JPEG.length });
  assert.ok(existsSync(path.join(p.base, 'banco/PPSA10001.jpg')));
  const capa = await p.req('/app/capa?id=PPSA10001');
  assert.equal(capa.status, 200);
  assert.equal(capa.headers['x-capa-fonte'], 'banco');
  assert.equal(capa.headers['content-type'], 'image/jpeg');
  assert.ok(capa.body.equals(JPEG));
  // o mesmo jogo em PNG: troca (um arquivo por jogo)
  assert.equal((await send('PPSA10001', PNG)).data.enviadas, 1);
  assert.deepEqual(readdirSync(path.join(p.base, 'banco')).filter((f) => !f.endsWith('.tmp')), ['PPSA10001.png']);
  assert.equal((await send('PPSA10002', WEBP)).status, 200, 'WebP tambem');
  // o banco vem antes do icon0 do jogo instalado
  assert.equal((await send('PPSA10004', JPEG)).status, 200);
  assert.equal((await p.req('/app/capa?id=PPSA10004')).headers['x-capa-fonte'], 'banco');
  // a TV pede pela URL (outra largura no ?w=)
  const tv = await p.req(`/app/capa?u=${encodeURIComponent(SONY(2).replace('w=440', 'w=300'))}`);
  assert.equal(tv.status, 200);
  assert.equal(tv.headers['x-capa-fonte'], 'banco');
  assert.equal(tv.headers['content-type'], 'image/webp');
  assert.equal((await p.req(`/app/capa?u=${encodeURIComponent('https://outro.site/x.png')}`)).status, 404, 'URL fora do catalogo');
  assert.equal((await p.req('/app/capa?u=http%3A%2F%2F127.0.0.1%2Fx')).status, 404, 'so https');

  let estado = (await p.req('/api/capas/estado', { session: token })).data;
  assert.equal(estado.enviadas, 3);
  assert.equal(estado.recebidas, 4);
  assert.ok(estado.servidas >= 3);
  assert.ok(estado.recusadas >= 6);
  assert.deepEqual((await p.req('/api/capas/lista', { session: token })).data.itens.map((i) => i.id), ['PPSA10003']);

  // reiniciar: o banco continua
  await p.stop();
  const q = await startPayload({ base: p.base });
  estado = (await q.req('/api/capas/estado', { session: token })).data;
  assert.equal(estado.enviadas, 3, 'o banco foi lido da pasta');
  assert.equal(estado.bytes, PNG.length + WEBP.length + JPEG.length);
  assert.equal((await q.req('/app/capa?id=PPSA10002')).headers['x-capa-fonte'], 'banco');
  assert.deepEqual((await q.req('/api/capas/apagar', { method: 'POST', session: token })).data, { ok: true, apagadas: 3 });
  assert.equal((await q.req('/api/capas/estado', { session: token })).data.enviadas, 0);
  assert.deepEqual(readdirSync(path.join(p.base, 'banco')), []);
  assert.equal((await q.req('/app/capa?id=PPSA10004')).headers['x-capa-fonte'], 'local', 'sem o banco, o icon0 de novo');
  await q.stop();
});

test('capas: limites do banco (bytes e arquivos) dao 507 cheio; cheio = lista vazia', { skip }, async () => {
  const p = await startPayload({ env: { BGDL_CAPAS_BANCO_MAX: String(JPEG.length + 100), BGDL_CAPAS_BANCO_ARQUIVOS: '2' } });
  const token = await pair(p);
  const send = (id, body) => p.req(`/api/capas/enviar?id=${id}`, { method: 'POST', session: token, body });
  assert.equal((await send('PPSA10001', JPEG)).status, 200);
  const cheio = await send('PPSA10002', JPEG);
  assert.equal(cheio.status, 507, 'passaria do teto de bytes');
  assert.equal(cheio.data.error, 'cheio');
  assert.equal((await send('PPSA10001', PNG)).status, 200, 'trocar a do mesmo jogo por uma menor cabe');
  assert.equal((await send('PPSA10002', PNG)).status, 200);
  assert.equal((await send('PPSA10003', PNG)).status, 507, 'teto de arquivos (2)');
  const estado = (await p.req('/api/capas/estado', { session: token })).data;
  assert.equal(estado.cheio, true);
  const lista = (await p.req('/api/capas/lista', { session: token })).data;
  assert.equal(lista.cheio, true);
  assert.deepEqual(lista.itens, [], 'cheio: o celular nao baixa nada');
  await p.stop();
  // pouco espaco livre no disco tambem enche
  const q = await startPayload({ env: { BGDL_CAPAS_BANCO_LIVRE: String(2 ** 60) } });
  const t2 = await pair(q);
  assert.equal((await q.req('/api/capas/enviar?id=PPSA10001', { method: 'POST', session: t2, body: JPEG })).status, 507);
  assert.equal((await q.req('/api/capas/estado', { session: t2 })).data.cheio, true);
  await q.stop();
});
