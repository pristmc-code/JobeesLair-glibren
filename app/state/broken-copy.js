// glibren.13: copias quebradas num servico debrid. O TorBox pode guardar como "o arquivo" a pagina de erro que o site
// de origem devolveu (visto em 07/11/2026: .pkg de 170 bytes com "500 Internal Server Error"; muitos "[EU] [EN] [x].pkg"
// assim). Um arquivo de jogo (imagem ou compactado) com menos de 1 MiB, ou um pacote com menos de 64 KiB, nao e o jogo.
// Usado pela Biblioteca TorBox (torbox-library.js), pelo "Procurar no TorBox" (torbox-search.js) e pelo selo "TorBox
// Instant" (debrid.js). O payload tem a mesma regra (bg_downloader.c lib_file_broken).

import { formatFromName } from './link-formats.js';

  var BROKEN_BYTES = 1024 * 1024;
  // Os formatos de jogo (os de FORMAT_RANK em torbox-search.js).
  var GAME_FORMATS = ["exfat", "ffpkg", "ffpfsc", "ffpfs", "pkg", "fpkg", "rar", "7z", "zip", "tar"];
  var baseName = (name) => String(name || "").replace(/^.*[\\/]/, "");
  var formatOf = (file) => typeof file?.format === "string" ? file.format : formatFromName(baseName(file?.name)) || "";
  // Um pacote (.pkg/.fpkg) pode ser pequeno de verdade (um DLC so de desbloqueio tem dezenas a centenas de KB): para ele
  // o limite e 64 KiB (uma pagina de erro tem de 170 B a uns 10 KB; um PKG valido nunca e tao pequeno).
  var PACKAGE_BROKEN_BYTES = 64 * 1024;
  var limitOf = (format) => format === "pkg" || format === "fpkg" ? PACKAGE_BROKEN_BYTES : BROKEN_BYTES;
  /** Um arquivo de jogo menor que o limite do formato ({ size, format? | name, piece? }): uma copia quebrada. */
  var brokenFile = (file) => {
    const format = formatOf(file);
    return Number(file?.size) > 0 && Number(file.size) < limitOf(format) && !file.piece && GAME_FORMATS.includes(format);
  };
  /**
   * Uma entrada do TorBox (checkcached com list_files: { name, size, files: [{ name, size }] }) que so tem copias
   * quebradas: algum arquivo quebrado e nenhum que valha (de jogo, ou grande).
   */
  function brokenEntry(entry) {
    if (!entry || typeof entry !== "object") return false;
    const files = Array.isArray(entry.files) && entry.files.length ? entry.files.map((file) => ({ name: file.short_name || file.name, size: Number(file.size) || 0 })) : [{ name: entry.name, size: Number(entry.size) || 0 }];
    const broken = files.filter(brokenFile).length;
    const good = files.some((file) => !brokenFile(file) && (GAME_FORMATS.includes(formatOf(file)) || file.size >= BROKEN_BYTES));
    return broken > 0 && !good;
  }

export { BROKEN_BYTES, GAME_FORMATS, PACKAGE_BROKEN_BYTES, brokenEntry, brokenFile };
