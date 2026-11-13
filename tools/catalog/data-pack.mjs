#!/usr/bin/env node
// glibren.47 (Fase 1, imagem menor): junta os arquivos pequenos de cada jogo em dois arquivos-pacote, lidos por
// deslocamento no console (app/state/data-pack.js, FileSystem.readFile(path, offset, length)).
//
//   node tools/catalog/data-pack.mjs
//
// app/data/releases/<id>.json (os links de cada jogo, JLX1) e app/data/pages/<id>.json (a ficha da loja) continuam
// sendo a fonte no repositorio: as ferramentas, os testes e o merge do catalogo leem e gravam neles. O app nao
// empacota mais as pastas: eram 4.188 arquivos de ~3 KB que, no exFAT de clusters de 64 KiB que o ShadowMount+ pede,
// ocupavam ~275 MB para 11,5 MB de dados. Ele le em vez disso, em app/data/packs/:
//   <nome>.pack   o conteudo de cada arquivo, byte a byte e sem nada no meio, na ordem do indice;
//   <nome>.idx    texto: a linha "JPK1 <nome> <itens> <bytes>" e uma linha "<arquivo sem .json> <inicio> <tamanho>"
//                 por item, em ordem crescente de inicio, cada uma comecando onde a anterior acaba.
// Rode de novo sempre que app/data/releases ou app/data/pages mudarem (depois de um merge do catalogo, por exemplo);
// tests/data-pack.test.mjs confere que os pacotes estao em dia.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const MAGIC = 'JPK1';
// Os pacotes e a pasta de origem de cada um (relativa ao repositorio).
export const PACKS = { releases: 'app/data/releases', pages: 'app/data/pages' };
export const PACK_DIR = 'app/data/packs';
// O nome de um item: o do arquivo sem .json (o id do jogo passado por encodeURIComponent, como catalog.js pede).
const ITEM = /^[A-Za-z0-9%_.!~*'()-]+$/;

/** Os arquivos de uma pasta de origem -> { idx: texto, pack: Buffer, items }. */
export function buildPack(name, dir = path.join(repo, PACKS[name])) {
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort();
  const parts = [];
  const lines = [];
  let offset = 0;
  for (const file of files) {
    const item = file.slice(0, -5);
    if (!ITEM.test(item)) throw new Error(`${name}: nome que o indice nao guarda: ${file}`);
    const bytes = fs.readFileSync(path.join(dir, file));
    parts.push(bytes);
    lines.push(`${item} ${offset} ${bytes.length}`);
    offset += bytes.length;
  }
  const idx = `${MAGIC} ${name} ${files.length} ${offset}\n${lines.map((line) => `${line}\n`).join('')}`;
  return { idx, pack: Buffer.concat(parts), items: files.length };
}

/** Os arquivos de app/data/packs/ como devem estar: { 'releases.idx': texto, 'releases.pack': Buffer, ... }. */
export function packFiles() {
  const out = {};
  for (const name of Object.keys(PACKS)) {
    const { idx, pack } = buildPack(name);
    out[`${name}.idx`] = idx;
    out[`${name}.pack`] = pack;
  }
  return out;
}

/** Grava app/data/packs/ (so os arquivos dos pacotes; outro arquivo na pasta sobra e o teste acusa). */
export function writePacks(log = console.log) {
  const dir = path.join(repo, PACK_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, data] of Object.entries(packFiles())) {
    fs.writeFileSync(path.join(dir, file), data);
    log(`${PACK_DIR}/${file}: ${Buffer.byteLength(data)} bytes`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) writePacks();
