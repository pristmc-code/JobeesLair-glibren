// glibren.20: a lista Orbit Store no payload (app/native/bg_orbit.c), compilado para o desktop e rodado contra um servidor
// local que serve um catalogue-v8.enc feito aqui com a mesma cifra do Orbit (AES-256-GCM, cabecalho ORBITENC como AAD,
// a chave de app/native/orbit_key.h): liga e grava o feed da Jobe (jogos agrupados, formato, descricao, capa e fundo, um
// "record" por link), nao reescreve uma revisao igual, uma chave diferente vira "broken" na hora e uma rede fora ha mais de
// 24 h vira "failing", os dois com notificacao do PS5 (BGDL_NOTIFY_FILE), e a volta tambem avisa. Run: npm test
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortFrom } from './free-port.mjs';
import { before as whenBuilt } from 'node:test';
import { assertBuilt, buildSkip, compileTo } from './payload-build.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-orbit-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : false;
// glibren.51: um binario que nao compilou (erro, aviso com -Werror ou o compilador morto por sinal) FALHA todos os
// testes deste arquivo na hora, com o motivo; antes eles viravam "pulados" e ninguem via. So a falta do ambiente pula.
whenBuilt(() => { if (!skip) assertBuilt(built); });
const children = new Set();
let server;
beforeEach(async () => {
  const left = [...children];
  for (const child of left) child.kill('SIGKILL');
  await Promise.all(left.map((child) => child.exitCode !== null || child.signalCode ? null : new Promise((resolve) => child.once('exit', resolve))));
});
after(() => {
  for (const child of children) child.kill('SIGKILL');
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = freePortFrom(3); // glibren.41 (T1): bloco de portas so deste arquivo (tests/free-port.mjs)

const KEY = Buffer.from(readFileSync(path.join(repo, 'app/native/orbit_key.h'), 'utf8').match(/0x[0-9a-fA-F]{2}/g).map((byte) => parseInt(byte, 16)));
// O envelope do Orbit (backend/catalog_crypto.c catalog_seal): magic, formato 1, chave 1, proposito 1, 0, nonce, cifra, tag.
function seal(value, key = KEY) {
  const header = Buffer.concat([Buffer.from('ORBITENC'), Buffer.from([1, 1, 1, 0]), randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(12));
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}
const art = (id) => ({ cover: `https://img.example/${id}/icon0.webp`, hero: `https://img.example/${id}/pic0.webp`, coverFallback: `https://img.example/${id}/fallback.png` });
const catalogue = (revision) => ({
  schemaVersion: 1, feedVersion: 8, revision,
  releases: [
    { id: 'ppsa04029-ffpfsc', titleId: 'PPSA04029', platform: 'ps5', sourceId: 'archive', provider: 'Archive.org', format: 'FFPFSC', filename: 'PPSA04029 Cyberpunk 2077.ffpfsc', sizeBytes: 156011528192, url: 'https://archive.org/download/x/PPSA04029.ffpfsc', sha256: '', version: null, region: 'EUR', title: 'Cyberpunk 2077', genre: 'Role-playing', tagline: 'Your story.', description: 'Become a mercenary in Night City.', publisher: 'CD PROJEKT RED', releaseDate: '2022-02-15', addedAt: '2026-10-03T19:37:21+05:30', ...art('PPSA04029') },
    { id: 'ppsa04029-vik-rar', titleId: 'PPSA04029', platform: 'ps5', sourceId: 'vikingfile', provider: 'Vikingfile', format: 'Game folder', compression: 'rar', filename: 'PPSA04029.rar', sizeBytes: 90000000000, url: 'https://vikingfile.com/d/abcdefghij/PPSA04029.rar', region: 'EUR', title: 'Cyberpunk 2077', ...art('PPSA04029') },
    { id: 'cusa00021-pkg', titleId: 'cusa00021', platform: 'ps4', sourceId: 'akirabox', provider: 'AkiraBox', format: 'FPKG', filename: 'WATCH_DOGS.pkg', sizeBytes: 17755209728, url: 'https://akirabox.com/abcdef/file', version: '01.05', region: 'USA', title: 'Watch Dogs', description: `Hack Chicago. ${'Lorem ipsum dolor sit amet. '.repeat(100)}`, ...art('CUSA00021') },
    { id: 'bad-1', titleId: 'XYZ00001', title: 'Not a console game', url: 'https://example.com/x.pkg' },
    { id: 'bad-2', titleId: 'PPSA00002', title: 'Insecure', url: 'http://example.com/x.pkg' },
  ],
  addons: [{ id: 'dlc-1', titleId: 'CUSA20499', url: 'https://archive.org/download/dlc.pkg' }],
});
const srv = { body: null, status: 200, hits: 0, retryAfter: null };
let port, api, monitorPort;
if (!skip) {
  port = await freePort();
  server = http.createServer((req, res) => {
    srv.hits++;
    if (srv.status !== 200 || !srv.body) {
      res.writeHead(srv.status === 200 ? 404 : srv.status, srv.retryAfter ? { 'Retry-After': String(srv.retryAfter) } : {});
      return res.end('no');
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': srv.body.length });
    res.end(srv.body);
  }).listen(port, '127.0.0.1');
  api = await freePort();
  monitorPort = await freePort();
}

let run = 0;
function workspace() {
  const base = path.join(dir, `run${++run}`);
  mkdirSync(path.join(base, 'state'), { recursive: true });
  mkdirSync(path.join(base, 'orbit'), { recursive: true });
  return base;
}
function start(base, env = {}) {
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitorPort),
    BGDL_ORBIT_DIR: path.join(base, 'orbit'), BGDL_ORBIT_URL: `http://127.0.0.1:${port}/catalogue-v8.enc`, BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
// Um GET (sem efeito) que falha na conexao e repetido por ate 10 s: depois de matar e subir o payload de novo na mesma
// porta, o fetch pode reaproveitar uma conexao keep-alive do processo morto ("fetch failed"), mais sob carga.
async function retryGet(method, ask) {
  for (let attempt = 0, end = Date.now() + 10000; ; attempt++) {
    try { return await ask(); } catch (problem) {
      if (method !== 'GET' || Date.now() >= end) throw new Error(`${problem.message}: ${problem.cause?.code || problem.cause?.message || ''}`, { cause: problem });
      await wait(Math.min(50 * 2 ** attempt, 1000));
    }
  }
}
async function call(base, method, route, body, token) {
  const tok = token ?? readFileSync(path.join(base, 'state/token'), 'utf8').trim();
  const res = await retryGet(method, () => fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': tok, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
// Com prazo largo (nao 100 voltas de 50 ms): com a suite inteira em paralelo o payload demora mais a subir.
async function up(base, ms = 30000) {
  for (const end = performance.now() + ms; performance.now() < end; await wait(50)) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call(base, 'GET', '/health')).status === 200) return; } catch {}
  }
  throw new Error('payload did not start');
}
// Mata os payloads e espera cada um sair de fato (nao 200 ms fixos) antes de subir o seguinte.
async function killAll() {
  const left = [...children];
  for (const child of left) child.kill('SIGKILL');
  await Promise.all(left.map((child) => (child.exitCode !== null || child.signalCode ? null : new Promise((resolve) => child.once('exit', resolve)))));
}
async function until(base, check, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const state = (await call(base, 'GET', '/orbit')).data;
    if (check(state)) return state;
  }
  throw new Error('the Orbit list never got there');
}
const notices = (base) => existsSync(path.join(base, 'notify.txt')) ? readFileSync(path.join(base, 'notify.txt'), 'utf8').trim().split('\n') : [];

test('bg_orbit.c compila junto do payload sem avisos (-Wall -Wextra -Werror)', { skip: !compiler || missing ? 'no compiler or headers' : false }, () => {
  assert.equal(built.status, 0, built.stderr);
});

test('off by default; turned on, it downloads, decrypts and writes the Jobe feed (grouped games, artwork, one record per link)', { skip }, async () => {
  const base = workspace();
  srv.body = seal(catalogue(95));
  srv.status = 200;
  srv.hits = 0;
  start(base);
  await up(base);
  assert.equal((await call(base, 'GET', '/orbit', undefined, 'wrong')).status, 401, 'the token is required');
  const off = (await call(base, 'GET', '/orbit')).data;
  assert.equal(off.enabled, false);
  await wait(300);
  assert.equal(srv.hits, 0, 'nothing is downloaded while the list is off');
  assert.equal((await call(base, 'POST', '/orbit', { enabled: true })).status, 200);
  const state = await until(base, (s) => s.lastOk > 0);
  assert.equal(state.revision, 95);
  assert.equal(state.games, 2);
  assert.equal(state.releases, 3);
  assert.equal(state.stale, '');
  const feed = JSON.parse(readFileSync(path.join(base, 'orbit/orbit-store.json'), 'utf8'));
  assert.equal(feed.version, 1);
  assert.equal(feed.name, 'Orbit Store');
  assert.deepEqual(feed.games.map((game) => game.id), ['CUSA00021', 'PPSA04029'], 'by title, the bad entries and the add-ons left out');
  const cyberpunk = feed.games[1];
  assert.equal(cyberpunk.platform, 'ps5');
  assert.equal(cyberpunk.summary, 'Your story.');
  assert.deepEqual(cyberpunk.about, ['Become a mercenary in Night City.']);
  assert.equal(cyberpunk.art.hero, 'https://img.example/PPSA04029/pic0.webp');
  assert.deepEqual(cyberpunk.art.coverFallbacks, ['https://img.example/PPSA04029/fallback.png']);
  assert.equal(cyberpunk.addedAt, '2026-10-03');
  assert.deepEqual(cyberpunk.genres, ['Role-playing']);
  assert.equal(cyberpunk.releases.length, 2);
  assert.deepEqual(cyberpunk.releases.map((r) => r.format), ['ffpfsc', 'rar'], 'an archive is its compression; the image its format');
  assert.equal(cyberpunk.releases[1].label, 'Vikingfile - EUR - Game folder (rar)');
  assert.deepEqual(cyberpunk.releases.map((r) => r.record), ['orbit-ppsa04029-ffpfsc', 'orbit-ppsa04029-vik-rar'], 'each link is its own set');
  assert.equal(cyberpunk.releases[0].sizeBytes, 156011528192);
  assert.equal(feed.games[0].releases[0].format, 'fpkg');
  assert.equal(feed.games[0].releases[0].version, '01.05');
  // glibren.26: a descricao longa vai cortada numa palavra (no maximo 1500 bytes e "..."), para caber no heap do app.
  const about = feed.games[0].about[0];
  assert.ok(about.startsWith('Hack Chicago. Lorem') && about.endsWith('amet....') && about.length <= 1503, about.slice(-40));
  assert.ok(existsSync(path.join(base, 'orbit/orbit-store-status.json')));
  assert.deepEqual(notices(base), [], 'no notification while it is fine');
});

test('the same revision does not rewrite the feed; a new one does; a refresh right after is not a new download', { skip }, async () => {
  const base = workspace();
  srv.body = seal(catalogue(95));
  srv.status = 200;
  start(base);
  await up(base);
  await call(base, 'POST', '/orbit', { enabled: true });
  const first = await until(base, (s) => s.lastOk > 0);
  const file = path.join(base, 'orbit/orbit-store.json');
  const written = statSync(file).mtimeMs;
  const hits = srv.hits;
  await call(base, 'POST', '/orbit', { refresh: true });
  await wait(600);
  assert.equal(srv.hits, hits, 'a refresh within a minute of the last try is ignored');
  // A minute later (the status says so), the same revision: read again, file untouched.
  writeFileSync(path.join(base, 'orbit/orbit-store-status.json'), JSON.stringify({ ...first, lastTry: first.lastTry - 120, lastOk: first.lastOk - 120 }));
  await killAll();
  start(base);
  await up(base);
  await call(base, 'POST', '/orbit', { refresh: true });
  await until(base, (s) => s.lastOk > first.lastOk - 120);
  assert.equal(statSync(file).mtimeMs, written, 'revision 95 again: the file the app reads keeps its stamp');
  srv.body = seal(catalogue(96));
  writeFileSync(path.join(base, 'orbit/orbit-store-status.json'), JSON.stringify({ ...(await call(base, 'GET', '/orbit')).data, lastTry: 1 }));
  await killAll();
  start(base);
  await up(base);
  const next = await until(base, (s) => s.revision === 96);
  assert.ok(next.revisionSince >= first.revisionSince);
  // Regravado: conferido pelo conteudo, nao pelo mtime (o relogio do WSL pode andar para tras sob carga e o mtime novo
  // ficava menor que o antigo).
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).orbitRevision, 96, 'the feed was rewritten with revision 96');
});

test('a catalogue sealed with another key is "broken" at once, with a PS5 notification; a good one brings it back', { skip }, async () => {
  const base = workspace();
  srv.body = seal(catalogue(95), randomBytes(32));
  srv.status = 200;
  start(base);
  await up(base);
  await call(base, 'POST', '/orbit', { enabled: true });
  const state = await until(base, (s) => s.lastTry > 0 && !s.busy);
  assert.equal(state.kind, 'broken');
  assert.equal(state.stale, 'broken');
  assert.match(state.error, /no longer opens/);
  assert.ok(!existsSync(path.join(base, 'orbit/orbit-store.json')), 'nothing written');
  await until(base, (s) => s.said === 'broken');
  assert.match(notices(base).join('\n'), /parou de atualizar/);
  // Fixed upstream: the next try (a minute later) works and says so.
  srv.body = seal(catalogue(95));
  writeFileSync(path.join(base, 'orbit/orbit-store-status.json'), JSON.stringify({ ...(await call(base, 'GET', '/orbit')).data, lastTry: 1 }));
  await killAll();
  start(base);
  await up(base);
  await until(base, (s) => s.lastOk > 0 && s.said === '');
  assert.match(notices(base).join('\n'), /voltou a atualizar/);
});

test('no successful update for more than 24 hours is "failing", notified once; Retry-After pushes the next try', { skip }, async () => {
  const base = workspace();
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(path.join(base, 'orbit/orbit-store-status.json'), JSON.stringify({ enabled: true, enabledAt: now - 30 * 86400, lastTry: now - 7 * 3600, lastOk: now - 25 * 3600, revision: 95, revisionSince: now - 2 * 86400, games: 2, releases: 3, kind: '', error: '', said: '' }));
  srv.status = 503;
  srv.retryAfter = 7200;
  start(base);
  await up(base);
  const state = await until(base, (s) => s.lastTry > now - 60 && s.said === 'failing');
  assert.equal(state.kind, 'network');
  assert.match(state.error, /HTTP 503/);
  assert.ok(state.retryUntil >= now + 7000, 'Retry-After kept');
  assert.equal(notices(base).filter((line) => /24 h/.test(line)).length, 1);
  await wait(500);
  assert.equal(notices(base).filter((line) => /24 h/.test(line)).length, 1, 'said once');
  srv.retryAfter = null;
  srv.status = 200;
});

test('off again: no more downloads, and a feed already written stays for the next time', { skip }, async () => {
  const base = workspace();
  srv.body = seal(catalogue(95));
  srv.status = 200;
  start(base);
  await up(base);
  await call(base, 'POST', '/orbit', { enabled: true });
  await until(base, (s) => s.lastOk > 0);
  const off = await call(base, 'POST', '/orbit', { enabled: false, refresh: true });
  assert.equal(off.data.enabled, false);
  assert.equal(off.data.stale, '');
  const hits = srv.hits;
  await wait(500);
  assert.equal(srv.hits, hits);
  assert.ok(existsSync(path.join(base, 'orbit/orbit-store.json')));
  assert.equal((await call(base, 'POST', '/orbit', '{bad')).status, 400);
});

// glibren.27: o app manda os codigos que ja conhece; o payload grava esses jogos so com os links, guarda a lista para a
// proxima vez que subir e regrava o feed quando ela muda (uma lista igual nao baixa de novo).
test('known titles: written with the links only, kept across restarts, and a new list rewrites the feed', { skip }, async () => {
  const base = workspace();
  srv.body = seal(catalogue(95));
  srv.status = 200;
  start(base);
  await up(base);
  const posted = await call(base, 'POST', '/orbit', { enabled: true, known: ['ppsa04029', 'XYZ00001', 'PPSA04029', 42] });
  assert.equal(posted.status, 200);
  assert.equal(posted.data.knownIds, 1, 'only valid PS4/PS5 codes, once');
  const state = await until(base, (s) => s.lastOk > 0 && s.known === 1);
  assert.equal(state.conv, 3);
  assert.match(state.knownHash, /^[0-9a-f]{16}$/);
  assert.equal(readFileSync(path.join(base, 'orbit/orbit-known.txt'), 'utf8'), 'PPSA04029\n');
  const file = path.join(base, 'orbit/orbit-store.json');
  let feed = JSON.parse(readFileSync(file, 'utf8'));
  const cyberpunk = feed.games.find((game) => game.id === 'PPSA04029');
  assert.deepEqual(Object.keys(cyberpunk), ['id', 'title', 'platform', 'releases'], 'a known game: no page, no art');
  assert.deepEqual(cyberpunk.releases.map((r) => r.record), ['orbit-ppsa04029-ffpfsc', 'orbit-ppsa04029-vik-rar']);
  assert.equal(cyberpunk.releases[1].label, 'Vikingfile - EUR - Game folder (rar)');
  const watchDogs = feed.games.find((game) => game.id === 'CUSA00021');
  assert.ok(watchDogs.about[0].startsWith('Hack Chicago.') && watchDogs.art.hero && watchDogs.art.cover, 'a new game keeps its page, cover and hero');
  // The same list again: nothing to do.
  const hits = srv.hits;
  await call(base, 'POST', '/orbit', { known: ['PPSA04029'] });
  await wait(600);
  assert.equal(srv.hits, hits);
  // Restarted (a minute later, as the status says): the list comes back from the file, the feed is not rewritten...
  const now = (await call(base, 'GET', '/orbit')).data;
  writeFileSync(path.join(base, 'orbit/orbit-store-status.json'), JSON.stringify({ ...now, lastTry: now.lastTry - 120, lastOk: now.lastOk - 120 }));
  await killAll();
  start(base);
  await up(base);
  const back = (await call(base, 'GET', '/orbit')).data;
  assert.equal(back.knownIds, 1);
  assert.equal(back.knownHash, state.knownHash);
  await wait(600);
  assert.equal(srv.hits, hits, 'the same list: no download');
  // ...and a different one rewrites it (Watch Dogs known now, Cyberpunk not).
  await call(base, 'POST', '/orbit', { known: ['CUSA00021'] });
  const next = await until(base, (s) => s.knownHash && s.knownHash !== state.knownHash && s.known === 1);
  assert.equal(next.revision, 95);
  feed = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(feed.games.find((game) => game.id === 'CUSA00021')), ['id', 'title', 'platform', 'releases']);
  assert.ok(feed.games.find((game) => game.id === 'PPSA04029').art.hero);
  // ~2.100 codes today; the body may pass the 64 KiB of the other routes.
  const many = Array.from({ length: 6000 }, (_, n) => `PPSA${String(n).padStart(5, '0')}`);
  const big = await call(base, 'POST', '/orbit', { known: many });
  assert.equal(big.status, 200);
  assert.equal(big.data.knownIds, 6000);
  assert.equal((await call(base, 'POST', '/orbit', { known: 'PPSA04029' })).status, 400, 'a list or nothing');
});
