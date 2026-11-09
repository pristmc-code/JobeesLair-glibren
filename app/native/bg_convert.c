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

#include "exfat_writer.c"
#include "pkg_source.c"

#define MAX_CONVS 32
#define ARC_MAX_VOLUMES 8
#define ARC_MAX_PASSWORDS 8
#define CONV_MARGIN (64ull * 1024 * 1024)

static int session_ok(const char* given);
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
} Conv;

static pthread_mutex_t g_conv_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_conv_wake = PTHREAD_COND_INITIALIZER;
static Conv* g_convs[MAX_CONVS];
static int g_conv_count;
static unsigned g_conv_next;
static char g_smp_base[256] = "http://127.0.0.1:10101/api/v1";
static int g_conv_delay_ms; // testes: espera por passo de progresso (BGDL_CONVERT_DELAY_MS)

static int conv_terminal(const char* state) { return !strcmp(state, "done") || !strcmp(state, "failed") || !strcmp(state, "cancelled"); }

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
  if (c->work[0] && (!conv_inside(c->work, downloads) || (!strcmp(c->kind, "dir") && strcmp(c->source, c->work) && !conv_inside(c->source, c->work)))) {
    snprintf(error, cap, "work must be inside <root>/downloads and hold the source"); return 0;
  }
  if (strlen(c->label) > 11) c->label[11] = 0;
  return 1;
}

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
        free(c);
      } else {
        // Parada no meio: recomeca limpa (o .part some quando ela rodar de novo).
        if (!strcmp(c->state, "converting") || !strcmp(c->state, "verifying") || !strcmp(c->state, "extracting") || !c->state[0]) {
          snprintf(c->state, sizeof c->state, "queued");
          c->written = 0;
          logf_("conversao %s (%s): parada no meio; recomeca do zero", c->id, c->name);
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
static void conv_ask_scan(void) {
  if (!g_smp_base[0]) return;
  CURL* curl = curl_easy_init();
  if (!curl) return;
  char url[300];
  snprintf(url, sizeof url, "%s/scan", g_smp_base);
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
  logf_("ShadowMount+: varredura pedida (%s, HTTP %ld)", result == CURLE_OK ? "ok" : curl_easy_strerror(result), status);
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
}

typedef struct { Conv* c; int64_t last_save; } ConvProgress;
static int conv_progress(void* ctx, uint64_t done, uint64_t total) {
  ConvProgress* p = ctx;
  pthread_mutex_lock(&g_conv_lock);
  p->c->written = done;
  p->c->total = total;
  const int64_t now = mono_ms();
  if (now - p->last_save >= 15000) { p->last_save = now; p->c->updated = now_s(); conv_save_locked(); }
  pthread_mutex_unlock(&g_conv_lock);
  if (g_conv_delay_ms) sleep_ms(g_conv_delay_ms);
  return p->c->cancel || g_stop ? 1 : 0;
}

static void conv_finish(Conv* c, const char* state, const char* error) {
  pthread_mutex_lock(&g_conv_lock);
  c->running = 0; // ja pode ser esquecida ou pedida de novo
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
static int arc_plan(const Conv* c, exw_entry** out, size_t* count, char* err, size_t cap) {
  ArcList l = {0};
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
    ++l.count;
    // So os cabecalhos: os dados sao pulados pela proxima chamada.
  }
  if (!rc && header != ARCHIVE_EOF) {
    snprintf(err, cap, "not-direct: %s", archive_error_string(a) ? archive_error_string(a) : "the archive could not be listed");
    rc = -1;
  }
  archive_read_free(a);
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
  exw_plan plan;
  if (exw_plan_image(entries, count, c->label, &plan, err, sizeof err)) { snprintf(message, sizeof message, "source: %s", err); goto end; }
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
    ConvProgress progress = {c, mono_ms()};
    err[0] = 0;
    const int written = exw_write(part, entries, count, c->label, reader, reader_ctx, conv_progress, &progress, err, sizeof err);
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
  err[0] = 0;
  // O compactado e lido em fluxo (os CRC do RAR/7z/zip ja conferem cada arquivo na leitura): so nomes e tamanhos.
  if (exw_verify(part, entries, count, reader, reader_ctx, arc ? 0 : 1, err, sizeof err)) { snprintf(message, sizeof message, "verify: %s", err); goto end; }
  if (!lstat(c->output, &st) || rename(part, c->output)) {
    snprintf(message, sizeof message, "write: the image was not renamed to %s (%s)", base_name(c->output), errno ? strerror(errno) : "exists");
    goto end;
  }
  sync_parent(c->output);
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
    conv_set_state(c, "extracting");
    return;
  }
  if (!strcmp(outcome, "failed")) logk_("conversao %s: falhou: %s", c->id, message);
  conv_finish(c, outcome, !strcmp(outcome, "failed") ? message : "");
  if (!strcmp(outcome, "done")) {
    char text[400];
    snprintf(text, sizeof text, "%s: pronto (EXFAT)", c->name);
    notify(text);
    conv_ask_scan();
  } else if (!strcmp(outcome, "failed")) {
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
  while (!g_stop) {
    pthread_mutex_lock(&g_conv_lock);
    Conv* next = NULL;
    for (int i = 0; i < g_conv_count && !next; ++i) if (!strcmp(g_convs[i]->state, "queued")) next = g_convs[i];
    if (!next) {
      struct timespec until;
      clock_gettime(CLOCK_REALTIME, &until);
      until.tv_sec += 1;
      pthread_cond_timedwait(&g_conv_wake, &g_conv_lock, &until);
      pthread_mutex_unlock(&g_conv_lock);
      continue;
    }
    next->running = 1;
    next->cancel = 0;
    pthread_mutex_unlock(&g_conv_lock);
    conv_run(next);
    pthread_mutex_lock(&g_conv_lock);
    next->running = 0;
    // glibren.20: qualquer conversao que nao deu direto (do app, do payload ou "Converter agora") e extraida aqui.
    const int extract = !strcmp(next->state, "extracting");
    const int leftover = (!strcmp(next->state, "failed") || !strcmp(next->state, "cancelled")) && conv_temp_work(next);
    char work[1024];
    copy_text(work, sizeof work, next->work);
    pthread_mutex_unlock(&g_conv_lock);
    if (extract) conv_extract_in_place(next);
    else if (leftover && conv_remove_tree(work, 0)) logf_("conversao %s: pasta temporaria %s nao apagada inteira", next->id, work);
  }
  return NULL;
}

static void conv_start(void) {
  snprintf(g_smp_base, sizeof g_smp_base, "%s", env_or("BGDL_SMP_BASE", g_smp_base));
  g_conv_delay_ms = atoi(env_or("BGDL_CONVERT_DELAY_MS", "0"));
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
  if (again) { conv_save_locked(); logk_("conversoes: %d que nao deram direto voltam para a fila (o payload extrai)", again); }
  pthread_mutex_unlock(&g_conv_lock);
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
        if (!conv_terminal(g_convs[i]->state) || g_convs[i]->running) continue;
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
    *c = *body;
    snprintf(c->id, sizeof c->id, "%s", id);
    c->created = created;
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
    buf_str(&b, "]}");
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
      if (c->running) status = 409;
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
  buf_str(b, "]");
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
static void backup_info(const char* root, const char* path, const char* name, BackupInfo* info, char* converted, size_t cap) {
  memset(info, 0, sizeof *info);
  converted[0] = 0;
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
    snprintf(image, sizeof image, "%.255s/homebrew/%s.exfat", root, info->code);
    if (!stat(image, &st) && S_ISREG(st.st_mode)) snprintf(converted, cap, "%s.exfat", info->code);
  }
}
static unsigned backup_parts(const BackupInfo* info) {
  for (int i = 0; i < 10; ++i) if (!strcmp(info->format, BACKUP_FORMATS[i])) return info->counts[i] > 1 ? info->counts[i] : 0;
  return 0;
}

static void conv_backup_list(int fd) {
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
      char converted[32];
      backup_info(roots[i], path, it->d_name, &info, converted, sizeof converted);
      buf_str(&b, ",\"platform\":"); buf_json(&b, info.platform);
      buf_str(&b, ",\"code\":"); buf_json(&b, info.code);
      buf_str(&b, ",\"format\":"); buf_json(&b, info.format);
      buf_fmt(&b, ",\"parts\":%u,\"fileNames\":[", backup_parts(&info));
      for (int k = 0; k < info.named; ++k) { if (k) buf_str(&b, ","); buf_json(&b, info.names[k]); }
      buf_fmt(&b, "],\"moreFiles\":%d,\"converted\":", info.more);
      buf_json(&b, converted);
      buf_str(&b, "}");
    }
    closedir(d);
  }
  buf_fmt(&b, "],\"totalBytes\":%llu}", (unsigned long long)all);
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_json(fd, 200, b.data);
  free(b.data);
}

typedef struct { char root[256], name[256]; } BackupDelete;
static int backup_delete_field(JP* jp, const char* key, void* ctx) {
  BackupDelete* d = ctx;
  if (!strcmp(key, "root")) return jp_text(jp, d->root, sizeof d->root) ? 1 : -1;
  if (!strcmp(key, "name")) return jp_text(jp, d->name, sizeof d->name) ? 1 : -1;
  return 0;
}

static void conv_backup_delete(int fd, Request* r) {
  if (!session_ok(r->session)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  BackupDelete d = {{0}, {0}};
  JP jp = {r->body, r->body + r->content_length, 0};
  if (!r->content_length || !jp_object(&jp, backup_delete_field, &d)) { monitor_json(fd, 400, "{\"error\":\"expected {root, name}\"}"); return; }
  char roots[24][256];
  const int count = conv_backup_roots(roots, 24);
  int known = 0;
  for (int i = 0; i < count; ++i) if (!strcmp(roots[i], d.root)) known = 1;
  if (!known || !d.name[0] || d.name[0] == '.' || strchr(d.name, '/') || strchr(d.name, '\\')) { monitor_json(fd, 400, "{\"error\":\"invalid backup\"}"); return; }
  char path[600];
  snprintf(path, sizeof path, "%.255s/BACKUP/%.255s", d.root, d.name);
  struct stat st;
  if (lstat(path, &st)) { monitor_json(fd, 404, "{\"error\":\"no such backup\"}"); return; }
  // Nao apaga o original de uma conversao que ainda o le (um .pkg convertido direto do BACKUP).
  pthread_mutex_lock(&g_conv_lock);
  int busy = 0;
  for (int i = 0; i < g_conv_count; ++i) if (!conv_terminal(g_convs[i]->state) && (conv_inside(g_convs[i]->source, path) || !strcmp(g_convs[i]->source, path))) busy = 1;
  pthread_mutex_unlock(&g_conv_lock);
  if (busy) { monitor_json(fd, 409, "{\"error\":\"converting\"}"); return; }
  const int failed = conv_remove_tree(path, 0);
  logk_("celular: BACKUP %s apagado%s", path, failed ? " (em parte)" : "");
  monitor_json(fd, failed ? 500 : 200, failed ? "{\"error\":\"not all deleted\"}" : "{\"ok\":true}");
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

// Uma conversao pedida pelo proprio payload, como o POST /convert do app, sem a resposta. 1 = na fila (ou ja existia com
// a mesma chave ou a mesma fonte).
static int conv_add_auto(const char* key, const char* name, const char* kind, const char* const* sources, int nsources,
                         const char* output, const char* root, const char* label, const char* work) {
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
  Conv* again = conv_by_key_locked(body->key);
  if (again && (!strcmp(again->state, "failed") || !strcmp(again->state, "cancelled")) && !again->running) {
    char id[sizeof again->id];
    const __typeof__(again->created) created = again->created;
    copy_text(id, sizeof id, again->id);
    *again = *body;
    copy_text(again->id, sizeof again->id, id);
    again->created = created;
    again->updated = now_s();
    snprintf(again->state, sizeof again->state, "queued");
    conv_save_locked();
    logf_("conversao %s pedida de novo pelo payload: %s (%s)", again->id, again->name, again->kind);
    pthread_cond_broadcast(&g_conv_wake);
    pthread_mutex_unlock(&g_conv_lock);
    free(body);
    return 1;
  }
  if (again || conv_by_source_locked(body->source)) { pthread_mutex_unlock(&g_conv_lock); free(body); return 1; }
  for (int i = 0; g_conv_count >= MAX_CONVS && i < g_conv_count; ++i) {
    if (!conv_terminal(g_convs[i]->state) || g_convs[i]->running) continue;
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
static int backup_convert(const char* root, const char* name, const char* key) {
  char dir[600];
  snprintf(dir, sizeof dir, "%.255s/BACKUP/%.255s", root, name);
  BackupInfo info;
  char converted[64];
  backup_info(root, dir, name, &info, converted, sizeof converted);
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
  return conv_add_auto(conv_key, name, pkg[0] ? "pkg" : "archive", list, n, output, root, label, NULL) ? 1 : 0;
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
// Extrai o compactado de `c` em `work` (libarchive, sem sair da pasta: nada de "..", caminho absoluto ou link perigoso).
static int auto_extract(const Conv* c, const char* work, char* err, size_t cap) {
  struct archive* a = arc_open(c, err, cap);
  if (!a) return 0;
  struct archive* out = archive_write_disk_new();
  if (!out) { archive_read_free(a); snprintf(err, cap, "out of memory"); return 0; }
  archive_write_disk_set_options(out, ARCHIVE_EXTRACT_TIME | ARCHIVE_EXTRACT_SECURE_NODOTDOT | ARCHIVE_EXTRACT_SECURE_SYMLINKS); // o caminho ja vem limpo (arc_clean_path) e absoluto dentro de work
  struct archive_entry* e;
  int rc = 1, r;
  char* block = malloc(ARC_BLOCK);
  if (!block) { archive_read_free(a); archive_write_free(out); snprintf(err, cap, "out of memory"); return 0; }
  while ((r = archive_read_next_header(a, &e)) == ARCHIVE_OK) {
    if (c->cancel || g_stop) { rc = 0; snprintf(err, cap, "stopped"); break; }
    char clean[1024], full[2200];
    if (!arc_clean_path(archive_entry_pathname(e), clean, sizeof clean)) { archive_read_data_skip(a); continue; }
    snprintf(full, sizeof full, "%s/%s", work, clean);
    archive_entry_set_pathname(e, full);
    if (archive_write_header(out, e) != ARCHIVE_OK) { rc = 0; snprintf(err, cap, "write: %s", archive_error_string(out) ? archive_error_string(out) : "extract"); break; }
    for (la_ssize_t got; (got = archive_read_data(a, block, ARC_BLOCK)) != 0;) {
      if (got < 0 || archive_write_data(out, block, (size_t)got) != got) { rc = 0; snprintf(err, cap, "source: %s", archive_error_string(a) ? archive_error_string(a) : "read"); break; }
    }
    if (!rc) break;
    archive_write_finish_entry(out);
  }
  if (rc && r != ARCHIVE_EOF) { rc = 0; snprintf(err, cap, "source: %s", archive_error_string(a) ? archive_error_string(a) : "the archive could not be read"); }
  free(block);
  archive_read_free(a);
  archive_write_free(out);
  return rc;
}
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
  logk_("conversao %s: extraindo %s em %s", c->id, base_name(c->source), work);
  const int extracted = auto_extract(c, work, err, sizeof err);
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
  logk_("conversao %s: extraido; converte agora %s (%s)", c->id, source, kind);
}

// POST /api/backup/convert {root, name} (com o PIN): "Converter agora" na lista do BACKUP.
static void conv_backup_convert(int fd, Request* r) {
  if (!session_ok(r->session)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  BackupDelete d = {{0}, {0}};
  JP jp = {r->body, r->body + r->content_length, 0};
  if (!r->content_length || !jp_object(&jp, backup_delete_field, &d)) { monitor_json(fd, 400, "{\"error\":\"expected {root, name}\"}"); return; }
  char roots[24][256];
  const int count = conv_backup_roots(roots, 24);
  int known = 0;
  for (int i = 0; i < count; ++i) if (!strcmp(roots[i], d.root)) known = 1;
  if (!known || !d.name[0] || d.name[0] == '.' || !strcmp(d.name, "_temp") || strchr(d.name, '/') || strchr(d.name, '\\')) { monitor_json(fd, 400, "{\"error\":\"invalid backup\"}"); return; }
  char key[128];
  snprintf(key, sizeof key, "backup-%.100s", d.name);
  for (char* p = key; *p; ++p) if ((unsigned char)*p < 0x20 || *p == '"' || *p == '\\') *p = '_';
  const int rc = backup_convert(d.root, d.name, key);
  logk_("celular: converter agora %s/BACKUP/%s -> %d", d.root, d.name, rc);
  monitor_json(fd, rc == 1 ? 200 : 400, rc == 1 ? "{\"ok\":true}" : rc == -1 ? "{\"error\":\"ps4\"}" : rc == -2 ? "{\"error\":\"converted\"}" : "{\"error\":\"nothing\"}");
}

// glibren.20: POST /api/backup/convert-all (com o PIN): "Converter todos" na lista do BACKUP: cada jogo de PS5 ainda nao
// convertido entra na fila (os que nao derem direto o payload extrai em BACKUP/_temp). {queued, ps4, converted, nothing}.
static void conv_backup_convert_all(int fd, Request* r) {
  if (!session_ok(r->session)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
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
      snprintf(key, sizeof key, "backup-%.100s", names[k]);
      for (char* p = key; *p; ++p) if ((unsigned char)*p < 0x20 || *p == '"' || *p == '\\') *p = '_';
      const int rc = backup_convert(roots[i], names[k], key);
      if (rc == 1) ++queued; else if (rc == -1) ++ps4; else if (rc == -2) ++converted; else ++nothing;
    }
  }
  logk_("celular: converter todos -> %d na fila, %d de PS4, %d ja convertidos, %d sem o que converter", queued, ps4, converted, nothing);
  char body[160];
  snprintf(body, sizeof body, "{\"ok\":true,\"queued\":%d,\"ps4\":%d,\"converted\":%d,\"nothing\":%d}", queued, ps4, converted, nothing);
  monitor_json(fd, 200, body);
}

// glibren.20: GET /api/log (com o PIN): o diario do payload (bgdl.log.old + bgdl.log, os ultimos ~1,5 MiB), para ver no
// celular por que uma conversao ou um download falhou e mandar a quem for ajudar.
static void conv_log(int fd, Request* r) {
  if (!session_ok(r->session)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  const size_t cap = 1536 * 1024;
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
  if (b.failed || !b.data) { monitor_send(fd, 200, "text/plain; charset=utf-8", "", 0); free(b.data); return; }
  const char* from = b.data;
  size_t size = b.size;
  if (size > cap) {
    from += size - cap;
    size = cap;
    const char* line = memchr(from, '\n', size);
    if (line) { size -= (size_t)(line + 1 - from); from = line + 1; }
  }
  monitor_send(fd, 200, "text/plain; charset=utf-8", from, size);
  free(b.data);
}

// Rotas da pagina do celular. 1 = tratou.
static int conv_monitor_route(int fd, Request* r) {
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/backup/convert-all")) { conv_backup_convert_all(fd, r); return 1; } // glibren.20
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/log")) { conv_log(fd, r); return 1; } // glibren.20
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/backup")) { conv_backup_list(fd); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/backup/delete")) { conv_backup_delete(fd, r); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/backup/convert")) { conv_backup_convert(fd, r); return 1; } // glibren.18
  return 0;
}
