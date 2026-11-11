// glibren.16: as conversoes para .exfat que o payload bg-downloader faz (GET /convert em 127.0.0.1:34200), para a tela
// de Downloads do PS5.
//
// As que a fila do app pediu (job "converting", download-queue.js queueConversion) ja aparecem no cartao do proprio
// download. Aqui ficam as que o payload faz e a fila nao conhece: comecaram com o app fechado, sao de um item que saiu
// da fila, ou de uma fila que se perdeu. Elas aparecem como cartoes proprios (DownloadCard.jsx ConversionCard), com
// velocidade e tempo restante calculados entre duas leituras, e podem ser canceladas (POST /convert/<id>/cancel) ou,
// depois de terminar, tiradas da lista (POST /convert/<id>/forget). As que terminaram ficam visiveis por 24 h.
//
// Quem pergunta ao payload e o background-downloads.js (setConversionSource, com o token dele); sem o payload no ar,
// a lista fica como estava (vazia). A tela le a lista enquanto esta aberta, a cada 2 s (usePayloadConversions).

import { useEffect, useState } from 'react';

  // glibren.22: "extracting" (o payload descompacta antes de converter, glibren.20) tambem esta em andamento.
  var ACTIVE_CONVERSION = ["queued", "extracting", "converting", "verifying"];
  var RECENT_SECONDS = 24 * 3600;
  var source = null; // { list(): Promise<array|null>, cancel(id), forget(id) }
  var latest = [];
  var samples = /* @__PURE__ */ new Map(); // id -> { written, at, bps }
  var listeners = /* @__PURE__ */ new Set();
  function setConversionSource(next) {
    source = next ?? null;
  }
  /** As conversoes como o payload as deu (GET /convert), com a velocidade de cada uma; avisa quem ouve. */
  function noteConversions(list, now = Date.now()) {
    const seen = /* @__PURE__ */ new Set();
    latest = (Array.isArray(list) ? list : []).filter((item) => item && typeof item.id === "string" && item.id).map((item) => {
      const written = Number(item.written) || 0, total = Number(item.total) || 0;
      const state = String(item.state || "");
      const before = samples.get(item.id);
      let bps = state === "converting" ? before?.bps || 0 : 0;
      let sample = before && written >= before.written ? before : { written, at: now, bps: 0 };
      if (state === "converting" && before && written > before.written && now > before.at) {
        const rate = (written - before.written) / ((now - before.at) / 1e3);
        bps = bps ? bps * 0.6 + rate * 0.4 : rate;
        sample = { written, at: now, bps };
      }
      samples.set(item.id, { ...sample, bps });
      seen.add(item.id);
      return {
        id: item.id,
        key: String(item.key || ""),
        name: String(item.name || ""),
        state,
        error: String(item.error || ""),
        output: String(item.output || ""),
        label: String(item.label || ""),
        written,
        total,
        updated: Number(item.updated) || 0,
        bytesPerSecond: bps
      };
    });
    for (const id of [...samples.keys()]) if (!seen.has(id)) samples.delete(id);
    for (const listener of [...listeners]) listener(latest);
    return latest;
  }
  var payloadConversions = () => latest;
  /** Le de novo o payload (sem ele, ou com erro, fica a ultima lista). */
  async function refreshConversions() {
    if (!source?.list) return latest;
    let list = null;
    try {
      list = await source.list();
    } catch {
      list = null;
    }
    return list ? noteConversions(list) : latest;
  }
  async function cancelPayloadConversion(id) {
    try {
      await source?.cancel?.(id);
    } finally {
      await refreshConversions();
    }
  }
  async function forgetPayloadConversion(id) {
    try {
      await source?.forget?.(id);
    } finally {
      latest = latest.filter((item) => item.id !== id);
      for (const listener of [...listeners]) listener(latest);
    }
  }
  /** A lista, lida a cada `ms` enquanto o componente esta na tela. */
  function usePayloadConversions(ms = 2e3) {
    const [list, setList] = useState(payloadConversions);
    useEffect(() => {
      listeners.add(setList);
      void refreshConversions();
      const timer = setInterval(() => void refreshConversions(), ms);
      return () => {
        listeners.delete(setList);
        clearInterval(timer);
      };
    }, [ms]);
    return list;
  }
  var conversionActive = (item) => ACTIVE_CONVERSION.includes(item.state);

  // ---- pac1: a pausa entre conversoes (Configuracoes > Downloads; o payload espera antes da proxima) ----
  // O payload diz no GET /convert quantos segundos faltam ("waitSeconds", 0 = nada esperando); a tela de Downloads
  // mostra "Pausa entre conversoes: a proxima comeca em 1:45", contando ate a proxima leitura.
  var waitUntil = 0; // Date.now() em que a proxima comeca; 0 = nenhuma espera
  var waitListeners = /* @__PURE__ */ new Set();
  function noteConversionWait(seconds, now = Date.now()) {
    const next = Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? now + Number(seconds) * 1e3 : 0;
    if (next === waitUntil) return;
    waitUntil = next;
    for (const listener of [...waitListeners]) listener(waitUntil);
  }
  /** Segundos que faltam para a proxima conversao comecar (0 = nenhuma espera). */
  var conversionWaitSeconds = (now = Date.now()) => waitUntil > now ? Math.ceil((waitUntil - now) / 1e3) : 0;
  /** "m:ss" de uma espera em segundos. */
  var waitClock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  /** Os segundos de espera, redesenhados a cada segundo enquanto houver espera. */
  function useConversionWait() {
    const [seconds, setSeconds] = useState(() => conversionWaitSeconds());
    useEffect(() => {
      const update = () => setSeconds(conversionWaitSeconds());
      waitListeners.add(update);
      const timer = setInterval(update, 1e3);
      return () => {
        waitListeners.delete(update);
        clearInterval(timer);
      };
    }, []);
    return seconds;
  }
  /**
   * Das conversoes do payload, as que a fila nao conhece: nem pela chave (o id do item da fila) nem pelo .exfat que
   * gravam. Canceladas nunca; terminadas (pronta ou erro) so nas ultimas 24 h, e uma pronta so se o .exfat ainda esta
   * no disco (`exists`), para um jogo apagado nao voltar como "Pronto".
   */
  function outsideQueue(list, jobs, { exists = () => true, now = Date.now() } = {}) {
    const ids = new Set(jobs.map((job) => job.id));
    const paths = new Set(jobs.flatMap((job) => [job.convert?.output, job.artifact?.destination]).filter(Boolean));
    const nowSeconds = now / 1e3;
    return list.filter((item) => {
      if (item.state === "cancelled" || ids.has(item.key) || item.output && paths.has(item.output)) return false;
      if (conversionActive(item)) return true;
      if (!item.updated || nowSeconds - item.updated > RECENT_SECONDS) return false;
      if (item.state === "done") {
        try {
          return Boolean(item.output) && exists(item.output);
        } catch {
          return false;
        }
      }
      return item.state === "failed";
    });
  }

  // ---- glibren.22: a pasta BACKUP, para a tela Pasta BACKUP da aba Downloads (downloads/BackupSheet.jsx) ----
  // O que antes so a pagina do celular fazia: ver o que ficou em <disco>/BACKUP, converter um ou todos para .exfat,
  // apagar um item e ler o diario do payload. Quem pergunta e o background-downloads.js (setBackupSource).
  var backupSource = null; // { list(), convert(root, name), convertAll(), remove(root, name), log() }
  var backupLatest = null; // { games, totalBytes } ou null (sem payload)
  var backupRead = false; // ja perguntou alguma vez (antes disso a tela diz "Lendo...")
  var backupListeners = /* @__PURE__ */ new Set();
  function setBackupSource(next) {
    backupSource = next ?? null;
  }
  const tellBackup = () => {
    for (const listener of [...backupListeners]) listener(backupLatest);
  };
  /** A pasta como o payload a deu (GET /backup), ou null sem ele; avisa quem ouve. */
  function noteBackup(data) {
    backupRead = true;
    backupLatest = data && Array.isArray(data.games) ? { games: data.games.filter((item) => item && typeof item.name === "string" && typeof item.root === "string"), totalBytes: Number(data.totalBytes) || 0 } : null;
    tellBackup();
    return backupLatest;
  }
  /** Le a pasta de novo pelo payload; null sem ele. */
  async function refreshBackup() {
    if (!backupSource?.list) return noteBackup(null);
    let data = null;
    try {
      data = await backupSource.list();
    } catch {
      data = null;
    }
    return noteBackup(data);
  }
  // O erro de uma acao, como o payload o deu ({ error }), ou "" quando deu certo.
  const failureOf = (answer) => answer?.status === 200 ? "" : String(answer?.data?.error || (answer?.status ? `HTTP ${answer.status}` : "no payload"));
  async function backupAction(run) {
    let answer = null;
    try {
      answer = await run();
    } catch (error) {
      answer = { status: 0, data: { error: error?.message ?? String(error) } };
    }
    void refreshBackup();
    void refreshConversions();
    return { ok: answer?.status === 200, error: failureOf(answer), data: answer?.data ?? {} };
  }
  var convertBackup = (item) => backupAction(() => backupSource.convert(item.root, item.name));
  var convertAllBackup = () => backupAction(() => backupSource.convertAll());
  var deleteBackup = (item) => backupAction(() => backupSource.remove(item.root, item.name));
  async function payloadLog() {
    try {
      return await backupSource?.log?.() ?? null;
    } catch {
      return null;
    }
  }
  /** A pasta BACKUP, lida a cada `ms` enquanto o componente esta na tela: undefined = lendo; null = sem payload. */
  function useBackup(ms = 3e3) {
    const [data, setData] = useState(() => backupRead ? backupLatest : void 0);
    useEffect(() => {
      backupListeners.add(setData);
      void refreshBackup();
      const timer = setInterval(() => void refreshBackup(), ms);
      return () => {
        backupListeners.delete(setData);
        clearInterval(timer);
      };
    }, [ms]);
    return data;
  }
  /**
   * O que dizer de um item do BACKUP: "converted" (o .exfat existe), "ps4", "queued"/"extracting"/"converting"/
   * "verifying" (a conversao dele), "failed" (com o erro) ou "idle" (nada feito ainda).
   */
  function backupStatus(item) {
    const conversion = item?.conversion;
    if (conversion && ACTIVE_CONVERSION.includes(conversion.state)) return { state: conversion.state, written: Number(conversion.written) || 0, total: Number(conversion.total) || 0 };
    if (item?.converted) return { state: "converted", file: item.converted };
    if (item?.platform === "ps4") return { state: "ps4" };
    if (conversion?.state === "failed") return { state: "failed", error: String(conversion.error || "") };
    return { state: "idle" };
  }

export { conversionWaitSeconds, noteConversionWait, useConversionWait, waitClock, backupStatus, convertAllBackup, convertBackup, deleteBackup, noteBackup, payloadLog, refreshBackup, setBackupSource, useBackup, cancelPayloadConversion, conversionActive, forgetPayloadConversion, noteConversions, outsideQueue, payloadConversions, refreshConversions, setConversionSource, usePayloadConversions };
