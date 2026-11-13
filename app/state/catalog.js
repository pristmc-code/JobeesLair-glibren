// ../pub-game-store/native/state/catalog.js
// reconstructed from the esbuild bundle in eboot.bin
// MODIFIED: hosts this build no longer downloads from are left out of each game's hosts and the host
// filter (none now: Vikingfile and AkiraBox are back, their file links captured from the browser).
// MODIFIED: games from catalog feeds (state/feeds.js) are merged in before anything is derived.
// MODIFIED: bundledIndex keeps the bundled titles' ids and direct flags for the live game counter.
// MODIFIED: each game carries `formats`, the kinds of download it has (state/formats.js), for the Format filter:
// the bundled games' from data/formats.js, a feed's releases sorted when the feeds load.
// MODIFIED: warmCovers still warms every cover, the first ones of each row first (state/cover-warm.js).
// MODIFIED: the bundled games come from data/catalog-index.js (data/catalog/index.json, read at launch), their
// banners, logos and other covers from its art files when first drawn; nothing here reads those for every game.
// MODIFIED (0.5.1): each game carries its PlayStation Store star rating, `stars` and `ratingCount` (the live
// catalog's when it has one, else data/ratings.js), and the rating sort and Top Rated go by ratingScore.
// MODIFIED (glibren.45): the store is built in parts (buildSteps): on the console the parts run a frame at a time
// (state/frame-pace.js: a number of steps, then the frame goes back), from the launch, while the intro and the terms
// notice show; index.jsx mounts the store once it is done (whenCatalogReady), and state/store-mode.js rebuilds what
// other modules worked out from the lists while they were empty. Elsewhere (tests, qjs measurements) it all runs as
// this module loads, as before. catalogBuildStats says how long it took, in how many parts and the longest one.
// MODIFIED (glibren.47): the bundled releases and pages come from two pack files read one item at a time
// (state/data-pack.js, tools/catalog/data-pack.mjs), not 4,188 small files: the image is ~275 MB smaller.

import { CATALOG_HELD, CATALOG_PACED, catalogLoad, coverSize, features, games, indexSteps, twins } from '../data/catalog-index.js';
import { formats as bundledFormats } from '../data/formats.js';
import { formatDate2, t } from '../i18n/core.js';
import { createPageCache } from './page-cache.js';
import { feedRatings, feedSnapshotParts, loadFeedGamesSteps, restoreFeedStates, takeFeedStates } from './feeds.js';
import { bucketReader, readSnapshotSteps, snapshotKey, writeSnapshotSteps } from './feed-snapshot.js';
import { ORBIT_FEED, setOrbitKnown } from './orbit-feed.js';
import { pageSummary } from './feed-format.js';
import { ratings as bundledRatings } from '../data/ratings.js';
import { createReleaseCache } from './release-cache.js';
import { createDataPack } from './data-pack.js';
import { createFramePace } from './frame-pace.js';
import { readJlx } from './jlx.js';
import { KINDS, gameFormats, ready1360 } from './formats.js';
import { deviceFacts } from './device.js';
import { consoleFirmware, firmwareText, ps5FakePackagesLaunch } from './firmware.js';
import { FileSystem } from '@ps5-react/core';
import { PS4 } from './ps4.js';
import { noteRow, warmAtStart } from './cover-warm.js';
import { memorySample } from './memory-meter.js';

  // 0.5.1: "Ready" is for this console's firmware. At 11.60 or lower PS5 fake packages start too, so a PS5 game
  // with one is ready there, and the label names that firmware ("Ready for 9.60"); above, it is 13.60's rule and
  // label, as before. Unknown firmware reads as 13.60.
  // Read once the console has said its firmware (it cannot change while the app runs): readyHere asks for
  // every game of every pass.
  // glibren.54: guardado por firmware (o de verdade pode chegar do payload depois da abertura, state/device.js).
  var lowKnown, lowFor;
  var lowFirmware = () => {
    try {
      const text = deviceFacts().firmware;
      if (lowKnown !== void 0 && lowFor === text) return lowKnown;
      if (!text) return null;
      lowFor = text;
      lowKnown = ps5FakePackagesLaunch(text) === true ? firmwareText(consoleFirmware(text)) : null;
      return lowKnown;
    } catch {
      return null;
    }
  };
  var readyHere = (game) => ready1360(game.formats ?? []) || Boolean(lowFirmware()) && game.platform === "ps5" && (game.formats ?? []).includes("fpkg");
  var readyLabel = (text) => {
    const low = lowFirmware();
    return low ? text.replace("13.60", low) : text;
  };
  // 0.5.7: the bundled release files are JLX1 (state/jlx.js).
  // glibren.47: the caches still name a game's data/<dir>/<id>.json; the text is that item of the pack. An item the pack
  // lacks (or a pack that does not read) fails as a missing file did: no releases but the feeds', an empty page.
  var releasePack = createDataPack("releases");
  var pagePack = createDataPack("pages");
  var packItem = (pack, path) => {
    const text = pack.read(path.slice(path.lastIndexOf("/") + 1, -".json".length));
    if (text === null) throw new Error(`${path}: not in the pack`);
    return text;
  };
  var releaseCache = createReleaseCache((path) => readJlx(packItem(releasePack, path)));
  var pageCache = createPageCache((path) => packItem(pagePack, path));
  var NO_PAGE = { about: [], shots: [], summary: "" };
  var SYNONYMS = {
    "Role Playing Game (RPG)": "RPG",
    "Role Playing Games": "RPG",
    "Role-playing": "RPG",
    Simulator: "Simulation",
    "Driving/Racing": "Racing"
  };
  var dataFile = (dir2, id) => `data/${dir2}/${encodeURIComponent(id)}.json`;
  var pageOf = (game) => {
    try {
      return pageCache(dataFile("pages", game.id));
    } catch {
      return NO_PAGE;
    }
  };
  var Entry = {
    get releases() {
      try {
        // glibren (item 2): os links de feed vem do disco (state/feed-snapshot.js) so quando o jogo nao esta guardado.
        const id = this.id;
        return releaseCache(dataFile("releases", id), () => feedReleasesOf(id));
      } catch {
        return [];
      }
    },
    get about() {
      return pageOf(this).about;
    },
    get shots() {
      return pageOf(this).shots;
    },
    get shortDescription() {
      return pageOf(this).summary;
    },
    // glibren.9: YouTube ids (a feed's "videos"; the bundled pages have none), for the TorBox library on the phone.
    get videos() {
      return pageOf(this).videos ?? [];
    },
    get titleId() {
      return this.id;
    }
  };
  // A game only a feed lists: its page comes from the feed, its releases from the feed alone.
  var FeedEntry = Object.create(Entry, {
    about: { get() {
      return this.feedPage.about;
    } },
    shots: { get() {
      return this.feedPage.shots;
    } },
    videos: { get() {
      return this.feedPage.videos ?? [];
    } },
    shortDescription: { get() {
      // glibren.26: o resumo que era o comeco da descricao sai dela (state/feed-format.js pageSummary).
      return pageSummary(this.feedPage);
    } }
  });
  // Feed releases join the catalog game they name (the same id); a game the catalog lacks is listed with
  // the feed's details. Two feeds naming one new game add up on the first one's entry.
  // glibren (item 2): so enquanto a loja e montada lendo os feeds (ou quando o retrato nao pode ser gravado); depois os
  // links ficam nos baldes do disco (feedLinks).
  var feedReleases = /* @__PURE__ */ new Map();
  var feedLinks = null;
  var feedReleasesOf = (id) => feedReleases.get(id) ?? (feedLinks ? feedLinks(id) : []);
  // glibren.45: what the build fills (buildSteps); empty until then.
  var BUNDLED = "bundled";
  var bundledKnown = [];
  var bundledIndex = [];
  var catalogIds = /* @__PURE__ */ new Map();
  var sourcesById = /* @__PURE__ */ new Map();
  var sourceCounts = /* @__PURE__ */ new Map();
  var entries = [];
  var editionsByWork = /* @__PURE__ */ new Map();
  var listed = /* @__PURE__ */ new Set();
  var genres = [];
  var allListed = [];
  var byId = /* @__PURE__ */ new Map();
  var hosts = [];
  // Games a step (a `yield`): a part runs a number of steps (state/frame-pace.js).
  var BATCH = 200, FORMATS_BATCH = 20, MERGE_BATCH = 50;
  var stats = { total: 0, longest: 0, steps: 0, frames: 0, paced: CATALOG_PACED, phases: {}, slowest: { phase: "", ms: 0 } };
  var current = "index";
  var phase = (name) => {
    current = name;
  };
  // The build, in parts: each `yield` is a place where the frame can go back.
  function* buildSteps() {
    phase("index");
    yield* indexSteps();
    phase("bundled");
    // The PS4 lists its own games only: every PS4 edition, a game the PS5 lists under its PS5 edition too, and no
    // PS5 edition at all (state/ps4.js).
    // glibren.27: todo codigo do catalogo embutido (no PS4 tambem os de PS5): conhecidos para a lista Orbit.
    bundledKnown = [...games, ...twins].map((game) => game.id);
    if (PS4) {
      const own = [...games, ...twins].filter((game) => game.platform === "ps4");
      games.splice(0, games.length, ...own);
      twins.splice(0, twins.length);
    }
    // The bundled titles as [id, direct] pairs, taken before any feed is merged in: the live game counter
    // (state/library-count.js) adds the feeds' own lists to these.
    bundledIndex.push(...games.map((game) => [game.id, game.direct ? 1 : 0]));
    catalogIds = new Map([...games, ...twins].map((game) => [game.id, game]));
    // glibren.9: where each game comes from, for the TorBox library (state/torbox-library.js): "bundled" (the catalog
    // in the package) and the address of each feed (the live catalog's too) that lists it.
    sourcesById = new Map([...games, ...twins].map((game) => [game.id, [BUNDLED]]));
    sourceCounts = /* @__PURE__ */ new Map([[BUNDLED, games.length + twins.length]]);
    // glibren (item 2): o retrato da loja (state/feed-snapshot.js): com os arquivos dos feeds iguais aos da ultima
    // montagem, os jogos dos feeds vem dele, sem ler os feeds, e os links ficam no disco. Senao, os feeds sao lidos como
    // antes e o retrato e gravado depois de montada a lista (mais abaixo).
    phase("feeds");
    let snapKey = snapshotKey(feedSnapshotParts(), PS4);
    let snapshot = yield* readSnapshotSteps(snapKey);
    const feedKinds = snapshot ? snapshot.kinds ?? {} : {};
    let feedGames = snapshot ? snapshot.games : yield* loadFeedGamesSteps();
    let feedStates = snapshot ? null : takeFeedStates();
    if (snapshot) {
      restoreFeedStates(snapshot.states ?? []);
      feedLinks = bucketReader(snapKey, snapshot.buckets);
    }
    // O que o retrato guarda de cada jogo de feed: o registro inteiro (e a pagina) so de um jogo novo; de um que o catalogo
    // ja tem, so o que esta montagem usa dele (providers e direct).
    phase("merge");
    let snapItems = snapshot ? null : [];
    let n = 0;
    for (const { game: feedGame, page, releases = [], feed } of feedGames) {
      if (++n % MERGE_BATCH === 0) yield;
      if (snapItems && !(PS4 && feedGame.platform !== "ps4")) snapItems.push(catalogIds.has(feedGame.id) ? { game: { id: feedGame.id, platform: feedGame.platform, providers: feedGame.providers, ...feedGame.direct ? { direct: true } : {} }, feed } : { game: feedGame, page, feed });
      if (PS4 && feedGame.platform !== "ps4") continue;
      if (feed) {
        const from = sourcesById.get(feedGame.id) ?? [];
        if (!from.includes(feed)) {
          sourcesById.set(feedGame.id, [...from, feed]);
          sourceCounts.set(feed, (sourceCounts.get(feed) ?? 0) + 1);
        }
      }
      if (releases.length) feedReleases.set(feedGame.id, [...feedReleases.get(feedGame.id) ?? [], ...releases]);
      const known = catalogIds.get(feedGame.id);
      if (known) {
        known.providers = [.../* @__PURE__ */ new Set([...known.providers ?? [], ...feedGame.providers])];
        if (feedGame.direct) known.direct = true;
      } else {
        const entry = { ...feedGame, feedPage: page };
        games.push(entry);
        catalogIds.set(feedGame.id, entry);
      }
    }
    yield;
    // glibren.27: o que o app conhece sem a lista Orbit (o embutido e o que um outro feed lista) vai ao payload, que grava
    // esses jogos so com os links: acima, um jogo conhecido so ganha providers, direct e releases dela.
    setOrbitKnown([...bundledKnown, ...[...sourcesById].filter(([, from]) => from.some((source) => source !== ORBIT_FEED)).map(([id]) => id)]);
    entries = [...games, ...twins];
    let _a;
    phase("prepare");
    n = 0;
    for (const game of entries) {
      if (++n % BATCH === 0) yield;
      Object.setPrototypeOf(game, game.feedPage ? FeedEntry : Entry);
      game.genres = [...new Set(game.genres.flatMap((genre) => genre.split(" / ")).map((genre) => SYNONYMS[genre] ?? genre))];
      (_a = game.art).cover && (_a.cover = coverSize(game.art.cover));
      // A bundled game's other covers wait in its art file (data/catalog-index.js sizes them when read): only a
      // feed game's own are sized here.
      if (Object.hasOwn(game.art, "coverFallbacks") && game.art.coverFallbacks) game.art.coverFallbacks = game.art.coverFallbacks.map(coverSize);
    }
    phase("formats");
    n = 0;
    for (const game of entries) {
      // Reading a feed game's links for its formats is the dearest part per game: a few at a time.
      if (++n % FORMATS_BATCH === 0) yield;
      const bundled = bundledFormats[game.id]?.split(" ") ?? [];
      const fed = feedReleases.get(game.id);
      // glibren (item 2): os formatos tirados dos links de feed, guardados no retrato (o retrato nao tem os links na memoria).
      const fromFeed = fed?.length ? feedKinds[game.id] = gameFormats(fed, game.platform) : feedKinds[game.id] ?? [];
      game.formats = fromFeed.length ? KINDS.filter((kind) => bundled.includes(kind) || fromFeed.includes(kind)) : bundled;
      // The PS4 installs packages; the disk images and folders are the PS5's ShadowMount's.
      if (PS4) game.formats = game.formats.filter((kind) => kind === "fpkg");
    }
    // glibren (item 2): montada a lista lendo os feeds, o retrato e gravado (os links em baldes, na ordem do catalogo) e os
    // links saem da memoria; sem gravar, ficam nela como antes.
    if (!snapshot && feedReleases.size) {
      // A chave de agora: ler um feed do PS5 regrava o cache dele (feeds.js saveLocal), e a proxima abertura ve esse cache.
      snapKey = snapshotKey(feedSnapshotParts(), PS4);
      phase("snapshot");
      const buckets = yield* writeSnapshotSteps(snapKey, { games: snapItems, states: feedStates, kinds: feedKinds, releases: feedReleases, order: entries.map((game) => game.id) });
      if (buckets) {
        feedLinks = bucketReader(snapKey, buckets);
        feedReleases.clear();
      }
    }
    feedGames = feedStates = snapshot = snapItems = null;
    yield;
    phase("ratings");
    editionsByWork = /* @__PURE__ */ new Map();
    n = 0;
    for (const game of entries) {
      if (++n % BATCH === 0) yield;
      if (game.work) editionsByWork.set(game.work, [...editionsByWork.get(game.work) ?? [], game]);
    }
    yield;
    for (const game of entries) {
      const pair = feedRatings[game.id] ?? bundledRatings[game.id];
      if (pair) [game.stars, game.ratingCount] = pair;
    }
    // An edition the store has no rating for takes its work's best-known one (the PS4 and PS5 versions of a game).
    yield;
    n = 0;
    for (const game of entries) {
      if (++n % BATCH === 0) yield;
      if (game.ratingCount || !game.work) continue;
      const rated = (editionsByWork.get(game.work) ?? []).filter((edition2) => edition2.ratingCount).sort((a, b) => b.ratingCount - a.ratingCount)[0];
      if (rated) [game.stars, game.ratingCount] = [rated.stars, rated.ratingCount];
    }
    listed = new Set(games);
    phase("platforms");
    n = 0;
    for (const game of entries) {
      if (++n % BATCH === 0) yield;
      game.platforms = [...new Set(editionsOf(game).map((edition2) => edition2.platform))].sort();
    }
    phase("lists");
    genres = [...new Set(games.flatMap((game) => game.genres))].sort();
    // glibren.9: every listed game, as loaded: the store's list (`games`) can be narrowed to the TorBox store's
    // (state/store-mode.js), and this keeps the whole one.
    allListed.push(...games);
    byId = new Map(entries.map((game) => [game.id, game]));
    // glibren (medidor de memoria): a loja montada (o catalogo embutido com os feeds), state/memory-meter.js.
    memorySample("loja:montar");
    yield;
    phase("facets");
    yield* facetSteps();
  }
  function editionsOf(game) {
    // Fase 4: um jogo do catalogo do payload (state/catalog-remote.js) traz as edicoes da ficha ({id, platform, listed}).
    if (game.remote) return (game.editionList ?? [game]).map((edition2) => edition2.id === game.id ? game : getGame(edition2.id) ?? { ...edition2, titleId: edition2.id, remote: true, stub: true });
    return [...editionsByWork.get(game.work) ?? [game]].sort((a, b) => b.platform.localeCompare(a.platform) || Number(listed.has(b)) - Number(listed.has(a)) || a.titleId.localeCompare(b.titleId));
  }
  /** The catalog's games and where they come from, for the TorBox library: [{ game, sources }], other editions too. */
  var catalogEntries = () => entries.map((game) => ({ game, sources: sourcesById.get(game.id) ?? [BUNDLED] }));
  /** The sources the catalog has games from: [{ id: "bundled" | "<feed url>", count }]. */
  var catalogSources = () => [...sourceCounts].map(([id, count]) => ({ id, count }));
  /** glibren.25: where a listed game comes from: ["bundled" | "<feed url>", ...] (the store's "show this catalog"). */
  var sourcesOfGame = (game) => sourcesById.get(game.id) ?? [BUNDLED];
  /**
   * glibren.9: after the store's list changed (state/store-mode.js): the filters' and related games' kept answers
   * go, and the genres are the list's.
   */
  function refreshDerived() {
    pools.clear();
    countsKept.clear();
    relatedCache.clear();
    // Fase 4: com a loja aberta pelo payload os generos sao os dele (openRemoteStore).
    if (!remoteActive) genres = [...new Set(games.flatMap((game) => game.genres))].sort();
    memorySample("loja:trocar");
  }

  // Fase 4: sem a loja montada aqui, o que o catalogo do payload ja mandou (cartas e fichas guardadas, state/catalog-remote.js).
  var remoteLookup = null;
  var setRemoteLookup = (fn) => {
    remoteLookup = fn;
  };
  var getGame = (id) => byId.get(id) ?? (remoteLookup ? remoteLookup(id) : void 0);
  function listedId(id) {
    const game = byId.get(id);
    if (!game || listed.has(game)) return id;
    return editionsOf(game).find((edition2) => listed.has(edition2) && edition2.platform === game.platform)?.id ?? id;
  }
  function warmCovers() {
    // How the launch read the catalog index (it ran before the debug log opened).
    const load = catalogLoad;
    console.log(load.error ? `[catalog] the bundled catalog was not read: ${load.error}` : `[catalog] index read at launch: ${load.games} games, ${load.twins} other editions, ${load.bytes} bytes in ${load.ms} ms`);
    // Every cover, by relevance as before, with the first of each Discover row and of the catalog grid first
    // (state/cover-warm.js).
    const all = sortGames(games, "relevance");
    noteRow(oneEach(all), GRID_FIRST);
    const { count, lead } = warmAtStart(all);
    console.log(`[covers] ${count} covers to warm at launch, the first ${lead} for the first screens`);
  }
  // The catalog grid's first rows (browse/Catalog.jsx: six a row) warmed at launch.
  var GRID_FIRST = 36;
  var SORTS = [
    // Most popular puts the games Archive.org serves first: the app downloads them fastest.
    { id: "relevance", compare: (a, b) => fromArchive(b) - fromArchive(a) || b.recommendations - a.recommendations },
    { id: "newest", compare: (a, b) => b.releaseDate.localeCompare(a.releaseDate) },
    { id: "rating", compare: (a, b) => ratingScore(b) - ratingScore(a) || (b.metacritic ?? 0) - (a.metacritic ?? 0) },
    { id: "size", compare: (a, b) => (b.sizeGb ?? 0) - (a.sizeGb ?? 0) },
    { id: "title", compare: (a, b) => a.title.localeCompare(b.title) }
  ];
  // A game's store rating weighed by how many rated it: the average pulled toward RATING_PRIOR stars by
  // RATING_WEIGHT imagined ratings, so 4.9 stars from 40 people ranks under 4.8 from 70 000. 0 when unrated.
  var RATING_PRIOR = 3.5, RATING_WEIGHT = 500;
  // The fewest ratings a game needs to stand in Top Rated.
  var TOP_RATED_MIN = 200;
  var ratingScore = (game) => game.ratingCount ? (game.stars * game.ratingCount + RATING_PRIOR * RATING_WEIGHT) / (game.ratingCount + RATING_WEIGHT) : 0;
  // One card a game, the first of each in `list`'s order: the PS4 and PS5 editions of a work, and the regions of
  // one store page (they share its rating exactly; a rating from TOP_RATED_MIN people is never shared by chance).
  // The Browse rows and the catalog grid show a game once; its page offers the other editions.
  // A title as editions share it: no ™/®, no platform word, letters and digits only.
  var plainTitle = (title) => title.toLowerCase().replace(/[™®©]/g, "").replace(/\b(?:ps[45]|playstation ?[45])\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  // 0.5.3: each game's keys are worked out once (its work, rating and title stay the same while the app runs):
  // oneEach goes over the whole catalog at every section change.
  var editionKeys = /* @__PURE__ */ new WeakMap();
  function keysOf(game) {
    let keys = editionKeys.get(game);
    // The same name and the same stars is one game too (eFootball's editions, rated a person apart).
    if (!keys) editionKeys.set(game, keys = [...game.work ? [`work:${game.work}`] : [], ...game.ratingCount >= TOP_RATED_MIN ? [`rated:${game.stars}/${game.ratingCount}`, `named:${plainTitle(game.title)}/${game.stars}`] : []]);
    return keys;
  }
  // 0.5.3: `list` less the games in `shown` and every other edition of them: Discover's rows each show games the rows
  // above them do not (Featured, Ready and Popular now opened with the same eight).
  function otherThan(list, shown) {
    const own = new Set(shown);
    const taken = new Set();
    for (const game of shown) for (const key of keysOf(game)) taken.add(key);
    return list.filter((game) => !own.has(game) && !keysOf(game).some((key) => taken.has(key)));
  }
  function oneEach(list) {
    const seen = /* @__PURE__ */ new Set();
    return list.filter((game) => {
      const keys = keysOf(game);
      if (keys.some((key) => seen.has(key))) return false;
      for (const key of keys) seen.add(key);
      return true;
    });
  }
  var topRated = (list) => oneEach(sortGames(list.filter((game) => game.ratingCount >= TOP_RATED_MIN), "rating"));
  var sortLabel = (id) => t(`sort.${id}`);
  var sortGames = (list, id) => [...list].sort(SORTS.find((sort) => sort.id === id).compare);
  var fromArchive = (game) => Boolean(game.providers?.includes("archive.org"));
  var HOST_NAMES = {
    "overdrive cdn": "Overdrive CDN",
    "archive.org": "Archive.org",
    "1fichier": "1fichier",
    "pippo26442999.github": "Pippo mirror",
    datanodes: "DataNodes",
    mediafire: "MediaFire",
    filekeeper: "FileKeeper",
    datavaults: "DataVaults",
    spectrum: "Spectrum",
    buzzheavier: "Buzzheavier",
    gofile: "Gofile",
    rapidgator: "Rapidgator",
    filecrypt: "Filecrypt",
    fileditchfiles: "FileDitch",
    ranoz: "Ranoz",
    transfer: "Transfer.it"
  };
  var MIN_HOST_GAMES = 20;
  var MIN_KIND_GAMES = 5;
  function slug(value) {
    const words = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return words.map((word, i) => i ? word[0].toUpperCase() + word.slice(1) : word).join("");
  }
  var CDN_HOST = "overdrive cdn";
  // glibren.45: worked out by the build (facetSteps), from the listed games.
  function hostOptions() {
    const hostCounts = /* @__PURE__ */ new Map();
    for (const game of games) for (const host2 of game.providers ?? []) hostCounts.set(host2, (hostCounts.get(host2) ?? 0) + 1);
    return [...hostCounts].filter(([host2, count]) => count >= MIN_HOST_GAMES || host2 === CDN_HOST).sort((a, b) => (b[0] === CDN_HOST) - (a[0] === CDN_HOST) || b[1] - a[1]).map(([host2]) => ({ value: host2, name: HOST_NAMES[host2] ?? host2 }));
  }
  var onCdn = (game) => Boolean(game.providers?.includes(CDN_HOST));
  var SIZES = [
    { value: "small", label: "filters.size.small", test: (gb) => gb < 10 },
    { value: "medium", label: "filters.size.medium", test: (gb) => gb >= 10 && gb <= 50 },
    { value: "large", label: "filters.size.large", test: (gb) => gb > 50 }
  ];
  var named = (values, namespace) => values.map((value) => ({ value, label: `${namespace}.${slug(value)}`, name: value }));
  var byGames = (values, has) => {
    const counts = new Map(values.map((value) => [value, games.filter((game) => has(game, value)).length]));
    return [...values].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
  };
  var RELEASES = [
    { value: "recent", label: "filters.release.recent", test: (year) => year >= 2024 },
    { value: "current", label: "filters.release.current", test: (year) => year >= 2020 && year <= 2023 },
    { value: "older", label: "filters.release.older", test: (year) => year < 2020 }
  ];
  var FACETS = [
    {
      key: "platform",
      any: true,
      options: [{ value: "ps5", name: "PS5" }, { value: "ps4", name: "PS4" }],
      has: (game, value) => game.platform === value
    },
    // What kind of download a game has. "13.60 Ready" first: a folder dump or a disk image, what ShadowMount+
    // runs on 13.60. Only the kinds at least MIN_KIND_GAMES games have are offered.
    {
      key: "format",
      any: true,
      options: [],
      optionsOf: () => [
        { value: "ready", label: "release.compat.ready", name: "13.60 Ready" },
        ...KINDS.filter((kind) => games.filter((game) => game.formats.includes(kind)).length >= MIN_KIND_GAMES).map((kind) => ({ value: kind, label: `release.type.${kind}`, name: kind }))
      ],
      has: (game, value) => value === "ready" ? readyHere(game) : game.formats.includes(value)
    },
    // A source the app downloads by itself, with no CAPTCHA page to pass in a browser.
    { key: "access", options: [{ value: "direct", label: "filters.access.direct" }], has: (game) => Boolean(game.direct) },
    {
      key: "genre",
      options: [],
      // glibren.45: the counts in one pass over the games (it was a pass per genre); the same order as byGames.
      optionsOf: () => {
        const counts = /* @__PURE__ */ new Map();
        for (const game of games) for (const genre of game.genres) counts.set(genre, (counts.get(genre) ?? 0) + 1);
        return named([...genres].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b)), "genre");
      },
      has: (game, value) => game.genres.includes(value)
    },
    { key: "feature", options: [], optionsOf: () => named(features, "feature"), has: (game, value) => game.features.includes(value) },
    {
      key: "release",
      any: true,
      options: RELEASES,
      has: (game, value) => game.year != null && RELEASES.find((release) => release.value === value).test(game.year)
    },
    {
      key: "size",
      any: true,
      options: SIZES,
      has: (game, value) => game.sizeGb != null && SIZES.find((size) => size.value === value).test(game.sizeGb)
    },
    { key: "provider", any: true, options: hosts, optionsOf: () => hosts, has: (game, value) => game.providers?.includes(value) }
  ];
  // glibren.45: the facets' options from the listed games, one facet a part; the arrays are filled in place (search/index.jsx
  // keeps the format facet from when it loaded). The hosts first: the provider facet shows them.
  function* facetSteps() {
    hosts.splice(0, hosts.length, ...hostOptions());
    for (const facet of FACETS) {
      if (!facet.optionsOf) continue;
      const options = facet.optionsOf();
      if (options !== facet.options) facet.options.splice(0, facet.options.length, ...options);
      yield;
    }
  }
  var facetTitle = (key) => t(`filters.facet.${key}`);
  function optionLabel(option) {
    if (!option.label) return option.name;
    const text = t(option.label);
    return readyLabel(text === option.label ? option.name : text);
  }
  var facetLabel = (key, value) => {
    const option = FACETS.find((facet) => facet.key === key).options.find((candidate) => candidate.value === value);
    return option ? optionLabel(option) : value;
  };
  var genreLabel = (genre) => optionLabel({ label: `genre.${slug(genre)}`, name: genre });
  var featureLabel = (feature) => optionLabel({ label: `feature.${slug(feature)}`, name: feature });
  var NO_FILTERS = { ...Object.fromEntries(FACETS.map((facet) => [facet.key, []])), wishlist: false };
  var activeCount = (filters) => FACETS.reduce((sum, facet) => sum + (filters[facet.key]?.length ?? 0), Number(filters.wishlist));
  var toggleValue = (list, value) => list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  var passes = (game, facet, picked) => !picked?.length || (facet.any ? picked.some((value) => facet.has(game, value)) : picked.every((value) => facet.has(game, value)));
  // What a search matches against, lowercased once per game rather than on every keystroke for every game.
  var searchTexts = /* @__PURE__ */ new WeakMap();
  function searchText(game) {
    let text = searchTexts.get(game);
    if (text === void 0) searchTexts.set(game, text = `${game.title} ${game.developer} ${game.publisher}`.toLowerCase());
    return text;
  }
  // The filter sheet asks for every facet's counts on each draw, and the facets that are not "any" share one
  // pool: each pool (and each facet's counts) is kept while the filters, query and wishlist are the same
  // objects the store handed out last time.
  var pools = /* @__PURE__ */ new Map();
  var countsKept = /* @__PURE__ */ new Map();
  var sameInputs = (kept, { filters, query, wishlist }) => kept && kept.filters === filters && kept.query === query && kept.wishlist === wishlist;
  function matching(state, skip) {
    const key = skip?.key ?? "";
    const kept = pools.get(key);
    if (sameInputs(kept, state)) return kept.result;
    const { filters, query, wishlist } = state;
    const q = query.trim().toLowerCase();
    const result = games.filter((game) => (!q || searchText(game).includes(q)) && FACETS.every((facet) => facet === skip || passes(game, facet, filters[facet.key])) && (!filters.wishlist || wishlist.includes(game.id)));
    pools.set(key, { filters, query, wishlist, result });
    return result;
  }
  var filterGames = (state) => matching(state);
  /** Fase 4: os filtros sobre uma lista dada (os Favoritos vindos do payload), sem guardar nada. */
  function filterList(list, { filters, query = "", wishlist = [] }) {
    const q = query.trim().toLowerCase();
    return list.filter((game) => (!q || searchText(game).includes(q)) && FACETS.every((facet) => passes(game, facet, filters[facet.key])) && (!filters.wishlist || wishlist.includes(game.id)));
  }
  /** Fase 4: as contagens de um filtro sobre uma lista dada (o facetCounts dos Favoritos vindos do payload). */
  function listCounts(list, state, facet) {
    const { filters, query = "", wishlist = [] } = state;
    const q = query.trim().toLowerCase();
    const pool = list.filter((game) => (!q || searchText(game).includes(q)) && FACETS.every((other) => facet.any && other === facet || passes(game, other, filters[other.key])) && (!filters.wishlist || wishlist.includes(game.id)));
    return Object.fromEntries(facet.options.map(({ value }) => [value, pool.filter((game) => facet.has(game, value)).length]));
  }
  function facetCounts(state, facet) {
    const kept = countsKept.get(facet.key);
    if (sameInputs(kept, state)) return kept.result;
    const pool = matching(state, facet.any ? facet : void 0);
    const result = Object.fromEntries(facet.options.map(({ value }) => [value, pool.filter((game) => facet.has(game, value)).length]));
    countsKept.set(facet.key, { filters: state.filters, query: state.query, wishlist: state.wishlist, result });
    return result;
  }
  var summaryOf = (game) => game.remote && game.summary != null ? game.summary : (game.about ?? []).find((text) => text.length > 80 && text !== text.toUpperCase()) ?? game.shortDescription;
  // The games sharing the most genres with `game`, then the most recommended; ties keep catalog order. One
  // pass that keeps only the best `limit` (the whole catalog was sorted with the shared count worked out in
  // the comparator), remembered per game: the list is complete once this module has loaded, and the game
  // page asks on every render.
  var relatedCache = /* @__PURE__ */ new Map();
  function relatedGames(game, limit = 6) {
    // Fase 4: a ficha do payload ja traz os relacionados (ct_related_list, a mesma regra).
    if (game.remote) return (game.related ?? []).slice(0, limit);
    const key = `${game.id}\n${limit}`;
    const known = relatedCache.get(key);
    if (known) return known;
    const mine = new Set(game.genres);
    const best = [];
    for (const other of games) {
      if (other.id === game.id) continue;
      let shared = 0;
      for (const genre of other.genres) if (mine.has(genre)) shared++;
      if (!shared) continue;
      const after = (entry) => entry.shared > shared || entry.shared === shared && entry.game.recommendations >= other.recommendations;
      let at = best.length;
      while (at > 0 && !after(best[at - 1])) at--;
      if (at < limit) {
        best.splice(at, 0, { game: other, shared });
        if (best.length > limit) best.pop();
      }
    }
    const result = best.map((entry) => entry.game);
    if (relatedCache.size >= 32) relatedCache.delete(relatedCache.keys().next().value);
    relatedCache.set(key, result);
    return result;
  }
  var formatDate3 = (iso) => iso ? formatDate2(iso) : "\u2014";
  // ---- glibren.45: the build, run as the module loads or a frame at a time ----------------------------------------
  // On the console the clock stands still inside a frame (state/frame-pace.js): each part runs a number of steps, more
  // while the frames stay short, fewer when one ran long. Times per phase are only measured where the clock moves (the
  // qjs measurements, tests); on the console the log gives the parts and the slowest frame while it built.
  var ready = false;
  var waiters = [];
  var pace = createFramePace({ start: 8 });
  /** `fn(paced)` once the store is built (at once if it is): paced says it was built in parts after the modules loaded. */
  function whenCatalogReady(fn) {
    if (ready) fn(CATALOG_PACED);
    else waiters.push(fn);
  }
  var isCatalogReady = () => ready;
  var catalogReady = () => new Promise((resolve) => whenCatalogReady(() => resolve()));
  /** { total, longest, steps, frames, paced, phases: { name: ms }, slowest }: the build's work in ms (the waits between parts not counted). */
  var catalogBuildStats = () => ({ ...stats, phases: { ...stats.phases }, slowest: { ...stats.slowest } });
  /** The player is waiting on the store (past the terms notice): longer parts until it is built. */
  function hurryCatalog() {
    pace.hurry();
  }
  // One part: up to `budget` steps, noting each phase's time. -> true when the build is over.
  function runPart(steps, budget) {
    const begun = Date.now();
    let over = false;
    for (let done = 0; done < budget; done++) {
      const at = Date.now();
      const step = steps.next();
      const spent = Date.now() - at;
      stats.phases[current] = (stats.phases[current] ?? 0) + spent;
      if (spent > stats.slowest.ms) stats.slowest = { phase: current, ms: spent };
      if (step.done) {
        over = true;
        break;
      }
    }
    const took = Date.now() - begun;
    stats.total += took;
    stats.steps++;
    if (took > stats.longest) stats.longest = took;
    return over;
  }
  // Fase 4: com o catalogo do payload no ar (state/catalog-remote.js), a loja abre sem montar nada aqui: index.jsx segura a
  // montagem (holdCatalogBuild) antes do primeiro quadro, e depois ou libera a loja com o payload (openRemoteStore) ou monta
  // como antes (startCatalogBuild). Precisou da loja inteira depois (loja TorBox, payload caiu): startCatalogBuild e, ao
  // terminar, os onLocalCatalog (store-mode.js refaz as linhas e a loja e montada de novo).
  var held = CATALOG_HELD;
  var buildStarted = false;
  var localBuilt = false;
  var remoteActive = false;
  var localWaiters = [];
  /** Fase 4: segura a montagem (chamar antes do primeiro quadro; no console a montagem comeca num timer). */
  function holdCatalogBuild() {
    if (!buildStarted) held = true;
  }
  var isRemoteCatalog = () => remoteActive;
  var isLocalCatalogBuilt = () => localBuilt;
  /** Fase 4: `fn(late)` quando a loja montada aqui fica pronta (late: a loja ja tinha aberto com o payload). */
  function onLocalCatalog(fn) {
    localWaiters.push(fn);
  }
  // Quem desliga o catalogo do payload (state/remote-store.js), para quem precisa da loja inteira aqui.
  var localDisabler = null;
  var setLocalDisabler = (fn) => {
    localDisabler = fn;
  };
  /**
   * Fase 4: o que so funciona com a loja inteira aqui (a Biblioteca TorBox, a loja TorBox, a lista de catalogos das
   * Configuracoes) chama isto: com o payload no ar, ele e desligado nesta abertura e a loja e montada aqui. -> a promessa
   * de quando ela estiver pronta (na hora, se ja esta).
   */
  function ensureLocalCatalog(reason = "local") {
    if (localBuilt) return Promise.resolve();
    return new Promise((resolve) => {
      localWaiters.push(() => resolve());
      if (remoteActive && localDisabler) localDisabler(reason);
      else startCatalogBuild();
    });
  }
  function release(paced) {
    ready = true;
    for (const fn of waiters.splice(0)) {
      try {
        fn(paced);
      } catch (error) {
        console.log(`[catalog] after the build: ${error?.message || error}`);
      }
    }
  }
  function built() {
    localBuilt = true;
    stats.frames = pace.slowest();
    console.log(`[catalog] built: ${entries.length} games in ${stats.steps} part(s)${CATALOG_PACED ? `, the slowest frame ${pace.slowest()} ms` : ""}; work ${stats.total} ms, the longest part ${stats.longest} ms, the slowest step ${stats.slowest.ms} ms in ${stats.slowest.phase || "-"} (${Object.entries(stats.phases).map(([name, ms]) => `${name} ${ms}`).join(", ")})`);
    const late = ready;
    remoteActive = false;
    if (!late) release(CATALOG_PACED);
    for (const fn of localWaiters.splice(0)) {
      try {
        fn(late);
      } catch (error) {
        console.log(`[catalog] after the late build: ${error?.message || error}`);
      }
    }
  }
  /** Monta a loja aqui (uma vez): no console em partes, um quadro de cada vez; fora dele de uma vez. */
  function startCatalogBuild() {
    held = false;
    if (buildStarted) return;
    buildStarted = true;
    const steps = buildSteps();
    if (!CATALOG_PACED) {
      runPart(steps, Infinity);
      built();
    } else {
      // A frame a time: the runtime runs timers once a frame, so a 0 ms timer is the next frame.
      const part = () => {
        let over = false;
        try {
          over = runPart(steps, pace.begin());
        } catch (error) {
          console.log(`[catalog] the build failed: ${error?.message || error}`);
          over = true;
        }
        if (over) built();
        else setTimeout(part, 0);
      };
      setTimeout(part, 0);
    }
  }
  /**
   * Fase 4: a loja abre com o catalogo do payload: as opcoes dos filtros vem dele (`options`: a resposta do
   * GET /api/catalog/options) e nada e montado aqui. -> false quando a loja ja abriu (montada aqui).
   */
  function openRemoteStore(options) {
    if (buildStarted || ready) return false;
    remoteActive = true;
    const take = (key) => Array.isArray(options?.[key]) ? options[key] : [];
    hosts.splice(0, hosts.length, ...take("provider").map((value) => ({ value, name: HOST_NAMES[value] ?? value })));
    genres = [...take("genre")].sort();
    for (const facet of FACETS) {
      if (!facet.optionsOf) continue;
      const values = take(facet.key);
      let list;
      if (facet.key === "format") list = values.map((value) => value === "ready" ? { value: "ready", label: "release.compat.ready", name: "13.60 Ready" } : { value, label: `release.type.${value}`, name: value });
      else if (facet.key === "genre" || facet.key === "feature") list = named(values, facet.key);
      else continue;
      facet.options.splice(0, facet.options.length, ...list);
    }
    features.splice(0, features.length, ...take("feature"));
    memorySample("loja:payload");
    release(true);
    return true;
  }
  // Sem ninguem segurar: como antes (no console, a montagem comeca no proximo quadro; index.jsx pode segurar ate la).
  if (!CATALOG_PACED) {
    if (!held) startCatalogBuild();
  } else setTimeout(() => {
    if (!held) startCatalogBuild();
  }, 0);

export { ensureLocalCatalog, setLocalDisabler, filterList, holdCatalogBuild, isLocalCatalogBuilt, isRemoteCatalog, listCounts, onLocalCatalog, setRemoteLookup, startCatalogBuild, openRemoteStore, BUNDLED, catalogBuildStats, catalogReady, hurryCatalog, isCatalogReady, whenCatalogReady, allListed, catalogEntries, catalogSources, sourcesOfGame, refreshDerived, CDN_HOST, FACETS, NO_FILTERS, SORTS, activeCount, bundledIndex, editionsOf, facetCounts, facetLabel, facetTitle, featureLabel, filterGames, formatDate3, fromArchive, genreLabel, genres, getGame, listedId, onCdn, oneEach, optionLabel, otherThan, ratingScore, readyHere, readyLabel, relatedGames, sortGames, sortLabel, summaryOf, toggleValue, topRated, warmCovers };
