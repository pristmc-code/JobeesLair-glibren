// glibren.12: a conversao para .exfat no payload (app/native/bg_convert.c), compilado para o PC e rodado de verdade.
// O criador de imagem (exfat_writer.c) e o leitor de .pkg (pkg_source.c, com os FPKG de teste de tests/pkg-source)
// sao os reais; as imagens sao montadas como root e conferidas; a libarchive e a de verdade (RAR, RAR em volumes, 7z, zip com senha). Testa: pasta, .pkg, compactado direto,
// progresso, cancelar, erros (com o codigo que o app traduz), espaco, tentar de novo pela mesma chave, reinicio no
// meio (recomeca limpo), o pedido de varredura ao ShadowMount+ e o BACKUP na pagina do celular (PIN).
// Precisa de cc, libcurl, OpenSSL e libarchive; rar/7z/zip so para os testes de compactado (sem eles, pulados).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-conv-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l(?:curl|crypto|archive)/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 400)}` : false;
const tool = (name) => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;
const MiB = 1024 * 1024;
const PIN = '135790';
const children = new Set();
let smp, smpPort, scans = 0;
after(() => {
  for (const child of children) child.kill('SIGKILL');
  smp?.closeAllConnections?.();
  smp?.close();
  rmSync(dir, { recursive: true, force: true });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
let api;
if (!skip) {
  api = await freePort();
  smpPort = await freePort();
  // O ShadowMount+ falso: conta os pedidos de varredura.
  smp = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/scan') scans++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":0,"queued":true}');
  }).listen(smpPort, '127.0.0.1');
}

let run = 0;
function workspace() {
  const base = path.join(dir, `run${++run}`);
  mkdirSync(path.join(base, 'state'), { recursive: true });
  mkdirSync(path.join(base, 'disk/homebrew'), { recursive: true });
  mkdirSync(path.join(base, 'disk/downloads/extracted'), { recursive: true });
  return base;
}
let monitorPort = 0;
function start(base, env = {}) {
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitorPort),
    BGDL_SMP_BASE: `http://127.0.0.1:${smpPort}/api/v1`, BGDL_BACKUP_ROOTS: path.join(base, 'disk'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
const stop = (child, signal = 'SIGTERM') => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill(signal); });
async function call(base, method, route, body) {
  const tok = readFileSync(path.join(base, 'state/token'), 'utf8').trim();
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
async function page(route, { method = 'GET', body, session } = {}) {
  const res = await fetch(`http://127.0.0.1:${monitorPort}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Session': session } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text };
}
async function conversion(base, id) {
  return (await call(base, 'GET', '/convert')).data.conversions.find((item) => item.id === id);
}
async function until(base, id, states, check = () => true, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) {
    let item;
    try { item = await conversion(base, id); } catch { continue; }
    if (item && states.includes(item.state) && check(item)) return item;
  }
  throw new Error(`conversion ${id} never reached ${states}: ${JSON.stringify(await conversion(base, id).catch(() => null))}`);
}

// Um jogo de PS5 numa pasta: eboot.bin, sce_sys/param.json e dados (bytes aleatorios, `mib` MiB no total).
function gameFolder(at, mib = 4) {
  mkdirSync(path.join(at, 'sce_sys'), { recursive: true });
  mkdirSync(path.join(at, 'data/sub'), { recursive: true });
  const files = { 'eboot.bin': randomBytes(64 * 1024), 'sce_sys/param.json': Buffer.from('{"titleId":"PPSA01234","contentVersion":"01.000.000"}'),
    'data/big.bin': randomBytes(mib * MiB), 'data/sub/small.txt': Buffer.from('ok') };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(at, name), bytes);
  return files;
}
// A imagem gravada (exfat_writer.c real): assinatura exFAT no setor 0 e, como root com o exFAT do kernel, montada so
// para leitura para comparar cada arquivo: { path: {dir, bytes} } (null quando nao da para montar).
function readImage(file) {
  const head = readFileSync(file).subarray(0, 11);
  assert.equal(head.subarray(3, 11).toString(), 'EXFAT   ', 'setor de boot exFAT');
  if (process.getuid?.() !== 0) return null;
  const mnt = mkdtempSync(path.join(dir, 'mnt-'));
  const mounted = spawnSync('mount', ['-t', 'exfat', '-o', 'loop,ro', file, mnt], { encoding: 'utf8' });
  if (mounted.status !== 0) {
    rmSync(mnt, { recursive: true, force: true });
    // Sem loop/exFAT no kernel (contêiner): so a assinatura. Com BGDL_TEST_MOUNT=1 a montagem e obrigatoria.
    if (process.env.BGDL_TEST_MOUNT === '1') assert.fail(`mount: ${mounted.stderr}`);
    return null;
  }
  const out = {};
  try {
    const walk = (at, rel) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const name = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { out[name] = { dir: true }; walk(path.join(at, entry.name), name); }
        else out[name] = { dir: false, bytes: readFileSync(path.join(at, entry.name)) };
      }
    };
    walk(mnt, '');
  } finally {
    spawnSync('umount', [mnt]);
    rmSync(mnt, { recursive: true, force: true });
  }
  return out;
}
const body = (base, extra) => ({ key: 'PPSA01234/rel', name: 'Jogo Teste', label: 'PPSA01234', root: path.join(base, 'disk'), output: path.join(base, 'disk/homebrew/PPSA01234.exfat'), ...extra });

test('bg_downloader.c + bg_convert.c compilam sem avisos (-Wall -Wextra -Werror, com libarchive)', { skip: !compiler || missing ? 'no compiler or headers' : false }, () => {
  assert.equal(built.status, 0, built.stderr);
});

test('pasta: progresso, imagem conferida e renomeada, pasta de trabalho apagada, ShadowMount+ varre, celular ve sem caminhos', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const work = path.join(base, 'disk/downloads/extracted/Jogo.rar');
  const files = gameFolder(path.join(work, 'PPSA01234-app'), 6);
  const child = start(base, { BGDL_CONVERT_DELAY_MS: '40' });
  await up(base);
  const before = scans;
  const { status, data } = await call(base, 'POST', '/convert', body(base, { kind: 'dir', source: path.join(work, 'PPSA01234-app'), work }));
  assert.equal(status, 201);
  const running = await until(base, data.id, ['converting'], (item) => item.written > 0);
  assert.ok(running.total >= 6 * MiB && running.written <= running.total);
  // A pagina do celular ve o nome, o estado e o progresso, sem chave nem caminhos.
  const phone = await page('/api/status');
  const shown = phone.data.conversions.find((item) => item.id === data.id);
  assert.deepEqual(Object.keys(shown).sort(), ['error', 'id', 'key', 'name', 'state', 'total', 'written']);
  assert.equal(shown.key, '');
  for (const secret of [base, 'PPSA01234/rel']) assert.ok(!phone.text.includes(secret), `a pagina nao ve ${secret}`);
  // A mesma chave de novo (o app reabriu): acompanha a que existe.
  const again = await call(base, 'POST', '/convert', body(base, { kind: 'dir', source: path.join(work, 'PPSA01234-app'), work }));
  assert.equal(again.status, 200);
  assert.equal(again.data.attached, true);
  assert.equal(again.data.id, data.id);
  const done = await until(base, data.id, ['done']);
  assert.equal(done.written, done.total);
  const image = path.join(base, 'disk/homebrew/PPSA01234.exfat');
  assert.ok(existsSync(image) && !existsSync(`${image}.part`));
  assert.ok(!existsSync(work), 'a pasta de trabalho some depois de conferir');
  const entries = readImage(image);
  if (entries) {
    for (const [name, bytes] of Object.entries(files)) assert.equal(sha(entries[name].bytes), sha(bytes), name);
    assert.ok(entries.sce_sys.dir, 'o jogo na raiz da imagem');
  }
  for (let i = 0; i < 40 && scans === before; i++) await wait(50);
  assert.equal(scans, before + 1, 'pediu uma varredura ao ShadowMount+');
  assert.match(readFileSync(path.join(base, 'notify.txt'), 'utf8'), /Jogo Teste: pronto \(EXFAT\)/);
  await stop(child);
});

test('cancelar no meio: o .part some, a pasta extraida fica; tentar de novo pela mesma chave recomeca e termina', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const work = path.join(base, 'disk/downloads/extracted/J');
  gameFolder(work, 8);
  const child = start(base, { BGDL_CONVERT_DELAY_MS: '80' });
  await up(base);
  const request = body(base, { kind: 'dir', source: work, work });
  const { data } = await call(base, 'POST', '/convert', request);
  await until(base, data.id, ['converting'], (item) => item.written > 0);
  assert.equal((await call(base, 'POST', `/convert/${data.id}/cancel`)).status, 200);
  await until(base, data.id, ['cancelled']);
  assert.ok(!existsSync(`${request.output}.part`) && !existsSync(request.output));
  assert.ok(existsSync(path.join(work, 'eboot.bin')), 'nada da fonte foi tocado');
  // "Tentar de novo": o mesmo pedido recomeca a cancelada (o mesmo id).
  const retry = await call(base, 'POST', '/convert', request);
  assert.equal(retry.data.id, data.id);
  assert.equal(retry.data.attached, false);
  await until(base, data.id, ['done'], () => true, 90000);
  assert.ok(existsSync(request.output));
  // Esquecer: so uma que terminou.
  assert.equal((await call(base, 'POST', `/convert/${data.id}/forget`)).status, 200);
  assert.equal(await conversion(base, data.id), undefined);
  await stop(child);
});

test('erros com codigo: imagem ja existe (write:), fonte sumida (source:), sem espaco (space:), pedido invalido (400)', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const work = path.join(base, 'disk/downloads/extracted/E');
  gameFolder(work, 1);
  let child = start(base);
  await up(base);
  writeFileSync(path.join(base, 'disk/homebrew/Exists.exfat'), 'x');
  let r = await call(base, 'POST', '/convert', body(base, { key: 'a', kind: 'dir', source: work, output: path.join(base, 'disk/homebrew/Exists.exfat') }));
  assert.match((await until(base, r.data.id, ['failed'])).error, /^write: Exists\.exfat already exists/);
  assert.equal(readFileSync(path.join(base, 'disk/homebrew/Exists.exfat'), 'utf8'), 'x', 'a imagem que ja existia nao foi tocada');
  r = await call(base, 'POST', '/convert', body(base, { key: 'b', kind: 'dir', source: path.join(base, 'disk/downloads/extracted/nada') }));
  assert.match((await until(base, r.data.id, ['failed'])).error, /^source: /);
  // Caminhos fora do disco, imagem fora de homebrew/ e pasta de trabalho fora de downloads/: recusados.
  for (const bad of [{ output: path.join(base, 'disk/x.exfat') }, { output: path.join(base, 'disk/homebrew/x.ffpkg') }, { source: '/etc' }, { work: path.join(base, 'disk/homebrew') }, { kind: 'zip' }, { key: '' }]) {
    assert.equal((await call(base, 'POST', '/convert', body(base, { key: 'c', kind: 'dir', source: work, ...bad }))).status, 400, JSON.stringify(bad));
  }
  await stop(child);
  child = start(base, { BGDL_FAKE_FREE_BYTES: String(10 * MiB) });
  await up(base);
  r = await call(base, 'POST', '/convert', body(base, { key: 'd', kind: 'dir', source: work, work }));
  const failed = await until(base, r.data.id, ['failed']);
  assert.match(failed.error, /^space: the \.exfat needs [\d.]+ GB free on the drive and it has 0\.0 GB/);
  assert.ok(existsSync(work), 'sem espaco nada e apagado');
  assert.match(readFileSync(path.join(base, 'notify.txt'), 'utf8'), /conversao para EXFAT falhou/);
  await stop(child);
});

test('reinicio no meio: o payload morto volta, a conversao recomeca limpa e termina', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const work = path.join(base, 'disk/downloads/extracted/R');
  gameFolder(work, 8);
  let child = start(base, { BGDL_CONVERT_DELAY_MS: '100' });
  await up(base);
  const request = body(base, { kind: 'dir', source: work, work });
  const { data } = await call(base, 'POST', '/convert', request);
  await until(base, data.id, ['converting'], (item) => item.written >= 2 * MiB);
  await stop(child, 'SIGKILL');
  assert.ok(existsSync(`${request.output}.part`), 'o .part ficou do processo morto');
  child = start(base);
  await up(base);
  const done = await until(base, data.id, ['done']);
  assert.equal(done.written, done.total);
  assert.ok(existsSync(request.output) && !existsSync(`${request.output}.part`));
  assert.match(readFileSync(path.join(base, 'state/bgdl.log'), 'utf8'), /parada no meio; recomeca do zero/);
  // Parar limpo (SIGTERM) no meio tambem volta para a fila.
  const work2 = path.join(base, 'disk/downloads/extracted/R2');
  gameFolder(work2, 8);
  await stop(child);
  child = start(base, { BGDL_CONVERT_DELAY_MS: '100' });
  await up(base);
  const second = await call(base, 'POST', '/convert', body(base, { key: 'k2', kind: 'dir', source: work2, work: work2, output: path.join(base, 'disk/homebrew/R2.exfat') }));
  await until(base, second.data.id, ['converting'], (item) => item.written > 0);
  await stop(child);
  const saved = JSON.parse(readFileSync(path.join(base, 'state/conversions.json'), 'utf8')).conversions.find((item) => item.id === second.data.id);
  assert.equal(saved.state, 'queued');
  assert.ok(!existsSync(path.join(base, 'disk/homebrew/R2.exfat.part')));
});

// Os FPKG de PS5 de verdade do pkg_source (tests/pkg-source, gerados pelo construtor aberto do ps5upload), em gzip.
const fixtures = path.join(repo, 'tests/pkg-source');
const gunzipTo = async (name, to) => writeFileSync(to, (await import('node:zlib')).gunzipSync(readFileSync(path.join(fixtures, `${name}.pkg.gz`))));
test('pacote: um FPKG de PS5 de verdade (Kraken rapido) vira .exfat com o sha256 de cada arquivo; DLC e atualizacao (LIH) sao not-a-game', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const backup = path.join(base, 'disk/BACKUP/Jogo');
  mkdirSync(backup, { recursive: true });
  const pkg = path.join(backup, 'jogo_fast.pkg');
  await gunzipTo('jogo_fast', pkg);
  const child = start(base);
  await up(base);
  let r = await call(base, 'POST', '/convert', body(base, { kind: 'pkg', source: pkg }));
  const done = await until(base, r.data.id, ['done', 'failed']);
  assert.equal(done.state, 'done', done.error);
  const entries = readImage(path.join(base, 'disk/homebrew/PPSA01234.exfat'));
  if (entries) {
    const lines = readFileSync(path.join(fixtures, 'jogo_fast.sha256'), 'utf8').trim().split('\n');
    assert.ok(lines.length > 50);
    for (const line of lines) {
      const [hash, size, ...name] = line.split(' ');
      const file = entries[name.join(' ')];
      assert.ok(file && !file.dir, `${name.join(' ')} na imagem`);
      assert.equal(file.bytes.length, Number(size), name.join(' '));
      assert.equal(sha(file.bytes), hash, name.join(' '));
    }
  }
  assert.ok(existsSync(pkg), 'o original continua no BACKUP');
  // DLC: o pacote abre, mas nao e o jogo.
  const dlc = path.join(backup, 'dlc.pkg');
  await gunzipTo('dlc', dlc);
  r = await call(base, 'POST', '/convert', body(base, { key: 'dlc', kind: 'pkg', source: dlc, output: path.join(base, 'disk/homebrew/DLC.exfat') }));
  assert.match((await until(base, r.data.id, ['failed'])).error, /^not-a-game: /);
  // Atualizacao (\x7FLIH em volta do pacote, como em pkg-source.test.mjs): not-a-game tambem.
  const whole = readFileSync(pkg);
  const cnt = Number(whole.readBigUInt64LE(0x58));
  const head = Buffer.alloc(0x10000);
  head.write('\x7fLIH', 0, 'latin1');
  head.writeBigUInt64LE(BigInt(whole.length + 0x10000), 0x18);
  head.writeBigUInt64LE(BigInt(0x10000 + cnt), 0x30);
  head.writeBigUInt64LE(BigInt(whole.length - cnt), 0x38);
  const lih = path.join(backup, 'patch.pkg');
  writeFileSync(lih, Buffer.concat([head, whole]));
  r = await call(base, 'POST', '/convert', body(base, { key: 'lih', kind: 'pkg', source: lih, output: path.join(base, 'disk/homebrew/P.exfat') }));
  assert.match((await until(base, r.data.id, ['failed'])).error, /^not-a-game: /);
  // Um pacote que nao abre (lixo): source:, nada gravado.
  writeFileSync(path.join(backup, 'lixo.pkg'), randomBytes(70000));
  r = await call(base, 'POST', '/convert', body(base, { key: 'lixo', kind: 'pkg', source: path.join(backup, 'lixo.pkg'), output: path.join(base, 'disk/homebrew/L.exfat') }));
  assert.match((await until(base, r.data.id, ['failed'])).error, /^source: /);
  assert.ok(!readdirSync(path.join(base, 'disk/homebrew')).some((name) => /^(DLC|P|L)\.exfat/.test(name)));
  await stop(child);
});

// ---- Compactado direto (libarchive) ----
function archiveFixture(base, name) {
  const src = path.join(base, 'src', name);
  const files = gameFolder(path.join(src, 'Jogo (PS5)', 'PPSA01234-app'), 3);
  writeFileSync(path.join(src, 'Jogo (PS5)', 'leia-me.nfo'), 'notas');
  mkdirSync(path.join(src, 'Jogo (PS5)', 'Backport 4.xx'), { recursive: true });
  writeFileSync(path.join(src, 'Jogo (PS5)', 'Backport 4.xx', 'eboot.bin'), 'outro eboot');
  return { src, files };
}
function make(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')}: ${result.stderr || result.stdout}`);
}
async function convertArchive(base, sources, extra = {}) {
  const { data, status } = await call(base, 'POST', '/convert', body(base, { key: `arc-${run}-${sources.length}-${Math.random()}`, kind: 'archive', source: sources[0], sources, ...extra }));
  assert.equal(status, 201, JSON.stringify(data));
  return until(base, data.id, ['done', 'failed']);
}
function checkImage(base, files) {
  const image = path.join(base, 'disk/homebrew/PPSA01234.exfat');
  const entries = readImage(image);
  if (entries) {
    for (const [name, bytes] of Object.entries(files)) assert.equal(sha(entries[name].bytes), sha(bytes), name);
    assert.ok(!Object.keys(entries).some((name) => /leia-me|Backport|PPSA01234-app/.test(name)), 'so a pasta do jogo, na raiz');
  }
  rmSync(image);
}

test('compactado direto: RAR, RAR em volumes, 7z e zip com senha viram .exfat sem extrair; o original fica', { skip: skip || (!tool('rar') || !tool('7z') || !tool('zip') ? 'rar/7z/zip ausentes' : false) }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const child = start(base);
  await up(base);
  const backup = path.join(base, 'disk/BACKUP/Jogo');
  mkdirSync(backup, { recursive: true });
  // RAR (um arquivo)
  let { src, files } = archiveFixture(base, 'rar1');
  make('rar', ['a', '-r', '-idq', path.join(backup, 'jogo.rar'), 'Jogo (PS5)'], src);
  let done = await convertArchive(base, [path.join(backup, 'jogo.rar')]);
  assert.equal(done.state, 'done', done.error);
  checkImage(base, files);
  assert.ok(existsSync(path.join(backup, 'jogo.rar')));
  // RAR em volumes de 1 MiB (part1..partN), em ordem
  ({ src, files } = archiveFixture(base, 'rarv'));
  make('rar', ['a', '-r', '-idq', '-v1m', path.join(backup, 'jogov.rar'), 'Jogo (PS5)'], src);
  const volumes = (await import('node:fs')).readdirSync(backup).filter((name) => /^jogov\.part\d+\.rar$/.test(name)).sort().map((name) => path.join(backup, name));
  assert.ok(volumes.length >= 3, `volumes: ${volumes.length}`);
  done = await convertArchive(base, volumes);
  assert.equal(done.state, 'done', done.error);
  checkImage(base, files);
  // 7z
  ({ src, files } = archiveFixture(base, 'sevenz'));
  make('7z', ['a', '-bd', '-bso0', path.join(backup, 'jogo.7z'), 'Jogo (PS5)'], src);
  done = await convertArchive(base, [path.join(backup, 'jogo.7z')]);
  assert.equal(done.state, 'done', done.error);
  checkImage(base, files);
  // zip com senha: a certa entre as tentadas
  ({ src, files } = archiveFixture(base, 'zip'));
  make('zip', ['-qr', '-P', 'DLPSGAME.COM', path.join(backup, 'jogo.zip'), 'Jogo (PS5)'], src);
  done = await convertArchive(base, [path.join(backup, 'jogo.zip')], { passwords: ['errada', 'DLPSGAME.COM'] });
  assert.equal(done.state, 'done', done.error);
  checkImage(base, files);
  await stop(child);
});

// glibren.20: o que nao da direto nao volta mais para a Jobe extrair: a MESMA conversao passa a "extracting", o payload
// descompacta em <disco>/BACKUP/_temp/<id> e converte a pasta (ou o .pkg de PS5 de dentro); a pasta temporaria some no
// fim, deu certo ou nao. Sem jogo dentro e senha errada viram falhas com o motivo.
test('compactado que nao da direto: o payload descompacta em BACKUP/_temp e converte na mesma conversao; a pasta temporaria some', { skip: skip || (!tool('rar') || !tool('zip') ? 'rar/zip ausentes' : false) }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const child = start(base);
  await up(base);
  const backup = path.join(base, 'disk/BACKUP/Outro');
  const temp = path.join(base, 'disk/BACKUP/_temp');
  mkdirSync(backup, { recursive: true });
  const src = path.join(base, 'src/x');
  mkdirSync(src, { recursive: true });
  const fs = await import('node:fs');
  const tempEmpty = () => !existsSync(temp) || fs.readdirSync(temp).length === 0;
  writeFileSync(path.join(src, 'notas.txt'), 'nada de jogo');
  make('zip', ['-q', path.join(backup, 'nada.zip'), 'notas.txt'], src);
  let done = await convertArchive(base, [path.join(backup, 'nada.zip')]);
  assert.equal(done.state, 'failed');
  assert.match(done.error, /^not-a-game: no PS5 game folder or package/);
  assert.ok(tempEmpty(), 'nada sobra em BACKUP/_temp');
  gameFolder(path.join(src, 'A'), 1);
  make('rar', ['a', '-r', '-idq', '-hpSEGREDO', path.join(backup, 'cifrado.rar'), 'A'], src);
  done = await convertArchive(base, [path.join(backup, 'cifrado.rar')], { passwords: ['outra'] });
  assert.equal(done.state, 'failed');
  assert.match(done.error, /^source: the archive could not be extracted either/);
  assert.ok(tempEmpty());
  // Dois jogos no mesmo compactado (nao da direto): descompacta e converte o primeiro achado.
  gameFolder(path.join(src, 'B'), 1);
  make('zip', ['-qr', path.join(backup, 'dois.zip'), 'A', 'B'], src);
  const states = new Set();
  const { data } = await call(base, 'POST', '/convert', body(base, { key: 'app-dois', kind: 'archive', source: path.join(backup, 'dois.zip'), sources: [path.join(backup, 'dois.zip')] }));
  for (const end = Date.now() + 60000; Date.now() < end; await wait(20)) {
    const item = await conversion(base, data.id);
    states.add(item.state);
    if (['done', 'failed'].includes(item.state)) { done = item; break; }
  }
  assert.equal(done.state, 'done', done.error);
  assert.ok(!states.has('failed'), 'a Jobe nunca ve "failed" no meio (ela nao extrai mais)');
  assert.ok(states.has('extracting') || states.has('queued'), [...states].join(','));
  assert.equal(done.kind, 'dir', 'a mesma conversao seguiu com a pasta do jogo');
  assert.ok(existsSync(path.join(base, 'disk/homebrew/PPSA01234.exfat')));
  assert.ok(tempEmpty(), 'a pasta do jogo descompactada foi apagada depois de converter');
  assert.ok(existsSync(path.join(backup, 'dois.zip')), 'o original fica no BACKUP');
  assert.ok(!fs.readdirSync(path.join(base, 'disk/homebrew')).some((name) => name.endsWith('.part')));
  await stop(child);
});

// glibren.20: as que falharam por "not-direct" antes (esperando a Jobe extrair) voltam para a fila quando o payload novo
// sobe; "Converter todos" e o diario do payload na pagina do celular, com o PIN; BACKUP/_temp nao aparece na lista.
test('ao subir, as conversoes que ficaram "not-direct" sao retomadas; Converter todos e o diario no celular (com o PIN)', { skip: skip || (!tool('zip') ? 'zip ausente' : false) }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const disk = path.join(base, 'disk');
  const old = path.join(disk, 'BACKUP/Antigo');
  mkdirSync(old, { recursive: true });
  const src = path.join(base, 'src');
  gameFolder(path.join(src, 'A'), 1);
  gameFolder(path.join(src, 'B'), 1);
  make('zip', ['-qr', path.join(old, 'antigo.zip'), 'A', 'B'], src);
  const request = body(base, { key: 'app-antigo', kind: 'archive', source: path.join(old, 'antigo.zip'), sources: [path.join(old, 'antigo.zip')] });
  // Uma conversao gravada por um payload antigo: falhou "not-direct" e ficou esperando a Jobe.
  writeFileSync(path.join(base, 'state/conversions.json'), JSON.stringify({ version: 1, next: 7, conversions: [{ ...request, id: 'c7', state: 'failed', error: 'not-direct: more than one game in the archive', written: 0, total: 0, created: 1, updated: 1 }] }));
  const child = start(base);
  try {
    await up(base);
    const item = await until(base, 'c7', ['done', 'failed']);
    assert.equal(item.state, 'done', item.error);
    assert.ok(existsSync(path.join(disk, 'homebrew/PPSA01234.exfat')));
    // Converter todos: o que ja foi convertido nao entra; um novo entra.
    const novo = path.join(disk, 'BACKUP/Novo');
    mkdirSync(novo, { recursive: true });
    make('zip', ['-qr', path.join(novo, 'PPSA05678 novo.zip'), 'A'], src);
    mkdirSync(path.join(disk, 'BACKUP/_temp/lixo'), { recursive: true });
    assert.equal((await page('/api/backup/convert-all', { method: 'POST', body: {} })).status, 401, 'so com o PIN');
    const session = await phoneSession(base);
    const listed = await page('/api/backup', { session });
    assert.ok(!listed.data.games.some((g) => g.name === '_temp'), 'BACKUP/_temp nao e um jogo');
    const all = await page('/api/backup/convert-all', { method: 'POST', body: {}, session });
    assert.equal(all.status, 200);
    assert.ok(all.data.queued >= 1, JSON.stringify(all.data));
    assert.equal((await page('/api/backup/convert', { method: 'POST', body: { root: disk, name: '_temp' }, session })).status, 400);
    // O diario: so com o PIN; texto com as linhas do payload.
    assert.equal((await page('/api/log')).status, 401);
    const log = await page('/api/log', { session });
    assert.equal(log.status, 200);
    assert.match(log.text, /bg-downloader/);
    assert.match(log.text, /voltam para a fila \(o payload extrai\)/);
  } finally {
    await stop(child);
  }
});

test('BACKUP na pagina do celular: lista por jogo com tamanho; apagar so com o PIN; nomes invalidos e original em uso recusados', { skip }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const disk = path.join(base, 'disk');
  mkdirSync(path.join(disk, 'BACKUP/Jogo A'), { recursive: true });
  mkdirSync(path.join(disk, 'BACKUP/Jogo B/sub'), { recursive: true });
  writeFileSync(path.join(disk, 'BACKUP/Jogo A/a.rar'), randomBytes(3000));
  writeFileSync(path.join(disk, 'BACKUP/Jogo B/b.part1.rar'), randomBytes(1000));
  writeFileSync(path.join(disk, 'BACKUP/Jogo B/sub/b.part2.rar'), randomBytes(500));
  const child = start(base, { BGDL_CONVERT_DELAY_MS: '200' });
  await up(base);
  const list = await page('/api/backup');
  assert.equal(list.status, 200);
  const games = Object.fromEntries(list.data.games.map((item) => [item.name, item]));
  assert.equal(games['Jogo A'].bytes, 3000);
  assert.equal(games['Jogo B'].bytes, 1500);
  assert.equal(games['Jogo B'].files, 2);
  assert.equal(list.data.totalBytes, 4500);
  assert.equal((await page('/api/backup/delete', { method: 'POST', body: { root: disk, name: 'Jogo A' } })).status, 401, 'sem o PIN nada e apagado');
  const salt = randomBytes(32).toString('hex');
  assert.equal((await call(base, 'POST', '/config', { pinSalt: salt, pinHash: sha(`${salt}:${PIN}`) })).status, 200);
  const session = (await page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data.session;
  assert.match(session, /^[0-9a-f]{32}$/);
  for (const bad of [{ root: disk, name: '..' }, { root: disk, name: 'a/b' }, { root: disk, name: '.x' }, { root: '/etc', name: 'Jogo A' }]) {
    assert.equal((await page('/api/backup/delete', { method: 'POST', body: bad, session })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await page('/api/backup/delete', { method: 'POST', body: { root: disk, name: 'Nao existe' }, session })).status, 404);
  assert.equal((await page('/api/backup/delete', { method: 'POST', body: { root: disk, name: 'Jogo A' }, session })).status, 200);
  assert.ok(!existsSync(path.join(disk, 'BACKUP/Jogo A')) && existsSync(path.join(disk, 'BACKUP/Jogo B')));
  // Um original que uma conversao ainda le nao e apagado.
  const work = path.join(disk, 'downloads/extracted/W');
  gameFolder(work, 4);
  const pkgDir = path.join(disk, 'BACKUP/Jogo B');
  const r = await call(base, 'POST', '/convert', body(base, { kind: 'archive', source: path.join(pkgDir, 'b.part1.rar'), sources: [path.join(pkgDir, 'b.part1.rar')] }));
  assert.equal(r.status, 201);
  const busy = await page('/api/backup/delete', { method: 'POST', body: { root: disk, name: 'Jogo B' }, session });
  // (a conversao falha logo, o arquivo e aleatorio: so vale enquanto nao terminou)
  if ((await conversion(base, r.data.id)).state !== 'failed') assert.equal(busy.status, 409);
  await until(base, r.data.id, ['failed']);
  assert.equal((await page('/api/backup/delete', { method: 'POST', body: { root: disk, name: 'Jogo B' }, session })).status, 200);
  assert.deepEqual((await page('/api/backup')).data, { games: [], totalBytes: 0 });
  await stop(child);
});

test('glibren.22: a tela Pasta BACKUP do app: lista com a conversao de cada item, converter todos, apagar e o diario, pela API local com o token', { skip: skip || (!tool('zip') ? 'zip ausente' : false) }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const disk = path.join(base, 'disk');
  const src = path.join(base, 'src');
  gameFolder(path.join(src, 'A'), 1);
  const novo = path.join(disk, 'BACKUP/Novo');
  mkdirSync(novo, { recursive: true });
  make('zip', ['-qr', path.join(novo, 'PPSA01234 novo.zip'), 'A'], src);
  mkdirSync(path.join(disk, 'BACKUP/Lixo'), { recursive: true });
  writeFileSync(path.join(disk, 'BACKUP/Lixo/x.bin'), randomBytes(100));
  const child = start(base);
  try {
    await up(base);
    const anonymous = await fetch(`http://127.0.0.1:${api}/backup`);
    assert.equal(anonymous.status, 401, 'so com o token');
    const listed = await call(base, 'GET', '/backup');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.games.map((g) => g.name).sort(), ['Lixo', 'Novo']);
    assert.ok(!('conversion' in listed.data.games.find((g) => g.name === 'Novo')), 'nada convertido ainda');
    const all = await call(base, 'POST', '/backup/convert-all', {});
    assert.equal(all.status, 200);
    assert.equal(all.data.queued, 1, JSON.stringify(all.data));
    const after = (await call(base, 'GET', '/backup')).data.games.find((g) => g.name === 'Novo');
    assert.ok(after.conversion?.id, 'o item diz qual conversao e a dele');
    const done = await until(base, after.conversion.id, ['done', 'failed']);
    assert.equal(done.state, 'done', done.error);
    const converted = (await call(base, 'GET', '/backup')).data.games.find((g) => g.name === 'Novo');
    assert.equal(converted.conversion.state, 'done');
    assert.equal(converted.converted, 'PPSA01234.exfat');
    // Converter um item ja convertido: recusado com o motivo.
    const again = await call(base, 'POST', '/backup/convert', { root: disk, name: 'Novo' });
    assert.equal(again.status, 400);
    assert.equal(again.data.error, 'converted');
    assert.equal((await call(base, 'POST', '/backup/convert', { root: disk, name: '_temp' })).status, 400);
    assert.equal((await call(base, 'POST', '/backup/delete', { root: disk, name: '..' })).status, 400);
    assert.equal((await call(base, 'POST', '/backup/delete', { root: disk, name: 'Lixo' })).status, 200);
    assert.ok(!existsSync(path.join(disk, 'BACKUP/Lixo')));
    const log = await call(base, 'GET', '/log');
    assert.equal(log.status, 200);
    assert.match(log.data.text, /app: converter todos -> 1 na fila/);
    assert.match(log.data.text, /app: BACKUP .*Lixo apagado/);
  } finally {
    await stop(child);
  }
});

// ---- glibren.18: o payload converte sozinho, sem o app ----

async function phoneSession(base) {
  const salt = randomBytes(32).toString('hex');
  assert.equal((await call(base, 'POST', '/config', { pinSalt: salt, pinHash: sha(`${salt}:${PIN}`) })).status, 200);
  return (await page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data.session;
}
const conversions = async (base) => (await call(base, 'GET', '/convert')).data.conversions;
async function convUntil(base, check, ms = 60000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) { last = await conversions(base); if (check(last)) return last; }
  throw new Error(`conversions never got there: ${JSON.stringify(last)}`);
}

test('glibren.18: "Converter agora" na lista do BACKUP (com o PIN): .pkg de PS5 e 7z direto viram .exfat pelo payload; PS4, convertido e vazio recusados; o app so acompanha a mesma fonte', { skip: skip || (!tool('7z') ? '7z ausente' : false) }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const disk = path.join(base, 'disk');
  const pkgDir = path.join(disk, 'BACKUP/Jogo Pkg');
  mkdirSync(pkgDir, { recursive: true });
  await gunzipTo('jogo_fast', path.join(pkgDir, 'jogo_fast.pkg'));
  writeFileSync(path.join(pkgDir, '.jobe-backup.json'), JSON.stringify({ titleId: 'PPSA01234', platform: 'ps5', format: 'pkg', source: 'torbox' }));
  const sevenDir = path.join(disk, 'BACKUP/Jogo Sete');
  mkdirSync(sevenDir, { recursive: true });
  const src = path.join(base, 'src');
  gameFolder(path.join(src, 'Jogo (PS5)'), 2);
  make('7z', ['a', '-bd', '-bso0', path.join(sevenDir, 'PPSA05555 jogo.7z'), 'Jogo (PS5)'], src);
  mkdirSync(path.join(disk, 'BACKUP/Jogo PS4'), { recursive: true });
  writeFileSync(path.join(disk, 'BACKUP/Jogo PS4/CUSA00900.pkg'), randomBytes(4096));
  mkdirSync(path.join(disk, 'BACKUP/Vazio'), { recursive: true });
  const child = start(base);
  try {
    await up(base);
    const session = await phoneSession(base);
    assert.equal((await page('/api/backup/convert', { method: 'POST', body: { root: disk, name: 'Jogo Pkg' } })).status, 401, 'sem o PIN, nada');
    assert.deepEqual((await page('/api/backup/convert', { method: 'POST', body: { root: disk, name: 'Jogo PS4' }, session })).data, { error: 'ps4' });
    assert.deepEqual((await page('/api/backup/convert', { method: 'POST', body: { root: disk, name: 'Vazio' }, session })).data, { error: 'nothing' });
    assert.equal((await page('/api/backup/convert', { method: 'POST', body: { root: disk, name: '../fora' }, session })).status, 400);
    assert.equal((await page('/api/backup/convert', { method: 'POST', body: { root: disk, name: 'Jogo Pkg' }, session })).status, 200);
    assert.equal((await page('/api/backup/convert', { method: 'POST', body: { root: disk, name: 'Jogo Sete' }, session })).status, 200);
    // O app abre e pede a conversao da MESMA fonte (outra chave): acompanha a do payload, sem uma segunda.
    const again = await call(base, 'POST', '/convert', { key: 'PPSA01234/r9', name: 'Jogo Pkg', kind: 'pkg', source: path.join(pkgDir, 'jogo_fast.pkg'), output: path.join(disk, 'homebrew/PPSA01234-2.exfat'), root: disk, label: 'PPSA01234' });
    assert.equal(again.data.attached, true, JSON.stringify(again.data));
    const done = await convUntil(base, (list) => list.length === 2 && list.every((c) => ['done', 'failed'].includes(c.state)));
    for (const c of done) assert.equal(c.state, 'done', `${c.name}: ${c.error}`);
    assert.deepEqual(done.map((c) => [c.kind, path.basename(c.output)]).sort(), [['archive', 'PPSA05555.exfat'], ['pkg', 'PPSA01234.exfat']]);
    readImage(path.join(disk, 'homebrew/PPSA01234.exfat'));
    readImage(path.join(disk, 'homebrew/PPSA05555.exfat'));
    assert.ok(scans >= 2, 'pediu a varredura ao ShadowMount+');
    // Convertido: a lista diz e o botao recusa.
    const list = Object.fromEntries((await page('/api/backup')).data.games.map((g) => [g.name, g]));
    assert.equal(list['Jogo Pkg'].converted, 'PPSA01234.exfat');
    assert.deepEqual((await page('/api/backup/convert', { method: 'POST', body: { root: disk, name: 'Jogo Pkg' }, session })).data, { error: 'converted' });
  } finally {
    await stop(child);
  }
});

test('glibren.18: compactado que nao da direto (um .pkg dentro): o payload EXTRAI no disco e converte o .pkg de PS5; o de PS4 vai para PS4/', { skip: skip || (!tool('zip') ? 'zip ausente' : false) }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const disk = path.join(base, 'disk');
  const five = path.join(disk, 'BACKUP/Jogo Cinco');
  const four = path.join(disk, 'BACKUP/Jogo Quatro');
  mkdirSync(five, { recursive: true });
  mkdirSync(four, { recursive: true });
  const src = path.join(base, 'src');
  mkdirSync(src, { recursive: true });
  await gunzipTo('jogo_fast', path.join(src, 'PPSA01234-jogo.pkg'));
  make('zip', ['-q', '-0', path.join(five, 'PPSA01234 cinco.zip'), 'PPSA01234-jogo.pkg'], src);
  writeFileSync(path.join(src, 'CUSA00900-jogo.pkg'), randomBytes(200 * 1024));
  make('zip', ['-q', '-0', path.join(four, 'quatro.zip'), 'CUSA00900-jogo.pkg'], src);
  writeFileSync(path.join(four, '.jobe-backup.json'), JSON.stringify({ titleId: '', platform: '', format: 'zip', source: '' }));
  const child = start(base);
  try {
    await up(base);
    const session = await phoneSession(base);
    assert.equal((await page('/api/backup/convert', { method: 'POST', body: { root: disk, name: 'Jogo Cinco' }, session })).status, 200);
    const list = await convUntil(base, (l) => l.some((c) => c.kind === 'pkg' && ['done', 'failed'].includes(c.state)));
    // glibren.20: a mesma conversao (o direto recusou: pacote dentro) seguiu com o .pkg descompactado em BACKUP/_temp.
    const pkg = list.find((c) => c.kind === 'pkg');
    assert.equal(pkg.state, 'done', pkg.error);
    assert.equal(list.filter((c) => c.key.startsWith('backup-Jogo Cinco')).length, 1, 'uma conversao so');
    assert.ok(existsSync(path.join(disk, 'homebrew/PPSA01234.exfat')));
    assert.ok(!existsSync(path.join(disk, 'BACKUP/_temp', pkg.id)), 'a pasta temporaria foi apagada no fim');
    assert.equal((await page('/api/backup/convert', { method: 'POST', body: { root: disk, name: 'Jogo Quatro' }, session })).status, 200);
    for (const end = Date.now() + 30000; Date.now() < end && !existsSync(path.join(disk, 'PS4/CUSA00900-jogo.pkg')); await wait(100));
    assert.ok(existsSync(path.join(disk, 'PS4/CUSA00900-jogo.pkg')), 'o .pkg de PS4 extraido foi para PS4/ (o app instala)');
    assert.ok(existsSync(path.join(four, 'quatro.zip')), 'o original fica no BACKUP');
  } finally {
    await stop(child);
  }
});

// glibren.20b: RAR cifrado (como os do DLPSGAME) que a libarchive nao abre: o payload manda o rar-extract.elf ao
// carregador de payloads (aqui um falso: le o "ELF" ate o pedido RARX1 e o repassa ao rar-extract de desktop, o UnRAR de
// verdade, por um pipe, como o elfldr liga o socket ao programa) e tenta as senhas conhecidas; a pasta temporaria some.
const RAR_WORKER = path.join(repo, 'ps5-react/.build/app/desktop/rar-extract');
async function fakeLoader() {
  const port = await freePort();
  const seen = [];
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0), worker = null;
    socket.on('data', (chunk) => {
      if (worker) { worker.stdin.write(chunk); return; }
      buffered = Buffer.concat([buffered, chunk]);
      const at = buffered.indexOf('RARX1\n');
      if (at < 0) return;
      const request = buffered.subarray(at);
      seen.push(request.toString());
      worker = spawn(RAR_WORKER, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      worker.stdout.pipe(socket);
      worker.on('exit', () => socket.end());
      worker.stdin.write(request);
    });
    socket.on('error', () => {});
  }).listen(port, '127.0.0.1');
  return { port, seen, close: () => server.close() };
}

test('RAR cifrado (DLPSGAME): o payload descompacta pelo rar-extract com a senha conhecida e converte; senha desconhecida falha com o motivo', { skip: skip || (!tool('rar') ? 'rar ausente' : !existsSync(RAR_WORKER) ? 'rar-extract de desktop nao compilado' : false) }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const loader = await fakeLoader();
  const fakeElf = path.join(base, 'rar-extract.elf');
  writeFileSync(fakeElf, Buffer.from('\x7fELF fake payload bytes\n'.repeat(100)));
  const child = start(base, { BGDL_RAR_ELF: fakeElf, BGDL_ELFLDR_PORT: String(loader.port) });
  try {
    await up(base);
    const backup = path.join(base, 'disk/BACKUP/Cifrado');
    mkdirSync(backup, { recursive: true });
    const src = path.join(base, 'src');
    gameFolder(path.join(src, 'PPSA01234-app'), 2);
    make('rar', ['a', '-r', '-idq', '-hpDLPSGAME.COM', path.join(backup, '[DLPSGAME.COM]-PPSA01234.rar'), 'PPSA01234-app'], src);
    const done = await convertArchive(base, [path.join(backup, '[DLPSGAME.COM]-PPSA01234.rar')]);
    assert.equal(done.state, 'done', done.error);
    assert.ok(existsSync(path.join(base, 'disk/homebrew/PPSA01234.exfat')));
    assert.ok(loader.seen.length >= 1 && /password [0-9a-f]+/.test(loader.seen.at(-1)), 'o pedido levou uma senha (hex)');
    assert.ok(!existsSync(path.join(base, 'disk/BACKUP/_temp', done.id)), 'a pasta temporaria foi apagada');
    const log = readFileSync(path.join(base, 'state/bgdl.log'), 'utf8');
    assert.match(log, /RAR extraido pelo rar-extract \(com uma das senhas conhecidas\)/);
    // Uma senha que ninguem conhece: tenta todas e falha dizendo isso.
    rmSync(path.join(base, 'disk/homebrew/PPSA01234.exfat'));
    make('rar', ['a', '-r', '-idq', '-hpNINGUEM', path.join(backup, 'outro.rar'), 'PPSA01234-app'], src);
    const failed = await convertArchive(base, [path.join(backup, 'outro.rar')]);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /none of the known passwords/);
    assert.ok(!existsSync(path.join(base, 'disk/BACKUP/_temp', failed.id)));
  } finally {
    await stop(child);
    loader.close();
  }
});
