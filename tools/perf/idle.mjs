// glibren.45 (medidor do app parado): quantos quadros o app desenha por segundo e quanto de CPU ele usa sem ninguem
// mexer, na loja e na tela de Downloads, no preview do PC (ps5-react-preview, o mesmo JavaScript e o mesmo desenho por
// CPU do console). O preview imprime a cada 2 s uma linha "frame:" (ps5-react/native/shared/frame_stats.cpp): fps (voltas
// do laco), shown (quadros desenhados de fato: os que mudaram algo), cpu (nucleos ocupados), js (ms por quadro) e dirty
// (mil pixels redesenhados por quadro). Este script roda o preview com um roteiro de controle e tira a media de cada
// trecho:
//   loja ativa     os primeiros ~13 s parada na loja depois da abertura (antes do "ninguem mexe" de 15 s)
//   loja parada    de 17 s a 37 s sem mexer
//   downloads ...  o mesmo na tela de Downloads (R1 ate ela)
//
// Antes: compilar o preview (ps5-react: python3 tools/cli.py preview --app-dir ../app, ou cli.desktop()).
// Run (WSL, com WSLg): node tools/perf/idle.mjs [--r1 N] [--notes N] [--energy on|off] [--saver] [--out arquivo.txt]
//   --saver      depois, espera o protetor de tela (10 min parado) e mede 40 s dele (a execucao leva ~12 min)
//   --live-notes deixa o servico de recados (api.jobees.org) responder: ele troca os recados de teste pelos de verdade.
//                Sem isso, so ele (e o resto que nao e capa nem catalogo) passa por um proxy morto, e os recados ficam.
//   --r1 N       quantos R1 da loja ate Downloads (padrao 6)
//   --notes N    grava N recados no online.json do sandbox antes de abrir (padrao 2: a faixa troca entre eles)
//   --energy     liga/desliga "Economizar energia" no settings.json do sandbox antes de abrir (padrao: nao mexe)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const R1 = Number(opt('r1', 6));
const NOTES = Number(opt('notes', 2));
const ENERGY = opt('energy', '');
const OUT = opt('out', '');
const build = path.join(repo, 'ps5-react/.build/app');
// --preview/--bundle: outro binario e bundle (por exemplo uma copia da versao anterior, para comparar).
const PREVIEW = opt('preview', path.join(build, 'desktop/ps5-react-preview'));
const BUNDLE = opt('bundle', path.join(build, 'generated/1920x1080/app.bundle.js'));
const SANDBOX = opt('sandbox', path.join(build, 'sandbox'));
for (const file of [PREVIEW, BUNDLE]) if (!existsSync(file)) throw new Error(`${file} not found: build the preview first`);

const data = path.join(SANDBOX, 'download0/JobeesLair');
// Os recados: como o online.json os guarda da ultima abertura (state/online.js); o servico de verdade pode troca-los.
if (NOTES >= 0) {
  const file = path.join(data, 'online.json');
  let online = {};
  try { online = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  online.notes = Array.from({ length: NOTES }, (_, i) => ({ id: 9000 + i, text: i ? 'Second note for the measurement: it takes turns with the first.' : 'Daily server updates: the catalog is refreshed every day, new games arrive in the evening.', level: 'info', until: null }));
  writeFileSync(file, JSON.stringify(online));
}
if (ENERGY) {
  const file = path.join(data, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  settings.energySaver = ENERGY === 'on';
  writeFileSync(file, JSON.stringify(settings));
}

// O roteiro: abertura (intro, aviso de termos com X), loja, Downloads. "shot:" so marca o trecho no log.
const SEGMENTS = [];
const steps = ['wait:4500', 'confirm', 'wait:9000'];
const segment = (name, ms) => { steps.push(`shot:perf_${name}`, `wait:${ms}`); SEGMENTS.push(name); };
segment('loja_ativa', 13000);
steps.push('wait:4000');
segment('loja_parada', 20000);
steps.push('shot:perf_fim', 'up', 'wait:600', ...Array(R1).fill('r1'), 'wait:2500');
segment('downloads_ativa', 13000);
steps.push('wait:4000');
segment('downloads_parada', 20000);
// --saver: espera o protetor de tela (10 min sem botao, conferido a cada 15 s: state/screen-saver.js) e mede 40 s dele.
if (args.includes('--saver')) {
  steps.push('shot:perf_fim', `wait:${10 * 60e3 + 20e3 - 37e3}`);
  segment('protetor_de_tela', 40000);
}
steps.push('shot:perf_fim', 'quit');

// Os recados de teste ficam: o servico online sai por um proxy que nao responde; capas, banners e catalogos nao.
const OPEN = 'image.api.playstation.com,raw.githubusercontent.com,github.com,objects.githubusercontent.com,codeload.github.com,archive.org,i.ytimg.com';
const net = args.includes('--live-notes') ? {} : { https_proxy: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', no_proxy: OPEN, NO_PROXY: OPEN };
const child = spawn(PREVIEW, [BUNDLE], { cwd: path.dirname(PREVIEW), env: { ...process.env, ...net, PS5_REACT_SANDBOX: SANDBOX, PS5_REACT_INPUT_SCRIPT: steps.join(',') } });
// O roteiro termina com quit; um preview que nao fecha (visto uma vez) e encerrado 60 s depois do tempo previsto.
const planned = steps.reduce((sum, step) => sum + (/^wait:(\d+)$/.exec(step)?.[1] ?? 0) * 1, 0);
const guard = setTimeout(() => child.kill('SIGKILL'), planned + 60e3);
let text = '';
child.stdout.on('data', (chunk) => { text += chunk; });
child.stderr.on('data', (chunk) => { text += chunk; });
const code = await new Promise((resolve) => child.on('close', resolve));
clearTimeout(guard);

const rows = {};
let current = null;
for (const line of text.split('\n')) {
  const mark = /script: shot:perf_(\w+)/.exec(line);
  if (mark) { current = mark[1] === 'fim' ? null : mark[1]; continue; }
  const frame = /\] frame: (.*)$/.exec(line);
  if (!frame || !current) continue;
  const num = (re) => Number(re.exec(frame[1])?.[1] ?? NaN);
  (rows[current] ??= []).push({ fps: num(/fps=([\d.]+)/), shown: num(/shown=([\d.]+)/), cpu: num(/cpu=([\d.]+) cores/), js: num(/ js=([\d.]+)/), dirty: num(/dirty=(\d+)kpx/), raster: num(/raster=([\d.]+)/) });
}
const avg = (list, key) => { const v = list.map((r) => r[key]).filter((n) => !Number.isNaN(n)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
const lines = [`preview saiu com ${code}; ${new Date().toISOString()}; notes=${NOTES}${args.includes('--live-notes') ? ' (servico ao vivo)' : ''} energy=${ENERGY || '-'}`,
  'trecho              janelas  fps(laco)  shown/s  cpu(nucleos)  js ms/q  raster ms/q  dirty kpx/q'];
for (const name of SEGMENTS) {
  const list = (rows[name] ?? []).slice(1); // a 1a janela pega a troca de trecho
  const f = (key, d = 1) => avg(list, key).toFixed(d).padStart(9);
  lines.push(`${name.padEnd(18)} ${String(list.length).padStart(5)}  ${f('fps')}  ${f('shown')}  ${f('cpu', 2)}     ${f('js', 2)}    ${f('raster', 2)}    ${f('dirty', 0)}`);
}
console.log(lines.join('\n'));
if (OUT) writeFileSync(OUT, `${lines.join('\n')}\n\n--- log ---\n${text}`);
