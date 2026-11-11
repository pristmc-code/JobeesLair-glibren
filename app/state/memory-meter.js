// glibren (medidor de memoria): quanto do heap do JavaScript o app usa, e em que tela ou acao. O heap do motor
// (QuickJS do ps5-react) tem um limite fixo (DeviceInfo.memory().heapLimit) e, quando estoura, o app fecha; este
// medidor mostra onde a memoria vai antes de mexer na loja e na Biblioteca TorBox.
// Uma amostra le so contadores do host (DeviceInfo.memory(), sem percorrer o heap): troca de tela (state/nav.jsx),
// fim de carregar os feeds e a lista Orbit, Biblioteca TorBox (ler, montar, gravar), Descobrir formatos, Procurar no
// TorBox, abrir o YouTube, e a cada 30 s com a tela da vez. Guarda so o pico global, o pico de cada tela/acao (as que
// mais usaram; no maximo KEEP nomes) e a ultima amostra: nada de historico.
// No jobeeslair.log: uma linha quando o pico passa de mais um degrau (1 MB) e um aviso quando o uso passa de 85% do
// limite ("memoria: 27,3 de 32 MB em <acao>"), uma vez ate o uso voltar abaixo de 80%.
// Num host sem DeviceInfo.memory (ps5-react antigo, testes) nada e medido e a tela diz que nao ha medida.

import { DeviceInfo } from '@ps5-react/core';
import { log } from '../services/logger.js';

  var MB = 1024 * 1024;
  var STEP = MB;
  var WARN_AT = 0.85;
  var REARM_AT = 0.8;
  var TOP = 10;
  var KEEP = 40;
  var TICK_MS = 3e4;
  /** "27,3": megabytes com uma casa e virgula (o log e lido em portugues). */
  var mb = (bytes) => (bytes / MB).toFixed(1).replace(".", ",");
  /**
   * Um medidor. `read()` devolve {heapUsed, heapLimit, processUsed?, processSize?} ou null; `write(line, level)`
   * vai ao log. Para os testes: `step`, `warnAt`, `top`, `keep` e `now`.
   */
  function createMemoryMeter({ read, write = () => {}, step = STEP, warnAt = WARN_AT, rearmAt = REARM_AT, top = TOP, keep = KEEP, now = Date.now } = {}) {
    let last = null;
    let peak = null;
    let loggedLevel = 0;
    let warned = false;
    let context = "inicio";
    const byAction = /* @__PURE__ */ new Map();
    const listeners = /* @__PURE__ */ new Set();
    // Mais nomes que `keep`: sai o de menor pico (nunca o da amostra de agora).
    const trim = (keepName) => {
      while (byAction.size > keep) {
        let smallest = null;
        for (const [name, used] of byAction) if (name !== keepName && (smallest === null || used < byAction.get(smallest))) smallest = name;
        if (smallest === null) return;
        byAction.delete(smallest);
      }
    };
    const processText = (reading) => {
      if (reading?.processUsed == null || !reading.processSize) return "";
      return ` (processo ${mb(reading.processUsed)} de ${mb(reading.processSize)} MB)`;
    };
    function sample(action = context) {
      let reading = null;
      try {
        reading = read();
      } catch {
        reading = null;
      }
      const used = Number(reading?.heapUsed);
      if (!reading || !Number.isFinite(used) || used < 0) return null;
      const limit = Number(reading.heapLimit) > 0 ? Number(reading.heapLimit) : 0;
      const name = String(action || context);
      last = { used, limit, action: name, at: now(), processUsed: reading.processUsed ?? null, processSize: reading.processSize ?? null };
      if (used > (byAction.get(name) ?? -1)) {
        byAction.set(name, used);
        trim(name);
      }
      if (!peak || used > peak.used) {
        peak = { used, limit, action: name, at: last.at };
        const level = Math.floor(used / step);
        if (level > loggedLevel) {
          loggedLevel = level;
          write(`memoria: pico ${mb(used)}${limit ? ` de ${mb(limit)}` : ""} MB em ${name}${processText(reading)}`);
        }
      }
      if (limit && used >= limit * warnAt) {
        if (!warned) {
          warned = true;
          write(`memoria: ${mb(used)} de ${mb(limit)} MB em ${name} (acima de ${Math.round(warnAt * 100)}% do limite)${processText(reading)}`, "WARN");
        }
      } else if (limit && used < limit * rearmAt) warned = false;
      for (const listener of listeners) listener();
      return last;
    }
    return {
      sample,
      /** A tela da vez: o nome das amostras sem acao (a de 30 s). Nao mede. */
      setContext(name) {
        if (name) context = String(name);
      },
      get context() {
        return context;
      },
      /** O que a tela mostra: a ultima amostra, o pico e as `top` telas/acoes de maior pico, da maior para a menor. */
      snapshot() {
        const ranked = [...byAction].sort((a, b) => b[1] - a[1]).slice(0, top).map(([action, used]) => ({ action, used }));
        return { last, peak, top: ranked };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
  }
  var meter = createMemoryMeter({
    read: () => typeof DeviceInfo.memory === "function" ? DeviceInfo.memory() : null,
    write: (line, level) => {
      try {
        log("memory", line, level);
      } catch {
      }
    }
  });
  /** Uma amostra com o nome da acao (sem nome: a tela da vez). Barata; nunca lanca. */
  function memorySample(action) {
    try {
      return meter.sample(action);
    } catch {
      return null;
    }
  }
  /** A troca de tela: passa a ser o nome das amostras sem acao, e mede. */
  function memoryScreen(name) {
    meter.setContext(`tela:${name}`);
    return memorySample();
  }
  var memorySnapshot = () => meter.snapshot();
  var subscribeMemory = (listener) => meter.subscribe(listener);
  var ticking = null;
  /** A amostra de 30 s (uma vez por execucao; index.jsx). Devolve o que a desliga. */
  function startMemoryMeter(every = TICK_MS) {
    if (ticking) return () => {};
    memorySample();
    ticking = setInterval(() => memorySample(), every);
    return () => {
      clearInterval(ticking);
      ticking = null;
    };
  }

export { MB, createMemoryMeter, memorySample, memoryScreen, memorySnapshot, startMemoryMeter, subscribeMemory };
