// glibren.12: leitor de .pkg (FPKG de PS5, "debug"/"fake") que entrega os arquivos do jogo em fluxo para o
// exfat_writer. Ver pkg_source.h e scratchpad/conv_contrato.md. Entra no bg_downloader.c por "unity build": tudo
// aqui e static ou tem prefixo pkgsrc_/PKGSRC_.
//
// Formato portado (logica, nao copia literal) do leitor aberto do ps5-dump-forge (crate ps5-dump-forge-fpkg:
// lib.rs, pfs.rs, mount.rs, tree.rs) e do motor do ps5upload que ele embute (vendor/ps5upload-fpkg: fih.rs, cnt.rs,
// outer.rs, crypto.rs, xts.rs, kraken.rs, kraken/huff.rs, kraken_image.rs), ambos GPL-3:
//   https://github.com/quer3q/ps5-dump-forge   https://github.com/phantomptr/ps5upload
// O formato Kraken em si foi documentado pelo powzix/ooz (GPL-3).
//
// Camadas de um FPKG de PS5 (tudo little-endian, salvo o container CNT, big-endian):
//   1. Cabecalho "\x7FFIH" (0x100 bytes): [5] byte de assinatura (0x00 = debug, 0x80 = varejo), [6] versao,
//      0x10 inicio do PFS de fora, 0x18 tamanho, 0x20 superbloco (absoluto), 0x30 SHA3 do superbloco,
//      0x50 base dos metadados do PFS de dentro (em blocos de 64 KiB), 0x58 container CNT, 0x60 tamanho do bloco.
//   2. Container "\x7FCNT": content id em 0x40, tipo em 0x74 (0x20/0x26 aplicativo, 0x21 DLC), tabela de entradas
//      (id, flags1 com bit 31 = cifrada, offset, tamanho). A entrada 0x040A (imagedigs) tem o SHA3-256 (bytes
//      invertidos) de cada bloco de 64 KiB do PFS de fora: todo bloco lido aqui e conferido.
//   3. PFS de fora (versao 2, magic 20130315). O "seed" do superbloco (0x370) diz o modo:
//      - "PPRPLAIN-NOAUTH!" = texto claro (o que o ps5upload/ps5-dump-forge gravam por padrao);
//      - qualquer outro = AES-128-XTS com chaves derivadas do content id e da senha de debug padrao (32 zeros)
//        por SHA3 + HMAC-SHA256 (chave aberta, a mesma das ferramentas abertas; nada de chave de varejo).
//      Dentro dele: uroot/pfs_image.dat (a imagem de dentro, comprimida) e uroot/naps_pkg_layout.dat (o mapa).
//   4. Imagem de dentro: o "mount" (o jogo como fica instalado) e cortado em blocos de ate 256 KiB, cada um
//      guardado em Kraken (Oodle) em duas metades de 128 KiB (crua, array de entropia ou LZ), ou esparso (zeros).
//      O naps_pkg_layout.dat diz onde fica cada bloco. Depois dos dados vem um PFS normal (superbloco na base dos
//      metadados, tabela de inodes no bloco seguinte, 390 inodes de 0xA8 por bloco, raiz do jogo = inode 4).
//   5. Arquivos so do container (icon0.png, pic*.png, param.json ...) entram em sce_sys/ quando a imagem nao tem.
// O bloco PFSC/zlib dos .ffpfsc NAO aparece em FPKG de PS5: a compressao e Kraken.
//
// Recusados com mensagem: pacote de PS4 ("\x7FCNT"), varejo (byte de assinatura != 0), imagem nativa que nao abre
// com a senha de debug, layout "plano" (diagnostico do ps5upload), compressao que nao e Kraken, e qualquer bloco que
// nao bata com o imagedigs (corrompido/truncado). Atualizacao "\x7FLIH" abre (para dar o tipo e os ids), mas
// pkgsrc_entries recusa: ela so tem os blocos que mudaram.
//
// Memoria: nada proporcional ao jogo alem do mapa de blocos (4 bytes por 64 KiB de imagem) e da lista de blocos
// Kraken (32 bytes por bloco de 256 KiB: ~13 MB para 100 GB). Buffers fixos: ~4 MB.
#include "pkg_source.h"

#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <openssl/evp.h>
#include <openssl/hmac.h>

#define PKGSRC_BLK 0x10000u          // bloco do PFS (64 KiB)
#define PKGSRC_UBLK 0x40000u         // bloco Kraken (256 KiB) e janela do mapa
#define PKGSRC_HALF 0x20000u         // metade de um bloco Kraken
#define PKGSRC_RUN 16u               // blocos de fora lidos de uma vez (1 MiB)
#define PKGSRC_DEC_SLOTS 4           // blocos Kraken decodificados guardados
#define PKGSRC_MAX_CNT 4096u         // entradas do container
#define PKGSRC_MAX_LAYOUT (96u << 20) // maior naps_pkg_layout.dat aceito
#define PKGSRC_MAX_KBLOCKS (4u << 20) // ~1 TB de mount
#define PKGSRC_MAX_INODES 4000000u
#define PKGSRC_MAX_ENTRIES 1000000u
#define PKGSRC_MAX_DIR (32u << 20)   // um diretorio lido inteiro
#define PKGSRC_INODE_LEN 0xA8u
#define PKGSRC_INODES_PER_BLK 390u
#define PKGSRC_DINODE_LEN 0x2C8u
#define PKGSRC_SB_MAGIC 20130315ull
#define PKGSRC_SIGNED_SECTOR (1ull << 47)
#define PKGSRC_PASSCODE "00000000000000000000000000000000"

enum { PKGSRC_OK = 0, PKGSRC_ERR = -1 };

typedef struct pkgsrc_kblk {
  uint64_t logical, stored_at;
  uint32_t len, stored_len, even_len;
  uint8_t even_lz, odd_lz, mode_bits, shuffle;
} pkgsrc_kblk;

typedef struct pkgsrc_place {
  int container;  // 1 = bytes direto no pacote (entrada do container); 0 = no mount
  uint64_t at;    // offset absoluto no pacote ou no mount
} pkgsrc_place;

typedef struct pkgsrc_cent {
  uint32_t id, flags1;
  uint64_t at, size;  // absoluto no pacote
} pkgsrc_cent;

typedef struct pkgsrc_run {
  uint64_t first;                 // primeiro bloco de fora
  uint32_t n;                     // quantos estao em raw
  uint8_t* raw;                   // PKGSRC_RUN * 64 KiB
  uint8_t state[PKGSRC_RUN];      // 0 = como esta no disco, 1 = conferido (e decifrado)
  uint8_t want[PKGSRC_RUN][32];   // SHA3 esperado
  uint64_t used;
} pkgsrc_run;

struct pkgsrc {
  int fd;
  uint64_t len;
  int kind, lih, native;
  uint32_t content_type;
  char title_id[16];
  char content_id[48];
  char lasterr[256];
  // cabecalho / PFS de fora
  uint64_t pfs_offset, outer_blocks, sb_index, meta_base, digests_at;
  EVP_CIPHER_CTX* xts;
  pkgsrc_run runs[2];
  uint64_t tick;
  uint8_t* tmp;  // 64 KiB para decifrar
  pkgsrc_cent* ce;
  uint32_t nce;
  // pfs_image.dat
  uint32_t* imap;
  uint64_t image_size;
  // mount Kraken
  pkgsrc_kblk* kb;
  size_t nkb;
  uint64_t mount_size;
  uint8_t* dec[PKGSRC_DEC_SLOTS];
  size_t dec_idx[PKGSRC_DEC_SLOTS];
  int dec_ok[PKGSRC_DEC_SLOTS];
  int dec_next;
  uint8_t* stored;  // 2 janelas (bytes guardados de um bloco)
  uint8_t *s_lits, *s_cmds, *s_offc, *s_lens, *s_unit;
  uint32_t *s_offs, *s_esc;
  // arvore
  exw_entry* ents;
  pkgsrc_place* places;
  size_t nents, capents;
};

// ------------------------------------------------------------------ utilitarios

static void pkgsrc_fail(char* err, size_t cap, const char* fmt, ...) {
  if(!err || !cap) return;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(err, cap, fmt, ap);
  va_end(ap);
}

// Mensagem guardada no pkgsrc (para erros dentro da leitura, que nao tem err no contrato).
static int pkgsrc_perr(pkgsrc* p, const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(p->lasterr, sizeof p->lasterr, fmt, ap);
  va_end(ap);
  return PKGSRC_ERR;
}

static uint32_t pkgsrc_be32(const uint8_t* b) {
  return ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) | ((uint32_t)b[2] << 8) | b[3];
}
static uint16_t pkgsrc_le16(const uint8_t* b) { return (uint16_t)(b[0] | (b[1] << 8)); }
static uint32_t pkgsrc_le32(const uint8_t* b) {
  return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
}
static uint64_t pkgsrc_le64(const uint8_t* b) { return (uint64_t)pkgsrc_le32(b) | ((uint64_t)pkgsrc_le32(b + 4) << 32); }
static uint64_t pkgsrc_be64(const uint8_t* b) { return ((uint64_t)pkgsrc_be32(b) << 32) | pkgsrc_be32(b + 4); }

static uint32_t pkgsrc_clz32(uint32_t v) { return v ? (uint32_t)__builtin_clz(v) : 32u; }

// Le exatamente n bytes em off. Fora do arquivo = erro (pacote truncado).
static int pkgsrc_pread(pkgsrc* p, uint64_t off, void* buf, size_t n) {
  if(off > p->len || n > p->len - off)
    return pkgsrc_perr(p, "pacote truncado: leitura de %zu bytes em 0x%llx passa do fim (0x%llx)", n,
                       (unsigned long long)off, (unsigned long long)p->len);
  uint8_t* d = buf;
  while(n) {
    ssize_t r = pread(p->fd, d, n, (off_t)off);
    if(r < 0 && errno == EINTR) continue;
    if(r <= 0) return pkgsrc_perr(p, "erro lendo o pacote em 0x%llx: %s", (unsigned long long)off, r < 0 ? strerror(errno) : "fim inesperado");
    d += r;
    off += (uint64_t)r;
    n -= (size_t)r;
  }
  return PKGSRC_OK;
}

static void pkgsrc_sha3(const void* d, size_t n, uint8_t out[32]) {
  unsigned int len = 32;
  if(!EVP_Digest(d, n, out, &len, EVP_sha3_256(), NULL)) memset(out, 0, 32);
}

static void pkgsrc_hmac(const uint8_t* key, size_t klen, const uint8_t* d, size_t n, uint8_t out[32]) {
  unsigned int len = 32;
  if(!HMAC(EVP_sha256(), key, (int)klen, d, n, out, &len)) memset(out, 0, 32);
}

// SHA3(SHA3(index BE32) || SHA3(content id com 48 bytes) || senha): chave de pacote de debug (crypto.rs).
static void pkgsrc_pfs_key(const char* cid, uint32_t index, uint8_t out[32]) {
  uint8_t buf[96 + 32], idx[4] = {(uint8_t)(index >> 24), (uint8_t)(index >> 16), (uint8_t)(index >> 8), (uint8_t)index};
  uint8_t c48[48] = {0};
  size_t n = strlen(cid);
  memcpy(c48, cid, n < 48 ? n : 48);
  pkgsrc_sha3(idx, 4, buf);
  pkgsrc_sha3(c48, 48, buf + 32);
  memcpy(buf + 64, PKGSRC_PASSCODE, 32);
  pkgsrc_sha3(buf, 96, out);
}

// Chaves XTS (dados, ajuste) a partir do EKPFS e do seed do superbloco (crypto.rs derive_xts_keys).
static void pkgsrc_xts_keys(const uint8_t ekpfs[32], const uint8_t seed[16], uint8_t data[16], uint8_t tweak[16]) {
  uint8_t k[32], enc[32], msg[20] = {1, 0, 0, 0};
  pkgsrc_hmac(ekpfs, 32, seed, 16, k);
  memcpy(msg + 4, seed, 16);
  pkgsrc_hmac(k, 32, msg, 20, enc);
  memcpy(tweak, enc, 16);
  memcpy(data, enc + 16, 16);
}

// Decifra uma unidade XTS de 64 KiB (setor = ajuste). 0 = ok.
static int pkgsrc_xts_decrypt(pkgsrc* p, uint64_t sector, const uint8_t* in, uint8_t* out) {
  uint8_t iv[16] = {0};
  for(int i = 0; i < 8; i++) iv[i] = (uint8_t)(sector >> (8 * i));
  int n = 0;
  if(!EVP_DecryptInit_ex(p->xts, NULL, NULL, NULL, iv)) return PKGSRC_ERR;
  if(!EVP_DecryptUpdate(p->xts, out, &n, in, (int)PKGSRC_BLK) || n != (int)PKGSRC_BLK) return PKGSRC_ERR;
  return PKGSRC_OK;
}

// ------------------------------------------------------------------ PFS de fora: blocos conferidos

// Bloco de fora `index` em texto claro e conferido contra o imagedigs; NULL em erro (p->lasterr). Os blocos sao
// lidos 16 de cada vez (1 MiB) em dois "runs", para a leitura em sequencia e para a arvore, que pula entre a tabela
// de inodes e os diretorios.
static const uint8_t* pkgsrc_outer(pkgsrc* p, uint64_t index) {
  if(index >= p->outer_blocks) {
    pkgsrc_perr(p, "pacote corrompido: bloco de fora %llu passa dos %llu da imagem", (unsigned long long)index,
                (unsigned long long)p->outer_blocks);
    return NULL;
  }
  pkgsrc_run* r = NULL;
  for(int i = 0; i < 2; i++)
    if(p->runs[i].n && index >= p->runs[i].first && index < p->runs[i].first + p->runs[i].n) r = &p->runs[i];
  if(!r) {
    r = p->runs[0].used <= p->runs[1].used ? &p->runs[0] : &p->runs[1];
    uint64_t n = p->outer_blocks - index;
    if(n > PKGSRC_RUN) n = PKGSRC_RUN;
    r->n = 0;
    uint8_t dig[PKGSRC_RUN * 32];
    if(pkgsrc_pread(p, p->pfs_offset + index * PKGSRC_BLK, r->raw, (size_t)n * PKGSRC_BLK) ||
       pkgsrc_pread(p, p->digests_at + index * 32, dig, (size_t)n * 32))
      return NULL;
    for(uint64_t k = 0; k < n; k++) {
      for(int j = 0; j < 32; j++) r->want[k][j] = dig[k * 32 + 31 - j];  // guardado de tras para frente
      r->state[k] = 0;
    }
    r->first = index;
    r->n = (uint32_t)n;
  }
  r->used = ++p->tick;
  size_t k = (size_t)(index - r->first);
  uint8_t* blk = r->raw + k * PKGSRC_BLK;
  if(r->state[k]) return blk;
  uint8_t got[32];
  if(!p->native || index == p->sb_index) {
    pkgsrc_sha3(blk, PKGSRC_BLK, got);
    if(memcmp(got, r->want[k], 32) == 0) {
      r->state[k] = 1;
      return blk;
    }
  } else {
    // Bloco de metadados usa o setor com o bit 47; o construtor aberto usa o indice puro antes do superbloco e o
    // bit depois dele, mas os pacotes da Sony assinam alguns antes tambem: tenta os dois (pfs.rs plaintext()).
    uint64_t s1 = index < p->sb_index ? index : (PKGSRC_SIGNED_SECTOR | index);
    uint64_t s2 = index < p->sb_index ? (PKGSRC_SIGNED_SECTOR | index) : index;
    for(int t = 0; t < 2; t++) {
      if(pkgsrc_xts_decrypt(p, t ? s2 : s1, blk, p->tmp)) break;
      pkgsrc_sha3(p->tmp, PKGSRC_BLK, got);
      if(memcmp(got, r->want[k], 32) == 0) {
        memcpy(blk, p->tmp, PKGSRC_BLK);
        r->state[k] = 1;
        return blk;
      }
    }
  }
  pkgsrc_perr(p, "pacote corrompido: o bloco de fora %llu nao confere com o imagedigs", (unsigned long long)index);
  return NULL;
}

// Le n bytes em off de pfs_image.dat (pelo mapa de blocos).
static int pkgsrc_image_read(pkgsrc* p, uint64_t off, uint8_t* buf, size_t n) {
  if(off > p->image_size || n > p->image_size - off)
    return pkgsrc_perr(p, "pacote corrompido: leitura fora de pfs_image.dat");
  while(n) {
    const uint8_t* b = pkgsrc_outer(p, p->imap[off / PKGSRC_BLK]);
    if(!b) return PKGSRC_ERR;
    size_t within = (size_t)(off % PKGSRC_BLK), k = PKGSRC_BLK - within;
    if(k > n) k = n;
    memcpy(buf, b + within, k);
    buf += k;
    off += k;
    n -= k;
  }
  return PKGSRC_OK;
}

// Uma entrada do container pelo id (NULL se nao tem).
static const pkgsrc_cent* pkgsrc_centry(const pkgsrc* p, uint32_t id) {
  for(uint32_t i = 0; i < p->nce; i++)
    if(p->ce[i].id == id) return &p->ce[i];
  return NULL;
}

// Cabecalho e tabela do container em cnt_off; cnt_rel = base dos offsets das entradas.
static int pkgsrc_container(pkgsrc* p, uint64_t cnt_off, char* err, size_t errcap) {
  uint8_t head[0x80];
  if(pkgsrc_pread(p, cnt_off, head, sizeof head)) {
    pkgsrc_fail(err, errcap, "%s", p->lasterr);
    return PKGSRC_ERR;
  }
  if(pkgsrc_be32(head) != 0x7F434E54u) {
    pkgsrc_fail(err, errcap, "pacote corrompido: sem container CNT em 0x%llx", (unsigned long long)cnt_off);
    return PKGSRC_ERR;
  }
  uint32_t count = pkgsrc_be32(head + 0x10), table = pkgsrc_be32(head + 0x18);
  if(count > PKGSRC_MAX_CNT) {
    pkgsrc_fail(err, errcap, "pacote corrompido: container com %u entradas", count);
    return PKGSRC_ERR;
  }
  p->content_type = pkgsrc_be32(head + 0x74);
  // content id: ate 36 caracteres [A-Za-z0-9_-]
  size_t n = 0;
  while(n < 36 && head[0x40 + n]) {
    uint8_t c = head[0x40 + n];
    if(!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '-' || c == '_')) break;
    n++;
  }
  memcpy(p->content_id, head + 0x40, n);
  p->content_id[n] = 0;
  p->ce = calloc(count ? count : 1, sizeof *p->ce);
  uint8_t* rows = malloc((size_t)(count ? count : 1) * 32);
  if(!p->ce || !rows) {
    free(rows);
    pkgsrc_fail(err, errcap, "sem memoria");
    return PKGSRC_ERR;
  }
  if(count && pkgsrc_pread(p, cnt_off + table, rows, (size_t)count * 32)) {
    free(rows);
    pkgsrc_fail(err, errcap, "%s", p->lasterr);
    return PKGSRC_ERR;
  }
  for(uint32_t i = 0; i < count; i++) {
    const uint8_t* r = rows + (size_t)i * 32;
    pkgsrc_cent* e = &p->ce[i];
    e->id = pkgsrc_be32(r);
    e->flags1 = pkgsrc_be32(r + 8);
    e->at = cnt_off + pkgsrc_be32(r + 16);
    e->size = pkgsrc_be32(r + 20);
    if(e->at > p->len || e->size > p->len - e->at) {
      free(rows);
      pkgsrc_fail(err, errcap, "pacote truncado: a entrada 0x%04x do container passa do fim", e->id);
      return PKGSRC_ERR;
    }
  }
  p->nce = count;
  free(rows);
  return PKGSRC_OK;
}

// ------------------------------------------------------------------ Kraken (kraken.rs / huff.rs)

// Leitor de bits MSB-primeiro com janela de 24 bits, para frente ou para tras (o BitReader do ooz).
typedef struct pkgsrc_br {
  const uint8_t* src;
  long pos, end;
  int back;
  uint32_t bits;
  int bitpos;
} pkgsrc_br;

static void pkgsrc_br_refill(pkgsrc_br* r) {
  while(r->bitpos > 0) {
    uint8_t b;
    if(r->back) {
      r->pos--;
      b = r->pos >= r->end ? r->src[r->pos] : 0;
    } else {
      b = r->pos < r->end ? r->src[r->pos] : 0;
      r->pos++;
    }
    r->bits |= (uint32_t)b << r->bitpos;
    r->bitpos -= 8;
  }
}

static void pkgsrc_br_init(pkgsrc_br* r, const uint8_t* src, size_t start, size_t end, int back) {
  r->src = src;
  r->pos = back ? (long)end : (long)start;
  r->end = back ? (long)start : (long)end;
  r->back = back;
  r->bits = 0;
  r->bitpos = 24;
  pkgsrc_br_refill(r);
}

static uint32_t pkgsrc_br_get(pkgsrc_br* r, uint32_t n) {
  uint32_t v = 0;
  while(n) {
    uint32_t take = n < 24 ? n : 24;
    uint32_t x = r->bits >> (32 - take);
    r->bits = take == 32 ? 0 : r->bits << take;
    r->bitpos += (int)take;
    pkgsrc_br_refill(r);
    v = (take == 32 ? 0 : v << take) | x;
    n -= take;
  }
  return v;
}

static int pkgsrc_br_length(pkgsrc_br* r, uint32_t* out) {
  uint32_t z = pkgsrc_clz32(r->bits);
  if(z > 12) return PKGSRC_ERR;
  pkgsrc_br_get(r, z);
  *out = pkgsrc_br_get(r, z + 7) - 64;
  return PKGSRC_OK;
}

static long pkgsrc_br_seam(const pkgsrc_br* r) {
  long pending = (24 - r->bitpos) >> 3;
  return r->back ? r->pos + pending : r->pos - pending;
}

// Leitor LSB-primeiro dos fluxos de Huffman.
typedef struct pkgsrc_lr {
  const uint8_t* src;
  size_t next, left, used;
  int back;
  uint64_t acc;
  uint32_t n;
} pkgsrc_lr;

static void pkgsrc_lr_init(pkgsrc_lr* r, const uint8_t* src, size_t start, size_t end, int back) {
  r->src = src;
  r->next = back ? end : start;
  r->left = end - start;
  r->back = back;
  r->acc = 0;
  r->n = 0;
  r->used = 0;
}

static unsigned pkgsrc_lr_peek(pkgsrc_lr* r) {
  if(r->n < 11 && r->left >= 8) {
    uint64_t w = r->back ? pkgsrc_be64(r->src + r->next - 8) : pkgsrc_le64(r->src + r->next);
    uint32_t k = (63 - r->n) / 8;
    r->acc |= (w & ((1ull << (k * 8)) - 1)) << r->n;
    r->n += k * 8;
    r->left -= k;
    if(r->back) r->next -= k;
    else r->next += k;
  }
  while(r->n < 11) {
    uint8_t b = 0;
    if(r->left) {
      r->left--;
      if(r->back) b = r->src[--r->next];
      else b = r->src[r->next++];
    }
    r->acc |= (uint64_t)b << r->n;
    r->n += 8;
  }
  return (unsigned)(r->acc & 2047u);
}

static void pkgsrc_lr_skip(pkgsrc_lr* r, uint32_t bits) {
  r->acc >>= bits;
  r->n -= bits;
  r->used += bits;
}

static uint32_t pkgsrc_rev11(uint32_t k) {
  uint32_t v = 0;
  for(int i = 0; i < 11; i++) v |= ((k >> i) & 1u) << (10 - i);
  return v;
}

static int pkgsrc_gamma(pkgsrc_br* r, uint32_t* out) {
  uint32_t lz = pkgsrc_clz32(r->bits);
  if(lz > 7) return PKGSRC_ERR;
  *out = pkgsrc_br_get(r, 2 * (lz + 1)) - 1;
  return PKGSRC_OK;
}

// Corpo de um array Huffman (tipo 2) em n bytes de out. 0 = ok.
static int pkgsrc_huff(const uint8_t* src, size_t slen, uint8_t* out, size_t n) {
  pkgsrc_br r;
  pkgsrc_br_init(&r, src, 0, slen, 0);
  if(pkgsrc_br_get(&r, 1) != 0) return PKGSRC_ERR;  // so a forma "antiga"
  uint8_t syms[12][256];
  uint32_t nsyms[12] = {0};
  if(pkgsrc_br_get(&r, 1) == 1) {
    uint32_t fb = pkgsrc_br_get(&r, 2), limit = 20u >> fb;
    int skip = pkgsrc_br_get(&r, 1) == 1;
    uint32_t sym = 0, count = 0;
    int32_t avg = 32;
    while(sym != 256) {
      uint32_t g;
      if(skip) skip = 0;
      else {
        if(pkgsrc_gamma(&r, &g)) return PKGSRC_ERR;
        sym += g;
        if(sym >= 256) break;
      }
      uint32_t run;
      if(pkgsrc_gamma(&r, &run)) return PKGSRC_ERR;
      if(sym + run > 256) return PKGSRC_ERR;
      count += run;
      for(uint32_t i = 0; i < run; i++) {
        uint32_t lz = pkgsrc_clz32(r.bits);
        if(lz > limit) return PKGSRC_ERR;
        pkgsrc_br_get(&r, lz + 1);
        int32_t v = (int32_t)((lz << fb) | pkgsrc_br_get(&r, fb));
        int32_t l = (-(v & 1) ^ (v >> 1)) + ((avg + 2) >> 2);
        if(l < 1 || l > 11) return PKGSRC_ERR;
        avg = l + ((3 * avg + 2) >> 2);
        syms[l][nsyms[l]++] = (uint8_t)sym;
        sym++;
      }
    }
    if(sym != 256 || count < 2) return PKGSRC_ERR;
  } else {
    uint32_t count = pkgsrc_br_get(&r, 8);
    if(count == 0) return PKGSRC_ERR;
    if(count == 1) {
      uint8_t s = (uint8_t)pkgsrc_br_get(&r, 8);
      if(pkgsrc_br_seam(&r) != (long)slen) return PKGSRC_ERR;
      memset(out, s, n);
      return PKGSRC_OK;
    }
    uint32_t cb = pkgsrc_br_get(&r, 3);
    if(cb > 4) return PKGSRC_ERR;
    for(uint32_t i = 0; i < count; i++) {
      uint8_t s = (uint8_t)pkgsrc_br_get(&r, 8);
      uint32_t l = pkgsrc_br_get(&r, cb) + 1;
      if(l > 11) return PKGSRC_ERR;
      syms[l][nsyms[l]++] = s;
    }
  }
  uint8_t lsym[2048], llen[2048];
  uint32_t slot = 0;
  for(uint32_t l = 1; l <= 11; l++) {
    uint32_t step = 1u << (11 - l);
    for(uint32_t i = 0; i < nsyms[l]; i++) {
      if(slot + step > 2048) return PKGSRC_ERR;
      for(uint32_t k = slot; k < slot + step; k++) {
        uint32_t at = pkgsrc_rev11(k);
        lsym[at] = syms[l][i];
        llen[at] = (uint8_t)l;
      }
      slot += step;
    }
  }
  if(slot != 2048) return PKGSRC_ERR;
  long st = pkgsrc_br_seam(&r);
  if(st < 0 || (size_t)st + 3 > slen) return PKGSRC_ERR;
  size_t start = (size_t)st, split = pkgsrc_le16(src + start), a0 = start + 2;
  if(a0 + split > slen) return PKGSRC_ERR;
  pkgsrc_lr s[3];
  pkgsrc_lr_init(&s[0], src, a0, a0 + split, 0);
  pkgsrc_lr_init(&s[1], src, a0 + split, slen, 1);
  pkgsrc_lr_init(&s[2], src, a0 + split, slen, 0);
  size_t i = 0;
  while(i < n) {
    for(int k = 0; k < 3 && i < n; k++, i++) {
      unsigned at = pkgsrc_lr_peek(&s[k]);
      pkgsrc_lr_skip(&s[k], llen[at]);
      out[i] = lsym[at];
    }
  }
  size_t ua = (s[0].used + 7) / 8, ub = (s[1].used + 7) / 8, uc = (s[2].used + 7) / 8;
  if(ua != split || ub + uc != slen - a0 - split) return PKGSRC_ERR;
  return PKGSRC_OK;
}

// Um array em src[at..end): cru (tipo 0, devolve ponteiro para dentro de src) ou Huffman (tipo 2, decodificado em
// buf). *used = cabecalho + corpo. max limita o tamanho decodificado (buf tem PKGSRC_HALF bytes).
static int pkgsrc_array(const uint8_t* src, size_t at, size_t end, size_t max, uint8_t* buf, const uint8_t** data,
                        size_t* len, size_t* used) {
  if(at > end || end - at < 2) return PKGSRC_ERR;
  uint8_t b0 = src[at];
  unsigned type = (b0 >> 4) & 7u;
  if(type == 0) {
    size_t n, h;
    if(b0 >= 0x80) {
      n = (((size_t)b0 << 8) | src[at + 1]) & 0xFFFu;
      h = 2;
    } else {
      if(end - at < 3) return PKGSRC_ERR;
      n = ((size_t)b0 << 16) | ((size_t)src[at + 1] << 8) | src[at + 2];
      if(n & ~(size_t)0x3FFFF) return PKGSRC_ERR;
      h = 3;
    }
    if(n > max || n > end - at - h) return PKGSRC_ERR;
    *data = src + at + h;
    *len = n;
    *used = h + n;
    return PKGSRC_OK;
  }
  if(type == 2) {
    size_t ssz, dsz, h;
    if(b0 >= 0x80) {
      if(end - at < 3) return PKGSRC_ERR;
      size_t v = ((size_t)b0 << 16) | ((size_t)src[at + 1] << 8) | src[at + 2];
      ssz = v & 0x3FF;
      dsz = ssz + ((v >> 10) & 0x3FF) + 1;
      h = 3;
    } else {
      if(end - at < 5) return PKGSRC_ERR;
      size_t v = pkgsrc_be32(src + at + 1);
      ssz = v & 0x3FFFF;
      dsz = (((v >> 18) | ((size_t)b0 << 14)) & 0x3FFFF) + 1;
      h = 5;
    }
    if(ssz >= dsz || dsz > max || dsz > PKGSRC_HALF || ssz > end - at - h) return PKGSRC_ERR;
    if(pkgsrc_huff(src + at + h, ssz, buf, dsz)) return PKGSRC_ERR;
    *data = buf;
    *len = dsz;
    *used = h + ssz;
    return PKGSRC_OK;
  }
  return PKGSRC_ERR;
}

static void pkgsrc_put_lits(uint8_t* out, size_t dst, const uint8_t* lits, size_t n, int delta, size_t last) {
  if(!delta) {
    memcpy(out + dst, lits, n);
    return;
  }
  for(size_t k = 0; k < n; k++) out[dst + k] = (uint8_t)(lits[k] + out[dst + k - last]);
}

static void pkgsrc_copy_match(uint8_t* out, size_t dst, size_t dist, size_t len) {
  if(dist >= len) {
    memcpy(out + dst, out + dst - dist, len);
    return;
  }
  size_t k = 0;
  for(; k + 8 <= len; k += 8) memcpy(out + dst + k, out + dst + k - dist, 8);  // dist >= 8: sem sobrepor
  for(; k < len; k++) out[dst + k] = out[dst + k - dist];
}

// Uma metade LZ em out[at..at+len) (out[..at] e o historico). kraken.rs decode_half.
static int pkgsrc_lz_half(pkgsrc* p, const uint8_t* src, size_t slen, uint8_t* out, size_t at, size_t len, int delta) {
  size_t end = at + len, q = 0, dst = at;
  if(at == 0) {
    if(slen < 8 || len < 8) return PKGSRC_ERR;
    memcpy(out, src, 8);
    q = 8;
    dst = 8;
  }
  if(slen < q + 13) return PKGSRC_ERR;
  uint8_t flag = src[q];
  if((flag & 0xC0) != 0x80) return PKGSRC_ERR;
  q++;
  size_t excess = flag & 0x3F;
  if(excess > 0x1F) excess += (size_t)src[q++] * 0x20;
  if(excess > slen - q) return PKGSRC_ERR;
  size_t main_end = slen - excess;
  const uint8_t *lits, *cmds, *offc, *lens;
  size_t nl, nc, no, nn, u;
  if(pkgsrc_array(src, q, main_end, len, p->s_lits, &lits, &nl, &u)) return PKGSRC_ERR;
  q += u;
  if(pkgsrc_array(src, q, main_end, len, p->s_cmds, &cmds, &nc, &u)) return PKGSRC_ERR;
  q += u;
  if(q >= main_end) return PKGSRC_ERR;
  int scaled = src[q] == 0x80;
  if(scaled) q++;
  if(pkgsrc_array(src, q, main_end, nc, p->s_offc, &offc, &no, &u)) return PKGSRC_ERR;
  q += u;
  if(pkgsrc_array(src, q, main_end, len / 4, p->s_lens, &lens, &nn, &u)) return PKGSRC_ERR;
  q += u;
  pkgsrc_br a, b;
  pkgsrc_br_init(&a, src, q, main_end, 0);
  pkgsrc_br_init(&b, src, q, main_end, 1);
  uint32_t* offs = p->s_offs;
  for(size_t k = 0; k < no; k++) {
    pkgsrc_br* r = (k % 2 == 0) ? &a : &b;
    uint8_t c = offc[k];
    if(scaled) {
      uint32_t nb = c >> 3;
      if(nb > 26) return PKGSRC_ERR;
      uint64_t v = ((uint64_t)(8u + (c & 7u)) << nb) | pkgsrc_br_get(r, nb);
      offs[k] = (uint32_t)(v - 8);
    } else {
      if(c >= 0xF0) return PKGSRC_ERR;
      uint32_t n = (uint32_t)(c >> 4) + 4;
      uint64_t v = ((((uint64_t)1 << n) | pkgsrc_br_get(r, n)) << 4) + (c & 0xFu) - 248;
      offs[k] = (uint32_t)v;
    }
  }
  if(pkgsrc_br_seam(&a) != pkgsrc_br_seam(&b)) return PKGSRC_ERR;
  size_t nesc = 0;
  for(size_t k = 0; k < nn; k++)
    if(lens[k] == 255) nesc++;
  pkgsrc_br ea, eb;
  pkgsrc_br_init(&ea, src, main_end, slen, 0);
  pkgsrc_br_init(&eb, src, main_end, slen, 1);
  for(size_t k = 0; k < nesc; k++)
    if(pkgsrc_br_length(k % 2 == 0 ? &ea : &eb, &p->s_esc[k])) return PKGSRC_ERR;
  if(pkgsrc_br_seam(&ea) != pkgsrc_br_seam(&eb)) return PKGSRC_ERR;
  size_t li = 0, ei = 0, oi = 0, lit_at = 0;
  size_t recent[3] = {8, 8, 8};
#define PKGSRC_NEXT_LEN(dstv)                                       \
  do {                                                               \
    if(li >= nn) return PKGSRC_ERR;                                  \
    uint8_t lv_ = lens[li++];                                        \
    (dstv) = 3 + (lv_ == 255 ? 255 + (size_t)p->s_esc[ei++] : lv_);  \
  } while(0)
  for(size_t k = 0; k < nc; k++) {
    uint8_t f = cmds[k];
    size_t lit = f & 3u;
    if(lit == 3) PKGSRC_NEXT_LEN(lit);
    size_t kind = f >> 6, code = (f >> 2) & 0xFu;
    if(lit > nl - lit_at || lit > end - dst) return PKGSRC_ERR;
    pkgsrc_put_lits(out, dst, lits + lit_at, lit, delta, recent[0]);
    dst += lit;
    lit_at += lit;
    size_t d;
    if(kind == 3) {
      if(oi >= no) return PKGSRC_ERR;
      d = offs[oi++];
      recent[2] = recent[1];
      recent[1] = recent[0];
      recent[0] = d;
    } else {
      d = recent[kind];
      for(size_t j = kind; j >= 1; j--) recent[j] = recent[j - 1];
      recent[0] = d;
    }
    size_t mlen;
    if(code == 15) {
      PKGSRC_NEXT_LEN(mlen);
      mlen += 14;
    } else mlen = code + 2;
    if(d < 8 || d > dst || mlen > end - dst) return PKGSRC_ERR;
    pkgsrc_copy_match(out, dst, d, mlen);
    dst += mlen;
  }
#undef PKGSRC_NEXT_LEN
  if(nl - lit_at != end - dst) return PKGSRC_ERR;
  pkgsrc_put_lits(out, dst, lits + lit_at, end - dst, delta, recent[0]);
  if(oi != no || li != nn) return PKGSRC_ERR;
  return PKGSRC_OK;
}

// Uma metade: LZ, crua (tamanho exato) ou array de entropia solto (kraken_image.rs decode_described).
static int pkgsrc_half(pkgsrc* p, const uint8_t* src, size_t slen, uint8_t* out, size_t at, size_t len, int lz, int delta) {
  if(lz) return pkgsrc_lz_half(p, src, slen, out, at, len, delta);
  if(slen == len) {
    memcpy(out + at, src, len);
    return PKGSRC_OK;
  }
  const uint8_t* d;
  size_t n, used;
  if(pkgsrc_array(src, 0, slen, len, p->s_lits, &d, &n, &used) || used != slen || n != len) return PKGSRC_ERR;
  memcpy(out + at, d, len);
  return PKGSRC_OK;
}

// Os 13 embaralhamentos do PFSv3 (LibProsperoPkg), como tamanhos de campo de um vetor de 8 ou 16 bytes.
static const uint8_t pkgsrc_shuf[13][9] = {
    {0}, {2, 4, 4}, {3, 2, 2, 4}, {3, 1, 1, 6}, {8, 1, 1, 1, 1, 1, 1, 1, 1}, {4, 8, 2, 2, 4}, {6, 1, 1, 6, 2, 2, 4},
    {6, 1, 1, 6, 1, 1, 6}, {4, 4, 4, 4, 4}, {2, 8, 8}, {3, 8, 4, 4}, {2, 2, 6}, {4, 2, 6, 2, 6}};  // [0] = quantos

static void pkgsrc_deshuffle(pkgsrc* p, uint8_t* data, size_t len, uint8_t pattern) {
  const uint8_t* f = pkgsrc_shuf[pattern];
  size_t stride = 0;
  for(int i = 1; i <= f[0]; i++) stride += f[i];
  if(!stride) return;
  for(size_t c = 0; c < len; c += PKGSRC_BLK) {
    size_t cl = len - c < PKGSRC_BLK ? len - c : PKGSRC_BLK;
    uint8_t* chunk = data + c;
    memcpy(p->s_unit, chunk, cl);
    size_t vectors = cl / stride, off = 0, at = 0;
    for(int i = 1; i <= f[0]; i++) {
      for(size_t v = 0; v < vectors; v++) {
        memcpy(chunk + v * stride + off, p->s_unit + at, f[i]);
        at += f[i];
      }
      off += f[i];
    }
  }
}

// Decodifica o bloco Kraken i (len bytes) em out a partir dos bytes guardados.
static int pkgsrc_kdecode(pkgsrc* p, const pkgsrc_kblk* b, const uint8_t* src, uint8_t* out) {
  if(b->stored_len == 0) {
    memset(out, 0, b->len);
    return PKGSRC_OK;
  }
  if(b->stored_len > 2 * PKGSRC_UBLK || b->even_len > b->stored_len) return PKGSRC_ERR;
  size_t even = b->len < PKGSRC_HALF ? b->len : PKGSRC_HALF;
  if(pkgsrc_half(p, src, b->even_len, out, 0, even, b->even_lz, b->mode_bits & 1)) return PKGSRC_ERR;
  size_t olen = b->stored_len - b->even_len;
  if(b->len > PKGSRC_HALF) {
    if(pkgsrc_half(p, src + b->even_len, olen, out, PKGSRC_HALF, b->len - PKGSRC_HALF, b->odd_lz, (b->mode_bits & 8) != 0))
      return PKGSRC_ERR;
  } else if(olen) return PKGSRC_ERR;
  if(b->shuffle) pkgsrc_deshuffle(p, out, b->len, b->shuffle);
  return PKGSRC_OK;
}

// ------------------------------------------------------------------ naps_pkg_layout.dat (kraken_image.rs describe)

static int pkgsrc_u64cmp(const void* a, const void* b) {
  uint64_t x = *(const uint64_t*)a, y = *(const uint64_t*)b;
  return x < y ? -1 : x > y;
}

typedef struct pkgsrc_rec {
  uint64_t lo;
  uint8_t hi;
} pkgsrc_rec;

static uint64_t pkgsrc_bits(pkgsrc_rec r, unsigned lo, unsigned w) {
  uint64_t v;
  if(lo >= 64) v = (uint64_t)r.hi >> (lo - 64);
  else if(lo + w <= 64) v = r.lo >> lo;
  else v = (r.lo >> lo) | ((uint64_t)r.hi << (64 - lo));
  return w >= 64 ? v : v & ((1ull << w) - 1);
}

static pkgsrc_rec pkgsrc_rec_at(const uint8_t* blob, size_t rec_at, size_t i) {
  pkgsrc_rec r = {pkgsrc_le64(blob + rec_at + i * 9), blob[rec_at + i * 9 + 8]};
  return r;
}

// Primeiro limite > x (bounds ordenado, sem repetidos), ou mount.
static uint64_t pkgsrc_next_bound(const uint64_t* bounds, size_t nb, uint64_t x, uint64_t mount) {
  size_t lo = 0, hi = nb;
  while(lo < hi) {
    size_t m = (lo + hi) / 2;
    if(bounds[m] <= x) lo = m + 1;
    else hi = m;
  }
  return lo < nb ? bounds[lo] : mount;
}

static int pkgsrc_push_kb(pkgsrc* p, size_t* cap, const pkgsrc_kblk* b) {
  if(p->nkb == *cap) {
    size_t nc = *cap ? *cap * 2 : 1024;
    pkgsrc_kblk* n = realloc(p->kb, nc * sizeof *n);
    if(!n) return PKGSRC_ERR;
    p->kb = n;
    *cap = nc;
  }
  p->kb[p->nkb++] = *b;
  return PKGSRC_OK;
}

// Preenche os extents esparsos que comecam em *logical (zeros, nada guardado).
static int pkgsrc_fill_sparse(pkgsrc* p, size_t* cap, const uint64_t* sp, size_t nsp, const uint64_t* spend, uint64_t* logical) {
  for(;;) {
    size_t lo = 0, hi = nsp;
    while(lo < hi) {
      size_t m = (lo + hi) / 2;
      if(sp[m] < *logical) lo = m + 1;
      else hi = m;
    }
    if(lo >= nsp || sp[lo] != *logical) return PKGSRC_OK;
    uint64_t end = spend[lo];
    while(*logical < end) {
      uint64_t len = end - *logical < PKGSRC_UBLK ? end - *logical : PKGSRC_UBLK;
      pkgsrc_kblk b = {*logical, 0, (uint32_t)len, 0, 0, 0, 0, 0, 0};
      if(p->nkb >= PKGSRC_MAX_KBLOCKS || pkgsrc_push_kb(p, cap, &b)) return PKGSRC_ERR;
      *logical += len;
    }
  }
}

// Percorre o mapa como o console: registros em ordem, ancoras movem o cursor guardado, blocos ladrilham o mount a
// partir de cada limite de arquivo. Monta p->kb. Mensagem em err.
static int pkgsrc_describe(pkgsrc* p, const uint8_t* blob, size_t blen, char* err, size_t errcap) {
  uint64_t w0 = pkgsrc_le64(blob), w1 = pkgsrc_le64(blob + 8);
  size_t files = (size_t)(w0 & 0xFFFFFF) + 1, outer = (size_t)(w1 & 0xFFFFFF), shuffle = (size_t)((w0 >> 28) & 0xF);
  uint64_t ublocks = (w0 >> 32) & 0xFFFFFF;
  size_t records = (size_t)((w1 >> 24) & 0xFFFFFF) + 2;
  size_t fidx_at = 16 + (outer + shuffle) * 8;
  size_t u2c_end = fidx_at + files * 6 + (size_t)(ublocks / 8 + 1) * 10;
  size_t rec_at = ((u2c_end + 7) & ~(size_t)7) + 3;
  if(blen < rec_at || (blen - rec_at) / 9 < records) {
    pkgsrc_fail(err, errcap, "pacote corrompido: mapa da imagem menor que os registros");
    return PKGSRC_ERR;
  }
  if(ublocks + files + 1 + records > PKGSRC_MAX_KBLOCKS) {
    pkgsrc_fail(err, errcap, "imagem grande demais (%llu blocos)", (unsigned long long)(ublocks + files + records));
    return PKGSRC_ERR;
  }
  uint8_t table[16];
  for(size_t t = 0; t < shuffle; t++) {
    const uint8_t* e = blob + 16 + (outer + t) * 8;
    int found = -1;
    for(int s = 0; s < 13 && found < 0; s++) {
      int ok = 1;
      for(int j = 0; j < 8; j++) {
        uint8_t want = j < pkgsrc_shuf[s][0] ? pkgsrc_shuf[s][j + 1] : 0;
        if(e[j] != want) ok = 0;
      }
      if(ok) found = s;
    }
    if(found < 0) {
      pkgsrc_fail(err, errcap, "formato nao suportado: embaralhamento desconhecido no mapa da imagem");
      return PKGSRC_ERR;
    }
    table[t] = (uint8_t)found;
  }
  uint64_t* bounds = malloc(files * sizeof *bounds);
  uint64_t* sp = malloc(files * sizeof *sp);
  uint64_t* spend = malloc(files * sizeof *spend);
  int rc = PKGSRC_ERR;
  size_t cap = 0, nsp = 0;
  if(!bounds || !sp || !spend) {
    pkgsrc_fail(err, errcap, "sem memoria");
    goto out;
  }
  uint64_t mount = 0;
  for(size_t i = 0; i < files; i++) {
    const uint8_t* r = blob + fidx_at + i * 6;
    bounds[i] = (uint64_t)pkgsrc_le32(r) | ((uint64_t)r[4] << 32);
  }
  mount = bounds[files - 1];
  int bad = (mount + PKGSRC_UBLK - 1) / PKGSRC_UBLK != ublocks;
  for(size_t i = 0; i < files && !bad; i++)
    if(bounds[i] > mount) bad = 1;
  if(bad) {
    pkgsrc_fail(err, errcap, "pacote corrompido: a tabela de limites nao bate com o tamanho do mount");
    goto out;
  }
  // esparsos: limite tipo 0x40 antes do fim
  qsort(bounds, files, sizeof *bounds, pkgsrc_u64cmp);
  size_t nb = 0;
  for(size_t i = 0; i < files; i++)
    if(!nb || bounds[i] != bounds[nb - 1]) bounds[nb++] = bounds[i];
  for(size_t i = 0; i < files; i++) {
    const uint8_t* r = blob + fidx_at + i * 6;
    uint64_t at = (uint64_t)pkgsrc_le32(r) | ((uint64_t)r[4] << 32);
    if(r[5] == 0x40 && at < mount) sp[nsp++] = at;
  }
  qsort(sp, nsp, sizeof *sp, pkgsrc_u64cmp);
  {
    size_t k = 0;
    for(size_t i = 0; i < nsp; i++)
      if(!k || sp[i] != sp[k - 1]) sp[k++] = sp[i];
    nsp = k;
  }
  for(size_t i = 0; i < nsp; i++) spend[i] = pkgsrc_next_bound(bounds, nb, sp[i], mount);
  int strict = blob[rec_at - 3] == 0 && blob[rec_at - 2] == 0 && blob[rec_at - 1] == 4;
  uint64_t cursor = 0, logical = 0, carried = 0;
  int next_is_anchor = 1;
  for(size_t i = 0; i + 1 < records; i++) {
    pkgsrc_rec v = pkgsrc_rec_at(blob, rec_at, i);
    uint64_t nibble = carried;
    carried = pkgsrc_bits(v, 68, 4);
    int anchor = next_is_anchor;
    next_is_anchor = pkgsrc_bits(v, 66, 1) == 1 && !anchor;
    if(anchor) {
      cursor = (pkgsrc_bits(v, 26, 22) << 18) | pkgsrc_bits(v, 48, 18);
      int terminator = i + 2 == records;
      if(strict && i > 0 && !terminator && nibble != ((cursor >> 16) & 0xF)) {
        pkgsrc_fail(err, errcap, "pacote corrompido: registro %zu do mapa (ancora) inconsistente", i);
        goto out;
      }
      continue;
    }
    if(pkgsrc_fill_sparse(p, &cap, sp, nsp, spend, &logical)) {
      pkgsrc_fail(err, errcap, "sem memoria");
      goto out;
    }
    if((strict && i > 0 && nibble != (logical & 0xF)) || logical >= mount ||
       ((logical % PKGSRC_UBLK) >> 4) != pkgsrc_bits(v, 0, 14)) {
      pkgsrc_fail(err, errcap, "pacote corrompido: registro %zu do mapa nao bate com o mount", i);
      goto out;
    }
    uint64_t nbd = pkgsrc_next_bound(bounds, nb, logical, mount);
    if(nbd > mount) nbd = mount;
    uint64_t cap_end = logical + (nbd - logical < PKGSRC_UBLK ? nbd - logical : PKGSRC_UBLK);
    size_t next = pkgsrc_bits(v, 66, 1) == 1 ? i + 2 : i + 1;
    uint64_t len;
    if(next + 1 < records) {
      pkgsrc_rec rn = pkgsrc_rec_at(blob, rec_at, next);
      uint64_t at16 = (logical & ~(uint64_t)(PKGSRC_UBLK - 1)) | ((rn.lo & 0x3FFF) << 4);
      if(at16 <= (logical & ~(uint64_t)0xF)) at16 += PKGSRC_UBLK;
      uint64_t low = strict ? pkgsrc_bits(pkgsrc_rec_at(blob, rec_at, next - 1), 68, 4) : (logical & 0xF);
      uint64_t exact = at16 | low;
      if(at16 + 16 <= cap_end || (strict && exact < cap_end)) len = exact - logical;
      else len = cap_end - logical;
    } else len = cap_end - logical;
    uint64_t end = (cursor & ~(uint64_t)(PKGSRC_UBLK - 1)) | pkgsrc_bits(v, 48, 18);
    if(end < cursor) end += PKGSRC_UBLK;
    uint64_t hl = len < PKGSRC_HALF ? len : PKGSRC_HALF;
    int even_raw = pkgsrc_bits(v, 33, 1) == 0 && pkgsrc_bits(v, 14, 17) + 1 == hl;
    int odd_raw = pkgsrc_bits(v, 36, 1) == 0;
    if(end == cursor && even_raw && odd_raw && len > PKGSRC_HALF) end += PKGSRC_UBLK;
    if(end == cursor || len == 0 || len > PKGSRC_UBLK) {
      pkgsrc_fail(err, errcap, "pacote corrompido: registro %zu do mapa sem bytes guardados", i);
      goto out;
    }
    uint64_t sh = pkgsrc_bits(v, 44, 4);
    if(sh > shuffle) {
      pkgsrc_fail(err, errcap, "pacote corrompido: registro %zu com embaralhamento fora da tabela", i);
      goto out;
    }
    pkgsrc_kblk b = {logical, cursor, (uint32_t)len, (uint32_t)(end - cursor), (uint32_t)(pkgsrc_bits(v, 14, 17) + 1),
                     (uint8_t)pkgsrc_bits(v, 33, 1), (uint8_t)pkgsrc_bits(v, 36, 1), (uint8_t)pkgsrc_bits(v, 32, 5),
                     (uint8_t)(sh ? table[sh - 1] : 0)};
    if(p->nkb >= PKGSRC_MAX_KBLOCKS || pkgsrc_push_kb(p, &cap, &b)) {
      pkgsrc_fail(err, errcap, "sem memoria");
      goto out;
    }
    cursor = end;
    logical += len;
  }
  if(pkgsrc_fill_sparse(p, &cap, sp, nsp, spend, &logical)) {
    pkgsrc_fail(err, errcap, "sem memoria");
    goto out;
  }
  if(logical != mount) {
    pkgsrc_fail(err, errcap, "pacote corrompido: os blocos cobrem 0x%llx, o mount tem 0x%llx", (unsigned long long)logical,
                (unsigned long long)mount);
    goto out;
  }
  for(size_t i = 0; i < p->nkb; i++) {
    const pkgsrc_kblk* b = &p->kb[i];
    if(b->stored_at > p->image_size || b->stored_len > p->image_size - b->stored_at || b->stored_len > 2 * PKGSRC_UBLK) {
      pkgsrc_fail(err, errcap, "pacote corrompido: bloco do mount 0x%llx fora da imagem guardada", (unsigned long long)b->logical);
      goto out;
    }
  }
  p->mount_size = mount;
  rc = PKGSRC_OK;
out:
  free(bounds);
  free(sp);
  free(spend);
  return rc;
}

// ------------------------------------------------------------------ mount

static const uint8_t* pkgsrc_block(pkgsrc* p, size_t i) {
  for(int s = 0; s < PKGSRC_DEC_SLOTS; s++)
    if(p->dec_ok[s] && p->dec_idx[s] == i) return p->dec[s];
  int s = p->dec_next;
  p->dec_next = (s + 1) % PKGSRC_DEC_SLOTS;
  p->dec_ok[s] = 0;
  const pkgsrc_kblk* b = &p->kb[i];
  if(b->stored_len && pkgsrc_image_read(p, b->stored_at, p->stored, b->stored_len)) return NULL;
  if(pkgsrc_kdecode(p, b, p->stored, p->dec[s])) {
    pkgsrc_perr(p, "formato nao suportado ou pacote corrompido: o bloco Kraken do mount 0x%llx nao decodifica",
                (unsigned long long)b->logical);
    return NULL;
  }
  p->dec_ok[s] = 1;
  p->dec_idx[s] = i;
  return p->dec[s];
}

// n bytes do mount em off.
static int pkgsrc_mount_read(pkgsrc* p, uint64_t off, uint8_t* buf, size_t n) {
  if(off > p->mount_size || n > p->mount_size - off) return pkgsrc_perr(p, "pacote corrompido: leitura fora do mount");
  size_t lo = 0, hi = p->nkb;
  while(lo < hi) {  // primeiro bloco que termina depois de off
    size_t m = (lo + hi) / 2;
    if(p->kb[m].logical + p->kb[m].len <= off) lo = m + 1;
    else hi = m;
  }
  size_t i = lo;
  while(n) {
    if(i >= p->nkb) return pkgsrc_perr(p, "pacote corrompido: mount sem bloco");
    const uint8_t* d = pkgsrc_block(p, i);
    if(!d) return PKGSRC_ERR;
    size_t within = (size_t)(off - p->kb[i].logical), k = p->kb[i].len - within;
    if(k > n) k = n;
    memcpy(buf, d + within, k);
    buf += k;
    off += k;
    n -= k;
    i++;
  }
  return PKGSRC_OK;
}

// ------------------------------------------------------------------ PFS de fora: inodes e mapa de arquivos

typedef struct pkgsrc_dinode {
  uint16_t mode;
  uint64_t size;
  uint32_t direct[12];
  uint32_t ind_block[5];
  uint8_t ind_digest[5][32];
} pkgsrc_dinode;

static void pkgsrc_parse_dinode(const uint8_t* t, pkgsrc_dinode* d) {
  d->mode = pkgsrc_le16(t);
  d->size = pkgsrc_le64(t + 8);
  for(int k = 0; k < 12; k++) d->direct[k] = pkgsrc_le32(t + 0x64 + k * 36 + 32);
  for(int k = 0; k < 5; k++) {
    memcpy(d->ind_digest[k], t + 0x64 + (12 + k) * 36, 32);
    d->ind_block[k] = pkgsrc_le32(t + 0x64 + (12 + k) * 36 + 32);
  }
}

static int pkgsrc_map_table(pkgsrc* p, uint32_t block, int level, const uint8_t digest[32], uint32_t* map, uint64_t* have,
                            uint64_t need, const char* what) {
  if(block >= p->outer_blocks) return pkgsrc_perr(p, "pacote corrompido: tabela indireta de %s fora da imagem", what);
  const uint8_t* t = pkgsrc_outer(p, block);
  if(!t) return PKGSRC_ERR;
  uint8_t* copy = malloc(PKGSRC_BLK);
  if(!copy) return pkgsrc_perr(p, "sem memoria");
  memcpy(copy, t, PKGSRC_BLK);
  uint8_t got[32];
  pkgsrc_sha3(copy, PKGSRC_BLK, got);
  int rc = PKGSRC_OK;
  if(memcmp(got, digest, 32) != 0) rc = pkgsrc_perr(p, "pacote corrompido: tabela indireta de %s nao confere", what);
  for(size_t slot = 0; rc == PKGSRC_OK && slot < PKGSRC_BLK / 36 && *have < need; slot++) {
    uint32_t child = pkgsrc_le32(copy + slot * 36 + 32);
    if(child == 0) rc = pkgsrc_perr(p, "pacote corrompido: tabela indireta de %s acaba antes", what);
    else if(level == 0) {
      if(child >= p->outer_blocks) rc = pkgsrc_perr(p, "pacote corrompido: %s aponta para fora da imagem", what);
      else map[(*have)++] = child;
    } else rc = pkgsrc_map_table(p, child, level - 1, copy + slot * 36, map, have, need, what);
  }
  free(copy);
  return rc;
}

// Mapa de blocos (blocos de fora de cada 64 KiB) de um arquivo do PFS de fora.
static uint32_t* pkgsrc_map_file(pkgsrc* p, const pkgsrc_dinode* d, const char* what) {
  uint64_t need = (d->size + PKGSRC_BLK - 1) / PKGSRC_BLK, have = 0;
  if(need > p->outer_blocks) {
    pkgsrc_perr(p, "pacote corrompido: %s maior que a imagem", what);
    return NULL;
  }
  uint32_t* map = malloc((size_t)(need ? need : 1) * sizeof *map);
  if(!map) {
    pkgsrc_perr(p, "sem memoria");
    return NULL;
  }
  for(int k = 0; k < 12 && have < need; k++) {
    if(d->direct[k] >= p->outer_blocks) {
      pkgsrc_perr(p, "pacote corrompido: %s aponta para fora da imagem", what);
      free(map);
      return NULL;
    }
    map[have++] = d->direct[k];
  }
  for(int level = 0; level < 5 && have < need && d->ind_block[level]; level++)
    if(pkgsrc_map_table(p, d->ind_block[level], level, d->ind_digest[level], map, &have, need, what)) {
      free(map);
      return NULL;
    }
  if(have < need) {
    pkgsrc_perr(p, "pacote corrompido: o mapa de %s cobre %llu de %llu blocos", what, (unsigned long long)have,
                (unsigned long long)need);
    free(map);
    return NULL;
  }
  return map;
}

// Inode do filho `name` do diretorio dinode `dir` (so o primeiro bloco). -1 se nao achou.
static long pkgsrc_child(pkgsrc* p, const uint8_t* table, uint64_t count, uint64_t dir, const char* name) {
  if(dir >= count) return -1;
  pkgsrc_dinode d;
  pkgsrc_parse_dinode(table + dir * PKGSRC_DINODE_LEN, &d);
  const uint8_t* b = pkgsrc_outer(p, d.direct[0]);
  if(!b) return -1;
  size_t limit = d.size < PKGSRC_BLK ? (size_t)d.size : PKGSRC_BLK, o = 0, nl = strlen(name);
  while(o + 16 <= limit) {
    uint32_t namelen = pkgsrc_le32(b + o + 8), ent = pkgsrc_le32(b + o + 12);
    if(ent == 0 || namelen > limit - o - 16) break;
    if(namelen == nl && memcmp(b + o + 16, name, nl) == 0) {
      uint32_t ino = pkgsrc_le32(b + o);
      return ino < count ? (long)ino : -1;
    }
    o += ent;
  }
  return -1;
}

// ------------------------------------------------------------------ arvore do jogo

static int pkgsrc_add(pkgsrc* p, char* path, uint64_t size, int is_dir, int container, uint64_t at) {
  if(p->nents >= PKGSRC_MAX_ENTRIES) {
    free(path);
    return pkgsrc_perr(p, "pacote corrompido: mais de %u entradas", PKGSRC_MAX_ENTRIES);
  }
  if(p->nents == p->capents) {
    size_t nc = p->capents ? p->capents * 2 : 256;
    exw_entry* e = realloc(p->ents, nc * sizeof *e);
    if(!e) {
      free(path);
      return pkgsrc_perr(p, "sem memoria");
    }
    p->ents = e;
    pkgsrc_place* pl = realloc(p->places, nc * sizeof *pl);
    if(!pl) {
      free(path);
      return pkgsrc_perr(p, "sem memoria");
    }
    p->places = pl;
    p->capents = nc;
  }
  exw_entry* e = &p->ents[p->nents];
  e->path = path;
  e->size = is_dir ? 0 : size;
  e->is_dir = is_dir;
  e->user = NULL;
  p->places[p->nents].container = container;
  p->places[p->nents].at = at;
  p->nents++;
  return PKGSRC_OK;
}

static char* pkgsrc_join(const char* prefix, const uint8_t* name, size_t nl) {
  size_t pl = strlen(prefix);
  char* s = malloc(pl + 1 + nl + 1);
  if(!s) return NULL;
  size_t o = 0;
  if(pl) {
    memcpy(s, prefix, pl);
    s[pl] = '/';
    o = pl + 1;
  }
  memcpy(s + o, name, nl);
  s[o + nl] = 0;
  return s;
}

// Nome valido: nao vazio, sem '/', NUL, "." ou "..", UTF-8 bem formado.
static int pkgsrc_name_ok(const uint8_t* s, size_t n) {
  if(n == 0 || n > 255 || (n == 1 && s[0] == '.') || (n == 2 && s[0] == '.' && s[1] == '.')) return 0;
  for(size_t i = 0; i < n;) {
    uint8_t c = s[i];
    if(c == 0 || c == '/') return 0;
    size_t k = c < 0x80 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 0;
    if(!k || i + k > n || (k == 2 && c < 0xC2)) return 0;
    for(size_t j = 1; j < k; j++)
      if((s[i + j] & 0xC0) != 0x80) return 0;
    i += k;
  }
  return 1;
}

typedef struct pkgsrc_pend {
  uint32_t ino;
  char* path;
} pkgsrc_pend;

static int pkgsrc_inode(pkgsrc* p, uint64_t table_at, uint64_t count, uint32_t ino, uint8_t raw[PKGSRC_INODE_LEN]) {
  if(ino >= count) return pkgsrc_perr(p, "pacote corrompido: inode %u passa da tabela (%llu)", ino, (unsigned long long)count);
  uint64_t off = table_at + (uint64_t)(ino / PKGSRC_INODES_PER_BLK) * PKGSRC_BLK + (uint64_t)(ino % PKGSRC_INODES_PER_BLK) * PKGSRC_INODE_LEN;
  return pkgsrc_mount_read(p, off, raw, PKGSRC_INODE_LEN);
}

// Percorre o PFS de dentro a partir do uroot (inode 4): pastas e arquivos com o lugar de cada um no mount.
static int pkgsrc_walk(pkgsrc* p) {
  uint64_t mb = p->meta_base;
  if(mb > p->mount_size || p->mount_size - mb < PKGSRC_BLK) return pkgsrc_perr(p, "pacote corrompido: base dos metadados fora do mount");
  uint8_t sb[0x40];
  if(pkgsrc_mount_read(p, mb, sb, sizeof sb)) return PKGSRC_ERR;
  if(pkgsrc_le64(sb) != 2 || pkgsrc_le64(sb + 8) != PKGSRC_SB_MAGIC || pkgsrc_le32(sb + 0x20) != PKGSRC_BLK)
    return pkgsrc_perr(p, "pacote corrompido: superbloco do PFS de dentro invalido");
  uint64_t count = pkgsrc_le64(sb + 0x30), table_at = mb + PKGSRC_BLK;
  uint64_t tlen = ((count + PKGSRC_INODES_PER_BLK - 1) / PKGSRC_INODES_PER_BLK) * (uint64_t)PKGSRC_BLK;
  if(count <= 4 || count > PKGSRC_MAX_INODES || table_at > p->mount_size || tlen > p->mount_size - table_at)
    return pkgsrc_perr(p, "pacote corrompido: %llu inodes no PFS de dentro", (unsigned long long)count);
  uint8_t* visited = calloc((size_t)(count + 7) / 8, 1);
  size_t cap = 64, np = 0;
  pkgsrc_pend* pend = malloc(cap * sizeof *pend);
  uint8_t* dirbuf = NULL;
  int rc = PKGSRC_ERR;
  uint64_t budget = p->mount_size - mb;
  char* root = calloc(1, 1);
  if(!visited || !pend || !root) {
    free(root);
    pkgsrc_perr(p, "sem memoria");
    goto out;
  }
  pend[np++] = (pkgsrc_pend){4, root};
  while(np) {
    pkgsrc_pend cur = pend[--np];
    // R2-1: o inode vem do pacote; conferir antes de tocar em 'visited' (que tem count bits).
    if(cur.ino >= count) {
      pkgsrc_perr(p, "pacote corrompido: inode %u passa da tabela (%llu)", cur.ino, (unsigned long long)count);
      free(cur.path);
      goto out;
    }
    if(visited[cur.ino / 8] & (1u << (cur.ino % 8))) {
      free(cur.path);
      pkgsrc_perr(p, "pacote corrompido: pasta ligada duas vezes (ciclo)");
      goto out;
    }
    visited[cur.ino / 8] |= (uint8_t)(1u << (cur.ino % 8));
    uint8_t raw[PKGSRC_INODE_LEN];
    if(pkgsrc_inode(p, table_at, count, cur.ino, raw)) {
      free(cur.path);
      goto out;
    }
    uint64_t dsize = pkgsrc_le64(raw + 8), dat = pkgsrc_le64(raw + 0x60);
    if((pkgsrc_le16(raw) & 0xF000) != 0x4000 || dsize > PKGSRC_MAX_DIR || dat > p->mount_size || dsize > p->mount_size - dat ||
       dsize > budget) {
      pkgsrc_perr(p, "pacote corrompido: pasta '%s' invalida", cur.path[0] ? cur.path : "uroot");
      free(cur.path);
      goto out;
    }
    budget -= dsize;
    free(dirbuf);
    dirbuf = malloc(dsize ? (size_t)dsize : 1);
    if(!dirbuf) {
      free(cur.path);
      pkgsrc_perr(p, "sem memoria");
      goto out;
    }
    if(pkgsrc_mount_read(p, dat, dirbuf, (size_t)dsize)) {
      free(cur.path);
      goto out;
    }
#ifdef PKGSRC_TEST_DIRENT_HOOK
    PKGSRC_TEST_DIRENT_HOOK(dirbuf, (size_t)dsize);  // so no harness de teste: simula pasta montada de proposito
#endif
    size_t o = 0;
    while(o + 16 <= dsize) {
      uint32_t ino = pkgsrc_le32(dirbuf + o), kind = pkgsrc_le32(dirbuf + o + 4), nl = pkgsrc_le32(dirbuf + o + 8),
               ent = pkgsrc_le32(dirbuf + o + 12);
      if(ent == 0) break;
      if(nl > dsize - o - 16 || ent < 16 + (uint64_t)nl) {
        pkgsrc_perr(p, "pacote corrompido: entrada de pasta malformada em '%s'", cur.path);
        free(cur.path);
        goto out;
      }
      const uint8_t* name = dirbuf + o + 16;
      o += ent;
      if(kind == 4 || kind == 5) continue;
      if(!pkgsrc_name_ok(name, nl)) {
        pkgsrc_perr(p, "pacote corrompido: nome invalido em '%s'", cur.path);
        free(cur.path);
        goto out;
      }
      char* path = pkgsrc_join(cur.path, name, nl);
      if(!path) {
        free(cur.path);
        pkgsrc_perr(p, "sem memoria");
        goto out;
      }
      if(kind == 3) {
        // R2-1: recusar ja ao empilhar uma subpasta com inode fora da tabela.
        if(ino >= count) {
          pkgsrc_perr(p, "pacote corrompido: inode %u da pasta '%s' passa da tabela (%llu)", ino, path, (unsigned long long)count);
          free(path);
          free(cur.path);
          goto out;
        }
        char* dup = strdup(path);
        if(!dup) free(path);
        if(!dup || pkgsrc_add(p, path, 0, 1, 0, 0)) {
          free(dup);
          free(cur.path);
          if(!dup) pkgsrc_perr(p, "sem memoria");
          goto out;
        }
        if(np == cap) {
          pkgsrc_pend* n2 = realloc(pend, cap * 2 * sizeof *pend);
          if(!n2) {
            free(dup);
            free(cur.path);
            pkgsrc_perr(p, "sem memoria");
            goto out;
          }
          pend = n2;
          cap *= 2;
        }
        pend[np++] = (pkgsrc_pend){ino, dup};
      } else if(kind == 2) {
        uint8_t fr[PKGSRC_INODE_LEN];
        if(pkgsrc_inode(p, table_at, count, ino, fr)) {
          free(path);
          free(cur.path);
          goto out;
        }
        uint64_t fsize = pkgsrc_le64(fr + 8), fat = pkgsrc_le64(fr + 0x60);
        if((pkgsrc_le16(fr) & 0xF000) != 0x8000 || fat > mb || fsize > mb - fat) {
          pkgsrc_perr(p, "pacote corrompido: arquivo '%s' invalido", path);
          free(path);
          free(cur.path);
          goto out;
        }
        if(pkgsrc_add(p, path, fsize, 0, 0, fat)) {
          free(cur.path);
          goto out;
        }
      } else {
        pkgsrc_perr(p, "pacote corrompido: tipo de entrada %u em '%s'", kind, path);
        free(path);
        free(cur.path);
        goto out;
      }
    }
    free(cur.path);
  }
  rc = PKGSRC_OK;
out:
  while(np) free(pend[--np].path);
  free(pend);
  free(visited);
  free(dirbuf);
  return rc;
}

static long pkgsrc_find(const pkgsrc* p, const char* path) {
  for(size_t i = 0; i < p->nents; i++)
    if(strcmp(p->ents[i].path, path) == 0) return (long)i;
  return -1;
}

// Arquivos do jogo que podem estar so no container (lib.rs container_paths): entram em sce_sys/ quando a imagem
// nao tem; cifrados ou vazios ficam de fora.
static const struct {
  uint32_t id;
  const char* path;
} pkgsrc_cpaths[] = {
    {0x1200, "sce_sys/icon0.png"},     {0x1280, "sce_sys/icon0.dds"},     {0x2000, "sce_sys/param.json"},
    {0x1006, "sce_sys/pic1.png"},      {0x100D, "sce_sys/save_data.png"}, {0x1220, "sce_sys/pic0.png"},
    {0x1240, "sce_sys/snd0.at9"},      {0x12A0, "sce_sys/pic0.dds"},      {0x12C0, "sce_sys/pic1.dds"},
    {0x1480, "sce_sys/trophy2/trophy00.ucp"}, {0x14A0, "sce_sys/uds/uds00.ucp"}, {0x2040, "sce_sys/pic2.png"},
    {0x2060, "sce_sys/pic2.dds"},      {0x0402, "sce_sys/nptitle.dat"},   {0x2020, "sce_sys/uds/npbind.dat"},
    {0x2021, "sce_sys/trophy2/npbind.dat"},
};

static int pkgsrc_merge_container(pkgsrc* p) {
  for(size_t c = 0; c < sizeof pkgsrc_cpaths / sizeof pkgsrc_cpaths[0]; c++) {
    const pkgsrc_cent* e = pkgsrc_centry(p, pkgsrc_cpaths[c].id);
    if(!e || e->size == 0 || (e->flags1 & 0x80000000u)) continue;
    const char* path = pkgsrc_cpaths[c].path;
    if(pkgsrc_find(p, path) >= 0) continue;  // a imagem ganha (arquivo ou pasta com o mesmo nome)
    // pais: pasta que falta e criada; arquivo no lugar de uma pasta = a imagem ganha
    char buf[64];
    int blocked = 0;
    for(const char* s = strchr(path, '/'); s && !blocked; s = strchr(s + 1, '/')) {
      size_t n = (size_t)(s - path);
      memcpy(buf, path, n);
      buf[n] = 0;
      long k = pkgsrc_find(p, buf);
      if(k >= 0 && !p->ents[k].is_dir) blocked = 1;
      else if(k < 0) {
        char* d = strdup(buf);
        if(!d) return pkgsrc_perr(p, "sem memoria");
        if(pkgsrc_add(p, d, 0, 1, 0, 0)) return PKGSRC_ERR;
      }
    }
    if(blocked) continue;
    char* s = strdup(path);
    if(!s) return pkgsrc_perr(p, "sem memoria");
    if(pkgsrc_add(p, s, e->size, 0, 1, e->at)) return PKGSRC_ERR;
  }
  return PKGSRC_OK;
}

// Ordena por caminho (pasta antes do conteudo, pela ordem de bytes) e recusa nome repetido.
static int pkgsrc_sort(pkgsrc* p) {
  size_t n = p->nents;
  size_t* idx = malloc((n ? n : 1) * sizeof *idx);
  exw_entry* e2 = malloc((n ? n : 1) * sizeof *e2);
  pkgsrc_place* p2 = malloc((n ? n : 1) * sizeof *p2);
  if(!idx || !e2 || !p2) {
    free(idx);
    free(e2);
    free(p2);
    return pkgsrc_perr(p, "sem memoria");
  }
  for(size_t i = 0; i < n; i++) idx[i] = i;
  // ordena os indices com um merge sort simples (qsort nao tem contexto em C11)
  size_t* tmp = malloc((n ? n : 1) * sizeof *tmp);
  if(!tmp) {
    free(idx);
    free(e2);
    free(p2);
    return pkgsrc_perr(p, "sem memoria");
  }
  for(size_t w = 1; w < n; w *= 2) {
    for(size_t lo = 0; lo < n; lo += 2 * w) {
      size_t mid = lo + w < n ? lo + w : n, hi = lo + 2 * w < n ? lo + 2 * w : n, a = lo, b = mid, k = lo;
      while(a < mid && b < hi) tmp[k++] = strcmp(p->ents[idx[a]].path, p->ents[idx[b]].path) <= 0 ? idx[a++] : idx[b++];
      while(a < mid) tmp[k++] = idx[a++];
      while(b < hi) tmp[k++] = idx[b++];
    }
    memcpy(idx, tmp, n * sizeof *idx);
  }
  free(tmp);
  for(size_t i = 0; i < n; i++) {
    e2[i] = p->ents[idx[i]];
    p2[i] = p->places[idx[i]];
  }
  free(idx);
  free(p->ents);
  free(p->places);
  p->ents = e2;
  p->places = p2;
  p->capents = n ? n : 1;
  for(size_t i = 0; i + 1 < n; i++)
    if(strcmp(p->ents[i].path, p->ents[i + 1].path) == 0) return pkgsrc_perr(p, "pacote corrompido: '%s' aparece duas vezes", p->ents[i].path);
  for(size_t i = 0; i < n; i++) p->ents[i].user = &p->places[i];
  return PKGSRC_OK;
}

// ------------------------------------------------------------------ title id / tipo

static int pkgsrc_tid_ok(const char* s) {
  for(int i = 0; i < 4; i++)
    if(s[i] < 'A' || s[i] > 'Z') return 0;
  for(int i = 4; i < 9; i++)
    if(s[i] < '0' || s[i] > '9') return 0;
  return s[9] == 0;
}

// "titleId" (ou "title_id") de um param.json.
static void pkgsrc_tid_from_json(pkgsrc* p, const char* js, size_t n) {
  const char* keys[] = {"\"titleId\"", "\"title_id\""};
  for(int k = 0; k < 2 && !p->title_id[0]; k++) {
    size_t kl = strlen(keys[k]);
    for(size_t i = 0; i + kl < n; i++) {
      if(memcmp(js + i, keys[k], kl)) continue;
      size_t j = i + kl;
      while(j < n && (js[j] == ' ' || js[j] == '\t' || js[j] == '\r' || js[j] == '\n')) j++;
      if(j >= n || js[j] != ':') continue;
      j++;
      while(j < n && (js[j] == ' ' || js[j] == '\t' || js[j] == '\r' || js[j] == '\n')) j++;
      if(j >= n || js[j] != '"') continue;
      j++;
      char t[16];
      size_t m = 0;
      while(j < n && js[j] != '"' && m < 15) t[m++] = js[j++];
      t[m] = 0;
      if(pkgsrc_tid_ok(t)) {
        memcpy(p->title_id, t, m + 1);
        break;
      }
    }
  }
}

static void pkgsrc_ids(pkgsrc* p) {
  // param.json do container (texto claro) ou da imagem, ate 1 MiB
  const pkgsrc_cent* e = pkgsrc_centry(p, 0x2000);
  char* js = NULL;
  size_t n = 0;
  if(e && e->size && e->size <= (1u << 20) && !(e->flags1 & 0x80000000u)) {
    js = malloc((size_t)e->size);
    n = (size_t)e->size;
    if(js && pkgsrc_pread(p, e->at, js, n)) {
      free(js);
      js = NULL;
    }
  }
  if(!js && !p->lih) {
    long i = pkgsrc_find(p, "sce_sys/param.json");
    if(i >= 0 && !p->ents[i].is_dir && p->ents[i].size <= (1u << 20)) {
      n = (size_t)p->ents[i].size;
      js = malloc(n ? n : 1);
      if(js && pkgsrc_read(p, &p->ents[i], 0, js, n) != (long long)n) {
        free(js);
        js = NULL;
      }
    }
  }
  if(js) pkgsrc_tid_from_json(p, js, n);
  free(js);
  if(!p->title_id[0] && strlen(p->content_id) >= 16) {  // UP0000-PPSA01234_00-...
    char t[16];
    memcpy(t, p->content_id + 7, 9);
    t[9] = 0;
    if(pkgsrc_tid_ok(t)) memcpy(p->title_id, t, 10);
  }
  if(p->lih) p->kind = PKGSRC_PATCH;
  else if(p->content_type == 0x20 || p->content_type == 0x1A || p->content_type == 0x26) p->kind = PKGSRC_GAME;
  else if(p->content_type == 0x21 || p->content_type == 0x1B) p->kind = PKGSRC_DLC;
  else p->kind = PKGSRC_OTHER;
}

// ------------------------------------------------------------------ abrir

static pkgsrc* pkgsrc_alloc(void) {
  pkgsrc* p = calloc(1, sizeof *p);
  if(!p) return NULL;
  p->fd = -1;
  for(int i = 0; i < 2; i++) p->runs[i].raw = malloc((size_t)PKGSRC_RUN * PKGSRC_BLK);
  for(int i = 0; i < PKGSRC_DEC_SLOTS; i++) p->dec[i] = malloc(PKGSRC_UBLK);
  p->tmp = malloc(PKGSRC_BLK);
  p->stored = malloc(2 * PKGSRC_UBLK);
  p->s_lits = malloc(PKGSRC_HALF);
  p->s_cmds = malloc(PKGSRC_HALF);
  p->s_offc = malloc(PKGSRC_HALF);
  p->s_lens = malloc(PKGSRC_HALF);
  p->s_unit = malloc(PKGSRC_BLK);
  p->s_offs = malloc(PKGSRC_HALF * sizeof(uint32_t));
  p->s_esc = malloc(PKGSRC_HALF * sizeof(uint32_t));
  int ok = p->runs[0].raw && p->runs[1].raw && p->tmp && p->stored && p->s_lits && p->s_cmds && p->s_offc && p->s_lens &&
           p->s_unit && p->s_offs && p->s_esc;
  for(int i = 0; i < PKGSRC_DEC_SLOTS; i++) ok = ok && p->dec[i];
  if(!ok) {
    pkgsrc_close(p);
    return NULL;
  }
  return p;
}

// Abre o "\x7FLIH" (atualizacao): so o container (ids e tipo); pkgsrc_entries recusa.
static int pkgsrc_open_lih(pkgsrc* p, char* err, size_t errcap) {
  uint8_t head[0x40];
  if(p->len < PKGSRC_BLK || pkgsrc_pread(p, 0, head, sizeof head)) {
    pkgsrc_fail(err, errcap, "pacote corrompido: cabecalho de atualizacao truncado");
    return PKGSRC_ERR;
  }
  uint64_t off = pkgsrc_le64(head + 0x30), size = pkgsrc_le64(head + 0x38);
  if(off < PKGSRC_BLK || off > p->len || size > p->len - off) {
    pkgsrc_fail(err, errcap, "pacote corrompido: container da atualizacao fora do arquivo");
    return PKGSRC_ERR;
  }
  p->lih = 1;
  return pkgsrc_container(p, off, err, errcap);
}

static int pkgsrc_open_fih(pkgsrc* p, char* err, size_t errcap) {
  uint8_t h[0x100];
#define PKGSRC_FAIL(...)                       \
  do {                                         \
    pkgsrc_fail(err, errcap, __VA_ARGS__);     \
    return PKGSRC_ERR;                         \
  } while(0)
#define PKGSRC_LAST() PKGSRC_FAIL("%s", p->lasterr)
  if(p->len < sizeof h) PKGSRC_FAIL("pacote truncado: menor que o cabecalho");
  if(pkgsrc_pread(p, 0, h, sizeof h)) PKGSRC_LAST();
  if(h[5] != 0)
    PKGSRC_FAIL("pacote de varejo (cifrado de verdade, byte de assinatura 0x%02x): so pacotes fake/debug (FPKG) sao suportados", h[5]);
  p->pfs_offset = pkgsrc_le64(h + 0x10);
  uint64_t pfs_size = pkgsrc_le64(h + 0x18), sb_abs = pkgsrc_le64(h + 0x20), cnt = pkgsrc_le64(h + 0x58);
  if(p->pfs_offset < sizeof h || p->pfs_offset % PKGSRC_BLK || !pfs_size || pfs_size % PKGSRC_BLK)
    PKGSRC_FAIL("pacote corrompido: PFS de fora em 0x%llx (+0x%llx)", (unsigned long long)p->pfs_offset, (unsigned long long)pfs_size);
  if(p->pfs_offset > p->len || pfs_size > p->len - p->pfs_offset)
    PKGSRC_FAIL("pacote truncado: o PFS de fora passa do fim do arquivo (%llu de %llu bytes)", (unsigned long long)p->len,
                (unsigned long long)(p->pfs_offset + pfs_size));
  p->outer_blocks = pfs_size / PKGSRC_BLK;
  if(p->outer_blocks > 0xFFFFFFFFull) PKGSRC_FAIL("pacote corrompido: PFS grande demais");
  if(sb_abs < p->pfs_offset || (sb_abs - p->pfs_offset) % PKGSRC_BLK || (sb_abs - p->pfs_offset) / PKGSRC_BLK >= p->outer_blocks)
    PKGSRC_FAIL("pacote corrompido: superbloco fora do PFS");
  p->sb_index = (sb_abs - p->pfs_offset) / PKGSRC_BLK;
  if(pkgsrc_le64(h + 0x60) != PKGSRC_BLK) PKGSRC_FAIL("formato nao suportado: bloco de 0x%llx", (unsigned long long)pkgsrc_le64(h + 0x60));
  p->meta_base = (uint64_t)pkgsrc_le32(h + 0x50) * PKGSRC_BLK;
  if(cnt > p->len || p->len - cnt < 0x1000) PKGSRC_FAIL("pacote truncado: container fora do arquivo");
  if(pkgsrc_container(p, cnt, err, errcap)) return PKGSRC_ERR;
  const pkgsrc_cent* dg = pkgsrc_centry(p, 0x040A);
  if(!dg || dg->size != p->outer_blocks * 32) PKGSRC_FAIL("pacote corrompido: imagedigs ausente ou do tamanho errado");
  p->digests_at = dg->at;

  // superbloco: guardado sempre em claro, conferido pelo SHA3 do cabecalho
  const uint8_t* sbb = pkgsrc_outer(p, p->sb_index);
  if(!sbb) PKGSRC_LAST();
  uint8_t got[32];
  pkgsrc_sha3(sbb, PKGSRC_BLK, got);
  if(memcmp(got, h + 0x30, 32)) PKGSRC_FAIL("pacote corrompido: o superbloco nao confere com o cabecalho");
  uint8_t sb[0x5A0];
  memcpy(sb, sbb, sizeof sb);
  if(pkgsrc_le64(sb) != 2 || pkgsrc_le64(sb + 8) != PKGSRC_SB_MAGIC) PKGSRC_FAIL("formato nao suportado: PFS de fora nao e de PS5");
  uint8_t icv[32];
  memcpy(icv, sb + 0x380, 32);
  memset(sb + 0x380, 0, 32);
  pkgsrc_sha3(sb, sizeof sb, got);
  if(memcmp(got, icv, 32)) PKGSRC_FAIL("pacote corrompido: ICV do superbloco nao confere");
  uint64_t dcount = pkgsrc_le64(sb + 0x30);
  uint32_t table_blk = pkgsrc_le32(sb + 0xD8);
  const uint8_t* seed = sb + 0x370;
  if(memcmp(seed, "PPRPLAIN-NOAUTH!", 16) != 0) {
    // imagem nativa: AES-XTS com a senha de debug padrao
    uint8_t ek[32], kd[16], kt[16], key[32];
    pkgsrc_pfs_key(p->content_id, 1, ek);
    pkgsrc_xts_keys(ek, seed, kd, kt);
    memcpy(key, kd, 16);
    memcpy(key + 16, kt, 16);
    p->xts = EVP_CIPHER_CTX_new();
    if(!p->xts || !EVP_DecryptInit_ex(p->xts, EVP_aes_128_xts(), NULL, key, NULL)) PKGSRC_FAIL("OpenSSL sem AES-XTS");
    p->native = 1;
    p->runs[0].n = p->runs[1].n = 0;  // o superbloco ja conferido continua valido, mas recarrega tudo
  }
  if(table_blk == p->sb_index) PKGSRC_FAIL("pacote corrompido: tabela de inodes no superbloco");
  const uint8_t* tb = pkgsrc_outer(p, table_blk);
  if(!tb) {
    if(!p->native) PKGSRC_LAST();
    // cifrada: senha errada (confere na entrada 0x10) ou esquema de chave desconhecido
    const pkgsrc_cent* ek = pkgsrc_centry(p, 0x0010);
    if(ek && ek->size >= 96) {
      uint8_t stored[32], key[32], want[32];
      if(pkgsrc_pread(p, ek->at + 64, stored, 32) == 0) {
        pkgsrc_pfs_key(p->content_id, 1, key);
        pkgsrc_sha3(key, 32, want);
        for(int i = 0; i < 32; i++) want[i] ^= key[i];
        if(memcmp(stored, want, 32))
          PKGSRC_FAIL("pacote cifrado com senha/chave que nao e a de debug padrao: nao da para abrir sem a chave");
      }
    }
    PKGSRC_FAIL("pacote cifrado (AES-XTS) que nao decifra com a chave de debug aberta: formato nao suportado");
  }
  uint8_t* table = malloc(PKGSRC_BLK);
  if(!table) PKGSRC_FAIL("sem memoria");
  memcpy(table, tb, PKGSRC_BLK);
  pkgsrc_sha3(table, PKGSRC_BLK, got);
  if(memcmp(got, sb + 0xB8, 32)) {
    free(table);
    PKGSRC_FAIL("pacote corrompido: tabela de inodes de fora nao confere");
  }
  uint64_t nd = PKGSRC_BLK / PKGSRC_DINODE_LEN;
  if(dcount < nd) nd = dcount;
  long uroot = pkgsrc_child(p, table, nd, 0, "uroot");
  long img = uroot >= 0 ? pkgsrc_child(p, table, nd, (uint64_t)uroot, "pfs_image.dat") : -1;
  long naps = uroot >= 0 ? pkgsrc_child(p, table, nd, (uint64_t)uroot, "naps_pkg_layout.dat") : -1;
  if(img < 0 || naps < 0) {
    free(table);
    if(uroot < 0 && p->lasterr[0]) PKGSRC_LAST();
    PKGSRC_FAIL("formato nao suportado: o PFS de fora nao tem uroot/pfs_image.dat e naps_pkg_layout.dat");
  }
  pkgsrc_dinode di, dn;
  pkgsrc_parse_dinode(table + (size_t)img * PKGSRC_DINODE_LEN, &di);
  pkgsrc_parse_dinode(table + (size_t)naps * PKGSRC_DINODE_LEN, &dn);
  free(table);
  p->imap = pkgsrc_map_file(p, &di, "pfs_image.dat");
  if(!p->imap) PKGSRC_LAST();
  p->image_size = di.size;
  if(dn.size < 16 || dn.size > PKGSRC_MAX_LAYOUT) PKGSRC_FAIL("formato nao suportado: mapa da imagem com %llu bytes", (unsigned long long)dn.size);
  uint32_t* nmap = pkgsrc_map_file(p, &dn, "naps_pkg_layout.dat");
  if(!nmap) PKGSRC_LAST();
  uint8_t* blob = malloc((size_t)dn.size);
  if(!blob) {
    free(nmap);
    PKGSRC_FAIL("sem memoria");
  }
  for(uint64_t o = 0; o < dn.size; o += PKGSRC_BLK) {
    const uint8_t* b = pkgsrc_outer(p, nmap[o / PKGSRC_BLK]);
    if(!b) {
      free(nmap);
      free(blob);
      PKGSRC_LAST();
    }
    size_t k = dn.size - o < PKGSRC_BLK ? (size_t)(dn.size - o) : PKGSRC_BLK;
    memcpy(blob + o, b, k);
  }
  free(nmap);
  uint64_t w0 = pkgsrc_le64(blob);
  unsigned comp = (unsigned)((w0 >> 24) & 3);
  if(comp != 2) {
    free(blob);
    PKGSRC_FAIL("formato nao suportado: a imagem usa a compressao %u (%s); so Kraken e suportado", comp,
                comp == 0 ? "QuickZ" : comp == 1 ? "zlib" : "desconhecida");
  }
  // layout "plano" (diagnostico do ps5upload, kraken desligado): os registros vem logo depois das tabelas. Quando o
  // tamanho serve para os dois (mount.rs shape "Either"), tenta Kraken e, se nao percorrer, e plano.
  int kraken = 0;
  {
    uint64_t w1 = pkgsrc_le64(blob + 8);
    size_t files = (size_t)(w0 & 0xFFFFFF) + 1, shuffle = (size_t)((w0 >> 28) & 0xF);
    size_t ub = (size_t)((w0 >> 32) & 0xFFFFFF), outer = (size_t)(w1 & 0xFFFFFF), recs = (size_t)((w1 >> 24) & 0xFFFFFF) + 2;
    size_t fidx_end = 16 + (outer + shuffle) * 8 + files * 6;
    size_t rec_at = ((fidx_end + (ub / 8 + 1) * 10 + 7) & ~(size_t)7) + 3;
    size_t flat_len = fidx_end + ((ub + 7) / 8 + 1) * 10 + recs * 9;
    if(rec_at <= dn.size) {
      if(blob[rec_at - 3] == 0 && blob[rec_at - 2] == 0 && blob[rec_at - 1] == 4) kraken = 1;
      else if(dn.size >= rec_at + recs * 9 && dn.size != flat_len) kraken = 1;
      else if(dn.size >= rec_at + recs * 9) kraken = 2;  // os dois tamanhos: tenta Kraken
    }
    if(!kraken) {
      free(blob);
      PKGSRC_FAIL("formato nao suportado: imagem sem compressao no layout 'plano' (diagnostico do ps5upload)");
    }
  }
  int rc = pkgsrc_describe(p, blob, (size_t)dn.size, err, errcap);
  free(blob);
  if(rc && kraken == 2) PKGSRC_FAIL("formato nao suportado: imagem sem compressao no layout 'plano' (diagnostico do ps5upload)");
  if(rc) return PKGSRC_ERR;
  if(pkgsrc_walk(p) || pkgsrc_merge_container(p) || pkgsrc_sort(p)) PKGSRC_LAST();
  return PKGSRC_OK;
#undef PKGSRC_LAST
#undef PKGSRC_FAIL
}

pkgsrc* pkgsrc_open(const char* pkg_path, char* err, size_t errcap) {
  if(err && errcap) err[0] = 0;
  pkgsrc* p = pkgsrc_alloc();
  if(!p) {
    pkgsrc_fail(err, errcap, "sem memoria");
    return NULL;
  }
  p->fd = open(pkg_path, O_RDONLY);
  struct stat st;
  if(p->fd < 0 || fstat(p->fd, &st) != 0) {
    pkgsrc_fail(err, errcap, "nao abriu o pacote: %s", strerror(errno));
    pkgsrc_close(p);
    return NULL;
  }
  p->len = (uint64_t)st.st_size;
  uint8_t m[4] = {0};
  if(p->len < 4 || pkgsrc_pread(p, 0, m, 4)) {
    pkgsrc_fail(err, errcap, "nao e um pacote (arquivo pequeno demais)");
    pkgsrc_close(p);
    return NULL;
  }
  int rc;
  if(memcmp(m, "\x7F" "FIH", 4) == 0) rc = pkgsrc_open_fih(p, err, errcap);
  else if(memcmp(m, "\x7F" "LIH", 4) == 0) rc = pkgsrc_open_lih(p, err, errcap);
  else if(memcmp(m, "\x7F" "CNT", 4) == 0) {
    pkgsrc_fail(err, errcap, "pacote de PS4 (\\x7FCNT): so pacotes de PS5 sao convertidos");
    rc = PKGSRC_ERR;
  } else {
    pkgsrc_fail(err, errcap, "nao e um pacote de PS5 (sem o cabecalho \\x7FFIH)");
    rc = PKGSRC_ERR;
  }
  if(rc) {
    pkgsrc_close(p);
    return NULL;
  }
  pkgsrc_ids(p);
  p->lasterr[0] = 0;
  return p;
}

int pkgsrc_entries(pkgsrc* p, const exw_entry** out, size_t* count, char* err, size_t errcap) {
  if(!p || !out || !count) {
    pkgsrc_fail(err, errcap, "argumento invalido");
    return -1;
  }
  if(p->lih) {
    pkgsrc_fail(err, errcap, "pacote de atualizacao (\\x7FLIH): so tem os blocos que mudaram; converta o jogo base");
    return -1;
  }
  *out = p->ents;
  *count = p->nents;
  return 0;
}

long long pkgsrc_read(void* ctx, const exw_entry* e, uint64_t offset, void* buf, size_t len) {
  pkgsrc* p = ctx;
  if(!p || !e || !e->user || p->lih) return -1;
  const pkgsrc_place* pl = e->user;
  if(pl < p->places || pl >= p->places + p->nents) return pkgsrc_perr(p, "entrada que nao e deste pacote");
  if(e->is_dir || offset >= e->size) return 0;
  if(len > e->size - offset) len = (size_t)(e->size - offset);
  if(len == 0) return 0;
  int rc = pl->container ? pkgsrc_pread(p, pl->at + offset, buf, len) : pkgsrc_mount_read(p, pl->at + offset, buf, len);
  return rc ? -1 : (long long)len;
}

const char* pkgsrc_title_id(const pkgsrc* p) { return p ? p->title_id : ""; }
const char* pkgsrc_content_id(const pkgsrc* p) { return p ? p->content_id : ""; }
int pkgsrc_kind(const pkgsrc* p) { return p ? p->kind : PKGSRC_OTHER; }

void pkgsrc_close(pkgsrc* p) {
  if(!p) return;
  if(p->fd >= 0) close(p->fd);
  if(p->xts) EVP_CIPHER_CTX_free(p->xts);
  for(int i = 0; i < 2; i++) free(p->runs[i].raw);
  for(int i = 0; i < PKGSRC_DEC_SLOTS; i++) free(p->dec[i]);
  free(p->tmp);
  free(p->stored);
  free(p->s_lits);
  free(p->s_cmds);
  free(p->s_offc);
  free(p->s_lens);
  free(p->s_unit);
  free(p->s_offs);
  free(p->s_esc);
  free(p->ce);
  free(p->imap);
  free(p->kb);
  for(size_t i = 0; i < p->nents; i++) free((char*)p->ents[i].path);
  free(p->ents);
  free(p->places);
  free(p);
}
