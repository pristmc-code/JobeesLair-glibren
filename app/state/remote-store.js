// Fase 4: a abertura da loja com o catalogo do payload (state/catalog-remote.js) ou, sem ele, montada aqui como antes
// (state/catalog.js). index.jsx chama beginRemoteStore no corpo do modulo, antes do primeiro quadro: no console a montagem
// local comeca num timer e e segurada ate a sonda responder.
//
// Ligado: as opcoes dos filtros (/options), as fileiras da pagina inicial (/home, aqui em remoteHome() para browse/Lanes.jsx,
// featured.js, PopularRail.jsx e CdnRail.jsx) e as cartas fixas dos jogos que o app ja conhece pelo codigo (a fila de
// downloads, os vistos e os favoritos: /cards) chegam antes de a loja abrir; as fichas da fila tambem (os links que a fila
// le em getGame(id).releases). Qualquer falha nisso (ou depois, com a loja aberta) = a loja montada aqui, transparente.

import { DATA_DIR } from './data-dir.js';
import { holdCatalogBuild, isRemoteCatalog, onLocalCatalog, openRemoteStore, setLocalDisabler, setRemoteLookup, startCatalogBuild } from './catalog.js';
import { createConsoleRemoteCatalog, setRemoteCatalog } from './catalog-remote.js';
import { loadList } from './saved.js';
import { readJSON } from './read-json.js';
import { isoDate } from './clock.js';
import { TITLE_ID } from '../version.js';
import { memorySample } from './memory-meter.js';
import { BUSY } from './download-queue.js';

  // = browse/ContinueRow.jsx: os jobs que ainda vao baixar (precisam dos links do jogo)
  var UNFINISHED = [...BUSY, "paused", "failed"];

  var homeRows = null;
  var counts = null; // { titles, direct } do catalogo do payload (state/library-count.js)
  var openedWith = ""; // "payload" | "app" | ""
  var why = "";
  /** As fileiras da pagina inicial vindas do payload, ou null (a loja montada aqui). */
  var remoteHome = () => homeRows;
  /** Fase 4: o contador da loja com o catalogo do payload ({ titles, direct }), ou null (o de sempre, state/library-count.js). */
  var remoteCounts = () => isRemoteCatalog() ? counts : null;
  /** Como a loja abriu: { with: "payload" | "app" | "", reason }. */
  var remoteStoreState = () => ({ with: openedWith, reason: why });
  // Os jogos que o app ja conhece pelo codigo: a fila de downloads (todos os jobs; os que nao acabaram com a ficha), os
  // vistos e os favoritos.
  function knownIds(fs) {
    const jobs = [];
    for (const path of [`/data/ps5-react/${TITLE_ID}/queue/downloads.json`, `${DATA_DIR}/JobeesLair/downloads.json`]) {
      const saved = readJSON(fs, path, null, (value) => value?.version === 1 && Array.isArray(value.jobs), () => {});
      if (saved) {
        jobs.push(...saved.jobs);
        break;
      }
    }
    const open = jobs.filter((job) => job && typeof job.gameId === "string" && UNFINISHED.includes(job.state)).map((job) => job.gameId);
    const all = jobs.map((job) => job?.gameId).filter((id) => typeof id === "string");
    let recent = [], wishlist = [];
    try {
      recent = loadList("recent.json", "recently viewed");
      wishlist = loadList("wishlist.json", "wishlist");
    } catch {
    }
    return { open: [...new Set(open)].slice(0, 32), cards: [...new Set([...all, ...recent, ...wishlist])] };
  }
  var torboxSaved = () => {
    try {
      return loadList("settings.json", "settings").storeMode === "torbox";
    } catch {
      return false;
    }
  };
  function local(reason) {
    openedWith = "app";
    why = reason;
    homeRows = null;
    startCatalogBuild();
    return false;
  }
  /**
   * Na abertura (index.jsx): no PS5 e sem a loja TorBox escolhida, segura a montagem local e pergunta ao payload.
   * -> a promessa de true (abriu com o payload) ou false (montada aqui). `seed`: o sorteio do carrossel desta abertura.
   */
  function beginRemoteStore({ http, fs, platform, seed = Math.random() * 4294967296 >>> 0, log = (text) => console.log(text), client: given = null }) {
    if (!given && (platform !== "ps5" || !http || !fs)) return Promise.resolve(false);
    if (torboxSaved()) {
      why = "torbox";
      return Promise.resolve(false);
    }
    holdCatalogBuild();
    const client = given ?? createConsoleRemoteCatalog({ http, fs, log });
    setRemoteCatalog(client);
    setRemoteLookup(client.lookup);
    setLocalDisabler((reason) => client.disable(reason));
    // O payload caiu (ou ficou over-limit) com a loja aberta: monta aqui; ao terminar, store-mode.js refaz a loja.
    client.listen((on, reason) => {
      if (!on && isRemoteCatalog()) {
        log(`[remote-store] the payload's catalog went away (${reason}): building the store in the app`);
        local(reason);
      }
    });
    const started = Date.now();
    return (async () => {
      try {
        if (!await client.probe()) return local(client.status().reason);
        const options = await client.options();
        const rows = options && await client.home(seed, isoDate(Date.now()));
        const ids = knownIds(fs);
        const pinned = rows && await client.cards(ids.cards, { pin: true });
        if (!pinned) return local(client.status().reason || "error");
        for (const id of ids.open) {
          const ficha = await client.game(id, { pin: true });
          if (ficha === null) return local(client.status().reason || "error");
        }
        homeRows = rows;
        counts = { titles: options.shown ?? 0, direct: (options.counts?.access ?? []).find((option) => option.value === "direct")?.count ?? 0 };
        if (!openRemoteStore(options)) {
          homeRows = null;
          return false;
        }
        openedWith = "payload";
        memorySample("loja:payload-aberta");
        log(`[remote-store] the store opened with the payload's catalog in ${Date.now() - started} ms (${pinned.length} known games, ${ids.open.length} in the queue)`);
        return true;
      } catch (error) {
        log(`[remote-store] ${error?.message || error}`);
        client.disable("error");
        return local("error");
      }
    })();
  }
  // A loja montada aqui depois de ter aberto com o payload: as fileiras voltam a ser as dela.
  onLocalCatalog(() => {
    homeRows = null;
  });

export { beginRemoteStore, knownIds, remoteCounts, remoteHome, remoteStoreState };
