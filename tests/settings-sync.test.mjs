// Fase 7: o sincronizador das configuracoes do app (state/settings-sync.js) com payloads falsos:
//   - fallback: sem payload, ou com um antigo (sem "settings" no /health, api 33), nada sai do app e o settings.json
//     local continua valendo; as mudancas ficam pendentes e vao quando um payload novo aparece;
//   - primeiro contato (store desconhecido) manda o settings.json inteiro; segredos nunca saem;
//   - mudanca remota (settingsRev) e adotada; a pendente local ganha da remota na mesma chave;
//   - saved.js avisa o sincronizador so nas gravacoes do settings.json; settings-apply cobre as chaves do payload.
// Run: node --import ./tests/stub-loader.mjs --test tests/settings-sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettingsSync, SETTINGS_SECRET_KEYS } from '../app/state/settings-sync.js';
import { saveList, setSettingsHook } from '../app/state/saved.js';

const repo = process.env.JL_REPO || fileURLToPath(new URL('..', import.meta.url));

// Um payload falso com o contrato do bg_settings.c (so o que o app usa). `old`: um payload da .49 (sem "settings").
function fakePayload({ old = false, refuse = [] } = {}) {
  const p = { values: {}, rev: 0, store: '', calls: [], old, alive: true };
  const reply = () => ({ status: 200, data: { ok: true, schema: 1, rev: p.rev, store: p.store, values: { ...p.values }, changed: [], dropped: [] } });
  p.source = {
    health: async () => {
      p.calls.push('health');
      if (!p.alive) return null;
      return p.old ? { ok: true, api: 33, version: '1.33.0' } : { ok: true, api: 33, settings: 1, settingsRev: p.rev, settingsStore: p.store };
    },
    get: async () => { p.calls.push('get'); return p.old ? { status: 404, data: { error: 'not found' } } : reply(); },
    post: async (body) => {
      p.calls.push(['post', JSON.parse(JSON.stringify(body))]);
      if (p.old) return { status: 404, data: { error: 'not found' } };
      const bad = Object.keys(body.set ?? {}).find((key) => refuse.includes(key));
      if (bad && !body.replace) return { status: 400, data: { error: 'invalid', key: bad } };
      const dropped = [];
      if (body.replace) p.values = {};
      for (const [key, value] of Object.entries(body.set ?? {})) {
        if (refuse.includes(key)) { dropped.push(key); continue; }
        p.values[key] = value;
      }
      for (const key of body.unset ?? []) delete p.values[key];
      p.rev++;
      if (!p.store) p.store = 'a'.repeat(32);
      return { ...reply(), data: { ...reply().data, dropped } };
    }
  };
  p.webSet = (changes) => { Object.assign(p.values, changes); p.rev++; };
  return p;
}
function app(local, state = {}) {
  const a = { file: { ...local }, state: JSON.parse(JSON.stringify(state)), adopted: [], logs: [] };
  a.sync = createSettingsSync({
    readLocal: () => a.file, writeLocal: (next) => { a.file = next; }, readState: () => a.state, writeState: (next) => { a.state = JSON.parse(JSON.stringify(next)); },
    onAdopt: (keys) => a.adopted.push(...keys), log: (line) => a.logs.push(line), pollMs: 0, pushDelayMs: -1
  });
  a.save = (next) => { const before = a.file; a.file = next; a.sync.noteSave(before, next); };
  return a;
}
const posts = (p) => p.calls.filter((call) => Array.isArray(call) && call[0] === 'post').map((call) => call[1]);

test('fallback: sem payload no ar, tudo fica no settings.json local', async () => {
  const a = app({ language: 'en' });
  assert.equal(await a.sync.sync(), 'local');
  a.sync.setSource({ health: async () => null, get: async () => null, post: async () => null });
  assert.equal(await a.sync.sync(), 'local');
  a.save({ language: 'pt-BR' });
  assert.equal(a.file.language, 'pt-BR');
  assert.deepEqual(a.state.pending, { set: { language: 'pt-BR' }, unset: [] }, 'fica pendente para quando houver payload');
});

test('fallback: payload antigo (api 33, sem "settings" no /health) nunca recebe GET/POST /settings; o novo recebe o que ficou', async () => {
  const old = fakePayload({ old: true });
  const a = app({ language: 'en', speedLimit: 10, companionPin: '864213' });
  a.sync.setSource(old.source);
  assert.equal(await a.sync.sync(), 'local');
  a.save({ ...a.file, speedLimit: 15 });
  a.save({ ...a.file, screenSaver: false });
  assert.equal(await a.sync.sync(), 'local');
  assert.deepEqual(old.calls.filter((call) => call !== 'health'), [], 'so o /health');
  assert.equal(a.file.speedLimit, 15, 'o app segue com o settings.json local');
  // O payload novo sobe (app atualizou o payload): primeiro contato manda tudo, menos os segredos.
  const fresh = fakePayload();
  a.sync.setSource(fresh.source);
  assert.equal(await a.sync.sync(), 'payload');
  assert.deepEqual(posts(fresh), [{ replace: true, set: { language: 'en', speedLimit: 15, screenSaver: false } }]);
  assert.deepEqual(a.state.pending, { set: {}, unset: [] });
  assert.equal(a.state.store, 'a'.repeat(32));
  assert.equal(a.file.companionPin, '864213', 'o segredo continua no app');
});

test('primeiro contato: o local ganha; segredos e chaves recusadas ficam so no app', async () => {
  const p = fakePayload({ refuse: ['tubeQuality'] });
  p.values = { language: 'ja' }; p.rev = 4; p.store = 'b'.repeat(32); // um store que este app nunca viu
  const a = app({ language: 'en', tubeQuality: 4320, phoneMonitorPin: { salt: '1', hash: '2' }, companionSession: 'x', companionCode: 'y' });
  assert.equal(await (a.sync.setSource(p.source)), 'payload');
  const [seed] = posts(p);
  assert.equal(seed.replace, true);
  for (const key of SETTINGS_SECRET_KEYS) assert.ok(!(key in seed.set), key);
  assert.deepEqual(p.values, { language: 'en' });
  assert.deepEqual(a.state.localOnly, ['tubeQuality']);
  assert.equal(a.file.tubeQuality, 4320);
  // Depois: tubeQuality nunca vai, e o payload nao a apaga do local.
  a.save({ ...a.file, tubeQuality: 1080 });
  assert.deepEqual(a.state.pending, { set: {}, unset: [] });
});

test('mudanca na pagina (settingsRev) chega ao app; a pendente local ganha na mesma chave; chave tirada volta ao padrao', async () => {
  const p = fakePayload();
  const a = app({ language: 'en', speedLimit: 10, companionPin: '864213' });
  a.sync.setSource(p.source);
  await a.sync.sync();
  const after = p.calls.length;
  await a.sync.sync();
  assert.deepEqual(p.calls.slice(after), ['health'], 'sem mudanca: so o /health');
  p.webSet({ language: 'pt-BR', vibration: false });
  await a.sync.sync();
  assert.deepEqual({ ...a.file }, { language: 'pt-BR', speedLimit: 10, companionPin: '864213', vibration: false });
  assert.deepEqual(a.adopted.sort(), ['language', 'vibration']);
  // As duas mudam a mesma chave: a do app (pendente) vai e fica.
  p.webSet({ speedLimit: 50 });
  a.save({ ...a.file, speedLimit: 3 });
  await a.sync.sync();
  assert.equal(p.values.speedLimit, 3);
  assert.equal(a.file.speedLimit, 3);
  // A pagina tira uma chave: sai do local (o modulo volta ao padrao pelo watcher).
  delete p.values.vibration; p.rev++;
  a.adopted.length = 0;
  await a.sync.sync();
  assert.ok(!('vibration' in a.file));
  assert.deepEqual(a.adopted, ['vibration']);
  // Gravacoes feitas enquanto o app aplica (o setter do modulo regrava o settings.json) nao voltam ao payload.
  const before = posts(p).length;
  await a.sync.sync();
  assert.equal(posts(p).length, before);
});

test('saved.js avisa o sincronizador so nas gravacoes do settings.json (antes -> depois)', () => {
  const seen = [];
  setSettingsHook((before, after) => seen.push([before, after]));
  try {
    saveList('settings.json', 'settings', { a: 1 });
    saveList('settings.json', 'settings', { a: 2 });
    saveList('wishlist.json', 'wishlist', ['x']);
  } finally {
    setSettingsHook(null);
  }
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1][1], { a: 2 });
});

test('o esquema do payload cobre as chaves que settings-apply aplica e os segredos do app', () => {
  const c = readFileSync(path.join(repo, 'app/native/bg_settings.c'), 'utf8');
  const apply = readFileSync(path.join(repo, 'app/state/settings-apply.js'), 'utf8');
  const prefs = [...c.matchAll(/\{"(\w+)", ST_\w+, SC_PREF/g)].map((m) => m[1]);
  const secrets = [...c.matchAll(/\{"(\w+)", ST_\w+, SC_SECRET/g)].map((m) => m[1]);
  assert.deepEqual(secrets.sort(), [...SETTINGS_SECRET_KEYS].sort());
  const applied = [...apply.matchAll(/^    (\w+): \(value\)/gm)].map((m) => m[1]);
  for (const key of applied) assert.ok(prefs.includes(key), `${key} aplicada no app mas nao e preferencia no payload`);
  for (const key of ['convertPauseSeconds', 'convertWriteLimit', 'convertSyncMB']) assert.ok(prefs.includes(key));
  // Os limites do payload batem com os do app.
  assert.match(c, /"pauseOnCloseSeconds", ST_INTS, SC_PREF, 0, 0, "0,5,10,15,20,25,30"/);
  const locales = c.match(/"language", ST_TEXTS, SC_PREF, 0, 0, "([^"]+)"/)[1].split(',').sort();
  assert.deepEqual(locales, readdirSync(path.join(repo, 'app/i18n/locales')).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort());
});
