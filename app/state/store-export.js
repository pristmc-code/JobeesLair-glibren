// glibren (item 2): a loja completa exportada para o payload (app/native/bg_store.c), que a serve na pagina do celular
// (busca, filtros, ordens, ficha e Baixar, inclusive com a Jobe fechada).
//
// Dois arquivos em STORE_DIR (no PS5 /data/JobeesLair/store, onde o payload le):
//   store-index.json  os jogos que a loja COMPLETA mostra (embutido + feeds + Orbit, sem os catalogos escondidos), na
//                     ordem da loja, com o que a lista, a busca e os filtros leem; `rank` = a posicao do jogo em cada
//                     ordem (SORTS) feita aqui, no motor do console: o payload ordena por ela e sai igual, inclusive o
//                     localeCompare dos titulos. `solo` = se o payload baixa o jogo sozinho (null ate store-games existir).
//   store-games.json  a ficha (resumo, texto, fotos, banner) e os links de cada jogo na ordem em que a Jobe os oferece
//                     (game/sources.js sourceOrder: o primeiro e o que o botao Baixar escolhe), com a `source` (indice na
//                     lista de links do jogo) e `solo` por link. A url so de um link solo: um link direto e publico do
//                     catalogo, de um arquivo so, que o payload baixa sem a Jobe (nada de debrid, pagina de host,
//                     navegador, torrent ou partes). Nenhuma chave ou link temporario vai para o disco.
// O indice e gravado logo (barato); o store-games, em segundo plano (le os links e a pagina de cada jogo, alguns
// milissegundos de cada vez), so quando a loja mudou (a chave e a do indice, sem o solo).

import { FileSystem, Platform } from '@ps5-react/core';
import { DATA_DIR } from './data-dir.js';
import { stableKey } from './feed-format.js';
import { FACETS, SORTS, allListed, ratingScore, readyHere, readyLabel, sortGames, sourcesOfGame } from './catalog.js';
import { sourceShown, subscribeStore } from './store-mode.js';
import { describeSource, isBackport, isDlc, sourceOrder } from '../game/sources.js';
import { sourceKind } from './download-sources.js';
import { linkHealth } from './links.js';
import { PS4 } from './ps4.js';
import { VERSION } from '../version.js';
import { exclusive } from './heavy-work.js';
import { isoStamp } from './clock.js';

  var STORE_DIR = Platform.OS === "ps5" ? "/data/JobeesLair/store" : `${DATA_DIR}/store`;
  var INDEX = `${STORE_DIR}/store-index.json`;
  var GAMES = `${STORE_DIR}/store-games.json`;
  // O que ja foi gravado: { key, solo: {id: bool} } (o store-games.json inteiro e grande demais para reler).
  var DONE = `${STORE_DIR}/store-games.done.json`;
  var FORMAT = 1;
  var SLICE_MS = 6;
  var CHUNK = 64 * 1024;

  /** Os jogos que a loja completa mostra (store-mode.js: sem os que so vem de catalogos escondidos). */
  var shownGames = () => allListed.filter((game) => sourcesOfGame(game).some((source) => sourceShown(source)));

  var text = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
  var https = (value) => typeof value === "string" && /^https:\/\/[^\s"'<>\\`]+$/.test(value) && value.length <= 600 ? value : "";

  /** O documento do store-index.json (sem gravar). `solo`: {id: bool} de um store-games da mesma loja, ou null. */
  function storeIndexDocument(list = shownGames(), solo = null) {
    const ranks = SORTS.map(({ id }) => new Map(sortGames(list, id).map((game, at) => [game, at])));
    const options = (key) => FACETS.find((facet) => facet.key === key)?.options ?? [];
    const named = (key) => options(key).map(({ value, name }) => ({ value, name: name ?? value }));
    const games = list.map((game) => ({
      id: game.id,
      code: game.id,
      title: game.title,
      platform: game.platform,
      s: `${game.title} ${game.developer} ${game.publisher}`.toLowerCase(),
      genres: game.genres ?? [],
      features: game.features ?? [],
      formats: game.formats ?? [],
      ready: Boolean(readyHere(game)),
      direct: Boolean(game.direct),
      providers: game.providers ?? [],
      year: game.year ?? null,
      sizeGb: game.sizeGb ?? null,
      stars: game.ratingCount ? game.stars : null,
      ratingCount: game.ratingCount ?? 0,
      score: Math.round(ratingScore(game) * 1e4) / 1e4,
      cover: https(game.art?.cover),
      developer: text(game.developer, 120),
      publisher: text(game.publisher, 120),
      releaseDate: game.releaseDate ?? "",
      rank: ranks.map((rank) => rank.get(game))
    }));
    const key = stableKey(JSON.stringify([FORMAT, VERSION, PS4, games]));
    for (const game of games) game.solo = solo ? solo[game.id] ?? false : null;
    return {
      version: FORMAT,
      key,
      builtAt: isoStamp(Date.now()),
      console: PS4 ? "ps4" : "ps5",
      readyFirmware: readyLabel("13.60"),
      facets: {
        platform: options("platform").map(({ value }) => value),
        format: options("format").map(({ value }) => value),
        access: options("access").map(({ value }) => value),
        genre: named("genre"),
        feature: named("feature"),
        release: options("release").map(({ value }) => value),
        size: options("size").map(({ value }) => value),
        provider: named("provider")
      },
      games
    };
  }

  /** Se o payload baixa este link sozinho: direto, publico, de um arquivo so, nem add-on nem backport, nem morto. */
  function soloLink(release) {
    if (!release || release.parts || release.debrid || release.manifestUrl || release.browserUrl || release.requiresBrowser) return false;
    if (release.unavailableReason || release.linkHealth?.status === "dead" || isDlc(release) || isBackport(release)) return false;
    if (typeof release.url !== "string" || !/^https?:\/\/[^\s"'<>\\`]+$/.test(release.url) || release.url.length > 1000) return false;
    if (!release.filename) return false;
    try {
      return sourceKind(release) === "direct";
    } catch {
      return false;
    }
  }

  /** A ficha e os links de um jogo como store-games.json os leva. */
  function storeGameEntry(game) {
    let releases = [];
    try {
      releases = linkHealth().overlay(game.releases);
    } catch {
      try {
        releases = game.releases;
      } catch {
        releases = [];
      }
    }
    const links = sourceOrder(releases).map((source) => {
      const release = releases[source];
      const solo = soloLink(release);
      let kind = "unavailable", host = "";
      try {
        ({ group: kind, host } = describeSource(release));
      } catch {
      }
      return {
        kind: release.parts ? "set" : kind,
        host: text(host || release.provider, 60),
        format: text(release.format, 16),
        size: Number.isSafeInteger(release.sizeBytes) ? release.sizeBytes : null,
        label: text(release.label, 120),
        filename: text(release.filename, 160),
        ...solo ? { url: release.url } : {},
        sha256: typeof release.sha256 === "string" ? release.sha256 : "",
        parts: release.parts?.length ?? 0,
        source,
        solo
      };
    });
    let about = [], shots = [], summary = "";
    try {
      about = (game.about ?? []).slice(0, 3).map((paragraph) => text(paragraph, 1500));
      shots = (game.shots ?? []).map(https).filter(Boolean).slice(0, 6);
      summary = text(game.shortDescription, 600);
    } catch {
    }
    let hero = "";
    try {
      hero = https(game.art?.hero);
    } catch {
    }
    return { id: game.id, summary, about, shots, hero, links };
  }

  var readJson = (path) => {
    try {
      return FileSystem.exists(path) ? JSON.parse(FileSystem.readFile(path)) : null;
    } catch {
      return null;
    }
  };
  var nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
  var running = null;
  var again = false;

  /**
   * Grava o indice (se a loja mudou) e, em segundo plano, a ficha e os links (store-games.json) de uma loja nova; depois
   * regrava o indice com o `solo` de cada jogo. -> Promise { key, games, written: "none"|"index"|"all" }.
   */
  function exportStore({ pause = nextFrame, log = (line) => console.log(line) } = {}) {
    if (running) {
      again = true;
      return running;
    }
    // glibren.38: nunca junto com a montagem da Biblioteca TorBox (state/heavy-work.js): uma espera a outra.
    running = exclusive(async () => {
      let result;
      do {
        again = false;
        result = await exportOnce(pause, log);
      } while (again);
      return result;
    }, { onWait: () => log('[store-export] waiting for the TorBox library build to finish') }).finally(() => {
      running = null;
    });
    return running;
  }
  async function exportOnce(pause, log) {
    const list = shownGames();
    const done = readJson(DONE);
    let doc = storeIndexDocument(list);
    const key = doc.key;
    const known = done?.key === key && done.solo ? done.solo : null;
    const onDisk = readJson(INDEX);
    if (known && onDisk?.key === key && onDisk.games?.[0]?.solo !== null) return { key, games: list.length, written: "none" };
    FileSystem.mkdir(STORE_DIR, { recursive: true });
    const writeIndex = (solo) => {
      doc = storeIndexDocument(list, solo);
      FileSystem.writeFile(`${INDEX}.tmp`, JSON.stringify(doc));
      FileSystem.rename(`${INDEX}.tmp`, INDEX);
      doc = null;
    };
    writeIndex(known);
    if (known) return { key, games: list.length, written: "index" };
    log(`[store-export] index of ${list.length} games written; details and links follow`);
    // store-games.json: o cabecalho com a chave antes dos jogos (o payload confere a chave sem ler o resto).
    const tmp = `${GAMES}.tmp`;
    FileSystem.writeFile(tmp, `{"version":${FORMAT},"key":${JSON.stringify(key)},"games":[`);
    const solo = {};
    let chunk = "", first = true, started = Date.now();
    for (const game of list) {
      const entry = storeGameEntry(game);
      solo[game.id] = entry.links.some((link) => link.solo);
      chunk += `${first ? "" : ","}${JSON.stringify(entry)}`;
      first = false;
      if (chunk.length >= CHUNK) {
        FileSystem.appendFile(tmp, chunk);
        chunk = "";
      }
      if (Date.now() - started >= SLICE_MS) {
        await pause();
        started = Date.now();
        // A loja mudou no meio (um catalogo escondido): comeca de novo com a lista nova.
        if (again) return { key, games: list.length, written: "index" };
      }
    }
    FileSystem.appendFile(tmp, `${chunk}]}`);
    FileSystem.rename(tmp, GAMES);
    FileSystem.writeFile(DONE, JSON.stringify({ key, solo }));
    writeIndex(solo);
    log(`[store-export] details and links of ${list.length} games written (${Object.values(solo).filter(Boolean).length} download with the app closed)`);
    return { key, games: list.length, written: "all" };
  }

  /** Na abertura (index.jsx, depois das capas): exporta e volta a exportar quando a loja muda (catalogo escondido). */
  function startStoreExport() {
    // So no PS5 (o payload so roda la) e com um runtime que grava em pedacos.
    if (Platform.OS !== "ps5" || typeof FileSystem.appendFile !== "function") return;
    const run = () => exportStore().catch((error) => console.log(`[store-export] failed: ${error?.message ?? error}`));
    void run();
    subscribeStore(() => void run());
  }

export { GAMES as STORE_GAMES, INDEX as STORE_INDEX, STORE_DIR, exportStore, soloLink, startStoreExport, storeGameEntry, storeIndexDocument };
