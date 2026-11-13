// glibren (medidor de memoria): mede no PC, no qjs (QuickJS-ng 0.15, o motor do ps5-react), o pico do heap do JavaScript
// em cada cenario de tools/memory/scenarios.js: o menor --memory-limit com que o cenario termina. A base de conhecimento
// recomenda medir assim, nao no V8 (numeros ruidosos). Os numeros sao do heap do JS; o limite do app no console e o
// kJsMemoryLimit do ps5-react (native/shared/js_heap.hpp).
//
// Run (Linux/WSL, um cenario de cada vez; nada em paralelo):
//   node tools/memory/measure.mjs [cenario ...]
// Variaveis: QJS (o qjs 0.15), ESBUILD_JS (o pacote esbuild, para o bundle), MEM_LIVE (o catalogo ao vivo, .jlx),
// MEM_ORBIT (o orbit-store.json que o payload grava), MEM_WORK (a pasta de trabalho), e as do tamanho da conta TorBox
// de mentira em scenarios.js (MEM_ACCOUNT, MEM_HELD_EVERY, MEM_BIG_EVERY, MEM_BIG_FILES).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const here = path.join(repo, 'tools/memory');
const first = (list) => list.find((file) => file && existsSync(file));
const QJS = first([process.env.QJS, '/root/forks/qjs-measure/quickjs/build/qjs']);
const ESBUILD_JS = first([process.env.ESBUILD_JS, '/root/forks/tube-service/innertube/node_modules/esbuild/lib/main.js',
  '/root/forks/youtube-maxd/companion/innertube/node_modules/esbuild/lib/main.js']);
const LIVE = first([process.env.MEM_LIVE, '/root/jlxdata/live.jlx']);
const ORBIT = first([process.env.MEM_ORBIT, '/root/m27/slim.json']);
const REMOTE_LOJA = process.env.MEM_REMOTE_LOJA || '/root/f4b/remote-loja';
const REMOTE_ORBIT = process.env.MEM_REMOTE_ORBIT || '/root/f4b/remote-orbit';
const WORK = process.env.MEM_WORK || path.join(process.env.TMPDIR || '/tmp', 'jobe-mem-measure');
for (const [name, value] of Object.entries({ QJS, ESBUILD_JS, MEM_LIVE: LIVE, MEM_ORBIT: ORBIT })) if (!value) throw new Error(`${name} not found: set it`);

// O bundle dos cenarios, com o core e o react de mentira do qjs.
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
const run = (scenario, fs, limitKB) => spawnSync(QJS, [...(limitKB ? ['--memory-limit', String(limitKB)] : []), bundle, scenario, fs, app, LIVE, ORBIT],
  { encoding: 'utf8', timeout: 300000, maxBuffer: 16 << 20 });
const done = (result) => /^DONE /m.test(result.stdout ?? '');
function prepare(name, scenario) {
  const fs = path.join(WORK, name);
  rmSync(fs, { recursive: true, force: true });
  mkdirSync(fs, { recursive: true });
  const result = run(scenario, fs, 0);
  if (!done(result)) throw new Error(`${scenario} failed: ${result.stderr || result.stdout}`);
  return { fs, note: /^DONE \S+ (.*)$/m.exec(result.stdout)[1] };
}
// O menor limite (KB) com que o cenario termina: busca binaria a partir de `low` (um cenario que comeca com a loja montada
// nao fica abaixo do pico dela), 128 KB de precisao. A Biblioteca leva mais de um minuto por execucao.
function peak(scenario, fs, low = 1024) {
  let high = 128 * 1024;
  const top = run(scenario, fs, high);
  if (!done(top)) return { error: (top.stderr || top.stdout || '').trim().split('\n').slice(-3).join(' | ') };
  // So conta como "terminou" o mesmo resultado de sem aperto: o app engole a falta de memoria em alguns lugares (um feed
  // que nao abre fica de fora da loja, try/catch em feeds.js) e o cenario terminaria com menos coisa carregada.
  const note = /^DONE \S+ (.*)$/m.exec(top.stdout)[1];
  while (high - low > 128) {
    const mid = Math.floor((low + high) / 2);
    const result = run(scenario, fs, mid);
    if (done(result) && /^DONE \S+ (.*)$/m.exec(result.stdout)[1] === note) high = mid;
    else low = mid;
  }
  return { kb: high, note };
}

const loja = prepare('fs-loja', 'prep-loja');
const orbit = prepare('fs-orbit', 'prep-orbit');
console.log(`preparado: sem Orbit (${loja.note}); com Orbit (${orbit.note})`);
// [nome, cenario, pasta, o que e, o cenario cujo pico e o piso deste]
const ALL = [
  ['base', 'base', loja.fs, 'so o codigo do app (bundle compilado)', null],
  ['loja', 'loja', loja.fs, 'loja montada, sem a lista Orbit', null],
  ['orbit', 'orbit', orbit.fs, 'loja montada com a lista Orbit ligada', null],
  ['biblioteca', 'biblioteca', loja.fs, 'Biblioteca TorBox (montar + gravar), sem Orbit', 'loja'],
  ['biblioteca-orbit', 'biblioteca', orbit.fs, 'Biblioteca TorBox (montar + gravar), Orbit ligada', 'orbit'],
  ['formatos', 'formatos', orbit.fs, 'Descobrir formatos (TorBox ligado), Orbit ligada', 'orbit'],
  ['procurar', 'procurar', orbit.fs, 'Procurar no TorBox, Orbit ligada', 'orbit'],
  ['youtube', 'youtube', orbit.fs, 'uma pagina do YouTube, Orbit ligada', 'orbit'],
  ['exportar', 'exportar', orbit.fs, 'loja completa exportada ao payload (celular), Orbit ligada', 'orbit'],
  ['modulos', 'modulos', loja.fs, 'Fase 4: so os modulos da loja (local e pelo payload), nada montado', null],
  ['loja-modulos', 'loja-modulos', loja.fs, 'Fase 4: loja montada no app com os mesmos modulos, sem Orbit', null],
  ['orbit-modulos', 'loja-modulos', orbit.fs, 'Fase 4: loja montada no app com os mesmos modulos, Orbit ligada', null],
  // Fase 4: a loja aberta pelo catalogo do payload (respostas gravadas por tools/fase4/record.mjs com os mesmos dados)
  ['loja-remota', 'loja-remota', loja.fs, 'loja aberta pelo payload + 6 paginas da grade + um filtro, sem Orbit', null, REMOTE_LOJA],
  ['orbit-remota', 'loja-remota', loja.fs, 'loja aberta pelo payload + 6 paginas da grade + um filtro, Orbit ligada', null, REMOTE_ORBIT],
  ['busca-remota', 'busca-remota', loja.fs, 'loja aberta pelo payload + 3 paginas da busca "the", Orbit ligada', null, REMOTE_ORBIT],
  ['ficha-remota', 'ficha-remota', loja.fs, 'loja aberta pelo payload + 48 fichas (16 guardadas), Orbit ligada', null, REMOTE_ORBIT],
];
const wanted = process.argv.slice(2);
const mb = (kb) => (kb / 1024).toFixed(1).replace('.', ',');
const peaks = {};
for (const [name, scenario, fs, what, floor, remote] of ALL.filter(([name]) => !wanted.length || wanted.includes(name))) {
  if (remote) {
    if (!existsSync(remote)) { console.log(`${name.padEnd(17)} sem ${remote}: rode tools/fase4/record.mjs`); continue; }
    process.env.MEM_REMOTE = remote;
  }
  const result = peak(scenario, fs, (peaks[floor] ?? 1152) - 128);
  if (result.kb) peaks[name] = result.kb;
  console.log(result.error ? `${name.padEnd(17)} FALHOU: ${result.error}` : `${name.padEnd(17)} pico ${mb(result.kb).padStart(5)} MB  ${what} (${result.note})`);
}
