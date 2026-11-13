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
import { allListed, catalogSources, editionsOf, refreshDerived, sourcesOfGame, whenCatalogReady } from './catalog.js';
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
  // glibren.25: os catálogos escondidos da loja (Configurações > Feeds, "Mostrar na loja"; settings.json
  // `hiddenSources`: "bundled", o endereço do feed ao vivo ou de um feed, o arquivo da lista Orbit Store). O feed
  // continua incluído e atualizado; só os jogos que vêm apenas de catálogos escondidos saem da loja (as duas versões).
  var hidden = /* @__PURE__ */ new Set();
  try {
    const saved = loadList(SETTINGS, "settings").hiddenSources;
    if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string") hidden.add(id);
  } catch {
  }
  /** Os jogos listados dos catálogos que a loja mostra. */
  var shownListed = () => hidden.size ? allListed.filter((game) => sourcesOfGame(game).some((source) => !hidden.has(source))) : allListed;
  var sourceShown = (id) => !hidden.has(id);
  // glibren.26: muda a cada catálogo mostrado/escondido (o contador de títulos refaz a conta).
  var hiddenVersion = 0;
  var shownVersion = () => hiddenVersion;
  /** glibren.26: avisa `listener` quando a loja muda (versão ou catálogos mostrados), fora de um componente. */
  function subscribeStore(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
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
    let list = shownListed();
    if (next === "torbox") {
      const ids = confirmedIds();
      if (!ids) return { ok: false, reason: "never" };
      list = torBoxGames(ids, list);
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
   * glibren.25: mostra ou esconde da loja os jogos de um catálogo (`id` de catalogSources) e refaz a loja na versão
   * de agora. -> { ok, reason } ("last": seria o último catálogo mostrado; "empty": a loja TorBox ficaria vazia).
   */
  function setSourceShown(id, on) {
    const before = new Set(hidden);
    if (on) hidden.delete(id);
    else {
      if (!catalogSources().some((source) => source.id !== id && !hidden.has(source.id))) return { ok: false, reason: "last" };
      hidden.add(id);
    }
    let result = applyStoreMode(mode, { save: false });
    if (!result.ok && mode === "torbox") {
      hidden.clear();
      for (const kept of before) hidden.add(kept);
      applyStoreMode(mode, { save: false });
      return result;
    }
    hiddenVersion++;
    notify();
    try {
      saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), hiddenSources: [...hidden] });
    } catch (error) {
      console.log(`[store-mode] hidden catalogs not saved: ${error?.message || error}`);
    }
    return result;
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
      confirmedCount = ids ? torBoxGames(ids, shownListed()).length : 0;
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
  // glibren.45: com a loja pronta (state/catalog.js whenCatalogReady: na hora, ou no console depois da montagem em partes).
  // Montada em partes, os módulos que tiraram linhas e índices da lista enquanto ela estava vazia refazem os seus
  // (applyStoreMode chama os onStoreMode), antes de a loja aparecer.
  whenCatalogReady((paced) => {
    let applied = false;
    try {
      const saved = loadList(SETTINGS, "settings").storeMode;
      if (saved === "torbox") {
        applied = true;
        if (!applyStoreMode("torbox", { save: false }).ok) {
          console.log("[store-mode] the TorBox store has no games; the full store is shown");
          applied = false;
        }
      }
      // glibren.25: com catálogos escondidos, a loja completa já sai sem eles (todos escondidos não acontece: o último fica).
      if (mode === "full" && hidden.size) {
        if (!catalogSources().some((source) => !hidden.has(source.id))) hidden.clear();
        applyStoreMode("full", { save: false });
        applied = true;
      }
    } catch (error) {
      console.log(`[store-mode] saved choice not read: ${error?.message || error}`);
    }
    if (paced && !applied) applyStoreMode(mode, { save: false });
  });

export { MODES, applyStoreMode, setSourceShown, shownVersion, sourceShown, subscribeStore, libraryChanged, onStoreMode, storeEpoch, storeMode, toggleStoreMode, torBoxGames, torBoxStoreCount, useStoreMode };
