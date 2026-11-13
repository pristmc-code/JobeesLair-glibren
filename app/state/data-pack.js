// glibren.47 (Fase 1, imagem menor): os links e as fichas dos jogos embutidos vem de dois arquivos-pacote
// (tools/catalog/data-pack.mjs) em vez de 4.188 arquivos pequenos. Um item e lido sozinho, por deslocamento
// (FileSystem.readFile(path, offset, length)): o pacote inteiro nunca fica na memoria, so o indice (um texto de ~50 KB
// por pacote, lido na primeira vez que um item e pedido e conferido inteiro uma vez).
//
//   createDataPack(name, { read, stat, dir, log })
//     .read(item)   o texto do item (o nome do arquivo sem .json), ou null se o pacote nao tem esse item.
//                   Lanca um erro se o indice esta corrompido (o mesmo erro em toda chamada, sem reler) ou se o
//                   trecho nao cabe no pacote.
//     .count()      quantos itens o indice lista (0 se ainda nao foi lido).
//
// O indice: a linha "JPK1 <nome> <itens> <bytes>" e "<item> <inicio> <tamanho>" por item, um depois do outro, sem
// buraco nem sobreposicao, somando <bytes>. Qualquer coisa fora disso (cabecalho, contagem, linha, ordem, total,
// tamanho do pacote no disco quando o stat sabe) recusa o pacote inteiro.
import { FileSystem } from '@ps5-react/core';

  var MAGIC = "JPK1";
  var LINE = /^([A-Za-z0-9%_.!~*'()-]+) (\d+) (\d+)$/;
  function checkIndex(text, name, packSize) {
    if (typeof text !== "string") throw new Error(`${name}.idx: not text`);
    const head = text.indexOf("\n");
    const header = head < 0 ? text : text.slice(0, head);
    const match = /^JPK1 ([a-z]+) (\d+) (\d+)$/.exec(header);
    if (!match || match[1] !== name) throw new Error(`${name}.idx: bad header`);
    const count = Number(match[2]);
    const bytes = Number(match[3]);
    if (!text.endsWith("\n")) throw new Error(`${name}.idx: cut short`);
    const lines = text.slice(head + 1, -1);
    const list = lines ? lines.split("\n") : [];
    if (list.length !== count) throw new Error(`${name}.idx: ${list.length} items, the header says ${count}`);
    let next = 0;
    for (const line of list) {
      const item = LINE.exec(line);
      if (!item || Number(item[2]) !== next) throw new Error(`${name}.idx: bad line "${line.slice(0, 40)}"`);
      next += Number(item[3]);
    }
    if (next !== bytes) throw new Error(`${name}.idx: items add up to ${next} bytes, the header says ${bytes}`);
    if (Number.isFinite(packSize) && packSize !== bytes) throw new Error(`${name}.pack: ${packSize} bytes, the index says ${bytes}`);
    // O corpo, com "\n" na frente: um item e achado por indexOf("\n<item> ") sem ler o texto linha a linha.
    return { body: `\n${lines}\n`, count };
  }
  function createDataPack(name, {
    read = (path, offset, length) => offset === void 0 ? FileSystem.readFile(path) : FileSystem.readFile(path, offset, length),
    stat = (path) => FileSystem.stat(path),
    dir = "/app0/data/packs",
    log = (line) => console.log(`[data-pack] ${line}`)
  } = {}) {
    let index = null;
    let problem = null;
    const load = () => {
      if (index) return index;
      if (problem) throw problem;
      try {
        let size;
        try {
          size = stat(`${dir}/${name}.pack`)?.size;
        } catch {
          size = void 0;
        }
        index = checkIndex(read(`${dir}/${name}.idx`), name, size == null ? void 0 : Number(size));
        return index;
      } catch (error) {
        problem = error instanceof Error ? error : new Error(String(error));
        log(`${name}: ${problem.message}`);
        throw problem;
      }
    };
    return {
      read(item) {
        const { body } = load();
        const key = `\n${item} `;
        const at = body.indexOf(key);
        if (at < 0) return null;
        const end = body.indexOf("\n", at + key.length);
        const [offset, length] = body.slice(at + key.length, end).split(" ").map(Number);
        return read(`${dir}/${name}.pack`, offset, length);
      },
      count: () => index?.count ?? 0
    };
  }

export { MAGIC, checkIndex, createDataPack };
