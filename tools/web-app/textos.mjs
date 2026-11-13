// Fase 8: os textos da Jobe web completa (/app) nos 14 idiomas da Jobe. Fonte: tools/web-app/textos.json, uma entrada
// por frase:
//   "chave": "app:settings.speedLimit"            -> a frase do app (app/i18n/locales/*.json), nos 14 idiomas;
//   "chave": {"en": "...", "pt-BR": "...", ...}   -> os idiomas dados; os que faltarem saem das frases ja traduzidas do
//                                                    app e da pagina do celular com o MESMO texto em ingles
//                                                    (fontes-textos.mjs). Faltou algum idioma = erro (nada inventado).
// Chaves com ponto viram objetos ("ordens.title" -> L.ordens.title). Gera o bloco entre /*TEXTOS-INICIO*/ e
// /*TEXTOS-FIM*/ de app/native/bg_app.html. Depois rode tools/bg-monitor/embed.mjs (o .h). tests/bg-app-page confere.
// Uso: node tools/web-app/textos.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDIOMAS, frasesDoApp, porIngles } from './fontes-textos.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FONTE = path.join(repo, 'tools/web-app/textos.json');
export const PAGINA = path.join(repo, 'app/native/bg_app.html');

/** {idioma: {chave aninhada: frase}} e a lista do que faltou. */
export function montar() {
  const entradas = JSON.parse(readFileSync(FONTE, 'utf8'));
  const app = frasesDoApp(), mapa = porIngles(), saida = {}, faltou = [];
  for (const idioma of IDIOMAS) saida[idioma] = {};
  const por = (obj, chave, valor) => { const partes = chave.split('.'); let o = obj; for (const p of partes.slice(0, -1)) o = (o[p] ||= {}); o[partes.at(-1)] = valor; };
  for (const [chave, v] of Object.entries(entradas)) {
    if (chave.startsWith('//')) continue;
    for (const idioma of IDIOMAS) {
      let frase;
      if (typeof v === 'string' && v.startsWith('app:')) frase = app[v.slice(4)] && app[v.slice(4)][idioma];
      else if (v && typeof v === 'object') frase = v[idioma] !== undefined ? v[idioma] : mapa[String(v.en).toLowerCase()] && mapa[String(v.en).toLowerCase()][idioma];
      if (typeof frase !== 'string') { faltou.push(`${chave} [${idioma}]`); continue; }
      por(saida[idioma], chave, frase);
    }
  }
  return { textos: saida, faltou };
}

/** A pagina com o bloco de textos refeito. */
export function pagina() {
  const { textos, faltou } = montar();
  if (faltou.length) throw new Error(`textos sem traducao: ${faltou.join(', ')}`);
  const html = readFileSync(PAGINA, 'utf8');
  const a = html.indexOf('/*TEXTOS-INICIO*/'), b = html.indexOf('/*TEXTOS-FIM*/');
  if (a < 0 || b < a) throw new Error('bg_app.html sem /*TEXTOS-INICIO*/ ... /*TEXTOS-FIM*/');
  const bloco = `/*TEXTOS-INICIO*/\n  // Gerado por tools/web-app/textos.mjs a partir de tools/web-app/textos.json. Nao editar a mao.\n  var TEXTOS = ${JSON.stringify(textos)};\n  `;
  return html.slice(0, a) + bloco + html.slice(b);
}

export const CELULAR = path.join(repo, 'app/native/bg_monitor.html');

/** A pagina do celular com o texto do link para a /app ("link.botao" e "link.texto") refeito nos 14 idiomas. */
export function paginaCelular() {
  const { textos } = montar();
  const link = {};
  for (const [idioma, t] of Object.entries(textos)) if (t.link) link[idioma] = { botao: t.link.botao, texto: t.link.texto };
  const html = readFileSync(CELULAR, 'utf8');
  const a = html.indexOf('/*APPLINK-INICIO*/'), b = html.indexOf('/*APPLINK-FIM*/');
  if (a < 0 || b < a) throw new Error('bg_monitor.html sem /*APPLINK-INICIO*/ ... /*APPLINK-FIM*/');
  return html.slice(0, a) + `/*APPLINK-INICIO*/\nvar APPLINK = ${JSON.stringify(link)};\n` + html.slice(b);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(PAGINA, pagina());
  console.log(`wrote ${path.relative(repo, PAGINA)}`);
  writeFileSync(CELULAR, paginaCelular());
  console.log(`wrote ${path.relative(repo, CELULAR)}`);
}
