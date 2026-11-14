// glibren.59: as regras do player do YouTube (app/tube/player-plan.js). Relatos do PS5 real (14/11/2026):
//   - avancar/retroceder mostrava "Essa qualidade falhou" e o player ciclava os formatos ate o VP9+AAC, que pisca: o
//     erro logo depois do seek era tratado como falha da qualidade;
//   - pedido: toque = 10 s, segurar acelera (10 s -> 30 s -> 1 min -> 2 min), um seek so ao soltar;
//   - o app nunca fica parado sem mensagem (travada / nao abriu).
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const plan = await import('../app/tube/player-plan.js');
const { scrubStep, scrubPress, scrubHold, scrubRelease, scrubDue, clampTarget, SCRUB_COMMIT_MS, errorPlan, newAttempts, noteSeek,
  stallPlan, SEEK_GRACE_MS, FRESH_AFTER_MS } = plan;

test('passo da navegacao: 10 s, depois 30 s, 1 min, 2 min conforme o tempo segurado', () => {
  assert.deepEqual([0, 1000, 1600, 3000, 4000, 7000, 12000].map(scrubStep), [10, 10, 30, 30, 60, 120, 300]);
  assert.equal(clampTarget(-5, 100), 0);
  assert.equal(clampTarget(500, 100), 99);
  assert.equal(clampTarget(500, 0), 500, 'sem duracao conhecida: sem teto');
});

test('toque = 10 s e o seek so acontece depois de soltar; toques seguidos somam num seek so', () => {
  let s = scrubPress(null, 1, 60, 600, 0);
  assert.equal(s.target, 70);
  assert.equal(scrubDue(s, 10000), false, 'segurando: nunca faz o seek');
  s = scrubRelease(s, 600, 100);
  assert.equal(s.target, 70, 'um toque curto: so 10 s');
  assert.equal(scrubDue(s, 100 + SCRUB_COMMIT_MS - 1), false);
  // outro toque antes do seek soma ao alvo
  s = scrubPress(s, 1, 60, 600, 300);
  s = scrubRelease(s, 600, 350);
  assert.equal(s.target, 80);
  s = scrubPress(s, -1, 60, 600, 500);
  s = scrubRelease(s, 600, 550);
  assert.equal(s.target, 70, 'voltar tambem soma');
  assert.equal(scrubDue(s, 550 + SCRUB_COMMIT_MS), true);
});

test('segurando acelera: 10 s por repeticao no comeco, depois 30 s, 1 min, 2 min', () => {
  let s = scrubPress(null, 1, 0, 100000, 0);
  const at = (ms) => (s = scrubHold(s, 100000, ms)).target;
  assert.equal(at(400), 10, 'antes da primeira repeticao');
  assert.equal(at(450), 20, 'primeira repeticao: +10');
  assert.equal(at(1350), 50, '+10 a cada 300 ms ate 1,5 s');
  const before = at(1600);
  assert.equal(before, 50, 'a repeticao de 1650 ms ainda nao chegou');
  assert.equal(at(1650) - before, 30, 'depois de 1,5 s: +30 s');
  const minute = at(3650);
  assert.equal(at(3950) - minute, 60, 'depois de 3,5 s: +1 min');
  const two = at(6050);
  assert.equal(at(6350) - two, 120, 'depois de 6 s: +2 min');
  s = scrubRelease(s, 100000, 6400);
  assert.equal(s.held, false);
  // voltar segurando para no comeco do video
  let back = scrubPress(null, -1, 30, 600, 0);
  back = scrubHold(back, 600, 5000);
  assert.equal(back.target, 0);
});

test('erro logo depois de um seek: reabre a MESMA qualidade (nao e "essa qualidade falhou")', () => {
  const a = newAttempts();
  noteSeek(a, 1000);
  assert.equal(errorPlan(a, 2000), 'reopen');
  assert.equal(errorPlan(a, 3000), 'reopen');
  // o seek novo zera a conta do seek
  noteSeek(a, 10000);
  assert.equal(errorPlan(a, 11000), 'reopen');
  assert.equal(errorPlan(a, 12000), 'reopen');
  // muitos seeks seguidos com erro nunca chegam a trocar de qualidade enquanto cada um tem a sua folga
  for (let i = 0; i < 20; i++) {
    noteSeek(a, 20000 + i * 5000);
    assert.equal(errorPlan(a, 20000 + i * 5000 + 100), 'reopen', `seek ${i}`);
  }
  assert.ok(SEEK_GRACE_MS >= 15000);
});

test('erro tocando: reabre duas vezes, depois links novos, so entao desce de qualidade', () => {
  const a = newAttempts();
  assert.equal(errorPlan(a, 0), 'reopen');
  assert.equal(errorPlan(a, 5000), 'reopen');
  assert.equal(errorPlan(a, 10000), 'fresh');
  assert.equal(errorPlan(a, 15000), 'lower', 'links novos ha pouco: agora sim a qualidade');
  // passado um minuto, volta a reabrir antes de qualquer outra coisa
  assert.equal(errorPlan(a, 80000), 'reopen');
  assert.equal(errorPlan(a, 81000), 'reopen');
  assert.equal(errorPlan(a, 82000), 'fresh', 'a reabertura ja foi usada; links novos de novo depois de FRESH_AFTER_MS');
  assert.ok(82000 - 10000 >= FRESH_AFTER_MS);
});

test('travada: reabre, reabre, links novos, e entao para com o motivo (nunca troca de formato)', () => {
  const a = newAttempts();
  assert.deepEqual([0, 30000, 60000, 90000].map((now) => stallPlan(a, now)), ['reopen', 'reopen', 'fresh', 'fail']);
  // travadas espalhadas (mais de 3 min entre elas) so reabrem
  const b = newAttempts();
  assert.deepEqual([0, 200000, 400000].map((now) => stallPlan(b, now)), ['reopen', 'reopen', 'reopen']);
});
