// Fase 3: o catalogo da loja montado no payload (app/native/bg_catalog*.c) da a mesma loja que o app, sobre o fixture do
// repositorio (tests/fixtures/fase3: catalogo ao vivo e lista Orbit reais recortados, uma lista da web, uma Pegasus e um
// arquivo do PS5 com as regras miudas). tools/fase3/parity.mjs sobe o payload de verdade (compilado para o PC) e confere
// com o codigo do app no qjs 0.15 (ou, sem o qjs, com a referencia gravada em reference.json.gz): as opcoes dos filtros,
// os campos de cada jogo, a grade de 36 consultas (todas as paginas), as contagens dos filtros, a busca da tela Procurar,
// as fileiras da pagina inicial, 60 fichas (links, ordem, edicoes, relacionados), o "solo" da loja do celular, as fontes
// e os codigos conhecidos da lista Orbit; nas variantes ps5, firmware 9.60, PS4 e com uma lista escondida. A segunda
// rodada usa o payload com ASan + UBSan. Run: node --import ./tests/stub-loader.mjs --test tests/fase3-nucleo.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortFrom } from './free-port.mjs';
import { compileTo } from './payload-build.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const skip = !compiler ? 'no C compiler' : false;
const asan = compiler && spawnSync(compiler, ['-fsanitize=address', '-x', 'c', '-o', '/dev/null', '-'], { input: 'int main(void){return 0;}' }).status === 0;
const ports = freePortFrom(9); // Fase 3: bloco de portas so deste arquivo (tests/free-port.mjs)
const { runParity } = await import('../tools/fase3/parity.mjs');

test('paridade app x payload no fixture (ps5, firmware 9.60, PS4, lista escondida)', { skip, timeout: 900000 }, async () => {
  const result = await runParity({ ports });
  assert.deepEqual(result.problems, [], 'nenhuma diferenca');
  const ps5 = result.variantes.ps5;
  const [same, total] = ps5.consultas.split('/').map(Number);
  assert.ok(total >= 30 && same === total, `consultas ${ps5.consultas}`);
  assert.equal(ps5.fichas, '60/60');
  for (const [name, variant] of Object.entries(result.variantes)) assert.ok(variant.listados > 0, name);
  if (result.warnings.length) console.log(result.warnings.join('\n'));
});

test('a mesma paridade com o payload em ASan + UBSan', { skip: skip || (!asan && 'no ASan'), timeout: 900000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-fase3-asan-'));
  try {
    const binary = path.join(dir, 'bgdl-asan');
    const built = compileTo(binary, compiler, ['-std=gnu11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=undefined', '-fno-omit-frame-pointer',
      path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
    assert.equal(built.status, 0, built.stderr.slice(0, 2000));
    process.env.ASAN_OPTIONS = 'detect_leaks=0:abort_on_error=1';
    const result = await runParity({ binary, variants: ['ps5', 'ps4'], ports });
    assert.deepEqual(result.problems, [], 'nenhuma diferenca (e nenhum erro do ASan/UBSan, que derrubaria o payload)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
