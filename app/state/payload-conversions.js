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

  var ACTIVE_CONVERSION = ["queued", "converting", "verifying"];
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

export { cancelPayloadConversion, conversionActive, forgetPayloadConversion, noteConversions, outsideQueue, payloadConversions, refreshConversions, setConversionSource, usePayloadConversions };
