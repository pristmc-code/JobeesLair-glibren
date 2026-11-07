// glibren.9: as "versões da loja". "full" é a loja de sempre (todo o catálogo); "torbox" mostra só os jogos que a
// Biblioteca TorBox confirmou (state/torbox-library.js, Configurações > Biblioteca TorBox), com as mesmas telas e
// filtros: a lista da loja (data/catalog-index.js `games`, que todas as telas leem) é trocada no lugar pela dos
// confirmados, os módulos que guardam linhas prontas (Discover, busca) refazem as suas (onStoreMode), e a loja é
// montada de novo (index.jsx usa storeEpoch na chave da página). A escolha fica em settings.json (`storeMode`) e
// vale já na próxima abertura do app.
// Um jogo listado entra na loja TorBox se ele ou outra edição dele (PS4/PS5, state/catalog.js editionsOf) foi
// confirmado.

import { useEffect, useState } from 'react';
import { games } from '../data/catalog-index.js';
import { allListed, editionsOf, refreshDerived } from './catalog.js';
import { DATA_DIR } from './data-dir.js';
import { loadList, saveList } from './saved.js';
import { libraryPaths, readConfirmedIds } from './torbox-library.js';
import { FileSystem, Platform } from '@ps5-react/core';

  var MODES = ["full", "torbox"];
  var SETTINGS = "settings.json";
  var mode = "full";
  var epoch = 0;
  var confirmedCount = null;
  var rebuilders = [];
  var listeners = /* @__PURE__ */ new Set();
  var paths = () => libraryPaths(DATA_DIR, Platform.OS === "ps5");
  /** Os ids confirmados gravados (null: a biblioteca nunca foi montada). */
  function confirmedIds() {
    try {
      return readConfirmedIds(FileSystem, paths());
    } catch {
      return null;
    }
  }
  /** Os jogos da loja TorBox: os listados que têm (eles ou outra edição) um id confirmado. */
  function torBoxGames(ids, list = allListed) {
    return list.filter((game) => ids.has(game.id) || editionsOf(game).some((edition) => ids.has(edition.id)));
  }
  function notify() {
    for (const listener of listeners) listener();
  }
  /**
   * Põe a loja na versão `next`. -> { ok, reason } ("never": a biblioteca nunca foi montada; "empty": nenhum jogo
   * confirmado). A versão TorBox lê de novo a lista gravada, então ativar depois de montar já mostra o novo.
   */
  function applyStoreMode(next, { save = true } = {}) {
    if (!MODES.includes(next)) return { ok: false, reason: "unknown" };
    let list = allListed;
    if (next === "torbox") {
      const ids = confirmedIds();
      if (!ids) return { ok: false, reason: "never" };
      list = torBoxGames(ids);
      if (!list.length) return { ok: false, reason: "empty" };
    }
    confirmedCount = next === "torbox" ? list.length : confirmedCount;
    games.splice(0, games.length, ...list);
    mode = next;
    refreshDerived();
    for (const rebuild of rebuilders) {
      try {
        rebuild();
      } catch (error) {
        console.log(`[store-mode] rebuild failed: ${error?.message || error}`);
      }
    }
    epoch++;
    if (save) saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), storeMode: next });
    console.log(`[store-mode] ${next}: ${list.length} games`);
    notify();
    return { ok: true, reason: "" };
  }
  /**
   * glibren.14: o atalho R3 (ui/StoreKey.jsx): a outra versão da loja. -> { ok, reason, mode, count } (mode: a versão
   * em que a loja ficou; count: quantos jogos ela mostra agora).
   */
  function toggleStoreMode() {
    const next = mode === "full" ? "torbox" : "full";
    const { ok, reason } = applyStoreMode(next);
    return { ok, reason, mode, count: games.length };
  }
  /**
   * Um módulo que guarda o que tirou da lista da loja (as linhas do Discover, o índice da busca) refaz com
   * `rebuild` quando a versão muda; se a loja já está na versão TorBox, ele já leu a lista certa.
   */
  function onStoreMode(rebuild) {
    rebuilders.push(rebuild);
  }
  var storeMode = () => mode;
  var storeEpoch = () => epoch;
  /** Quantos jogos a loja TorBox tem (da última vez que foi lida), ou null. */
  function torBoxStoreCount() {
    if (confirmedCount === null) {
      const ids = confirmedIds();
      confirmedCount = ids ? torBoxGames(ids).length : 0;
    }
    return confirmedCount;
  }
  /** Depois de uma nova montagem: a contagem é lida de novo, e a loja TorBox aberta passa a mostrar a lista nova. */
  function libraryChanged() {
    confirmedCount = null;
    if (mode === "torbox") applyStoreMode("torbox", { save: false });
    else notify();
  }
  function useStoreMode() {
    const [, redraw] = useState(0);
    useEffect(() => {
      const listener = () => redraw((n) => n + 1);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);
    return { mode, epoch, count: torBoxStoreCount() };
  }
  // A versão escolhida antes, ao carregar: a lista da loja já sai certa para quem a lê depois.
  try {
    const saved = loadList(SETTINGS, "settings").storeMode;
    if (saved === "torbox" && !applyStoreMode("torbox", { save: false }).ok) console.log("[store-mode] the TorBox store has no games; the full store is shown");
  } catch (error) {
    console.log(`[store-mode] saved choice not read: ${error?.message || error}`);
  }

export { MODES, applyStoreMode, libraryChanged, onStoreMode, storeEpoch, storeMode, toggleStoreMode, torBoxGames, torBoxStoreCount, useStoreMode };
