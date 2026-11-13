// Fase 3: a copia do catalogo embutido que o app deixa para o payload (app/state/catalog-payload.js faz o mesmo no
// console com FileSystem.copyAsync): o mesmo desenho de app/data (catalog/index.json, catalog/art/, packs/, formats.js, ratings.js) em <dest>, e por ultimo
// version.json ({version, files:[{name, size}]}), que o payload confere antes de usar a copia.
// Uso: node tools/fase3/stage-bundled.mjs <pasta app/> <destino> [versao]   (ou import { stageBundled })
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function bundledFiles(appDir) {
  const data = path.join(appDir, 'data');
  const files = [['catalog/index.json', 'catalog/index.json'], ['formats.js', 'formats.js'], ['ratings.js', 'ratings.js']];
  for (const name of ['releases.pack', 'releases.idx', 'pages.pack', 'pages.idx']) files.push([`packs/${name}`, `packs/${name}`]);
  for (const name of readdirSync(path.join(data, 'catalog/art')).filter((file) => /^\d+\.json$/.test(file))) files.push([`catalog/art/${name}`, `catalog/art/${name}`]);
  return files.map(([to, from]) => ({ to, from: path.join(data, from) }));
}

export function stageBundled(appDir, dest, version = 'test', { only } = {}) {
  rmSync(path.join(dest, 'version.json'), { force: true });
  const out = [];
  for (const { to, from } of bundledFiles(appDir)) {
    if (only && !only(to)) continue;
    mkdirSync(path.dirname(path.join(dest, to)), { recursive: true });
    copyFileSync(from, path.join(dest, to));
    out.push({ name: to, size: statSync(from).size });
  }
  writeFileSync(path.join(dest, 'version.json'), JSON.stringify({ version, files: out }));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [appDir, dest, version] = process.argv.slice(2);
  if (!appDir || !dest) { console.error('uso: stage-bundled.mjs <app/> <destino> [versao]'); process.exit(2); }
  console.log(`${stageBundled(appDir, dest, version).length} arquivos`);
}
