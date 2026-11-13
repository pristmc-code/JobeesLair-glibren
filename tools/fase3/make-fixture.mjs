// Fase 3: gera o fixture pequeno do teste de paridade (tests/fixtures/fase3), uma vez, a partir dos dados reais de
// /root/fase3-data (o live.jlx e a lista Orbit de 13/11/2026) e de jogos inventados que pegam as regras miudas: titulo
// com acento decomposto (NFC), sigma final, I com ponto, minusculas, ™, conjuntos em partes, magnet, links de host,
// "backport files", id repetido, um jogo do embutido com links novos, notas, "addedAt" recente, a lista Pegasus
// ("packages", com codigo repetido e partes) e um arquivo do PS5.
// Run (WSL): node tools/fase3/make-fixture.mjs [/root/fase3-data]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
// --full <pasta>: os arquivos reais inteiros (o catalogo ao vivo e a lista Orbit completos) com os mesmos feeds inventados.
const full = process.argv.indexOf('--full');
const src = (full >= 0 ? process.argv[full + 2] : process.argv[2]) || '/root/fase3-data';
const out = full >= 0 ? process.argv[full + 1] : path.join(repo, 'tests/fixtures/fase3');
mkdirSync(out, { recursive: true });
const { decodeJlx, encodeJlx } = await import(path.join(repo, 'app/state/jlx.js'));
const index = JSON.parse(readFileSync(path.join(repo, 'app/data/catalog/index.json'), 'utf8'));
const bundled = new Set([...index.games, ...index.twins].map((game) => game.id));

// O catalogo ao vivo: 70 jogos (os primeiros e os que tem partes, magnet ou varios hosts) e as notas deles e de 300 outros.
const live = JSON.parse(decodeJlx(readFileSync(path.join(src, 'live.jlx'), 'utf8')));
const pick = new Set();
for (const game of live.games.slice(0, full >= 0 ? Infinity : 45)) pick.add(game.id);
for (const game of live.games) {
  if (pick.size >= 70 && full < 0) break;
  const text = JSON.stringify(game.releases ?? []);
  if (/part\s*\d|magnet:|mediafire|vikingfile|datanodes|backport/i.test(text)) pick.add(game.id);
}
const ratings = {};
let kept = 0;
for (const [id, pair] of Object.entries(live.ratings ?? {})) if (full >= 0 || pick.has(id) || bundled.has(id) && kept++ < 300) ratings[id] = pair;
const liveOut = { version: 1, name: live.name, source: live.source, ratings, games: live.games.filter((game) => pick.has(game.id)) };
writeFileSync(path.join(out, 'live.jlx'), `${encodeJlx(liveOut)}\n`);

// A lista Orbit: 90 jogos, metade que o embutido ja tem (entram so com os links) e metade nova.
const orbit = JSON.parse(readFileSync(path.join(src, 'run/orbit/orbit-store.json'), 'utf8'));
const known = orbit.games.filter((game) => bundled.has(game.id)).slice(0, full >= 0 ? Infinity : 45);
const fresh = orbit.games.filter((game) => !bundled.has(game.id) && (full >= 0 || !pick.has(game.id))).slice(0, full >= 0 ? Infinity : 45);
writeFileSync(path.join(out, 'orbit-store.jlx'), encodeJlx(full >= 0 ? orbit : { ...orbit, games: [...known, ...fresh] }));
writeFileSync(path.join(out, 'orbit-known.txt'), `${[...bundled].sort().slice(0, 50).join('\n')}\n`);

// Uma lista do jogador na web (formato da Jobe).
const any = index.games.find((game) => game.platform === index.names.platform.indexOf('ps5'));
const rel = (url, extra = {}) => ({ url, ...extra });
const web = {
  version: 1,
  name: 'Fixture da Fase 3',
  mirrors: ['https://mirror.example/fase3.json'],
  ratings: { PPSA90001: [4.6, 1200], PPSA90004: [3.9, 250], CUSA90003: [4.1, 90] },
  games: [
    { id: 'PPSA90001', title: 'Pokémon Fixture Edition', developer: 'Game Freak', publisher: 'Nintendo', releaseDate: '2025-02-01', addedAt: '2026-11-10',
      genres: ['Role Playing Game (RPG) / Adventure', 'Action'], features: ['Online Multiplayer'], recommendations: 900, metacritic: 81, sizeGb: 30,
      art: { cover: 'https://image.api.playstation.com/vulcan/ap/rnd/1/a.png?w=384&thumb=false', hero: 'https://example.com/hero1.jpg', tint: '#112233', coverFallbacks: ['https://image.api.playstation.com/x.png?w=384'] },
      about: ['A long enough paragraph about this invented game, with lower case letters so it counts as the summary of the page.'], summary: 'A long enough', shots: ['https://example.com/s1.jpg', 'ftp://bad'],
      releases: [
        rel('https://example.com/files/Pokemon.Fixture.part1.rar', { label: 'USA Base (v01.00) part 1', provider: 'example', sizeBytes: 1000000000 }),
        rel('https://example.com/files/Pokemon.Fixture.part2.rar', { label: 'USA Base (v01.00) part 2', provider: 'example', sizeBytes: 500000000 }),
        rel('https://archive.org/download/fix/Pokemon.exfat', { label: 'EUR exFAT image', format: 'exfat', sizeBytes: 31000000000, sha256: 'A'.repeat(64) }),
        rel('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Pokemon+Fixture.rar', { label: 'Torrent pack' }),
        rel('https://example.com/files/Pokemon.Fixture.Backport.Files.rar', { label: 'Backport files 4.xx' }),
      ] },
    { id: 'PPSA90002', title: 'ΣΟΦΟΣ Ο ΘΕΟΣ', developer: 'Αθήνα', publisher: 'ΣΣ', releaseDate: '2024-06-01', genres: ['Simulator'], recommendations: 10,
      releases: [rel('https://www.mediafire.com/file/abc/sofos.zip', { label: 'Mediafire' }), rel('https://download123.mediafire.com/abc/sofos.zip', { label: 'Mediafire direct' })] },
    { id: 'CUSA90003', title: 'İstanbul Racer', platform: 'ps4', releaseDate: '2019-01-01', genres: ['Driving/Racing'], recommendations: 50,
      releases: [rel('https://vikingfile.com/d/abc123/Istanbul.pkg', { label: 'Vikingfile PKG' }), rel('https://datanodes.to/xyz/Istanbul.pkg', { label: 'DataNodes' })] },
    { id: 'PPSA90004', title: 'art of rally fixture', releaseDate: '2023-03-03', addedAt: '2026-11-12', genres: ['Racing'], recommendations: 3000,
      art: { hero: 'https://example.com/hero4.jpg' },
      releases: [rel('https://example.com/rally-folder-dump.7z', { label: 'Folder dump', sizeBytes: 12345678901 }), rel('https://example.com/rally.ffpkg', { browserUrl: 'https://page.example/rally' })] },
    { id: 'PPSA90005', title: 'Fixture™ Deluxe PS5', releaseDate: '2022-12-12', genres: ['Shooter'], recommendations: 'not a number',
      releases: [rel('https://example.com/fix5.pkg', { format: 'fpkg', label: 'FPKG 11.xx' }), rel('not a url'), rel('https://example.com/a part 0.rar', { label: 'Set part 0' })] },
    { id: 'PPSA90001', title: 'Duplicado (o primeiro vale)', releases: [rel('https://example.com/dup.exfat')] },
    { id: any.id, title: 'Ja no embutido', releases: [rel('https://cdn.overdrive.example/files/known.exfat', { provider: 'Overdrive CDN', label: 'Overdrive CDN exFAT' })] },
    { id: 'XXXX00000', title: 'codigo invalido', releases: [rel('https://example.com/x.exfat')] },
  ],
};
writeFileSync(path.join(out, 'feed-web.jlx'), `${encodeJlx(web)}\n`);

// Uma lista Pegasus ("packages"): codigo repetido junta os links; partes viram um conjunto; fpkg e dlc.
const pegasus = {
  name: 'Pegasus Fixture',
  packages: [
    { titleId: 'PPSA90010', title: 'Pegasus Game', version: '01.002', description: '<p>First line &amp; more.</p><p>Second line</p><br/>Third', posterUrl: 'https://example.com/p.jpg',
      downloadLinks: [
        { name: 'EUR 12.xx Base - Akirabox part 1', url: 'https://akirabox.com/a1', details: { buildKey: 'base', hostLabel: 'AkiraBox' } },
        { name: 'EUR 12.xx Base - Akirabox part 2', url: 'https://akirabox.com/a2', details: { buildKey: 'base', hostLabel: 'AkiraBox' } },
        { url: 'https://vikingfile.com/f/xyz', details: { buildKey: 'FPKG', hostLabel: 'VikingFile' } },
      ] },
    { titleId: 'ppsa90010', title: 'Pegasus Game (USA)', description: 'Other region',
      downloadLinks: [{ name: 'USA DLC pack', url: 'https://akirabox.com/d1', details: { buildKey: 'dlc', hostLabel: 'AkiraBox' } }, { name: 'dup', url: 'https://akirabox.com/a1' }] },
    { titleId: 'CUSA90011', title: 'Pegasus PS4', originalPosterUrl: 'https://example.com/o.jpg', downloadLinks: [{ name: 'Base - 1fichier', url: 'https://1fichier.com/?abc' }] },
    { titleId: 'PPSA90012', title: 'Sem links', downloadLinks: 'nao e lista' },
  ],
};
writeFileSync(path.join(out, 'feed-pegasus.jlx'), `${encodeJlx(pegasus)}\n`);

// Um arquivo do PS5 (feed da Jobe).
const local = {
  version: 1,
  games: [
    { id: 'PPSA90020', title: 'Local Game', genres: ['Puzzle'], releaseDate: '2021-05-05', releases: [rel('https://github.com/a/b/releases/download/v1/local.exfat', { sizeBytes: 2000000000 })] },
    { id: 'CUSA90021', title: 'Zebra local', releases: [rel('https://example.com/z.pkg')] },
  ],
};
writeFileSync(path.join(out, 'feed-local.json'), JSON.stringify(local, null, 1));
console.log(`fixture: live ${liveOut.games.length} jogos, orbit ${known.length + fresh.length}, web ${web.games.length}, pegasus ${pegasus.packages.length}, local ${local.games.length}`);
