// Fase 4: a abertura da loja (app/state/remote-store.js + state/catalog.js): com o payload no ar a loja abre sem montar
// nada no app; parado, antigo (BG_API 36), over-limit ou sem catalogo pronto, a loja e montada no app como antes; e se o
// payload cair (ou ficar over-limit) com a loja aberta, ou algo pedir a loja inteira (Biblioteca/loja TorBox), ela passa a
// ser montada no app e store-mode a monta de novo (epoch). Um processo por caso (tests/remote-store-run.mjs).
// Run: node --import ./tests/stub-loader.mjs --test tests/remote-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
function run(kase) {
  const result = spawnSync(process.execPath, ['--import', './tests/stub-loader.mjs', 'tests/remote-store-run.mjs', kase], { cwd: repo, encoding: 'utf8', timeout: 120000 });
  const line = /^RESULT (.*)$/m.exec(result.stdout ?? '');
  assert.ok(line, `${kase}: ${result.stderr || result.stdout}`.slice(0, 3000));
  return JSON.parse(line[1]);
}

test('payload no ar: a loja abre pelo payload, sem montar nada no app', () => {
  const r = run('ok');
  assert.equal(r.opened, true);
  assert.deepEqual([r.start.remote, r.start.local, r.start.ready, r.start.games, r.start.home], [true, false, true, 0, true]);
  assert.equal(r.start.state.with, 'payload');
  assert.deepEqual(r.start.counts, { titles: 9, direct: 7 });
  assert.equal(r.start.genres, 2, 'os generos vem do payload');
  assert.equal(r.carousel, 'https://h/1.jpg');
  assert.equal(r.getC1, 'Jogo C1', 'getGame acha os jogos da pagina inicial');
});

for (const [kase, reason] of [['down', 'no-payload'], ['old', 'old-api'], ['overlimit', 'over-limit'], ['notready', 'not-ready']]) {
  test(`fallback na abertura: ${kase} -> a loja montada no app`, () => {
    const r = run(kase);
    assert.equal(r.opened, false);
    assert.deepEqual([r.start.remote, r.start.local, r.start.ready, r.start.home], [false, true, true, false]);
    assert.ok(r.start.games > 1000, `loja local montada (${r.start.games})`);
    assert.equal(r.start.state.reason, reason);
    assert.equal(r.start.counts, null);
  });
}

for (const kase of ['drop', 'limit-later', 'torbox-later']) {
  test(`depois de aberta pelo payload: ${kase} -> a loja passa a ser montada no app e e montada de novo`, () => {
    const r = run(kase);
    assert.equal(r.opened, true);
    assert.equal(r.start.remote, true);
    if ('page' in r) assert.equal(r.page, null, 'a pagina pedida volta vazia (a grade cai para o caminho local)');
    assert.deepEqual([r.end.remote, r.end.local, r.end.home], [false, true, false]);
    assert.ok(r.end.games > 1000);
    assert.ok(r.end.epoch > r.start.epoch, 'store-mode montou a loja de novo');
  });
}
