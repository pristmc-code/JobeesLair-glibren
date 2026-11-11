// glibren-a: o glibren abre a Jobe para tocar YouTube (app/state/tube-request.js): a capacidade (jobe-tube.txt), o
// pedido (abrir.txt: idade, linhas, voltar= invalido ignorado, apagado ao ler), a prioridade sobre a tela guardada
// (return-screen) e a volta ao glibren (POST /switch ao payload de fundo falso, depois o app fecha). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const tr = await load('app/state/tube-request.js');
const rs = await load('app/state/return-screen.js');

const NOW = 1_800_000_000_000;
const DIR = '/data/JobeesLair/tube';
const REQ = `${DIR}/abrir.txt`;
function memoryFs(entries = {}, times = {}) {
  const files = new Map(Object.entries(entries));
  const mtimes = new Map(Object.entries(times));
  return {
    files, mtimes, dirs: [],
    exists: (p) => files.has(p),
    stat: (p) => files.has(p) ? { name: p, isFile: true, isDirectory: false, size: Buffer.byteLength(files.get(p)), modified: mtimes.get(p) ?? NOW } : null,
    readFile(p) { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
    writeFile(p, text) { files.set(p, String(text)); },
    rename(from, to) { if (!files.has(from)) throw new Error(`ENOENT ${from}`); files.set(to, files.get(from)); files.delete(from); },
    remove(p) { files.delete(p); },
    mkdir(p) { this.dirs.push(p); },
  };
}

test('capacidade: grava jobe-tube.txt com a linha api=1 (.tmp + rename)', () => {
  const fs = memoryFs();
  assert.equal(tr.writeTubeCapability(fs, DIR), true);
  assert.equal(fs.files.get(`${DIR}/jobe-tube.txt`), 'api=1\n');
  assert.ok(!fs.files.has(`${DIR}/jobe-tube.txt.tmp`));
  assert.deepEqual(fs.dirs, [DIR]);
  const broken = { ...memoryFs(), writeFile() { throw new Error('read-only'); } };
  const lines = [];
  assert.equal(tr.writeTubeCapability(broken, DIR, { log: (line) => lines.push(line) }), false, 'nunca lanca');
  assert.match(lines[0], /read-only/);
});

test('pedido: busca na linha 1, voltar= e auto=1; lido uma vez e apagado (o .tmp largado tambem)', () => {
  const fs = memoryFs({ [REQ]: '﻿ASTRO BOT   trailer\r\nvoltar=PMGL00001\r\nauto=1\r\n', [`${REQ}.tmp`]: 'x' }, { [REQ]: NOW - 60_000 });
  assert.deepEqual(tr.takeTubeRequest(fs, DIR, { now: NOW }), { query: 'ASTRO BOT trailer', back: 'PMGL00001', auto: true });
  assert.ok(!fs.files.has(REQ) && !fs.files.has(`${REQ}.tmp`), 'apagado');
  assert.equal(tr.takeTubeRequest(fs, DIR, { now: NOW }), null, 'nada na segunda vez');
});

test('pedido: busca vazia (abre o teclado), sem auto; voltar= invalido ignorado; linhas desconhecidas ignoradas', () => {
  assert.deepEqual(tr.parseTubeRequest('\nauto=1\nvoltar=PMGL00001'), { query: '', back: 'PMGL00001', auto: false }, 'auto so com busca');
  for (const bad of ['voltar=pmgl00001', 'voltar=PMGL0001', 'voltar=PMGL00001; rm', 'voltar=../x', 'voltar=']) {
    assert.equal(tr.parseTubeRequest(`gta\n${bad}`).back, '', bad);
  }
  assert.deepEqual(tr.parseTubeRequest('gta\nqualquer=coisa\nauto=0\n\nVOLTAR = PPSA01234'), { query: 'gta', back: 'PPSA01234', auto: false });
  assert.deepEqual(tr.parseTubeRequest(''), { query: '', back: '', auto: false });
  assert.equal(tr.parseTubeRequest('a\tb\u0000c').query, 'a b c', 'controles viram espaco');
});

test('pedido: a busca e cortada em 200 bytes de UTF-8 sem partir caractere', () => {
  assert.equal(Buffer.byteLength(tr.parseTubeRequest('a'.repeat(300)).query), 200);
  const accented = tr.parseTubeRequest('ã'.repeat(150)).query; // 2 bytes cada
  assert.equal(accented, 'ã'.repeat(100));
  const emoji = tr.parseTubeRequest(`${'a'.repeat(198)}😀b`).query;
  assert.equal(emoji, 'a'.repeat(198), 'o emoji de 4 bytes nao cabe');
});

test('pedido: velho (10 min ou mais), data desconhecida ou do futuro demais: ignorado, mas apagado', () => {
  for (const [label, modified] of [['11 min', NOW - 11 * 60_000], ['futuro', NOW + 6 * 60_000], ['sem data', undefined]]) {
    const fs = memoryFs({ [REQ]: 'gta\nvoltar=PMGL00001' }, { [REQ]: modified });
    if (modified === undefined) fs.stat = () => ({ size: 10 });
    assert.equal(tr.takeTubeRequest(fs, DIR, { now: NOW }), null, label);
    assert.ok(!fs.files.has(REQ), `${label}: apagado`);
  }
  const fresh = memoryFs({ [REQ]: 'gta' }, { [REQ]: NOW - 9 * 60_000 });
  assert.deepEqual(tr.takeTubeRequest(fresh, DIR, { now: NOW }), { query: 'gta', back: '', auto: false }, '9 min ainda vale');
  const big = memoryFs({ [REQ]: 'x'.repeat(5000) });
  assert.equal(tr.takeTubeRequest(big, DIR, { now: NOW }), null, 'grande demais');
  assert.ok(!big.files.has(REQ));
});

test('prioridade: com pedido, a pilha abre na tela de YouTube e a tela guardada e apagada', () => {
  const RETURN = '/download0/JobeesLair/return-screen.json';
  const fs = memoryFs({ [REQ]: 'gta trailer\nvoltar=PMGL00001\nauto=1' });
  rs.saveReturnScreen(fs, RETURN, [{ name: 'browse' }, { name: 'game', id: 'PPSA01234' }], { now: NOW });
  // O que index.jsx restoreScreen faz (tube-request-run.js takeTubeStartStack, depois takeStartStack).
  const root = { name: 'browse' };
  const request = tr.takeTubeRequest(fs, DIR, { now: NOW });
  const stack = request ? (rs.forgetReturnScreen(fs, RETURN), tr.tubeRequestStack(request, root)) : rs.takeReturnScreen(fs, RETURN, root, { now: NOW });
  assert.deepEqual(stack, [root, { name: 'tube', query: 'gta trailer', auto: true, back: 'PMGL00001', ensure: true }]);
  assert.ok(!fs.files.has(RETURN), 'a tela guardada nao volta depois');
  assert.equal(rs.takeReturnScreen(fs, RETURN, root, { now: NOW }), null);
});

test('voltar: POST /switch {to, from} ao payload de fundo (falso) e o app fecha; recusado, nao fecha', async () => {
  const { createBackgroundDownloads } = await load('app/state/background-downloads.js');
  const TOKEN = 'a'.repeat(64);
  const calls = [];
  let accept = true;
  const http = {
    async request(url, { method = 'GET', headers = {}, body } = {}) {
      const route = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
      calls.push({ method, route, body: body ? JSON.parse(body) : undefined, token: headers['X-Jobe-Token'] });
      const respond = (status, data) => ({ status, ok: status < 300, json: async () => data });
      if (route === '/health') return respond(200, { ok: true, version: '1', api: 99, pid: 1 });
      if (method === 'POST' && route === '/switch') return accept ? respond(200, { ok: true }) : respond(409, { error: 'busy' });
      return respond(200, { ok: true, jobs: [] });
    }
  };
  const fs = { exists: () => true, readFile: () => TOKEN, writeFile() {}, mkdir() {}, rename() {}, remove() {}, stat: () => null, readDir: () => [] };
  const wrapper = createBackgroundDownloads({ downloads: { enqueue() {}, setRateLimit() {} }, http, fs, platform: 'desktop', on: () => true, payloads: null, log: () => {}, pollMs: 5, startWaitMs: 20 });
  const leaves = [];
  const leave = async (options) => leaves.push(options);
  const prepare = () => {};
  const ok = await tr.returnToCaller('PMGL00001', { from: 'PPSA99471', switchApp: wrapper.switchApp, leave, prepare });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(calls.filter((call) => call.route === '/switch').map(({ method, body, token }) => ({ method, body, token })), [{ method: 'POST', body: { to: 'PMGL00001', from: 'PPSA99471' }, token: TOKEN }]);
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0].prepare, prepare, 'a fila marcada para continuar, como na troca para o app de videos');
  accept = false;
  const refused = await tr.returnToCaller('PMGL00001', { from: 'PPSA99471', switchApp: wrapper.switchApp, leave });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /409/);
  assert.equal(leaves.length, 1, 'recusado: o app nao fecha');
  const thrown = await tr.returnToCaller('PMGL00001', { from: 'PPSA99471', switchApp: async () => { throw new Error('down'); }, leave });
  assert.deepEqual(thrown, { ok: false, error: 'down' });
});
