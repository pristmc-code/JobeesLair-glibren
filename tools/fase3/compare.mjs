// Fase 3 (prototipo): sobe um nucleo (A ou B), confere /api/catalog contra a referencia do app (reference.json) e mede.
// Run: node tools/fase3/compare.mjs <reference.json> <porta> <comando> [args...]
// Confere: as opcoes de cada filtro (na ordem), a lista inteira de cada consulta (todas as paginas) e os campos de cada
// jogo listado (formatos, direto, tamanho, nota). Mede: montagem (o que o nucleo diz), RSS/pico, tempo por pagina.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [refFile, portText, command, ...args] = process.argv.slice(2);
const ref = JSON.parse(readFileSync(refFile, 'utf8'));
const port = Number(portText);
const base = `http://127.0.0.1:${port}`;
const started = performance.now();
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
const ready = new Promise((resolve, reject) => {
  child.stdout.on('data', (chunk) => { out += chunk; if (/^LISTEN /m.test(out)) resolve(); });
  child.on('exit', (code) => reject(new Error(`o nucleo saiu (${code}): ${out}`)));
});
await ready;
const upMs = performance.now() - started;
const get = async (path) => { const res = await fetch(base + path); if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`); return res.json(); };
const params = (query, extra) => new URLSearchParams(Object.entries({ ...query, ...extra }).filter(([key, value]) => key !== 'name' && value !== undefined && value !== '')).toString();

const problems = [];
const options = await get('/api/catalog/options');
for (const [key, values] of Object.entries(ref.facets)) {
  const mine = options[key] ?? [];
  if (JSON.stringify(mine) !== JSON.stringify(values)) problems.push(`opcoes de ${key}: ${JSON.stringify(mine)} != ${JSON.stringify(values)}`);
}
async function all(query) {
  const ids = [];
  for (let page = 0; ; page++) {
    const body = await get(`/api/catalog?${params(query, { page, per: 500 })}`);
    ids.push(...body.games.map((game) => game.id));
    if (ids.length >= body.total || !body.games.length) return { ids, total: body.total };
  }
}
let same = 0;
for (const { query, ids } of ref.results) {
  const mine = await all(query);
  if (JSON.stringify(mine.ids) === JSON.stringify(ids) && mine.total === ids.length) { same++; continue; }
  const at = ids.findIndex((id, i) => mine.ids[i] !== id);
  problems.push(`${query.name}: ${mine.ids.length} x ${ids.length} jogos; 1a diferenca na posicao ${at}: ${mine.ids.slice(Math.max(0, at - 1), at + 3)} x ${ids.slice(Math.max(0, at - 1), at + 3)}`);
}
// Os campos de cada jogo listado (todas as copias: plataforma escolhida).
const every = [];
for (let page = 0; ; page++) {
  const body = await get(`/api/catalog?${params({ sort: 'title', platform: 'ps5,ps4' }, { page, per: 500 })}`);
  every.push(...body.games);
  if (every.length >= body.total || !body.games.length) break;
}
const byId = new Map(every.map((game) => [game.id, game]));
let fieldDiffs = 0;
for (const row of ref.games) {
  const [id, title, platform, formats, direct, sizeGb, stars, ratingCount] = row;
  const game = byId.get(id);
  if (!game) { if (fieldDiffs++ < 15) problems.push(`${id} falta`); continue; }
  const diffs = [];
  if (game.title !== title) diffs.push(`title ${JSON.stringify(game.title)} x ${JSON.stringify(title)}`);
  if (game.platform !== platform) diffs.push(`platform ${game.platform} x ${platform}`);
  if ([...game.formats].sort().join(' ') !== formats.split(' ').filter(Boolean).sort().join(' ')) diffs.push(`formats ${game.formats.join(' ')} x ${formats}`);
  if (Number(game.direct) !== direct) diffs.push(`direct ${game.direct} x ${direct}`);
  if ((game.sizeGb ?? null) !== sizeGb) diffs.push(`sizeGb ${game.sizeGb} x ${sizeGb}`);
  if ((game.stars ?? null) !== stars || (game.ratingCount ?? null) !== ratingCount) diffs.push(`nota ${game.stars}/${game.ratingCount} x ${stars}/${ratingCount}`);
  if (diffs.length && fieldDiffs++ < 15) problems.push(`${id}: ${diffs.join('; ')}`);
}
if (every.length !== ref.games.length) problems.push(`listados: ${every.length} x ${ref.games.length}`);
// Tempo por pagina (60 jogos), mediana de 30: a 1a pagina sem filtro, uma pagina funda, um filtro e uma busca.
const timing = {};
for (const [label, query] of Object.entries({
  'relevance p0': { sort: 'relevance', page: 0 },
  'title p30': { sort: 'title', page: 30 },
  'ps5+ready+Action rating': { sort: 'rating', platform: 'ps5', format: 'ready', genre: 'Action', page: 0 },
  'busca "the" newest': { sort: 'newest', q: 'the', page: 0 },
})) {
  // A 1a vez de uma consulta nova (pagina 1 de outra ordem antes, para nao pegar cache), depois a mediana de 30 iguais.
  const core = [], http = [];
  for (let i = 0; i < 31; i++) {
    const t0 = performance.now();
    const res = await fetch(`${base}/api/catalog?${params(query, { per: 60 })}`);
    await res.arrayBuffer();
    http.push(performance.now() - t0);
    core.push(Number(res.headers.get('x-took-ms')));
  }
  const median = (list) => { const sorted = list.slice(1).sort((a, b) => a - b); return Number(sorted[15].toFixed(2)); };
  timing[label] = { primeiraNucleoMs: Number(core[0].toFixed(2)), nucleoMs: median(core), comHttpMs: median(http) };
}
const stats = await get('/stats');
await fetch(`${base}/quit`).catch(() => {});
const built = /^BUILT (.*)$/m.exec(out)?.[1] ?? '';
console.log(JSON.stringify({ built, upMs: Math.round(upMs), stats, consultas: `${same}/${ref.results.length} iguais`, listados: every.length, timing, problems: problems.slice(0, 40), nProblems: problems.length }, null, 1));
process.exit(problems.length ? 1 : 0);
