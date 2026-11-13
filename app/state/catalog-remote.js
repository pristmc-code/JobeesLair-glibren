// Fase 4 (Orbit): a TV pede as paginas da loja ao catalogo do payload (bg_catalog*.c, API local 127.0.0.1:34200, rotas
// /api/catalog*, BG_API >= 37) em vez de montar o catalogo inteiro na memoria do app.
//
// Na abertura (index.jsx, so no PS5): a montagem local fica segura (state/catalog.js holdCatalogBuild) enquanto a sonda
// pergunta ao payload; ligado, o app pega as opcoes dos filtros (/options), as fileiras da pagina inicial (/home) e as
// cartas dos jogos que ele ja conhece pelo codigo (fila de downloads, vistos, favoritos: /cards) e abre a loja sem montar
// nada (state/catalog.js openRemoteStore). Desligado, monta como antes.
// As telas (browse/Catalog.jsx, search/index.jsx, browse/FilterDrawer.jsx, browse/Lanes.jsx e vizinhas, a ficha) pedem
// pagina por pagina aqui.
//
// Fallback (transparente): qualquer coisa fora do normal desliga o modo remoto PARA ESTA ABERTURA e o app monta a loja
// dele como antes (state/catalog.js startCatalogBuild; ao terminar a loja e montada de novo):
//   - sem payload (sem token, /health sem resposta)                 -> "no-payload"
//   - payload antigo (api < CATALOG_MIN_API, sem as rotas)           -> "old-api"
//   - catalogo "over-limit" (503 com error "over-limit")            -> "over-limit"
//   - catalogo sem dados / ainda montando (no-data / not-ready)      -> "not-ready" (so na sonda: espera ate
//     PROBE_WAIT_MS e entao o app monta o dele)
//   - qualquer erro de rede ou 5xx depois de ligado                  -> "error"
//   - a loja TorBox escolhida (store-mode "torbox")                  -> "torbox" (a lista dela e do app)
// Desligado nao religa sozinho na mesma abertura.
//
// Memoria: so o que esta na tela e perto dela. PAGE jogos por pagina, no maximo KEPT_PAGES paginas guardadas (LRU, a
// chave e a assinatura do catalogo + a consulta + o deslocamento), KEPT_GAMES fichas e KEPT_CARDS cartas soltas (as que
// getGame acha), mais as fixas (fila, vistos, favoritos, pagina inicial). Nada do catalogo inteiro.
//
// O que continua no app (ver ESTUDO, Andamento Fase 4): a loja TorBox, a saude dos links, o historico de capturas na ordem
// dos links e os videos dos feeds.

import { coverSize } from '../data/catalog-index.js';

  var CATALOG_MIN_API = 37; // BG_API 37: /api/catalog/cards, cartas com metacritic/providers/platforms/features/work, arte na pagina inicial
  var PAGE = 48; // = browse/Catalog.jsx BATCH (6 colunas x 8 linhas)
  var KEPT_PAGES = 8;
  var KEPT_GAMES = 16;
  var KEPT_CARDS = 400;
  var CARDS_PER_ASK = 60; // o caminho do pedido cabe em 1024 bytes no payload
  var PROBE_WAIT_MS = 4e3;

  // As chaves dos filtros do app (state/catalog.js FACETS) que o payload entende com o mesmo nome (ct_query_parse).
  var REMOTE_FACETS = ["platform", "format", "access", "genre", "feature", "release", "size", "provider"];

  /** Os filtros do app -> a consulta do payload (a mesma que tools/fase3/parity.mjs usa). null = o payload nao sabe
   * responder (os Favoritos so o app conhece): quem chamou filtra as cartas dos favoritos (catalog.js filterList). */
  function remoteQuery({ filters = {}, query = "", sort = "relevance" } = {}) {
    if (filters.wishlist) return null;
    const pairs = [["sort", sort]];
    for (const key of REMOTE_FACETS) {
      const picked = filters[key];
      if (picked?.length) pairs.push([key, picked.join(",")]);
    }
    if (String(query).trim()) pairs.push(["q", String(query)]);
    return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  }

  /** Uma carta do payload (bg_catalog_query.c ct_card) com o desenho que GameCard, os filtros e as ordens leem de um jogo. */
  function cardToGame(card) {
    const art = { ...card.art ?? {}, cover: card.cover ? coverSize(card.cover) : "", tint: card.tint ?? card.art?.tint };
    if (!art.tint) delete art.tint;
    return {
      id: card.id,
      titleId: card.id,
      title: card.title,
      platform: card.platform,
      platforms: card.platforms ?? [card.platform],
      formats: card.formats ?? [],
      ready: Boolean(card.ready),
      direct: Boolean(card.direct),
      sizeGb: card.sizeGb ?? void 0,
      stars: card.stars ?? void 0,
      ratingCount: card.ratingCount ?? void 0,
      metacritic: card.metacritic ?? void 0,
      providers: card.providers ?? [],
      features: card.features ?? [],
      work: card.work ?? void 0,
      recommendations: card.recommendations ?? void 0,
      pos: card.pos ?? 0,
      year: card.year ?? void 0,
      releaseDate: card.releaseDate ?? "",
      genres: card.genres ?? [],
      developer: card.developer ?? "",
      publisher: card.publisher ?? "",
      ...card.summary != null ? { summary: card.summary } : {},
      art,
      about: [],
      shots: [],
      videos: [],
      shortDescription: "",
      remote: true
    };
  }
  /** A ficha do payload (bg_catalog_game.c ct_game) como o jogo que game/index.jsx, os downloads e a Biblioteca leem. */
  function fichaToGame(data) {
    const game = cardToGame(data.game);
    const page = data.page ?? {};
    return Object.assign(game, {
      developer: data.game.developer ?? "",
      publisher: data.game.publisher ?? "",
      addedAt: data.game.addedAt ?? void 0,
      listed: data.game.listed !== false,
      sources: data.game.sources ?? [],
      about: page.about ?? [],
      shots: page.shots ?? [],
      videos: page.videos ?? [],
      shortDescription: page.summary ?? "",
      summary: data.summary ?? page.summary ?? "",
      art: { ...data.art ?? {}, cover: data.art?.cover ? coverSize(data.art.cover) : game.art.cover, ...data.art?.coverFallbacks ? { coverFallbacks: data.art.coverFallbacks.map(coverSize) } : {} },
      releases: data.releases ?? [],
      editionList: data.editions ?? [{ id: game.id, platform: game.platform, listed: true }],
      related: (data.related ?? []).map(cardToGame),
      full: true
    });
  }

  // Um mapa com limite: o mais antigo sai quando passa (get renova).
  function lru(limit) {
    const map = /* @__PURE__ */ new Map();
    return {
      get(key) {
        if (!map.has(key)) return void 0;
        const value = map.get(key);
        map.delete(key);
        map.set(key, value);
        return value;
      },
      peek: (key) => map.get(key),
      set(key, value) {
        map.delete(key);
        map.set(key, value);
        while (map.size > limit) map.delete(map.keys().next().value);
      },
      clear: () => map.clear(),
      get size() {
        return map.size;
      }
    };
  }

  /**
   * `http`: { request(url, {method, headers, maxBytes}) -> {status, json()} } (o Http do ps5-react); `readToken()`: o token
   * do payload ("" sem payload); `log(text)`. Um cliente por abertura (index.jsx).
   */
  function createRemoteCatalog({ http, readToken, port = 34200, log = () => {}, minApi = CATALOG_MIN_API, waitMs = PROBE_WAIT_MS, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    const base = `http://127.0.0.1:${port}`;
    let state = "unknown"; // unknown | on | off
    let reason = "";
    let key = ""; // "payload-<assinatura>": muda quando o payload monta um catalogo novo
    const pages = lru(KEPT_PAGES);
    const fichas = lru(KEPT_GAMES);
    const cardsKept = lru(KEPT_CARDS);
    const pinned = /* @__PURE__ */ new Map(); // os jogos da fila, dos vistos, dos favoritos e da pagina inicial
    const listeners = /* @__PURE__ */ new Set();
    const stats = { requests: 0, hits: 0 };
    const tell = (on, why) => {
      for (const fn of [...listeners]) {
        try {
          fn(on, why);
        } catch {
        }
      }
    };

    async function get(path) {
      const token = readToken();
      if (!token) throw Object.assign(new Error("no payload"), { why: "no-payload" });
      stats.requests++;
      const response = await http.request(`${base}${path}`, { method: "GET", headers: { "X-Jobe-Token": token }, maxBytes: 4 * 1024 * 1024 });
      let data = {};
      try {
        data = await response.json() ?? {};
      } catch {
      }
      return { status: response.status, data };
    }
    function off(why) {
      if (state === "off") return false;
      state = "off";
      reason = why;
      pages.clear();
      fichas.clear();
      log(`[catalog-remote] off (${why}): the store is built by the app`);
      tell(false, why);
      return false;
    }
    /** Uma vez na abertura: liga o modo remoto ou desliga com o motivo. -> true ligado. */
    async function probe() {
      if (state !== "unknown") return state === "on";
      const started = now();
      try {
        const health = await get("/health");
        if (health.status !== 200 || !health.data?.ok) return off("no-payload");
        if (!Number.isInteger(health.data.api) || health.data.api < minApi) return off("old-api");
        for (;;) {
          const answer = await get("/api/catalog/status");
          if (answer.status === 404) return off("old-api");
          const s = answer.data?.state;
          if (answer.status === 200 && s === "ready") {
            key = answer.data.key ?? "";
            break;
          }
          if (s === "over-limit") return off("over-limit");
          if (s === "failed") return off("error");
          if (now() - started >= waitMs) return off("not-ready");
          await sleep(250);
        }
      } catch (error) {
        return off(error?.why ?? "no-payload");
      }
      state = "on";
      log(`[catalog-remote] on (${key}) after ${now() - started} ms`);
      tell(true, "");
      return true;
    }
    // Um pedido com o modo ligado: 503 / 5xx / rede -> desliga (o chamador recebe null e usa o caminho local).
    async function ask(path) {
      if (state !== "on") return null;
      let answer;
      try {
        answer = await get(path);
      } catch (error) {
        return off(error?.why ?? "error") || null;
      }
      if (answer.status === 503) return off(answer.data?.error === "over-limit" ? "over-limit" : "error") || null;
      if (answer.status === 404 && answer.data?.error === "not-found") return { notFound: true };
      if (answer.status !== 200 || !answer.data?.ok) return off("error") || null;
      return answer.data;
    }
    const keep = (game) => {
      if (!pinned.has(game.id) || !pinned.get(game.id).full) cardsKept.set(game.id, game);
      return game;
    };
    /** A pagina que comeca em `offset` (PAGE jogos) da grade (`route` "" ) ou da tela Procurar ("search"): { games, total, offset } ou null. */
    async function page(view, offset = 0, route = "") {
      const query = remoteQuery(view);
      if (query === null) return null;
      const cacheKey = `${key}|${route}|${query}|${offset}`;
      const kept = pages.get(cacheKey);
      if (kept) {
        stats.hits++;
        return kept;
      }
      const data = await ask(`/api/catalog${route ? `/${route}` : ""}?${query}&offset=${offset}&limit=${PAGE}`);
      if (!data || data.notFound) return null;
      const result = { games: (data.games ?? []).map((card) => keep(cardToGame(card))), total: data.total ?? 0, offset };
      pages.set(cacheKey, result);
      return result;
    }
    /** As opcoes e (com filtros) as contagens dos filtros para a vista, ou null. */
    async function options(view = {}) {
      const query = remoteQuery(view);
      if (query === null) return null;
      return ask(`/api/catalog/options?${query}`);
    }
    /** As cartas de `ids` (na ordem), guardadas; `pin`: ficam enquanto o app roda (fila, vistos, favoritos). null = desligado. */
    async function cards(ids, { pin = false } = {}) {
      const want = [...new Set(ids.filter((id) => typeof id === "string" && id))];
      // o que ja esta guardado sai daqui antes de pedir o resto (guardar o resto pode tirar uma carta antiga do LRU)
      const found = /* @__PURE__ */ new Map();
      for (const id of want) {
        const game = pinned.get(id) ?? cardsKept.peek(id);
        if (game) found.set(id, game);
      }
      const missing = want.filter((id) => !found.has(id));
      for (let at = 0; at < missing.length; at += CARDS_PER_ASK) {
        const data = await ask(`/api/catalog/cards?ids=${missing.slice(at, at + CARDS_PER_ASK).map(encodeURIComponent).join(",")}`);
        if (!data) return null;
        for (const card of data.games ?? []) {
          const game = cardToGame(card);
          found.set(game.id, game);
          if (pin) pinned.set(game.id, game);
          else cardsKept.set(game.id, game);
        }
      }
      const out = [];
      for (const id of want) {
        const game = found.get(id);
        if (!game) continue;
        if (pin && !pinned.has(id)) pinned.set(id, game);
        out.push(game);
      }
      return out;
    }
    /** A ficha como jogo (bg_catalog_game.c), guardada; null = desligado; { notFound: true } = o payload nao conhece. */
    async function game(id, { pin = false } = {}) {
      const kept = fichas.get(`${key}|${id}`);
      if (kept) {
        stats.hits++;
        return kept;
      }
      const data = await ask(`/api/catalog/game?id=${encodeURIComponent(id)}`);
      if (!data || data.notFound) return data;
      const full = fichaToGame(data);
      // as outras edicoes (a escolha de versao, catalog.js editionsOf): as cartas delas
      const others = full.editionList.map((edition) => edition.id).filter((other) => other !== id);
      if (others.length && !await cards(others)) return null;
      fichas.set(`${key}|${id}`, full);
      if (pin || pinned.has(id)) pinned.set(id, full);
      return full;
    }
    /** As fileiras da pagina inicial (bg_catalog_query.c ct_home) com as cartas como jogos; as cartas ficam fixas. */
    async function home(seed, today) {
      const data = await ask(`/api/catalog/home?seed=${seed >>> 0}&today=${encodeURIComponent(today)}`);
      if (!data) return null;
      const rows = {};
      for (const name of ["carousel", "featured", "recent", "top", "newWeek", "ready", "popular", "cdn"]) {
        rows[name] = (data[name] ?? []).map((card) => {
          const g = cardToGame(card);
          const had = pinned.get(g.id);
          // a ficha guardada vale mais que a carta; a arte da pagina inicial (hero, logo) entra na carta guardada
          if (had?.full) return had;
          if (had) {
            Object.assign(had.art, g.art);
            if (g.summary != null) had.summary = g.summary;
          }
          if (!had) pinned.set(g.id, g);
          return had ?? g;
        });
      }
      // GenreRail: { genre, count, covers } (as capas como cartas soltas, guardadas)
      rows.genres = (data.genres ?? []).map(({ genre, count, covers }) => ({ genre, count, covers: (covers ?? []).map((card) => pinned.get(card.id) ?? keep(cardToGame(card))) }));
      rows.newWeekCount = data.newWeekCount ?? rows.newWeek.length;
      rows.readyCount = data.readyCount ?? rows.ready.length;
      return rows;
    }
    /** O jogo `id` se o app ja tem algo dele (ficha, carta fixa ou guardada), sem pedir nada: o getGame de state/catalog.js. */
    const lookup = (id) => {
      const full = fichas.peek(`${key}|${id}`);
      return full ?? pinned.get(id) ?? cardsKept.peek(id);
    };
    return {
      probe,
      page,
      options,
      cards,
      game,
      home,
      lookup,
      on: () => state === "on",
      status: () => ({ state, reason, key, keptPages: pages.size, keptGames: fichas.size, keptCards: cardsKept.size, pinned: pinned.size, ...stats }),
      /** `fn(on, reason)` quando liga ou desliga. -> desinscreve. */
      listen(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      disable: off
    };
  }

  // O cliente desta abertura (index.jsx o cria com o Http e o token do bg-downloader); sem ele, tudo segue local.
  var current = null;
  function setRemoteCatalog(client) {
    current = client;
    for (const fn of waiting) client?.listen(fn);
  }
  var remoteCatalog = () => current;
  var remoteCatalogOn = () => Boolean(current?.on());
  var waiting = /* @__PURE__ */ new Set();
  /** `fn(on, reason)` quando o cliente desta abertura liga ou desliga (vale tambem para o criado depois). */
  function onRemoteCatalog(fn) {
    waiting.add(fn);
    const stop = current?.listen(fn);
    return () => {
      waiting.delete(fn);
      stop?.();
    };
  }
  var TOKEN_FILE = "/data/JobeesLair/bg/token"; // = background-downloads.js STATE_DIR + /token
  /** O cliente do PS5: o token do bg-downloader no disco. */
  function createConsoleRemoteCatalog({ http, fs, log = (text) => console.log(text) }) {
    const readToken = () => {
      try {
        const value = String(fs.readFile(TOKEN_FILE) ?? "").trim();
        return /^[0-9a-f]{64}$/.test(value) ? value : "";
      } catch {
        return "";
      }
    };
    return createRemoteCatalog({ http, readToken, log });
  }

export { CATALOG_MIN_API, CARDS_PER_ASK, KEPT_CARDS, KEPT_GAMES, KEPT_PAGES, PAGE, PROBE_WAIT_MS, cardToGame, createConsoleRemoteCatalog, createRemoteCatalog, fichaToGame, onRemoteCatalog, remoteCatalog, remoteCatalogOn, remoteQuery, setRemoteCatalog };
