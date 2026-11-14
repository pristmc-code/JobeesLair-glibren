// glibren.42 (R2-2, R2-3): a extracao de reserva do payload (auto_extract em app/native/bg_convert.c), com um .tar
// montado de proposito: dois jogos (entao nao da direto e o payload extrai em BACKUP/_temp), hardlink absoluto para
// fora seguido de um arquivo com o mesmo nome (o ataque "link() e grava por cima"), hardlink com "..", hardlink interno
// legitimo, links simbolicos para fora, fifo e nomes nao-ASCII (fora do locale "C" do payload).
// Espera: o arquivo de fora fica intacto, a conversao termina "done", o payload segue vivo, o diario conta as entradas
// puladas e (como root, com exFAT no kernel) a imagem traz os arquivos certos, sem os links.
// Precisa de cc, libcurl, OpenSSL, libarchive e python3 (gera o .tar). Run: npm test
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortFrom } from './free-port.mjs';
import { before as whenBuilt } from 'node:test';
import { assertBuilt, buildSkip, compileTo } from './payload-build.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-convx-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l(?:curl|crypto|archive)/.test(built.stderr));
const python = spawnSync('python3', ['--version']).status === 0;
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : !python ? 'python3 ausente' : false;
// glibren.51: um binario que nao compilou (erro, aviso com -Werror ou o compilador morto por sinal) FALHA todos os
// testes deste arquivo na hora, com o motivo; antes eles viravam "pulados" e ninguem via. So a falta do ambiente pula.
whenBuilt(() => { if (!skip) assertBuilt(built); });
const children = new Set();
// glibren.49: um teste que falhou no meio (maquina carregada) deixava o payload dele no ar segurando a porta da API, e
// todos os seguintes deste arquivo falhavam com "payload did not start" (16 falhas em cascata na .48). Cada teste
// comeca sem nenhum payload de antes.
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
const freePort = freePortFrom(12); // bloco de portas so deste arquivo (tests/free-port.mjs)

// Gera o .tar (python3 tarfile): <saida> <arquivo de fora> <pax|gnu>.
const MKTAR = String.raw`
import io, sys, tarfile
out, victim, fmt = sys.argv[1], sys.argv[2], sys.argv[3]
form = tarfile.PAX_FORMAT if fmt == 'pax' else tarfile.GNU_FORMAT
def add(t, name, data=None, kind=tarfile.REGTYPE, link=''):
    i = tarfile.TarInfo(name)
    i.type = kind
    i.mode = 0o755 if kind == tarfile.DIRTYPE else 0o644
    i.linkname = link
    if data is not None:
        i.size = len(data)
        t.addfile(i, io.BytesIO(data))
    else:
        t.addfile(i)
with tarfile.open(out, 'w', format=form, encoding='utf-8') as t:
    for g in ('A', 'B'):
        add(t, g, kind=tarfile.DIRTYPE)
        add(t, g + '/sce_sys', kind=tarfile.DIRTYPE)
        add(t, g + '/sce_sys/param.json', b'{"titleId":"PPSA01234","contentVersion":"01.000.000"}')
        add(t, g + '/eboot.bin', b'E' * 70000)
        add(t, g + '/data', kind=tarfile.DIRTYPE)
        add(t, g + '/data/big.bin', b'D' * 300000)
        add(t, g + '/data/link.bin', kind=tarfile.LNKTYPE, link=victim)
        add(t, g + '/data/link.bin', b'PWNED')
        add(t, g + '/data/sobe.bin', kind=tarfile.LNKTYPE, link='../../../../../../../../' + victim.lstrip('/'))
        add(t, g + '/data/copia.bin', kind=tarfile.LNKTYPE, link=g + '/data/big.bin')
        add(t, g + '/fora', kind=tarfile.SYMTYPE, link='/etc')
        add(t, g + '/data/vitima', kind=tarfile.SYMTYPE, link=victim)
        add(t, g + '/fifo', kind=tarfile.FIFOTYPE)
        add(t, g + '/data/café’™ 日本語.bin', b'unicode ok')
`;

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
// glibren.49: prazo largo pelo relogio monotonico (com a suite inteira em paralelo subir passa de 5 s) e, se nao subir,
// o fim do diario do payload na mensagem.
async function up(base, api, ms = 30000) {
  for (const end = performance.now() + ms; performance.now() < end; await wait(50)) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call(base, api, 'GET', '/health')).status === 200) return; } catch {}
  }
  let tail = '';
  try { tail = readFileSync(path.join(base, 'state/bgdl.log'), 'utf8').split('\n').slice(-15).join('\n'); } catch {}
  throw new Error(`payload did not start:\n${tail}`);
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

for (const fmt of ['pax', 'gnu']) {
  test(`tar (${fmt}) com hardlink/link simbolico para fora e nome nao-ASCII: extrai so o que e do jogo, o de fora fica intacto, sem derrubar o payload (R2-2, R2-3)`, { skip }, async () => {
    const base = path.join(dir, `run${++run}`);
    mkdirSync(path.join(base, 'state'), { recursive: true });
    mkdirSync(path.join(base, 'disk/homebrew'), { recursive: true });
    mkdirSync(path.join(base, 'disk/downloads'), { recursive: true });
    const backup = path.join(base, 'disk/BACKUP/Malicioso');
    mkdirSync(backup, { recursive: true });
    const victim = path.join(base, 'fora/vitima.txt');
    mkdirSync(path.dirname(victim), { recursive: true });
    writeFileSync(victim, 'original');
    const tar = path.join(backup, 'jogo.tar');
    const made = spawnSync('python3', ['-I', '-c', MKTAR, tar, victim, fmt], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const api = await freePort();
    const child = start(base, api, await freePort());
    try {
      await up(base, api);
      const output = path.join(base, 'disk/homebrew/PPSA01234.exfat');
      const { status, data } = await call(base, api, 'POST', '/convert', { key: `x-${fmt}`, name: 'Jogo', label: 'PPSA01234', root: path.join(base, 'disk'), output, kind: 'archive', source: tar, sources: [tar] });
      assert.equal(status, 201, JSON.stringify(data));
      let done;
      for (const end = Date.now() + 60000; Date.now() < end && !done; await wait(50)) {
        const item = (await call(base, api, 'GET', '/convert')).data.conversions.find((c) => c.id === data.id);
        if (item && ['done', 'failed'].includes(item.state)) done = item;
      }
      assert.ok(done, 'a conversao terminou');
      assert.equal(done.state, 'done', done.error);
      assert.equal(readFileSync(victim, 'utf8'), 'original', 'o arquivo de fora nao foi tocado');
      assert.equal((await call(base, api, 'GET', '/health')).status, 200, 'o payload segue vivo');
      assert.ok(!existsSync(path.join(base, 'disk/BACKUP/_temp', data.id)), 'a pasta temporaria foi apagada');
      const log = readFileSync(path.join(base, 'state/bgdl.log'), 'utf8');
      assert.match(log, /extracao pulou \d+ entrada\(s\)/);
      const image = readImage(output);
      if (image) {
        assert.equal(image['data/link.bin'].bytes.toString(), 'PWNED', 'o arquivo comum com o nome do link foi gravado na pasta do jogo');
        assert.equal(image['data/copia.bin'].bytes.length, 300000, 'o hardlink interno virou o arquivo');
        assert.equal(image['data/café’™ 日本語.bin'].bytes.toString(), 'unicode ok', 'nome nao-ASCII');
        for (const name of ['fora', 'data/vitima', 'fifo', 'data/sobe.bin']) assert.ok(!image[name], `${name} nao entra na imagem`);
      }
    } finally {
      await stop(child);
    }
  });
}

// glibren.55: PS5 real (Alan Wake 2, 13/11/2026): um .exfat dentro de um .7z ("PPSA02572-game-unknown-....exfat.7z") nao
// da direto ("the archive holds a package or an image"); a extracao falhava com "write: Could not stat
// .../_temp/c21/PPSA02572.exfat" (o lstat de cada pedaco do caminho do SECURE_SYMLINKS) e, mesmo extraida, a imagem
// virava "not-a-game". Agora a imagem de dentro e so publicada em homebrew/, sem reconverter. 24 MiB: varios blocos de
// ARC_BLOCK (1 MiB), o caminho de fluxo.
const sevenZip = ['7z', '7za'].find((name) => spawnSync(name, ['i'], { stdio: 'ignore' }).status === 0);
test('.exfat dentro de .7z: a conversao extrai e publica a imagem em homebrew/<codigo>.exfat, sem reconverter', { skip: skip || (!sevenZip && 'sem 7z') }, async () => {
  const base = path.join(dir, `run${++run}`);
  mkdirSync(path.join(base, 'state'), { recursive: true });
  mkdirSync(path.join(base, 'disk/downloads'), { recursive: true });
  const backup = path.join(base, 'disk/BACKUP/Alan Wake 2 Deluxe Edition (3)');
  const inner = path.join(base, 'monta');
  mkdirSync(backup, { recursive: true });
  mkdirSync(inner, { recursive: true });
  const bytes = randomBytes(24 * 1024 * 1024);
  writeFileSync(path.join(inner, 'PPSA02572.exfat'), bytes);
  const archive = path.join(backup, 'PPSA02572-game-unknown-rcc915f30fb54.exfat.7z');
  const made = spawnSync(sevenZip, ['a', '-mx=0', archive, 'PPSA02572.exfat'], { cwd: inner, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  rmSync(inner, { recursive: true, force: true });
  const api = await freePort();
  const child = start(base, api, await freePort());
  try {
    await up(base, api);
    const output = path.join(base, 'disk/homebrew/PPSA02572.exfat');
    const { status, data } = await call(base, api, 'POST', '/convert', { key: 'x-7z-exfat', name: 'Alan Wake 2 Deluxe Edition', label: 'PPSA02572', root: path.join(base, 'disk'), output, kind: 'archive', source: archive, sources: [archive] });
    assert.equal(status, 201, JSON.stringify(data));
    let done;
    for (const end = Date.now() + 60000; Date.now() < end && !done; await wait(50)) {
      const item = (await call(base, api, 'GET', '/convert')).data.conversions.find((c) => c.id === data.id);
      if (item && ['done', 'failed'].includes(item.state)) done = item;
    }
    assert.ok(done, 'a conversao terminou');
    assert.equal(done.state, 'done', done.error);
    const sha = (b) => createHash('sha256').update(b).digest('hex');
    assert.equal(sha(readFileSync(output)), sha(bytes), 'a imagem de dentro, byte a byte, em homebrew/');
    assert.ok(!existsSync(path.join(base, 'disk/BACKUP/_temp', data.id)), 'a pasta temporaria foi apagada');
    assert.ok(existsSync(archive), 'o .7z original fica no BACKUP');
    assert.match(readFileSync(path.join(base, 'state/bgdl.log'), 'utf8'), /imagem pronta dentro do compactado, publicada em/);
  } finally {
    await stop(child);
  }
});

// glibren.58: PS5 real (Alan Wake 2, .exfat.7z de 91,7 GB, 14/11/2026): a extracao levava 1h43 a ~15 MB/s e as telas so
// mostravam "Descompactando" com a barra listrada. Agora GET /convert e /api/status trazem o progresso da extracao:
// formato, bytes extraidos de quantos (o total descompactado dos cabecalhos), lidos do compactado, velocidade, tempo
// restante e o motivo "cpu" (LZMA). BGDL_CONVERT_DELAY_MS segura cada bloco de 1 MiB para dar tempo de ler.
const MKZIP = String.raw`
import sys, zipfile
out, name, src = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:
    z.write(src, name)
`;
async function followExtraction(base, api, monitor, id) {
  const seen = [], phone = [];
  let done;
  for (const end = Date.now() + 90000; Date.now() < end && !done; await wait(100)) {
    const item = (await call(base, api, 'GET', '/convert')).data.conversions.find((c) => c.id === id);
    if (item?.state === 'extracting') {
      seen.push(item);
      const status = await fetch(`http://127.0.0.1:${monitor}/api/status`).then((r) => r.json()).catch(() => null);
      const mine = status?.conversions?.find((c) => c.id === id);
      if (mine?.state === 'extracting') phone.push(mine);
    }
    if (item && ['done', 'failed'].includes(item.state)) done = item;
  }
  return { seen, phone, done };
}
for (const kind of ['7z', 'zip']) {
  const tool = kind === '7z' ? sevenZip : python;
  test(`glibren.58: extraindo um .${kind}, GET /convert e /api/status trazem o progresso (formato, bytes, total, velocidade, tempo, motivo)`, { skip: skip || (!tool && `sem ${kind}`) }, async () => {
    const base = path.join(dir, `run${++run}`);
    mkdirSync(path.join(base, 'state'), { recursive: true });
    mkdirSync(path.join(base, 'disk/downloads'), { recursive: true });
    const backup = path.join(base, 'disk/BACKUP/Alan Wake 2');
    const inner = path.join(base, 'monta');
    mkdirSync(backup, { recursive: true });
    mkdirSync(inner, { recursive: true });
    const bytes = randomBytes(12 * 1024 * 1024);
    writeFileSync(path.join(inner, 'PPSA02572.exfat'), bytes);
    const archive = path.join(backup, `PPSA02572-game.exfat.${kind}`);
    const made = kind === '7z'
      ? spawnSync(sevenZip, ['a', '-mx=1', archive, 'PPSA02572.exfat'], { cwd: inner, encoding: 'utf8' })
      : spawnSync('python3', ['-I', '-c', MKZIP, archive, 'PPSA02572.exfat', path.join(inner, 'PPSA02572.exfat')], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    rmSync(inner, { recursive: true, force: true });
    const archiveBytes = statSync(archive).size;
    const api = await freePort();
    const monitor = await freePort();
    const child = start(base, api, monitor, { BGDL_CONVERT_DELAY_MS: '250' });
    try {
      await up(base, api);
      const output = path.join(base, 'disk/homebrew/PPSA02572.exfat');
      const { status, data } = await call(base, api, 'POST', '/convert', { key: `x-prog-${kind}`, name: 'Alan Wake 2', label: 'PPSA02572', root: path.join(base, 'disk'), output, kind: 'archive', source: archive, sources: [archive] });
      assert.equal(status, 201, JSON.stringify(data));
      const { seen, phone, done } = await followExtraction(base, api, monitor, data.id);
      assert.ok(done, 'a conversao terminou');
      assert.equal(done.state, 'done', done.error);
      assert.ok(seen.length >= 3, `viu a extracao andando (${seen.length} leituras)`);
      const total = bytes.length;
      for (const item of seen) {
        assert.equal(item.extractFormat, kind);
        assert.equal(item.limitedBy, kind === '7z' ? 'cpu' : '', '7z (LZMA) e limitado pelo processador; zip nao');
        assert.equal(item.extractTotal, total, 'o total descompactado vem dos cabecalhos');
        assert.equal(item.archiveBytes, archiveBytes, 'o tamanho do compactado');
        assert.ok(item.extracted >= 0 && item.extracted <= total);
        assert.equal(item.written, item.extracted, 'written/total acompanham (clientes antigos)');
        assert.equal(item.total, total);
        assert.ok(item.extractPercent >= 0 && item.extractPercent <= 100, `percentual ${item.extractPercent}`);
        assert.equal(item.extractPercent, Math.floor(item.extracted * 100 / total));
        assert.equal(item.target, 'PPSA02572.exfat');
      }
      const late = seen.filter((item) => item.extractBytesPerSecond > 0);
      assert.ok(late.length, 'a velocidade aparece depois de 1 s');
      assert.ok(late.every((item) => item.extractEtaSeconds >= 0), 'com velocidade, o tempo restante');
      assert.ok(seen.some((item) => item.extracted > 0 && item.extracted < total), 'um ponto no meio');
      assert.ok(seen.at(-1).archiveRead > 0, 'bytes lidos do compactado');
      assert.ok(phone.length, '/api/status (pagina do celular) tambem');
      for (const item of phone) {
        assert.equal(item.extractFormat, kind);
        assert.equal(item.extractTotal, total);
        assert.equal(item.limitedBy, kind === '7z' ? 'cpu' : '');
        assert.equal(item.target, 'PPSA02572.exfat');
        assert.ok(!('source' in item), 'sem caminhos no celular');
      }
      assert.equal(done.extractFormat, '', 'fora da extracao os campos vem zerados');
      assert.equal(done.extractPercent, -1);
      assert.equal(done.limitedBy, '');
      assert.match(readFileSync(path.join(base, 'state/bgdl.log'), 'utf8'), new RegExp(`extraindo .*\\(${kind}, 0\\.01 GB descompactados\\)`));
    } finally {
      await stop(child);
    }
  });
}
