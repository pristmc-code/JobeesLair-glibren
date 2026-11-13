// Fase 8: as frases ja traduzidas que a /app reaproveita, por idioma: as do app (app/i18n/locales/*.json) e as tabelas
// de idiomas da pagina do celular (app/native/bg_monitor.html: pareamento, loja, diagnostico...). Cada fonte vira um
// mapa "frase em ingles" -> {idioma: frase}. Usado por tools/web-app/textos.mjs.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const IDIOMAS = ['pt-BR', 'en', 'es', 'fr', 'de', 'it', 'ru', 'ja', 'zh-Hans', 'ar', 'hi', 'bn', 'id', 'ur'];
const PAGINA = { 'pt-BR': ['pt', 'pt-BR'], 'zh-Hans': ['zh-Hans', 'zh'] }; // a pagina do celular usa "pt" e, as vezes, "zh"

const achatar = (o, p = '', out = {}) => { for (const k in o) (o[k] && typeof o[k] === 'object') ? achatar(o[k], p + k + '.', out) : (out[p + k] = o[k]); return out; };

/** As frases do app: {chave: {idioma: frase}} (chaves achatadas, ex.: "settings.speedLimit"). */
export function frasesDoApp() {
  const dir = path.join(repo, 'app/i18n/locales'), por = {};
  for (const arq of readdirSync(dir)) {
    const idioma = arq.replace(/\.json$/, '');
    for (const [k, v] of Object.entries(achatar(JSON.parse(readFileSync(path.join(dir, arq), 'utf8'))))) (por[k] ||= {})[idioma] = String(v);
  }
  return por;
}

// Le o objeto literal que comeca em `ini` (no "{"), contando chaves fora de strings.
function objeto(texto, ini) {
  let n = 0, aspas = '';
  for (let i = ini; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) { if (c === '\\') i++; else if (c === aspas) aspas = ''; continue; }
    if (c === '"' || c === "'" || c === '`') aspas = c;
    else if (c === '{') n++;
    else if (c === '}' && --n === 0) return Function(`return (${texto.slice(ini, i + 1)})`)();
  }
  return null;
}

/** As tabelas da pagina do celular, alinhadas: [{idioma: objeto}] na ordem em que aparecem. */
export function tabelasDaPagina() {
  const html = readFileSync(path.join(repo, 'app/native/bg_monitor.html'), 'utf8');
  const por = {};
  for (const idioma of IDIOMAS) {
    const nomes = (PAGINA[idioma] || [idioma]).map((nome) => `"${nome}"` + (/^[a-z]+$/.test(nome) ? `|${nome}` : '')).join('|');
    const rx = new RegExp(`(?:^|[\\s,{(])(?:${nomes}): \\{`, 'g');
    por[idioma] = [];
    for (let m; (m = rx.exec(html));) {
      const abre = m.index + m[0].length - 1, o = objeto(html, abre);
      const linha = html.lastIndexOf('\n', abre) + 1;
      if (o) por[idioma].push({ pos: abre, recuo: /^[ \t]*/.exec(html.slice(linha, abre))[0].length, o });
    }
  }
  // Cada tabela: o objeto "en" e, de cada idioma, o irmao mais perto com o mesmo recuo e quase as mesmas chaves.
  const tabelas = [];
  for (const en of por.en) {
    const chaves = Object.keys(achatar(en.o)), tab = { en: en.o };
    for (const idioma of IDIOMAS) {
      if (idioma === 'en') continue;
      let melhor = null;
      for (const c of por[idioma]) {
        if (Math.abs(c.pos - en.pos) > 60000 || Math.abs(c.recuo - en.recuo) > 2) continue;
        const ck = achatar(c.o), comuns = chaves.filter((k) => k in ck).length;
        if (comuns < chaves.length * 0.6) continue;
        if (!melhor || Math.abs(c.pos - en.pos) < Math.abs(melhor.pos - en.pos)) melhor = c;
      }
      if (melhor) tab[idioma] = melhor.o;
    }
    tabelas.push(tab);
  }
  return tabelas;
}

/** Frase em ingles (minusculas) -> {idioma: frase}, das duas fontes (o app primeiro). */
export function porIngles() {
  const mapa = {};
  const pegar = (en, traducoes) => { const k = String(en).toLowerCase(); if (!mapa[k] && Object.keys(traducoes).length === IDIOMAS.length) mapa[k] = traducoes; };
  for (const tr of Object.values(frasesDoApp())) if (tr.en) pegar(tr.en, tr);
  for (const tab of tabelasDaPagina()) {
    if (!tab.en) continue;
    for (const [k, v] of Object.entries(achatar(tab.en))) {
      const tr = {};
      for (const idioma of IDIOMAS) { const o = tab[idioma] && achatar(tab[idioma])[k]; if (typeof o === 'string') tr[idioma] = o; }
      if (typeof v === 'string') pegar(v, tr);
    }
  }
  return mapa;
}
