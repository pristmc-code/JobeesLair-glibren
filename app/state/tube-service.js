// glibren-tube: o YouTube dentro da Jobee'sLair. Quem fala com o YouTube e o payload tube-service.elf (projeto
// tube-service: o servico embutido do YouTube Max'd, QuickJS-NG + youtubei.js, so em 127.0.0.1:34210), enviado ao
// elfldr (127.0.0.1:9021) por Payloads.send como o bg-downloader.elf, mas SOB DEMANDA: so quando o jogador abre os
// videos (nunca na abertura do app). Ele fica no ar depois que o app fecha, ate o PS5 reiniciar ou um POST /v1/quit.
//
// Contrato (tube-service, js/companion.js e src/payload_main.c):
//   - GET /v1/health (sem token): { api_version, api, version, service: "tube-service", features, sponsorblock, pid };
//   - o token (64 hex) fica em /data/JobeesLair/tube/token e vai como "Authorization: Bearer <token>" em /v1/*;
//   - POST /v1/jobs { action: "library", library: { action: "search", query, order, duration, upload_date, type } }
//     e { action: "library", library: { action: "continue", cursor } } -> { job }; GET /v1/jobs/<id> ate sair de
//     "pending": { state: "done", result } ou { state: "failed", error: { code, message } }. A busca responde
//     { kind: "catalog", items: [{ kind: "video" | "channel" | "playlist", id, title, subtitle, duration_sec, is_live,
//     is_short, is_upcoming, ... }], cursor, has_more } (o cursor vale ~120 s);
//   - POST /v1/jobs { action: "resolve", playback: { id, max_height, codec, caption_language, automatic_captions } }
//     -> { title, channel, duration_sec, choices: [{ label, container, video_codec, height, fps, url, hls_url? }],
//     captions: [{ language, name, url, automatic, translated }] }. O `hls_url` e uma playlist HLS master (video +
//     audio) servida pelo proprio servico em /media/... (sem token): o <Video> abre um link so;
//   - GET /v1/sponsor/<id>?categories=sponsor,selfpromo -> { segments: [{ start, end, category }], enabled }.
// Por jobs (e nao direto) porque resolver um video pode levar dezenas de segundos: o app pergunta a cada 400 ms e
// pode desistir (DELETE /v1/jobs/<id>) quando o jogador sai.
//
// Nada de listas grandes no heap: uma pagina de resultados por vez (ate 24, so os campos que a tela usa).

import { Downloads, FileSystem, Http, Payloads, Platform } from '@ps5-react/core';
import { createTubeUpdater } from './tube-update.js';
import { tubeAutoUpdate } from './tube-settings.js';
import { newer } from './updater.js';
import { REPO, VERSION } from '../version.js';

  var TUBE_DIR = "/data/JobeesLair/tube";
  var TUBE_PORT = 34210;
  // A "api" minima do servico (API em tube-service js/companion.js, no /health); um mais antigo e trocado pelo nosso.
  var TUBE_API = 1;
  // Onde o app procura o ELF: o do pacote (app.json "payloads", opcional) e, para testar sem refazer o app, um copiado
  // a mao para a pasta de dados.
  var ELF_PATHS = ["/app0/tube-service.elf", "/data/JobeesLair/tube-service.elf"];
  var VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  var PAGE_LIMIT = 24;
  // O que o <Video> do ps5-react decodifica (docs/VIDEO.md): H.264, HEVC e VP9; AV1 nao.
  var PLAYABLE_CODECS = /* @__PURE__ */ new Set(["h264", "avc", "vp9", "hevc"]);

  class TubeError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

  var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var clip = (value, max) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };

  // ---- Pecas puras (testadas em tests/tube-service.test.mjs) ----

  /** Os parametros da busca como o servico os aceita (schema.js LIBRARY): so valores conhecidos. */
  var ORDERS = ["relevance", "view_count"];
  var DURATIONS = ["any", "short", "medium", "long"];
  var UPLOADS = ["any", "today", "week", "month", "year"];
  var TYPES = ["video", "shorts", "all"];
  var DEFAULT_FILTERS = Object.freeze({ order: "relevance", duration: "any", upload_date: "any", type: "video" });
  function searchRequest(query, filters = DEFAULT_FILTERS) {
    const pick = (value, list, fallback) => list.includes(value) ? value : fallback;
    return {
      action: "search",
      query: clip(query, 200),
      order: pick(filters.order, ORDERS, "relevance"),
      duration: pick(filters.duration, DURATIONS, "any"),
      upload_date: pick(filters.upload_date, UPLOADS, "any"),
      type: pick(filters.type, TYPES, "video")
    };
  }

  /** Uma pagina do servico enxuta: so videos, so os campos da tela, ate PAGE_LIMIT. */
  function pageItems(result, limit = PAGE_LIMIT) {
    const rows = Array.isArray(result?.items) ? result.items : [];
    const items = [];
    for (const row of rows) {
      if (items.length >= limit) break;
      if (!row || row.is_folder || row.kind && row.kind !== "video" || !VIDEO_ID.test(String(row.id ?? ""))) continue;
      items.push({
        id: row.id,
        title: clip(row.title, 120),
        channel: clip(row.subtitle ?? row.channel, 80),
        seconds: Number.isFinite(row.duration_sec) && row.duration_sec > 0 ? Math.trunc(row.duration_sec) : 0,
        live: row.is_live === true,
        short: row.is_short === true,
        upcoming: row.is_upcoming === true
      });
    }
    return items;
  }

  /** O primeiro video "normal" (nao ao vivo, nao Short, nao agendado); sem nenhum, o primeiro ao vivo ou Short; ou null. */
  function pickFirstVideo(items) {
    const list = Array.isArray(items) ? items : [];
    return list.find((item) => !item.live && !item.short && !item.upcoming) ?? list.find((item) => !item.upcoming) ?? null;
  }

  /** As qualidades que o <Video> toca, na ordem do servico (melhor primeiro): { label, height, fps, codec, url, hls }. */
  function playableChoices(choices) {
    const list = [];
    const seen = /* @__PURE__ */ new Set();
    for (const choice of Array.isArray(choices) ? choices : []) {
      const codec = String(choice?.video_codec ?? "").toLowerCase();
      if (!PLAYABLE_CODECS.has(codec)) continue;
      const container = String(choice.container ?? "");
      // Um link so com imagem e som: a master HLS do servico (DASH vira HLS la), um HLS do proprio YouTube (ao vivo)
      // ou um arquivo com os dois (o servico responde com um redirect). Um .mpd sozinho, nao (o player nao le DASH).
      const url = typeof choice.hls_url === "string" && choice.hls_url ? choice.hls_url : container === "hls" || container === "mp4" || container === "webm" ? choice.url : "";
      if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) continue;
      const label = clip(choice.label || `${choice.height}p`, 48);
      if (seen.has(label)) continue;
      seen.add(label);
      list.push({ label, height: Number(choice.height) || 0, fps: Number(choice.fps) || 0, codec, url, hls: Boolean(choice.hls_url) || container === "hls" });
    }
    return list;
  }

  /** A qualidade padrao: a melhor ate `max` (1080p), um link HLS antes de um arquivo; sem nenhuma ate la, a menor. */
  function defaultChoice(list, max = 1080) {
    if (!list.length) return -1;
    const fits = list.map((choice, index) => ({ choice, index })).filter(({ choice }) => choice.height <= max);
    if (!fits.length) return list.reduce((best, choice, index) => choice.height < list[best].height ? index : best, 0);
    const top = Math.max(...fits.map(({ choice }) => choice.height));
    const best = fits.filter(({ choice }) => choice.height === top);
    return (best.find(({ choice }) => choice.hls) ?? best[0]).index;
  }

  /** A legenda no idioma do app (a escrita antes da automatica, a original antes da traduzida), senao em ingles, senao null. */
  function pickCaption(captions, locale = "en") {
    const list = (Array.isArray(captions) ? captions : []).filter((caption) => typeof caption?.url === "string" && caption.url);
    const base = (tag) => String(tag ?? "").toLowerCase().split(/[-_]/)[0];
    const exact = String(locale ?? "").toLowerCase();
    const want = base(locale);
    const rank = (caption) => (caption.translated ? 2 : 0) + (caption.automatic ? 1 : 0);
    for (const target of [want, "en"]) {
      const found = list.filter((caption) => base(caption.translated ? caption.target ?? caption.language : caption.language) === target).sort((a, b) => rank(a) - rank(b) || (String(b.language).toLowerCase() === exact) - (String(a.language).toLowerCase() === exact));
      if (found.length) {
        const caption = found[0];
        return { uri: `${caption.url}${caption.url.includes("?") ? "&" : "?"}format=vtt`, language: clip(caption.language, 32), title: clip(caption.name || caption.language, 64) };
      }
    }
    return null;
  }

  /** O fim do trecho do SponsorBlock em que `seconds` esta (para pular ate ele), ou null. */
  function sponsorSkipTo(segments, seconds) {
    if (!Number.isFinite(seconds)) return null;
    for (const segment of Array.isArray(segments) ? segments : []) {
      if (segment.category === "poi_highlight") continue;
      if (seconds >= segment.start && seconds < segment.end - 0.4) return segment.end;
    }
    return null;
  }

  /** "1:02:03" / "4:05". */
  function clockText(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
    const two = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
  }

  // ---- O cliente ----

  /**
   * `http`: Http; `fs`: FileSystem; `payloads`: Payloads; `platform`: Platform.OS. `startWaitMs`: quanto esperar o
   * payload responder depois de enviado; `jobPollMs`/`jobTimeoutMs`: o acompanhamento de um job. glibren-fast:
   * `prefetchMax`/`cacheKeep`/`cacheMs`: o pre-resolve (em andamento ao mesmo tempo, guardados, validade); `now`: o relogio.
   */
  function createTubeService({
    http,
    fs,
    payloads,
    platform,
    log = (line) => console.log(`[tube] ${line}`),
    port = TUBE_PORT,
    stateDir = TUBE_DIR,
    elfPaths = ELF_PATHS,
    api = TUBE_API,
    startWaitMs = 15e3,
    startPollMs = 400,
    jobPollMs = 400,
    jobTimeoutMs = 9e4,
    requestMs = 1e4,
    prefetchMax = 2,
    cacheKeep = 3,
    cacheMs = 6e5,
    now = () => Date.now(),
    // glibren-tube-update: quem escolhe o ELF (state/tube-update.js candidates()); sem ele, `elfPaths` como antes.
    updater = null
  }) {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    // glibren-tube-update: a versao no ar (do /v1/health), quem usa o servico agora (telas, jobs) e a reinicializacao
    // para uma versao nova quando ninguem usa.
    let runningVersion = null;
    let holds = 0;
    let active = 0;
    const readToken = () => {
      try {
        const value = String(fs.readFile(`${stateDir}/token`) ?? "").trim();
        return /^[0-9a-f]{64}$/.test(value) ? value : "";
      } catch {
        return "";
      }
    };
    // Um prazo para cada pedido (o Http do ps5-react aceita um `signal`), somado ao de quem chama.
    function deadline(ms, outer) {
      const listeners = /* @__PURE__ */ new Set();
      const signal = {
        aborted: false,
        addEventListener: (type, listener) => type === "abort" && listeners.add(listener),
        removeEventListener: (type, listener) => listeners.delete(listener)
      };
      const fire = () => {
        if (signal.aborted) return;
        signal.aborted = true;
        for (const listener of [...listeners]) listener();
      };
      const id = setTimeout(fire, ms);
      if (outer?.aborted) fire();
      else outer?.addEventListener?.("abort", fire);
      return { signal, clear: () => {
        clearTimeout(id);
        outer?.removeEventListener?.("abort", fire);
      } };
    }
    async function call(method, path, { body, auth = true, timeoutMs = requestMs, signal } = {}) {
      const headers = {};
      if (auth) headers.Authorization = `Bearer ${readToken()}`;
      if (body !== void 0) headers["Content-Type"] = "application/json";
      const timer = deadline(timeoutMs, signal);
      let response;
      try {
        response = await http.request(`${base}${path}`, { method, headers, body: body === void 0 ? void 0 : JSON.stringify(body), maxBytes: 2 * 1024 * 1024, signal: timer.signal });
      } catch (error) {
        if (signal?.aborted) throw new TubeError("cancelled", "cancelled");
        throw new TubeError(timer.signal.aborted ? "timeout" : "unreachable", error?.message ?? String(error));
      } finally {
        timer.clear();
      }
      let data = null;
      try {
        data = await response.json();
      } catch {
      }
      return { status: response.status, data: data ?? {} };
    }
    async function health() {
      try {
        const answer = await call("GET", "/v1/health", { auth: false, timeoutMs: 3e3 });
        return answer.status === 200 && answer.data?.service === "tube-service" ? answer.data : null;
      } catch {
        return null;
      }
    }
    const upToDate = (state) => Number.isInteger(state?.api) && state.api >= api;
    /** Os ELF que podem subir, na ordem: { path, version, source } (state/tube-update.js; sem ele, `elfPaths`). */
    function elfCandidates() {
      if (updater) {
        try {
          return updater.candidates();
        } catch (error) {
          log(`no candidates: ${error?.message ?? error}`);
        }
      }
      const list = [];
      for (const path of elfPaths) {
        try {
          if (fs.exists(path)) list.push({ path, version: null, source: path.startsWith("/app0/") ? "embedded" : "manual" });
        } catch {
        }
      }
      return list;
    }
    function elfPath() {
      return elfCandidates()[0]?.path ?? null;
    }
    /** Se vale oferecer o YouTube interno: o ELF existe (ou o servico ja respondeu nesta execucao). */
    function offered() {
      return ready || elfPath() !== null;
    }
    // Uma subida por vez: quem pede enquanto outra corre espera a mesma.
    let ensuring = null;
    function ensure() {
      if (!ensuring) ensuring = ensureNow().finally(() => {
        ensuring = null;
      });
      return ensuring;
    }
    async function ensureNow() {
      let state = await health();
      if (state && upToDate(state) && readToken()) {
        // O que ja esta no ar serve (mesmo com uma versao mais nova pronta: ela entra quando ninguem usa).
        ready = true;
        runningVersion = typeof state.version === "string" ? state.version : null;
        if (updater && !updater.state?.().running) updater.noteRunning("running", runningVersion);
        return { ok: true, version: state.version ?? "" };
      }
      ready = false;
      runningVersion = null;
      if (platform !== "ps5" || !payloads) return { ok: false, reason: "desktop", error: state ? "old service" : "no service" };
      const list = elfCandidates();
      if (!list.length) return { ok: false, reason: "missing", error: "tube-service.elf" };
      if (state) {
        // glibren-tube-update: um mais antigo no ar segura a trava do servico: pede para ele sair antes de mandar outro.
        log(`service ${state.pid ?? "?"} is older (api ${state.api ?? "none"}) or has no token; asking it to quit`);
        await call("POST", "/v1/quit", { timeoutMs: 3e3 }).catch(() => {
        });
        await wait(500);
      }
      // glibren-tube-update: um por vez, na ordem de candidates(); um baixado que nao responde fica marcado como ruim e
      // o seguinte (o anterior, o embutido) e tentado.
      for (const candidate of list) {
        const elf = candidate.path;
        try {
          const result = payloads.send(elf, { answer: false });
          if (!result?.ok) {
            log(`payload not sent: ${result?.error ?? "no answer"}`);
            return { ok: false, reason: "send", error: result?.error ?? "" };
          }
        } catch (error) {
          log(`payload not sent: ${error?.message ?? error}`);
          return { ok: false, reason: "send", error: error?.message ?? String(error) };
        }
        log(`${elf} (${candidate.source} ${candidate.version ?? "?"}) sent; waiting for 127.0.0.1:${port}`);
        for (const until = Date.now() + startWaitMs; Date.now() < until; ) {
          await wait(startPollMs);
          state = await health();
          if (state && upToDate(state) && readToken()) {
            ready = true;
            runningVersion = typeof state.version === "string" ? state.version : null;
            log(`service ${state.version ?? ""} up (pid ${state.pid ?? "?"})`);
            updater?.noteRunning(candidate.source, runningVersion);
            return { ok: true, version: state.version ?? "" };
          }
        }
        log(`${elf} did not answer in time`);
        if (candidate.source === "downloaded") updater?.markBad(candidate.version, "did not answer /v1/health");
      }
      log("service did not answer in time");
      return { ok: false, reason: "timeout", error: "" };
    }
    /** glibren-tube-update: alguem (uma tela, o player) usa o servico; devolve quem solta. Ao soltar o ultimo, uma
     *  versao mais nova pronta entra (refreshIfIdle). */
    function hold() {
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds = Math.max(0, holds - 1);
        if (!holds) void refreshIfIdle();
      };
    }
    /** Com ninguem usando e uma versao mais nova pronta que a do ar: pede ao servico para sair (POST /v1/quit); o
     *  proximo ensure() sobe a nova. True quando pediu. */
    async function refreshIfIdle() {
      if (holds || active || pending.size || !ready || !updater || !runningVersion) return false;
      let best = null;
      try {
        best = updater.candidates()[0] ?? null;
      } catch {
      }
      if (!best?.version || !newer(best.version, runningVersion)) return false;
      log(`service ${runningVersion} is idle and ${best.version} is ready: restarting it`);
      ready = false;
      runningVersion = null;
      await call("POST", "/v1/quit", { timeoutMs: 3e3 }).catch(() => {
      });
      return true;
    }
    // Um job: cria, acompanha, devolve o `result` (ou lanca TubeError com o codigo do servico). `signal` desiste.
    async function job(payload, options) {
      active++;
      try {
        return await jobNow(payload, options);
      } finally {
        active--;
      }
    }
    async function jobNow(payload, { signal } = {}) {
      const created = await call("POST", "/v1/jobs", { body: payload, signal });
      if (created.status === 401) {
        ready = false;
        throw new TubeError("unauthorized", "token");
      }
      if (created.status !== 200 || typeof created.data?.job !== "string") throw new TubeError(created.data?.error?.code ?? `http_${created.status}`, created.data?.error?.message ?? "");
      const id = created.data.job;
      const give = () => call("DELETE", `/v1/jobs/${encodeURIComponent(id)}`, { timeoutMs: 3e3 }).catch(() => {
      });
      for (const until = Date.now() + jobTimeoutMs; ; ) {
        if (signal?.aborted) {
          void give();
          throw new TubeError("cancelled", "cancelled");
        }
        if (Date.now() > until) {
          void give();
          throw new TubeError("timeout", "the video service took too long");
        }
        await wait(jobPollMs);
        if (signal?.aborted) continue;
        const answer = await call("GET", `/v1/jobs/${encodeURIComponent(id)}`, { signal });
        if (answer.status !== 200) throw new TubeError(answer.data?.error?.code ?? `http_${answer.status}`, answer.data?.error?.message ?? "");
        if (answer.data?.state === "pending") continue;
        if (answer.data?.state === "failed") throw new TubeError(answer.data.error?.code ?? "failed", answer.data.error?.message ?? "");
        return answer.data?.result ?? null;
      }
    }
    /** Uma pagina de busca: { items, cursor } (cursor "" sem mais). */
    async function search(query, filters, options) {
      const result = await job({ action: "library", library: searchRequest(query, filters) }, options);
      return { items: pageItems(result), cursor: result?.has_more && typeof result.cursor === "string" ? result.cursor : "" };
    }
    /** A pagina seguinte de uma busca (o cursor da anterior). */
    async function more(cursor, options) {
      const result = await job({ action: "library", library: { action: "continue", cursor } }, options);
      return { items: pageItems(result), cursor: result?.has_more && typeof result.cursor === "string" ? result.cursor : "" };
    }
    const languageOf = (locale) => {
      const language = String(locale ?? "").split(/[-_]/)[0].toLowerCase();
      return /^[a-z]{2,3}$/.test(language) ? language : "en";
    };
    async function resolveNow(id, { locale, maxHeight, fresh, signal }) {
      const result = await job({ action: "resolve", playback: { id, max_height: maxHeight, codec: "auto", caption_language: languageOf(locale), automatic_captions: true, ...fresh ? { fresh: true } : {} } }, { signal });
      const choices = playableChoices(result?.choices);
      if (!choices.length) throw new TubeError("unsupported_media", "no playable stream");
      return {
        title: clip(result.title, 160),
        channel: clip(result.channel, 80),
        duration: Number(result.duration_sec) || 0,
        choices,
        caption: pickCaption(result.captions, locale)
      };
    }

    // ---- glibren-fast: o pre-resolve ----
    // Enquanto o jogador olha um resultado, o app ja resolve aquele video (prefetch) e guarda a resposta pouco tempo:
    // ao apertar X, o player usa o resolve pronto (ou o que esta em andamento) em vez de comecar do zero. So os
    // ultimos `cacheKeep` (3) resolves, so os campos que o player usa, e por `cacheMs` (10 min): bem antes das ~6 h
    // dos links e dos 30 min sem uso em que o servico esquece a sessao /media. No maximo `prefetchMax` (2) em
    // andamento; um novo foco cancela os outros (DELETE /v1/jobs/<id>), menos o que o player ja esta esperando.
    const cache = /* @__PURE__ */ new Map(); // chave -> { at, info } (a ordem do Map e a da chegada)
    const pending = /* @__PURE__ */ new Map(); // chave -> { id, promise, abort, adopted }
    const keyOf = (id, locale, maxHeight) => `${id}|${languageOf(locale)}|${maxHeight}`;
    function remember(key, info) {
      cache.delete(key);
      cache.set(key, { at: now(), info });
      while (cache.size > cacheKeep) cache.delete(cache.keys().next().value);
    }
    function cached(key) {
      const hit = cache.get(key);
      if (!hit) return null;
      if (now() - hit.at > cacheMs) {
        cache.delete(key);
        return null;
      }
      return hit.info;
    }
    // Espera o pre-resolve em andamento, mas desiste (so quem espera) se `signal` cancelar.
    function follow(promise, signal) {
      if (!signal) return promise;
      if (signal.aborted) return Promise.reject(new TubeError("cancelled", "cancelled"));
      return new Promise((done, fail) => {
        const stop = () => fail(new TubeError("cancelled", "cancelled"));
        signal.addEventListener?.("abort", stop);
        promise.then(done, fail).finally(() => signal.removeEventListener?.("abort", stop));
      });
    }
    // As playlists de midia da qualidade padrao (vNv/vNa ao lado da master vN.m3u8): um HEAD faz o servico ler os
    // indices do arquivo agora (ele so le os da primeira escolha sozinho), sem trazer o texto para o heap.
    function warm(info) {
      const index = defaultChoice(info.choices);
      const url = index >= 0 ? info.choices[index].url : "";
      const match = /^http:\/\/127\.0\.0\.1:\d+(\/media\/[^/?#]+\/v)(\d+)\.m3u8$/.exec(url);
      if (!match || match[2] === "0") return;
      for (const kind of ["v", "a"]) void call("HEAD", `${match[1]}${match[2]}${kind}.m3u8`, { auth: false, timeoutMs: 15e3 }).catch(() => {
      });
    }
    /** Resolve em segundo plano (o item focado; o primeiro video do modo auto). Cancela os outros pre-resolves que o
     *  player nao esta esperando. Devolve false quando nao comecou (servico fora, id ruim, ja no limite). */
    function prefetch(id, { locale = "en", maxHeight = 2160 } = {}) {
      if (!ready || !VIDEO_ID.test(String(id ?? ""))) return false;
      const key = keyOf(id, locale, maxHeight);
      if (cached(key) || pending.has(key)) return true;
      cancelPrefetch();
      if (pending.size >= prefetchMax) return false;
      const listeners = /* @__PURE__ */ new Set();
      const signal = { aborted: false, addEventListener: (type, listener) => listeners.add(listener), removeEventListener: (type, listener) => listeners.delete(listener) };
      const entry = { id, adopted: false, abort: () => {
        signal.aborted = true;
        for (const listener of [...listeners]) listener();
      } };
      const started = now();
      entry.promise = resolveNow(id, { locale, maxHeight, fresh: false, signal }).then((info) => {
        remember(key, info);
        log(`prefetch ${id} ready in ${now() - started} ms`);
        warm(info);
        return info;
      }).finally(() => {
        if (pending.get(key) === entry) pending.delete(key);
      });
      entry.promise.catch(() => {
      });
      pending.set(key, entry);
      return true;
    }
    /** Cancela os pre-resolves em andamento (menos `except` e o que o player espera). */
    function cancelPrefetch(except = "") {
      for (const [key, entry] of pending) {
        if (entry.adopted || entry.id === except) continue;
        pending.delete(key);
        entry.abort();
      }
    }
    /** O que tocar de um video: { title, channel, duration, choices (playableChoices), caption (pickCaption) }. `fresh`:
     *  links novos (depois de um erro do player: os do YouTube vencem em ~6 h). Sem `fresh`, usa o pre-resolve pronto
     *  (ou espera o que esta em andamento). */
    async function resolve(id, { locale = "en", maxHeight = 2160, fresh = false, signal } = {}) {
      if (!VIDEO_ID.test(id)) throw new TubeError("invalid_video", id);
      const key = keyOf(id, locale, maxHeight);
      if (fresh) cache.delete(key);
      else {
        const hit = cached(key);
        if (hit) return hit;
        const running = pending.get(key);
        if (running) {
          running.adopted = true;
          try {
            return await follow(running.promise, signal);
          } catch (error) {
            if (signal?.aborted) throw error;
            // O pre-resolve falhou: um resolve normal (pode ter sido algo passageiro).
          }
        }
      }
      const info = await resolveNow(id, { locale, maxHeight, fresh, signal });
      remember(key, info);
      return info;
    }
    /** Os trechos do SponsorBlock de um video ([] quando falha: nunca atrapalha o video). */
    async function sponsor(id, { signal } = {}) {
      try {
        const answer = await call("GET", `/v1/sponsor/${encodeURIComponent(id)}?categories=sponsor,selfpromo`, { timeoutMs: 8e3, signal });
        const list = answer.status === 200 && Array.isArray(answer.data?.segments) ? answer.data.segments : [];
        return list.filter((segment) => Number.isFinite(segment?.start) && Number.isFinite(segment?.end) && segment.end > segment.start).slice(0, 64).map((segment) => ({ start: segment.start, end: segment.end, category: String(segment.category ?? "") }));
      } catch {
        return [];
      }
    }
    return { ensure, offered, elfPath, elfCandidates, health, readToken, job, search, more, resolve, prefetch, cancelPrefetch, sponsor, hold, refreshIfIdle, isReady: () => ready, runningVersion: () => runningVersion };
  }

  // O servico do app (o Http, o FileSystem e os Payloads do ps5-react), criado no primeiro uso.
  var shared = null;
  var sharedUpdater = null;
  /** glibren-tube-update: a atualizacao do servico (state/tube-update.js) do app, criada no primeiro uso. */
  function tubeUpdater() {
    if (!sharedUpdater) sharedUpdater = createTubeUpdater({ http: Http, fs: FileSystem, downloads: Downloads, repo: REPO, jobeVersion: VERSION, api: TUBE_API, enabled: () => Platform.OS === "ps5" && tubeAutoUpdate(), onInstalled: () => void shared?.refreshIfIdle?.() });
    return sharedUpdater;
  }
  function tubeService() {
    if (!shared) shared = createTubeService({ http: Http, fs: FileSystem, payloads: Payloads, platform: Platform.OS, updater: tubeUpdater() });
    return shared;
  }
  /** Para os testes: troca o servico compartilhado (null volta ao do app). */
  function setTubeService(service) {
    shared = service;
  }
  /** Para os testes: troca a atualizacao compartilhada (null volta a do app). */
  function setTubeUpdater(updater) {
    sharedUpdater = updater;
  }
  // glibren-tube-update: ao abrir a tela do YouTube/Videos, olha se ha versao nova do servico (no maximo 1x a cada 6 h,
  // tube-update.js) um pouco depois, para nao disputar a rede com a primeira busca; nunca segura a tela nem o video.
  var CHECK_DELAY_MS = 5e3;
  var checkTimer = null;
  function checkTubeUpdateSoon(delayMs = CHECK_DELAY_MS) {
    if (Platform.OS !== "ps5" || checkTimer) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      void tubeUpdater().check().catch(() => {
      });
    }, delayMs);
  }

export { checkTubeUpdateSoon, setTubeUpdater, tubeUpdater, DEFAULT_FILTERS, DURATIONS, ELF_PATHS, ORDERS, TUBE_API, TUBE_DIR, TUBE_PORT, TYPES, TubeError, UPLOADS, clockText, createTubeService, defaultChoice, pageItems, pickCaption, pickFirstVideo, playableChoices, searchRequest, setTubeService, sponsorSkipTo, tubeService };
