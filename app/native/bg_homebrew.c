// glibren.70 (payload 1.37.14): a aba HOMEBREW da loja completa (/app). Incluido em bg_downloader.c, depois de
// bg_covers_bank.c (usa cat_http_get de bg_catalog_api.c).
//
// A lista e a MESMA da aba Homebrew da Jobe: o homebrew/index.json do JVK3R/JobeesLair-Homebrew (montado por
// tools/homebrew/build-index.mjs; app/state/homebrew.js INDEX_URL). O payload le a copia mais nova entre:
//   - a dele: <BGDL_DIR>/homebrew-index.json, baixada de BGDL_HOMEBREW_URL (padrao o INDEX_URL da Jobe; "" desliga) quando
//     falta ou passou de 6 h (numa thread; a pagina ve "carregando" e pede de novo);
//   - a da Jobe: BGDL_HOMEBREW_JOBE (padrao /data/JobeesLair/homebrew-index.json, gravada quando ela atualiza a lista).
// Nada do indice e confiado (como homebrew-index.js normalizeFile): arquivo sem nome valido, de outro tipo ou fora das
// releases do proprio repositorio do app (https://github.com/<dono>/<repo>/releases/download/...) e descartado.
//
//   GET  /api/homebrew?q=&offset=&limit=   {ok, total, count, offset, limit, from, categories:[{id,name}], apps:[{id, repo, name,
//                                          author, category, description, icon, version, stars, files:[{i, name, kind, size,
//                                          payload, queued}]}]} | 503 {error:"loading"|"none", detail}
//                                          payload = o payload baixa sozinho (image, pkg, payload); os outros tipos (app,
//                                          arquivos compactados) a Jobe instala (aba Homebrew dela).
//   POST /api/homebrew/add {id, i, name}   (monitor_allowed) poe o arquivo na fila do payload, o mesmo pedido da loja
//                                          baixado pelo payload (store_add, via_payload): imagem -> <disco>/homebrew/ (o
//                                          ShadowMount+ monta), .pkg -> downloads/packages, payload -> downloads/files.
//                                          -> {ok, id, kind, where} | {ok, already, id} | 400 {error:"file"} | 404 not-found
//                                          | 409 {error:"app-open"|"no-root"|"exists"|"full"|"kind"}.
#define HB_DEFAULT_URL "https://raw.githubusercontent.com/JVK3R/JobeesLair-Homebrew/main/index.json"
#define HB_MAX_APPS 600
#define HB_MAX_FILES 12
#define HB_MAX_CATS 32
#define HB_MAX_BYTES (6u * 1024 * 1024)
#define HB_STALE_S (6 * 3600)
#define HB_RETRY_S 600

typedef struct { char name[204], kind[16], url[720]; uint64_t size; } HbFile;
typedef struct {
  char id[144], repo[144], name[64], author[44], category[34], desc[420], icon[604], version[64];
  uint64_t stars;
  HbFile* files;
  int nfiles;
  char* search; // nome, autor, descricao, categoria e repo em minusculas
} HbApp;
typedef struct { char id[34], name[64]; } HbCat;
typedef struct { HbApp* apps; int count; HbCat cats[HB_MAX_CATS]; int ncats; char from[8]; } HbIndex;

static pthread_mutex_t g_hb_lock = PTHREAD_MUTEX_INITIALIZER; // antes de g_lock, nunca depois
static HbIndex* g_hb;
static char g_hb_path[700];
static int64_t g_hb_mtime;
static int g_hb_fetching;
static int64_t g_hb_tried;
static char g_hb_error[200];

// getenv direto: BGDL_HOMEBREW_URL="" desliga a busca (env_or troca o vazio pelo padrao)
static const char* hb_url(void) { const char* v = getenv("BGDL_HOMEBREW_URL"); return v ? v : HB_DEFAULT_URL; }
static void hb_cache_path(char* out, size_t cap) { snprintf(out, cap, "%.500s/homebrew-index.json", g_dir); }
static const char* hb_jobe_path(void) { return env_or("BGDL_HOMEBREW_JOBE", "/data/JobeesLair/homebrew-index.json"); }

static void hb_free(HbIndex* x) {
  if (!x) return;
  for (int i = 0; i < x->count; ++i) { free(x->apps[i].files); free(x->apps[i].search); }
  free(x->apps);
  free(x);
}
static int hb_kind_ok(const char* k) {
  static const char* const KINDS[] = {"image", "app", "archive-image", "payload", "archive-payload", "pkg", "archive-pkg"};
  for (size_t i = 0; i < sizeof KINDS / sizeof *KINDS; ++i) if (!strcmp(k, KINDS[i])) return 1;
  return 0;
}
// O payload baixa sozinho so o que nao precisa ser aberto nem instalado pela Jobe.
static int hb_kind_payload(const char* k) { return !strcmp(k, "image") || !strcmp(k, "pkg") || !strcmp(k, "payload"); }
static int hb_name_ok(const char* n) {
  if (!n[0] || !strcmp(n, ".") || !strcmp(n, "..") || strlen(n) > 200) return 0;
  for (const unsigned char* p = (const unsigned char*)n; *p; ++p) if (*p < 0x20 || *p == '/' || *p == '\\') return 0;
  return 1;
}
static int hb_repo_ok(const char* r) {
  const char* slash = strchr(r, '/');
  if (!slash || slash == r || strchr(slash + 1, '/') || !slash[1] || slash - r > 39 || strlen(slash + 1) > 100) return 0;
  for (const char* p = r; *p; ++p) if (*p != '/' && !isalnum((unsigned char)*p) && *p != '_' && *p != '.' && *p != '-') return 0;
  return 1;
}
static int hb_https_ok(const char* u) {
  if (strncmp(u, "https://", 8) || strlen(u) > 600) return 0;
  for (const unsigned char* p = (const unsigned char*)u; *p; ++p) if (*p <= 0x20 || *p == '"' || *p == '\'' || *p == '<' || *p == '>') return 0;
  return 1;
}

static int hb_file_field(JP* jp, const char* key, void* ctx) {
  HbFile* f = ctx;
  if (!strcmp(key, "name")) return lib_text(jp, f->name, sizeof f->name) ? 1 : -1;
  if (!strcmp(key, "kind")) return lib_text(jp, f->kind, sizeof f->kind) ? 1 : -1;
  if (!strcmp(key, "url")) return lib_text(jp, f->url, sizeof f->url) ? 1 : -1;
  if (!strcmp(key, "size")) return lib_uint(jp, &f->size) ? 1 : -1;
  return 0;
}
static int hb_file_item(JP* jp, void* ctx) {
  HbApp* a = ctx;
  HbFile f;
  memset(&f, 0, sizeof f);
  if (!jp_object(jp, hb_file_field, &f)) return 0;
  if (a->nfiles >= HB_MAX_FILES || !hb_name_ok(f.name) || !hb_kind_ok(f.kind) || !hb_https_ok(f.url)) return 1;
  // so os arquivos das releases do proprio repositorio do app
  char prefix[220];
  snprintf(prefix, sizeof prefix, "https://github.com/%s/releases/download/", a->repo);
  if (strncasecmp(f.url, prefix, strlen(prefix))) return 1;
  HbFile* more = realloc(a->files, sizeof *more * (size_t)(a->nfiles + 1));
  if (!more) return 0;
  a->files = more;
  a->files[a->nfiles++] = f;
  return 1;
}
static int hb_release_field(JP* jp, const char* key, void* ctx) {
  if (!strcmp(key, "tag")) return lib_text(jp, ((HbApp*)ctx)->version, sizeof ((HbApp*)ctx)->version) ? 1 : -1;
  return 0;
}
// os arquivos vem depois do repo no indice, mas nao confia na ordem: guarda o trecho e le no fim
typedef struct { HbApp a; const char* files_at; const char* files_end; } HbAppParse;
static int hb_app_field(JP* jp, const char* key, void* ctx) {
  HbAppParse* p = ctx;
  HbApp* a = &p->a;
  if (!strcmp(key, "repo")) return lib_text(jp, a->repo, sizeof a->repo) ? 1 : -1;
  if (!strcmp(key, "name")) return lib_text(jp, a->name, sizeof a->name) ? 1 : -1;
  if (!strcmp(key, "author")) return lib_text(jp, a->author, sizeof a->author) ? 1 : -1;
  if (!strcmp(key, "category")) return lib_text(jp, a->category, sizeof a->category) ? 1 : -1;
  if (!strcmp(key, "description")) return lib_text(jp, a->desc, sizeof a->desc) ? 1 : -1;
  if (!strcmp(key, "icon")) return lib_text(jp, a->icon, sizeof a->icon) ? 1 : -1;
  if (!strcmp(key, "stars")) return lib_uint(jp, &a->stars) ? 1 : -1;
  if (!strcmp(key, "release")) { jp_ws(jp); if (jp->p < jp->end && *jp->p == '{') return jp_object(jp, hb_release_field, a) ? 1 : -1; return 0; }
  if (!strcmp(key, "files")) { jp_ws(jp); p->files_at = jp->p; if (!jp_skip(jp)) return -1; p->files_end = jp->p; return 1; }
  return 0;
}
static void hb_lower_add(char* out, size_t cap, size_t* n, const char* text) {
  if (*n && *n + 1 < cap) out[(*n)++] = ' ';
  for (const char* p = text; *p && *n + 1 < cap; ++p) out[(*n)++] = (char)tolower((unsigned char)*p);
  out[*n] = 0;
}
static int hb_app_item(JP* jp, void* ctx) {
  HbIndex* x = ctx;
  HbAppParse p;
  memset(&p, 0, sizeof p);
  if (!jp_object(jp, hb_app_field, &p)) return 0;
  HbApp* a = &p.a;
  // como normalizeApp: repo valido, nome, ao menos um arquivo valido
  char* trim = a->name;
  while (*trim == ' ') ++trim;
  if (x->count >= HB_MAX_APPS || !hb_repo_ok(a->repo) || !*trim) return 1;
  if (trim != a->name) memmove(a->name, trim, strlen(trim) + 1);
  if (p.files_at) { JP fj = {p.files_at, p.files_end, 0}; if (!jp_array(&fj, hb_file_item, a)) { free(a->files); return 0; } }
  if (!a->nfiles) { free(a->files); return 1; }
  copy_text(a->id, sizeof a->id, a->repo);
  lower_ascii(a->id);
  if (!a->author[0]) { copy_text(a->author, sizeof a->author, a->repo); char* s = strchr(a->author, '/'); if (s) *s = 0; }
  if (!hb_https_ok(a->icon)) a->icon[0] = 0;
  for (int i = 0; i < x->count; ++i) if (!strcmp(x->apps[i].id, a->id)) { free(a->files); return 1; } // repetido
  const size_t cap = strlen(a->name) + strlen(a->author) + strlen(a->desc) + strlen(a->category) + strlen(a->repo) + 8;
  a->search = malloc(cap);
  if (!a->search) { free(a->files); return 0; }
  size_t n = 0;
  a->search[0] = 0;
  hb_lower_add(a->search, cap, &n, a->name);
  hb_lower_add(a->search, cap, &n, a->author);
  hb_lower_add(a->search, cap, &n, a->desc);
  hb_lower_add(a->search, cap, &n, a->category);
  hb_lower_add(a->search, cap, &n, a->repo);
  x->apps[x->count++] = *a;
  return 1;
}
static int hb_cat_field(JP* jp, const char* key, void* ctx) {
  HbCat* c = ctx;
  if (!strcmp(key, "id")) return lib_text(jp, c->id, sizeof c->id) ? 1 : -1;
  if (!strcmp(key, "name")) return lib_text(jp, c->name, sizeof c->name) ? 1 : -1;
  return 0;
}
static int hb_cat_item(JP* jp, void* ctx) {
  HbIndex* x = ctx;
  HbCat c;
  memset(&c, 0, sizeof c);
  if (!jp_object(jp, hb_cat_field, &c)) return 0;
  if (x->ncats < HB_MAX_CATS && c.id[0] && c.name[0]) x->cats[x->ncats++] = c;
  return 1;
}
static int hb_top_field(JP* jp, const char* key, void* ctx) {
  if (!strcmp(key, "apps")) return jp_array(jp, hb_app_item, ctx) ? 1 : -1;
  if (!strcmp(key, "categories")) return jp_array(jp, hb_cat_item, ctx) ? 1 : -1;
  return 0;
}
// Le um indice do disco ou da rede. NULL = nao e um indice com apps.
static HbIndex* hb_parse(const char* text, size_t size) {
  HbIndex* x = calloc(1, sizeof *x);
  if (!x) return NULL;
  x->apps = calloc(HB_MAX_APPS, sizeof *x->apps);
  JP jp = {text, text + size, 0};
  if (!x->apps || !jp_object(&jp, hb_top_field, x) || !x->count) { hb_free(x); return NULL; }
  return x;
}

static void* hb_fetch_thread(void* arg) {
  (void)arg;
  CtFetch f;
  char error[200] = "";
  const long status = cat_http_get(hb_url(), NULL, &f, error, sizeof error);
  int ok = 0;
  if (status >= 200 && status < 300 && f.data) {
    if (f.size > HB_MAX_BYTES) snprintf(error, sizeof error, "larger than 6 MiB");
    else {
      HbIndex* check = hb_parse(f.data, f.size);
      if (!check) snprintf(error, sizeof error, "not a homebrew index");
      else {
        char path[700];
        hb_cache_path(path, sizeof path);
        ok = save_atomic(path, f.data, f.size, 0644);
        if (!ok) snprintf(error, sizeof error, "not saved");
        else logf_("homebrew: lista nova (%d apps) de %s", check->count, hb_url());
        hb_free(check);
      }
    }
  } else if (!error[0]) snprintf(error, sizeof error, "HTTP %ld", status);
  free(f.data);
  pthread_mutex_lock(&g_hb_lock);
  g_hb_fetching = 0;
  copy_text(g_hb_error, sizeof g_hb_error, ok ? "" : error);
  pthread_mutex_unlock(&g_hb_lock);
  if (!ok) logf_("homebrew: lista nao baixada (%s)", error);
  return NULL;
}
static int64_t hb_mtime(const char* path) { struct stat st; return stat(path, &st) ? -1 : (int64_t)st.st_mtime; }
// Com g_hb_lock: a copia mais nova no ar (e uma busca em segundo plano quando a nossa falta ou ficou velha).
static void hb_refresh_locked(void) {
  char cache[700];
  hb_cache_path(cache, sizeof cache);
  const char* jobe = hb_jobe_path();
  const int64_t mc = hb_mtime(cache), mj = hb_mtime(jobe), now = now_s();
  const char* url = hb_url();
  if (url[0] && !g_hb_fetching && (mc < 0 || now - mc > HB_STALE_S) && now - g_hb_tried > HB_RETRY_S) {
    pthread_t t;
    g_hb_tried = now;
    g_hb_fetching = 1;
    if (pthread_create(&t, NULL, hb_fetch_thread, NULL)) g_hb_fetching = 0;
    else pthread_detach(t);
  }
  const char* best = mc >= 0 && mc >= mj ? cache : mj >= 0 ? jobe : NULL;
  const int64_t mtime = best == cache ? mc : mj;
  if (!best || (g_hb && !strcmp(g_hb_path, best) && g_hb_mtime == mtime)) return;
  size_t size = 0;
  char* text = read_text(best, HB_MAX_BYTES, &size);
  HbIndex* x = text ? hb_parse(text, size) : NULL;
  free(text);
  if (!x) { logf_("homebrew: %s nao e uma lista valida", best); return; }
  copy_text(x->from, sizeof x->from, best == cache ? "payload" : "jobe");
  hb_free(g_hb);
  g_hb = x;
  copy_text(g_hb_path, sizeof g_hb_path, best);
  g_hb_mtime = mtime;
}

// O id do pedido na fila (lib_store, 16 bytes): "h" + 14 hex: "h" + o hash de repo e nome do arquivo.
static void hb_store_id(const HbApp* a, const HbFile* f, char out[16]) {
  Hash h;
  char digest[65];
  hash_init(&h);
  hash_text0(&h, a->id);
  hash_text0(&h, f->name);
  if (!hash_finish(&h, digest)) snprintf(digest, sizeof digest, "%064d", 0);
  snprintf(out, 16, "h%.14s", digest);
}
static void hb_list(int fd, const char* query) {
  char q[200] = "";
  int offset = 0, limit = 60;
  for (const char* p = query ? query : ""; *p;) {
    const size_t n = strcspn(p, "&");
    const char* eq = memchr(p, '=', n);
    const size_t key_size = eq ? (size_t)(eq - p) : n;
    char key[16], value[200];
    url_decode(p, key_size, key, sizeof key);
    if (eq) url_decode(eq + 1, n - key_size - 1, value, sizeof value);
    else value[0] = 0;
    if (!strcmp(key, "q")) { copy_utf8(q, sizeof q, value); lower_ascii(q); }
    else if (!strcmp(key, "offset")) offset = atoi(value);
    else if (!strcmp(key, "limit")) limit = atoi(value);
    p += n;
    if (*p == '&') ++p;
  }
  if (offset < 0) offset = 0;
  if (limit < 1) limit = 1;
  if (limit > HB_MAX_APPS) limit = HB_MAX_APPS;
  // as palavras da busca: todas tem de aparecer (searchApps)
  char words[200];
  copy_text(words, sizeof words, q);
  char* list[16];
  int nw = 0;
  for (char* save = NULL, *w = strtok_r(words, " \t", &save); w && nw < 16; w = strtok_r(NULL, " \t", &save)) list[nw++] = w;
  pthread_mutex_lock(&g_hb_lock);
  hb_refresh_locked();
  if (!g_hb) {
    char out[320];
    Buf e = {0};
    buf_str(&e, g_hb_fetching ? "{\"error\":\"loading\",\"detail\":" : "{\"error\":\"none\",\"detail\":");
    buf_json(&e, g_hb_error);
    buf_str(&e, "}");
    copy_text(out, sizeof out, e.data && !e.failed ? e.data : "{\"error\":\"none\"}");
    free(e.data);
    pthread_mutex_unlock(&g_hb_lock);
    monitor_json(fd, 503, out);
    return;
  }
  const HbIndex* x = g_hb;
  int* match = malloc(sizeof *match * (size_t)(x->count + 1));
  if (!match) { pthread_mutex_unlock(&g_hb_lock); monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
  int count = 0;
  for (int i = 0; i < x->count; ++i) {
    int ok = 1;
    for (int k = 0; ok && k < nw; ++k) ok = strstr(x->apps[i].search, list[k]) != NULL;
    if (ok) match[count++] = i;
  }
  // com busca: o nome que tem todas as palavras primeiro, depois as estrelas (searchApps); sem busca, a ordem do indice
  if (nw && count > 1) {
    for (int i = 1; i < count; ++i) {
      const int v = match[i];
      int named_v = 1;
      char low[64];
      copy_text(low, sizeof low, x->apps[v].name); lower_ascii(low);
      for (int k = 0; k < nw; ++k) if (!strstr(low, list[k])) named_v = 0;
      int j = i - 1;
      while (j >= 0) {
        const HbApp* o = &x->apps[match[j]];
        char lo[64];
        copy_text(lo, sizeof lo, o->name); lower_ascii(lo);
        int named_o = 1;
        for (int k = 0; k < nw; ++k) if (!strstr(lo, list[k])) named_o = 0;
        if (named_o > named_v || (named_o == named_v && o->stars >= x->apps[v].stars)) break;
        match[j + 1] = match[j];
        --j;
      }
      match[j + 1] = v;
    }
  }
  Buf b = {0};
  buf_fmt(&b, "{\"ok\":true,\"total\":%d,\"count\":%d,\"offset\":%d,\"limit\":%d,\"from\":", x->count, count, offset, limit);
  buf_json(&b, x->from);
  buf_str(&b, ",\"categories\":[");
  for (int c = 0; c < x->ncats; ++c) {
    buf_str(&b, c ? ",{\"id\":" : "{\"id\":"); buf_json(&b, x->cats[c].id);
    buf_str(&b, ",\"name\":"); buf_json(&b, x->cats[c].name); buf_str(&b, "}");
  }
  buf_str(&b, "],\"apps\":[");
  pthread_mutex_lock(&g_lock);
  for (int i = offset, shown = 0; i < count && shown < limit; ++i, ++shown) {
    const HbApp* a = &x->apps[match[i]];
    if (shown) buf_str(&b, ",");
    buf_str(&b, "{\"id\":"); buf_json(&b, a->id);
    buf_str(&b, ",\"repo\":"); buf_json(&b, a->repo);
    buf_str(&b, ",\"name\":"); buf_json(&b, a->name);
    buf_str(&b, ",\"author\":"); buf_json(&b, a->author);
    buf_str(&b, ",\"category\":"); buf_json(&b, a->category);
    buf_str(&b, ",\"description\":"); buf_json(&b, a->desc);
    buf_str(&b, ",\"icon\":"); buf_json(&b, a->icon);
    buf_str(&b, ",\"version\":"); buf_json(&b, a->version);
    buf_fmt(&b, ",\"stars\":%llu,\"files\":[", (unsigned long long)a->stars);
    for (int k = 0; k < a->nfiles; ++k) {
      const HbFile* f = &a->files[k];
      char sid[16];
      hb_store_id(a, f, sid);
      buf_fmt(&b, "%s{\"i\":%d,\"name\":", k ? "," : "", k); buf_json(&b, f->name);
      buf_str(&b, ",\"kind\":"); buf_json(&b, f->kind);
      buf_fmt(&b, ",\"size\":%llu,\"payload\":%s,\"queued\":%s}", (unsigned long long)f->size, hb_kind_payload(f->kind) ? "true" : "false",
              st_queued_locked(sid) ? "true" : "false");
    }
    buf_str(&b, "]}");
  }
  pthread_mutex_unlock(&g_lock);
  pthread_mutex_unlock(&g_hb_lock);
  buf_str(&b, "]}");
  free(match);
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_send(fd, 200, "application/json", b.data, b.size);
  free(b.data);
}

typedef struct { char id[144], name[204]; int64_t i; int has_i; } HbAddBody;
static int hb_add_field(JP* jp, const char* key, void* ctx) {
  HbAddBody* b = ctx;
  if (!strcmp(key, "id")) return jp_text(jp, b->id, sizeof b->id) ? 1 : -1;
  if (!strcmp(key, "name")) return jp_text(jp, b->name, sizeof b->name) ? 1 : -1;
  if (!strcmp(key, "i")) { b->has_i = 1; return jp_int64(jp, &b->i) ? 1 : -1; }
  return 0;
}
static void hb_add(int fd, Request* r) {
  if (!monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  HbAddBody body;
  memset(&body, 0, sizeof body);
  JP jp = {r->body, r->body + r->content_length, 0};
  if (!r->body || !jp_object(&jp, hb_add_field, &body) || !body.id[0] || !body.has_i) { monitor_json(fd, 400, "{\"error\":\"id\"}"); return; }
  lower_ascii(body.id);
  HbApp a;
  HbFile f;
  memset(&a, 0, sizeof a);
  memset(&f, 0, sizeof f);
  int found = 0;
  pthread_mutex_lock(&g_hb_lock);
  hb_refresh_locked();
  for (int i = 0; g_hb && i < g_hb->count; ++i) {
    if (strcmp(g_hb->apps[i].id, body.id)) continue;
    found = 1;
    if (body.i >= 0 && body.i < g_hb->apps[i].nfiles && !strcmp(g_hb->apps[i].files[body.i].name, body.name)) { found = 2; a = g_hb->apps[i]; f = g_hb->apps[i].files[body.i]; }
    break;
  }
  pthread_mutex_unlock(&g_hb_lock);
  if (!found) { monitor_json(fd, 404, "{\"error\":\"not-found\"}"); return; }
  if (found == 1) { monitor_json(fd, 400, "{\"error\":\"file\"}"); return; } // a lista mudou: a pagina pede de novo
  a.files = NULL; a.search = NULL; // so os campos de texto daqui em diante
  if (!hb_kind_payload(f.kind)) { monitor_json(fd, 409, "{\"error\":\"kind\"}"); return; }
  char sid[16];
  hb_store_id(&a, &f, sid);
  char root[1024], name[256];
  pthread_mutex_lock(&g_lock);
  copy_text(root, sizeof root, g_auto_root);
  pthread_mutex_unlock(&g_lock);
  auto_safe_name(f.name, name, sizeof name);
  AutoPlan plan;
  const int planned = root[0] && auto_plan(root, name, a.name, "", 0, &plan, NULL);
  pthread_mutex_lock(&g_lock);
  Job* same = st_request_locked(sid);
  if (same && (!strcmp(same->state, "failed") || !strcmp(same->state, "cancelled")) && !same->running) { remove_job_locked(same); same = NULL; }
  if (same) {
    char answer[120];
    snprintf(answer, sizeof answer, "{\"ok\":true,\"already\":true,\"id\":\"%s\"}", same->id);
    pthread_mutex_unlock(&g_lock);
    monitor_json(fd, 200, answer);
    return;
  }
  const int away = app_away();
  pthread_mutex_unlock(&g_lock);
  // Com a Jobe aberta a fila e dela (o mesmo que a loja faz): instalar pela aba Homebrew da Jobe.
  if (!away) { monitor_json(fd, 409, "{\"error\":\"app-open\"}"); return; }
  if (!planned) { monitor_json(fd, 409, "{\"error\":\"no-root\"}"); return; }
  struct stat st;
  if (!stat(plan.destination, &st) || (plan.publish[0] && !stat(plan.publish, &st))) { monitor_json(fd, 409, "{\"error\":\"exists\"}"); return; }
  char parent[1500];
  copy_text(parent, sizeof parent, plan.destination);
  char* slash = strrchr(parent, '/');
  if (slash) { *slash = 0; mkdir_p(parent); }
  char answer[200], job_id[24] = "";
  pthread_mutex_lock(&g_lock);
  same = st_request_locked(sid);
  if (same) {
    snprintf(answer, sizeof answer, "{\"ok\":true,\"already\":true,\"id\":\"%s\"}", same->id);
    pthread_mutex_unlock(&g_lock);
    monitor_json(fd, 200, answer);
    return;
  }
  if (g_job_count >= MAX_JOBS) { pthread_mutex_unlock(&g_lock); monitor_json(fd, 409, "{\"error\":\"full\"}"); return; }
  Job* j = calloc(1, sizeof *j);
  if (!j) { pthread_mutex_unlock(&g_lock); monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
  snprintf(j->key, sizeof j->key, "homebrew-%s", sid);
  snprintf(j->id, sizeof j->id, "b%u", ++g_next_id);
  j->requested = 1;
  copy_utf8(j->name, sizeof j->name, a.name);
  j->created = j->updated = now_s();
  snprintf(j->lib_id, sizeof j->lib_id, "%s", sid);
  snprintf(j->lib_store, sizeof j->lib_store, "%s", sid);
  snprintf(j->lib_release, sizeof j->lib_release, "homebrew");
  snprintf(j->lib_platform, sizeof j->lib_platform, "ps5");
  j->total = f.size;
  j->ahead = 1;
  j->auto_started = 1;
  snprintf(j->lib_via, sizeof j->lib_via, "direct");
  copy_text(j->lib_file, sizeof j->lib_file, name);
  snprintf(j->url, sizeof j->url, "%s", f.url);
  copy_text(j->destination, sizeof j->destination, plan.destination);
  copy_text(j->storage_root, sizeof j->storage_root, root);
  copy_text(j->publish_to, sizeof j->publish_to, plan.publish);
  snprintf(j->provider, sizeof j->provider, "direct");
  j->link_at = now_s();
  j->reject_html = 1;
  j->range_bytes = DEFAULT_RANGE;
  j->connections = 4;
  j->expected_bytes = 0;
  snprintf(j->platform, sizeof j->platform, "ps5");
  copy_text(j->file, sizeof j->file, name);
  if (origin_format_ok(plan.format)) copy_text(j->format, sizeof j->format, plan.format);
  snprintf(j->state, sizeof j->state, "queued");
  snprintf(j->notify_done, sizeof j->notify_done, "Jobee'sLair: %.120s baixado pelo celular.", j->name);
  snprintf(j->notify_failed, sizeof j->notify_failed, "Jobee'sLair: %.120s nao baixou pelo celular.", j->name);
  g_jobs[g_job_count++] = j;
  save_jobs_locked();
  pthread_cond_broadcast(&g_wake_downloader);
  copy_text(job_id, sizeof job_id, j->id);
  pthread_mutex_unlock(&g_lock);
  const char* where = plan.image ? "homebrew" : plan.pkg ? "packages" : plan.archive ? "archives" : "files";
  snprintf(answer, sizeof answer, "{\"ok\":true,\"id\":\"%s\",\"via\":\"payload\",\"kind\":\"%s\",\"where\":\"%s\"}", job_id, f.kind, where);
  logf_("celular: homebrew na fila: %s (%s)", a.name, f.name);
  monitor_json(fd, 200, answer);
}

static int homebrew_route(int fd, Request* r, const char* query) {
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/homebrew")) { hb_list(fd, query); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/homebrew/add")) { hb_add(fd, r); return 1; }
  return 0;
}
