// glibren.44: "Instalar atualizacoes automaticamente" tambem REINICIA sozinha. Antes a versao nova baixada e conferida so
// entrava quando a Jobee'sLair fechava; agora, com o automatico ligado e a atualizacao pronta, o app reinicia para
// aplicar (state/update.js restartToApply) quando e seguro:
//   - a Jobee'sLair esta em primeiro plano (o payload le o foco no kern.msgbuf, GET /focus; sem resposta, o app conta
//     que, fora do primeiro plano, o PS5 congela o processo e nada roda);
//   - nada tocando (o player do YouTube), nenhuma conversao (do app ou do payload), extracao, instalacao ou mover;
//   - nenhum dialogo aberto e nenhum botao apertado ha IDLE_MS (60 s).
// Antes, um aviso de COUNTDOWN_MS (10 s): "Atualizando para X em N s — (O) para adiar"; (O) adia POSTPONE_MS, qualquer
// outro botao cancela (o jogador voltou a usar: a regra vale de novo depois de mais 60 s parado). Se a Jobee'sLair nao
// esta em primeiro plano, nada reabre por cima de outro app: fica para quando ele voltar (a mesma regra) ou para o
// proximo fechar/abrir (o updater.elf aplica ao fechar, como antes). Os downloads do payload seguem durante o reinicio.

import { useEffect, useState } from 'react';
import { dialogOpen, idleFor, mediaPlaying, onPress, startActivity } from './activity.js';

  var IDLE_MS = 6e4;
  var COUNTDOWN_MS = 1e4;
  var POSTPONE_MS = 30 * 6e4;
  var TICK_MS = 5e3;
  /**
   * Por que nao reiniciar agora ("" = pode). `inputs`: { automatic, phase, version, foreground (true/false/null:
   * nao sabido), media, converting, busy, dialog, idleMs }.
   */
  function restartBlocker(inputs, idleNeeded = IDLE_MS) {
    if (!inputs?.automatic) return "off";
    if (!["ready", "armed"].includes(inputs.phase) || !inputs.version) return "not-ready";
    if (inputs.foreground === false) return "background";
    if (inputs.media) return "playing";
    if (inputs.converting) return "converting";
    if (inputs.busy) return "busy";
    if (inputs.dialog) return "dialog";
    if (!(inputs.idleMs >= idleNeeded)) return "in-use";
    return "";
  }
  /**
   * O vigia. `read()` -> os inputs de restartBlocker (pode ser async); `restart()` -> "" ou o motivo de nao ter
   * reiniciado (state/update.js restartToApply); `log(linha)`.
   */
  function createAutoRestart({ read, restart, log = () => {}, now = Date.now, idleNeeded = IDLE_MS, countdownMs = COUNTDOWN_MS, postponeMs = POSTPONE_MS, subscribePress = onPress }) {
    let state = { phase: "idle", version: null, endsAt: 0, postponedUntil: 0, reason: "" };
    const listeners = /* @__PURE__ */ new Set();
    const set = (next) => {
      state = { ...state, ...next };
      for (const listener of [...listeners]) listener(state);
    };
    let stopPress = null;
    let ticking = false;
    const endCountdown = () => {
      stopPress?.();
      stopPress = null;
    };
    function postpone() {
      if (state.phase !== "countdown") return false;
      endCountdown();
      log(`auto restart: postponed ${Math.round(postponeMs / 6e4)} min (Circle)`);
      set({ phase: "idle", endsAt: 0, postponedUntil: now() + postponeMs, reason: "postponed" });
      return true;
    }
    function cancel(reason) {
      if (state.phase !== "countdown") return;
      endCountdown();
      log(`auto restart: cancelled (${reason})`);
      set({ phase: "idle", endsAt: 0, reason });
    }
    /** Uma volta do vigia (a cada TICK_MS): comeca a contagem, cancela ou reinicia. */
    async function tick() {
      if (ticking) return state;
      ticking = true;
      try {
        let inputs = null;
        try {
          inputs = await read();
        } catch (error) {
          log(`auto restart: not read: ${error?.message ?? error}`);
          return state;
        }
        if (state.phase === "countdown") {
          // Durante a contagem os botoes ja cancelam (onPress); aqui, o resto (um video, uma conversao, outro app).
          const blocker = restartBlocker({ ...inputs, idleMs: Infinity }, idleNeeded);
          if (blocker) {
            cancel(blocker);
            return state;
          }
          if (now() < state.endsAt) return state;
          endCountdown();
          set({ phase: "restarting" });
          log(`auto restart: restarting to apply ${state.version}`);
          const reason = restart();
          if (reason) {
            log(`auto restart: not restarted (${reason})`);
            set({ phase: "idle", endsAt: 0, reason, postponedUntil: now() + idleNeeded });
          }
          return state;
        }
        if (state.phase !== "idle" || now() < state.postponedUntil) return state;
        const blocker = restartBlocker(inputs, idleNeeded);
        if (blocker) {
          if (blocker !== state.reason) set({ reason: blocker });
          return state;
        }
        log(`auto restart: ${inputs.version} ready and the app idle ${Math.round(inputs.idleMs / 1e3)} s; restarting in ${countdownMs / 1e3} s`);
        stopPress = subscribePress((event) => {
          // O (e o X no "Adiar", que esta focado) adiam; qualquer outro botao cancela (o jogador voltou a usar).
          if (event?.button === "circle" || event?.button === "cross") postpone();
          else cancel("input");
        });
        set({ phase: "countdown", version: inputs.version, endsAt: now() + countdownMs, reason: "" });
        return state;
      } finally {
        ticking = false;
      }
    }
    return {
      tick,
      postpone,
      state: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
  }

  // ---- O do app ----
  var shared = null;
  var timer = null;
  /** Liga o vigia do app (index.jsx, junto das verificacoes de atualizacao). `deps`: o que ele le (state/update.js). */
  function startAutoRestart(deps) {
    if (shared || !deps) return shared;
    startActivity();
    shared = createAutoRestart({
      read: async () => {
        const snap = deps.snapshot();
        const foreground = await deps.foreground().catch(() => null);
        return {
          automatic: snap.auto,
          phase: snap.install.phase,
          version: snap.install.version,
          foreground,
          media: mediaPlaying(),
          converting: deps.converting(),
          busy: Boolean(deps.busy()),
          dialog: dialogOpen() || deps.dialog(),
          idleMs: idleFor()
        };
      },
      restart: deps.restart,
      log: (line) => console.log(`jobeeslair: ${line}`)
    });
    // Rapido durante a contagem (o aviso conta os segundos); a cada TICK_MS fora dela.
    const loop = () => {
      void shared.tick().finally(() => {
        timer = setTimeout(loop, shared.state().phase === "countdown" ? 1e3 : TICK_MS);
      });
    };
    timer = setTimeout(loop, TICK_MS);
    return shared;
  }
  var autoRestart = () => shared;
  /** O estado do vigia para o aviso ({ phase, version, endsAt }). */
  function useAutoRestart() {
    const [value, setValue] = useState(() => shared?.state() ?? null);
    useEffect(() => shared?.subscribe(setValue) ?? void 0, []);
    return value;
  }

export { COUNTDOWN_MS, IDLE_MS, POSTPONE_MS, autoRestart, createAutoRestart, restartBlocker, startAutoRestart, useAutoRestart };
