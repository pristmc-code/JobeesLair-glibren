// glibren.42 (R2-2, R2-3): a extracao de reserva do payload (auto_extract em app/native/bg_convert.c), com um .tar
// montado de proposito: dois jogos (entao nao da direto e o payload extrai em BACKUP/_temp), hardlink absoluto para
// fora seguido de um arquivo com o mesmo nome (o ataque "link() e grava por cima"), hardlink com "..", hardlink interno
// legitimo, links simbolicos para fora, fifo e nomes nao-ASCII (fora do locale "C" do payload).
// Espera: o arquivo de fora fica intacto, a conversao termina "done", o payload segue vivo, o diario conta as entradas
// puladas e (como root, com exFAT no kernel) a imagem traz os arquivos certos, sem os links.
// Precisa de cc, libcurl, OpenSSL, libarchive e python3 (gera o .tar). Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortFrom } from './free-port.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-convx-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l(?:curl|crypto|archive)/.test(built.stderr));
const python = spawnSync('python3', ['--version']).status === 0;
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 400)}` : !python ? 'python3 ausente' : false;
const children = new Set();
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
function start(base, api, monitor) {
  const child = spawn(binary, [], { env: { ...process.env, LANG: 'C', LC_ALL: 'C', BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor),
    BGDL_SMP_BASE: 'http://127.0.0.1:9/api/v1', BGDL_BACKUP_ROOTS: path.join(base, 'disk'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt') }, stdio: ['ignore', 'pipe', 'ignore'] });
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
async function up(base, api) {
  for (let i = 0; i < 100; i++) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call(base, api, 'GET', '/health')).status === 200) return; } catch {}
    await wait(50);
  }
  throw new Error('payload did not start');
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
