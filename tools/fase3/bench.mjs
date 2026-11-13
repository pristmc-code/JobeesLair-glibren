// Fase 3 (prototipo): medicoes repetidas dos dois nucleos (mediana). Run: node tools/fase3/bench.mjs [vezes=5]
// Por nucleo: montagem (ms ate responder), RSS e pico (VmHWM) somados pela montagem, heap do JS (B), e o tempo do nucleo
// por pagina de 60: a 1a vez de 24 consultas diferentes (sem cache) e a pagina seguinte de cada uma.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const runs = Number(process.argv[2] ?? 5);
const app = '/root/forks/jobe-fase3/app';
const data = `${app}/data`;
const W = '/root/fase3-data';
const cores = {
  A: ['/root/fase3-data/bin/a_catalog', `${data}/catalog/index.json`, `${data}/formats.js`, `${data}/ratings.js`, '0', `${W}/live.jlx`, `${W}/run/orbit/orbit-store.json`],
  'B fria (sem retrato)': ['/root/fase3-data/bin/b_catalog', `${W}/bin/b.bundle.min.js`, app, `${W}/bfs`],
  'B com retrato': ['/root/fase3-data/bin/b_catalog', `${W}/bin/b.bundle.min.js`, app, `${W}/bfs`],
};
const sorts = ['relevance', 'newest', 'rating', 'size', 'title'];
const queries = [];
for (const sort of sorts) for (const extra of [{}, { platform: 'ps5' }, { genre: 'Action' }, { access: 'direct', format: 'ready' }, { q: 'the' }]) queries.push({ sort, ...extra });
const median = (list) => { const s = [...list].sort((a, b) => a - b); return s[s.length >> 1]; };
let port = 38830;
async function once(name, [command, ...args]) {
  if (name.startsWith('B fria')) rmSync(`${W}/bfs/data/JobeesLair/feed-store`, { recursive: true, force: true });
  const p = ++port;
  const t0 = performance.now();
  const child = spawn(command, [String(p), ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { out += chunk; if (/^LISTEN /m.test(out)) resolve(); });
    child.on('exit', (code) => reject(new Error(`${name} saiu (${code})`)));
  });
  const up = performance.now() - t0;
  const get = async (path) => { const res = await fetch(`http://127.0.0.1:${p}${path}`); const body = await res.json(); return { body, took: Number(res.headers.get('x-took-ms')) }; };
  const built = (await get('/stats')).body;
  const first = [], next = [];
  for (const query of queries) {
    const qs = new URLSearchParams({ ...query, per: '60' });
    first.push((await get(`/api/catalog?${qs}&page=0`)).took);
    next.push((await get(`/api/catalog?${qs}&page=1`)).took);
  }
  const after = (await get('/stats')).body;
  await fetch(`http://127.0.0.1:${p}/quit`).catch(() => {});
  return { up, buildMs: built.buildMs, rssAdd: (built.rssBuiltKb - built.rssStartKb) / 1024, hwmAdd: (built.hwmBuiltKb - built.rssStartKb) / 1024,
    hwmAfter: (after.hwmNowKb - built.rssStartKb) / 1024, heapKb: built.heapBuiltKb ?? null, heapPeakKb: after.heapPeakKb ?? null,
    firstMs: median(first), firstMax: Math.max(...first), nextMs: median(next) };
}
const result = {};
for (const [name, cmd] of Object.entries(cores)) {
  const list = [];
  for (let i = 0; i < runs; i++) list.push(await once(name, cmd));
  const pick = (key) => (list[0][key] === null ? null : Number(median(list.map((r) => r[key])).toFixed(2)));
  result[name] = Object.fromEntries(Object.keys(list[0]).map((key) => [key, pick(key)]));
}
console.log(JSON.stringify(result, null, 1));
