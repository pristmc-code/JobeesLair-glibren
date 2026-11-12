// glibren (item 2 do plano de memoria): o retrato da loja e os links dos feeds no disco (app/state/feed-snapshot.js).
// A loja montada lendo os feeds e a loja montada do retrato na abertura seguinte dao os mesmos jogos, links, formatos,
// notas e estado dos feeds; um retrato de outra chave nao vale; um balde que some deixa so os links do embutido.
// Run: node --import ./tests/stub-loader.mjs --test tests/feed-snapshot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const { BUCKET, bucketReader, readSnapshot, writeSnapshot } = await import('../app/state/feed-snapshot.js');

test('os links vao em baldes na ordem dada e voltam iguais; outra chave nao vale', () => {
  globalThis.__stubFiles = new Map();
  try {
    const releases = new Map();
    const order = [];
    for (let i = 0; i < BUCKET * 2 + 5; i++) {
      const id = `PPSA${String(10000 + i)}`;
      order.push(id);
      if (i % 7) releases.set(id, [{ id: `r${i}`, url: `https://example.com/${i}.exfat`, filename: `${i}.exfat` }]);
    }
    const buckets = writeSnapshot('k1', { games: [{ game: { id: 'PPSA10001' }, page: { about: [] }, feed: 'f', extra: 'fora' }], states: [{ url: 'f' }], kinds: { PPSA10001: ['exfat'] }, releases, order });
    assert.ok(buckets && buckets.length === Math.ceil(releases.size / BUCKET));
    assert.deepEqual(buckets.flat(), order.filter((id) => releases.has(id)), 'na ordem dada, so os que tem links');
    const snap = readSnapshot('k1');
    assert.deepEqual(snap.games, [{ game: { id: 'PPSA10001' }, page: { about: [] }, feed: 'f' }]);
    assert.equal(readSnapshot('outra'), null);
    const read = bucketReader('k1', snap.buckets);
    for (const id of order) assert.deepEqual(read(id), releases.get(id) ?? []);
    // Um balde que some: o jogo fica sem os links de feed (e o log diz), o resto segue.
    globalThis.__stubFiles.delete([...globalThis.__stubFiles.keys()].find((name) => name.endsWith('/links-0.json')));
    const after = bucketReader('k1', snap.buckets);
    assert.deepEqual(after(order[1]), []);
    const last = [...releases.keys()].at(-1);
    assert.deepEqual(after(last), releases.get(last));
  } finally {
    globalThis.__stubFiles = undefined;
  }
});

test('um disco que nao guarda os baldes deixa os links na memoria (writeSnapshot -> null)', () => {
  globalThis.__stubFiles = { has: () => false, get: () => undefined, set() {} };
  try {
    assert.equal(writeSnapshot('k', { games: [], states: [], kinds: {}, releases: new Map([['PPSA10000', [{}]]]), order: ['PPSA10000'] }), null);
  } finally {
    globalThis.__stubFiles = undefined;
  }
});

// Duas aberturas do app (processos separados, os arquivos do console num JSON entre elas): a primeira le o feed e grava o
// retrato, a segunda monta do retrato.
const LIVE = 'https://raw.githubusercontent.com/JVK3R/JobeesLair/main/catalog/live.json';
const child = `import __fs from 'node:fs';
const files = new Map(JSON.parse(__fs.readFileSync(process.env.FILES, 'utf8')));
globalThis.__stubFiles = files;
const c = await import(${JSON.stringify(path.join(repo, 'app/state/catalog.js'))});
const f = await import(${JSON.stringify(path.join(repo, 'app/state/feeds.js'))});
const pick = (id) => { const g = c.getGame(id); return g && { title: g.title, formats: g.formats, providers: g.providers, direct: Boolean(g.direct), stars: g.stars ?? null, about: g.about, releases: g.releases.map((r) => [r.id, r.url ?? null, r.format, r.parts?.length ?? 0]) }; };
const out = { count: c.catalogEntries().length, ids: c.filterGames({ filters: c.NO_FILTERS, query: '', wishlist: [] }).map((g) => g.id),
  newGame: pick('PPSA99901'), known: pick(process.env.KNOWN), feeds: f.feedsSnapshot([${JSON.stringify(LIVE)}]).map(({ fetchedAt, ...rest }) => rest),
  index: f.feedIndexes(), snapshot: [...files.keys()].some((name) => name.endsWith('feed-store/snapshot.json')) };
__fs.writeFileSync(process.env.FILES, JSON.stringify([...files]));
console.log('RESULT' + JSON.stringify(out));
`;
test('a loja do retrato e igual a loja lida dos feeds (jogos, links, formatos, notas, estado dos feeds)', async () => {
  const { stableKey } = await import('../app/state/feed-format.js');
  const { games } = await import('../app/data/catalog-index.js');
  const known = games.find((game) => game.platform === 'ps5').id;
  const document = {
    version: 1, name: 'Ao vivo', ratings: { PPSA99901: [4.5, 1234] },
    games: [
      { id: 'PPSA99901', title: 'Jogo Novo', platform: 'ps5', developer: 'Estudio', genres: ['Action'], releaseDate: '2025-01-02', about: ['Um jogo novo de teste.'],
        releases: [{ url: 'https://archive.org/download/x/Jogo.exfat', filename: 'Jogo.exfat', sizeBytes: 5e9, label: 'Archive' },
          { url: 'https://example.com/Jogo.part1.rar', filename: 'Jogo.part1.rar', label: 'Host part 1' }, { url: 'https://example.com/Jogo.part2.rar', filename: 'Jogo.part2.rar', label: 'Host part 2' }] },
      { id: known, title: 'Conhecido', platform: 'ps5', releases: [{ url: 'https://archive.org/download/y/K.ffpkg', filename: 'K.ffpkg', sizeBytes: 3e9 }] },
    ],
  };
  const head = { url: LIVE, from: LIVE, hash: 'h1', etag: null, fetchedAt: '2026-11-11T00:00:00Z', name: 'Ao vivo', games: 2, skipped: 0, mirrors: [] };
  const cache = `${JSON.stringify(head).slice(0, -1)},"document":${JSON.stringify(document)}}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-snap-'));
  const filesPath = path.join(dir, 'files.json');
  writeFileSync(filesPath, JSON.stringify([[`/download0/JobeesLair/feeds/${stableKey(LIVE)}.json`, cache]]));
  const launch = () => {
    const run = spawnSync(process.execPath, ['--import', path.join(repo, 'tests/stub-loader.mjs'), '--input-type=module', '-e', child], { cwd: repo, encoding: 'utf8', env: { ...process.env, FILES: filesPath, KNOWN: known } });
    const line = run.stdout.split('\n').find((text) => text.startsWith('RESULT'));
    assert.ok(line, run.stderr.slice(-800));
    return JSON.parse(line.slice(6));
  };
  try {
    const first = launch();
    assert.ok(first.snapshot, 'a primeira abertura grava o retrato');
    assert.equal(first.newGame.title, 'Jogo Novo');
    assert.ok(first.newGame.releases.length === 2 && first.newGame.releases.some(([, , format, parts]) => format === 'archive-set' && parts === 2));
    assert.ok(first.known.releases.some(([, url]) => url === 'https://archive.org/download/y/K.ffpkg'));
    assert.equal(first.newGame.stars, 4.5);
    const second = launch();
    assert.deepEqual(second, first, 'a segunda abertura (do retrato) da a mesma loja');
    // O cache do feed muda (uma atualizacao): o retrato nao vale mais e a loja le o feed de novo.
    const files = new Map(JSON.parse(readFileSync(filesPath, 'utf8')));
    const changed = { ...document, games: [{ ...document.games[0], title: 'Jogo Renomeado' }] };
    files.set(`/download0/JobeesLair/feeds/${stableKey(LIVE)}.json`, `${JSON.stringify({ ...head, hash: 'h2', games: 1 }).slice(0, -1)},"document":${JSON.stringify(changed)}}`);
    writeFileSync(filesPath, JSON.stringify([...files]));
    // O stub nao da tamanho/hora dos arquivos (stat null): a chave muda pelo conteudo so com stat; aqui o retrato e
    // apagado para simular a troca de carimbo.
    for (const name of [...files.keys()]) if (name.includes('/feed-store/')) files.delete(name);
    writeFileSync(filesPath, JSON.stringify([...files]));
    const third = launch();
    assert.equal(third.newGame.title, 'Jogo Renomeado');
    assert.equal(third.known.releases.some(([, url]) => url === 'https://archive.org/download/y/K.ffpkg'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
