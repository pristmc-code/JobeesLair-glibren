// Fase 8: uma API FALSA do payload para a Jobe web completa (app/native/bg_app.html), para testar e medir a pagina
// sem o PS5 e sem o payload: /app, /api/store (paginas, busca, filtros, ordem e facetas como bg_store.c),
// /api/store/game, /api/store/add (pede credencial), /api/status, /api/jobs/<id>/<acao>, /api/unlock (PIN 1234),
// /api/session e o pareamento por aparelho da .50 (GET /api/pair, POST /api/pair/request e /api/pair/confirm: codigo 123456). As capas sao SVG pequenos servidos daqui (/capa/<n>.svg), para contar quantas a pagina pede (lazy-load);
// por isso a CSP daqui acrescenta 'self' em img-src (a do payload so aceita data: e https:).
// Uso: import { apiFalsa } from './api-falsa.mjs'; const api = await apiFalsa({ jogos: 2639 }); ... api.close().
// Sozinha: node tools/web-app/api-falsa.mjs [porta]  ->  http://127.0.0.1:<porta>/app
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
export const PAGINA = path.join(aqui, '../../app/native/bg_app.html');
export const SESSAO = '0123456789abcdef0123456789abcdef';
export const PIN = '1234';
export const CODIGO = '123456'; // o codigo "mostrado na TV" pelo pareamento falso
export const TOKEN = 'ab'.repeat(32); // o token do aparelho (64 hex)
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; frame-src https://www.youtube-nocookie.com https://www.youtube.com";

const PALAVRAS = ['Shadow', 'Legend', 'Dragon', 'Knight', 'Racing', 'Souls', 'Galaxy', 'Ninja', 'Kingdom', 'Hearts', 'Blade', 'Storm', 'Hunter', 'Rise', 'Origins',
  'Chronicles', 'Tactics', 'Arena', 'Odyssey', 'Fury', 'Horizon', 'Quest', 'Saga', 'Wars', 'Edge', 'Spirit', 'Paradox', 'Zero', 'Infinite', 'Rebirth'];
const GENEROS = ['Ação', 'Aventura', 'RPG', 'Corrida', 'Esporte', 'Luta', 'Tiro', 'Estratégia', 'Plataforma', 'Terror'];
const FORMATOS = ['exfat', 'ffpkg', 'pkg', 'rar', '7z', 'zip', 'ffpfs'];
const HOSTS = ['archive.org', '1fichier.com', 'gofile.io', 'vikingfile.com', 'mediafire.com', 'datanodes.to'];

/** Os jogos falsos: titulos de tamanhos variados (alguns bem longos, para conferir a quebra de linha). */
export function jogosFalsos(n = 2639) {
  const lista = [];
  for (let i = 0; i < n; i++) {
    const w = (k) => PALAVRAS[(i * 7 + k * 13 + (i >> 3)) % PALAVRAS.length];
    let titulo = `${w(0)} ${w(1)}`;
    if (i % 3 === 0) titulo += ` ${w(2)}`;
    if (i % 11 === 0) titulo += `: ${w(3)} of the ${w(4)} ${w(5)} Remastered Definitive Edition`;
    if (i % 97 === 0) titulo = `${titulo} - Ultimate Collector's Bundle with Season Pass and All Downloadable Content Included (${i})`;
    titulo += ` ${i + 1}`;
    const ps4 = i % 4 === 0;
    const code = `${ps4 ? 'CUSA' : 'PPSA'}${String(10000 + i).padStart(5, '0')}`;
    const formatos = [FORMATOS[i % FORMATOS.length]];
    if (i % 5 === 0) formatos.push('rar');
    lista.push({
      id: code, title: titulo, code, platform: ps4 ? 'ps4' : 'ps5', cover: `/capa/${i}.svg`,
      sizeGb: Math.round(((i * 37) % 1200) / 10 + 0.4) / 1, formats: formatos, ready: i % 3 === 0,
      stars: 3 + (i % 21) / 10, ratingCount: (i * 131) % 50000, year: 2014 + (i % 12), solo: i % 6 === 1 ? false : i % 17 === 0 ? null : true,
      queued: false, genres: [GENEROS[i % GENEROS.length], GENEROS[(i * 3 + 1) % GENEROS.length]].filter((g, k, a) => a.indexOf(g) === k),
      developer: `${w(6)} Studios`, publisher: `${w(7)} Interactive`, releaseDate: `${2014 + (i % 12)}-${String(1 + (i % 12)).padStart(2, '0')}-15`, rel: i,
    });
  }
  return lista;
}

// Capa barata de desenhar (cor lisa e um numero): o navegador decodifica um JPEG de verdade fora da thread principal, ja
// um SVG com degrade e texto grande custa na thread principal e mediria o SVG, nao a pagina.
function capaSvg(i) {
  const h = (i * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="hsl(${h},45%,32%)"/><text x="80" y="92" font-family="sans-serif" font-size="28" fill="#fff" text-anchor="middle">${i + 1}</text></svg>`;
}

const tamanhoDe = (g) => (g.sizeGb <= 10 ? 'small' : g.sizeGb <= 50 ? 'medium' : 'large');

/** Sobe o servidor; devolve { porta, url, contadores, close }. `atraso`: ms antes de cada resposta da API; `capas: false` = jogos sem capa. */
export async function apiFalsa({ jogos = 2639, porta = 0, atraso = 15, capas = true } = {}) {
  const lista = jogosFalsos(jogos);
  if (!capas) for (const g of lista) g.cover = '';
  const contadores = { store: 0, capas: 0, fichas: 0, status: 0, add: 0 };
  const jobs = [
    { id: 'j1', name: lista[0].title, state: 'downloading', via: 'TorBox', format: 'exfat', platform: 'ps5', code: lista[0].code, written: 31.6 * 2 ** 30, total: 48.2 * 2 ** 30, bytesPerSecond: 38.5 * 2 ** 20 },
    { id: 'j2', name: lista[11].title, state: 'paused', host: '1fichier.com', format: 'rar', platform: 'ps5', code: lista[11].code, written: 4.2 * 2 ** 30, total: 97.4 * 2 ** 30, bytesPerSecond: 0 },
    { id: 'j3', name: lista[2].title, state: 'queued', host: 'gofile.io', format: '7z', platform: 'ps5', code: lista[2].code, written: 0, total: 60.3 * 2 ** 30, bytesPerSecond: 0 },
    { id: 'j4', name: lista[97].title, state: 'waiting-app', host: 'mediafire.com', format: 'rar', platform: 'ps5', code: lista[97].code, written: 0, total: 51.2 * 2 ** 30, bytesPerSecond: 0, requested: true },
    { id: 'j5', name: lista[4].title, state: 'failed', via: 'TorBox', format: 'exfat', platform: 'ps4', code: lista[4].code, written: 7.9 * 2 ** 30, total: 89.6 * 2 ** 30, bytesPerSecond: 0, error: 'O link do TorBox venceu e não foi renovado. Abra a Jobee\'sLair para continuar.' },
    { id: 'j6', name: lista[5].title, state: 'completed', host: 'archive.org', format: 'ffpfsc', platform: 'ps5', code: lista[5].code, written: 33.4 * 2 ** 30, total: 33.4 * 2 ** 30, bytesPerSecond: 0 },
  ];
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  // aceita a sessao do PIN e o token do aparelho (em X-Session ou Authorization: Bearer), como a .50 (monitor_allowed)
  const sessaoOk = (req) => [SESSAO, TOKEN].includes(req.headers['x-session']) || req.headers.authorization === `Bearer ${TOKEN}`;
  let codigoPedido = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      let body = {};
      try { body = corpo ? JSON.parse(corpo) : {}; } catch {}
      if (p === '/app' || p === '/app/' || p === '/app/index.html') {
        if (req.method !== 'GET') return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        return res.end(readFileSync(PAGINA));
      }
      if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>pagina do celular</title><p>a pagina do celular (fora deste teste)</p>'); }
      const capa = /^\/capa\/(\d+)\.svg$/.exec(p);
      if (capa) { contadores.capas++; res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' }); return res.end(capaSvg(Number(capa[1]))); }
      setTimeout(() => api(req, res, p, url.searchParams, body), atraso);
    });
  });
  function api(req, res, p, q, body) {
    if (p === '/api/store' && req.method === 'GET') {
      contadores.store++;
      const busca = (q.get('q') || '').trim().toLowerCase();
      const sel = (k) => (q.get(k) || '').split(',').filter(Boolean);
      const f = { platform: sel('platform'), format: sel('format'), genre: sel('genre'), size: sel('size') };
      const solo = q.get('solo') === '1';
      const passa = (g, fora) => (!busca || g.title.toLowerCase().includes(busca))
        && (fora === 'platform' || !f.platform.length || f.platform.includes(g.platform))
        && (fora === 'format' || !f.format.length || f.format.some((v) => (v === 'ready' ? g.ready : g.formats.includes(v))))
        && (fora === 'genre' || !f.genre.length || f.genre.every((v) => g.genres.includes(v)))
        && (fora === 'size' || !f.size.length || f.size.includes(tamanhoDe(g)))
        && (fora === 'solo' || !solo || g.solo === true);
      const sort = q.get('sort') || 'relevance';
      const achados = lista.filter((g) => passa(g));
      const ordem = { relevance: (a, b) => a.rel - b.rel, newest: (a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.rel - b.rel, rating: (a, b) => b.stars - a.stars || a.rel - b.rel,
        size: (a, b) => b.sizeGb - a.sizeGb || a.rel - b.rel, title: (a, b) => a.title.localeCompare(b.title) }[sort] || ((a, b) => a.rel - b.rel);
      achados.sort(ordem);
      const offset = Math.max(0, Number(q.get('offset')) || 0), limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 40));
      const conta = (k, valor, teste) => lista.filter((g) => passa(g, k) && teste(g, valor)).length;
      const facets = {
        platform: ['ps5', 'ps4'].map((v) => ({ value: v, name: v.toUpperCase(), count: conta('platform', v, (g, x) => g.platform === x) })),
        format: ['ready', ...FORMATOS].map((v) => ({ value: v, name: v, count: conta('format', v, (g, x) => (x === 'ready' ? g.ready : g.formats.includes(x))) })),
        genre: GENEROS.map((v) => ({ value: v, name: v, count: achados.filter((g) => g.genres.includes(v)).length })),
        size: ['small', 'medium', 'large'].map((v) => ({ value: v, name: v, count: conta('size', v, (g, x) => tamanhoDe(g) === x) })),
        solo: [{ value: '1', name: '1', count: achados.filter((g) => g.solo === true).length }],
      };
      const enxuto = ({ developer, publisher, releaseDate, rel, ...g }) => g;
      return json(res, 200, { ok: true, key: 'falsa', builtAt: '2026-11-13T09:00:00Z', console: 'ps5', readyFirmware: '12.00', total: lista.length, count: achados.length, offset, limit,
        games: achados.slice(offset, offset + limit).map(enxuto), facets });
    }
    if (p === '/api/store/game' && req.method === 'GET') {
      contadores.fichas++;
      const g = lista.find((x) => x.id === q.get('id'));
      if (!g) return json(res, 404, { error: 'not-found' });
      const links = [
        { kind: g.solo === false ? 'browser' : 'direct', host: HOSTS[g.rel % HOSTS.length], format: g.formats[0], size: Math.round(g.sizeGb * 2 ** 30), label: '', parts: 0, solo: g.solo !== false },
        { kind: 'set', host: HOSTS[(g.rel + 1) % HOSTS.length], format: 'rar', size: Math.round(g.sizeGb * 2 ** 30), label: '', parts: 4, solo: false },
      ];
      const { rel, ...jogo } = g;
      return json(res, 200, { ok: true, game: { ...jogo, direct: g.solo !== false, features: [], providers: [] },
        details: { summary: `${g.title}: um resumo de exemplo da API falsa.`,
          about: ['Texto longo de exemplo para conferir a quebra de linha na ficha, sem cortar nada com reticências. '.repeat(4), 'Segundo parágrafo da descrição.'],
          shots: [`/capa/${(g.rel + 1) % lista.length}.svg`, `/capa/${(g.rel + 2) % lista.length}.svg`, `/capa/${(g.rel + 3) % lista.length}.svg`], hero: '' },
        links, download: g.solo === false ? 'app' : 'payload', detailsState: 'ok' });
    }
    if (p === '/api/store/add' && req.method === 'POST') {
      contadores.add++;
      if (!sessaoOk(req)) return json(res, 401, { error: 'pin' });
      const g = lista.find((x) => x.id === body.id);
      if (!g) return json(res, 404, { error: 'not-found' });
      if (g.queued) return json(res, 200, { ok: true, already: true, id: 'j9' });
      g.queued = true;
      return json(res, 200, g.solo === false ? { ok: true, id: 'j9', via: 'app', appOpen: false, reason: 'needs-app' } : { ok: true, id: 'j9', via: 'payload' });
    }
    if (p === '/api/status' && req.method === 'GET') {
      contadores.status++;
      for (const j of jobs) if (j.state === 'downloading') j.written = Math.min(j.total, j.written + j.bytesPerSecond * 2);
      return json(res, 200, { jobs, cancelledRecent: [], limit: 2, maxLimit: 4, maxConnections: 64, limitSet: false, pinSet: true, speedLimit: 0, maxSpeedLimit: 1000, speedLimitSet: false });
    }
    const acao = /^\/api\/jobs\/([^/]+)\/(pause|resume|cancel)$/.exec(p);
    if (acao && req.method === 'POST') {
      if (!sessaoOk(req)) return json(res, 401, { error: 'pin' });
      const j = jobs.find((x) => x.id === acao[1]);
      if (!j) return json(res, 404, { error: 'not found' });
      if (acao[2] === 'pause') Object.assign(j, { state: 'paused', bytesPerSecond: 0 });
      if (acao[2] === 'resume') Object.assign(j, { state: 'downloading', bytesPerSecond: 12 * 2 ** 20 });
      if (acao[2] === 'cancel') jobs.splice(jobs.indexOf(j), 1);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/pair' && req.method === 'GET') return json(res, 200, { ok: true, paired: sessaoOk(req), local: false, allowed: sessaoOk(req), pinOn: true, pinSet: true, devices: 0, retryIn: 0 });
    if (p === '/api/pair/request' && req.method === 'POST') { codigoPedido = true; return json(res, 200, { ok: true, validFor: 120 }); }
    if (p === '/api/pair/confirm' && req.method === 'POST') {
      if (!codigoPedido) return json(res, 409, { error: 'no-code' });
      if (body.code !== CODIGO) return json(res, 403, { error: 'wrong', left: 4 });
      codigoPedido = false;
      return json(res, 200, { ok: true, token: TOKEN, id: '0123456789abcdef' });
    }
    if (p === '/api/unlock' && req.method === 'POST') return body.pin === PIN ? json(res, 200, { session: SESSAO }) : json(res, 403, { retryIn: 0 });
    if (p === '/api/session' && req.method === 'GET') return sessaoOk(req) ? json(res, 200, { ok: true }) : json(res, 401, { error: 'pin' });
    return json(res, 404, { error: 'not found' });
  }
  await new Promise((resolve) => server.listen(porta, '127.0.0.1', resolve));
  const real = server.address().port;
  return { porta: real, url: `http://127.0.0.1:${real}`, contadores, lista, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const api = await apiFalsa({ porta: Number(process.argv[2]) || 8799 });
  console.log(`API falsa: ${api.url}/app (codigo de pareamento ${CODIGO}, PIN ${PIN})`);
}
