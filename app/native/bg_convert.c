// glibren.12: conversao dos jogos de PS5 para .exfat no payload (incluido por bg_downloader.c, "unity build").
//
// O app (download-queue.js) entrega a conversao depois do download (e da extracao, que continua no app): a pasta do
// jogo ja extraida (kind "dir") ou o .pkg de PS5 (kind "pkg", lido direto do pacote por pkg_source.c). Aqui ela roda
// numa thread so, UMA conversao por vez, e continua com o app fechado. Os downloads seguem ao mesmo tempo (dividem o
// disco; nada e pausado): a conversao le e grava em fluxo, sem segurar a rede, e pausar um download do TorBox faria o
// link vencer.
//
// Passos: lista os arquivos (exw_list_dir / pkgsrc_entries) -> calcula a imagem (exw_plan_image) -> confere o espaco
// -> grava <output>.part (exw_write, em fluxo, com progresso e cancelamento) -> confere (exw_verify com amostra) ->
// renomeia para <output> (.exfat) -> apaga a pasta de trabalho -> pede uma varredura ao ShadowMount+ (POST /scan).
// O original fica no BACKUP (o app o move antes). Em erro: o .part e apagado e nada mais e tocado (a pasta extraida e o
// original continuam), o app oferece "Tentar de novo" e "Usar sem converter".
// Reinicio no meio (payload parado, console desligado): a conversao volta para a fila e RECOMECA LIMPA (o .part e
// apagado); nao ha retomada no meio de uma imagem.
//
// API local (127.0.0.1, com o token):
//   POST /convert {key, name, kind:"dir"|"pkg", source, output, work?, label?, root}
//        -> 201 {id, state} (nova) | 200 {id, state, attached:true} (a mesma chave ja existe: acompanha a que existe;
//           uma falha ou cancelada com a mesma chave recomeca)
//   GET  /convert                     {conversions:[...]}
//   POST /convert/<id>/cancel         para (o .part e apagado)
//   POST /convert/<id>/forget         esquece uma que terminou (done/failed/cancelled)
// Pagina do celular (porta 34201): /api/status leva "conversions" (nome, estado, progresso, erro, sem caminhos);
//   GET  /api/backup                  {games:[{root, name, bytes, files}], totalBytes}
//   POST /api/backup/delete {root, name}   com a sessao do PIN: apaga <root>/BACKUP/<name>
// Erros comecam por um codigo que o app traduz: "space:", "not-a-game:", "source:", "write:", "verify:".
#include <archive.h>
#include <archive_entry.h>
#include <dirent.h>
#ifdef __PROSPERO__
#include <sys/mount.h> // pac1: statfs (f_fstypename)
#else
#include <sys/vfs.h>
#endif

#include "exfat_writer.c"
#include "pkg_source.c"

#define MAX_CONVS 32
#define ARC_MAX_VOLUMES 8
#define ARC_MAX_PASSWORDS 8
#define CONV_MARGIN (64ull * 1024 * 1024)

static int session_ok(const char* given);
static int monitor_allowed(const Request* r); // pareamento (bg_pair.c): 127.0.0.1, aparelho pareado ou sessao do PIN
static void monitor_json(int fd, int status, const char* body);
static void monitor_send(int fd, int status, const char* type, const void* body, size_t size); // glibren.20: /api/log
static const char* base_name(const char* path);

typedef struct {
  char id[24], key[128], name[256];
  char kind[8];           // "dir" | "pkg" | "archive"
  char sources[ARC_MAX_VOLUMES][1024]; // "archive": os volumes, o primeiro primeiro (source = o primeiro)
  int nsources;
  char passwords[ARC_MAX_PASSWORDS][128]; // "archive": as senhas a tentar (as publicas dos sites, como no app)
  int npasswords;
  char source[1024], output[1024], work[1024], root[1024];
  char label[32];
  char state[16]; // queued converting verifying done failed cancelled
  char error[600];
  uint64_t written, total, image_bytes;
  int64_t created, updated;
  volatile int cancel;
  int running;
  // glibren.41 (J4): o conv_loop ainda usa esta conversao (do inicio do conv_run ao fim do ciclo: aviso, varredura do
  // ShadowMount, marcos, extracao). Enquanto 1, ninguem a libera da memoria (esquecer, abrir vaga).
  int in_use;
  // glibren.58: o progresso da extracao de um compactado (conv_extract_in_place), so na memoria (nao vai ao
  // conversions.json; uma extracao parada recomeca do zero). GET /convert e /api/status levam os campos "extract*".
  char ext_format[12];          // "7z", "zip", "rar", "tar", "tar.gz", "tar.xz", "tar.bz2", "tar.zst" ("" = outro)
  uint64_t unpacked;            // arc_plan: soma dos tamanhos descompactados das entradas (0 = alguma sem tamanho)
  uint64_t ext_done, ext_total; // bytes descompactados gravados / total descompactado (0 = nao se sabe)
  uint64_t arc_read, arc_bytes; // bytes lidos do compactado / tamanho do compactado (os volumes somados)
  double ext_bps, arc_bps;      // media movel (bytes por segundo) do descompactado e do lido do compactado
  uint64_t ext_last_done, arc_last_read;
  int64_t ext_last_ms;
} Conv;

static pthread_mutex_t g_conv_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_conv_wake = PTHREAD_COND_INITIALIZER;
static Conv* g_convs[MAX_CONVS];
static int g_conv_count;
static unsigned g_conv_next;
static char g_smp_base[256] = "http://127.0.0.1:10101/api/v1";
static int g_conv_delay_ms; // testes: espera por passo de progresso (BGDL_CONVERT_DELAY_MS)

// ---- pac1: marcos da conversao no diario ----
// Cada passo grande da conversao vira uma linha "conversao <id> [marco] <passo>" gravada com fsync na hora (logk_),
// para sobreviver a uma queda do console: inicio (jogo, origem, destino), origem aberta, plano (tamanho), arquivo .exfat
// criado, inicio da escrita, progresso a cada g_conv_mark_bytes (1 GiB; BGDL_MARK_BYTES nos testes) com MB/s, fim da
// escrita, fsync/fechamento, conferencia, rename, pedido ao ShadowMount+ (rota e resposta) e fim. So os marcos levam
// fsync (as outras linhas seguem a regra de sempre, no maximo a cada 2 s). O last-crash.json traz o ultimo marco.
#define MARK_TAG "[marco] "
static uint64_t g_conv_mark_bytes = 1024ull * 1024 * 1024;
static void conv_mark(const Conv* c, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
static void conv_mark(const Conv* c, const char* fmt, ...) {
  char text[900];
  va_list args;
  va_start(args, fmt);
  vsnprintf(text, sizeof text, fmt, args);
  va_end(args);
  logk_("conversao %s " MARK_TAG "%s", c->id, text);
}
static double conv_gb(uint64_t bytes) { return (double)bytes / 1e9; }
// Os marcos de dentro do exw_write (exfat_writer.c chama exw_mark_hook; o harness de teste nao liga).
static void conv_writer_mark(void* ctx, const char* stage, uint64_t a, uint64_t b) {
  const Conv* c = ctx;
  if (!strcmp(stage, "created")) conv_mark(c, "arquivo .exfat criado: %s.part (tamanho final %.2f GB, estendido no fim)", c->output, conv_gb(a));
  else if (!strcmp(stage, "data-start")) conv_mark(c, "escrita do exFAT: inicio dos dados (0 de %.2f GB)", conv_gb(a));
  else if (!strcmp(stage, "data-end")) conv_mark(c, "escrita do exFAT: fim dos dados (%.2f GB)", conv_gb(a));
  else if (!strcmp(stage, "sync")) conv_mark(c, "fsync da imagem (%.2f GB)", conv_gb(a));
  else if (!strcmp(stage, "closed")) conv_mark(c, "imagem fechada%s", b ? " (com erro)" : "");
  else if (!strcmp(stage, "fsync")) conv_mark(c, "gravar em pedacos: fsync em %.2f GB levou %llu ms", conv_gb(a), (unsigned long long)b);
}
// pac1: o disco de um caminho para os marcos: tipo do sistema de arquivos (statfs: f_fstypename no PS5/FreeBSD, o
// numero magico no Linux), livre e total.
static void conv_disk_info(const char* path, char* out, size_t cap) {
  char fstype[32] = "?";
  uint64_t free_bytes = 0, total_bytes = 0;
  struct statfs sf;
  if (!statfs(path, &sf)) {
#ifdef __PROSPERO__
    size_t n = strnlen(sf.f_fstypename, sizeof sf.f_fstypename);
    if (n >= sizeof fstype) n = sizeof fstype - 1;
    memcpy(fstype, sf.f_fstypename, n);
    fstype[n] = 0;
#else
    const unsigned long magic = (unsigned long)sf.f_type;
    const char* name = magic == 0x2011BAB0UL ? "exfat" : magic == 0xEF53UL ? "ext4" : magic == 0x01021994UL ? "tmpfs" :
                       magic == 0x4D44UL ? "msdos" : magic == 0x5346544EUL ? "ntfs" : magic == 0x9123683EUL ? "btrfs" :
                       magic == 0x58465342UL ? "xfs" : magic == 0x794C7630UL ? "overlay" : magic == 0x65735546UL ? "fuse" : NULL;
    if (name) memcpy(fstype, name, strlen(name) + 1); // todos bem menores que fstype
    else snprintf(fstype, sizeof fstype, "0x%lx", magic);
#endif
    free_bytes = (uint64_t)sf.f_bavail * (uint64_t)sf.f_bsize;
    total_bytes = (uint64_t)sf.f_blocks * (uint64_t)sf.f_bsize;
    snprintf(out, cap, "%s, livre %.1f GB de %.1f GB", fstype, conv_gb(free_bytes), conv_gb(total_bytes));
  } else {
    snprintf(out, cap, "statfs falhou: %s", strerror(errno));
  }
}

// ---- pac1: pausa entre conversoes ----
// g_conv_pause_s (bg_downloader.c, POST /config "convertPauseSeconds"; 0 = desligada): depois de uma conversao que
// trabalhou (pronta, falhou depois de gravar, ou extraida), a PROXIMA conversao diferente so comeca depois desse tempo,
// contado do fim. Mudar a opcao vale na hora. GET /convert e /api/status levam "waitSeconds" (o que falta, com uma na fila).
static int64_t g_conv_last_end_ms; // mono_ms do fim da ultima que trabalhou; 0 = nenhuma
static char g_conv_last_id[24];
static int64_t conv_wait_left_ms_locked(const Conv* next) {
  if (g_conv_pause_s <= 0 || !g_conv_last_end_ms) return 0;
  if (next && !strcmp(next->id, g_conv_last_id)) return 0; // a mesma (extraida agora, converte em seguida)
  const int64_t left = g_conv_last_end_ms + (int64_t)g_conv_pause_s * 1000 - mono_ms();
  return left > 0 ? left : 0;
}
static int conv_wait_seconds_locked(void) {
  Conv* next = NULL;
  for (int i = 0; i < g_conv_count && !next; ++i) if (!strcmp(g_convs[i]->state, "queued")) next = g_convs[i];
  if (!next) return 0;
  const int64_t left = conv_wait_left_ms_locked(next);
  return (int)((left + 999) / 1000);
}

static int conv_terminal(const char* state) { return !strcmp(state, "done") || !strcmp(state, "failed") || !strcmp(state, "cancelled"); }

// ---- glibren.58: progresso da extracao ----
// O formato pelo nome do primeiro volume (o que a tela mostra: "Extraindo do .7z").
static void conv_archive_format(const char* path, char* out, size_t cap) {
  static const struct { const char* ext; const char* format; } kinds[] = {
    {".tar.gz", "tar.gz"}, {".tgz", "tar.gz"}, {".tar.xz", "tar.xz"}, {".txz", "tar.xz"}, {".tar.bz2", "tar.bz2"},
    {".tar.zst", "tar.zst"}, {".tar", "tar"}, {".7z", "7z"}, {".zip", "zip"}, {".rar", "rar"}, {".xz", "xz"}, {".lzma", "lzma"}};
  char name[300];
  copy_text(name, sizeof name, base_name(path));
  size_t n = strlen(name);
  // volumes: nome.7z.001, nome.zip.001 -> pelo que vem antes do numero; nome.r00 -> rar
  if (n > 4 && name[n - 4] == '.' && isdigit((unsigned char)name[n - 1]) && isdigit((unsigned char)name[n - 2])) {
    if (name[n - 3] == 'r' || name[n - 3] == 'R') { copy_text(out, cap, "rar"); return; }
    if (isdigit((unsigned char)name[n - 3])) { name[n - 4] = 0; n -= 4; }
  }
  for (size_t i = 0; i < sizeof kinds / sizeof *kinds; ++i) {
    const size_t e = strlen(kinds[i].ext);
    if (n > e && !strcasecmp(name + n - e, kinds[i].ext)) { copy_text(out, cap, kinds[i].format); return; }
  }
  out[0] = 0;
}
// LZMA/LZMA2 (7z, xz): a descompressao e o gargalo, nao o disco (Alan Wake 2, 91,7 GB em .7z: ~15 MB/s no PS5).
static int conv_cpu_bound_format(const char* format) {
  return !strcmp(format, "7z") || !strcmp(format, "tar.xz") || !strcmp(format, "xz") || !strcmp(format, "lzma");
}
// Um passo da extracao: `done` bytes descompactados gravados; `total` (0 = mantem) o total descompactado; `read` (0 =
// mantem) os bytes lidos do compactado. A velocidade e uma media movel recalculada a cada 1 s. Tambem poe written/total
// (como o rar-extract ja fazia), para os clientes antigos verem a barra andar.
static void conv_extract_tick(Conv* c, uint64_t done, uint64_t total, uint64_t read) {
  const int64_t now = mono_ms();
  pthread_mutex_lock(&g_conv_lock);
  c->ext_done = done;
  if (total) c->ext_total = total;
  if (c->ext_total && done > c->ext_total) c->ext_total = done; // um cabecalho que mentiu o tamanho
  if (read) c->arc_read = c->arc_bytes && read > c->arc_bytes ? c->arc_bytes : read;
  if (!c->ext_last_ms) {
    c->ext_last_ms = now;
    c->ext_last_done = done;
    c->arc_last_read = c->arc_read;
  } else if (now - c->ext_last_ms >= 1000) {
    const double secs = (double)(now - c->ext_last_ms) / 1000.0;
    const double rate = done >= c->ext_last_done ? (double)(done - c->ext_last_done) / secs : 0;
    const double arate = c->arc_read >= c->arc_last_read ? (double)(c->arc_read - c->arc_last_read) / secs : 0;
    c->ext_bps = c->ext_bps > 0 ? c->ext_bps * 0.7 + rate * 0.3 : rate;
    c->arc_bps = c->arc_bps > 0 ? c->arc_bps * 0.7 + arate * 0.3 : arate;
    c->ext_last_ms = now;
    c->ext_last_done = done;
    c->arc_last_read = c->arc_read;
  }
  c->written = done;
  c->total = c->ext_total;
  pthread_mutex_unlock(&g_conv_lock);
}
// Comeco de uma extracao: zera o progresso, o formato e o tamanho do compactado (os volumes somados).
static void conv_extract_begin(Conv* c) {
  uint64_t bytes = 0;
  struct stat st;
  if (c->nsources) {
    for (int i = 0; i < c->nsources; ++i) if (!stat(c->sources[i], &st)) bytes += (uint64_t)st.st_size;
  } else if (!stat(c->source, &st)) {
    bytes = (uint64_t)st.st_size;
  }
  pthread_mutex_lock(&g_conv_lock);
  conv_archive_format(c->source, c->ext_format, sizeof c->ext_format);
  c->ext_done = c->arc_read = 0;
  c->ext_total = c->unpacked;
  c->arc_bytes = bytes;
  c->ext_bps = c->arc_bps = 0;
  c->ext_last_done = c->arc_last_read = 0;
  c->ext_last_ms = 0;
  c->written = 0;
  c->total = c->ext_total;
  pthread_mutex_unlock(&g_conv_lock);
}
// Os campos da extracao no JSON (aditivos; com o estado "extracting" valem, nos outros vem zerados):
//   extractFormat  "7z" | "zip" | "rar" | "tar" | "tar.gz" | "tar.xz" | "tar.bz2" | "tar.zst" | "xz" | "lzma" | ""
//   extracted      bytes descompactados ja gravados
//   extractTotal   total descompactado (soma dos tamanhos das entradas nos cabecalhos; 0 = nao se sabe)
//   archiveRead    bytes lidos do compactado (archive_filter_bytes; 0 no RAR, que roda noutro processo)
//   archiveBytes   tamanho do compactado (os volumes somados)
//   extractBytesPerSecond  media movel dos bytes descompactados por segundo
//   extractPercent 0-100 (extracted/extractTotal; sem o total, archiveRead/archiveBytes); -1 = nao se sabe
//   extractEtaSeconds  o tempo restante pela mesma base do percentual; -1 = nao se sabe
//   limitedBy      "cpu" quando o formato e LZMA (7z, xz): o processador e o gargalo, nao o disco; "" nos outros
//   target         o nome do arquivo de destino (homebrew/<codigo>.exfat, sem a pasta), para a tela juntar a falha
//                  antiga do mesmo item com a conversao nova
static void conv_extract_json(Buf* b, const Conv* c) {
  const int on = !strcmp(c->state, "extracting");
  int percent = -1;
  long long eta = -1;
  if (on && c->ext_total) {
    percent = (int)(c->ext_done >= c->ext_total ? 100 : c->ext_done * 100 / c->ext_total);
    if (c->ext_bps >= 1) eta = (long long)((double)(c->ext_total - (c->ext_done < c->ext_total ? c->ext_done : c->ext_total)) / c->ext_bps + 0.5);
  } else if (on && c->arc_bytes && c->arc_read) {
    percent = (int)(c->arc_read >= c->arc_bytes ? 100 : c->arc_read * 100 / c->arc_bytes);
    if (c->arc_bps >= 1) eta = (long long)((double)(c->arc_bytes - c->arc_read) / c->arc_bps + 0.5);
  }
  buf_str(b, ",\"extractFormat\":"); buf_json(b, on ? c->ext_format : "");
  buf_fmt(b, ",\"extracted\":%llu,\"extractTotal\":%llu,\"archiveRead\":%llu,\"archiveBytes\":%llu,\"extractBytesPerSecond\":%llu,\"extractPercent\":%d,\"extractEtaSeconds\":%lld",
          (unsigned long long)(on ? c->ext_done : 0), (unsigned long long)(on ? c->ext_total : 0), (unsigned long long)(on ? c->arc_read : 0),
          (unsigned long long)(on ? c->arc_bytes : 0), (unsigned long long)(on && c->ext_bps > 0 ? c->ext_bps + 0.5 : 0), percent, eta);
  buf_str(b, ",\"limitedBy\":"); buf_json(b, on && conv_cpu_bound_format(c->ext_format) ? "cpu" : "");
  buf_str(b, ",\"target\":"); buf_json(b, base_name(c->output));
}

static void conv_json(Buf* b, const Conv* c, int for_phone) {
  buf_str(b, "{\"id\":"); buf_json(b, c->id);
  buf_str(b, ",\"key\":"); buf_json(b, for_phone ? "" : c->key);
  buf_str(b, ",\"name\":"); buf_json(b, c->name);
  buf_str(b, ",\"state\":"); buf_json(b, c->state);
  buf_str(b, ",\"error\":"); buf_json(b, c->error);
  if (!for_phone) {
    buf_str(b, ",\"kind\":"); buf_json(b, c->kind);
    buf_str(b, ",\"source\":"); buf_json(b, c->source);
    buf_str(b, ",\"output\":"); buf_json(b, c->output);
    buf_str(b, ",\"work\":"); buf_json(b, c->work);
    buf_str(b, ",\"root\":"); buf_json(b, c->root);
    buf_str(b, ",\"label\":"); buf_json(b, c->label);
    buf_str(b, ",\"sources\":[");
    for (int i = 0; i < c->nsources; ++i) { if (i) buf_str(b, ","); buf_json(b, c->sources[i]); }
    buf_str(b, "],\"passwords\":[");
    for (int i = 0; i < c->npasswords; ++i) { if (i) buf_str(b, ","); buf_json(b, c->passwords[i]); }
    buf_str(b, "]");
    buf_fmt(b, ",\"imageBytes\":%llu,\"created\":%lld,\"updated\":%lld", (unsigned long long)c->image_bytes, (long long)c->created, (long long)c->updated);
  }
  conv_extract_json(b, c); // glibren.58
  buf_fmt(b, ",\"written\":%llu,\"total\":%llu}", (unsigned long long)c->written, (unsigned long long)c->total);
}

static void conv_save_locked(void) {
  Buf b = {0};
  buf_fmt(&b, "{\"version\":1,\"next\":%u,\"conversions\":[", g_conv_next);
  for (int i = 0; i < g_conv_count; ++i) {
    if (i) buf_str(&b, ",");
    conv_json(&b, g_convs[i], 0);
  }
  buf_str(&b, "]}\n");
  char path[600];
  snprintf(path, sizeof path, "%s/conversions.json", g_dir);
  if (b.failed || !save_atomic(path, b.data, b.size, 0600)) logf_("conversoes nao salvas: %s", strerror(errno));
  free(b.data);
}

static int conv_source_item(JP* jp, void* ctx) {
  Conv* c = ctx;
  if (c->nsources >= ARC_MAX_VOLUMES) return jp_skip(jp);
  return jp_text(jp, c->sources[c->nsources++], sizeof c->sources[0]);
}
static int conv_password_item(JP* jp, void* ctx) {
  Conv* c = ctx;
  if (c->npasswords >= ARC_MAX_PASSWORDS) return jp_skip(jp);
  return jp_text(jp, c->passwords[c->npasswords++], sizeof c->passwords[0]);
}

static int conv_field(JP* jp, const char* key, void* ctx) {
  Conv* c = ctx;
  if (!strcmp(key, "sources")) { c->nsources = 0; return jp_array(jp, conv_source_item, c) ? 1 : -1; }
  if (!strcmp(key, "passwords")) { c->npasswords = 0; return jp_array(jp, conv_password_item, c) ? 1 : -1; }
#define CTEXT(name, field) if (!strcmp(key, name)) return jp_text(jp, c->field, sizeof c->field) ? 1 : -1
  CTEXT("id", id);
  CTEXT("key", key);
  CTEXT("name", name);
  CTEXT("kind", kind);
  CTEXT("source", source);
  CTEXT("output", output);
  CTEXT("work", work);
  CTEXT("root", root);
  CTEXT("label", label);
  CTEXT("state", state);
  CTEXT("error", error);
#undef CTEXT
  if (!strcmp(key, "written")) return jp_uint(jp, &c->written) ? 1 : -1;
  if (!strcmp(key, "total")) return jp_uint(jp, &c->total) ? 1 : -1;
  if (!strcmp(key, "imageBytes")) return jp_uint(jp, &c->image_bytes) ? 1 : -1;
  if (!strcmp(key, "created")) return jp_int64(jp, &c->created) ? 1 : -1;
  if (!strcmp(key, "updated")) return jp_int64(jp, &c->updated) ? 1 : -1;
  return 0;
}

// Caminho de `path` dentro de `dir` (dir + "/" + algo)?
static int conv_inside(const char* path, const char* dir) {
  const size_t n = strlen(dir);
  return n && !strncmp(path, dir, n) && path[n] == '/' && path[n + 1];
}

// Os caminhos de uma conversao: tudo absoluto e no mesmo disco (root); a imagem em <root>/homebrew/<nome>.exfat; a
// pasta de trabalho (apagada no fim) so dentro de <root>/downloads/, e a fonte "dir" dentro dela quando houver.
static int conv_validate(Conv* c, char* error, size_t cap) {
  char homebrew[1100], downloads[1100];
  if (!c->key[0] || !queue_key_ok(c->key)) { snprintf(error, cap, "key"); return 0; }
  if (strcmp(c->kind, "dir") && strcmp(c->kind, "pkg") && strcmp(c->kind, "archive")) { snprintf(error, cap, "kind must be dir, pkg or archive"); return 0; }
  if (!strcmp(c->kind, "archive")) {
    if (!c->nsources) { snprintf(error, cap, "archive needs its sources"); return 0; }
    for (int i = 0; i < c->nsources; ++i)
      if (!safe_path(c->sources[i]) || !conv_inside(c->sources[i], c->root)) { snprintf(error, cap, "sources must be on the same drive (root)"); return 0; }
    snprintf(c->source, sizeof c->source, "%s", c->sources[0]);
  } else {
    c->nsources = 0;
  }
  if (!safe_path(c->root) || !safe_path(c->source) || !safe_path(c->output) || (c->work[0] && !safe_path(c->work))) {
    snprintf(error, cap, "paths must be absolute"); return 0;
  }
  snprintf(homebrew, sizeof homebrew, "%s/homebrew", c->root);
  snprintf(downloads, sizeof downloads, "%s/downloads", c->root);
  const size_t out = strlen(c->output);
  if (!conv_inside(c->output, homebrew) || strchr(c->output + strlen(homebrew) + 1, '/') || out < 7 || strcasecmp(c->output + out - 6, ".exfat")) {
    snprintf(error, cap, "output must be <root>/homebrew/<name>.exfat"); return 0;
  }
  if (!conv_inside(c->source, c->root)) { snprintf(error, cap, "source must be on the same drive (root)"); return 0; }
  // glibren.41 (J1): a pasta de trabalho tambem pode ser a da extracao (<root>/BACKUP/_temp/<id>, conv_extract_in_place):
  // antes uma conversao que ja tinha extraido era descartada ao reiniciar e a pasta extraida ficava no disco para sempre.
  char temp[1100];
  snprintf(temp, sizeof temp, "%s/BACKUP/_temp", c->root);
  if (c->work[0] && (!(conv_inside(c->work, downloads) || conv_inside(c->work, temp)) ||
                     (!strcmp(c->kind, "dir") && strcmp(c->source, c->work) && !conv_inside(c->source, c->work)))) {
    snprintf(error, cap, "work must be inside <root>/downloads (or BACKUP/_temp) and hold the source"); return 0;
  }
  if (strlen(c->label) > 11) c->label[11] = 0;
  return 1;
}

static int g_lock_contended; // definida em bg_downloader.c (outra copia viva: nao foi queda); declaracao provisoria do C
static void conv_load(void) {
  char path[600];
  snprintf(path, sizeof path, "%s/conversions.json", g_dir);
  size_t size = 0;
  char* text = read_text(path, 4 * 1024 * 1024, &size);
  if (!text) return;
  JP jp = {text, text + size, 0};
  jp_ws(&jp);
  // {"version":1,"next":N,"conversions":[{...}]}: lido a mao (so os dois campos que importam).
  const char* list = strstr(text, "\"conversions\"");
  const char* next = strstr(text, "\"next\":");
  if (next) g_conv_next = (unsigned)strtoul(next + 7, NULL, 10);
  if (list && (list = strchr(list, '['))) {
    jp.p = list + 1;
    for (;;) {
      jp_ws(&jp);
      if (jp.p >= jp.end || *jp.p != '{') break;
      Conv* c = calloc(1, sizeof *c);
      if (!c) break;
      char error[200];
      if (!jp_object(&jp, conv_field, c) || g_conv_count >= MAX_CONVS || !c->id[0] || !conv_validate(c, error, sizeof error)) {
        if (c->id[0]) logf_("conversao %s descartada ao iniciar: %s", c->id, g_conv_count >= MAX_CONVS ? "lista cheia" : error);
        free(c);
      } else {
        // Parada no meio. Saida limpa (o app parou o payload, atualizacao): recomeca limpa (o .part some quando ela rodar
        // de novo). glibren.41 (J2): queda (o console desligou, o processo morreu): fica "falhou" com o motivo e so volta
        // com "Converter agora" - se foi ela que derrubou o console, recomecar sozinha derrubaria de novo, em laco.
        if (!strcmp(c->state, "converting") || !strcmp(c->state, "verifying") || !strcmp(c->state, "extracting") || !c->state[0]) {
          const int queda = c->state[0] && g_previous_seen && !g_lock_contended && !strstr(g_previous_last, CLEAN_EXIT_MARK);
          if (!g_crash_conv[0] && c->state[0]) copy_text(g_crash_conv, sizeof g_crash_conv, c->name[0] ? c->name : c->id); // pac1
          c->written = 0;
          if (queda) {
            snprintf(c->state, sizeof c->state, "failed");
            copy_text(c->error, sizeof c->error, "interrupted: the console went down while this conversion was running; tap Convert to try again");
            c->updated = now_s();
            logf_("conversao %s (%s): estava rodando quando o console caiu; segurada ate Converter de novo", c->id, c->name);
          } else {
            snprintf(c->state, sizeof c->state, "queued");
            logf_("conversao %s (%s): parada no meio; recomeca do zero", c->id, c->name);
          }
        }
        g_convs[g_conv_count++] = c;
      }
      jp_ws(&jp);
      if (jp.p < jp.end && *jp.p == ',') { ++jp.p; continue; }
      break;
    }
  }
  free(text);
}

static Conv* conv_find_locked(const char* id) {
  for (int i = 0; i < g_conv_count; ++i) if (!strcmp(g_convs[i]->id, id)) return g_convs[i];
  return NULL;
}
static Conv* conv_by_source_locked(const char* source); // glibren.18 (abaixo)
static Conv* conv_by_key_locked(const char* key) {
  for (int i = 0; i < g_conv_count; ++i) if (!strcmp(g_convs[i]->key, key)) return g_convs[i];
  return NULL;
}

// Apaga uma arvore sem seguir links simbolicos (o link e apagado, o destino nao). 0 = ok.
static int conv_remove_tree(const char* path, int depth) {
  struct stat st;
  if (lstat(path, &st)) return errno == ENOENT ? 0 : -1;
  if (!S_ISDIR(st.st_mode)) return unlink(path);
  if (depth > 64) return -1;
  DIR* d = opendir(path);
  if (!d) return -1;
  int rc = 0;
  for (struct dirent* it; (it = readdir(d));) {
    if (!strcmp(it->d_name, ".") || !strcmp(it->d_name, "..")) continue;
    char child[4096];
    snprintf(child, sizeof child, "%s/%s", path, it->d_name);
    if (conv_remove_tree(child, depth + 1)) rc = -1;
  }
  closedir(d);
  return rc || rmdir(path) ? -1 : 0;
}

// Tamanho e quantidade de arquivos de uma arvore (sem seguir links).
static void conv_tree_size(const char* path, int depth, uint64_t* bytes, unsigned* files) {
  struct stat st;
  if (lstat(path, &st) || depth > 8) return;
  if (S_ISREG(st.st_mode)) { *bytes += (uint64_t)st.st_size; ++*files; return; }
  if (!S_ISDIR(st.st_mode)) return;
  DIR* d = opendir(path);
  if (!d) return;
  for (struct dirent* it; (it = readdir(d));) {
    if (!strcmp(it->d_name, ".") || !strcmp(it->d_name, "..") || !strcmp(it->d_name, ".jobe-backup.json")) continue;
    char child[4096];
    snprintf(child, sizeof child, "%s/%s", path, it->d_name);
    conv_tree_size(child, depth + 1, bytes, files);
  }
  closedir(d);
}

static uint64_t conv_free_bytes(const char* root) {
  if (g_fake_free) return g_fake_free;
  struct statvfs vfs;
  if (statvfs(root, &vfs)) return UINT64_MAX;
  return (uint64_t)vfs.f_bavail * (uint64_t)vfs.f_frsize;
}

// Pede ao ShadowMount+ uma varredura (POST /api/v1/scan), para o jogo novo aparecer sem esperar a proxima (15 s por
// padrao). Sem resposta: tudo bem, a varredura periodica dele acha a imagem em homebrew/.
static size_t conv_discard(char* data, size_t size, size_t count, void* opaque) {
  (void)data;
  (void)opaque;
  return size * count;
}
static void conv_ask_scan(const Conv* c) {
  if (!g_smp_base[0]) return;
  CURL* curl = curl_easy_init();
  if (!curl) return;
  char url[300];
  snprintf(url, sizeof url, "%s/scan", g_smp_base);
  conv_mark(c, "ShadowMount+: POST %s", url); // pac1
  struct curl_slist* headers = curl_slist_append(NULL, "Content-Type: application/json");
  curl_easy_setopt(curl, CURLOPT_URL, url);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, "{\"reset_attempts\":false}");
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, conv_discard);
  const CURLcode result = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  conv_mark(c, "ShadowMount+: resposta %s, HTTP %ld", result == CURLE_OK ? "ok" : curl_easy_strerror(result), status);
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
}

typedef struct {
  Conv* c;
  int64_t last_save;
  // pac1: o proximo marco de progresso e o anterior (para os MB/s), e a janela do limite de escrita.
  uint64_t mark_next, mark_done;
  int64_t mark_ms;
  int win_limit;
  uint64_t win_bytes;
  int64_t win_ms;
} ConvProgress;
// pac1: o limite de escrita da conversao (g_conv_write_limit MB/s; 0 = sem limite): uma janela de tempo comeca num
// ponto (bytes, hora); se os bytes gravados desde ela passaram do que o limite deixa no tempo decorrido, espera a
// diferenca (em fatias de 100 ms, atento a cancelar/parar). A janela recomeca a cada ~2 s e quando o limite muda, para
// uma folga (o disco lento por um tempo) nao virar rajada depois.
static void conv_throttle(ConvProgress* p, uint64_t done) {
  const int limit = g_conv_write_limit;
  int64_t now = mono_ms();
  if (limit <= 0) { p->win_limit = 0; return; }
  if (p->win_limit != limit || !p->win_ms || done < p->win_bytes) { p->win_limit = limit; p->win_bytes = done; p->win_ms = now; return; }
  const double rate = (double)limit * 1024.0 * 1024.0; // bytes por segundo (MB/s como o app mostra: MiB)
  const int64_t due = p->win_ms + (int64_t)((double)(done - p->win_bytes) * 1000.0 / rate);
  while (now < due && !p->c->cancel && !g_stop && g_conv_write_limit == limit) {
    const int64_t step = due - now;
    sleep_ms(step > 100 ? 100 : (int)step);
    now = mono_ms();
  }
  if (now - p->win_ms >= 2000) { p->win_bytes = done; p->win_ms = now; }
}
static int conv_progress(void* ctx, uint64_t done, uint64_t total) {
  ConvProgress* p = ctx;
  pthread_mutex_lock(&g_conv_lock);
  p->c->written = done;
  p->c->total = total;
  const int64_t now = mono_ms();
  if (now - p->last_save >= 15000) { p->last_save = now; p->c->updated = now_s(); conv_save_locked(); }
  pthread_mutex_unlock(&g_conv_lock);
  if (done == 0 && !p->mark_ms) { // o exw_write comeca os dados
    p->mark_ms = now;
    p->mark_done = 0;
    p->mark_next = g_conv_mark_bytes;
  } else if (g_conv_mark_bytes && done >= p->mark_next && done < total) {
    const double secs = (double)(now - p->mark_ms) / 1000.0;
    const double mbps = secs > 0 ? (double)(done - p->mark_done) / (1024.0 * 1024.0) / secs : 0;
    conv_mark(p->c, "escrita do exFAT: %.2f GB de %.2f GB (%.1f MB/s)", conv_gb(done), conv_gb(total), mbps);
    p->mark_ms = now;
    p->mark_done = done;
    while (p->mark_next <= done) p->mark_next += g_conv_mark_bytes;
  }
  conv_throttle(p, done);
  if (g_conv_delay_ms) sleep_ms(g_conv_delay_ms);
  return p->c->cancel || g_stop ? 1 : 0;
}

static void conv_finish(Conv* c, const char* state, const char* error) {
  pthread_mutex_lock(&g_conv_lock);
  c->running = 0; // ja pode ser pedida de novo (liberar da memoria so depois do ciclo: in_use, glibren.41 J4)
  snprintf(c->state, sizeof c->state, "%s", state);
  copy_utf8(c->error, sizeof c->error, error ? error : "");
  c->updated = now_s();
  conv_save_locked();
  pthread_mutex_unlock(&g_conv_lock);
}
static void conv_set_state(Conv* c, const char* state) {
  pthread_mutex_lock(&g_conv_lock);
  snprintf(c->state, sizeof c->state, "%s", state);
  c->updated = now_s();
  conv_save_locked();
  pthread_mutex_unlock(&g_conv_lock);
}

// ---- Fonte "archive": RAR/7z/zip direto para o .exfat, sem extrair para o disco (glibren.12) ----
// Duas passadas pela libarchive (a mesma do app, estatica): (1) so os cabecalhos, para montar a lista de entradas na
// ORDEM do arquivo e achar a pasta do jogo (a que tem eboot.bin e sce_sys/param.json); (2) o exw_write pede os dados
// arquivo por arquivo e arc_read os entrega em fluxo, avancando no arquivo compactado. Se o writer pedir algo que ja
// passou, o arquivo e reaberto do comeco (correto, so mais lento). Volumes (part1.rar, .7z.001, ...) vao juntos em
// archive_read_open_filenames; senhas pela archive_read_add_passphrase (as mesmas que o app tenta, archive-password.js).
// Quando nao da para ir direto (tamanho ausente no cabecalho, senha que a libarchive nao abre, RAR5 cifrado, formato
// nao suportado, nenhum ou mais de um jogo, pacote/imagem dentro), o erro comeca com "not-direct:" e o app cai para o
// caminho de sempre: extrair e converter a pasta.
#define ARC_BLOCK (1024 * 1024)

typedef struct { char* path; uint64_t size; int is_dir, sized; uint32_t ordinal; } ArcItem;
typedef struct { ArcItem* items; size_t count, cap; } ArcList;

static void arc_list_free(ArcList* l) {
  for (size_t i = 0; i < l->count; ++i) free(l->items[i].path);
  free(l->items);
  memset(l, 0, sizeof *l);
}

static struct archive* arc_open(const Conv* c, char* err, size_t cap) {
  struct archive* a = archive_read_new();
  if (!a) { snprintf(err, cap, "not-direct: libarchive unavailable"); return NULL; }
  archive_read_support_filter_all(a);
  archive_read_support_format_zip(a);
  archive_read_support_format_rar(a);
  archive_read_support_format_rar5(a);
  archive_read_support_format_7zip(a);
  archive_read_support_format_tar(a);
  for (int i = 0; i < c->npasswords; ++i) archive_read_add_passphrase(a, c->passwords[i]);
  const char* files[ARC_MAX_VOLUMES + 1];
  int n = 0;
  for (; n < c->nsources && n < ARC_MAX_VOLUMES; ++n) files[n] = c->sources[n];
  files[n] = NULL;
  if (archive_read_open_filenames(a, files, ARC_BLOCK) != ARCHIVE_OK) {
    snprintf(err, cap, "not-direct: %s", archive_error_string(a) ? archive_error_string(a) : "the archive did not open");
    archive_read_free(a);
    return NULL;
  }
  return a;
}

// "./a/b" e "/a/b" viram "a/b"; uma barra no fim cai; ".." e recusado (devolve 0).
static int arc_clean_path(const char* in, char* out, size_t cap) {
  while (in[0] == '.' && in[1] == '/') in += 2;
  while (*in == '/') ++in;
  size_t n = strlen(in);
  while (n && in[n - 1] == '/') --n;
  if (!n || n >= cap) return 0;
  memcpy(out, in, n);
  out[n] = 0;
  for (char* p = out; *p; ++p) if (*p == '\\') *p = '/';
  if (!strcmp(out, "..") || !strncmp(out, "../", 3) || strstr(out, "/../") || (n >= 3 && !strcmp(out + n - 3, "/.."))) return 0;
  return 1;
}

static int arc_ends(const char* path, const char* suffix) {
  const size_t n = strlen(path), k = strlen(suffix);
  return n >= k && !strcasecmp(path + n - k, suffix);
}

static int arc_has(const ArcList* l, const char* path) {
  for (size_t i = 0; i < l->count; ++i) if (!l->items[i].is_dir && !strcmp(l->items[i].path, path)) return 1;
  return 0;
}

static int arc_backport_name(const char* path) {
  for (const char* p = path; *p; ++p) {
    if (strncasecmp(p, "back", 4)) continue;
    const char* q = p + 4;
    while (*q == ' ' || *q == '_' || *q == '.' || *q == '-') ++q;
    if (!strncasecmp(q, "port", 4)) return 1;
  }
  return 0;
}

// Passada 1: as entradas do jogo (relativas a pasta dele), na ordem do arquivo. 0 = ok; senao err ("not-direct: ...").
static int arc_plan(Conv* c, exw_entry** out, size_t* count, char* err, size_t cap) {
  ArcList l = {0};
  uint64_t unpacked = 0; // glibren.58: o total descompactado (para o progresso de uma extracao depois)
  int all_sized = 1;
  struct archive* a = arc_open(c, err, cap);
  if (!a) return -1;
  struct archive_entry* entry;
  uint32_t ordinal = 0;
  int rc = 0, header;
  while ((header = archive_read_next_header(a, &entry)) == ARCHIVE_OK || header == ARCHIVE_WARN) {
    const char* name = archive_entry_pathname_utf8(entry);
    if (!name) name = archive_entry_pathname(entry);
    char clean[1024];
    const uint32_t mine = ordinal++;
    if (!name || !arc_clean_path(name, clean, sizeof clean)) continue;
    const mode_t type = archive_entry_filetype(entry);
    if (type != AE_IFREG && type != AE_IFDIR) continue;
    if (l.count == l.cap) {
      const size_t grown = l.cap ? l.cap * 2 : 256;
      ArcItem* items = realloc(l.items, grown * sizeof *items);
      if (!items) { snprintf(err, cap, "source: out of memory"); rc = -1; break; }
      l.items = items;
      l.cap = grown;
    }
    ArcItem* item = &l.items[l.count];
    item->path = strdup(clean);
    if (!item->path) { snprintf(err, cap, "source: out of memory"); rc = -1; break; }
    item->is_dir = type == AE_IFDIR;
    item->sized = item->is_dir || archive_entry_size_is_set(entry);
    item->size = item->is_dir ? 0 : (uint64_t)archive_entry_size(entry);
    item->ordinal = mine;
    if (!item->is_dir) { if (item->sized) unpacked += item->size; else all_sized = 0; }
    ++l.count;
    // So os cabecalhos: os dados sao pulados pela proxima chamada.
  }
  if (!rc && header != ARCHIVE_EOF) {
    snprintf(err, cap, "not-direct: %s", archive_error_string(a) ? archive_error_string(a) : "the archive could not be listed");
    rc = -1;
  }
  archive_read_free(a);
  pthread_mutex_lock(&g_conv_lock);
  c->unpacked = header == ARCHIVE_EOF && all_sized ? unpacked : 0;
  pthread_mutex_unlock(&g_conv_lock);
  // A pasta do jogo: a de nome mais curto com eboot.bin e sce_sys/param.json, fora de pastas de backport; duas
  // diferentes (dois jogos) nao vao direto.
  char game[1024] = "";
  int found = 0, ambiguous = 0, inner = 0;
  for (size_t i = 0; !rc && i < l.count; ++i) {
    const char* path = l.items[i].path;
    const size_t n = strlen(path);
    if (arc_ends(path, ".pkg") || arc_ends(path, ".exfat") || arc_ends(path, ".ffpkg") || arc_ends(path, ".ffpfs") || arc_ends(path, ".ffpfsc")) inner = 1;
    if (l.items[i].is_dir || strcmp(base_name(path), "eboot.bin")) continue;
    char prefix[1024], param[1100];
    snprintf(prefix, sizeof prefix, "%.*s", (int)(n - strlen("eboot.bin")), path);
    snprintf(param, sizeof param, "%ssce_sys/param.json", prefix);
    if (!arc_has(&l, param) || arc_backport_name(prefix)) continue;
    if (!found) { snprintf(game, sizeof game, "%s", prefix); found = 1; }
    else if (strcmp(game, prefix)) ambiguous = 1;
  }
  if (!rc && (!found || ambiguous)) {
    snprintf(err, cap, "not-direct: %s", ambiguous ? "more than one game in the archive" : inner ? "the archive holds a package or an image" : "no PS5 game folder in the archive");
    rc = -1;
  }
  exw_entry* entries = NULL;
  size_t used = 0;
  const size_t skip = strlen(game);
  if (!rc && !(entries = calloc(l.count ? l.count : 1, sizeof *entries))) { snprintf(err, cap, "source: out of memory"); rc = -1; }
  for (size_t i = 0; !rc && i < l.count; ++i) {
    const ArcItem* item = &l.items[i];
    if (strncmp(item->path, game, skip) || !item->path[skip]) continue;
    if (!item->sized) { snprintf(err, cap, "not-direct: %s has no size in the archive's headers", item->path + skip); rc = -1; break; }
    char* path = strdup(item->path + skip);
    if (!path) { snprintf(err, cap, "source: out of memory"); rc = -1; break; }
    entries[used++] = (exw_entry){path, item->size, item->is_dir, (void*)(uintptr_t)item->ordinal};
  }
  arc_list_free(&l);
  if (rc) { exw_free_entries(entries, used); return -1; }
  *out = entries;
  *count = used;
  return 0;
}

typedef struct {
  const Conv* conv;
  struct archive* a;
  int64_t current;   // a entrada em que a leitura esta (ordinal), -1 antes da primeira
  uint32_t next;     // o ordinal do proximo cabecalho
  uint64_t pos;      // bytes ja lidos da entrada atual
  unsigned reopened; // quantas vezes voltou ao comeco (diario)
  char err[300];
} ArcRead;

static int arc_reopen(ArcRead* r) {
  if (r->a) archive_read_free(r->a);
  r->a = arc_open(r->conv, r->err, sizeof r->err);
  r->current = -1;
  r->next = 0;
  r->pos = 0;
  ++r->reopened;
  return r->a ? 0 : -1;
}

static long long arc_read(void* ctx, const exw_entry* e, uint64_t offset, void* buf, size_t len) {
  ArcRead* r = ctx;
  const uint32_t want = (uint32_t)(uintptr_t)e->user;
  if (!r->a || (int64_t)want < r->current || ((int64_t)want == r->current && offset < r->pos)) {
    if (arc_reopen(r)) return -1;
  }
  while (r->current != (int64_t)want) {
    struct archive_entry* entry;
    const int header = archive_read_next_header(r->a, &entry);
    if (header != ARCHIVE_OK && header != ARCHIVE_WARN) { snprintf(r->err, sizeof r->err, "%s", archive_error_string(r->a) ? archive_error_string(r->a) : "entry not found"); return -1; }
    r->current = r->next++;
    r->pos = 0;
  }
  while (r->pos < offset) { // pula ate o offset pedido, usando o proprio buf
    const size_t step = offset - r->pos < len ? (size_t)(offset - r->pos) : len;
    const la_ssize_t got = archive_read_data(r->a, buf, step ? step : 1);
    if (got <= 0) return -1;
    r->pos += (uint64_t)got;
  }
  size_t done = 0;
  while (done < len) {
    const la_ssize_t got = archive_read_data(r->a, (char*)buf + done, len - done);
    if (got < 0) { snprintf(r->err, sizeof r->err, "%s", archive_error_string(r->a) ? archive_error_string(r->a) : "read failed"); return -1; }
    if (got == 0) break;
    done += (size_t)got;
    r->pos += (uint64_t)got;
  }
  return (long long)done;
}

static void conv_run(Conv* c) {
  char err[512] = "", part[1100], message[1700];
  snprintf(part, sizeof part, "%s.part", c->output);
  unlink(part); // recomeca limpa
  conv_set_state(c, "converting");
  logk_("conversao %s: %s (%s) -> %s", c->id, c->name, c->kind, c->output);
  conv_mark(c, "inicio: %s (%s); origem %s; destino %s", c->name, c->kind, c->source, c->output);
  {
    char disk[200];
    conv_disk_info(c->root, disk, sizeof disk);
    conv_mark(c, "disco de destino: %s (%s)", c->root, disk);
    conv_disk_info(c->source, disk, sizeof disk);
    conv_mark(c, "disco de origem: %s (%s)", c->source, disk);
    if (g_conv_sync_mb > 0) conv_mark(c, "gravar em pedacos: fsync a cada %d MB", g_conv_sync_mb);
    if (g_conv_write_limit > 0) conv_mark(c, "limite de escrita: %d MB/s", g_conv_write_limit);
  }
  struct stat st;
  exw_entry* listed = NULL;
  size_t count = 0;
  const exw_entry* entries = NULL;
  pkgsrc* pkg = NULL;
  ArcRead* arc = NULL;
  exw_read_fn reader = exw_read_dir_file;
  void* reader_ctx = c->source;
  const char* outcome = "failed";
  message[0] = 0;
  if (!lstat(c->output, &st)) {
    snprintf(message, sizeof message, "write: %s already exists in homebrew/", base_name(c->output));
    goto end;
  }
  if (!strcmp(c->kind, "dir")) {
    if (exw_list_dir(c->source, &listed, &count, err, sizeof err)) { snprintf(message, sizeof message, "source: %s", err); goto end; }
    entries = listed;
  } else if (!strcmp(c->kind, "archive")) {
    arc = calloc(1, sizeof *arc);
    if (!arc) { snprintf(message, sizeof message, "source: out of memory"); goto end; }
    arc->conv = c;
    arc->current = -1;
    if (arc_plan(c, &listed, &count, err, sizeof err)) {
      snprintf(message, sizeof message, "%s%s", strncmp(err, "not-direct:", 11) && strncmp(err, "source:", 7) ? "source: " : "", err);
      goto end;
    }
    entries = listed;
    reader = arc_read;
    reader_ctx = arc;
  } else {
    pkg = pkgsrc_open(c->source, err, sizeof err);
    if (!pkg) { snprintf(message, sizeof message, "source: %s", err); goto end; }
    if (pkgsrc_kind(pkg) != PKGSRC_GAME) {
      snprintf(message, sizeof message, "not-a-game: the package is not a game (an update, DLC or other); it is used as it came");
      goto end;
    }
    if (pkgsrc_entries(pkg, &entries, &count, err, sizeof err)) { snprintf(message, sizeof message, "source: %s", err); goto end; }
    reader = pkgsrc_read;
    reader_ctx = pkg;
  }
  conv_mark(c, "origem aberta (%s): %zu entradas", !strcmp(c->kind, "dir") ? "pasta" : !strcmp(c->kind, "archive") ? "RAR/7z/zip" : "pkg", count);
  exw_plan plan;
  if (exw_plan_image(entries, count, c->label, &plan, err, sizeof err)) { snprintf(message, sizeof message, "source: %s", err); goto end; }
  conv_mark(c, "plano: imagem %.2f GB, dados %.2f GB", conv_gb(plan.image_bytes), conv_gb(plan.data_bytes));
  {
    const uint64_t free_bytes = conv_free_bytes(c->root), need = plan.image_bytes + CONV_MARGIN;
    pthread_mutex_lock(&g_conv_lock);
    c->image_bytes = plan.image_bytes;
    c->total = plan.data_bytes;
    c->written = 0;
    pthread_mutex_unlock(&g_conv_lock);
    if (free_bytes < need) {
      snprintf(message, sizeof message, "space: the .exfat needs %.1f GB free on the drive and it has %.1f GB", (double)need / 1e9, (double)free_bytes / 1e9);
      goto end;
    }
  }
  {
    ConvProgress progress;
    memset(&progress, 0, sizeof progress);
    progress.c = c;
    progress.last_save = mono_ms();
    err[0] = 0;
    exw_mark_hook = conv_writer_mark; // pac1: os marcos de dentro da escrita
    exw_mark_ctx = c;
    // pac1: "Gravar em pedacos": fsync a cada N MB (MiB, como o app mostra), cada um com marco; desligado, o de sempre.
    exw_sync_marked = g_conv_sync_mb > 0;
    exw_sync_bytes = exw_sync_marked ? (uint64_t)g_conv_sync_mb * 1024 * 1024 : EXW_SYNC_EVERY;
    const int written = exw_write(part, entries, count, c->label, reader, reader_ctx, conv_progress, &progress, err, sizeof err);
    exw_mark_hook = NULL;
    exw_mark_ctx = NULL;
    exw_sync_marked = 0;
    exw_sync_bytes = EXW_SYNC_EVERY;
    if (written == -2) {
      unlink(part);
      if (g_stop && !c->cancel) {
        // O payload esta parando: volta para a fila e recomeca do zero na proxima vez.
        pthread_mutex_lock(&g_conv_lock);
        c->written = 0;
        pthread_mutex_unlock(&g_conv_lock);
        outcome = "queued";
        logk_("conversao %s: interrompida (payload parando); recomeca depois", c->id);
      } else {
        outcome = "cancelled";
        logk_("conversao %s: cancelada", c->id);
      }
      goto end;
    }
    if (written && arc && arc->err[0]) {
      // A libarchive parou no meio (senha, volume, dado corrompido): o app tenta o caminho de extrair.
      snprintf(message, sizeof message, "not-direct: %s", arc->err);
      goto end;
    }
    if (written) { snprintf(message, sizeof message, "write: %s", err[0] ? err : "the image was not written"); goto end; }
  }
  conv_set_state(c, "verifying");
  conv_mark(c, "conferindo a imagem");
  err[0] = 0;
  // O compactado e lido em fluxo (os CRC do RAR/7z/zip ja conferem cada arquivo na leitura): so nomes e tamanhos.
  if (exw_verify(part, entries, count, reader, reader_ctx, arc ? 0 : 1, err, sizeof err)) { snprintf(message, sizeof message, "verify: %s", err); goto end; }
  if (!lstat(c->output, &st) || rename(part, c->output)) {
    snprintf(message, sizeof message, "write: the image was not renamed to %s (%s)", base_name(c->output), errno ? strerror(errno) : "exists");
    goto end;
  }
  sync_parent(c->output);
  conv_mark(c, "renomeada: %s", c->output);
  if (c->work[0] && conv_remove_tree(c->work, 0)) logf_("conversao %s: pasta de trabalho %s nao apagada inteira", c->id, c->work);
  outcome = "done";
  logk_("conversao %s: pronta, %s (%llu bytes)", c->id, c->output, (unsigned long long)c->image_bytes);
end:
  if (pkg) pkgsrc_close(pkg);
  if (arc) {
    if (arc->a) archive_read_free(arc->a);
    if (arc->reopened > 1) logf_("conversao %s: o compactado foi relido %u vezes", c->id, arc->reopened - 1);
    free(arc);
  }
  if (listed) exw_free_entries(listed, count);
  if (strcmp(outcome, "done") && strcmp(outcome, "queued")) unlink(part);
  // glibren.20: um compactado que nao da direto (RAR5, senha, tamanho ausente, ...) nao falha mais, venha do app ou do
  // proprio payload: a MESMA conversao passa a "extracting" e o payload extrai em <disco>/BACKUP/_temp/<id> e converte a
  // pasta (conv_extract_in_place). O app so acompanha (antes ele extraia, e so com a Jobe aberta).
  if (!strcmp(outcome, "failed") && !strncmp(message, "not-direct:", 11) && !strcmp(c->kind, "archive") && !c->cancel && !g_stop) {
    logk_("conversao %s: nao da direto (%s); o payload extrai antes", c->id, message + 11);
    pthread_mutex_lock(&g_conv_lock);
    copy_utf8(c->error, sizeof c->error, "");
    pthread_mutex_unlock(&g_conv_lock);
    conv_extract_begin(c); // glibren.58: o formato e os tamanhos ja valem no GET /convert assim que o estado muda
    conv_set_state(c, "extracting");
    return;
  }
  if (!strcmp(outcome, "failed")) logk_("conversao %s: falhou: %s", c->id, message);
  conv_finish(c, outcome, !strcmp(outcome, "failed") ? message : "");
  if (!strcmp(outcome, "done")) {
    char text[400];
    snprintf(text, sizeof text, "%s: pronto (EXFAT)", c->name);
    notify(text);
    conv_ask_scan(c);
    conv_mark(c, "fim: pronta");
  } else {
    conv_mark(c, "fim: %s%s%.300s", !strcmp(outcome, "queued") ? "interrompida (payload parando)" : outcome, !strcmp(outcome, "failed") ? ": " : "",
              !strcmp(outcome, "failed") ? message : "");
  }
  if (!strcmp(outcome, "failed")) {
    // glibren.20: nao chega aqui com "not-direct" (conv_run passa a "extracting" antes); fica para outras falhas.
    const int extracting = !strncmp(c->error, "not-direct:", 11) && !strcmp(c->kind, "archive") && (!strncmp(c->key, "auto-", 5) || !strncmp(c->key, "backup-", 7));
    char text[400];
    snprintf(text, sizeof text, "%s: conversao para EXFAT falhou", c->name);
    if (!extracting) notify(text);
  }
}

static void conv_extract_in_place(Conv* c); // glibren.20 (abaixo)
static int conv_temp_work(const Conv* c) { return c->work[0] && strstr(c->work, "/BACKUP/_temp/") != NULL; }
static void* conv_loop(void* arg) {
  (void)arg;
  int64_t waited_for = -1; // pac1: o fim (g_conv_last_end_ms) cuja pausa ja foi registrada no diario
  while (!g_stop) {
    pthread_mutex_lock(&g_conv_lock);
    Conv* next = NULL;
    for (int i = 0; i < g_conv_count && !next; ++i) if (!strcmp(g_convs[i]->state, "queued")) next = g_convs[i];
    // pac1: a pausa entre conversoes (so antes de uma conversao diferente da ultima).
    const int64_t left = next ? conv_wait_left_ms_locked(next) : 0;
    if (!next || left > 0) {
      if (next && waited_for != g_conv_last_end_ms) {
        waited_for = g_conv_last_end_ms;
        logk_("pausa entre conversoes: %s comeca em %lld s", next->name, (long long)((left + 999) / 1000));
      }
      struct timespec until;
      clock_gettime(CLOCK_REALTIME, &until);
      if (next && left < 1000) {
        until.tv_nsec += (long)(left * 1000000);
        if (until.tv_nsec >= 1000000000L) { until.tv_sec += 1; until.tv_nsec -= 1000000000L; }
      } else {
        until.tv_sec += 1;
      }
      pthread_cond_timedwait(&g_conv_wake, &g_conv_lock, &until);
      pthread_mutex_unlock(&g_conv_lock);
      continue;
    }
    next->running = 1;
    next->in_use = 1; // glibren.41 (J4)
    next->cancel = 0;
    pthread_mutex_unlock(&g_conv_lock);
    conv_run(next);
    pthread_mutex_lock(&g_conv_lock);
    // glibren.20: qualquer conversao que nao deu direto (do app, do payload ou "Converter agora") e extraida aqui.
    const int extract = !strcmp(next->state, "extracting");
    const int leftover = (!strcmp(next->state, "failed") || !strcmp(next->state, "cancelled")) && conv_temp_work(next);
    // pac1: trabalhou (pronta, extraindo, ou falhou depois de gravar): a proxima espera a pausa.
    const int worked = !strcmp(next->state, "done") || extract || (!strcmp(next->state, "failed") && next->written > 0);
    char work[1024];
    copy_text(work, sizeof work, next->work);
    pthread_mutex_unlock(&g_conv_lock);
    if (extract) conv_extract_in_place(next);
    else if (leftover && conv_remove_tree(work, 0)) logf_("conversao %s: pasta temporaria %s nao apagada inteira", next->id, work);
    pthread_mutex_lock(&g_conv_lock);
    if (worked) {
      g_conv_last_end_ms = mono_ms();
      copy_text(g_conv_last_id, sizeof g_conv_last_id, next->id);
    }
    next->running = 0;
    next->in_use = 0; // glibren.41 (J4): so agora pode ser esquecida ou aberta vaga com ela
    pthread_mutex_unlock(&g_conv_lock);
  }
  return NULL;
}

static void conv_start(void) {
  snprintf(g_smp_base, sizeof g_smp_base, "%s", env_or("BGDL_SMP_BASE", g_smp_base));
  g_conv_delay_ms = atoi(env_or("BGDL_CONVERT_DELAY_MS", "0"));
  {
    const unsigned long long mark = strtoull(env_or("BGDL_MARK_BYTES", "0"), NULL, 10); // pac1: testes
    if (mark) g_conv_mark_bytes = mark;
  }
  pthread_mutex_lock(&g_conv_lock);
  conv_load();
  // glibren.20: as que falharam por "not-direct" antes (ficavam esperando a Jobe extrair) voltam para a fila: agora o
  // payload extrai. As outras falhas ficam (sem espaco, nao e o jogo, ...): "Converter agora" tenta de novo.
  int again = 0;
  for (int i = 0; i < g_conv_count; ++i) {
    Conv* c = g_convs[i];
    if (strcmp(c->state, "failed") || strncmp(c->error, "not-direct:", 11) || strcmp(c->kind, "archive")) continue;
    snprintf(c->state, sizeof c->state, "queued");
    c->error[0] = 0;
    c->written = 0;
    ++again;
  }
  if (again) logk_("conversoes: %d que nao deram direto voltam para a fila (o payload extrai)", again);
  conv_save_locked(); // glibren.41 (J2): o estado lido (queued ou "falhou" por queda) fica gravado ja
  // glibren.41 (J1): pastas de extracao (<root>/BACKUP/_temp/<id>) sem conversao viva sao sobra de uma conversao que
  // terminou, foi esquecida ou descartada: dezenas de GB escondidos (a lista do BACKUP nao mostra _temp). Apagadas aqui,
  // fora da trava (pode demorar).
  char roots[8][1024], sobras[16][1400];
  int nroots = 0, nsobras = 0;
  for (int i = 0; i < g_conv_count && nroots < 8; ++i) {
    int visto = 0;
    for (int k = 0; k < nroots; ++k) visto |= !strcmp(roots[k], g_convs[i]->root);
    if (!visto) copy_text(roots[nroots++], sizeof roots[0], g_convs[i]->root);
  }
  for (int r = 0; r < nroots && nsobras < 16; ++r) {
    char dir[1100];
    snprintf(dir, sizeof dir, "%.1000s/BACKUP/_temp", roots[r]);
    DIR* d = opendir(dir);
    struct dirent* e;
    while (d && (e = readdir(d)) && nsobras < 16) {
      if (e->d_name[0] == '.') continue;
      char completo[1400];
      snprintf(completo, sizeof completo, "%.1100s/%.255s", dir, e->d_name);
      // viva: uma conversao nao terminada com esse id, ou cuja pasta de trabalho e essa (ou esta dentro dela)
      int viva = 0;
      for (int i = 0; i < g_conv_count && !viva; ++i) {
        const Conv* c = g_convs[i];
        viva = !conv_terminal(c->state) && (!strcmp(c->id, e->d_name) || !strcmp(c->work, completo) || conv_inside(c->work, completo));
      }
      if (!viva) copy_text(sobras[nsobras++], sizeof sobras[0], completo);
    }
    if (d) closedir(d);
  }
  pthread_mutex_unlock(&g_conv_lock);
  for (int i = 0; i < nsobras; ++i) {
    if (conv_remove_tree(sobras[i], 0)) logf_("conversoes: sobra de extracao %s nao apagada inteira", sobras[i]);
    else logk_("conversoes: apagada a sobra de extracao %s (sem conversao viva)", sobras[i]);
  }
}

// ---- API local ----
static void conv_respond_one(int fd, int status, const Conv* c, int attached) {
  Buf b = {0};
  buf_str(&b, "{\"id\":"); buf_json(&b, c->id);
  buf_str(&b, ",\"state\":"); buf_json(&b, c->state);
  buf_fmt(&b, ",\"attached\":%s}", attached ? "true" : "false");
  respond(fd, status, b.failed || !b.data ? "{}" : b.data);
  free(b.data);
}

static void conv_create(int fd, Request* r) {
  Conv* body = calloc(1, sizeof *body);
  if (!body) { respond_error(fd, 500, "out of memory"); return; }
  JP jp = {r->body, r->body + r->content_length, 0};
  char error[200];
  if (!r->content_length || !jp_object(&jp, conv_field, body)) { free(body); respond_error(fd, 400, "expected a JSON object"); return; }
  body->id[0] = body->state[0] = body->error[0] = 0;
  body->written = body->total = body->image_bytes = 0;
  if (!conv_validate(body, error, sizeof error)) { respond_error(fd, 400, error); free(body); return; }
  pthread_mutex_lock(&g_conv_lock);
  Conv* same = conv_by_key_locked(body->key);
  // glibren.18: a mesma fonte que o payload ja converte (ou converteu) sozinho: o app so a acompanha.
  if (!same) same = conv_by_source_locked(body->source);
  if (same && (!conv_terminal(same->state) || !strcmp(same->state, "done"))) {
    // A mesma conversao (o app reabriu e pergunta de novo): acompanha a que existe.
    conv_respond_one(fd, 200, same, 1);
    pthread_mutex_unlock(&g_conv_lock);
    free(body);
    return;
  }
  Conv* c = same;
  if (!c) {
    if (g_conv_count >= MAX_CONVS) {
      // Abre lugar esquecendo a mais antiga que terminou.
      for (int i = 0; i < g_conv_count; ++i) {
        if (!conv_terminal(g_convs[i]->state) || g_convs[i]->running || g_convs[i]->in_use) continue;
        free(g_convs[i]);
        memmove(&g_convs[i], &g_convs[i + 1], sizeof(Conv*) * (size_t)(g_conv_count - i - 1));
        --g_conv_count;
        break;
      }
    }
    if (g_conv_count >= MAX_CONVS) { pthread_mutex_unlock(&g_conv_lock); free(body); respond_error(fd, 409, "too many conversions"); return; }
    c = body;
    body = NULL;
    snprintf(c->id, sizeof c->id, "c%u", ++g_conv_next);
    c->created = now_s();
    g_convs[g_conv_count++] = c;
  } else {
    // Uma que falhou ou foi cancelada, pedida de novo ("Tentar de novo"): recomeca com o pedido novo.
    char id[24];
    snprintf(id, sizeof id, "%s", c->id);
    const int64_t created = c->created;
    const int in_use = c->in_use; // glibren.41 (J4): o ciclo pode ainda estar terminando com ela
    *c = *body;
    snprintf(c->id, sizeof c->id, "%s", id);
    c->created = created;
    c->in_use = in_use;
  }
  snprintf(c->state, sizeof c->state, "queued");
  c->error[0] = 0;
  c->cancel = 0;
  c->updated = now_s();
  conv_save_locked();
  logf_("conversao %s pedida: %s (%s)", c->id, c->name, c->kind);
  conv_respond_one(fd, same ? 200 : 201, c, 0);
  pthread_cond_broadcast(&g_conv_wake);
  pthread_mutex_unlock(&g_conv_lock);
  free(body);
}

// Rotas /convert da API local. 1 = tratou.
static int conv_route(int fd, Request* r) {
  if (strcmp(r->path, "/convert") && strncmp(r->path, "/convert/", 9)) return 0;
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/convert")) { conv_create(fd, r); return 1; }
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/convert")) {
    Buf b = {0};
    pthread_mutex_lock(&g_conv_lock);
    buf_str(&b, "{\"conversions\":[");
    for (int i = 0; i < g_conv_count; ++i) {
      if (i) buf_str(&b, ",");
      conv_json(&b, g_convs[i], 0);
    }
    // pac1: a pausa entre conversoes (o que falta para a proxima comecar; 0 = nenhuma espera) e as opcoes.
    buf_fmt(&b, "],\"waitSeconds\":%d,\"pauseSeconds\":%d,\"writeLimit\":%d}", conv_wait_seconds_locked(), g_conv_pause_s, g_conv_write_limit);
    pthread_mutex_unlock(&g_conv_lock);
    respond(fd, 200, b.failed || !b.data ? "{\"conversions\":[]}" : b.data);
    free(b.data);
    return 1;
  }
  if (!strcmp(r->method, "POST") && !strncmp(r->path, "/convert/", 9)) {
    char id[24];
    const char* rest = r->path + 9;
    const char* slash = strchr(rest, '/');
    if (!slash || (size_t)(slash - rest) >= sizeof id) { respond_error(fd, 404, "not found"); return 1; }
    memcpy(id, rest, (size_t)(slash - rest));
    id[slash - rest] = 0;
    const char* action = slash + 1;
    pthread_mutex_lock(&g_conv_lock);
    Conv* c = conv_find_locked(id);
    int status = c ? 200 : 404;
    if (c && !strcmp(action, "cancel")) {
      if (!conv_terminal(c->state)) {
        c->cancel = 1;
        if (!c->running) { snprintf(c->state, sizeof c->state, "cancelled"); c->updated = now_s(); conv_save_locked(); }
      }
    } else if (c && !strcmp(action, "forget")) {
      if (c->running || c->in_use) status = 409; // glibren.41 (J4): o ciclo ainda usa
      else {
        for (int i = 0; i < g_conv_count; ++i) {
          if (g_convs[i] != c) continue;
          memmove(&g_convs[i], &g_convs[i + 1], sizeof(Conv*) * (size_t)(g_conv_count - i - 1));
          --g_conv_count;
          break;
        }
        free(c);
        conv_save_locked();
      }
    } else if (c) {
      status = 404;
    }
    pthread_mutex_unlock(&g_conv_lock);
    if (status == 200) respond(fd, 200, "{\"ok\":true}");
    else respond_error(fd, status, status == 409 ? "still running" : "no such conversion");
    return 1;
  }
  respond_error(fd, 404, "not found");
  return 1;
}

// ---- Pagina do celular ----
// As conversoes no /api/status (sem caminhos): ,"conversions":[...]
static void conv_status_json(Buf* b) {
  pthread_mutex_lock(&g_conv_lock);
  buf_str(b, ",\"conversions\":[");
  int first = 1;
  for (int i = 0; i < g_conv_count; ++i) {
    if (!strcmp(g_convs[i]->state, "cancelled")) continue;
    if (!first) buf_str(b, ",");
    first = 0;
    conv_json(b, g_convs[i], 1);
  }
  buf_fmt(b, "],\"convertWaitSeconds\":%d", conv_wait_seconds_locked()); // pac1: a pausa entre conversoes
  pthread_mutex_unlock(&g_conv_lock);
}

// Os discos onde pode haver BACKUP: o interno e os externos (BGDL_BACKUP_ROOTS, separados por ':', so nos testes).
static int conv_backup_roots(char roots[][256], int max) {
  int count = 0;
  const char* custom = env_or("BGDL_BACKUP_ROOTS", "");
  if (custom[0]) {
    for (const char* p = custom; *p && count < max;) {
      const char* colon = strchr(p, ':');
      const size_t n = colon ? (size_t)(colon - p) : strlen(p);
      if (n && n < 256) { memcpy(roots[count], p, n); roots[count++][n] = 0; }
      p += n + (colon ? 1 : 0);
    }
    return count;
  }
  snprintf(roots[count++], 256, "/data");
  for (int i = 0; i < 8 && count < max; ++i) snprintf(roots[count++], 256, "/mnt/usb%d", i);
  for (int i = 0; i < 2 && count < max; ++i) snprintf(roots[count++], 256, "/mnt/ext%d", i);
  return count;
}

// glibren.12: definidas mais adiante em bg_downloader.c.
static void format_of_file(const char* path, char* out, size_t cap);
static int system_code_ok(const char* text);
static int system_platform_field(JP* jp, char* out, size_t cap);
static int system_code_field(JP* jp, char* out, size_t cap);

// glibren.12: o que a lista do BACKUP mostra de cada jogo: o sistema e o codigo (do .jobe-backup.json que o app ou o
// payload grava; sem ele, PPSA/CUSA no nome dos arquivos ou da pasta), o formato dos arquivos guardados (o mais comum;
// "parts" quando sao varios do mesmo formato), os nomes (so o nome base, ate BACKUP_NAMES) e o .exfat convertido, se
// existe (<disco>/homebrew/<codigo>.exfat).
#define BACKUP_NAMES 10
typedef struct {
  char platform[4], code[16], format[9];
  char names[BACKUP_NAMES][129];
  int named, more;
  unsigned counts[10];
} BackupInfo;
static const char* const BACKUP_FORMATS[10] = {"exfat", "ffpkg", "ffpfsc", "ffpfs", "pkg", "fpkg", "rar", "7z", "zip", "tar"};
static void backup_code_in(const char* text, BackupInfo* info) {
  if (info->code[0]) return;
  for (const char* p = text; p[0] && p[1] && p[2] && p[3]; ++p) {
    char maybe[10];
    int k = 0;
    for (; k < 9 && p[k]; ++k) maybe[k] = (char)toupper((unsigned char)p[k]);
    maybe[k] = 0;
    if (k == 9 && system_code_ok(maybe) && (!strncmp(maybe, "PPSA", 4) || !strncmp(maybe, "CUSA", 4))) {
      snprintf(info->code, sizeof info->code, "%s", maybe);
      return;
    }
  }
}
static void backup_walk(const char* path, int depth, BackupInfo* info) {
  if (depth > 6) return;
  DIR* d = opendir(path);
  if (!d) return;
  for (struct dirent* it; (it = readdir(d));) {
    if (it->d_name[0] == '.') continue;
    char child[4096];
    snprintf(child, sizeof child, "%s/%s", path, it->d_name);
    struct stat st;
    if (lstat(child, &st)) continue;
    if (S_ISDIR(st.st_mode)) { backup_walk(child, depth + 1, info); continue; }
    if (!S_ISREG(st.st_mode)) continue;
    char format[9];
    format_of_file(it->d_name, format, sizeof format);
    for (int i = 0; i < 10; ++i) if (format[0] && !strcmp(format, BACKUP_FORMATS[i])) ++info->counts[i];
    backup_code_in(it->d_name, info);
    if (info->named < BACKUP_NAMES && strlen(it->d_name) < sizeof info->names[0] && !strchr(it->d_name, '\\')) snprintf(info->names[info->named++], sizeof info->names[0], "%s", it->d_name);
    else ++info->more;
  }
  closedir(d);
}
static int backup_marker_field(JP* jp, const char* key, void* ctx) {
  BackupInfo* info = ctx;
  if (!strcmp(key, "titleId")) return system_code_field(jp, info->code, sizeof info->code);
  if (!strcmp(key, "platform")) return system_platform_field(jp, info->platform, sizeof info->platform);
  if (!strcmp(key, "format")) {
    char value[16];
    if (!lib_text(jp, value, sizeof value)) return -1;
    lower_ascii(value);
    for (int i = 0; i < 10; ++i) if (!strcmp(value, BACKUP_FORMATS[i])) snprintf(info->format, sizeof info->format, "%s", BACKUP_FORMATS[i]);
    return 1;
  }
  return jp_skip(jp) ? 1 : -1;
}
// glibren.25: um .exfat do mesmo codigo (PPSA/CUSA) ja feito em algum <disco>/homebrew/ (os discos de conv_backup_roots,
// so o primeiro nivel): o de sempre (<root>/homebrew/<codigo>.exfat) primeiro; senao qualquer nome com o codigo ("Pinball_FX-
// PPSA08755-US-PS5.exfat", renomeado ou movido pelo gamer depois de pronto). `where` = o caminho; 0 = nao achou.
static int name_has_code(const char* name, const char* code) {
  const size_t n = strlen(code);
  for (const char* p = name; *p; ++p)
    if (!strncasecmp(p, code, n) && !isdigit((unsigned char)p[n]) && (p == name || !isalnum((unsigned char)p[-1]))) return 1;
  return 0;
}
static int exfat_of_code(const char* root, const char* code, char* where, size_t cap) {
  struct stat st;
  snprintf(where, cap, "%.255s/homebrew/%s.exfat", root, code);
  if (!stat(where, &st) && S_ISREG(st.st_mode)) return 1;
  char roots[24][256];
  const int count = conv_backup_roots(roots, 24);
  for (int i = 0; i < count; ++i) {
    char dir[300];
    snprintf(dir, sizeof dir, "%.255s/homebrew", roots[i]);
    DIR* d = opendir(dir);
    if (!d) continue;
    int found = 0;
    for (struct dirent* it; !found && (it = readdir(d));) {
      const size_t n = strlen(it->d_name);
      if (it->d_name[0] == '.' || n < 7 || strcasecmp(it->d_name + n - 6, ".exfat") || !name_has_code(it->d_name, code)) continue;
      snprintf(where, cap, "%s/%s", dir, it->d_name);
      found = !stat(where, &st) && S_ISREG(st.st_mode);
    }
    closedir(d);
    if (found) return 1;
  }
  where[0] = 0;
  return 0;
}
// glibren.25: `where` (pode ser NULL) recebe o caminho inteiro do .exfat achado; `converted`, so o nome dele.
static void backup_info(const char* root, const char* path, const char* name, BackupInfo* info, char* converted, size_t cap, char* where, size_t where_cap) {
  memset(info, 0, sizeof *info);
  converted[0] = 0;
  if (where) where[0] = 0;
  char marker[700];
  snprintf(marker, sizeof marker, "%.599s/.jobe-backup.json", path);
  FILE* f = fopen(marker, "rb");
  if (f) {
    char text[2048];
    const size_t n = fread(text, 1, sizeof text - 1, f);
    fclose(f);
    text[n] = 0;
    JP jp = {text, text + n, 0};
    if (!jp_object(&jp, backup_marker_field, info)) { info->code[0] = info->platform[0] = info->format[0] = 0; }
  }
  struct stat st;
  if (!lstat(path, &st) && S_ISDIR(st.st_mode)) backup_walk(path, 0, info);
  else if (!lstat(path, &st) && S_ISREG(st.st_mode)) {
    char format[9];
    format_of_file(name, format, sizeof format);
    for (int i = 0; i < 10; ++i) if (format[0] && !strcmp(format, BACKUP_FORMATS[i])) ++info->counts[i];
    if (strlen(name) < sizeof info->names[0]) snprintf(info->names[info->named++], sizeof info->names[0], "%s", name);
  }
  backup_code_in(name, info);
  if (!info->platform[0] && info->code[0]) snprintf(info->platform, sizeof info->platform, "%s", !strncmp(info->code, "CUSA", 4) ? "ps4" : !strncmp(info->code, "PPSA", 4) ? "ps5" : "");
  if (!info->format[0]) {
    int best = -1;
    for (int i = 0; i < 10; ++i) if (info->counts[i] && (best < 0 || info->counts[i] > info->counts[best])) best = i;
    if (best >= 0) snprintf(info->format, sizeof info->format, "%s", BACKUP_FORMATS[best]);
  }
  if (info->code[0]) {
    char image[700];
    if (exfat_of_code(root, info->code, image, sizeof image)) { // glibren.25: tambem o renomeado/movido
      copy_text(converted, cap, base_name(image));
      if (where) copy_text(where, where_cap, image);
    }
  }
}
static unsigned backup_parts(const BackupInfo* info) {
  for (int i = 0; i < 10; ++i) if (!strcmp(info->format, BACKUP_FORMATS[i])) return info->counts[i] > 1 ? info->counts[i] : 0;
  return 0;
}

// glibren.22: as acoes do BACKUP servem a pagina do celular (com o PIN) e o app (a API local, com o token, app = 1): a
// mesma resposta, pelo canal de cada um.
static void backup_reply(int fd, int app, int status, const char* body) {
  if (app) respond(fd, status, body);
  else monitor_json(fd, status, body);
}
static const char* backup_who(int app) { return app ? "app" : "celular"; }

// glibren.22: a conversao mais recente do item do BACKUP (pela chave "backup-<nome>" ou pelo original dentro dele), para
// o app mostrar o estado ao lado do item: ,"conversion":{"id","state","error","written","total"} ou nada.
static void backup_conv_json(Buf* b, const char* path, const char* key) {
  pthread_mutex_lock(&g_conv_lock);
  const Conv* best = NULL;
  for (int i = 0; i < g_conv_count; ++i) {
    const Conv* c = g_convs[i];
    if (!strcmp(c->state, "cancelled")) continue;
    int mine = !strcmp(c->key, key) || !strcmp(c->source, path) || conv_inside(c->source, path);
    for (int k = 0; !mine && k < c->nsources; ++k) mine = !strcmp(c->sources[k], path) || conv_inside(c->sources[k], path);
    if (mine && (!best || c->updated >= best->updated)) best = c;
  }
  if (best) {
    buf_str(b, ",\"conversion\":{\"id\":"); buf_json(b, best->id);
    buf_str(b, ",\"state\":"); buf_json(b, best->state);
    buf_str(b, ",\"error\":"); buf_json(b, best->error);
    buf_fmt(b, ",\"written\":%llu,\"total\":%llu}", (unsigned long long)best->written, (unsigned long long)best->total);
  }
  pthread_mutex_unlock(&g_conv_lock);
}
static void backup_key(char* key, size_t cap, const char* name) {
  snprintf(key, cap, "backup-%.100s", name);
  for (char* p = key; *p; ++p) if ((unsigned char)*p < 0x20 || *p == '"' || *p == '\\') *p = '_';
}

static void conv_backup_list(int fd, int app) {
  char roots[24][256];
  const int count = conv_backup_roots(roots, 24);
  Buf b = {0};
  uint64_t all = 0;
  buf_str(&b, "{\"games\":[");
  int first = 1;
  for (int i = 0; i < count; ++i) {
    char dir[300];
    snprintf(dir, sizeof dir, "%.255s/BACKUP", roots[i]);
    DIR* d = opendir(dir);
    if (!d) continue;
    for (struct dirent* it; (it = readdir(d));) {
      if (it->d_name[0] == '.' || !strcmp(it->d_name, "_temp")) continue; // glibren.20: a pasta das extracoes
      char path[600];
      snprintf(path, sizeof path, "%.299s/%.255s", dir, it->d_name);
      uint64_t bytes = 0;
      unsigned files = 0;
      conv_tree_size(path, 0, &bytes, &files);
      all += bytes;
      if (!first) buf_str(&b, ",");
      first = 0;
      buf_str(&b, "{\"root\":"); buf_json(&b, roots[i]);
      buf_str(&b, ",\"name\":"); buf_json(&b, it->d_name);
      buf_fmt(&b, ",\"bytes\":%llu,\"files\":%u", (unsigned long long)bytes, files);
      // glibren.12: de que jogo e, o formato e os nomes (sem caminho) e o .exfat convertido.
      BackupInfo info;
      char converted[256], where[700];
      backup_info(roots[i], path, it->d_name, &info, converted, sizeof converted, where, sizeof where);
      buf_str(&b, ",\"platform\":"); buf_json(&b, info.platform);
      buf_str(&b, ",\"code\":"); buf_json(&b, info.code);
      buf_str(&b, ",\"format\":"); buf_json(&b, info.format);
      buf_fmt(&b, ",\"parts\":%u,\"fileNames\":[", backup_parts(&info));
      for (int k = 0; k < info.named; ++k) { if (k) buf_str(&b, ","); buf_json(&b, info.names[k]); }
      buf_fmt(&b, "],\"moreFiles\":%d,\"converted\":", info.more);
      buf_json(&b, converted);
      if (where[0]) { buf_str(&b, ",\"convertedPath\":"); buf_json(&b, where); } // glibren.25
      { // glibren.22; glibren.25: tambem para o celular (o item mostra "Na fila"/"Convertendo" no lugar do botao)
        char key[128];
        backup_key(key, sizeof key, it->d_name);
        backup_conv_json(&b, path, key);
      }
      buf_str(&b, "}");
    }
    closedir(d);
  }
  buf_fmt(&b, "],\"totalBytes\":%llu}", (unsigned long long)all);
  if (b.failed || !b.data) backup_reply(fd, app, 500, "{\"error\":\"out of memory\"}");
  else backup_reply(fd, app, 200, b.data);
  free(b.data);
}

typedef struct { char root[256], name[256]; } BackupDelete;
static int backup_delete_field(JP* jp, const char* key, void* ctx) {
  BackupDelete* d = ctx;
  if (!strcmp(key, "root")) return jp_text(jp, d->root, sizeof d->root) ? 1 : -1;
  if (!strcmp(key, "name")) return jp_text(jp, d->name, sizeof d->name) ? 1 : -1;
  return 0;
}

static void conv_backup_delete(int fd, Request* r, int app) {
  if (!app && !monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  BackupDelete d = {{0}, {0}};
  JP jp = {r->body, r->body + r->content_length, 0};
  if (!r->content_length || !jp_object(&jp, backup_delete_field, &d)) { backup_reply(fd, app, 400, "{\"error\":\"expected {root, name}\"}"); return; }
  char roots[24][256];
  const int count = conv_backup_roots(roots, 24);
  int known = 0;
  for (int i = 0; i < count; ++i) if (!strcmp(roots[i], d.root)) known = 1;
  // R2-19: _temp (as extracoes em andamento) nao e um item do BACKUP: a lista e o "converter" ja o recusavam.
  if (!known || !d.name[0] || d.name[0] == '.' || !strcmp(d.name, "_temp") || strchr(d.name, '/') || strchr(d.name, '\\')) { backup_reply(fd, app, 400, "{\"error\":\"invalid backup\"}"); return; }
  char path[600];
  snprintf(path, sizeof path, "%.255s/BACKUP/%.255s", d.root, d.name);
  struct stat st;
  if (lstat(path, &st)) { backup_reply(fd, app, 404, "{\"error\":\"no such backup\"}"); return; }
  // Nao apaga o original de uma conversao que ainda o le (um .pkg convertido direto do BACKUP).
  pthread_mutex_lock(&g_conv_lock);
  int busy = 0;
  // R2-19: tambem a pasta de trabalho de uma conversao em andamento (dentro ou igual ao item).
  for (int i = 0; i < g_conv_count; ++i)
    if (!conv_terminal(g_convs[i]->state) && (conv_inside(g_convs[i]->source, path) || !strcmp(g_convs[i]->source, path) ||
                                              conv_inside(g_convs[i]->work, path) || !strcmp(g_convs[i]->work, path)))
      busy = 1;
  pthread_mutex_unlock(&g_conv_lock);
  if (busy) { backup_reply(fd, app, 409, "{\"error\":\"converting\"}"); return; }
  // J10: nem um download que ainda grava dentro do item (o .part ou o destino de um job que nao terminou).
  pthread_mutex_lock(&g_lock);
  for (int i = 0; i < g_job_count; ++i)
    if ((!terminal(g_jobs[i]->state) || g_jobs[i]->running) && g_jobs[i]->destination[0] &&
        (conv_inside(g_jobs[i]->destination, path) || !strcmp(g_jobs[i]->destination, path)))
      busy = 1;
  pthread_mutex_unlock(&g_lock);
  if (busy) { backup_reply(fd, app, 409, "{\"error\":\"downloading\"}"); return; }
  const int failed = conv_remove_tree(path, 0);
  logk_("%s: BACKUP %s apagado%s", backup_who(app), path, failed ? " (em parte)" : "");
  backup_reply(fd, app, failed ? 500 : 200, failed ? "{\"error\":\"not all deleted\"}" : "{\"ok\":true}");
}

// ---- glibren.18: o payload converte sozinho, sem o app ----
// Antes, so o app pedia a conversao (download-queue.js queueConversion -> POST /convert) depois do download: com o app
// fechado, um jogo de PS5 que terminava em <disco>/BACKUP/<jogo>/ ficava "nao convertido". Agora:
//   - todo job do payload que termina com o app fechado dentro de <disco>/BACKUP/<jogo>/ (o app so poe la jogo de PS5
//     compactado ou .pkg de PS5 com a conversao ligada) e convertido aqui (backup_convert): .pkg de PS5 pela fonte
//     "pkg"; compactado pela "archive" (direto); se der "not-direct:", o payload EXTRAI numa pasta de trabalho no mesmo
//     disco (<disco>/downloads/extract/<id>) e converte a pasta do jogo ("dir"); um .pkg de PS4 achado dentro vai para
//     <disco>/PS4/ (instalar continua com o app: aba Arquivos);
//   - a lista do BACKUP na pagina do celular tem "Converter agora" (POST /api/backup/convert, com o PIN);
//   - sem trabalho dobrado: o POST /convert do app que pede a MESMA fonte de uma conversao em andamento ou pronta so a
//     acompanha (attached), como ja fazia com a mesma chave.
// As senhas que se tenta num compactado sao as conhecidas do app (KNOWN_PASSWORDS em download-queue.js).
static const char* const AUTO_PASSWORDS[] = {"DLPSGAME.COM", "[DLPSGAME.COM]", "www.DLPSGAME.COM", "SuperPSX", "downloadgameps3.com", "hako", "pippo"};

// Uma conversao da mesma fonte, em andamento ou pronta (falhou/cancelada nao conta).
static Conv* conv_by_source_locked(const char* source) {
  for (int i = 0; i < g_conv_count; ++i) {
    const Conv* c = g_convs[i];
    if (strcmp(c->state, "failed") && strcmp(c->state, "cancelled") && !strcmp(c->source, source)) return g_convs[i];
  }
  return NULL;
}

// glibren.25: o que conv_add_auto fez com o pedido, para a resposta do "Converter" (antes o duplicado sumia sem nada):
// o id, a posicao na fila (0 = convertendo agora) e, se ja existia, o estado dela ("" = entrou na fila agora).
typedef struct { char id[24]; char already[16]; int position; } ConvAdded;
// Quantas conversoes passam antes de `c`: a que esta rodando ou extraindo e as "queued" antes dela na lista (conv_loop
// pega a primeira "queued").
static int conv_position_locked(const Conv* c) {
  if (c->running || strcmp(c->state, "queued")) return 0;
  int ahead = 0, before = 1;
  for (int i = 0; i < g_conv_count; ++i) {
    const Conv* o = g_convs[i];
    if (o == c) { before = 0; continue; }
    if (o->running || (!conv_terminal(o->state) && strcmp(o->state, "queued"))) ++ahead;
    else if (before && !strcmp(o->state, "queued")) ++ahead;
  }
  return ahead;
}
static void conv_added_locked(ConvAdded* out, const Conv* c, const char* already) {
  if (!out) return;
  copy_text(out->id, sizeof out->id, c->id);
  copy_text(out->already, sizeof out->already, already);
  out->position = conv_position_locked(c);
}
// glibren.25: "pronta" mas o .exfat de saida nao existe mais (apagado, disco trocado): conta como falhou.
static int conv_done_gone(const Conv* c) {
  struct stat st;
  return !strcmp(c->state, "done") && stat(c->output, &st);
}

// Uma conversao pedida pelo proprio payload, como o POST /convert do app, sem a resposta. 1 = na fila (ou ja existia com
// a mesma chave ou a mesma fonte). glibren.25: `out` (pode ser NULL) diz qual e onde esta na fila.
static int conv_add_auto(const char* key, const char* name, const char* kind, const char* const* sources, int nsources,
                         const char* output, const char* root, const char* label, const char* work, ConvAdded* out) {
  Conv* body = calloc(1, sizeof *body);
  if (!body) return 0;
  copy_text(body->key, sizeof body->key, key);
  copy_text(body->name, sizeof body->name, name);
  copy_text(body->kind, sizeof body->kind, kind);
  copy_text(body->source, sizeof body->source, sources[0]);
  copy_text(body->output, sizeof body->output, output);
  copy_text(body->root, sizeof body->root, root);
  copy_text(body->label, sizeof body->label, label);
  copy_text(body->work, sizeof body->work, work ? work : "");
  if (!strcmp(kind, "archive")) {
    for (int i = 0; i < nsources && i < ARC_MAX_VOLUMES; ++i) copy_text(body->sources[body->nsources++], sizeof body->sources[0], sources[i]);
    for (size_t i = 0; i < sizeof AUTO_PASSWORDS / sizeof *AUTO_PASSWORDS && i < ARC_MAX_PASSWORDS; ++i)
      copy_text(body->passwords[body->npasswords++], sizeof body->passwords[0], AUTO_PASSWORDS[i]);
  }
  char error[200];
  if (!conv_validate(body, error, sizeof error)) { logf_("conversao automatica recusada: %s", error); free(body); return 0; }
  pthread_mutex_lock(&g_conv_lock);
  // glibren.20: a mesma chave que falhou ou foi cancelada (um "Converter agora" de novo) volta para a fila, do comeco.
  // glibren.25: e tambem a "pronta" cujo .exfat sumiu.
  Conv* again = conv_by_key_locked(body->key);
  if (again && (!strcmp(again->state, "failed") || !strcmp(again->state, "cancelled") || conv_done_gone(again)) && !again->running) {
    char id[sizeof again->id];
    const __typeof__(again->created) created = again->created;
    copy_text(id, sizeof id, again->id);
    const int in_use = again->in_use; // glibren.41 (J4)
    *again = *body;
    copy_text(again->id, sizeof again->id, id);
    again->created = created;
    again->in_use = in_use;
    again->updated = now_s();
    snprintf(again->state, sizeof again->state, "queued");
    conv_save_locked();
    logf_("conversao %s pedida de novo pelo payload: %s (%s)", again->id, again->name, again->kind);
    conv_added_locked(out, again, "");
    pthread_cond_broadcast(&g_conv_wake);
    pthread_mutex_unlock(&g_conv_lock);
    free(body);
    return 1;
  }
  // glibren.25: o duplicado (mesma chave, ou a mesma fonte em andamento/pronta) nao some mais calado: vai para o log e
  // para a resposta. A pronta de outra chave cujo .exfat sumiu nao segura o pedido.
  const Conv* same = again ? again : conv_by_source_locked(body->source);
  if (same && same != again && conv_done_gone(same)) same = NULL;
  if (same) {
    logf_("conversao %s ja pedida (%s): %s", same->id, same->state, body->name);
    conv_added_locked(out, same, same->state);
    pthread_mutex_unlock(&g_conv_lock);
    free(body);
    return 1;
  }
  for (int i = 0; g_conv_count >= MAX_CONVS && i < g_conv_count; ++i) {
    if (!conv_terminal(g_convs[i]->state) || g_convs[i]->running || g_convs[i]->in_use) continue;
    free(g_convs[i]);
    memmove(&g_convs[i], &g_convs[i + 1], sizeof(Conv*) * (size_t)(g_conv_count - i - 1));
    --g_conv_count;
  }
  if (g_conv_count >= MAX_CONVS) { pthread_mutex_unlock(&g_conv_lock); free(body); return 0; }
  snprintf(body->id, sizeof body->id, "c%u", ++g_conv_next);
  body->created = body->updated = now_s();
  snprintf(body->state, sizeof body->state, "queued");
  g_convs[g_conv_count++] = body;
  conv_save_locked();
  logf_("conversao %s pedida pelo payload: %s (%s)", body->id, body->name, body->kind);
  conv_added_locked(out, body, "");
  pthread_cond_broadcast(&g_conv_wake);
  pthread_mutex_unlock(&g_conv_lock);
  return 1;
}

static int conv_name_order(const void* a, const void* b) { return strcmp((const char*)a, (const char*)b); }
static int auto_archive_name(const char* name) {
  const char* const ext[] = {".rar", ".zip", ".7z", ".tar", ".tgz", ".tar.gz", ".tar.xz", ".tar.bz2", ".tar.zst"};
  for (size_t i = 0; i < sizeof ext / sizeof *ext; ++i) if (arc_ends(name, ext[i])) return 1;
  const size_t n = strlen(name);
  // volumes: .001, .r00
  return n > 4 && name[n - 4] == '.' && isdigit((unsigned char)name[n - 1]) && isdigit((unsigned char)name[n - 2]) &&
         (isdigit((unsigned char)name[n - 3]) || name[n - 3] == 'r' || name[n - 3] == 'R');
}
// <disco>/homebrew/<id>.exfat (-2, -3... se ja houver) e o rotulo: exfatOutput/exfatLabel (exfat-convert.js).
static void auto_output(const char* root, const char* code, const char* fallback, char* output, size_t cap, char* label, size_t label_cap) {
  char id[96];
  if (system_code_ok(code)) snprintf(id, sizeof id, "%s", code);
  else {
    copy_text(id, sizeof id, fallback);
    char* dot = strrchr(id, '.');
    if (dot && dot != id) *dot = 0;
    for (char* p = id; *p; ++p) if (!isalnum((unsigned char)*p) && *p != '_' && *p != '.' && *p != '-') *p = '_';
    if (!id[0]) snprintf(id, sizeof id, "jogo");
  }
  struct stat st;
  for (int n = 1; n < 100; ++n) {
    if (n == 1) snprintf(output, cap, "%s/homebrew/%s.exfat", root, id);
    else snprintf(output, cap, "%s/homebrew/%s-%d.exfat", root, id, n);
    if (stat(output, &st)) break;
  }
  snprintf(label, label_cap, "%.11s", system_code_ok(code) ? code : "JOBE");
  for (char* p = label; *p; ++p) *p = (char)toupper((unsigned char)*p);
}

// Converte o que esta em <root>/BACKUP/<name>: o .pkg de PS5 (o maior), senao o compactado (os volumes juntos, o
// primeiro primeiro). -> 1 pedida (ou ja pedida), 0 nada para converter, -1 jogo de PS4, -2 ja convertido.
// glibren.25: `out` (pode ser NULL), como em conv_add_auto.
// glibren.25: `where` (pode ser NULL) recebe o .exfat achado quando da -2.
static int backup_convert(const char* root, const char* name, const char* key, ConvAdded* out, char* where, size_t where_cap) {
  char dir[600];
  snprintf(dir, sizeof dir, "%.255s/BACKUP/%.255s", root, name);
  BackupInfo info;
  char converted[256];
  backup_info(root, dir, name, &info, converted, sizeof converted, where, where_cap);
  if (!strcmp(info.platform, "ps4")) return -1;
  if (converted[0]) return -2;
  DIR* d = opendir(dir);
  if (!d) return 0;
  char pkg[300] = "", archives[ARC_MAX_VOLUMES * 2][256];
  uint64_t pkg_size = 0;
  int count = 0;
  for (struct dirent* it; (it = readdir(d));) {
    if (it->d_name[0] == '.' || strlen(it->d_name) >= 256) continue;
    char path[900];
    snprintf(path, sizeof path, "%s/%s", dir, it->d_name);
    struct stat st;
    if (stat(path, &st) || !S_ISREG(st.st_mode)) continue;
    if (arc_ends(it->d_name, ".part") || arc_ends(it->d_name, ".resume")) continue; // ainda baixando
    if ((arc_ends(it->d_name, ".pkg") || arc_ends(it->d_name, ".fpkg")) && (uint64_t)st.st_size > pkg_size) { copy_text(pkg, sizeof pkg, it->d_name); pkg_size = (uint64_t)st.st_size; }
    else if (auto_archive_name(it->d_name) && count < ARC_MAX_VOLUMES * 2) copy_text(archives[count++], sizeof archives[0], it->d_name);
  }
  closedir(d);
  char output[1100], label[32], sources[ARC_MAX_VOLUMES][900];
  const char* list[ARC_MAX_VOLUMES];
  int n = 0;
  if (pkg[0]) {
    snprintf(sources[0], sizeof sources[0], "%s/%s", dir, pkg);
    list[n++] = sources[0];
  } else if (count) {
    qsort(archives, (size_t)count, sizeof archives[0], conv_name_order);
    // Um ".rar" que nao e ".partN.rar" vem antes dos ".r00" (o primeiro volume do jeito antigo).
    for (int i = 0; i < count; ++i) if (arc_ends(archives[i], ".rar") && !strstr(archives[i], ".part")) { char first[256]; memcpy(first, archives[i], sizeof first); memmove(archives[1], archives[0], sizeof archives[0] * (size_t)i); memcpy(archives[0], first, sizeof first); break; }
    for (int i = 0; i < count && n < ARC_MAX_VOLUMES; ++i) { snprintf(sources[n], sizeof sources[n], "%.600s/%.255s", dir, archives[i]); list[n] = sources[n]; ++n; }
  } else {
    return 0;
  }
  char homebrew[600];
  snprintf(homebrew, sizeof homebrew, "%.580s/homebrew", root);
  mkdir_p(homebrew);
  auto_output(root, info.code, pkg[0] ? pkg : archives[0], output, sizeof output, label, sizeof label);
  char conv_key[128];
  snprintf(conv_key, sizeof conv_key, "%.120s", key);
  return conv_add_auto(conv_key, name, pkg[0] ? "pkg" : "archive", list, n, output, root, label, NULL, out) ? 1 : 0;
}

// A pasta do jogo de PS5 dentro do que foi extraido (a que tem sce_sys/param.json), ate 4 niveis; e um .pkg achado.
static int auto_find_game(const char* dir, int depth, char* game, size_t cap, char* pkg, size_t pkg_cap) {
  char probe[1200];
  struct stat st;
  snprintf(probe, sizeof probe, "%s/sce_sys/param.json", dir);
  if (!stat(probe, &st)) { copy_text(game, cap, dir); return 1; }
  if (depth >= 4) return 0;
  DIR* d = opendir(dir);
  if (!d) return 0;
  int found = 0;
  for (struct dirent* it; !found && (it = readdir(d));) {
    if (it->d_name[0] == '.') continue;
    char path[1200];
    snprintf(path, sizeof path, "%s/%s", dir, it->d_name);
    if (lstat(path, &st)) continue;
    if (S_ISDIR(st.st_mode)) found = auto_find_game(path, depth + 1, game, cap, pkg, pkg_cap);
    else if (S_ISREG(st.st_mode) && !pkg[0] && (arc_ends(it->d_name, ".pkg") || arc_ends(it->d_name, ".fpkg"))) copy_text(pkg, pkg_cap, path);
  }
  closedir(d);
  return found;
}
// glibren.55: a maior imagem pronta (.exfat ou .ffpfs) do que foi extraido, ate 4 niveis: 1 achou.
static int auto_find_image(const char* dir, int depth, char* image, size_t cap, uint64_t* best) {
  if (depth > 4) return 0;
  DIR* d = opendir(dir);
  if (!d) return 0;
  int found = 0;
  for (struct dirent* it; (it = readdir(d));) {
    if (it->d_name[0] == '.') continue;
    char path[1200];
    struct stat st;
    snprintf(path, sizeof path, "%s/%s", dir, it->d_name);
    if (lstat(path, &st)) continue;
    if (S_ISDIR(st.st_mode)) found |= auto_find_image(path, depth + 1, image, cap, best);
    else if (S_ISREG(st.st_mode) && (arc_ends(it->d_name, ".exfat") || arc_ends(it->d_name, ".ffpfs")) && (uint64_t)st.st_size > *best) {
      *best = (uint64_t)st.st_size;
      copy_text(image, cap, path);
      found = 1;
    }
  }
  closedir(d);
  return found;
}
// Extrai o compactado de `c` em `work` (libarchive, sem sair da pasta: nada de "..", caminho absoluto ou link perigoso).
static int auto_extract(Conv* c, const char* work, char* err, size_t cap) {
  struct archive* a = arc_open(c, err, cap);
  if (!a) return 0;
  struct archive* out = archive_write_disk_new();
  if (!out) { archive_read_free(a); snprintf(err, cap, "out of memory"); return 0; }
  // O caminho ja vem limpo (arc_clean_path) e absoluto dentro de work. SECURE_NOABSOLUTEPATHS nao entra porque o
  // proprio caminho de destino e absoluto (work/...); a defesa contra links e o filtro de tipo abaixo (R2-2).
  // glibren.55: SECURE_SYMLINKS saiu. Ele faz lstat de cada pedaco do caminho desde a raiz ("/mnt", "/mnt/ext0", ...), e
  // no PS5 real isso falhava num disco USB: "write: Could not stat /mnt/ext0/BACKUP/_temp/c21/PPSA02572.exfat" (Alan
  // Wake 2, .exfat dentro de .7z, 13/11/2026). Nenhum link simbolico entra em work: o filtro abaixo pula todos, os
  // hardlinks so apontam para arquivos que esta extracao gravou, e work e criada vazia agora (conv_extract_in_place).
  archive_write_disk_set_options(out, ARCHIVE_EXTRACT_TIME | ARCHIVE_EXTRACT_SECURE_NODOTDOT);
  struct archive_entry* e;
  int rc = 1, r;
  char* block = malloc(ARC_BLOCK);
  if (!block) { archive_read_free(a); archive_write_free(out); snprintf(err, cap, "out of memory"); return 0; }
  uint32_t skipped = 0;
  uint64_t extracted = 0; // glibren.58: o progresso (conv_extract_tick, a cada bloco)
  // R2-3: ARCHIVE_WARN (nome fora do locale, por exemplo) segue, como no arc_plan.
  while ((r = archive_read_next_header(a, &e)) == ARCHIVE_OK || r == ARCHIVE_WARN) {
    if (c->cancel || g_stop) { rc = 0; snprintf(err, cap, "stopped"); break; }
    char clean[1024], full[2200];
    // R2-3: o nome pode vir NULL (caractere fora do locale "C" do payload): mesmo padrao do arc_plan.
    const char* name = archive_entry_pathname_utf8(e);
    if (!name) name = archive_entry_pathname(e);
    if (!name || !arc_clean_path(name, clean, sizeof clean)) { archive_read_data_skip(a); skipped++; continue; }
    // R2-2: so arquivo comum e pasta. Link simbolico, aparelho e fifo ficam de fora. Hardlink so para um arquivo que
    // esta mesma extracao ja gravou dentro de work (o alvo e reescrito para work/...); alvo absoluto, com "..", que
    // ainda nao existe ou que nao e arquivo comum e pulado.
    // (Um hardlink do tar pode vir sem tipo no modo: o alvo e conferido abaixo.)
    const mode_t type = archive_entry_filetype(e);
    const int hard = archive_entry_hardlink(e) || archive_entry_hardlink_utf8(e);
    if ((type != AE_IFREG && type != AE_IFDIR && !(hard && type == 0)) || (hard && type == AE_IFDIR) || archive_entry_symlink(e)) {
      archive_read_data_skip(a);
      skipped++;
      continue;
    }
    if (hard) {
      const char* target = archive_entry_hardlink_utf8(e);
      if (!target) target = archive_entry_hardlink(e);
      char tclean[1024], tfull[2200];
      struct stat tst;
      if (!target || target[0] == '/' || !arc_clean_path(target, tclean, sizeof tclean) ||
          snprintf(tfull, sizeof tfull, "%s/%s", work, tclean) >= (int)sizeof tfull || lstat(tfull, &tst) || !S_ISREG(tst.st_mode)) {
        archive_read_data_skip(a);
        skipped++;
        continue;
      }
      archive_entry_set_hardlink(e, tfull);
    }
    snprintf(full, sizeof full, "%s/%s", work, clean);
    archive_entry_set_pathname(e, full);
    const int w = archive_write_header(out, e);
    if (w != ARCHIVE_OK && w != ARCHIVE_WARN) { rc = 0; snprintf(err, cap, "write: %s", archive_error_string(out) ? archive_error_string(out) : "extract"); break; }
    for (la_ssize_t got; (got = archive_read_data(a, block, ARC_BLOCK)) != 0;) {
      if (got < 0 || archive_write_data(out, block, (size_t)got) != got) { rc = 0; snprintf(err, cap, "source: %s", archive_error_string(a) ? archive_error_string(a) : "read"); break; }
      extracted += (uint64_t)got;
      const la_int64_t read = archive_filter_bytes(a, -1);
      conv_extract_tick(c, extracted, 0, read > 0 ? (uint64_t)read : 0);
      if (g_conv_delay_ms) sleep_ms(g_conv_delay_ms); // testes: da tempo de ler o progresso
      if (c->cancel || g_stop) { rc = 0; snprintf(err, cap, "stopped"); break; }
    }
    if (!rc) break;
    archive_write_finish_entry(out);
  }
  if (rc && r != ARCHIVE_EOF) { rc = 0; snprintf(err, cap, "source: %s", archive_error_string(a) ? archive_error_string(a) : "the archive could not be read"); }
  if (skipped) logk_("conversao %s: extracao pulou %u entrada(s) (link, hardlink, tipo especial ou nome invalido)", c->id, skipped);
  free(block);
  archive_read_free(a);
  archive_write_free(out);
  return rc;
}
// glibren.20b: RAR (cifrado ou nao) pelo rar-extract.elf do app, num processo separado (bg_rar.c).
#include "bg_rar.c"

// glibren.20: uma conversao de compactado que nao deu direto: extrai em <disco>/BACKUP/_temp/<id> (o mesmo disco do
// original, entao sem copiar entre discos) e a MESMA conversao segue com a pasta do jogo ("dir") ou o .pkg de PS5 de
// dentro ("pkg"), com a pasta temporaria como pasta de trabalho: apagada quando o .exfat fica pronto, e tambem quando a
// conversao falha ou e cancelada (conv_loop). Um .pkg de PS4 vai para <disco>/PS4/ (o app instala).
static void conv_fail_extract(Conv* c, const char* work, const char* message) {
  conv_remove_tree(work, 0);
  logk_("conversao %s: falhou: %s", c->id, message);
  conv_finish(c, "failed", message);
  char text[400];
  snprintf(text, sizeof text, "%s: conversao para EXFAT falhou", c->name);
  notify(text);
}
static void conv_extract_in_place(Conv* c) {
  char work[1100], dir[1100], err[300] = "", game[1200] = "", pkg[1200] = "", message[700];
  snprintf(dir, sizeof dir, "%.900s/BACKUP/_temp", c->root);
  snprintf(work, sizeof work, "%.1000s/%s", dir, c->id);
  conv_remove_tree(work, 0); // uma extracao interrompida antes recomeca limpa
  if (mkdir_p(work)) {
    snprintf(message, sizeof message, "source: the temporary folder %s could not be created (%s)", work, strerror(errno));
    conv_fail_extract(c, work, message);
    return;
  }
  pthread_mutex_lock(&g_conv_lock);
  c->running = 1;
  c->written = c->total = 0;
  pthread_mutex_unlock(&g_conv_lock);
  conv_extract_begin(c); // glibren.58: formato, tamanho do compactado e total descompactado (arc_plan)
  conv_mark(c, "extraindo %s em %s (%s, %.2f GB descompactados)", base_name(c->source), work, c->ext_format[0] ? c->ext_format : "?", conv_gb(c->ext_total));
  // glibren.20b: RAR vai ao rar-extract (abre os cifrados); sem ele (ELF ou carregador ausentes), a libarchive.
  int extracted;
  if (rar_name(c->source)) {
    const int rar = rar_extract(c, work, err, sizeof err);
    if (rar < 0) {
      logk_("conversao %s: rar-extract indisponivel (%s); tentando a libarchive", c->id, err);
      conv_remove_tree(work, 0);
      mkdir_p(work);
      err[0] = 0;
      extracted = auto_extract(c, work, err, sizeof err);
    } else {
      extracted = rar;
    }
  } else {
    extracted = auto_extract(c, work, err, sizeof err);
  }
  pthread_mutex_lock(&g_conv_lock);
  c->running = 0;
  const int cancelled = c->cancel;
  pthread_mutex_unlock(&g_conv_lock);
  if (cancelled || g_stop) {
    conv_remove_tree(work, 0);
    if (g_stop && !cancelled) return; // fica "extracting": conv_load a poe na fila de novo
    conv_finish(c, "cancelled", "");
    return;
  }
  if (!extracted) {
    snprintf(message, sizeof message, "source: the archive could not be extracted either: %s", err);
    conv_fail_extract(c, work, message);
    return;
  }
  const char* kind = "dir";
  const char* source = game;
  if (!auto_find_game(work, 0, game, sizeof game, pkg, sizeof pkg)) {
    char code[16] = "";
    for (const char* p = pkg[0] ? base_name(pkg) : ""; *p && !code[0]; ++p)
      if (!strncasecmp(p, "CUSA", 4) || !strncasecmp(p, "PPSA", 4)) { snprintf(code, sizeof code, "%.9s", p); for (char* q = code; *q; ++q) *q = (char)toupper((unsigned char)*q); }
    if (pkg[0] && !strncmp(code, "CUSA", 4)) {
      char ps4[1100], to[1400];
      snprintf(ps4, sizeof ps4, "%.900s/PS4", c->root);
      mkdir_p(ps4);
      snprintf(to, sizeof to, "%s/%s", ps4, base_name(pkg));
      const int moved = !rename(pkg, to);
      if (moved) logk_("conversao %s: .pkg de PS4 extraido para %s (instalar pela Jobee'sLair)", c->id, to);
      snprintf(message, sizeof message, "not-a-game: a PS4 package, %s %.500s (install it in Jobee'sLair)", moved ? "moved to" : "could not be moved to", ps4);
      conv_fail_extract(c, work, message);
      return;
    }
    // glibren.55: uma imagem pronta (.exfat/.ffpfs dentro do compactado, como o Alan Wake 2 em .exfat.7z): nada a
    // converter, so publicar no destino (homebrew/<codigo>.<ext>) como a conversao faria.
    char image[1200] = "";
    uint64_t image_bytes = 0;
    if (!pkg[0] && auto_find_image(work, 0, image, sizeof image, &image_bytes)) {
      char output[sizeof c->output], parent[sizeof c->output];
      copy_text(output, sizeof output, c->output);
      const char* ext = arc_ends(image, ".ffpfs") ? ".ffpfs" : ".exfat";
      char* dot = strrchr(output, '.');
      if (dot && strchr(dot, '/') == NULL && (size_t)(dot - output) + strlen(ext) < sizeof output) strcpy(dot, ext);
      copy_text(parent, sizeof parent, output);
      char* slash = strrchr(parent, '/');
      if (slash) { *slash = 0; mkdir_p(parent); }
      struct stat st;
      if (!lstat(output, &st) || rename(image, output)) {
        snprintf(message, sizeof message, "write: the image was not moved to %.500s (%s)", output, errno ? strerror(errno) : "exists");
        conv_fail_extract(c, work, message);
        return;
      }
      sync_parent(output);
      conv_remove_tree(work, 0);
      pthread_mutex_lock(&g_conv_lock);
      copy_text(c->output, sizeof c->output, output);
      c->image_bytes = image_bytes;
      c->written = c->total = image_bytes;
      pthread_mutex_unlock(&g_conv_lock);
      logk_("conversao %s: imagem pronta dentro do compactado, publicada em %s (%llu bytes)", c->id, output, (unsigned long long)image_bytes);
      conv_finish(c, "done", "");
      snprintf(message, sizeof message, "%s: pronto (%s)", c->name, ext + 1);
      notify(message);
      conv_ask_scan(c);
      conv_mark(c, "fim: imagem extraida e publicada");
      return;
    }
    if (!pkg[0]) {
      conv_fail_extract(c, work, "not-a-game: no PS5 game folder or package in the archive");
      return;
    }
    kind = "pkg";
    source = pkg;
  }
  pthread_mutex_lock(&g_conv_lock);
  copy_text(c->kind, sizeof c->kind, kind);
  copy_text(c->source, sizeof c->source, source);
  copy_text(c->work, sizeof c->work, work);
  c->nsources = 0;
  c->error[0] = 0;
  c->written = c->total = 0;
  snprintf(c->state, sizeof c->state, "queued");
  c->updated = now_s();
  conv_save_locked();
  pthread_cond_broadcast(&g_conv_wake);
  pthread_mutex_unlock(&g_conv_lock);
  conv_mark(c, "extraido; converte agora %s (%s)", source, kind);
}

// POST /api/backup/convert {root, name} (com o PIN): "Converter agora" na lista do BACKUP.
static void conv_backup_convert(int fd, Request* r, int app) {
  if (!app && !monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  BackupDelete d = {{0}, {0}};
  JP jp = {r->body, r->body + r->content_length, 0};
  if (!r->content_length || !jp_object(&jp, backup_delete_field, &d)) { backup_reply(fd, app, 400, "{\"error\":\"expected {root, name}\"}"); return; }
  char roots[24][256];
  const int count = conv_backup_roots(roots, 24);
  int known = 0;
  for (int i = 0; i < count; ++i) if (!strcmp(roots[i], d.root)) known = 1;
  if (!known || !d.name[0] || d.name[0] == '.' || !strcmp(d.name, "_temp") || strchr(d.name, '/') || strchr(d.name, '\\')) { backup_reply(fd, app, 400, "{\"error\":\"invalid backup\"}"); return; }
  char key[128];
  backup_key(key, sizeof key, d.name);
  ConvAdded added = {"", "", 0};
  char where[700] = "";
  const int rc = backup_convert(d.root, d.name, key, &added, where, sizeof where);
  // glibren.25: ja convertido, mas o .exfat nao esta onde a conversao o pos (o gamer renomeou ou moveu: "Pinball_FX-
  // PPSA08755-US-PS5.exfat" em /data/homebrew): nao converte de novo; diz onde esta. No lugar de sempre segue o
  // {error:"converted"} de antes.
  if (rc == -2 && where[0]) {
    char usual[700];
    BackupInfo info;
    char name_only[256];
    char dir[600];
    snprintf(dir, sizeof dir, "%.255s/BACKUP/%.255s", d.root, d.name);
    backup_info(d.root, dir, d.name, &info, name_only, sizeof name_only, NULL, 0);
    snprintf(usual, sizeof usual, "%.255s/homebrew/%s.exfat", d.root, info.code);
    if (strcmp(usual, where)) {
      pthread_mutex_lock(&g_conv_lock);
      const Conv* had = conv_by_key_locked(key);
      char id[24] = "";
      if (had) copy_text(id, sizeof id, had->id);
      pthread_mutex_unlock(&g_conv_lock);
      if (id[0]) logk_("conversao %s: ja convertido em %s", id, where);
      else logk_("%s: BACKUP %s ja convertido em %s", backup_who(app), d.name, where);
      Buf b = {0};
      buf_str(&b, "{\"ok\":true,\"already\":\"converted\",\"path\":"); buf_json(&b, where);
      if (id[0]) { buf_str(&b, ",\"id\":"); buf_json(&b, id); }
      buf_str(&b, "}");
      if (b.failed || !b.data) backup_reply(fd, app, 500, "{\"error\":\"out of memory\"}");
      else backup_reply(fd, app, 200, b.data);
      free(b.data);
      return;
    }
  }
  // glibren.25: diz onde ficou: {ok, state:"queued", position, id} (0 = convertendo agora) ou {ok, already:<estado>, id,
  // position} se ja estava pedida. Antes era so {ok:true} e o app/celular ficavam sem retorno nenhum.
  char reply[160];
  if (rc == 1 && added.already[0])
    snprintf(reply, sizeof reply, "{\"ok\":true,\"already\":\"%s\",\"id\":\"%s\",\"position\":%d}", added.already, added.id, added.position);
  else if (rc == 1)
    snprintf(reply, sizeof reply, "{\"ok\":true,\"state\":\"queued\",\"position\":%d,\"id\":\"%s\"}", added.position, added.id);
  else
    snprintf(reply, sizeof reply, "%s", rc == -1 ? "{\"error\":\"ps4\"}" : rc == -2 ? "{\"error\":\"converted\"}" : "{\"error\":\"nothing\"}");
  if (rc == 1) logk_("%s: converter agora %s/BACKUP/%s -> %s %s (posicao %d)", backup_who(app), d.root, d.name, added.id, added.already[0] ? added.already : "na fila", added.position);
  else logk_("%s: converter agora %s/BACKUP/%s -> %d", backup_who(app), d.root, d.name, rc);
  backup_reply(fd, app, rc == 1 ? 200 : 400, reply);
}

// glibren.20: POST /api/backup/convert-all (com o PIN): "Converter todos" na lista do BACKUP: cada jogo de PS5 ainda nao
// convertido entra na fila (os que nao derem direto o payload extrai em BACKUP/_temp). {queued, ps4, converted, nothing}.
static void conv_backup_convert_all(int fd, Request* r, int app) {
  if (!app && !monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  char roots[24][256];
  const int count = conv_backup_roots(roots, 24);
  int queued = 0, ps4 = 0, converted = 0, nothing = 0;
  for (int i = 0; i < count; ++i) {
    char dir[300];
    snprintf(dir, sizeof dir, "%.255s/BACKUP", roots[i]);
    DIR* d = opendir(dir);
    if (!d) continue;
    char names[256][256];
    int n = 0;
    for (struct dirent* it; (it = readdir(d)) && n < 256;) {
      if (it->d_name[0] == '.' || !strcmp(it->d_name, "_temp") || strlen(it->d_name) >= 256) continue;
      copy_text(names[n++], sizeof names[0], it->d_name);
    }
    closedir(d);
    for (int k = 0; k < n; ++k) {
      char key[128];
      backup_key(key, sizeof key, names[k]);
      const int rc = backup_convert(roots[i], names[k], key, NULL, NULL, 0);
      if (rc == 1) ++queued; else if (rc == -1) ++ps4; else if (rc == -2) ++converted; else ++nothing;
    }
  }
  logk_("%s: converter todos -> %d na fila, %d de PS4, %d ja convertidos, %d sem o que converter", backup_who(app), queued, ps4, converted, nothing);
  char body[160];
  snprintf(body, sizeof body, "{\"ok\":true,\"queued\":%d,\"ps4\":%d,\"converted\":%d,\"nothing\":%d}", queued, ps4, converted, nothing);
  backup_reply(fd, app, 200, body);
}

// glibren.20: GET /api/log (com o PIN): o diario do payload (bgdl.log.old + bgdl.log, os ultimos ~1,5 MiB), para ver no
// celular por que uma conversao ou um download falhou e mandar a quem for ajudar.
static void conv_log(int fd, Request* r, int app) {
  if (!app && !monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  // R2-12: o app le no maximo 1 MiB (background-downloads.js); o texto vai num JSON (as quebras de linha dobram), entao
  // para ele so os ultimos 512 KiB. A pagina do celular segue com ~1,5 MiB.
  const size_t cap = app ? 512 * 1024 : 1536 * 1024;
  Buf b = {0};
  char old[700];
  snprintf(old, sizeof old, "%.690s.old", g_log_path);
  const char* paths[2] = {old, g_log_path};
  for (int i = 0; i < 2; ++i) {
    size_t size = 0;
    char* text = read_text(paths[i], 8u * 1024 * 1024, &size);
    if (!text) continue;
    buf_add(&b, text, size);
    free(text);
  }
  if (b.failed || !b.data) {
    if (app) respond(fd, 200, "{\"text\":\"\"}");
    else monitor_send(fd, 200, "text/plain; charset=utf-8", "", 0);
    free(b.data);
    return;
  }
  const char* from = b.data;
  size_t size = b.size;
  if (size > cap) {
    from += size - cap;
    size = cap;
    const char* line = memchr(from, '\n', size);
    if (line) { size -= (size_t)(line + 1 - from); from = line + 1; }
  }
  if (app) {
    // glibren.22: para o app, o texto num JSON ({"text": ...}), como o resto da API local.
    Buf j = {0};
    buf_str(&j, "{\"text\":");
    char* text = malloc(size + 1);
    if (text) { memcpy(text, from, size); text[size] = 0; buf_json(&j, text); free(text); }
    else buf_str(&j, "\"\"");
    buf_str(&j, "}");
    respond(fd, j.failed || !j.data ? 500 : 200, j.failed || !j.data ? "{\"error\":\"out of memory\"}" : j.data);
    free(j.data);
  } else {
    monitor_send(fd, 200, "text/plain; charset=utf-8", from, size);
  }
  free(b.data);
}

// Rotas da pagina do celular. 1 = tratou.
static int conv_monitor_route(int fd, Request* r) {
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/backup/convert-all")) { conv_backup_convert_all(fd, r, 0); return 1; } // glibren.20
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/log")) { conv_log(fd, r, 0); return 1; } // glibren.20
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/backup")) { conv_backup_list(fd, 0); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/backup/delete")) { conv_backup_delete(fd, r, 0); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/backup/convert")) { conv_backup_convert(fd, r, 0); return 1; } // glibren.18
  return 0;
}

// glibren.22: as mesmas acoes para o app, na API local (com o token): a tela "Pasta BACKUP" da aba Downloads da Jobe.
//   GET  /backup                       a lista, com a conversao de cada item ("conversion")
//   POST /backup/convert {root, name}  converte um item
//   POST /backup/convert-all           converte todos os de PS5 ainda nao convertidos
//   POST /backup/delete {root, name}   apaga um item
//   GET  /log                          o diario do payload ({text})
static int conv_app_route(int fd, Request* r) {
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/backup")) { conv_backup_list(fd, 1); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/backup/convert")) { conv_backup_convert(fd, r, 1); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/backup/convert-all")) { conv_backup_convert_all(fd, r, 1); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/backup/delete")) { conv_backup_delete(fd, r, 1); return 1; }
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/log")) { conv_log(fd, r, 1); return 1; }
  return 0;
}
