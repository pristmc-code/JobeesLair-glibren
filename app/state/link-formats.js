// Link formats (glibren fork): what kind of file a download link leads to, told without downloading it.
// Most catalog links say "binary" (nothing known); for those, a source's format is, in this order:
//   catalog   the catalog's own format (exfat, pkg, rar, an archive set…)
//   name      read from the link's file name: the catalog filename, the URL's path (a MediaFire or Rapidgator
//             URL carries the file's name), a set's first part
//   found     what "Find formats" (state/format-probe.js) learned and saved: a file link's answer
//             (Content-Disposition, Content-Type, its final URL, its first bytes), a host page's file name,
//             or TorBox's list of a cached item's files
//   download  what a real download's first bytes said (download-queue.js reportFormat)
//   password  an archive of a kind nothing names: the catalog gives the source an archive password
// The source list shows it on each row and filters by it (state/format-filter.js). Nothing here changes how a
// source downloads or ranks: the download queue still reads the bytes for itself.

  /** The filter's groups: a disk image ShadowMount+ mounts, a package, an archive to unpack. */
  var FORMAT_GROUP = {
    exfat: "image",
    ffpkg: "image",
    ffpfs: "image",
    ffpfsc: "image",
    pkg: "pkg",
    fpkg: "pkg",
    zip: "archive",
    rar: "archive",
    "7z": "archive",
    tar: "archive",
    "archive-set": "archive",
    // An archive of a kind nothing names: a source the catalog gives an archive password (2,360 of the 2,361
    // such links whose name says a format are archives).
    archive: "archive"
  };
  var GROUPS = ["image", "pkg", "archive"];
  // glibren: the image types the filter can pick among (FFPFSC goes with FFPFS: the same mount, compressed).
  var IMAGE_TYPES = ["exfat", "ffpkg", "ffpfs"];
  var imageTypeOf = (format) => format === "ffpfsc" ? "ffpfs" : IMAGE_TYPES.includes(format) ? format : null;
  var groupOf = (format) => FORMAT_GROUP[format] ?? null;
  var decodeName = (value) => {
    try {
      return decodeURIComponent(String(value).replace(/\+/g, " "));
    } catch {
      return String(value);
    }
  };
  // A file name's format, from its extension: "Game.exfat", "Game.part01.rar", "Game.7z.001", "Game.r00",
  // "Game.pkg.rar" (an archive), "PPSA02210-PS5.rar.html" (Rapidgator's page names the file and adds .html).
  // Null for anything else, the catalog's own ".binary" placeholder included.
  var NAMED = [
    [/\.(?:rar|zip|7z)\.html?$/i, (m) => m[0].split(".")[1].toLowerCase()],
    [/\.part\d{1,4}\.(rar|zip|7z)$/i, (m) => m[1].toLowerCase()],
    [/\.(rar|zip|7z|tar)\.\d{3}$/i, (m) => m[1].toLowerCase()],
    [/\.r\d{2}$/i, () => "rar"],
    [/\.z\d{2}$/i, () => "zip"],
    [/\.(?:tar\.(?:gz|bz2|xz|zst)|tgz)$/i, () => "tar"],
    [/\.(exfat|ffpkg|ffpfsc|ffpfs|pkg|rar|zip|7z|tar)$/i, (m) => m[1].toLowerCase()]
  ];
  function formatFromName(value) {
    if (typeof value !== "string" || !value) return null;
    const name = decodeName(value.split(/[?#]/)[0]).trim().replace(/[\s"']+$/, "");
    for (const [pattern, format] of NAMED) {
      const match = pattern.exec(name);
      if (match) return format(match);
    }
    return null;
  }
  // The path segments of a link that may be a file name: MediaFire's sits before its trailing "/file", so each
  // segment is tried, the last first.
  function namesInURL(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return [];
    const path = url.replace(/^https?:\/\/[^/?#]+/i, "").split(/[?#]/)[0];
    return path.split("/").filter(Boolean).reverse();
  }
  var sourcesOf = (release) => release?.parts ? release.parts.map((part) => part.sources?.[0]).filter(Boolean) : release ? [release] : [];
  /** A release's format read from its names (catalog filename, URL, a set's first part), or null. */
  function deduceFormat(release) {
    for (const source of sourcesOf(release).slice(0, 1)) {
      const names = [source.filename, ...namesInURL(source.url), ...namesInURL(source.browserUrl)];
      for (const name of names) {
        const format = formatFromName(name);
        if (format) return format;
      }
    }
    return null;
  }
  /** The link a release's format is saved under: its first source's page or file link. */
  function formatKeyOf(release) {
    const first = sourcesOf(release)[0];
    const link = first && (first.browserUrl || first.url || first.manifestUrl);
    return typeof link === "string" && link ? link : null;
  }
  // Content-Disposition's file name: filename*=UTF-8''… (RFC 5987, percent-encoded) over filename="…".
  function nameFromDisposition(value) {
    if (typeof value !== "string" || !value) return null;
    const extended = /filename\*\s*=\s*([^;]+)/i.exec(value)?.[1]?.trim();
    if (extended) {
      const encoded = extended.replace(/^"|"$/g, "").replace(/^[a-z0-9-]*'[^']*'/i, "");
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    }
    const plain = /(?:^|;)\s*filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(value);
    return plain ? (plain[2] ?? plain[1]).trim() : null;
  }
  var formatFromDisposition = (value) => formatFromName(nameFromDisposition(value));
  var TYPES = {
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
    "application/x-rar-compressed": "rar",
    "application/x-rar": "rar",
    "application/vnd.rar": "rar",
    "application/x-7z-compressed": "7z",
    "application/x-tar": "tar"
  };
  /** A Content-Type's format (an archive's own types); null for application/octet-stream and the rest. */
  var formatFromContentType = (value) => TYPES[String(value || "").split(";")[0].trim().toLowerCase()] ?? null;
  // The first bytes of a file (a string of one character per byte, as Http.request's binary bytes() gives
  // them): an archive's signature, a package's, an exFAT or PFS image's. A UFS2 image (.ffpkg) keeps its
  // magic at 65536 + 1372, past what is asked: format-probe.js asks those four bytes apart (UFS_MAGIC_AT)
  // when the first ones say nothing.
  var BYTES_ASKED = 64;
  // glibren: UFS2's superblock (at 65536) holds fs_magic 0x19540119 at offset 1372, little-endian.
  var UFS_MAGIC_AT = 65536 + 1372;
  var formatFromUfsMagic = (bytes) => typeof bytes === "string" && bytes.slice(0, 4) === "\x19\x01\x54\x19" ? "ffpkg" : null;
  var at = (bytes, offset, text) => bytes.length >= offset + text.length && bytes.slice(offset, offset + text.length) === text;
  function formatFromMagic(bytes) {
    if (typeof bytes !== "string" || bytes.length < 4) return null;
    if (at(bytes, 0, "Rar!\x1A\x07")) return "rar";
    if (at(bytes, 0, "PK\x03\x04")) return "zip";
    if (at(bytes, 0, "7z\xBC\xAF\x27\x1C")) return "7z";
    if (at(bytes, 0, "\x7FCNT") || at(bytes, 0, "\x7FFIH") || at(bytes, 0, "\x7FLIH")) return "pkg";
    if (at(bytes, 3, "EXFAT   ")) return "exfat";
    if (at(bytes, 0, "PFSC")) return "ffpfsc";
    // PFS: the u64 20130315 (0x01332A0B) little-endian at offset 8.
    if (at(bytes, 8, "\x0B\x2A\x33\x01\x00\x00\x00\x00")) return "ffpfs";
    return null;
  }
  // A host page's file name, by the host's own markup (pages saved in tests/fixtures/host-pages), then the
  // page's title. Never a page behind a check: those say nothing.
  var entities = (value) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  var READERS = {
    mediafire: [/<div\s+class="filename"[^>]*>\s*([^<]+?)\s*</i, /class="dl-btn-label"[^>]*\btitle="([^"]+)"/i],
    vikingfile: [/id="filename"[^>]*>\s*([^<]+?)\s*</i],
    "1fichier": [/class="tier-name"[^>]*>\s*([^<]+?)\s*</i],
    // XFileSharing hosts (DataNodes, FileKeeper, DataVaults): the download form's hidden file name.
    xfs: [/<input[^>]*\bname="fname"[^>]*\bvalue="([^"]+)"/i, /<input[^>]*\bvalue="([^"]+)"[^>]*\bname="fname"/i]
  };
  var GENERIC = [/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i, /<title>\s*([^<]+?)\s*<\/title>/i];
  var PAGE_HOSTS = [
    ["mediafire.com", "mediafire"],
    ["vikingfile.com", "vikingfile"],
    ["vik1ngfile.site", "vikingfile"],
    ["1fichier.com", "1fichier"],
    ["datanodes.to", "xfs"],
    ["filekeeper.net", "xfs"],
    ["datavaults.co", "xfs"]
  ];
  var isHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);
  /** The page reader for a link's host ("mediafire", "vikingfile", "1fichier", "xfs"), or null. */
  function pageReaderOf(url) {
    const host = /^https?:\/\/([^/?#:]+)/i.exec(url || "")?.[1]?.toLowerCase();
    return host ? PAGE_HOSTS.find(([domain]) => isHost(host, domain))?.[1] ?? null : null;
  }
  /** What a host page says: { name, format } of its file, { gone: true }, { check: true } (a challenge), or {}. */
  function readHostPage(reader, html) {
    if (typeof html !== "string" || !html) return {};
    if (/<title>\s*(?:Just a moment|Attention Required|DDoS-Guard)/i.test(html) || /cf-challenge|challenge-platform|g-recaptcha|h-captcha/i.test(html.slice(0, 2e5)) && !/id="filename"|class="tier-name"|name="fname"/i.test(html)) return { check: true };
    for (const pattern of [...READERS[reader] ?? [], ...GENERIC]) {
      const match = pattern.exec(html);
      if (!match) continue;
      const name = entities(match[1]).trim();
      const format = formatFromName(name) ?? formatFromName(name.replace(/^download\s+/i, "").replace(/\s+(exfat|ffpkg|ffpfsc?|pkg|rar|zip|7z)$/i, ".$1"));
      if (format) return { name, format };
    }
    if (/File Not Found|file was deleted|\/error\.php/i.test(html)) return { gone: true };
    return {};
  }
  /**
   * A release's format as the source list shows it: { format, how } with `how` "catalog", "name", "found",
   * "download", "password"; { format: null, how: "browser" } when a search found only that its host needs the browser;
   * { format: null, how: null } when nothing is known. `recordOf(link)` reads state/format-probe.js's records.
   */
  function effectiveFormat(release, recordOf = () => null) {
    const format = String(release?.format || "").toLowerCase();
    if (format && format !== "binary") return { format, how: "catalog" };
    const named = deduceFormat(release);
    if (named) return { format: named, how: "name" };
    const key = formatKeyOf(release);
    const record = key ? recordOf(key) : null;
    if (record?.f && FORMAT_GROUP[record.f]) return { format: record.f, how: record.how === "download" ? "download" : "found" };
    // glibren: the catalog's label or names call it an image of a kind ("exFAT", release-sets.js imageFormat).
    if (release?.dumpType === "image" && IMAGE_TYPES.includes(release.imageFormat)) return { format: release.imageFormat, how: "name" };
    if (release?.archivePassword || sourcesOf(release).some((source) => source.archivePassword)) return { format: "archive", how: "password" };
    return { format: null, how: record?.s === "browser" ? "browser" : null };
  }
  // A download's own reading of its first bytes (download-queue.js), for whoever keeps the records.
  var reporters = /* @__PURE__ */ new Set();
  var INSPECTED = { "tar.gz": "tar", "tar.bz2": "tar", "tar.xz": "tar", "tar.zst": "tar" };
  function reportFormat(release, kind) {
    const format = INSPECTED[kind] ?? kind;
    if (!FORMAT_GROUP[format]) return;
    for (const reporter of reporters) {
      try {
        reporter(release, format);
      } catch {
      }
    }
  }
  function onFormatReport(reporter) {
    reporters.add(reporter);
    return () => reporters.delete(reporter);
  }
  // glibren.12: de onde vem e o que e um download, para os selos da pagina do celular (o payload os mostra no
  // /api/status). So o dominio registravel do site ("download1234.mediafire.com" -> "mediafire.com"; "com.br",
  // "co.uk" e afins com tres partes), nunca caminho, consulta, porta ou usuario.
  var SECOND_LEVEL = /* @__PURE__ */ new Set(["com", "net", "org", "gov", "edu", "co", "ac"]);
  function siteOf(url) {
    const host = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:[\]]+)(?::\d+)?(?:[/?#]|$)/i.exec(String(url || ""))?.[1]?.toLowerCase().replace(/^www\./, "");
    if (!host || !/^[a-z0-9.-]+$/.test(host) || /^[.-]|[.-]$|\.\./.test(host)) return null;
    if (/^[\d.]+$/.test(host)) return host.length <= 64 ? host : null;
    const labels = host.split(".");
    const keep = labels.length >= 3 && labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2)) ? 3 : 2;
    const site = labels.slice(-keep).join(".");
    return site.length <= 64 ? site : null;
  }
  // { via?: "torbox" | "alldebrid", host?: "mediafire.com", format?: "rar", parts?: 3 } de uma fonte (release) da fila.
  // Pelo TorBox/AllDebrid o site e o CDN deles: so o `via`. O formato e o que a lista de fontes mostra (effectiveFormat);
  // um conjunto em partes, o da primeira parte.
  function originOf(release, recordOf) {
    if (!release || typeof release !== "object") return {};
    const out = {};
    const service = release.debrid?.service ?? release.parts?.[0]?.sources?.[0]?.debrid?.service;
    if (service === "torbox" || service === "alldebrid") out.via = service;
    else {
      const first = sourcesOf(release)[0];
      const link = [first?.browserUrl, first?.url].find((value) => typeof value === "string" && /^https?:\/\//i.test(value));
      const site = link ? siteOf(link) : null;
      if (site) out.host = site;
    }
    let format = effectiveFormat(release, recordOf).format;
    if (format === "archive-set" || format === "archive") format = deduceFormat(release);
    if (typeof format === "string" && /^[a-z0-9]{1,8}$/.test(format)) out.format = format;
    const parts = Array.isArray(release.parts) ? release.parts.length : 0;
    if (parts > 1) out.parts = Math.min(parts, 999);
    return out;
  }

export { BYTES_ASKED, FORMAT_GROUP, GROUPS, IMAGE_TYPES, UFS_MAGIC_AT, formatFromUfsMagic, imageTypeOf, deduceFormat, effectiveFormat, formatFromContentType, formatFromDisposition, formatFromMagic, formatFromName, formatKeyOf, groupOf, nameFromDisposition, onFormatReport, originOf, pageReaderOf, readHostPage, reportFormat, siteOf };
