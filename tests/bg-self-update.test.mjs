// glibren.49 (Fase 2 do modelo Orbit): o payload se atualiza sozinho, com assinatura (app/native/bg_self.c).
// O payload e compilado para o PC em varias versoes (BG_VERSION/BG_API/BG_MIN_APP_API) e roda de verdade contra um
// GitHub falso (matching-refs + releases/download) e um elfldr falso (recebe o ELF pela porta e o executa, como o
// carregador do PS5). As chaves Ed25519 sao geradas na hora (nada da chave real). Casos: assinatura valida instala e
// troca quando ocioso (e a proxima subida escolhe o baixado); .sig ausente, de outra chave ou sem o prefixo de dominio
// recusados; sha256/tamanho errados; versao mais velha (ou igual) que a embutida ignorada; uma versao que nao sobe 2x
// vira ruim e a anterior (ou a embutida) sobe; troca segurada com download ou conversao rodando; compatibilidade de API
// (minAppApi); "Voltar ao payload embutido" pela pagina do celular (PIN) e pela API do app.
// Tambem: o ps5/jobe/ferramentas/publicar_bg.py (com PS5_BASE) gera um manifesto que este payload aceita.
// Precisa de cc, libcurl, OpenSSL e libarchive; sem eles, pulado. Run: npm test
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortFrom } from './free-port.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-self-'));
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const source = path.join(repo, 'app/native/bg_downloader.c');
// As versoes do payload usadas nos testes (o "base" e o embutido do app: o BG_VERSION do fonte).
const VARIANTS = {
  base: [],
  v1335: ['-DBG_VERSION="1.33.5"'],
  v1329: ['-DBG_VERSION="1.32.9"'],
  api35min33: ['-DBG_VERSION="1.40.0"', '-DBG_API=35', '-DBG_MIN_APP_API=33'],
  api35min34: ['-DBG_VERSION="1.40.0"', '-DBG_API=35', '-DBG_MIN_APP_API=34'],
  api32: ['-DBG_VERSION="1.40.0"', '-DBG_API=32', '-DBG_MIN_APP_API=32']
};
const bin = (name) => path.join(dir, `bgdl-${name}`);
const compile = (name, flags) => new Promise((resolve) => {
  const child = spawn(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', ...flags, '-o', bin(name), source, '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('exit', (code) => resolve({ name, code, err }));
});
let skip = !compiler ? 'no C compiler' : false;
if (!skip) {
  const results = await Promise.all(Object.entries(VARIANTS).map(([name, flags]) => compile(name, flags)));
  const failed = results.find((r) => r.code !== 0);
  if (failed) skip = /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/.test(failed.err) ? 'no libcurl/OpenSSL/libarchive headers' : `did not compile (${failed.name}): ${failed.err.slice(0, 400)}`;
  // Um "payload" que cai na subida (a versao ruim): sai na hora.
  writeFileSync(path.join(dir, 'bad.c'), 'int main(void) { return 3; }\n');
  if (!skip && spawnSync(compiler, ['-o', bin('bad'), path.join(dir, 'bad.c')]).status !== 0) skip = 'the bad stand-in did not compile';
}
const BASE_VERSION = /#define BG_VERSION "([^"]+)"/.exec(readFileSync(source, 'utf8'))[1];
const VERSION_OF = { base: BASE_VERSION, v1335: '1.33.5', v1329: '1.32.9', api35min33: '1.40.0', api35min34: '1.40.0', api32: '1.40.0', bad: '1.40.0' };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const freePort = freePortFrom(15);
const DOMAIN = 'jobe-bg-signature-v1\n';
const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, hex: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') };
};
const KEY = keyPair();
const OTHER = keyPair();

// Os 3 arquivos de uma versao: o manifesto (texto exato) e a assinatura (128 hex + \n).
function release(elf, { version, api = 33, minAppApi = api, key = KEY, sha256 = sha(elf), size = elf.length, domain = DOMAIN } = {}) {
  const manifest = `${JSON.stringify({ format: 1, name: 'bg-downloader', version, api, minAppApi, size, sha256 }, null, 2)}\n`;
  const signature = `${sign(null, Buffer.concat([Buffer.from(domain), Buffer.from(manifest)]), key.privateKey).toString('hex')}\n`;
  return { elf, manifest, signature };
}
const releaseOf = (name, extra = {}) => {
  const elf = readFileSync(bin(name));
  const flags = VARIANTS[name] ?? [];
  const api = Number(/-DBG_API=(\d+)/.exec(flags.join(' '))?.[1] ?? 33);
  const minAppApi = Number(/-DBG_MIN_APP_API=(\d+)/.exec(flags.join(' '))?.[1] ?? api);
  return release(elf, { version: VERSION_OF[name], api, minAppApi, ...extra });
};

// O GitHub falso: as tags e os arquivos de cada versao (o ELF vem por um redirect, como o do GitHub). `slow`: um arquivo
// grande servido devagar (para um download ficar rodando).
const gh = { tags: [], files: {}, asked: [] };
let ghServer, ghPort;
const children = new Set();
const track = (child) => {
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
};
beforeEach(async () => {
  const left = [...children];
  for (const child of left) child.kill('SIGKILL');
  await Promise.all(left.map((child) => child.exitCode !== null || child.signalCode ? null : new Promise((resolve) => child.once('exit', resolve))));
  gh.tags = [];
  gh.files = {};
  gh.asked = [];
});
after(() => {
  for (const child of children) child.kill('SIGKILL');
  ghServer?.closeAllConnections?.();
  ghServer?.close();
  for (const loader of loaders) loader.close();
  rmSync(dir, { recursive: true, force: true });
});
const SLOW = randomBytes(4 * 1024 * 1024);
if (!skip) {
  ghPort = await freePort();
  ghServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    gh.asked.push(url.pathname);
    if (url.pathname === '/repos/pristmc-code/JobeesLair-glibren/git/matching-refs/tags/bg-downloader-') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(gh.tags.map((v) => ({ ref: `refs/tags/bg-downloader-${v}`, object: { sha: 'x' } }))));
    }
    const m = /^\/pristmc-code\/JobeesLair-glibren\/releases\/download\/bg-downloader-([^/]+)\/(.+)$/.exec(url.pathname);
    if (m && m[2] === 'bg-downloader.elf' && gh.files[m[1]]?.elf) { res.writeHead(302, { Location: `/cdn/${m[1]}/elf` }); return res.end(); }
    const cdn = /^\/cdn\/([^/]+)\/elf$/.exec(url.pathname);
    const file = cdn ? gh.files[cdn[1]]?.elf : m ? { 'bg-downloader.json': gh.files[m[1]]?.manifest, 'bg-downloader.json.sig': gh.files[m[1]]?.signature }[m[2]] : null;
    if (url.pathname === '/slow.bin') {
      res.writeHead(200, { 'Content-Length': SLOW.length, 'Content-Type': 'application/octet-stream' });
      for (let p = 0; p < SLOW.length && !res.destroyed; p += 64 * 1024) { res.write(SLOW.subarray(p, p + 64 * 1024)); await wait(150); }
      return res.end();
    }
    if (file === undefined || file === null) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(file);
  }).listen(ghPort, '127.0.0.1');
}
const publish = (rel) => {
  const version = JSON.parse(rel.manifest).version;
  if (!gh.tags.includes(version)) gh.tags.push(version);
  gh.files[version] = rel;
};

// O elfldr falso de uma pasta de trabalho: recebe o ELF ate o fim da conexao, grava e executa com o ambiente dela.
const loaders = new Set();
async function loaderFor(ws) {
  const port = await freePort();
  const got = [];
  let count = 0;
  const server = net.createServer((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const file = path.join(ws.base, `loaded-${++count}`);
      writeFileSync(file, bytes);
      chmodSync(file, 0o755);
      got.push(sha(bytes));
      track(spawn(file, [], { env: ws.env, stdio: ['ignore', 'ignore', 'ignore'] }));
    });
  }).listen(port, '127.0.0.1');
  loaders.add(server);
  return { port, got };
}

let run = 0;
async function workspace({ app = { api: 33, embedded: BASE_VERSION } } = {}) {
  const base = path.join(dir, `ws${++run}`);
  mkdirSync(path.join(base, 'state'), { recursive: true });
  mkdirSync(path.join(base, 'disk/homebrew'), { recursive: true });
  mkdirSync(path.join(base, 'disk/downloads/extracted'), { recursive: true });
  if (app) writeFileSync(path.join(base, 'state/app.json'), JSON.stringify(app));
  const ws = { base, state: path.join(base, 'state'), api: await freePort(), monitor: await freePort() };
  const loader = await loaderFor(ws);
  ws.loader = loader;
  ws.env = { ...process.env, BGDL_DIR: ws.state, BGDL_PORT: String(ws.api), BGDL_MONITOR_PORT: String(ws.monitor), BGDL_ORBIT_DIR: path.join(base, 'orbit'),
    BGDL_LIBRARY: path.join(base, 'lista.json'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_DIAG_DIR: path.join(base, 'diag'), BGDL_GLIBREN_BASE: 'http://127.0.0.1:9',
    BGDL_GITHUB_BASE: `http://127.0.0.1:${ghPort}`, BGDL_RELEASES_BASE: `http://127.0.0.1:${ghPort}`, BGDL_SELF_PUBLIC_KEY: KEY.hex, BGDL_ELFLDR_PORT: String(loader.port),
    BGDL_SELF_CONFIRM_MS: '800', BGDL_BACKUP_ROOTS: path.join(base, 'disk'), BGDL_SMP_BASE: 'http://127.0.0.1:9/api/v1' };
  ws.start = (name = 'base') => track(spawn(bin(name), [], { env: ws.env, stdio: ['ignore', 'pipe', 'ignore'] }));
  ws.token = () => readFileSync(path.join(ws.state, 'token'), 'utf8').trim();
  ws.call = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${ws.api}${route}`, { method, headers: { 'X-Jobe-Token': ws.token(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  ws.health = async () => {
    try { const r = await ws.call('GET', '/health'); return r.status === 200 ? r.data : null; } catch { return null; }
  };
  ws.log = () => { try { return readFileSync(path.join(ws.state, 'bgdl.log'), 'utf8'); } catch { return ''; } };
  ws.saved = () => { try { return JSON.parse(readFileSync(path.join(ws.state, 'self-update.json'), 'utf8')); } catch { return {}; } };
  ws.until = async (check, what, ms = 30000) => {
    let last;
    for (const end = performance.now() + ms; performance.now() < end; await wait(50)) {
      try { last = await check(); if (last) return last; } catch {}
    }
    throw new Error(`timed out waiting for ${what}\n${ws.log().split('\n').slice(-20).join('\n')}`);
  };
  ws.version = (version, ms) => ws.until(async () => { const h = await ws.health(); return h?.version === version ? h : null; }, `payload ${version}`, ms);
  ws.self = async () => (await ws.call('GET', '/self-update')).data;
  ws.phase = (phases, ms) => ws.until(async () => { const s = await ws.self(); return phases.includes(s.phase) ? s : null; }, `phase ${phases}`, ms);
  // Os arquivos de uma versao no disco, como o payload grava ("bg-downloader" ou "bg-downloader.prev").
  ws.install = (rel, name = 'bg-downloader') => {
    writeFileSync(path.join(ws.state, `${name}.elf`), rel.elf);
    writeFileSync(path.join(ws.state, `${name}.json`), rel.manifest);
    writeFileSync(path.join(ws.state, `${name}.json.sig`), rel.signature);
  };
  return ws;
}
const exited = (child) => child.exitCode !== null || child.signalCode ? Promise.resolve(child.exitCode) : new Promise((resolve) => child.once('exit', (code) => resolve(code)));
async function unlock(ws) {
  const PIN = '1357';
  const salt = randomBytes(32).toString('hex');
  assert.equal((await ws.call('POST', '/config', { pinSalt: salt, pinHash: sha(`${salt}:${PIN}`) })).status, 200);
  const r = await page(ws, '/api/unlock', { method: 'POST', body: { pin: PIN } });
  assert.match(r.data.session, /^[0-9a-f]{32}$/);
  return r.data.session;
}
const page = (ws, route, { method = 'GET', body = null, session = '' } = {}) => new Promise((resolve, reject) => {
  const data = body === null ? null : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: ws.monitor, path: route, method, headers: { Host: `192.168.0.20:${ws.monitor}`, ...(session ? { 'X-Session': session } : {}),
    ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
    let text = '';
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, data: json }); });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

test('glibren.49: as versoes do payload compilam sem avisos; o marcador e o contrato batem com o app', { skip: !compiler ? 'no C compiler' : false }, async () => {
  assert.equal(skip, false, String(skip));
  const elf = readFileSync(bin('base')).toString('latin1');
  const marker = /BG-DOWNLOADER-VERSION:(\d+\.\d+\.\d+);API:(\d+);MINAPP:(\d+);\n/.exec(elf);
  assert.ok(marker, 'o marcador que o publicar_bg.py le');
  const { BG_EMBEDDED_VERSION, PAYLOAD_API } = await import('../app/state/background-downloads.js');
  assert.equal(marker[1], BG_EMBEDDED_VERSION, 'BG_VERSION = BG_EMBEDDED_VERSION do app');
  assert.equal(Number(marker[2]), PAYLOAD_API, 'BG_API = PAYLOAD_API do app');
  assert.ok(Number(marker[3]) <= Number(marker[2]), 'minAppApi <= api');
  assert.match(readFileSync(path.join(repo, 'app/native/bg_self.c'), 'utf8'), /ce2767604727310aa1b2a5713fe7b76774b7ecd8c68240fef789819a473847c0/, 'a chave publica do glibren');
});

test('assinatura valida: baixa, confere, grava (.part -> renomeia), troca quando ocioso e a proxima subida escolhe o baixado', { skip }, async () => {
  const ws = await workspace();
  const rel = releaseOf('v1335');
  publish(rel);
  const first = ws.start();
  await ws.version(BASE_VERSION);
  const answer = await ws.call('POST', '/self-update', { action: 'check', force: true });
  assert.equal(answer.status, 200);
  assert.equal(answer.data.version, BASE_VERSION);
  assert.equal(answer.data.source, 'embedded');
  // O novo sobe pelo elfldr e pede a saida limpa do antigo.
  const health = await ws.version('1.33.5');
  assert.equal(health.api, 33);
  assert.equal(health.minAppApi, 33);
  assert.equal(await exited(first), 0, 'o antigo saiu limpo (SIGTERM do novo)');
  assert.deepEqual(ws.loader.got, [sha(rel.elf)], 'o elfldr recebeu o ELF baixado, uma vez');
  for (const ext of ['elf', 'json', 'json.sig']) assert.ok(existsSync(path.join(ws.state, `bg-downloader.${ext}`)), ext);
  assert.equal(readFileSync(path.join(ws.state, 'bg-downloader.json'), 'utf8'), rel.manifest, 'o manifesto exato');
  assert.ok(!existsSync(path.join(ws.state, 'bg-downloader.part')));
  assert.ok(gh.asked.some((p) => p.startsWith('/cdn/')), 'o ELF veio pelo redirect');
  assert.match(ws.log(), /self-update: 1\.33\.5 pronta/);
  const self = await ws.self();
  assert.equal(self.source, 'downloaded');
  assert.equal(self.installed, '1.33.5');
  // confirmada: as tentativas zeram
  await ws.until(() => JSON.stringify(ws.saved().strikes ?? {}) === '{}' && ws.log().includes('payload 1.33.5 confirmado'), 'confirmacao');
  // A proxima subida (o app manda o embutido): ele passa a vez para o baixado.
  for (const child of [...children]) child.kill('SIGTERM');
  await ws.until(async () => !(await ws.health()), 'o payload parar');
  ws.loader.got.length = 0;
  const again = ws.start();
  await ws.version('1.33.5');
  assert.equal(await exited(again), 0);
  assert.equal(ws.loader.got.length, 1);
  assert.match(ws.log(), /passando a vez para o payload baixado 1\.33\.5 \(api 33; tentativa 1 de 2; este e o 1\.33\.0\)/);
});

test('.sig ausente, de outra chave ou sem o prefixo de dominio: recusado, nada gravado; no disco, ignorado na subida', { skip }, async () => {
  const ws = await workspace();
  ws.start();
  await ws.version(BASE_VERSION);
  const cases = [
    ['sem .sig', { ...releaseOf('v1335'), signature: undefined }],
    ['outra chave', releaseOf('v1335', { key: OTHER })],
    ['sem o prefixo', releaseOf('v1335', { domain: '' })],
    ['manifesto mexido', (() => { const r = releaseOf('v1335'); return { ...r, manifest: r.manifest.replace('"api": 33', '"api": 34') }; })()]
  ];
  for (const [what, rel] of cases) {
    gh.files = {};
    publish(rel);
    await ws.call('POST', '/self-update', { action: 'check', force: true });
    const s = await ws.phase(['failed'], 20000);
    assert.match(s.error, /^1\.33\.5: signature$/, what);
    assert.ok(!existsSync(path.join(ws.state, 'bg-downloader.elf')), `${what}: nada gravado`);
  }
  assert.ok(!gh.asked.some((p) => p.startsWith('/cdn/')), 'o ELF nunca foi baixado');
  // Instalado a mao com a assinatura de outra chave: a subida ignora (nao passa a vez).
  for (const child of [...children]) child.kill('SIGKILL');
  ws.install(releaseOf('v1335', { key: OTHER }));
  ws.start();
  await ws.version(BASE_VERSION);
  assert.deepEqual(ws.loader.got, []);
  assert.match(ws.log(), /bg-downloader\.elf ignorado na subida \(signature\)/);
});

test('sha256 ou tamanho errados: recusado, o .part some e nada entra no lugar; ELF trocado no disco e ignorado na subida', { skip }, async () => {
  const ws = await workspace();
  ws.start();
  await ws.version(BASE_VERSION);
  publish(releaseOf('v1335', { sha256: sha(Buffer.from('outro')) }));
  await ws.call('POST', '/self-update', { action: 'check', force: true });
  assert.match((await ws.phase(['failed'])).error, /sha256 mismatch/);
  assert.ok(!existsSync(path.join(ws.state, 'bg-downloader.part')) && !existsSync(path.join(ws.state, 'bg-downloader.elf')));
  gh.files = {};
  const real = readFileSync(bin('v1335'));
  publish(release(real, { version: '1.33.5', size: real.length - 1000, sha256: sha(real.subarray(0, real.length - 1000)) }));
  await ws.call('POST', '/self-update', { action: 'check', force: true });
  assert.match((await ws.phase(['failed'])).error, /bigger than the manifest/);
  assert.ok(!existsSync(path.join(ws.state, 'bg-downloader.elf')));
  assert.deepEqual(ws.loader.got, [], 'nenhuma troca');
  // No disco: manifesto e assinatura validos, ELF trocado.
  for (const child of [...children]) child.kill('SIGKILL');
  const rel = releaseOf('v1335');
  ws.install({ ...rel, elf: readFileSync(bin('v1329')) });
  ws.start();
  await ws.version(BASE_VERSION);
  assert.deepEqual(ws.loader.got, []);
  assert.match(ws.log(), /bg-downloader\.elf ignorado na subida \(sha256\)/);
});

test('versao mais velha ou igual a embutida: nem baixada nem usada', { skip }, async () => {
  const ws = await workspace();
  ws.start();
  await ws.version(BASE_VERSION);
  publish(releaseOf('v1329'));
  publish(release(readFileSync(bin('base')), { version: BASE_VERSION }));
  await ws.call('POST', '/self-update', { action: 'check', force: true });
  const s = await ws.phase(['current']);
  assert.equal(s.latest, BASE_VERSION);
  assert.ok(!gh.asked.some((p) => p.includes('/releases/download/')), 'nenhum manifesto pedido');
  // Instaladas no disco (validas): a subida nao passa a vez.
  for (const child of [...children]) child.kill('SIGKILL');
  ws.install(releaseOf('v1329'));
  ws.install(release(readFileSync(bin('base')), { version: BASE_VERSION }), 'bg-downloader.prev');
  ws.start();
  await ws.version(BASE_VERSION);
  await wait(300);
  assert.deepEqual(ws.loader.got, []);
  // e um app com embutido mais novo que o baixado (Jobe nova): o baixado tambem nao vale
  for (const child of [...children]) child.kill('SIGKILL');
  ws.install(releaseOf('v1335'));
  writeFileSync(path.join(ws.state, 'app.json'), JSON.stringify({ api: 33, embedded: '1.33.7' }));
  ws.start();
  await ws.version(BASE_VERSION);
  await wait(300);
  assert.deepEqual(ws.loader.got, [], '1.33.5 < 1.33.7 do app');
});

test('nao sobe 2x: vira ruim e a anterior sobe; sem anterior, o embutido; nada de laco', { skip }, async () => {
  const ws = await workspace();
  const bad = release(readFileSync(bin('bad')), { version: '1.40.0' });
  ws.install(bad);
  ws.install(releaseOf('v1335'), 'bg-downloader.prev');
  // 1a e 2a subidas: passa a vez para a 1.40.0, que cai.
  for (const n of [1, 2]) {
    const child = ws.start();
    assert.equal(await exited(child), 0, `subida ${n}: passou a vez`);
    await ws.until(() => ws.loader.got.length === n, `elfldr ${n}`);
    assert.equal(ws.saved().strikes['1.40.0'], n);
    await wait(200);
    assert.equal(await ws.health(), null, 'a versao ruim nao responde');
  }
  // 3a: marca a 1.40.0 como ruim e passa a vez para a anterior (1.33.5), que sobe e confirma.
  const third = ws.start();
  await ws.version('1.33.5');
  assert.equal(await exited(third), 0);
  assert.deepEqual(ws.saved().bad, ['1.40.0']);
  assert.match(ws.log(), /versao 1\.40\.0 marcada como ruim \(nao subiu em 2 tentativas\)/);
  await ws.until(() => !('1.33.5' in (ws.saved().strikes ?? {})), 'confirmacao da 1.33.5');
  const self = await ws.self();
  assert.deepEqual(self.bad, ['1.40.0']);
  // Sem anterior: so a ruim no disco -> o embutido fica.
  const ws2 = await workspace();
  ws2.install(bad);
  writeFileSync(path.join(ws2.state, 'self-update.json'), JSON.stringify({ bad: [], strikes: { '1.40.0': 2 } }));
  ws2.start();
  await ws2.version(BASE_VERSION);
  assert.deepEqual(ws2.loader.got, [], 'nao manda a ruim de novo');
  assert.deepEqual(ws2.saved().bad, ['1.40.0']);
  // A procura tambem nao baixa a ruim de novo.
  publish(bad);
  await ws2.call('POST', '/self-update', { action: 'check', force: true });
  await ws2.phase(['current']);
  assert.ok(!gh.asked.some((p) => p.includes('/releases/download/')));
});

test('troca segurada com download gravando ou conversao rodando; sai quando fica ocioso', { skip }, async () => {
  const ws = await workspace();
  publish(releaseOf('v1335'));
  ws.start();
  await ws.version(BASE_VERSION);
  // um download rodando (servido devagar)
  const dest = path.join(ws.base, 'disk/downloads/slow.bin');
  const job = await ws.call('POST', '/jobs', { url: `http://127.0.0.1:${ghPort}/slow.bin`, destination: dest, storageRoot: path.join(ws.base, 'disk'), connections: 1 });
  assert.ok([200, 201].includes(job.status), JSON.stringify(job.data));
  await ws.until(async () => (await ws.health())?.running === 1, 'o download rodando');
  await ws.call('POST', '/self-update', { action: 'check', force: true });
  const waiting = await ws.phase(['waiting']);
  assert.equal(waiting.waiting, 'download');
  await wait(1500);
  assert.deepEqual(ws.loader.got, [], 'nao troca com download gravando');
  assert.match(ws.log(), /troca para 1\.33\.5 esperando \(download em andamento\)/);
  assert.equal((await ws.call('POST', `/jobs/${job.data.id}/cancel`)).status, 200);
  // Sem download: troca.
  await ws.version('1.33.5');
  assert.equal(ws.loader.got.length, 1);

  // Uma conversao rodando (devagar: BGDL_CONVERT_DELAY_MS) segura a troca do mesmo jeito.
  const ws2 = await workspace();
  publish(releaseOf('v1335'));
  ws2.env.BGDL_CONVERT_DELAY_MS = '300';
  ws2.start();
  await ws2.version(BASE_VERSION);
  const w2 = path.join(ws2.base, 'disk/downloads/extracted/J');
  mkdirSync(path.join(w2, 'sce_sys'), { recursive: true });
  writeFileSync(path.join(w2, 'eboot.bin'), randomBytes(64 * 1024));
  writeFileSync(path.join(w2, 'sce_sys/param.json'), '{"titleId":"PPSA01234","contentVersion":"01.000.000"}');
  writeFileSync(path.join(w2, 'big.bin'), randomBytes(24 * 1024 * 1024));
  const conv = await ws2.call('POST', '/convert', { key: 'k1', kind: 'dir', name: 'Jogo', label: 'PPSA01234', root: path.join(ws2.base, 'disk'), source: w2, work: w2, output: path.join(ws2.base, 'disk/homebrew/PPSA01234.exfat') });
  assert.ok([200, 201].includes(conv.status), JSON.stringify(conv.data));
  await ws2.until(async () => (await ws2.call('GET', '/convert')).data.conversions.some((c) => c.state === 'converting'), 'a conversao rodando');
  await ws2.call('POST', '/self-update', { action: 'check', force: true });
  assert.equal((await ws2.phase(['waiting'])).waiting, 'convert');
  await wait(1200);
  assert.deepEqual(ws2.loader.got, [], 'nao troca com conversao rodando');
  assert.equal((await ws2.call('POST', `/convert/${conv.data.id}/cancel`)).status, 200);
  await ws2.version('1.33.5');
});

test('compatibilidade de API: api maior so com minAppApi <= a do app; api menor recusada; vale na procura e na subida', { skip }, async () => {
  const ws = await workspace();
  ws.start();
  await ws.version(BASE_VERSION);
  publish(releaseOf('api35min34'));
  await ws.call('POST', '/self-update', { action: 'check', force: true });
  const needs = await ws.phase(['needs-app']);
  assert.match(needs.error, /1\.40\.0: needs-app/);
  assert.ok(!gh.asked.some((p) => p.startsWith('/cdn/')), 'nao baixa o que o app nao usa');
  gh.files = {};
  publish(releaseOf('api32'));
  await ws.call('POST', '/self-update', { action: 'check', force: true });
  assert.match((await ws.phase(['failed'])).error, /1\.40\.0: api/);
  gh.files = {};
  publish(releaseOf('api35min33'));
  await ws.call('POST', '/self-update', { action: 'check', force: true });
  const health = await ws.version('1.40.0');
  assert.equal(health.api, 35);
  assert.equal(health.minAppApi, 33);
  // Na subida: um app (api 33) com o baixado api35/min34 no disco nao passa a vez; com o app api 34, passa.
  const ws2 = await workspace();
  ws2.install(releaseOf('api35min34'));
  ws2.start();
  await ws2.version(BASE_VERSION);
  await wait(300);
  assert.deepEqual(ws2.loader.got, []);
  assert.match(ws2.log(), /ignorado na subida \(needs-app\)/);
});

test('"Voltar ao payload embutido": pagina do celular (com o PIN) e API do app; o baixado vira ruim e o embutido volta', { skip }, async () => {
  const ws = await workspace();
  ws.install(releaseOf('v1335'));
  copyFileSync(bin('base'), path.join(ws.state, 'embedded.elf')); // a copia que o app deixa
  ws.start();
  await ws.version('1.33.5');
  assert.equal((await page(ws, '/api/payload')).status, 401, 'sem o PIN');
  assert.equal((await page(ws, '/api/payload/revert', { method: 'POST' })).status, 401);
  const session = await unlock(ws);
  const status = await page(ws, '/api/payload', { session });
  assert.equal(status.status, 200);
  assert.equal(status.data.source, 'downloaded');
  assert.equal(status.data.version, '1.33.5');
  const reverted = await page(ws, '/api/payload/revert', { method: 'POST', session });
  assert.equal(reverted.status, 200);
  assert.deepEqual(reverted.data.bad, ['1.33.5']);
  // troca pelo embedded.elf quando ocioso
  const health = await ws.version(BASE_VERSION);
  assert.equal(health.replace, false);
  assert.match(ws.log(), /voltando ao payload embutido/);
  // a proxima subida nao passa a vez para o baixado posto de lado
  for (const child of [...children]) child.kill('SIGTERM');
  await ws.until(async () => !(await ws.health()), 'o payload parar');
  const got = ws.loader.got.length;
  ws.start();
  await ws.version(BASE_VERSION);
  await wait(300);
  assert.equal(ws.loader.got.length, got);
  // Pela API do app, sem embedded.elf: marca e o /health do baixado diz "replace" (o app manda o embutido).
  const ws2 = await workspace();
  ws2.install(releaseOf('v1335'));
  ws2.start();
  await ws2.version('1.33.5');
  const r = await ws2.call('POST', '/self-update', { action: 'revert' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.bad, ['1.33.5']);
  assert.equal((await ws2.health()).replace, true);
  assert.equal((await ws2.call('POST', '/self-update', { action: 'nada' })).status, 400);
});

// O publicar_bg.py (fora do repositorio: PS5_BASE) com uma chave de teste: o manifesto e a assinatura que ele grava sao
// aceitos por este payload (o mesmo contrato dos dois lados).
const tool = process.env.PS5_BASE ? path.join(process.env.PS5_BASE, 'jobe/ferramentas/publicar_bg.py') : '';
const python = spawnSync('python3', ['-c', 'import cryptography'], { encoding: 'utf8' }).status === 0;
test('publicar_bg.py: manifesto + .sig que o payload aceita (chave de teste gerada na hora)', { skip: skip || (!tool || !existsSync(tool) ? 'no PS5_BASE/publicar_bg.py' : !python ? 'no python3 cryptography' : false) }, async () => {
  const pem = path.join(dir, 'teste.pem');
  writeFileSync(pem, KEY.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const out = path.join(dir, 'saida-bg');
  const r = spawnSync('python3', [tool, bin('v1335'), '--saida', out, '--chave', pem, '--chave-publica', KEY.hex, '--sem-gh'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rel = { elf: readFileSync(path.join(out, 'bg-downloader.elf')), manifest: readFileSync(path.join(out, 'bg-downloader.json'), 'utf8'), signature: readFileSync(path.join(out, 'bg-downloader.json.sig'), 'utf8') };
  assert.deepEqual(JSON.parse(rel.manifest), { format: 1, name: 'bg-downloader', version: '1.33.5', api: 33, minAppApi: 33, size: rel.elf.length, sha256: sha(rel.elf) });
  const ws = await workspace();
  publish(rel);
  ws.start();
  await ws.version(BASE_VERSION);
  await ws.call('POST', '/self-update', { action: 'check', force: true });
  await ws.version('1.33.5');
  // e o --conferir do script confere os arquivos baixados
  const c = spawnSync('python3', [tool, '--conferir', out, '--chave-publica', KEY.hex], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  writeFileSync(path.join(out, 'bg-downloader.json.sig'), `${'0'.repeat(128)}\n`);
  assert.notEqual(spawnSync('python3', [tool, '--conferir', out, '--chave-publica', KEY.hex], { encoding: 'utf8' }).status, 0, 'assinatura errada falha');
});
