// glibren.27: um documento JSON grande lido por partes, sem montar a arvore inteira. O JSON.parse de um feed de 1,8 MB
// (o catalogo ao vivo, ps5/live.jlx) cria milhares de objetos de uma vez, e eles ficavam no heap de 32 MiB do app ao
// lado do texto e da copia validada (state/feed-format.js): no PS5 (glibren.26) o heap acabou e o erro saiu de uma
// regex qualquer ("out of memory in regexp execution"). Aqui so se acham os limites de cada valor (indexOf para as
// strings, charCodeAt para a pontuacao; nenhuma regex sobre o texto), e quem le faz JSON.parse de um valor por vez.
//
//   jsonMembers(text, from, to, stream)   os membros do objeto em text[from, to): { key, start, end } por membro; o
//                                         membro `stream` cujo valor e uma lista sai como { key, open: true } e depois
//                                         { key, item: true, start, end } por elemento. Texto que nao e JSON: SyntaxError.
//   skipSpace(text, at, to)                o primeiro indice sem espaco a partir de `at`.

const bad = () => new SyntaxError("Not JSON.");
const space = (code) => code === 32 || code === 10 || code === 13 || code === 9;

function skipSpace(text, at, to) {
  while (at < to && space(text.charCodeAt(at))) at++;
  return at;
}

// `at` e a aspa que abre; devolve o indice logo depois da que fecha (uma aspa precedida de um numero par de "\").
function stringEnd(text, at, to) {
  for (let from = at + 1; ;) {
    const quote = text.indexOf('"', from);
    if (quote < 0 || quote >= to) throw bad();
    let slashes = 0;
    while (text.charCodeAt(quote - 1 - slashes) === 92) slashes++;
    if (slashes % 2 === 0) return quote + 1;
    from = quote + 1;
  }
}

// O fim do valor que comeca em `at`. Objetos e listas so pela contagem de chaves e colchetes (as strings saltadas
// inteiras): o JSON.parse do pedaco confere o resto.
function valueEnd(text, at, to) {
  const first = text.charCodeAt(at);
  if (first === 34) return stringEnd(text, at, to);
  if (first === 123 || first === 91) {
    let depth = 0;
    for (let i = at; i < to; ) {
      const code = text.charCodeAt(i);
      if (code === 34) {
        i = stringEnd(text, i, to);
        continue;
      }
      if (code === 123 || code === 91) depth++;
      else if ((code === 125 || code === 93) && --depth === 0) return i + 1;
      i++;
    }
    throw bad();
  }
  let i = at;
  while (i < to) {
    const code = text.charCodeAt(i);
    if (code === 44 || code === 125 || code === 93 || space(code)) break;
    i++;
  }
  if (i === at) throw bad();
  return i;
}

function* jsonMembers(text, from = 0, to = text.length, stream = null) {
  let at = skipSpace(text, from, to);
  if (text.charCodeAt(at) !== 123) throw bad();
  at = skipSpace(text, at + 1, to);
  if (text.charCodeAt(at) === 125) {
    if (skipSpace(text, at + 1, to) !== to) throw bad();
    return;
  }
  for (;;) {
    if (text.charCodeAt(at) !== 34) throw bad();
    const keyEnd = stringEnd(text, at, to);
    const key = JSON.parse(text.slice(at, keyEnd));
    at = skipSpace(text, keyEnd, to);
    if (text.charCodeAt(at) !== 58) throw bad();
    at = skipSpace(text, at + 1, to);
    if (at >= to) throw bad();
    if (key === stream && text.charCodeAt(at) === 91) {
      yield { key, open: true };
      at = skipSpace(text, at + 1, to);
      if (text.charCodeAt(at) === 93) at++;
      else for (;;) {
        const end = valueEnd(text, at, to);
        yield { key, item: true, start: at, end };
        at = skipSpace(text, end, to);
        const code = text.charCodeAt(at);
        if (code === 93) {
          at++;
          break;
        }
        if (code !== 44) throw bad();
        at = skipSpace(text, at + 1, to);
      }
    } else {
      const end = valueEnd(text, at, to);
      yield { key, start: at, end };
      at = end;
    }
    at = skipSpace(text, at, to);
    const code = text.charCodeAt(at);
    if (code === 125) {
      if (skipSpace(text, at + 1, to) !== to) throw bad();
      return;
    }
    if (code !== 44) throw bad();
    at = skipSpace(text, at + 1, to);
  }
}

export { jsonMembers, skipSpace };
