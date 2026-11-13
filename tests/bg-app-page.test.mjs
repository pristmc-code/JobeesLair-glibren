// Fase 8: a Jobe web completa (app/native/bg_app.c + bg_app.html, servida pelo payload em /app, na porta da pagina do
// celular). O payload compilado para o PC:
//   - /app (e /app/, /app/index.html) sai sem sessao, igual ao .h embutido, com a CSP da pagina do celular; o Host com
//     nome de dominio da 403 (J6) e so GET; a pagina do celular ("/") continua a de sempre;
//   - a pagina segue o padrao de tela do dono e do navegador do PS5 (sem reticencias, sem ?. nem ??, sem innerHTML no
//     script, sem endereco de fora, botoes da mesma linha com a mesma largura, "<- JOGOS" primeiro);
//   - ela monta contra a API falsa (tools/web-app/api-falsa.mjs) no Chromium, nos 5 tamanhos, com controle e teclado, e
//     tira os prints (tools/web-app/medir.mjs --checar --rapido). Precisa do Playwright: o do proprio Node (import
//     'playwright'), ou, no WSL, o Node do Windows com o Playwright do cache do npx (ou JL_PLAYWRIGHT=<pasta>); sem
//     nenhum, o teste e pulado.
// Run: node --import ./tests/stub-loader.mjs --test tests/bg-app-page.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePortFrom } from './free-port.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const embed = await import(pathToFileURL(path.join(repo, 'tools/bg-monitor/embed.mjs')).href);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = freePortFrom(16); // Fase 8: bloco de portas so deste arquivo (tests/free-port.mjs)

const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-app-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && spawnSync(compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread'], { encoding: 'utf8' });
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 400)}` : false;
const children = new Set();
after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

let run = 0;
async function startPayload() {
  const base = path.join(dir, `run${++run}`);
  for (const sub of ['state', 'tube', 'apps', 'diag']) mkdirSync(path.join(base, sub), { recursive: true });
  const api = await freePort(), monitor = await freePort();
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor), BGDL_ORBIT_DIR: path.join(base, 'orbit'),
    BGDL_LIBRARY: path.join(base, 'lista.json'), BGDL_KEYFILE: path.join(base, 'debrid.json'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_DIAG_DIR: path.join(base, 'diag'),
    BGDL_TUBE_DIR: path.join(base, 'tube'), BGDL_APP_LOGS_ROOT: path.join(base, 'apps'), BGDL_STORE_DIR: path.join(base, 'store'), BGDL_GITHUB_BASE: 'http://127.0.0.1:9', BGDL_GLIBREN_BASE: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  // Um pedido cru (o Host e o metodo escolhidos aqui; fetch nao deixa trocar o Host).
  const raw = (route, { method = 'GET', host } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: monitor, path: route, method, headers: host ? { Host: host } : {} }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
  for (const end = performance.now() + 30000; ; await wait(50)) {
    try { if ((await raw('/api/session')).status === 401) break; } catch {}
    if (performance.now() > end) throw new Error('payload did not start');
  }
  const stop = async () => { const gone = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGTERM'); await gone; };
  return { raw, stop };
}

test('bg_app.c compila junto com o payload, sem avisos (-Wall -Wextra -Werror)', { skip: !compiler || missing ? 'no compiler or headers' : false }, () => {
  assert.equal(built.status, 0, built.stderr);
});

test('Fase 8: bg_app_html.h esta em dia com bg_app.html (rode tools/bg-monitor/embed.mjs)', () => {
  assert.equal(readFileSync(embed.APP_HEADER, 'utf8'), embed.appHeader(readFileSync(embed.APP_PAGE)));
  assert.equal(readFileSync(embed.HEADER, 'utf8'), embed.header(readFileSync(embed.PAGE)), 'o da pagina do celular continua igual');
  assert.equal(readFileSync(embed.TESTE_HEADER, 'utf8'), embed.testeHeader(readFileSync(embed.TESTE_PAGE)), 'o da pagina /teste continua igual');
});

test('Fase 8: a pagina /app segue o padrao de tela e o navegador do PS5', () => {
  const page = readFileSync(embed.APP_PAGE, 'utf8');
  for (const piece of ['"/api/store/game?id="', '"/api/store/add"', '"/api/status"', '"/api/jobs/"', '"/api/unlock"', 'CHAVE: "jobe.session"', 'X-Session',
    '"/api/pair"', '"/api/pair/request"', '"/api/pair/confirm"', '"jobe.deviceName"', 'Auth.com(', 'Usar o PIN', 'Código da TV', 'navigator.getGamepads', 'gamepadconnected', 'keydown', 'requestAnimationFrame', 'ResizeObserver', 'loading = "lazy"', 'data-src',
    'visibilitychange', '/PlayStation/', 'html.ps5', 'clamp(15px,min(1.04vw,1.95vh),20px)', 'requestFullscreen', 'webkitRequestFullscreen', '"jobe.app.tela"',
    '"/api/teste/enviar"', 'guardaCursor', 'GP.rodaAte', 'window.jobeVoltar', '"← JOGOS"', '"← GAMES"', 'Biblioteca (em breve)', 'Homebrew (em breve)', 'Configurações (em breve)',
    '(max-height:500px) and (min-width:600px)', '(min-width:761px) and (min-height:501px)', '100dvh', '[hidden]{display:none!important}']) assert.ok(page.includes(piece), piece);
  assert.ok(!/text-overflow|nowrap|ellipsis/.test(page), 'texto quebra a linha, sem reticencias');
  assert.match(page, /\.fila\{display:grid;grid-auto-flow:column;grid-auto-columns:minmax\(0,1fr\)/, 'botoes de uma linha com a mesma largura');
  assert.match(page, /overflow-x:hidden/, 'a grade nao rola de lado');
  const script = page.slice(page.indexOf('<script>'));
  assert.ok(!/\?\.|\?\?/.test(script), 'sem ?. nem ?? (navegador do PS5)');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(script), 'texto do payload nunca por innerHTML');
  assert.ok(!/(prompt|alert|confirm)\(/.test(script), 'pareamento e PIN numa janela da pagina, sem prompt/alert/confirm');
  assert.ok(!/<script[^>]+src=|<link[^>]+stylesheet/.test(page), 'tudo embutido (a CSP so aceita inline)');
  const fixed = (page.match(/https?:\/\/[^`'"\s$)\\]+/g) || []).filter((u) => !/^https:\/\/image\.api\.playstation\.com\//.test(u));
  assert.deepEqual(fixed, [], 'fala so com a mesma origem');
  // "<- JOGOS"/voltar primeiro: o 1o botao da navegacao e o da loja, e o 1o da barra da ficha e o voltar
  const nav = page.slice(page.indexOf('<nav id="nav"'), page.indexOf('</nav>'));
  assert.match(nav.slice(nav.indexOf('<button')), /^<button type="button" class="nb" data-sec="loja"/);
  assert.match(page, /<div class="fbar"><button type="button" class="btn" id="fVoltar">← JOGOS<\/button>/);
});

test('Fase 8: /app sai sem sessao e igual ao .h; so GET; Host com nome da 403; "/" continua a pagina do celular', { skip }, async () => {
  const p = await startPayload();
  const page = readFileSync(embed.APP_PAGE, 'utf8');
  for (const route of ['/app', '/app/', '/app/index.html']) {
    const r = await p.raw(route);
    assert.equal(r.status, 200, route);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.equal(r.text, page, route);
    assert.match(r.headers['content-security-policy'], /default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'/);
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.equal((await p.raw('/app?x=1')).status, 200, 'com query');
  assert.equal((await p.raw('/app', { method: 'POST' })).status, 404, 'so GET');
  assert.equal((await p.raw('/apps')).status, 404, 'nada de prefixo solto');
  assert.equal((await p.raw('/app', { host: 'exemplo.com' })).status, 403, 'nome de dominio (DNS rebinding)');
  assert.equal((await p.raw('/app', { host: 'jobe.exemplo.com:34201' })).status, 403);
  assert.equal((await p.raw('/app', { host: '192.168.0.20:34201' })).status, 200, 'IP literal passa');
  assert.equal((await p.raw('/app', { host: 'localhost:34201' })).status, 200, 'localhost passa');
  const home = await p.raw('/');
  assert.equal(home.status, 200);
  assert.equal(home.text, readFileSync(embed.PAGE, 'utf8'), 'a pagina do celular nao mudou');
  // as rotas que a pagina usa respondem como ela espera sem loja e sem sessao
  const store = await p.raw('/api/store?offset=0&limit=100');
  assert.equal(store.status, 404);
  assert.equal(JSON.parse(store.text).error, 'no-store');
  assert.equal((await p.raw('/api/store/add', { method: 'POST' })).status, 401, 'Baixar pede a sessao');
  assert.equal((await p.raw('/api/jobs/x/pause', { method: 'POST' })).status, 401, 'acoes da fila pedem a sessao');
  assert.ok(Array.isArray(JSON.parse((await p.raw('/api/status')).text).jobs), 'a fila ao vivo');
  await p.stop();
});

// ---- O Playwright: neste Node ou no do Windows (WSL) ----
function wslPath(p) { const r = spawnSync('wslpath', ['-w', p], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; }
async function runner() {
  try { await import('playwright'); return { node: process.execPath, script: path.join(repo, 'tools/web-app/medir.mjs'), playwright: null, out: (p) => p }; } catch {}
  const winNode = '/mnt/c/Program Files/nodejs/node.exe';
  if (process.platform !== 'linux' || !existsSync(winNode) || !existsSync('/usr/bin/wslpath')) return null;
  let pw = process.env.JL_PLAYWRIGHT || '';
  if (!pw) {
    for (const user of (() => { try { return readdirSync('/mnt/c/Users'); } catch { return []; } })()) {
      const npx = `/mnt/c/Users/${user}/AppData/Local/npm-cache/_npx`;
      let dirs = [];
      try { dirs = readdirSync(npx); } catch { continue; }
      for (const d of dirs) if (existsSync(`${npx}/${d}/node_modules/playwright/index.mjs`)) { pw = `${npx}/${d}/node_modules/playwright`; break; }
      if (pw) break;
    }
  }
  if (!pw) return null;
  const script = wslPath(path.join(repo, 'tools/web-app/medir.mjs')), pwWin = pw.startsWith('/') ? wslPath(pw) : pw;
  if (!script || !pwWin) return null;
  return { node: winNode, script, playwright: pwWin, out: (p) => wslPath(p) };
}
const pwRunner = await runner();

test('Fase 8: a pagina monta contra a API falsa nos 5 tamanhos e na area util do PS5 (Chromium), com controle e teclado, e tira os prints', { skip: pwRunner ? false : 'sem Playwright (nem neste Node nem no do Windows)', timeout: 600000 }, async () => {
  const out = path.join(dir, 'prints');
  mkdirSync(out, { recursive: true });
  const argv = [pwRunner.script, '--checar', '--rapido', `--saida=${pwRunner.out(out)}`];
  if (pwRunner.playwright) argv.push(`--playwright=${pwRunner.playwright}`);
  const r = spawnSync(pwRunner.node, argv, { encoding: 'utf8', timeout: 540000, cwd: pwRunner.playwright ? '/mnt/c' : repo });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('JSON '));
  assert.ok(line, `sem resultado: ${(r.stderr || r.stdout || '').slice(-1500)}`);
  const result = JSON.parse(line.slice(5));
  assert.deepEqual(result.falhas, [], 'regras de tela, controle e teclado');
  assert.equal(r.status, 0);
  const medidas = JSON.parse(readFileSync(path.join(out, 'medidas.json'), 'utf8'));
  assert.deepEqual(medidas.resultados.map((x) => x.tamanho), ['360x780', '412x915', '780x360', '1280x800', '1920x1080', '1600x860-ps5', '1280x720-ps5']);
  for (const m of medidas.resultados) {
    assert.ok(m.montagem.cartoes > 0 && m.montagem.estado.count === 2639, `${m.tamanho}: montou com os 2.639 jogos`);
    assert.ok(m.rolagem.maxCartoesNoDom < 200, `${m.tamanho}: lista virtual`);
    assert.equal(m.montagem.estado.lista, m.tamanho === '360x780' || m.tamanho === '412x915', `${m.tamanho}: lista em pe, grade deitado/PC/TV`);
    for (const shot of ['loja', 'ficha', 'parear', 'downloads']) assert.ok(existsSync(path.join(out, `app-${m.tamanho}-${shot}.png`)), `${m.tamanho} ${shot}.png`);
  }
});
