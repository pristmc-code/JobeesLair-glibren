// Downloads em segundo plano: o download continua quando a Jobee'sLair fecha (o jogador abre um jogo).
//
// Quem baixa e o payload bg-downloader.elf (app/native/bg_downloader.c), enviado ao elfldr (127.0.0.1:9021)
// por Payloads.send, como o companion. Ele fica vivo depois que o app fecha e fala so em 127.0.0.1:34200, com o
// token que ele mesmo grava em /data/JobeesLair/bg/token (lido aqui pelo FileSystem do app).
//
// Por que o app entrega o download ao payload JA NO INICIO (e nao "ao sair"): o ps5-react nao avisa o JS quando
// o app vai fechar; com outro app na frente o processo fica suspenso (o JS para) e, quando um jogo abre, o
// sistema mata o app. Nao ha um momento confiavel para entregar. Entao, com a opcao ligada (padrao), cada
// download da fila nasce no payload e o app so acompanha: nunca os dois baixam o mesmo arquivo.
//
// Este modulo embrulha o Downloads do ps5-react (createBackgroundDownloads): a fila (download-queue.js) chama
// downloads.enqueue() como sempre e recebe uma tarefa com a mesma interface (subscribe, done, cancel,
// snapshot). Por baixo, a tarefa e do payload; se ele nao subir, ou a opcao estiver desligada, ou o download
// nao couber (pecas, a atualizacao do proprio app), e o motor nativo, como antes.
// Espelhos (mirrors: o mesmo arquivo em outros links, download-mirrors.js): o payload baixa so do link principal,
// para o download continuar com o app fechado. As opcoes guardadas mantem os espelhos, entao, se o download voltar
// ao motor do app ("Baixar pelo app", payload que some), ele volta a usa-los. Com a opcao desligada, o app usa os
// espelhos desde o inicio, como antes.
// A parcial (.part/.resume/.complete) tem o mesmo formato nos dois, entao:
//   - "Baixar pelo app" (takeOverDownload) libera o job no payload (ele grava o checkpoint e esquece o job) e
//     continua no motor nativo de onde parou;
//   - se o payload some, o app continua sozinho do ultimo checkpoint;
//   - ao abrir o app, a fila retoma o job e esta tarefa se liga ao job que o payload ja tinha (pelo destino, ou
//     pelo caminho onde ele publicou a imagem), mostrando o progresso dele; um job que terminou com o app
//     fechado entrega o resultado (concluido, ou o erro, que a fila trata como sempre: link vencido, etc.).
//
// Pontos de contato com o resto do app (para facilitar a juncao com outros ramos):
//   - download-queue.js: o enqueue do arquivo unico leva `background: { title, publishTo, source }`;
//   - downloads.js: a fila recebe createBackgroundDownloads(...) no lugar do Downloads;
//   - debrid.js: debridHandoff(source) (servico + pedido + arquivo do TorBox) e debridSecret(service) (a chave,
//     entregue ao payload so por POST /secret em 127.0.0.1, nunca gravada nem registrada);
//   - Settings.jsx (a opcao) e DownloadCard.jsx (o selo "segundo plano" e o botao "Baixar pelo app").
//   - downloads simultaneos (state/simultaneous-downloads.js): setConcurrency(n) passa o numero ao motor nativo
//     (Downloads.setConcurrency) e ao payload (POST /config), que entao baixa ate n jobs ao mesmo tempo.

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';

  var SETTINGS = "settings.json";
  var ELF = "/app0/bg-downloader.elf";
  var STATE_DIR = "/data/JobeesLair/bg";
  var PORT = 34200;
  var MiB = 1024 * 1024;
  var ENGINE_RANGE = 32 * MiB; // o rangeBytes padrao do motor nativo: a parcial so e a mesma com o mesmo valor

  // ---- A opcao "Continuar baixando quando eu fechar o app" (ligada por padrao) ----
  var enabled = null;
  var settingListeners = /* @__PURE__ */ new Set();
  function backgroundDownloadsOn() {
    if (enabled === null) enabled = loadList(SETTINGS, "settings").backgroundDownloads !== false;
    return enabled;
  }
  function setBackgroundDownloads(on) {
    enabled = Boolean(on);
    saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), backgroundDownloads: enabled });
    for (const listener of settingListeners) listener(enabled);
  }
  function useBackgroundDownloads() {
    const [on, setOn] = useState(backgroundDownloadsOn);
    useEffect(() => {
      settingListeners.add(setOn);
      return () => {
        settingListeners.delete(setOn);
      };
    }, []);
    return on;
  }

  // ---- Quem baixa cada destino agora (para o cartao na tela de downloads) ----
  var owners = /* @__PURE__ */ new Map(); // destino -> { takeOver }
  var ownerListeners = /* @__PURE__ */ new Set();
  function setOwner(destination, entry) {
    if (entry) owners.set(destination, entry);
    else owners.delete(destination);
    for (const listener of ownerListeners) listener();
  }
  /** True enquanto o payload (e nao o app) baixa `destination`. */
  function inBackground(destination) {
    return Boolean(destination && owners.has(destination));
  }
  function useBackgroundOwner(destination) {
    const [owned, setOwned] = useState(() => inBackground(destination));
    useEffect(() => {
      const listener = () => setOwned(inBackground(destination));
      ownerListeners.add(listener);
      listener();
      return () => {
        ownerListeners.delete(listener);
      };
    }, [destination]);
    return owned;
  }
  /** "Baixar pelo app": tira o download do payload e continua no motor do app, aproveitando a parcial. */
  function takeOverDownload(destination) {
    return owners.get(destination)?.takeOver() ?? Promise.resolve(false);
  }

  var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var TERMINAL = ["completed", "failed", "cancelled", "needs-app"];
  var baseName = (path) => String(path).slice(String(path).lastIndexOf("/") + 1);

  /**
   * O Downloads do ps5-react com os downloads da fila entregues ao payload. `downloads`: o Downloads do runtime;
   * `http`: Http; `fs`: FileSystem; `payloads`: Payloads; `platform`: Platform.OS; `handoff(source)`: a fonte
   * como o payload a entende ({ provider, kind, id, fileId, zip }); `secret(service)`: a chave do servico
   * debrid; `text(key, vars)`: as mensagens da notificacao no idioma do jogador.
   */
  function createBackgroundDownloads({
    downloads,
    http,
    fs,
    payloads,
    platform,
    handoff = () => null,
    secret = () => "",
    text = (key) => key,
    on = backgroundDownloadsOn,
    log = (line) => console.log(`[background] ${line}`),
    pollMs = 1e3,
    startWaitMs = 8e3,
    port = PORT,
    stateDir = STATE_DIR,
    concurrency = () => 1
  }) {
    const base = `http://127.0.0.1:${port}`;
    let secretsFor = null; // pid do payload que ja recebeu a chave
    let configFor = null; // pid:n do payload que ja recebeu o numero de downloads simultaneos
    const readToken = () => {
      try {
        const value = String(fs.readFile(`${stateDir}/token`) ?? "").trim();
        return /^[0-9a-f]{64}$/.test(value) ? value : "";
      } catch {
        return "";
      }
    };
    async function call(token, method, path, body) {
      const response = await http.request(`${base}${path}`, {
        method,
        headers: body === void 0 ? { "X-Jobe-Token": token } : { "X-Jobe-Token": token, "Content-Type": "application/json" },
        body: body === void 0 ? void 0 : JSON.stringify(body),
        maxBytes: 1024 * 1024
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
      }
      return { status: response.status, data: data ?? {} };
    }
    async function health(token) {
      try {
        const answer = await call(token, "GET", "/health");
        return answer.status === 200 && answer.data?.ok ? answer.data : null;
      } catch {
        return null;
      }
    }
    // O payload no ar: o token dele, ou "" (sem payload: o app baixa como antes).
    async function ensurePayload() {
      let token = readToken();
      if (token && await health(token)) return token;
      if (platform !== "ps5" || !payloads) return "";
      try {
        const result = payloads.send(ELF, { answer: false });
        if (!result?.ok) {
          log(`payload not sent: ${result?.error ?? "no answer"}`);
          return "";
        }
      } catch (error) {
        log(`payload not sent: ${error?.message ?? error}`);
        return "";
      }
      for (const until = Date.now() + startWaitMs; Date.now() < until; ) {
        await wait(Math.min(400, startWaitMs));
        token = readToken();
        if (token && await health(token)) return token;
      }
      log("payload did not answer in time; downloading in the app");
      return "";
    }
    async function handSecret(token, provider) {
      if (provider !== "torbox" && provider !== "alldebrid") return;
      const state = await health(token);
      if (!state || secretsFor === `${state.pid}:${provider}`) return;
      const key = secret(provider);
      if (!key) return;
      const answer = await call(token, "POST", "/secret", { service: provider, key });
      if (answer.status === 200) secretsFor = `${state.pid}:${provider}`;
    }
    // O payload baixa ate `concurrency()` jobs ao mesmo tempo: o numero vai a cada payload novo (pid) e a cada mudanca.
    async function syncConcurrency(token) {
      if (!token) return;
      const count = concurrency();
      const state = await health(token);
      if (!state || configFor === `${state.pid}:${count}`) return;
      const answer = await call(token, "POST", "/config", { concurrency: count });
      if (answer.status === 200) configFor = `${state.pid}:${count}`;
      else log(`payload did not take ${count} simultaneous downloads (HTTP ${answer.status})`);
    }
    const eligible = (options) => platform === "ps5" && on() && options.background && typeof options.url === "string" &&
      /^https?:\/\//.test(options.url) && options.destination && !options.pieces && !options.unlimited;

    function hybridTask(options, meta) {
      const destination = options.destination;
      const listeners = /* @__PURE__ */ new Set();
      let snapshot = Object.freeze({ id: 0, destination, state: "queued", received: 0, written: 0, total: null, bytesPerSecond: 0, connections: 0, retries: 0, bufferedBytes: 0 });
      let resolve, reject;
      const done = new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      done.catch(() => {});
      let mode = "starting", native = null, token = "", jobId = null, cancelled = false, settled = false, failures = 0, timer = null;
      const emit = (next) => {
        snapshot = Object.freeze({ ...next, destination });
        for (const listener of [...listeners]) {
          try {
            listener(snapshot);
          } catch (error) {
            console.error("Download progress listener failed:", error);
          }
        }
      };
      const error = (message, name) => {
        const value = new Error(`Downloads.enqueue ${destination}: ${message}`);
        if (name) value.name = name;
        return value;
      };
      const finish = (ok, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (owners.get(destination)?.task === task) setOwner(destination, null);
        if (ok) resolve(value);
        else reject(value);
        listeners.clear();
      };
      const forget = () => jobId && call(token, "POST", `/jobs/${jobId}/forget`).catch(() => {});
      // Espera o payload largar o arquivo (checkpoint gravado, job esquecido) antes de o app mexer nele.
      async function release() {
        try {
          await call(token, "POST", `/jobs/${jobId}/release`);
          for (let i = 0; i < 150; ++i) {
            const answer = await call(token, "GET", "/jobs");
            if (!answer.data?.jobs?.some((job) => job.id === jobId)) return true;
            await wait(100);
          }
        } catch {
        }
        return false;
      }
      function runNative() {
        mode = "native";
        if (owners.get(destination)?.task === task) setOwner(destination, null);
        native = downloads.enqueue(options);
        native.subscribe((progress) => {
          if (!settled) emit(progress);
        });
        native.done.then((value) => finish(true, value), (value) => finish(false, value));
        if (cancelled) native.cancel();
      }
      const shown = (job) => ({
        id: snapshot.id,
        state: ["connecting", "downloading", "verifying"].includes(job.state) ? job.state : "queued",
        received: job.written || 0,
        written: job.written || 0,
        total: job.total || null,
        bytesPerSecond: job.bytesPerSecond || 0,
        connections: job.connectionsActive || 0,
        retries: job.retries || 0,
        bufferedBytes: 0,
        owner: "payload"
      });
      // O que o payload tem para este destino ao (re)abrir: o resultado de um job que terminou com o app fechado.
      function settle(job) {
        if (job.state === "completed") {
          forget();
          finish(true, { ...shown(job), state: "completed", destination });
          return true;
        }
        if (job.state === "cancelled") {
          forget();
          finish(false, error("cancelled", "AbortError"));
          return true;
        }
        if (job.state === "failed" || job.state === "needs-app") {
          forget();
          finish(false, error(job.error || "download failed"));
          return true;
        }
        return false;
      }
      async function poll() {
        if (settled || mode !== "payload") return;
        let job;
        try {
          const answer = await call(token, "GET", "/jobs");
          if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
          job = answer.data.jobs?.find((item) => item.id === jobId);
          failures = 0;
        } catch (problem) {
          // O payload sumiu (morto pelo gerenciador de payloads, ou o sistema): o app continua do ultimo checkpoint.
          if (++failures >= 15) {
            log(`payload stopped answering (${problem?.message ?? problem}); continuing in the app`);
            if (!settled && mode === "payload") runNative();
            return;
          }
          timer = setTimeout(poll, pollMs);
          return;
        }
        if (settled || mode !== "payload") return;
        if (!job) {
          if (cancelled) finish(false, error("cancelled", "AbortError"));
          else runNative();
          return;
        }
        emit(shown(job));
        if (settle(job)) return;
        if (job.state === "paused" && !cancelled) call(token, "POST", `/jobs/${jobId}/resume`).catch(() => {});
        timer = setTimeout(poll, pollMs);
      }
      async function start() {
        try {
          token = await ensurePayload();
          if (cancelled) return finish(false, error("cancelled", "AbortError"));
          if (!token) return runNative();
          const source = handoff(meta.source) || { provider: "direct" };
          await handSecret(token, source.provider).catch(() => {});
          await syncConcurrency(token).catch(() => {});
          const list = await call(token, "GET", "/jobs");
          const existing = list.data?.jobs?.find((job) => job.destination === destination || job.published && job.published === destination);
          if (existing) {
            jobId = existing.id;
            log(`${baseName(destination)}: following the background job ${jobId} (${existing.state})`);
            if (settle(existing)) return;
          } else {
            const publishTo = meta.publishTo && meta.publishTo !== destination ? meta.publishTo : "";
            const name = meta.title || baseName(destination);
            const answer = await call(token, "POST", "/jobs", {
              url: options.url,
              destination,
              storageRoot: options.storageRoot || "",
              name,
              sha256: options.sha256 || "",
              expectedBytes: options.expectedBytes || 0,
              rangeBytes: options.rangeBytes || ENGINE_RANGE,
              connections: options.connections || 8,
              rejectHtml: Boolean(options.rejectHtml),
              publishTo,
              source,
              notifyDone: text("downloads.background.notifyDone", { name }),
              notifyFailed: text("downloads.background.notifyFailed", { name })
            });
            if (answer.status === 409 && answer.data?.id) jobId = answer.data.id;
            else if (answer.status === 201 && answer.data?.id) jobId = answer.data.id;
            else {
              log(`payload refused the download (HTTP ${answer.status}: ${answer.data?.error ?? ""}); downloading in the app`);
              return runNative();
            }
            log(`${baseName(destination)}: handed to the background job ${jobId}${options.mirrors?.length ? ` (main link only; the app keeps ${options.mirrors.length} mirror(s) for a take-over)` : ""}`);
          }
          if (cancelled) {
            await release();
            return finish(false, error("cancelled", "AbortError"));
          }
          mode = "payload";
          setOwner(destination, { task, takeOver });
          poll();
        } catch (problem) {
          log(`background download not started (${problem?.message ?? problem}); downloading in the app`);
          if (settled) return;
          if (jobId) await release();
          if (cancelled) finish(false, error("cancelled", "AbortError"));
          else runNative();
        }
      }
      async function takeOver() {
        if (mode !== "payload" || settled) return false;
        mode = "handing";
        clearTimeout(timer);
        setOwner(destination, null);
        log(`${baseName(destination)}: taking the download back from the background job ${jobId}`);
        const released = await release();
        if (!released) log("the background job did not let go in time; continuing in the app anyway");
        if (cancelled) finish(false, error("cancelled", "AbortError"));
        else runNative();
        return true;
      }
      const task = Object.freeze({
        get id() {
          return snapshot.id;
        },
        done,
        cancel() {
          if (settled || cancelled) return;
          cancelled = true;
          if (mode === "native") native?.cancel();
          else if (mode === "payload") {
            mode = "handing";
            clearTimeout(timer);
            release().finally(() => finish(false, error("cancelled", "AbortError")));
          }
        },
        get snapshot() {
          return snapshot;
        },
        subscribe(listener) {
          if (typeof listener !== "function") throw new TypeError("Downloads.subscribe: expected a function");
          listener(snapshot);
          if (!settled) listeners.add(listener);
          return () => listeners.delete(listener);
        }
      });
      start();
      return task;
    }

    const wrapper = Object.create(downloads);
    wrapper.enqueue = (request) => {
      const { background, ...options } = request ?? {};
      if (!eligible({ ...options, background })) return downloads.enqueue(options);
      return hybridTask(options, background);
    };
    wrapper.setRateLimit = (bytesPerSecond) => downloads.setRateLimit(bytesPerSecond);
    // Downloads simultaneos: as faixas do motor nativo agora, e o payload se estiver no ar (senao, ao subir).
    wrapper.setConcurrency = (count) => {
      let lanes = 1;
      try {
        if (typeof downloads.setConcurrency === "function") lanes = downloads.setConcurrency(count);
      } catch (error) {
        log(`engine lanes not set: ${error?.message ?? error}`);
      }
      syncConcurrency(readToken()).catch(() => {});
      return lanes;
    };
    return wrapper;
  }

export { backgroundDownloadsOn, createBackgroundDownloads, inBackground, setBackgroundDownloads, takeOverDownload, useBackgroundDownloads, useBackgroundOwner };
