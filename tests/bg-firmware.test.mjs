// glibren.54 (1o diagnostico real, 13/11): o app lia 13.090.001 (sceKernelGetSystemSwVersion no processo dele) num PS5 12.00.
// O payload le o firmware de verdade (kernel_get_fw_version, como o glibren; no PC: BGDL_FIRMWARE), grava <dir>/firmware ao
// subir e diz no /health ("firmware"); o app (state/device.js) usa esse ja na abertura (o arquivo) e depois do /health, e
// guarda o que o processo dele via (appFirmware, no log). Sem o payload, o do app, como antes.
// Run: node --import ./tests/stub-loader.mjs --test tests/bg-firmware.test.mjs
import test, { after, before as whenBuilt } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortFrom } from './free-port.mjs';
import { assertBuilt, buildSkip, compileTo } from './payload-build.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(path.join(os.tmpdir(), 'jl-fw-'));
after(() => rmSync(work, { recursive: true, force: true }));
const binary = path.join(work, 'payload');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
const skip = buildSkip(compiler, built);
whenBuilt(() => { if (!skip) assertBuilt(built); });
const ports = freePortFrom(8); // bloco de portas so deste arquivo (tests/free-port.mjs)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('o payload diz o firmware de verdade no /health e grava <dir>/firmware', { skip, timeout: 60000 }, async () => {
  const state = path.join(work, 'state');
  mkdirSync(state, { recursive: true });
  const [api, monitor] = [await ports(), await ports()];
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: state, BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor), BGDL_FIRMWARE: '12.00',
    BGDL_ORBIT_DIR: path.join(work, 'orbit'), BGDL_LIBRARY: path.join(work, 'lista.json'), BGDL_NOTIFY_FILE: path.join(work, 'notify.txt'), BGDL_STORE_DIR: path.join(work, 'store'),
    BGDL_CATALOG_FIRST_MS: '600000' }, stdio: 'ignore' });
  try {
    let token = '';
    for (let i = 0; i < 200 && !token; i++) { try { token = readFileSync(path.join(state, 'token'), 'utf8').trim(); } catch { await wait(50); } }
    let health = null;
    for (let i = 0; i < 100 && !health; i++) { try { health = await (await fetch(`http://127.0.0.1:${api}/health`, { headers: { 'X-Jobe-Token': token } })).json(); } catch { await wait(50); } }
    assert.equal(health.firmware, '12.00');
    assert.equal(health.api, 37);
    assert.equal(readFileSync(path.join(state, 'firmware'), 'utf8'), '12.00');
  } finally {
    child.kill('SIGTERM');
  }
});

test('o app usa o firmware do payload (arquivo na abertura, /health depois) e guarda o que ele mesmo via', async () => {
  // o FileSystem de mentira (tests/stub-loader.mjs) le de globalThis.__stubFiles
  const file = '/data/teste/firmware';
  globalThis.__stubFiles = globalThis.__stubFiles ?? new Map();
  globalThis.__stubFiles.set(file, '12.00\n');
  globalThis.__jobeFirmwareFile = file;
  const core = await import('@ps5-react/core');
  const before = core.DeviceInfo.get;
  core.DeviceInfo.get = () => ({ language: 'pt-BR', firmware: '13.090.001', model: 'x' });
  try {
    const device = await import('../app/state/device.js');
    assert.equal(device.payloadFirmware(), '12.00');
    const facts = device.deviceFacts();
    assert.equal(facts.firmware, '12.00');
    assert.equal(facts.appFirmware, '13.090.001');
    assert.equal(device.setConsoleFirmware('12.00'), false, 'igual: nada muda');
    assert.equal(device.setConsoleFirmware('13.090.001'), false, 'so "NN.NN"');
    assert.equal(device.setConsoleFirmware('11.60'), true);
    assert.equal(device.deviceFacts().firmware, '11.60');
    const { ps5FakePackagesLaunch } = await import('../app/state/firmware.js');
    assert.equal(ps5FakePackagesLaunch(device.deviceFacts().firmware), true, 'a regra das fake packages segue o firmware de verdade');
  } finally {
    core.DeviceInfo.get = before;
    delete globalThis.__jobeFirmwareFile;
  }
});
