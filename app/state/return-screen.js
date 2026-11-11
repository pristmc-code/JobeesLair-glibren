// glibren.31: "reabrir na mesma tela". Antes de abrir o app de videos (game/VideosSheet.jsx; o PS5 so tem um app em
// primeiro plano, entao abrir o YouTube Max'd fecha a Jobee'sLair), a pilha de telas (state/nav.jsx) vai para
// RETURN_FILE em DATA_DIR. Quando o app abre de novo (o Max'd reabre o titulo pela linha voltar= de glibren_busca.txt,
// state/youtube.js) em ate MAX_AGE_MS, ele volta nessa tela, com a pilha para o (O) voltar como antes (ex. inicio ->
// pagina do jogo), e o arquivo e apagado. Um jogo que nao existe mais, um arquivo velho ou estragado: abre normal.
// A volta e so uma vez por gravacao: lido (e apagado) na primeira montagem da navegacao; o app remontado pela troca de
// tema nao volta de novo. A reabertura pela atualizacao (auto-update.js beforeExit -> update.js) e o botao Sair
// (exit-app.js) apagam o arquivo antes de fechar: essas aberturas sao por outro motivo e comecam no inicio.
// Funcoes simples sobre `fs` (tests/return-screen.test.mjs).

export const RETURN_FILE = "return-screen.json";
export const MAX_AGE_MS = 6 * 60 * 60 * 1e3;
// Um relogio que andou um pouco para tras entre gravar e ler ainda vale; mais que isso, nao.
export const CLOCK_SLACK_MS = 5 * 60 * 1e3;
export const MAX_SCREENS = 8;
// As telas que voltam, e os campos de cada uma que vao junto (todos texto). Settings, folhas e dialogos nao.
const SCREENS = new Set(["game", "downloads", "files", "storage", "homebrew", "homebrew-app", "search"]);
const FIELDS = ["id", "from", "side", "only"];
const MAX_TEXT = 300;
const NEEDS_ID = new Set(["game", "homebrew-app"]);

const plain = (screen) => {
  if (!screen || typeof screen !== "object" || typeof screen.name !== "string") return null;
  const out = { name: screen.name };
  for (const field of FIELDS) {
    const value = screen[field];
    if (typeof value === "string" && value && value.length <= MAX_TEXT) out[field] = value;
  }
  return out;
};

const remove = (fs, path) => {
  try {
    if (fs.exists(path)) fs.remove(path);
  } catch {
  }
};

/** Grava a pilha `stack` (a de nav.jsx) em `path`. True quando gravou. Nunca lanca. */
export function saveReturnScreen(fs, path, stack, { now = Date.now(), log = () => {} } = {}) {
  try {
    if (!Array.isArray(stack) || !stack.length) return false;
    const screens = stack.map(plain).filter(Boolean).slice(-MAX_SCREENS);
    if (!screens.length) return false;
    const temp = `${path}.tmp`;
    fs.writeFile(temp, JSON.stringify({ v: 1, at: now, stack: screens }), { sync: true });
    fs.rename(temp, path);
    log(`return screen saved: ${screens.map((screen) => screen.id ? `${screen.name}:${screen.id}` : screen.name).join(" > ")}`);
    return true;
  } catch (error) {
    log(`return screen not saved: ${error?.message ?? error}`);
    return false;
  }
}

/** Apaga a tela guardada (a abertura seguinte comeca no inicio). Nunca lanca. */
export function forgetReturnScreen(fs, path) {
  remove(fs, path);
  remove(fs, `${path}.tmp`);
}

/**
 * A pilha que a navegacao monta a partir do que foi guardado: `root` (a primeira tela desta edicao) e as telas
 * guardadas depois da primeira que ainda existem (`isGame(id)` para os jogos). Null quando a ultima (a tela onde o
 * jogador estava) nao existe mais, ou nao ha nada alem do inicio.
 */
export function restoredStack(saved, root, { isGame = () => true } = {}) {
  const list = Array.isArray(saved?.stack) ? saved.stack.slice(1) : [];
  const valid = (screen) => screen && SCREENS.has(screen.name) && (!NEEDS_ID.has(screen.name) || typeof screen.id === "string" && screen.id) && (screen.name !== "game" || Boolean(isGame(screen.id)));
  const screens = list.map(plain);
  const top = screens[screens.length - 1];
  if (!valid(top)) return null;
  const kept = screens.filter(valid);
  // O inicio fica com o foco de onde o jogador saiu dele (o card do jogo), como na pilha guardada.
  const first = plain(saved.stack[0]);
  const start = { ...root, ...(first?.name === root.name && first.from ? { from: first.from } : {}) };
  return [start, ...kept];
}

/**
 * Le e apaga a tela guardada em `path`: a pilha para abrir (restoredStack) ou null (nada guardado, velho demais,
 * estragado, ou a tela nao existe mais). O arquivo e apagado em todos os casos.
 */
export function takeReturnScreen(fs, path, root, { now = Date.now(), maxAge = MAX_AGE_MS, isGame, log = () => {} } = {}) {
  let text = null;
  try {
    if (!fs.exists(path)) return null;
    text = String(fs.readFile(path));
  } catch (error) {
    log(`return screen not read: ${error?.message ?? error}`);
  }
  forgetReturnScreen(fs, path);
  if (text == null) return null;
  let saved;
  try {
    saved = JSON.parse(text);
  } catch {
    log("return screen unreadable; opening at the start");
    return null;
  }
  const age = now - Number(saved?.at);
  if (!Number.isFinite(age) || age > maxAge || age < -CLOCK_SLACK_MS) {
    log(`return screen too old (${Number.isFinite(age) ? Math.round(age / 6e4) : "?"} min); opening at the start`);
    return null;
  }
  let stack = null;
  try {
    stack = restoredStack(saved, root, { isGame });
  } catch {
    stack = null;
  }
  log(stack ? `back to ${stack.map((screen) => screen.id ? `${screen.name}:${screen.id}` : screen.name).join(" > ")}` : "the saved screen is gone; opening at the start");
  return stack;
}
