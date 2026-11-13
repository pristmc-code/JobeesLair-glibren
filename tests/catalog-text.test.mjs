// Fase 3: o texto do catalogo do payload (app/native/bg_catalog.c + bg_unicode.h) igual ao do JS: toLowerCase completo
// (com o sigma final e o I com ponto), NFC e NFD de verdade (o localeCompare do QuickJS-ng compara em NFC) e o fold da
// tela Procurar (search/match.js: minusculas, NFD, sem U+0300-U+036F). Corpus: todo titulo, desenvolvedora e editora do
// catalogo embutido e do fixture, cada letra latina/grega/cirilica/vietnamita composta e decomposta, Hangul e os casos
// de sigma. Confere contra o Node (o mesmo Unicode nesses blocos) e, quando ha o qjs 0.15, contra ele (o motor do app).
// Run: node --import ./tests/stub-loader.mjs --test tests/catalog-text.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-cattext-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const binary = path.join(dir, 'harness');
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O2', '-w', '-o', binary, path.join(repo, 'tests/catalog-text-harness.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
const skip = !compiler ? 'no C compiler' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 400)}` : false;

function corpus() {
  const lines = new Set();
  const index = JSON.parse(readFileSync(path.join(repo, 'app/data/catalog/index.json'), 'utf8'));
  for (const game of [...index.games, ...index.twins]) lines.add(game.title);
  for (const list of [index.names.developer, index.names.publisher, index.names.genres]) for (const name of list) lines.add(name);
  for (const file of ['feed-web.json', 'feed-pegasus.json', 'feed-local.json']) {
    const doc = JSON.parse(readFileSync(path.join(repo, 'tests/fixtures/fase3', file), 'utf8'));
    for (const game of doc.games ?? doc.packages ?? []) lines.add(game.title ?? '');
  }
  // cada letra composta dos blocos latino, grego, cirilico e vietnamita, nas duas formas, sozinha e numa palavra
  const ranges = [[0xc0, 0x24f], [0x370, 0x3ff], [0x400, 0x4ff], [0x1e00, 0x1fff], [0x2100, 0x214f]];
  for (const [a, b] of ranges) for (let cp = a; cp <= b; cp++) {
    const ch = String.fromCodePoint(cp);
    lines.add(`x${ch}y ${ch.normalize('NFD')} ${ch.toUpperCase()}`);
  }
  for (const text of ['ΣΟΦΟΣ', 'ΟΔΟΣ ΣΑΣ.', "ΑΣ' Β", 'Σ', 'ΑΣΑ', 'ΑΣ', 'aΣ b', 'İstanbul', 'Iİı', 'KELVIN K ÅNGSTRÖM Å', 'ȩ́', 'ą́', 'q̣̇',
    '각 한국어 게임', 'ﬁnal ﬀ', 'ß ẞ', 'Ǆ ǅ ǆ', 'Pokémon', 'Pokémon', 'Café́', 'ŉ', 'ǰ']) lines.add(text);
  return [...lines].filter((line) => line && !line.includes('\n'));
}
const js = (line) => [line.toLowerCase(), line.normalize('NFC'), line.normalize('NFD'), line.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')];

test('minusculas, NFC, NFD e o fold da busca iguais ao JS', { skip }, () => {
  const lines = corpus();
  const run = spawnSync(binary, [], { input: `${lines.join('\n')}\n`, encoding: 'utf8', maxBuffer: 256 << 20 });
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout.trim().split('\n').map((row) => JSON.parse(row));
  assert.equal(out.length, lines.length);
  const wrong = [];
  const names = ['toLowerCase', 'NFC', 'NFD', 'fold'];
  lines.forEach((line, i) => {
    const want = js(line);
    for (let k = 0; k < 4; k++) if (out[i][k] !== want[k]) wrong.push(`${names[k]} ${JSON.stringify(line)}: ${JSON.stringify(out[i][k])} x ${JSON.stringify(want[k])}`);
  });
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} diferencas em ${lines.length} textos`);
});

const QJS = [process.env.QJS_PEAK, '/root/forks/qjs-peak/build/qjs'].find((file) => file && existsSync(file));
test('o mesmo contra o qjs 0.15 (o motor do app)', { skip: skip || (!QJS && 'no qjs') }, () => {
  const lines = corpus();
  const input = path.join(dir, 'corpus.json');
  writeFileSync(input, JSON.stringify(lines));
  const script = path.join(dir, 'text.js');
  writeFileSync(script, `import * as std from 'qjs:std';
const lines = JSON.parse(std.loadFile(${JSON.stringify(input)}));
std.out.puts(JSON.stringify(lines.map((line) => [line.toLowerCase(), line.normalize('NFC'), line.normalize('NFD'), line.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')])));`);
  const want = JSON.parse(spawnSync(QJS, ['--module', script], { encoding: 'utf8', maxBuffer: 256 << 20 }).stdout);
  const run = spawnSync(binary, [], { input: `${lines.join('\n')}\n`, encoding: 'utf8', maxBuffer: 256 << 20 });
  const out = run.stdout.trim().split('\n').map((row) => JSON.parse(row));
  const wrong = [];
  lines.forEach((line, i) => { for (let k = 0; k < 4; k++) if (out[i][k] !== want[i][k]) wrong.push(`${k} ${JSON.stringify(line)}: ${JSON.stringify(out[i][k])} x ${JSON.stringify(want[i][k])}`); });
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} diferencas`);
});
