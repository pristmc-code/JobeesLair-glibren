// glibren.44: a memoria do JavaScript na Biblioteca TorBox (no PS5 real, .43: Configuracoes > Sobre > Memoria dizia
// 50,5 MB de 64 em "Biblioteca TorBox"). Causas medidas no qjs (tools/memory/peak.mjs, cenario biblioteca-payload):
//   - a conta: o payload mandava todos os arquivos de cada item (account.json de varios MB numa conta com pastas de
//     milhares de arquivos) e o app guardava todos em indexAccount, com o texto preso no quadro da montagem;
//   - o banco lido do disco: cada registro com objetos e textos proprios (~3 KB por jogo), mesmo os nao confirmados.
// Aqui: o corte da conta (so os arquivos que a montagem usa, os codigos de todos), a leitura do account.json um item por
// vez, o registro enxuto dos nao confirmados e, quando ha o qjs com contador (QJS_PEAK), o limite do pico.
// Run: node --import ./tests/stub-loader.mjs --test tests/torbox-library-memory.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const lib = await load('app/state/torbox-library.js');
const { readAccount } = await load('app/state/torbox-library-payload.js');

const folder = (count) => Array.from({ length: count }, (_, f) => f % 50 === 0
  ? { id: f, name: `Quest Legends/Image0/data_${f}.bin`, short_name: `data_${f}.bin`, size: 5e6 + f }
  : { id: f, name: `PPSA01234-app/sce_sys/p_${f}.dat`, short_name: `p_${f}.dat`, size: 1000 });

test('glibren.44: indexAccount keeps only the files the build uses, and the codes of all of them (and the payload\'s "codes")', () => {
  const index = lib.indexAccount([
    ['torrent', [{ id: 1, name: 'Big Folder', hash: 'AB', size: 1, files: folder(3000) }]],
    ['webdl', [{ id: 2, name: 'Trimmed by the payload', hash: 'cd', files: [{ id: 0, name: 'x/data.bin', size: 5e6 }], codes: ['CUSA07777', 'junk'] }]],
  ]);
  const [big, trimmed] = index.items;
  assert.equal(big.files.length, 60, 'the 60 files of 1 MB or more, none of the 2,940 small ones');
  assert.ok(big.files.every((file) => file.size >= 1e6));
  assert.equal(big.hash, 'ab');
  assert.deepEqual(index.byCode.get('PPSA01234'), [big], 'the code only in small files still indexes the item');
  assert.deepEqual(index.byCode.get('CUSA07777'), [trimmed], 'the codes the payload sent');
  assert.equal(index.byCode.size, 2);
  // Uma lista que e um iteravel (a conta lida item a item) da o mesmo.
  const again = lib.indexAccount([['torrent', { *[Symbol.iterator]() { yield { id: 1, name: 'Big Folder', hash: 'AB', size: 1, files: folder(3000) }; } }]]);
  assert.deepEqual(again.items[0], big);
});

test('glibren.44: readAccount reads account.json one item at a time; the error note and a non-object as before', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: i, name: `Item ${i} "q"`, files: [{ id: 0, name: 'a\\b', size: i }] }));
  const text = JSON.stringify({ webdl: items, torrent: [items[1]] });
  const value = readAccount(text);
  assert.deepEqual([...value.webdl], items);
  assert.deepEqual([...value.torrent], [items[1]]);
  assert.deepEqual([...value.webdl], items, 'read again (each pass parses again)');
  assert.deepEqual(readAccount('{"error":"BAD_TOKEN"}'), { error: 'BAD_TOKEN' });
  const empty = readAccount('{"webdl":[]}');
  assert.deepEqual([[...empty.webdl], [...empty.torrent]], [[], []]);
  assert.equal(readAccount('[1]'), null);
  assert.throws(() => readAccount('{"webdl":[{"id":1}'), SyntaxError);
});

const game = (n, extra = {}) => ({ id: `PPSA${String(n).padStart(5, '0')}`, title: `Game ${n}`, platform: 'ps5', genres: ['Action'], art: { cover: `https://img.example/${n}.png` }, sizeGb: 2, formats: ['exfat'], releases: [{ id: `r${n}`, url: `https://host.example/${n}/g${n}.exfat`, filename: `g${n}.exfat` }], ...extra });

test('glibren.44: a game TorBox does not have is kept as { id, title, torbox } (built and read back); a confirmed one whole', async () => {
  const games = [game(1), game(2), game(3)];
  const api = { myList: async () => [], cachedByHash: async () => [],
    cachedEntries: async (links) => new Map(links.filter((link) => link.includes('/2/')).map((link) => [link, { name: 'g2.exfat', size: 3e9, files: [{ id: 0, name: 'g2.exfat', size: 3e9 }] }])) };
  const { library } = await lib.buildLibrary({ entries: games.map((g) => ({ game: g, sources: ['bundled', 'https://feed.example/live.json'] })), api, pace: 0, sleep: async () => {} });
  assert.deepEqual(Object.keys(library.games.PPSA00001), ['id', 'title', 'torbox']);
  assert.equal(library.games.PPSA00001.torbox.confirmed, false);
  assert.equal(library.games.PPSA00002.torbox.confirmed, true);
  assert.deepEqual(library.games.PPSA00002.sources, ['bundled', 'https://feed.example/live.json']);
  assert.equal(library.games.PPSA00002.cover, 'https://img.example/2.png');
  // Gravado e lido de novo: o mesmo; a lista so com o confirmado, com os campos da loja.
  const files = new Map();
  const fs = { exists: (p) => files.has(p), readFile: (p) => files.get(p), writeFile: (p, t) => files.set(p, String(t)), appendFile: (p, t) => files.set(p, (files.get(p) ?? '') + t), mkdir() {}, rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); }, remove: (p) => files.delete(p) };
  const paths = lib.libraryPaths('/data', false);
  lib.saveLibraryRun(fs, paths, library, { final: true });
  assert.deepEqual(lib.readLibrary(fs, paths), JSON.parse(JSON.stringify(library)));
  const list = JSON.parse(files.get(paths.list));
  assert.deepEqual(list.games.map((g) => [g.id, g.cover, g.genres]), [['PPSA00002', 'https://img.example/2.png', ['Action']]]);
  assert.deepEqual(lib.summarize(lib.readLibrary(fs, paths), games.map((g) => ({ game: g }))), { builtAt: library.builtAt, games: 3, confirmed: 1, broken: 0, unchecked: 0, open: null });
});

test('glibren.44: a bank written by the .43 is compacted when read (unconfirmed slimmed, repeated texts shared); a confirmed one keeps every field', () => {
  const unconfirmed = (n) => ({ id: `PPSA0000${n}`, title: `G${n}`, code: `PPSA0000${n}`, platform: 'ps5', sources: ['bundled', 'https://feed.example/live.json'], genres: ['Action'], cover: 'https://x/c.png', sizeBytes: 1, formats: ['exfat'],
    torbox: { confirmed: false, checkedAt: '2026-11-12T00:00:00.000Z', run: 'r1', hash: null, name: null, files: [], known: [{ name: 'a.exfat', size: 1, format: 'exfat', via: 'name', hash: 'h' }] } });
  const confirmed = { ...unconfirmed(3), torbox: { confirmed: true, checkedAt: '2026-11-12T00:00:00.000Z', run: 'r1', hash: 'h', name: 'n', files: [{ name: 'a.exfat', size: 9e9, format: 'exfat', via: 'webdl', hash: 'h' }] } };
  const old = { version: 1, builtAt: 'T', run: null, games: { PPSA00001: unconfirmed(1), PPSA00002: unconfirmed(2), PPSA00003: confirmed } };
  const files = new Map([['/data/torbox-biblioteca.json', JSON.stringify(old)]]);
  const fs = { exists: (p) => files.has(p), readFile: (p) => files.get(p) };
  const read = lib.readLibrary(fs, { library: '/data/torbox-biblioteca.json', backup: null });
  assert.deepEqual(read.games.PPSA00001, { id: 'PPSA00001', title: 'G1', torbox: unconfirmed(1).torbox });
  assert.deepEqual(read.games.PPSA00003, confirmed);
  // Listas iguais viram a mesma (um objeto so no heap).
  const text = JSON.stringify({ ...old, games: { A: confirmed, B: { ...confirmed, id: 'B' } } });
  const twin = lib.readLibrary({ exists: () => true, readFile: () => text }, { library: 'x', backup: null });
  assert.equal(twin.games.A.sources, twin.games.B.sources);
  assert.equal(twin.games.A.genres, twin.games.B.genres);
});

// ---- O limite: o cenario biblioteca-payload no qjs com contador de pico (tools/memory/peak.mjs) ----
const QJS_PEAK = [process.env.QJS_PEAK, '/root/forks/qjs-peak/build/qjs'].find((file) => file && existsSync(file));
const ESBUILD = [process.env.ESBUILD_JS, '/root/forks/tube-service/innertube/node_modules/esbuild/lib/main.js', '/root/forks/youtube-maxd/companion/innertube/node_modules/esbuild/lib/main.js'].find((file) => file && existsSync(file));
const DATA = [process.env.MEM_LIVE || '/root/jlxdata/live.jlx', process.env.MEM_ORBIT || '/root/m27/slim.json'].every((file) => existsSync(file));
const noPeak = !QJS_PEAK ? 'no qjs with the peak counter (tools/memory/qjs-peak.patch; QJS_PEAK)' : !ESBUILD ? 'no esbuild (ESBUILD_JS)' : !DATA ? 'no live.jlx/orbit list (MEM_LIVE, MEM_ORBIT)' : false;
// Limite do pico do heap do JS na Biblioteca TorBox, no PC, com a loja (+ Orbit, 2.639 jogos) aberta: a .43 chegava a 44,7
// MB neste cenario (conta com 20 pastas de 3.000 arquivos, ~950 confirmados, banco da rodada anterior lido do disco).
const LIMIT_MB = 30;

test(`glibren.44: MEMORY: the TorBox library (payload path, Orbit on, big account, built twice) stays under ${LIMIT_MB} MB of JS heap and goes back down after`, { skip: noPeak, timeout: 900000 }, () => {
  const result = spawnSync(process.execPath, [path.join(repo, 'tools/memory/peak.mjs'), 'biblioteca-payload', 'prep-orbit'], { encoding: 'utf8', timeout: 900000, maxBuffer: 64 << 20,
    env: { ...process.env, MEM_RUNS: '2', MEM_ACCOUNT: '250', MEM_ACCOUNT_BIG_EVERY: '25', MEM_ACCOUNT_BIG_FILES: '3000', MEM_HELD_EVERY: '12', MEM_TRACE: '1', MEM_WORK: path.join(process.env.TMPDIR || '/tmp', `jobe-mem-test-${process.pid}`) } });
  const out = `${result.stdout}${result.stderr}`;
  assert.match(out, /^DONE biblioteca-payload library \d+ of \d+/m, out.slice(-2000));
  const rank = Object.fromEntries((/^RANK (.*)$/m.exec(out)?.[1] ?? '').split(' ').map((pair) => pair.split('=')).map(([name, mb]) => [name, Number(mb)]));
  // O pico de verdade (com o lixo ainda nao coletado), de cada trecho da montagem (as linhas do MEM_TRACE depois da loja).
  const traced = [...out.matchAll(/^ {2}\[([\d.]+) pico ([\d.]+)\] (.*)$/gm)];
  const during = traced.slice(1).map((m) => Number(m[2]));
  const peak = Math.max(...during);
  const before = Number(/^ {2}\[([\d.]+) pico [\d.]+\] antes de ler o banco$/m.exec(out)[1]);
  const afterMb = Number(/^AFTER ([\d.]+)$/m.exec(out)[1]);
  assert.ok(rank['biblioteca-torbox:montar'] < LIMIT_MB, `montar ${rank['biblioteca-torbox:montar']} MB`);
  assert.ok(peak < LIMIT_MB, `peak during the build ${peak} MB`);
  assert.ok(afterMb < before + 1.5, `after the build ${afterMb} MB, before ${before} MB: the library is let go`);
});
