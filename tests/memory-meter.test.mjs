// glibren (medidor de memoria): app/state/memory-meter.js. O pico global e o de cada tela/acao, as 10 maiores, a linha
// no log a cada degrau novo (1 MB) e o aviso acima de 85% do limite (uma vez ate voltar abaixo de 80%), sem guardar
// historico; um host sem DeviceInfo.memory nao mede nada. Run: node --import ./tests/stub-loader.mjs --test tests/memory-meter.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const { MB, createMemoryMeter, memorySample, memorySnapshot } = await import(pathToFileURL(path.join(repo, 'app/state/memory-meter.js')).href);

// Um host de mentira: `used` em MB, limite de 32 MB.
function fake({ limit = 32 } = {}) {
  const host = { used: 10, process: null };
  const lines = [];
  const meter = createMemoryMeter({
    read: () => ({ heapUsed: Math.round(host.used * MB), heapLimit: limit * MB, processUsed: host.process, processSize: host.process == null ? null : 256 * MB }),
    write: (line, level = 'INFO') => lines.push(`${level} ${line}`),
    now: () => 1000
  });
  return { host, lines, meter };
}

test('the peak stays the highest sample, with the action it was taken in', () => {
  const { host, meter } = fake();
  meter.sample('tela:browse');
  host.used = 21.4;
  meter.sample('loja:montar');
  host.used = 15;
  meter.sample('tela:game');
  const { last, peak } = meter.snapshot();
  assert.equal(last.action, 'tela:game');
  assert.equal(last.used, 15 * MB);
  assert.equal(peak.action, 'loja:montar');
  assert.equal(peak.used, Math.round(21.4 * MB));
  assert.equal(peak.limit, 32 * MB);
});

test('a log line only when a new peak passes another 1 MB step', () => {
  const { host, lines, meter } = fake();
  meter.sample('inicio'); // 10 MB: o primeiro degrau
  host.used = 10.6;
  meter.sample('a'); // pico novo, mesmo degrau: nada
  host.used = 9;
  meter.sample('b'); // abaixo do pico: nada
  host.used = 12.2;
  meter.sample('c'); // degrau 12
  host.used = 12.9;
  meter.sample('d'); // mesmo degrau
  assert.deepEqual(lines, ['INFO memoria: pico 10,0 de 32,0 MB em inicio', 'INFO memoria: pico 12,2 de 32,0 MB em c']);
});

test('a warning past 85% of the limit, once until the use goes back under 80%', () => {
  const { host, lines, meter } = fake();
  host.used = 27.3;
  host.process = 180 * MB;
  meter.sample('biblioteca-torbox:montar');
  host.used = 28;
  meter.sample('biblioteca-torbox:montar');
  const warnings = () => lines.filter((line) => line.startsWith('WARN'));
  assert.deepEqual(warnings(), ['WARN memoria: 27,3 de 32,0 MB em biblioteca-torbox:montar (acima de 85% do limite) (processo 180,0 de 256,0 MB)']);
  host.used = 26; // ainda acima de 80%: nao rearma
  meter.sample('x');
  host.used = 28;
  meter.sample('y');
  assert.equal(warnings().length, 1);
  host.used = 20; // abaixo de 80%: rearma
  meter.sample('z');
  host.used = 27.5;
  meter.sample('w');
  assert.equal(warnings().length, 2);
  assert.match(warnings()[1], /27,5 de 32,0 MB em w/);
});

test('the top 10 by peak, largest first; each name keeps its own highest sample', () => {
  const { host, meter } = fake({ limit: 64 });
  for (let i = 1; i <= 14; i++) {
    host.used = i;
    meter.sample(`acao-${i}`);
  }
  host.used = 3;
  meter.sample('acao-14'); // mais baixo que o pico dela: fica o 14
  const { top } = meter.snapshot();
  assert.equal(top.length, 10);
  assert.deepEqual(top.map((item) => item.action), Array.from({ length: 10 }, (_, i) => `acao-${14 - i}`));
  assert.equal(top[0].used, 14 * MB);
});

test('at most `keep` names are kept: the smallest goes, never the one just sampled', () => {
  const lines = [];
  let used = 0;
  const meter = createMemoryMeter({ read: () => ({ heapUsed: used, heapLimit: 0 }), write: (line) => lines.push(line), keep: 3, top: 10 });
  for (const [name, value] of [['a', 5], ['b', 9], ['c', 7], ['d', 1]]) {
    used = value * MB;
    meter.sample(name);
  }
  assert.deepEqual(meter.snapshot().top.map((item) => item.action), ['b', 'c', 'd']);
});

test('samples without an action take the screen set as context', () => {
  const { meter } = fake();
  meter.setContext('tela:settings');
  meter.sample();
  assert.equal(meter.snapshot().last.action, 'tela:settings');
});

test('nothing is measured when the host has no reading, and a failing read never throws', () => {
  let calls = 0;
  const meter = createMemoryMeter({ read: () => (calls++ === 0 ? null : (() => { throw new Error('host'); })()) });
  assert.equal(meter.sample('a'), null);
  assert.equal(meter.sample('b'), null);
  assert.deepEqual(meter.snapshot(), { last: null, peak: null, top: [] });
  // O medidor do app num host sem DeviceInfo.memory (o stub dos testes): nada.
  assert.equal(memorySample('tela:browse'), null);
  assert.equal(memorySnapshot().peak, null);
});
