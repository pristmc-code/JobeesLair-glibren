// Fase 7 (modelo Orbit): as configuracoes da Jobe no payload (app/native/bg_settings.c) + o sincronizador do app
// (state/settings-sync.js) contra o payload de verdade, compilado para o PC:
//   - migracao do settings.json antigo do app (segredos e valores invalidos ficam de fora; desconhecidas ficam so p/ o app);
//   - GET sem segredos (a pagina so ve preferencias; segredos so como estado; o fim so para aparelho pareado);
//   - POST validando tipos e limites (tudo ou nada; a pagina nao grava interna, desconhecida nem segredo);
//   - gravacao atomica: queda no meio do .part e antes do rename (o arquivo anterior vale; o .part e descartado);
//   - o app: entrega o settings.json no primeiro contato, recebe uma mudanca feita na pagina e manda a dele.
// Run: node --import ./tests/stub-loader.mjs --test tests/bg-settings.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePortFrom } from './free-port.mjs';
import { before as whenBuilt } from 'node:test';
import { assertBuilt, buildSkip, compileTo } from './payload-build.mjs';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));
const { createSettingsSync } = await import(pathToFileURL(path.join(repo, 'app/state/settings-sync.js')).href);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const freePort = freePortFrom(16); // Fase 7: bloco de portas so deste arquivo (tests/free-port.mjs)

// Segredos falsos (nada aqui vale em lugar nenhum)
const TORBOX_KEY = 'abcdef12-3456-7890-abcd-ef12345678zz';
const GITHUB_KEY = 'github_pat_11TESTE0000000000_FakeFakeFakeFakeFakeFake12345Qq9w';
const COMPANION_PIN = '864213';
const MONITOR_PIN_HASH = 'f'.repeat(64);

const dir = mkdtempSync(path.join(os.tmpdir(), 'jl-settings-'));
const binary = path.join(dir, 'bgdl');
const compiler = process.platform === 'win32' ? null : ['cc', 'gcc', 'clang'].find((name) => spawnSync(name, ['--version']).status === 0);
// Compilado fora de /tmp/jl-* e movido no fim (tests/payload-build.mjs): a limpeza de payloads orfaos mata o que cita
// /tmp/jl-*/bgdl na linha de comando, e o compilador citava.
const built = compiler && compileTo(binary, compiler, ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', path.join(repo, 'app/native/bg_downloader.c'), '-lcurl', '-lcrypto', '-larchive', '-lpthread']);
const skip = buildSkip(compiler, built);
// glibren.51: um binario que nao compilou (erro, aviso com -Werror ou o compilador morto por sinal) FALHA todos os
// testes deste arquivo na hora, com o motivo; antes eles viravam "pulados" e ninguem via. So a falta do ambiente pula.
whenBuilt(() => { if (!skip) assertBuilt(built); });
const children = new Set();
after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

let run = 0;
function workspace() {
  const base = path.join(dir, `ws${++run}`);
  for (const sub of ['state', 'tube', 'diag']) mkdirSync(path.join(base, sub), { recursive: true });
  writeFileSync(path.join(base, 'debrid.json'), JSON.stringify({ torbox: { key: TORBOX_KEY } }));
  return { base, state: path.join(base, 'state') };
}
async function startPayload(ws, env = {}) {
  const api = await freePort(), monitor = await freePort();
  const child = spawn(binary, [], {
    env: { ...process.env, BGDL_DIR: ws.state, BGDL_PORT: String(api), BGDL_MONITOR_PORT: String(monitor), BGDL_ORBIT_DIR: path.join(ws.base, 'orbit'),
      BGDL_LIBRARY: path.join(ws.base, 'lista.json'), BGDL_KEYFILE: path.join(ws.base, 'debrid.json'), BGDL_NOTIFY_FILE: path.join(ws.base, 'notify.txt'),
      BGDL_DIAG_DIR: path.join(ws.base, 'diag'), BGDL_TUBE_DIR: path.join(ws.base, 'tube'), BGDL_APP_SETTINGS: path.join(ws.base, 'app-settings.json'), ...env },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  children.add(child);
  const exited = new Promise((resolve) => child.on('exit', (code) => { children.delete(child); resolve(code); }));
  const token = () => readFileSync(path.join(ws.state, 'token'), 'utf8').trim();
  const call = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${api}${route}`, { method, headers: { 'X-Jobe-Token': token(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text };
  };
  const page = async (route, { method = 'GET', body, session } = {}) => {
    const res = await fetch(`http://127.0.0.1:${monitor}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Session': session } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text };
  };
  for (const end = performance.now() + 30000; ; await wait(50)) {
    try { if (existsSync(path.join(ws.state, 'token')) && (await call('GET', '/health')).status === 200) break; } catch {}
    if (performance.now() > end) throw new Error(`payload did not start: ${readLog(ws).slice(-600)}`);
  }
  const stop = async () => { child.kill('SIGTERM'); await exited; };
  return { child, exited, call, page, stop };
}
const readLog = (ws) => { try { return readFileSync(path.join(ws.state, 'bgdl.log'), 'utf8'); } catch { return ''; } };
const fileOf = (ws) => JSON.parse(readFileSync(path.join(ws.state, 'settings.json'), 'utf8'));
// A sessao do PIN antigo da pagina (ainda aceita na transicao do pareamento).
async function pinSession(p) {
  const PIN = '246813';
  const salt = randomBytes(32).toString('hex');
  assert.equal((await p.call('POST', '/config', { pinSalt: salt, pinHash: sha(`${salt}:${PIN}`) })).status, 200);
  const session = (await p.page('/api/unlock', { method: 'POST', body: { pin: PIN } })).data.session;
  assert.match(session, /^[0-9a-f]{32}$/);
  return session;
}
// Um aparelho pareado (bg_pair.c): o codigo que a TV mostra vem do GET /pair da API local.
async function pairedToken(p) {
  assert.equal((await p.page('/api/pair/request', { method: 'POST', body: { name: 'Celular de teste' } })).status, 200);
  const code = (await p.call('GET', '/pair')).data.code;
  const done = await p.page('/api/pair/confirm', { method: 'POST', body: { code, name: 'Celular de teste' } });
  assert.equal(done.status, 200, done.text);
  return done.data.token;
}

// O settings.json de um app da .49 (com segredos, chaves internas, uma desconhecida e dois valores invalidos).
const LEGACY = {
  language: 'pt-BR', speedLimit: 20, simultaneousDownloads: 2, screenSaver: false, defaultDrive: '/mnt/ext0',
  hiddenSources: ['bundled', 'https://example.com/feed.json'], linkFormats: { kinds: ['exfat'], unknown: false },
  tubeQuality: 1440, whatsNewSeen: '0.5.6', reportCode: 'AB23CD', keyboardOpen: 1731500000000, futureOption: { a: [1, 2] },
  companionPin: COMPANION_PIN, companionSession: 'sessaosecretasessaosecreta', phoneMonitorPin: { salt: 'e'.repeat(64), hash: MONITOR_PIN_HASH },
  tubeDownloadCap: 5000, storeMode: 'outra'
};

test('migracao: o settings.json antigo do app vira o do payload, sem segredos e sem valores invalidos', { skip }, async () => {
  const ws = workspace();
  writeFileSync(path.join(ws.base, 'app-settings.json'), JSON.stringify(LEGACY));
  const p = await startPayload(ws);
  try {
    const health = (await p.call('GET', '/health')).data;
    assert.equal(health.settings, 1);
    assert.equal(health.settingsRev, 1);
    assert.match(health.settingsStore, /^[0-9a-f]{32}$/);
    const got = (await p.call('GET', '/settings')).data;
    assert.equal(got.migratedFrom, path.join(ws.base, 'app-settings.json'));
    assert.equal(got.store, health.settingsStore);
    assert.deepEqual(got.values, {
      language: 'pt-BR', speedLimit: 20, simultaneousDownloads: 2, screenSaver: false, defaultDrive: '/mnt/ext0',
      hiddenSources: ['bundled', 'https://example.com/feed.json'], linkFormats: { kinds: ['exfat'], unknown: false },
      tubeQuality: 1440, whatsNewSeen: '0.5.6', reportCode: 'AB23CD', keyboardOpen: 1731500000000, futureOption: { a: [1, 2] }
    });
    const disk = readFileSync(path.join(ws.state, 'settings.json'), 'utf8');
    assert.equal(JSON.parse(disk).schema, 1);
    for (const secret of [COMPANION_PIN, 'sessaosecretasessaosecreta', MONITOR_PIN_HASH, 'companionPin', 'phoneMonitorPin']) assert.ok(!disk.includes(secret), `segredo no arquivo: ${secret}`);
    assert.match(readLog(ws), /configuracoes migradas de .*app-settings\.json: 12 chave\(s\); 3 segredo\(s\) ficaram no app; 2 invalida\(s\) descartada\(s\)/);
    assert.ok(!readLog(ws).includes(COMPANION_PIN));
    // Reiniciado, le o proprio arquivo (nao migra de novo).
    await p.stop();
    writeFileSync(path.join(ws.base, 'app-settings.json'), JSON.stringify({ language: 'en' }));
    const again = await startPayload(ws);
    try {
      const second = (await again.call('GET', '/settings')).data;
      assert.equal(second.values.language, 'pt-BR');
      assert.equal(second.rev, 1);
      assert.equal(second.store, health.settingsStore);
    } finally {
      await again.stop();
    }
  } finally {
    if (p.child.exitCode === null) await p.stop();
  }
});

test('migracao: um settings.json no formato do app (sem envelope) na pasta do payload e importado; sem nada, comeca vazio', { skip }, async () => {
  const ws = workspace();
  writeFileSync(path.join(ws.state, 'settings.json'), JSON.stringify({ vibration: false, companionPin: COMPANION_PIN, speedLimit: -3 }));
  const p = await startPayload(ws);
  try {
    const got = (await p.call('GET', '/settings')).data;
    assert.deepEqual(got.values, { vibration: false });
    const disk = fileOf(ws);
    assert.equal(disk.schema, 1);
    assert.deepEqual(disk.values, { vibration: false });
  } finally {
    await p.stop();
  }
  const empty = workspace();
  const q = await startPayload(empty);
  try {
    const health = (await q.call('GET', '/health')).data;
    assert.equal(health.settings, 1);
    assert.equal(health.settingsRev, 0);
    assert.equal(health.settingsStore, '', 'o store nasce na primeira gravacao');
    assert.deepEqual((await q.call('GET', '/settings')).data.values, {});
    assert.ok(!existsSync(path.join(empty.state, 'settings.json')));
  } finally {
    await q.stop();
  }
});

test('GET sem segredos: a pagina ve so as preferencias e o estado dos segredos (fim so para aparelho pareado)', { skip }, async () => {
  const ws = workspace();
  writeFileSync(path.join(ws.base, 'app-settings.json'), JSON.stringify(LEGACY));
  writeFileSync(path.join(ws.base, 'diag/token'), `${GITHUB_KEY}\n`);
  writeFileSync(path.join(ws.base, 'tube/account.json'), JSON.stringify({ refresh: 'CONTA-SECRETA-YT' }));
  const p = await startPayload(ws);
  try {
    assert.equal((await p.page('/api/settings')).status, 401, 'sem credencial');
    assert.equal((await p.page('/api/settings', { session: 'f'.repeat(32) })).status, 401, 'sessao inventada');
    const session = await pinSession(p);
    const web = await p.page('/api/settings', { session });
    assert.equal(web.status, 200);
    assert.deepEqual(Object.keys(web.data.values).sort(), ['defaultDrive', 'hiddenSources', 'language', 'linkFormats', 'screenSaver', 'simultaneousDownloads', 'speedLimit', 'tubeQuality']);
    assert.equal(web.data.migratedFrom, undefined, 'o caminho do arquivo nao vai para a pagina');
    assert.deepEqual(web.data.secrets, { torbox: { set: true }, alldebrid: { set: false }, github: { set: true }, youtube: { set: true }, phonePin: { set: true } });
    for (const secret of [TORBOX_KEY, TORBOX_KEY.slice(-4), GITHUB_KEY, GITHUB_KEY.slice(-4), COMPANION_PIN, 'CONTA-SECRETA-YT', 'whatsNewSeen', 'reportCode', 'futureOption'])
      assert.ok(!web.text.includes(secret), `vazou: ${secret}`);
    // Aparelho pareado (monitor_strong): o fim das chaves, nunca a chave.
    const device = await pairedToken(p);
    const strong = await p.page('/api/settings', { session: device });
    assert.equal(strong.status, 200);
    assert.deepEqual(strong.data.secrets.torbox, { set: true, tail: TORBOX_KEY.slice(-4) });
    assert.deepEqual(strong.data.secrets.github, { set: true, tail: GITHUB_KEY.slice(-4) });
    assert.deepEqual(strong.data.secrets.youtube, { set: true });
    assert.ok(!strong.text.includes(TORBOX_KEY) && !strong.text.includes(GITHUB_KEY));
    // O app (token) ve tudo o que esta guardado, e os segredos so como estado.
    const app = await p.call('GET', '/settings');
    assert.equal(app.data.values.whatsNewSeen, '0.5.6');
    assert.ok(!app.text.includes(TORBOX_KEY) && !app.text.includes(COMPANION_PIN));
  } finally {
    await p.stop();
  }
});

test('POST validando: tipos e limites, tudo ou nada; a pagina so grava preferencias e elas valem na hora nos downloads', { skip }, async () => {
  const ws = workspace();
  writeFileSync(path.join(ws.base, 'app-settings.json'), JSON.stringify({ speedLimit: 20, language: 'en' }));
  const p = await startPayload(ws);
  try {
    const session = await pinSession(p);
    const post = (body) => p.page('/api/settings', { method: 'POST', body, session });
    assert.equal((await p.page('/api/settings', { method: 'POST', body: { set: { speedLimit: 1 } } })).status, 401);
    const refused = [
      [{ set: { speedLimit: 2000 } }, 'invalid', 'speedLimit'],
      [{ set: { speedLimit: 10.5 } }, 'invalid', 'speedLimit'],
      [{ set: { speedLimit: '10' } }, 'invalid', 'speedLimit'],
      [{ set: { screenSaver: 'false' } }, 'invalid', 'screenSaver'],
      [{ set: { pauseOnCloseSeconds: 7 } }, 'invalid', 'pauseOnCloseSeconds'],
      [{ set: { language: 'klingon' } }, 'invalid', 'language'],
      [{ set: { defaultDrive: '/mnt/../etc' } }, 'invalid', 'defaultDrive'],
      [{ set: { defaultDrive: 'mnt/ext0' } }, 'invalid', 'defaultDrive'],
      [{ set: { hiddenSources: [1, 2] } }, 'invalid', 'hiddenSources'],
      [{ set: { hiddenSources: Array.from({ length: 65 }, (_, i) => `f${i}`) } }, 'invalid', 'hiddenSources'],
      [{ set: { language: 'pt-BR', speedLimit: -1 } }, 'invalid', 'speedLimit'],
      [{ set: { whatsNewSeen: '0.6' } }, 'readonly', 'whatsNewSeen'],
      [{ set: { futureOption: 1 } }, 'unknown', 'futureOption'],
      [{ set: { companionPin: '111111' } }, 'secret', 'companionPin'],
      [{ set: { 'bad-key': 1 } }, 'key', 'bad-key'],
      [{ unset: ['reportCode'] }, 'readonly', 'reportCode'],
      [{ replace: true, set: {} }, 'replace', ''],
      [{}, 'empty', '']
    ];
    for (const [body, error, key] of refused) {
      const answer = await post(body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.deepEqual(answer.data, { error, key }, JSON.stringify(body));
    }
    assert.equal((await p.call('GET', '/settings')).data.rev, 1, 'nada mudou (tudo ou nada)');
    assert.equal((await p.call('GET', '/settings')).data.values.language, 'en');
    const ok = await post({ set: { speedLimit: 25, simultaneousDownloads: 3, language: 'pt-BR', pauseOnCloseSeconds: 10, convertWriteLimit: 50, tubeSubtitles: true }, unset: ['nada'] });
    assert.equal(ok.status, 400, 'unset de chave desconhecida pela pagina tambem e recusado');
    const good = await post({ set: { speedLimit: 25, simultaneousDownloads: 3, language: 'pt-BR', pauseOnCloseSeconds: 10, convertWriteLimit: 50, tubeSubtitles: true } });
    assert.equal(good.status, 200, good.text);
    assert.equal(good.data.rev, 2);
    assert.deepEqual(good.data.changed.sort(), ['convertWriteLimit', 'language', 'pauseOnCloseSeconds', 'simultaneousDownloads', 'speedLimit', 'tubeSubtitles']);
    const health = (await p.call('GET', '/health')).data;
    assert.equal(health.settingsRev, 2);
    assert.equal(health.speedLimit, 25);
    assert.equal(health.speedLimitBy, 'remote', 'o app adota como faz com /api/config');
    assert.equal(health.concurrency, 3);
    assert.equal(health.pauseOnCloseSeconds, 10);
    assert.equal(health.convertWriteLimit, 50);
    assert.equal(JSON.parse(readFileSync(path.join(ws.state, 'config.json'), 'utf8')).speedLimit, 25);
    // O mesmo valor de novo nao sobe a revisao.
    assert.equal((await post({ set: { speedLimit: 25 } })).data.rev, 2);
    assert.equal((await post({ unset: ['tubeSubtitles'] })).data.rev, 3);
    // O app: estrito no normal; o replace descarta o invalido e o segredo e diz quais.
    assert.deepEqual((await p.call('POST', '/settings', { set: { speedLimit: 9999 } })).data, { error: 'invalid', key: 'speedLimit' });
    assert.deepEqual((await p.call('POST', '/settings', { set: { companionPin: '1' } })).data, { error: 'secret', key: 'companionPin' });
    const appSet = await p.call('POST', '/settings', { set: { whatsNewSeen: '0.5.7', futureOption: [1] } });
    assert.equal(appSet.status, 200);
    const replaced = await p.call('POST', '/settings', { replace: true, set: { language: 'es', speedLimit: 5000, companionPin: COMPANION_PIN, crashSeen: 'x' } });
    assert.equal(replaced.status, 200, replaced.text);
    assert.deepEqual(replaced.data.values, { language: 'es', crashSeen: 'x' });
    assert.deepEqual(replaced.data.dropped, ['speedLimit']);
    assert.ok(!readFileSync(path.join(ws.state, 'settings.json'), 'utf8').includes(COMPANION_PIN));
    // Grande demais: 413 e nada muda.
    const huge = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, i]));
    assert.equal((await p.call('POST', '/settings', { set: huge })).status, 400);
  } finally {
    await p.stop();
  }
});

for (const mode of ['half', 'before-rename']) {
  test(`gravacao atomica: queda ${mode === 'half' ? 'no meio do .part' : 'antes do rename'} deixa o arquivo anterior valendo`, { skip }, async () => {
    const ws = workspace();
    writeFileSync(path.join(ws.base, 'app-settings.json'), JSON.stringify({ language: 'en', speedLimit: 20 }));
    const first = await startPayload(ws);
    const before = readFileSync(path.join(ws.state, 'settings.json'), 'utf8');
    await first.stop();
    const crashing = await startPayload(ws, { BGDL_SETTINGS_CRASH: mode });
    const session = await pinSession(crashing);
    await assert.rejects(crashing.page('/api/settings', { method: 'POST', body: { set: { language: 'ja', speedLimit: 99 } }, session }));
    assert.equal(await crashing.exited, 86, 'o payload caiu no meio da gravacao');
    assert.equal(readFileSync(path.join(ws.state, 'settings.json'), 'utf8'), before, 'o arquivo anterior esta inteiro');
    assert.ok(existsSync(path.join(ws.state, 'settings.json.part')), 'sobrou o .part');
    const back = await startPayload(ws);
    try {
      const got = (await back.call('GET', '/settings')).data;
      assert.deepEqual(got.values, { language: 'en', speedLimit: 20 });
      assert.equal(got.rev, 1);
      assert.ok(!existsSync(path.join(ws.state, 'settings.json.part')), 'o .part foi descartado');
      assert.match(readLog(ws), /gravacao interrompida descartada/);
      // E grava normalmente depois.
      assert.equal((await back.call('POST', '/settings', { set: { language: 'ja' } })).data.rev, 2);
      assert.equal(fileOf(ws).values.language, 'ja');
      assert.deepEqual(readdirSync(ws.state).filter((name) => name.startsWith('settings.json')), ['settings.json']);
    } finally {
      await back.stop();
    }
  });
}

test('arquivo ilegivel: guardado de lado e o payload migra de novo do app', { skip }, async () => {
  const ws = workspace();
  writeFileSync(path.join(ws.state, 'settings.json'), '{"schema":1,"values":{"language":');
  writeFileSync(path.join(ws.base, 'app-settings.json'), JSON.stringify({ language: 'fr' }));
  const p = await startPayload(ws);
  try {
    assert.equal((await p.call('GET', '/settings')).data.values.language, 'fr');
    assert.ok(readdirSync(ws.state).some((name) => name.startsWith('settings.json.unreadable-')));
  } finally {
    await p.stop();
  }
});

// ---- O app (state/settings-sync.js) contra este payload ----
function appSide(p, local) {
  let file = { ...local };
  let syncState = {};
  const adopted = [];
  const source = {
    health: async () => { const h = await p.call('GET', '/health'); return h.status === 200 ? h.data : null; },
    get: () => p.call('GET', '/settings'),
    post: (body) => p.call('POST', '/settings', body)
  };
  const sync = createSettingsSync({
    readLocal: () => file, writeLocal: (next) => { file = next; }, readState: () => syncState, writeState: (next) => { syncState = JSON.parse(JSON.stringify(next)); },
    onAdopt: (keys) => adopted.push(...keys), pollMs: 0, pushDelayMs: -1
  });
  sync.setSource(source);
  return { sync, file: () => file, save: (next) => { const before = file; file = next; sync.noteSave(before, next); }, adopted, syncState: () => syncState };
}

test('o app: entrega o settings.json no primeiro contato, recebe a mudanca da pagina e manda a dele', { skip }, async () => {
  const ws = workspace();
  writeFileSync(path.join(ws.base, 'app-settings.json'), JSON.stringify({ language: 'en', speedLimit: 20 }));
  const p = await startPayload(ws);
  try {
    const app = appSide(p, { language: 'en', speedLimit: 30, companionPin: COMPANION_PIN, whatsNewSeen: '0.5.6' });
    assert.equal(await app.sync.sync(), 'payload');
    let got = (await p.call('GET', '/settings')).data;
    assert.deepEqual(got.values, { language: 'en', speedLimit: 30, whatsNewSeen: '0.5.6' }, 'o local ganhou no primeiro contato; o PIN ficou');
    assert.equal(app.syncState().store, got.store);
    // A pagina muda o idioma: o app adota na proxima rodada (e o segredo continua no settings.json local).
    const session = await pinSession(p);
    assert.equal((await p.page('/api/settings', { method: 'POST', body: { set: { language: 'pt-BR' } }, session })).status, 200);
    await app.sync.sync();
    assert.equal(app.file().language, 'pt-BR');
    assert.equal(app.file().companionPin, COMPANION_PIN);
    assert.deepEqual(app.adopted, ['language']);
    // O app muda o limite: vai ao payload.
    app.save({ ...app.file(), speedLimit: 7 });
    await app.sync.sync();
    got = (await p.call('GET', '/settings')).data;
    assert.equal(got.values.speedLimit, 7);
    assert.deepEqual(app.syncState().pending, { set: {}, unset: [] });
    // Chave que este payload recusa fica so no app (e nao trava a fila).
    app.save({ ...app.file(), tubeQuality: 4320 });
    await app.sync.sync();
    assert.ok(app.syncState().localOnly.includes('tubeQuality'));
    assert.equal(app.file().tubeQuality, 4320);
    app.save({ ...app.file(), vibration: false });
    await app.sync.sync();
    assert.equal((await p.call('GET', '/settings')).data.values.vibration, false);
  } finally {
    await p.stop();
  }
});
