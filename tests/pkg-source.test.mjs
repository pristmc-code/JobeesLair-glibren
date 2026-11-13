// O leitor de .pkg (app/native/pkg_source.c), compilado no PC num harness C (tests/pkg-source/harness.c) e rodado
// contra FPKGs de PS5 de verdade gerados pelo construtor aberto do ps5upload (tests/pkg-source/gerar_fixtures.sh):
// Kraken rapido/balanceado/sem compressao, imagem cifrada com a chave de debug aberta (AES-XTS) e DLC. O sha256 de
// cada arquivo lido em fluxo tem de bater com o que o leitor do ps5-dump-forge extraiu (*.sha256) e com a fonte.
// Pacote truncado, com byte trocado, de PS4, de varejo, "plano" ou de atualizacao: erro com mensagem, sem travar e
// nunca bytes errados. Precisa de cc e dos cabecalhos do OpenSSL; sem eles o teste e pulado. Run: npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, openSync, writeSync, closeSync, ftruncateSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before as whenBuilt } from 'node:test';
import { assertBuilt, buildSkip, compileTo } from './payload-build.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const fix = path.join(repo, 'tests/pkg-source');
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-pkgsrc-'));
const binary = path.join(dir, 'harness');
after(() => rmSync(dir, { recursive: true, force: true }));
// Os pacotes ficam no repo em gzip (os sem compressao sao quase so zeros); descompactados para a pasta temporaria.
const pkgs = path.join(dir, 'pkgs');
mkdirSync(pkgs);
for (const name of readdirSync(fix).filter((n) => n.endsWith('.pkg.gz'))) writeFileSync(path.join(pkgs, name.slice(0, -3)), gunzipSync(readFileSync(path.join(fix, name))));
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(fix, 'harness.c'), '-lcrypto']);
const missing = Boolean(built && built.status !== 0 && /openssl\/evp\.h|cannot find -lcrypto/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no OpenSSL headers' : false;
// glibren.51: um binario que nao compilou (erro, aviso com -Werror ou o compilador morto por sinal) FALHA todos os
// testes deste arquivo na hora, com o motivo; antes eles viravam "pulados" e ninguem via. So a falta do ambiente pula.
whenBuilt(() => { if (!skip) assertBuilt(built); });

const run = (...args) => spawnSync(binary, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
const shaLines = (text) => text.trim().split('\n').filter(Boolean).sort((a, b) => (a.split(' ').slice(2).join(' ') < b.split(' ').slice(2).join(' ') ? -1 : 1));
const expected = (name) => shaLines(readFileSync(path.join(fix, `${name}.sha256`), 'utf8'));
const fails = (r, re) => {
  assert.equal(r.signal, null, `morreu por sinal ${r.signal}: ${r.stderr}`);
  assert.ok(r.status === 2 || r.status === 3, `esperava erro, saiu ${r.status}: ${r.stderr}`);
  if (re) assert.match(r.stderr, re);
};
const le64 = (b, at) => Number(b.readBigUInt64LE(at));

test('compila sem avisos e os vetores de cripto das referencias batem', { skip }, () => {
  assert.equal(built.status, 0, built.stderr);
  const r = run('selftest');
  assert.equal(r.status, 0, r.stderr);
});

const PKGS = [
  { name: 'jogo_fast', kind: 1 },
  { name: 'jogo_balanced', kind: 1 },
  { name: 'jogo_native', kind: 1, native: 1 },
  { name: 'dlc', kind: 3, cid: 'UP9999-PPSA99999_00-GLIBRENDLC000001' },
  { name: 'mini_stored', kind: 1, cid: 'UP9999-PPSA99999_00-GLIBRENPKGMINI01' },
];

for (const { name, kind, native = 0, cid = 'UP9999-PPSA99999_00-GLIBRENPKGSRC001' } of PKGS) {
  test(`${name}: ids, tipo, arvore e sha256 de cada arquivo (pedacos de 4 MiB, 64 KiB+1 e 1 MB+3)`, { skip }, () => {
    const pkg = path.join(pkgs, `${name}.pkg`);
    const list = run('list', pkg);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, new RegExp(`^TID PPSA99999\nCID ${cid}\nKIND ${kind}\nNATIVE ${native}\n`));
    for (const chunk of ['4194304', '65537', '1000003']) {
      const r = run('sha', pkg, chunk);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(shaLines(r.stdout), expected(name));
    }
    const rand = run('rand', pkg, '7');
    assert.equal(rand.status, 0, rand.stderr);
  });
}

test('jogo: tudo o que entrou no pacote sai igual (pastas vazias e nome com acento inclusive)', { skip }, () => {
  const r = run('sha', path.join(pkgs, 'jogo_fast.pkg'));
  assert.equal(r.status, 0, r.stderr);
  const got = new Map(r.stdout.trim().split('\n').map((l) => { const [h, s, ...p] = l.split(' '); return [p.join(' '), `${h} ${s}`]; }));
  for (const line of readFileSync(path.join(fix, 'jogo_fonte.sha256'), 'utf8').trim().split('\n')) {
    const [h, s, ...p] = line.split(' ');
    const file = p.join(' ');
    if (file === 'sce_sys/param.json') { assert.ok(got.has(file)); continue; } // o construtor reescreve o param.json
    assert.equal(got.get(file), `${h} ${s}`, file);
  }
  const list = run('list', path.join(pkgs, 'jogo_fast.pkg')).stdout;
  for (const d of ['data/empty', 'emptytop/inner', 'data/nested/deep']) assert.match(list, new RegExp(`^D ${d}$`, 'm'));
  assert.match(list, /^F 0 data\/zero\.bin$/m);
});

test('recusa layout plano, PS4, lixo, varejo e imagem cifrada com outra chave, com mensagem clara', { skip }, () => {
  fails(run('list', path.join(pkgs, 'mini_flat.pkg')), /plano/);
  const ps4 = path.join(dir, 'ps4.pkg');
  writeFileSync(ps4, Buffer.concat([Buffer.from([0x7f, 0x43, 0x4e, 0x54]), Buffer.alloc(4096)]));
  fails(run('list', ps4), /PS4/);
  const junk = path.join(dir, 'lixo.pkg');
  writeFileSync(junk, Buffer.alloc(100000, 0x41));
  fails(run('list', junk), /nao e um pacote de PS5/);
  fails(run('list', path.join(dir, 'nao-existe.pkg')), /nao abriu/);
  const retail = path.join(dir, 'varejo.pkg');
  copyFileSync(path.join(pkgs, 'jogo_fast.pkg'), retail);
  const fd = openSync(retail, 'r+');
  writeSync(fd, Buffer.from([0x80]), 0, 1, 5);
  closeSync(fd);
  fails(run('list', retail), /varejo/);
  // content id trocado: as chaves da imagem cifrada mudam e nada decifra
  const other = path.join(dir, 'outra-chave.pkg');
  copyFileSync(path.join(pkgs, 'jogo_native.pkg'), other);
  const head = readFileSync(other).subarray(0, 0x100);
  const cnt = le64(head, 0x58);
  const f2 = openSync(other, 'r+');
  writeSync(f2, Buffer.from('X'), 0, 1, cnt + 0x40 + 30);
  closeSync(f2);
  fails(run('list', other), /cifrad/);
});

test('atualizacao (\\x7FLIH): abre com tipo e ids, mas recusa listar', { skip }, () => {
  const base = readFileSync(path.join(pkgs, 'jogo_fast.pkg'));
  const cnt = le64(base, 0x58);
  const head = Buffer.alloc(0x10000);
  head.write('\x7fLIH', 0, 'latin1');
  head.writeBigUInt64LE(BigInt(base.length + 0x10000), 0x18);
  head.writeBigUInt64LE(BigInt(0x10000 + cnt), 0x30);
  head.writeBigUInt64LE(BigInt(base.length - cnt), 0x38);
  const lih = path.join(dir, 'patch.pkg');
  writeFileSync(lih, Buffer.concat([head, base]));
  const r = run('list', lih);
  fails(r, /atualizacao/);
  assert.match(r.stdout, /^TID PPSA99999\nCID UP9999-PPSA99999_00-GLIBRENPKGSRC001\nKIND 2\n/);
});

test('subpasta com inode fora da tabela (pacote montado de proposito): erro claro, sem escrever fora do vetor (R2-1)', { skip }, () => {
  for (const ino of ['100000', '0x7FFFFFFF', '0xFFFFFFF0']) {
    const r = spawnSync(binary, ['list', path.join(pkgs, 'jogo_fast.pkg')], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HARNESS_BAD_DIR_INO: ino } });
    fails(r, /inode \d+ da pasta .* passa da tabela/);
  }
  // sem o gancho o mesmo pacote continua abrindo
  assert.equal(run('list', path.join(pkgs, 'jogo_fast.pkg')).status, 0);
});

test('pacote truncado: erro, sem travar', { skip }, () => {
  const src = path.join(pkgs, 'jogo_fast.pkg');
  const size = statSync(src).size;
  for (const cut of [0, 3, 200, 0x1000, Math.floor(size / 3), Math.floor(size / 2), size - 0x10000, size - 1]) {
    const p = path.join(dir, `cut-${cut}.pkg`);
    copyFileSync(src, p);
    const fd = openSync(p, 'r+');
    ftruncateSync(fd, cut);
    closeSync(fd);
    const r = run('sha', p);
    // um corte no fim pode cair so no que vem depois dos dados do jogo; nesse caso tem de sair igual
    if (r.status === 0) assert.deepEqual(shaLines(r.stdout), expected('jogo_fast'), `corte em ${cut}`);
    else fails(r);
  }
});

test('byte trocado no cabecalho ou no PFS de fora: erro ou leitura identica, nunca bytes errados', { skip }, () => {
  for (const name of ['jogo_fast', 'jogo_native', 'mini_stored']) {
    const src = path.join(pkgs, `${name}.pkg`);
    const buf = readFileSync(src);
    const pfsOff = le64(buf, 0x10), pfsSize = le64(buf, 0x18);
    const want = expected(name);
    let x = 12345 + name.length;
    const rnd = (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
    let errors = 0;
    for (let i = 0; i < 25; i++) {
      const at = i < 5 ? rnd(0x100) : pfsOff + rnd(pfsSize);
      const bad = Buffer.from(buf);
      bad[at] ^= 1 + rnd(255);
      const p = path.join(dir, `flip-${name}-${i}.pkg`);
      writeFileSync(p, bad);
      const r = run('sha', p);
      if (r.status === 0) assert.deepEqual(shaLines(r.stdout), want, `${name}: byte ${at} trocado deu bytes errados`);
      else { fails(r); errors++; }
      rmSync(p);
    }
    assert.ok(errors > 0, `${name}: nenhum byte trocado foi detectado`);
  }
});
