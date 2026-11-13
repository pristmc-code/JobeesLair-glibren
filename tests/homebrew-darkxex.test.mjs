// glibren.48: o PS5 Homebrew Catalog (darkxex) na aba Homebrew: o feed lido com dados reais do catalogo
// (tests/fixtures/darkxex, copiados de prosperostore.net em 13/11/2026; catalogo GPL-3.0-or-later de
// darkxex/ps5-homebrew-catalog, so dados), a juncao com a lista da Jobe sem duplicar, a versao escolhida, os retirados
// escondidos, a assinatura do manifesto, o sha256 conferido na instalacao e a chave desligada. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const dx = await load('app/state/darkxex-catalog.js');
const { normalizeIndex } = await load('app/state/homebrew-index.js');
const { createHomebrew } = await load('app/state/homebrew.js');
const fixture = (name) => readFileSync(path.join(repo, 'tests/fixtures/darkxex', name));
const feedText = fixture('catalog-v1.sample.json').toString('utf8');
const manifestBytes = [...fixture('manifest.json')];
const signatureBytes = [...Buffer.from(fixture('manifest.sig.hex').toString('utf8').trim(), 'hex')];
const shipped = normalizeIndex(JSON.parse(readFileSync(path.join(repo, 'app/data/homebrew.json'), 'utf8')));

// ---- O feed ---------------------------------------------------------------------------------------------------------

test('feed real: cada app vira um registro da aba, com sha256, title ID, tag do link e pasta = title ID', () => {
  const feed = dx.parseDarkxexFeed(feedText);
  assert.ok(feed, 'o feed foi lido');
  assert.match(feed.commit, /^[0-9a-f]{40}$/);
  const raw = JSON.parse(feedText);
  // glibren.49: nada escondido (Alembic volta, com a linha informativa); as reservas (coming_soon) nem entram na lista.
  assert.equal(feed.apps.length, raw.apps.length);
  assert.equal(dx.HIDDEN.size, 0, 'o mecanismo fica, vazio');
  const alembic = feed.apps.find((app) => app.titleId === 'PPSA99594');
  assert.ok(alembic, 'Alembic aparece');
  assert.equal(dx.noticeOf(alembic), 'homebrew.notice.ownCopies');
  assert.equal(dx.noticeOf(feed.apps.find((app) => app.titleId === 'PPSA01153')), null, 'app comum sem aviso');
  assert.ok(!feed.apps.some((app) => raw.coming_soon.some((c) => c.titleid === app.titleId)), 'reservas fora');
  const olise = feed.apps.find((app) => app.titleId === 'PPSA01153');
  assert.equal(olise.id, 'marice/oliseplayer');
  assert.equal(olise.release.tag, '02.001.000');
  assert.deepEqual(olise.sources, ['darkxex']);
  assert.equal(olise.category, 'media', 'music -> Video & music');
  assert.deepEqual(olise.files, [{ name: 'PPSA01153.zip', kind: 'app', url: 'https://github.com/Marice/OliSePlayer/releases/download/02.001.000/PPSA01153.zip', size: null, sha256: '3711b359f91fb572acd9385c4a027f5324da0d9d8734c382080073a2a7f68c7b', darkxex: 'PPSA01153', folder: 'PPSA01153' }]);
  assert.ok(olise.release.date > 1.7e12, 'data ISO lida sem o objeto Date');
  for (const app of feed.apps) {
    for (const file of app.files) assert.ok(file.url.toLowerCase().startsWith(`https://github.com/${app.repo.toLowerCase()}/releases/download/`), file.url);
    assert.match(app.files[0].sha256, /^[0-9a-f]{64}$/);
  }
  // O formato antigo (.ffpfsc, imagem) instala como imagem.
  assert.equal(feed.apps.find((app) => app.titleId === 'PPSA77711').files[0].kind, 'image');
  // Dois apps do mesmo repositorio: ids diferentes.
  const ids = feed.apps.map((app) => app.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.some((id) => id.startsWith('zizc3/infinity-blade-ps5#')));
});

test('retirados, reservas e registros quebrados nao aparecem; formato desconhecido aparece como nao suportado', () => {
  const good = JSON.parse(feedText).apps.find((app) => app.titleid === 'PPSA01153');
  assert.ok(dx.normalizeDarkxexApp(good));
  assert.equal(dx.normalizeDarkxexApp({ ...good, status: 'withdrawn' }), null, 'withdrawn');
  assert.equal(dx.normalizeDarkxexApp({ schema: 3, id: 'PPSA01153', titleid: 'PPSA01153', status: 'withdrawn' }), null, 'arquivo de retirado da API');
  assert.equal(dx.normalizeDarkxexApp({ ...good, status: 'coming_soon', artifact_url: null, sha256: null }), null, 'reserva');
  assert.equal(dx.normalizeDarkxexApp({ ...good, sha256: 'abc' }), null, 'sem sha256 valido');
  assert.equal(dx.normalizeDarkxexApp({ ...good, artifact_url: 'https://example.com/PPSA01153.zip' }), null, 'fora do release do proprio repositorio');
  assert.equal(dx.normalizeDarkxexApp({ ...good, artifact_url: 'https://github.com/someone/else/releases/download/v1/x.zip' }), null, 'release de outro repositorio');
  const odd = dx.normalizeDarkxexApp({ ...good, format: 'pkg', artifact_url: good.artifact_url.replace('.zip', '.pkg') });
  assert.deepEqual(odd.files, []);
  assert.equal(odd.unsupported, 'pkg');
  // Um feed com um app retirado no meio: so os disponiveis.
  const doc = JSON.parse(feedText);
  doc.apps[0] = { ...doc.apps[0], status: 'withdrawn' };
  const feed = dx.parseDarkxexFeed(JSON.stringify(doc));
  assert.ok(!feed.apps.some((app) => app.titleId === doc.apps[0].titleid));
  assert.equal(dx.parseDarkxexFeed('{"schema":2,"apps":[]}'), null, 'outro schema');
  assert.equal(dx.parseDarkxexFeed('<html>'), null);
});

// ---- Juntar ---------------------------------------------------------------------------------------------------------

test('juncao com a lista da Jobe: nenhum app duplicado, a fonte indicada, os novos entram', () => {
  const feed = dx.parseDarkxexFeed(feedText);
  const merged = dx.mergeCatalogs(shipped, feed.apps);
  const ids = merged.apps.map((app) => app.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unicos');
  assert.equal(merged.apps.length, shipped.apps.length + merged.stats.added);
  assert.equal(merged.stats.added + merged.stats.duplicates, feed.apps.length);
  // OliSe Player esta nas duas listas (mesmo repositorio): uma entrada so, das duas fontes.
  const olise = merged.apps.filter((app) => app.repo.toLowerCase() === 'marice/oliseplayer');
  assert.equal(olise.length, 1);
  assert.deepEqual(olise[0].sources, ['jobe', 'darkxex']);
  assert.equal(olise[0].titleId, 'PPSA01153');
  // So no darkxex: entra com a fonte darkxex.
  const subway = merged.apps.find((app) => app.titleId === 'PPSA26370');
  assert.deepEqual(subway.sources, ['darkxex']);
  // Mesmo title ID com nome parecido e outro repositorio (PS5MC -> "PS5MC (Kodi)"): o mesmo app.
  const kodi = merged.apps.filter((app) => app.titleId === 'PPSA99420' || app.repo.toLowerCase() === 'vivalavent/ps5mc');
  assert.equal(kodi.length, 1, 'PS5MC uma vez so');
  // Mesmo title ID com outro nome (Vita3K x Spider-Man: Edge of Time): os dois ficam e cada um avisa do outro.
  const vita = merged.apps.find((app) => app.repo.toLowerCase() === 'tsuramatsu1/vita3k-ps5');
  const spider = merged.apps.find((app) => app.titleId === 'PPSA99300' && app.sources?.[0] === 'darkxex');
  assert.ok(vita && spider);
  assert.deepEqual(vita.conflicts, ['Spider-Man: Edge of Time']);
  assert.deepEqual(spider.conflicts, ['Vita3K']);
  // A categoria do darkxex existe na lista.
  for (const app of merged.apps) assert.ok(merged.categories.some((c) => c.id === app.category), app.category);
  // Sem darkxex: a lista da Jobe como veio.
  assert.equal(dx.mergeCatalogs(shipped, []).apps.length, shipped.apps.length);
});

test('juncao: fica a versao mais nova; o mesmo arquivo nas duas ganha o sha256 do catalogo', () => {
  const base = { generated: 1, categories: [{ id: 'media', name: 'Video & music' }, { id: 'system', name: 'System tools' }], apps: [] };
  const jobe = (repo2, tag, file) => ({ id: repo2.toLowerCase(), repo: repo2, name: repo2.split('/')[1], author: 'x', category: 'media', description: 'da Jobe', about: 'sobre', stars: 40, license: 'MIT', icon: 'https://i/x.png', iconFromAvatar: false, logo: null, hero: 'https://i/h.png', shots: [], pushed: 1, release: { tag, title: tag, date: 1000, prerelease: false, notes: 'notas', url: null, downloads: 9 }, files: [{ name: file, kind: 'app', url: `https://github.com/${repo2}/releases/download/${tag}/${file}`, size: 10, folder: 'PPSA00001' }, { name: 'helper.elf', kind: 'payload', url: `https://github.com/${repo2}/releases/download/${tag}/helper.elf`, size: 5 }], note: null, with: ['helper.elf'], search: 'x' });
  const dark = (repo2, tag, file, titleid = 'PPSA00001', name = repo2.split('/')[1]) => dx.normalizeDarkxexApp({ titleid, name, kind: 'app', category: 'video', description: 'do darkxex', license: 'GPL-3.0', author: 'y', version: tag, source_repo: `https://github.com/${repo2}`, artifact_url: `https://github.com/${repo2}/releases/download/${tag}/${file}`, sha256: 'a'.repeat(64), icon_url: null, format: 'zip', updated: '2026-11-01T00:00:00Z' });
  // darkxex mais novo: o arquivo e o release dele; a arte e o texto da Jobe ficam; o ajudante do release velho sai.
  let merged = dx.mergeCatalogs({ ...base, apps: [jobe('a/one', 'v1.4.1', 'one.zip')] }, [dark('a/one', 'v1.6.0', 'one-1.6.zip')]);
  assert.equal(merged.apps.length, 1);
  assert.equal(merged.apps[0].release.tag, 'v1.6.0');
  assert.deepEqual(merged.apps[0].files.map((f) => [f.name, f.sha256]), [['one-1.6.zip', 'a'.repeat(64)]]);
  assert.deepEqual(merged.apps[0].with, []);
  assert.equal(merged.apps[0].hero, 'https://i/h.png');
  assert.equal(merged.apps[0].stars, 40);
  assert.equal(merged.stats.newer, 1);
  // Jobe mais nova: fica a da Jobe, inteira.
  merged = dx.mergeCatalogs({ ...base, apps: [jobe('a/one', 'v2.0', 'one.zip')] }, [dark('a/one', 'v1.6.0', 'one-1.6.zip')]);
  assert.equal(merged.apps[0].release.tag, 'v2.0');
  assert.deepEqual(merged.apps[0].files.map((f) => f.name), ['one.zip', 'helper.elf']);
  assert.ok(!merged.apps[0].files.some((f) => f.sha256));
  assert.deepEqual(merged.apps[0].sources, ['jobe', 'darkxex']);
  // O mesmo arquivo: o da Jobe, com o sha256 do catalogo.
  merged = dx.mergeCatalogs({ ...base, apps: [jobe('a/one', 'v1.6.0', 'one.zip')] }, [dark('a/one', 'v1.6.0', 'one.zip')]);
  assert.equal(merged.apps[0].files[0].sha256, 'a'.repeat(64));
  assert.equal(merged.apps[0].files[0].darkxex, 'PPSA00001');
  assert.equal(merged.apps[0].files[1].sha256, undefined);
  // Versoes de verdade do cruzamento de 13/11.
  const newer = (a, b) => dx.compareVersions({ tag: a }, { tag: b }) > 0;
  assert.ok(newer('0.6.00', '0.5.20'));
  assert.ok(newer('v1.000.116', 'v1.000.107'));
  assert.ok(newer('vk-285-190', 'vk-285-177'));
  assert.ok(newer('v1.0.0.22-native-experimental', 'v1.0.0-native-experimental'));
  assert.ok(newer('v3.5', 'Alpha-2.1'));
  assert.ok(!newer('v1.9', 'v1.9.1'));
  assert.equal(dx.compareVersions({ tag: 'beta', date: 5 }, { tag: 'alpha', date: 3 }) > 0, true, 'sem numeros: pela data');
});

// ---- Assinatura ----------------------------------------------------------------------------------------------------

test('manifesto assinado real: confere com a chave do catalogo; um byte trocado ou sequencia menor recusa', () => {
  const ok = dx.verifyManifest(manifestBytes, signatureBytes);
  assert.equal(ok.ok, true);
  assert.equal(ok.manifest.sequence, 1128);
  const tampered = manifestBytes.slice();
  tampered[20] ^= 1;
  assert.deepEqual(dx.verifyManifest(tampered, signatureBytes), { ok: false, reason: 'signature' });
  assert.deepEqual(dx.verifyManifest(manifestBytes, signatureBytes.slice(0, 63)), { ok: false, reason: 'signature' });
  assert.deepEqual(dx.verifyManifest(manifestBytes, signatureBytes, { keys: ['00'.repeat(32)] }), { ok: false, reason: 'signature' });
  assert.deepEqual(dx.verifyManifest(manifestBytes, signatureBytes, { minSequence: 1129 }), { ok: false, reason: 'rollback' });
  // O arquivo do app pelo sha256 do manifesto.
  const app = dx.verifyAppFile(ok.manifest, 'apps/PPSA01153.json', [...fixture('apps-PPSA01153.json')]);
  assert.equal(app.ok, true);
  assert.equal(app.app.files[0].sha256, '3711b359f91fb572acd9385c4a027f5324da0d9d8734c382080073a2a7f68c7b');
  const changed = [...fixture('apps-PPSA01153.json')];
  changed[changed.length - 3] ^= 1;
  assert.deepEqual(dx.verifyAppFile(ok.manifest, 'apps/PPSA01153.json', changed), { ok: false, reason: 'hash' });
  assert.deepEqual(dx.verifyAppFile(ok.manifest, 'apps/PPSA00000.json', changed), { ok: false, reason: 'unlisted' });
});

// O Http.request do runtime com as respostas dos arquivos reais (binary: um caractere por byte).
function apiServer(overrides = {}) {
  const files = {
    'manifest.json': fixture('manifest.json'),
    'manifest.sig': Buffer.from(fixture('manifest.sig.hex').toString('utf8').trim(), 'hex'),
    'apps/PPSA01153.json': fixture('apps-PPSA01153.json'),
    'apps/PPSA99309.json': fixture('apps-PPSA99309.json'),
    'apps/PPSA99309-mgoodings.json': fixture('apps-PPSA99309-mgoodings.json'),
    ...overrides,
  };
  const asked = [];
  const get = async (url, options) => {
    const name = url.slice(dx.API_URL.length);
    asked.push(name);
    assert.equal(options.binary, true);
    const body = files[name];
    if (!body) return { ok: false, status: 404 };
    return { ok: true, status: 200, bytes: async () => body.toString('latin1') };
  };
  return { get, asked };
}

test('conferencia na hora de instalar: acha o app certo pelo dono quando dois dividem o title ID', async () => {
  const api = apiServer();
  const signed = await dx.confirmDarkxexFile({ get: api.get, file: { darkxex: 'PPSA99309' }, repo: 'mgoodings/ProsperoWake' });
  assert.match(signed.url, /^https:\/\/github\.com\/mgoodings\/ProsperoWake\/releases\/download\//);
  assert.match(signed.sha256, /^[0-9a-f]{64}$/);
  assert.equal(signed.sequence, 1128);
  assert.deepEqual(api.asked, ['manifest.json', 'manifest.sig', 'apps/PPSA99309.json', 'apps/PPSA99309-mgoodings.json']);
  // Assinatura trocada: nada.
  const forged = apiServer({ 'manifest.sig': Buffer.alloc(64, 7) });
  await assert.rejects(dx.confirmDarkxexFile({ get: forged.get, file: { darkxex: 'PPSA01153' }, repo: 'Marice/OliSePlayer' }), (error) => error.reason === 'signature');
  // Arquivo do app que nao bate com o manifesto: nada.
  const swapped = apiServer({ 'apps/PPSA01153.json': fixture('apps-PPSA99309.json') });
  await assert.rejects(dx.confirmDarkxexFile({ get: swapped.get, file: { darkxex: 'PPSA01153' }, repo: 'Marice/OliSePlayer' }), (error) => error.reason === 'hash');
  // Fora do manifesto (retirado): nada.
  await assert.rejects(dx.confirmDarkxexFile({ get: api.get, file: { darkxex: 'PPSA00001' }, repo: 'a/b' }), (error) => error.reason === 'gone');
});

// ---- Instalar e a chave -------------------------------------------------------------------------------------------

function memoryFs() {
  const files = new Map();
  const dirs = new Set(['/']);
  const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const addDirs = (p) => { for (let d = parent(p); d && !dirs.has(d); d = parent(d)) dirs.add(d); };
  const under = (p) => [...files.keys(), ...dirs].filter((q) => q.startsWith(`${p}/`));
  return {
    files,
    exists: (p) => files.has(p) || dirs.has(p),
    stat: (p) => files.has(p) ? { isFile: true, isDirectory: false } : dirs.has(p) ? { isFile: false, isDirectory: true } : null,
    readFile: (p) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
    writeFile: (p, text) => { addDirs(p); files.set(p, text); },
    mkdir: (p) => { dirs.add(p); addDirs(p); },
    remove: (p) => { files.delete(p); dirs.delete(p); },
    removeTree: (p) => { for (const q of under(p)) { files.delete(q); dirs.delete(q); } files.delete(p); dirs.delete(p); },
    rename: (from, to) => {
      if (files.has(from)) { files.set(to, files.get(from)); files.delete(from); addDirs(to); return; }
      for (const q of under(from)) { const moved = to + q.slice(from.length); if (files.has(q)) { files.set(moved, files.get(q)); files.delete(q); } else { dirs.delete(q); dirs.add(moved); } }
      dirs.delete(from); dirs.add(to); addDirs(to);
    },
    readDir: (p) => [...new Set([...files.keys(), ...dirs].filter((q) => parent(q) === p && q !== p))].map((q) => ({ name: q.slice(p.length + 1), isDirectory: dirs.has(q), isFile: files.has(q) })),
    chmod: () => {},
  };
}

// Um console com a lista da Jobe embutida, o feed do darkxex na rede e downloads que conferem o sha256 como o nativo.
function setup({ on = true, realSha = null, confirm = undefined } = {}) {
  const fs = memoryFs();
  const enqueued = [];
  const requests = [];
  let darkxexOn = on;
  const downloads = {
    enqueue(options) {
      enqueued.push(options);
      const fail = options.sha256 && realSha && options.sha256 !== realSha;
      if (!fail) fs.writeFile(options.destination, `bytes of ${options.url}`);
      return { done: fail ? Promise.reject(new Error('Downloads.enqueue: SHA-256 mismatch')) : Promise.resolve({}), cancel() {}, subscribe: (listener) => (listener({ state: 'completed', written: 10, total: 10 }), () => {}) };
    },
  };
  const archives = {
    extract({ destination }) {
      fs.writeFile(`${destination}/PPSA01153/eboot.bin`, 'elf');
      fs.writeFile(`${destination}/PPSA01153/sce_sys/param.json`, JSON.stringify({ titleId: 'PPSA01153' }));
      return { done: Promise.resolve({}), cancel() {} };
    },
  };
  const http = {
    async request(url) {
      requests.push(url);
      if (url === dx.FEED_URL) return { ok: true, status: 200, text: async () => feedText };
      return { ok: false, status: 404, text: async () => '' };
    },
  };
  const signedOlise = { url: 'https://github.com/Marice/OliSePlayer/releases/download/02.001.000/PPSA01153.zip', name: 'PPSA01153.zip', sha256: '3711b359f91fb572acd9385c4a027f5324da0d9d8734c382080073a2a7f68c7b', size: 12456020, sequence: 1128 };
  const store = createHomebrew({
    fs, http, downloads, archives, dataDir: '/data/jl', payloadDir: '/data/payloads', roots: () => ['/data'],
    readBundled: () => JSON.stringify({ version: 1, generated: 5, categories: [{ id: 'media', name: 'Video & music' }, { id: 'system', name: 'System tools' }], apps: [{ repo: 'other/app', name: 'Other', category: 'system', release: { tag: 'v1' }, files: [{ name: 'o.elf', kind: 'payload', url: 'https://github.com/other/app/releases/download/v1/o.elf', size: 4096 }] }] }),
    defer: () => {}, log: () => {}, now: () => 1e12,
    darkxexOn: () => darkxexOn,
    darkxexConfirm: confirm === undefined ? async () => signedOlise : confirm,
  });
  return { store, fs, enqueued, requests, setOn: (value) => { darkxexOn = value; } };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('chave ligada: a lista busca o feed e junta; chave desligada: nada do darkxex, nem pedido', async () => {
  const off = setup({ on: false });
  await off.store.refresh();
  assert.ok(!off.requests.includes(dx.FEED_URL), 'desligada nao pede o feed');
  assert.equal(off.store.index.apps.length, 1);
  assert.equal(off.store.index.darkxex, null);
  const on = setup();
  assert.equal(on.store.index.apps.length, 1, 'antes de buscar, so a lista da Jobe');
  assert.equal(await on.store.refresh(), true);
  assert.ok(on.requests.includes(dx.FEED_URL));
  assert.ok(on.store.app('marice/oliseplayer'));
  assert.ok(on.store.index.darkxex.added > 0);
  assert.ok(on.fs.exists('/data/jl/homebrew-darkxex.json'), 'copia guardada');
  // Desligar na hora tira os apps; religar volta da copia guardada, sem pedir de novo.
  on.setOn(false);
  await on.store.darkxexChanged();
  assert.equal(on.store.app('marice/oliseplayer'), null);
  const asked = on.requests.length;
  on.setOn(true);
  await on.store.darkxexChanged();
  assert.ok(on.store.app('marice/oliseplayer'));
  assert.equal(on.requests.length, asked, 'usou a copia');
  // Outra abertura: a copia guardada ja aparece; o feed nao e pedido de novo antes de 30 min.
  const again = createHomebrew({ fs: on.fs, http: { request: async (url) => { throw new Error(`nao devia pedir ${url}`); } }, downloads: {}, archives: {}, dataDir: '/data/jl', payloadDir: '/data/payloads', roots: () => ['/data'], readBundled: () => null, defer: () => {}, log: () => {}, now: () => 1e12 + 60e3, darkxexOn: () => true });
  assert.ok(again.app('marice/oliseplayer'));
});

test('instalar do darkxex: confere a assinatura, baixa com o sha256 assinado e instala a pasta pelo title ID', async () => {
  const { store, enqueued, fs } = setup({ realSha: '3711b359f91fb572acd9385c4a027f5324da0d9d8734c382080073a2a7f68c7b' });
  await store.refresh();
  store.install('marice/oliseplayer');
  await settle();
  assert.equal(store.statusOf('marice/oliseplayer').failed, '');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].sha256, '3711b359f91fb572acd9385c4a027f5324da0d9d8734c382080073a2a7f68c7b');
  assert.equal(enqueued[0].rejectHtml, true);
  assert.ok(fs.exists('/data/homebrew/PPSA01153/eboot.bin'));
  assert.equal(store.statusOf('marice/oliseplayer').installed, true);
});

test('sha256 errado: o download e recusado e nada e instalado', async () => {
  const { store, fs } = setup({ realSha: 'b'.repeat(64) });
  await store.refresh();
  store.install('marice/oliseplayer');
  await settle();
  const status = store.statusOf('marice/oliseplayer');
  assert.match(status.failed, /SHA-256 mismatch/);
  assert.equal(status.installed, false);
  assert.ok(!fs.exists('/data/homebrew/PPSA01153'));
});

test('assinatura que nao confere ou sem conferencia: nada e baixado', async () => {
  const bad = setup({ confirm: async () => { throw Object.assign(new Error('darkxex: signature'), { reason: 'signature' }); } });
  await bad.store.refresh();
  bad.store.install('marice/oliseplayer');
  await settle();
  assert.match(bad.store.statusOf('marice/oliseplayer').failed, /signature did not check out/);
  assert.equal(bad.enqueued.length, 0);
  const none = setup({ confirm: null });
  await none.store.refresh();
  none.store.install('marice/oliseplayer');
  await settle();
  assert.match(none.store.statusOf('marice/oliseplayer').failed, /Could not check/);
  assert.equal(none.enqueued.length, 0);
});
