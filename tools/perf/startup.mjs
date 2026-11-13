// glibren.45 (medidor de CPU da abertura): o tempo que a loja leva para decodificar e indexar o catalogo (o embutido, o
// catalogo ao vivo e a lista Orbit), no qjs 0.15 (o mesmo motor do ps5-react, uma thread, como no console). Usa o cenario
// "tempo" de tools/memory/scenarios.js e o mesmo empacotamento do tools/memory/peak.mjs.
//
// Run (Linux/WSL): node tools/perf/startup.mjs [vezes=5]
// Saida, de uma vez so (como antes da .45 e nos testes) e em partes (como no console da .45 em diante, MEM_PACED): a 1a
// abertura (sem o retrato da loja: le os feeds e grava o retrato) e a mediana das seguintes (com o retrato, o caso comum
// no console): total (ms de CPU), a maior parte sem devolver o quadro ("longest") e quantas partes, e o pico do heap (MB,
// com o qjs de contador; ver tools/memory/qjs-peak.patch). Numa versao sem partes (a .44) as duas linhas dao o mesmo.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const here = path.join(repo, 'tools/memory');
const first = (list) => list.find((file) => file && existsSync(file));
const QJS = first([process.env.QJS_PEAK, '/root/forks/qjs-peak/build/qjs', process.env.QJS, '/usr/local/bin/qjs']);
const ESBUILD_JS = first([process.env.ESBUILD_JS, '/root/forks/tube-service/innertube/node_modules/esbuild/lib/main.js',
  '/root/forks/youtube-maxd/companion/innertube/node_modules/esbuild/lib/main.js']);
const LIVE = first([process.env.MEM_LIVE, '/root/jlxdata/live.jlx']);
const ORBIT = first([process.env.MEM_ORBIT, '/root/m27/slim.json']);
const WORK = process.env.MEM_WORK || path.join(process.env.TMPDIR || '/tmp', 'jobe-perf-startup');
for (const [name, value] of Object.entries({ QJS_PEAK: QJS, ESBUILD_JS, MEM_LIVE: LIVE, MEM_ORBIT: ORBIT })) if (!value) throw new Error(`${name} not found: set it`);

const runs = Math.max(1, Number(process.argv[2] ?? 5));
const { build } = await import(pathToFileURL(ESBUILD_JS).href);
const bundle = path.join(WORK, 'scenarios.bundle.js');
mkdirSync(WORK, { recursive: true });
const stubs = { '@ps5-react/core': path.join(here, 'qjs-core.js'), react: path.join(here, 'qjs-react.js'), 'react/jsx-runtime': path.join(here, 'qjs-react.js') };
await build({
  entryPoints: [path.join(here, 'scenarios.js')], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'error',
  loader: { '.ttf': 'empty', '.png': 'empty', '.jpg': 'empty' }, mainFields: ['module', 'main'],
  plugins: [{ name: 'stubs', setup(b) {
    b.onResolve({ filter: /^(@ps5-react\/core|react|react\/jsx-runtime)$/ }, (args) => ({ path: stubs[args.path] }));
    b.onResolve({ filter: /^qjs:/ }, (args) => ({ path: args.path, external: true }));
  } }],
});
const app = path.join(repo, 'app');
const fs = path.join(WORK, 'prep-orbit');
const run = (name, env = {}) => spawnSync(QJS, [bundle, name, fs, app, LIVE, ORBIT], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20, env: { ...process.env, ...env } });
rmSync(fs, { recursive: true, force: true });
mkdirSync(fs, { recursive: true });
const ready = run('prep-orbit');
if (!/^DONE /m.test(ready.stdout)) throw new Error(`prep-orbit failed: ${ready.stderr || ready.stdout}`);

const parse = (result) => {
  if (!/^DONE /m.test(result.stdout)) throw new Error(`tempo failed: ${result.stderr || result.stdout}`);
  const time = Object.fromEntries([...(/^TIME (.*)$/m.exec(result.stderr)?.[1] ?? '').matchAll(/(\w+)=([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
  const peak = Number(/^PEAK ([\d.]+)/m.exec(result.stderr)?.[1] ?? NaN);
  return { ...time, peak, phases: /^PHASES (.*)$/m.exec(result.stderr)?.[1] ?? '', done: /^DONE (.*)$/m.exec(result.stdout)[1] };
};
const median = (list, key) => { const sorted = list.map((r) => r[key]).sort((a, b) => a - b); return sorted[sorted.length >> 1]; };
const line = (label, r) => console.log(`${label}: CPU ${r.total} ms, maior parte sem devolver o quadro ${r.longest} ms, ${r.steps} parte(s), pico ${r.peak} MB${r.phases ? ` | ${r.phases}` : ''}`);

for (const [mode, env] of [['de uma vez', {}], ['em partes', { MEM_PACED: '1' }]]) {
  // Sem o retrato: apaga o que a abertura anterior gravou (a pasta da loja no armazenamento de mentira).
  for (const name of (await import('node:fs')).readdirSync(fs)) if (decodeURIComponent(name).includes('/feed-store/')) rmSync(path.join(fs, name), { force: true });
  const cold = parse(run('tempo', env));
  if (mode === 'de uma vez') console.log(cold.done);
  line(`${mode}, 1a abertura (sem retrato)`, cold);
  const warm = [];
  for (let i = 0; i < runs; i++) warm.push(parse(run('tempo', env)));
  const mid = Object.fromEntries(['total', 'index', 'store', 'rest', 'longest', 'steps', 'peak'].map((key) => [key, median(warm, key)]));
  mid.phases = warm[warm.length >> 1].phases;
  line(`${mode}, abertura com retrato (mediana de ${runs})`, mid);
}
