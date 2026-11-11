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

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-orbit-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 400)}` : false;
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
const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

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
async function call(base, method, route, body, token) {
  const tok = token ?? readFileSync(path.join(base, 'state/token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': tok, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function up(base) {
  for (let i = 0; i < 100; i++) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call(base, 'GET', '/health')).status === 200) return; } catch {}
    await wait(50);
  }
  throw new Error('payload did not start');
}
async function until(base, check, ms = 15000) {
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
  for (const child of [...children]) child.kill('SIGKILL');
  await wait(200);
  start(base);
  await up(base);
  await call(base, 'POST', '/orbit', { refresh: true });
  await until(base, (s) => s.lastOk > first.lastOk - 120);
  assert.equal(statSync(file).mtimeMs, written, 'revision 95 again: the file the app reads keeps its stamp');
  srv.body = seal(catalogue(96));
  writeFileSync(path.join(base, 'orbit/orbit-store-status.json'), JSON.stringify({ ...(await call(base, 'GET', '/orbit')).data, lastTry: 1 }));
  for (const child of [...children]) child.kill('SIGKILL');
  await wait(200);
  start(base);
  await up(base);
  const next = await until(base, (s) => s.revision === 96);
  assert.ok(next.revisionSince >= first.revisionSince);
  assert.ok(statSync(file).mtimeMs >= written);
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
  for (const child of [...children]) child.kill('SIGKILL');
  await wait(200);
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
