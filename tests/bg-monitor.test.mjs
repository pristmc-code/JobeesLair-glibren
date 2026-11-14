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

test('glibren.19: a pagina guarda a credencial (sessao do PIN ou token do aparelho), confere ao abrir e so pede de novo num 401 ou no cadeado', () => {
  const page = readFileSync(embed.PAGE, 'utf8');
  assert.match(page, /const SESSION_KEY = "jobe\.session"/);
  // Pareamento: a guardada e a sessao do PIN (32 hex) ou o token do aparelho (64 hex); "local" (o proprio PS5) nunca.
  assert.ok(page.includes('const CRED = /^([0-9a-f]{32}|[0-9a-f]{64})$/;'));
  assert.ok(page.includes('try { const saved = localStorage.getItem(SESSION_KEY); if (CRED.test(saved || "")) session = saved; } catch {}'), 'le a guardada ao carregar');
  const lock = page.slice(page.indexOf('function lockButton()'), page.indexOf('function render()'));
  assert.match(lock, /if \(CRED\.test\(session\)\) localStorage\.setItem\(SESSION_KEY, session\)/, 'grava quando a credencial muda (so hex)');
  assert.match(lock, /localStorage\.removeItem\(SESSION_KEY\)/, 'apaga quando a sessao some (401 ou cadeado)');
  const open = page.slice(page.indexOf('async function pinOnOpen()'), page.indexOf('pinOnOpen();'));
  assert.ok(open.includes('api("GET", "/api/session")'), 'confere a guardada no payload');
  assert.match(open, /if \(r\.status !== 401\) return;/, 'so um 401 descarta a guardada');
  assert.match(open, /if \(!session && lastStatus && \(pinSet \|\| \(pairInfo && pairInfo\.devices > 0\)\) && \$\("sheet"\)\.hidden\) openPin\(\);/, 'pede uma vez ao abrir, sem credencial, quando o PS5 ja tem protecao');
  assert.ok(page.includes('pinOnOpen();\n</script>'));
  // O cadeado e os 401 continuam zerando a sessao e passando por lockButton (que apaga a guardada).
  // Pareamento: com um aparelho pareado (ou no proprio PS5) o cadeado abre a lista de aparelhos; com a sessao do PIN tranca.
  assert.ok(page.includes('$("lock").onclick = () => { if (session.length === 64 || session === "local") { if (window.openDevices) window.openDevices(); } else if (session) { session = ""; lockButton(); } else openPin(); };'));
  for (const hit of page.matchAll(/session = "";/g)) assert.ok(page.slice(hit.index, hit.index + 40).includes('lockButton()'), 'toda limpeza passa por lockButton');
});

test('glibren.12: a pagina mostra a conversao para .exfat e a pasta BACKUP (apagar com o PIN, confirmacao na pagina)', () => {
  const page = readFileSync(embed.PAGE, 'utf8');
  for (const piece of ['/api/backup', '/api/backup/delete', 'window.convHook', 'Convertendo para EXFAT', 'Pronto (EXFAT)', 'Converting to EXFAT', 'Ready (EXFAT)', 'Pasta BACKUP', 'guarded(() => { confirmingBk', '"not-direct"', 'errors: { space:']) assert.ok(page.includes(piece), piece);
  assert.ok(!/\bconfirm\(|\balert\(/.test(page), 'sem caixa nativa do navegador');
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

test('glibren.12: a pagina tem as secoes, o sistema/arquivo nos cards, os cancelados e o BACKUP no fim da lista', () => {
  const page = readFileSync(embed.PAGE, 'utf8');
  for (const piece of ['"all", "downloading", "queue", "extracting", "converting", "done", "cancelled", "backup"', 'localStorage.getItem("jobe.section")', 'Descompactando', 'Cancelados', 'Finalizados', '/api/cancelled/clear', 'cancelledRecent', 'function fileLine', 's-${j.platform}', 'Convertido: {f}', '$("foot").before(row)', '.secbar{', '.secmenu{']) assert.ok(page.includes(piece), piece);
  assert.ok(!page.includes('list.before(row)'), 'o botao do BACKUP fica no fim, nao no topo');
});

test('glibren.13: velocidades em MB/s (nunca Mbps) e a velocidade maxima livre (− campo +, Sem limite, Aplicar)', async () => {
  const page = readFileSync(embed.PAGE, 'utf8');
  assert.ok(!/Mbps|kbps|\* 8 \//.test(page), 'nada em megabits');
  assert.match(page, /MB\/s/);
  assert.match(page, /KB\/s/);
  assert.ok(!/const SPEEDS = \[/.test(page), 'sem lista fixa de velocidades');
  const { MAX_SPEED_LIMIT } = await load('app/state/speed-limit.js');
  assert.match(page, new RegExp(`maxSpeed = ${MAX_SPEED_LIMIT}\\b`), 'o mesmo teto do app e do payload');
  for (const piece of ['id="speedBtn"', 'id="speedBtn2"', 'id="secPick"', '{ speedLimit: v }', 'r.data.speedLimit', 'r.data.maxSpeedLimit', 'guarded(() => setSpeed(v))',
    'input.inputMode = "numeric"', 'hold(minus, -1); hold(plus, 1)', 'e.key === "Enter"', 'none.onclick = () => put(0)', 'L.speedBad', 'menuKind !== "speed"',
    'Sem limite', 'No limit', 'Aplicar', 'Apply', 'Velocidade máxima', 'Maximum speed',
    // glibren.13: arquivo quebrado no TorBox (o payload marca "broken"): fora da escolha, aviso na ficha, recusa explicada.
    '!f.broken', 'r.data?.error === "broken"', 'Arquivo quebrado no TorBox ({s})', 'Broken file in TorBox ({s})', '.fmsg.broken{',
    // glibren.13: so copias quebradas (lista antiga): sem "Baixar", com o que fazer.
    'data.game?.brokenOnly', 'get.hidden = true', 'B.brokenAll', 'Apague no TorBox e use outra fonte', 'Delete it in TorBox and use another source',
    // glibren.18: o payload sozinho: pedido do celular com a Jobe fechada (notas e "Baixando pelo payload") e "Converter agora".
    'L.autoNotes[j.autoNote]', 'j.auto && j.state !== "waiting-app"', 'Baixando pelo payload (Jobee\'sLair fechada)', 'Downloading through the payload',
    '"no-key": "Abra a Jobee\'sLair uma vez para entregar a chave do TorBox', '/api/backup/convert', 'Converter agora', 'Convert now',
    // glibren.25: a resposta do Converter agora (posicao / ja na fila), a mensagem no topo do painel e o estado no item.
    'convQueuedAt:', 'convAlready:', 'convDone:', 'd.already === "converted"', 'convAnswer(r.data', 'bkSay(', '$("bkText"), $("bkMsg"), $("bkList")', 'g.conversion && ACTIVE_CONV.includes']) assert.ok(page.includes(piece), piece);
  // A mesma conta da pagina (MB = 1024 * 1024), num pedaco isolado.
  const fn = /const speed = \(b\) => [^\n]+/.exec(page)[0];
  const speed = new Function('MB', 'nf', `${fn}; return speed;`)(1024 ** 2, (v, d) => v.toFixed(d));
  assert.equal(speed(15 * 1024 ** 2), '15 MB/s');
  assert.equal(speed(2.5 * 1024 ** 2), '2.5 MB/s');
  assert.equal(speed(512 * 1024), '512 KB/s');
  assert.equal(speed(0), '–');
});

test('glibren.55: "Recomecar do zero" na pagina do celular e na /app (14 idiomas, com confirmacao, no lugar de Retomar quando o erro pede)', () => {
  const page = readFileSync(embed.PAGE, 'utf8');
  const RECOMECAR = new Function(`${/var RECOMECAR = [^\n]+/.exec(page)[0]}; return RECOMECAR;`)();
  const langs = ['ar', 'bn', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'pt-BR', 'ru', 'ur', 'zh-Hans'];
  assert.deepEqual(Object.keys(RECOMECAR).sort(), langs);
  for (const lang of langs) for (const key of ['botao', 'armado', 'pergunta', 'sim', 'dica']) assert.ok(RECOMECAR[lang][key] && !/\.\.\.|\u2026/.test(RECOMECAR[lang][key]), `${lang} ${key}`);
  assert.equal(RECOMECAR['pt-BR'].botao, 'Recomeçar do zero');
  // Confirma antes (a linha de confirmacao), so depois chama a rota; Retomar some quando o payload diz restartAdvised.
  assert.ok(page.includes('confirming = `restart:${j.id}`') && page.includes('act(j.id, "restart")'));
  assert.ok(page.includes('const toggle = restart && j.restartAdvised ? ""'));
  const app = readFileSync(path.join(repo, 'app/native/bg_app.html'), 'utf8');
  assert.ok(app.includes('acaoJob(j.id, "restart")') && app.includes('dl.confirmar = "r:" + j.id'), '/app: dois toques');
  assert.ok(app.includes('!(recomeca && j.restartAdvised)'), '/app: no lugar de Retomar');
});

// glibren.58: PS5 real (Alan Wake 2, .exfat.7z de 91,7 GB extraido pelo payload, 14/11/2026): o bloco Convertendo so
// dizia "Descompactando" com a barra listrada, o nome saia cortado ("Alan Wa...") pelo selo ao lado e a falha antiga do
// mesmo item continuava na lista. Agora: % real, "Extraindo do .7z", GB de GB, velocidade, tempo e o motivo (CPU).
test('glibren.58: a pagina do celular mostra o progresso da extracao e esconde a falha antiga do mesmo item', async () => {
  const vm = await import('node:vm');
  const page = readFileSync(path.join(repo, 'app/native/bg_monitor.html'), 'utf8');
  for (const piece of ['extractingFrom: "Extraindo do .{f}"', 'extractingFrom: "Extracting from the .{f}"', 'Limitado pelo processador', 'Limited by the processor',
    'ex.extractPercent', 'ex.extractEtaSeconds', 'ex.extractBytesPerSecond', 'ex.limitedBy === "cpu"', '"width", `${ex.extractPercent}%`, "important"',
    '.job.conv .top{flex-direction:column', '.job.conv .name{display:block;overflow:visible;-webkit-line-clamp:unset', 'liveConversions(DEMO ? demoConv']) assert.ok(page.includes(piece), piece);
  const source = /const liveConversions = \(list\) => \{[\s\S]*?\n\};/.exec(page)?.[0];
  assert.ok(source, 'liveConversions na pagina');
  const live = vm.runInNewContext(`${source}; liveConversions`);
  const list = [
    { id: 'c21', name: 'Alan Wake 2', target: 'PPSA02572.exfat', state: 'failed', error: 'write: x' },
    { id: 'c30', name: 'Alan Wake 2', target: 'PPSA02572.exfat', state: 'extracting' },
    { id: 'c5', name: 'Outro', target: 'PPSA01111.exfat', state: 'failed', error: 'space: x' },
    { id: 'c6', name: 'Cancelado', target: 'PPSA03333.exfat', state: 'cancelled' },
  ];
  assert.deepEqual(live(list).map((c) => c.id), ['c30', 'c5'], 'a falha antiga do mesmo item some; a de outro fica');
  assert.deepEqual(live(list.filter((c) => c.id !== 'c30')).map((c) => c.id), ['c21', 'c5'], 'sem a nova, a falha aparece');
  assert.deepEqual(live([{ id: 'a', name: 'X', target: '', state: 'failed' }, { id: 'b', name: 'X', target: '', state: 'queued' }]).map((c) => c.id), ['b'], 'pelo nome, sem destino');
});
