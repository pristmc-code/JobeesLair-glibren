// glibren.60 (7z-multi): extracao de .7z com LZMA2 em varios nucleos (o Alan Wake 2, .exfat.7z de 91,7 GB, levava 1h43
// a ~15 MB/s no PS5 pela libarchive: um nucleo so, e ler/descompactar/gravar no mesmo fio).
//
// Como funciona: o cabecalho do .7z e lido pelo 7zArcIn do LZMA SDK (7-Zip 26.06, arquivos em dominio publico, copiados
// sem mudanca em app/native/lzma/). Cada "pasta" (folder) LZMA2 vai ao Lzma2DecMt do mesmo SDK, o decodificador que o
// proprio 7-Zip usa: o LZMA2 gravado pelo 7-Zip com varios fios ("-mmt", o padrao num PC com 4+ nucleos) e cortado em
// blocos com o dicionario zerado (a cada 4x o dicionario: 64 MiB no -mx5, 256 MiB no -mx9); cada bloco e descompactado
// num nucleo e a saida sai NA ORDEM. Um LZMA2 de um bloco so (-mmt1, xz antigo) decodifica num fio, como antes.
// Em volta: um fio le o compactado adiantado (buffers de 8 MiB, os volumes .7z.001... juntos) e outro grava os arquivos
// (fila de buffers de 8 MiB), entao o fio que descompacta nao espera o disco. Os CRC32 de cada arquivo (e da pasta)
// sao conferidos na gravacao.
//
// So entra aqui o .7z sem senha cujas pastas sao TODAS de um codec LZMA2 sem filtro (o que o 7-Zip grava por padrao);
// o resto (LZMA, BCJ, PPMd, AES, cabecalho cifrado) devolve -1 e a libarchive extrai como antes. Memoria: cada fio do
// MT segura um bloco de entrada e um de saida (~2,1x o bloco); o numero de fios cabe em BGDL_7Z_MEM_MB (padrao 1536)
// e em BGDL_7Z_THREADS (padrao: nucleos - 1, ate 7). Sem memoria no meio, tenta de novo com um fio; sem memoria de
// novo, -1 (libarchive).
//
// Devolve 1 extraido, 0 falhou (err: dado corrompido, CRC, disco, cancelado), -1 nao e para este caminho (err diz por que).

#define Z7_AFFINITY_DISABLE 1
#define Z7_NO_METHODS_FILTERS 1
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#elif defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-parameter"
#pragma GCC diagnostic ignored "-Wsign-compare"
#pragma GCC diagnostic ignored "-Wimplicit-fallthrough"
#pragma GCC diagnostic ignored "-Wunused-function"
#pragma GCC diagnostic ignored "-Wcast-function-type"
#pragma GCC diagnostic ignored "-Wtype-limits"
#pragma GCC diagnostic ignored "-Wunused-but-set-variable"
#pragma GCC diagnostic ignored "-Wunused-variable"
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#endif
#include "lzma/Alloc.c"
#include "lzma/CpuArch.c"
#include "lzma/7zCrc.c"
#include "lzma/7zCrcOpt.c"
#include "lzma/7zBuf.c"
#include "lzma/7zStream.c"
#include "lzma/LzmaDec.c"
#include "lzma/Lzma2Dec.c"
#include "lzma/Bcj2.c"
#include "lzma/Bra.c"
#include "lzma/Bra86.c"
#include "lzma/Delta.c"
#include "lzma/7zDec.c"
#include "lzma/7zArcIn.c"
#undef Print
#undef PRF
#include "lzma/Threads.c"
#undef Print
#undef PRF
#include "lzma/MtDec.c"
#undef Print
#undef PRF
#undef kNumAlignBits // LzmaDec.c (macro) x Lzma2DecMt.c (variavel local): mesmo nome numa unidade so
#include "lzma/Lzma2DecMt.c"
#if defined(__clang__)
#pragma clang diagnostic pop
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

#define SZ7_BUF (8u * 1024 * 1024) // leitura adiantada e fila de gravacao: buffers de 8 MiB
#define SZ7_NBUF 4

static void* sz7_alloc(ISzAllocPtr p, size_t size) { (void)p; return size ? malloc(size) : NULL; }
static void sz7_free(ISzAllocPtr p, void* a) { (void)p; free(a); }
static const ISzAlloc g_sz7_alloc = {sz7_alloc, sz7_free};

// ---- os volumes (.7z ou .7z.001, .002, ...) como um arquivo so ----
typedef struct {
  int fd[ARC_MAX_VOLUMES];
  uint64_t start[ARC_MAX_VOLUMES + 1]; // start[i] = onde o volume i comeca; start[n] = tamanho total
  int n;
} Sz7Vol;

static void sz7_vol_close(Sz7Vol* v) {
  for (int i = 0; i < v->n; ++i) if (v->fd[i] >= 0) close(v->fd[i]);
  v->n = 0;
}
static int sz7_vol_open(Sz7Vol* v, const Conv* c, char* err, size_t cap) {
  memset(v, 0, sizeof *v);
  const int count = c->nsources ? c->nsources : 1;
  for (int i = 0; i < count && i < ARC_MAX_VOLUMES; ++i) {
    const char* path = c->nsources ? c->sources[i] : c->source;
    struct stat st;
    v->fd[i] = open(path, O_RDONLY | O_CLOEXEC);
    if (v->fd[i] < 0 || fstat(v->fd[i], &st)) {
      snprintf(err, cap, "could not open %.200s (%s)", base_name(path), strerror(errno));
      v->n = i + (v->fd[i] >= 0);
      sz7_vol_close(v);
      return -1;
    }
    v->start[i + 1] = v->start[i] + (uint64_t)st.st_size;
    v->n = i + 1;
  }
  return 0;
}
// pread por cima dos volumes: menos que `len` so no fim; -1 erro de leitura.
static long long sz7_vol_pread(const Sz7Vol* v, void* buf, size_t len, uint64_t off) {
  size_t done = 0;
  while (done < len && off < v->start[v->n]) {
    int i = 0;
    while (i + 1 < v->n && off >= v->start[i + 1]) ++i;
    const uint64_t left = v->start[i + 1] - off;
    const size_t want = len - done < left ? len - done : (size_t)left;
    const ssize_t got = pread(v->fd[i], (char*)buf + done, want, (off_t)(off - v->start[i]));
    if (got < 0) { if (errno == EINTR) continue; return -1; }
    if (got == 0) break;
    done += (size_t)got;
    off += (uint64_t)got;
  }
  return (long long)done;
}

// ISeekInStream para o SzArEx_Open (cabecalho).
typedef struct { ISeekInStream vt; const Sz7Vol* v; uint64_t pos; } Sz7Seek;
static SRes sz7_seek_read(ISeekInStreamPtr pp, void* buf, size_t* size) {
  Sz7Seek* p = Z7_CONTAINER_FROM_VTBL(pp, Sz7Seek, vt);
  const long long got = sz7_vol_pread(p->v, buf, *size, p->pos);
  if (got < 0) { *size = 0; return SZ_ERROR_READ; }
  *size = (size_t)got;
  p->pos += (uint64_t)got;
  return SZ_OK;
}
static SRes sz7_seek_seek(ISeekInStreamPtr pp, Int64* pos, ESzSeek origin) {
  Sz7Seek* p = Z7_CONTAINER_FROM_VTBL(pp, Sz7Seek, vt);
  const int64_t base = origin == SZ_SEEK_SET ? 0 : origin == SZ_SEEK_CUR ? (int64_t)p->pos : (int64_t)p->v->start[p->v->n];
  const int64_t to = base + *pos;
  if (to < 0) return SZ_ERROR_PARAM;
  p->pos = (uint64_t)to;
  *pos = to;
  return SZ_OK;
}

// ---- leitura adiantada: um fio le o fluxo compactado de uma pasta em buffers de 8 MiB ----
typedef struct { char* data; size_t len; int full; } Sz7Buf;
typedef struct {
  ISeqInStream vt;
  const Sz7Vol* v;
  uint64_t pos, end;        // produtor
  Sz7Buf buf[SZ7_NBUF];
  int head, tail;           // tail: produtor; head: consumidor
  size_t off;               // consumidor: ja lido de buf[head]
  int eof, error, stop;
  volatile uint64_t consumed; // bytes entregues ao decodificador (progresso "lidos do compactado")
  pthread_mutex_t lock;
  pthread_cond_t cond;
  pthread_t thread;
  int started, inited;
} Sz7In;

static void* sz7_in_loop(void* arg) {
  Sz7In* in = arg;
  for (;;) {
    pthread_mutex_lock(&in->lock);
    while (!in->stop && in->buf[in->tail].full) pthread_cond_wait(&in->cond, &in->lock);
    if (in->stop) { pthread_mutex_unlock(&in->lock); break; }
    Sz7Buf* b = &in->buf[in->tail];
    pthread_mutex_unlock(&in->lock);
    const uint64_t left = in->end - in->pos;
    const size_t want = left < SZ7_BUF ? (size_t)left : SZ7_BUF;
    const long long got = want ? sz7_vol_pread(in->v, b->data, want, in->pos) : 0;
    pthread_mutex_lock(&in->lock);
    if (got < 0) in->error = 1;
    else {
      b->len = (size_t)got;
      b->full = 1;
      in->pos += (uint64_t)got;
      if (!got) in->eof = 1; // buffer vazio cheio = fim
      in->tail = (in->tail + 1) % SZ7_NBUF;
    }
    pthread_cond_broadcast(&in->cond);
    const int done = in->error || in->eof;
    pthread_mutex_unlock(&in->lock);
    if (done) break;
  }
  return NULL;
}
static SRes sz7_in_read(ISeqInStreamPtr pp, void* buf, size_t* size) {
  Sz7In* in = Z7_CONTAINER_FROM_VTBL(pp, Sz7In, vt);
  if (!*size) return SZ_OK;
  pthread_mutex_lock(&in->lock);
  while (!in->buf[in->head].full && !in->error) pthread_cond_wait(&in->cond, &in->lock);
  if (!in->buf[in->head].full) { pthread_mutex_unlock(&in->lock); *size = 0; return SZ_ERROR_READ; }
  Sz7Buf* b = &in->buf[in->head];
  pthread_mutex_unlock(&in->lock);
  if (!b->len) { *size = 0; return SZ_OK; } // fim: fica cheio (ler de novo = fim de novo)
  size_t n = b->len - in->off;
  if (n > *size) n = *size;
  memcpy(buf, b->data + in->off, n);
  in->off += n;
  in->consumed += n;
  *size = n;
  if (in->off == b->len) {
    pthread_mutex_lock(&in->lock);
    b->full = 0;
    in->off = 0;
    in->head = (in->head + 1) % SZ7_NBUF;
    pthread_cond_broadcast(&in->cond);
    pthread_mutex_unlock(&in->lock);
  }
  return SZ_OK;
}
static int sz7_in_start(Sz7In* in, const Sz7Vol* v, uint64_t pos, uint64_t size) {
  memset(in, 0, sizeof *in);
  in->vt.Read = sz7_in_read;
  in->v = v;
  in->pos = pos;
  in->end = pos + size;
  pthread_mutex_init(&in->lock, NULL);
  pthread_cond_init(&in->cond, NULL);
  in->inited = 1;
  for (int i = 0; i < SZ7_NBUF; ++i) if (!(in->buf[i].data = malloc(SZ7_BUF))) return -1;
  if (pthread_create(&in->thread, NULL, sz7_in_loop, in)) return -1;
  in->started = 1;
  return 0;
}
static void sz7_in_stop(Sz7In* in) {
  if (!in->inited) return;
  if (in->started) {
    pthread_mutex_lock(&in->lock);
    in->stop = 1;
    pthread_cond_broadcast(&in->cond);
    pthread_mutex_unlock(&in->lock);
    pthread_join(in->thread, NULL);
    in->started = 0;
  }
  for (int i = 0; i < SZ7_NBUF; ++i) { free(in->buf[i].data); in->buf[i].data = NULL; }
  pthread_mutex_destroy(&in->lock);
  pthread_cond_destroy(&in->cond);
  in->inited = 0;
}

// ---- gravacao: um fio grava a saida da pasta nos arquivos, na ordem, conferindo os CRC ----
typedef struct {
  ISeqOutStream vt;
  Conv* c;
  const CSzArEx* db;
  const char* work;
  // a pasta atual (so o fio de gravacao mexe)
  UInt32 folder, next_file;   // proximo arquivo a olhar (indice no db)
  int fd;                     // arquivo aberto (-1 nenhum)
  int discard;                // link simbolico ou nome invalido: so consome os bytes
  UInt32 file;                // o arquivo atual
  uint64_t left;              // bytes que faltam do arquivo atual
  UInt32 crc, folder_crc;
  unsigned skipped;
  uint64_t done, delay_mark;  // descompactados gravados (todas as pastas)
  uint64_t read_base;         // compactado ja lido nas pastas anteriores
  Sz7In* volatile in;
  // fila (decodificador -> fio de gravacao)
  Sz7Buf buf[SZ7_NBUF];
  int head, tail, finish, stop;
  int error;                  // 1: o fio de gravacao parou (err)
  char err[300];
  pthread_mutex_t lock;
  pthread_cond_t cond;
  pthread_t thread;
  int started, inited;
} Sz7Out;

static void sz7_name(const CSzArEx* db, UInt32 i, char* out, size_t cap) {
  UInt16 name16[1100];
  const size_t n = SzArEx_GetFileNameUtf16(db, i, NULL);
  if (n > sizeof name16 / sizeof *name16) { out[0] = 0; return; }
  SzArEx_GetFileNameUtf16(db, i, name16);
  size_t o = 0;
  for (size_t k = 0; k < n && name16[k]; ++k) {
    uint32_t cp = name16[k];
    if (cp >= 0xD800 && cp < 0xDC00 && k + 1 < n && name16[k + 1] >= 0xDC00 && name16[k + 1] < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (uint32_t)(name16[k + 1] - 0xDC00); ++k; }
    char tmp[4];
    size_t len;
    if (cp < 0x80) { tmp[0] = (char)cp; len = 1; }
    else if (cp < 0x800) { tmp[0] = (char)(0xC0 | (cp >> 6)); tmp[1] = (char)(0x80 | (cp & 0x3F)); len = 2; }
    else if (cp < 0x10000) { tmp[0] = (char)(0xE0 | (cp >> 12)); tmp[1] = (char)(0x80 | ((cp >> 6) & 0x3F)); tmp[2] = (char)(0x80 | (cp & 0x3F)); len = 3; }
    else { tmp[0] = (char)(0xF0 | (cp >> 18)); tmp[1] = (char)(0x80 | ((cp >> 12) & 0x3F)); tmp[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); tmp[3] = (char)(0x80 | (cp & 0x3F)); len = 4; }
    if (o + len + 1 > cap) { out[0] = 0; return; }
    memcpy(out + o, tmp, len);
    o += len;
  }
  out[o] = 0;
}
// O caminho final dentro de work (0 = nome invalido: "..", vazio, comprido demais).
static int sz7_path(const CSzArEx* db, UInt32 i, const char* work, char* full, size_t cap) {
  char name[1200], clean[1200];
  sz7_name(db, i, name, sizeof name);
  if (!name[0] || !arc_clean_path(name, clean, sizeof clean)) return 0;
  return snprintf(full, cap, "%s/%s", work, clean) < (int)cap;
}
static int sz7_is_link(const CSzArEx* db, UInt32 i) {
  if (!SzBitWithVals_Check(&db->Attribs, i)) return 0;
  const UInt32 a = db->Attribs.Vals[i];
  return (a & 0x8000) && ((a >> 16) & S_IFMT) == S_IFLNK; // FILE_ATTRIBUTE_UNIX_EXTENSION + modo unix
}
static void sz7_times(const CSzArEx* db, UInt32 i, const char* path) {
  if (!SzBitWithVals_Check(&db->MTime, i)) return;
  const uint64_t ft = ((uint64_t)db->MTime.Vals[i].High << 32) | db->MTime.Vals[i].Low;
  if (ft < 116444736000000000ull) return;
  const uint64_t unix100 = ft - 116444736000000000ull;
  struct timespec ts[2];
  ts[0].tv_sec = ts[1].tv_sec = (time_t)(unix100 / 10000000ull);
  ts[0].tv_nsec = ts[1].tv_nsec = (long)(unix100 % 10000000ull) * 100;
  utimensat(AT_FDCWD, path, ts, 0);
}
static int sz7_close_file(Sz7Out* o) {
  int rc = 0;
  if (o->fd >= 0) {
    if (close(o->fd)) { snprintf(o->err, sizeof o->err, "write: %s", strerror(errno)); rc = -1; }
    o->fd = -1;
    char full[1300];
    if (!rc && sz7_path(o->db, o->file, o->work, full, sizeof full)) sz7_times(o->db, o->file, full);
    if (!rc && SzBitWithVals_Check(&o->db->CRCs, o->file) && CRC_GET_DIGEST(o->crc) != o->db->CRCs.Vals[o->file]) {
      char name[400];
      sz7_name(o->db, o->file, name, sizeof name);
      snprintf(o->err, sizeof o->err, "source: CRC mismatch in %.250s (the archive is damaged)", name);
      rc = -1;
    }
  }
  o->discard = 0;
  return rc;
}
// Abre o proximo arquivo da pasta (pula os de outras pastas e os vazios sem fluxo). 1 abriu; 0 acabou; -1 erro.
static int sz7_open_next(Sz7Out* o) {
  for (; o->next_file < o->db->NumFiles; ++o->next_file) {
    const UInt32 i = o->next_file;
    if (o->db->FileToFolder[i] != o->folder) continue;
    ++o->next_file;
    o->file = i;
    o->left = SzArEx_GetFileSize(o->db, i);
    o->crc = CRC_INIT_VAL;
    o->fd = -1;
    o->discard = 0;
    char full[1300];
    if (SzArEx_IsDir(o->db, i) || sz7_is_link(o->db, i) || !sz7_path(o->db, i, o->work, full, sizeof full)) {
      o->discard = 1; // link, nome invalido (ou pasta com dados): le e joga fora
      ++o->skipped;
      return 1;
    }
    char parent[1300];
    copy_text(parent, sizeof parent, full);
    char* slash = strrchr(parent, '/');
    if (slash) { *slash = 0; mkdir_p(parent); }
    o->fd = open(full, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
    if (o->fd < 0) { snprintf(o->err, sizeof o->err, "write: %.200s (%s)", base_name(full), strerror(errno)); return -1; }
    return 1;
  }
  return 0;
}
static int sz7_consume(Sz7Out* o, const char* data, size_t len) {
  o->folder_crc = CrcUpdate(o->folder_crc, data, len);
  while (len) {
    if (o->fd < 0 && !o->discard) {
      const int opened = sz7_open_next(o);
      if (opened < 0) return -1;
      if (!opened) { snprintf(o->err, sizeof o->err, "source: the folder has more data than its files (the archive is damaged)"); return -1; }
    }
    const size_t n = o->left < len ? (size_t)o->left : len;
    if (n) {
      o->crc = CrcUpdate(o->crc, data, n);
      for (size_t w = 0; o->fd >= 0 && w < n;) {
        const ssize_t got = write(o->fd, data + w, n - w);
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) { snprintf(o->err, sizeof o->err, "write: %s", got < 0 ? strerror(errno) : "short write"); return -1; }
        w += (size_t)got;
      }
      data += n;
      len -= n;
      o->left -= n;
    }
    if (!o->left && sz7_close_file(o)) return -1;
  }
  return 0;
}
static void* sz7_out_loop(void* arg) {
  Sz7Out* o = arg;
  for (;;) {
    pthread_mutex_lock(&o->lock);
    while (!o->buf[o->head].full && !o->finish && !o->stop) pthread_cond_wait(&o->cond, &o->lock);
    if (o->stop || (!o->buf[o->head].full && o->finish)) { pthread_mutex_unlock(&o->lock); break; }
    Sz7Buf* b = &o->buf[o->head];
    const int failed = o->error;
    pthread_mutex_unlock(&o->lock);
    int bad = 0;
    if (!failed) {
      bad = sz7_consume(o, b->data, b->len);
      o->done += b->len;
      Sz7In* in = o->in;
      conv_extract_tick(o->c, o->done, 0, o->read_base + (in ? in->consumed : 0));
      if (g_conv_delay_ms) {
        // testes: uma espera por MiB gravado, como o caminho da libarchive (da tempo de ler o progresso)
        while (o->done - o->delay_mark >= ARC_BLOCK && !o->c->cancel && !g_stop) { sleep_ms(g_conv_delay_ms); o->delay_mark += ARC_BLOCK; }
      }
    }
    pthread_mutex_lock(&o->lock);
    if (bad) o->error = 1;
    b->full = 0;
    b->len = 0;
    o->head = (o->head + 1) % SZ7_NBUF;
    pthread_cond_broadcast(&o->cond);
    pthread_mutex_unlock(&o->lock);
  }
  return NULL;
}
static int sz7_out_cancelled(const Sz7Out* o) { return o->c->cancel || g_stop; }
static size_t sz7_out_write(ISeqOutStreamPtr pp, const void* data, size_t size) {
  Sz7Out* o = Z7_CONTAINER_FROM_VTBL(pp, Sz7Out, vt);
  const char* p = data;
  size_t left = size;
  while (left) {
    pthread_mutex_lock(&o->lock);
    while (o->buf[o->tail].full && !o->error && !sz7_out_cancelled(o)) {
      struct timespec until;
      clock_gettime(CLOCK_REALTIME, &until);
      until.tv_nsec += 200 * 1000000L;
      if (until.tv_nsec >= 1000000000L) { until.tv_sec++; until.tv_nsec -= 1000000000L; }
      pthread_cond_timedwait(&o->cond, &o->lock, &until);
    }
    const int stop = o->error || sz7_out_cancelled(o);
    Sz7Buf* b = &o->buf[o->tail];
    pthread_mutex_unlock(&o->lock);
    if (stop) return 0;
    size_t n = SZ7_BUF - b->len;
    if (n > left) n = left;
    memcpy(b->data + b->len, p, n);
    b->len += n;
    p += n;
    left -= n;
    if (b->len == SZ7_BUF) {
      pthread_mutex_lock(&o->lock);
      b->full = 1;
      o->tail = (o->tail + 1) % SZ7_NBUF;
      pthread_cond_broadcast(&o->cond);
      pthread_mutex_unlock(&o->lock);
    }
  }
  return size;
}
// Manda o resto do buffer atual e espera a fila esvaziar (fim da pasta). 0 ok.
static int sz7_out_drain(Sz7Out* o) {
  pthread_mutex_lock(&o->lock);
  Sz7Buf* b = &o->buf[o->tail];
  if (b->len && !b->full) {
    b->full = 1;
    o->tail = (o->tail + 1) % SZ7_NBUF;
    pthread_cond_broadcast(&o->cond);
  }
  for (int i = 0; i < SZ7_NBUF; ++i) while (o->buf[i].full && !o->error) pthread_cond_wait(&o->cond, &o->lock);
  const int error = o->error;
  pthread_mutex_unlock(&o->lock);
  return error ? -1 : 0;
}
static int sz7_out_start(Sz7Out* o) {
  pthread_mutex_init(&o->lock, NULL);
  pthread_cond_init(&o->cond, NULL);
  o->inited = 1;
  for (int i = 0; i < SZ7_NBUF; ++i) { o->buf[i].len = 0; o->buf[i].full = 0; if (!(o->buf[i].data = malloc(SZ7_BUF))) return -1; }
  if (pthread_create(&o->thread, NULL, sz7_out_loop, o)) return -1;
  o->started = 1;
  return 0;
}
static void sz7_out_stop(Sz7Out* o) {
  if (!o->inited) return;
  if (o->started) {
    pthread_mutex_lock(&o->lock);
    o->finish = 1;
    o->stop = 1; // o que sobrou na fila depois de um erro ou cancelamento nao e gravado (sz7_out_drain ja esvaziou o resto)
    pthread_cond_broadcast(&o->cond);
    pthread_mutex_unlock(&o->lock);
    pthread_join(o->thread, NULL);
    o->started = 0;
  }
  if (o->fd >= 0) { close(o->fd); o->fd = -1; }
  for (int i = 0; i < SZ7_NBUF; ++i) { free(o->buf[i].data); o->buf[i].data = NULL; }
  pthread_mutex_destroy(&o->lock);
  pthread_cond_destroy(&o->cond);
  o->inited = 0;
}

typedef struct { ICompressProgress vt; const Conv* c; } Sz7Progress;
static SRes sz7_progress(ICompressProgressPtr pp, UInt64 in, UInt64 out) {
  (void)in;
  (void)out;
  const Sz7Progress* p = Z7_CONTAINER_FROM_VTBL_CONST(pp, Sz7Progress, vt);
  return p->c->cancel || g_stop ? SZ_ERROR_PROGRESS : SZ_OK;
}

static const char* sz7_res_text(SRes res) {
  switch (res) {
    case SZ_ERROR_DATA: return "data error";
    case SZ_ERROR_MEM: return "out of memory";
    case SZ_ERROR_CRC: return "CRC mismatch";
    case SZ_ERROR_UNSUPPORTED: return "unsupported";
    case SZ_ERROR_INPUT_EOF: return "the archive ends too early";
    case SZ_ERROR_READ: return "read error";
    case SZ_ERROR_ARCHIVE: return "not a valid 7z";
    case SZ_ERROR_NO_ARCHIVE: return "not a 7z";
    case SZ_ERROR_THREAD: return "thread error";
    case SZ_ERROR_WRITE: return "write stopped";
    case SZ_ERROR_PROGRESS: return "stopped";
    default: return "error";
  }
}

// Bloco esperado do LZMA2 pelo dicionario (o mesmo calculo do 7-Zip, CPP/7zip/Compress/Lzma2Decoder.cpp).
static uint64_t sz7_block_for_dict(uint32_t dict) {
  const uint64_t min = 1u << 20, max = 1u << 28;
  uint64_t block = (uint64_t)dict << 2;
  if (block < min) block = min;
  if (block > max) block = max;
  if (block < dict) block = dict;
  return (block + min - 1) & ~(min - 1);
}
static uint32_t sz7_dict(Byte prop) { return prop >= 40 ? 0xFFFFFFFFu : (((uint32_t)2 | (prop & 1)) << (prop / 2 + 11)); }

// Quantos fios cabem: o pedido (nucleos - 1, ate 7; BGDL_7Z_THREADS) limitado pela memoria (BGDL_7Z_MEM_MB) e por uma
// prova de alocacao (malloc de cada fio; o que falhar reduz).
static unsigned sz7_threads(uint64_t per_thread, uint64_t* budget_out) {
  long cpus = sysconf(_SC_NPROCESSORS_ONLN);
  if (cpus < 1) cpus = 4;
  unsigned want = cpus > 1 ? (unsigned)(cpus - 1) : 1;
  if (want > 7) want = 7;
  const char* forced = getenv("BGDL_7Z_THREADS");
  if (forced && atoi(forced) > 0) want = (unsigned)atoi(forced);
  if (want > 16) want = 16;
  const char* mem = getenv("BGDL_7Z_MEM_MB");
  const uint64_t budget = (uint64_t)(mem && atoi(mem) > 0 ? atoi(mem) : 1536) * 1024 * 1024;
  *budget_out = budget;
  const uint64_t fit = per_thread ? budget / per_thread : want;
  if (fit < want) want = fit ? (unsigned)fit : 1;
  if (want <= 1) return 1;
  void* probe[16] = {0};
  unsigned got = 0;
  for (; got < want; ++got) if (!(probe[got] = malloc((size_t)per_thread))) break;
  for (unsigned i = 0; i < got; ++i) free(probe[i]);
  return got > 1 ? got : 1;
}

static int sz7_name_is_7z(const char* path) {
  const char* name = base_name(path);
  const size_t n = strlen(name);
  if (n > 3 && !strcasecmp(name + n - 3, ".7z")) return 1;
  return n > 7 && !strcasecmp(name + n - 7, ".7z.001");
}

static int sz7_extract(Conv* c, const char* work, char* err, size_t cap) {
  static pthread_once_t crc_once = PTHREAD_ONCE_INIT;
  pthread_once(&crc_once, CrcGenerateTable);
  if (getenv("BGDL_7Z_OFF") && atoi(getenv("BGDL_7Z_OFF"))) { snprintf(err, cap, "turned off (BGDL_7Z_OFF)"); return -1; }
  Sz7Vol vol;
  if (sz7_vol_open(&vol, c, err, cap)) return -1;
  Sz7Seek seek = {{sz7_seek_read, sz7_seek_seek}, &vol, 0};
  CLookToRead2 look;
  LookToRead2_CreateVTable(&look, False);
  look.realStream = &seek.vt;
  look.bufSize = 1 << 18;
  look.buf = malloc(look.bufSize);
  CSzArEx db;
  SzArEx_Init(&db);
  int rc = -1;
  Sz7Out out;
  memset(&out, 0, sizeof out);
  out.fd = -1;
  if (!look.buf) { snprintf(err, cap, "out of memory"); goto end; }
  LookToRead2_INIT(&look);
  SRes res = SzArEx_Open(&db, &look.vt, &g_sz7_alloc, &g_sz7_alloc);
  if (res != SZ_OK) {
    snprintf(err, cap, "7z header: %s", sz7_res_text(res)); // cabecalho cifrado, metodo que o SDK nao tem...: a libarchive tenta
    goto end;
  }
  // So pastas de um codec LZMA2 (sem filtro, sem senha).
  uint32_t dict_max = 0;
  for (UInt32 f = 0; f < db.db.NumFolders; ++f) {
    CSzFolder folder;
    CSzData sd = {db.db.CodersData + db.db.FoCodersOffsets[f], db.db.FoCodersOffsets[f + 1] - db.db.FoCodersOffsets[f]};
    if (SzGetNextFolderItem(&folder, &sd) != SZ_OK || folder.NumCoders != 1 || folder.NumPackStreams != 1 || folder.Coders[0].MethodID != k_LZMA2 || folder.Coders[0].PropsSize != 1) {
      snprintf(err, cap, "7z block %u is not plain LZMA2 (method %x)", (unsigned)f, folder.NumCoders ? (unsigned)folder.Coders[0].MethodID : 0u);
      goto end;
    }
    const Byte prop = db.db.CodersData[db.db.FoCodersOffsets[f] + folder.Coders[0].PropsOffset];
    if (prop > 40) { snprintf(err, cap, "7z block %u: bad LZMA2 property", (unsigned)f); goto end; }
    if (sz7_dict(prop) > dict_max) dict_max = sz7_dict(prop);
  }
  rc = 1;
  uint64_t total = 0;
  for (UInt32 f = 0; f < db.db.NumFolders; ++f) total += SzAr_GetFolderUnpackSize(&db.db, f);
  // Pastas e arquivos vazios (sem fluxo) primeiro.
  unsigned skipped = 0;
  for (UInt32 i = 0; i < db.NumFiles; ++i) {
    if (db.FileToFolder[i] != (UInt32)-1) continue;
    char full[1300];
    if (sz7_is_link(&db, i) || !sz7_path(&db, i, work, full, sizeof full)) { ++skipped; continue; }
    if (SzArEx_IsDir(&db, i)) { mkdir_p(full); continue; }
    char parent[1300];
    copy_text(parent, sizeof parent, full);
    char* slash = strrchr(parent, '/');
    if (slash) { *slash = 0; mkdir_p(parent); }
    const int fd = open(full, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0644);
    if (fd < 0) { snprintf(err, cap, "write: %.200s (%s)", base_name(full), strerror(errno)); rc = 0; goto end; }
    close(fd);
    sz7_times(&db, i, full);
  }
  const uint64_t block = sz7_block_for_dict(dict_max);
  const size_t in_mt = 1u << 20;
  const uint64_t per_thread = block + block / 16 + block + in_mt + (1u << 16);
  uint64_t budget = 0;
  unsigned threads = sz7_threads(per_thread, &budget);
  logk_("conversao %s: 7z pelo caminho multinucleo: %u bloco(s) 7z LZMA2, dicionario %u MiB, bloco LZMA2 esperado %llu MiB, %u fio(s) (memoria %llu MiB, %llu MiB por fio), %.2f GB descompactados",
        c->id, (unsigned)db.db.NumFolders, (unsigned)(dict_max >> 20), (unsigned long long)(block >> 20), threads, (unsigned long long)(budget >> 20),
        (unsigned long long)(per_thread >> 20), conv_gb(total));
  conv_extract_tick(c, 0, total, 0);
  const int64_t started = mono_ms();
  out.vt.Write = sz7_out_write;
  out.c = c;
  out.db = &db;
  out.work = work;
  out.skipped = skipped;
  int any_mt = 0, all_mt = 1;
  for (UInt32 f = 0; rc == 1 && f < db.db.NumFolders; ++f) {
    CSzFolder folder;
    CSzData sd = {db.db.CodersData + db.db.FoCodersOffsets[f], db.db.FoCodersOffsets[f + 1] - db.db.FoCodersOffsets[f]};
    SzGetNextFolderItem(&folder, &sd);
    const Byte prop = db.db.CodersData[db.db.FoCodersOffsets[f] + folder.Coders[0].PropsOffset];
    const UInt32 pack_index = db.db.FoStartPackStreamIndex[f];
    const uint64_t pack_pos = db.dataPos + db.db.PackPositions[pack_index];
    const uint64_t pack_size = db.db.PackPositions[pack_index + 1] - db.db.PackPositions[pack_index];
    const UInt64 unpack = SzAr_GetFolderUnpackSize(&db.db, f);
    for (unsigned attempt = 0; attempt < 2; ++attempt) {
      const uint64_t done_before = out.done;
      const UInt32 first = db.FolderToFile[f];
      const unsigned skipped_before = out.skipped;
      out.folder = f;
      out.next_file = first;
      out.folder_crc = CRC_INIT_VAL;
      out.error = 0;
      out.err[0] = 0;
      out.discard = 0;
      out.head = out.tail = out.finish = out.stop = 0;
      Sz7In in;
      memset(&in, 0, sizeof in);
      if (sz7_in_start(&in, &vol, pack_pos, pack_size) || sz7_out_start(&out)) {
        sz7_in_stop(&in);
        sz7_out_stop(&out);
        snprintf(err, cap, "out of memory");
        rc = -1;
        break;
      }
      out.in = &in;
      CLzma2DecMtProps mt;
      Lzma2DecMtProps_Init(&mt);
      mt.inBufSize_ST = 4u << 20;
      mt.outStep_ST = 4u << 20;
      mt.numThreads = threads;
      mt.inBufSize_MT = in_mt;
      mt.outBlockMax = (size_t)block;
      mt.inBlockMax = (size_t)(block + block / 16);
      CLzma2DecMtHandle dec = Lzma2DecMt_Create(&g_sz7_alloc, &g_sz7_alloc);
      Sz7Progress progress = {{sz7_progress}, c};
      UInt64 in_done = 0;
      int is_mt = 0;
      res = dec ? Lzma2DecMt_Decode(dec, prop, &mt, &out.vt, &unpack, 1, &in.vt, &in_done, &is_mt, &progress.vt) : SZ_ERROR_MEM;
      if (dec) Lzma2DecMt_Destroy(dec);
      int bad = res != SZ_OK || sz7_out_drain(&out);
      // o fio de gravacao ja parou de mexer (fila vazia): os arquivos de tamanho zero no fim da pasta e o que faltou
      if (!bad && (out.fd >= 0 || out.discard) && out.left) { snprintf(out.err, sizeof out.err, "source: the 7z block ended before its files (the archive is damaged)"); bad = 1; }
      if (!bad && (out.fd >= 0 || out.discard) && sz7_close_file(&out)) bad = 1;
      while (!bad) {
        const int opened = sz7_open_next(&out);
        if (opened <= 0) { bad = opened < 0; break; }
        if (out.left) { snprintf(out.err, sizeof out.err, "source: the 7z block ended before its files (the archive is damaged)"); bad = 1; break; }
        if (sz7_close_file(&out)) bad = 1;
      }
      if (!bad && SzBitWithVals_Check(&db.db.FolderCRCs, f) && CRC_GET_DIGEST(out.folder_crc) != db.db.FolderCRCs.Vals[f]) {
        snprintf(out.err, sizeof out.err, "source: CRC mismatch in the 7z block %u (the archive is damaged)", (unsigned)f);
        bad = 1;
      }
      const uint64_t consumed = in.consumed;
      out.in = NULL;
      sz7_out_stop(&out);
      sz7_in_stop(&in);
      if (is_mt) any_mt = 1; else all_mt = 0;
      if (!bad) { out.read_base += consumed; break; }
      if (c->cancel || g_stop) { snprintf(err, cap, "stopped"); rc = 0; break; }
      if (res == SZ_ERROR_MEM && !out.err[0] && attempt == 0 && threads > 1) {
        logk_("conversao %s: 7z: sem memoria com %u fios; de novo com 1", c->id, threads);
        threads = 1;
        out.done = done_before;
        out.skipped = skipped_before;
        continue;
      }
      if (res == SZ_ERROR_MEM && !out.err[0]) { snprintf(err, cap, "7z: out of memory"); rc = -1; break; }
      if (out.err[0]) snprintf(err, cap, "%s", out.err);
      else snprintf(err, cap, "source: %s in the 7z (the archive is damaged)", sz7_res_text(res));
      rc = 0;
      break;
    }
  }
  if (rc == 1) {
    const double secs = (double)(mono_ms() - started) / 1000.0;
    logk_("conversao %s: 7z extraido em %.1f s (%.1f MB/s descompactados, %s)", c->id, secs, secs > 0 ? (double)out.done / 1e6 / secs : 0.0,
          all_mt && any_mt ? "varios nucleos" : any_mt ? "varios nucleos em parte" : "um nucleo: LZMA2 de um bloco so ou um fio");
    if (out.skipped) logk_("conversao %s: extracao pulou %u entrada(s) (link, hardlink, tipo especial ou nome invalido)", c->id, out.skipped);
  }
end:
  SzArEx_Free(&db, &g_sz7_alloc);
  free(look.buf);
  sz7_vol_close(&vol);
  return rc;
}
