// Pareamento por aparelho da pagina do celular (payload bg-downloader, app/native/bg_pair.c). O payload e a fonte da
// verdade: ele gera o codigo de 6 digitos, guarda os aparelhos (so o SHA-256 do token de cada um) e o PIN antigo
// ligado/desligado. A Jobe so mostra:
//   - o codigo na tela enquanto ele vale (ui/PairCodeNotice.jsx; a notificacao do sistema o payload ja manda), lido de
//     GET /pair a cada WATCH_MS com a Jobe aberta (so pergunta a um payload no ar; nunca o sobe para isso);
//   - a lista de aparelhos com "Remover" e o "Aceitar o PIN antigo" em Configuracoes > Downloads (ui/PairedDevicesRows.jsx).
// Este arquivo nao importa o runtime: a ligacao com o payload vem de background-downloads.js (setPairingSource).
import { useEffect, useState } from 'react';

var source = null;
/** background-downloads.js: { status(), remove(id), pin(on) }, cada um devolve { status, data }. */
function setPairingSource(next) {
  source = next ?? null;
}

var ID = /^[0-9a-f]{16}$/;
var CODE = /^\d{6}$/;
var MAX_NAME = 48;
var text = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : "";

/** O estado do payload validado ({ code, name, expiresIn, devices: [{ id, name, at }], pinOn, pinSet }) ou null. */
function cleanPairing(data) {
  if (!data || typeof data !== "object" || data.ok !== true || !Array.isArray(data.devices)) return null;
  const code = typeof data.code === "string" && CODE.test(data.code) ? data.code : "";
  const expiresIn = code && Number.isInteger(data.expiresIn) ? Math.max(0, Math.min(120, data.expiresIn)) : 0;
  const devices = data.devices.filter((item) => item && typeof item === "object" && ID.test(item.id)).slice(0, 16).map((item) => ({
    id: item.id,
    name: text(item.name, MAX_NAME) || "?",
    at: Number.isInteger(item.at) && item.at > 0 ? item.at : 0
  }));
  return { code: expiresIn > 0 ? code : "", name: expiresIn > 0 ? text(data.name, MAX_NAME) : "", expiresIn, devices, pinOn: data.pinOn !== false, pinSet: data.pinSet === true };
}

async function ask(name, ...args) {
  const link = source;
  if (!link) return null;
  try {
    const answer = await link[name](...args);
    return answer?.status === 200 ? answer.data : null;
  } catch {
    return null;
  }
}
/** O estado agora (null: payload fora do ar ou antigo, sem a rota). */
var pairingStatus = async () => cleanPairing(await ask("status"));
/** Remove um aparelho: o token dele deixa de valer na hora. true = removido. */
var removePairedDevice = async (id) => ID.test(String(id)) && (await ask("remove", id))?.ok === true;
/** Liga/desliga o PIN antigo (desligar derruba as sessoes abertas por ele). true = feito. */
var setLegacyPin = async (on) => (await ask("pin", on === true))?.ok === true;

// ---- O codigo na tela da Jobe ----
var WATCH_MS = 3e3;
var code = { code: "", name: "", until: 0 };
var listeners = /* @__PURE__ */ new Set();
function setCode(next) {
  if (next.code === code.code && next.name === code.name && Math.abs(next.until - code.until) < 2e3) return;
  code = next;
  for (const listener of [...listeners]) listener(code);
}
/** Uma volta: le GET /pair e atualiza o codigo mostrado. */
async function pairingTick(now = Date.now) {
  const state = await pairingStatus();
  if (!state || !state.code) setCode({ code: "", name: "", until: 0 });
  else setCode({ code: state.code, name: state.name, until: now() + state.expiresIn * 1e3 });
  return state;
}
var started = false;
/** Liga a leitura do codigo (so no PS5; index.jsx). Devolve quem a desliga. */
function startPairingWatch({ platform, every = WATCH_MS } = {}) {
  if (started || platform !== "ps5") return () => {};
  started = true;
  let timer = null;
  const loop = async () => {
    try {
      await pairingTick();
    } catch {
    }
    timer = setTimeout(loop, every);
  };
  timer = setTimeout(loop, every);
  return () => {
    clearTimeout(timer);
    started = false;
  };
}
/** { code, name, until } para o aviso; code "" sem codigo valendo. */
function usePairCode() {
  const [value, setValue] = useState(code);
  useEffect(() => {
    listeners.add(setValue);
    setValue(code);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}

export { cleanPairing, pairingStatus, pairingTick, removePairedDevice, setLegacyPin, setPairingSource, startPairingWatch, usePairCode };
