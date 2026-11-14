// glibren.60 (7z-multi): a extracao de .7z LZMA2 em varios nucleos (app/native/bg_7z.c, LZMA SDK do 7-Zip em
// app/native/lzma/). PS5 real (Alan Wake 2, .exfat.7z de 91,7 GB, 14/11/2026): 1h43 a ~15 MB/s, um nucleo so.
// Confere: o resultado byte a byte (varios blocos, um bloco so, volumes .7z.001, memoria limitada a um fio, varios
// arquivos com pasta e arquivo vazios e nome nao-ASCII), o que nao e LZMA2 puro cai na libarchive como antes, um .7z
// estragado no meio falha com "damaged" sem lixo em BACKUP/_temp, e cancelar no meio para e limpa.
// Precisa de cc, libcurl, OpenSSL, libarchive e 7z/7za. Run: npm test
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, openSync, writeSync, closeSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { before as whenBuilt } from 'node:test';
import { assertBuilt, compileTo } from './payload-build.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-conv7z-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l(?:curl|crypto|archive)/.test(built.stderr));
const sevenZip = process.platform === 'win32' ? null : ['7z', '7za'].find((name) => spawnSync(name, ['i'], { stdio: 'ignore' }).status === 0);
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : !sevenZip ? 'sem 7z' : false;
whenBuilt(() => { if (!skip) assertBuilt(built); });
const children = new Set();
beforeEach(async () => {
  const left = [...children];
  for (const child of left) child.kill('SIGKILL');
  await Promise.all(left.map((child) => child.exitCode !== null || child.signalCode ? null : new Promise((resolve) => child.once('exit', resolve))));
});
after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Portas so deste arquivo: 32000-32767 (acima dos blocos 0-19 do tests/free-port.mjs, abaixo do automatico do Linux).
const usedPorts = new Set();
const canListen = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});
async function freePort() {
  for (let port = 32000; port < 32768; port++) {
    if (usedPorts.has(port)) continue;
    usedPorts.add(port);
    if (await canListen(port)) return port;
  }
  throw new Error('free-port: 32000-32767 sem porta livre');
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

// Dados que o LZMA comprime de verdade (texto com palavras + trechos aleatorios), deterministas pela semente.
function compressible(bytes, seed) {
  const out = Buffer.alloc(bytes);
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const words = Array.from({ length: 512 }, () => Buffer.from(Array.from({ length: 3 + (rnd() % 9) }, () => 97 + (rnd() % 26))));
  let at = 0;
  while (at < bytes) {
    if (rnd() % 16 === 0) { // trecho aleatorio
      const n = Math.min(bytes - at, 64 + (rnd() % 512));
      for (let i = 0; i < n; ++i) out[at + i] = rnd() & 0xff;
      at += n;
    } else {
      const w = words[rnd() % words.length];
      const n = Math.min(bytes - at, w.length);
      w.copy(out, at, 0, n);
      at += n;
      if (at < bytes) out[at++] = 32;
    }
  }
  return out;
}

let run = 0;
function start(base, api, monitor, extra = {}) {
  const child = spawn(binary, [], { env: { ...process.env, LANG: 'C', LC_ALL: 'C', BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor),
    BGDL_SMP_BASE: 'http://127.0.0.1:9/api/v1', BGDL_BACKUP_ROOTS: path.join(base, 'disk'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), ...extra }, stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
const stop = (child) => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); });
async function call(base, api, method, route, body) {
  const tok = readFileSync(path.join(base, 'state/token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': tok, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function up(base, api, ms = 30000) {
  for (const end = performance.now() + ms; performance.now() < end; await wait(50)) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call(base, api, 'GET', '/health')).status === 200) return; } catch {}
  }
  let tail = '';
  try { tail = readFileSync(path.join(base, 'state/bgdl.log'), 'utf8').split('\n').slice(-15).join('\n'); } catch {}
  throw new Error(`payload did not start:\n${tail}`);
}
async function until(base, api, id, states, ms = 120000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) {
    const item = (await call(base, api, 'GET', '/convert')).data.conversions.find((c) => c.id === id);
    if (item && states.includes(item.state)) return item;
  }
  return null;
}
// A imagem montada so para leitura (root + exFAT no kernel); null quando nao da.
function readImage(file) {
  if (process.getuid?.() !== 0) return null;
  const mnt = mkdtempSync(path.join(dir, 'mnt-'));
  if (spawnSync('mount', ['-t', 'exfat', '-o', 'loop,ro', file, mnt]).status !== 0) { rmSync(mnt, { recursive: true, force: true }); return null; }
  const out = {};
  try {
    const walk = (at, rel) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const name = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { out[name] = { dir: true }; walk(path.join(at, entry.name), name); } else out[name] = { dir: false, bytes: readFileSync(path.join(at, entry.name)) };
      }
    };
    walk(mnt, '');
  } finally {
    spawnSync('umount', [mnt]);
    rmSync(mnt, { recursive: true, force: true });
  }
  return out;
}
const logOf = (base) => readFileSync(path.join(base, 'state/bgdl.log'), 'utf8');

// Monta um caso: a pasta do disco, a imagem (e extras) comprimidos com os argumentos do 7z. Devolve os caminhos.
function scenario({ args, mb = 24, extras = false, volumes = false }) {
  const base = path.join(dir, `run${++run}`);
  mkdirSync(path.join(base, 'state'), { recursive: true });
  mkdirSync(path.join(base, 'disk/downloads'), { recursive: true });
  const backup = path.join(base, 'disk/BACKUP/Alan Wake 2');
  const inner = path.join(base, 'monta');
  mkdirSync(backup, { recursive: true });
  mkdirSync(inner, { recursive: true });
  const bytes = compressible(mb * 1024 * 1024, run * 7919);
  writeFileSync(path.join(inner, 'PPSA02572.exfat'), bytes);
  const names = ['PPSA02572.exfat'];
  if (extras) {
    mkdirSync(path.join(inner, 'extra/vazia'), { recursive: true });
    writeFileSync(path.join(inner, 'extra/leia-me café 日本.txt'), compressible(300000, 5));
    writeFileSync(path.join(inner, 'extra/zero.bin'), '');
    writeFileSync(path.join(inner, 'extra/pequeno.bin'), Buffer.from('ok'));
    names.push('extra');
  }
  const archive = path.join(backup, 'PPSA02572-game-unknown.exfat.7z');
  const made = spawnSync(sevenZip, ['a', ...args, ...(volumes ? ['-v4m'] : []), archive, ...names], { cwd: inner, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr || made.stdout);
  rmSync(inner, { recursive: true, force: true });
  const sources = volumes ? readdirSync(backup).filter((n) => /\.7z\.\d{3}$/.test(n)).sort().map((n) => path.join(backup, n)) : [archive];
  return { base, bytes, sources };
}
async function convert(s, extra = {}, key = `x7z-${run}`) {
  const api = await freePort();
  const child = start(s.base, api, await freePort(), extra);
  await up(s.base, api);
  const output = path.join(s.base, 'disk/homebrew/PPSA02572.exfat');
  const { status, data } = await call(s.base, api, 'POST', '/convert', { key, name: 'Alan Wake 2', label: 'PPSA02572', root: path.join(s.base, 'disk'), output, kind: 'archive', source: s.sources[0], sources: s.sources });
  assert.equal(status, 201, JSON.stringify(data));
  return { api, child, output, id: data.id };
}

const cases = [
  { name: 'varios blocos LZMA2 (-mmt4): varios nucleos', args: ['-m0=lzma2', '-mx=1', '-mmt=4'], expect: /varios nucleos\)/, extras: true },
  { name: 'um bloco LZMA2 so (-mmt1): um nucleo, mesmo resultado', args: ['-m0=lzma2', '-mx=1', '-mmt=1'], expect: /um nucleo/ },
  { name: 'volumes .7z.001/.002...: lidos como um arquivo so', args: ['-m0=lzma2', '-mx=1', '-mmt=4'], expect: /varios nucleos\)/, volumes: true },
  { name: 'memoria limitada (BGDL_7Z_MEM_MB=1): um fio, mesmo resultado', args: ['-m0=lzma2', '-mx=1', '-mmt=4'], env: { BGDL_7Z_MEM_MB: '1' }, expect: /1 fio\(s\)/ },
];
for (const c of cases) {
  test(`glibren.60 7z multinucleo: ${c.name}`, { skip }, async () => {
    const s = scenario({ args: c.args, extras: c.extras, volumes: c.volumes });
    if (c.volumes) assert.ok(s.sources.length >= 2, `volumes: ${s.sources.length}`);
    const job = await convert(s, c.env);
    try {
      const done = await until(s.base, job.api, job.id, ['done', 'failed']);
      assert.ok(done, 'a conversao terminou');
      assert.equal(done.state, 'done', done.error);
      assert.equal(sha(readFileSync(job.output)), sha(s.bytes), 'a imagem, byte a byte');
      const log = logOf(s.base);
      assert.match(log, /7z pelo caminho multinucleo/);
      assert.match(log, c.expect);
      assert.doesNotMatch(log, /extraindo pela libarchive/);
      assert.ok(!existsSync(path.join(s.base, 'disk/BACKUP/_temp', job.id)), 'a pasta temporaria foi apagada');
    } finally {
      await stop(job.child);
    }
  });
}

test('glibren.60 7z multinucleo: jogo em pasta (varios arquivos, pasta e arquivo vazios, nome nao-ASCII): a mesma imagem que a libarchive', { skip }, async () => {
  // Dois jogos no .7z: nao da direto, o payload extrai em BACKUP/_temp e converte a pasta do primeiro. A imagem montada
  // pelo caminho multinucleo tem de ser igual, byte a byte, a montada com a extracao pela libarchive (BGDL_7Z_OFF=1).
  const monta = path.join(dir, `monta${++run}`);
  for (const [folder, code, seed] of [['Jogo', 'PPSA01234', 11], ['Jogo2', 'PPSA01235', 21]]) { // dois jogos iguais por dentro
    const inner = path.join(monta, folder);
    mkdirSync(path.join(inner, 'sce_sys'), { recursive: true });
    mkdirSync(path.join(inner, 'data/vazia'), { recursive: true });
    writeFileSync(path.join(inner, 'sce_sys/param.json'), `{"titleId":"${code}","contentVersion":"01.000.000"}`);
    writeFileSync(path.join(inner, 'eboot.bin'), compressible(3 * 1024 * 1024, seed));
    writeFileSync(path.join(inner, 'data/big.bin'), compressible(9 * 1024 * 1024, seed + 1));
    writeFileSync(path.join(inner, 'data/zero.bin'), '');
    writeFileSync(path.join(inner, 'data/café 日本.bin'), 'unicode ok');
  }
  const packed = path.join(monta, 'jogo.7z');
  const made = spawnSync(sevenZip, ['a', '-m0=lzma2', '-mx=1', '-mmt=4', packed, 'Jogo', 'Jogo2'], { cwd: monta, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const images = [];
  for (const off of ['0', '1']) {
    const base = path.join(dir, `run${++run}`);
    mkdirSync(path.join(base, 'state'), { recursive: true });
    mkdirSync(path.join(base, 'disk/homebrew'), { recursive: true });
    mkdirSync(path.join(base, 'disk/downloads'), { recursive: true });
    const backup = path.join(base, 'disk/BACKUP/Jogo');
    mkdirSync(backup, { recursive: true });
    const archive = path.join(backup, 'jogo.7z');
    writeFileSync(archive, readFileSync(packed));
    const api = await freePort();
    const child = start(base, api, await freePort(), { BGDL_7Z_OFF: off });
    try {
      await up(base, api);
      const output = path.join(base, 'disk/homebrew/PPSA01234.exfat');
      const { data } = await call(base, api, 'POST', '/convert', { key: 'x7z-files', name: 'Jogo', label: 'PPSA01234', root: path.join(base, 'disk'), output, kind: 'archive', source: archive, sources: [archive] });
      const done = await until(base, api, data.id, ['done', 'failed']);
      assert.ok(done, 'a conversao terminou');
      assert.equal(done.state, 'done', done.error);
      if (off === '0') assert.match(logOf(base), /7z pelo caminho multinucleo/);
      else assert.match(logOf(base), /extraindo pela libarchive/);
      images.push(readImage(output));
    } finally {
      await stop(child);
    }
  }
  // A imagem em si muda (datas das pastas); os arquivos de dentro tem de ser os mesmos (root + exFAT no kernel).
  if (images[0] && images[1]) {
    const flat = (img) => Object.entries(img).map(([name, v]) => `${name}:${v.dir ? 'dir' : sha(v.bytes)}`).sort();
    // A libarchive no locale "C" do payload perde o nome nao-ASCII do .7z (UTF-16 sem conversao); o caminho novo
    // converte o UTF-16 para UTF-8 sozinho e mantem o arquivo. Fora ele, os mesmos arquivos byte a byte.
    const ascii = (list) => list.filter((line) => !line.startsWith('data/café'));
    assert.deepEqual(ascii(flat(images[0])), ascii(flat(images[1])), 'os mesmos arquivos pelos dois caminhos');
    assert.equal(images[0]['data/café 日本.bin']?.bytes.toString(), 'unicode ok', Object.keys(images[0]).join(' | '));
    assert.equal(images[0]['data/zero.bin'].bytes.length, 0);
    assert.ok(images[0]['data/vazia']?.dir, 'a pasta vazia');
  }
});

test('glibren.60 7z multinucleo: o que nao e LZMA2 puro (LZMA, BCJ2) vai a libarchive, mesmo resultado', { skip }, async () => {
  const s = scenario({ args: ['-m0=lzma', '-mx=1'] });
  const job = await convert(s);
  try {
    const done = await until(s.base, job.api, job.id, ['done', 'failed']);
    assert.ok(done, 'a conversao terminou');
    assert.equal(done.state, 'done', done.error);
    assert.equal(sha(readFileSync(job.output)), sha(s.bytes));
    assert.match(logOf(s.base), /7z sem o caminho multinucleo \(7z block 0 is not plain LZMA2 \(method 30101\)\); extraindo pela libarchive/);
  } finally {
    await stop(job.child);
  }
});

test('glibren.60 7z multinucleo: .7z estragado no meio falha com "damaged", sem lixo em BACKUP/_temp, payload vivo', { skip }, async () => {
  const s = scenario({ args: ['-m0=lzma2', '-mx=1', '-mmt=4'], mb: 16 });
  const file = s.sources[0];
  const size = statSync(file).size;
  const fd = openSync(file, 'r+');
  writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, Math.floor(size / 2)); // no meio dos dados compactados
  closeSync(fd);
  const job = await convert(s);
  try {
    const done = await until(s.base, job.api, job.id, ['done', 'failed']);
    assert.ok(done, 'a conversao terminou');
    assert.equal(done.state, 'failed');
    assert.match(done.error, /damaged|data error|CRC/i, done.error);
    assert.ok(!existsSync(path.join(s.base, 'disk/BACKUP/_temp', job.id)), 'a pasta temporaria foi apagada');
    assert.ok(!existsSync(job.output), 'nada publicado');
    assert.equal((await call(s.base, job.api, 'GET', '/health')).status, 200, 'o payload segue vivo');
    assert.doesNotMatch(logOf(s.base), /extraindo pela libarchive/, 'dado estragado nao tenta de novo pela libarchive');
  } finally {
    await stop(job.child);
  }
});

test('glibren.60 7z multinucleo: cancelar no meio para os fios e limpa a pasta temporaria', { skip }, async () => {
  const s = scenario({ args: ['-m0=lzma2', '-mx=1', '-mmt=4'], mb: 32 });
  const job = await convert(s, { BGDL_CONVERT_DELAY_MS: '200' });
  try {
    let mid;
    for (const end = Date.now() + 60000; Date.now() < end && !mid; await wait(50)) {
      const item = (await call(s.base, job.api, 'GET', '/convert')).data.conversions.find((c) => c.id === job.id);
      if (item?.state === 'extracting' && item.extracted > 0) mid = item;
    }
    assert.ok(mid, 'viu a extracao andando');
    assert.equal((await call(s.base, job.api, 'POST', `/convert/${job.id}/cancel`)).status, 200);
    const done = await until(s.base, job.api, job.id, ['cancelled', 'failed', 'done'], 30000);
    assert.ok(done, 'parou');
    assert.equal(done.state, 'cancelled', done.error);
    assert.ok(!existsSync(path.join(s.base, 'disk/BACKUP/_temp', job.id)), 'a pasta temporaria foi apagada');
    assert.ok(!existsSync(job.output));
    assert.equal((await call(s.base, job.api, 'GET', '/health')).status, 200, 'o payload segue vivo');
  } finally {
    await stop(job.child);
  }
});
