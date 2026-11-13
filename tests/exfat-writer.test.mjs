// glibren.12: o criador de imagens .exfat (app/native/exfat_writer.c), compilado no PC com um harness
// (tests/exfat-writer-harness.c) e conferido por fora: fsck.exfat -n (exfatprogs), montagem da imagem (loop, como
// root) com sha256 de cada arquivo, e o leitor proprio do exw_verify. Os testes de C precisam de um compilador (cc);
// fsck e montagem sao pulados onde nao existem (sem exfatprogs ou sem root). Rodar: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
  writeSync, ftruncateSync, readSync, createReadStream,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const skip = compiler ? false : 'no C compiler';
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const fsckOk = !skip && has('fsck.exfat');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const work = mkdtempSync(path.join(os.tmpdir(), 'jl-exfatw-'));
const binary = path.join(work, 'harness');
after(() => {
  spawnSync('sh', ['-c', `grep -q '${work}' /proc/mounts && umount ${work}/m* 2>/dev/null; true`]);
  rmSync(work, { recursive: true, force: true });
});

let built = null;
const build = () => built ??= spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-I', path.join(repo, 'app/native'), '-o', binary, path.join(repo, 'tests/exfat-writer-harness.c')], { encoding: 'utf8' });
function harness(args, input = '') {
  const b = build();
  assert.equal(b.status, 0, b.stderr);
  const r = spawnSync(binary, args, { input, encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const MIB = 1024 * 1024;
const CLUSTER = 65536;

// A pasta de um jogo de teste. files: { 'caminho': Buffer | string | null (pasta) }
function tree(name, files) {
  const root = path.join(work, name);
  for (const [rel, data] of Object.entries(files)) {
    const p = path.join(root, rel);
    if (data === null) mkdirSync(p, { recursive: true });
    else {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, data);
    }
  }
  return root;
}

function walk(root, rel = '') {
  const out = [];
  for (const d of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    out.push({ rel: r, dir: d.isDirectory() });
    if (d.isDirectory()) out.push(...walk(root, r));
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

const sha = (file) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

function fsck(image) {
  if (!fsckOk) return null;
  const r = spawnSync('fsck.exfat', ['-n', image], { encoding: 'utf8' });
  assert.equal(r.status, 0, `fsck.exfat -n: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /clean/);
  return r.stdout;
}

// Monta a imagem (somente leitura), roda fn(pasta) e desmonta. Sem root ou sem exFAT no kernel: devolve null
// (EXW_REQUIRE_MOUNT=1 faz a falta de montagem falhar o teste).
let mounts = 0;
async function mounted(image, fn) {
  if (!isRoot) {
    assert.ok(!process.env.EXW_REQUIRE_MOUNT, 'montagem pedida, mas sem root');
    return null;
  }
  const dir = path.join(work, `m${mounts++}`);
  mkdirSync(dir, { recursive: true });
  const m = spawnSync('mount', ['-o', 'loop,ro', '-t', 'exfat', image, dir], { encoding: 'utf8' });
  if (m.status !== 0) {
    assert.ok(!process.env.EXW_REQUIRE_MOUNT, `mount falhou: ${m.stderr}`);
    return null;
  }
  try {
    return await fn(dir);
  } finally {
    spawnSync('umount', [dir]);
  }
}

// Mesma arvore e mesmo sha256 em cada arquivo.
async function sameTree(src, dir) {
  const a = walk(src), b = walk(dir);
  assert.deepEqual(b, a);
  for (const e of a) if (!e.dir) assert.equal(await sha(path.join(dir, e.rel)), await sha(path.join(src, e.rel)), e.rel);
  return a.length;
}

function boot(image) {
  const fd = openSync(image, 'r');
  const b = Buffer.alloc(512);
  readSync(fd, b, 0, 512, 0);
  closeSync(fd);
  return {
    volumeLength: Number(b.readBigUInt64LE(72)), fatOffset: b.readUInt32LE(80), heap: b.readUInt32LE(88),
    clusters: b.readUInt32LE(92), bpsShift: b[108], spcShift: b[109], fats: b[110],
  };
}

// O tamanho do mkexfat.sh do ShadowMount+, refeito aqui a partir da pasta (find -type f / -type d).
function mkexfatSize(root) {
  const all = walk(root);
  const files = all.filter((e) => !e.dir).map((e) => statSync(path.join(root, e.rel)).size);
  const dirs = all.filter((e) => e.dir).length + 1;
  const raw = files.reduce((s, x) => s + x, 0);
  const data = files.reduce((s, x) => s + Math.ceil(x / CLUSTER) * CLUSTER, 0);
  const cl = Math.ceil(data / CLUSTER);
  const base = data + cl * 4 + Math.ceil(cl / 8) + (files.length + dirs) * 256 + 32 * MIB;
  const spare = Math.min(Math.max(Math.floor(base / 200), 64 * MIB), 512 * MIB);
  const total = Math.max(base + spare, raw + 64 * MIB);
  return Math.ceil(total / MIB) * MIB;
}

const game = () => ({
  'eboot.bin': Buffer.alloc(300000, 7),
  'sce_sys/param.json': '{"titleId":"PPSA01234","contentId":"UP0000-PPSA01234_00-TESTE0000000000"}',
  'sce_sys/icon0.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'sce_sys/about/right.sprx': Buffer.alloc(CLUSTER, 1),
  'vazio.bin': '',
  'dados/pasta vazia': null,
  'dados/nível 1/nível 2/nível 3/nível 4/fundo.dat': Buffer.alloc(CLUSTER + 1, 3),
  'ação/Ünïcödé ✓ 日本語 😀.txt': 'acentos e emoji',
  [`longo/${'n'.repeat(200)}é.bin`]: 'nome comprido (201 caracteres)',
});

test('jogo com pastas aninhadas, acentos, Unicode e arquivo vazio: fsck limpo, monta igual (sha256), confere', { skip }, async () => {
  const src = tree('jogo', game());
  const img = path.join(work, 'jogo.exfat');
  const w = harness(['write', src, img, 'PPSA01234']);
  assert.equal(w.rc, 0, w.err);
  assert.equal(statSync(img).size, w.image);
  assert.equal(w.files, 8);
  assert.equal(w.last, w.total);
  assert.equal(w.backwards, 0);
  assert.equal(harness(['verify', src, img, '2']).rc, 0);
  assert.equal(harness(['verify', src, img, '1']).rc, 0);
  assert.equal(harness(['verify', src, img, '0']).rc, 0);
  fsck(img);
  if (has('exfatlabel')) assert.match(spawnSync('exfatlabel', [img], { encoding: 'utf8' }).stdout, /label: PPSA01234/);
  const n = await mounted(img, async (dir) => {
    // o jogo fica na raiz da imagem (regra do ShadowMount+)
    assert.ok(statSync(path.join(dir, 'sce_sys/param.json')).isFile());
    return sameTree(src, dir);
  });
  if (n !== null) assert.equal(n, walk(src).length);
});

test('geometria e tamanho do ShadowMount+: setor 512, cluster 64 KiB, heap alinhado a 64 KiB, conta do mkexfat.sh', { skip }, () => {
  const src = tree('geo', { ...game(), 'grande.bin': Buffer.alloc(3 * MIB + 5, 9) });
  const p = harness(['plan', src, 'PPSA01234']);
  assert.equal(p.rc, 0, p.err);
  assert.equal(p.cluster, CLUSTER);
  assert.equal(p.image, mkexfatSize(src));
  assert.equal(p.image % MIB, 0);
  const img = path.join(work, 'geo.exfat');
  assert.equal(harness(['write', src, img, 'PPSA01234']).rc, 0);
  const b = boot(img);
  assert.equal(b.bpsShift, 9);
  assert.equal(b.spcShift, 7);
  assert.equal(b.fats, 1);
  assert.equal(b.fatOffset * 512 % CLUSTER, 0);
  assert.equal(b.heap * 512 % CLUSTER, 0);
  assert.equal(b.volumeLength * 512, p.image);
  fsck(img);
});

test('nomes e listas invalidos sao recusados com o caminho na mensagem', { skip }, () => {
  const bad = [
    ['F 1 a:b.txt', /proibido/],
    ['F 1 pasta/x?.bin', /proibido/],
    ['F 1 tab\there', /proibido/],
    ['F 1 dir/../x', /reservado/],
    ['F 1 ./x', /reservado/],
    ['F 1 a//b', /vazio/],
    ['F 1 /abs', /invalido/],
    ['D fim/', /invalido/],
    [`F 1 ${'x'.repeat(256)}`, /longo/],
    [`F 1 ${'😀'.repeat(128)}`, /longo/],
    ['F 1 Arquivo.TXT\nF 2 arquivo.txt', /mesmo nome/],
    ['F 1 ÄÖ/a\nF 1 äö/b', /mesmo nome/],
    ['F 1 a\nF 1 a', /duas vezes/],
    ['F 1 a\nF 1 a/b', /arquivo e pasta/],
    ['F 1 x�y', /FFFD/],
  ];
  for (const [list, why] of bad) {
    const r = harness(['planlist'], `${list}\n`);
    assert.equal(r.rc, -1, `${list} devia falhar`);
    assert.match(r.err, why, list);
  }
  // UTF-8 invalido (bytes soltos) chega pela entrada crua
  const raw = spawnSync(binary, ['planlist'], { input: Buffer.concat([Buffer.from('F 1 ok/'), Buffer.from([0xC3, 0x28]), Buffer.from('\n')]) });
  assert.match(JSON.parse(raw.stdout.toString()).err, /UTF-8 invalido/);
  assert.match(harness(['planlist', 'ROTULO_LONGO_DEMAIS'], 'F 1 a\n').err, /rotulo/);
  // validos: 255 caracteres, pasta repetida (explicita e implicita), maiusculas diferentes em pastas diferentes
  const ok = harness(['planlist', 'PPSA01234'], `F 1 ${'y'.repeat(255)}\nD a\nF 1 a/b\nD a\nF 1 A.txt\nF 1 a/A.TXT\nD vazia\n`);
  assert.equal(ok.rc, 0, ok.err);
  assert.equal(ok.files, 4);
  assert.equal(ok.dirs, 2);
});

test('milhares de arquivos (pasta com varios clusters de entradas): grava, confere tudo, fsck e montagem', { skip, timeout: 300000 }, async () => {
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push(`F ${(i * 7919) % 5000} muitos/arquivo número ${String(i).padStart(5, '0')} com nome um pouco longo.bin`);
  for (let d = 0; d < 50; d++) for (let i = 0; i < 40; i++) lines.push(`F ${(d * 131 + i * 977) % 200000} p${d}/sub/f${i}`);
  lines.push('F 0 vazio', 'D so/pastas/vazias', 'F 100 sce_sys/param.json');
  const img = path.join(work, 'muitos.exfat');
  const r = harness(['synth', img, 'MUITOS'], `${lines.join('\n')}\n`);
  assert.equal(r.rc, 0, r.err);
  assert.equal(r.verify, 0, r.err);
  assert.equal(r.files, 5002);
  fsck(img);
  const n = await mounted(img, async (dir) => {
    assert.equal(readdirSync(path.join(dir, 'muitos')).length, 3000);
    return walk(dir).length;
  });
  if (n !== null) assert.equal(n, 5002 + 1 + 50 * 2 + 3 + 1);
  rmSync(img);
});

test('arquivo > 4 GB (fonte esparsa): offsets de 64 bits, fsck, montagem com sha256 igual', { skip, timeout: 600000 }, async () => {
  const src = path.join(work, 'grande');
  mkdirSync(path.join(src, 'sce_sys'), { recursive: true });
  writeFileSync(path.join(src, 'sce_sys/param.json'), '{"titleId":"PPSA04096"}');
  const big = path.join(src, 'dados.pak');
  const size = 4 * 1024 * MIB + 12345;
  const fd = openSync(big, 'w');
  ftruncateSync(fd, size);
  for (const at of [0, 2 ** 32 - 3, 2 ** 32 + 70000, size - 9]) writeSync(fd, Buffer.from(`marca@${at}`).subarray(0, Math.min(16, size - at)), 0, undefined, at);
  closeSync(fd);
  writeFileSync(path.join(src, 'depois.bin'), 'arquivo depois do grande');
  const img = path.join(work, 'grande.exfat');
  // No WSL2 o cache de disco da VM cresce com a leitura da imagem e da fonte pela montagem (8+ GB aqui) e, se passar
  // da memoria livre do Windows, a VM inteira cai. Como root, o cache e esvaziado a cada meio segundo durante o teste.
  const dropper = isRoot ? spawn('sh', ['-c', 'while :; do echo 1 > /proc/sys/vm/drop_caches; sleep 0.5; done'], { stdio: 'ignore' }) : null;
  try {
  const w = harness(['write', src, img, 'PPSA04096']);
  assert.equal(w.rc, 0, w.err);
  assert.equal(w.total, size + 24 + 23);
  const v = harness(['verify', src, img, '1']);
  assert.equal(v.rc, 0, v.err);
  fsck(img);
  await mounted(img, async (dir) => {
    assert.equal(statSync(path.join(dir, 'dados.pak')).size, size);
    await sameTree(src, dir);
  });
  } finally {
    dropper?.kill();
  }
  rmSync(img);
});

test('cancelamento pelo progresso devolve -2; progresso so cresce e termina no total', { skip }, () => {
  const src = tree('cancela', { 'sce_sys/param.json': '{}', 'a.bin': Buffer.alloc(9 * MIB, 1), 'b.bin': Buffer.alloc(9 * MIB, 2) });
  const img = path.join(work, 'cancela.exfat');
  const c = harness(['write', src, img, '', String(5 * MIB)]);
  assert.equal(c.rc, -2);
  assert.ok(c.last >= 5 * MIB && c.last < c.total);
  const ok = harness(['write', src, img, '']);
  assert.equal(ok.rc, 0, ok.err);
  assert.equal(ok.last, 18 * MIB + 2);
  assert.equal(ok.backwards, 0);
});

test('a conferencia acha conteudo trocado na imagem e fonte que mudou', { skip }, () => {
  const src = tree('confere', { 'sce_sys/param.json': '{"a":1}', 'meio.bin': Buffer.alloc(3 * CLUSTER, 5) });
  const img = path.join(work, 'confere.exfat');
  assert.equal(harness(['write', src, img, '']).rc, 0);
  // troca um byte no meio do arquivo dentro da imagem (acha pelo conteudo)
  const buf = readFileSync(img);
  const at = buf.indexOf(Buffer.alloc(3 * CLUSTER, 5)) + CLUSTER + 17;
  assert.ok(at > CLUSTER);
  const fd = openSync(img, 'r+');
  writeSync(fd, Buffer.from([6]), 0, 1, at);
  closeSync(fd);
  assert.equal(harness(['verify', src, img, '0']).rc, 0);   // nomes e tamanhos ainda batem
  const v = harness(['verify', src, img, '2']);
  assert.equal(v.rc, -1);
  assert.match(v.err, /conteudo diferente em meio\.bin \(offset 65553\)/);
  writeFileSync(path.join(src, 'novo.txt'), 'x');
  assert.match(harness(['verify', src, img, '0']).err, /falta na imagem: novo\.txt/);
  // boot sector estragado: checksum
  const fd2 = openSync(img, 'r+');
  writeSync(fd2, Buffer.from([0x55]), 0, 1, 100);
  closeSync(fd2);
  assert.match(harness(['verify', src, img, '0']).err, /checksum da regiao de boot/);
});

test('fonte pasta: link simbolico e recusado', { skip }, () => {
  const src = tree('link', { 'sce_sys/param.json': '{}' });
  symlinkSync('/etc/hostname', path.join(src, 'atalho'));
  const p = harness(['plan', src, '']);
  assert.equal(p.rc, -1);
  assert.match(p.err, /link simbolico recusado: atalho/);
  // glibren.42 (R2-2): a propria pasta-fonte sendo um link simbolico (para a pasta de outro jogo) tambem e recusada.
  const other = tree('outro-jogo', { 'sce_sys/param.json': '{}', 'eboot.bin': 'x' });
  const alias = path.join(work, 'atalho-para-outro');
  symlinkSync(other, alias);
  const q = harness(['plan', alias, '']);
  assert.equal(q.rc, -1);
  assert.match(q.err, /nao e uma pasta/);
  assert.equal(harness(['plan', other, '']).rc, 0, 'a pasta de verdade segue valendo');
});
