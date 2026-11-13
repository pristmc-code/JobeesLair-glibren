// Fase 8: mede e confere a Jobe web completa (app/native/bg_app.html) no Chromium, com o Playwright, contra a API falsa
// (tools/web-app/api-falsa.mjs, 2.639 jogos). Para cada tamanho (celular em pe 360x780 e 412x915, deitado 780x360, PC
// 1280x800, TV 1920x1080 e a area util provavel do navegador do PS5 com moldura, 1600x860 e 1280x720, as tres com o
// user agent do PS5):
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
  // a area util provavel do navegador do PS5 (a moldura come parte da TV; o numero real vem das medidas da /app e /teste)
  { nome: '1600x860-ps5', w: 1600, h: 860, movel: false, ps5: true },
  { nome: '1280x720-ps5', w: 1280, h: 720, movel: false, ps5: true },
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
  const contexto = await navegador.newContext({ viewport: { width: t.w, height: t.h }, deviceScaleFactor: 1, isMobile: t.movel, hasTouch: t.movel, locale: 'pt-BR',
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
  conferir(tela.telaCheia, `${t.nome}: o botao Tela cheia devia aparecer no Chromium (tem a API)`);
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
  await pagina.waitForFunction(() => /errado|Wrong/.test(document.getElementById('parErro').textContent), null, { timeout: 5000 });
  await pagina.fill('#parCodigo', '123456');
  await pagina.click('#parSim');
  await pagina.waitForFunction(() => document.getElementById('acesso').hidden, null, { timeout: 5000 });
  const guardado = await pagina.evaluate(() => localStorage.getItem('jobe.session'));
  conferir(/^[0-9a-f]{64}$/.test(guardado || ''), `${t.nome}: o token do aparelho nao foi guardado em jobe.session`);
  passo = "await pagina.waitForFunction(() => document.getElementById('fBaixar').";
  await pagina.waitForFunction(() => document.getElementById('fBaixar').disabled && /fila|Queued/i.test(document.getElementById('fBaixar').textContent), null, { timeout: 5000 });
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

  for (const [qual, r] of [['loja', r1], ['rolagem', r2], ['ficha', r3], ['downloads', r4]]) {
    conferir(!r.largo.length, `${t.nome} ${qual}: rola de lado: ${r.largo.join(', ')}`);
    conferir(!r.reticencias, `${t.nome} ${qual}: ${r.reticencias} elemento(s) com reticencias`);
    conferir(!r.desiguais.length, `${t.nome} ${qual}: botoes de larguras diferentes: ${r.desiguais.join('; ')}`);
    conferir(!r.cortados, `${t.nome} ${qual}: ${r.cortados} texto(s) cortado(s)`);
  }
  conferir(/Jogos/.test(primeiroNav), `${t.nome}: 1o botao da navegacao: ${primeiroNav}`);
  conferir(/^← JOGOS$/.test(navFora), `${t.nome}: fora da loja o 1o botao deveria ser "← JOGOS": ${navFora}`);
  conferir(/^← JOGOS$/.test(fichaPrimeiro), `${t.nome}: o 1o botao da ficha deveria ser "← JOGOS": ${fichaPrimeiro}`);
  conferir(rolagem.maxCartoesNoDom < 200, `${t.nome}: lista nao e virtual (${rolagem.maxCartoesNoDom} cartoes no DOM)`);
  conferir(capasNaMontagem < 120, `${t.nome}: capas demais na montagem (${capasNaMontagem})`);
  conferir(!errosJs.length, `${t.nome}: erros de JS: ${errosJs.join(' | ')}`);
  await contexto.close();
  return { tamanho: t.nome, ps5: Boolean(t.ps5), tela, montagem, capasNaMontagem, rolagem, controle, errosJs,
    prints: ['loja', 'ficha', 'parear', 'downloads'].map((q) => path.join(saida, `app-${t.nome}-${q}.png`)) };
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
