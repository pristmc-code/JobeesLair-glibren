// glibren.38 (o app fechava "na hora de gerar a lista" da Biblioteca TorBox com a lista Orbit, 11/11/2026): a gravacao
// final em passos (torbox-library.js saveLibraryRun: banco, lista + ids, fichas e a copia, um arquivo por vez, medindo
// depois de cada um, com o mesmo texto de antes), o modo enxuto com o heap do JS acima de 85% e o resumo da tela tirado do
// banco que ja esta na memoria (summarize), sem ler o arquivo de novo.
// Run: node --import ./tests/stub-loader.mjs --test tests/torbox-library-save.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const lib = await import(pathToFileURL(path.join(repo, 'app/state/torbox-library.js')).href);

function memoryFs() {
  const files = new Map();
  return { files, exists: (p) => files.has(p), readFile: (p) => { if (!files.has(p)) throw new Error(`no ${p}`); return files.get(p); }, writeFile: (p, text) => files.set(p, String(text)),
    appendFile: (p, text) => files.set(p, (files.get(p) ?? '') + text), mkdir() {}, remove: (p) => files.delete(p), rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); } };
}
const catalog = (total) => Array.from({ length: total }, (_, i) => ({ id: `PPSA${String(i + 1).padStart(5, '0')}`, title: `Quest${i + 1} Legends`, platform: 'ps5', genres: ['Action'],
  art: { cover: `https://img.example/${i + 1}.png` }, sizeGb: i + 1, formats: ['exfat'], releases: [], shortDescription: `Resumo ${i + 1}`, about: ['Sobre.'], shots: [{ url: 'https://img.example/s.jpg' }] }));
const entriesOf = (games) => games.map((game) => ({ game, sources: ['bundled'] }));

test('glibren.38: the final save writes one file at a time (library, list + ids, details, copy), the same text as before', () => {
  const games = catalog(30);
  const library = lib.emptyLibrary();
  library.builtAt = '2026-11-11T10:00:00.000Z';
  games.forEach((game, i) => { library.games[game.id] = { ...lib.describe(game, ['bundled']), torbox: { confirmed: i % 2 === 0, checkedAt: 'x', run: 'r', hash: 'h', name: null, files: i % 2 === 0 ? [{ name: 'a.exfat', size: 5e9, format: 'exfat', via: 'webdl', hash: 'h' }] : [] } }; });
  const ps5 = lib.libraryPaths('/download0/JobeesLair', true);
  const byId = new Map(games.map((game) => [game.id, game]));
  const old = memoryFs();
  lib.writeLibrary(old, ps5, library, { backup: true });
  lib.writeList(old, ps5, library, undefined, (id) => byId.get(id) ?? null);
  const fs = memoryFs();
  const samples = [];
  const partial = lib.saveLibraryRun(fs, ps5, library, { final: false, sample: (name) => samples.push(name) });
  assert.deepEqual([...fs.files.keys()], [ps5.library], 'a partial save: the library only');
  assert.equal(partial.list, false);
  samples.length = 0;
  const done = lib.saveLibraryRun(fs, ps5, library, { final: true, gameOf: (id) => byId.get(id) ?? null, sample: (name) => samples.push(name), memory: () => ({ heapUsed: 20, heapLimit: 64 }) });
  assert.deepEqual(done, { library: true, list: true, details: true, backup: true, lean: false });
  assert.deepEqual(samples, ['biblioteca-torbox:gravar-library', 'biblioteca-torbox:gravar-list', 'biblioteca-torbox:gravar-details', 'biblioteca-torbox:gravar-backup'], 'measured after each file');
  for (const key of ['library', 'backup', 'list', 'ids', 'details']) assert.equal(fs.files.get(ps5[key]), old.files.get(ps5[key]), key);
});

test('glibren.38: lean save with the JS heap above 85%: library, list and ids only, said in the log; a failing step does not stop the rest', () => {
  const games = catalog(8);
  const library = lib.emptyLibrary();
  games.forEach((game) => { library.games[game.id] = { ...lib.describe(game, ['bundled']), torbox: { confirmed: true, checkedAt: 'x', run: 'r', hash: 'h', name: null, files: [] } }; });
  const ps5 = lib.libraryPaths('/download0/JobeesLair', true);
  const fs = memoryFs();
  const lines = [];
  const done = lib.saveLibraryRun(fs, ps5, library, { final: true, gameOf: () => ({}), log: (line) => lines.push(line), memory: () => ({ heapUsed: 58, heapLimit: 64 }) });
  assert.deepEqual(done, { library: true, list: true, details: false, backup: false, lean: true });
  assert.deepEqual([...fs.files.keys()].sort(), [ps5.ids, ps5.library, ps5.list].sort());
  assert.ok(lines.some((line) => /memory high before the details \(91% of the JS heap\): lean save/.test(line)), lines.join('\n'));
  // O banco que nao grava (sem memoria) nao leva a lista junto.
  const broken = memoryFs();
  broken.appendFile = (p, text) => { if (p.includes('biblioteca')) throw new Error('out of memory'); broken.files.set(p, (broken.files.get(p) ?? '') + text); };
  const lines2 = [];
  const result = lib.saveLibraryRun(broken, ps5, library, { final: true, log: (line) => lines2.push(line) });
  assert.equal(result.library, false);
  assert.equal(result.list, true);
  assert.ok(broken.files.has(ps5.list) && broken.files.has(ps5.ids));
  assert.ok(lines2.some((line) => /library not saved: out of memory/.test(line)));
});

test('glibren.38: the screen summary comes from the library in memory (the same numbers the file gives)', () => {
  const games = catalog(12);
  const library = lib.emptyLibrary();
  library.builtAt = 'x';
  games.slice(0, 10).forEach((game, i) => { library.games[game.id] = { ...lib.describe(game, ['bundled']), torbox: { confirmed: i < 6, ...(i === 0 ? { files: [{ name: 'a.pkg', size: 170, format: 'pkg' }] } : { files: [] }), ...(i === 7 ? { broken: 1 } : {}), run: 'r' } }; });
  library.run = { id: 'r', finishedAt: null, done: 10, total: 12, sources: null };
  assert.deepEqual(lib.summarize(library, entriesOf(games)), { builtAt: 'x', games: 10, confirmed: 5, broken: 2, unchecked: 2, open: { done: 10, total: 12, sources: null, onlyNew: false } });
});
