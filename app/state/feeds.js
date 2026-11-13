// Catalog feeds the player added in Settings: the list (feeds.json), each feed's last good copy (one
// cache file per feed, in feed form) and its refresh state. The catalog reads the caches once, as it
// loads (state/catalog.js), so what a refresh brings in is shown from the next launch.
//
// A feed is its address plus any number of mirrors: other addresses serving the same feed. A feed that
// lists its own `mirrors` brings them along; the player can add more (feed-mirrors.json), from the
// console or the phone. A refresh tries the address that worked last first, then the feed's own address,
// then the mirrors, and stops at the first that gives a usable feed. So a feed whose domain is taken down
// keeps refreshing from a mirror, and when every address is down the last good copy on the console is
// kept. Nothing here touches the download handlers: a feed only ever supplies catalog records.
//
// glibren.14: a feed can also be a .json file on the console (state/local-feed.js): its entry in feeds.json is the
// file's path. It is read from the disk at every launch, as the catalog loads (so an edited file shows the next time
// the app opens), and again on Refresh feeds. A file that is missing or unreadable (its drive unplugged) keeps its
// link and the games of its last good read, as a feed whose every address is down keeps its last good copy. Removing
// the link never touches the file itself. No mirrors for a file.

import { useEffect, useState } from 'react';
import { MAX_MIRRORS, feedDocument, feedTextSteps, parseFeed, parseFeedAsync, checkFeedTextAsync, parseFeedText, stableKey, stableKeyAsync } from './feed-format.js';
import { isoStamp } from './clock.js';
import { readJlxAsync } from './jlx.js';
import { askListsHome, listsAddress, listsGone } from './lists-home.js';
import { DATA_DIR, LEGACY_DATA_DIR } from './data-dir.js';
import { webURL } from './download-sources.js';
import { checkLocalPath, isLocalFeed } from './local-feed.js';
import { ORBIT_FEED, onOrbitFeed, orbitFeedOn, orbitFeedReady, requestOrbitRefresh } from './orbit-feed.js';
import { savedList } from './saved.js';
import { memorySample } from './memory-meter.js';
import { FileSystem, Http } from '@ps5-react/core';

  // The JS heap is 32 MiB for everything: a few modest feeds, each read whole. glibren.14: no longer three of the
  // player's own; MAX_FEEDS is only a safety ceiling, far above what anyone links.
  // glibren.20: 8 MiB por feed (eram 2 MiB): a lista Orbit Store tem ~3,2 MB com descricao e fundo, e um feed de 5000
  // jogos chega perto de 7 MB. Pesa no heap do console: testar no PS5 antes de subir mais.
  var MAX_FEEDS = 50, MAX_BYTES = 8 * 1024 * 1024;
  var TOO_BIG = "The file is larger than 8 MiB.";
  // glibren.26: o transporte HTTP do console recusa maxBytes acima de 4 MiB (ps5-react network_api.cpp:
  // "invalid method/body/maxBytes/binary"). Da glibren.20 a .25 o pedido de 8 MiB fazia TODO feed da web falhar no
  // PS5, inclusive o catalogo ao vivo (live.jlx, ~1,8 MB): a loja parou de receber jogos novos. 8 MiB fica so para
  // arquivos do PS5 (a lista Orbit Store e os .json escolhidos).
  var NET_MAX_BYTES = 4 * 1024 * 1024;
  // MODIFIED (0.5.1): the live catalog, built every few hours from the public Pegasus catalogs
  // (tools/catalog/live-feed.mjs, .github/workflows/catalog-live.yml): games and links newer than this build's
  // bundled catalog. Every console reads it like a feed the player added, without being listed in Settings,
  // so a game added there shows up in the store the next time Jobee'sLair starts.
  var LIVE_FEED = "https://raw.githubusercontent.com/JVK3R/JobeesLair/main/catalog/live.json";
  // MODIFIED (0.5.7): the live catalog is published as JLX1 (state/jlx.js), as ps5/live.jlx in a repository of its
  // own, apart from the app's releases; live.json is gone. LIVE_FEED stays its name, so its release ids (and the
  // downloads started from them) are the same as before. Its address is under the lists' home (state/lists-home.js):
  // github.com/JVK3R/JobeesLair-Lists, or the place api.jobees.org names when that answers the file is not there.
  var LIVE_PATH = "ps5/live.jlx";
  var liveSource = () => listsAddress(LIVE_PATH);
  // The feeds read and refreshed: the live catalog first, then the player's.
  // glibren.20: e a lista Orbit Store (um arquivo que o payload grava), so com a opcao ligada.
  // glibren.27: a lista Orbit por ultimo: um jogo que so um feed do jogador tem e conhecido (o payload grava so os links
  // dele) e precisa ja estar no catalogo, com a pagina do feed, quando os links da Orbit chegam (state/catalog.js).
  var allFeeds = () => [LIVE_FEED, ...feedList.get().filter((url) => url !== LIVE_FEED && url !== ORBIT_FEED), ...orbitFeedOn() ? [ORBIT_FEED] : []];
  // glibren.27: a lista Orbit gravada sem os codigos conhecidos (inteira) fica de fora ate o payload regravar.
  var ORBIT_WAIT = "Waiting for the payload to rewrite the list for this version.";
  var DIR = `${DATA_DIR}/feeds`;
  // Caches an earlier build left in the old data folder are read until the feed refreshes into this one.
  var LEGACY_DIR = `${LEGACY_DATA_DIR}/feeds`;
  var feedList = savedList("feeds.json", "feeds");
  // The player's mirrors, by feed address: { "<feed url>": ["<mirror url>", …] }.
  var mirrorStore = savedList("feed-mirrors.json", "feed mirrors");
  var cacheFile = (url) => `${DIR}/${stableKey(url)}.json`;
  function readCache(url) {
    for (const path of [cacheFile(url), `${LEGACY_DIR}/${stableKey(url)}.json`]) {
      try {
        const cache = JSON.parse(FileSystem.readFile(path));
        if (cache?.url === url && cache.document) return cache;
      } catch {
      }
    }
    return null;
  }
  // glibren.27: o cache de um feed da web como TEXTO: o cabecalho (o que vem antes de "document") lido a parte e o
  // documento deixado no texto, para parseFeedText ler um jogo por vez. Antes o cache inteiro virava uma arvore
  // (JSON.parse) e depois a copia validada, as duas no heap ao mesmo tempo. null quando nao ha cache dele.
  var DOCUMENT_KEY = ',"document":';
  function readWebCache(url) {
    for (const path of [cacheFile(url), `${LEGACY_DIR}/${stableKey(url)}.json`]) {
      try {
        const text2 = FileSystem.readFile(path);
        const at = typeof text2 === "string" ? text2.indexOf(DOCUMENT_KEY) : -1;
        const end = at < 0 ? -1 : text2.lastIndexOf("}");
        if (end <= at) continue;
        const head = JSON.parse(`${text2.slice(0, at)}}`);
        if (head?.url === url) return { cache: head, text: text2, from: at + DOCUMENT_KEY.length, to: end };
      } catch {
      }
    }
    return null;
  }
  // glibren.27: o cache gravado sem montar uma segunda copia do documento: o cabecalho e depois o texto em pedacos
  // (FileSystem.appendFile). Sem appendFile (um runtime antigo), de uma vez, como antes.
  var WRITE_SLICE = 256 * 1024;
  function writeCacheText(path, head, text2) {
    if (typeof FileSystem.appendFile !== "function") {
      FileSystem.writeFile(path, `${head}${DOCUMENT_KEY}${text2}}`);
      return;
    }
    FileSystem.writeFile(path, `${head}${DOCUMENT_KEY}`);
    for (let at = 0; at < text2.length; at += WRITE_SLICE) FileSystem.appendFile(path, text2.slice(at, at + WRITE_SLICE));
    FileSystem.appendFile(path, "}");
  }
  // What the catalog loaded from each feed this launch, by URL: a later refresh that differs needs a restart.
  var loaded = /* @__PURE__ */ new Map();
  // Each feed's last good copy, summarized for Settings ({ name, games, fetchedAt, from, mirrors }), so
  // drawing the list never reads a cache file.
  var meta = /* @__PURE__ */ new Map();
  // What each feed's last good copy lists, as [id, direct] pairs: all the live game counter (state/library-count.js)
  // needs, kept apart from the games themselves so counting never touches a cache file.
  var indexes = /* @__PURE__ */ new Map();
  var indexVersion = 0;
  var setIndex = (url, games) => {
    indexes.set(url, games.map(({ game: game2 }) => [game2.id, game2.direct ? 1 : 0]));
    indexVersion++;
  };
  var summary = (cache) => ({ name: cache.name, games: cache.games, fetchedAt: cache.fetchedAt, from: cache.from ?? cache.url, mirrors: Array.isArray(cache.mirrors) ? cache.mirrors : [], hash: cache.hash, etag: typeof cache.etag === "string" ? cache.etag : null, stamp: typeof cache.stamp === "string" ? cache.stamp : null });
  // glibren.14: a linked file, read off the disk. Its size and time say whether it changed since the cached copy;
  // they also stand for its hash (`loaded` and the "reopen to see it" notice compare them).
  var stampOf = (info) => `${info.size ?? ""}:${info.modified ?? ""}`;
  function statLocal(path) {
    let info;
    try {
      info = FileSystem.stat(path);
    } catch (error2) {
      throw new Error(`File not readable (${error2.message}).`);
    }
    if (!info) throw new Error("File not found. Is its drive connected?");
    if (info.isDirectory) throw new Error("That is a folder, not a file.");
    if (typeof info.size === "number" && info.size > MAX_BYTES) throw new Error(TOO_BIG);
    return info;
  }
  // glibren.27: o texto de um arquivo do PS5, para parseFeedText ler um jogo por vez (a lista Orbit Store e os .json
  // do jogador): sem a arvore inteira do JSON.parse no heap de 32 MiB.
  function readLocalText(path) {
    let text2;
    try {
      text2 = FileSystem.readFile(path);
    } catch (error2) {
      throw new Error(`File not readable (${error2.message}).`);
    }
    if (typeof text2 !== "string") throw new Error("File not readable.");
    if (text2.length > MAX_BYTES) throw new Error(TOO_BIG);
    return text2;
  }
  function readLocalDocument(path) {
    let text2;
    try {
      text2 = FileSystem.readFile(path);
    } catch (error2) {
      throw new Error(`File not readable (${error2.message}).`);
    }
    if (typeof text2 !== "string") throw new Error("File not readable.");
    if (text2.length > MAX_BYTES) throw new Error(TOO_BIG);
    try {
      return JSON.parse(text2);
    } catch {
      throw new Error("Not JSON.");
    }
  }
  // The cache of a file's good read: the same form as a fetched feed's, with the file's stamp.
  // glibren.26: escrito de uma vez (um texto so de ~4 MB para a lista Orbit Store, nao o documento e depois uma segunda
  // copia dele emendada ao cabecalho), e o documento por ultimo, como antes (readCacheHead le so o que vem antes dele).
  function saveLocal(url, feed, stamp, text2 = null) {
    const cache = { url, from: url, hash: `file:${stamp}`, etag: null, stamp, fetchedAt: isoStamp(Date.now()), name: feed.name, games: feed.games.length, skipped: feed.skipped, mirrors: [] };
    try {
      FileSystem.mkdir(DIR, { recursive: true });
      // glibren.27: com o texto do arquivo, o cache leva o proprio texto em pedacos (writeCacheText), sem montar
      // feedDocument e um JSON.stringify de mais alguns MB ao lado.
      if (text2 !== null) writeCacheText(`${cacheFile(url)}.tmp`, JSON.stringify(cache).slice(0, -1), text2);
      else FileSystem.writeFile(`${cacheFile(url)}.tmp`, JSON.stringify({ ...cache, document: feedDocument({ ...feed, mirrors: [] }) }));
      FileSystem.rename(`${cacheFile(url)}.tmp`, cacheFile(url));
    } catch (error2) {
      console.log(`feeds: copy of ${url} not kept: ${error2.message}`);
    }
    meta.set(url, summary(cache));
    setIndex(url, feed.games);
    return cache;
  }
  // At launch: the file as it is on the disk now, or (missing, unreadable, not a feed) its last good read, with the
  // reason in its status. The cached copy stands in for the file when its stamp says nothing changed.
  // glibren.26: so o cabecalho de um cache (o que vem antes de "document"), sem montar o documento: um arquivo do PS5 que
  // mudou (a lista Orbit Store a cada revisao nova) e lido sem a copia antiga inteira montada ao lado no heap de 32 MiB.
  function readCacheHead(url) {
    for (const path of [cacheFile(url), `${LEGACY_DIR}/${stableKey(url)}.json`]) {
      try {
        const text2 = FileSystem.readFile(path);
        const at = typeof text2 === "string" ? text2.indexOf(',"document":') : -1;
        if (at < 0) continue;
        const head = JSON.parse(`${text2.slice(0, at)}}`);
        if (head?.url === url) return head;
      } catch {
      }
    }
    return null;
  }
  // glibren.45: na abertura os feeds sao lidos em partes (state/catalog.js da o quadro de volta entre elas): LOAD_BATCH
  // jogos entre duas olhadas no relogio. loadFeedGames() continua lendo tudo de uma vez.
  var LOAD_BATCH = 8;
  // glibren.27: o arquivo lido como texto (parseFeedText, um jogo por vez); o cache so quando o arquivo nao pode ser
  // lido, tambem como texto (readWebCache). O feed sai igual ao de antes.
  function* loadLocalSteps(url) {
    const cache = readCacheHead(url);
    let failure = null;
    try {
      const info = statLocal(url);
      const stamp = stampOf(info);
      let text2 = readLocalText(url);
      const feed = yield* feedTextSteps(text2, url, LOAD_BATCH);
      if (!feed.games.length) throw new Error("No usable games in this file.");
      if (cache && cache.stamp === stamp) {
        text2 = null;
        loaded.set(url, cache.hash);
        meta.set(url, { ...summary(cache), fetchedAt: isoStamp(Date.now()) });
        setIndex(url, feed.games);
        return feed;
      }
      const saved = saveLocal(url, feed, stamp, text2);
      text2 = null;
      loaded.set(url, saved.hash);
      console.log(`feeds: ${url}: read, ${feed.games.length} games, ${feed.skipped} skipped`);
      return feed;
    } catch (error2) {
      failure = error2;
    }
    console.log(`feeds: ${url} not read: ${failure.message}`);
    status.set(url, { state: "failed", error: failure.message });
    if (!cache) return null;
    const kept = readWebCache(url);
    if (!kept) return null;
    const feed = yield* feedTextSteps(kept.text, url, LOAD_BATCH, kept.from, kept.to);
    loaded.set(url, cache.hash);
    meta.set(url, summary(cache));
    setIndex(url, feed.games);
    return feed;
  }
  // Every listed feed's cached games, validated again: { game, page, releases } as parseFeed gives them.
  // The store ratings the feeds carry (0.5.1), [stars, count] by title ID; the live catalog's first, as it is listed first.
  var feedRatings = {};
  function* loadFeedGamesSteps() {
    const out = [];
    for (const url of allFeeds()) {
      // glibren (item 2): o que esta leitura deixou de cada feed (status, resumo, indice, notas), para o retrato da loja
      // (state/feed-snapshot.js) refazer igual na proxima abertura sem ler os feeds.
      const seen = () => states.push({ url, status: status.get(url) ?? null, meta: meta.get(url) ?? null, loaded: loaded.has(url) ? loaded.get(url) : null, index: indexes.get(url) ?? null, ratings: ratingsOf.get(url) ?? null });
      if (url === ORBIT_FEED && !orbitFeedReady()) {
        console.log(`feeds: ${url} not read: written without the known titles (the payload rewrites it)`);
        status.set(url, { state: "failed", error: ORBIT_WAIT });
        seen();
        continue;
      }
      // glibren.27: um feed da web le o cache como texto (readWebCache), sem a arvore do documento.
      let kept = isLocalFeed(url) ? null : readWebCache(url);
      if (!kept && !isLocalFeed(url)) {
        seen();
        continue;
      }
      try {
        let feed;
        if (isLocalFeed(url)) {
          feed = yield* loadLocalSteps(url);
          if (!feed) {
            seen();
            continue;
          }
        } else {
          const { cache } = kept;
          feed = yield* feedTextSteps(kept.text, url, LOAD_BATCH, kept.from, kept.to);
          kept = null; // o texto do cache sai antes do proximo feed
          loaded.set(url, cache.hash);
          meta.set(url, summary(cache));
          setIndex(url, feed.games);
        }
        // glibren.9: each game says which feed it came from (the TorBox library's sources, state/torbox-library.js).
        for (const item of feed.games) item.feed = url;
        out.push(...feed.games);
        if (feed.ratings && Object.keys(feed.ratings).length) ratingsOf.set(url, feed.ratings);
        for (const [id, pair] of Object.entries(feed.ratings ?? {})) if (!feedRatings[id]) feedRatings[id] = pair;
      } catch (error2) {
        console.log(`feeds: cached ${url} unreadable: ${error2.message}`);
      }
      seen();
      memorySample(memoryAction(url, "abrir"));
      yield;
    }
    return out;
  }
  function loadFeedGames() {
    const steps = loadFeedGamesSteps();
    for (; ; ) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }
  // glibren (item 2): o retrato da loja (state/feed-snapshot.js). `states` e o que a ultima loadFeedGames deixou de cada
  // feed; ratingsOf, as notas de cada um (so para o retrato).
  var states = [];
  var ratingsOf = /* @__PURE__ */ new Map();
  /** O estado de cada feed da ultima leitura (para gravar no retrato); a lista sai daqui. */
  function takeFeedStates() {
    const out = states;
    states = [];
    ratingsOf.clear();
    return out;
  }
  /** Refaz o estado que a leitura dos feeds deixaria (o retrato valeu): status, resumo, "carregado", indice e notas. */
  function restoreFeedStates(saved) {
    for (const item of saved) {
      if (!item || typeof item.url !== "string") continue;
      const { url } = item;
      if (item.status) status.set(url, item.status);
      if (item.meta) meta.set(url, isLocalFeed(url) ? { ...item.meta, fetchedAt: isoStamp(Date.now()) } : item.meta);
      if (item.loaded != null) loaded.set(url, item.loaded);
      if (Array.isArray(item.index)) {
        indexes.set(url, item.index);
        indexVersion++;
      }
      for (const [id, pair] of Object.entries(item.ratings ?? {})) if (!feedRatings[id]) feedRatings[id] = pair;
      memorySample(memoryAction(url, "abrir"));
    }
  }
  /**
   * O que decide se o retrato da loja ainda vale: cada feed lido (na ordem), com o tamanho e a hora do arquivo de que ele
   * seria lido (o cache, e o proprio arquivo num feed do PS5) e, na lista Orbit, se ela ja pode ser lida. Nada e lido.
   */
  function feedSnapshotParts() {
    const info = (path) => {
      try {
        const st = FileSystem.stat(path);
        return st ? stampOf(st) : "-";
      } catch {
        return "!";
      }
    };
    return allFeeds().map((url) => [url, info(cacheFile(url)), info(`${LEGACY_DIR}/${stableKey(url)}.json`), isLocalFeed(url) ? info(url) : "", url === ORBIT_FEED ? orbitFeedReady() : ""]);
  }
  // glibren (medidor de memoria): o nome da acao de cada feed (state/memory-meter.js).
  function memoryAction(url, step) {
    return `${url === ORBIT_FEED ? "orbit" : url === LIVE_FEED ? "loja" : "feeds"}:${step}`;
  }
  // Refresh state per URL: { state: "refreshing" | "ok" | "failed", error, changed }.
  var status = /* @__PURE__ */ new Map();
  var listeners = /* @__PURE__ */ new Set();
  var notify = () => {
    for (const listener of listeners) listener();
  };
  function setStatus(url, value) {
    status.set(url, value);
    notify();
  }
  function checkURL(value) {
    const url = (value || "").trim();
    let parsed;
    try {
      parsed = webURL(url);
    } catch {
      throw new Error("Enter a full http:// or https:// address.");
    }
    if (parsed.path === "/" && !url.endsWith("/")) throw new Error("Enter the feed file's full address, not just its site.");
    return url;
  }
  var hostOf = (url) => {
    try {
      return webURL(url).host;
    } catch {
      return url;
    }
  };
  // The player's mirrors of a feed.
  var userMirrors = (url) => {
    const list = mirrorStore.get()[url];
    return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
  };
  // Every mirror of a feed: the player's, then the ones the feed names itself (none for a file on the console).
  var mirrorsOf = (url) => isLocalFeed(url) ? [] : [...new Set([...userMirrors(url), ...meta.get(url)?.mirrors ?? []])].filter((mirror) => mirror !== url);
  // glibren.14: what the player typed or picked: a file's path (or file:// address), else a web address.
  var addressOf = (value) => /^\s*(?:\/|file:\/\/)/i.test(value || "") ? checkLocalPath(value) : checkURL(value);
  // The addresses a refresh tries, in order: the one that worked last, the feed's own, then its mirrors.
  function sourcesOf(url) {
    const all = [url === LIVE_FEED ? liveSource() : url, ...mirrorsOf(url)];
    const last = meta.get(url)?.from;
    return [...new Set(last && all.includes(last) ? [last, ...all] : all)];
  }
  // One fetch per feed at a time: adding a feed while every feed refreshes (or a phone and the console
  // both asking) shares the fetch instead of writing the same cache file twice at once.
  var inflight = /* @__PURE__ */ new Map();
  function refreshFeed(url) {
    if (!inflight.has(url)) inflight.set(url, fetchFeed(url).finally(() => inflight.delete(url)));
    return inflight.get(url);
  }
  var listed = (url) => url === LIVE_FEED || url === ORBIT_FEED && orbitFeedOn() || feedList.get().includes(url);
  // A refresh runs while the store or Settings is on screen, and checking a 2 MiB feed took the console's
  // interpreter about a second per feed in one piece: the screen stopped answering (Settings froze when
  // opened just after launch, when the feeds refresh, or on Refresh feeds). Its checking and hashing now
  // stop for a frame every few milliseconds of work.
  var nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
  // One address: the parsed feed, or an error saying why not (so the next address gets its turn). It is
  // parsed as the feed's own address (`url`), so a copy from a mirror has the same release ids and
  // downloads started from either keep their identity.
  // A strong ETag names exactly one copy of a file; a weak one (W/) does not.
  var strongTag = (tag) => typeof tag === "string" && tag !== "" && !tag.startsWith("W/") ? tag : null;
  async function fetchFrom(source, url) {
    // No custom headers: with them the transport will not follow a redirect (raw file hosts redirect).
    let response = await Http.request(source, { maxBytes: Math.min(MAX_BYTES, NET_MAX_BYTES) });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    // 0.5.3: the copy the cache holds already, as the server's ETag says: it is not read, checked, hashed or
    // written again. Reading the live catalog (2 MiB at most) and building its copies held the console for
    // over a second after every launch, and its heap filled until a collection stopped the screen; the live
    // catalog changes every few hours, so most launches fetch the same copy.
    const etag = strongTag(response.headers?.etag);
    const known = meta.get(url);
    if (etag && known?.etag === etag && known.from === source) return { unchanged: true };
    // glibren.27: o pico de memoria deste caminho (catalogo ao vivo de 1,8 MB) passava de 20 MB no QuickJS: o texto
    // baixado preso na resposta ate o fim, o texto decodificado, a arvore do JSON.parse, a copia validada, o documento
    // refeito (feedDocument) e o seu JSON, e o cache montado como mais uma string. Agora: a resposta solta logo depois
    // de lida, o texto baixado solto depois de decodificado, o feed conferido do texto um jogo por vez, guardando so
    // id e direct de cada jogo (checkFeedTextAsync: o catalogo le os jogos do cache na proxima abertura), e o proprio
    // texto decodificado vai para o cache (fetchFeed), sem documento refeito.
    let text2 = await response.text();
    response = null;
    try {
      // 0.5.7: a JLX1 feed (state/jlx.js) is decoded first, a few slices a frame; a plain one is read as it is.
      text2 = await readJlxAsync(text2, nextFrame);
    } catch {
      throw new Error("Not JSON.");
    }
    let feed;
    try {
      feed = await checkFeedTextAsync(text2, url, nextFrame);
    } catch (error2) {
      if (error2 instanceof SyntaxError) throw new Error("Not JSON.");
      throw error2;
    }
    if (!feed.games.length) throw new Error("No usable games in this feed.");
    feed.etag = etag;
    feed.text = text2;
    return feed;
  }
  // glibren.14: a linked file, read again (Refresh feeds, and the refresh after launch): an unchanged stamp reads
  // nothing; a missing or broken file keeps its last good read and says why.
  async function refreshLocal(url) {
    if (url === ORBIT_FEED && !orbitFeedReady()) return setStatus(url, { state: "failed", error: ORBIT_WAIT });
    setStatus(url, { state: "refreshing" });
    try {
      const info = statLocal(url);
      const stamp = stampOf(info);
      const known = meta.get(url);
      if (known && known.stamp === stamp) {
        meta.set(url, { ...known, fetchedAt: isoStamp(Date.now()) });
        setStatus(url, { state: "ok", changed: loaded.get(url) !== known.hash });
        return;
      }
      // glibren.27: so a contagem e o indice (checkFeedTextAsync guarda { id, direct } de cada jogo); o cache leva o texto.
      let text2 = readLocalText(url);
      const feed = await checkFeedTextAsync(text2, url, nextFrame);
      if (!feed.games.length) throw new Error("No usable games in this file.");
      if (!listed(url)) return;
      const cache = saveLocal(url, feed, stamp, text2);
      text2 = null;
      setStatus(url, { state: "ok", changed: loaded.get(url) !== cache.hash });
      console.log(`feeds: ${url}: read, ${feed.games.length} games, ${feed.skipped} skipped`);
    } catch (error2) {
      console.log(`feeds: ${url} not read: ${error2.message}`);
      if (listed(url)) setStatus(url, { state: "failed", error: error2.message });
    }
  }
  async function fetchFeed(url) {
    if (isLocalFeed(url)) return refreshLocal(url);
    setStatus(url, { state: "refreshing" });
    try {
      const sources = sourcesOf(url);
      let feed = null, from = null, gone = false;
      const failures = [];
      for (const source of sources) {
        try {
          feed = await fetchFrom(source, url);
          from = source;
          break;
        } catch (error2) {
          failures.push(error2.message);
          if (url === LIVE_FEED && source === liveSource() && listsGone(error2.status)) gone = true;
          console.log(`feeds: ${source} failed: ${error2.message}`);
        }
      }
      // 0.5.7: the live catalog's file is not at its address: once, where the lists are now (state/lists-home.js).
      if (!feed && gone && await askListsHome()) {
        try {
          from = liveSource();
          feed = await fetchFrom(from, url);
        } catch (error2) {
          failures.push(error2.message);
          console.log(`feeds: ${from} failed: ${error2.message}`);
        }
      }
      if (!feed) throw new Error(failures.length > 1 ? `${failures[0]} (${failures.length - 1} mirror${failures.length > 2 ? "s" : ""} also failed)` : failures[0]);
      // Removed while it downloaded: nothing is cached for it, and it leaves no status behind.
      if (!listed(url)) return;
      // The cache's copy: only when it was fetched changes (kept until the next launch; the file keeps the time
      // its copy was written).
      if (feed.unchanged) {
        const known = meta.get(url);
        meta.set(url, { ...known, fetchedAt: isoStamp(Date.now()) });
        setStatus(url, { state: "ok", changed: loaded.get(url) !== known.hash });
        console.log(`feeds: ${url}${from === url ? "" : ` (via ${hostOf(from)})`}: unchanged, ${known.games} games`);
        return;
      }
      // glibren.27: o cache guarda o texto que veio (ja decodificado), nao um documento refeito do feed validado: nada
      // de feedDocument + JSON.stringify (mais uma arvore e mais uma string do tamanho do feed) e o arquivo fica menor
      // (1,8 MB em vez de 2,4 no catalogo ao vivo). Na abertura ele e validado de novo (loadFeedGames), como sempre.
      // O hash passa a ser o desse texto: um cache de antes conta como "mudou" uma vez.
      let text = feed.text;
      feed.text = null;
      await nextFrame();
      const hash = await stableKeyAsync(text, nextFrame);
      if (!listed(url)) return;
      const cache = { url, from, hash, etag: feed.etag, fetchedAt: isoStamp(Date.now()), name: feed.name, games: feed.games.length, skipped: feed.skipped, mirrors: feed.mirrors };
      FileSystem.mkdir(DIR, { recursive: true });
      writeCacheText(`${cacheFile(url)}.tmp`, JSON.stringify(cache).slice(0, -1), text);
      text = null;
      FileSystem.rename(`${cacheFile(url)}.tmp`, cacheFile(url));
      meta.set(url, summary(cache));
      setIndex(url, feed.games);
      setStatus(url, { state: "ok", changed: loaded.get(url) !== hash });
      console.log(`feeds: ${url}${from === url ? "" : ` (via ${hostOf(from)})`}: ${feed.games.length} games, ${feed.skipped} skipped`);
      memorySample(memoryAction(url, "atualizar"));
    } catch (error2) {
      console.log(`feeds: ${url} failed: ${error2.message}`);
      if (listed(url)) setStatus(url, { state: "failed", error: error2.message });
    }
  }
  var refreshing = null;
  // One refresh at a time, feed by feed: they share the console's connection with downloads.
  function refreshFeeds() {
    return refreshing ?? (refreshing = (async () => {
      try {
        for (const url of allFeeds()) await refreshFeed(url);
      } finally {
        refreshing = null;
      }
    })());
  }
  // Adds a feed and fetches it; throws (for the address dialog to show) when it cannot be added.
  // glibren.14: a path (or file://) links a file on the console instead; it must be there when it is linked.
  function addFeed(value) {
    const url = addressOf(value);
    const urls = feedList.get();
    if (urls.includes(url) || url === LIVE_FEED) throw new Error("That feed is already added.");
    if (url === ORBIT_FEED) throw new Error("That is the Orbit Store list: turn it on in Settings.");
    if (urls.length >= MAX_FEEDS) throw new Error(`Up to ${MAX_FEEDS} feeds. Remove one first.`);
    if (isLocalFeed(url)) statLocal(url);
    feedList.set([...urls, url]);
    void refreshFeed(url);
  }
  // glibren.14: Settings' "Add a file from the PS5" (ui/FeedFilePicker.jsx): only a path.
  function addLocalFeed(path) {
    addFeed(checkLocalPath(path));
  }
  // Adds a fallback address for a feed (kept in feed-mirrors.json); throws when it cannot be added.
  function addMirror(feedUrl, value) {
    if (!listed(feedUrl)) throw new Error("No such feed.");
    if (isLocalFeed(feedUrl)) throw new Error("A file on the console has no mirrors.");
    const mirror = checkURL(value);
    if (mirror === feedUrl) throw new Error("That is the feed's own address.");
    const mine = userMirrors(feedUrl);
    if (mine.includes(mirror) || meta.get(feedUrl)?.mirrors.includes(mirror)) throw new Error("That mirror is already added.");
    if (mine.length >= MAX_MIRRORS) throw new Error(`Up to ${MAX_MIRRORS} mirrors for a feed. Remove one first.`);
    mirrorStore.set({ ...mirrorStore.get(), [feedUrl]: [...mine, mirror] });
    notify();
  }
  function removeMirror(feedUrl, mirror) {
    const mine = userMirrors(feedUrl);
    if (!mine.includes(mirror)) return;
    const rest = mine.filter((item) => item !== mirror);
    const next = { ...mirrorStore.get() };
    if (rest.length) next[feedUrl] = rest;
    else delete next[feedUrl];
    mirrorStore.set(next);
    notify();
  }
  function forget(url) {
    status.delete(url);
    meta.delete(url);
    if (indexes.delete(url)) indexVersion++;
    try {
      if (FileSystem.exists(cacheFile(url))) FileSystem.remove(cacheFile(url));
    } catch (error2) {
      console.log(`feeds: cache of ${url} not removed: ${error2.message}`);
    }
  }
  function removeFeed(url) {
    feedList.set(feedList.get().filter((item) => item !== url));
    if (url in mirrorStore.get()) {
      const next = { ...mirrorStore.get() };
      delete next[url];
      mirrorStore.set(next);
    }
    forget(url);
    notify();
  }
  // Edits a feed's address in place (the phone's Edit): checked like a new one, kept in its position,
  // and fetched; the old address's cache goes and its mirrors move to the new address. Throws when the
  // new address cannot be used.
  function replaceFeed(from, value) {
    const urls = feedList.get();
    const index = urls.indexOf(from);
    if (index < 0) throw new Error("No such feed.");
    const url = addressOf(value);
    if (url === from) {
      void refreshFeed(url);
      return;
    }
    if (urls.includes(url) || url === LIVE_FEED) throw new Error("That feed is already added.");
    if (isLocalFeed(url)) statLocal(url);
    feedList.set(urls.map((item, at) => at === index ? url : item));
    const mine = isLocalFeed(url) ? [] : userMirrors(from).filter((mirror) => mirror !== url);
    const next = { ...mirrorStore.get() };
    delete next[from];
    if (mine.length) next[url] = mine;
    mirrorStore.set(next);
    forget(from);
    notify();
    void refreshFeed(url);
  }
  // The feeds: address, last good copy (name, games, when), where it came from, its mirrors and refresh
  // state, for Settings and the phone companion alike.
  function feedsSnapshot(urls = feedList.get()) {
    return urls.map((url) => {
      const known = meta.get(url);
      return {
        url,
        // glibren.14: a file on the console (`url` is its path); `fetchedAt` is when it was last read.
        local: isLocalFeed(url),
        name: known?.name ?? null,
        games: known?.games ?? 0,
        fetchedAt: known?.fetchedAt ?? null,
        // The mirrors in order (the player's first) and the address the last good copy came from.
        mirrors: mirrorsOf(url),
        own: userMirrors(url),
        via: known?.from && known.from !== url ? known.from : null,
        // A refresh that brought a different copy (a new feed's first) shows its games after a restart.
        restart: status.get(url)?.changed === true,
        ...status.get(url) ?? (known ? { state: "ok" } : { state: "failed", error: "Not loaded yet." })
      };
    });
  }
  // The games each feed lists right now, by feed: [[id, direct], …]. `feedIndexVersion` changes whenever
  // that does (a refresh, a mirror answering instead of the feed, a feed removed); `subscribeFeeds` calls
  // back on every change to the feeds or their state.
  var feedIndexes = () => [...indexes.values()];
  /** glibren.26: [[url do feed, pares [id, direct]]], para o contador respeitar "Mostrar na loja". */
  var feedIndexEntries = () => [...indexes];
  var feedIndexVersion = () => indexVersion;
  function subscribeFeeds(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  function useFeeds() {
    const urls = feedList.useList();
    const [, redraw] = (0, useState)(0);
    (0, useEffect)(() => {
      const listener = () => redraw((n) => n + 1);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);
    return feedsSnapshot(urls);
  }

// glibren.20: a lista Orbit Store ligada le o arquivo do payload (se ja existe); desligada, o que estava guardado sai.
  onOrbitFeed((on) => {
    if (on) void refreshFeed(ORBIT_FEED);
    else forget(ORBIT_FEED);
    notify();
  });
  /** glibren.20: a lista Orbit Store como as Configuracoes a mostram (o mesmo resumo de um feed), ou null desligada. */
  var orbitFeedSnapshot = () => orbitFeedOn() ? feedsSnapshot([ORBIT_FEED])[0] : null;
  var refreshOrbitFeed = () => orbitFeedOn() ? refreshFeed(ORBIT_FEED) : Promise.resolve();
  /** glibren.20: o "Atualizar feeds" das Configuracoes: pede ao payload a lista Orbit Store agora e rele os feeds. */
  function refreshFeedsNow() {
    void requestOrbitRefresh();
    return refreshFeeds();
  }

/** glibren.9: a feed's name as its last good copy says (null when none is cached). */
var feedName = (url) => meta.get(url)?.name ?? null;

export { LIVE_FEED, MAX_FEEDS, NET_MAX_BYTES, feedIndexEntries, orbitFeedSnapshot, refreshOrbitFeed, refreshFeedsNow, feedName, MAX_MIRRORS, addFeed, addLocalFeed, addMirror, feedIndexVersion, feedIndexes, feedRatings, feedsSnapshot, feedSnapshotParts, loadFeedGames, loadFeedGamesSteps, restoreFeedStates, takeFeedStates, refreshFeeds, removeFeed, removeMirror, replaceFeed, subscribeFeeds, useFeeds };
