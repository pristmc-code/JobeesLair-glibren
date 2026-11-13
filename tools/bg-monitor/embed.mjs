// Embute a pagina do celular (app/native/bg_monitor.html) no payload bg-downloader: gera app/native/bg_monitor_html.h,
// que bg_downloader.c serve na porta 34201. Rodar depois de mudar a pagina: node tools/bg-monitor/embed.mjs
// (tests/bg-monitor.test.mjs confere que o .h esta em dia).
// glibren.47: tambem a pagina de testes da Fase 0 (app/native/bg_teste.html -> bg_teste_html.h, servida em /teste;
// tests/bg-teste-page.test.mjs confere).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PAGE = path.join(repo, 'app/native/bg_monitor.html');
export const HEADER = path.join(repo, 'app/native/bg_monitor_html.h');
export const TESTE_PAGE = path.join(repo, 'app/native/bg_teste.html');
export const TESTE_HEADER = path.join(repo, 'app/native/bg_teste_html.h');

/** O texto do .h para os bytes da pagina (`name`: o prefixo das constantes; `source`: o .html de origem). */
export function header(bytes, name = 'BG_MONITOR_HTML', source = 'bg_monitor.html') {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 24) lines.push(`  ${Array.from(bytes.subarray(i, i + 24), (b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')},`);
  return `// Gerado por tools/bg-monitor/embed.mjs a partir de app/native/${source}. Nao editar a mao.
#pragma once
#define ${name}_SIZE ${bytes.length}u
static const unsigned char ${name}[${bytes.length}] = {
${lines.join('\n')}
};
`;
}

/** O .h da pagina de testes (/teste). */
export const testeHeader = (bytes) => header(bytes, 'BG_TESTE_HTML', 'bg_teste.html');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(HEADER, header(readFileSync(PAGE)));
  console.log(`wrote ${path.relative(repo, HEADER)}`);
  writeFileSync(TESTE_HEADER, testeHeader(readFileSync(TESTE_PAGE)));
  console.log(`wrote ${path.relative(repo, TESTE_HEADER)}`);
}
