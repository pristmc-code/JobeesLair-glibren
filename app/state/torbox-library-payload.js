// glibren.38 (item 3 do plano de melhorias): a rede da Biblioteca TorBox no payload (app/native/bg_library.c).
//
// A montagem (state/torbox-library.js buildLibrary) pergunta aqui se o payload pode fazer as chamadas da rodada. Pode
// quando ha um payload no ar com api >= 27 (background-downloads.js registra como falar com ele: setLibraryPayload):
//   1. o app grava o plano (<pasta do payload>/library/plan.ndjson) um bloco de jogos por vez (appendFile), so com o que
//      o payload pergunta ao TorBox de cada jogo (torbox-library.js planGame: links, partes, codigo e nomes de arquivo),
//      e pede POST /library/build {run};
//   2. o payload faz a conta, a lista de hashes e os blocos no ritmo do TorBox (429, 414, rede) e grava o que achou de
//      cada bloco num arquivo (account.json, list.json, b00000.json...), com o app aberto, em outra tela ou fechado;
//   3. o app le cada arquivo quando ele aparece (um bloco por vez, nunca todos), passa as entradas por cachedEntry (o
//      mesmo corte das chamadas dele) e casa e grava como antes.
// A rodada do payload tem o id da rodada do banco: um "Continuar" depois de fechar o app reencontra a mesma (o que o
// payload ja fez esta la) e um "Montar de novo" comeca outra. Sem payload, com um antigo, ou se ele recusar: null, e a
// montagem segue toda no app, como antes.

import { cachedEntry } from '../services/torbox.js';
import { planGame } from './torbox-library.js';
import { jsonMembers, skipSpace } from './json-scan.js';

  var PLAN = "plan.ndjson";
  var LIST_LINE = 500; // hashes da lista do jogador por linha do plano
  var POLL_MS = 1e3;
  var GONE_LIMIT = 60; // consultas seguidas sem resposta do payload antes de desistir da rodada (~1 min)
  var source = null;
  /**
   * background-downloads.js: { dir, status(), start(run), cancel() } (cada um -> o estado do GET /library/build ou null
   * sem payload / api < 27), ou null.
   */
  function setLibraryPayload(next) {
    source = next && typeof next.status === "function" ? next : null;
  }
  var libraryPayload = () => source;
  var stopped = () => Object.assign(new Error("Stopped."), { name: "AbortError" });
  var failure = (state) => {
    const text = String(state?.error || "the payload stopped the run");
    const code = /^([A-Z0-9_]+)(?::|$)/.exec(text)?.[1] ?? "PAYLOAD";
    return Object.assign(new Error(code === "RATE_LIMITED" ? "TorBox asked to slow down. Try again in a minute." : code === "NO_AUTH" ? "TorBox needs an API key. Add it in Settings." : `TorBox library (payload): ${text}`), { code });
  };
  var pause = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopped());
    const stop = () => {
      clearTimeout(timer);
      reject(stopped());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", stop, { once: true });
  });
  var blockFile = (b) => `b${String(b).padStart(5, "0")}.json`;
  /**
   * glibren.44: o account.json do payload ({ webdl: [item...], torrent: [item...] } ou { error }) com as listas como
   * iteraveis que fazem o JSON.parse de um item por vez (o texto fica; a arvore inteira nunca existe de uma vez).
   * -> { webdl, torrent } | { error } | null (nao e um objeto). Texto que nao e JSON: SyntaxError.
   */
  function readAccount(text) {
    if (text.charCodeAt(skipSpace(text, 0, text.length)) !== 123) return null;
    const out = { webdl: [], torrent: [] };
    for (const member of jsonMembers(text, 0, text.length)) {
      if (member.key === "error") return { error: JSON.parse(text.slice(member.start, member.end)) || "?" };
      if (member.key !== "webdl" && member.key !== "torrent" || text.charCodeAt(member.start) !== 91) continue;
      const kind = member.key;
      out[kind] = { *[Symbol.iterator]() {
        for (const part of jsonMembers(text, 0, text.length, kind)) if (part.item && part.key === kind) yield JSON.parse(text.slice(part.start, part.end));
      } };
    }
    return out;
  }

  /**
   * O cliente da rodada no payload. `fs`: FileSystem; `link`: o de setLibraryPayload (padrão: o registrado); `wait(ms,
   * signal)`. -> { open(...) } para buildLibrary (`remote`).
   */
  function createLibraryRemote({ fs, link = libraryPayload, wait = pause, log = () => {}, poll = POLL_MS }) {
    return {
      /**
       * Comeca ou reencontra a rodada `runId` no payload. `pending`: os jogos que faltam ([{ game }]), em blocos de
       * `chunk`; `hashList`: a lista do jogador. -> a sessao, ou null (sem payload: tudo pelo app).
       */
      async open({ runId, pending, chunk, hashList, signal, onStatus = () => {} }) {
        const payload = link();
        if (!payload) return null;
        let state = await payload.status();
        if (!state) return null;
        const dir = payload.dir;
        const attached = state.run === runId && Boolean(state.state);
        if (!attached) {
          if (state.busy) {
            await payload.cancel();
            for (let tries = 0; state?.busy && tries < 60; tries++) {
              await wait(500, signal);
              state = await payload.status();
            }
            if (state?.busy) return null;
          }
          writePlan(fs, dir, runId, pending, chunk, hashList);
          state = await payload.start(runId);
          if (!state || state.run !== runId) return null;
        } else if (state.state === "failed" || state.state === "cancelled" || state.state === "running" && !state.busy) {
          state = await payload.start(runId);
          if (!state || state.run !== runId) return null;
        }
        onStatus(state);
        let gone = 0;
        // Espera ate `ready()` (um arquivo do payload) ou a rodada parar; o estado vai para a tela a cada consulta.
        async function until(ready) {
          for (;;) {
            if (signal?.aborted) throw stopped();
            if (ready()) return;
            const now = await payload.status().catch(() => null);
            if (now && now.run === runId) {
              gone = 0;
              state = now;
              onStatus(now);
              if (ready()) return;
              if (now.state === "failed") throw failure(now);
              if (now.state === "cancelled") throw stopped();
              if (now.state === "done") {
                if (ready()) return;
                throw Object.assign(new Error("TorBox library (payload): a result file is missing"), { code: "PAYLOAD" });
              }
            } else if (++gone >= GONE_LIMIT) {
              throw Object.assign(new Error("The background payload stopped answering. Continue the TorBox library to resume."), { code: "NETWORK" });
            }
            await wait(poll, signal);
          }
        }
        const path = (name) => `${dir}/${name}`;
        const read = (name) => JSON.parse(String(fs.readFile(path(name))));
        return {
          attached,
          blocks: attached ? Number(state.blocks) || 0 : Math.ceil(pending.length / chunk),
          calls: Number(state.calls) || 0,
          /** A conta: [["webdl", itens], ["torrent", itens]], ou null quando o TorBox nao a deu. */
          // glibren.44: lida um item por vez (state/json-scan.js), sem o JSON.parse do arquivo inteiro: o payload da .43
          // mandava todos os arquivos de cada item (varios MB numa conta com pastas grandes) e um payload antigo ainda
          // no ar manda. Cada item passa pelo corte de indexAccount logo depois de lido.
          async account() {
            await until(() => fs.exists(path("account.json")));
            const value = readAccount(String(fs.readFile(path("account.json"))));
            if (!value || value.error) {
              log(`account not read: ${value?.error ?? "?"}`);
              return null;
            }
            return [["webdl", value.webdl], ["torrent", value.torrent]];
          },
          /** A lista de hashes do jogador: Map hash -> entrada (so os que o TorBox tem). */
          async list() {
            if (!hashList?.entries?.length) return /* @__PURE__ */ new Map();
            await until(() => fs.exists(path("list.json")));
            const value = read("list.json");
            return new Map(Object.entries(value?.held || {}).map(([hash, entry]) => [hash, cachedEntry(entry)]));
          },
          /** O bloco `b`: { ids, held: Map link -> entrada, failed: Map link -> codigo, names: [{ hash, ...entrada }] }. */
          async block(b) {
            await until(() => fs.exists(path(blockFile(b))));
            const value = read(blockFile(b));
            return {
              ids: Array.isArray(value.ids) ? value.ids : [],
              held: new Map(Object.entries(value.held || {}).map(([url, entry]) => [url, cachedEntry(entry)])),
              failed: new Map(Object.entries(value.failed || {})),
              names: (Array.isArray(value.names) ? value.names : []).map((entry) => ({ hash: String(entry.hash || "").toLowerCase(), ...cachedEntry(entry) }))
            };
          },
          async cancel() {
            await payload.cancel();
          }
        };
      }
    };
  }
  /**
   * O plano (bg_library.c), gravado um bloco por vez e trocado de nome no fim: nenhum texto do plano inteiro na memoria.
   * Linha 1 o cabecalho, depois a lista de hashes do jogador (LIST_LINE por linha) e um bloco de `chunk` jogos por linha.
   */
  function writePlan(fs, dir, runId, pending, chunk, hashList) {
    fs.mkdir(dir, { recursive: true });
    const target = `${dir}/${PLAN}`;
    const tmp = `${target}.tmp`;
    const blocks = Math.ceil(pending.length / chunk);
    fs.writeFile(tmp, `${JSON.stringify({ v: 1, run: runId, blocks, account: true })}\n`);
    const hashes = (hashList?.entries || []).map((item) => item.hash);
    for (let i = 0; i < hashes.length; i += LIST_LINE) fs.appendFile(tmp, `${JSON.stringify({ list: hashes.slice(i, i + LIST_LINE) })}\n`);
    for (let b = 0; b < blocks; b++) {
      const games = pending.slice(b * chunk, (b + 1) * chunk).map(({ game }) => planGame(game));
      fs.appendFile(tmp, `${JSON.stringify({ b, games })}\n`);
    }
    if (fs.exists(target)) fs.remove(target);
    fs.rename(tmp, target);
  }

export { createLibraryRemote, libraryPayload, readAccount, setLibraryPayload, writePlan };
