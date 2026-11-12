// glibren (item 2 do plano de memoria): o retrato da loja e os links dos feeds fora do heap do JavaScript.
//
// Medido no qjs (tools/memory, 11/11/2026): com a lista Orbit ligada a loja deixava 15,1 MB no heap, e 6,5 MB disso eram
// os links (releases) dos feeds e da Orbit, guardados para todos os ~2600 jogos mas so lidos quando um jogo e aberto
// (ou baixado, ou a Biblioteca TorBox e montada). Agora:
//   - os links de cada jogo vem de um arquivo de "baldes" no disco (BUCKET jogos por arquivo, na ordem do catalogo), lido
//     quando pedido e guardado so para os ultimos KEPT baldes;
//   - o que os feeds dao ao catalogo (os jogos sem os links, a pagina, o feed de origem, os formatos tirados dos links) e
//     o estado de cada feed (state/feeds.js takeFeedStates) ficam num retrato (snapshot.json): enquanto nenhum arquivo de
//     feed mudar (tamanho e hora, feeds.js feedSnapshotParts), a abertura le o retrato e nao le mais os feeds (sem o pico
//     do parse dos textos de alguns MB).
// Um retrato ou balde que nao se le (disco cheio, apagado, de outra versao) faz a loja ler os feeds como antes; um balde
// que some depois da abertura deixa o jogo so com os links do catalogo embutido (e o log diz).

import { FileSystem } from '@ps5-react/core';
import { DATA_DIR } from './data-dir.js';
import { stableKey } from './feed-format.js';
import { VERSION } from '../version.js';

  var DIR = `${DATA_DIR}/feed-store`;
  var SNAPSHOT = `${DIR}/snapshot.json`;
  var FORMAT = 1;
  // Jogos por balde: ~40 jogos com links dao 40-90 KB de texto, lidos de uma vez quando um deles e aberto.
  var BUCKET = 40;
  var KEPT = 3;
  var bucketFile = (n) => `${DIR}/links-${n}.json`;

  /** A chave do retrato: a versao do app, o console (PS4 so lista os dele) e cada feed com o carimbo dos seus arquivos. */
  var snapshotKey = (parts, ps4) => stableKey(JSON.stringify([FORMAT, VERSION, Boolean(ps4), parts]));

  /** O retrato gravado, se a chave e a mesma: { games:[{game, page, feed}], states, kinds:{id:[...]}, buckets:[[id...]] }. */
  function readSnapshot(key) {
    try {
      if (!FileSystem.exists(SNAPSHOT)) return null;
      const value = JSON.parse(FileSystem.readFile(SNAPSHOT));
      if (value?.format !== FORMAT || value.key !== key || !Array.isArray(value.games) || !Array.isArray(value.buckets)) return null;
      // Os textos repetidos de jogo para jogo (generos, estudios, hosts, datas) viram um so, como na leitura dos feeds
      // (feed-format.js `same`): o JSON.parse faz uma copia por jogo.
      const pool = /* @__PURE__ */ new Map();
      const one = (text) => {
        if (typeof text !== "string") return text;
        const known = pool.get(text);
        if (known !== void 0) return known;
        pool.set(text, text);
        return text;
      };
      for (const item of value.games) {
        const game = item?.game;
        if (!game) continue;
        for (const field of ["platform", "developer", "publisher", "releaseDate", "addedAt"]) if (field in game) game[field] = one(game[field]);
        for (const field of ["genres", "features", "providers"]) if (Array.isArray(game[field])) game[field] = game[field].map(one);
      }
      for (const id in value.kinds ?? {}) if (Array.isArray(value.kinds[id])) value.kinds[id] = value.kinds[id].map(one);
      return value;
    } catch (error) {
      console.log(`[feed-snapshot] not read: ${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * Grava os links (`releases`: Map id -> lista) em baldes na ordem `order` (os ids na ordem do catalogo) e depois o
   * retrato. -> os baldes ([[id...]]) ou null quando nao gravou (a loja fica com os links na memoria, como antes).
   */
  function writeSnapshot(key, { games, states, kinds, releases, order }) {
    try {
      FileSystem.mkdir(DIR, { recursive: true });
      const buckets = [];
      let current = [];
      const flush = () => {
        if (!current.length) return;
        const body = {};
        for (const id of current) body[id] = releases.get(id);
        FileSystem.writeFile(bucketFile(buckets.length), JSON.stringify({ key, links: body }));
        buckets.push(current);
        current = [];
      };
      for (const id of order) {
        if (!releases.has(id)) continue;
        current.push(id);
        if (current.length >= BUCKET) flush();
      }
      flush();
      // Um balde relido antes de contar com eles (um disco que nao guardou nada deixa os links na memoria).
      if (buckets.length && JSON.parse(FileSystem.readFile(bucketFile(buckets.length - 1)) || "null")?.key !== key) throw new Error("links file not kept");
      // O retrato por ultimo (tmp + rename): um retrato inteiro so existe com os baldes dele ja gravados.
      const lean = games.map(({ game, page, feed }) => ({ game, page, feed }));
      FileSystem.writeFile(`${SNAPSHOT}.tmp`, JSON.stringify({ format: FORMAT, key, games: lean, states, kinds, buckets }));
      FileSystem.rename(`${SNAPSHOT}.tmp`, SNAPSHOT);
      return buckets;
    } catch (error) {
      console.log(`[feed-snapshot] not written: ${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * Os links de um jogo lidos do balde dele. `buckets` sao os do retrato; `key`, a chave dele. -> function(id) que
   * devolve a lista (vazia quando o jogo nao tem links de feed ou o balde nao se le).
   */
  function bucketReader(key, buckets) {
    const where = new Map();
    buckets.forEach((ids, n) => {
      for (const id of ids) where.set(id, n);
    });
    const kept = new Map();
    let warned = false;
    const read = (n) => {
      let links = kept.get(n);
      if (links) {
        kept.delete(n);
      } else {
        try {
          const value = JSON.parse(FileSystem.readFile(bucketFile(n)));
          if (value?.key !== key || !value.links) throw new Error("from another snapshot");
          links = value.links;
        } catch (error) {
          if (!warned) console.log(`[feed-snapshot] links file ${n} not read: ${error?.message ?? error}`);
          warned = true;
          links = {};
        }
        if (kept.size >= KEPT) kept.delete(kept.keys().next().value);
      }
      kept.set(n, links);
      return links;
    };
    const releasesOf = (id) => {
      const n = where.get(id);
      return n === void 0 ? [] : read(n)[id] ?? [];
    };
    releasesOf.has = (id) => where.has(id);
    return releasesOf;
  }

export { BUCKET, SNAPSHOT, bucketReader, readSnapshot, snapshotKey, writeSnapshot };
