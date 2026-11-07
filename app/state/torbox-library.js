// glibren.9: a "Biblioteca TorBox", montada a pedido (Configurações > Biblioteca TorBox; nunca sozinha).
// Passa por todos os jogos do catálogo (o embutido, o ao vivo e os feeds que o jogador incluiu, ou só as fontes
// escolhidas) e pergunta ao TorBox o que ele já tem de cada um, do mesmo jeito que "Procurar no TorBox" faz jogo
// a jogo (state/torbox-search.js), mas em lote:
//   - os links do catálogo: /webdl/checkcached (MD5 do link e do link sem a query) e /torrents/checkcached (o
//     info hash de um magnet), com list_files, 100 hashes por chamada (GET; 200 passa, 400 dá HTTP 414);
//   - a conta: /webdl/mylist e /torrents/mylist uma vez, cada item casado pelo código (PPSA/CUSA, no nome do item
//     ou de um arquivo) ou por todas as palavras do nome do jogo (no nome do item);
//   - a lista de hashes do jogador (torbox-hashes.txt): checada uma vez, casada pelo código da linha ou pelo nome;
//   - os jogos que nada disso achou: o MD5 do nome de cada arquivo do catálogo e de "<código>.<tipo>" (exfat, ffpkg,
//     ffpfs, ffpfsc), que o TorBox também reconhece (pesquisa de 05/11/2026). Ele responde com a chave do link de
//     origem, que o app não tem: o jogo fica "conhecido" (`torbox.known`), mas não confirmado, porque baixar
//     depende de um link do mesmo arquivo.
// A busca por texto (search-api.torbox.app) fica de fora, como na ficha do jogo: o serviço sumiu e um nome que
// não resolve deixa o transporte HTTP do console recusando os pedidos seguintes.
//
// Gentileza com a API: uma chamada por vez, no mínimo PACE_MS entre elas (o TorBox dá 300 chamadas por janela de
// ~60 s: cabeçalhos x-ratelimit-limit=300 e retry-after≈60, medidos em 06/11/2026), e num 429 espera um minuto
// (dois, quatro) antes de tentar de novo. Um lote que o TorBox recusa (414, resposta grande demais) é partido ao
// meio até passar; um link que sozinho ainda falha fica marcado com o erro.
//
// Retomável: cada jogo verificado leva o id da rodada (`torbox.run`) e o banco é gravado a cada bloco de jogos.
// Cancelar, fechar o app ou faltar rede deixa a rodada aberta (`run.finishedAt` nulo), e o próximo "Continuar"
// pula o que já tem o id dela. "Montar de novo" começa uma rodada nova.
//
// Dois arquivos (formato exato em LIBRARY_FORMAT e LIST_FORMAT abaixo; nenhum tem a chave nem link assinado):
//   - o banco, `torbox-biblioteca.json` na pasta de dados do app (e uma cópia em /data/JobeesLair no PS5, gravada
//     ao terminar uma rodada: ~1 MB, refazer leva minutos);
//   - a lista para o payload/celular, `torbox-lista.json` em /data/JobeesLair no PS5 (na pasta de dados do app
//     no PC), só com os jogos confirmados;
//   - e só os ids confirmados, `torbox-loja.json` na pasta de dados do app (~10 KB): o que a loja TorBox lê ao abrir
//     o app (state/store-mode.js), sem ler a lista inteira (~600 KB para ~950 jogos);
//   - glibren.9: as fichas dos confirmados para o celular, `torbox-fichas.json` ao lado da lista (DETAILS_FORMAT):
//     resumo, fotos, vídeos e detalhes da loja. Fica à parte porque é bem maior que a lista: o payload indexa só a
//     lista e lê a ficha de um jogo quando o celular a abre.

import { isoStamp } from './clock.js';
import { youtubeId } from './youtube.js';
import { formatFromName } from './link-formats.js';
import { BROKEN_BYTES, brokenFile } from './broken-copy.js';
import { isMagnet, linkHashes, magnetHash, md5 } from '../services/torbox.js';
import { FORMAT_RANK, baseName, catalogLinks, catalogSets, setHolding, codePattern, filesOf, isBackportFile, isPiece, magnetOf, matchesGame, plain, titleWords, worthShowing } from './torbox-search.js';

  var LIBRARY_FILE = "torbox-biblioteca.json";
  var LIST_FILE = "torbox-lista.json";
  var IDS_FILE = "torbox-loja.json";
  var DETAILS_FILE = "torbox-fichas.json";
  var PS5_DIR = "/data/JobeesLair";
  /**
   * O banco (torbox-biblioteca.json):
   * {
   *   version: 1,
   *   builtAt: "2026-11-06T12:00:00.000Z" | null,     // fim da última rodada completa
   *   run: { id, startedAt, finishedAt | null, sources: ["bundled", "<url do feed>", ...], total, done, found,
   *          errors, calls } | null,
   *   games: { "<id>": {
   *     id: "PPSA01234",            // chave estável: o id do jogo no catálogo (o código PPSA/CUSA)
   *     title, code: "PPSA01234" | null, platform: "ps5" | "ps4",
   *     sources: ["bundled" | "<url do feed>", ...],   // de onde o jogo vem
   *     genres: [...], cover: "https://..." | null, sizeBytes: number | null, formats: ["exfat", ...],
   *     torbox: { confirmed: bool, checkedAt: iso, run: "<id da rodada>", hash: string | null, name: string | null,
   *               files: [{ name, size, format, via: "webdl" | "torrent" | "account", hash, release?, item?, file?,
   *                         parts?: [{ hash, name?, size }] }],
   *               known?: [{ name, size, format, via: "name" | "code" | "parts", hash, release?, parts?, missing?,
   *                          total? }],  // só quando não confirmado
   *               error?: string }
   *   glibren.16: um conjunto em partes (release.parts no catálogo) é UM arquivo: via "webdl", `release` o id do conjunto
   *   (set-...), `parts` as partes guardadas na ordem (hash = MD5 do link da parte, ou o info hash de um magnet), `size`
   *   a soma, `name` "<nome da parte 1 sem a parte> (N partes)". Só entra em `files` com TODAS as partes no TorBox; com
   *   algumas, vai para `known` (via "parts", `missing` de `total` faltando) e não confirma o jogo.
   *   } }
   * }
   */
  var LIBRARY_FORMAT = 1;
  /**
   * A lista do payload (torbox-lista.json), só os confirmados:
   * { version: 1, builtAt: iso, games: [{ id, title, code, platform, genres: [], sizeBytes, formats: [], hash,
   *   files: [{ name, size, format, via, hash, release?, item?, file? }], cover? }] }
   * `hash` (do jogo e de cada arquivo): via "torrent" é o info hash (40 hex; magnet:?xt=urn:btih:<hash>), via
   * "webdl" é o MD5 do link do catálogo (o link fica no app: `release` é o id da fonte em app/data/releases/<id>.json
   * ou no feed), via "account" é o hash do item que já está na conta (`item`: { kind, id }, `file`: id do arquivo).
   * glibren.16: `parts` (opcional) num arquivo "webdl" diz que ele é um conjunto em partes (o payload lê só quantas são;
   * um payload antigo ignora o campo e mostra o nome, "... (N partes)"). Formato continua 1: só campos novos opcionais.
   */
  var LIST_FORMAT = 1;
  /**
   * As fichas para o celular (torbox-fichas.json), dos mesmos jogos da lista e na mesma ordem:
   * { version: 1, builtAt: iso, games: [{ id,                     // sempre o primeiro campo (o payload procura por ele)
   *   summary?, about?: ["parágrafo", ...], shots?: [{ url, thumb? }], videos?: ["<id do YouTube>", ...],
   *   cover?, coverFallbacks?: [...], hero?, developer?, publisher?, releaseDate?: "AAAA-MM-DD", metacritic?, stars?,
   *   ratingCount?, features?: [...] }] }
   * Só endereços https; campos vazios ficam de fora. As fotos e o texto vêm da página do jogo na loja (data/pages ou
   * o feed), os vídeos do feed ("videos"; o catálogo embutido não tem: o celular busca no YouTube pelo nome).
   */
  var DETAILS_FORMAT = 1;
  var MAX_SHOTS = 8, MAX_ABOUT = 4, MAX_PARAGRAPH = 900, MAX_SUMMARY = 600, MAX_VIDEOS = 6;
  // Um jogo guarda no máximo estes arquivos (um torrent de pasta pode ter centenas).
  var MAX_FILES = 40;
  // Os links de um pedido: um link web vira até 2 hashes, e o GET leva 100 hashes.
  var WEB_GROUP = 50, MAGNET_GROUP = 100;
  var PACE_MS = 400;
  var RATE_WAIT_MS = 61e3;
  var CHUNK = 50;
  // Os tipos testados com o código do jogo ("PPSA01234.exfat").
  var CODE_TYPES = ["exfat", "ffpkg", "ffpfs", "ffpfsc"];
  var ALT_GROUP = 100;
  var SAVE_EVERY_MS = 15e3;

  var emptyLibrary = () => ({ version: LIBRARY_FORMAT, builtAt: null, run: null, games: {} });
  var validLibrary = (value) => Boolean(value) && typeof value === "object" && value.version === LIBRARY_FORMAT && value.games && typeof value.games === "object" && !Array.isArray(value.games);
  /** Onde ficam os arquivos: `dataDir` é a pasta de dados do app; `ps5` diz se é o console. */
  function libraryPaths(dataDir, ps5) {
    return {
      library: `${dataDir}/${LIBRARY_FILE}`,
      backup: ps5 ? `${PS5_DIR}/${LIBRARY_FILE}` : null,
      list: ps5 ? `${PS5_DIR}/${LIST_FILE}` : `${dataDir}/${LIST_FILE}`,
      ids: `${dataDir}/${IDS_FILE}`,
      details: ps5 ? `${PS5_DIR}/${DETAILS_FILE}` : `${dataDir}/${DETAILS_FILE}`
    };
  }
  function writeAtomic(fs, path, text) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) fs.mkdir(dir, { recursive: true });
    fs.writeFile(`${path}.tmp`, text);
    fs.rename(`${path}.tmp`, path);
  }
  function readJson(fs, path) {
    try {
      if (!path || !fs.exists(path)) return null;
      return JSON.parse(String(fs.readFile(path)));
    } catch {
      return null;
    }
  }
  /** O banco gravado (o da pasta do app, senão a cópia em /data), ou um vazio. */
  function readLibrary(fs, paths) {
    for (const path of [paths.library, paths.backup]) {
      const value = readJson(fs, path);
      if (validLibrary(value)) return value;
    }
    return emptyLibrary();
  }
  function writeLibrary(fs, paths, library, { backup = false } = {}) {
    const text = JSON.stringify(library);
    writeAtomic(fs, paths.library, text);
    if (backup && paths.backup) {
      try {
        writeAtomic(fs, paths.backup, text);
      } catch (error) {
        console.log(`[torbox-library] copy not written to ${paths.backup}: ${error?.message || error}`);
      }
    }
  }
  // glibren.13: confirmado e com pelo menos um arquivo que nao e copia quebrada. Reaplica a regra a jogos gravados por
  // rodadas antigas (antes dela), sem precisar montar de novo para tira-los da loja e do celular.
  var stillConfirmed = (record) => Boolean(record?.torbox?.confirmed) && (!Array.isArray(record.torbox.files) || !record.torbox.files.length || record.torbox.files.some((file) => !brokenFile(file)));
  var brokenOnly = (record) => Boolean(record?.torbox?.broken) || Boolean(record?.torbox?.confirmed) && !stillConfirmed(record);
  // A marca, na lista de ids, de que ela ja segue a regra das copias quebradas (uma antiga e refeita uma vez do banco).
  var IDS_RULES = ["broken"];
  /** A lista do payload a partir do banco: só os confirmados, em ordem de título. */
  function exportList(library, now = Date.now()) {
    const games = Object.values(library.games).filter(stillConfirmed).sort((a, b) => a.title.localeCompare(b.title)).map((record) => ({
      id: record.id,
      title: record.title,
      code: record.code,
      platform: record.platform,
      genres: record.genres,
      sizeBytes: record.sizeBytes,
      formats: record.formats,
      hash: record.torbox.hash,
      files: record.torbox.files,
      ...record.cover ? { cover: record.cover } : {}
    }));
    return { version: LIST_FORMAT, builtAt: library.builtAt ?? isoStamp(now), games };
  }
  // ---- As fichas (torbox-fichas.json) ----
  var httpsURL = (value) => typeof value === "string" && value.length <= 600 && /^https:\/\/[^\s"'<>\\]+$/i.test(value) ? value : null;
  var oneLine = (value, max) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
  // Um campo do jogo do catálogo; um getter que falha (página que não lê) conta como vazio.
  function field(game, name) {
    try {
      return game?.[name];
    } catch {
      return void 0;
    }
  }
  /** A ficha de um jogo do catálogo para o celular (DETAILS_FORMAT), sem o id. */
  function gameDetails(game) {
    if (!game || typeof game !== "object") return {};
    const art = field(game, "art") || {};
    const out = {};
    const summary = oneLine(field(game, "shortDescription"), MAX_SUMMARY);
    if (summary) out.summary = summary;
    const about = (Array.isArray(field(game, "about")) ? field(game, "about") : []).map((text) => oneLine(text, MAX_PARAGRAPH)).filter(Boolean).slice(0, MAX_ABOUT);
    if (about.length) out.about = about;
    const shots = [];
    for (const shot of Array.isArray(field(game, "shots")) ? field(game, "shots") : []) {
      const url = httpsURL(typeof shot === "string" ? shot : shot?.url);
      if (!url || shots.some((kept) => kept.url === url)) continue;
      const thumb = httpsURL(shot?.thumb);
      shots.push(thumb && thumb !== url ? { url, thumb } : { url });
      if (shots.length >= MAX_SHOTS) break;
    }
    if (shots.length) out.shots = shots;
    const videos = [...new Set((Array.isArray(field(game, "videos")) ? field(game, "videos") : []).map(youtubeId).filter(Boolean))].slice(0, MAX_VIDEOS);
    if (videos.length) out.videos = videos;
    const cover = httpsURL(art.cover);
    if (cover) out.cover = cover;
    const fallbacks = (Array.isArray(art.coverFallbacks) ? art.coverFallbacks : []).map(httpsURL).filter((url) => url && url !== cover).slice(0, 2);
    if (fallbacks.length) out.coverFallbacks = fallbacks;
    const hero = httpsURL(art.hero);
    if (hero) out.hero = hero;
    for (const name of ["developer", "publisher"]) {
      const text = oneLine(field(game, name), 120);
      if (text) out[name] = text;
    }
    const date = field(game, "releaseDate");
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.releaseDate = date;
    const metacritic = field(game, "metacritic");
    if (Number.isInteger(metacritic) && metacritic > 0 && metacritic <= 100) out.metacritic = metacritic;
    const stars = field(game, "stars");
    if (Number.isFinite(stars) && stars > 0 && stars <= 5) out.stars = Math.round(stars * 100) / 100;
    const ratings = field(game, "ratingCount");
    if (Number.isInteger(ratings) && ratings > 0) out.ratingCount = ratings;
    const features = (Array.isArray(field(game, "features")) ? field(game, "features") : []).map((text) => oneLine(text, 40)).filter(Boolean).slice(0, 12);
    if (features.length) out.features = features;
    return out;
  }
  /** As fichas da lista: `detailsOf(id)` dá o jogo do catálogo (null: sem ficha, só o id). */
  function exportDetails(list, detailsOf) {
    return { version: DETAILS_FORMAT, builtAt: list.builtAt, games: list.games.map((game) => ({ id: game.id, ...gameDetails(detailsOf(game.id)) })) };
  }
  /**
   * Grava a lista do payload e os ids da loja; com `gameOf(id)` (o jogo do catálogo), também as fichas do celular.
   * Uma ficha que falha não impede a lista.
   */
  function writeList(fs, paths, library, now, gameOf = null) {
    const list = exportList(library, now);
    writeAtomic(fs, paths.list, JSON.stringify(list));
    // { version: 1, builtAt, ids: ["PPSA01234", ...] }
    writeAtomic(fs, paths.ids, JSON.stringify({ version: LIST_FORMAT, builtAt: list.builtAt, rules: IDS_RULES, ids: list.games.map((game) => game.id) }));
    if (gameOf && paths.details) {
      try {
        writeAtomic(fs, paths.details, JSON.stringify(exportDetails(list, gameOf)));
      } catch (error) {
        console.log(`[torbox-library] details not written to ${paths.details}: ${error?.message || error}`);
      }
    }
  }
  /** Os ids confirmados da lista gravada (a loja TorBox, state/store-mode.js): null quando não há lista. */
  // glibren.13: uma lista de ids gravada antes da regra das copias quebradas e refeita do banco (uma vez: a nova leva a
  // marca), com a lista do payload; as fichas ficam (o payload as procura pelo id, uma a mais nao atrapalha).
  function readConfirmedIds(fs, paths) {
    const kept = readJson(fs, paths.ids);
    const current = kept && kept.version === LIST_FORMAT && Array.isArray(kept.ids);
    if (current && IDS_RULES.every((rule) => kept.rules?.includes(rule))) return new Set(kept.ids);
    const library = readLibrary(fs, paths);
    if (library.builtAt) {
      try {
        writeList(fs, paths, library);
      } catch (error) {
        console.log(`[torbox-library] list not rewritten: ${error?.message || error}`);
      }
      return new Set(Object.values(library.games).filter(stillConfirmed).map((record) => record.id));
    }
    if (current) return new Set(kept.ids);
    const list = readJson(fs, paths.list);
    if (list && list.version === LIST_FORMAT && Array.isArray(list.games)) return new Set(list.games.map((game) => game.id));
    const ids = Object.values(library.games).filter(stillConfirmed).map((record) => record.id);
    return ids.length ? new Set(ids) : null;
  }

  // ---- O que se sabe de um jogo ----
  var CODE = /(PPSA|CUSA)[-_ ]?(\d{5})/gi;
  var codesIn = (text) => [...String(text || "").matchAll(CODE)].map((match) => `${match[1].toUpperCase()}${match[2]}`);
  var codeOf = (game) => codePattern(game.id) ? String(game.id).toUpperCase().replace(/[-_ ]/g, "") : null;
  /** Os campos do catálogo que o banco guarda de um jogo (`sources`: de onde ele vem). */
  function describe(game, sources) {
    const cover = typeof game.art?.cover === "string" ? game.art.cover : null;
    return {
      id: game.id,
      title: String(game.title || game.id),
      code: codeOf(game),
      platform: game.platform === "ps4" ? "ps4" : "ps5",
      sources,
      genres: Array.isArray(game.genres) ? game.genres : [],
      cover,
      sizeBytes: Number.isFinite(game.sizeGb) && game.sizeGb > 0 ? Math.round(game.sizeGb * 1e9) : null,
      formats: Array.isArray(game.formats) ? game.formats : []
    };
  }
  var rankOf = (format) => {
    const index = FORMAT_RANK.indexOf(format);
    return index < 0 ? FORMAT_RANK.length : index;
  };
  // glibren.13: um arquivo de jogo (imagem, pacote ou compactado) com menos de 1 MiB nao e o jogo: e uma copia quebrada no
  // TorBox (visto em 07/11/2026: um .pkg de 170 bytes que era a pagina "500 Internal Server Error" do site de origem). Fica
  // marcado ("broken"), por ultimo, e nunca e o recomendado (a pagina do celular avisa e o payload recusa baixa-lo).
  // Os arquivos de um jogo: uma vez cada (nome e tamanho), imagens de disco primeiro, depois o maior; os quebrados no fim.
  function tidy(files) {
    const seen = /* @__PURE__ */ new Set();
    return files.filter((file) => {
      const key = `${file.name.toLowerCase()}|${file.size}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((file) => brokenFile(file) ? { ...file, broken: true } : file).sort((a, b) => Number(Boolean(a.broken)) - Number(Boolean(b.broken)) || Number(Boolean(a.piece)) - Number(Boolean(b.piece)) || rankOf(a.format) - rankOf(b.format) || Number(Boolean(a.parts)) - Number(Boolean(b.parts)) || b.size - a.size || a.name.localeCompare(b.name)).slice(0, MAX_FILES);
  }
  // Os arquivos que contam de um item ou entrada do TorBox, cada um com de onde veio.
  function fileRows(item, fields, accept = () => true) {
    return filesOf(item).filter((file) => !isBackportFile(file) && worthShowing(file) && accept(file)).map((file) => {
      const name = baseName(file.name);
      return { name, size: Number(file.size) || 0, format: formatFromName(name), ...fields, ...file.id !== void 0 && fields.via === "account" ? { file: file.id } : {}, ...isPiece(name) ? { piece: true } : {} };
    });
  }
  /** A conta (itens de mylist) arrumada para casar muitos jogos: por código e pelo nome em texto simples. */
  function indexAccount(lists) {
    const byCode = /* @__PURE__ */ new Map();
    const items = [];
    for (const [kind, list] of lists) {
      for (const raw of list || []) {
        const item = { kind, id: raw.id, name: String(raw.name || ""), hash: String(raw.hash || "").toLowerCase() || null, size: Number(raw.size) || 0, files: Array.isArray(raw.files) ? raw.files : [], text: ` ${plain(raw.name)} ` };
        items.push(item);
        const codes = new Set([...codesIn(item.name), ...item.files.flatMap((file) => codesIn(file.name || file.short_name))]);
        for (const code of codes) byCode.set(code, [...byCode.get(code) ?? [], item]);
      }
    }
    return { byCode, items };
  }
  function accountFiles(index, game) {
    if (!index) return [];
    const code = codeOf(game);
    const words = titleWords(game.title);
    const rows = [];
    const take = (item, accept) => rows.push(...fileRows(item, { via: "account", hash: item.hash, item: { kind: item.kind, id: item.id }, torrent: item.name }, accept));
    const done = /* @__PURE__ */ new Set();
    for (const item of code ? index.byCode.get(code) ?? [] : []) {
      done.add(item);
      const whole = matchesGame(item.name, game);
      take(item, whole ? void 0 : (file) => matchesGame(file.path, game));
    }
    if (words.length) {
      for (const item of index.items) if (!done.has(item) && words.every((word) => item.text.includes(` ${word} `))) take(item);
    }
    return rows;
  }
  /** A lista de hashes do jogador já checada: [{ hash, code, entry }] só os que o TorBox tem. */
  function listFiles(held, game) {
    if (!held?.length) return [];
    const code = codeOf(game);
    const rows = [];
    for (const { hash, code: lineCode, entry } of held) {
      if (lineCode && lineCode !== code) continue;
      const named = lineCode === code && code || matchesGame(entry.name || "", game) || filesOf(entry).some((file) => matchesGame(file.path, game));
      if (named) rows.push(...fileRows(entry, { via: "torrent", hash, torrent: entry.name || "" }));
    }
    return rows;
  }
  /**
   * glibren.16: os conjuntos em partes do catálogo (`sets`, de catalogSets) no que o TorBox tem: com todas as partes
   * guardadas, uma linha só pela release inteira ({ name: "<nome> (N partes)", size: a soma, format, via: "webdl",
   * hash: o da primeira parte, release: o id do conjunto, parts: [{ hash, name?, size }] }); com só algumas, uma linha
   * em `partial` (o "known" do jogo: { ..., via: "parts", missing, total }), que não confirma o jogo.
   */
  function setFiles(sets, heldByLink) {
    const rows = [], partial = [];
    for (const set of sets) {
      const holding = setHolding(set, heldByLink);
      if (!holding.held) continue;
      const row = { name: holding.name, size: holding.size, format: holding.format, hash: holding.parts[0].hash, release: set.release.id ?? null, parts: holding.parts, torrent: "" };
      if (holding.complete) rows.push({ ...row, via: "webdl" });
      else partial.push({ ...row, via: "parts", missing: holding.total - holding.held, total: holding.total });
    }
    return { rows, partial };
  }
  function catalogFiles(links, heldByLink) {
    const rows = [];
    for (const [link, release] of links) {
      const entry = heldByLink.get(link);
      if (!entry) continue;
      const magnet = isMagnet(link);
      // glibren.18: num "webdl", o link PUBLICO do catalogo (o que o TorBox guarda; nunca um assinado nem com chave), para o
      // payload pedir o arquivo ao TorBox sozinho quando o celular pede um jogo com a Jobee'sLair fechada.
      const publicLink = !magnet && /^https?:\/\/[^\s"\\]+$/i.test(link) && link.length < 1000 && !/(?:token|key|apikey|api_key)=/i.test(link) ? { link } : {};
      const fields = { via: magnet ? "torrent" : "webdl", hash: magnet ? magnetHash(link) : linkHashes(link)[0], release: release.id ?? null, ...publicLink, torrent: entry.name || "" };
      const rowsOf = fileRows(entry, fields);
      // Um link guardado sem lista de arquivos ainda é o arquivo do catálogo.
      rows.push(...rowsOf.length ? rowsOf : [{ name: baseName(release.filename || entry.name || link), size: Number(entry.size) || Number(release.sizeBytes) || 0, format: release.format || formatFromName(release.filename || ""), ...fields }]);
    }
    return rows;
  }
  /** O resultado do TorBox de um jogo, a partir das linhas achadas. */
  function verdict(rows, runId, now, error, known = []) {
    const files = tidy(rows);
    const best = files.find((file) => !file.broken) ?? files[0];
    const others = files.length ? [] : tidy(known);
    // glibren.13: so copias quebradas (paginas de erro guardadas como o arquivo): nao confirma; `broken` diz quantas.
    const good = files.some((file) => !file.broken);
    return {
      confirmed: good,
      ...files.length && !good ? { broken: files.length } : {},
      checkedAt: isoStamp(now),
      run: runId,
      hash: best?.hash ?? null,
      name: best?.torrent || null,
      files: files.map(({ torrent: _torrent, ...file }) => file),
      ...others.length ? { known: others.map(({ torrent: _torrent, ...file }) => file) } : {},
      ...error ? { error } : {}
    };
  }

  // ---- A rodada ----
  var stopped = () => Object.assign(new Error("Stopped."), { name: "AbortError" });
  var defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopped());
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(stopped());
    };
    signal?.addEventListener?.("abort", stop, { once: true });
  });
  var transient = (error) => error?.code === "NETWORK" || /^HTTP_5\d\d$/.test(error?.code || "");

  /**
   * Monta (ou continua) a biblioteca. `entries`: [{ game, sources }] (os jogos e de onde vêm); `api`: o cliente
   * TorBox (services/torbox.js: myList, cachedEntries); `hashList`: readHashList (null: nenhuma); `library`: o
   * banco lido (readLibrary); `save(library, { final })` grava; `onProgress(progress)` ouve o andamento.
   * `sources`: as fontes escolhidas (null: todas). -> { library, progress }. Cancelar (`signal`) grava o que já
   * foi feito e rejeita com AbortError.
   */
  async function buildLibrary({ entries, api, hashList = null, library = emptyLibrary(), save = () => {}, onProgress = () => {}, signal, sources = null, fresh = false, sleep = defaultSleep, now = Date.now, pace = PACE_MS, rateWait = RATE_WAIT_MS, chunk = CHUNK, saveEvery = SAVE_EVERY_MS, log = () => {} }) {
    const wanted = sources ? new Set(sources) : null;
    const picked = entries.filter((entry) => !wanted || entry.sources.some((source) => wanted.has(source)));
    const sourceList = sources ? [...sources].sort() : null;
    const open = library.run && !library.run.finishedAt && !fresh && JSON.stringify(library.run.sources) === JSON.stringify(sourceList);
    const run = open ? library.run : { id: `${now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`, startedAt: isoStamp(now()), finishedAt: null, sources: sourceList, total: 0, done: 0, found: 0, known: 0, errors: 0, calls: 0 };
    library.run = run;
    run.total = picked.length;
    const pending = picked.filter((entry) => library.games[entry.game.id]?.torbox?.run !== run.id);
    run.done = picked.length - pending.length;
    const mine = picked.map((entry) => library.games[entry.game.id]?.torbox).filter((torbox) => torbox?.run === run.id);
    run.found = mine.filter((torbox) => torbox.confirmed).length;
    run.known = mine.filter((torbox) => torbox.known).length;
    run.broken = mine.filter((torbox) => torbox.broken).length; // glibren.13
    const startedAt = now();
    const doneAtStart = run.done;
    let waitingUntil = null, phase = "account", lastCall = 0;
    const progress = () => {
      const segment = run.done - doneAtStart;
      const elapsed = now() - startedAt;
      return { phase, runId: run.id, resumed: open, total: run.total, done: run.done, found: run.found, known: run.known, broken: run.broken, errors: run.errors, calls: run.calls, startedAt: run.startedAt, waitingUntil, etaMs: segment > 0 ? Math.round(elapsed / segment * (run.total - run.done)) : null };
    };
    const tell = () => onProgress(progress());
    // Uma chamada ao TorBox, no ritmo e com as esperas de um 429.
    async function polite(work) {
      for (let attempt = 0; ; attempt++) {
        const gap = lastCall + pace - now();
        if (gap > 0) await sleep(gap, signal);
        lastCall = now();
        run.calls++;
        try {
          return await work();
        } catch (error) {
          if (error?.name === "AbortError" || signal?.aborted) throw error.name === "AbortError" ? error : stopped();
          const limited = error?.code === "RATE_LIMITED";
          if (limited && attempt < 4 || transient(error) && attempt < 2) {
            const ms = limited ? rateWait * 2 ** Math.min(attempt, 2) : 5e3 * (attempt + 1);
            log(`${error.code}: waiting ${Math.round(ms / 1e3)} s`);
            waitingUntil = now() + ms;
            tell();
            await sleep(ms, signal);
            waitingUntil = null;
            continue;
          }
          throw error;
        }
      }
    }
    // O que o TorBox tem de `links`; um grupo recusado é partido ao meio, e um link que sozinho falha volta em `failed`.
    async function held(links, failed) {
      const found = /* @__PURE__ */ new Map();
      if (!links.length) return found;
      try {
        for (const [link, entry] of await polite(() => api.cachedEntries(links, { signal }))) found.set(link, entry);
      } catch (error) {
        if (error?.name === "AbortError" || transient(error) || error?.code === "RATE_LIMITED") throw error;
        if (links.length === 1) {
          failed.set(links[0], error?.code || error?.message || "error");
          return found;
        }
        const half = Math.ceil(links.length / 2);
        for (const [link, entry] of await held(links.slice(0, half), failed)) found.set(link, entry);
        for (const [link, entry] of await held(links.slice(half), failed)) found.set(link, entry);
      }
      return found;
    }
    async function heldAll(links, failed) {
      const web = links.filter((link) => !isMagnet(link));
      const magnets = links.filter(isMagnet);
      const found = /* @__PURE__ */ new Map();
      for (let i = 0; i < web.length; i += WEB_GROUP) for (const [link, entry] of await held(web.slice(i, i + WEB_GROUP), failed)) found.set(link, entry);
      for (let i = 0; i < magnets.length; i += MAGNET_GROUP) for (const [link, entry] of await held(magnets.slice(i, i + MAGNET_GROUP), failed)) found.set(link, entry);
      return found;
    }
    // Os jogos que nada achou, pelos outros nomes que o TorBox reconhece: o MD5 do nome de cada arquivo do catálogo e
    // de "<código>.<tipo>". A resposta vem pela chave do link de origem, então cada entrada volta ao seu jogo pelo
    // nome: o nome de um arquivo pedido, ou o código de um jogo pedido no nome dela ou de um arquivo dela.
    async function knownByName(games) {
      const byName = /* @__PURE__ */ new Map(), byCode = /* @__PURE__ */ new Map(), hashes = [];
      for (const game of games) {
        const code = codeOf(game);
        if (code) {
          byCode.set(code, game);
          hashes.push(...CODE_TYPES.map((type) => md5(`${code}.${type}`)));
        }
        for (const release of game.releases || []) {
          const name = release.parts ? null : baseName(release.filename || "");
          if (!name || byName.has(name.toLowerCase())) continue;
          byName.set(name.toLowerCase(), game);
          hashes.push(md5(name));
        }
      }
      const found = /* @__PURE__ */ new Map();
      const unique = [...new Set(hashes)];
      for (let i = 0; i < unique.length; i += ALT_GROUP) {
        let entries;
        try {
          entries = await polite(() => api.cachedByHash(unique.slice(i, i + ALT_GROUP), { signal }));
        } catch (error) {
          if (error?.name === "AbortError" || transient(error) || error?.code === "RATE_LIMITED") throw error;
          log(`names not checked: ${error?.code || error?.message}`);
          continue;
        }
        for (const entry of entries) {
          const names = [entry.name, ...filesOf(entry).map((file) => baseName(file.name))].filter(Boolean);
          const named = names.map((name) => byName.get(name.toLowerCase())).find(Boolean);
          const coded = named ? null : names.flatMap(codesIn).map((code) => byCode.get(code)).find(Boolean);
          const game = named ?? coded;
          if (!game) continue;
          const rows = fileRows(entry, { via: named ? "name" : "code", hash: entry.hash });
          found.set(game, [...found.get(game) ?? [], ...rows.length ? rows : [{ name: baseName(entry.name), size: entry.size, format: formatFromName(entry.name), via: named ? "name" : "code", hash: entry.hash }]]);
        }
      }
      return found;
    }
    tell();
    // A conta, uma vez por rodada.
    let account = null;
    try {
      const lists = [];
      for (const kind of ["webdl", "torrent"]) lists.push([kind, await polite(() => api.myList(kind, { signal }))]);
      account = indexAccount(lists);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (transient(error) || error?.code === "RATE_LIMITED") throw error;
      log(`account not read: ${error?.code || error?.message}`);
    }
    // A lista de hashes do jogador, uma vez por rodada.
    phase = "list";
    tell();
    let listHeld = [];
    if (hashList?.entries?.length) {
      const failed = /* @__PURE__ */ new Map();
      const found = await heldAll(hashList.entries.map((item) => magnetOf(item.hash)), failed);
      listHeld = hashList.entries.filter((item) => found.has(magnetOf(item.hash))).map((item) => ({ hash: item.hash, code: item.code, entry: found.get(magnetOf(item.hash)) }));
    }
    // Os jogos, em blocos: os links do bloco todo em poucos pedidos.
    phase = "games";
    tell();
    let savedAt = now();
    // O que parar a rodada (Cancelar, TorBox fora do ar) guarda o que já foi verificado: a próxima continua dali.
    try {
      for (let start = 0; start < pending.length; start += chunk) {
        if (signal?.aborted) throw stopped();
        const block = pending.slice(start, start + chunk);
        const linksOf = new Map(block.map(({ game }) => [game, catalogLinks(game)]));
        // glibren.16: as partes dos conjuntos vão no mesmo lote (nos mesmos grupos de WEB_GROUP/MAGNET_GROUP links).
        const setsOf = new Map(block.map(({ game }) => [game, catalogSets(game)]));
        const asked = (game) => [...linksOf.get(game).keys(), ...setsOf.get(game).flatMap((set) => set.links)];
        const all = [...new Set(block.flatMap(({ game }) => asked(game)))];
        const failed = /* @__PURE__ */ new Map();
        const heldByLink = await heldAll(all, failed);
        const setsHeld = new Map(block.map(({ game }) => [game, setFiles(setsOf.get(game), heldByLink)]));
        const rowsOf = new Map(block.map(({ game }) => [game, [...catalogFiles(linksOf.get(game), heldByLink), ...setsHeld.get(game).rows, ...accountFiles(account, game), ...listFiles(listHeld, game)]]));
        const known = api.cachedByHash ? await knownByName(block.map(({ game }) => game).filter((game) => !rowsOf.get(game).length)) : /* @__PURE__ */ new Map();
        for (const { game, sources: from } of block) {
          const rows = rowsOf.get(game);
          const errors = asked(game).map((link) => failed.get(link)).filter(Boolean);
          const torbox = verdict(rows, run.id, now(), !rows.length && errors.length ? errors[0] : null, [...known.get(game) ?? [], ...setsHeld.get(game).partial]);
          library.games[game.id] = { ...describe(game, from), torbox };
          run.done++;
          if (torbox.confirmed) run.found++;
          if (torbox.known) run.known++;
          if (torbox.broken) run.broken++;
          if (torbox.error) run.errors++;
        }
        tell();
        if (now() - savedAt >= saveEvery) {
          save(library, { final: false });
          savedAt = now();
        }
        // Um respiro para a tela entre blocos.
        await sleep(0, signal);
      }
    } catch (error) {
      save(library, { final: false });
      throw error;
    }
    run.finishedAt = isoStamp(now());
    library.builtAt = run.finishedAt;
    phase = "done";
    save(library, { final: true });
    tell();
    return { library, progress: progress() };
  }

export { BROKEN_BYTES, brokenFile, brokenOnly, stillConfirmed, DETAILS_FILE, DETAILS_FORMAT, LIBRARY_FILE, LIBRARY_FORMAT, LIST_FILE, LIST_FORMAT, MAX_FILES, PACE_MS, RATE_WAIT_MS, buildLibrary, describe, emptyLibrary, exportDetails, exportList, gameDetails, indexAccount, libraryPaths, readConfirmedIds, readLibrary, writeLibrary, writeList };
