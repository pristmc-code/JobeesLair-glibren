// Fase 4: grava as respostas do catalogo do payload (o de verdade, compilado para o PC) para os cenarios de memoria do app
// pelo caminho remoto (tools/memory/scenarios.js "*-remota"): os mesmos dados dos cenarios "loja"/"orbit" (o catalogo
// embutido do repositorio + o live.jlx e, com --orbit, a lista Orbit do measure.mjs).
// Run (WSL): node tools/fase4/record.mjs <bgdl> <pasta de saida> [--orbit]
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageBundled } from '../fase3/stage-bundled.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const [binary, out] = process.argv.slice(2);
const orbit = process.argv.includes('--orbit');
const LIVE_FILE = process.env.MEM_LIVE || '/root/jlxdata/live.jlx';
const ORBIT_FILE = process.env.MEM_ORBIT || '/root/m27/slim.json';
const LIVE = 'https://raw.githubusercontent.com/JVK3R/JobeesLair/main/catalog/live.json';
const stableKey = (value) => { let a = 2166136261, b = 5381; for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(i); } return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`; };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const base = mkdtempSync(path.join(os.tmpdir(), 'jl-f4rec-'));
const cat = path.join(base, 'state/catalog');
mkdirSync(path.join(cat, 'feeds'), { recursive: true });
stageBundled(path.join(repo, 'app'), path.join(cat, 'bundled'), '0.5.5-record');
copyFileSync(LIVE_FILE, path.join(cat, `feeds/${stableKey(LIVE)}.json`));
const orbitDir = path.join(base, 'orbit');
mkdirSync(orbitDir, { recursive: true });
if (orbit) {
  copyFileSync(ORBIT_FILE, path.join(orbitDir, 'orbit-store.json'));
  copyFileSync(path.join(repo, 'tests/fixtures/fase3/orbit-known.txt'), path.join(orbitDir, 'orbit-known.txt')); // a lista so vale com codigos conhecidos
  writeFileSync(path.join(orbitDir, 'orbit-store-status.json'), JSON.stringify({ enabled: false, conv: 3, known: 50, lastOk: 1763000000, lastTry: 1763000000, revision: 96 }));
}
writeFileSync(path.join(cat, 'config.json'), JSON.stringify({ app: '0.5.5-record', feeds: [], mirrors: [], orbit: { on: orbit, id: '/data/JobeesLair/orbit/orbit-store.json' }, hidden: [], ps4: false, firmware: '12.00' }));
const api = 12000 + 8 * 1000 + Math.floor(Math.random() * 900), monitor = api + 1;
const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor), BGDL_ORBIT_DIR: orbitDir,
  BGDL_STORE_DIR: path.join(base, 'store'), BGDL_LIBRARY: path.join(base, 'none.json'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_LOCAL_PREFIX: path.join(base, 'root'),
  BGDL_CATALOG_FIRST_MS: '0', BGDL_CATALOG_CHECK_MS: '200', BGDL_FEEDS_EVERY_S: '999999' }, stdio: 'ignore' });
try {
  let token = '';
  for (let i = 0; i < 300 && !token; i++) { try { token = readFileSync(path.join(base, 'state/token'), 'utf8').trim(); } catch { await wait(50); } }
  const got = {};
  const get = async (route) => {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${api}${route}`, { headers: { 'X-Jobe-Token': token } });
        const body = await res.text();
        got[route] = { status: res.status, body };
        return JSON.parse(body);
      } catch (error) { if (i > 50) throw error; await wait(100); }
    }
  };
  for (;;) { const s = await get('/api/catalog/status'); if (s.state === 'ready') break; if (s.state === 'over-limit' || s.state === 'failed') throw new Error(JSON.stringify(s)); await wait(100); }
  const status = await get('/api/catalog/status');
  await get('/health');
  // o que o app pede (state/catalog-remote.js), com as mesmas consultas
  await get('/api/catalog/options?sort=relevance');
  await get(`/api/catalog/home?seed=12345&today=2026-11-13`);
  for (let offset = 0; offset < 48 * 6; offset += 48) await get(`/api/catalog?sort=relevance&offset=${offset}&limit=48`);
  await get('/api/catalog?sort=relevance&genre=Action&offset=0&limit=48');
  await get('/api/catalog/options?sort=relevance&genre=Action');
  await get('/api/catalog?sort=relevance&genre=Action&offset=0&limit=1');
  for (let offset = 0; offset < 48 * 3; offset += 48) await get(`/api/catalog/search?sort=relevance&q=the&offset=${offset}&limit=48`);
  // a ficha mais pesada entre as primeiras da grade: a com mais links
  const first = JSON.parse(got['/api/catalog?sort=relevance&offset=0&limit=48'].body).games.map((g) => g.id);
  let busiest = null, most = -1;
  for (const id of first) {
    const ficha = await get(`/api/catalog/game?id=${encodeURIComponent(id)}`);
    if ((ficha.releases?.length ?? 0) > most) { most = ficha.releases.length; busiest = id; }
    const others = (ficha.editions ?? []).map((e) => e.id).filter((other) => other !== id);
    if (others.length) await get(`/api/catalog/cards?ids=${others.map(encodeURIComponent).join(',')}`);
  }
  // uma resposta por arquivo (o cenario le so a que pede: o arquivo inteiro na memoria do qjs viraria o pico)
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const index = {};
  Object.entries(got).forEach(([route, { status: code, body }], i) => {
    writeFileSync(path.join(out, `${i}.json`), body);
    index[route] = { status: code, file: `${i}.json` };
  });
  writeFileSync(path.join(out, 'index.json'), JSON.stringify({ shown: status.listed, entries: status.entries, busiest, links: most, routes: index }));
  console.log(`gravado ${Object.keys(got).length} respostas; ${status.listed ?? '?'} listados; ficha ${busiest} com ${most} links; ${(JSON.stringify(got).length / 1048576).toFixed(1)} MB`);
} finally {
  child.kill('SIGTERM');
  await wait(200);
  if (existsSync(base)) rmSync(base, { recursive: true, force: true });
}
