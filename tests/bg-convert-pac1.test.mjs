// pac1: o payload (app/native/bg_downloader.c + bg_convert.c) compilado para o PC e rodado de verdade:
//   - a pausa entre conversoes (POST /config "convertPauseSeconds"; GET /convert e /api/status dizem quanto falta);
//   - o limite de escrita da conversao (POST /config "convertWriteLimit", MB/s);
//   - as duas opcoes gravadas no config.json e de volta depois de reiniciar (padrao 0 = desligadas);
//   - os marcos da conversao no bgdl.log ("[marco]": inicio, origem, arquivo criado, escrita, progresso, fsync, rename,
//     ShadowMount+, fim);
//   - a queda da sessao anterior: last-crash.json (ate 4 KB, ultimas linhas, o que fazia, o ultimo marco) e GET /crash.
// Tempos curtos: pausa de 2 s, limite de 4 MB/s, marco de progresso a cada 1 MiB (BGDL_MARK_BYTES).
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortFrom } from './free-port.mjs';
import { before as whenBuilt } from 'node:test';
import { assertBuilt, buildSkip, compileTo } from './payload-build.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-pac1-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l(?:curl|crypto|archive)/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : false;
// glibren.51: um binario que nao compilou (erro, aviso com -Werror ou o compilador morto por sinal) FALHA todos os
// testes deste arquivo na hora, com o motivo; antes eles viravam "pulados" e ninguem via. So a falta do ambiente pula.
whenBuilt(() => { if (!skip) assertBuilt(built); });
const MiB = 1024 * 1024;
const children = new Set();
// glibren.49: um teste que falhou no meio (maquina carregada) deixava o payload dele no ar segurando a porta da API, e
// todos os seguintes deste arquivo falhavam com "payload did not start" (16 falhas em cascata na .48). Cada teste
// comeca sem nenhum payload de antes.
beforeEach(async () => {
  const left = [...children];
  for (const child of left) child.kill('SIGKILL');
  await Promise.all(left.map((child) => child.exitCode !== null || child.signalCode ? null : new Promise((resolve) => child.once('exit', resolve))));
});
let smp, smpPort;
after(() => {
  for (const child of children) child.kill('SIGKILL');
  smp?.closeAllConnections?.();
  smp?.close();
  rmSync(dir, { recursive: true, force: true });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = freePortFrom(1); // glibren.41 (T1): bloco de portas so deste arquivo (tests/free-port.mjs)
let api, monitorPort;
if (!skip) {
  api = await freePort();
  monitorPort = await freePort();
  smpPort = await freePort();
  smp = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":0,"queued":true}');
  }).listen(smpPort, '127.0.0.1');
}

let run = 0;
// Um teste que falhou no meio deixa o payload dele no ar (com a porta): o proximo comeca sem nenhum.
async function workspace() {
  await Promise.all([...children].map((child) => stop(child, 'SIGKILL')));
  const base = path.join(dir, `run${++run}`);
  mkdirSync(path.join(base, 'state'), { recursive: true });
  mkdirSync(path.join(base, 'disk/homebrew'), { recursive: true });
  mkdirSync(path.join(base, 'disk/downloads/extracted'), { recursive: true });
  return base;
}
function start(base, env = {}) {
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitorPort),
    BGDL_SMP_BASE: `http://127.0.0.1:${smpPort}/api/v1`, BGDL_BACKUP_ROOTS: path.join(base, 'disk'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
const stop = (child, signal = 'SIGTERM') => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill(signal); });
async function call(base, method, route, body) {
  const tok = readFileSync(path.join(base, 'state/token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': tok, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
// glibren.49: prazo largo pelo relogio monotonico (com a suite inteira em paralelo subir passa de 5 s) e, se nao subir,
// o fim do diario do payload na mensagem.
async function up(base, ms = 30000) {
  for (const end = performance.now() + ms; performance.now() < end; await wait(50)) {
    try { if (existsSync(path.join(base, 'state/token')) && (await call(base, 'GET', '/health')).status === 200) return; } catch {}
  }
  let tail = '';
  try { tail = readFileSync(path.join(base, 'state/bgdl.log'), 'utf8').split('\n').slice(-15).join('\n'); } catch {}
  throw new Error(`payload did not start:\n${tail}`);
}
const conversion = async (base, id) => (await call(base, 'GET', '/convert')).data.conversions.find((item) => item.id === id);
async function until(base, id, states, check = () => true, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(25)) {
    let item;
    try { item = await conversion(base, id); } catch { continue; }
    if (item && states.includes(item.state) && check(item)) return item;
  }
  throw new Error(`conversion ${id} never reached ${states}: ${JSON.stringify(await conversion(base, id).catch(() => null))}`);
}
function gameFolder(at, mib) {
  mkdirSync(path.join(at, 'sce_sys'), { recursive: true });
  writeFileSync(path.join(at, 'eboot.bin'), randomBytes(64 * 1024));
  writeFileSync(path.join(at, 'sce_sys/param.json'), '{"titleId":"PPSA01234","contentVersion":"01.000.000"}');
  writeFileSync(path.join(at, 'big.bin'), randomBytes(mib * MiB));
}
function request(base, n, mib = 2) {
  const work = path.join(base, `disk/downloads/extracted/G${n}`);
  gameFolder(work, mib);
  return { key: `PPSA0123${n}/rel`, name: `Jogo ${n}`, label: `PPSA0123${n}`, kind: 'dir', source: work, work, root: path.join(base, 'disk'), output: path.join(base, `disk/homebrew/PPSA0123${n}.exfat`) };
}
const log = (base) => readFileSync(path.join(base, 'state/bgdl.log'), 'utf8');

test('pac1: payload compila sem avisos', { skip: !compiler || missing ? 'no compiler or headers' : false }, () => {
  assert.equal(built.status, 0, built.stderr);
});

test('pac1: pausa entre conversoes respeitada, visivel no GET /convert e no celular; opcoes no config.json (padrao 0)', { skip }, async () => {
  const base = await workspace();
  let child = start(base);
  await up(base);
  // Padrao: as duas desligadas.
  let health = (await call(base, 'GET', '/health')).data;
  assert.equal(health.convertPauseSeconds, 0);
  assert.equal(health.convertWriteLimit, 0);
  assert.equal(health.crash, false, 'diario novo: nenhuma queda');
  // Fora da faixa: recusado.
  assert.equal((await call(base, 'POST', '/config', { convertPauseSeconds: 3601 })).status, 400);
  assert.equal((await call(base, 'POST', '/config', { convertWriteLimit: 2001 })).status, 400);
  const set = await call(base, 'POST', '/config', { convertPauseSeconds: 2 });
  assert.equal(set.status, 200);
  assert.equal(set.data.convertPauseSeconds, 2);
  const first = await call(base, 'POST', '/convert', request(base, 1));
  const second = await call(base, 'POST', '/convert', request(base, 2));
  await until(base, first.data.id, ['done'], () => true);
  const doneAt = performance.now(); // glibren.49: monotonico (o Date.now do WSL atrasa sob carga)
  // Logo depois da primeira: a segunda espera (o app e o celular veem quanto falta).
  let list = (await call(base, 'GET', '/convert')).data;
  for (let i = 0; i < 40 && !list.waitSeconds; i++) { await wait(25); list = (await call(base, 'GET', '/convert')).data; }
  assert.equal(list.conversions.find((item) => item.id === second.data.id).state, 'queued');
  assert.ok(list.waitSeconds >= 1 && list.waitSeconds <= 2, `waitSeconds ${list.waitSeconds}`);
  assert.equal(list.pauseSeconds, 2);
  const phone = await (await fetch(`http://127.0.0.1:${monitorPort}/api/status`)).json();
  assert.ok(phone.convertWaitSeconds >= 1, `convertWaitSeconds ${phone.convertWaitSeconds}`);
  await until(base, second.data.id, ['converting', 'verifying', 'done'], () => true);
  assert.ok(performance.now() - doneAt >= 1500, `a segunda comecou ${Math.round(performance.now() - doneAt)} ms depois da primeira`);
  await until(base, second.data.id, ['done']);
  assert.equal((await call(base, 'GET', '/convert')).data.waitSeconds, 0, 'sem nada na fila, nada a esperar');
  assert.match(log(base), /pausa entre conversoes: Jogo 2 comeca em \d+ s/);
  // Gravada no config.json e de volta depois de reiniciar.
  assert.equal((await call(base, 'POST', '/config', { convertWriteLimit: 7 })).status, 200);
  const saved = JSON.parse(readFileSync(path.join(base, 'state/config.json'), 'utf8'));
  assert.equal(saved.convertPauseSeconds, 2);
  assert.equal(saved.convertWriteLimit, 7);
  await stop(child);
  child = start(base);
  await up(base);
  health = (await call(base, 'GET', '/health')).data;
  assert.equal(health.convertPauseSeconds, 2);
  assert.equal(health.convertWriteLimit, 7);
  // Desligar a pausa vale na hora.
  assert.equal((await call(base, 'POST', '/config', { convertPauseSeconds: 0, convertWriteLimit: 0 })).data.convertPauseSeconds, 0);
  await stop(child);
});

test('pac1: limite de escrita da conversao aplicado (4 MB/s) e marcos da conversao no diario', { skip }, async () => {
  const base = await workspace();
  const child = start(base, { BGDL_MARK_BYTES: String(MiB) });
  await up(base);
  assert.equal((await call(base, 'POST', '/config', { convertWriteLimit: 4 })).status, 200);
  // Relogio monotonico: o Date.now() do WSL anda para tras sob carga (ate -1,1 s visto).
  const started = performance.now();
  const r = await call(base, 'POST', '/convert', request(base, 3, 16));
  const done = await until(base, r.data.id, ['done']);
  const took = Math.round(performance.now() - started);
  // ~16 MiB de dados a 4 MiB/s: ~4 s (sem limite, bem menos de 1 s aqui); a primeira janela pode passar inteira.
  assert.ok(took >= 2000, `levou ${took} ms com o limite`);
  assert.equal(done.written, done.total);
  // O "done" aparece antes do pedido ao ShadowMount+ e do ultimo marco.
  for (let i = 0; i < 100 && !log(base).includes(`conversao ${r.data.id} [marco] fim: pronta`); i++) await wait(50);
  const text = log(base);
  const marks = text.split('\n').filter((line) => line.includes(`conversao ${r.data.id} [marco] `)).map((line) => line.slice(line.indexOf('[marco] ') + 8));
  const order = [/^inicio: Jogo 3 \(dir\); origem .*G3; destino .*PPSA01233\.exfat/, /^origem aberta \(pasta\): \d+ entradas/, /^plano: imagem [\d.]+ GB, dados [\d.]+ GB/,
    /^arquivo \.exfat criado: .*PPSA01233\.exfat\.part/, /^escrita do exFAT: inicio dos dados/, /^escrita do exFAT: [\d.]+ GB de [\d.]+ GB \([\d.]+ MB\/s\)/,
    /^escrita do exFAT: fim dos dados/, /^fsync da imagem/, /^imagem fechada$/, /^conferindo a imagem/, /^renomeada: /, /^ShadowMount\+: POST http:\/\/127\.0\.0\.1:\d+\/api\/v1\/scan/,
    /^ShadowMount\+: resposta ok, HTTP 200/, /^fim: pronta/];
  let at = 0;
  for (const pattern of order) {
    const found = marks.findIndex((mark, index) => index >= at && pattern.test(mark));
    assert.ok(found >= 0, `marco ${pattern} (em ordem) em:\n${marks.join('\n')}`);
    at = found;
  }
  // O writer le e grava em blocos de 4 MiB: com o marco a cada 1 MiB, um por bloco (no console, 1 GiB).
  assert.ok(marks.filter((mark) => /^escrita do exFAT: [\d.]+ GB de/.test(mark)).length >= 3, 'progresso a cada 1 MiB');
  assert.match(text, /limite de escrita da conversao: 0 -> 4 MB\/s/);
  // O disco de destino e o de origem (tipo do sistema de arquivos, livre e total).
  assert.ok(marks.some((mark) => /^disco de destino: .*disk \([\w.]+, livre [\d.]+ GB de [\d.]+ GB\)$/.test(mark)), marks.join('\n'));
  assert.ok(marks.some((mark) => /^disco de origem: .*G3 \([\w.]+, livre [\d.]+ GB de [\d.]+ GB\)$/.test(mark)), marks.join('\n'));
  assert.ok(marks.includes('limite de escrita: 4 MB/s'));
  // "Gravar em pedacos" desligado (padrao): nenhum marco de fsync em pedacos.
  assert.ok(!marks.some((mark) => mark.startsWith('gravar em pedacos')), 'desligado, sem fsync em pedacos');
  await stop(child);
});

test('pac1: gravar em pedacos (convertSyncMB): fsync a cada N MB com o tempo de cada um; gravado no config.json', { skip }, async () => {
  const base = await workspace();
  let child = start(base);
  await up(base);
  assert.equal((await call(base, 'GET', '/health')).data.convertSyncMB, 0, 'padrao desligado');
  assert.equal((await call(base, 'POST', '/config', { convertSyncMB: 4097 })).status, 400);
  const set = await call(base, 'POST', '/config', { convertSyncMB: 1 });
  assert.equal(set.data.convertSyncMB, 1);
  const r = await call(base, 'POST', '/convert', request(base, 5, 16));
  await until(base, r.data.id, ['done']);
  const marks = log(base).split('\n').filter((line) => line.includes(`conversao ${r.data.id} [marco] `)).map((line) => line.slice(line.indexOf('[marco] ') + 8));
  assert.ok(marks.includes('gravar em pedacos: fsync a cada 1 MB'), marks.join('\n'));
  const syncs = marks.filter((mark) => /^gravar em pedacos: fsync em [\d.]+ GB levou \d+ ms$/.test(mark));
  // A escrita sai em blocos de 4 MiB: com 1 MB, um fsync por bloco (16 MiB de dados: 4 ou mais).
  assert.ok(syncs.length >= 4, `fsync a cada 1 MiB (16 MiB de dados): ${syncs.length}`);
  assert.equal(JSON.parse(readFileSync(path.join(base, 'state/config.json'), 'utf8')).convertSyncMB, 1);
  await stop(child);
  child = start(base);
  await up(base);
  assert.equal((await call(base, 'GET', '/health')).data.convertSyncMB, 1, 'de volta depois de reiniciar');
  await stop(child);
});

test('pac1: queda no meio da conversao -> last-crash.json (<= 4 KB) com o ultimo marco, GET /crash; saida limpa nao grava outra', { skip }, async () => {
  const base = await workspace();
  let child = start(base, { BGDL_MARK_BYTES: String(MiB), BGDL_CONVERT_DELAY_MS: '60' });
  await up(base);
  assert.deepEqual((await call(base, 'GET', '/crash')).data, { crash: null });
  const body4 = request(base, 4, 8);
  const r = await call(base, 'POST', '/convert', body4);
  await until(base, r.data.id, ['converting'], (item) => item.written >= 2 * MiB);
  await stop(child, 'SIGKILL'); // o console "caiu": nenhuma linha de saida limpa
  child = start(base);
  await up(base);
  const health = (await call(base, 'GET', '/health')).data;
  assert.equal(health.crash, true);
  const file = path.join(base, 'state/last-crash.json');
  assert.ok(statSync(file).size <= 4096, `last-crash.json com ${statSync(file).size} bytes`);
  const { crash } = (await call(base, 'GET', '/crash')).data;
  assert.ok(crash && /^\d+$/.test(crash.id), JSON.stringify(crash));
  assert.equal(crash.activity, 'convert');
  assert.equal(crash.name, 'Jogo 4');
  assert.match(crash.milestone, /^escrita do exFAT: [\d.]+ GB de [\d.]+ GB/);
  assert.match(crash.lastTime, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.ok(crash.lastAt > 0 && crash.upAt >= crash.lastAt, `${crash.upAt} ${crash.lastAt}`);
  assert.ok(Array.isArray(crash.lines) && crash.lines.length > 0 && crash.lines.length <= 20);
  assert.equal(crash.lastLine, crash.lines.at(-1));
  assert.ok(!crash.lines.some((line) => line.includes('saida limpa')));
  assert.match(log(base), /queda anterior registrada em last-crash\.json: convert de Jogo 4; ultimo marco: escrita do exFAT/);
  // A conversao fica segurada (falhou: interrompida) ate Converter de novo; reenviada, termina.
  // Depois uma saida limpa: a proxima subida nao registra queda nova.
  const held = await until(base, r.data.id, ['failed', 'done', 'converting']);
  assert.equal(held.state, 'failed', 'segurada, nao recomecou sozinha');
  assert.match(held.error, /^interrupted:/);
  assert.equal((await call(base, 'POST', '/convert', body4)).data.id, r.data.id);
  await until(base, r.data.id, ['done']);
  await stop(child);
  child = start(base);
  await up(base);
  assert.equal((await call(base, 'GET', '/health')).data.crash, false);
  assert.equal((await call(base, 'GET', '/crash')).data.crash.id, crash.id, 'o arquivo da queda fica ate a proxima');
  await stop(child);
});

test('pac1: queda sem nada rodando -> activity "none", sem marco; linhas longas cortadas', { skip }, async () => {
  const base = await workspace();
  const long = 'x'.repeat(2000);
  const lines = Array.from({ length: 40 }, (_, i) => `2026-11-11 14:${String(i).padStart(2, '0')}:05 linha ${i} ${i === 39 ? long : ''}`);
  // Um marco antigo no diario (de uma conversao que terminou): nao conta sem conversao rodando.
  lines.splice(10, 0, '2026-11-11 14:09:59 conversao c1 [marco] fim: pronta');
  writeFileSync(path.join(base, 'state/bgdl.log'), `${lines.join('\n')}\n`);
  const child = start(base);
  await up(base);
  const { crash } = (await call(base, 'GET', '/crash')).data;
  assert.equal(crash.activity, 'none');
  assert.equal(crash.name, '');
  assert.equal(crash.milestone, '');
  assert.equal(crash.lastTime, '2026-11-11 14:39:05');
  assert.ok(crash.lines.length <= 20);
  assert.ok(crash.lastLine.length <= 200 && crash.lastLine.startsWith('2026-11-11 14:39:05 linha 39'));
  assert.ok(statSync(path.join(base, 'state/last-crash.json')).size <= 4096);
  await stop(child);
});
