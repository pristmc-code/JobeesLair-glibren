// Fase 7 do modelo Orbit (ps5/ESTUDO-jobe-como-payload.md): as configuracoes da Jobe ficam no payload
// (app/native/bg_settings.c), uma fonte so para o app e a pagina do celular. O settings.json do app continua sendo lido e
// gravado como sempre (todos os modulos usam loadList/saveList): ele vira a copia local, e e ela que vale quando o
// payload nao responde ou e antigo (sem "settings" no /health) - o fallback e simplesmente o comportamento de antes.
//
// Como anda:
//   - cada gravacao do settings.json (saved.js chama noteSave) vira uma mudanca pendente (chave a chave), guardada em
//     settings-sync.json e mandada ao payload (POST /settings) assim que ele estiver no ar;
//   - de POLL_MS em POLL_MS (e logo depois de uma gravacao) o app olha o /health: "settingsRev" diferente do conhecido =
//     alguem mudou (a pagina do celular) -> GET /settings, e as chaves que mudaram vao para o settings.json local e para
//     quem as usa agora (watchSetting, ligado em state/settings-apply.js); uma chave sem quem a use vale na proxima
//     abertura do app (ela le o settings.json ao abrir);
//   - "settingsStore" diferente do conhecido (o primeiro contato com ESTE armazenamento, ou um payload que perdeu o dele):
//     o app manda o settings.json dele inteiro (replace) - o local ganha. Depois disso, o payload ganha, menos nas chaves
//     com mudanca local ainda nao mandada (a ultima gravacao vale);
//   - segredos (SECRET_KEYS) nunca saem do app; chaves que o payload recusou ("dropped" ou 400 com "key") ficam so locais
//     (localOnly), para um app mais novo que o payload nao perder nada.
import { loadList, saveList, setSettingsHook } from './saved.js';

  var FILE = "settings.json";
  var STATE_FILE = "settings-sync.json";
  // O PIN do companion e a sessao dele, o codigo antigo e o sal+hash do PIN da pagina: ficam so no app.
  var SECRET_KEYS = /* @__PURE__ */ new Set(["companionPin", "companionSession", "companionCode", "phoneMonitorPin"]);
  var SETTINGS_SCHEMA = 1; // o menor "settings" do /health que este app usa (bg_settings.c SETTINGS_SCHEMA)
  var POLL_MS = 5e3;
  var PUSH_DELAY_MS = 300;
  var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  var isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  function cleanState(saved) {
    const pending = isRecord(saved?.pending) ? saved.pending : {};
    return {
      store: typeof saved?.store === "string" ? saved.store : "",
      rev: Number.isSafeInteger(saved?.rev) ? saved.rev : 0,
      pending: { set: isRecord(pending.set) ? { ...pending.set } : {}, unset: Array.isArray(pending.unset) ? pending.unset.filter((key) => typeof key === "string") : [] },
      localOnly: Array.isArray(saved?.localOnly) ? saved.localOnly.filter((key) => typeof key === "string") : []
    };
  }

  /**
   * O motor (sem arquivo nem rede proprios, para os testes): readLocal/writeLocal = o settings.json do app; readState/
   * writeState = settings-sync.json; source (setSource) = { health(), get(), post(body) } do payload no ar, cada um uma
   * promessa de null (sem payload) ou { status, data } (health: o corpo do /health ou null); onAdopt(chaves, valores).
   */
  function createSettingsSync({ readLocal, writeLocal, readState, writeState, onAdopt = () => {}, log = () => {}, pollMs = POLL_MS, pushDelayMs = PUSH_DELAY_MS }) {
    let state = cleanState(readState());
    let source = null;
    let mode = "local";
    let applying = false;
    let busy = null;
    let timer = null, pushTimer = null;
    const shareable = (key) => !SECRET_KEYS.has(key) && !state.localOnly.includes(key);
    const shared = (settings) => Object.fromEntries(Object.entries(isRecord(settings) ? settings : {}).filter(([key, value]) => shareable(key) && value !== void 0));
    const hasPending = () => Object.keys(state.pending.set).length > 0 || state.pending.unset.length > 0;
    const isPending = (key) => key in state.pending.set || state.pending.unset.includes(key);
    const save = () => {
      try {
        writeState(state);
      } catch (problem) {
        log(`sync state not saved: ${problem?.message ?? problem}`);
      }
    };
    function keepLocal(key, why) {
      delete state.pending.set[key];
      state.pending.unset = state.pending.unset.filter((item) => item !== key);
      if (!state.localOnly.includes(key)) state.localOnly.push(key);
      log(`"${key}" stays only in the app (${why})`);
    }
    /** saved.js: o settings.json foi gravado (antes -> depois). */
    function noteSave(before, after) {
      if (applying) return;
      const a = shared(before), b = shared(after);
      let changed = false;
      for (const key of /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (same(a[key], b[key])) continue;
        changed = true;
        if (key in b) {
          state.pending.set[key] = b[key];
          state.pending.unset = state.pending.unset.filter((item) => item !== key);
        } else {
          delete state.pending.set[key];
          if (!state.pending.unset.includes(key)) state.pending.unset.push(key);
        }
      }
      if (!changed) return;
      save();
      if (mode === "payload" && source && pushDelayMs >= 0) {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(() => void sync(), pushDelayMs);
        pushTimer?.unref?.();
      }
    }
    // Os valores do payload no settings.json local (os segredos, as chaves so locais e as pendentes ficam como estao).
    function adopt(values) {
      const local = isRecord(readLocal()) ? readLocal() : {};
      const next = {};
      for (const [key, value] of Object.entries(local)) if (!shareable(key) || isPending(key)) next[key] = value;
      for (const [key, value] of Object.entries(isRecord(values) ? values : {})) if (shareable(key) && !isPending(key)) next[key] = value;
      const changed = [...new Set([...Object.keys(local), ...Object.keys(next)])].filter((key) => !same(local[key], next[key]));
      if (!changed.length) return [];
      applying = true;
      try {
        writeLocal(next);
        onAdopt(changed, next);
      } catch (problem) {
        log(`settings from the payload not applied: ${problem?.message ?? problem}`);
      } finally {
        applying = false;
      }
      log(`settings from the payload: ${changed.join(", ")}`);
      return changed;
    }
    const okAnswer = (answer) => answer?.status === 200 && answer.data?.ok === true && typeof answer.data.store === "string" && Number.isSafeInteger(answer.data.rev);
    async function seed() {
      const answer = await source.post({ replace: true, set: shared(readLocal()) });
      if (!okAnswer(answer)) {
        log(`payload did not take the settings (HTTP ${answer?.status ?? 0})`);
        return;
      }
      for (const key of Array.isArray(answer.data.dropped) ? answer.data.dropped : []) if (typeof key === "string" && !SECRET_KEYS.has(key)) keepLocal(key, "the payload refused it");
      state.store = answer.data.store;
      state.rev = answer.data.rev;
      state.pending = { set: {}, unset: [] };
      save();
      log(`settings handed to the payload (store ${state.store.slice(0, 8)}, rev ${state.rev})`);
      adopt(answer.data.values);
    }
    async function push() {
      const sent = { set: { ...state.pending.set }, unset: [...state.pending.unset] };
      const answer = await source.post(sent);
      if (answer?.status === 400 && typeof answer.data?.key === "string" && answer.data.key) {
        keepLocal(answer.data.key, `refused: ${answer.data.error ?? "invalid"}`);
        save();
        return false;
      }
      if (!okAnswer(answer)) {
        log(`payload did not take the settings change (HTTP ${answer?.status ?? 0})`);
        return false;
      }
      // So sai da fila o que foi mandado e nao mudou de novo enquanto ia.
      for (const [key, value] of Object.entries(sent.set)) if (key in state.pending.set && same(state.pending.set[key], value)) delete state.pending.set[key];
      state.pending.unset = state.pending.unset.filter((key) => !sent.unset.includes(key) || key in state.pending.set);
      state.rev = answer.data.rev;
      save();
      adopt(answer.data.values);
      return true;
    }
    async function pull() {
      const answer = await source.get();
      if (!okAnswer(answer)) return;
      state.rev = answer.data.rev;
      save();
      adopt(answer.data.values);
    }
    async function syncNow() {
      if (!source) return mode = "local";
      let health = null;
      try {
        health = await source.health();
      } catch {
      }
      if (!health || !(Number(health.settings) >= SETTINGS_SCHEMA)) {
        if (mode !== "local") log(health ? "the payload running keeps no settings (an older one); using settings.json" : "no payload; using settings.json");
        return mode = "local";
      }
      if (mode !== "payload") log(`settings kept by the payload (schema ${health.settings}, rev ${health.settingsRev})`);
      mode = "payload";
      if (!health.settingsStore || health.settingsStore !== state.store) await seed();
      else if (hasPending()) await push();
      else if (health.settingsRev !== state.rev) await pull();
      return mode;
    }
    /** Uma rodada (uma por vez): devolve "payload" ou "local". */
    function sync() {
      if (!busy) busy = syncNow().catch((problem) => {
        log(`settings sync failed: ${problem?.message ?? problem}`);
        return mode;
      }).finally(() => {
        busy = null;
      });
      return busy;
    }
    /** Liga (ou troca) o payload e comeca a olhar de pollMs em pollMs (0 = so quando sync() for chamado). */
    function setSource(next) {
      source = next ?? null;
      clearInterval(timer);
      timer = null;
      if (source && pollMs > 0) {
        timer = setInterval(() => void sync(), pollMs);
        timer?.unref?.();
      }
      return source ? sync() : Promise.resolve(mode = "local");
    }
    function stop() {
      clearInterval(timer);
      clearTimeout(pushTimer);
      timer = pushTimer = null;
      source = null;
    }
    return { noteSave, sync, setSource, stop, mode: () => mode, state: () => cleanState(state) };
  }

  // ---- A instancia do app (ligada ao settings.json pelo saved.js) ----
  var watchers = /* @__PURE__ */ new Map();
  var engine = createSettingsSync({
    readLocal: () => loadList(FILE, "settings"),
    writeLocal: (next) => saveList(FILE, "settings", next),
    readState: () => loadList(STATE_FILE, "settings sync"),
    writeState: (next) => saveList(STATE_FILE, "settings sync", next),
    log: (line) => console.log(`[settings] ${line}`),
    onAdopt: (keys, values) => {
      for (const key of keys) for (const watcher of [...watchers.get(key) ?? []]) {
        try {
          watcher(values[key]);
        } catch (problem) {
          console.log(`[settings] ${key} not applied now: ${problem?.message ?? problem}`);
        }
      }
    }
  });
  setSettingsHook((before, after) => engine.noteSave(before, after));
  /** Quem usa `key` agora recebe o valor novo vindo do payload (undefined = a chave saiu: volte ao padrao). */
  function watchSetting(key, apply) {
    if (!watchers.has(key)) watchers.set(key, /* @__PURE__ */ new Set());
    watchers.get(key).add(apply);
    return () => watchers.get(key)?.delete(apply);
  }
  var setSettingsSource = (source) => engine.setSource(source);
  var syncSettings = () => engine.sync();
  var settingsMode = () => engine.mode();

export { SECRET_KEYS as SETTINGS_SECRET_KEYS, SETTINGS_SCHEMA, createSettingsSync, setSettingsSource, settingsMode, syncSettings, watchSetting };
