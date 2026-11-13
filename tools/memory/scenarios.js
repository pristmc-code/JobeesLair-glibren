// glibren (medidor de memoria): os cenarios que tools/memory/measure.mjs mede no qjs. Cada execucao roda um cenario e
// termina com "DONE <cenario> ..."; o measure.mjs procura o menor --memory-limit com que ele termina (o pico do heap).
// Argumentos: <cenario> <pasta de trabalho> <pasta app/> <live.jlx> <orbit-store.json>.
//   prep-loja / prep-orbit  grava na pasta de trabalho o cache do catalogo ao vivo (e a lista Orbit ligada); nao mede
//   base                    so o codigo (o bundle compilado), nada carregado
//   loja                    a loja montada (state/catalog.js: catalogo embutido + catalogo ao vivo do cache)
//   orbit                   a loja com a lista Orbit Store ligada
//   biblioteca              a loja + montar e gravar a Biblioteca TorBox (conta e checkcached de mentira)
//   biblioteca-payload      glibren.44: a mesma montagem pelo caminho do console (rede no payload, arquivos por bloco)
//   formatos                a loja + Descobrir formatos do jogo com mais links (TorBox ligado: checkcached com list_files)
//   procurar                a loja + Procurar no TorBox do jogo com mais links
//   youtube                 a loja + uma pagina de resultados do YouTube (tube-service pageItems)
//   exportar                a loja + a loja completa exportada ao payload (state/store-export.js: indice, fichas, links)
//   ficha                   glibren.47: ler os links (JLX1) e a ficha de MEM_FICHA_N jogos embutidos, sem montar a loja;
//                           MEM_FICHA=arquivos le um arquivo por jogo (como ate a .46), senao os pacotes (data-pack.js)
// A loja dos cenarios depois de "loja" e a da pasta de trabalho: com a Orbit ligada se ela foi preparada com prep-orbit.
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import { DeviceInfo, FileSystem, Http } from '@ps5-react/core';

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
} else if (scenario === 'tempo') {
  // glibren.45: o tempo de CPU da montagem da loja (tools/perf/startup.mjs): o indice embutido, depois o resto
  // (feeds ou retrato, formatos, notas, facetas). os.now() do qjs-ng em microssegundos. MEM_PACED=1: em partes, como no
  // console (a .45 em diante; state/catalog.js). "cpu" = o trabalho (a carga dos modulos e as partes, sem as esperas);
  // "longest" = a maior parte que roda sem devolver o quadro (sem partes, a abertura inteira).
  if (std.getenv('MEM_PACED')) globalThis.__jobeCatalogPaced = true;
  const t0 = os.now();
  const index = await import('../../app/data/catalog-index.js');
  const t1 = os.now();
  const catalog = await store();
  const t2 = os.now();
  if (catalog.catalogReady) await catalog.catalogReady();
  const t3 = os.now();
  const stats = catalog.catalogBuildStats?.() ?? {};
  const ms = (n) => (n / 1e3).toFixed(1);
  const paced = Boolean(stats.paced);
  const cpu = paced ? (t2 - t0) / 1e3 + stats.total : (t3 - t0) / 1e3;
  const longest = paced ? Math.max(stats.longest, (t2 - t0) / 1e3) : (t3 - t0) / 1e3;
  std.err.puts(`TIME index=${ms(t1 - t0)} store=${ms(t2 - t1)} rest=${ms(t3 - t2)} total=${cpu.toFixed(1)} longest=${longest.toFixed(1)} steps=${paced ? stats.steps : 1}\n`);
  if (stats.phases) std.err.puts(`PHASES ${Object.entries(stats.phases).map(([name, n]) => `${name}=${n}`).join(' ')}${stats.slowest ? ` slowest=${stats.slowest.phase}:${stats.slowest.ms}` : ''}\n`);
  note = `games ${catalog.catalogEntries().length} index ${index.games.length}`;
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
} else if (scenario === 'biblioteca-payload') {
  // glibren.44: a Biblioteca TorBox como no console desde a .38: a rede no payload (state/torbox-library-payload.js) e o
  // app lendo account.json, list.json e um bloco por vez. O payload de mentira responde na hora com o formato de
  // app/native/bg_library.c. A conta tem MEM_ACCOUNT itens por tipo; 1 de cada MEM_ACCOUNT_BIG_EVERY e uma pasta de
  // MEM_ACCOUNT_BIG_FILES arquivos (um jogo PS5 em pasta), como a conta de quem baixa muito. O medidor do app
  // (memory-meter.js) mede com o qjs de peak.mjs; no fim, "depois" e o heap com a tela de volta (montagem terminada).
  const catalog = await store();
  const meter = await import('../../app/state/memory-meter.js');
  meter.memoryScreen('tela:settings');
  const lib = await import('../../app/state/torbox-library.js');
  const { createLibraryRemote } = await import('../../app/state/torbox-library-payload.js');
  // MEM_TRACE=1: a cada linha do log e a cada bloco, o heap agora e o pico desde a linha anterior (MB).
  const trace = (line) => {
    if (typeof std.mem !== 'function') return std.err.puts(`${line}\n`);
    const [used, top] = std.mem(true);
    std.err.puts(`  [${(used / 1048576).toFixed(1)} pico ${(top / 1048576).toFixed(1)}] ${line}\n`);
  };
  const debug = std.getenv('MEM_DEBUG') || std.getenv('MEM_TRACE') ? trace : () => {};
  const where = lib.libraryPaths('/data/JobeesLair', true);
  const bigEvery = Number(std.getenv('MEM_ACCOUNT_BIG_EVERY') ?? 10), bigFiles = Number(std.getenv('MEM_ACCOUNT_BIG_FILES') ?? 2000);
  const dir = '/data/JobeesLair/bg/library';
  const accountText = () => {
    const kinds = [];
    for (const kind of ['webdl', 'torrent']) {
      const items = [];
      for (let i = 0; i < ACCOUNT_ITEMS; i++) {
        const name = `Game.${kind}.${i}.PPSA${10000 + i}-GROUP`;
        const files = [];
        // Uma pasta: 1 de cada 5 arquivos com 5 MB (os que contam), o resto pequeno (o payload .43 manda todos).
        const count = bigEvery > 0 && i % bigEvery === 0 ? bigFiles : 1;
        for (let f = 0; f < count; f++) files.push(count === 1 ? `{"id":0,"name":"${name}/${name}.exfat","short_name":"${name}.exfat","size":40000000000}`
          : `{"id":${f},"name":"${name}/Image0/sce_module/data_${i}_${f}.bin","short_name":"data_${i}_${f}.bin","size":${f % 5 ? 50000 + f : 5000000 + f}}`);
        // glibren.44: o payload novo (api 29) grava so os arquivos que valem (nome de jogo ou 1 MB ou mais, ate 400, e o
        // maior) e os codigos de todos; MEM_OLD_PAYLOAD=1 grava todos, como o da .43.
        let kept = files;
        if (!std.getenv('MEM_OLD_PAYLOAD') && files.length > 1) {
          kept = files.filter((text) => /\.exfat"/.test(text) || Number(/"size":(\d+)/.exec(text)[1]) >= 1e6).slice(0, 400);
          if (!kept.length) kept = [files[0]];
        }
        const codes = std.getenv('MEM_OLD_PAYLOAD') ? '' : `,"codes":["PPSA${10000 + i}"]`;
        items.push(`{"id":${i},"hash":"${hexOf(name).repeat(5)}","name":"${name}","size":${i * 1e6},"files":[${kept.join(',')}]${codes}}`);
      }
      kinds.push(`"${kind}":[${items.join(',')}]`);
    }
    return `{${kinds.join(',')}}`;
  };
  let runId = '', blocks = 0;
  const payload = {
    dir,
    status: async () => ({ ok: true, api: 28, run: runId, state: runId ? 'done' : '', phase: 'games', busy: false, blocks, done: blocks, calls: 1, waitMs: 0 }),
    cancel: async () => ({}),
    async start(run) {
      // O que o app fez ate aqui (o plano) e medido; o resto (o trabalho do payload, em C no console) nao conta.
      debug('plano gravado (payload comeca)');
      runId = run;
      const lines = String(FileSystem.readFile(`${dir}/plan.ndjson`)).split('\n').filter(Boolean);
      blocks = JSON.parse(lines[0]).blocks;
      FileSystem.writeFile(`${dir}/account.json`, accountText());
      FileSystem.writeFile(`${dir}/list.json`, '{"held":{}}');
      for (const line of lines.slice(1)) {
        const value = JSON.parse(line);
        if (!value.games) continue;
        const held = [];
        for (const game of value.games) for (const link of [...game.links, ...game.parts]) {
          const n = parseInt(hexOf(link).slice(-4), 16);
          if (n % HELD_EVERY) continue;
          const hash = hexOf(link).repeat(4);
          // Como bg_library.c grava (lb_entry_write): so os arquivos que valem (nome de jogo ou 1 MB ou mais, ate 400).
          const dirName = `Game.Title.${hash.slice(0, 6)}.PPSA0${hash.slice(0, 4)}-GROUP`;
          const big = n % (HELD_EVERY * BIG_EVERY) === 0;
          const files = big ? Array.from({ length: Math.min(BIG_FILES, 400) }, (_, f) => `{"id":${f},"name":"${dirName}/Image0/data_${f}.bin","short_name":"data_${f}.bin","size":${5000000 + f}}`)
            : [`{"id":0,"name":"${dirName}/${dirName}.exfat","short_name":"${dirName}.exfat","size":45000000000}`];
          held.push(`${JSON.stringify(link)}:{"name":"${dirName}","size":${files.length * 5000000},"files":[${files.join(',')}]}`);
        }
        FileSystem.writeFile(`${dir}/b${String(value.b).padStart(5, '0')}.json`, `{"b":${value.b},"ids":${JSON.stringify(value.games.map((g) => g.id))},"held":{${held.join(',')}},"failed":{},"names":[]}`);
      }
      std.gc();
      if (typeof std.mem === 'function') std.mem(true);
      return payload.status();
    },
  };
  const entries = catalog.catalogEntries();
  const byId = new Map(entries.map(({ game }) => [game.id, game]));
  // A loja termina de abrir os feeds (a Orbit) depois de montada: espera isso acabar (o heap parar de mudar), para o pico
  // da Biblioteca nao somar o da abertura da loja (no console a montagem comeca com a loja aberta ha tempo).
  for (let last = -1, still = 0, tries = 0; still < 10 && tries < 400; tries++) {
    await new Promise((resolve) => os.setTimeout(resolve, 20));
    const size = catalog.catalogEntries().length + (meter.memorySnapshot().top.length << 16);
    still = size === last ? still + 1 : 0;
    last = size;
  }
  std.gc();
  if (std.getenv('MEM_PRETOUCH')) {
    debug('antes de tocar');
    const { planGame } = await import('../../app/state/torbox-library.js');
    for (const { game } of catalog.catalogEntries()) planGame(game);
    std.gc();
    debug('links de todos lidos');
    const { gameDetails } = await import('../../app/state/torbox-library.js');
    for (const { game } of catalog.catalogEntries()) gameDetails(game);
    std.gc();
    debug('fichas de todos lidas');
  }
  // A montagem numa funcao (como torbox-library-run.js startLibrary): o que ela segura sai quando ela termina.
  let probe = null, probeGames = null;
  async function runLibrary(fresh = false) {
    debug('antes de ler o banco');
    let library = lib.readLibrary(FileSystem, where);
    meter.memorySample('biblioteca-torbox:ler');
    debug('banco lido');
    const save = (value, { final }) => lib.saveLibraryRun(FileSystem, where, value, { final, gameOf: (id) => byId.get(id) ?? null, log: debug, sample: meter.memorySample,
      memory: () => DeviceInfo.memory() });
    const { progress: last } = await lib.buildLibrary({ entries, api: null, library, save, signal, fresh, sleep: async () => {}, pace: 0, rateWait: 0, log: debug,
      remote: createLibraryRemote({ fs: FileSystem, link: () => payload, wait: async () => {}, log: debug, poll: 0 }),
      onProgress: (p) => {
        meter.memorySample('biblioteca-torbox:montar');
        debug(`progress ${p.phase} ${p.done}/${p.total}`);
      } });
    probe = new WeakRef(library);
    probeGames = new WeakRef(library.games);
    library = null;
    return last;
  }
  // MEM_RUNS=2: monta de novo ("Montar de novo"), com o banco da primeira lido do disco, como no console.
  let progress = await runLibrary();
  for (let again = 1; again < Number(std.getenv('MEM_RUNS') ?? 1); again++) {
    std.gc();
    debug(`montar de novo (${again + 1})`);
    runId = '';
    progress = await runLibrary(true);
  }
  std.gc();
  if (std.getenv('MEM_TRACE')) debug(`banco ainda vivo: ${probe.deref() !== undefined}, jogos: ${probeGames.deref() !== undefined}`);
  meter.memorySample('tela:settings');
  const snap = meter.memorySnapshot();
  const mbOf = (b) => (b / 1048576).toFixed(1);
  std.err.puts(`RANK ${snap.top.map((r) => `${r.action}=${mbOf(r.used)}`).join(' ')}\n`);
  std.err.puts(`AFTER ${mbOf(snap.last.used)}\n`);
  note = `library ${progress.found} of ${progress.total}`;
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
} else if (scenario === 'ficha') {
  // glibren.47: o custo de abrir a ficha de um jogo (links + pagina), pacote contra arquivo por jogo.
  const { createDataPack } = await import('../../app/state/data-pack.js');
  const { readJlx } = await import('../../app/state/jlx.js');
  const files = std.getenv('MEM_FICHA') === 'arquivos';
  const releases = createDataPack('releases');
  const pages = createDataPack('pages');
  const idx = FileSystem.readFile('/app0/data/packs/releases.idx').split('\n').slice(1, -1).map((line) => line.split(' ')[0]);
  const count = Math.min(Number(std.getenv('MEM_FICHA_N') ?? 300), idx.length);
  const step = Math.max(1, Math.floor(idx.length / count));
  std.gc();
  const before = typeof std.mem === 'function' ? std.mem()[0] : 0;
  let slowest = 0;
  let total = 0;
  let first = 0;
  let links = 0;
  for (let n = 0; n < count; n++) {
    const id = idx[n * step];
    const t0 = os.now();
    const text = files ? FileSystem.readFile(`/app0/data/releases/${id}.json`) : releases.read(id);
    const list = JSON.parse(readJlx(text));
    let page;
    try {
      page = JSON.parse(files ? FileSystem.readFile(`/app0/data/pages/${id}.json`) : pages.read(id) ?? '{}');
    } catch {
      page = {};
    }
    const us = os.now() - t0;
    if (n === 0) first = us;
    slowest = Math.max(slowest, us);
    total += us;
    links += list.length + (page.about ? 0 : 0);
  }
  const after = typeof std.mem === 'function' ? std.mem() : [0, 0];
  std.err.puts(`FICHA ${files ? 'arquivos' : 'pacote'} games=${count} links=${links} first_ms=${(first / 1e3).toFixed(2)} avg_ms=${(total / count / 1e3).toFixed(3)} slowest_ms=${(slowest / 1e3).toFixed(2)} heap_before_MB=${(before / 1048576).toFixed(2)} heap_after_MB=${(after[0] / 1048576).toFixed(2)} peak_MB=${(after[1] / 1048576).toFixed(2)}\n`);
  note = `ficha ${count}`;
} else if (scenario === 'modulos') {
  // Fase 4: so os modulos que a loja (local ou pelo payload) carrega, com a montagem segura: o piso das duas.
  globalThis.__jobeHoldCatalog = true;
  keep.catalog = await import('../../app/state/catalog.js');
  keep.remote = await import('../../app/state/remote-store.js');
  if (keep.catalog.isLocalCatalogBuilt()) throw new Error('montou');
  note = 'modulos';
} else if (scenario === 'loja-modulos') {
  // a loja montada aqui com os mesmos modulos de "modulos" carregados (a comparacao justa com as "-remota")
  keep.remote = await import('../../app/state/remote-store.js');
  const catalog = await store();
  note = `games ${catalog.catalogEntries().length}`;
} else if (scenario.endsWith('-remota')) {
  // Fase 4: a loja aberta pelo catalogo do payload (state/remote-store.js), sem montar nada no app. As respostas sao as do
  // payload de verdade com os mesmos dados (tools/fase4/record.mjs, arquivo em MEM_REMOTE). loja-remota: abrir a loja
  // (opcoes, pagina inicial) + 6 paginas da grade + um filtro com as contagens; busca-remota: abrir + 3 paginas da busca
  // "the"; ficha-remota: abrir + as fichas das 48 primeiras (a ultima e a guardada; 16 no maximo).
  globalThis.__jobeHoldCatalog = true;
  const dir = std.getenv('MEM_REMOTE');
  const recorded = JSON.parse(std.loadFile(`${dir}/index.json`));
  const served = (url) => {
    const route = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
    const hit = recorded.routes[route];
    return hit ? reply(hit.status, std.loadFile(`${dir}/${hit.file}`), url) : reply(404, '{"ok":false,"error":"not recorded"}', url);
  };
  globalThis.__MEM_HTTP = async (url, options) => url.startsWith('http://127.0.0.1:') ? served(url, options) : reply(404, 'not found', url);
  const catalog = await import('../../app/state/catalog.js');
  const remoteMod = await import('../../app/state/catalog-remote.js');
  const { beginRemoteStore } = await import('../../app/state/remote-store.js');
  const client = remoteMod.createRemoteCatalog({ http: Http, readToken: () => 'a'.repeat(64) });
  const step = (what) => { if (std.getenv('MEM_STEPS') && typeof std.mem === 'function') { std.gc(); std.err.puts(`STEP ${what} now ${(std.mem()[0] / 1048576).toFixed(1)} peak ${(std.mem()[1] / 1048576).toFixed(1)}
`); } };
  step('modulos');
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 10, 13, 12); // o "today" gravado
  const opened = await beginRemoteStore({ client, fs: FileSystem, platform: 'ps5', seed: 12345, log: () => {} });
  Date.now = realNow;
  if (!opened) throw new Error(`a loja nao abriu pelo payload: ${client.status().reason}`);
  step('aberta');
  keep.catalog = catalog;
  keep.grid = [];
  const view = { filters: catalog.NO_FILTERS, query: '', sort: 'relevance' };
  if (scenario === 'loja-remota') {
    for (let offset = 0; offset < 48 * 6; offset += 48) keep.grid.push(...(await client.page(view, offset)).games);
    const action = { filters: { ...catalog.NO_FILTERS, genre: ['Action'] }, query: '', sort: 'relevance' };
    keep.filtered = await client.page(action, 0);
    keep.counts = await client.options(action);
  } else if (scenario === 'busca-remota') {
    for (let offset = 0; offset < 48 * 3; offset += 48) keep.grid.push(...(await client.page({ ...view, query: 'the' }, offset, 'search')).games);
  } else if (scenario === 'ficha-remota') {
    for (const card of (await client.page(view, 0)).games) keep.ficha = await client.game(card.id);
  } else throw new Error(`unknown scenario ${scenario}`);
  if (catalog.isLocalCatalogBuilt() || !catalog.isRemoteCatalog()) throw new Error('a loja foi montada no app');
  note = `remota ${recorded.shown ?? '?'} listados, grade ${keep.grid.length}, ${JSON.stringify(client.status())}`;
} else if (scenario !== 'base') {
  throw new Error(`unknown scenario ${scenario}`);
}
pumping = false;
std.gc();
// glibren.44: com o qjs de peak.mjs, o pico do heap (MB) desde o inicio.
if (typeof std.mem === 'function') std.err.puts(`PEAK ${(std.mem()[1] / 1048576).toFixed(1)} NOW ${(std.mem()[0] / 1048576).toFixed(1)}
`);
print(`DONE ${scenario} ${note}`);
