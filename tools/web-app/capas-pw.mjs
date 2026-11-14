// .56: as capas da /app no Chromium, contra o PAYLOAD DE VERDADE (o teste tests/bg-app-page.test.mjs sobe o payload com
// um store-index.json de 3 jogos: capa recusada + icon0.png local, capa recusada sem nada no payload, capa data: boa).
// Abre a /app duas vezes: com o user agent do PS5 (a capa que falha vai para /app/capa; sem nada, o nome no lugar) e
// com o de um celular (nada vai para o proxy). Imprime uma linha "JSON {...}" com o que achou.
// Uso: node tools/web-app/capas-pw.mjs --url=http://127.0.0.1:<porta>/app [--playwright=<pasta do playwright>]
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
async function carregarPlaywright() {
  const alvo = typeof args.playwright === 'string' ? args.playwright : '';
  if (!alvo) return import('playwright');
  let arquivo = alvo;
  if (existsSync(arquivo) && statSync(arquivo).isDirectory()) arquivo = path.join(arquivo, 'index.mjs');
  return import(pathToFileURL(arquivo).href);
}
const { chromium } = await carregarPlaywright();
let navegador = null;
for (const opcoes of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
  try { navegador = await chromium.launch(opcoes); break; } catch {}
}
if (!navegador) { console.log('JSON ' + JSON.stringify({ erro: 'nenhum Chromium abriu' })); process.exit(1); }

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PS5_UA = 'Mozilla/5.0 (PlayStation; PlayStation 5/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const CELULAR_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
async function rodada(ua) {
  const ctx = await navegador.newContext({ userAgent: ua, viewport: { width: 1540, height: 700 } });
  // a capa boa do teste (https: de mentira, respondida aqui) e as recusadas (127.0.0.1:1)
  await ctx.route('https://capas-boa.example/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  const page = await ctx.newPage();
  const proxy = [];
  page.on('request', (r) => { if (r.url().includes('/app/capa?')) proxy.push(r.url().replace(/^.*\/app\/capa/, '/app/capa')); });
  await page.goto(String(args.url) + '#/loja');
  await page.waitForFunction(() => window.jobeApp && window.jobeApp.cartoes() >= 3, null, { timeout: 20000 });
  // espera cada capa terminar: abriu, ou o nome no lugar (no celular a imagem quebrada some e fica a inicial)
  await page.waitForFunction(() => {
    const c = window.jobeApp.capas();
    return c.ok + c.erro >= 3 && document.querySelectorAll('.capa img').length === document.querySelectorAll('.capa.ok img').length;
  }, null, { timeout: 25000 }).catch(() => {});
  const r = await page.evaluate(() => ({
    capas: window.jobeApp.capas(),
    ok: Array.from(document.querySelectorAll('.card .capa.ok')).map((b) => b.closest('.card').querySelector('.t').textContent),
    nome: Array.from(document.querySelectorAll('.card .capa.sem')).map((b) => b.querySelector('.ini').textContent),
    tela: window.jobeApp.tela(),
  }));
  r.proxy = proxy;
  await ctx.close();
  return r;
}
const saida = { ps5: await rodada(PS5_UA), celular: await rodada(CELULAR_UA) };
await navegador.close();
console.log('JSON ' + JSON.stringify(saida));
