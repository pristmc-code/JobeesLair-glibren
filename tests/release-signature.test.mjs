// glibren.46 (A-M1): a assinatura propria das atualizacoes da Jobe (app/state/release-signature.js) e o verificador
// (app/state/updater.js) que so oferece para instalar com o manifesto assinado. Chaves de teste geradas aqui (nunca a
// chave real). Run: node --import ./tests/stub-loader.mjs --test tests/release-signature.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const { GLIBREN_PUBLIC_KEY, MANIFEST_NAME, RELEASE_DOMAIN, SIGNATURE_NAME, releaseMessage, verifyRelease } = await import('../app/state/release-signature.js');
const { PUBLIC_KEY: TUBE_PUBLIC_KEY } = await import('../app/state/tube-update.js');
const { createUpdateChecker } = await import('../app/state/updater.js');

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, hex: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex') };
}
const KEY = keyPair();
const OTHER = keyPair();
const REPO = 'pristmc-code/JobeesLair-glibren';
const TAG = 'v0.5.5-glibren.47';
const VERSION = '0.5.5-glibren.47';
const SHA = { image: 'a'.repeat(64), zip: 'b'.repeat(64) };
const SIZE = { image: 5000, zip: 300 };
const dl = (name, tag = TAG) => `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${name}`;

// O manifesto como o assinar_jobe.py grava (JSON com indent 2 + \n) e a assinatura em hex.
function manifestText(fields = {}) {
  const m = { format: 1, name: 'jobe-release', version: VERSION, files: [
    { name: 'update.zip', size: SIZE.zip, sha256: SHA.zip },
    { name: 'JobeesLair.exfat', size: SIZE.image, sha256: SHA.image },
  ], ...fields };
  return `${JSON.stringify(m, null, 2)}\n`;
}
const sign = (text, key = KEY) => `${crypto.sign(null, Buffer.from(RELEASE_DOMAIN + text, 'ascii'), key.privateKey).toString('hex')}\n`;

// O GitHub falso: a release mais nova (com ou sem os arquivos de assinatura) e os arquivos pequenos dela.
function github({ manifest = manifestText(), signature = sign(manifestText()), withSigning = true, digests = SHA } = {}) {
  const asset = (name, size, sha) => ({ name, size, digest: `sha256:${sha}`, browser_download_url: dl(name) });
  const assets = [asset('JobeesLair.exfat', SIZE.image, digests.image), asset('update.zip', SIZE.zip, digests.zip)];
  if (withSigning) assets.push(asset(MANIFEST_NAME, 400, 'c'.repeat(64)), asset(SIGNATURE_NAME, 129, 'd'.repeat(64)));
  const release = { tag_name: TAG, html_url: `https://github.com/${REPO}/releases/tag/${TAG}`, body: 'notes', published_at: '2026-11-13T00:00:00Z', assets };
  const files = { [dl(MANIFEST_NAME)]: manifest, [dl(SIGNATURE_NAME)]: signature };
  const asked = [];
  const http = {
    async request(url) {
      asked.push(url);
      if (url.endsWith('/releases/latest')) return { ok: true, status: 200, json: async () => release, text: async () => JSON.stringify(release) };
      const body = files[url];
      if (body === undefined || body === null) return { ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' };
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
    },
  };
  return { http, asked };
}
function checker(gh, options = {}) {
  let saved = {};
  const logs = [];
  const c = createUpdateChecker({ http: gh.http, store: { get: () => saved, set: (v) => { saved = v; } }, version: '0.5.5-glibren.46', repo: REPO, publicKey: KEY.hex, log: (line) => logs.push(line), ...options });
  return { c, logs, store: () => saved };
}

test('a chave publica embutida e a do glibren (a mesma do tube-service, do glibren-payload e dos scripts de publicacao)', () => {
  assert.equal(GLIBREN_PUBLIC_KEY, 'ce2767604727310aa1b2a5713fe7b76774b7ecd8c68240fef789819a473847c0');
  assert.equal(GLIBREN_PUBLIC_KEY, TUBE_PUBLIC_KEY, 'tube-update.js PUBLIC_KEY');
  // As copias fora do repositorio, no PC de quem publica: PS5_BASE = a pasta com glibren-payload/ e jobe/ferramentas/
  // (o pacote.sh exporta).
  const base = process.env.PS5_BASE || '';
  if (!base) return;
  const header = `${base}/glibren-payload/src/chave_publica.h`;
  assert.ok(existsSync(header), header);
  {
    const bytes = [...readFileSync(header, 'utf8').matchAll(/0x([0-9a-fA-F]{2})/g)].map((m) => m[1].toLowerCase()).join('');
    assert.equal(bytes, GLIBREN_PUBLIC_KEY, 'glibren-payload src/chave_publica.h');
  }
  for (const script of [`${base}/jobe/ferramentas/publicar_tube.py`, `${base}/jobe/ferramentas/assinar_jobe.py`]) {
    const found = /CHAVE_PUBLICA_JOBE = "([0-9a-f]{64})"/.exec(readFileSync(script, 'utf8'));
    assert.equal(found?.[1], GLIBREN_PUBLIC_KEY, script);
  }
});

test('verifyRelease: valida com a chave certa; .sig ausente, outra chave, manifesto adulterado e outra versao sao recusados', () => {
  const text = manifestText();
  const ok = verifyRelease(text, sign(text), { publicKey: KEY.hex, version: TAG });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.manifest.files['JobeesLair.exfat'], { size: SIZE.image, sha256: SHA.image });
  assert.equal(verifyRelease(text, null, { publicKey: KEY.hex }).reason, 'missing');
  assert.equal(verifyRelease(text, '  \n', { publicKey: KEY.hex }).reason, 'missing');
  assert.equal(verifyRelease(null, sign(text), { publicKey: KEY.hex }).reason, 'missing');
  assert.equal(verifyRelease(text, sign(text, OTHER), { publicKey: KEY.hex }).reason, 'signature', 'outra chave');
  const tampered = text.replace(SHA.image, 'e'.repeat(64));
  assert.equal(verifyRelease(tampered, sign(text), { publicKey: KEY.hex }).reason, 'signature', 'sha256 trocado');
  assert.equal(verifyRelease(text, 'zz', { publicKey: KEY.hex }).reason, 'signature');
  // Sem o prefixo de dominio (uma assinatura do arquivo cru, como o glibren assina o ELF) nao vale.
  const raw = crypto.sign(null, Buffer.from(text, 'ascii'), KEY.privateKey).toString('hex');
  assert.equal(verifyRelease(text, raw, { publicKey: KEY.hex }).reason, 'signature', 'sem o prefixo');
  const other = manifestText({ version: '0.5.5-glibren.48' });
  assert.equal(verifyRelease(other, sign(other), { publicKey: KEY.hex, version: TAG }).reason, 'version');
  const bad = manifestText({ files: [{ name: 'x', size: -1, sha256: 'no' }] });
  assert.equal(verifyRelease(bad, sign(bad), { publicKey: KEY.hex }).reason, 'fields');
  assert.equal(releaseMessage('ç'), null, 'so ASCII');
});

test('verificador: release com assinatura valida fica instalavel com o tamanho e o sha256 do manifesto assinado', async () => {
  const gh = github();
  const { c } = checker(gh);
  const { update } = await c.check();
  assert.equal(update.version, VERSION);
  assert.equal(update.signed, true);
  assert.equal(update.unsigned, '');
  assert.deepEqual(update.assets, { image: { url: dl('JobeesLair.exfat'), size: SIZE.image, sha256: SHA.image }, zip: { url: dl('update.zip'), size: SIZE.zip, sha256: SHA.zip } });
  assert.ok(gh.asked.includes(dl(MANIFEST_NAME)) && gh.asked.includes(dl(SIGNATURE_NAME)));
  // A resposta guardada continua instalavel na proxima abertura.
  assert.equal(c.known().signed, true);
  assert.ok(c.known().assets);
});

for (const [name, setup, reason] of [
  ['.sig ausente na release', { withSigning: false }, 'missing'],
  ['.sig listado mas 404', { signature: null }, 'missing'],
  ['assinatura de outra chave', { signature: sign(manifestText(), OTHER) }, 'signature'],
  ['manifesto adulterado (sha256 trocado)', { manifest: manifestText().replace(SHA.image, 'e'.repeat(64)), signature: sign(manifestText()) }, 'signature'],
  ['arquivo da release diferente do manifesto assinado (sha256 do GitHub)', { digests: { image: 'f'.repeat(64), zip: SHA.zip } }, 'mismatch'],
]) {
  test(`verificador: ${name} e recusado (versao aparece, sem assets, com o motivo)`, async () => {
    const { c, logs } = checker(github(setup));
    const { update } = await c.check();
    assert.equal(update.version, VERSION);
    assert.equal(update.assets, null);
    assert.equal(update.signed, false);
    assert.equal(update.unsigned, reason);
    assert.ok(logs.some((line) => line.includes(`signature ${reason}`)), logs.join('\n'));
    assert.equal(c.known().assets, null, 'nem depois, pela resposta guardada');
  });
}

test('verificador: resposta guardada sem a assinatura conferida (de antes da .46) nunca e instalavel', () => {
  const saved = { checkedAt: 1, latest: { version: VERSION, url: 'x', notes: '', published: '', assets: { image: { url: 'u', size: 1, sha256: SHA.image } } } };
  const c = createUpdateChecker({ http: null, store: { get: () => saved, set: () => {} }, version: '0.5.5-glibren.46', repo: REPO });
  assert.equal(c.known().assets, null);
  assert.equal(c.known().unsigned, 'missing');
});

test('verificador: uma falha de rede ao baixar o manifesto falha a procura (tenta de novo depois), sem guardar nada', async () => {
  const gh = github();
  const request = gh.http.request;
  gh.http.request = async (url, o) => url.endsWith(MANIFEST_NAME) ? { ok: false, status: 502, text: async () => '' } : request(url, o);
  const { c, store } = checker(gh);
  await assert.rejects(c.check(), /HTTP 502/);
  assert.deepEqual(store(), {});
});

