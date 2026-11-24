// glibren.76: catalogo escondido (Configuracoes > Feeds, "Mostrar na loja") esconde tambem os LINKS dele. A paridade com o
// payload e o caso "so a Orbit" (o embutido escondido) ficam em tests/fase3-nucleo.test.mjs (variante orbit); aqui, o
// que o app faz sozinho: game.releases sem os links escondidos, game.allReleases com todos (a fila de downloads), e a
// ficha que continua com o link de um download que ja esta na fila.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);

test('glibren.76: a ficha fica com os links mostrados e, no fim, o de um download que ja esta na fila', async () => {
  const { withQueued } = await load('app/game/releases.js');
  const orbit = { id: 'feed-e9c4e35ff1e70db3-PPSA00001-aa', url: 'https://a.example/1' };
  const bundled = { id: 'pegasus-0-PPSA00001-1', url: 'https://b.example/1' };
  const game = { id: 'PPSA00001', releases: [orbit], allReleases: [bundled, orbit] };
  assert.deepEqual(withQueued(game, []), [orbit], 'sem download na fila: so os mostrados');
  assert.deepEqual(withQueued(game, [{ gameId: 'PPSA00002', release: { id: bundled.id } }]), [orbit], 'o download de outro jogo nao conta');
  assert.deepEqual(withQueued(game, [{ gameId: 'PPSA00001', release: { id: bundled.id } }]), [orbit, bundled], 'o link do job continua na ficha');
  assert.deepEqual(withQueued(game, [{ gameId: 'PPSA00001', requestedId: `${bundled.id}~torbox`, release: { id: 'x' } }]), [orbit, bundled], 'tambem pelo TorBox');
  const same = [orbit];
  assert.equal(withQueued({ id: 'PPSA00001', releases: same, allReleases: same }, [{ gameId: 'PPSA00001', release: { id: bundled.id } }]), same, 'nada escondido: a mesma lista');
  assert.deepEqual(withQueued({ id: 'PPSA00001', releases: same }, []), same, 'jogo do payload (sem allReleases)');
});

test('glibren.76: um feed escondido nao tira links do embutido; game.allReleases tem todos; a fila le todos', async () => {
  const { games } = await load('app/data/catalog-index.js');
  const catalog = await load('app/state/catalog.js');
  globalThis.__stubFiles = new Map();
  const mode = await load('app/state/store-mode.js');
  const game = games.find((item) => { try { return item.releases.length > 0; } catch { return false; } });
  assert.ok(game, 'um jogo do embutido com links');
  const before = game.releases.map((release) => release.id);
  assert.ok(before.length && before.every((id) => !id.startsWith('feed-')), 'links do embutido');
  const feed = 'https://feeds.example/other.json';
  assert.deepEqual(mode.setSourceShown(feed, false), { ok: true, reason: '' });
  try {
    assert.deepEqual(game.releases.map((release) => release.id), before, 'o feed escondido nao tira os do embutido');
    assert.deepEqual(game.allReleases.map((release) => release.id), before);
    assert.ok(catalog.getGame(game.id) === game);
  } finally {
    assert.deepEqual(mode.setSourceShown(feed, true), { ok: true, reason: '' });
    delete globalThis.__stubFiles;
  }
  // sem nada escondido, os dois sao a mesma lista (o mesmo cache)
  assert.equal(game.allReleases, game.releases);
});

test('glibren.76: o filtro dos links pelo catalogo de origem (id "feed-<chave do feed>-...")', async () => {
  const { stableKey } = await load('app/state/feed-format.js');
  const { createReleaseCache } = await load('app/state/release-cache.js');
  // o cache esquece o que guardou (clear): os links filtrados saem quando um catalogo e escondido ou mostrado
  let reads = 0;
  const cache = createReleaseCache(() => { reads++; return '[]'; });
  const extra = [{ id: `feed-${stableKey('/data/JobeesLair/orbit/orbit-store.json')}-PPSA00001-1`, url: 'https://a.example/1', label: 'x', format: 'exfat', filename: 'x.exfat' }];
  cache('data/releases/PPSA00001.json', extra);
  cache('data/releases/PPSA00001.json', extra);
  assert.equal(reads, 1);
  cache.clear();
  cache('data/releases/PPSA00001.json', extra);
  assert.equal(reads, 2);
});
