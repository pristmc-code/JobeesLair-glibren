// Fase 3 (prototipo, branch fase3-prototipo): o nucleo A em C (app/native/bg_catalog.c) da a mesma loja que o app.
// Compila tools/fase3/a_main.c e confere com tools/fase3/compare.mjs contra a referencia do app (tools/fase3/reference.mjs,
// o state/catalog.js rodando no qjs 0.15). Precisa dos dados reais em /root/fase3-data (live.jlx, a lista Orbit gravada
// pelo payload e reference.json); sem eles o teste e pulado. Ver PROTOTIPO-fase3-nucleo.md na pasta ps5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortFrom } from './free-port.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const W = process.env.FASE3_WORK || '/root/fase3-data';
const needs = [`${W}/reference.json`, `${W}/live.jlx`, `${W}/run/orbit/orbit-store.json`];
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const skip = !compiler ? 'no C compiler' : needs.find((file) => !existsSync(file)) ? `no Fase 3 data (${W})` : false;
const freePort = freePortFrom(19);

test('nucleo A: /api/catalog igual ao app (30 consultas, opcoes dos filtros e campos de cada jogo)', { skip, timeout: 600000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-fase3-'));
  try {
    const binary = path.join(dir, 'a_catalog');
    const built = spawnSync(compiler, ['-std=gnu11', '-O2', '-w', '-o', binary, path.join(repo, 'tools/fase3/a_main.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread', '-lm'], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const port = await freePort();
    const data = path.join(repo, 'app/data');
    const run = spawnSync(process.execPath, [path.join(repo, 'tools/fase3/compare.mjs'), `${W}/reference.json`, String(port), binary, String(port),
      `${data}/catalog/index.json`, `${data}/formats.js`, `${data}/ratings.js`, '0', `${W}/live.jlx`, `${W}/run/orbit/orbit-store.json`], { encoding: 'utf8', timeout: 300000 });
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.problems, [], 'nenhuma diferenca');
    assert.match(result.consultas, /^30\/30/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
