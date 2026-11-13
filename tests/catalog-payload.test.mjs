// Fase 3: o que o app deixa para o payload montar a loja (app/state/catalog-payload.js): o config.json com as listas do
// jogador e a copia do catalogo embutido desta versao (com o version.json que o payload confere), so quando muda.
// O FileSystem aqui e um de verdade numa pasta temporaria, com /app0 = a pasta app/ do repositorio e copyAsync como o
// do motor (copia arquivo ou pasta). Run: node --import ./tests/stub-loader.mjs --test tests/catalog-payload.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledFiles } from '../tools/fase3/stage-bundled.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'jl-catpay-'));
after(() => rmSync(root, { recursive: true, force: true }));
const real = (p) => p.startsWith('/app0/') ? path.join(repo, 'app', p.slice(6)) : path.join(root, p);
let copies = 0;
const fs = {
  exists: (p) => existsSync(real(p)),
  readFile: (p) => readFileSync(real(p), 'utf8'),
  writeFile: (p, text) => { mkdirSync(path.dirname(real(p)), { recursive: true }); writeFileSync(real(p), String(text)); },
  mkdir: (p) => mkdirSync(real(p), { recursive: true }),
  rename: (a, b) => renameSync(real(a), real(b)),
  removeTree: (p) => rmSync(real(p), { recursive: true, force: true }),
  stat: (p) => { try { const s = statSync(real(p)); return { size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile() }; } catch { return null; } },
  readDir: (p) => readdirSync(real(p), { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), size: e.isFile() ? statSync(path.join(real(p), e.name)).size : 0 })),
  copyAsync: (from, to) => { copies++; assert.ok(!existsSync(real(to)), `${to} nao pode existir (como no motor)`); cpSync(real(from), real(to), { recursive: true }); return { done: Promise.resolve() }; },
};
const { CATALOG_BUNDLED, CATALOG_CONFIG, CATALOG_PARTS, catalogConfig, stageBundled, writeCatalogConfig } = await import('../app/state/catalog-payload.js');
const { VERSION } = await import('../app/version.js');
const { ORBIT_FEED } = await import('../app/state/orbit-feed.js');

test('config.json: as listas, a Orbit, os escondidos, PS4, capa e versao; gravado so quando muda', () => {
  const doc = catalogConfig();
  assert.equal(doc.app, VERSION);
  assert.deepEqual(doc.feeds, []);
  assert.deepEqual(doc.mirrors, []);
  assert.deepEqual(doc.orbit, { on: false, id: ORBIT_FEED });
  assert.deepEqual(doc.hidden, []);
  assert.equal(doc.ps4, false);
  assert.equal(doc.coverWidth, 440);
  assert.equal(writeCatalogConfig(fs), true);
  assert.deepEqual(JSON.parse(fs.readFile(CATALOG_CONFIG)), doc);
  assert.equal(writeCatalogConfig(fs), false, 'igual: nao regrava');
});

test('a copia do embutido: o mesmo desenho de app/data, version.json por ultimo com os tamanhos, uma vez por versao', async () => {
  const result = await stageBundled({ fs, log: () => {} });
  assert.equal(result, 'copied');
  const version = JSON.parse(fs.readFile(`${CATALOG_BUNDLED}/version.json`));
  assert.equal(version.version, VERSION);
  // tudo o que o payload le (tools/fase3/stage-bundled.mjs lista o mesmo para os testes do payload) esta la, do tamanho certo
  const listed = new Map(version.files.map((file) => [file.name, file.size]));
  for (const { to, from } of bundledFiles(path.join(repo, 'app'))) assert.equal(listed.get(to), statSync(from).size, to);
  for (const [name, size] of listed) assert.equal(statSync(real(`${CATALOG_BUNDLED}/${name}`)).size, size, name);
  assert.ok(!fs.exists(`${CATALOG_BUNDLED}.tmp`), 'a pasta temporaria virou a de verdade');
  assert.equal(copies, 4);
});

// glibren.54 (1o diagnostico real, 13/11): a .52/.53 copiava /app0/data/formats.js e ratings.js, que nao entravam na imagem
// (nao estavam nos "resources"): a copia falhava no console e o catalogo do payload nunca montava. No PC o teste passava
// porque le o app/ do repositorio. Agora: tudo o que a copia le esta nos resources dos dois app.json (o pacote.sh confere
// tambem na imagem montada).
test('tudo o que a copia le do /app0 esta nos resources do app.json e do app.homebrew.json', () => {
  for (const name of ['app.json', 'app.homebrew.json']) {
    const resources = JSON.parse(readFileSync(path.join(repo, 'app', name), 'utf8')).resources;
    for (const [from] of CATALOG_PARTS) {
      const inApp = from.replace(/^\/app0\//, '');
      assert.ok(resources.some((entry) => inApp === entry || inApp.startsWith(`${entry}/`)), `${name}: ${inApp} fora dos resources`);
    }
  }
});
