// Fase 3: o teste de paridade app x payload sobre o fixture do repositorio (tests/fixtures/fase3).
//   1. A referencia: o codigo do app no qjs 0.15 (tools/fase3/reference-fixture.js), quando o qjs e o esbuild estao na
//      maquina (WSL: /root/forks/qjs-peak e o esbuild do tube-service); senao, a copia gravada em
//      tests/fixtures/fase3/reference.json.gz (refeita com --update; uma copia diferente da gerada agora vira um aviso).
//   2. O payload de verdade (app/native/bg_downloader.c compilado para o PC) com o catalogo embutido do repositorio e os
//      feeds do fixture, nas variantes ps5, low (firmware 9.60), ps4 e hidden (a lista Pegasus escondida).
//   3. Confere: as opcoes dos filtros, os campos de cada jogo, a grade de cada consulta (todas as paginas), as contagens
//      dos filtros, a busca da tela Procurar, as fileiras da pagina inicial, as fichas (links como game.releases, a ordem
//      da Jobe, edicoes e relacionados), o "solo" da loja do celular, as fontes e os codigos conhecidos da lista Orbit.
// Run (WSL): node tools/fase3/parity.mjs [--update] [--variants ps5,low,ps4,hidden] [--binary <bgdl>] [--keep]
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { stageBundled } from './stage-bundled.mjs';
import { compileTo } from '../../tests/payload-build.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
// FASE3_FIXTURE: outra pasta no mesmo formato (make-fixture.mjs --full: os dados reais inteiros, 3.200 jogos).
const FIXTURE = process.env.FASE3_FIXTURE || path.join(repo, 'tests/fixtures/fase3');
const SAVED = path.join(FIXTURE, 'reference.json.gz');
const LIVE = 'https://raw.githubusercontent.com/JVK3R/JobeesLair/main/catalog/live.json';
const WEB = 'https://feeds.example/fase3.json';
const PKG = 'https://pegasus.example/catalogs/fase3.json';
const LOCAL = '/data/fixture/feed-local.json';
const ORBIT = '/data/JobeesLair/orbit/orbit-store.json';
const first = (list) => list.find((file) => file && existsSync(file));
const stableKey = (value) => { let a = 2166136261, b = 5381; for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(i); } return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`; };
const canonical = (value) => JSON.stringify(value, (key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 1. A referencia -------------------------------------------------------------------------------------------------
async function makeReference(work, variants) {
  const QJS = first([process.env.QJS_PEAK, '/root/forks/qjs-peak/build/qjs']);
  const ESBUILD_JS = first([process.env.ESBUILD_JS, '/root/forks/tube-service/innertube/node_modules/esbuild/lib/main.js']);
  if (!QJS || !ESBUILD_JS) return null;
  const { build } = await import(pathToFileURL(ESBUILD_JS).href);
  const here = path.join(repo, 'tools/fase3');
  const stubs = { '@ps5-react/core': path.join(here, 'qjs-core-f3.js'), react: path.join(repo, 'tools/memory/qjs-react.js'), 'react/jsx-runtime': path.join(repo, 'tools/memory/qjs-react.js') };
  const bundle = path.join(work, 'reference-fixture.bundle.js');
  await build({
    entryPoints: [path.join(here, 'reference-fixture.js')], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'error',
    loader: { '.ttf': 'empty', '.png': 'empty', '.jpg': 'empty' }, mainFields: ['module', 'main'],
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: /^(@ps5-react\/core|react|react\/jsx-runtime)$/ }, (args) => ({ path: stubs[args.path] }));
      b.onResolve({ filter: /^qjs:/ }, (args) => ({ path: args.path, external: true }));
      b.onResolve({ filter: /qjs-core\.js$/ }, (args) => args.importer.endsWith('qjs-core-f3.js') ? { path: path.join(repo, 'tools/memory/qjs-core.js') } : undefined);
    } }],
  });
  const out = {};
  for (const variant of variants) {
    const fs = path.join(work, `appfs-${variant}`);
    rmSync(fs, { recursive: true, force: true });
    mkdirSync(fs, { recursive: true });
    const app = path.join(repo, 'app');
    const prep = spawnSync(QJS, [bundle, 'prep', fs, app, FIXTURE, variant], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
    if (!/^DONE /m.test(prep.stdout)) throw new Error(`referencia ${variant} (prep): ${prep.stderr || prep.stdout}`);
    const file = path.join(work, `ref-${variant}.json`);
    const ref = spawnSync(QJS, [bundle, 'ref', fs, app, FIXTURE, variant, file], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
    if (!/^DONE /m.test(ref.stdout)) throw new Error(`referencia ${variant}: ${ref.stderr || ref.stdout}`);
    out[variant] = JSON.parse(readFileSync(file, 'utf8'));
  }
  return out;
}

// ---- 2. O payload ------------------------------------------------------------------------------------------------------
const freeLocalPort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function startPayload(binary, work, variant, ports) {
  const base = path.join(work, `payload-${variant}`);
  rmSync(base, { recursive: true, force: true });
  const cat = path.join(base, 'state/catalog');
  mkdirSync(path.join(cat, 'feeds'), { recursive: true });
  stageBundled(path.join(repo, 'app'), path.join(cat, 'bundled'), '0.5.5-fixture');
  copyFileSync(path.join(FIXTURE, 'live.jlx'), path.join(cat, `feeds/${stableKey(LIVE)}.json`));
  copyFileSync(path.join(FIXTURE, 'feed-web.jlx'), path.join(cat, `feeds/${stableKey(WEB)}.json`));
  copyFileSync(path.join(FIXTURE, 'feed-pegasus.jlx'), path.join(cat, `feeds/${stableKey(PKG)}.json`));
  mkdirSync(path.join(base, 'root/data/fixture'), { recursive: true });
  copyFileSync(path.join(FIXTURE, 'feed-local.json'), path.join(base, 'root', LOCAL));
  const orbitDir = path.join(base, 'orbit');
  mkdirSync(orbitDir, { recursive: true });
  const orbit = variant !== 'ps4';
  if (orbit) {
    copyFileSync(path.join(FIXTURE, 'orbit-store.jlx'), path.join(orbitDir, 'orbit-store.json'));
    copyFileSync(path.join(FIXTURE, 'orbit-known.txt'), path.join(orbitDir, 'orbit-known.txt'));
    writeFileSync(path.join(orbitDir, 'orbit-store-status.json'), JSON.stringify({ enabled: false, conv: 3, known: 50, lastOk: 1763000000, lastTry: 1763000000, revision: 96 }));
  }
  writeFileSync(path.join(cat, 'config.json'), JSON.stringify({ app: '0.5.5-fixture', feeds: [WEB, PKG, LOCAL], mirrors: [{ url: WEB, list: ['https://mirror2.example/fase3.json'] }],
    orbit: { on: orbit, id: ORBIT }, hidden: variant === 'hidden' ? [PKG] : [], ps4: variant === 'ps4', firmware: variant === 'low' ? '9.60' : '12.00' }));
  const [api, monitor] = ports ? [await ports(), await ports()] : [await freeLocalPort(), await freeLocalPort()];
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor), BGDL_ORBIT_DIR: orbitDir,
    BGDL_STORE_DIR: path.join(base, 'store'), BGDL_LIBRARY: path.join(base, 'none.json'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_LOCAL_PREFIX: path.join(base, 'root'),
    BGDL_CATALOG_FIRST_MS: '0', BGDL_CATALOG_CHECK_MS: '200' }, stdio: ['ignore', 'ignore', 'ignore'] });
  const token = async () => { for (let i = 0; i < 300; i++) { try { return readFileSync(path.join(base, 'state/token'), 'utf8').trim(); } catch { await wait(50); } } throw new Error('sem token'); };
  const tok = await token();
  const get = async (route, port = api) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'X-Jobe-Token': tok } });
        return { status: res.status, data: await res.json() };
      } catch (problem) { if (attempt > 40) throw problem; await wait(100); }
    }
  };
  // pronto: montado e com o "solo" do pacote lido
  const started = performance.now();
  for (;;) {
    const s = (await get('/api/catalog/status')).data;
    if (s.state === 'ready' && s.soloDone) break;
    if (performance.now() - started > 120000) throw new Error(`o payload nao montou (${variant}): ${JSON.stringify(s)}`);
    await wait(100);
  }
  const status = (await get('/api/catalog/status')).data;
  return { child, get, api, monitor, base, orbitDir, status, upMs: performance.now() - started };
}

// ---- 3. Conferir -------------------------------------------------------------------------------------------------------
const params = (query, extra) => new URLSearchParams(Object.entries({ ...query, ...extra }).filter(([key, value]) => key !== 'name' && value !== undefined && value !== '')).toString();
async function compare(ref, p, variant) {
  const problems = [];
  const say = (text) => problems.push(`[${variant}] ${text}`);
  const { get } = p;
  const all = async (route, query) => {
    const ids = [];
    for (let page = 0; ; page++) {
      const { status, data } = await get(`${route}?${params(query, { page, per: 500 })}`);
      if (status !== 200) throw new Error(`${route}: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
      ids.push(...data.games.map((game) => game.id));
      if (ids.length >= data.total || !data.games.length) return { ids, total: data.total };
    }
  };
  const options = (await get('/api/catalog/options')).data;
  for (const [key, values] of Object.entries(ref.facets)) if (JSON.stringify(options[key] ?? []) !== JSON.stringify(values)) say(`opcoes de ${key}: ${JSON.stringify(options[key])} != ${JSON.stringify(values)}`);
  // os jogos
  const every = [];
  for (let page = 0; ; page++) {
    const { data } = await get(`/api/catalog?${params({ sort: 'title', platform: 'ps5,ps4' }, { page, per: 500 })}`);
    every.push(...data.games);
    if (every.length >= data.total || !data.games.length) break;
  }
  const byId = new Map(every.map((game) => [game.id, game]));
  let fieldDiffs = 0;
  for (const [id, title, platform, formats, direct, sizeGb, stars, ratingCount, , genres, releaseDate, year, , ready] of ref.games) {
    const game = byId.get(id);
    if (!game) { if (fieldDiffs++ < 15) say(`${id} falta`); continue; }
    const diffs = [];
    if (game.title !== title) diffs.push(`title ${JSON.stringify(game.title)} x ${JSON.stringify(title)}`);
    if (game.platform !== platform) diffs.push(`platform ${game.platform} x ${platform}`);
    if (game.formats.join(' ') !== formats) diffs.push(`formats ${game.formats.join(' ')} x ${formats}`);
    if (Number(game.direct) !== direct) diffs.push(`direct ${game.direct} x ${direct}`);
    if ((game.sizeGb ?? null) !== sizeGb) diffs.push(`sizeGb ${game.sizeGb} x ${sizeGb}`);
    if ((game.stars ?? null) !== stars || (game.ratingCount ?? null) !== ratingCount) diffs.push(`nota ${game.stars}/${game.ratingCount} x ${stars}/${ratingCount}`);
    if (game.genres.join('|') !== genres) diffs.push(`genres ${game.genres.join('|')} x ${genres}`);
    if (game.releaseDate !== releaseDate || (game.year ?? null) !== year) diffs.push(`data ${game.releaseDate}/${game.year} x ${releaseDate}/${year}`);
    if (game.ready !== ready) diffs.push(`ready ${game.ready} x ${ready}`);
    if (diffs.length && fieldDiffs++ < 15) say(`${id}: ${diffs.join('; ')}`);
  }
  if (every.length !== ref.games.length) say(`listados: ${every.length} x ${ref.games.length}`);
  // a grade
  let same = 0;
  for (const { query, ids } of ref.results) {
    const mine = await all('/api/catalog', query);
    if (JSON.stringify(mine.ids) === JSON.stringify(ids)) { same++; continue; }
    const at = ids.findIndex((id, i) => mine.ids[i] !== id);
    say(`grade ${query.name}: ${mine.ids.length} x ${ids.length}; 1a diferenca na posicao ${at}: ${mine.ids.slice(Math.max(0, at - 1), at + 3)} x ${ids.slice(Math.max(0, at - 1), at + 3)}`);
  }
  // as contagens
  let countsSame = 0;
  for (const { query, counts } of ref.counts) {
    const { data } = await get(`/api/catalog/options?${params(query)}`);
    let ok = true;
    for (const [key, values] of Object.entries(counts)) {
      const mine = Object.fromEntries((data.counts?.[key] ?? []).map(({ value, count }) => [value, count]));
      if (canonical(mine) !== canonical(values)) { ok = false; say(`contagens ${query.name ?? query.sort} ${key}: ${JSON.stringify(mine).slice(0, 160)} x ${JSON.stringify(values).slice(0, 160)}`); }
    }
    if (ok) countsSame++;
  }
  // a busca da tela Procurar
  let searchSame = 0;
  for (const { query, ids } of ref.search ?? []) {
    const mine = await all('/api/catalog/search', query);
    if (JSON.stringify(mine.ids) === JSON.stringify(ids)) searchSame++;
    else say(`busca ${JSON.stringify(query)}: ${mine.ids.slice(0, 5)} (${mine.ids.length}) x ${ids.slice(0, 5)} (${ids.length})`);
  }
  // a pagina inicial
  let homeSame = 0;
  for (const rows of ref.home ?? []) {
    const { data } = await get(`/api/catalog/home?seed=${rows.seed}&today=${rows.today}`);
    let ok = true;
    for (const key of ['carousel', 'featured', 'recent', 'top', 'newWeek', 'ready', 'popular', 'cdn']) {
      const mine = (data[key] ?? []).map((game) => game.id);
      if (JSON.stringify(mine) !== JSON.stringify(rows[key])) { ok = false; say(`inicio ${rows.seed} ${key}: ${mine.slice(0, 6)} (${mine.length}) x ${rows[key].slice(0, 6)} (${rows[key].length})`); }
    }
    for (const key of ['newWeekCount', 'readyCount']) if (data[key] !== rows[key]) { ok = false; say(`inicio ${key}: ${data[key]} x ${rows[key]}`); }
    if (ok) homeSame++;
  }
  // as fichas
  let fichasSame = 0;
  for (const ficha of ref.fichas ?? []) {
    const { status, data } = await get(`/api/catalog/game?id=${ficha.id}`);
    if (status !== 200) { say(`ficha ${ficha.id}: HTTP ${status}`); continue; }
    let ok = true;
    if (canonical(data.releases) !== canonical(ficha.releases)) {
      ok = false;
      const a = data.releases ?? [], b = ficha.releases;
      const at = b.findIndex((item, i) => canonical(item) !== canonical(a[i]));
      say(`ficha ${ficha.id} links (${a.length} x ${b.length}), 1o diferente ${at}: ${canonical(a[at]).slice(0, 400)} x ${canonical(b[at]).slice(0, 400)}`);
    }
    if (JSON.stringify(data.order) !== JSON.stringify(ficha.order)) { ok = false; say(`ficha ${ficha.id} ordem ${data.order} x ${ficha.order}`); }
    if (JSON.stringify((data.editions ?? []).map((e) => e.id)) !== JSON.stringify(ficha.editions)) { ok = false; say(`ficha ${ficha.id} edicoes ${JSON.stringify(data.editions)} x ${ficha.editions}`); }
    if (JSON.stringify((data.related ?? []).map((g) => g.id)) !== JSON.stringify(ficha.related)) { ok = false; say(`ficha ${ficha.id} relacionados ${(data.related ?? []).map((g) => g.id)} x ${ficha.related}`); }
    if (ok) fichasSame++;
  }
  // o "solo" da loja do celular
  let soloSame = 0, soloTotal = 0;
  if (ref.solo) {
    const store = [];
    for (let offset = 0; ; offset += 200) {
      const res = await fetch(`http://127.0.0.1:${p.monitor}/api/store?limit=200&offset=${offset}&sort=title`);
      const data = await res.json();
      store.push(...data.games);
      if (store.length >= data.count || !data.games.length) break;
    }
    for (const game of store) {
      if (!(game.id in ref.solo)) continue;
      soloTotal++;
      if (game.solo === ref.solo[game.id]) soloSame++;
      else if (soloTotal - soloSame <= 10) say(`solo ${game.id}: ${game.solo} x ${ref.solo[game.id]}`);
    }
  }
  // as fontes e os codigos conhecidos da lista Orbit
  const sources = (await get('/api/catalog/sources')).data.sources?.map(({ id, count }) => ({ id, count }));
  if (canonical(sources) !== canonical(ref.sources)) say(`fontes ${JSON.stringify(sources)} x ${JSON.stringify(ref.sources)}`);
  if (ref.known?.length) {
    await wait(300);
    const file = new Set(readFileSync(path.join(p.orbitDir, 'orbit-known.txt'), 'utf8').split('\n').filter(Boolean));
    const missing = ref.known.filter((id) => !file.has(id));
    if (missing.length) say(`conhecidos da Orbit: faltam ${missing.length} (${missing.slice(0, 5)})`);
  }
  return {
    problems,
    summary: { consultas: `${same}/${ref.results.length}`, contagens: `${countsSame}/${ref.counts.length}`, busca: `${searchSame}/${(ref.search ?? []).length}`,
      inicio: `${homeSame}/${(ref.home ?? []).length}`, fichas: `${fichasSame}/${(ref.fichas ?? []).length}`, solo: `${soloSame}/${soloTotal}`, listados: every.length },
  };
}

export async function runParity({ binary, variants = ['ps5', 'low', 'ps4', 'hidden'], update = false, keep = false, ports } = {}) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'jl-fase3-'));
  try {
    let refs = await makeReference(work, variants);
    let source = 'qjs';
    const warnings = [];
    if (refs && existsSync(SAVED) && !update && !process.env.FASE3_FIXTURE) {
      const saved = JSON.parse(gunzipSync(readFileSync(SAVED)).toString('utf8'));
      for (const variant of variants) if (saved[variant] && canonical(saved[variant]) !== canonical(refs[variant])) warnings.push(`a referencia gravada (${variant}) e diferente da gerada agora: rode tools/fase3/parity.mjs --update`);
    }
    if (refs && update && !process.env.FASE3_FIXTURE) writeFileSync(SAVED, gzipSync(JSON.stringify(refs), { level: 9 }));
    if (!refs) {
      if (!existsSync(SAVED)) throw new Error('sem qjs/esbuild e sem tests/fixtures/fase3/reference.json.gz');
      refs = JSON.parse(gunzipSync(readFileSync(SAVED)).toString('utf8'));
      source = 'gravada';
    }
    if (!binary) {
      binary = path.join(work, 'bgdl');
      const built = compileTo(binary, 'cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
      if (built.status !== 0) throw new Error(built.stderr);
    }
    const result = { referencia: source, warnings, variantes: {}, problems: [] };
    for (const variant of variants) {
      const p = await startPayload(binary, work, variant, ports);
      try {
        const { problems, summary } = await compare(refs[variant], p, variant);
        result.variantes[variant] = { ...summary, montagemMs: p.status.buildMs, guardaMB: Number((p.status.bytes / 1048576).toFixed(2)), picoMB: Number((p.status.peak / 1048576).toFixed(2)) };
        result.problems.push(...problems);
      } finally {
        p.child.kill('SIGTERM');
        await new Promise((resolve) => p.child.exitCode !== null ? resolve() : p.child.once('exit', resolve));
      }
    }
    return result;
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const result = await runParity({ binary: opt('--binary'), variants: opt('--variants')?.split(','), update: args.includes('--update'), keep: args.includes('--keep') });
  console.log(JSON.stringify({ ...result, problems: result.problems.slice(0, 60), nProblems: result.problems.length }, null, 1));
  process.exit(result.problems.length ? 1 : 0);
}
