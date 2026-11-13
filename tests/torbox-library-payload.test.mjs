// glibren.38 (item 3 do plano): a rede da rodada da Biblioteca TorBox no payload (app/native/bg_library.c +
// state/torbox-library-payload.js; a gravacao em passos fica em tests/torbox-library-save.test.mjs):
//   - o app le os blocos que o payload grava e casa como antes (sem nenhuma chamada propria ao TorBox);
//   - sem payload (ou um antigo): tudo pelo app;
//   - EQUIVALENCIA: o mesmo catalogo contra o mesmo TorBox falso (429, 414, pasta de milhares de arquivos, conta, lista de
//     hashes, nomes de arquivo, conjuntos em partes, magnets) da os mesmos banco, lista, ids e fichas pelo app (o caminho
//     antigo, services/torbox.js) e pelo payload compilado para o PC; a chave nunca vai a um arquivo nem ao diario;
//     cancelar para e o "Continuar" retoma dos blocos que faltam.
// Run: node --import ./tests/stub-loader.mjs --test tests/torbox-library-payload.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePortFrom } from './free-port.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const lib = await load('app/state/torbox-library.js');
const { createLibraryRemote, writePlan } = await load('app/state/torbox-library-payload.js');
const { createTorBox, md5 } = await load('app/services/torbox.js');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nodeMd5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

// ---- Um sistema de arquivos na memoria (o do app) e um no disco (o do payload) ----
function memoryFs() {
  const files = new Map();
  return { files, exists: (p) => files.has(p), readFile: (p) => { if (!files.has(p)) throw new Error(`no ${p}`); return files.get(p); }, writeFile: (p, text) => files.set(p, String(text)),
    appendFile: (p, text) => files.set(p, (files.get(p) ?? '') + text), mkdir() {}, remove: (p) => files.delete(p), rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); } };
}
const diskFs = {
  exists: (p) => existsSync(p), readFile: (p) => readFileSync(p, 'utf8'), writeFile: (p, text) => writeFileSync(p, String(text)), appendFile: (p, text) => appendFileSync(p, String(text)),
  mkdir: (p) => mkdirSync(p, { recursive: true }), remove: (p) => rmSync(p, { force: true }), rename: (a, b) => renameSync(a, b),
};

// ---- O catalogo de mentira ----
const HOST = 'https://host.example';
const web = (n, name = `game-${n}.exfat`) => `${HOST}/file/${n}/${encodeURIComponent(name)}`;
const idOf = (n) => `PPSA${String(n).padStart(5, '0')}`;
const torrentHash = (n) => nodeMd5(`torrent-${n}`).padEnd(40, '0').slice(0, 40);
function catalog(total = 140) {
  const games = [];
  for (let n = 1; n <= total; n++) {
    const id = idOf(n);
    const releases = [{ id: `r${n}`, url: web(n), filename: `game-${n}.exfat` }];
    if (n % 4 === 0) releases.push({ id: `r${n}b`, url: `${web(n, `game-${n}.pkg`)}?token=abc`, filename: `game-${n}.pkg` }); // a consulta sai do 2o MD5
    if (n % 9 === 0) releases.push({ id: `m${n}`, url: `magnet:?xt=urn:btih:${torrentHash(n)}&dn=Game+${n}`, filename: `Game ${n}` });
    if (n % 13 === 0) releases.push({ id: `set-${n}`, label: `Game ${n} · 3 parts`, parts: [1, 2, 3].map((part) => ({ number: part, sources: [{ url: web(n, `game-${n}.part${part}.rar`) }] })) });
    if (n % 17 === 0) releases.push({ id: `lost-${n}`, url: `${HOST}/gone/${n}`, filename: `lost-${n}.exfat` }); // achado so pelo nome
    games.push({ id, title: `Quest${n} Legends ${'ÁéÑ'[n % 3]}`, platform: n % 5 ? 'ps5' : 'ps4', genres: ['Action'], art: { cover: `https://img.example/${n}.png` }, sizeGb: n,
      formats: ['exfat'], releases, shortDescription: `Resumo ${n}`, about: [`Sobre o jogo ${n}.`], shots: [{ url: `https://img.example/${n}/shot.jpg` }], developer: 'Estudio' });
  }
  return games;
}
const entriesOf = (games) => games.map((game) => ({ game, sources: ['bundled'] }));
const HASH_LIST = { files: 1, entries: [{ hash: torrentHash(900), code: 'PPSA00031' }, { hash: torrentHash(901), code: null }, { hash: torrentHash(902), code: null }] };

// ---- O TorBox falso (o mesmo para o app e para o payload) ----
function fakeTorBox() {
  const held = new Map(); // hash -> entrada (texto JSON)
  const file = (id, name, size) => ({ id, name, short_name: name.split('/').pop(), size, mimetype: 'application/octet-stream', md5: null, s3_path: 'x' });
  const entry = (name, size, files) => ({ name, size, hash: 'ignored', files, extra: { deep: [1, 2, 3] } });
  for (let n = 1; n <= 200; n++) {
    if (n % 3 === 0) held.set(nodeMd5(web(n)), entry(`game-${n}.exfat`, n * 1e9, [file(0, `game-${n}.exfat`, n * 1e9), file(1, 'readme.txt', 10)]));
    if (n % 8 === 0) held.set(nodeMd5(web(n, `game-${n}.pkg`)), entry(`game-${n}.pkg`, 170, [file(0, `game-${n}.pkg`, 170)])); // copia quebrada
    if (n % 9 === 0 && n % 2 === 0) held.set(torrentHash(n), entry(`Game ${n} [PS5]`, 5e9, [file(0, `Game ${n}/${idOf(n)}.exfat`, 5e9), file(1, `Game ${n}/backports/PPSA/eboot.bin`, 2e6)]));
    if (n % 13 === 0 && n % 26 === 0) for (const part of [1, 2, 3]) held.set(nodeMd5(web(n, `game-${n}.part${part}.rar`)), entry(`game-${n}.part${part}.rar`, 4e9, [file(0, `game-${n}.part${part}.rar`, 4e9)]));
    if (n % 13 === 0 && n % 26 !== 0) held.set(nodeMd5(web(n, `game-${n}.part1.rar`)), entry(`game-${n}.part1.rar`, 4e9, [file(0, `game-${n}.part1.rar`, 4e9)])); // so uma parte
    if (n % 17 === 0) held.set(nodeMd5(`lost-${n}.exfat`), entry(`lost-${n}.exfat`, 3e9, [file(0, `lost-${n}.exfat`, 3e9)]));
    if (n % 11 === 0) held.set(nodeMd5(`${idOf(n)}.exfat`), entry(`Dump ${idOf(n)}`, 9e9, [file(0, `${idOf(n)}-app.ffpkg`, 9e9)]));
  }
  // Uma pasta de milhares de arquivos (o corte do payload e o do app tem de dar o mesmo).
  const dump = [];
  for (let f = 0; f < 2500; f++) dump.push(file(f, `Game 30/Image0/sce_module/data_${f}.bin`, f % 7 === 0 ? 2e6 + f : 1000 + f));
  dump.push(file(2500, 'Game 30/Game 30.exfat', 170), file(2501, 'Game 30/backports/PPSA/lib.prx', 5e6));
  held.set(nodeMd5(web(30)), entry('Game 30', 9e10, dump));
  // A lista do jogador: dois que o TorBox tem.
  held.set(torrentHash(900), entry('Some Torrent PPSA00031', 7e9, [file(0, 'x/PPSA00031.exfat', 7e9)]));
  held.set(torrentHash(901), entry('Quest44 Legends', 6e9, [file(0, 'Quest44 Legends/big.exfat', 6e9)]));
  const POISON = nodeMd5(web(50)); // um link que o TorBox recusa (414) sozinho ou em grupo
  const account = {
    webdl: Array.from({ length: 260 }, (_, i) => ({ id: 1000 + i, name: `Account Item ${i}`, hash: `w${i}`, size: 1e9, download_state: 'completed', download_finished: true, files: [file(0, `item-${i}.zip`, 1e9)] })),
    torrents: [{ id: 7, name: 'PPSA00060 Dump', hash: 'TT7', size: 6e9, download_finished: true, files: [file(0, 'PPSA00060/eboot.bin', 6e9), file(1, 'Quest61 Legends/game.exfat', 4e9)] }],
  };
  account.webdl[3].name = 'Quest70 Legends Ñ';
  // glibren.44: uma pasta de 3.000 arquivos na conta: o codigo so nos arquivos pequenos (que o payload corta e manda em
  // "codes") e os grandes so com o nome do jogo no caminho. Pelo payload, sem "codes" a conta nao casaria pelo codigo.
  const folder = [];
  for (let f = 0; f < 3000; f++) folder.push(f % 100 === 0 ? file(f, `Quest72 Legends/Image0/data_${f}.bin`, 5e6 + f) : file(f, `PPSA00072-app/sce_sys/p_${f}.dat`, 1000 + f));
  account.torrents.push({ id: 8, name: 'Big Folder Dump', hash: 'TT8', size: 9e9, download_finished: true, files: folder });
  const state = { calls: 0, limitOnce: new Set(['first-checkcached', 'first-mylist']), seen: [] };
  const answer = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    state.calls++;
    const url = new URL(req.url, 'http://x');
    state.seen.push(`${req.headers.authorization ?? ''} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${KEY}`) return answer(res, 403, { success: false, error: 'BAD_TOKEN', detail: 'no' });
    if (url.pathname.endsWith('/checkcached')) {
      if (state.limitOnce.delete('first-checkcached')) return answer(res, 429, '{"success":false}');
      const hashes = (url.searchParams.get('hash') || '').split(',').filter(Boolean);
      if (hashes.length > 10) return answer(res, 400, { success: false, error: 'TOO_MANY' });
      if (hashes.includes(POISON)) { res.writeHead(414); return res.end('<html>414 Request-URI Too Large</html>'); }
      const data = {};
      for (const hash of hashes) if (held.has(hash.toLowerCase())) data[hash] = held.get(hash.toLowerCase());
      return answer(res, 200, { success: true, error: null, detail: 'Found cached items.', data });
    }
    if (url.pathname.endsWith('/mylist')) {
      if (state.limitOnce.delete('first-mylist')) return answer(res, 429, '{}');
      const kind = url.pathname.includes('torrents') ? 'torrents' : 'webdl';
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 1000);
      const page = account[kind].slice(offset, offset + limit);
      if (!page.length && offset === 0) return answer(res, 404, { success: false, error: 'ITEM_NOT_FOUND' });
      return answer(res, 200, { success: true, data: page });
    }
    answer(res, 404, { success: false, error: 'NOT_FOUND' });
  });
  return { server, state };
}
const KEY = 'abcdef12-3456-7890-abcd-ef1234567890';
// O Http do app (services/torbox.js) em cima do fetch do Node.
const nodeHttp = { async request(url, { method = 'GET', headers, body, signal } = {}) {
  const res = await fetch(url, { method, headers, body, signal });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text: async () => text, json: async () => JSON.parse(text) };
} };
const freePort = freePortFrom(7); // glibren.41 (T1): bloco de portas so deste arquivo (tests/free-port.mjs)

// O que a montagem gravou, sem o que muda de uma rodada para outra (o id da rodada, as horas e as chamadas).
function normalized(fs, paths) {
  const library = JSON.parse(fs.readFile(paths.library));
  for (const record of Object.values(library.games)) { record.torbox.checkedAt = 'T'; record.torbox.run = 'R'; }
  library.builtAt = 'T';
  library.run = { ...library.run, id: 'R', startedAt: 'T', finishedAt: 'T', calls: 0 };
  const strip = (text) => text.replace(/"builtAt":"[^"]*"/g, '"builtAt":"T"');
  return { library, list: strip(fs.readFile(paths.list)), ids: strip(fs.readFile(paths.ids)), details: strip(fs.readFile(paths.details)) };
}
const saverFor = (fs, paths, games) => {
  const byId = new Map(games.map((game) => [game.id, game]));
  return (value, { final }) => lib.saveLibraryRun(fs, paths, value, { final, gameOf: (id) => byId.get(id) ?? null });
};

// ======================================================================================================================
// Um payload de mentira: grava os arquivos que o bg_library.c gravaria (com o TorBox de mentira do app) e responde o estado.
function fakePayload(fs, dir, api) {
  const state = { ok: true, api: 27, run: '', state: '', phase: '', busy: false, blocks: 0, done: 0, calls: 0, waitMs: 0, error: '' };
  const starts = [];
  return { starts, state, dir, async status() { return { ...state }; }, async cancel() { state.state = 'cancelled'; return { ...state }; },
    async start(run) {
      starts.push(run);
      const lines = fs.readFile(`${dir}/plan.ndjson`).trim().split('\n').map((line) => JSON.parse(line));
      Object.assign(state, { run, state: 'running', busy: false, blocks: lines[0].blocks, done: 0 });
      fs.writeFile(`${dir}/account.json`, JSON.stringify({ webdl: await api.myList('webdl'), torrent: await api.myList('torrent') }));
      for (const line of lines.filter((l) => l.b !== undefined)) {
        const links = [...new Set(line.games.flatMap((g) => [...g.links, ...g.parts]))];
        const held = await api.cachedEntries(links);
        fs.writeFile(`${dir}/b${String(line.b).padStart(5, '0')}.json`, JSON.stringify({ b: line.b, ids: line.games.map((g) => g.id), held: Object.fromEntries(held), failed: {}, names: [] }));
        state.done++;
      }
      state.state = 'done';
      return { ...state };
    } };
}
function fakeApi(games) {
  const calls = [];
  return { calls, async myList(kind) { calls.push(kind); return kind === 'webdl' ? [{ id: 1, name: games[2].title, hash: 'w1', size: 1e9, files: [{ id: 0, name: 'x.exfat', size: 1e9 }] }] : []; },
    async cachedEntries(links) { calls.push(links.length); return new Map(links.filter((link) => /\/(\d+)\//.exec(link)?.[1] % 2 === 0).map((link) => [link, { name: 'g.exfat', size: 2e9, files: [{ id: 0, name: 'g.exfat', size: 2e9 }] }])); } };
}

test('glibren.38: with a payload the app sends the plan, reads its blocks and makes no TorBox call of its own; same library', async () => {
  const games = catalog(25);
  const fs = memoryFs();
  const dir = '/data/JobeesLair/bg/library';
  const ps5 = lib.libraryPaths('/download0/JobeesLair', true);
  const source = fakePayload(fs, dir, fakeApi(games));
  const api = { myList: () => assert.fail('no call from the app'), cachedEntries: () => assert.fail('no call from the app'), cachedByHash: () => assert.fail('no call from the app') };
  const remote = createLibraryRemote({ fs, link: () => source, wait: async () => {} });
  const { library, progress } = await lib.buildLibrary({ entries: entriesOf(games), api, remote, chunk: 10, pace: 0, sleep: async () => {}, save: saverFor(fs, ps5, games) });
  assert.equal(source.starts.length, 1);
  const plan = fs.readFile(`${dir}/plan.ndjson`).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(plan[0], { v: 1, run: library.run.id, blocks: 3, account: true });
  assert.deepEqual(plan[1].games[0], lib.planGame(games[0]));
  assert.deepEqual(plan[1].games[3].links, [web(4), `${web(4, 'game-4.pkg')}?token=abc`]);
  assert.equal(progress.done, 25);
  // O mesmo pelo app sozinho (o TorBox de mentira direto).
  const alone = memoryFs();
  const own = await lib.buildLibrary({ entries: entriesOf(games), api: fakeApi(games), chunk: 10, pace: 0, sleep: async () => {}, save: saverFor(alone, ps5, games) });
  assert.equal(own.progress.found, progress.found);
  assert.deepEqual(normalized(fs, ps5), normalized(alone, ps5));
});

test('glibren.38: no payload, or an old one (api < 27): the whole run in the app, as before', async () => {
  const games = catalog(6);
  for (const link of [() => null, () => ({ dir: '/x', status: async () => null, start: async () => null, cancel: async () => null })]) {
    const api = fakeApi(games);
    const remote = createLibraryRemote({ fs: memoryFs(), link, wait: async () => {} });
    const { progress } = await lib.buildLibrary({ entries: entriesOf(games), api, remote, pace: 0, sleep: async () => {} });
    assert.equal(progress.done, 6);
    assert.ok(api.calls.includes('webdl') && api.calls.some((call) => typeof call === 'number'), 'the app asked TorBox itself');
  }
  // background-downloads.js so entrega o payload com api >= 27 (o que um payload antigo responde vira null).
  const text = readFileSync(path.join(repo, 'app/state/background-downloads.js'), 'utf8');
  assert.match(text, /Number\(answer\.data\.api\) >= 27/);
  assert.match(text, /var PAYLOAD_API = 30;/);
});

// ======================================================================================================================
// O payload de verdade (compilado para o PC) contra o TorBox falso.
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-libpay-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 400)}` : false;
const children = new Set();
const servers = new Set(); // fechados no fim mesmo quando um teste falha (senao o processo nao sai)
after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const server of servers) { server.closeAllConnections?.(); server.close(); }
  rmSync(dir, { recursive: true, force: true });
});
let run = 0;
async function startPayload(torboxPort, env = {}, base = null) {
  base ??= path.join(dir, `run${++run}`);
  mkdirSync(path.join(base, 'state'), { recursive: true });
  writeFileSync(path.join(base, 'debrid.json'), JSON.stringify({ torbox: { key: KEY } }));
  const api = await freePort(), monitor = await freePort();
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor), BGDL_ORBIT_DIR: path.join(base, 'orbit'),
    BGDL_LIBRARY: path.join(base, 'lista.json'), BGDL_KEYFILE: path.join(base, 'debrid.json'), BGDL_TORBOX_BASE: `http://127.0.0.1:${torboxPort}/v1/api`, BGDL_TB_PACE_MS: '0', BGDL_LIB_RATE_WAIT_MS: '40',
    BGDL_LIB_RETRY_MS: '20', BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const call = async (method, route, body) => {
    const token = readFileSync(path.join(base, 'state/token'), 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  for (const end = Date.now() + 30000; ; await wait(50)) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call('GET', '/health')).status === 200) break; } catch {}
    if (Date.now() > end) throw new Error('payload did not start');
  }
  const ok = (answer) => (answer.status === 200 && answer.data?.ok && Number(answer.data.api) >= 27 ? answer.data : null);
  const link = { dir: path.join(base, 'state/library'), status: async () => ok(await call('GET', '/library/build')), start: async (id) => ok(await call('POST', '/library/build', { run: id })),
    cancel: async () => ok(await call('POST', '/library/build/cancel', {})) };
  return { base, child, call, link };
}
async function torbox() {
  const fake = fakeTorBox();
  const port = await freePort();
  await new Promise((resolve) => fake.server.listen(port, '127.0.0.1', resolve));
  servers.add(fake.server);
  return { ...fake, port, close: () => new Promise((resolve) => { fake.server.closeAllConnections?.(); fake.server.close(resolve); }) };
}
const appApi = (port) => createTorBox({ http: { request: (url, options) => nodeHttp.request(url.replace('https://api.torbox.app', `http://127.0.0.1:${port}`), options) }, key: () => KEY, wait: async () => {}, log: () => {} });

test('bg_library.c compiles with the payload, no warnings (-Wall -Wextra -Werror)', { skip: !compiler || missing ? 'no compiler or headers' : false }, () => {
  assert.equal(built.status, 0, built.stderr);
});

test('glibren.38: EQUIVALENCE: the payload\'s network gives the same library, list, ids and details as the app\'s own calls', { skip, timeout: 120000 }, async () => {
  const games = catalog(140);
  const ps5 = lib.libraryPaths('/download0/JobeesLair', true);
  // 1. O caminho antigo: o app chama o TorBox (services/torbox.js).
  const tbA = await torbox();
  const appFs = memoryFs();
  const before = await lib.buildLibrary({ entries: entriesOf(games), api: appApi(tbA.port), hashList: HASH_LIST, pace: 0, rateWait: 30, sleep: (ms) => wait(Math.min(ms, 30)), save: saverFor(appFs, ps5, games) });
  await tbA.close();
  // 2. O payload faz a rede; o app so casa e grava (nenhuma chamada dele ao TorBox).
  const tbB = await torbox();
  const payload = await startPayload(tbB.port);
  const payFs = memoryFs();
  const remote = createLibraryRemote({ fs: diskFs, link: () => payload.link, poll: 20 });
  const forbidden = { myList: () => assert.fail('app call'), cachedEntries: () => assert.fail('app call'), cachedByHash: () => assert.fail('app call') };
  const seen = [];
  const after2 = await lib.buildLibrary({ entries: entriesOf(games), api: forbidden, hashList: HASH_LIST, remote, pace: 0, sleep: async () => {}, save: saverFor(payFs, ps5, games), onProgress: (p) => seen.push(p.phase) });
  const calls = tbB.state.calls;
  await tbB.close();
  assert.equal(after2.progress.found, before.progress.found, 'confirmed');
  assert.equal(after2.progress.known, before.progress.known, 'known by name/code/parts');
  assert.equal(after2.progress.errors, before.progress.errors, 'errors (the 414 link)');
  assert.ok(before.progress.errors >= 1 && before.progress.known >= 3 && before.progress.broken >= 1, JSON.stringify(before.progress));
  const a = normalized(appFs, ps5), b = normalized(payFs, ps5);
  for (const id of Object.keys(a.library.games)) assert.deepEqual(b.library.games[id], a.library.games[id], id);
  assert.deepEqual(b, a, 'the same files');
  assert.equal(a.library.games.PPSA00050.torbox.error, 'HTTP_414');
  // glibren.44: a pasta da conta casou pelo codigo dos arquivos pequenos pelos dois caminhos (o payload manda "codes").
  assert.ok(a.library.games.PPSA00072.torbox.files.some((f) => f.via === 'account' && /^data_\d+\.bin$/.test(f.name)), 'account folder matched by code');
  // e o account.json do payload so leva os arquivos que o app usa (os 30 grandes, nao os 3.000).
  const accountText = readFileSync(path.join(payload.base, 'state/library/account.json'), 'utf8');
  const big = JSON.parse(accountText).torrent.find((item) => item.name === 'Big Folder Dump');
  assert.equal(big.files.length, 30);
  assert.deepEqual(big.codes, ['PPSA00072']);
  assert.ok(!accountText.includes('p_1.dat'), 'small files left out');
  assert.ok(a.library.games.PPSA00030.torbox.files.length > 1, 'the big folder');
  assert.ok(seen.includes('account') && seen.includes('games'));
  assert.ok(after2.progress.calls > 0 && calls > 0, 'calls counted');
  // A chave nunca foi para um arquivo nem para o diario do payload.
  const written = readdirSync(path.join(payload.base, 'state'), { recursive: true }).map((name) => path.join(payload.base, 'state', String(name))).filter((p) => !p.endsWith('library') && existsSync(p));
  for (const file of written) { try { assert.ok(!readFileSync(file, 'utf8').includes(KEY), file); } catch (error) { if (error.code !== 'EISDIR' && error.code !== 'ENOENT') throw error; } }  // um .tmp pode ser renomeado entre listar e ler
  let state = (await payload.call('GET', '/library/build')).data;
  for (const end = Date.now() + 10000; state.busy && Date.now() < end; await wait(20)) state = (await payload.call('GET', '/library/build')).data;
  assert.equal(state.state, 'done');
  assert.equal(state.blocks, 3);
  payload.child.kill('SIGKILL');
});

test('glibren.38: cancel stops the payload; "Continue" (same run) resumes from the blocks left, even after the payload restarts', { skip, timeout: 120000 }, async () => {
  const games = catalog(120);
  const ps5 = lib.libraryPaths('/download0/JobeesLair', true);
  const tb = await torbox();
  tb.state.limitOnce.clear();
  // Um TorBox lento: da tempo de cancelar no meio.
  const slow = tb.server.listeners('request')[0];
  tb.server.removeAllListeners('request');
  tb.server.on('request', (req, res) => setTimeout(() => slow(req, res), 15));
  let payload = await startPayload(tb.port);
  const fs = memoryFs();
  const remote = createLibraryRemote({ fs: diskFs, link: () => payload.link, poll: 20 });
  const controller = new AbortController();
  const library = lib.emptyLibrary();
  const save = saverFor(fs, ps5, games);
  const first = lib.buildLibrary({ entries: entriesOf(games), api: {}, remote, chunk: 20, pace: 0, sleep: async () => {}, library, save, signal: controller.signal,
    onProgress: (p) => { if (p.done >= 20) controller.abort(); } });
  await assert.rejects(first, { name: 'AbortError' });
  for (const end = Date.now() + 10000; (await payload.call('GET', '/library/build')).data.busy && Date.now() < end; ) await wait(20);
  const stopped = (await payload.call('GET', '/library/build')).data;
  assert.equal(stopped.state, 'cancelled');
  assert.ok(stopped.done < 6, `stopped early (${stopped.done} of 6 blocks)`);
  const runId = library.run.id;
  assert.equal(library.run.finishedAt, null);
  // O payload reinicia (atualizacao do app, PS5 desligado): a rodada continua do que ja gravou.
  payload.child.kill('SIGKILL');
  await new Promise((resolve) => payload.child.once('exit', resolve));
  payload = await startPayload(tb.port, {}, payload.base);
  const kept = new Map(readdirSync(payload.link.dir).filter((name) => /^b\d+\.json$/.test(name)).map((name) => [name, readFileSync(path.join(payload.link.dir, name), 'utf8')]));
  assert.ok(kept.size >= 1);
  const { progress } = await lib.buildLibrary({ entries: entriesOf(games), api: {}, remote, chunk: 20, pace: 0, sleep: async () => {}, library, save });
  assert.equal(library.run.id, runId, 'the same run');
  assert.equal(progress.done, 120);
  for (const [name, text] of kept) assert.equal(readFileSync(path.join(payload.link.dir, name), 'utf8'), text, `${name} kept, not asked again`);
  // O app pode ler o ultimo bloco antes de o payload gravar o estado final.
  let state = (await payload.call('GET', '/library/build')).data;
  for (const end = Date.now() + 10000; state.busy && Date.now() < end; await wait(20)) state = (await payload.call('GET', '/library/build')).data;
  assert.equal(state.state, 'done');
  // Uma rodada nova ("Montar de novo"): o payload limpa a anterior.
  const fresh = await lib.buildLibrary({ entries: entriesOf(games.slice(0, 15)), api: {}, remote, chunk: 20, pace: 0, sleep: async () => {}, library, save, fresh: true });
  assert.notEqual(fresh.library.run.id, runId);
  assert.deepEqual(readdirSync(payload.link.dir).filter((name) => /^b\d+\.json$/.test(name)), ['b00000.json']);
  payload.child.kill('SIGKILL');
  await tb.close();
});

test('glibren.38: a TorBox without the key (BAD_TOKEN) or a 429 that never ends stops the run with the reason; the plan of another run is refused', { skip, timeout: 60000 }, async () => {
  const tb = await torbox();
  const payload = await startPayload(tb.port);
  writeFileSync(path.join(payload.base, 'debrid.json'), JSON.stringify({ torbox: { key: 'wrong-key-wrong-key-1234' } }));
  const games = catalog(5);
  const remote = createLibraryRemote({ fs: diskFs, link: () => payload.link, poll: 20 });
  // glibren.41 (J5): BAD_TOKEN para a rodada na hora, com o motivo (antes cada grupo de links era partido ate o link
  // sozinho: milhares de chamadas recusadas e a rodada terminava "pronta" com tudo em falha).
  await assert.rejects(lib.buildLibrary({ entries: entriesOf(games), api: {}, remote, pace: 0, sleep: async () => {} }), { code: 'BAD_TOKEN' });
  assert.deepEqual(((await payload.call('GET', '/library/build')).data).error, 'BAD_TOKEN');
  // 429 sem fim: 5 tentativas (61 s, 2, 4, 4 min no PS5; aqui milissegundos) e a rodada para com RATE_LIMITED.
  writeFileSync(path.join(payload.base, 'debrid.json'), JSON.stringify({ torbox: { key: KEY } }));
  tb.server.removeAllListeners('request');
  let hits = 0;
  tb.server.on('request', (req, res) => { hits++; res.writeHead(429); res.end('{}'); });
  await assert.rejects(lib.buildLibrary({ entries: entriesOf(games), api: {}, remote, pace: 0, sleep: async () => {}, fresh: true }), { code: 'RATE_LIMITED' });
  assert.equal(hits, 5);
  const state = (await payload.call('GET', '/library/build')).data;
  assert.deepEqual([state.state, state.error], ['failed', 'RATE_LIMITED']);
  // Um plano de outra rodada: 409.
  const refused = await payload.call('POST', '/library/build', { run: 'someotherrun' });
  assert.equal(refused.status, 409);
  const log = readFileSync(path.join(payload.base, 'state/bgdl.log'), 'utf8');
  assert.ok(!log.includes(KEY) && !log.includes('wrong-key-wrong-key-1234'), 'no key in the log');
  assert.match(log, /biblioteca: RATE_LIMITED; esperando/);
  payload.child.kill('SIGKILL');
  await tb.close();
});

// glibren.43: um ritmo so para o TorBox no payload inteiro (tb_turn): a Biblioteca respeita o intervalo entre chamadas
// e um 429 dela segura as outras partes (o diario diz quem pediu a espera).
test('glibren.43: the library calls the TorBox at the one payload-wide pace, and its 429 becomes a payload-wide wait', { skip, timeout: 60000 }, async () => {
  const tb = await torbox();
  const payload = await startPayload(tb.port, { BGDL_TB_PACE_MS: '120' });
  const times = [];
  tb.server.prependListener('request', () => times.push(performance.now()));
  const games = catalog(12);
  const remote = createLibraryRemote({ fs: diskFs, link: () => payload.link, poll: 20 });
  await lib.buildLibrary({ entries: entriesOf(games), api: {}, remote, pace: 0, sleep: async () => {} });
  assert.ok(times.length >= 3, `poucas chamadas: ${times.length}`);
  const gaps = times.slice(1).map((at, i) => at - times[i]);
  assert.ok(Math.min(...gaps) >= 105, `intervalo menor que o ritmo: ${gaps.map(Math.round).join(', ')}`);
  const log = readFileSync(path.join(payload.base, 'state/bgdl.log'), 'utf8');
  assert.match(log, /TorBox: 429 \(devagar\) em biblioteca; ninguem chama por/);
  assert.ok(!log.includes(KEY), 'no key in the log');
  payload.child.kill('SIGKILL');
  await tb.close();
});

test('glibren.38: the payload\'s MD5 and magnet hashes are the app\'s (accents, base32 magnets, links with and without a query)', { skip, timeout: 60000 }, async () => {
  const tb = await torbox();
  const asked = [];
  tb.server.removeAllListeners('request');
  tb.server.on('request', (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.endsWith('/checkcached')) asked.push(...(url.searchParams.get('hash') || '').split(','));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(url.pathname.endsWith('/mylist') ? '{"success":true,"data":[]}' : '{"success":true,"data":{}}');
  });
  const payload = await startPayload(tb.port);
  const links = ['https://h.example/f/Jogo Ação ñ.exfat', 'https://1fichier.com/?abcdef', 'https://h.example/f/x.exfat?dl=1#frag', 'magnet:?xt=urn:btih:MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U&dn=x', 'magnet:?dn=y&xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01'];
  const game = { id: 'PPSA01234', title: 'Teste', platform: 'ps5', genres: [], art: {}, formats: [], releases: links.map((url, i) => ({ id: `r${i}`, url, filename: i === 0 ? 'Jogo Ação ñ.exfat' : '' })) };
  const remote = createLibraryRemote({ fs: diskFs, link: () => payload.link, poll: 20 });
  await lib.buildLibrary({ entries: entriesOf([game]), api: {}, remote, pace: 0, sleep: async () => {} });
  const { linkHashes, magnetHash } = await load('app/services/torbox.js');
  const wanted = [...links.slice(0, 3).flatMap(linkHashes), ...links.slice(3).map(magnetHash), ...['exfat', 'ffpkg', 'ffpfs', 'ffpfsc'].map((type) => md5(`PPSA01234.${type}`)), md5('Jogo Ação ñ.exfat')];
  assert.deepEqual([...new Set(asked)].sort(), [...new Set(wanted)].sort());
  payload.child.kill('SIGKILL');
  await tb.close();
});
