// glibren.46 (A-M1): assinatura propria das atualizacoes da Jobe.
//
// Cada release do app (a partir da 0.5.5-glibren.46) traz, ao lado do JobeesLair.exfat e do update.zip, dois arquivos
// gerados e assinados no PC de quem publica (jobe/ferramentas/assinar_jobe.py, chamado pelo publicar.sh):
//   jobe-release.json      { format: 1, name: "jobe-release", version, files: [{ name, size, sha256 }, ...] } (ASCII)
//   jobe-release.json.sig  a assinatura Ed25519 (128 hex) de RELEASE_DOMAIN + o texto exato do jobe-release.json
// A chave e a MESMA do glibren e do tube-service (GLIBREN_PUBLIC_KEY; a privada fica so no PC de quem publica). O prefixo
// RELEASE_DOMAIN separa esta assinatura das outras feitas com a mesma chave (o glibren assina o ELF cru; o tube-service
// um texto que comeca com "jobe-tube-service").
//
// O verificador (state/updater.js) baixa os dois, confere a assinatura e que a versao do manifesto e a da tag, e so
// oferece para instalar com o tamanho e o sha256 do MANIFESTO ASSINADO (que tambem tem de bater com os do GitHub); o
// Downloads nativo confere o arquivo baixado contra eles. Sem assinatura valida a versao nova aparece, com o motivo, mas
// nao e instalada (nem pelo dialogo, nem automaticamente, nem pelo celular). Quem esta na .45 ou antes ainda atualiza
// para a .46 so pelo sha256 do GitHub (o app antigo nao sabe da assinatura); da .46 em diante a assinatura e exigida.

import { asciiBytes, fromHex, verify } from './ed25519.js';

  // A chave publica Ed25519 do glibren (glibren-payload src/chave_publica.h; a mesma de tube-update.js PUBLIC_KEY).
  var GLIBREN_PUBLIC_KEY = "ce2767604727310aa1b2a5713fe7b76774b7ecd8c68240fef789819a473847c0";
  var MANIFEST_NAME = "jobe-release.json";
  var SIGNATURE_NAME = "jobe-release.json.sig";
  var RELEASE_DOMAIN = "jobe-release-signature-v1\n";
  var MAX_MANIFEST = 16 * 1024;
  var MAX_FILE = 8 * 1024 ** 3;
  var VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;
  var FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

  /** Os bytes que a assinatura cobre: o prefixo + o texto do manifesto (so ASCII); null se nao for ASCII. */
  function releaseMessage(text) {
    return typeof text === "string" ? asciiBytes(RELEASE_DOMAIN + text) : null;
  }

  /**
   * Confere o manifesto assinado de uma release: { ok: true, manifest: { version, files: { nome: { size, sha256 } } } }
   * ou { ok: false, reason } com reason "missing" (sem manifesto ou sem .sig), "size", "signature", "json", "fields" ou
   * "version" (o manifesto e de outra versao que a da tag).
   */
  function verifyRelease(manifestText, signatureText, { publicKey = GLIBREN_PUBLIC_KEY, version = "" } = {}) {
    if (typeof manifestText !== "string" || !manifestText || typeof signatureText !== "string" || !signatureText.trim()) return { ok: false, reason: "missing" };
    if (manifestText.length > MAX_MANIFEST) return { ok: false, reason: "size" };
    const signature = signatureText.trim().toLowerCase();
    const message = releaseMessage(manifestText);
    if (!/^[0-9a-f]{128}$/.test(signature) || !message || !verify(fromHex(signature), message, fromHex(publicKey))) return { ok: false, reason: "signature" };
    let m;
    try {
      m = JSON.parse(manifestText);
    } catch {
      return { ok: false, reason: "json" };
    }
    if (!m || typeof m !== "object" || m.format !== 1 || m.name !== "jobe-release" || typeof m.version !== "string" || !VERSION.test(m.version) || !Array.isArray(m.files) || !m.files.length || m.files.length > 16)
      return { ok: false, reason: "fields" };
    const files = {};
    for (const file of m.files) {
      if (!file || typeof file.name !== "string" || !FILE_NAME.test(file.name) || file.name in files || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256))
        return { ok: false, reason: "fields" };
      files[file.name] = { size: file.size, sha256: file.sha256 };
    }
    if (version && m.version !== version.replace(/^v/, "")) return { ok: false, reason: "version" };
    return { ok: true, manifest: { version: m.version, files } };
  }

  /**
   * Os assets de `release` (updater.js describe()) com o tamanho e o sha256 do manifesto assinado: { ok: true, assets }
   * ou { ok: false, reason: "mismatch" } quando um deles falta no manifesto ou o GitHub diz outro tamanho/sha256.
   */
  function signedAssets(release, manifest, names) {
    const assets = {};
    for (const [key, asset] of Object.entries(release?.assets ?? {})) {
      const signed = manifest.files[names[key]];
      if (!signed || signed.size !== asset.size || signed.sha256 !== asset.sha256) return { ok: false, reason: "mismatch" };
      assets[key] = { url: asset.url, size: signed.size, sha256: signed.sha256 };
    }
    return Object.keys(assets).length ? { ok: true, assets } : { ok: false, reason: "mismatch" };
  }

export { GLIBREN_PUBLIC_KEY, MANIFEST_NAME, RELEASE_DOMAIN, SIGNATURE_NAME, releaseMessage, signedAssets, verifyRelease };
