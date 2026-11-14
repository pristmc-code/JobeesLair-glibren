// Fase 8: mede e confere a Jobe web completa (app/native/bg_app.html) no Chromium, com o Playwright, contra a API falsa
// (tools/web-app/api-falsa.mjs, 2.639 jogos). Para cada tamanho (celular em pe 360x780 e 412x915, deitado 780x360, PC
// 1280x800, e o navegador do PS5 com o user agent dele: 1920x1080 (tela cheia pelo patch), 1540x700 (com a moldura) e
// 1232x560 (zoom de 125%)):
//   - montagem: do inicio do script ate a 1a pagina de capas na tela (window.jobeApp.montagemMs) e desde a navegacao;
//   - rolagem: a grade inteira de cima a baixo, 35% da altura por quadro (bem mais rapido que um polegar), com o tempo
//     de cada quadro (media, p95, pior), quantos cartoes existiam no DOM (lista virtual) e quantas capas foram pedidas;
//   - regras de tela: nada rola de lado, nada de reticencias, botoes de uma linha com a mesma largura, "<- JOGOS" primeiro;
//   - prints: loja, ficha, pareamento e downloads.
// --checar: tambem o controle (Gamepad API falsa) e o teclado, e sai com codigo 1 se alguma regra falhar.
// --rapido: rolagem curta (para a suite de testes); as medidas de desempenho valem so sem ele.
// Uso: node tools/web-app/medir.mjs [--saida=<pasta>] [--checar] [--playwright=<pasta ou index.mjs do playwright>]
//      [--tamanhos=360x780,1280x800]
// Sem --playwright: import('playwright'). Navegador: o Chromium do Playwright; se faltar, o Chrome ou o Edge instalados.
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { apiFalsa } from './api-falsa.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const checar = Boolean(args.checar);
const rapido = Boolean(args.rapido); // a suite: rolagem curta (150 quadros e 1,5 s de leitura) e um salto ao fim da lista
const saida = path.resolve(typeof args.saida === 'string' ? args.saida : path.join(os.tmpdir(), 'jobe-web-medidas'));
mkdirSync(saida, { recursive: true });

async function carregarPlaywright() {
  const alvo = typeof args.playwright === 'string' ? args.playwright : '';
  if (!alvo) return import('playwright');
  let arquivo = alvo;
  if (existsSync(arquivo) && statSync(arquivo).isDirectory()) arquivo = path.join(arquivo, 'index.mjs');
  return import(pathToFileURL(arquivo).href);
}
const { chromium } = await carregarPlaywright();
async function abrirNavegador() {
  const erros = [];
  for (const opcoes of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return { navegador: await chromium.launch(opcoes), canal: opcoes.channel || 'chromium' }; } catch (e) { erros.push(String(e.message).split('\n')[0]); }
  }
  throw new Error(`nenhum Chromium abriu: ${erros.join(' | ')}`);
}

const PS5_UA = 'Mozilla/5.0 (PlayStation; PlayStation 5/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const TODOS = [
  { nome: '360x780', w: 360, h: 780, movel: true },
  { nome: '412x915', w: 412, h: 915, movel: true },
  { nome: '780x360', w: 780, h: 360, movel: true },
  { nome: '1280x800', w: 1280, h: 800, movel: false },
  { nome: '1920x1080', w: 1920, h: 1080, movel: false, ps5: true },
  // navegador do PS5 com a moldura (1540x700, PS5 real) e com o zoom de 125% (~1232x560, o minimo); 1920x1080 acima e o
  // PS5 com o patch de tela cheia (ps5/PESQUISA-navegador-ps5-tela-cheia.md)
  { nome: '1540x700-ps5', w: 1540, h: 700, movel: false, ps5: true },
  { nome: '1232x560-ps5', w: 1232, h: 560, movel: false, ps5: true },
  // da direita para a esquerda (arabe) no celular
  { nome: '412x915-ar', w: 412, h: 915, movel: true, idioma: 'ar' },
];
const pedidos = typeof args.tamanhos === 'string' ? args.tamanhos.split(',') : null;
const TAMANHOS = pedidos ? TODOS.filter((t) => pedidos.includes(t.nome)) : TODOS;

const falhas = [];
const conferir = (ok, texto) => { if (!ok) falhas.push(texto); };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// As regras de tela, medidas dentro da pagina.
const REGRAS = () => {
  const w = innerWidth;
  const largo = [document.documentElement, document.body, ...document.querySelectorAll('#app, main, .sec, #grade, #ficha, #fCorpo, #dLista, #nav')]
    .filter((e) => e && e.getClientRects().length)
    .filter((e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > w + 1)
    .map((e) => `${e.id || e.tagName} ${e.scrollWidth}>${e.clientWidth}`);
  const reticencias = [...document.querySelectorAll('body *')].filter((e) => getComputedStyle(e).textOverflow === 'ellipsis').length;
  const desiguais = [];
  const grupos = [...document.querySelectorAll('.fila, .resumo')].filter((e) => e.getClientRects().length);
  if (document.querySelector('#nav').getClientRects().length && getComputedStyle(document.querySelector('#nav')).display === 'grid') grupos.push(document.querySelector('#nav'));
  for (const g of grupos) {
    const linhas = new Map();
    for (const c of g.children) { if (!c.getClientRects().length || c.classList.contains('marca')) continue; const r = c.getBoundingClientRect(); const k = Math.round(r.top); if (!linhas.has(k)) linhas.set(k, []); linhas.get(k).push(r.width); }
    for (const ws of linhas.values()) if (Math.max(...ws) - Math.min(...ws) > 1.5) desiguais.push(`${g.id || g.className}: ${ws.map((x) => x.toFixed(0)).join('/')}`);
  }
  // texto cortado: titulo com mais conteudo do que a caixa mostra
  const cortados = [...document.querySelectorAll('.card .t, .fcab h2, #fTitulo, .job .nome')].filter((e) => e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2).length;
  return { largo, reticencias, desiguais, cortados };
};

let passo = '';
async function medirTamanho(navegador, api, t, jogo) {
  const contexto = await navegador.newContext({ viewport: { width: t.w, height: t.h }, deviceScaleFactor: 1, isMobile: t.movel, hasTouch: t.movel, locale: t.idioma || 'pt-BR',
    ...(t.ps5 ? { userAgent: PS5_UA } : {}) });
  if (checar) await contexto.addInitScript(() => {
    const pad = { id: 'controle falso', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], timestamp: 0, buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    window.__lidos = 0;
    navigator.getGamepads = () => { window.__lidos++; return [pad]; };
  });
  const pagina = await contexto.newPage();
  const errosJs = [];
  pagina.on('pageerror', (e) => errosJs.push(String(e.message)));
  // 401/403 sao respostas esperadas (Baixar sem credencial, o codigo errado de proposito): o navegador registra, nao e erro
  pagina.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: .*status of 40[13]/.test(m.text())) errosJs.push(m.text()); });
  const antes = { ...api.contadores };
  const t0 = Date.now();
  await pagina.goto(`${api.url}/app`, { waitUntil: 'domcontentloaded' });
  passo = 'await pagina.waitForFunction(() => window.jobeApp && window.jobeApp.mo';
  await pagina.waitForFunction(() => window.jobeApp && window.jobeApp.montadoMs !== null, null, { timeout: 15000 });
  const montagem = await pagina.evaluate(() => ({ montagemMs: window.jobeApp.montagemMs, desdeNavegacaoMs: window.jobeApp.montadoMs, cartoes: window.jobeApp.cartoes(), estado: window.jobeApp.estado() }));
  montagem.paredeMs = Date.now() - t0;
  await pagina.waitForTimeout(400); // capas da 1a tela
  const capasNaMontagem = api.contadores.capas - antes.capas;
  // navegador do PS5: cabecalho baixo no alto (sem barra lateral), fonte pela area util, botao Tela cheia (o Chromium tem a API)
  const tela = await pagina.evaluate(() => { const r = document.getElementById('nav').getBoundingClientRect(); const b = document.getElementById('bTela');
    return { ps5: document.documentElement.classList.contains('ps5'), navL: Math.round(r.width), navA: Math.round(r.height), fonte: getComputedStyle(document.documentElement).fontSize,
      telaCheia: !b.hidden, cols: window.jobeApp.estado().cols, medidas: window.jobeApp.tela() }; });
  if (t.ps5) {
    conferir(tela.ps5, `${t.nome}: o UA do PS5 nao marcou html.ps5`);
    conferir(tela.navL >= t.w - 2 && tela.navA <= t.h * 0.12, `${t.nome}: no PS5 a navegacao devia ser um cabecalho baixo (${tela.navL}x${tela.navA})`);
  }
  // fora do PS5 o Chromium tem a Fullscreen API: o botao aparece; no PS5 nao (a moldura e do ShellUI; so o gancho do payload)
  // fora do PS5: a Fullscreen API; no PS5: o ⛶ pelo glibren (no ar na API falsa) aparece logo depois de perguntar
  if (!t.ps5) conferir(tela.telaCheia, `${t.nome}: botao Tela cheia devia aparecer (Chromium tem a API)`);
  if (t.ps5 && t.h >= 1060) conferir(!tela.telaCheia, `${t.nome}: ja em tela cheia, o ⛶ nao devia aparecer`);
  const r1 = await pagina.evaluate(REGRAS);
  await pagina.screenshot({ path: path.join(saida, `app-${t.nome}-loja.png`) });
  // o 1o botao da navegacao e "Jogos" (fora da loja vira "<- JOGOS")
  const primeiroNav = await pagina.evaluate(() => document.querySelector('#nav .nb').textContent.trim());

  // ---- rolagem ----
  const antesRolar = { ...api.contadores };
  const antesRolarCapas = api.contadores.capas;
  const rolagem = await pagina.evaluate(async (limite) => {
    const g = document.getElementById('grade');
    const quadros = []; let ultimo = performance.now(), maxCartoes = 0, n = 0;
    const passo = Math.max(40, g.clientHeight * 0.35);
    const inicio = performance.now();
    await new Promise((fim) => {
      function f(t) {
        quadros.push(t - ultimo); ultimo = t; n++;
        maxCartoes = Math.max(maxCartoes, window.jobeApp.cartoes());
        if (g.scrollTop >= g.scrollHeight - g.clientHeight - 1 || n > limite) return fim();
        g.scrollTop += passo;
        requestAnimationFrame(f);
      }
      requestAnimationFrame(f);
    });
    const duracao = performance.now() - inicio;
    quadros.shift();
    const ord = [...quadros].sort((a, b) => a - b);
    const media = quadros.reduce((s, x) => s + x, 0) / Math.max(1, quadros.length);
    return { quadros: quadros.length, duracaoMs: Math.round(duracao), mediaMs: +media.toFixed(2), p95Ms: +ord[Math.floor(ord.length * 0.95)].toFixed(2), piorMs: +ord[ord.length - 1].toFixed(2),
      acima50ms: quadros.filter((x) => x > 50).length, maxCartoesNoDom: maxCartoes, alturaPx: g.scrollHeight, colunas: window.jobeApp.estado().cols };
  }, rapido ? 150 : 6000);
  await pagina.waitForTimeout(500);
  // rolagem de leitura: ~1 tela por segundo por 8 s (as capas carregam no caminho)
  const antesLenta = { ...api.contadores };
  await pagina.evaluate(() => { document.getElementById('grade').scrollTop = 0; });
  await pagina.waitForTimeout(300);
  const lenta = await pagina.evaluate(async (ms) => {
    const g = document.getElementById('grade'); const q = []; let u = performance.now(); const t0 = u;
    await new Promise((fim) => { function f(t) { q.push(t - u); u = t; if (t - t0 > ms) return fim(); g.scrollTop += Math.max(1, Math.round(g.clientHeight * q[q.length - 1] / 1000)); requestAnimationFrame(f); } requestAnimationFrame(f); });
    q.shift(); const o = [...q].sort((a, b) => a - b);
    const semCapa = [...document.querySelectorAll('.card:not(.vazio) .capa')].filter((c) => { const r = c.getBoundingClientRect(), q2 = g.getBoundingClientRect(); return r.bottom > q2.top && r.top < q2.bottom && !c.classList.contains('ok'); }).length;
    return { quadros: q.length, mediaMs: +(q.reduce((s, x) => s + x, 0) / q.length).toFixed(2), p95Ms: +o[Math.floor(o.length * 0.95)].toFixed(2), piorMs: +o[o.length - 1].toFixed(2), visiveisSemCapa: semCapa };
  }, rapido ? 1500 : 8000);
  lenta.capasPedidas = api.contadores.capas - antesLenta.capas;
  rolagem.leitura = lenta;
  // o fim da lista (com as alturas medidas a altura total muda: salta de novo ate parar)
  for (let k = 0; k < 6; k++) { await pagina.evaluate(() => { const g = document.getElementById('grade'); g.scrollTop = g.scrollHeight; }); await pagina.waitForTimeout(250); }
  rolagem.paginasPedidas = api.contadores.store - antesRolar.store;
  rolagem.capasPedidas = api.contadores.capas - antesRolarCapas - lenta.capasPedidas;
  rolagem.cartoesNoFim = await pagina.evaluate(() => window.jobeApp.cartoes());
  const ultimoVisivel = await pagina.evaluate(() => { const c = [...document.querySelectorAll('.card')].map((e) => +e.getAttribute('data-i')); return Math.max(...c); });
  conferir(ultimoVisivel === 2638, `${t.nome}: o fim da lista nao chegou ao jogo 2639 (${ultimoVisivel + 1})`);
  const r2 = await pagina.evaluate(REGRAS);

  // ---- ficha ----
  await pagina.evaluate(() => { document.getElementById('grade').scrollTop = 0; });
  await pagina.waitForTimeout(200);
  // um jogo de titulo longo (multiplo de 11 na API falsa: quebra de linha), outro em cada tamanho (a fila e a mesma)
  await pagina.evaluate((i) => window.jobeApp.focarCartao(i), jogo);
  passo = 'await pagina.click(`.card[data-i="${jogo}"]`);';
  await pagina.click(`.card[data-i="${jogo}"]`);
  passo = "await pagina.waitForSelector('#fBaixar', { timeout: 10000 });";
  await pagina.waitForSelector('#fBaixar', { timeout: 10000 });
  await pagina.waitForTimeout(400);
  const r3 = await pagina.evaluate(REGRAS);
  const fichaPrimeiro = await pagina.evaluate(() => { const f = document.querySelector('#ficha .fbar').firstElementChild; return f.textContent.trim(); });
  // glibren.55: as fontes sao botoes, "Automatico" escolhido de inicio; escolhido o link do navegador (o 3o), ele fica
  // destacado, mostra o aviso e vai no Baixar (link + ref).
  const fontes = await pagina.evaluate(() => [...document.querySelectorAll('#fCorpo .fontes button.fonte')].map((b) => b.getAttribute('aria-pressed')));
  conferir(fontes.length === 4 && fontes[0] === 'true' && fontes.slice(1).every((x) => x === 'false'), `${t.nome}: fontes escolhiveis com Automatico primeiro: ${fontes}`);
  await pagina.locator('#fCorpo .fontes button.fonte').nth(3).scrollIntoViewIfNeeded();
  // .58: a lista vem antes do Baixar (logo abaixo do titulo), com os selos; o Baixar diz a fonte ("Baixar (automatico)")
  const ordemFicha = await pagina.evaluate(() => { const u = document.querySelector('#fCorpo .fontes'), b = document.getElementById('fBaixar'); return Boolean(u && b && (u.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)); });
  conferir(ordemFicha, `${t.nome}: a lista de fontes devia vir antes do Baixar`);
  conferir(await pagina.evaluate(() => document.getElementById('fBaixar').textContent === window.jobeApp.L.baixarAuto), `${t.nome}: o Baixar devia dizer "automatico" de inicio`);
  const selos = await pagina.evaluate(() => document.querySelectorAll('#fCorpo .fontes button.fonte')[3].textContent);
  conferir(selos.includes('RAR') && /TorBox/.test(selos), `${t.nome}: o link do navegador sem os selos (formato, via TorBox): ${selos}`);
  await pagina.click('#fCorpo .fontes button.fonte >> nth=3');
  const escolhida = await pagina.evaluate(() => [...document.querySelectorAll('#fCorpo .fontes button.fonte')].map((b) => b.getAttribute('aria-pressed')));
  conferir(escolhida[3] === 'true' && escolhida[0] === 'false', `${t.nome}: o link tocado nao ficou escolhido: ${escolhida}`);
  // o 2o toque no mesmo nao desfaz a escolha; a marca "escolhida" aparece so nele; o Baixar diz o host
  await pagina.click('#fCorpo .fontes button.fonte >> nth=3');
  const marcaVisivel = await pagina.evaluate(() => [...document.querySelectorAll('#fCorpo .fontes button.fonte .marca')].map((m) => getComputedStyle(m).display !== 'none'));
  conferir(marcaVisivel[3] && marcaVisivel.filter(Boolean).length === 1, `${t.nome}: a marca "escolhida" devia estar so no link tocado: ${marcaVisivel}`);
  const textoBaixar = await pagina.evaluate(() => document.getElementById('fBaixar').textContent);
  conferir(/VikingFile/.test(textoBaixar), `${t.nome}: o Baixar devia dizer a fonte escolhida: ${textoBaixar}`);
  await pagina.screenshot({ path: path.join(saida, `app-${t.nome}-fontes.png`) });
  await pagina.evaluate(() => { document.getElementById('fCorpo').scrollTop = 0; });
  await pagina.screenshot({ path: path.join(saida, `app-${t.nome}-ficha.png`) });
  // Baixar sem credencial abre o pareamento: nome -> "Pedir codigo" -> codigo da TV (um errado antes) -> entra na fila
  passo = 'pareamento';
  await pagina.click('#fBaixar');
  await pagina.waitForSelector('#acesso:not([hidden]) #parForm:not([hidden])', { timeout: 5000 });
  const nomeSugerido = await pagina.inputValue('#parNome');
  conferir(Boolean(nomeSugerido), `${t.nome}: o nome do aparelho veio vazio`);
  await pagina.screenshot({ path: path.join(saida, `app-${t.nome}-parear.png`) });
  await pagina.click('#parSim');
  await pagina.waitForSelector('#parCodL:not([hidden])', { timeout: 5000 });
  await pagina.fill('#parCodigo', '000000');
  await pagina.click('#parSim');
  await pagina.waitForFunction(() => document.getElementById('parErro').textContent.length > 0, null, { timeout: 5000 });
  await pagina.fill('#parCodigo', '123456');
  await pagina.click('#parSim');
  await pagina.waitForFunction(() => document.getElementById('acesso').hidden, null, { timeout: 5000 });
  const guardado = await pagina.evaluate(() => localStorage.getItem('jobe.session'));
  conferir(/^[0-9a-f]{64}$/.test(guardado || ''), `${t.nome}: o token do aparelho nao foi guardado em jobe.session`);
  passo = "await pagina.waitForFunction(() => document.getElementById('fBaixar').";
  await pagina.waitForFunction(() => document.getElementById('fBaixar').disabled && document.getElementById('fBaixar').textContent === window.jobeApp.L.naFila, null, { timeout: 5000 });
  conferir(api.contadores.ultimoAdd?.link === 2 && typeof api.contadores.ultimoAdd?.ref === 'string', `${t.nome}: o Baixar nao mandou o link escolhido: ${JSON.stringify(api.contadores.ultimoAdd)}`);
  passo = "await pagina.click('#fVoltar');";
  await pagina.click('#fVoltar');
  passo = "await pagina.waitForFunction(() => document.getElementById('ficha').hi";
  await pagina.waitForFunction(() => document.getElementById('ficha').hidden, null, { timeout: 5000 });

  // ---- downloads ----
  passo = 'await pagina.click(\'#nav .nb[data-sec="downloads"]\');';
  await pagina.click('#nav .nb[data-sec="downloads"]');
  passo = "await pagina.waitForSelector('.job', { timeout: 5000 });";
  await pagina.waitForSelector('.job', { timeout: 5000 });
  await pagina.waitForTimeout(200);
  const r4 = await pagina.evaluate(REGRAS);
  const navFora = await pagina.evaluate(() => document.querySelector('#nav .nb').textContent.trim());
  await pagina.screenshot({ path: path.join(saida, `app-${t.nome}-downloads.png`) });

  // ---- configuracoes (/api/settings, com o token do pareamento acima) ----
  passo = 'configuracoes';
  await pagina.click('#nav .nb[data-sec="config"]');
  await pagina.waitForSelector('#cfg_backgroundDownloads', { timeout: 8000 }).catch(async (e) => {
    throw new Error(`${e.message.split(String.fromCharCode(10))[0]} | tela: ${await pagina.evaluate(() => document.getElementById('secConfig').innerText.slice(0, 300))}`); });
  const antesCfg = api.config.rev, antesValor = api.config.values.backgroundDownloads;
  await pagina.click('#cfg_backgroundDownloads');
  await pagina.waitForFunction(() => document.getElementById('cfgCorpo').textContent.indexOf(window.jobeApp.L.cfg.salvo) >= 0, null, { timeout: 5000 });
  conferir(api.config.values.backgroundDownloads === !antesValor && api.config.rev > antesCfg, `${t.nome}: o liga/desliga nao gravou em /api/settings`);
  await pagina.fill('#cfg_speedLimit', '5000'); await pagina.press('#cfg_speedLimit', 'Tab');
  conferir(await pagina.evaluate(() => document.getElementById('cfgCorpo').textContent.indexOf(window.jobeApp.L.cfg.invalido) >= 0), `${t.nome}: 5000 MB/s devia ser recusado na pagina`);
  // glibren.56: a escolha propria (botao + lista), nao <select>
  await pagina.click('#cfg_simultaneousDownloads');
  await pagina.waitForSelector('#escLista:not([hidden]) .op', { timeout: 3000 });
  await pagina.locator('#escLista .op').filter({ hasText: /^\s*3\s*$/ }).click();
  await pagina.waitForFunction(() => true, null, { timeout: 300 }).catch(() => {});
  await espera(300);
  conferir(api.config.values.simultaneousDownloads === 3, `${t.nome}: o select nao gravou`);
  const chaves = await pagina.evaluate(() => document.getElementById('cfgChavesLista').textContent);
  conferir(/a1b2/.test(chaves) && !/9z8y9/.test(chaves), `${t.nome}: segredos so como "configurada ✓ …fim": ${chaves}`);
  await pagina.evaluate(() => { document.getElementById('secConfig').scrollTop = 0; });
  const r5 = await pagina.evaluate(REGRAS);
  await pagina.screenshot({ path: path.join(saida, `app-${t.nome}-config.png`) });
  if (t.ps5 && t.h < 1060) {
    // o botao ⛶ (glibren no ar pela API falsa) e a janela que pede ao payload; em 1920x1080 o PS5 ja esta em tela cheia
    await pagina.click('#nav .nb[data-sec="loja"]');
    await pagina.waitForSelector('#bTela:not([hidden])', { timeout: 5000 });
    await pagina.click('#bTela');
    await pagina.waitForSelector('#tcForm:not([hidden])', { timeout: 5000 });
    await pagina.click('#tcSim');
    await pagina.waitForFunction(() => document.getElementById('tcEst').textContent === window.jobeApp.L.tc.indo, null, { timeout: 5000 });
    conferir(api.telaPedidos.length > 0 && /^#\//.test(api.telaPedidos.at(-1)), `${t.nome}: o ⛶ nao pediu ao payload com a volta para a /app`);
    await pagina.click('#tcNao');
  }
  for (const [qual, r] of [['config', r5]]) {
    conferir(!r.largo.length, `${t.nome} ${qual}: rola de lado: ${r.largo.join(', ')}`);
    conferir(!r.reticencias, `${t.nome} ${qual}: reticencias`);
    conferir(!r.desiguais.length, `${t.nome} ${qual}: botoes de larguras diferentes: ${r.desiguais.join('; ')}`);
  }

  // ---- controle e teclado (so com --checar) ----
  let controle = null;
  if (checar) {
    passo = 'await pagina.click(\'#nav .nb[data-sec="loja"]\');';
    await pagina.click('#nav .nb[data-sec="loja"]');
    passo = "await pagina.waitForFunction(() => document.querySelector('.card:not(.";
    await pagina.waitForFunction(() => window.jobeApp.estado().secao === 'loja' && document.querySelector('.card:not(.vazio)'));
    const apertar = async (b) => {
      await pagina.evaluate((i) => { window.__pad.buttons[i] = { pressed: true, value: 1 }; window.__pad.timestamp++; }, b);
      // segura ate o laco do controle (requestAnimationFrame) ler o botao apertado, e solta
      await pagina.waitForFunction((n) => window.__lidos > n, await pagina.evaluate(() => window.__lidos || 0), { timeout: 3000, polling: 'raf' }).catch(() => {});
      await espera(40);
      await pagina.evaluate((i) => { window.__pad.buttons[i] = { pressed: false, value: 0 }; window.__pad.timestamp++; }, b);
      await pagina.waitForFunction((n) => window.__lidos > n, await pagina.evaluate(() => window.__lidos || 0), { timeout: 3000, polling: 'raf' }).catch(() => {});
      await espera(40);
    };
    await pagina.evaluate(() => { window.dispatchEvent(new Event('gamepadconnected')); window.jobeApp.focarCartao(0); });
    const foco = () => pagina.evaluate(() => { const a = document.activeElement; return a && a.getAttribute ? a.getAttribute('data-i') : null; });
    const cols = await pagina.evaluate(() => window.jobeApp.estado().cols);
    await espera(400);
    const inicio = await foco(); // o foco nao pode sair sozinho do cartao 0 (troca de secao, medidas da grade)
    conferir(inicio === '0', `${t.nome}: o foco saiu sozinho do cartao 0 para ${inicio}`);
    if (inicio !== '0') await pagina.evaluate(() => window.jobeApp.focarCartao(0));
    await apertar(15); const direita = await foco();
    await apertar(13); const baixo = await foco();
    await apertar(0);
    controle = { cols, inicio, direita, baixo, antesDoX: await pagina.evaluate(() => [document.activeElement.className, location.hash, window.jobeApp.estado().ficha]) };
    passo = "await pagina.waitForFunction(() => !document.getElementById('ficha').h";
    await pagina.waitForFunction(() => !document.getElementById('ficha').hidden && document.getElementById('fBaixar'), null, { timeout: 5000 });
    const fichaId = await pagina.evaluate(() => window.jobeApp.estado().ficha);
    await apertar(1);
    passo = "await pagina.waitForFunction(() => document.getElementById('ficha').hi";
    await pagina.waitForFunction(() => document.getElementById('ficha').hidden, null, { timeout: 5000 });
    await espera(150);
    const volta = await foco();
    // teclado: setas andam e Enter abre
    await pagina.evaluate(() => window.jobeApp.focarCartao(0));
    await pagina.keyboard.press('ArrowRight');
    const tecla = await foco();
    const anelVisivel = await pagina.evaluate(() => document.documentElement.classList.contains('kb') && getComputedStyle(document.activeElement).borderColor !== 'rgba(0, 0, 0, 0)');
    const esperado = cols > 1 ? { direita: '1', baixo: String(1 + cols) } : { direita: '0', baixo: '1' };
    controle = { ...controle, fichaId, volta, tecla, anelVisivel };
    conferir(direita === esperado.direita, `${t.nome}: controle -> direita foi para ${direita}`);
    conferir(baixo === esperado.baixo, `${t.nome}: controle -> baixo foi para ${baixo} (esperado ${esperado.baixo})`);
    conferir(Boolean(fichaId), `${t.nome}: X do controle nao abriu a ficha`);
    conferir(volta === esperado.baixo, `${t.nome}: O do controle nao devolveu o foco ao cartao (${volta})`);
    conferir(tecla === (cols > 1 ? '1' : '0'), `${t.nome}: seta do teclado foi para ${tecla}`);
    conferir(anelVisivel, `${t.nome}: foco sem anel visivel`);
  }

  // ---- glibren.56: navegador do PS5 (bug real: clicar num jogo "dava uma mexidinha e nao fazia nada"; filtros sumiam) ----
  // X = keydown 13 seguido do clique do cursor (eco); clique direto; rolagem e clique; linha trocada entre o mousedown e
  // o mouseup; filtros pelo cursor, pelo direcional + X e O fechando sem mudar.
  let ps5Cliques = null;
  if (checar && t.ps5) {
    passo = 'ps5: cliques';
    const fichaFechada = async () => {
      if (!(await pagina.evaluate(() => document.getElementById('ficha').hidden))) { await pagina.evaluate(() => window.jobeVoltar()); await pagina.waitForFunction(() => document.getElementById('ficha').hidden, null, { timeout: 5000 }); }
      await espera(250);
    };
    const centro = (i) => pagina.evaluate((k) => { const c = document.querySelector(`.card[data-i="${k}"]`); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }, i);
    const fichaAberta = async () => { await pagina.waitForFunction(() => !document.getElementById('ficha').hidden && window.jobeApp.estado().ficha, null, { timeout: 4000 }).catch(() => {}); await espera(150); return pagina.evaluate(() => (document.getElementById('ficha').hidden ? null : window.jobeApp.estado().ficha)); };
    const idDe = (i) => pagina.evaluate((k) => window.jobeApp.idDe(k), i);
    ps5Cliques = {};
    // 1) cursor sobre o cartao 2 (foco em outro), X: keydown 13 e o clique do cursor logo depois -> abre o 2
    await fichaFechada();
    await pagina.evaluate(() => { document.getElementById('grade').scrollTop = 0; window.jobeApp.focarCartao(0); });
    await espera(200);
    let c = await centro(2);
    await pagina.mouse.move(c.x - 5, c.y - 5); await pagina.mouse.move(c.x, c.y);
    await pagina.keyboard.press('Enter'); await pagina.mouse.click(c.x, c.y);
    ps5Cliques.cursorX = (await fichaAberta()) === (await idDe(2));
    conferir(ps5Cliques.cursorX, `${t.nome}: PS5, cursor no cartao 2 + X (13 e o clique) nao abriu o cartao 2`);
    // 2) cursor parado no cartao 3, direcional para o cartao 1, X (13 + clique do cursor no 3 = eco) -> abre o 1
    await fichaFechada();
    c = await centro(3);
    await pagina.mouse.move(c.x - 5, c.y - 5); await pagina.mouse.move(c.x, c.y);
    await pagina.evaluate(() => window.jobeApp.focarCartao(0));
    await pagina.keyboard.press('ArrowRight');
    await pagina.keyboard.press('Enter'); await pagina.mouse.click(c.x, c.y);
    ps5Cliques.direcionalX = (await fichaAberta()) === (await idDe(1));
    conferir(ps5Cliques.direcionalX, `${t.nome}: PS5, direcional + X com o cursor parado em outro cartao nao abriu o focado`);
    // 3) clique direto do cursor
    await fichaFechada();
    c = await centro(4);
    await pagina.mouse.click(c.x, c.y);
    ps5Cliques.clique = (await fichaAberta()) === (await idDe(4));
    conferir(ps5Cliques.clique, `${t.nome}: PS5, clique do cursor no cartao 4 nao abriu`);
    // 4) rolagem e clique
    await fichaFechada();
    await pagina.evaluate(() => { document.getElementById('grade').scrollTop = 3000; });
    await espera(600);
    const iRol = await pagina.evaluate(() => { const g = document.getElementById('grade').getBoundingClientRect(); const c2 = [...document.querySelectorAll('.card:not(.vazio)')].find((e) => { const r = e.getBoundingClientRect(); return r.top > g.top + 4 && r.bottom < g.bottom - 4; }); return c2 ? +c2.getAttribute('data-i') : -1; });
    c = await centro(iRol);
    await pagina.mouse.click(c.x, c.y);
    ps5Cliques.rolagem = iRol > 0 && (await fichaAberta()) === (await idDe(iRol));
    conferir(ps5Cliques.rolagem, `${t.nome}: PS5, rolagem e clique no cartao ${iRol} nao abriu`);
    // 5) a linha trocada entre o mousedown e o mouseup (a pagina dela chegou no meio do clique)
    await fichaFechada();
    c = await centro(iRol);
    await pagina.mouse.move(c.x, c.y); await pagina.mouse.down();
    await pagina.evaluate((k) => { const lin = document.querySelector(`.card[data-i="${k}"]`).parentNode; lin.replaceWith(lin.cloneNode(true)); }, iRol);
    await pagina.mouse.up();
    ps5Cliques.linhaTrocada = (await fichaAberta()) === (await idDe(iRol));
    conferir(ps5Cliques.linhaTrocada, `${t.nome}: PS5, linha trocada no meio do clique: nao abriu`);
    await fichaFechada();
    await pagina.evaluate(() => { document.getElementById('grade').scrollTop = 0; });
    // 6) filtros: cursor
    passo = 'ps5: filtros';
    if (await pagina.evaluate(() => document.getElementById('filtros').hidden)) await pagina.click('#bFiltros');
    await pagina.click('#fPlat');
    await pagina.waitForSelector('#escLista:not([hidden]) .op', { timeout: 3000 });
    await pagina.screenshot({ path: path.join(saida, `app-${t.nome}-filtros.png`) });
    const rf = await pagina.evaluate(REGRAS);
    conferir(!rf.largo.length && !rf.reticencias, `${t.nome} filtros: rola de lado ou reticencias`);
    await pagina.locator('#escLista .op').filter({ hasText: /^PS4/ }).click();
    await espera(300);
    ps5Cliques.filtroCursor = (await pagina.evaluate(() => window.jobeApp.filtros().platform)) === 'ps4';
    conferir(ps5Cliques.filtroCursor, `${t.nome}: PS5, filtro Plataforma pelo cursor nao mudou`);
    // 7) filtros: X (sem clique do cursor: vale o foco), direcional na lista e X
    passo = 'ps5: filtros pelo X';
    await espera(400); // um X logo depois (350 ms) de um clique do cursor e o mesmo aperto: ignorado
    await pagina.focus('#fGenero');
    await pagina.keyboard.press('Enter');
    await pagina.waitForSelector('#escLista:not([hidden]) .op', { timeout: 3000 });
    const segundo = await pagina.evaluate(() => document.querySelectorAll('#escLista .op')[1].textContent);
    await pagina.keyboard.press('ArrowDown');
    await pagina.keyboard.press('Enter');
    await espera(300);
    const gen = await pagina.evaluate(() => window.jobeApp.filtros().genre);
    ps5Cliques.filtroControle = Boolean(gen) && segundo.indexOf(gen) >= 0;
    conferir(ps5Cliques.filtroControle, `${t.nome}: PS5, filtro Genero pelo direcional + X nao mudou (${gen} / ${segundo})`);
    // 8) O fecha sem mudar e o foco volta ao botao
    passo = 'ps5: filtros, O fecha';
    const ordem = await pagina.evaluate(() => window.jobeApp.filtros().sort);
    await pagina.focus('#fOrdem');
    await pagina.keyboard.press('Enter');
    await pagina.waitForSelector('#escLista:not([hidden]) .op', { timeout: 3000 });
    await pagina.keyboard.press('ArrowDown');
    await pagina.keyboard.press('Escape');
    await espera(400);
    ps5Cliques.filtroO = await pagina.evaluate((o) => document.getElementById('escLista').hidden && window.jobeApp.filtros().sort === o && document.activeElement.id === 'fOrdem', ordem);
    conferir(ps5Cliques.filtroO, `${t.nome}: PS5, O na lista do filtro nao fechou sem mudar`);
    await pagina.click('#fLimpar');
    await espera(300);
    // 9) .58: a fonte na ficha. Cursor: um clique escolhe; direcional + X escolhe a focada (o clique do cursor parado em
    // outra fonte e eco); X de novo nao desfaz; O fecha a ficha uma vez so (a loja continua).
    passo = 'ps5: fontes';
    await fichaFechada();
    c = await centro(5);
    await pagina.mouse.click(c.x, c.y);
    await pagina.waitForSelector('#fCorpo .fontes button.fonte', { timeout: 5000 });
    await espera(300);
    const pressed = () => pagina.evaluate(() => [...document.querySelectorAll('#fCorpo .fontes button.fonte')].map((b) => b.getAttribute('aria-pressed') === 'true'));
    const centroFonte = (k) => pagina.evaluate((n) => { const b = document.querySelectorAll('#fCorpo .fontes button.fonte')[n]; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }, k);
    let cf = await centroFonte(1);
    await espera(150);
    await pagina.mouse.move(cf.x - 6, cf.y - 6); await pagina.mouse.move(cf.x, cf.y);
    await pagina.mouse.click(cf.x, cf.y);
    await espera(200);
    ps5Cliques.fonteCursor = (await pressed()).join() === [false, true, false, false].join();
    conferir(ps5Cliques.fonteCursor, `${t.nome}: PS5, clique do cursor na fonte 1 nao a escolheu: ${await pressed()}`);
    // direcional: foco no Automatico, baixo ate a fonte 2, X (13 + clique do cursor parado na fonte 1 = eco)
    await espera(700);
    await pagina.evaluate(() => document.querySelectorAll('#fCorpo .fontes button.fonte')[0].focus());
    await pagina.keyboard.press('ArrowDown'); await pagina.keyboard.press('ArrowDown');
    const focada = await pagina.evaluate(() => [...document.querySelectorAll('#fCorpo .fontes button.fonte')].indexOf(document.activeElement));
    await pagina.keyboard.press('Enter'); await pagina.mouse.click(cf.x, cf.y);
    await espera(400);
    ps5Cliques.fonteDirecional = focada === 2 && (await pressed()).join() === [false, false, true, false].join();
    conferir(ps5Cliques.fonteDirecional, `${t.nome}: PS5, direcional + X na fonte 2 (focada ${focada}): ${await pressed()}`);
    await espera(400);
    await pagina.keyboard.press('Enter');
    await espera(400);
    ps5Cliques.fonteXDuasVezes = (await pressed()).join() === [false, false, true, false].join();
    conferir(ps5Cliques.fonteXDuasVezes, `${t.nome}: PS5, X de novo na fonte escolhida mudou a escolha: ${await pressed()}`);
    const baixarPs5 = await pagina.evaluate(() => document.getElementById('fBaixar').textContent);
    conferir(/Archive|Media|Viking|\./.test(baixarPs5) && baixarPs5 !== (await pagina.evaluate(() => window.jobeApp.L.baixarAuto)), `${t.nome}: PS5, o Baixar nao diz a fonte: ${baixarPs5}`);
    await pagina.screenshot({ path: path.join(saida, `app-${t.nome}-fontes-ps5.png`) });
    // O do PS5 = keydown 27 E o voltar do navegador (popstate): a ficha fecha uma vez so, o hash volta a #/loja (antes
    // da .58 a guarda do historico ia por cima da ficha e esse O deixava a ficha aberta); um 2o O continua na /app.
    await pagina.keyboard.press('Escape'); await pagina.evaluate(() => history.back());
    await espera(700);
    const depoisO = () => pagina.evaluate(() => ({ hash: location.hash, ficha: !document.getElementById('ficha').hidden, secao: window.jobeApp.estado().secao, app: /\/app/.test(location.pathname) }));
    const o1 = await depoisO();
    await pagina.keyboard.press('Escape'); await pagina.evaluate(() => history.back());
    await espera(700);
    const o2 = await depoisO();
    ps5Cliques.fonteO = !o1.ficha && o1.secao === 'loja' && o1.hash === '#/loja' && !o2.ficha && o2.app; // o 2o O anda o historico das secoes (aqui, #/config)
    conferir(ps5Cliques.fonteO, `${t.nome}: PS5, O na ficha devia fechar so a ficha e o 2o O ficar na /app: ${JSON.stringify([o1, o2])}`);
  }

  for (const [qual, r] of [['loja', r1], ['rolagem', r2], ['ficha', r3], ['downloads', r4]]) {
    conferir(!r.largo.length, `${t.nome} ${qual}: rola de lado: ${r.largo.join(', ')}`);
    conferir(!r.reticencias, `${t.nome} ${qual}: ${r.reticencias} elemento(s) com reticencias`);
    conferir(!r.desiguais.length, `${t.nome} ${qual}: botoes de larguras diferentes: ${r.desiguais.join('; ')}`);
    conferir(!r.cortados, `${t.nome} ${qual}: ${r.cortados} texto(s) cortado(s)`);
  }
  const Lp = await pagina.evaluate(() => ({ jogos: window.jobeApp.L.jogos, voltar: window.jobeApp.L.voltarJogos }));
  conferir(primeiroNav === Lp.jogos, `${t.nome}: 1o botao da navegacao: ${primeiroNav}`);
  conferir(navFora === Lp.voltar && /^←/.test(navFora), `${t.nome}: fora da loja o 1o botao deveria ser "${Lp.voltar}": ${navFora}`);
  conferir(fichaPrimeiro === Lp.voltar, `${t.nome}: o 1o botao da ficha deveria ser "${Lp.voltar}": ${fichaPrimeiro}`);
  conferir(rolagem.maxCartoesNoDom < 200, `${t.nome}: lista nao e virtual (${rolagem.maxCartoesNoDom} cartoes no DOM)`);
  conferir(capasNaMontagem < 120, `${t.nome}: capas demais na montagem (${capasNaMontagem})`);
  conferir(!errosJs.length, `${t.nome}: erros de JS: ${errosJs.join(' | ')}`);
  await contexto.close();
  return { tamanho: t.nome, ps5: Boolean(t.ps5), tela, montagem, capasNaMontagem, rolagem, controle, ps5Cliques, errosJs,
    prints: ['loja', 'ficha', 'parear', 'downloads', 'config'].map((q) => path.join(saida, `app-${t.nome}-${q}.png`)) };
}

const api = await apiFalsa({ jogos: 2639, atraso: 15 });
const { navegador, canal } = await abrirNavegador();
const resultados = [];
try {
  for (const [k, t] of TAMANHOS.entries()) {
    try { resultados.push(await medirTamanho(navegador, api, t, 11 * (k + 1))); } catch (e) { falhas.push(`${t.nome} [${passo}]: ${String(e.message).split(String.fromCharCode(10))[0]}`); }
  }
} finally {
  await navegador.close();
  await api.close();
}
const relatorio = { quando: new Date().toISOString(), navegador: `${canal} ${navegador.version()}`, jogos: 2639, resultados, falhas };
writeFileSync(path.join(saida, 'medidas.json'), JSON.stringify(relatorio, null, 2));
for (const r of resultados) {
  if (r.controle) console.log(r.tamanho, 'controle', JSON.stringify(r.controle));
  const m = r.montagem, s = r.rolagem;
  console.log(`${r.tamanho.padEnd(13)} fonte ${r.tela.fonte}, ${r.tela.cols} col., nav ${r.tela.navL}x${r.tela.navA} | montagem ${m.montagemMs.toFixed(0)} ms (desde a navegacao ${m.desdeNavegacaoMs.toFixed(0)} ms), ${m.cartoes} cartoes, ${r.capasNaMontagem} capas | ` +
    `rolagem rapida ${s.quadros} quadros em ${s.duracaoMs} ms: media ${s.mediaMs} ms, p95 ${s.p95Ms} ms, pior ${s.piorMs} ms, >50 ms: ${s.acima50ms}; max ${s.maxCartoesNoDom} cartoes no DOM, ${s.colunas} col., ${s.paginasPedidas} paginas, ${s.capasPedidas} capas | ` +
    `leitura 8 s: media ${s.leitura.mediaMs} ms, p95 ${s.leitura.p95Ms} ms, pior ${s.leitura.piorMs} ms, ${s.leitura.capasPedidas} capas, ${s.leitura.visiveisSemCapa} visiveis sem capa no fim`);
}
console.log(falhas.length ? `FALHAS:\n- ${falhas.join('\n- ')}` : 'regras de tela: ok');
console.log(`JSON ${JSON.stringify({ ok: !falhas.length, falhas, saida })}`);
process.exitCode = checar && falhas.length ? 1 : 0;
