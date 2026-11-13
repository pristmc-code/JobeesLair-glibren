// glibren.44 (medidor de memoria): o pico do heap do JavaScript de um cenario de tools/memory/scenarios.js numa execucao
// so, com um qjs 0.15 que conta o pico (std.mem() = [uso agora, pico]; o mesmo malloc_size que o --memory-limit confere).
// Mais rapido que a busca binaria do measure.mjs (uma Biblioteca leva minutos la) e mostra o ranking do medidor do app,
// como Configuracoes > Sobre no console. O qjs com o contador: quickjs-ng 0.15 com o patch descrito em
// tools/memory/qjs-peak.patch (QJS_PEAK; padrao /root/forks/qjs-peak/build/qjs).
//
// Run (Linux/WSL): node tools/memory/peak.mjs <cenario> [prep-loja|prep-orbit]
// Variaveis: as de measure.mjs e scenarios.js (MEM_ACCOUNT, MEM_ACCOUNT_BIG_EVERY, MEM_ACCOUNT_BIG_FILES...).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const here = path.join(repo, 'tools/memory');
const first = (list) => list.find((file) => file && existsSync(file));
const QJS = first([process.env.QJS_PEAK, '/root/forks/qjs-peak/build/qjs']);
const ESBUILD_JS = first([process.env.ESBUILD_JS, '/root/forks/tube-service/innertube/node_modules/esbuild/lib/main.js',
  '/root/forks/youtube-maxd/companion/innertube/node_modules/esbuild/lib/main.js']);
const LIVE = first([process.env.MEM_LIVE, '/root/jlxdata/live.jlx']);
const ORBIT = first([process.env.MEM_ORBIT, '/root/m27/slim.json']);
const WORK = process.env.MEM_WORK || path.join(process.env.TMPDIR || '/tmp', 'jobe-mem-peak');
for (const [name, value] of Object.entries({ QJS_PEAK: QJS, ESBUILD_JS, MEM_LIVE: LIVE, MEM_ORBIT: ORBIT })) if (!value) throw new Error(`${name} not found: set it`);

const [scenario = 'base', prep = 'prep-orbit'] = process.argv.slice(2);
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
const run = (name, fs) => spawnSync(QJS, [bundle, name, fs, app, LIVE, ORBIT], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
const fs = path.join(WORK, prep);
rmSync(fs, { recursive: true, force: true });
mkdirSync(fs, { recursive: true });
const ready = run(prep, fs);
if (!/^DONE /m.test(ready.stdout)) throw new Error(`${prep} failed: ${ready.stderr || ready.stdout}`);
const result = run(scenario, fs);
process.stdout.write(result.stdout);
process.stdout.write(result.stderr);
if (!/^DONE /m.test(result.stdout)) process.exitCode = 1;
