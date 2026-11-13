// glibren.47 (Fase 1, imagem menor): os links e as fichas dos jogos embutidos em dois arquivos-pacote
// (tools/catalog/data-pack.mjs, app/state/data-pack.js), lidos um item por vez por deslocamento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const tool = await load('tools/catalog/data-pack.mjs');
const { checkIndex, createDataPack } = await load('app/state/data-pack.js');
const { readJlx } = await load('app/state/jlx.js');

// Um "disco" de mentira: arquivos em memoria (Buffer), leitura inteira ou por trecho como o console.
function disk(files) {
  const reads = [];
  const read = (file, offset, length) => {
    reads.push([file, offset, length]);
    const bytes = files[file];
    if (bytes == null) throw new Error(`fs.readFile ${file}: No such file or directory`);
    if (offset === undefined) return bytes.toString('utf8');
    if (offset + length > bytes.length) throw new Error(`fs.readFile ${file}: range ${offset}+${length} passes the end of the file`);
    return bytes.subarray(offset, offset + length).toString('utf8');
  };
  const stat = (file) => (files[file] ? { size: files[file].length } : null);
  return { read, stat, reads };
}
const packOf = (items, name = 'releases') => {
  const lines = [];
  let at = 0;
  const parts = [];
  for (const [item, text] of items) {
    const bytes = Buffer.from(text);
    lines.push(`${item} ${at} ${bytes.length}\n`);
    parts.push(bytes);
    at += bytes.length;
  }
  return { idx: `JPK1 ${name} ${items.length} ${at}\n${lines.join('')}`, pack: Buffer.concat(parts) };
};
const fakePack = (idx, pack, name = 'releases') => {
  const files = { [`/p/${name}.idx`]: Buffer.from(idx), [`/p/${name}.pack`]: pack };
  const logs = [];
  const fs = disk(files);
  return { pack: createDataPack(name, { read: fs.read, stat: fs.stat, dir: '/p', log: (line) => logs.push(line) }), logs, reads: fs.reads, files };
};

test('data pack: app/data/packs/ is current with app/data/releases and app/data/pages (run tools/catalog/data-pack.mjs)', () => {
  const files = tool.packFiles();
  const dir = path.join(repo, tool.PACK_DIR);
  assert.deepEqual(readdirSync(dir).sort(), Object.keys(files).sort(), 'the same files, none left over');
  for (const [name, data] of Object.entries(files)) assert.ok(readFileSync(path.join(dir, name)).equals(Buffer.from(data)), name);
});

test('data pack: the image packages the packs, not the thousands of small files', () => {
  const app = JSON.parse(readFileSync(path.join(repo, 'app/app.json'), 'utf8'));
  assert.ok(app.resources.includes('data/packs'));
  assert.ok(!app.resources.includes('data/releases') && !app.resources.includes('data/pages'));
});

test('data pack: every bundled release and page reads back byte for byte, one item at a time', () => {
  for (const [name, rel] of Object.entries(tool.PACKS)) {
    const dir = path.join(repo, rel);
    const files = { [`/p/${name}.idx`]: Buffer.from(readFileSync(path.join(repo, tool.PACK_DIR, `${name}.idx`))), [`/p/${name}.pack`]: readFileSync(path.join(repo, tool.PACK_DIR, `${name}.pack`)) };
    const fs = disk(files);
    const pack = createDataPack(name, { read: fs.read, stat: fs.stat, dir: '/p', log: () => {} });
    const sources = readdirSync(dir).filter((file) => file.endsWith('.json'));
    assert.ok(sources.length > 2000, `${name}: ${sources.length} items`);
    for (const file of sources) assert.equal(pack.read(file.slice(0, -5)), readFileSync(path.join(dir, file), 'utf8'), `${name}/${file}`);
    assert.equal(pack.count(), sources.length);
    // O indice e lido uma vez; cada item e um trecho do pacote, nunca o pacote inteiro.
    assert.equal(fs.reads.filter(([file]) => file.endsWith('.idx')).length, 1);
    assert.ok(fs.reads.filter(([file]) => file.endsWith('.pack')).every(([, offset, length]) => Number.isInteger(offset) && length < 200000));
  }
});

test("data pack: the store reads each game's releases and page from the packs as it read the files", async () => {
  const catalog = await load('app/state/catalog.js');
  const { createReleaseCache } = await load('app/state/release-cache.js');
  // O caminho antigo (.46): um arquivo por jogo.
  const before = createReleaseCache((file) => readJlx(readFileSync(path.join(repo, 'app', file), 'utf8')));
  const games = [...catalog.catalogEntries()].map(({ game }) => game).filter((game) => !game.feedPage);
  let releases = 0;
  let pages = 0;
  for (const game of games.slice(0, 400)) {
    const id = encodeURIComponent(game.id);
    let old;
    try {
      old = before(`data/releases/${id}.json`);
    } catch {
      old = null;
    }
    if (old) {
      assert.deepEqual(JSON.parse(JSON.stringify(game.releases)).slice(0, old.length).map((r) => r.url), old.map((r) => r.url), game.id);
      releases++;
    }
    let page = null;
    try {
      page = JSON.parse(readFileSync(path.join(repo, 'app/data/pages', `${id}.json`), 'utf8'));
    } catch {}
    if (page) {
      assert.deepEqual(game.about, page.about, game.id);
      assert.deepEqual(game.shots, page.shots, game.id);
      assert.equal(game.shortDescription, page.summary);
      pages++;
    }
  }
  assert.ok(releases > 100 && pages > 100, `${releases} releases, ${pages} pages`);
});

test('data pack: an item the pack does not have is null; the store gives no releases and an empty page', async () => {
  const { pack } = fakePack(...Object.values(packOf([['CUSA00001', 'JLX1:a'], ['PPSA00002', 'JLX1:bb']])));
  assert.equal(pack.read('CUSA00001'), 'JLX1:a');
  assert.equal(pack.read('PPSA00002'), 'JLX1:bb');
  assert.equal(pack.read('PPSA00003'), null);
  // Um nome que e o comeco de outro nao acha o outro.
  assert.equal(pack.read('CUSA0000'), null);
  assert.equal(pack.read('PPSA00002 0'), null);
});

test('data pack: a corrupt index refuses the whole pack, once, and says why', () => {
  const good = packOf([['CUSA00001', 'JLX1:aaa'], ['CUSA00002', 'JLX1:bb'], ['PPSA00003', 'JLX1:c']]);
  const cases = {
    header: good.idx.replace('JPK1', 'JPK2'),
    name: good.idx.replace('JPK1 releases', 'JPK1 pages'),
    count: good.idx.replace('JPK1 releases 3', 'JPK1 releases 4'),
    total: good.idx.replace(/^(JPK1 releases 3 )\d+/, '$1999'),
    gap: good.idx.replace('CUSA00002 8 ', 'CUSA00002 9 '),
    overlap: good.idx.replace('CUSA00002 8 ', 'CUSA00002 7 '),
    line: good.idx.replace('CUSA00002 8 7', 'CUSA00002 8 x'),
    cut: good.idx.slice(0, -3),
    blank: good.idx.replace('CUSA00002', 'CUSA 00002'),
    binary: '\u0000\u0001garbage',
  };
  for (const [what, idx] of Object.entries(cases)) {
    const { pack, logs, reads } = fakePack(idx, good.pack);
    assert.throws(() => pack.read('CUSA00001'), /releases\.(idx|pack)/, what);
    assert.throws(() => pack.read('PPSA00003'), /releases\.(idx|pack)/, what);
    assert.equal(reads.filter(([file]) => file.endsWith('.idx')).length, 1, `${what}: read once`);
    assert.equal(logs.length, 1, `${what}: logged once`);
  }
  // O pacote no disco de outro tamanho que o indice diz.
  const short = fakePack(good.idx, good.pack.subarray(0, good.pack.length - 1));
  assert.throws(() => short.pack.read('CUSA00001'), /releases\.pack: \d+ bytes, the index says/);
  // Sem stat (tamanho desconhecido): o indice vale, e um trecho alem do fim do pacote falha na leitura.
  const files = { '/p/releases.idx': Buffer.from(good.idx), '/p/releases.pack': good.pack.subarray(0, good.pack.length - 1) };
  const fs = disk(files);
  const blind = createDataPack('releases', { read: fs.read, stat: () => null, dir: '/p', log: () => {} });
  assert.equal(blind.read('CUSA00001'), 'JLX1:aaa');
  assert.throws(() => blind.read('PPSA00003'), /passes the end/);
  // Sem indice nenhum.
  const none = createDataPack('releases', { read: disk({}).read, stat: () => null, dir: '/p', log: () => {} });
  assert.throws(() => none.read('CUSA00001'), /No such file/);
  assert.equal(checkIndex('JPK1 releases 0 0\n', 'releases').count, 0);
});

test('data pack: a corrupt pack leaves the store with feed releases and an empty page, never a crash', async () => {
  const { createReleaseCache } = await load('app/state/release-cache.js');
  const { createPageCache } = await load('app/state/page-cache.js');
  const { pack } = fakePack('JPK1 releases 9 9\nbroken\n', Buffer.from('x'));
  const item = (file) => {
    const text = pack.read(file.slice(file.lastIndexOf('/') + 1, -5));
    if (text === null) throw new Error('not in the pack');
    return text;
  };
  const releases = createReleaseCache((file) => readJlx(item(file)));
  const extra = [{ id: 'feed', provider: 'h', url: 'https://h.example/a.pkg', format: 'pkg', label: 'Feed' }];
  assert.deepEqual(releases('data/releases/PPSA01234.json', extra).map((release) => release.id), ['feed']);
  assert.throws(() => releases('data/releases/PPSA01235.json'));
  const pages = createPageCache((file) => item(file));
  assert.throws(() => pages('data/pages/PPSA01234.json'));
});

test('data pack: a page with accents and emoji reads back whole (offsets are bytes, not characters)', () => {
  const items = [['A', '{"about":["Ação é ótima 🎮"],"shots":[],"summary":"ü"}'], ['B', '{"about":["日本語"],"shots":[],"summary":""}'], ['C', '{"about":[],"shots":[],"summary":"ok"}']];
  const built = packOf(items, 'pages');
  const { pack } = fakePack(built.idx, built.pack, 'pages');
  for (const [item, text] of items) assert.equal(pack.read(item), text);
});
