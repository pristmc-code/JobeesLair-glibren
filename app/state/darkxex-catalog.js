// glibren.48: o PS5 Homebrew Catalog (darkxex/ps5-homebrew-catalog, GPL-3.0-or-later; https://prosperostore.net) como
// segunda lista da aba Homebrew, ao lado da lista da Jobe (state/homebrew-index.js). Daqui so saem DADOS do catalogo
// (title ID, nome, autor, link do release, sha256): nenhum codigo do repositorio foi copiado.
//
// De onde vem:
//   - a lista: FEED_URL (catalog/v1.json, ~170 KB, um pedido so), lida item a item (json-scan.js), sem a arvore inteira
//     do documento; so os apps com status "available", link e sha256 entram (reservas e retirados nao aparecem);
//   - na hora de instalar: o manifesto ASSINADO da API (api/v1/manifest.json + manifest.sig, Ed25519 com uma das duas
//     chaves publicas do catalogo, numero de sequencia que nunca desce) e o apps/<id>.json do app, conferido pelo
//     sha256 do manifesto. O link e o sha256 que valem sao os do arquivo assinado; o Downloads nativo confere o
//     arquivo baixado contra esse sha256 e recusa se nao bater ("SHA-256 mismatch").
//
// Junta com a lista da Jobe (mergeCatalogs): mesmo repositorio = o mesmo app; mesmo title ID com nome parecido = o
// mesmo app (repositorio novo do mesmo projeto); mesmo title ID com outro nome = dois apps, cada um avisa do outro
// (instalar um substitui o outro no console). Fica a versao mais nova (compareVersions); a entrada diz de que listas
// veio (`sources`).

import { jsonMembers } from './json-scan.js';
import { parseStamp } from './clock.js';
import { fromHex, verify } from './ed25519.js';
import { fromUtf8, hex, sha256 } from './secret-box.js';

  var FEED_URL = "https://prosperostore.net/catalog/v1.json";
  var API_URL = "https://prosperostore.net/api/v1/";
  var CREDIT_URL = "https://github.com/darkxex/ps5-homebrew-catalog";
  // As duas chaves publicas do catalogo (docs/api.md "The public keys"; keys/catalog-signing-1 e -2). Vale qualquer uma.
  var PUBLIC_KEYS = [
    "87391bf1698ecef101bf5e29dc8585ee5947d571e19470de7411c5d3b137b5cf",
    "509bcfab7edfb4e5ed23639488517c6ef2657c13b6b7f2bf699c8989d9b0dd7b"
  ];
  var MAX_FEED_BYTES = 2 * 1024 * 1024;
  var MAX_MANIFEST_BYTES = 512 * 1024;
  var MAX_APP_BYTES = 64 * 1024;
  var MAX_APPS = 600;
  // Itens que a Jobe nao mostra (ANALISE-ps5-homebrew-catalog.md, secao 3): ferramentas cujo uso tipico e rodar copias
  // (FPKG, dumps), destravar trofeus, chaves de save, ou outra loja de conteudo nao verificado.
  var HIDDEN = /* @__PURE__ */ new Set(["PPSA99594", "PPSA99180", "PPSA99842", "PPSA99700", "PSPL47000", "PPSA92000"]);
  // As categorias do catalogo nas da aba Homebrew (app/data/homebrew.json).
  var CATEGORIES = {
    "console-ports": "games",
    "pc-ports": "games",
    "homebrew-games": "games",
    showcases: "games",
    emulators: "emulators",
    video: "media",
    music: "media",
    streaming: "streaming",
    utilities: "system",
    tools: "system",
    ai: "system"
  };
  var TITLE = /^[A-Z]{4}\d{5}$/;
  var SHA = /^[0-9a-f]{64}$/;
  var REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/?$/;
  var str = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
  var https = (value) => typeof value === "string" && /^https:\/\/[^\s"'<>]+$/.test(value) && value.length <= 600 ? value : null;
  // O que a Jobe faz com cada formato: zip = a pasta do app (sce_sys + eboot.bin); imagem = vai para <disco>/homebrew/.
  var KIND_OF_FORMAT = { zip: "app", ffpfsc: "image", ffpkg: "image", ffpfs: "image", exfat: "image" };

  /** A tag do release no link (`.../releases/download/<tag>/<arquivo>`), ou null. */
  function tagOf(url, repo) {
    const prefix = `https://github.com/${repo}/releases/download/`;
    if (typeof url !== "string" || !url.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    const rest = url.slice(prefix.length).split("/");
    if (rest.length !== 2 || !rest[0] || !rest[1]) return null;
    try {
      return decodeURIComponent(rest[0]);
    } catch {
      return null;
    }
  }
  function fileNameOf(url) {
    const raw = url.slice(url.lastIndexOf("/") + 1);
    let name;
    try {
      name = decodeURIComponent(raw);
    } catch {
      return null;
    }
    return name.length <= 200 && /^[^/\\\x00-\x1f]+$/.test(name) && name !== "." && name !== ".." ? name : null;
  }
  var formatOf = (raw, name) => {
    const declared = typeof raw.format === "string" ? raw.format.toLowerCase() : "";
    if (declared) return declared;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  };

  /**
   * Um registro do catalogo (catalog/v1.json `apps[]` ou api/v1/apps/<id>.json) no formato de app da aba Homebrew,
   * ou null quando nao entra (reserva, retirado, sem link/sha256, link fora do release do proprio repositorio,
   * title ID escondido). Um formato que a Jobe ainda nao instala entra com `files: []` e `unsupported: "<formato>"`.
   */
  function normalizeDarkxexApp(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.status !== void 0 && raw.status !== "available") return null;
    const titleId = typeof raw.titleid === "string" ? raw.titleid : "";
    if (!TITLE.test(titleId) || HIDDEN.has(titleId)) return null;
    const match = REPO_URL.exec(typeof raw.source_repo === "string" ? raw.source_repo : "");
    if (!match) return null;
    const repo = `${match[1]}/${match[2]}`;
    const url = https(raw.artifact_url);
    const sha = typeof raw.sha256 === "string" ? raw.sha256.toLowerCase() : "";
    if (!url || !SHA.test(sha)) return null;
    const tag = tagOf(url, repo);
    const name = tag ? fileNameOf(url) : null;
    if (!tag || !name) return null;
    const title = str(raw.name, 60).trim();
    if (!title) return null;
    const format = formatOf(raw, name);
    const kind = KIND_OF_FORMAT[format] ?? null;
    const author = str(raw.author, 40).trim() || match[1];
    const category = CATEGORIES[raw.category] ?? "system";
    const description = str(raw.description, 300);
    const date = parseStamp(raw.updated) ?? 0;
    const files = kind ? [{ name, kind, url, size: Number.isSafeInteger(raw.size) && raw.size > 0 ? raw.size : null, sha256: sha, darkxex: titleId, ...kind === "app" ? { folder: titleId } : {} }] : [];
    return {
      id: repo.toLowerCase(),
      repo,
      name: title,
      author,
      category,
      description,
      about: "",
      stars: 0,
      license: str(raw.license, 40) || null,
      icon: https(raw.icon_url) && /\.(png|jpe?g)(\?|$)/i.test(raw.icon_url) ? raw.icon_url : null,
      iconFromAvatar: false,
      logo: null,
      hero: null,
      shots: [],
      pushed: date || null,
      release: { tag, title: "", date: date || null, prerelease: false, notes: "", url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`, downloads: 0 },
      files,
      note: null,
      with: [],
      titleId,
      sources: ["darkxex"],
      ...kind ? {} : { unsupported: format || "?" },
      search: `${title} ${author} ${repo} ${description} ${category}`.toLowerCase()
    };
  }

  /**
   * catalog/v1.json -> { commit, apps, skipped }. Le um app por vez (json-scan.js): so o texto de um item vira objeto,
   * e o objeto e trocado pelo registro enxuto na hora. Texto que nao e o feed: null.
   */
  function parseDarkxexFeed(text) {
    if (typeof text !== "string" || !text) return null;
    const apps = [];
    const ids = /* @__PURE__ */ new Set();
    let commit = "", schema = 0, skipped = 0, sawApps = false;
    try {
      for (const part of jsonMembers(text, 0, text.length, "apps")) {
        if (part.key === "schema" && !part.item) schema = JSON.parse(text.slice(part.start, part.end));
        else if (part.key === "source" && !part.item) {
          const source = JSON.parse(text.slice(part.start, part.end));
          commit = typeof source?.commit === "string" ? source.commit.slice(0, 64) : "";
        } else if (part.key === "apps" && part.open) sawApps = true;
        else if (part.key === "apps" && part.item) {
          if (apps.length >= MAX_APPS) continue;
          let raw;
          try {
            raw = JSON.parse(text.slice(part.start, part.end));
          } catch {
            skipped += 1;
            continue;
          }
          const app = normalizeDarkxexApp(raw);
          if (!app) {
            skipped += 1;
            continue;
          }
          // Dois apps do mesmo repositorio (zizc3/hydroid tem dois): o segundo leva o title ID no id.
          if (ids.has(app.id)) app.id = `${app.id}#${app.titleId.toLowerCase()}`;
          if (ids.has(app.id)) {
            skipped += 1;
            continue;
          }
          ids.add(app.id);
          apps.push(app);
        }
      }
    } catch {
      return null;
    }
    if (schema !== 1 || !sawApps) return null;
    return { commit, apps, skipped };
  }

  // ---- Versoes ------------------------------------------------------------------------------------------------------
  // Os numeros de uma tag ("v1.000.116" -> [1, 0, 116]; "vk-285-190" -> [285, 190]; "Alpha-2.1" -> [2, 1]).
  var numbersOf = (tag) => (String(tag).match(/\d+/g) ?? []).slice(0, 8).map(Number);
  /**
   * Qual release e mais novo: > 0 quando `a` e mais novo que `b`, < 0 quando e mais velho, 0 quando nao da para
   * dizer. Pelos numeros da tag; sem numeros dos dois lados, pela data.
   */
  function compareVersions(a, b) {
    const x = numbersOf(a?.tag), y = numbersOf(b?.tag);
    if (x.length && y.length) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d) return d;
      }
      if (a?.tag === b?.tag) return 0;
    }
    return (a?.date || 0) - (b?.date || 0);
  }

  // ---- Juntar as listas -----------------------------------------------------------------------------------------
  var TITLE_IN = /[A-Z]{4}\d{5}/g;
  // Os title IDs que uma app da lista da Jobe instala (pelo nome dos arquivos, da pasta ou do que vai dentro).
  function titlesOf(app) {
    if (app.titleId) return [app.titleId];
    const found = /* @__PURE__ */ new Set();
    for (const file of app.files) for (const text of [file.name, file.folder, file.inner]) for (const m of String(text ?? "").match(TITLE_IN) ?? []) found.add(m);
    return [...found];
  }
  var plain = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  // "PS5MC" e "PS5MC (Kodi)", "OpenNOW PS5 - Prototype" e "OpenNOW PS5 - Prototype": o mesmo projeto.
  function sameName(a, b) {
    const x = plain(a), y = plain(b);
    if (x.length < 3 || y.length < 3) return x === y;
    return x === y || x.startsWith(y) || y.startsWith(x);
  }

  /**
   * A lista da Jobe (`base`, de normalizeIndex) com os apps do darkxex (`extra`, de parseDarkxexFeed): { generated,
   * categories, apps, stats: { added, duplicates } }. `extra` vazio ou null: a lista da Jobe como veio.
   */
  function mergeCatalogs(base, extra, categoryNames = null) {
    const apps = base.apps.slice();
    const stats = { added: 0, duplicates: 0, newer: 0 };
    if (!extra?.length) return { ...base, apps, stats };
    const byRepo = /* @__PURE__ */ new Map();
    const byTitle = /* @__PURE__ */ new Map();
    apps.forEach((app, i) => {
      byRepo.set(app.repo.toLowerCase(), i);
      for (const title of titlesOf(app)) if (!byTitle.has(title)) byTitle.set(title, i);
    });
    const conflicts = [];
    for (const item of extra) {
      let at = item.id.includes("#") ? -1 : byRepo.get(item.repo.toLowerCase()) ?? -1;
      const sameTitle = byTitle.get(item.titleId) ?? -1;
      if (at < 0 && sameTitle >= 0) {
        if (sameName(apps[sameTitle].name, item.name)) at = sameTitle;
        else conflicts.push([sameTitle, item]);
      }
      if (at < 0) {
        apps.push(item);
        byRepo.set(item.repo.toLowerCase(), apps.length - 1);
        if (!byTitle.has(item.titleId)) byTitle.set(item.titleId, apps.length - 1);
        stats.added += 1;
        continue;
      }
      stats.duplicates += 1;
      const was = apps[at];
      const merged = { ...was, sources: ["jobe", "darkxex"], titleId: item.titleId, license: was.license || item.license, description: was.description || item.description, icon: was.icon || item.icon, iconFromAvatar: was.icon ? was.iconFromAvatar : false };
      const same = was.files.find((file) => item.files[0] && file.url === item.files[0].url);
      if (same) {
        // O mesmo arquivo nas duas listas: fica o da Jobe, com o sha256 do catalogo.
        merged.files = was.files.map((file) => file === same ? { ...file, sha256: item.files[0].sha256, darkxex: item.titleId } : file);
      } else if (item.files.length && compareVersions(item.release, was.release) > 0) {
        // O darkxex tem uma versao mais nova: o arquivo dele (com sha256), o release dele; a arte e o texto da Jobe ficam.
        // Os ajudantes (payloads) do release antigo nao valem para o novo: saem.
        stats.newer += 1;
        merged.files = item.files;
        merged.with = [];
        merged.repo = item.repo;
        merged.release = { ...item.release, downloads: 0 };
        merged.from = "darkxex";
      }
      merged.search = `${merged.search} ${item.titleId.toLowerCase()} darkxex`;
      apps[at] = merged;
    }
    // Mesmo title ID com outro nome: os dois ficam, e cada pagina diz qual o outro.
    for (const [i, item] of conflicts) {
      const j = apps.indexOf(item);
      if (j < 0) continue;
      apps[i] = { ...apps[i], conflicts: [...apps[i].conflicts ?? [], item.name] };
      apps[j] = { ...apps[j], conflicts: [...apps[j].conflicts ?? [], apps[i].name] };
    }
    const known = new Set(base.categories.map((c) => c.id));
    const categories = base.categories.slice();
    for (const app of apps) {
      if (known.has(app.category)) continue;
      known.add(app.category);
      categories.push({ id: app.category, name: categoryNames?.get(app.category) ?? app.category });
    }
    return { ...base, categories, apps, stats };
  }

  // ---- A conferencia assinada (na hora de instalar) -------------------------------------------------------------
  /** Os bytes de uma resposta `binary: true` (um caractere por byte) como lista de numeros. */
  function bytesOf(text) {
    const out = new Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 255;
    return out;
  }
  /**
   * Confere o manifesto: { ok: true, manifest: { files, sequence } } ou { ok: false, reason } ("signature", "json",
   * "fields" ou "rollback": sequencia menor que a ja aceita). `manifestBytes` e `signatureBytes` sao listas de bytes.
   */
  function verifyManifest(manifestBytes, signatureBytes, { minSequence = 0, keys = PUBLIC_KEYS } = {}) {
    if (!Array.isArray(manifestBytes) || !manifestBytes.length || manifestBytes.length > MAX_MANIFEST_BYTES) return { ok: false, reason: "fields" };
    if (!Array.isArray(signatureBytes) || signatureBytes.length !== 64) return { ok: false, reason: "signature" };
    if (!keys.some((key) => verify(signatureBytes, manifestBytes, fromHex(key)))) return { ok: false, reason: "signature" };
    let m;
    try {
      m = JSON.parse(fromUtf8(manifestBytes) ?? "");
    } catch {
      return { ok: false, reason: "json" };
    }
    if (!m || typeof m !== "object" || !m.files || typeof m.files !== "object" || !Number.isSafeInteger(m.sequence) || m.sequence < 0) return { ok: false, reason: "fields" };
    if (m.sequence < minSequence) return { ok: false, reason: "rollback" };
    return { ok: true, manifest: { files: m.files, sequence: m.sequence } };
  }
  /**
   * Um apps/<id>.json conferido pelo manifesto: { ok: true, app } (o registro normalizado) ou { ok: false, reason }
   * ("unlisted": o manifesto nao tem esse arquivo; "hash": os bytes nao batem; "json"; "gone": nao esta disponivel).
   */
  function verifyAppFile(manifest, path, bytes) {
    const expected = manifest.files[path];
    if (typeof expected !== "string" || !SHA.test(expected)) return { ok: false, reason: "unlisted" };
    if (!Array.isArray(bytes) || bytes.length > MAX_APP_BYTES || hex(sha256(bytes)) !== expected) return { ok: false, reason: "hash" };
    let raw;
    try {
      raw = JSON.parse(fromUtf8(bytes) ?? "");
    } catch {
      return { ok: false, reason: "json" };
    }
    const app = normalizeDarkxexApp(raw);
    return app ? { ok: true, app } : { ok: false, reason: "gone" };
  }
  /**
   * Busca e confere, pela API assinada, o arquivo de um app da lista (`file`: o arquivo da aba, com `darkxex` = title
   * ID; `repo`: o repositorio dele). `get(url, options)` e o Http.request. Devolve { url, sha256, size, sequence } do
   * registro assinado, ou lanca um Error com `reason`.
   */
  async function confirmDarkxexFile({ get, file, repo, minSequence = 0 }) {
    const fail = (reason, detail = "") => {
      const error = new Error(`darkxex: ${reason}${detail ? ` (${detail})` : ""}`);
      error.reason = reason;
      throw error;
    };
    const fetchBytes = async (path, maxBytes) => {
      const response = await get(`${API_URL}${path}`, { binary: true, maxBytes });
      if (!response.ok) fail("network", `${path} HTTP ${response.status}`);
      return bytesOf(typeof response.bytes === "function" ? await response.bytes() : await response.text());
    };
    const checked = verifyManifest(await fetchBytes("manifest.json", MAX_MANIFEST_BYTES), await fetchBytes("manifest.sig", 1024), { minSequence });
    if (!checked.ok) fail(checked.reason);
    const { manifest } = checked;
    const owner = repo.split("/")[0].toLowerCase();
    // O app e apps/<TITLEID>.json, ou apps/<TITLEID>-<dono>.json quando outro app chegou antes com o mesmo title ID.
    const paths = [`apps/${file.darkxex}.json`, `apps/${file.darkxex}-${owner}.json`].filter((path) => path in manifest.files);
    if (!paths.length) fail("gone");
    for (const path of paths) {
      const found = verifyAppFile(manifest, path, await fetchBytes(path, MAX_APP_BYTES));
      if (!found.ok) {
        if (found.reason === "gone") continue;
        fail(found.reason, path);
      }
      if (found.app.repo.toLowerCase() !== repo.toLowerCase()) continue;
      const signed = found.app.files[0];
      if (!signed) fail("format");
      return { url: signed.url, name: signed.name, sha256: signed.sha256, size: signed.size, tag: found.app.release.tag, sequence: manifest.sequence };
    }
    return fail("gone");
  }

export { API_URL, CREDIT_URL, FEED_URL, HIDDEN, PUBLIC_KEYS, bytesOf, compareVersions, confirmDarkxexFile, mergeCatalogs, normalizeDarkxexApp, parseDarkxexFeed, sameName, verifyAppFile, verifyManifest };
