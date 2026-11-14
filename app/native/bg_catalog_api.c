// Fase 3: o catalogo no payload residente. Parte do bg_catalog.c.
//
// Pastas (no PS5 /data/JobeesLair/catalog; BGDL_CATALOG_DIR nos testes):
//   bundled/        a copia do catalogo embutido que o app deixa a cada versao (state/catalog-payload.js), com o desenho
//                   de app/data: catalog/index.json, catalog/art/<n>.json, packs/{releases,pages}.{pack,idx}, formats.js,
//                   ratings.js e, por ultimo, version.json
//                   ({version, files:[{name, size}]}). Sem o version.json (ou com um tamanho errado) a copia nao vale.
//   config.json     o que o app diz das listas (state/catalog-payload.js): {feeds:[...], mirrors:[{url, list}], orbit:{on,id},
//                   hidden:[...], ps4, coverWidth, firmware, maxMb}. Sem ele: so o catalogo ao vivo.
//   feeds/<k>.json  a copia de cada feed da web que o PAYLOAD baixou (o texto decifrado, k = stableKey do endereco) e
//   feeds/<k>.meta  o estado dela ({url, from, etag, fetchedAt, games, name, mirrors, error}).
//   lists-home.json onde as listas publicadas estao agora (state/lists-home.js).
//
// A montagem roda na thread `catalog_loop`: confere a cada BGDL_CATALOG_CHECK_MS (5 s) se algum arquivo mudou (tamanho e
// hora de cada entrada: a copia do embutido, a configuracao, cada feed) e, mudou, monta um catalogo novo FORA do lock e
// troca o ponteiro sob g_cat_lock; o antigo sai quando o ultimo pedido que o usa termina (contagem de referencias). Nada
// e montado no modo quieto (o app fechando) nem antes de BGDL_CATALOG_FIRST_MS da subida (20 s: o app monta o dele).
//
// Teto de memoria: a montagem para quando o que ela aloca (ct_malloc) passa de BGDL_CATALOG_MAX_MB (ou "maxMb" do
// config.json; padrao 32 MiB, ~4x o pico medido com 3.200 jogos) e antes de comecar, quando o tamanho dos arquivos ja
// passaria. Passou: estado "over-limit", nada novo ate um arquivo mudar, /api/catalog responde 503 e /api/store volta ao
// store-index.json do app (o caminho antigo). O diario registra cada montagem com o tempo, o que o catalogo guarda, o pico
// e a residente (RSS) antes e depois.
//
// Rede: a thread `feeds_loop` baixa o catalogo ao vivo (live.jlx, no lists-home; api.jobees.org quando o arquivo some) e
// as listas do jogador da web (com os espelhos), uma de cada vez, com If-None-Match (ETag), ate 8 MiB, nunca no modo
// quieto; 30 s depois de subir e a cada 3 h (BGDL_FEEDS_EVERY_S) ou quando pedido. Arquivos do PS5 e a lista Orbit sao
// lidos direto. Os codigos que a lista Orbit nao precisa mandar inteiros saem daqui (orbit_known_core).
//
// API local (porta 34200, com o token): GET /api/catalog (grade), /api/catalog/options (opcoes e contagens),
// /api/catalog/search (Procurar), /api/catalog/home (fileiras), /api/catalog/related?id=, /api/catalog/game?id= (ficha),
// /api/catalog/sources, /api/catalog/status; POST /api/catalog/rebuild e /api/catalog/refresh.

#ifdef __GLIBC__
#include <malloc.h>
#endif
#if !defined(__linux__)
#include <sys/user.h> // struct kinfo_proc (a residente no PS5)
#endif
#define CT_FEED_MAX_BYTES (8u * 1024 * 1024)
#define CT_LISTS_HOME "https://raw.githubusercontent.com/JVK3R/JobeesLair-Lists/main/"
#define CT_LISTS_WHERE "https://api.jobees.org/v1/lists/home"
#define CT_ORBIT_ID "/data/JobeesLair/orbit/orbit-store.json"

static pthread_mutex_t g_cat_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_cat_wake = PTHREAD_COND_INITIALIZER;
static Catalog* g_cat;          // o catalogo no ar (refs: 1 do dono + 1 por pedido em curso)
static char g_cat_dir[600];
static char g_cat_state[16] = "starting", g_cat_error[200];
static char g_cat_sig[20], g_cat_tried[20];
static int g_cat_kick, g_feeds_kick, g_cat_builds;
static double g_cat_last_ms;
static size_t g_cat_last_bytes, g_cat_last_peak, g_cat_limit;
static uint64_t g_cat_rss_before, g_cat_rss_after;
static int64_t g_cat_built_at;

static Catalog* cat_get(void) {
  pthread_mutex_lock(&g_cat_lock);
  Catalog* c = g_cat;
  if (c) c->refs++;
  pthread_mutex_unlock(&g_cat_lock);
  return c;
}
static void cat_put(Catalog* c) {
  if (!c) return;
  pthread_mutex_lock(&g_cat_lock);
  const int last = --c->refs == 0;
  pthread_mutex_unlock(&g_cat_lock);
  if (last) ct_destroy(c);
}
static uint64_t cat_rss(void) {
#if defined(__linux__)
  FILE* file = fopen("/proc/self/statm", "r");
  if (!file) return 0;
  unsigned long long total = 0, resident = 0;
  const int got = fscanf(file, "%llu %llu", &total, &resident);
  fclose(file);
  return got == 2 ? (uint64_t)resident * (uint64_t)sysconf(_SC_PAGESIZE) : 0;
#else
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)getpid()};
  struct kinfo_proc info;
  size_t length = sizeof info;
  memset(&info, 0, sizeof info);
  if (sysctl(mib, 4, &info, &length, NULL, 0) || length < sizeof info) return 0;
  return (uint64_t)info.ki_rssize * (uint64_t)getpagesize();
#endif
}

// ---- A configuracao que o app grava -------------------------------------------------------------------------------
typedef struct { char* url; char* list[8]; int n; } CtMirror;
typedef struct {
  char* feeds[CT_MAX_FEEDS]; int nfeeds;
  CtMirror mirrors[CT_MAX_FEEDS]; int nmirrors;
  char* hidden[CT_MAX_FEEDS + 1]; int nhidden;
  int orbit; char orbit_id[300];
  int ps4, cover_width, max_mb, seen;
  char firmware[32], app[64];
} CtConfig;
static void cfg_free(CtConfig* c) {
  for (int i = 0; i < c->nfeeds; ++i) free(c->feeds[i]);
  for (int i = 0; i < c->nmirrors; ++i) { free(c->mirrors[i].url); for (int k = 0; k < c->mirrors[i].n; ++k) free(c->mirrors[i].list[k]); }
  for (int i = 0; i < c->nhidden; ++i) free(c->hidden[i]);
  memset(c, 0, sizeof *c);
}
static int cfg_text(JP* j, char** out) { char text[1100]; if (!lib_text(j, text, sizeof text)) return 0; *out = strdup(text); return *out != NULL; }
static int cfg_feed_item(JP* j, void* ctx) { CtConfig* c = ctx; char* s; if (!cfg_text(j, &s)) return 0; if (c->nfeeds < CT_MAX_FEEDS && *s) c->feeds[c->nfeeds++] = s; else free(s); return 1; }
static int cfg_hidden_item(JP* j, void* ctx) { CtConfig* c = ctx; char* s; if (!cfg_text(j, &s)) return 0; if (c->nhidden < CT_MAX_FEEDS + 1 && *s) c->hidden[c->nhidden++] = s; else free(s); return 1; }
typedef struct { CtConfig* c; CtMirror* m; } CfgMirror;
static int cfg_mirror_item(JP* j, void* ctx) { CfgMirror* x = ctx; char* s; if (!cfg_text(j, &s)) return 0; if (x->m->n < 8 && *s) x->m->list[x->m->n++] = s; else free(s); return 1; }
static int cfg_mirrors_field(JP* j, const char* key, void* ctx) {
  CtConfig* c = ctx;
  (void)key;
  if (c->nmirrors >= CT_MAX_FEEDS) return jp_skip(j) ? 1 : -1;
  return 0; // a chave tem ate 64 letras no leitor: o endereco vai dentro do valor ({url, list}) - ver cfg_mirror_obj
}
static int cfg_mirror_obj_field(JP* j, const char* key, void* ctx) {
  CfgMirror* x = ctx;
  if (!strcmp(key, "url")) { free(x->m->url); return cfg_text(j, &x->m->url) ? 1 : -1; }
  if (!strcmp(key, "list")) return jp_array(j, cfg_mirror_item, x) ? 1 : -1;
  return 0;
}
static int cfg_mirror_obj(JP* j, void* ctx) {
  CtConfig* c = ctx;
  if (c->nmirrors >= CT_MAX_FEEDS) return jp_skip(j);
  CtMirror* m = &c->mirrors[c->nmirrors];
  memset(m, 0, sizeof *m);
  CfgMirror x = {c, m};
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{') return jp_skip(j);
  if (!jp_object(j, cfg_mirror_obj_field, &x)) return 0;
  if (m->url) c->nmirrors++;
  else for (int k = 0; k < m->n; ++k) free(m->list[k]);
  return 1;
}
static int cfg_orbit_field(JP* j, const char* key, void* ctx) {
  CtConfig* c = ctx;
  if (!strcmp(key, "on")) return jp_bool(j, &c->orbit) ? 1 : -1;
  if (!strcmp(key, "id")) return lib_text(j, c->orbit_id, sizeof c->orbit_id) ? 1 : -1;
  return 0;
}
static int cfg_field(JP* j, const char* key, void* ctx) {
  CtConfig* c = ctx;
  double v; int has;
  if (!strcmp(key, "feeds")) return jp_array(j, cfg_feed_item, c) ? 1 : -1;
  if (!strcmp(key, "hidden")) return jp_array(j, cfg_hidden_item, c) ? 1 : -1;
  if (!strcmp(key, "mirrors")) { (void)cfg_mirrors_field; return jp_array(j, cfg_mirror_obj, c) ? 1 : -1; }
  if (!strcmp(key, "orbit")) { jp_ws(j); return (j->p < j->end && *j->p == '{' ? jp_object(j, cfg_orbit_field, c) : jp_skip(j)) ? 1 : -1; }
  if (!strcmp(key, "ps4")) return jp_bool(j, &c->ps4) ? 1 : -1;
  if (!strcmp(key, "firmware")) return lib_text(j, c->firmware, sizeof c->firmware) ? 1 : -1;
  if (!strcmp(key, "app")) return lib_text(j, c->app, sizeof c->app) ? 1 : -1;
  if (!strcmp(key, "coverWidth")) { if (!ct_num(j, &v, &has)) return -1; c->cover_width = has && v >= 100 && v <= 2000 ? (int)v : 0; return 1; }
  if (!strcmp(key, "maxMb")) { if (!ct_num(j, &v, &has)) return -1; c->max_mb = has && v >= 4 && v <= 1024 ? (int)v : 0; return 1; }
  return 0;
}
static void cfg_read(CtConfig* c) {
  memset(c, 0, sizeof *c);
  snprintf(c->orbit_id, sizeof c->orbit_id, "%s", CT_ORBIT_ID);
  c->orbit = -1;
  char path[700];
  snprintf(path, sizeof path, "%.600s/config.json", g_cat_dir);
  size_t size = 0;
  char* text = read_text(path, 1u << 20, &size);
  if (!text) return;
  JP jp = {text, text + size, 0};
  if (jp_object(&jp, cfg_field, c)) c->seen = 1;
  else { cfg_free(c); snprintf(c->orbit_id, sizeof c->orbit_id, "%s", CT_ORBIT_ID); c->orbit = -1; logf_("catalogo: %s ilegivel; so o catalogo ao vivo", path); }
  free(text);
}
// O firmware do console: o do sistema (PS5), o que o app disse ou BGDL_FIRMWARE.
#ifdef __PROSPERO__
typedef struct { uint32_t size; char text[0x1c]; uint32_t version; } CtSwVersion;
int sceKernelGetSystemSwVersion(CtSwVersion*) __attribute__((weak));
#endif
static void cat_firmware(const CtConfig* cfg, char* out, size_t cap) {
  // glibren.54: o firmware de verdade (kernel) primeiro; o da chamada do sistema e o do app podem vir fingidos.
  bg_firmware(out, cap);
  if (out[0]) return;
#ifdef __PROSPERO__
  if (sceKernelGetSystemSwVersion) {
    CtSwVersion v;
    memset(&v, 0, sizeof v);
    v.size = sizeof v;
    if (!sceKernelGetSystemSwVersion(&v) && v.version) { snprintf(out, cap, "%x.%02x", (v.version >> 24) & 0xff, (v.version >> 16) & 0xff); return; }
  }
#endif
  if (cfg->firmware[0]) { snprintf(out, cap, "%s", cfg->firmware); return; }
  snprintf(out, cap, "%s", env_or("BGDL_FIRMWARE", ""));
}

// ---- Os feeds: onde cada um esta no disco ---------------------------------------------------------------------------
static int cat_local_ok(const char* path) { // local-feed.js checkLocalPath (o que vale ler)
  if (!path || path[0] != '/' || strlen(path) > 1024 || strstr(path, "/../") || strstr(path, "/./") || strstr(path, "//")) return 0;
  const size_t n = strlen(path);
  if (n < 6 || strcasecmp(path + n - 5, ".json")) return 0;
  if (!strncmp(path, "/data/", 6)) return 1;
  if (!strncmp(path, "/mnt/usb", 8) || !strncmp(path, "/mnt/ext", 8)) { const char* p = path + 8; if (!isdigit((unsigned char)*p)) return 0; while (isdigit((unsigned char)*p)) ++p; return *p == '/'; }
#ifndef __PROSPERO__
  return !strncmp(path, "/tmp/", 5) || !strncmp(path, "/root/", 6); // testes no PC
#else
  return 0;
#endif
}
static void cat_cache_path(const char* url, const char* ext, char* out, size_t cap) {
  char k[20];
  ct_stable_key(url, k);
  snprintf(out, cap, "%.600s/feeds/%s.%s", g_cat_dir, k, ext);
}
// A ordem do app (feeds.js allFeeds): o ao vivo, os do jogador (sem o ao vivo nem a Orbit), a Orbit ligada e pronta.
typedef struct { const char* id[CT_MAX_FEEDS]; char path[CT_MAX_FEEDS][700]; int n; } CtFeedList;
static int cat_orbit_ready(void) {
  pthread_mutex_lock(&g_orbit_lock);
  const int ready = g_orbit.conv >= 3 && g_known_count > 0 && g_orbit.last_ok;
  pthread_mutex_unlock(&g_orbit_lock);
  return ready;
}
static void cat_feed_list(const CtConfig* cfg, CtFeedList* l) {
  memset(l, 0, sizeof *l);
  l->id[l->n] = CT_LIVE_FEED; cat_cache_path(CT_LIVE_FEED, "json", l->path[l->n], sizeof l->path[0]); l->n++;
  for (int i = 0; i < cfg->nfeeds && l->n < CT_MAX_FEEDS - 1; ++i) {
    const char* u = cfg->feeds[i];
    if (!strcmp(u, CT_LIVE_FEED) || !strcmp(u, cfg->orbit_id)) continue;
    l->id[l->n] = u;
    if (u[0] == '/') {
      if (cat_local_ok(u)) {
#ifndef __PROSPERO__
        // testes no PC: o "/data/..." do app dentro de uma pasta (BGDL_LOCAL_PREFIX)
        if (env_or("BGDL_LOCAL_PREFIX", "")[0]) { snprintf(l->path[l->n], sizeof l->path[0], "%.300s%.390s", env_or("BGDL_LOCAL_PREFIX", ""), u); l->n++; continue; }
#endif
        copy_text(l->path[l->n], sizeof l->path[0], u);
      }
    }
    else cat_cache_path(u, "json", l->path[l->n], sizeof l->path[0]);
    l->n++;
  }
  pthread_mutex_lock(&g_orbit_lock);
  const int on = cfg->orbit >= 0 ? cfg->orbit : g_orbit.enabled;
  pthread_mutex_unlock(&g_orbit_lock);
  if (on && cat_orbit_ready()) { l->id[l->n] = cfg->orbit_id; snprintf(l->path[l->n], sizeof l->path[0], "%s", g_orbit_feed); l->n++; }
}
// A copia do embutido vale? (version.json e cada tamanho)
typedef struct { char version[64]; char name[64][96]; uint64_t size[64]; int n; } CtBundledInfo;
typedef struct { CtBundledInfo* b; char name[96]; uint64_t size; } CtBundledFile;
static int cat_bfile_field(JP* j, const char* key, void* ctx) {
  CtBundledFile* f = ctx;
  if (!strcmp(key, "name")) return lib_text(j, f->name, sizeof f->name) ? 1 : -1;
  if (!strcmp(key, "size")) return jp_uint(j, &f->size) ? 1 : -1;
  return 0;
}
static int cat_bfile_item(JP* j, void* ctx) {
  CtBundledInfo* b = ctx;
  CtBundledFile f = {b, "", 0};
  if (!jp_object(j, cat_bfile_field, &f)) return 0;
  if (b->n < 64 && f.name[0] && !strstr(f.name, "..")) { snprintf(b->name[b->n], sizeof b->name[0], "%s", f.name); b->size[b->n++] = f.size; }
  return 1;
}
static int cat_bundled_field(JP* j, const char* key, void* ctx) {
  CtBundledInfo* b = ctx;
  if (!strcmp(key, "version")) return lib_text(j, b->version, sizeof b->version) ? 1 : -1;
  if (!strcmp(key, "files")) return jp_array(j, cat_bfile_item, b) ? 1 : -1;
  return 0;
}
static int cat_bundled_ok(const char* dir, char* version, size_t cap, char* why, size_t why_cap) {
  char path[800];
  snprintf(path, sizeof path, "%s/version.json", dir);
  size_t size = 0;
  char* text = read_text(path, 64 * 1024, &size);
  if (!text) { snprintf(why, why_cap, "sem %.200s (o app copia o catalogo embutido ao abrir)", path); return 0; }
  CtBundledInfo* b = calloc(1, sizeof *b);
  if (!b) { free(text); return 0; }
  JP jp = {text, text + size, 0};
  int ok = jp_object(&jp, cat_bundled_field, b) && b->n > 0;
  free(text);
  for (int i = 0; ok && i < b->n; ++i) {
    struct stat st;
    snprintf(path, sizeof path, "%s/%s", dir, b->name[i]);
    if (stat(path, &st) || (uint64_t)st.st_size != b->size[i]) { ok = 0; snprintf(why, why_cap, "copia incompleta: %.90s", b->name[i]); }
  }
  if (ok) snprintf(version, cap, "%s", b->version);
  else if (!why[0]) snprintf(why, why_cap, "version.json ilegivel");
  free(b);
  return ok;
}

// ---- A thread que monta ---------------------------------------------------------------------------------------------
static void cat_sig_add(Buf* b, const char* path) {
  struct stat st;
  buf_str(b, path); buf_str(b, "|");
  if (path[0] && !stat(path, &st)) buf_fmt(b, "%lld:%lld:%ld;", (long long)st.st_size, (long long)st.st_mtime, (long)st.st_mtim.tv_nsec);
  else buf_str(b, "-;");
}
static size_t cat_file_size(const char* path) { struct stat st; return path[0] && !stat(path, &st) ? (size_t)st.st_size : 0; }
static void cat_set_state(const char* state, const char* error) {
  pthread_mutex_lock(&g_cat_lock);
  snprintf(g_cat_state, sizeof g_cat_state, "%s", state);
  snprintf(g_cat_error, sizeof g_cat_error, "%s", error ? error : "");
  pthread_mutex_unlock(&g_cat_lock);
}
static void orbit_known_core(char (*ids)[10], int n);
// Uma volta: confere os arquivos e monta se algo mudou (ou se pediram).
static void cat_check(void) {
  CtConfig cfg;
  cfg_read(&cfg);
  char bundled[700], version[64] = "", why[300] = "";
  snprintf(bundled, sizeof bundled, "%.600s/bundled", g_cat_dir);
  const int have = cat_bundled_ok(bundled, version, sizeof version, why, sizeof why);
  CtFeedList feeds;
  cat_feed_list(&cfg, &feeds);
  char firmware[32];
  cat_firmware(&cfg, firmware, sizeof firmware);
  const int max_mb = cfg.max_mb ? cfg.max_mb : atoi(env_or("BGDL_CATALOG_MAX_MB", "32"));
  Buf sig = {0};
  buf_fmt(&sig, "v1|%s|%d|%d|%s|%d|", version, cfg.ps4, cfg.cover_width, firmware, max_mb);
  char path[800];
  snprintf(path, sizeof path, "%s/version.json", bundled); cat_sig_add(&sig, path);
  for (int f = 0; f < feeds.n; ++f) { buf_str(&sig, feeds.id[f]); buf_str(&sig, "="); cat_sig_add(&sig, feeds.path[f]); }
  for (int h = 0; h < cfg.nhidden; ++h) { buf_str(&sig, "h:"); buf_str(&sig, cfg.hidden[h]); buf_str(&sig, ";"); }
  char key[20];
  ct_stable_key(sig.data ? sig.data : "", key);
  free(sig.data);
  pthread_mutex_lock(&g_cat_lock);
  const int kick = g_cat_kick;
  g_cat_kick = 0;
  const int same = !strcmp(key, g_cat_tried) && !kick;
  pthread_mutex_unlock(&g_cat_lock);
  if (same) { cfg_free(&cfg); return; }
  pthread_mutex_lock(&g_cat_lock);
  snprintf(g_cat_tried, sizeof g_cat_tried, "%s", key);
  pthread_mutex_unlock(&g_cat_lock);
  if (!have) {
    cat_set_state("no-data", why);
    logf_("catalogo: nao montado: %s", why);
    cfg_free(&cfg);
    return;
  }
  // Antes de comecar: os arquivos lidos ja passariam do teto? (cada feed e lido inteiro, um por vez)
  const size_t limit = (size_t)max_mb << 20;
  size_t biggest = cat_file_size(path);
  snprintf(path, sizeof path, "%s/catalog/index.json", bundled);
  const size_t index_bytes = cat_file_size(path);
  for (int f = 0; f < feeds.n; ++f) { const size_t s = cat_file_size(feeds.path[f]); if (s > biggest) biggest = s; }
  if (index_bytes + biggest > limit) {
    char e[160];
    snprintf(e, sizeof e, "os arquivos (%zu + %zu bytes) passam do teto de %d MiB", index_bytes, biggest, max_mb);
    cat_set_state("over-limit", e);
    logk_("catalogo: nao montado: %s; a loja continua pelo app", e);
    cfg_free(&cfg);
    return;
  }
  cat_set_state("building", NULL);
  CtInputs in;
  memset(&in, 0, sizeof in);
  in.bundled_dir = bundled;
  for (int f = 0; f < feeds.n; ++f) { in.feed_id[f] = feeds.id[f]; in.feed_path[f] = feeds.path[f][0] ? feeds.path[f] : NULL; }
  in.nfeeds = feeds.n;
  for (int h = 0; h < cfg.nhidden; ++h) in.hidden[in.nhidden++] = cfg.hidden[h];
  in.ps4 = cfg.ps4;
  in.cover_width = cfg.cover_width;
  in.firmware = firmware;
  in.app_version = version;
  in.limit = limit;
  const uint64_t rss_before = cat_rss();
  char error[64] = "";
  Catalog* c = ct_build(&in, error, sizeof error);
#ifdef __GLIBC__
  malloc_trim(0); // o PC: devolve ao sistema o que a montagem soltou (no PS5 o alocador do sistema faz isso sozinho)
#endif
  const uint64_t rss_after = cat_rss();
  if (!c) {
    char e[160];
    snprintf(e, sizeof e, "a montagem passou do teto de %d MiB (pico %.1f MiB)", max_mb, (double)(__atomic_load_n(&g_ctm_peak, __ATOMIC_RELAXED)) / 1048576.0);
    cat_set_state(!strcmp(error, "over-limit") ? "over-limit" : "failed", e);
    logk_("catalogo: nao montado: %s; a loja continua pelo app", e);
    cfg_free(&cfg);
    return;
  }
  for (int f = 0; f < c->nfeeds; ++f) c->feeds[f].path = ct_dup(in.feed_path[f] ? in.feed_path[f] : "");
  c->refs = 1;
  pthread_mutex_lock(&g_cat_lock);
  Catalog* old = g_cat;
  g_cat = c;
  snprintf(g_cat_sig, sizeof g_cat_sig, "%s", key);
  snprintf(g_cat_state, sizeof g_cat_state, "ready");
  g_cat_error[0] = 0;
  g_cat_last_ms = c->build_ms;
  g_cat_last_bytes = c->bytes;
  g_cat_last_peak = c->peak;
  g_cat_limit = limit;
  g_cat_rss_before = rss_before;
  g_cat_rss_after = rss_after;
  g_cat_built_at = now_s();
  ++g_cat_builds;
  const int last = old && --old->refs == 0;
  pthread_mutex_unlock(&g_cat_lock);
  if (last) ct_destroy(old);
  int feeds_read = 0;
  for (int f = 0; f < c->nfeeds; ++f) feeds_read += c->feeds[f].ok;
  logk_("catalogo: montado em %.0f ms: %d listados (%d na loja), %d entradas, %d/%d feeds; guarda %.1f MiB, pico %.1f MiB (teto %d MiB); "
        "residente %.1f -> %.1f MiB; embutido %s",
        c->build_ms, c->nlisted, c->ngames, c->count, feeds_read, c->nfeeds, (double)c->bytes / 1048576.0, (double)c->peak / 1048576.0, max_mb,
        (double)rss_before / 1048576.0, (double)rss_after / 1048576.0, version);
  // os codigos que a lista Orbit nao precisa mandar inteiros (setOrbitKnown do app)
  orbit_known_core(c->known, c->nknown);
  // 2a fase: o "solo" dos jogos pelos links do pacote embutido (a loja do celular mostra null ate acabar)
  Catalog* held = cat_get();
  if (held == c) {
    const double t0 = ct_now_ms();
    ct_solo_bundled(c);
    int solo = 0;
    for (int i = 0; i < c->count; ++i) solo += c->solo[i] == 1;
    logf_("catalogo: links do pacote lidos em %.0f ms (%d jogos baixam sem o app)", ct_now_ms() - t0, solo);
  }
  cat_put(held);
  cfg_free(&cfg);
}
static void* catalog_loop(void* unused) {
  (void)unused;
  const int64_t first = atoll(env_or("BGDL_CATALOG_FIRST_MS", "20000"));
  const int64_t every = atoll(env_or("BGDL_CATALOG_CHECK_MS", "5000"));
  const int64_t start = mono_ms();
  // a lista Orbit so entra depois de o estado dela ser lido (orbit_loop): ate 10 s
  while (!__atomic_load_n(&g_orbit_loaded, __ATOMIC_ACQUIRE) && !g_stop && mono_ms() - start < 10000) usleep(20000);
  pthread_mutex_lock(&g_cat_lock);
  while (!g_stop) {
    const int64_t now = mono_ms();
    if (now - start >= first && !quiet_now()) {
      pthread_mutex_unlock(&g_cat_lock);
      cat_check();
      pthread_mutex_lock(&g_cat_lock);
    }
    if (g_stop) break;
    if (g_cat_kick && mono_ms() - start >= first && !quiet_now()) continue;
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    const int64_t wait = now - start < first ? first - (now - start) : every;
    deadline.tv_sec += wait / 1000;
    deadline.tv_nsec += (long)(wait % 1000) * 1000000L;
    if (deadline.tv_nsec >= 1000000000L) { deadline.tv_sec++; deadline.tv_nsec -= 1000000000L; }
    pthread_cond_timedwait(&g_cat_wake, &g_cat_lock, &deadline);
  }
  pthread_mutex_unlock(&g_cat_lock);
  return NULL;
}
static void cat_wake(int force) {
  pthread_mutex_lock(&g_cat_lock);
  if (force) g_cat_kick = 1;
  pthread_cond_broadcast(&g_cat_wake);
  pthread_mutex_unlock(&g_cat_lock);
}

// ---- Os feeds da web, baixados pelo payload --------------------------------------------------------------------------
typedef struct { char* data; size_t size; int too_big; char etag[200]; } CtFetch;
static size_t cat_collect(char* data, size_t a, size_t b, void* ctx) {
  CtFetch* f = ctx;
  const size_t n = a * b;
  if (g_stop) return 0;
  if (f->size + n > CT_FEED_MAX_BYTES) { f->too_big = 1; return 0; }
  char* next = realloc(f->data, f->size + n + 1);
  if (!next) return 0;
  memcpy(next + f->size, data, n);
  f->data = next;
  f->size += n;
  f->data[f->size] = 0;
  return n;
}
static size_t cat_header(char* data, size_t a, size_t b, void* ctx) {
  CtFetch* f = ctx;
  const size_t n = a * b;
  if (n > 5 && !strncasecmp(data, "ETag:", 5)) {
    const char* v = data + 5;
    size_t len = n - 5;
    while (len && (*v == ' ' || *v == '\t')) { ++v; --len; }
    while (len && (v[len - 1] == '\r' || v[len - 1] == '\n' || v[len - 1] == ' ')) --len;
    if (len < sizeof f->etag) { memcpy(f->etag, v, len); f->etag[len] = 0; }
  }
  if (n > 5 && !strncasecmp(data, "HTTP/", 5)) f->etag[0] = 0; // um redirecionamento: vale o ETag da resposta final
  return n;
}
// GET `url` (If-None-Match `etag`, so um ETag forte). -> status HTTP (304 sem corpo), 0 falhou (error).
static long cat_http_get(const char* url, const char* etag, CtFetch* f, char* error, size_t cap) {
  memset(f, 0, sizeof *f);
  CURL* curl = curl_easy_init();
  if (!curl) { snprintf(error, cap, "curl"); return 0; }
  configure_transport(curl, url);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 120L);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, cat_collect);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, f);
  curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, cat_header);
  curl_easy_setopt(curl, CURLOPT_HEADERDATA, f);
  struct curl_slist* headers = NULL;
  char line[260];
  if (etag && etag[0] && strncmp(etag, "W/", 2)) { snprintf(line, sizeof line, "If-None-Match: %s", etag); headers = curl_slist_append(headers, line); curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers); }
  const CURLcode code = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_cleanup(curl);
  curl_slist_free_all(headers);
  if (code != CURLE_OK) { snprintf(error, cap, f->too_big ? "The file is larger than 8 MiB." : "%s", f->too_big ? "" : curl_easy_strerror(code)); return 0; }
  if (status != 304 && (status < 200 || status >= 300)) { snprintf(error, cap, "HTTP %ld", status); return status; }
  return status;
}
// O estado gravado de um feed (feeds/<k>.meta).
typedef struct { char url[1100], from[1100], etag[200], fetched[40], name[200], error[200]; int games; char mirrors[4][1100]; int nmirrors; } CtFeedMeta;
static int cat_meta_mirror(JP* j, void* ctx) { CtFeedMeta* m = ctx; char t[1100]; if (!lib_text(j, t, sizeof t)) return 0; if (m->nmirrors < 4 && t[0]) snprintf(m->mirrors[m->nmirrors++], sizeof m->mirrors[0], "%s", t); return 1; }
static int cat_meta_field(JP* j, const char* key, void* ctx) {
  CtFeedMeta* m = ctx;
  if (!strcmp(key, "url")) return lib_text(j, m->url, sizeof m->url) ? 1 : -1;
  if (!strcmp(key, "from")) return lib_text(j, m->from, sizeof m->from) ? 1 : -1;
  if (!strcmp(key, "etag")) return lib_text(j, m->etag, sizeof m->etag) ? 1 : -1;
  if (!strcmp(key, "fetchedAt")) return lib_text(j, m->fetched, sizeof m->fetched) ? 1 : -1;
  if (!strcmp(key, "name")) return lib_text(j, m->name, sizeof m->name) ? 1 : -1;
  if (!strcmp(key, "error")) return lib_text(j, m->error, sizeof m->error) ? 1 : -1;
  if (!strcmp(key, "games")) { uint64_t v; if (!jp_uint(j, &v)) return -1; m->games = (int)v; return 1; }
  if (!strcmp(key, "mirrors")) return jp_array(j, cat_meta_mirror, m) ? 1 : -1;
  return 0;
}
static void cat_meta_read(const char* url, CtFeedMeta* m) {
  memset(m, 0, sizeof *m);
  char path[800];
  cat_cache_path(url, "meta", path, sizeof path);
  size_t size = 0;
  char* text = read_text(path, 64 * 1024, &size);
  if (!text) return;
  JP jp = {text, text + size, 0};
  if (!jp_object(&jp, cat_meta_field, m) || strcmp(m->url, url)) memset(m, 0, sizeof *m);
  free(text);
}
static void cat_meta_write(const CtFeedMeta* m) {
  char path[800];
  cat_cache_path(m->url, "meta", path, sizeof path);
  Buf b = {0};
  buf_str(&b, "{\"url\":"); buf_json(&b, m->url);
  buf_str(&b, ",\"from\":"); buf_json(&b, m->from);
  buf_str(&b, ",\"etag\":"); buf_json(&b, m->etag);
  buf_str(&b, ",\"fetchedAt\":"); buf_json(&b, m->fetched);
  buf_str(&b, ",\"name\":"); buf_json(&b, m->name);
  buf_fmt(&b, ",\"games\":%d,\"error\":", m->games); buf_json(&b, m->error);
  buf_str(&b, ",\"mirrors\":[");
  for (int i = 0; i < m->nmirrors; ++i) { if (i) buf_str(&b, ","); buf_json(&b, m->mirrors[i]); }
  buf_str(&b, "]}\n");
  if (!b.failed && b.data) save_atomic(path, b.data, b.size, 0644);
  free(b.data);
}
static void cat_iso_now(char* out, size_t cap) { time_t t = time(NULL); struct tm tm; gmtime_r(&t, &tm); strftime(out, cap, "%Y-%m-%dT%H:%M:%SZ", &tm); }
// Conta os jogos validos de um feed (o mesmo filtro da montagem).
static void cat_count_fn(CtFeedVisit* v, CtRawGame* raw, CtRel* rels, int nrels, const int* magnets, char (*hosts)[256]) { (void)v; (void)raw; (void)rels; (void)nrels; (void)magnets; (void)hosts; }
// O endereco das listas (lists-home.js): o salvo ou o padrao.
static void cat_lists_base(char* out, size_t cap) {
  snprintf(out, cap, "%s", CT_LISTS_HOME);
  char path[700];
  snprintf(path, sizeof path, "%.600s/lists-home.json", g_cat_dir);
  size_t size = 0;
  char* text = read_text(path, 8192, &size);
  if (!text) return;
  const char* at = strstr(text, "\"base\"");
  char base[320] = "";
  if (at && (at = strchr(at + 6, '"'))) { JP jp = {at, text + size, 0}; if (!lib_text(&jp, base, sizeof base)) base[0] = 0; }
  const size_t n = strlen(base);
  if (n > 9 && !strncmp(base, "https://", 8) && base[n - 1] == '/' && !strpbrk(base, " \"'<>\\")) snprintf(out, cap, "%s", base);
  free(text);
}
static int g_lists_asked;
static int cat_ask_lists_home(void) {
  if (g_lists_asked) return 0;
  g_lists_asked = 1;
  CtFetch f;
  char error[200] = "";
  const char* where = env_or("BGDL_LISTS_WHERE", CT_LISTS_WHERE);
  const long status = cat_http_get(where, NULL, &f, error, sizeof error);
  int moved = 0;
  if (status >= 200 && status < 300 && f.data) {
    const char* at = strstr(f.data, "\"base\"");
    char base[320] = "", now[320];
    if (at && (at = strchr(at + 6, '"'))) { JP jp = {at, f.data + f.size, 0}; if (!lib_text(&jp, base, sizeof base)) base[0] = 0; }
    cat_lists_base(now, sizeof now);
    const size_t n = strlen(base);
    if (n > 9 && n <= 300 && !strncmp(base, "https://", 8) && base[n - 1] == '/' && !strpbrk(base, " \"'<>\\") && strcmp(base, now)) {
      char path[700], body[400];
      snprintf(path, sizeof path, "%.600s/lists-home.json", g_cat_dir);
      const int len = snprintf(body, sizeof body, "{\"base\":\"%s\",\"at\":%lld}\n", base, (long long)now_s() * 1000);
      if (len > 0 && save_atomic(path, body, (size_t)len, 0644)) { moved = 1; logk_("catalogo: as listas agora sao lidas de %s", base); }
    }
  } else logf_("catalogo: %s: %s; as listas ficam onde estavam", where, error[0] ? error : "sem resposta");
  free(f.data);
  return moved;
}
// Uma tentativa num endereco. 1 copia nova gravada, 2 a mesma (304 ou o mesmo ETag), 0 falhou (`error`, `gone`).
static int cat_fetch_from(const char* url, const char* source, CtFeedMeta* m, char* error, size_t cap, int* gone) {
  CtFetch f;
  *gone = 0;
  const long status = cat_http_get(source, !strcmp(m->from, source) ? m->etag : NULL, &f, error, cap);
  if (status == 304) { free(f.data); return 2; }
  if (status < 200 || status >= 300 || !f.data) { free(f.data); *gone = status == 404 || status == 410 || status == 451; return 0; }
  size_t size = f.size;
  if (!ct_jlx_decode(f.data, &size)) { free(f.data); snprintf(error, cap, "Not JSON."); return 0; }
  // conferido como a montagem le (feed-format.js): um feed com jogos validos
  char* copy = ct_malloc(size + 1);
  memcpy(copy, f.data, size); copy[size] = 0;
  CtFeedVisit v;
  memset(&v, 0, sizeof v);
  Catalog scratch;
  memset(&scratch, 0, sizeof scratch);
  v.c = &scratch; v.fn = cat_count_fn; v.url = url;
  const int ok = ct_visit_feed(&v, copy, size);
  ct_free(copy);
  ct_free(scratch.feed_ids); ct_free(scratch.feed_stars); ct_free(scratch.feed_counts);
  if (!ok || !v.games) { ct_free(v.name); ct_strlist_free(&v.mirrors); free(f.data); snprintf(error, cap, ok ? "No usable games in this feed." : "Not a catalog feed: expected version 1 with a games list."); return 0; }
  char path[800];
  cat_cache_path(url, "json", path, sizeof path);
  if (!save_atomic(path, f.data, size, 0644)) { ct_free(v.name); ct_strlist_free(&v.mirrors); free(f.data); snprintf(error, cap, "not saved: %s", strerror(errno)); return 0; }
  free(f.data);
  snprintf(m->url, sizeof m->url, "%s", url);
  snprintf(m->from, sizeof m->from, "%s", source);
  snprintf(m->etag, sizeof m->etag, "%s", strncmp(f.etag, "W/", 2) ? f.etag : "");
  m->games = v.games;
  { char* t = ct_text(v.name, 80); snprintf(m->name, sizeof m->name, "%s", t); ct_free(t); }
  m->nmirrors = 0;
  for (int i = 0; i < v.mirrors.n && m->nmirrors < 4; ++i) {
    const char* x = v.mirrors.v[i];
    CtUrl u;
    if (!x || !ct_weburl(x, &u) || !strcmp(x, url)) continue;
    int dup = 0; for (int k = 0; k < m->nmirrors; ++k) if (!strcmp(m->mirrors[k], x)) dup = 1;
    if (!dup) snprintf(m->mirrors[m->nmirrors++], sizeof m->mirrors[0], "%s", x);
  }
  ct_free(v.name); ct_strlist_free(&v.mirrors);
  return 1;
}
// Um feed da web: o endereco que deu certo por ultimo, o proprio, os espelhos (do jogador e do feed). 1 mudou.
static int cat_refresh_feed(const char* url, const CtConfig* cfg) {
  CtFeedMeta m;
  cat_meta_read(url, &m);
  const int live = !strcmp(url, CT_LIVE_FEED);
  char own[1100];
  if (live) { char base[320]; cat_lists_base(base, sizeof base); snprintf(own, sizeof own, "%sps5/live.jlx", base); }
  else snprintf(own, sizeof own, "%s", url);
#ifndef __PROSPERO__
  if (live && env_or("BGDL_LIVE_URL", "")[0]) snprintf(own, sizeof own, "%s", env_or("BGDL_LIVE_URL", ""));
#endif
  const char* sources[16]; int n = 0;
  if (m.from[0]) sources[n++] = m.from;
  sources[n++] = own;
  for (int i = 0; i < cfg->nmirrors; ++i) if (!strcmp(cfg->mirrors[i].url, url)) for (int k = 0; k < cfg->mirrors[i].n && n < 14; ++k) sources[n++] = cfg->mirrors[i].list[k];
  for (int k = 0; k < m.nmirrors && n < 16; ++k) sources[n++] = m.mirrors[k];
  // o ultimo que deu certo so na frente se ainda for um dos enderecos
  int last_ok = 0;
  for (int i = 1; i < n; ++i) if (m.from[0] && !strcmp(sources[i], m.from)) last_ok = 1;
  int start = m.from[0] && !last_ok ? 1 : 0;
  char error[200] = "", first_error[200] = "";
  int failures = 0, gone = 0;
  for (int i = start; i < n; ++i) {
    int dup = 0; for (int k = start; k < i; ++k) if (!strcmp(sources[k], sources[i])) dup = 1;
    if (dup) continue;
    while (quiet_now() && !g_stop) sleep(1);
    if (g_stop) return 0;
    int is_gone = 0;
    const int got = cat_fetch_from(url, sources[i], &m, error, sizeof error, &is_gone);
    if (got) {
      cat_iso_now(m.fetched, sizeof m.fetched);
      m.error[0] = 0;
      if (got == 2) logf_("catalogo: feed %s: sem mudanca (%d jogos)", url, m.games);
      else logk_("catalogo: feed %s%s%s: %d jogos", url, strcmp(sources[i], url) ? " via " : "", strcmp(sources[i], url) ? sources[i] : "", m.games);
      cat_meta_write(&m);
      return got == 1;
    }
    if (!failures++) snprintf(first_error, sizeof first_error, "%s", error);
    if (live && sources[i] == own && is_gone) gone = 1;
    logf_("catalogo: feed %s falhou: %s", sources[i], error);
  }
  if (gone && cat_ask_lists_home()) return cat_refresh_feed(url, cfg);
  snprintf(m.url, sizeof m.url, "%s", url);
  if (failures > 1) snprintf(m.error, sizeof m.error, "%.150s (%d mirror%s also failed)", first_error, failures - 1, failures > 2 ? "s" : "");
  else snprintf(m.error, sizeof m.error, "%s", first_error);
  cat_meta_write(&m);
  return 0;
}
static void* feeds_loop(void* unused) {
  (void)unused;
  const int64_t first = atoll(env_or("BGDL_FEEDS_FIRST_S", "30")) * 1000;
  const int64_t every = atoll(env_or("BGDL_FEEDS_EVERY_S", "10800")) * 1000;
  int64_t next = mono_ms() + first;
  char dir[700];
  snprintf(dir, sizeof dir, "%.600s/feeds", g_cat_dir);
  mkdir_p(dir);
  pthread_mutex_lock(&g_cat_lock);
  while (!g_stop) {
    if ((g_feeds_kick || mono_ms() >= next) && !quiet_now()) {
      g_feeds_kick = 0;
      pthread_mutex_unlock(&g_cat_lock);
      CtConfig cfg;
      cfg_read(&cfg);
      int changed = cat_refresh_feed(CT_LIVE_FEED, &cfg);
      for (int i = 0; i < cfg.nfeeds && !g_stop; ++i) {
        const char* u = cfg.feeds[i];
        if (u[0] == '/' || !strcmp(u, CT_LIVE_FEED) || !strcmp(u, cfg.orbit_id)) continue;
        CtUrl x;
        if (!ct_weburl(u, &x)) continue;
        changed |= cat_refresh_feed(u, &cfg);
      }
      cfg_free(&cfg);
      g_lists_asked = 0;
      if (changed) cat_wake(0);
      pthread_mutex_lock(&g_cat_lock);
      next = mono_ms() + every;
      continue;
    }
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += 1;
    pthread_cond_timedwait(&g_cat_wake, &g_cat_lock, &deadline);
  }
  pthread_mutex_unlock(&g_cat_lock);
  return NULL;
}

// ---- A lista Orbit: os codigos conhecidos (a uniao do que o app manda com o que o catalogo daqui conhece) ----------------
static OrbitId* g_known_app; static size_t g_known_app_count; static int g_known_app_loaded;
static OrbitId* g_known_cat; static size_t g_known_cat_count;
// (com g_orbit_lock) Junta as duas listas e troca a do feed Orbit (que regrava o feed so se mudou).
static void orbit_known_merge_locked(void) {
  if (!g_known_app_loaded) { // na subida: a ultima lista gravada conta como a do app (a uniao so cresce)
    g_known_app_loaded = 1;
    if (g_known_count) { g_known_app = malloc(g_known_count * sizeof *g_known_app); if (g_known_app) { memcpy(g_known_app, g_known, g_known_count * sizeof *g_known_app); g_known_app_count = g_known_count; } }
  }
  const size_t total = g_known_app_count + g_known_cat_count;
  OrbitId* ids = malloc((total + 1) * sizeof *ids);
  if (!ids) return;
  if (g_known_app_count) memcpy(ids, g_known_app, g_known_app_count * sizeof *ids);
  if (g_known_cat_count) memcpy(ids + g_known_app_count, g_known_cat, g_known_cat_count * sizeof *ids);
  if (orbit_known_set_locked(ids, total)) { logk_("orbit: %zu codigos conhecidos (app + catalogo do payload)", g_known_count); pthread_cond_broadcast(&g_orbit_wake); }
}
static void orbit_known_core(char (*ids)[10], int n) {
  OrbitId* copy = malloc(((size_t)n + 1) * sizeof *copy);
  if (!copy) return;
  for (int i = 0; i < n; ++i) memcpy(copy[i], ids[i], sizeof copy[i]);
  pthread_mutex_lock(&g_orbit_lock);
  free(g_known_cat);
  g_known_cat = copy;
  g_known_cat_count = (size_t)n;
  orbit_known_merge_locked();
  pthread_mutex_unlock(&g_orbit_lock);
}
// (com g_orbit_lock) A lista nova do app (POST /orbit "known"): fica como a parte do app da uniao. Fica com `ids`.
static void orbit_known_app_locked(OrbitId* ids, size_t count) {
  if (!g_known_app_loaded) g_known_app_loaded = 1;
  free(g_known_app);
  g_known_app = ids;
  g_known_app_count = count;
  orbit_known_merge_locked();
}

// ---- Rotas ------------------------------------------------------------------------------------------------------------
static void cat_status_json(Buf* b) {
  pthread_mutex_lock(&g_cat_lock);
  const Catalog* c = g_cat;
  buf_str(b, "{\"ok\":true,\"state\":"); buf_json(b, g_cat_state);
  buf_str(b, ",\"error\":"); buf_json(b, g_cat_error);
  buf_fmt(b, ",\"builds\":%d,\"builtAt\":%lld,\"buildMs\":%.1f,\"bytes\":%zu,\"peak\":%zu,\"limit\":%zu,\"rssBefore\":%llu,\"rssAfter\":%llu,\"rssNow\":%llu,\"live\":%zu",
          g_cat_builds, (long long)g_cat_built_at, g_cat_last_ms, g_cat_last_bytes, g_cat_last_peak, g_cat_limit, (unsigned long long)g_cat_rss_before,
          (unsigned long long)g_cat_rss_after, (unsigned long long)cat_rss(), __atomic_load_n(&g_ctm_live, __ATOMIC_RELAXED));
  if (c) {
    buf_fmt(b, ",\"listed\":%d,\"shown\":%d,\"entries\":%d,\"nfcRisk\":%d", c->nlisted, c->ngames, c->count, c->nfc_risk);
    buf_fmt(b, ",\"phasesMs\":{\"index\":%.1f,\"tables\":%.1f,\"feeds\":%.1f,\"formats\":%.1f,\"ratings\":%.1f,\"texts\":%.1f,\"sorts\":%.1f,\"facets\":%.1f}",
            c->phase_ms[0], c->phase_ms[1] - c->phase_ms[0], c->phase_ms[2] - c->phase_ms[1], c->phase_ms[3] - c->phase_ms[2],
            c->phase_ms[4] - c->phase_ms[3], c->phase_ms[5] - c->phase_ms[4], c->phase_ms[6] - c->phase_ms[5], c->phase_ms[7] - c->phase_ms[6]);
    buf_str(b, ",\"bundled\":");
    buf_json(b, c->app_version);
    buf_str(b, ",\"firmware\":"); buf_json(b, c->firmware);
    buf_fmt(b, ",\"ps4\":%s,\"key\":\"payload-%s\",\"soloDone\":%s", c->ps4 ? "true" : "false", g_cat_sig, __atomic_load_n(&c->solo_done, __ATOMIC_RELAXED) ? "true" : "false");
  }
  pthread_mutex_unlock(&g_cat_lock);
  // os feeds da web: o estado de cada copia
  CtConfig cfg;
  cfg_read(&cfg);
  buf_str(b, ",\"feeds\":[");
  const char* urls[CT_MAX_FEEDS + 1]; int n = 0;
  urls[n++] = CT_LIVE_FEED;
  for (int i = 0; i < cfg.nfeeds && n < CT_MAX_FEEDS; ++i) if (cfg.feeds[i][0] != '/' && strcmp(cfg.feeds[i], CT_LIVE_FEED)) urls[n++] = cfg.feeds[i];
  for (int i = 0; i < n; ++i) {
    CtFeedMeta* m = calloc(1, sizeof *m);
    if (!m) break;
    cat_meta_read(urls[i], m);
    if (i) buf_str(b, ",");
    buf_str(b, "{\"url\":"); buf_json(b, urls[i]);
    buf_str(b, ",\"from\":"); buf_json(b, m->from);
    buf_str(b, ",\"fetchedAt\":"); buf_json(b, m->fetched);
    buf_fmt(b, ",\"games\":%d,\"error\":", m->games); buf_json(b, m->error);
    buf_str(b, "}");
    free(m);
  }
  buf_str(b, "]}");
  cfg_free(&cfg);
}
// Uma consulta ao catalogo no ar (fora do lock: o pedido segura uma referencia).
typedef void (*CatQuery)(const Catalog* c, const char* query, Buf* out);
static void cat_game_q(const Catalog* c, const char* query, Buf* out) {
  const char* paths[CT_MAX_FEEDS];
  for (int f = 0; f < c->nfeeds; ++f) paths[f] = c->feeds[f].path && c->feeds[f].path[0] ? c->feeds[f].path : NULL;
  ct_game(c, query, paths, out);
}
static void cat_sources_q(const Catalog* c, const char* query, Buf* out) { (void)query; ct_sources(c, out); }
// -> o JSON da consulta (malloc) e o status; NULL quando nao ha catalogo (body com o motivo).
static char* cat_answer(CatQuery fn, const char* query, int* status, size_t* size, double* took) {
  Catalog* c = cat_get();
  if (!c) {
    Buf b = {0};
    pthread_mutex_lock(&g_cat_lock);
    buf_str(&b, "{\"ok\":false,\"error\":"); buf_json(&b, !strcmp(g_cat_state, "over-limit") ? "over-limit" : !strcmp(g_cat_state, "no-data") ? "no-data" : "not-ready");
    buf_str(&b, ",\"state\":"); buf_json(&b, g_cat_state);
    buf_str(&b, ",\"detail\":"); buf_json(&b, g_cat_error);
    buf_str(&b, "}");
    pthread_mutex_unlock(&g_cat_lock);
    *status = 503;
    *size = b.size;
    return b.data;
  }
  const double started = ct_now_ms();
  Buf b = {0};
  fn(c, query, &b);
  if (took) *took = ct_now_ms() - started;
  cat_put(c);
  *status = b.failed || !b.data ? 500 : !strncmp(b.data, "{\"ok\":false,\"error\":\"not-found\"", 31) ? 404 : 200;
  *size = b.size;
  return b.data;
}
// Rotas da API local (com o token). 1 = tratou.
static int catalog_route(int fd, Request* r) {
  if (strncmp(r->path, "/api/catalog", 12) || (r->path[12] && r->path[12] != '/' && r->path[12] != '?')) return 0;
  char path[64];
  const char* q = strchr(r->path, '?');
  const size_t n = q ? (size_t)(q - r->path) : strlen(r->path);
  if (n >= sizeof path) { respond_error(fd, 404, "not found"); return 1; }
  memcpy(path, r->path, n); path[n] = 0;
  const char* query = q ? q + 1 : "";
  const int get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST");
  if (post && !strcmp(path, "/api/catalog/rebuild")) { cat_wake(1); respond(fd, 200, "{\"ok\":true}"); return 1; }
  if (post && !strcmp(path, "/api/catalog/refresh")) {
    pthread_mutex_lock(&g_cat_lock); g_feeds_kick = 1; pthread_cond_broadcast(&g_cat_wake); pthread_mutex_unlock(&g_cat_lock);
    respond(fd, 200, "{\"ok\":true}");
    return 1;
  }
  if (get && !strcmp(path, "/api/catalog/status")) {
    Buf b = {0};
    cat_status_json(&b);
    respond(fd, b.failed || !b.data ? 500 : 200, b.data ? b.data : "{}");
    free(b.data);
    return 1;
  }
  CatQuery fn = !strcmp(path, "/api/catalog") ? ct_page : !strcmp(path, "/api/catalog/options") ? ct_options : !strcmp(path, "/api/catalog/search") ? ct_search :
                !strcmp(path, "/api/catalog/home") ? ct_home : !strcmp(path, "/api/catalog/related") ? ct_related : !strcmp(path, "/api/catalog/game") ? cat_game_q :
                !strcmp(path, "/api/catalog/sources") ? cat_sources_q : !strcmp(path, "/api/catalog/cards") ? ct_cards_ids : NULL;
  if (!get || !fn) { respond_error(fd, 404, "not found"); return 1; }
  int status = 0;
  size_t size = 0;
  char* body = cat_answer(fn, query, &status, &size, NULL);
  respond(fd, status, body ? body : "{\"ok\":false,\"error\":\"out of memory\"}");
  free(body);
  return 1;
}

// ---- A loja do celular (bg_store.c) a partir do catalogo --------------------------------------------------------------
// GET /api/store com o catalogo no ar: o mesmo contrato do store_list (store-index.json), sem o arquivo do app. 0 = sem
// catalogo (o bg_store.c usa o arquivo).
static int catalog_store_list(int fd, const char* query) {
  Catalog* c = cat_get();
  if (!c) return 0;
  CtQuery q;
  ct_query_parse(query, &q);
  if (q.limit == 40 && !q.has_offset) q.limit = 40;
  if (q.limit > ST_PAGE) q.limit = ST_PAGE;
  CtGame** list = malloc(sizeof *list * ((size_t)c->nlisted + 1));
  if (!list) abort();
  int n = 0;
  for (int i = 0; i < c->nlisted; ++i) {
    CtGame* g = c->by_rank[q.sort][i];
    if (!g->shown || !ct_passes(c, g, &q, -1, 1)) continue;
    if (q.solo && !c->solo[g->entry]) continue;
    list[n++] = g;
  }
  Buf b = {0};
  buf_str(&b, "{\"ok\":true,\"key\":");
  char key[40];
  pthread_mutex_lock(&g_cat_lock);
  snprintf(key, sizeof key, "payload-%s", g_cat_sig);
  pthread_mutex_unlock(&g_cat_lock);
  buf_json(&b, key);
  char built[40];
  { time_t t = (time_t)g_cat_built_at; struct tm tm; gmtime_r(&t, &tm); strftime(built, sizeof built, "%Y-%m-%dT%H:%M:%S.000Z", &tm); }
  buf_str(&b, ",\"builtAt\":"); buf_json(&b, built);
  buf_fmt(&b, ",\"console\":\"%s\",\"readyFirmware\":", c->ps4 ? "ps4" : "ps5");
  buf_json(&b, c->low_firmware ? c->low_text : "13.60");
  buf_fmt(&b, ",\"source\":\"catalog\",\"partial\":false,\"total\":%d,\"count\":%d,\"offset\":%d,\"limit\":%d,\"sort\":\"%s\",\"games\":[", c->ngames, n, q.offset, q.limit, CT_SORT_KEYS[q.sort]);
  pthread_mutex_lock(&g_lock);
  for (int i = q.offset, shown = 0; i < n && shown < q.limit; ++i, ++shown) {
    const CtGame* g = list[i];
    if (shown) buf_str(&b, ",");
    buf_str(&b, "{\"id\":"); buf_json(&b, g->id);
    buf_str(&b, ",\"title\":"); buf_json(&b, g->title);
    buf_str(&b, ",\"code\":"); buf_json(&b, g->id);
    buf_fmt(&b, ",\"platform\":\"%s\",\"cover\":", g->platform ? "ps4" : "ps5");
    buf_json(&b, g->cover && !strncmp(g->cover, "https://", 8) && strlen(g->cover) < LIB_COVER ? g->cover : "");
    buf_str(&b, ",\"sizeGb\":"); if (g->has_size) ct_num_json(&b, g->size_gb); else buf_str(&b, "null");
    buf_str(&b, ",\"formats\":[");
    for (int k = 0, m = 0; k < CT_KINDS; ++k) if (g->formats & (1u << k)) buf_fmt(&b, "%s\"%s\"", m++ ? "," : "", CT_KIND[k]);
    buf_fmt(&b, "],\"ready\":%s,\"stars\":", ct_ready(c, g) ? "true" : "false");
    if (g->rating_count) ct_num_json(&b, g->stars); else buf_str(&b, "null");
    buf_fmt(&b, ",\"ratingCount\":%u,\"year\":", g->rating_count);
    if (g->has_year) buf_fmt(&b, "%d", g->year); else buf_str(&b, "null");
    buf_fmt(&b, ",\"solo\":%s,\"queued\":%s", c->solo[g->entry] == 1 ? "true" : c->solo[g->entry] == 0 ? "false" : "null", st_queued_locked(g->id) ? "true" : "false");
    if (g->genres.n) { buf_str(&b, ",\"genres\":["); for (int k = 0; k < g->genres.n; ++k) { if (k) buf_str(&b, ","); buf_json(&b, c->genres.v[g->genres.v[k]]); } buf_str(&b, "]"); }
    buf_str(&b, "}");
  }
  pthread_mutex_unlock(&g_lock);
  buf_str(&b, "],\"facets\":");
  // as contagens (store_list): um filtro "any" sem ele mesmo; o "solo" daqui conta como os nao-"any"
  Buf counts = {0};
  ct_counts_json(&counts, c, &q, 1, 1, c->solo);
  if (counts.data && counts.size > 1) {
    buf_add(&b, counts.data, counts.size - 1);
    int solo_count = 0;
    for (int i = 0; i < c->ngames; ++i) { const CtGame* g = c->games[i]; if (ct_passes(c, g, &q, -1, 1) && c->solo[g->entry] == 1) ++solo_count; }
    buf_fmt(&b, ",\"solo\":[{\"value\":\"1\",\"name\":\"solo\",\"count\":%d}]}}", solo_count);
  } else buf_str(&b, "{}}");
  free(counts.data);
  free(list);
  ct_query_free(&q);
  cat_put(c);
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_send(fd, 200, "application/json", b.data, b.size);
  free(b.data);
  return 1;
}
// Um jogo da loja do celular a partir do catalogo: o StGame (com as tabelas de nomes) e a ficha com os links na ordem da
// Jobe (StDetail), para store_game e store_add. 1 achou, 0 nao achou, -1 sem catalogo (o bg_store.c usa os arquivos).
static int catalog_store_entry(const char* id, StGame* out, char* key, size_t key_cap, StIndex* tables, StDetail* d) {
  Catalog* c = cat_get();
  if (!c) return -1;
  const CtGame* g = ct_find_game(c, id);
  if (!g || !g->shown) { cat_put(c); return 0; }
  memset(out, 0, sizeof *out);
  snprintf(out->id, sizeof out->id, "%s", g->id);
  snprintf(out->code, sizeof out->code, "%s", g->id);
  copy_utf8(out->title, sizeof out->title, g->title);
  if (g->cover && !strncmp(g->cover, "https://", 8) && strlen(g->cover) < sizeof out->cover) copy_text(out->cover, sizeof out->cover, g->cover);
  copy_utf8(out->developer, sizeof out->developer, g->dev);
  copy_utf8(out->publisher, sizeof out->publisher, g->pub);
  copy_text(out->release_date, sizeof out->release_date, g->release);
  out->platform = g->platform ? 2 : 1;
  out->ready = (uint8_t)ct_ready(c, g);
  out->direct = g->direct;
  out->has_size = g->has_size; out->size_gb = g->size_gb;
  out->has_stars = g->rating_count > 0; out->stars = g->stars; out->rating_count = g->rating_count;
  out->has_year = g->has_year; out->year = g->year;
  out->solo = (int8_t)(c->solo[g->entry] == 255 ? -1 : c->solo[g->entry]);
  if (tables) {
    memset(tables, 0, sizeof *tables);
    for (int k = 0; k < CT_KINDS; ++k) { copy_text(tables->formats[k], sizeof tables->formats[k], CT_KIND[k]); if (g->formats & (1u << k)) out->formats |= 1u << k; }
    tables->format_count = CT_KINDS;
    for (int k = 0; k < g->genres.n && k < ST_BITS; ++k) { copy_utf8(tables->genres[k], sizeof tables->genres[k], c->genres.v[g->genres.v[k]]); st_bit_set(&out->genres, k); }
    tables->genre_count = g->genres.n < ST_BITS ? g->genres.n : ST_BITS;
    for (int k = 0; k < g->features.n && k < ST_BITS; ++k) { copy_utf8(tables->features[k], sizeof tables->features[k], c->features.v[g->features.v[k]]); st_bit_set(&out->features, k); }
    tables->feature_count = g->features.n < ST_BITS ? g->features.n : ST_BITS;
    for (int k = 0; k < g->providers.n && k < ST_BITS; ++k) { copy_utf8(tables->providers[k], sizeof tables->providers[k], c->providers.v[g->providers.v[k]]); st_bit_set(&out->providers, k); }
    tables->provider_count = g->providers.n < ST_BITS ? g->providers.n : ST_BITS;
  }
  pthread_mutex_lock(&g_cat_lock);
  snprintf(key, key_cap, "payload-%s", g_cat_sig);
  pthread_mutex_unlock(&g_cat_lock);
  if (d) {
    memset(d, 0, sizeof *d);
    const char* paths[CT_MAX_FEEDS];
    for (int f = 0; f < c->nfeeds; ++f) paths[f] = c->feeds[f].path && c->feeds[f].path[0] ? c->feeds[f].path : NULL;
    CtDetail det;
    ct_detail(c, g, &det, paths);
    // store-export.js storeGameEntry: resumo, 3 paragrafos, 6 fotos https, o banner e os links na ordem da Jobe
    const char* summary = det.summary ? det.summary : "";
    char* cut = NULL;
    if (det.cut && det.about.n && det.about.v[0]) { cut = ct_ndup(det.about.v[0], strlen(summary) <= strlen(det.about.v[0]) ? strlen(summary) : 0); summary = cut; }
    copy_utf8(d->summary, sizeof d->summary, summary);
    ct_free(cut);
    for (int i = 0; i < det.about.n && d->about_count < ST_ABOUT; ++i) if (det.about.v[i]) copy_utf8(d->about[d->about_count++], sizeof d->about[0], det.about.v[i]);
    for (int i = 0; i < det.shots.n && d->shot_count < 6 && d->shot_count < ST_SHOTS; ++i)
      if (det.shots.v[i] && !strncmp(det.shots.v[i], "https://", 8) && strlen(det.shots.v[i]) <= 600 && strlen(det.shots.v[i]) < sizeof d->shots[0]) copy_text(d->shots[d->shot_count++], sizeof d->shots[0], det.shots.v[i]);
    if (det.hero && !strncmp(det.hero, "https://", 8) && strlen(det.hero) < sizeof d->hero) copy_text(d->hero, sizeof d->hero, det.hero);
    CtItems items;
    ct_release_sets(det.rels.v, det.rels.n, &items);
    int* order = malloc(sizeof(int) * ((size_t)items.n + 1));
    if (!order) abort();
    ct_source_order(&items, ct_release_platform(g), order);
    for (int i = 0; i < items.n && d->link_count < ST_LINKS; ++i) {
      const CtItem* t = &items.v[order[i]];
      StLink* l = &d->links[d->link_count++];
      memset(l, 0, sizeof *l);
      const int group = ct_group(t);
      const CtRel* base = t->rel ? t->rel : t->base;
      copy_text(l->kind, sizeof l->kind, t->rel ? CT_GROUP[group] : "set");
      snprintf(l->group, sizeof l->group, "%s", CT_GROUP[group]); // glibren.55: tambem num conjunto
      const char* host = group == GR_TORRENT ? "Torrent" : !strncmp(ct_s(base->provider), "www.", 4) ? base->provider + 4 : ct_s(base->provider);
      copy_utf8(l->host, sizeof l->host, host);
      copy_text(l->format, sizeof l->format, t->rel ? ct_s(t->rel->format) : "archive-set");
      for (char* p = l->format; *p; ++p) *p = (char)tolower((unsigned char)*p);
      copy_utf8(l->label, sizeof l->label, t->rel ? ct_s(t->rel->label) : ct_s(t->label));
      copy_utf8(l->filename, sizeof l->filename, t->rel ? ct_s(t->rel->filename) : ct_s(t->id));
      const int solo = ct_solo(t);
      if (solo && strlen(t->rel->url) < sizeof l->url) copy_text(l->url, sizeof l->url, t->rel->url);
      if (t->rel && t->rel->sha256 && is_hex64(t->rel->sha256)) copy_text(l->sha256, sizeof l->sha256, t->rel->sha256);
      if (t->rel && t->rel->has_size && t->rel->size > 0) { l->has_size = 1; l->size = (uint64_t)t->rel->size; }
      l->parts = t->rel ? 0 : (unsigned)t->nparts;
      l->source = order[i];
      l->solo = (int8_t)(solo && l->url[0] ? 1 : 0);
    }
    free(order);
    ct_items_free(&items);
    ct_detail_free(&det);
  }
  cat_put(c);
  return 1;
}

// ---- /teste (Fase 0): a medicao do catalogo no console --------------------------------------------------------------
// GET /api/teste/catalogo: o estado da montagem (tempo, o que guarda, pico, residente antes/depois) e o tempo de algumas
// consultas feitas agora (a 1a pagina de cada ordem, uma busca, os filtros, a pagina inicial, uma ficha).
static void teste_catalogo(int fd) {
  Buf b = {0};
  cat_status_json(&b);
  if (b.data && b.size) b.size--; // reabre
  buf_str(&b, ",\"queries\":[");
  static const char* const Q[][2] = {{"pagina relevancia", "/api/catalog?per=60&sort=relevance"}, {"pagina titulo", "/api/catalog?per=60&sort=title"},
                                     {"pagina 2 nota", "/api/catalog?per=60&page=1&sort=rating"}, {"filtros ps5 prontos acao", "/api/catalog?per=60&platform=ps5&format=ready&genre=Action"},
                                     {"busca", "/api/catalog?per=60&q=final"}, {"contagens", "/api/catalog/options?platform=ps5"},
                                     {"Procurar sem acento", "/api/catalog/search?q=pokemon"}, {"pagina inicial", "/api/catalog/home?seed=7"}};
  for (size_t i = 0; i < sizeof Q / sizeof *Q; ++i) {
    const char* full = Q[i][1];
    const char* qm = strchr(full, '?');
    char path[64];
    snprintf(path, sizeof path, "%.*s", (int)(qm - full), full);
    CatQuery fn = !strcmp(path, "/api/catalog") ? ct_page : !strcmp(path, "/api/catalog/options") ? ct_options : !strcmp(path, "/api/catalog/search") ? ct_search : ct_home;
    int status = 0; size_t size = 0; double took = 0;
    char* body = cat_answer(fn, qm + 1, &status, &size, &took);
    free(body);
    buf_fmt(&b, "%s{\"name\":\"%s\",\"status\":%d,\"ms\":%.2f,\"bytes\":%zu}", i ? "," : "", Q[i][0], status, took, size);
  }
  // uma ficha: o primeiro jogo da loja (le o pacote e os feeds que o listam)
  Catalog* c = cat_get();
  char game_query[40] = "";
  if (c && c->ngames) snprintf(game_query, sizeof game_query, "id=%s", c->games[0]->id);
  cat_put(c);
  if (game_query[0]) {
    int status = 0; size_t size = 0; double took = 0;
    char* body = cat_answer(cat_game_q, game_query, &status, &size, &took);
    free(body);
    buf_fmt(&b, ",{\"name\":\"ficha\",\"status\":%d,\"ms\":%.2f,\"bytes\":%zu}", status, took, size);
  }
  buf_fmt(&b, "],\"rssAfterQueries\":%llu}", (unsigned long long)cat_rss());
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_send(fd, 200, "application/json", b.data, b.size);
  free(b.data);
}

static void catalog_setup(void) {
#ifdef __PROSPERO__
  snprintf(g_cat_dir, sizeof g_cat_dir, "%s", "/data/JobeesLair/catalog");
  const int feeds = 1;
#else
  // No PC (testes): dentro da pasta de estado do payload, e sem rede dos feeds sem BGDL_FEEDS_ON=1.
  char fallback[600];
  snprintf(fallback, sizeof fallback, "%.580s/catalog", g_dir);
  copy_text(g_cat_dir, sizeof g_cat_dir, env_or("BGDL_CATALOG_DIR", fallback));
  const int feeds = atoi(env_or("BGDL_FEEDS_ON", "0"));
#endif
  mkdir_p(g_cat_dir);
  if (atoi(env_or("BGDL_CATALOG_OFF", "0"))) { cat_set_state("off", "BGDL_CATALOG_OFF"); return; }
  if (spawn_thread(catalog_loop, NULL, NULL)) logf_("catalogo: thread nao criada");
  if (feeds && spawn_thread(feeds_loop, NULL, NULL)) logf_("catalogo: thread dos feeds nao criada");
}
