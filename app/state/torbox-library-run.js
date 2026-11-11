// glibren.9: a Biblioteca TorBox no app: um só construtor por vez (state/torbox-library.js), que segue rodando
// com o app em outra tela (é um módulo, não a tela: Configurações só mostra o andamento e os botões). Nada começa
// sozinho: só o botão "Montar biblioteca TorBox" (ou "Continuar") o põe para andar. Cancelar, ou fechar o app,
// deixa a rodada aberta para continuar depois.

import { useEffect, useState } from 'react';
import { BUNDLED, catalogEntries, catalogSources } from './catalog.js';
import { DATA_DIR } from './data-dir.js';
import { cancellation } from './download-sources.js';
import { torBoxApi } from './debrid.js';
import { storageRoots } from './drives.js';
import { LIVE_FEED, feedName } from './feeds.js';
import { libraryChanged } from './store-mode.js';
import { brokenOnly, buildLibrary, libraryPaths, readLibrary, stillConfirmed, uncheckedCount, writeLibrary, writeList } from './torbox-library.js';
import { hashListPaths, readHashList } from './torbox-search.js';
import { FileSystem, Platform } from '@ps5-react/core';

  var IDLE = { state: "idle", phase: null, total: 0, done: 0, found: 0, broken: 0, errors: 0, calls: 0, etaMs: null, waitingUntil: null, error: "", resumed: false };
  var current = null;
  var progress = IDLE;
  var listeners = /* @__PURE__ */ new Set();
  var paths = () => libraryPaths(DATA_DIR, Platform.OS === "ps5");
  function set(next) {
    progress = next;
    for (const listener of listeners) listener(progress);
  }
  var log = (line) => console.log(`[torbox-library] ${line}`);
  /** O que o banco gravado diz (para a tela, sem rodar nada): rodada aberta, quantos confirmados, quando. */
  function librarySummary() {
    try {
      const library = readLibrary(FileSystem, paths());
      const records = Object.values(library.games);
      const run = library.run;
      return {
        builtAt: library.builtAt,
        games: records.length,
        confirmed: records.filter(stillConfirmed).length,
        // glibren.13: os jogos que o TorBox so tem como copia quebrada (uma pagina de erro), fora da loja.
        broken: records.filter(brokenOnly).length,
        // glibren.25: os jogos do catálogo que nenhuma montagem verificou (uma lista ligada depois, como a Orbit Store).
        unchecked: library.builtAt ? uncheckedCount(library, catalogEntries()) : 0,
        open: run && !run.finishedAt ? { done: run.done, total: run.total, sources: run.sources, onlyNew: Boolean(run.onlyNew) } : null
      };
    } catch {
      return { builtAt: null, games: 0, confirmed: 0, broken: 0, unchecked: 0, open: null };
    }
  }
  /** As fontes que o jogador pode escolher: o catálogo embutido, o ao vivo e cada feed incluído, com seus jogos. */
  function librarySources() {
    return catalogSources().map(({ id, count }) => ({ id, count, kind: id === BUNDLED ? "bundled" : id === LIVE_FEED ? "live" : "feed", name: id === BUNDLED || id === LIVE_FEED ? null : feedName(id) ?? id }));
  }
  /**
   * Começa (ou continua) a montagem. `sources`: as fontes escolhidas (null: todas); `fresh`: uma rodada nova mesmo
   * com uma aberta; `onlyNew` (glibren.25): só os jogos que o banco ainda não tem. Uma montagem já andando é a que volta.
   */
  function startLibrary({ sources = null, fresh = false, onlyNew = false } = {}) {
    if (current) return current.promise;
    // O motor JS do console não tem AbortController: o sinal de cancelamento é o do app (download-sources.js).
    const controller = cancellation();
    const where = paths();
    let hashList = null;
    try {
      hashList = readHashList(FileSystem, hashListPaths(DATA_DIR, storageRoots()));
    } catch {
    }
    // glibren.28: o banco gravado que nao deu para ler (sem memoria, por exemplo) para a montagem com o erro, sem comecar
    // do zero nem gravar nada por cima dele.
    let library;
    try {
      library = readLibrary(FileSystem, where);
    } catch (error) {
      log(`not started: library not read: ${error?.cause?.message || error?.message || error}`);
      set({ ...IDLE, state: "failed", error: error?.message || String(error) });
      return Promise.resolve();
    }
    set({ ...IDLE, state: "running", phase: "account" });
    const entries = catalogEntries();
    // As fichas do celular (torbox-fichas.json) saem dos jogos do catálogo: capa, fotos, texto e detalhes da loja.
    const byId = new Map(entries.map(({ game }) => [game.id, game]));
    const save = (value, { final }) => {
      try {
        writeLibrary(FileSystem, where, value, { backup: final });
      } catch (error) {
        log(`not saved: ${error?.message || error}`);
      }
      // glibren.28: a lista, os ids da loja e as fichas (so na gravacao final; as parciais gravam so o banco) mesmo
      // quando o banco nao grava: antes a falha do banco levava a lista junto e a loja ficava com a lista antiga.
      if (!final) return;
      try {
        writeList(FileSystem, where, value, void 0, (id) => byId.get(id) ?? null);
      } catch (error) {
        log(`list not saved: ${error?.message || error}`);
      }
    };
    const promise = buildLibrary({
      entries,
      api: torBoxApi(),
      hashList,
      library,
      save,
      sources,
      fresh,
      onlyNew,
      signal: controller.signal,
      log,
      onProgress: (next) => set({ ...progress, ...next, state: "running", error: "" })
    }).then(
      ({ progress: last }) => {
        log(`done: ${last.found} of ${last.total} games confirmed, ${last.calls} calls`);
        set({ ...progress, ...last, state: "done", error: "" });
        libraryChanged();
      },
      (error) => {
        const cancelled = error?.name === "AbortError";
        save(library, { final: false });
        log(cancelled ? `cancelled at ${progress.done} of ${progress.total}` : `stopped: ${error?.code || ""} ${error?.message || error}`);
        set({ ...progress, state: cancelled ? "cancelled" : "failed", waitingUntil: null, error: cancelled ? "" : error?.message || String(error) });
      }
    ).finally(() => {
      current = null;
    });
    current = { controller, promise };
    return promise;
  }
  function cancelLibrary() {
    current?.controller.cancel();
  }
  var libraryProgress = () => progress;
  function useLibraryProgress() {
    const [value, setValue] = useState(progress);
    useEffect(() => {
      listeners.add(setValue);
      setValue(progress);
      return () => {
        listeners.delete(setValue);
      };
    }, []);
    return value;
  }

export { cancelLibrary, libraryProgress, librarySources, librarySummary, startLibrary, useLibraryProgress };
