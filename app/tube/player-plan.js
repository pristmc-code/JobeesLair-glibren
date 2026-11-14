// glibren.59: as regras do player do YouTube que nao dependem da tela (testadas em tests/tube-player-plan.test.mjs).
//   - Navegacao progressiva (pedido 14/11/2026): toque = 10 s; segurar acelera (10 s -> 30 s -> 1 min -> 2 min), o
//     alvo aparece na barra e o player faz UM seek so, um pouco depois de soltar (toques seguidos somam).
//   - O que fazer num erro do player (errorPlan): seek, travada e erro do decodificador NAO sao falha da qualidade.
//     Antes (glibren.55-.58) o seek no PS5 dava "video decode failed", o player gastava os links novos e depois descia
//     de qualidade a cada erro ("Essa qualidade falhou"), ate cair no VP9+AAC, que pisca. Agora: reabre a MESMA
//     qualidade na mesma posicao (decodificador novo); depois links novos; so depois desce, e so no mesmo formato.
//   - Travada (stallPlan): sem andar por STALL_MS tocando = reabre na mesma qualidade; repetida, links novos; depois
//     para com a mensagem (nunca troca de formato sozinho).

/** Passo de um toque, em segundos. */
export const SCRUB_TAP = 10;
/** Depois de soltar, espera isto por outro toque antes do seek (toques seguidos somam num seek so). */
export const SCRUB_COMMIT_MS = 650;
/** Segurando: a primeira repeticao e a cada quanto repete. */
export const SCRUB_REPEAT_FIRST_MS = 450;
export const SCRUB_REPEAT_MS = 300;

/** O passo de cada repeticao conforme o tempo segurado: 10 s, 30 s, 1 min, 2 min, 5 min. */
export function scrubStep(heldMs) {
  if (heldMs < 1500) return 10;
  if (heldMs < 3500) return 30;
  if (heldMs < 6000) return 60;
  if (heldMs < 10000) return 120;
  return 300;
}

/** O alvo dentro do video: de 0 ate 1 s antes do fim (sem duracao conhecida, sem teto). */
export function clampTarget(seconds, duration) {
  const top = duration > 1 ? duration - 1 : Infinity;
  return Math.max(0, Math.min(top, seconds));
}

/**
 * Um botao de navegacao apertado (`dir` -1 volta, +1 avanca). `scrub`: o de antes ainda nao aplicado (null: comeca da
 * posicao). Devolve o novo estado: { dir, target, pressedAt, repeats, held, commitAt }.
 */
export function scrubPress(scrub, dir, position, duration, now) {
  const base = scrub ? scrub.target : position;
  return { dir, target: clampTarget(base + dir * SCRUB_TAP, duration), pressedAt: now, repeats: 0, held: true, commitAt: 0 };
}

/** Segurando: soma as repeticoes que venceram ate `now` (cada uma com o passo do tempo segurado nela). */
export function scrubHold(scrub, duration, now) {
  if (!scrub?.held) return scrub;
  const heldMs = now - scrub.pressedAt;
  let { target, repeats } = scrub;
  for (;;) {
    const due = SCRUB_REPEAT_FIRST_MS + repeats * SCRUB_REPEAT_MS;
    if (due > heldMs) break;
    target = clampTarget(target + scrub.dir * scrubStep(due), duration);
    repeats += 1;
  }
  return repeats === scrub.repeats ? scrub : { ...scrub, target, repeats };
}

/** Soltou: o seek fica para SCRUB_COMMIT_MS depois (outro toque antes disso soma). */
export function scrubRelease(scrub, duration, now) {
  if (!scrub) return scrub;
  const held = scrubHold(scrub, duration, now);
  return { ...held, held: false, commitAt: now + SCRUB_COMMIT_MS };
}

/** Hora de aplicar o seek (um so). */
export function scrubDue(scrub, now) {
  return Boolean(scrub && !scrub.held && scrub.commitAt && now >= scrub.commitAt);
}

/** Um erro logo depois de um seek (ou de reabrir por causa dele) e do seek, nao da qualidade. */
export const SEEK_GRACE_MS = 20000;
export const SEEK_REOPENS = 2;
/** Reaberturas na mesma qualidade por janela (decodificador novo na mesma posicao). */
export const REOPEN_WINDOW_MS = 60000;
export const REOPENS_PER_WINDOW = 2;
/** Links novos: a primeira vez sempre; depois so FRESH_AFTER_MS depois da anterior, ate FRESH_MAX por video. */
export const FRESH_AFTER_MS = 60000;
export const FRESH_MAX = 8;

/** O estado das tentativas de um video (vive em live.current do player). */
export function newAttempts() {
  return { seekAt: 0, seekReopens: 0, reopens: [], freshCount: 0, freshAt: 0, stalls: [] };
}

/** Um seek feito pelo jogador (ou pelo SponsorBlock): erros nos proximos SEEK_GRACE_MS sao dele. */
export function noteSeek(attempts, now) {
  attempts.seekAt = now;
  attempts.seekReopens = 0;
}

/**
 * O que fazer com um erro do player: "reopen" (a mesma qualidade na mesma posicao, decodificador novo), "fresh"
 * (links novos, mesma qualidade) ou "lower" (a qualidade abaixo; fallbackChoice decide qual, ou falha). Muda
 * `attempts` (conta o que decidiu).
 */
export function errorPlan(attempts, now) {
  if (attempts.seekAt && now - attempts.seekAt < SEEK_GRACE_MS && attempts.seekReopens < SEEK_REOPENS) {
    attempts.seekReopens += 1;
    return "reopen";
  }
  attempts.reopens = attempts.reopens.filter((at) => now - at < REOPEN_WINDOW_MS);
  if (attempts.reopens.length < REOPENS_PER_WINDOW) {
    attempts.reopens.push(now);
    return "reopen";
  }
  if (attempts.freshCount === 0 || attempts.freshCount < FRESH_MAX && now - attempts.freshAt >= FRESH_AFTER_MS) {
    attempts.freshCount += 1;
    attempts.freshAt = now;
    return "fresh";
  }
  return "lower";
}

/** Sem andar por isto tocando (nao pausado, sem seek pendente) = travou. Sem o primeiro quadro por OPEN_MS = nao abriu. */
export const STALL_MS = 20000;
export const OPEN_MS = 45000;
export const STALL_WINDOW_MS = 180000;

/**
 * Uma travada: "reopen" (as duas primeiras na janela), "fresh" (a terceira, se ainda pode) ou "fail" (para e diz o
 * motivo). Nunca troca de qualidade/formato.
 */
export function stallPlan(attempts, now) {
  attempts.stalls = attempts.stalls.filter((at) => now - at < STALL_WINDOW_MS);
  attempts.stalls.push(now);
  if (attempts.stalls.length <= 2) return "reopen";
  if (attempts.stalls.length === 3 && attempts.freshCount < FRESH_MAX) {
    attempts.freshCount += 1;
    attempts.freshAt = now;
    return "fresh";
  }
  return "fail";
}
