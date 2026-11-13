// Fase 3 (prototipo): compila o nucleo B (QuickJS sem tela, guardado para a Fase 6) e prepara a pasta /data dele. O nucleo A
// (C) entrou no payload (app/native/bg_catalog*.c); a paridade dele e tools/fase3/parity.mjs.
// Run (WSL): node tools/fase3/build.mjs   (depois de tools/fase3/reference.mjs, que deixa /root/fase3-data/appfs)
// Saida em /root/fase3-data/bin: a_catalog (A: bg_downloader.c + bg_catalog.c), b_catalog (B: host + QuickJS-ng 0.15),
// b.bundle.js e b.bundle.min.js, bgdl_base (o payload sem nada novo, para medir o que A soma). E /root/fase3-data/bfs: a
// pasta /data do app (o cache do catalogo ao vivo e a lista Orbit) como arvore, para o B ler como o app le.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const here = path.join(repo, 'tools/fase3');
const WORK = process.env.FASE3_WORK || '/root/fase3-data';
const bin = path.join(WORK, 'bin');
const QJS_SRC = process.env.QJS_SRC || '/root/forks/qjs-peak';
const ESBUILD_JS = process.env.ESBUILD_JS || '/root/forks/tube-service/innertube/node_modules/esbuild/lib/main.js';
mkdirSync(bin, { recursive: true });
const { build } = await import(pathToFileURL(ESBUILD_JS).href);
const stubs = { '@ps5-react/core': path.join(here, 'b-core.js'), react: path.join(repo, 'tools/memory/qjs-react.js'), 'react/jsx-runtime': path.join(repo, 'tools/memory/qjs-react.js') };
for (const minify of [false, true]) {
  await build({
    entryPoints: [path.join(here, 'b-entry.js')], bundle: true, format: 'iife', platform: 'neutral', minify, logLevel: 'error',
    outfile: path.join(bin, minify ? 'b.bundle.min.js' : 'b.bundle.js'), target: 'es2022',
    loader: { '.ttf': 'empty', '.png': 'empty', '.jpg': 'empty' }, mainFields: ['module', 'main'], metafile: !minify,
    plugins: [{ name: 'stubs', setup(b) { b.onResolve({ filter: /^(@ps5-react\/core|react|react\/jsx-runtime)$/ }, (args) => ({ path: stubs[args.path] })); } }],
  }).then((result) => {
    if (result.metafile) {
      const inputs = Object.keys(result.metafile.inputs).filter((file) => file.startsWith('app/') || file.includes('/app/'));
      console.log(`bundle: ${Object.keys(result.metafile.inputs).length} modulos, ${inputs.length} do app/`);
    }
  });
}
const cc = (args) => execFileSync('cc', args, { cwd: here, stdio: ['ignore', 'inherit', 'inherit'] });
const flags = ['-std=gnu11', '-O2', '-w'];
// B: o host + o motor (as 4 fontes do QuickJS-ng, sem quickjs-libc).
const qjs = ['quickjs.c', 'libregexp.c', 'libunicode.c', 'dtoa.c'].map((file) => path.join(QJS_SRC, file));
cc([...flags, '-D_GNU_SOURCE', `-I${QJS_SRC}`, '-o', path.join(bin, 'b_catalog'), 'b_host.c', ...qjs, '-lm', '-lpthread']);
// O motor sozinho com um main vazio, para separar motor e cola no tamanho.
cc([...flags, '-D_GNU_SOURCE', `-I${QJS_SRC}`, '-o', path.join(bin, 'qjs_only'), 'qjs_only.c', ...qjs, '-lm', '-lpthread']);
for (const name of ['b_catalog', 'qjs_only']) {
  copyFileSync(path.join(bin, name), path.join(bin, `${name}.stripped`));
  execFileSync('strip', [path.join(bin, `${name}.stripped`)]);
}
// A pasta /data do B: os arquivos da pasta de trabalho do qjs (um por caminho, nome = encodeURIComponent do caminho).
const flat = path.join(WORK, 'appfs');
const tree = path.join(WORK, 'bfs');
rmSync(tree, { recursive: true, force: true });
let copied = 0;
for (const name of readdirSync(flat)) {
  const logical = decodeURIComponent(name);
  if (!logical.startsWith('/data/')) continue;
  const target = path.join(tree, logical);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(flat, name), target);
  copied++;
}
console.log(`bfs: ${copied} arquivos`);
const size = (name) => statSync(path.join(bin, name)).size;
console.log(JSON.stringify({ b: size('b_catalog.stripped'), qjs: size('qjs_only.stripped'),
  bundle: size('b.bundle.js'), bundleMin: size('b.bundle.min.js') }));
if (!existsSync(path.join(tree, 'data'))) throw new Error('bfs vazio: rode tools/fase3/reference.mjs antes');
