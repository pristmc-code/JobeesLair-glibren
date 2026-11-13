// Fase 3: o que o payload de downloads (app/native/bg_catalog*.c) precisa para montar o catalogo da loja sozinho, em
// /data/JobeesLair/catalog (no PS5; caminho absoluto: o payload nao enxerga a pasta do app):
//   bundled/      a copia do catalogo embutido DESTA versao do app (o mesmo desenho de app/data: catalog/index.json,
//                 catalog/art/, packs/, formats.js, ratings.js) e, por ultimo, version.json ({version, files:[{name, size}]}).
//                 Copiada pelo motor (FileSystem.copyAsync, numa thread dele: nada passa pelo heap do JS) para
//                 bundled.tmp e trocada de uma vez, so quando a versao muda. Assim o payload, que se atualiza a parte
//                 (Fase 2), sempre monta com os dados da versao do app que esta instalada.
//   config.json   as listas do jogador (feeds.json, os espelhos dele, a lista Orbit, os catalogos escondidos), o PS4,
//                 a largura das capas e o firmware: regravado quando algo disso muda (e so quando muda).
// O payload confere os arquivos a cada 5 s e monta de novo quando algum muda. Enquanto o app monta a loja dele (ate a
// Fase 4), nada aqui muda o que o app mostra.

import { FileSystem, Platform } from '@ps5-react/core';
import { DATA_DIR } from './data-dir.js';
import { VERSION } from '../version.js';
import { COVER_WIDTH } from '../data/catalog-index.js';
import { catalogSources, isRemoteCatalog } from './catalog.js';
import { feedsSnapshot, subscribeFeeds } from './feeds.js';
import { ORBIT_FEED, onOrbitFeed, orbitFeedOn } from './orbit-feed.js';
import { hiddenSources, sourceShown, subscribeStore } from './store-mode.js';
import { deviceFacts } from './device.js';
import { PS4 } from './ps4.js';

  var CATALOG_DIR = Platform.OS === "ps5" ? "/data/JobeesLair/catalog" : `${DATA_DIR}/catalog`;
  var BUNDLED = `${CATALOG_DIR}/bundled`;
  var CONFIG = `${CATALOG_DIR}/config.json`;
  // O que vai para a copia: [origem no app, destino em bundled/].
  var PARTS = [["/app0/data/catalog", "catalog"], ["/app0/data/packs", "packs"], ["/app0/data/formats.js", "formats.js"], ["/app0/data/ratings.js", "ratings.js"]];
  // glibren.54: sem estes o payload monta igual (sem os formatos e as notas do embutido): uma imagem que nao os traz (a .52/.53
  // nao os empacotava: "read the source: No such file", 1o diagnostico real de 13/11) nao impede a copia. Os outros sao
  // obrigatorios. Os quatro estao nos "resources" do app.json e do app.homebrew.json (tests/catalog-payload.test.mjs confere).
  var OPTIONAL = new Set(["formats.js", "ratings.js"]);

  /** O config.json que o payload le (sem gravar). */
  function catalogConfig() {
    let hidden = [];
    try {
      // Fase 4: com a loja aberta pelo payload o app nao conhece os catalogos (catalogSources vazio): os escondidos das
      // configuracoes, como estao.
      hidden = isRemoteCatalog() ? hiddenSources() : catalogSources().map((source) => source.id).filter((id) => !sourceShown(id));
    } catch {
    }
    let feeds = [];
    try {
      feeds = feedsSnapshot();
    } catch {
    }
    let firmware = "";
    try {
      firmware = deviceFacts().firmware || "";
    } catch {
    }
    return {
      version: 1,
      app: VERSION,
      feeds: feeds.map((feed) => feed.url),
      // a chave de um objeto JSON no leitor do payload tem ate 64 letras: o endereco vai dentro do valor
      mirrors: feeds.filter((feed) => feed.own?.length).map((feed) => ({ url: feed.url, list: feed.own })),
      orbit: { on: Boolean(orbitFeedOn()), id: ORBIT_FEED },
      hidden,
      ps4: PS4,
      coverWidth: COVER_WIDTH,
      firmware
    };
  }
  var lastConfig = null;
  /** Grava o config.json quando ele mudou. -> true quando gravou. */
  function writeCatalogConfig(fs = FileSystem) {
    const text = JSON.stringify(catalogConfig());
    if (text === lastConfig) return false;
    try {
      if (lastConfig === null && fs.exists(CONFIG) && fs.readFile(CONFIG) === text) {
        lastConfig = text;
        return false;
      }
      fs.mkdir(CATALOG_DIR, { recursive: true });
      fs.writeFile(`${CONFIG}.tmp`, text);
      fs.rename(`${CONFIG}.tmp`, CONFIG);
      lastConfig = text;
      return true;
    } catch (error) {
      console.log(`[catalog-payload] config.json not written: ${error?.message ?? error}`);
      return false;
    }
  }
  // Os arquivos de uma pasta copiada, com o tamanho (o version.json lista todos; o payload confere cada um).
  function listFiles(fs, dir, prefix, out) {
    for (const entry of fs.readDir(dir) ?? []) {
      const name = entry?.name;
      if (typeof name !== "string" || !name || name.startsWith(".")) continue;
      if (entry.isDirectory) listFiles(fs, `${dir}/${name}`, `${prefix}${name}/`, out);
      else out.push({ name: `${prefix}${name}`, size: typeof entry.size === "number" ? entry.size : fs.stat(`${dir}/${name}`)?.size ?? 0 });
    }
    return out;
  }
  var staging = null;
  /**
   * A copia do catalogo embutido, quando a versao mudou (uma vez por abertura no maximo). -> Promise
   * "same" | "copied" | "skipped" | "failed".
   */
  function stageBundled({ fs = FileSystem, log = (line) => console.log(line) } = {}) {
    if (staging) return staging;
    staging = (async () => {
      if (typeof fs.copyAsync !== "function") return "skipped";
      try {
        if (fs.exists(`${BUNDLED}/version.json`) && JSON.parse(fs.readFile(`${BUNDLED}/version.json`))?.version === VERSION) return "same";
      } catch {
      }
      const tmp = `${BUNDLED}.tmp`;
      try {
        if (fs.exists(tmp)) fs.removeTree(tmp);
        fs.mkdir(tmp, { recursive: true });
        const copied = [];
        for (const [from, to] of PARTS) {
          if (OPTIONAL.has(to) && !fs.exists(from)) {
            log(`[catalog-payload] ${from} is not in the image: the payload builds without it`);
            continue;
          }
          const task = fs.copyAsync(from, `${tmp}/${to}`, { verify: false, resume: false });
          await task?.done;
          copied.push(to);
        }
        const files = [];
        for (const to of copied) {
          const info = fs.stat(`${tmp}/${to}`);
          if (info?.isDirectory) listFiles(fs, `${tmp}/${to}`, `${to}/`, files);
          else files.push({ name: to, size: info?.size ?? 0 });
        }
        fs.writeFile(`${tmp}/version.json`, JSON.stringify({ version: VERSION, files }));
        if (fs.exists(BUNDLED)) fs.removeTree(BUNDLED);
        fs.rename(tmp, BUNDLED);
        log(`[catalog-payload] bundled catalog of ${VERSION} copied for the payload (${files.length} files)`);
        return "copied";
      } catch (error) {
        log(`[catalog-payload] bundled catalog not copied: ${error?.message ?? error}`);
        return "failed";
      }
    })();
    return staging;
  }
  /** Na abertura (index.jsx, depois da exportacao da loja): a copia e o config.json, e o config de novo a cada mudanca. */
  function startCatalogPayload() {
    if (Platform.OS !== "ps5") return;
    writeCatalogConfig();
    void stageBundled();
    const again = () => writeCatalogConfig();
    subscribeFeeds(again);
    subscribeStore(again);
    onOrbitFeed(again);
  }

export { PARTS as CATALOG_PARTS, BUNDLED as CATALOG_BUNDLED, CATALOG_DIR, CONFIG as CATALOG_CONFIG, catalogConfig, stageBundled, startCatalogPayload, writeCatalogConfig };
