// glibren.16: downloads em partes na Biblioteca TorBox, contra um TorBox falso. Um conjunto em partes do catálogo
// (release-sets.js releaseSets: release.parts) conta como confirmado só com TODAS as partes no TorBox (checkcached do
// webdl pelo MD5 do link de cada parte), e fica guardado como UM arquivo (via "webdl", release = o id do conjunto,
// parts = as partes); com algumas, o jogo fica "conhecido" (faltam N de M). A lista do payload leva o conjunto como
// uma opção, depois do arquivo único do mesmo formato; o "Procurar no TorBox" da ficha mostra uma linha só; e o
// "Baixar" (no PS5 ou pelo celular) põe na fila a release inteira, cada parte resolvida pelo TorBox.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const lib = await load('app/state/torbox-library.js');
const search = await load('app/state/torbox-search.js');
const { releaseSets } = await load('app/state/release-sets.js');
const { md5 } = await load('app/services/torbox.js');
const { queueLibraryRequest } = await load('app/state/phone-library.js');
const { setDefaultDrive } = await load('app/state/last-drive.js');

const GiB = 1024 ** 3;
// Os links das partes, como no catálogo (1fichier, "part N" no rótulo): releaseSets junta num conjunto "set-...".
const partLink = (game, n) => `https://1fichier.com/?${game}p${n}`;
const partsOf = (game, count, label = 'EUR 1.00 Base - 1fichier') => Array.from({ length: count }, (_, i) => ({
  id: `r${game}p${i + 1}`, format: 'binary', filename: `${game}-game-unknown-p${i + 1}.binary`, url: partLink(game, i + 1), browserUrl: partLink(game, i + 1),
  requiresBrowser: true, provider: '1fichier.com', flow: 'browser', label: `${label} part ${i + 1}`, volume: `part ${i + 1}`, record: `rec-${game}`
}));
const single = (game, name, format) => ({ id: `r${game}-one`, format, filename: name, url: `https://host.example/${game}/${name}`, provider: 'host.example', label: 'Single' });
const gameOf = (id, title, raw) => ({ id, title, platform: 'ps5', genres: ['Action'], formats: ['rar'], releases: releaseSets(raw) });
const entriesOf = (games) => games.map((game) => ({ game, sources: ['bundled'] }));
const setOf = (game) => game.releases.find((release) => release.parts);

// O TorBox falso: guarda os links de `held`, cada parte com o nome "<jogo>.partN.rar" (e um .txt do lado).
function fakeApi(held) {
  const calls = [];
  return {
    calls,
    async myList(kind) {
      calls.push({ kind: `myList ${kind}` });
      return [];
    },
    async cachedEntries(links) {
      calls.push({ kind: 'cachedEntries', links: [...links] });
      const found = new Map();
      for (const link of links) {
        const part = /\?(PPSA\d+)p(\d+)$/.exec(link);
        if (held.has(link) && part) found.set(link, { name: `${part[1]}.part${part[2]}.rar`, size: 15 * GiB, files: [{ id: 0, name: `${part[1]}/${part[1]}.part${part[2]}.rar`, size: 15 * GiB }, { id: 1, name: `${part[1]}/leia.txt`, size: 20 }] });
        else if (held.has(link)) found.set(link, { name: link.split('/').pop(), size: 40 * GiB, files: [{ id: 0, name: link.split('/').pop(), size: 40 * GiB }] });
      }
      return found;
    }
  };
}
function clock() {
  let at = 1_793_960_000_000;
  return { now: () => at, sleep: async (ms) => { at += ms; } };
}
const quiet = { pace: 400, rateWait: 61_000, chunk: 10, saveEvery: 0 };

test('glibren.16: uma release em 3 partes, todas no TorBox: o jogo é confirmado com UMA opção, "3 partes"', async () => {
  const game = gameOf('PPSA01001', 'Jogo Em Partes', partsOf('PPSA01001', 3));
  const set = setOf(game);
  assert.ok(set && set.parts.length === 3 && set.id.startsWith('set-'), 'o catálogo junta as 3 partes num conjunto');
  const api = fakeApi(new Set([1, 2, 3].map((n) => partLink('PPSA01001', n))));
  const { library, progress } = await lib.buildLibrary({ entries: entriesOf([game]), api, ...quiet, ...clock() });
  const torbox = library.games.PPSA01001.torbox;
  assert.equal(torbox.confirmed, true);
  assert.equal(progress.found, 1);
  assert.equal(torbox.files.length, 1, 'uma opção só pela release inteira (as partes não viram linhas soltas)');
  const [file] = torbox.files;
  assert.deepEqual(file, {
    name: 'PPSA01001 (3 partes)', size: 45 * GiB, format: 'rar', hash: md5(partLink('PPSA01001', 1)), release: set.id, via: 'webdl',
    parts: [1, 2, 3].map((n) => ({ hash: md5(partLink('PPSA01001', n)), name: `PPSA01001.part${n}.rar`, size: 15 * GiB }))
  });
  assert.equal(torbox.hash, md5(partLink('PPSA01001', 1)));
  assert.equal(torbox.known, undefined);
  // As partes vão todas no mesmo pedido de checkcached.
  const asked = api.calls.filter((call) => call.kind === 'cachedEntries');
  assert.deepEqual(asked.map((call) => call.links.length), [3]);
});

test('glibren.16: 2 de 3 partes no TorBox: não confirmado; "conhecido" com faltam 1 de 3 (diagnóstico)', async () => {
  const game = gameOf('PPSA01002', 'Jogo Faltando Parte', partsOf('PPSA01002', 3));
  const api = fakeApi(new Set([1, 3].map((n) => partLink('PPSA01002', n))));
  const { library, progress } = await lib.buildLibrary({ entries: entriesOf([game]), api, ...quiet, ...clock() });
  const torbox = library.games.PPSA01002.torbox;
  assert.equal(torbox.confirmed, false);
  assert.deepEqual(torbox.files, []);
  assert.equal(progress.found, 0);
  assert.equal(progress.known, 1);
  assert.equal(torbox.known.length, 1);
  assert.deepEqual([torbox.known[0].via, torbox.known[0].missing, torbox.known[0].total, torbox.known[0].release, torbox.known[0].parts.length, torbox.known[0].size], ['parts', 1, 3, setOf(game).id, 2, 30 * GiB]);
  const list = lib.exportList(library);
  assert.deepEqual(list.games, [], 'fora da lista do payload/celular e da loja TorBox');
});

test('glibren.16: arquivo único e conjunto do mesmo formato: os dois listados, o único primeiro (o recomendado); exFAT antes de tudo', async () => {
  const raw = [...partsOf('PPSA01003', 3), single('PPSA01003', 'Jogo.rar', 'rar')];
  const game = gameOf('PPSA01003', 'Jogo Misto', raw);
  const held = new Set([...[1, 2, 3].map((n) => partLink('PPSA01003', n)), 'https://host.example/PPSA01003/Jogo.rar']);
  const { library } = await lib.buildLibrary({ entries: entriesOf([game]), api: fakeApi(held), ...quiet, ...clock() });
  const torbox = library.games.PPSA01003.torbox;
  assert.deepEqual(torbox.files.map((file) => [file.name, file.format, Boolean(file.parts)]), [['Jogo.rar', 'rar', false], ['PPSA01003 (3 partes)', 'rar', true]], 'o único vence o conjunto no mesmo formato, mesmo menor');
  assert.equal(torbox.hash, md5('https://host.example/PPSA01003/Jogo.rar'));
  // Com um exFAT também: o exFAT primeiro (FORMAT_RANK), depois o .rar único, depois o conjunto.
  const withImage = gameOf('PPSA01004', 'Jogo Com Imagem', [...partsOf('PPSA01004', 2), single('PPSA01004', 'Jogo.exfat', 'exfat')]);
  const held2 = new Set([...[1, 2].map((n) => partLink('PPSA01004', n)), 'https://host.example/PPSA01004/Jogo.exfat']);
  const { library: second } = await lib.buildLibrary({ entries: entriesOf([withImage]), api: fakeApi(held2), ...quiet, ...clock() });
  assert.deepEqual(second.games.PPSA01004.torbox.files.map((file) => file.format), ['exfat', 'rar']);
});

test('glibren.16: as partes entram nos lotes (no máximo 50 links web por chamada) junto com os links únicos', async () => {
  // 20 jogos, cada um com 1 link único e um conjunto de 4 partes: 100 links em 2 chamadas de 50.
  const games = Array.from({ length: 20 }, (_, i) => {
    const id = `PPSA02${String(i).padStart(3, '0')}`;
    return gameOf(id, `Jogo Lote ${i}`, [...partsOf(id, 4), single(id, `Jogo${i}.exfat`, 'exfat')]);
  });
  const held = new Set(games.flatMap((game) => [1, 2, 3, 4].map((n) => partLink(game.id, n))));
  const api = fakeApi(held);
  const time = clock();
  const waits = [];
  const { progress } = await lib.buildLibrary({ entries: entriesOf(games), api, ...quiet, chunk: 20, now: time.now, sleep: async (ms) => { waits.push(ms); await time.sleep(ms); } });
  const batches = api.calls.filter((call) => call.kind === 'cachedEntries');
  assert.deepEqual(batches.map((call) => call.links.length), [50, 50]);
  assert.equal(progress.found, 20, 'todos pelo conjunto (os únicos não estão no TorBox)');
  assert.ok(waits.filter((ms) => ms > 0).every((ms) => ms <= 400), 'no ritmo (PACE_MS)');
});

test('glibren.16: a lista do payload (torbox-lista.json) e as fichas levam o conjunto como um arquivo com "parts"', async () => {
  const game = gameOf('PPSA01005', 'Jogo Lista', partsOf('PPSA01005', 3));
  const { library } = await lib.buildLibrary({ entries: entriesOf([game]), api: fakeApi(new Set([1, 2, 3].map((n) => partLink('PPSA01005', n)))), ...quiet, ...clock() });
  const files = new Map();
  const fs = { exists: (p) => files.has(p), readFile: (p) => files.get(p), writeFile: (p, text) => files.set(p, String(text)), mkdir() {}, rename: (a, b) => { files.set(b, files.get(a)); files.delete(a); } };
  const paths = lib.libraryPaths('/download0/JobeesLair', true);
  lib.writeList(fs, paths, library, Date.now(), () => game);
  const list = JSON.parse(files.get(paths.list));
  assert.equal(list.version, 1, 'o formato continua 1 (campo novo opcional)');
  const [entry] = list.games;
  assert.equal(entry.id, 'PPSA01005');
  assert.deepEqual(entry.files.map((file) => [file.name, file.format, file.via, file.release, file.parts.length, file.size]), [['PPSA01005 (3 partes)', 'rar', 'webdl', setOf(game).id, 3, 45 * GiB]]);
  assert.ok(!files.get(paths.list).includes('1fichier.com'), 'nenhum link na lista');
  assert.deepEqual([...lib.readConfirmedIds(fs, paths)], ['PPSA01005'], 'entra na loja TorBox');
  const details = JSON.parse(files.get(paths.details));
  assert.deepEqual(details.games.map((item) => item.id), ['PPSA01005']);
});

test('glibren.16: "Procurar no TorBox" (loja TorBox no PS5): o conjunto completo é uma linha "3 partes"; o "Baixar" põe a release inteira na fila', async () => {
  const game = gameOf('PPSA01006', 'Jogo Ficha', [...partsOf('PPSA01006', 3), ...partsOf('PPSA01006', 2, 'EUR 1.00 Base - Viking').map((r) => ({ ...r, id: `${r.id}v`, url: `${r.url}v`, browserUrl: `${r.browserUrl}v`, provider: 'VikingFile' }))]);
  const held = new Set([1, 2, 3].map((n) => partLink('PPSA01006', n)));
  const client = { ...fakeApi(held), searchTorrents: async () => [] };
  const { files, sources } = await search.searchTorBox(game, { api: client });
  assert.equal(sources.catalog.state, 'done');
  const sets = files.filter((file) => file.parts);
  assert.equal(sets.length, 1, 'só o conjunto que o TorBox tem inteiro (o de 2 partes não está lá)');
  const [row] = sets;
  assert.deepEqual([row.name, row.parts, row.format, row.type, row.piece, row.size, row.origin], ['PPSA01006 (3 partes)', 3, 'rar', 'RAR', false, 45 * GiB, 'catalog']);
  const queued = [];
  const queue = { enqueue(g, release, root, alternatives) { queued.push({ g, release, root, alternatives }); return `${g.id}/${release.id}`; } };
  search.downloadFile(queue, game, row, '/mnt/ext0');
  const [{ release }] = queued;
  const set = setOf(game) ;
  assert.equal(release.id, `${set.id}~torbox`);
  assert.equal(release.parts.length, 3);
  assert.deepEqual(release.parts.map((part) => [part.sources[0].url, part.sources[0].debrid]), [1, 2, 3].map((n) => [partLink('PPSA01006', n), { service: 'torbox' }]), 'cada parte resolvida pelo TorBox, como a fila faz com partes');
  assert.deepEqual(release.debrid, { service: 'torbox' });
});

test('glibren.16: pedido do celular de uma release em partes (via webdl, release = o conjunto): a fila recebe as partes pelo TorBox', () => {
  setDefaultDrive('/mnt/ext0');
  const game = gameOf('PPSA01007', 'Jogo Celular', partsOf('PPSA01007', 3));
  const set = setOf(game);
  const queued = [];
  const queue = { enqueue(g, release, root, alternatives) { queued.push({ g, release, root, alternatives }); return `${g.id}/${release.id}`; } };
  const request = { id: 'b1', hash: md5(partLink('PPSA01007', 1)), file: 'PPSA01007 (3 partes)', via: 'webdl', release: set.id, code: 'PPSA01007', platform: 'ps5', whole: false, title: 'Jogo Celular', size: 45 * GiB };
  const id = queueLibraryRequest(request, { queue, roots: ['/data', '/mnt/ext0'], getGame: (code) => code === 'PPSA01007' ? game : null });
  const [{ g, release, root }] = queued;
  assert.equal(g, game);
  assert.equal(root, '/mnt/ext0');
  assert.equal(id, `PPSA01007/${set.id}~torbox`);
  assert.deepEqual(release.parts.map((part) => [part.number, part.sources[0].url, part.sources[0].debrid?.service]), [1, 2, 3].map((n) => [n, partLink('PPSA01007', n), 'torbox']));
  assert.equal(release.format, 'archive-set', 'a fila trata como um conjunto (extração depois de todas as partes)');
  setDefaultDrive(null);
});
