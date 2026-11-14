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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePortFrom } from './free-port.mjs';
import { compileTo } from './payload-build.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const embed = await import(pathToFileURL(path.join(repo, 'tools/bg-monitor/embed.mjs')).href);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textosGer = await import(pathToFileURL(path.join(repo, 'tools/web-app/textos.mjs')).href);
const freePort = freePortFrom(13); // Fase 8: bloco de portas so deste arquivo (tests/free-port.mjs)

const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-app-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
const built = compiler && compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
const missing = Boolean(built && built.status !== 0 && /curl\/curl\.h|openssl\/evp\.h|archive\.h|cannot find -l/.test(built.stderr));
const skip = !compiler ? 'no C compiler' : missing ? 'no libcurl/OpenSSL/libarchive headers' : built.status !== 0 ? `did not compile: ${built.stderr.slice(0, 400)}` : false;
const children = new Set();
after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

let run = 0;
async function startPayload({ glibren, env = {} } = {}) {
  const base = path.join(dir, `run${++run}`);
  for (const sub of ['state', 'tube', 'apps', 'diag']) mkdirSync(path.join(base, sub), { recursive: true });
  const api = await freePort(), monitor = await freePort();
  const child = spawn(binary, [], { env: { ...process.env, BGDL_DIR: path.join(base, 'state'), BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor), BGDL_ORBIT_DIR: path.join(base, 'orbit'),
    BGDL_LIBRARY: path.join(base, 'lista.json'), BGDL_KEYFILE: path.join(base, 'debrid.json'), BGDL_NOTIFY_FILE: path.join(base, 'notify.txt'), BGDL_DIAG_DIR: path.join(base, 'diag'),
    BGDL_TUBE_DIR: path.join(base, 'tube'), BGDL_APP_LOGS_ROOT: path.join(base, 'apps'), BGDL_STORE_DIR: path.join(base, 'store'), BGDL_GLIBREN_PORT: String(glibren || 9), BGDL_GITHUB_BASE: 'http://127.0.0.1:9', BGDL_GLIBREN_BASE: 'http://127.0.0.1:9',
    BGDL_APPMETA_DIR: path.join(base, 'appmeta'), BGDL_CAPA_DOH: 'off', BGDL_CAPA_PATCHES: 'off', ...env },
    stdio: ['ignore', 'pipe', 'ignore'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  // Um pedido cru (o Host e o metodo escolhidos aqui; fetch nao deixa trocar o Host).
  const raw = (route, { method = 'GET', host, body, session, port = monitor, headers = {} } = {}) => new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host) h.Host = host;
    if (session) h['X-Session'] = session;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: h }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  // a API local (127.0.0.1:BGDL_PORT, com o token do app): o que a Jobe mostraria na TV
  const local = (route) => raw(route, { port: api, headers: { 'X-Jobe-Token': readFileSync(path.join(base, 'state/token'), 'utf8').trim() } });
  for (const end = performance.now() + 30000; ; await wait(50)) {
    try { if ((await raw('/api/session')).status === 401) break; } catch {}
    if (performance.now() > end) throw new Error('payload did not start');
  }
  const stop = async () => { const gone = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGTERM'); await gone; };
  // .56: o corpo em bytes (as capas)
  const rawBin = (route) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: monitor, path: route }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(partes) }));
    }).on('error', reject);
  });
  return { raw, rawBin, local, stop, base, monitor };
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
    '"/api/teste/enviar"', 'guardaCursor', 'GP.rodaAte', 'window.jobeTelaCheiaPs5', 'k === 116 || k === 117', 'CODIGOS = { 38:', 'jobeGuarda', 'GP.porTeclas', 'window.jobeVoltar', '"← JOGOS"', '"← GAMES"', 'Biblioteca (em breve)', 'Homebrew (em breve)', '"/api/settings"', '"/api/app/telacheia"', 'root.dir = "rtl"',
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

test('glibren.58: a ficha e a grade da /app seguem o "na fila" do payload (pedido cancelado ou recusado volta a Baixar)', () => {
  const page = readFileSync(embed.APP_PAGE, 'utf8');
  assert.ok(!page.includes('known.queued || g.queued'), 'o "na fila" antigo nao gruda mais');
  assert.ok(page.includes('known.queued = Boolean(g.queued)'));
  assert.match(page, /if \(s === "loja"\) \{ agendar\(\); if \(loja\.revalidar\) revalidarFila\(\); \}/, 'voltar a loja reconsulta');
  assert.match(page, /else loja\.revalidar = true; \/\/ glibren\.58/, 'acao em Downloads marca a loja para reconsultar');
  const langs = [...page.matchAll(/"outraFonte":"([^"]+)"/g)];
  assert.equal(langs.length, 14, 'outraFonte nos 14 idiomas');
  assert.ok(langs.every(([, t]) => !/\.\.\.|…/.test(t)));
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
  if (process.env.JL_F8_SEM_LINHA_TROCADA === '1') argv.push('--sem-linha-trocada'); // glibren.61: ver medir.mjs
  const r = spawnSync(pwRunner.node, argv, { encoding: 'utf8', timeout: 540000, cwd: pwRunner.playwright ? '/mnt/c' : repo });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('JSON '));
  assert.ok(line, `sem resultado: ${(r.stderr || r.stdout || '').slice(-1500)}`);
  const result = JSON.parse(line.slice(5));
  assert.deepEqual(result.falhas, [], 'regras de tela, controle e teclado');
  assert.equal(r.status, 0);
  const medidas = JSON.parse(readFileSync(path.join(out, 'medidas.json'), 'utf8'));
  assert.deepEqual(medidas.resultados.map((x) => x.tamanho), ['360x780', '412x915', '780x360', '1280x800', '1920x1080', '1540x700-ps5', '1232x560-ps5', '412x915-ar']);
  for (const m of medidas.resultados) {
    assert.ok(m.montagem.cartoes > 0 && m.montagem.estado.count === 2639, `${m.tamanho}: montou com os 2.639 jogos`);
    assert.ok(m.rolagem.maxCartoesNoDom < 200, `${m.tamanho}: lista virtual`);
    assert.equal(m.montagem.estado.lista, /^(360x780|412x915)/.test(m.tamanho), `${m.tamanho}: lista em pe, grade deitado/PC/TV`);
    for (const shot of ['loja', 'ficha', 'parear', 'downloads', 'config']) assert.ok(existsSync(path.join(out, `app-${m.tamanho}-${shot}.png`)), `${m.tamanho} ${shot}.png`);
  }
});

test('Fase 8 + pareamento: o fluxo da janela da /app no payload de verdade (codigo na TV -> token -> Baixar e acoes da fila)', { skip }, async () => {
  const p = await startPayload();
  const info = JSON.parse((await p.raw('/api/pair')).text);
  assert.equal(info.ok, true, 'GET /api/pair: a pagina sabe que ha pareamento');
  // um celular na rede chega pelo IP do PS5 (no PC o 127.0.0.1 so e isento com BGDL_TEST_LOCAL=1: aqui vale o token)
  const remoto = { host: '192.168.0.20:34201' };
  assert.equal((await p.raw('/api/store/add', { method: 'POST', body: { id: 'PPSA00001' }, ...remoto })).status, 401, 'sem token: a janela de pareamento abre');
  const pedido = await p.raw('/api/pair/request', { method: 'POST', body: { name: 'Celular de teste' }, ...remoto });
  assert.equal(pedido.status, 200, pedido.text);
  const codigo = JSON.parse((await p.local('/pair')).text).code;
  assert.match(codigo, /^\d{6}$/, 'o codigo que a TV mostra');
  const ok = await p.raw('/api/pair/confirm', { method: 'POST', body: { code: codigo, name: 'Celular de teste' }, ...remoto });
  assert.equal(ok.status, 200, ok.text);
  const token = JSON.parse(ok.text).token;
  assert.match(token, /^[0-9a-f]{64}$/, 'o token que a pagina guarda em jobe.session');
  // o token (em X-Session, como a pagina manda) passa nas rotas protegidas que a /app usa
  assert.notEqual((await p.raw('/api/store/add', { method: 'POST', body: { id: 'PPSA00001' }, session: token })).status, 401, 'Baixar com o token');
  assert.notEqual((await p.raw('/api/jobs/x/pause', { method: 'POST', session: token })).status, 401, 'acoes da fila com o token');
  assert.notEqual((await p.raw('/api/store/add', { method: 'POST', body: { id: 'PPSA00001' }, headers: { Authorization: `Bearer ${token}` } })).status, 401, 'Bearer tambem');
  await p.stop();
});

test('Fase 8: os textos da /app nos 14 idiomas e o link da pagina do celular estao em dia (rode tools/web-app/textos.mjs)', () => {
  const { textos, faltou } = textosGer.montar();
  assert.deepEqual(faltou, [], 'nenhuma frase sem traducao');
  assert.deepEqual(Object.keys(textos).sort(), ['ar', 'bn', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'pt-BR', 'ru', 'ur', 'zh-Hans']);
  for (const [idioma, t] of Object.entries(textos)) for (const k of ['busca', 'baixar', 'voltarJogos', 'parTit']) assert.ok(t[k], `${idioma}.${k}`);
  for (const [idioma, t] of Object.entries(textos)) for (const [k, v] of Object.entries(t)) if (typeof v === 'string') {
    const marcas = (textos.en[k] || '').match(/\{\w+\}/g) || [];
    for (const m of marcas) assert.ok(v.includes(m), `${idioma}.${k} perdeu ${m}`);
  }
  assert.equal(readFileSync(textosGer.PAGINA, 'utf8'), textosGer.pagina(), 'bg_app.html em dia');
  assert.equal(readFileSync(textosGer.CELULAR, 'utf8'), textosGer.paginaCelular(), 'bg_monitor.html em dia');
  assert.match(readFileSync(textosGer.CELULAR, 'utf8'), /<a class="applink" id="appLink" href="\/app">/, 'link para a /app logo abaixo do cabecalho');
});

test('Fase 8: tela cheia no PS5 pelo glibren (GET/POST /api/app/telacheia): monitor_strong, X-GLR, UA do PS5 e reabre a /app', { skip }, async () => {
  const pedidos = [];
  const glr = http.createServer((req, res) => {
    let corpo = ''; req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      pedidos.push({ metodo: req.method, url: req.url, glr: req.headers['x-glr'], ua: req.headers['user-agent'], corpo });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/payloads/ativar') return res.end('{"ok":true}');
      res.end('{"ok":true,"ocupado":false,"itens":[{"id":"outro","estado":"pronto"},{"id":"web-browser-fullscreen","estado":"ativado"}]}');
    });
  });
  const porta = await freePort();
  await new Promise((r) => glr.listen(porta, '127.0.0.1', r));
  try {
    const sem = await startPayload();
    assert.equal(JSON.parse((await sem.raw('/api/app/telacheia')).text).glibren, false, 'sem glibren: o botao some');
    await sem.stop();
    const p = await startPayload({ glibren: porta });
    const info = JSON.parse((await p.raw('/api/app/telacheia')).text);
    assert.equal(info.glibren, true); assert.equal(info.item, true); assert.equal(info.estado, 'ativado');
    const remoto = { host: '192.168.0.20:34201' };
    assert.equal((await p.raw('/api/app/telacheia', { method: 'POST', body: { volta: '#/loja' }, ...remoto })).status, 401, 'sem credencial');
    assert.equal((await p.raw('/api/pair/request', { method: 'POST', body: { name: 'PC' }, ...remoto })).status, 200);
    const codigo = JSON.parse((await p.local('/pair')).text).code;
    const token = JSON.parse((await p.raw('/api/pair/confirm', { method: 'POST', body: { code: codigo, name: 'PC' }, ...remoto })).text).token;
    const ok = await p.raw('/api/app/telacheia', { method: 'POST', body: { volta: '#/jogo/PPSA01234' }, session: token, ...remoto });
    assert.equal(ok.status, 200, ok.text);
    const ativar = pedidos.find((x) => x.url === '/api/payloads/ativar');
    assert.ok(ativar && ativar.metodo === 'POST' && ativar.glr === '1' && /PlayStation/.test(ativar.ua) && ativar.corpo === 'id=web-browser-fullscreen', JSON.stringify(ativar));
    const log = path.join(p.base, 'state/bgdl.log');
    let texto = '';
    for (const fim = performance.now() + 15000; performance.now() < fim; await wait(200)) { texto = existsSync(log) ? readFileSync(log, 'utf8') : ''; if (/abriria o navegador em/.test(texto)) break; }
    assert.match(texto, /abriria o navegador em http:\/\/127\.0\.0\.1:\d+\/app#\/jogo\/PPSA01234/, 'reabre a /app no mesmo lugar');
    assert.equal((await p.raw('/api/app/telacheia', { method: 'POST', body: { volta: '//exemplo.com' }, session: token, ...remoto })).status, 200);
    for (const fim = performance.now() + 15000; performance.now() < fim; await wait(200)) { texto = readFileSync(log, 'utf8'); if ((texto.match(/abriria o navegador em/g) || []).length >= 2) break; }
    assert.match(texto, /abriria o navegador em http:\/\/127\.0\.0\.1:\d+\/app$/m, 'uma "volta" que nao e hash da /app e descartada');
    await p.stop();
  } finally { glr.close(); }
});

// ---- .56: o proxy de capas da /app (app/native/bg_capa.c) ----
// Um PNG de 1x1 (o icon0.png falso do jogo instalado) e um JPEG minimo (so o comeco importa para o payload).
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
function storeIndex(games) {
  return JSON.stringify({ version: 1, key: 'kc', builtAt: 'x', console: 'ps5', readyFirmware: '13.60', facets: {},
    games: games.map((g, i) => ({ code: g.id, platform: 'ps5', s: g.title.toLowerCase(), formats: [], solo: null, rank: [i, i, i, i, i], ...g })) });
}
// Um certificado para 127.0.0.1 e capas.invalid (o nome que so o DoH falso resolve); null sem o openssl.
function certificado() {
  const pasta = path.join(dir, 'cert');
  mkdirSync(pasta, { recursive: true });
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=capas-teste', '-addext', 'subjectAltName=DNS:capas.invalid,IP:127.0.0.1',
    '-keyout', path.join(pasta, 'key.pem'), '-out', path.join(pasta, 'cert.pem')], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return { key: readFileSync(path.join(pasta, 'key.pem')), cert: readFileSync(path.join(pasta, 'cert.pem')), file: path.join(pasta, 'cert.pem') };
}
const tls = compiler ? certificado() : null;
async function servidorHttps(handler) {
  const server = https.createServer({ key: tls.key, cert: tls.cert }, handler);
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, port };
}
// Uma resposta DNS (wire format, RFC 8484) que diz 127.0.0.1 para qualquer pergunta A e nada para as outras.
function respostaDns(q) {
  let i = 12;
  while (q[i]) i += q[i] + 1;
  const fimPergunta = i + 5, tipo = q.readUInt16BE(i + 1);
  const cab = Buffer.from(q.subarray(0, 12));
  cab.writeUInt16BE(0x8180, 2); cab.writeUInt16BE(1, 4); cab.writeUInt16BE(tipo === 1 ? 1 : 0, 6); cab.writeUInt16BE(0, 8); cab.writeUInt16BE(0, 10);
  const partes = [cab, q.subarray(12, fimPergunta)];
  if (tipo === 1) partes.push(Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]));
  return Buffer.concat(partes);
}

test('.56: /app/capa serve o icon0.png do jogo instalado, sem sessao; id ruim 400; sem capa 404; Host com nome 403', { skip }, async () => {
  const p = await startPayload();
  mkdirSync(path.join(p.base, 'appmeta/PPSA01001'), { recursive: true });
  writeFileSync(path.join(p.base, 'appmeta/PPSA01001/icon0.png'), PNG_1PX);
  mkdirSync(path.join(p.base, 'store'), { recursive: true });
  writeFileSync(path.join(p.base, 'store/store-index.json'), storeIndex([{ id: 'PPSA01001', title: 'Instalado', cover: 'https://127.0.0.1:1/a.png' }, { id: 'PPSA01002', title: 'Sem Nada', cover: 'https://127.0.0.1:1/b.webp' }]));
  const local = await p.rawBin('/app/capa?id=PPSA01001');
  assert.equal(local.status, 200);
  assert.equal(local.headers['content-type'], 'image/png');
  assert.equal(local.headers['x-capa-fonte'], 'local');
  assert.match(local.headers['cache-control'], /max-age=86400/);
  assert.ok(local.body.equals(PNG_1PX), 'o icon0.png inteiro');
  assert.equal((await p.raw('/app/capa?id=../../etc')).status, 400);
  assert.equal((await p.raw('/app/capa?id=ppsa01001')).status, 400, 'so o codigo em maiusculas');
  assert.equal((await p.raw('/app/capa')).status, 400);
  const nada = await p.raw('/app/capa?id=PPSA01002');
  assert.equal(nada.status, 404, nada.text);
  assert.equal(JSON.parse(nada.text).error, 'sem-capa');
  assert.equal((await p.raw('/app/capa?id=PPSA01002')).status, 404, 'a segunda vez nem tenta a rede (10 min)');
  assert.equal((await p.raw('/app/capa?id=PPSA01001', { host: 'capas.exemplo.com' })).status, 403, 'J6: Host com nome');
  assert.equal((await p.raw('/app/capa?id=PPSA01001', { method: 'POST' })).status, 404, 'so GET');
  const conta = JSON.parse((await p.raw('/api/app/capas')).text);
  assert.equal(conta.local, 1); assert.equal(conta.falhou, 1); assert.equal(conta.semCapa, 1);
  assert.match((await p.raw('/app')).headers['content-security-policy'], /img-src 'self' data: https:;/, 'a CSP deixa a /app mostrar /app/capa');
  await p.stop();
});

test('.56: /app/capa baixa a capa do catalogo pelo payload (HTTPS verificado), guarda no cache em disco e recusa o que nao e imagem', { skip: skip || (!tls && 'sem openssl') }, async () => {
  const pedidos = [];
  const site = await servidorHttps((req, res) => {
    pedidos.push(req.url);
    if (req.url === '/d.jpg') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(JPEG); }
    if (req.url === '/e.png') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>pagina de erro</html>'); }
    res.writeHead(404); res.end();
  });
  try {
    const p = await startPayload({ env: { BGDL_CAINFO: tls.file } });
    mkdirSync(path.join(p.base, 'store'), { recursive: true });
    writeFileSync(path.join(p.base, 'store/store-index.json'), storeIndex([
      { id: 'PPSA02001', title: 'Baixa', cover: `https://127.0.0.1:${site.port}/d.jpg` },
      { id: 'PPSA02002', title: 'Html', cover: `https://127.0.0.1:${site.port}/e.png` }]));
    const rede = await p.rawBin('/app/capa?id=PPSA02001');
    assert.equal(rede.status, 200, rede.body.toString());
    assert.equal(rede.headers['content-type'], 'image/jpeg');
    assert.equal(rede.headers['x-capa-fonte'], 'rede');
    assert.ok(rede.body.equals(JPEG));
    assert.ok(existsSync(path.join(p.base, 'state/capas/PPSA02001.jpg')), 'no cache em disco');
    const cache = await p.rawBin('/app/capa?id=PPSA02001');
    assert.equal(cache.headers['x-capa-fonte'], 'cache');
    assert.equal(pedidos.filter((u) => u === '/d.jpg').length, 1, 'do cache: o site nao e chamado de novo');
    assert.equal((await p.raw('/app/capa?id=PPSA02002')).status, 404, 'HTML no lugar da imagem nao serve');
    assert.ok(!existsSync(path.join(p.base, 'state/capas/PPSA02002.png')));
    await p.stop();
  } finally { site.server.close(); }
});

test('.56: /app/capa com um nome que o DNS do sistema nao resolve (como o 0.0.0.0 do DNS que bloqueia): tenta de novo pelo DoH', { skip: skip || (!tls && 'sem openssl') }, async () => {
  const site = await servidorHttps((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG_1PX); });
  let perguntas = 0;
  const doh = await servidorHttps((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      perguntas++;
      const q = req.method === 'GET' ? Buffer.from(new URL(req.url, 'https://x').searchParams.get('dns') || '', 'base64url') : Buffer.concat(partes);
      res.writeHead(200, { 'Content-Type': 'application/dns-message' });
      res.end(respostaDns(q));
    });
  });
  try {
    const p = await startPayload({ env: { BGDL_CAINFO: tls.file, BGDL_CAPA_DOH: `https://127.0.0.1:${doh.port}/dns-query` } });
    mkdirSync(path.join(p.base, 'store'), { recursive: true });
    writeFileSync(path.join(p.base, 'store/store-index.json'), storeIndex([{ id: 'PPSA03001', title: 'Bloqueado', cover: `https://capas.invalid:${site.port}/c.png` }]));
    const r = await p.rawBin('/app/capa?id=PPSA03001');
    assert.equal(r.status, 200, r.body.toString());
    assert.equal(r.headers['x-capa-fonte'], 'doh');
    assert.ok(perguntas > 0, 'perguntou ao DoH');
    const log = readFileSync(path.join(p.base, 'state/bgdl.log'), 'utf8');
    assert.match(log, /capa: PPSA03001: capas\.invalid falhou \(curl 6 /, 'o motivo da falha no diario');
    assert.match(log, /capa: PPSA03001: capas\.invalid pelo DoH/);
    assert.equal(JSON.parse((await p.raw('/api/app/capas')).text).doh, 1);
    await p.stop();
  } finally { site.server.close(); doh.server.close(); }
});

test('.56: no Chromium com o UA do PS5 a capa que falha vai para /app/capa (icon0 local abre; sem nada, o nome no lugar) e as contagens vao nas medidas; no celular nada vai ao proxy', { skip: skip || (pwRunner ? false : 'sem Playwright (nem neste Node nem no do Windows)'), timeout: 180000 }, async () => {
  const p = await startPayload();
  mkdirSync(path.join(p.base, 'appmeta/PPSA04001'), { recursive: true });
  writeFileSync(path.join(p.base, 'appmeta/PPSA04001/icon0.png'), PNG_1PX);
  mkdirSync(path.join(p.base, 'store'), { recursive: true });
  writeFileSync(path.join(p.base, 'store/store-index.json'), storeIndex([
    { id: 'PPSA04001', title: 'Instalado Local', cover: 'https://127.0.0.1:1/a.png' },
    { id: 'PPSA04002', title: 'Sem Capa Nenhuma', cover: 'https://127.0.0.1:1/b.webp' },
    { id: 'PPSA04003', title: 'Capa Boa', cover: 'https://capas-boa.example/ok.png' }])); // o capas-pw.mjs responde esta no Chromium
  const script = pwRunner.playwright ? wslPath(path.join(repo, 'tools/web-app/capas-pw.mjs')) : path.join(repo, 'tools/web-app/capas-pw.mjs');
  const argv = [script, `--url=http://127.0.0.1:${p.monitor}/app`];
  if (pwRunner.playwright) argv.push(`--playwright=${pwRunner.playwright}`);
  const r = spawnSync(pwRunner.node, argv, { encoding: 'utf8', timeout: 150000, cwd: pwRunner.playwright ? '/mnt/c' : repo });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('JSON '));
  assert.ok(line, `sem resultado: ${(r.stderr || r.stdout || '').slice(-1500)}`);
  const { ps5, celular } = JSON.parse(line.slice(5));
  assert.deepEqual(ps5.proxy.sort(), ['/app/capa?id=PPSA04001', '/app/capa?id=PPSA04002'], 'PS5: as duas que falharam foram ao proxy');
  assert.deepEqual(ps5.ok.sort(), ['Capa Boa', 'Instalado Local'], 'PS5: a direta e a do icon0 local abriram');
  assert.deepEqual(ps5.nome, ['Sem Capa Nenhuma'], 'PS5: sem nada, o nome do jogo no lugar');
  assert.equal(ps5.capas.ok, 1); assert.equal(ps5.capas.erro, 2); assert.equal(ps5.capas.proxyOk, 1); assert.equal(ps5.capas.proxyErro, 1); assert.equal(ps5.capas.nome, 1);
  assert.deepEqual(ps5.capas.hosts['127.0.0.1 .png'], { ok: 0, erro: 1 });
  assert.deepEqual(ps5.capas.hosts['127.0.0.1 .webp'], { ok: 0, erro: 1 });
  assert.match(ps5.tela, /capas: 1 abriram, 2 falharam, 0 demoraram mais de 8 s; proxy do payload: 1 abriram, 1 falharam/);
  assert.match(ps5.tela, /capas por host: .*127\.0\.0\.1 \.png 0 ok\/1 erro/);
  assert.deepEqual(celular.proxy, [], 'celular: nada vai ao proxy');
  assert.deepEqual(celular.ok, ['Capa Boa']);
  assert.match(celular.tela, /fora do PS5: sem proxy/);
  await p.stop();
});

test('.56: REGRA FIXA: o proxy nunca baixa nem resolve por DoH um host da Sony (image.api.playstation.com e afins)', { skip: skip || (!tls && 'sem openssl') }, async () => {
  let perguntas = 0;
  const doh = await servidorHttps((req, res) => {
    req.resume();
    req.on('end', () => { perguntas++; res.writeHead(200, { 'Content-Type': 'application/dns-message' }); res.end(); });
  });
  try {
    const p = await startPayload({ env: { BGDL_CAINFO: tls.file, BGDL_CAPA_DOH: `https://127.0.0.1:${doh.port}/dns-query` } });
    mkdirSync(path.join(p.base, 'store'), { recursive: true });
    writeFileSync(path.join(p.base, 'store/store-index.json'), storeIndex([
      { id: 'PPSA05001', title: 'Sony 1', cover: 'https://image.api.playstation.com/vulcan/ap/rnd/x.png?w=440' },
      { id: 'PPSA05002', title: 'Sony 2', cover: 'https://IMAGE.API.PlayStation.COM./y.png' },
      { id: 'PPSA05003', title: 'Sony 3', cover: 'https://gmedia.playstation.net/z.jpg' },
      { id: 'PPSA05004', title: 'Sony 4', cover: 'https://www.sony.com/w.jpg' }]));
    for (const id of ['PPSA05001', 'PPSA05002', 'PPSA05003', 'PPSA05004']) {
      const r = await p.raw(`/app/capa?id=${id}`);
      assert.equal(r.status, 404, `${id}: ${r.text}`);
    }
    assert.equal(perguntas, 0, 'nenhuma pergunta ao DoH');
    const log = readFileSync(path.join(p.base, 'state/bgdl.log'), 'utf8');
    assert.doesNotMatch(log, /playstation|sony\.com/i, 'nem tentou baixar');
    assert.match(log, /capa: PPSA05001: sem endereco de capa no catalogo/);
    await p.stop();
  } finally { doh.server.close(); }
});

// .56 (pedido do dono): sem capa do catalogo que abra, a do site de patches pelo TitleID (prosperopatches PS5,
// orbispatches PS4, como o glibren faz com os icones), baixada pelo payload; um icone da Sony achado na pagina e recusado.
test('.56: /app/capa cai no site de patches pelo TitleID (icone da pagina, pelo payload; nunca a Sony) e conta em patches', { skip }, async () => {
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(12)]);
  const pedidos = [];
  const site = http.createServer((req, res) => {
    pedidos.push(req.url);
    const base = `http://127.0.0.1:${site.address().port}`;
    if (req.url === '/PPSA06001') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<html><meta property="og:title" content="PPSA06001: Jogo"><div class="game-icon lazy" style="background-image: url(&quot;${base}/i.webp&quot;)"></div></html>`); }
    if (req.url === '/CUSA06002') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<div class="game-icon" style="background-image:url(https://image.api.playstation.com/x.png)"></div>'); }
    if (req.url === '/i.webp') { res.writeHead(200, { 'Content-Type': 'image/webp' }); return res.end(WEBP); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  try {
    const p = await startPayload({ env: { BGDL_CAPA_PATCHES: `http://127.0.0.1:${site.address().port}/` } });
    mkdirSync(path.join(p.base, 'store'), { recursive: true });
    writeFileSync(path.join(p.base, 'store/store-index.json'), storeIndex([
      { id: 'PPSA06001', title: 'Capa da Sony', cover: 'https://image.api.playstation.com/a.png' },
      { id: 'CUSA06002', title: 'Icone da Sony', cover: 'https://image.api.playstation.com/b.png' }]));
    const r = await p.rawBin('/app/capa?id=PPSA06001');
    assert.equal(r.status, 200, r.body.toString());
    assert.equal(r.headers['content-type'], 'image/webp');
    assert.equal(r.headers['x-capa-fonte'], 'rede');
    assert.ok(r.body.equals(WEBP));
    assert.ok(existsSync(path.join(p.base, 'state/capas/PPSA06001.webp')), 'no cache em disco');
    assert.equal((await p.raw('/app/capa?id=CUSA06002')).status, 404, 'icone da Sony na pagina: recusado');
    assert.ok(pedidos.includes('/CUSA06002') && !pedidos.some((u) => /playstation/.test(u)));
    const conta = JSON.parse((await p.raw('/api/app/capas')).text);
    assert.equal(conta.patches, 1);
    assert.equal(conta.rede, 0, 'a capa da Sony do catalogo nao foi baixada');
    await p.stop();
  } finally { site.close(); }
});

// glibren.58: a secao Downloads da /app tambem mostra as conversoes do payload (o /api/status ja as traz): a extracao em
// andamento com "Extraindo do .7z", %, GB, velocidade, tempo e "limitado pelo processador"; a falha antiga do mesmo item
// some. As funcoes da pagina rodam aqui com um DOM minimo.
test('glibren.58: a /app mostra a conversao/extracao do payload na secao Downloads', async () => {
  const vm = await import('node:vm');
  const page = readFileSync(path.join(repo, 'app/native/bg_app.html'), 'utf8');
  const a = page.indexOf('  var CONV_ANDANDO'), b = page.indexOf('  function desenharDownloads()');
  assert.ok(a > 0 && b > a, 'o bloco das conversoes');
  assert.ok(page.includes('dl.convs = conversoesVivas(r.data.conversions)') && page.includes('lista.appendChild(cartaoConversao(cv))'));
  const { textos } = textosGer.montar();
  for (const [idioma, t] of Object.entries(textos)) for (const k of ['extraindoDe', 'cpu', 'extraidos', 'convertendo', 'naFila', 'falhou']) assert.ok(t.conv?.[k], `${idioma}.conv.${k}`);
  const el = (tag, cls, text) => ({ tag, cls, text: text ?? '', kids: [], style: {}, appendChild(k) { this.kids.push(k); return k; } });
  const all = (n) => [n.text, ...n.kids.flatMap(all)].filter(Boolean);
  const ctx = { el, Date, Object, Array, Number, L: { ...textos['pt-BR'], de: 'de' },
    fill: (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? ''), nf: (v, d) => Number(v).toFixed(d),
    bytes: (x) => `${(x / 2 ** 30).toFixed(1)} GB`, speed: (x) => `${(x / 2 ** 20).toFixed(1)} MB/s`, eta: (s) => `${Math.round(s)} s` };
  vm.runInNewContext(`${page.slice(a, b)}; this.vivas = conversoesVivas; this.cartao = cartaoConversao;`, ctx);
  const GB = 2 ** 30;
  const vivas = ctx.vivas([
    { id: 'c21', name: 'Alan Wake 2', target: 'PPSA02572.exfat', state: 'failed', error: 'write: x' },
    { id: 'c30', name: 'Alan Wake 2', target: 'PPSA02572.exfat', state: 'extracting', written: 34 * GB, total: 91 * GB, extractFormat: '7z', extracted: 34 * GB, extractTotal: 91 * GB,
      extractBytesPerSecond: 15 * 2 ** 20, extractPercent: 37, extractEtaSeconds: 3900, limitedBy: 'cpu' },
  ]);
  assert.deepEqual(vivas.map((c) => c.id), ['c30'], 'a falha antiga do mesmo item some');
  const textos30 = all(ctx.cartao(vivas[0]));
  for (const t of ['Alan Wake 2', 'Extraindo do .7z', '37%', '34.0 GB de 91.0 GB extraídos', '15.0 MB/s', '3900 s', 'EXFAT']) assert.ok(textos30.includes(t), `${t} em ${textos30.join('|')}`);
  assert.ok(textos30.some((t) => t.startsWith('Limitado pelo processador')), textos30.join('|'));
  // Um zip: sem o motivo; um payload antigo (sem os campos): "Descompactando", sem %.
  const zip = all(ctx.cartao({ id: 'z', name: 'Z', state: 'extracting', extractFormat: 'zip', extracted: GB, extractTotal: 2 * GB, extractPercent: 50, extractEtaSeconds: -1, extractBytesPerSecond: 0, limitedBy: '' }));
  assert.ok(zip.includes('Extraindo do .zip') && zip.includes('50%') && !zip.some((t) => t.startsWith('Limitado')), zip.join('|'));
  const antigo = all(ctx.cartao({ id: 'o', name: 'O', state: 'extracting', written: 0, total: 0 }));
  assert.ok(antigo.includes(textos['pt-BR'].conv.extraindo), antigo.join('|'));
  // Convertendo: velocidade entre duas leituras.
  ctx.vivas([{ id: 'k', name: 'K', state: 'converting', written: 10 * GB, total: 40 * GB }]);
  await new Promise((r) => setTimeout(r, 30));
  const conv = ctx.vivas([{ id: 'k', name: 'K', state: 'converting', written: 11 * GB, total: 40 * GB }]);
  assert.ok(conv[0].convBps > 0, 'velocidade da conversao');
  assert.ok(all(ctx.cartao(conv[0])).includes(textos['pt-BR'].conv.convertendo));
});
