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

test('compactado direto: quando nao da, o erro e not-direct (o app cai para extrair): sem jogo, dois jogos, pacote dentro, senha errada, zip em fluxo sem tamanho', { skip: skip || (!tool('rar') || !tool('zip') ? 'rar/zip ausentes' : false) }, async () => {
  monitorPort = await freePort();
  const base = workspace();
  const child = start(base);
  await up(base);
  const backup = path.join(base, 'disk/BACKUP/Outro');
  mkdirSync(backup, { recursive: true });
  const src = path.join(base, 'src/x');
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, 'notas.txt'), 'nada de jogo');
  make('zip', ['-q', path.join(backup, 'nada.zip'), 'notas.txt'], src);
  let done = await convertArchive(base, [path.join(backup, 'nada.zip')]);
  assert.match(done.error, /^not-direct: no PS5 game folder/);
  writeFileSync(path.join(src, 'game.pkg'), 'pkg');
  make('zip', ['-q', path.join(backup, 'pkg.zip'), 'game.pkg'], src);
  done = await convertArchive(base, [path.join(backup, 'pkg.zip')]);
  assert.match(done.error, /^not-direct: the archive holds a package or an image/);
  gameFolder(path.join(src, 'A'), 1);
  gameFolder(path.join(src, 'B'), 1);
  make('zip', ['-qr', path.join(backup, 'dois.zip'), 'A', 'B'], src);
  done = await convertArchive(base, [path.join(backup, 'dois.zip')]);
  assert.match(done.error, /^not-direct: more than one game/);
  make('rar', ['a', '-r', '-idq', '-hpSEGREDO', path.join(backup, 'cifrado.rar'), 'A'], src);
  done = await convertArchive(base, [path.join(backup, 'cifrado.rar')], { passwords: ['outra'] });
  assert.match(done.error, /^not-direct: /);
  // zip gravado em fluxo (data descriptor: o cabecalho local nao diz o tamanho)
  const streamed = spawnSync('sh', ['-c', `cd "${src}" && tar cf - A >/dev/null; cat A/eboot.bin | zip -q - - > "${path.join(backup, 'fluxo.zip')}"`]);
  assert.equal(streamed.status, 0);
  done = await convertArchive(base, [path.join(backup, 'fluxo.zip')]);
  assert.match(done.error, /^not-direct: /);
  assert.ok(!(await import('node:fs')).readdirSync(path.join(base, 'disk/homebrew')).some((name) => name.endsWith('.part')));
  await stop(child);
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
