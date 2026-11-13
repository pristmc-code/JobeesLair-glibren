// Fase 3 (prototipo): monta a referencia do app (tools/fase3/reference.js) com os dados reais de agora.
// Run (WSL): node tools/fase3/reference.mjs [live.jlx] [orbit-store.json] [saida.json]
//   padrao: /root/fase3-data/live.jlx, /root/fase3-data/run/orbit/orbit-store.json, /root/fase3-data/reference.json
// A pasta de trabalho (cache do catalogo ao vivo + lista Orbit, como o app grava) fica em /root/fase3-data/appfs: o nucleo
// B (QuickJS) le dela tambem. Usa o mesmo empacotamento de tools/memory/peak.mjs (esbuild, stubs do @ps5-react/core).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const mem = path.join(repo, 'tools/memory');
const first = (list) => list.find((file) => file && existsSync(file));
const QJS = first([process.env.QJS_PEAK, '/root/forks/qjs-peak/build/qjs']);
const ESBUILD_JS = first([process.env.ESBUILD_JS, '/root/forks/tube-service/innertube/node_modules/esbuild/lib/main.js']);
const LIVE = process.argv[2] || '/root/fase3-data/live.jlx';
const ORBIT = process.argv[3] || '/root/fase3-data/run/orbit/orbit-store.json';
const OUT = process.argv[4] || '/root/fase3-data/reference.json';
const WORK = process.env.FASE3_WORK || '/root/fase3-data';
const fs = path.join(WORK, 'appfs');
const { build } = await import(pathToFileURL(ESBUILD_JS).href);
const stubs = { '@ps5-react/core': path.join(mem, 'qjs-core.js'), react: path.join(mem, 'qjs-react.js'), 'react/jsx-runtime': path.join(mem, 'qjs-react.js') };
const bundle = async (entry, outfile) => build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'error',
  loader: { '.ttf': 'empty', '.png': 'empty', '.jpg': 'empty' }, mainFields: ['module', 'main'],
  plugins: [{ name: 'stubs', setup(b) {
    b.onResolve({ filter: /^(@ps5-react\/core|react|react\/jsx-runtime)$/ }, (args) => ({ path: stubs[args.path] }));
    b.onResolve({ filter: /^qjs:/ }, (args) => ({ path: args.path, external: true }));
  } }],
});
mkdirSync(WORK, { recursive: true });
await bundle(path.join(mem, 'scenarios.js'), path.join(WORK, 'scenarios.bundle.js'));
await bundle(path.join(repo, 'tools/fase3/reference.js'), path.join(WORK, 'reference.bundle.js'));
const app = path.join(repo, 'app');
if (!process.env.FASE3_KEEP) {
  rmSync(fs, { recursive: true, force: true });
  mkdirSync(fs, { recursive: true });
  const prep = spawnSync(QJS, [path.join(WORK, 'scenarios.bundle.js'), 'prep-orbit', fs, app, LIVE, ORBIT], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
  if (!/^DONE /m.test(prep.stdout)) throw new Error(`prep-orbit failed: ${prep.stderr || prep.stdout}`);
  console.log(prep.stdout.trim().split('\n').pop());
}
const ref = spawnSync(QJS, [path.join(WORK, 'reference.bundle.js'), fs, app, path.join(repo, 'tools/fase3/queries.json'), OUT], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 });
if (!/^DONE /m.test(ref.stdout)) throw new Error(`reference failed: ${ref.stderr || ref.stdout}`);
console.log(ref.stdout.trim().split('\n').pop());
