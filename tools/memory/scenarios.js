// glibren (medidor de memoria): os cenarios que tools/memory/measure.mjs mede no qjs. Cada execucao roda um cenario e
// termina com "DONE <cenario> ..."; o measure.mjs procura o menor --memory-limit com que ele termina (o pico do heap).
// Argumentos: <cenario> <pasta de trabalho> <pasta app/> <live.jlx> <orbit-store.json>.
//   prep-loja / prep-orbit  grava na pasta de trabalho o cache do catalogo ao vivo (e a lista Orbit ligada); nao mede
//   base                    so o codigo (o bundle compilado), nada carregado
//   loja                    a loja montada (state/catalog.js: catalogo embutido + catalogo ao vivo do cache)
//   orbit                   a loja com a lista Orbit Store ligada
//   biblioteca              a loja + montar e gravar a Biblioteca TorBox (conta e checkcached de mentira)
//   formatos                a loja + Descobrir formatos do jogo com mais links (TorBox ligado: checkcached com list_files)
//   procurar                a loja + Procurar no TorBox do jogo com mais links
//   youtube                 a loja + uma pagina de resultados do YouTube (tube-service pageItems)
//   exportar                a loja + a loja completa exportada ao payload (state/store-export.js: indice, fichas, links)
// A loja dos cenarios depois de "loja" e a da pasta de trabalho: com a Orbit ligada se ela foi preparada com prep-orbit.
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import { FileSystem, Http } from '@ps5-react/core';

// O laco do qjs 0.15 so retoma um await de nivel de modulo no proximo evento do poll: com um timer longo pendente (o
// limite de 90 s de uma chamada ao TorBox, que e cancelado logo) ele esperava esse tempo todo. Um timer de 1 ms enquanto o
// cenario roda mantem o poll acordando; sai no fim, para o processo terminar.
let pumping = true;
const pump = () => { if (pumping) os.setTimeout(pump, 1); };
pump();

const [, scenario = 'base', fsDir, appDir, liveFile, orbitFile] = scriptArgs;
globalThis.__MEM_FS = fsDir;
globalThis.__MEM_APP = appDir.endsWith('/') ? appDir : appDir + '/';
const KEY = 'abcdefabcdefabcdefabcdefabcdef12';
// O tamanho de mentira da conta TorBox e do que ele tem (como no teste da .29: alguns itens com milhares de arquivos).
const ACCOUNT_ITEMS = Number(std.getenv('MEM_ACCOUNT') ?? 400);
const HELD_EVERY = Number(std.getenv('MEM_HELD_EVERY') ?? 3); // 1 de cada N hashes o TorBox tem
const BIG_EVERY = Number(std.getenv('MEM_BIG_EVERY') ?? 15); // 1 de cada N do que ele tem lista BIG_FILES arquivos
const BIG_FILES = Number(std.getenv('MEM_BIG_FILES') ?? 2000);

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const hexOf = (text) => { let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0; return (h >>> 0).toString(16).padStart(8, '0'); };
const reply = (status, body, url) => ({ status, ok: status >= 200 && status < 300, url, headers: {}, text: async () => body, json: async () => JSON.parse(body) });
const query = (url, name) => { const m = new RegExp(`[?&]${name}=([^&]*)`).exec(url); return m ? decodeURIComponent(m[1]) : null; };
function entryText(hash, files) {
  const dir = `Game.Title.${hash.slice(0, 6)}.PPSA0${hash.slice(0, 4)}-GROUP`;
  const list = [];
  for (let f = 0; f < files; f++) list.push(`{"id":${f},"name":"${dir}/Image0/sce_module/data_${hash.slice(0, 5)}_${f}.bin","short_name":"data_${f}.bin","size":${100000 + f * 37}}`);
  if (files < 100) list[0] = `{"id":0,"name":"${dir}/${dir}.exfat","short_name":"${dir}.exfat","size":45000000000}`;
  return `{"name":"${dir}","size":${files * 100000},"hash":"${hash}","files":[${list.join(',')}]}`;
}
function torbox(url) {
  if (url.includes('/webdl/hosters')) return reply(200, '{"success":true,"data":[]}', url);
  if (url.includes('/mylist')) {
    const offset = Number(query(url, 'offset') ?? 0), limit = Number(query(url, 'limit') ?? 1000);
    const items = [];
    for (let i = offset; i < Math.min(ACCOUNT_ITEMS, offset + limit); i++) {
      const hash = hexOf(`item${i}${url.includes('torrents') ? 't' : 'w'}`).repeat(5);
      items.push(`{"id":${i},"name":"Game.${i}.PPSA${10000 + i}-GROUP","hash":"${hash}","size":${i * 1e6},"download_finished":true,"download_state":"completed","files":[{"id":0,"name":"Game.${i}/Game.${i}.exfat","short_name":"Game.${i}.exfat","size":40000000000}]}`);
    }
    return reply(200, `{"success":true,"data":[${items.join(',')}]}`, url);
  }
  if (url.includes('/checkcached')) {
    const hashes = (query(url, 'hash') ?? '').split(',').filter(Boolean);
    const parts = [];
    for (const hash of hashes) {
      const n = parseInt(hash.slice(-4), 16) || 0;
      if (n % HELD_EVERY) continue;
      parts.push(`"${hash}":${entryText(hash, n % (HELD_EVERY * BIG_EVERY) === 0 ? BIG_FILES : 30)}`);
    }
    return reply(200, `{"success":true,"error":null,"detail":"Found cached items.","data":{${parts.join(',')}}}`, url);
  }
  if (url.includes('search-api')) return reply(200, '{"success":true,"data":{"torrents":[]}}', url);
  return reply(404, '{"success":false,"error":"NOT_FOUND"}', url);
}
globalThis.__MEM_HTTP = async (url) => {
  if (std.getenv('MEM_DEBUG')) std.err.puts(`http ${url.slice(0, 120)}\n`);
  if (/live\.(jlx|json)$/.test(url)) return reply(200, std.loadFile(liveFile), url);
  if (url.startsWith('https://api.torbox.app') || url.includes('search-api.torbox.app')) return torbox(url);
  // Um link de jogo (Descobrir formatos le o comeco do arquivo): uma resposta curta.
  return reply(404, 'not found', url);
};
const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
const keep = {};
globalThis.keep = keep;
let note = '';
async function store() {
  const catalog = await import('../../app/state/catalog.js');
  keep.catalog = catalog;
  return catalog;
}
// O jogo com mais links (o pior caso de Descobrir formatos e de Procurar no TorBox).
function busiest(catalog) {
  let best = null;
  for (const { game } of catalog.catalogEntries()) if ((game.releases?.length ?? 0) > (best?.releases?.length ?? 0)) best = game;
  return best;
}

if (scenario === 'prep-loja' || scenario === 'prep-orbit') {
  if (scenario === 'prep-orbit') {
    const orbit = await import('../../app/state/orbit-feed.js');
    const text = std.loadFile(orbitFile);
    FileSystem.writeFile(orbit.ORBIT_FEED, text);
    FileSystem.writeFile(orbit.ORBIT_STATUS, JSON.stringify({ conv: 3, known: 1, ok: Math.floor(Date.now() / 1e3), rev: 95 }));
    orbit.setOrbitFeed(true);
  }
  const feeds = await import('../../app/state/feeds.js');
  await feeds.refreshFeeds();
  note = `feeds ${feeds.feedsSnapshot().map((feed) => `${feed.state ?? ''}`).join(',')}`;
} else if (scenario === 'loja' || scenario === 'orbit') {
  const catalog = await store();
  note = `games ${catalog.catalogEntries().length}`;
} else if (scenario === 'biblioteca') {
  const catalog = await store();
  const { buildLibrary, libraryPaths, writeLibrary, writeList } = await import('../../app/state/torbox-library.js');
  const { createTorBox } = await import('../../app/services/torbox.js');
  const where = libraryPaths('/data/JobeesLair', true);
  const debug = std.getenv('MEM_DEBUG') ? (line) => std.err.puts(`${line}\n`) : () => {};
  const api = createTorBox({ http: Http, key: () => KEY, wait: async () => {}, log: debug });
  const byId = new Map(catalog.catalogEntries().map(({ game }) => [game.id, game]));
  // glibren.38 (item 3): MEM_LIB_STEP para no meio, para achar o passo do pico: "build" (so montar, sem gravar), "library"
  // (montar + o banco, sem lista nem fichas), "list" (+ lista e ids, sem fichas); vazio = tudo, como o app (com a copia do
  // banco em /data, que o app grava ao terminar). MEM_LIB_SUMMARY=1 le o banco de novo no fim, como a tela de
  // Configuracoes fazia ao mudar o estado (librarySummary).
  const step = std.getenv('MEM_LIB_STEP') || '';
  const save = (value, { final }) => {
    if (step === 'build') return;
    writeLibrary(FileSystem, where, value, { backup: final && !step });
    if (final && step !== 'library') writeList(FileSystem, where, value, undefined, step === 'list' ? null : (id) => byId.get(id) ?? null);
  };
  // O gravador do app (torbox-library.js saveLibraryRun, glibren.38) quando existe; senao o de antes.
  const lib = await import('../../app/state/torbox-library.js');
  const save2 = lib.saveLibraryRun && !step ? (value, { final }) => lib.saveLibraryRun(FileSystem, where, value, { final, gameOf: (id) => byId.get(id) ?? null, log: debug }) : save;
  const { progress } = await buildLibrary({ entries: catalog.catalogEntries(), api, save: save2, signal, sleep: async () => {}, pace: 0, rateWait: 0, log: debug,
    onProgress: (p) => debug(`progress ${p.phase} ${p.done}/${p.total} calls ${p.calls}`) });
  if (std.getenv('MEM_LIB_SUMMARY')) {
    const { readLibrary, uncheckedCount } = await import('../../app/state/torbox-library.js');
    const again = readLibrary(FileSystem, where);
    keep.summary = uncheckedCount(again, catalog.catalogEntries());
  }
  note = `library ${progress.found} of ${progress.total}, ${progress.calls} calls`;
} else if (scenario === 'formatos') {
  const catalog = await store();
  const { createFormatProbe } = await import('../../app/state/format-probe.js');
  const { createTorBox } = await import('../../app/services/torbox.js');
  const { savedList } = await import('../../app/state/saved.js');
  const api = createTorBox({ http: Http, key: () => KEY, wait: async () => {}, log: () => {} });
  const probe = createFormatProbe({ http: Http, store: savedList('link-formats.json', 'link formats'), torbox: (links) => api.cachedFiles(links), debridOn: () => true,
    wait: async () => {}, timeout: () => () => {}, log: () => {} });
  const game = busiest(catalog);
  await probe.discover(game.id, game.releases);
  note = `formats of ${game.id}: ${game.releases.length} links`;
} else if (scenario === 'procurar') {
  const catalog = await store();
  const { searchTorBox } = await import('../../app/state/torbox-search.js');
  const { createTorBox } = await import('../../app/services/torbox.js');
  const api = createTorBox({ http: Http, key: () => KEY, wait: async () => {}, log: () => {} });
  const game = busiest(catalog);
  const found = await searchTorBox(game, { api, signal, supports: () => true });
  keep.found = found;
  note = `search ${game.id}: ${found.files?.length ?? 0} files`;
} else if (scenario === 'youtube') {
  await store();
  const { pageItems } = await import('../../app/state/tube-service.js');
  // Uma pagina como a do tube-service (60 linhas com miniaturas e textos), lida inteira como o app le.
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const id = `vid${String(i).padStart(8, '0')}`;
    rows.push({ id, kind: 'video', title: `Gameplay walkthrough part ${i} ${'x'.repeat(40)}`, channel: { id: `ch${i}`, name: `Channel ${i}` }, duration: 600 + i, views: 1e5 * i, published: '2 weeks ago',
      thumbnails: Array.from({ length: 4 }, (_, k) => ({ url: `https://i.ytimg.com/vi/${id}/hq${k}.jpg?sqp=${'a'.repeat(80)}`, width: 120 * (k + 1), height: 90 * (k + 1) })), description: 'd'.repeat(300) });
  }
  const body = JSON.stringify({ items: rows, has_more: true, cursor: 'c'.repeat(400) });
  rows.length = 0;
  keep.items = pageItems(JSON.parse(body));
  note = `youtube ${keep.items.length} items`;
} else if (scenario === 'exportar') {
  // glibren (item 2): a loja completa exportada para o payload (indice, fichas e links de todos os jogos).
  await store();
  const { STORE_DIR, exportStore } = await import('../../app/state/store-export.js');
  // Sempre a exportacao inteira (a de uma loja que mudou), nao a que ve tudo gravado e para.
  for (const name of ['store-index.json', 'store-games.json', 'store-games.done.json']) if (FileSystem.exists(`${STORE_DIR}/${name}`)) FileSystem.remove(`${STORE_DIR}/${name}`);
  const result = await exportStore({ pause: async () => {}, log: () => {} });
  note = `export ${result.games} games ${result.written}`;
} else if (scenario !== 'base') {
  throw new Error(`unknown scenario ${scenario}`);
}
pumping = false;
std.gc();
print(`DONE ${scenario} ${note}`);
