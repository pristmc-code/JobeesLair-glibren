// glibren.45: menos trabalho de desenho quando ninguem esta usando a Jobee'sLair (a ventoinha do PS5 acelerava com ela
// aberta e parada). O app desenha na CPU (ps5-react): cada quadro que muda algo e rasterizado e enviado a tela, e um
// quadro que nao muda nada nao custa quase nada. Duas coisas aqui:
//   - "em repouso": REST_MS (15 s) sem nenhum botao do controle (state/activity.js). Vale sempre. A faixa de recados para
//     de trocar, o destaque da loja para de passar sozinho e os numeros ao vivo de Downloads passam a ser redesenhados
//     a cada REST_REDRAW_MS (5 s), sem animacao. Qualquer botao volta ao normal na hora.
//   - "Economizar energia" (Configuracoes > Aparencia; settings.json `energySaver`, desligado por padrao): o tempo todo,
//     animacoes curtas (o "light motion" do ps5-react, o mesmo do PS4: no maximo 160 ms, sem os movimentos longos), os
//     graficos parados, as capas em resolucao menor (data/catalog-index.js, na proxima abertura) e as telas ao vivo
//     redesenhadas a cada SAVER_REDRAW_MS (2 s).
// Nada aqui faz polling: um temporizador so, remarcado a cada botao.

import { useEffect, useState } from 'react';
import * as core from '@ps5-react/core';
import { loadList, saveList } from './saved.js';
import { idleFor, onPress, startActivity } from './activity.js';
import { PS4 } from './ps4.js';

  var REST_MS = 15e3;
  var REST_REDRAW_MS = 5e3;
  var SAVER_REDRAW_MS = 2e3;
  var SETTINGS = "settings.json";
  var saver = null;
  var resting = false;
  var listeners = /* @__PURE__ */ new Set();
  var timer = null;
  var stopPress = null;
  var timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };
  var clock = () => Date.now();
  /** Se "Economizar energia" esta ligado (lido de settings.json uma vez). */
  function energySaverOn() {
    if (saver === null) {
      try {
        saver = loadList(SETTINGS, "settings").energySaver === true;
      } catch {
        saver = false;
      }
    }
    return saver;
  }
  // O PS4 ja anda com o light motion (ui/light-motion.js); aqui so liga a mais.
  var applyMotion = () => {
    try {
      core.setLightMotion?.(PS4 || energySaverOn());
    } catch {
    }
  };
  function notify() {
    const now = { resting, saver: energySaverOn() };
    for (const listener of [...listeners]) {
      try {
        listener(now);
      } catch {
      }
    }
  }
  function setEnergySaver(on) {
    saver = Boolean(on);
    try {
      saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), energySaver: saver });
    } catch (error) {
      console.log(`[power] energy saver not saved: ${error?.message || error}`);
    }
    applyMotion();
    console.log(`[power] energy saver ${saver ? "on" : "off"}`);
    notify();
  }
  function setResting(next) {
    if (next === resting) return;
    resting = next;
    notify();
  }
  // Marca a proxima conferida para quando os REST_MS sem botao se completarem.
  function schedule() {
    if (timer !== null) timers.clear(timer);
    timer = null;
    const left = REST_MS - idleFor(clock());
    if (left <= 0) {
      setResting(true);
      return;
    }
    timer = timers.set(() => {
      timer = null;
      schedule();
    }, left);
  }
  /**
   * Comeca a seguir o controle (index.jsx, uma vez). Os testes passam `controller`, `now` e os temporizadores. -> quem
   * para.
   */
  function startPower({ controller, now, set, clear } = {}) {
    stopPower();
    if (set && clear) timers = { set, clear };
    if (now) clock = now;
    startActivity({ ...controller ? { controller } : {}, ...now ? { now } : {} });
    stopPress = onPress(() => {
      setResting(false);
      schedule();
    });
    schedule();
    return stopPower;
  }
  function stopPower() {
    if (timer !== null) timers.clear(timer);
    timer = null;
    stopPress?.();
    stopPress = null;
    resting = false;
  }
  /** Se o app esta em repouso (REST_MS sem botao). */
  var isResting = () => resting;
  /** Repouso ou "Economizar energia": as animacoes continuas param. */
  var isQuiet = () => resting || energySaverOn();
  /**
   * De quanto em quanto tempo uma tela ao vivo se redesenha: `normal` (ms) em uso, REST_REDRAW_MS em repouso e no maximo
   * SAVER_REDRAW_MS com "Economizar energia".
   */
  function redrawEvery(normal) {
    if (resting) return Math.max(normal, REST_REDRAW_MS);
    if (energySaverOn()) return Math.max(normal, SAVER_REDRAW_MS);
    return normal;
  }
  /** `listener({ resting, saver })` a cada mudanca; devolve quem para. */
  function onPowerChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  /**
   * Um valor ao vivo entregue a `apply` (o setState de uma tela) no maximo a cada redrawEvery(`normal`) ms: o ultimo vale,
   * os do meio sao pulados. Saindo do repouso, o que esperava sai na hora. -> { feed(valor), stop() }.
   */
  function paced(apply, normal = 0) {
    let latest, pending = false, drawnAt = 0, wait = null;
    const draw = () => {
      wait = null;
      if (!pending) return;
      pending = false;
      drawnAt = clock();
      apply(latest);
    };
    const feed = (value) => {
      latest = value;
      pending = true;
      if (wait !== null) return;
      const left = Math.max(0, redrawEvery(normal) - (clock() - drawnAt));
      if (left === 0) draw();
      else wait = timers.set(draw, left);
    };
    const stopWatch = onPowerChange((now) => {
      if (now.resting || wait === null) return;
      timers.clear(wait);
      draw();
    });
    const stop = () => {
      if (wait !== null) timers.clear(wait);
      wait = null;
      pending = false;
      stopWatch();
    };
    return { feed, stop };
  }
  /** { resting, saver, quiet } no componente, redesenhado quando muda. */
  function usePower() {
    const [now, setNow] = useState(() => ({ resting, saver: energySaverOn() }));
    useEffect(() => {
      setNow({ resting, saver: energySaverOn() });
      return onPowerChange(setNow);
    }, []);
    return { ...now, quiet: now.resting || now.saver };
  }
  /** Para os testes: tudo como no comeco (com `saverValue`, sem ler o settings.json). */
  function resetPower(saverValue = null) {
    stopPower();
    saver = saverValue;
    listeners.clear();
    timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };
    clock = () => Date.now();
  }

export { REST_MS, REST_REDRAW_MS, SAVER_REDRAW_MS, energySaverOn, isQuiet, isResting, onPowerChange, paced, redrawEvery, resetPower, setEnergySaver, startPower, stopPower, usePower };
