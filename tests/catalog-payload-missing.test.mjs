// glibren.54: a copia do embutido para o payload (app/state/catalog-payload.js) numa imagem sem formats.js e ratings.js
// (como a .52/.53 no console): copia o resto e o version.json lista so o que foi copiado (o payload monta sem os formatos e as
// notas do embutido). Sem catalog/ ou packs/ continua falhando. Um processo so para isto (a copia e uma vez por abertura).
// Run: node --import ./tests/stub-loader.mjs --test tests/catalog-payload-missing.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'jl-catmiss-'));
after(() => rmSync(root, { recursive: true, force: true }));
const MISSING = new Set(['/app0/data/formats.js', '/app0/data/ratings.js']);
const real = (p) => p.startsWith('/app0/') ? path.join(repo, 'app', p.slice(6)) : path.join(root, p);
const fs = {
  exists: (p) => !MISSING.has(p) && existsSync(real(p)),
  readFile: (p) => readFileSync(real(p), 'utf8'),
  writeFile: (p, text) => { mkdirSync(path.dirname(real(p)), { recursive: true }); writeFileSync(real(p), String(text)); },
  mkdir: (p) => mkdirSync(real(p), { recursive: true }),
  rename: (a, b) => renameSync(real(a), real(b)),
  removeTree: (p) => rmSync(real(p), { recursive: true, force: true }),
  stat: (p) => { try { const s = statSync(real(p)); return { size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile() }; } catch { return null; } },
  readDir: (p) => readdirSync(real(p), { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), size: e.isFile() ? statSync(path.join(real(p), e.name)).size : 0 })),
  copyAsync: (from, to) => {
    if (MISSING.has(from)) return { done: Promise.reject(new Error(`fs.copyAsync ${to}: read the source: No such file or directory`)) };
    cpSync(real(from), real(to), { recursive: true });
    return { done: Promise.resolve() };
  },
};
const { CATALOG_BUNDLED, stageBundled } = await import('../app/state/catalog-payload.js');

test('imagem sem formats.js/ratings.js: copia o resto e o version.json nao os lista', async () => {
  const lines = [];
  assert.equal(await stageBundled({ fs, log: (line) => lines.push(line) }), 'copied');
  const version = JSON.parse(fs.readFile(`${CATALOG_BUNDLED}/version.json`));
  const names = version.files.map((file) => file.name);
  assert.ok(names.some((name) => name.startsWith('catalog/')) && names.some((name) => name.startsWith('packs/')));
  assert.ok(!names.includes('formats.js') && !names.includes('ratings.js'));
  assert.ok(lines.some((line) => /formats\.js is not in the image/.test(line)), lines.join('\n'));
});
