// pac1: o aviso de queda do console. O payload de fundo (bg_downloader.c) percebe ao subir que a sessao anterior NAO
// terminou limpa e grava last-crash.json (hora da ultima linha do diario, o que fazia: conversao de X / download de Y /
// nada, o ultimo marco da conversao e as ultimas linhas). A Jobe pergunta por GET /crash (background-downloads.js,
// setCrashSource) ao abrir e, se a queda for nova (o "id" dela nao e o visto, guardado em settings.json "crashSeen"),
// mostra um aviso unico (ui/CrashNotice.jsx): "O console desligou as HH:MM durante <atividade>", "Ver detalhes" (as
// linhas) e "OK" (marca como vista). Durante uma conversao, sugere as opcoes da conversao (Configuracoes > Downloads).

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  var ACTIVITIES = ["convert", "download", "none"];
  var source = null; // () => Promise<crash|null>
  var pending = null;
  var seenNow = ""; // a vista nesta abertura (vale mesmo se o settings.json nao gravar)
  var listeners = /* @__PURE__ */ new Set();
  function setCrashSource(next) {
    source = typeof next === "function" ? next : null;
  }
  const tell = () => {
    for (const listener of [...listeners]) listener(pending);
  };
  function crashSeen() {
    try {
      return String(loadList(SETTINGS, "settings")?.crashSeen ?? "");
    } catch {
      return "";
    }
  }
  /** A queda como o payload a deu, so com o que o aviso usa (null quando nao serve). */
  function normalizeCrash(crash) {
    if (!crash || typeof crash !== "object" || typeof crash.id !== "string" || !/^\d{1,20}$/.test(crash.id)) return null;
    const text = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
    return {
      id: crash.id,
      lastTime: text(crash.lastTime, 32),
      activity: ACTIVITIES.includes(crash.activity) ? crash.activity : "none",
      name: text(crash.name, 256),
      milestone: text(crash.milestone, 300),
      lines: (Array.isArray(crash.lines) ? crash.lines : []).filter((line) => typeof line === "string").slice(-20).map((line) => line.slice(0, 300))
    };
  }
  /** "HH:MM" da ultima linha do diario ("AAAA-MM-DD HH:MM:SS", o relogio do console), ou "". */
  var crashTime = (crash) => /^\d{4}-\d\d-\d\d (\d\d:\d\d)/.exec(crash?.lastTime ?? "")?.[1] ?? "";
  /**
   * Pergunta ao payload (ou a `fetch`) pela queda; uma nova (nao vista) fica pendente e o aviso abre. Devolve a
   * pendente, ou null. Nunca lanca.
   */
  /** glibren.60: sem nada rodando e sem sinal fatal = desligamento normal (sem aviso). */
  var quietShutdown = (crash) => crash?.activity === "none" && !(crash.lines ?? []).some((line) => / FATAL: /.test(line));
  async function checkCrash(fetch = source) {
    if (typeof fetch !== "function") return null;
    let crash = null;
    try {
      crash = normalizeCrash(await fetch());
    } catch {
      crash = null;
    }
    if (!crash || crash.id === seenNow || crash.id === crashSeen() || pending?.id === crash.id) return pending;
    // glibren.60: desligar o console com nada rodando (nem download nem conversao) tambem fica sem a marca de saida limpa
    // (o sistema mata o payload sem SIGTERM): nao e queda que interessa ao jogador. Avisa so com trabalho interrompido
    // ou com o payload morto por um sinal fatal (a linha "FATAL" no fim do diario). O last-crash.json segue no diagnostico.
    if (quietShutdown(crash)) {
      console.log(`jobeeslair: the console went down at ${crash.lastTime || "?"} with nothing running; no notice (a normal power off)`);
      seenNow = crash.id;
      return pending;
    }
    pending = crash;
    console.log(`jobeeslair: the console went down during ${crash.activity}${crash.name ? ` (${crash.name})` : ""} at ${crash.lastTime || "?"}; telling the player`);
    tell();
    return pending;
  }
  /** OK: a queda pendente fica vista (nao volta a avisar) e o aviso fecha. */
  function dismissCrash() {
    if (!pending) return;
    seenNow = pending.id;
    try {
      saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), crashSeen: pending.id });
    } catch (problem) {
      console.log(`jobeeslair: settings: crashSeen not saved (${problem?.message ?? problem})`);
    }
    pending = null;
    tell();
  }
  var pendingCrash = () => pending;
  function usePendingCrash() {
    const [now, setNow] = useState(pendingCrash);
    useEffect(() => {
      listeners.add(setNow);
      setNow(pending);
      return () => {
        listeners.delete(setNow);
      };
    }, []);
    return now;
  }
  // So para os testes.
  function resetCrashNotice() {
    pending = null;
    source = null;
    seenNow = "";
    tell();
  }

export { checkCrash, crashTime, dismissCrash, normalizeCrash, pendingCrash, quietShutdown, resetCrashNotice, setCrashSource, usePendingCrash };
