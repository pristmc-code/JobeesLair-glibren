// glibren.31: "reabrir na mesma tela" (app/state/return-screen.js): a pilha de telas guardada antes de abrir o app de
// videos, restaurada (e apagada) na abertura seguinte se for recente e a tela ainda existir; e quem apaga antes de
// fechar por outro motivo (Sair, a atualizacao). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const rs = await load('app/state/return-screen.js');

function memoryFs(entries = {}) {
  const files = new Map(Object.entries(entries));
  return {
    files,
    exists: (p) => files.has(p),
    readFile(p) { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
    writeFile(p, text) { files.set(p, String(text)); },
    rename(from, to) { if (!files.has(from)) throw new Error(`ENOENT ${from}`); files.set(to, files.get(from)); files.delete(from); },
    remove(p) { files.delete(p); },
  };
}
const FILE = '/download0/JobeesLair/return-screen.json';
const ROOT = { name: 'browse' };
const NOW = 1_800_000_000_000;
const known = new Set(['PPSA01234', 'PPSA05678']);
const isGame = (id) => known.has(id);

test('grava a pilha (so os campos de texto conhecidos) e restaura o inicio -> pagina do jogo, apagando o arquivo', () => {
  const fs = memoryFs();
  const stack = [{ name: 'browse', from: 'card:PPSA01234' }, { name: 'game', id: 'PPSA01234', download: { big: 'object' } }];
  assert.equal(rs.saveReturnScreen(fs, FILE, stack, { now: NOW }), true);
  assert.ok(!fs.files.has(`${FILE}.tmp`), 'gravado como .tmp e renomeado');
  const saved = JSON.parse(fs.files.get(FILE));
  assert.deepEqual(saved, { v: 1, at: NOW, stack: [{ name: 'browse', from: 'card:PPSA01234' }, { name: 'game', id: 'PPSA01234' }] });

  const back = rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW + 60_000, isGame });
  assert.deepEqual(back, [{ name: 'browse', from: 'card:PPSA01234' }, { name: 'game', id: 'PPSA01234' }]);
  assert.ok(!fs.files.has(FILE), 'uma vez so: o arquivo e apagado');
  assert.equal(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW + 61_000, isGame }), null, 'nada mais para restaurar');
});

test('a pilha do meio volta (biblioteca -> jogo; busca da Homebrew), telas desconhecidas e jogos que sumiram saem', () => {
  const fs = memoryFs();
  rs.saveReturnScreen(fs, FILE, [
    { name: 'browse' },
    { name: 'files', from: 'shelf:PPSA05678' },
    { name: 'settings', start: 'x' },
    { name: 'game', id: 'PPSA99999', from: 'related:PPSA01234' },
    { name: 'search', side: 'homebrew', only: 'homebrew' },
    { name: 'game', id: 'PPSA01234' },
  ], { now: NOW });
  assert.deepEqual(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW, isGame }), [
    { name: 'browse' },
    { name: 'files', from: 'shelf:PPSA05678' },
    { name: 'search', side: 'homebrew', only: 'homebrew' },
    { name: 'game', id: 'PPSA01234' },
  ]);
  // A edicao homebrew comeca na Homebrew: o inicio e sempre o desta edicao.
  rs.saveReturnScreen(fs, FILE, [{ name: 'browse', from: 'card:x' }, { name: 'homebrew-app', id: 'app.one' }], { now: NOW });
  assert.deepEqual(rs.takeReturnScreen(fs, FILE, { name: 'homebrew' }, { now: NOW, isGame }), [{ name: 'homebrew' }, { name: 'homebrew-app', id: 'app.one' }]);
});

test('o jogo que nao existe mais, uma tela so de inicio ou desconhecida: abre normal (e apaga)', () => {
  const fs = memoryFs();
  rs.saveReturnScreen(fs, FILE, [{ name: 'browse' }, { name: 'game', id: 'PPSA99999' }], { now: NOW });
  assert.equal(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW, isGame }), null);
  assert.ok(!fs.files.has(FILE));
  rs.saveReturnScreen(fs, FILE, [{ name: 'browse' }], { now: NOW });
  assert.equal(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW, isGame }), null);
  rs.saveReturnScreen(fs, FILE, [{ name: 'browse' }, { name: 'settings' }], { now: NOW });
  assert.equal(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW, isGame }), null);
  rs.saveReturnScreen(fs, FILE, [{ name: 'browse' }, { name: 'game' }], { now: NOW });
  assert.equal(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW, isGame }), null, 'jogo sem id');
});

test('expira: mais de 6 h depois (ou relogio muito para tras) abre normal e apaga', () => {
  const fs = memoryFs();
  const stack = [{ name: 'browse' }, { name: 'game', id: 'PPSA01234' }];
  rs.saveReturnScreen(fs, FILE, stack, { now: NOW });
  assert.ok(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW + rs.MAX_AGE_MS - 1, isGame }), 'logo antes das 6 h ainda vale');
  rs.saveReturnScreen(fs, FILE, stack, { now: NOW });
  assert.equal(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW + rs.MAX_AGE_MS + 1, isGame }), null);
  assert.ok(!fs.files.has(FILE));
  rs.saveReturnScreen(fs, FILE, stack, { now: NOW });
  assert.ok(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW - 60_000, isGame }), 'um minuto para tras ainda vale');
  rs.saveReturnScreen(fs, FILE, stack, { now: NOW });
  assert.equal(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW - rs.CLOCK_SLACK_MS - 1, isGame }), null);
  assert.equal(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW, maxAge: 1000, isGame }), null, 'nada gravado');
});

test('arquivo estragado ou ilegivel: abre normal e apaga; gravar nunca lanca', () => {
  for (const text of ['{', 'null', '[]', '{"at":"x","stack":[]}', '{"v":1,"at":1800000000000}', `{"v":1,"at":${NOW},"stack":"game"}`]) {
    const fs = memoryFs({ [FILE]: text });
    assert.equal(rs.takeReturnScreen(fs, FILE, ROOT, { now: NOW, isGame }), null, text);
    assert.ok(!fs.files.has(FILE), text);
  }
  const refusing = { ...memoryFs({ [FILE]: '{}' }), readFile() { throw new Error('EIO'); } };
  assert.equal(rs.takeReturnScreen(refusing, FILE, ROOT, { now: NOW, isGame }), null);
  assert.ok(!refusing.files.has(FILE));
  const readOnly = { ...memoryFs(), writeFile() { throw new Error('EROFS'); } };
  assert.equal(rs.saveReturnScreen(readOnly, FILE, [{ name: 'browse' }, { name: 'game', id: 'PPSA01234' }], { now: NOW }), false);
  assert.equal(rs.saveReturnScreen(memoryFs(), FILE, undefined), false, 'sem pilha (fora da navegacao)');
  assert.equal(rs.saveReturnScreen(memoryFs(), FILE, []), false);
  // Uma pilha enorme guarda so as ultimas MAX_SCREENS.
  const fs = memoryFs();
  rs.saveReturnScreen(fs, FILE, Array.from({ length: 20 }, (_, n) => ({ name: 'game', id: `G${n}` })), { now: NOW });
  assert.equal(JSON.parse(fs.files.get(FILE)).stack.length, rs.MAX_SCREENS);
});

test('forgetReturnScreen apaga o arquivo e o .tmp; o app (return-screen-run.js) le uma vez so por execucao', async () => {
  const fs = memoryFs({ [FILE]: '{}', [`${FILE}.tmp`]: '{}' });
  rs.forgetReturnScreen(fs, FILE);
  assert.equal(fs.files.size, 0);
  rs.forgetReturnScreen(fs, FILE);

  // O modulo de verdade, sobre o FileSystem do stub-loader (globalThis.__stubFiles).
  globalThis.__stubFiles = new Map();
  const run = await load('app/state/return-screen-run.js');
  assert.match(run.RETURN_PATH, /\/JobeesLair\/return-screen\.json$/);
  assert.equal(run.rememberScreen([{ name: 'browse' }, { name: 'game', id: 'PPSA01234' }]), true);
  assert.ok(globalThis.__stubFiles.has(run.RETURN_PATH));
  // O stub nao tem remove: o arquivo fica, mas a segunda leitura (navegacao remontada pela troca de tema) e null.
  assert.deepEqual(run.takeStartStack(ROOT, isGame), [{ name: 'browse' }, { name: 'game', id: 'PPSA01234' }]);
  run.rememberScreen([{ name: 'browse' }, { name: 'game', id: 'PPSA01234' }]);
  assert.equal(run.takeStartStack(ROOT, isGame), null, 'uma vez so por execucao');
  delete globalThis.__stubFiles;
});

test('Sair (leaveApp) apaga a tela guardada antes de fechar', async () => {
  const { leaveApp } = await load('app/state/exit-app.js');
  const order = [];
  await leaveApp({ bye: async () => true, exit: () => order.push('exit'), log: () => {}, forget: () => order.push('forget') });
  assert.deepEqual(order, ['forget', 'exit']);
  let closed = 0;
  await leaveApp({ bye: async () => true, exit: () => ++closed, log: () => {}, forget: () => { throw new Error('boom'); } });
  assert.equal(closed, 1, 'fecha mesmo se apagar falhar');
});

test('glibren.31: a troca para o app de videos (leaveForSwitch) guarda a tela, marca a fila, avisa o payload e fecha', async () => {
  const { leaveForSwitch } = await load('app/state/exit-app.js');
  const order = [];
  await leaveForSwitch({ bye: async () => (order.push('bye'), true), exit: () => order.push('exit'), log: () => {}, forget: () => order.push('forget'), prepare: () => order.push('prepare') });
  assert.deepEqual(order, ['prepare', 'bye', 'exit'], 'a tela guardada fica; a fila e marcada antes de fechar');
});
