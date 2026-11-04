// Embute a pagina do celular (app/native/bg_monitor.html) no payload bg-downloader: gera app/native/bg_monitor_html.h,
// que bg_downloader.c serve na porta 34201. Rodar depois de mudar a pagina: node tools/bg-monitor/embed.mjs
// (tests/bg-monitor.test.mjs confere que o .h esta em dia).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PAGE = path.join(repo, 'app/native/bg_monitor.html');
export const HEADER = path.join(repo, 'app/native/bg_monitor_html.h');

/** O texto do .h para os bytes da pagina. */
export function header(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 24) lines.push(`  ${Array.from(bytes.subarray(i, i + 24), (b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')},`);
  return `// Gerado por tools/bg-monitor/embed.mjs a partir de app/native/bg_monitor.html. Nao editar a mao.
#pragma once
#define BG_MONITOR_HTML_SIZE ${bytes.length}u
static const unsigned char BG_MONITOR_HTML[${bytes.length}] = {
${lines.join('\n')}
};
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(HEADER, header(readFileSync(PAGE)));
  console.log(`wrote ${path.relative(repo, HEADER)}`);
}
