// glibren-a: o glibren (payload, tela no navegador pelo icone PMGL00001 da aba Midia) abre a Jobe para tocar YouTube.
// Contrato com o glibren (pasta TUBE_DIR = /data/JobeesLair/tube no PS5; nos testes, a pasta de dados equivalente):
//   - CAPACIDADE: a cada abertura a Jobe grava CAPABILITY_FILE ("jobe-tube.txt") com a linha "api=1" (.tmp + rename).
//     O glibren so abre a Jobe para YouTube se esse arquivo existir.
//   - PEDIDO: o glibren grava REQUEST_FILE ("abrir.txt", UTF-8, .tmp + rename): linha 1 = a busca (pode ser vazia, ate
//     MAX_QUERY_BYTES bytes); linhas seguintes opcionais "voltar=<TITLEID>" (ex. PMGL00001) e "auto=1". Ao abrir, ANTES
//     de restaurar a tela guardada (return-screen.js), a Jobe le o pedido (so se tiver menos de REQUEST_MAX_AGE_MS pela
//     data do arquivo), apaga-o, apaga a tela guardada e abre direto a tela de YouTube (tube/TubeScreen.jsx) na busca
//     (vazia: abre o teclado). Com auto=1 e busca: toca o primeiro video normal (tube-service.js pickFirstVideo).
//   - VOLTAR: com voltar=, o Circulo na raiz da tela de YouTube (ou ao fechar o video no modo auto) mostra "Voltando ao
//     glibren", pede ao payload de fundo POST /switch { to: <voltar>, from: <TITLE_ID da edicao> } e fecha o app
//     (exit-app.js leaveForSwitch). Se o /switch falhar, volta ao inicio da Jobe com um aviso curto.
// Funcoes simples sobre `fs` e com as dependencias passadas (tests/tube-request.test.mjs); tube-request-run.js liga ao
// FileSystem de verdade.

export const CAPABILITY_FILE = "jobe-tube.txt";
export const CAPABILITY_TEXT = "api=1\n";
export const REQUEST_FILE = "abrir.txt";
export const REQUEST_MAX_AGE_MS = 10 * 60 * 1e3;
// Um relogio que andou um pouco para tras entre gravar e ler ainda vale; mais que isso, nao.
export const CLOCK_SLACK_MS = 5 * 60 * 1e3;
export const MAX_QUERY_BYTES = 200;
// O pedido inteiro e pequeno; um arquivo grande demais nao e um pedido.
const MAX_FILE_BYTES = 4096;
const TITLE_ID_RE = /^[A-Z]{4}\d{5}$/;

const remove = (fs, path) => {
  try {
    if (fs.exists(path)) fs.remove(path);
  } catch {
  }
};

const utf8Bytes = (code) => code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;

/** `text` cortado em ate `max` bytes de UTF-8, sem partir um caractere. */
export function clipUtf8(text, max = MAX_QUERY_BYTES) {
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const size = utf8Bytes(char.codePointAt(0));
    if (bytes + size > max) break;
    bytes += size;
    out += char;
  }
  return out;
}

/**
 * O pedido em texto: { query, back, auto }. `query` limpo (espacos e controles viram um espaco) e cortado em
 * MAX_QUERY_BYTES; `back` o title ID de voltar= (vazio quando falta ou e invalido); `auto` so com busca.
 */
export function parseTubeRequest(text) {
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  const query = clipUtf8(String(lines[0] ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim()).trim();
  let back = "";
  let auto = false;
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === "voltar" && TITLE_ID_RE.test(value)) back = value;
    else if (key === "auto") auto = value === "1";
  }
  return { query, back, auto: auto && Boolean(query) };
}

/**
 * Le e apaga o pedido em `dir`: { query, back, auto } ou null (nada pedido, velho demais, data desconhecida, ou
 * grande demais). O arquivo (e um .tmp largado) e apagado em todos os casos. Nunca lanca.
 */
export function takeTubeRequest(fs, dir, { now = Date.now(), maxAge = REQUEST_MAX_AGE_MS, log = () => {} } = {}) {
  const path = `${dir}/${REQUEST_FILE}`;
  let text = null;
  let modified = NaN;
  try {
    if (!fs.exists(path)) return null;
    const info = fs.stat?.(path);
    modified = Number(info?.modified);
    if (Number(info?.size) > MAX_FILE_BYTES) log(`tube request too big (${info.size} bytes); ignored`);
    else text = String(fs.readFile(path));
  } catch (error) {
    log(`tube request not read: ${error?.message ?? error}`);
  }
  remove(fs, path);
  remove(fs, `${path}.tmp`);
  if (text == null) return null;
  const age = now - modified;
  if (!Number.isFinite(age) || age > maxAge || age < -CLOCK_SLACK_MS) {
    log(`tube request too old (${Number.isFinite(age) ? Math.round(age / 6e4) : "?"} min); ignored`);
    return null;
  }
  const request = parseTubeRequest(text);
  log(`tube request: "${request.query}"${request.back ? ` back to ${request.back}` : ""}${request.auto ? " (auto)" : ""}`);
  return request;
}

/** Grava a capacidade (CAPABILITY_FILE com "api=1") em `dir`. True quando gravou. Nunca lanca. */
export function writeTubeCapability(fs, dir, { log = () => {} } = {}) {
  const path = `${dir}/${CAPABILITY_FILE}`;
  try {
    try {
      fs.mkdir(dir, { recursive: true });
    } catch {
    }
    const temp = `${path}.tmp`;
    fs.writeFile(temp, CAPABILITY_TEXT, { sync: true });
    fs.rename(temp, path);
    return true;
  } catch (error) {
    log(`tube capability not written: ${error?.message ?? error}`);
    return false;
  }
}

/** A pilha da navegacao para um pedido: o inicio e a tela de YouTube (ensure: sobe o servico antes de buscar). */
export function tubeRequestStack(request, root) {
  return [root, { name: "tube", query: request.query, auto: request.auto, back: request.back, ensure: true }];
}

/**
 * Volta ao app que pediu (`to`): POST /switch { to, from } ao payload de fundo (`switchApp`) e, aceito, fecha o app
 * (`leave`, exit-app.js leaveForSwitch com `prepare`). { ok: true } ou { ok: false, error } (o app nao fecha entao).
 */
export async function returnToCaller(to, { from, switchApp, leave, prepare = null, log = () => {} }) {
  let answer;
  try {
    answer = await switchApp(to, from);
  } catch (error) {
    answer = { ok: false, error: error?.message ?? String(error) };
  }
  if (!answer?.ok) {
    log(`tube: back to ${to} refused: ${answer?.error ?? "no answer"}`);
    return { ok: false, error: answer?.error ?? "" };
  }
  log(`tube: back to ${to}; closing`);
  try {
    await leave({ prepare });
  } catch (error) {
    log(`tube: closing: ${error?.message ?? error}`);
  }
  return { ok: true };
}
