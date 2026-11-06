// glibren.12: jogos de PS5 convertidos para .exfat no fim do download, com o original guardado na pasta BACKUP.
//
// Decisoes (do jogador): o criador de .exfat e o da propria Jobee'sLair (payload bg-downloader.elf, bg_convert.c); o
// original fica em <disco>/BACKUP/<jogo>/ ate o jogador apagar (Configuracoes > Downloads e a pagina do celular); vale
// para tudo de PS5: RAR/7z/zip, pasta e .pkg. O que ja monta no ShadowMount+ (.exfat/.ffpkg/.ffpfs/.ffpfsc) fica como veio.
// PS4: nada e convertido. O .pkg de PS4 vai para <disco>/PS4/ e e instalado como antes (Packages.install); compactado de
// PS4 baixa no BACKUP, e extraido, e o .pkg de dentro vai para PS4/.
//
// Onde cada download e gravado (destinationFor), com a opcao ligada: compactado (PS5 ou PS4) e .pkg de PS5 direto em
// <disco>/BACKUP/<jogo>/; .pkg de PS4 direto em <disco>/PS4/; imagens no lugar de sempre. Desligada: tudo como antes.
// O ShadowMount+ varre <disco>/homebrew, <disco>/etaHEN/games e tambem a raiz dos discos externos, com profundidade 1
// por padrao (ate 2): BACKUP/ e PS4/ nao tem eboot.bin + sce_sys, e .pkg/.rar/.part nao sao imagens que ele monte; nada
// ali vira titulo (src/sm_scan_tree.c, sm_image.c do ShadowMount+ 1.7). Ver ps5-conhecimento/08.
//
// Espaco, conferido no inicio do download (download-queue.js enqueue/space.js): o download + o .exfat (~ o mesmo
// tamanho) no mesmo disco, ~2x. O caminho de extrair (quando o compactado nao vai direto) pede mais na hora dele.

import { useEffect, useState } from 'react';
import { loadList, saveList } from './saved.js';
import { formatFromName } from './link-formats.js';

  var SETTINGS = "settings.json";
  var BACKUP = "BACKUP";
  var PS4_FOLDER = "PS4";
  // ---- A opcao "Converter jogos de PS5 para .exfat" (ligada por padrao) ----
  var enabled = null;
  var listeners = /* @__PURE__ */ new Set();
  function convertToExfatOn() {
    if (enabled === null) {
      try {
        enabled = loadList(SETTINGS, "settings").convertExfat !== false;
      } catch {
        enabled = true;
      }
    }
    return enabled;
  }
  function setConvertToExfat(on) {
    enabled = Boolean(on);
    saveList(SETTINGS, "settings", { ...loadList(SETTINGS, "settings"), convertExfat: enabled });
    for (const listener of listeners) listener(enabled);
  }
  function onConvertToExfat(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function useConvertToExfat() {
    const [on, setOn] = useState(convertToExfatOn);
    useEffect(() => onConvertToExfat(setOn), []);
    return on;
  }

  // ---- De que console e o jogo ----
  // Pelo codigo (PPSA = PS5, CUSA = PS4), o do jogo ou o do arquivo; senao o que o catalogo diz; senao PS5.
  function platformOf({ titleId = "", release = null, game = null, name = "" } = {}) {
    const ids = [titleId, game?.titleId, name, release?.filename].map((value) => String(value || "").toUpperCase());
    if (ids.some((id) => /\bPPSA\d{5}/.test(id) || /^PPSA/.test(id))) return "ps5";
    if (ids.some((id) => /\bCUSA\d{5}/.test(id) || /^CUSA/.test(id))) return "ps4";
    const said = String(release?.platform || game?.platform || "").toLowerCase();
    return said === "ps4" ? "ps4" : "ps5";
  }
  var ARCHIVE_FORMATS = ["rar", "7z", "zip", "tar", "tar.gz", "tgz", "tar.bz2", "tar.xz", "tar.zst"];
  var IMAGE_FORMATS = ["exfat", "ffpkg", "ffpfs", "ffpfsc"];
  // O que o download e: "archive", "pkg", "image" ou "other" (pelo artefato que o motor calculou).
  function kindOf(artifact, release) {
    if (release?.parts) return "archive";
    const format = String(artifact?.format || release?.format || "").toLowerCase();
    if (artifact?.nextAction === "extraction-required" || ARCHIVE_FORMATS.includes(format)) return "archive";
    if (artifact?.nextAction === "installer-required" || format === "pkg" || format === "fpkg") return "pkg";
    if (artifact?.nextAction === "shadowmount" || IMAGE_FORMATS.includes(format)) return "image";
    return "other";
  }
  // Um nome de pasta seguro e legivel (o titulo do jogo, ou o codigo).
  function safeFolderName(name) {
    const clean = String(name || "").normalize?.("NFC").replace(/[\x00-\x1f/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 96);
    return clean || "Jogo";
  }
  // A pasta do jogo no BACKUP: <disco>/BACKUP/<titulo>; uma ja usada (por outro item da fila ou que ja existe) ganha
  // " (2)", " (3)"...
  function backupFolder(root, title, taken = () => false) {
    const base = `${root}/${BACKUP}/${safeFolderName(title)}`;
    for (let n = 1; n < 100; n++) {
      const path = n === 1 ? base : `${base} (${n})`;
      if (!taken(path)) return path;
    }
    return `${base} (${Date.now()})`;
  }
  /**
   * Para onde vai um download novo e o que acontece depois. `artifact` e o que o motor calculou (formats.artifact ou o
   * de um conjunto em partes). Devolve { artifact, convert, backupDir, platform, kind }: `convert` = vira .exfat no fim;
   * `backupDir` = a pasta do BACKUP onde o original e baixado (ou null).
   */
  function destinationFor({ on, role = "game", artifact, release, root, title = "", titleId = "", game = null, taken = () => false }) {
    const platform = platformOf({ titleId, release, game });
    const kind = kindOf(artifact, release);
    const plain = { artifact, convert: false, backupDir: null, platform, kind };
    if (!on || role !== "game") return plain;
    if (kind === "pkg" && platform === "ps4") {
      const directory = `${root}/${PS4_FOLDER}`;
      return { ...plain, artifact: { ...artifact, directory, destination: `${directory}/${baseName(artifact.destination)}` } };
    }
    if (kind !== "archive" && !(kind === "pkg" && platform === "ps5")) return plain;
    const backupDir = backupFolder(root, title || titleId, taken);
    // Um conjunto em partes guarda os volumes na pasta dele (directory); o resto, o arquivo baixado.
    const moved = release?.parts ? { ...artifact, directory: backupDir } : { ...artifact, directory: backupDir, destination: `${backupDir}/${baseName(artifact.destination)}` };
    return { ...plain, artifact: moved, convert: platform === "ps5", backupDir };
  }
  var baseName = (path) => String(path).slice(String(path).lastIndexOf("/") + 1);
  // Onde a imagem convertida fica: <disco>/homebrew/<codigo>.exfat (o codigo do jogo; senao o nome do release).
  function exfatOutput(root, { titleId = "", fallback = "jogo" } = {}, taken = () => false) {
    const id = /^[A-Z]{4}\d{5}$/i.test(String(titleId)) ? String(titleId).toUpperCase() : String(fallback).replace(/\.[^.]*$/, "").replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80) || "jogo";
    for (let n = 1; n < 100; n++) {
      const path = `${root}/homebrew/${id}${n === 1 ? "" : `-${n}`}.exfat`;
      if (!taken(path)) return path;
    }
    return `${root}/homebrew/${id}-${Date.now()}.exfat`;
  }
  // O rotulo do volume exFAT (ate 11 caracteres): o codigo do jogo.
  var exfatLabel = (titleId) => String(titleId || "JOBE").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 11) || "JOBE";
  // O codigo de um erro da conversao ("space: ...", "not-direct: ..."): o que o payload (bg_convert.c) manda.
  var CODES = ["space", "not-direct", "not-a-game", "source", "write", "verify", "unavailable"];
  function errorCode(message) {
    const code = /^([a-z-]+):/.exec(String(message || ""))?.[1];
    return CODES.includes(code) ? code : "other";
  }
  var errorDetail = (message) => String(message || "").replace(/^[a-z-]+:\s*/, "");

  // ---- A pasta BACKUP: listar e apagar por jogo ----
  function treeSize(fs, path, depth = 0) {
    let bytes = 0, files = 0;
    let entries = [];
    try {
      entries = fs.readDir(path);
    } catch {
      return { bytes, files };
    }
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory) {
        if (depth < 6) {
          const inner = treeSize(fs, child, depth + 1);
          bytes += inner.bytes;
          files += inner.files;
        }
      } else if (entry.name !== MARKER) {
        bytes += entry.size ?? fs.stat(child)?.size ?? 0;
        files += 1;
      }
    }
    return { bytes, files };
  }
  // glibren.12: <disco>/BACKUP/<jogo>/.jobe-backup.json: { titleId, platform, format, source } de quem baixou para la
  // (o app ao por na fila; o payload ao terminar, se faltar). A lista do BACKUP le daqui de que jogo e; sem ele, deduz
  // pelo PPSA/CUSA no nome dos arquivos ou da pasta.
  var MARKER = ".jobe-backup.json";
  var CODE = /\b(PPSA|CUSA)\d{5}/i;
  function writeBackupMarker(fs, dir, { titleId = "", platform = "", format = "", source = "" } = {}) {
    const code = /^[A-Z]{4}\d{5}$/i.test(String(titleId)) ? String(titleId).toUpperCase() : "";
    const body = { titleId: code, platform: ["ps5", "ps4"].includes(platform) ? platform : "", format: /^[a-z0-9]{1,8}$/.test(format) ? format : "", source: /^[a-z0-9.-]{1,64}$/.test(source) ? source : "" };
    fs.mkdir(dir, { recursive: true });
    fs.writeFile(`${dir}/${MARKER}`, JSON.stringify(body), { sync: true });
  }
  var BACKUP_NAMES = 10;
  // { platform, code, format, parts, fileNames, moreFiles, converted } de um jogo do BACKUP (`path` a pasta dele).
  function backupDetails(fs, root, path, name) {
    let marker = {};
    try {
      if (fs.exists(`${path}/${MARKER}`)) marker = JSON.parse(fs.readFile(`${path}/${MARKER}`)) || {};
    } catch {
      marker = {};
    }
    const names = [];
    const walk = (dir, depth) => {
      let entries = [];
      try {
        entries = fs.readDir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory) {
          if (depth < 6) walk(`${dir}/${entry.name}`, depth + 1);
        } else names.push(entry.name);
      }
    };
    if (fs.stat(path)?.isDirectory) walk(path, 0);
    else names.push(name);
    names.sort();
    const counts = /* @__PURE__ */ new Map();
    for (const file of names) {
      const format2 = formatFromName(file);
      if (format2) counts.set(format2, (counts.get(format2) ?? 0) + 1);
    }
    const said = String(marker.format || "").toLowerCase();
    const format = /^[a-z0-9]{1,8}$/.test(said) ? said : [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const code = (/^[A-Z]{4}\d{5}$/i.test(String(marker.titleId || "")) ? String(marker.titleId) : [name, ...names].map((value) => CODE.exec(value)?.[0]).find(Boolean) ?? "").toUpperCase();
    const platform = ["ps5", "ps4"].includes(marker.platform) ? marker.platform : code.startsWith("PPSA") ? "ps5" : code.startsWith("CUSA") ? "ps4" : "";
    const parts = (counts.get(format) ?? 0) > 1 ? counts.get(format) : 0;
    const converted = code && fs.exists(`${root}/homebrew/${code}.exfat`) ? `${code}.exfat` : "";
    return { platform, code, format, parts, fileNames: names.slice(0, BACKUP_NAMES), moreFiles: Math.max(0, names.length - BACKUP_NAMES), converted };
  }
  /** Os jogos guardados no BACKUP de cada disco: [{ root, name, path, bytes, files, platform, code, format, parts,
   *  fileNames, moreFiles, converted }] e o total. */
  function listBackup(fs, roots) {
    const games = [];
    for (const root of roots) {
      const dir = `${root}/${BACKUP}`;
      let entries = [];
      try {
        if (!fs.exists(dir)) continue;
        entries = fs.readDir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const path = `${dir}/${entry.name}`;
        const { bytes, files } = entry.isDirectory ? treeSize(fs, path) : { bytes: entry.size ?? fs.stat(path)?.size ?? 0, files: 1 };
        games.push({ root, name: entry.name, path, bytes, files, ...backupDetails(fs, root, path, entry.name) });
      }
    }
    games.sort((a, b) => b.bytes - a.bytes);
    return { games, totalBytes: games.reduce((sum, game) => sum + game.bytes, 0) };
  }
  /** Apaga <root>/BACKUP/<name>. `inUse(path)`: um original que uma conversao ainda le nao e apagado. */
  async function deleteBackup(fs, root, name, inUse = () => false) {
    if (!name || name.startsWith(".") || /[/\\]/.test(name) || name === "..") throw new Error("Invalid BACKUP entry.");
    const path = `${root}/${BACKUP}/${name}`;
    if (!fs.exists(path)) throw new Error("This BACKUP entry is gone.");
    if (inUse(path)) throw Object.assign(new Error("Still being converted."), { busy: true });
    await fs.removeAsync(path);
    return path;
  }

export { BACKUP, PS4_FOLDER, backupDetails, backupFolder, writeBackupMarker, convertToExfatOn, deleteBackup, destinationFor, errorCode, errorDetail, exfatLabel, exfatOutput, kindOf, listBackup, onConvertToExfat, platformOf, safeFolderName, setConvertToExfat, useConvertToExfat };
