// glibren-tube-update: o servico do YouTube (tube-service.elf) se atualiza sozinho, sem uma Jobee'sLair nova.
//
// Publicacao (ferramentas/publicar_tube.py, fora do app): uma release do mesmo repositorio do app com a tag
// "tube-service-<versao>", publicada como NAO latest (o verificador do app ignora essas tags: state/updater.js), com
// dois arquivos: tube-service.elf e tube-service.json, o manifesto assinado com a chave Ed25519 do glibren:
//   { format: 1, name: "tube-service", version, api, min_jobe, size, sha256, signature }
// `signature` (128 hex) assina o texto ASCII de manifestMessage(): o app confere a assinatura com a chave PUBLICA
// embutida aqui (PUBLIC_KEY) antes de baixar qualquer coisa, e o ELF e baixado pelo Downloads nativo com o sha256 e o
// tamanho do manifesto (conferidos fora do heap JS: o ELF tem ~8,5 MB e nunca entra no heap).
//
// Quando: ao abrir a tela do YouTube/Videos, no maximo uma vez a cada 6 h (uma falha tenta de novo em 1 h), so com
// "Atualizar o servico do YouTube sozinho" ligada (settings.json tubeAutoUpdate). Nunca segura o video: baixa em
// segundo plano e a versao nova vale na proxima vez que o servico sobe (state/tube-service.js reinicia o servico quando
// ninguem o usa).
//
// Arquivos em /data/JobeesLair/tube/: tube-service.elf + .json (a baixada em uso), tube-service.prev.elf + .json (a
// anterior, para voltar), incoming/ (o download em andamento) e update.json (quando olhou, versoes ruins, a versao do
// ELF embutido aprendida pelo /v1/health). A troca e atomica: o ELF vai para o lugar por rename e o manifesto e gravado
// em .tmp e renomeado por ultimo; um ELF sem manifesto valido do mesmo tamanho nao e usado.
//
// Qual sobe (candidates()): a de versao maior entre a baixada, a anterior e a embutida no pacote (uma Jobe nova pode
// trazer uma embutida mais nova que a baixada); uma que nao respondeu ao subir fica marcada como ruim e nao e tentada
// (nem baixada) de novo.
//
// Rede: so o GitHub, pelo caminho normal do app (Http e Downloads). O DNS publico de reserva e coisa do tube-service e
// so para hosts do YouTube/Google.

import { asciiBytes, fromHex, verify } from './ed25519.js';
import { newer } from './updater.js';

  var TUBE_DIR = "/data/JobeesLair/tube";
  // A chave publica Ed25519 do glibren (glibren-payload src/chave_publica.h): a mesma que assina as versoes do glibren.
  var PUBLIC_KEY = "ce2767604727310aa1b2a5713fe7b76774b7ecd8c68240fef789819a473847c0";
  // A versao deste cliente de atualizacao/do contrato com o servico: um manifesto com min_jobe maior pede uma Jobe nova.
  var CLIENT_API = 1;
  var CHECK_MS = 6 * 60 * 60 * 1e3;
  var RETRY_MS = 60 * 60 * 1e3;
  var MAX_ELF = 32 * 1024 * 1024;
  var TAG_PREFIX = "tube-service-";
  var VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;
  var STATE_FILE = "update.json";
  var CURRENT = "tube-service";
  var PREVIOUS = "tube-service.prev";

  /** O texto que a assinatura cobre (ASCII, uma linha por campo, nessa ordem). O publicar_tube.py monta o mesmo. */
  function manifestMessage(m) {
    return `jobe-tube-service\nformat=${m.format}\nname=${m.name}\nversion=${m.version}\napi=${m.api}\nmin_jobe=${m.min_jobe}\nsize=${m.size}\nsha256=${m.sha256}\n`;
  }

  /**
   * Um manifesto conferido: { ok: true, manifest } ou { ok: false, reason } ("json", "fields", "signature", "version",
   * "api", "jobe"). `version`: a da tag (tem de ser a mesma); `api`: a minima do servico; `clientApi`: a deste app.
   */
  function parseManifest(text, { publicKey = PUBLIC_KEY, version = "", api = 1, clientApi = CLIENT_API } = {}) {
    let m;
    try {
      m = typeof text === "string" ? JSON.parse(text) : text;
    } catch {
      return { ok: false, reason: "json" };
    }
    const int = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
    if (!m || typeof m !== "object" || m.format !== 1 || m.name !== "tube-service" || typeof m.version !== "string" || !VERSION.test(m.version) || !int(m.api, 1, 1e6) || !int(m.min_jobe, 1, 1e6) || !int(m.size, 1, MAX_ELF) || typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256) || typeof m.signature !== "string" || !/^[0-9a-f]{128}$/.test(m.signature))
      return { ok: false, reason: "fields" };
    const manifest = { format: m.format, name: m.name, version: m.version, api: m.api, min_jobe: m.min_jobe, size: m.size, sha256: m.sha256, signature: m.signature };
    const message = asciiBytes(manifestMessage(manifest));
    if (!message || !verify(fromHex(manifest.signature), message, fromHex(publicKey))) return { ok: false, reason: "signature" };
    if (version && manifest.version !== version) return { ok: false, reason: "version" };
    if (manifest.api < api) return { ok: false, reason: "api" };
    if (manifest.min_jobe > clientApi) return { ok: false, reason: "jobe" };
    return { ok: true, manifest };
  }

  /** As versoes das tags tube-service-* (a resposta de git/matching-refs), da maior para a menor. */
  function tubeTags(refs) {
    const found = [];
    for (const row of Array.isArray(refs) ? refs : []) {
      const ref = typeof row?.ref === "string" ? row.ref : "";
      if (!ref.startsWith(`refs/tags/${TAG_PREFIX}`)) continue;
      const version = ref.slice(`refs/tags/${TAG_PREFIX}`.length);
      if (VERSION.test(version) && !found.includes(version)) found.push(version);
    }
    return found.sort((a, b) => newer(a, b) ? -1 : newer(b, a) ? 1 : 0);
  }

  /** A maior de duas versoes (null nao conta). */
  var higher = (a, b) => !a ? b ?? null : !b ? a : newer(b, a) ? b : a;

  /**
   * `http`: Http; `fs`: FileSystem; `downloads`: Downloads; `repo`: "dono/repositorio"; `jobeVersion`: a do app (a versao
   * aprendida do ELF embutido vale so para ela); `enabled()`: a opcao do usuario; `onInstalled(version)`: uma versao
   * nova ficou pronta.
   */
  function createTubeUpdater({
    http,
    fs,
    downloads,
    repo,
    jobeVersion = "",
    dir = TUBE_DIR,
    embeddedElf = "/app0/tube-service.elf",
    embeddedInfo = "/app0/tube-service.json",
    manualElf = "/data/JobeesLair/tube-service.elf",
    publicKey = PUBLIC_KEY,
    api = 1,
    clientApi = CLIENT_API,
    enabled = () => true,
    onInstalled = () => {},
    log = (line) => console.log(`[tube-update] ${line}`),
    now = () => Date.now(),
    checkMs = CHECK_MS,
    retryMs = RETRY_MS
  }) {
    const path = (name) => `${dir}/${name}`;
    const exists = (file) => {
      try {
        return fs.exists(file);
      } catch {
        return false;
      }
    };
    const readText = (file) => {
      try {
        return fs.exists(file) ? String(fs.readFile(file) ?? "") : "";
      } catch {
        return "";
      }
    };
    const remove = (file) => {
      try {
        if (fs.exists(file)) fs.remove(file);
      } catch (error) {
        log(`could not delete ${file}: ${error?.message ?? error}`);
      }
    };
    function load() {
      try {
        const value = JSON.parse(readText(path(STATE_FILE)) || "{}");
        return value && typeof value === "object" ? value : {};
      } catch {
        return {};
      }
    }
    function save(fields) {
      const next = { ...load(), ...fields };
      try {
        fs.mkdir(dir, { recursive: true });
        fs.writeFile(path(`${STATE_FILE}.tmp`), JSON.stringify(next), { sync: true });
        fs.rename(path(`${STATE_FILE}.tmp`), path(STATE_FILE));
      } catch (error) {
        log(`could not save ${STATE_FILE}: ${error?.message ?? error}`);
      }
      return next;
    }
    const badList = () => Array.isArray(load().bad) ? load().bad.filter((v) => typeof v === "string") : [];

    // O que se ve (Configuracoes): o servico no ar nesta execucao, ou o que subiria; e se esta olhando.
    let view = { running: null, checking: false, error: "" };
    const listeners = /* @__PURE__ */ new Set();
    function publish(fields) {
      view = { ...view, ...fields };
      for (const listener of [...listeners]) listener(view);
    }

    // Uma baixada conferida (o manifesto com assinatura valida e o ELF do tamanho dele), guardada pelo carimbo do
    // manifesto: conferir a assinatura custa, entao so de novo quando o arquivo muda.
    const memo = /* @__PURE__ */ new Map();
    function installed(name) {
      const elf = path(`${name}.elf`), json = path(`${name}.json`);
      let stamp = "";
      try {
        const info = fs.stat(json);
        const body = fs.stat(elf);
        if (!info || !body) return null;
        stamp = `${info.size}:${info.modified}:${body.size}:${body.modified}`;
      } catch {
        return null;
      }
      const hit = memo.get(name);
      if (hit && hit.stamp === stamp) return hit.value;
      const parsed = parseManifest(readText(json), { publicKey, api, clientApi });
      let value = null;
      if (parsed.ok && fs.stat(elf)?.size === parsed.manifest.size) value = { path: elf, version: parsed.manifest.version, source: "downloaded" };
      else log(`${name}.elf is not usable (${parsed.ok ? "size" : parsed.reason})`);
      memo.set(name, { stamp, value });
      return value;
    }
    /** A versao do ELF embutido: a do tube-service.json do pacote, senao a que o /v1/health disse com esta Jobe. */
    function embeddedVersion() {
      try {
        const info = JSON.parse(readText(embeddedInfo) || "null");
        if (typeof info?.version === "string" && VERSION.test(info.version)) return info.version;
      } catch {
      }
      const learned = load().embedded;
      return learned?.jobe === jobeVersion && typeof learned.version === "string" && VERSION.test(learned.version) ? learned.version : null;
    }
    /**
     * Os ELF que podem subir, na ordem em que sao tentados: { path, version (null: desconhecida), source:
     * "downloaded" | "embedded" | "manual" }. As baixadas mais novas que a embutida primeiro (uma embutida de versao
     * desconhecida perde para uma baixada), a embutida, as baixadas mais velhas (so como reserva) e a copiada a mao.
     */
    function candidates() {
      const bad = badList();
      const downloaded = [installed(CURRENT), installed(PREVIOUS)].filter((entry) => entry && !bad.includes(entry.version));
      downloaded.sort((a, b) => newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0);
      const unique = downloaded.filter((entry, index) => downloaded.findIndex((other) => other.version === entry.version) === index);
      const list = [];
      const embedded = exists(embeddedElf) ? { path: embeddedElf, version: embeddedVersion(), source: "embedded" } : null;
      if (embedded) {
        list.push(...unique.filter((entry) => !embedded.version || newer(entry.version, embedded.version)), embedded);
        list.push(...unique.filter((entry) => embedded.version && !newer(entry.version, embedded.version)));
      } else list.push(...unique);
      if (exists(manualElf)) list.push({ path: manualElf, version: null, source: "manual" });
      return list;
    }
    /** A maior versao conhecida que o app tem (para nao baixar o que ja tem). */
    function bestVersion() {
      return candidates().reduce((best, entry) => higher(best, entry.version), null);
    }
    /** O servico subiu: guarda (para as Configuracoes) e, se for o embutido, aprende a versao dele com esta Jobe. */
    function noteRunning(source, version) {
      const known = typeof version === "string" && VERSION.test(version) ? version : null;
      if (source === "embedded" && known && !embeddedVersion()) save({ embedded: { jobe: jobeVersion, version: known } });
      // "running": ja estava no ar (subiu antes, talvez noutra execucao do app): a origem e a do candidato da mesma versao.
      let from = source;
      if (source === "running") {
        try {
          from = candidates().find((entry) => entry.version && entry.version === known)?.source ?? "running";
        } catch {
        }
      }
      publish({ running: { source: from, version: known } });
    }
    /** Uma baixada nao subiu: nao e tentada nem baixada de novo. */
    function markBad(version, reason = "") {
      if (!version) return;
      const bad = badList();
      if (!bad.includes(version)) save({ bad: [...bad, version].slice(-16) });
      log(`version ${version} marked bad${reason ? `: ${reason}` : ""}`);
    }
    /** O que as Configuracoes mostram: o servico no ar, senao o primeiro candidato. */
    function inUse() {
      if (view.running) return view.running;
      const first = candidates()[0];
      return first ? { source: first.source, version: first.version } : null;
    }

    const headers = { Accept: "application/vnd.github+json", "User-Agent": "JobeesLair" };
    const releaseFile = (version, name) => `https://github.com/${repo}/releases/download/${TAG_PREFIX}${version}/${name}`;
    async function download(manifest) {
      const incomingDir = path("incoming");
      const incoming = `${incomingDir}/tube-service.elf`;
      try {
        fs.removeTree?.(incomingDir);
      } catch {
      }
      fs.mkdir(incomingDir, { recursive: true });
      // O Downloads nativo confere o tamanho e o sha256 antes de publicar o arquivo (docs/NATIVE-API.md).
      const task = downloads.enqueue({ url: releaseFile(manifest.version, "tube-service.elf"), destination: incoming, sha256: manifest.sha256, expectedBytes: manifest.size, unlimited: true });
      await task.done;
      if (fs.stat(incoming)?.size !== manifest.size) throw new Error("the downloaded file has the wrong size");
      return incoming;
    }
    /** A troca: a baixada em uso vira a anterior, a nova entra por rename, o manifesto por ultimo (.tmp + rename). */
    function install(incoming, manifestText) {
      const cur = (ext) => path(`${CURRENT}.${ext}`), prev = (ext) => path(`${PREVIOUS}.${ext}`);
      if (exists(cur("elf")) && exists(cur("json"))) {
        remove(prev("elf"));
        remove(prev("json"));
        fs.rename(cur("json"), prev("json"));
        fs.rename(cur("elf"), prev("elf"));
      } else {
        remove(cur("json"));
        remove(cur("elf"));
      }
      fs.rename(incoming, cur("elf"));
      fs.writeFile(path(`${CURRENT}.json.tmp`), manifestText, { sync: true });
      fs.rename(path(`${CURRENT}.json.tmp`), cur("json"));
      try {
        fs.removeTree?.(path("incoming"));
      } catch {
      }
    }

    let running = null;
    /** Olha (e baixa) uma versao nova, respeitando a opcao e o intervalo; `force` ignora o intervalo. Nunca lanca. */
    function check({ force = false } = {}) {
      if (!enabled()) return Promise.resolve({ state: "off" });
      if (!running) running = checkNow(force).finally(() => {
        running = null;
      });
      return running;
    }
    async function checkNow(force) {
      const saved = load();
      const t = now();
      if (!force && (saved.checkedAt && t - saved.checkedAt < checkMs || saved.failedAt && t - saved.failedAt < retryMs)) return { state: "recent" };
      publish({ checking: true });
      try {
        const answer = await http.request(`https://api.github.com/repos/${repo}/git/matching-refs/tags/${TAG_PREFIX}`, { headers, maxBytes: 256 * 1024 });
        let tags = [];
        if (answer.status !== 404) {
          if (!answer.ok) throw new Error(`GitHub answered HTTP ${answer.status}`);
          tags = tubeTags(await answer.json());
        }
        const bad = badList();
        const have = bestVersion();
        const pick = tags.find((version) => !bad.includes(version) && (!have || newer(version, have)));
        if (!pick) {
          save({ checkedAt: t, failedAt: 0, error: "" });
          publish({ checking: false, error: "" });
          return { state: "current", version: have };
        }
        // Sem cabecalhos proprios: o Http segue o redirect do download do GitHub.
        const response = await http.request(releaseFile(pick, "tube-service.json"), { maxBytes: 16 * 1024 });
        if (!response.ok) throw new Error(`tube-service.json answered HTTP ${response.status}`);
        const text = await response.text();
        const parsed = parseManifest(text, { publicKey, version: pick, api, clientApi });
        if (!parsed.ok) {
          // Uma que pede uma Jobe mais nova (ou uma API mais nova) nao e erro: espera a proxima.
          const reason = parsed.reason === "jobe" || parsed.reason === "api" ? "" : `tube-service ${pick}: manifest refused (${parsed.reason})`;
          if (reason) log(reason);
          save({ checkedAt: t, failedAt: 0, error: reason });
          publish({ checking: false, error: reason });
          return { state: parsed.reason === "jobe" ? "needs-app" : "refused", version: pick, reason: parsed.reason };
        }
        log(`tube-service ${pick} found (have ${have ?? "none"}); downloading`);
        const incoming = await download(parsed.manifest);
        install(incoming, text);
        memo.clear();
        save({ checkedAt: t, failedAt: 0, error: "", installed: pick });
        publish({ checking: false, error: "" });
        log(`tube-service ${pick} ready; it is used the next time the service starts`);
        try {
          onInstalled(pick);
        } catch {
        }
        return { state: "installed", version: pick };
      } catch (error) {
        const message = error?.message ?? String(error);
        log(`check failed: ${message}`);
        save({ failedAt: t, error: message });
        publish({ checking: false, error: message });
        return { state: "failed", error: message };
      }
    }
    return {
      candidates,
      bestVersion,
      noteRunning,
      markBad,
      inUse,
      check,
      state: () => view,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
  }

export { CHECK_MS, CLIENT_API, PUBLIC_KEY, TAG_PREFIX, TUBE_DIR, createTubeUpdater, manifestMessage, parseManifest, tubeTags };
