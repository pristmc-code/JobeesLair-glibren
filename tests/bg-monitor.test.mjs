// glibren: a pagina do celular (app/native/bg_monitor.html, servida pelo payload na porta 34201) e a opcao nas
// Configuracoes (app/state/phone-monitor.js): o .h embutido esta em dia com a pagina, o PIN so existe como sal +
// SHA-256 e o que vai ao payload. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const load = (file) => import(path.join(repo, file));
const embed = await load('tools/bg-monitor/embed.mjs');
const monitor = await load('app/state/phone-monitor.js');
const saved = await load('app/state/saved.js');

test('bg_monitor_html.h esta em dia com bg_monitor.html (rode tools/bg-monitor/embed.mjs)', () => {
  assert.equal(readFileSync(embed.HEADER, 'utf8'), embed.header(readFileSync(embed.PAGE)));
});

test('a pagina embutida: fala so com a mesma origem, tem o aviso de PIN e o modo demo', () => {
  const page = readFileSync(embed.PAGE, 'utf8');
  for (const route of ['/api/status', '/api/unlock', '/api/power', '`/api/jobs/${id}/${what}`', '/api/library?', '/api/library/game?id=', '/api/library/add']) assert.ok(page.includes(route), route);
  // glibren: a Biblioteca TorBox tambem no modo demo. glibren.9: as capas e fotos vem dos enderecos do catalogo (que o
  // payload manda); de endereco fixo, so o YouTube (player sem cookies, miniatura e os links de busca).
  assert.match(page, /demoApi/);
  const fixed = page.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '').match(/https?:\/\/[^`'"\s$]+/g) || [];
  assert.deepEqual([...new Set(fixed)].sort(), ['https://i.ytimg.com/vi/', 'https://www.youtube-nocookie.com/embed/', 'https://www.youtube.com/results?search_query=', 'https://www.youtube.com/watch?v='], 'nada de outro site');
  assert.ok(!/\.innerHTML\s*=\s*[^;]*\b(d|g|shot|data)\./.test(page), 'texto e enderecos do jogo nunca por innerHTML');
  for (const piece of ['loading = "lazy"', 'aspect-ratio:3/4', 'aspect-ratio:16/9', 'onerror', '@media (orientation:landscape)', 'history.pushState', 'popstate', 'window.jobeVoltar', 'referrerPolicy = "strict-origin-when-cross-origin"', '#jogo=']) assert.ok(page.includes(piece), piece);
  assert.match(page, /noPin/);
  assert.match(page, /has\("demo"\)/);
});

test('phone-monitor: ligado por padrao, PIN guardado so como sal + SHA-256, configuracao para o payload', () => {
  assert.equal(monitor.phoneMonitorOn(), true);
  assert.deepEqual(monitor.phoneMonitorConfig(), { monitor: true, pinSalt: '', pinHash: '' });
  assert.throws(() => monitor.choosePhoneMonitorPin('12'), /pin\.digits/, 'seis digitos');
  assert.throws(() => monitor.choosePhoneMonitorPin('12345a'), /pin\.digits/);
  monitor.choosePhoneMonitorPin('246810', 'entropia-de-teste');
  const config = monitor.phoneMonitorConfig();
  assert.match(config.pinSalt, /^[0-9a-f]{64}$/);
  assert.equal(config.pinHash, createHash('sha256').update(`${config.pinSalt}:246810`).digest('hex'), 'o mesmo hash que o payload calcula');
  assert.equal(monitor.pinHashOf(config.pinSalt, '246810'), config.pinHash);
  const settings = saved.loadList('settings.json', 'settings');
  assert.ok(!JSON.stringify(settings).includes('246810'), 'o PIN em texto nunca e gravado');
  assert.equal(monitor.hasPhoneMonitorPin(), true);
  const seen = [];
  const stop = monitor.onPhoneMonitor((state) => seen.push(state));
  monitor.setPhoneMonitor(false);
  assert.equal(monitor.phoneMonitorConfig().monitor, false);
  monitor.setPhoneMonitorAddress('192.168.0.20');
  monitor.setPhoneMonitorAddress('nao-e-ip');
  stop();
  assert.equal(seen.at(-1).address, '', 'so um IPv4 vira endereco');
  assert.equal(seen.at(-2).address, 'http://192.168.0.20:34201');
  monitor.setPhoneMonitor(true);
});
