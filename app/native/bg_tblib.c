// glibren.73 (payload 1.37.17, Fase 6): a BIBLIOTECA TORBOX da loja completa (/app). Incluido em bg_downloader.c depois
// de bg_homebrew.c (usa lb_get de bg_library.c, debrid_key/tb_turn/tb_slow_down e o mesmo marcador "waiting-app" de
// monitor_library_add, que o auto_loop baixa com a Jobe fechada).
//
// Modelo Orbit: o payload faz tudo e a pagina e fina. O payload le a conta TorBox (torrents e web downloads; a Jobe nao
// baixa usenet) em paginas, guarda so um resumo de cada item (ate TL_MAX, ~0,6 MB) e a pagina pede pedacos dele, com
// busca. Os arquivos de um item so sao lidos quando a pagina abre o item (TL_FILES_MAX por vez). A chave e a de
// debrid_key() (POST /secret ou debrid-keys.json, .61): nunca sai do payload nem vai ao diario.
//
//   GET  /api/app/torbox?q=&kind=all|torrent|webdl&offset=&limit=&refresh=1
//        {ok, at, loading, total, count, offset, limit, truncated, error?, code?, waitS?, items:[{kind, id, name, size,
//        state, progress, files, ready, failed, why, added, queued}]}
//        | 503 {error:"loading"} | 409 {error:"no-key"|"bad-key"} | 503 {error:"rate", waitS} | 502 {error:"torbox", code}
//   GET  /api/app/torbox/item?kind=&id=  {ok, item:{...}, files:[{id, name, size}], more} | os mesmos erros | 404 not-found
//   POST /api/app/torbox/add {kind, id, fileId?, name?, title?, size?, whole?} -> o marcador "waiting-app" de um pedido da
//        Biblioteca TorBox (via "account"): com a Jobe aberta ela o poe na fila dela (phone-library.js libraryFile); fechada,
//        o payload baixa sozinho (auto_loop: requestdl, o disco padrao e a conversao das Configuracoes, .71).
//        -> {ok, id, appOpen} | {ok, already, id} | 400 {error:"id"|"file"} | 409 {error:"not-ready"|"failed", why}
//        | 409 {error:"full"}
// Tudo com monitor_allowed (aparelho pareado ou o proprio PS5): a lista e da conta do dono.
// Quando o TorBox nao consegue o arquivo (estado de erro, parado sem fontes, ou nada baixado em TL_STUCK_S) o item vem com
// failed=true e why ("error"|"stalled"|"timeout"), e o Baixar e recusado com o motivo em vez de esperar para sempre (ideia
// do Orbit 1.9.2).
#define TL_MAX 2000
#define TL_PAGE 100
#define TL_FILES_MAX 400
#define TL_STALE_S 600       // a lista vale 10 min; depois a proxima visita le de novo
#define TL_GAP_S 20          // "Atualizar" (ou uma nova tentativa depois de erro) no maximo 1 vez a cada 20 s
#define TL_STUCK_S (6 * 3600) // nada baixado em 6 h = o TorBox nao conseguiu
#define TL_TURN_MS 20000     // a vez no ritmo unico do TorBox; espera maior (um 429 recente) = "rate"

typedef struct {
  char kind[8], id[24], name[200], state[40], why[8];
  uint64_t size;
  double progress;
  int files, ready, failed;
  int64_t added;
} TlItem;

static pthread_mutex_t g_tl_lock = PTHREAD_MUTEX_INITIALIZER; // antes de g_lock, nunca depois
static TlItem* g_tl;
static int g_tl_count, g_tl_loading, g_tl_truncated, g_tl_has;
static int64_t g_tl_at, g_tl_tried;
static char g_tl_error[16], g_tl_code[64];
static int g_tl_gap_s = -1; // TL_GAP_S (BGDL_TL_GAP_S nos testes)

// "2024-03-05T12:34:56Z" -> segundos (UTC); 0 se nao der. Sem timegm (nem todo libc do PS5 tem).
static int64_t tl_time(const char* s) {
  int y = 0, mo = 0, d = 0, h = 0, mi = 0, se = 0;
  if (sscanf(s, "%d-%d-%dT%d:%d:%d", &y, &mo, &d, &h, &mi, &se) < 3 || y < 1970 || mo < 1 || mo > 12 || d < 1 || d > 31) return 0;
  y -= mo <= 2;
  const int era = y / 400, yoe = y - era * 400, mp = (mo + 9) % 12;
  const int doy = (153 * mp + 2) / 5 + d - 1, doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  const int64_t days = (int64_t)era * 146097 + doe - 719468;
  return days * 86400 + h * 3600 + mi * 60 + se;
}
static int tl_bool(JP* j, int* out) {
  jp_ws(j);
  if (jp_literal(j, "true")) { *out = 1; return 1; }
  *out = 0;
  return jp_skip(j);
}
static int tl_num(JP* j, double* out) {
  jp_ws(j);
  *out = 0;
  if (j->p < j->end && (*j->p == '-' || isdigit((unsigned char)*j->p))) { uint64_t u; int i; return jp_number(j, out, &u, &i); }
  return jp_skip(j);
}
static int tl_digits(const char* s, size_t max) {
  size_t n = 0;
  for (; s[n]; ++n) if (!isdigit((unsigned char)s[n]) || n >= max) return 0;
  return n > 0;
}

typedef struct { char id[24], name[256]; double size; } TlFile;
typedef struct { TlItem it; int finished, present; Buf* files; int listed, more; } TlParse;
static int tl_file_field(JP* j, const char* key, void* ctx) {
  TlFile* f = ctx;
  if (!strcmp(key, "id")) return jp_id(j, f->id, sizeof f->id) ? 1 : -1;
  if (!strcmp(key, "name")) return lib_text(j, f->name, sizeof f->name) ? 1 : -1;
  if (!strcmp(key, "short_name") && !f->name[0]) return lib_text(j, f->name, sizeof f->name) ? 1 : -1;
  if (!strcmp(key, "size")) return tl_num(j, &f->size) ? 1 : -1;
  return 0;
}
static int tl_file_item(JP* j, void* ctx) {
  TlParse* p = ctx;
  ++p->it.files;
  if (!p->files || p->listed >= TL_FILES_MAX) { if (p->files) ++p->more; return jp_skip(j); }
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{') return jp_skip(j);
  TlFile f;
  memset(&f, 0, sizeof f);
  if (!jp_object(j, tl_file_field, &f)) return 0;
  if (!f.id[0] || !f.name[0]) return 1;
  buf_str(p->files, p->listed++ ? ",{\"id\":" : "{\"id\":");
  buf_json(p->files, f.id);
  buf_str(p->files, ",\"name\":");
  buf_json(p->files, f.name);
  buf_fmt(p->files, ",\"size\":%llu}", (unsigned long long)(f.size > 0 ? f.size : 0));
  return 1;
}
static int tl_item_field(JP* j, const char* key, void* ctx) {
  TlParse* p = ctx;
  if (!strcmp(key, "id")) return jp_id(j, p->it.id, sizeof p->it.id) ? 1 : -1;
  if (!strcmp(key, "name")) return lib_text(j, p->it.name, sizeof p->it.name) ? 1 : -1;
  if (!strcmp(key, "download_state")) return lib_text(j, p->it.state, sizeof p->it.state) ? 1 : -1;
  if (!strcmp(key, "download_finished")) return tl_bool(j, &p->finished) ? 1 : -1;
  if (!strcmp(key, "download_present")) return tl_bool(j, &p->present) ? 1 : -1;
  if (!strcmp(key, "progress")) return tl_num(j, &p->it.progress) ? 1 : -1;
  if (!strcmp(key, "size")) {
    double d;
    if (!tl_num(j, &d)) return -1;
    p->it.size = d > 0 ? (uint64_t)d : 0;
    return 1;
  }
  if (!strcmp(key, "created_at")) {
    char t[48];
    if (!lib_text(j, t, sizeof t)) return -1;
    p->it.added = tl_time(t);
    return 1;
  }
  if (!strcmp(key, "files")) {
    jp_ws(j);
    if (j->p < j->end && *j->p == '[') return jp_array(j, tl_file_item, p) ? 1 : -1;
    return jp_skip(j) ? 1 : -1;
  }
  return 0;
}
// Pronto, ou o motivo de o TorBox nao ter conseguido (estado de erro, parado sem fontes, nada em TL_STUCK_S).
static void tl_settle(TlParse* p, const char* kind, int64_t now) {
  TlItem* it = &p->it;
  copy_text(it->kind, sizeof it->kind, kind);
  if (it->progress < 0 || it->progress != it->progress) it->progress = 0;
  if (it->progress > 1) it->progress = it->progress <= 100 ? it->progress / 100 : 1;
  it->ready = p->finished || p->present;
  it->failed = 0;
  it->why[0] = 0;
  if (it->ready) return;
  char s[40];
  copy_text(s, sizeof s, it->state);
  lower_ascii(s);
  if (strstr(s, "error") || strstr(s, "fail") || strstr(s, "dead") || strstr(s, "invalid")) copy_text(it->why, sizeof it->why, "error");
  else if (strstr(s, "stalled")) copy_text(it->why, sizeof it->why, "stalled");
  else if (it->added && now - it->added > TL_STUCK_S && it->progress < 0.001) copy_text(it->why, sizeof it->why, "timeout");
  it->failed = it->why[0] != 0;
}

typedef struct { TlItem* items; int count, cap, page, over, nomem; const char* kind; int64_t now; } TlFetch;
static int tl_page_item(JP* j, void* ctx) {
  TlFetch* f = ctx;
  ++f->page;
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{') return jp_skip(j);
  TlParse p;
  memset(&p, 0, sizeof p);
  if (!jp_object(j, tl_item_field, &p)) return 0;
  if (!p.it.id[0]) return 1;
  for (int i = f->count - 1; i >= 0; --i) if (!strcmp(f->items[i].kind, f->kind) && !strcmp(f->items[i].id, p.it.id)) return 1; // paginas que se cruzam
  if (f->count >= TL_MAX) { f->over = 1; return 1; }
  if (f->count == f->cap) {
    const int cap = f->cap ? f->cap * 2 : 128;
    TlItem* next = realloc(f->items, sizeof *next * (size_t)(cap > TL_MAX ? TL_MAX : cap));
    if (!next) { f->nomem = 1; return 0; }
    f->items = next;
    f->cap = cap > TL_MAX ? TL_MAX : cap;
  }
  tl_settle(&p, f->kind, f->now);
  f->items[f->count++] = p.it;
  return 1;
}
static int tl_newest(const void* a, const void* b) {
  const TlItem* x = a;
  const TlItem* y = b;
  return x->added < y->added ? 1 : x->added > y->added ? -1 : 0;
}
// Uma chamada ao TorBox no ritmo unico. 1 ok (`a` aponta para `body`); 0 erro em `err`.
static int tl_call(const char* path, const char* key, Buf* body, LbAnswer* a, LbErr* err) {
  memset(err, 0, sizeof *err);
  if (tb_turn(TL_TURN_MS, NULL) != 1) { snprintf(err->code, sizeof err->code, "RATE_LIMITED"); err->rate = 1; return 0; }
  if (lb_get(path, key, body, a, err)) return 1;
  if (err->rate) tb_slow_down(g_tb_rate_wait_ms, "biblioteca da /app");
  return 0;
}
static const char* tl_err_kind(const LbErr* e) { return e->rate ? "rate" : e->fatal ? "bad-key" : "torbox"; }
static int tl_missing(const LbErr* e) { return !strcmp(e->code, "ITEM_NOT_FOUND") || !strcmp(e->code, "HTTP_404"); }

static void* tl_fetch_thread(void* unused) {
  (void)unused;
  char key[160], fail[16] = "", code[64] = "";
  TlFetch f;
  memset(&f, 0, sizeof f);
  f.now = now_s();
  if (!debrid_key("torbox", key, sizeof key)) snprintf(fail, sizeof fail, "no-key");
  else {
    Buf body = {0};
    static const char* const kinds[2] = {"torrent", "webdl"};
    for (int k = 0; k < 2 && !fail[0] && !f.over && !g_stop; ++k) {
      f.kind = kinds[k];
      int page = TL_PAGE;
      for (int offset = 0; offset < TL_MAX && !g_stop;) {
        char path[160];
        snprintf(path, sizeof path, "/%s/mylist?bypass_cache=true&offset=%d&limit=%d", k ? "webdl" : "torrents", offset, page);
        LbAnswer a;
        LbErr err;
        if (!tl_call(path, key, &body, &a, &err)) {
          if (tl_missing(&err)) break; // conta sem itens desse tipo
          // uma pagina grande demais (pastas com milhares de arquivos): pede menos itens por vez
          if (!strcmp(err.code, "TOO_LARGE") && page > 5) { page /= 4; continue; }
          snprintf(fail, sizeof fail, "%s", tl_err_kind(&err));
          copy_text(code, sizeof code, err.code);
          break;
        }
        f.page = 0;
        JP jp = {a.data.s, a.data.e, 0};
        int ok = 1;
        if (span_is(a.data, '[')) ok = jp_array(&jp, tl_page_item, &f);
        else if (span_is(a.data, '{')) ok = tl_page_item(&jp, &f);
        if (!ok || f.nomem) { snprintf(fail, sizeof fail, "torbox"); snprintf(code, sizeof code, "%s", f.nomem ? "NO_MEMORY" : "BAD_ANSWER"); break; }
        if (f.page < page || f.over) break;
        offset += page;
      }
    }
    free(body.data);
    memset(key, 0, sizeof key);
  }
  if (f.count > 1) qsort(f.items, (size_t)f.count, sizeof *f.items, tl_newest);
  pthread_mutex_lock(&g_tl_lock);
  copy_text(g_tl_error, sizeof g_tl_error, fail);
  copy_text(g_tl_code, sizeof g_tl_code, code);
  if (!fail[0]) {
    free(g_tl);
    g_tl = f.items;
    f.items = NULL;
    g_tl_count = f.count;
    g_tl_truncated = f.over;
    g_tl_at = now_s();
    g_tl_has = 1;
  } else if (strcmp(fail, "rate") && strcmp(fail, "torbox")) {
    // sem chave ou chave recusada: a lista antiga nao vale mais
    free(g_tl);
    g_tl = NULL;
    g_tl_count = 0;
    g_tl_has = 0;
  }
  g_tl_loading = 0;
  const int count = g_tl_count;
  pthread_mutex_unlock(&g_tl_lock);
  free(f.items);
  if (fail[0]) logf_("biblioteca da /app: conta TorBox nao lida (%s %s)", fail, code);
  else logf_("biblioteca da /app: conta TorBox lida (%d itens%s)", count, f.over ? ", cortada" : "");
  return NULL;
}
static void tl_start_locked(void) {
  if (g_tl_loading) return;
  g_tl_loading = 1;
  g_tl_tried = now_s();
  pthread_t t;
  if (pthread_create(&t, NULL, tl_fetch_thread, NULL)) { g_tl_loading = 0; return; }
  pthread_detach(t);
}

// Ja pedido (na fila do payload ou esperando a Jobe)? Com g_lock.
static int tl_queued_locked(const char* kind, const char* id) {
  for (int i = 0; i < g_job_count; ++i) {
    const Job* j = g_jobs[i];
    if (j->requested && !strcmp(j->lib_via, "account") && !strcmp(j->lib_item_id, id) && !strcmp(j->lib_item_kind, kind) &&
        strcmp(j->state, "failed") && strcmp(j->state, "cancelled")) return 1;
  }
  return 0;
}
static void tl_item_json(Buf* b, const TlItem* it, int queued) {
  buf_str(b, "{\"kind\":"); buf_json(b, it->kind);
  buf_str(b, ",\"id\":"); buf_json(b, it->id);
  buf_str(b, ",\"name\":"); buf_json(b, it->name);
  buf_str(b, ",\"state\":"); buf_json(b, it->state);
  buf_str(b, ",\"why\":"); buf_json(b, it->why);
  buf_fmt(b, ",\"size\":%llu,\"progress\":%.3f,\"files\":%d,\"ready\":%s,\"failed\":%s,\"added\":%lld,\"queued\":%s}",
          (unsigned long long)it->size, it->progress, it->files, it->ready ? "true" : "false", it->failed ? "true" : "false",
          (long long)it->added, queued ? "true" : "false");
}
static void tl_error_reply(int fd, const char* fail, const char* code) {
  Buf b = {0};
  int status = 502;
  buf_str(&b, "{\"error\":");
  buf_json(&b, fail);
  if (!strcmp(fail, "no-key") || !strcmp(fail, "bad-key")) status = 409;
  else if (!strcmp(fail, "rate")) { status = 503; buf_fmt(&b, ",\"waitS\":%lld", (long long)(tb_cooldown_left() / 1000 + 1)); }
  else if (!strcmp(fail, "loading")) status = 503;
  if (code && code[0]) { buf_str(&b, ",\"code\":"); buf_json(&b, code); }
  buf_str(&b, "}");
  monitor_json(fd, status, b.data ? b.data : "{\"error\":\"torbox\"}");
  free(b.data);
}
// q (palavras, todas tem de aparecer no nome, sem diferenca de maiusculas no ASCII)
static int tl_match(const char* name, char** words, int nw) {
  char low[200];
  copy_text(low, sizeof low, name);
  lower_ascii(low);
  for (int i = 0; i < nw; ++i) if (!strstr(low, words[i])) return 0;
  return 1;
}

static void tl_list(int fd, Request* r, const char* query) {
  if (!monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  char q[200] = "", kind[12] = "all";
  int offset = 0, limit = 40, refresh = 0;
  for (const char* p = query ? query : ""; *p;) {
    const size_t n = strcspn(p, "&");
    const char* eq = memchr(p, '=', n);
    const size_t key_size = eq ? (size_t)(eq - p) : n;
    char key[16], value[200];
    url_decode(p, key_size, key, sizeof key);
    if (eq) url_decode(eq + 1, n - key_size - 1, value, sizeof value);
    else value[0] = 0;
    if (!strcmp(key, "q")) { copy_utf8(q, sizeof q, value); lower_ascii(q); }
    else if (!strcmp(key, "kind")) copy_text(kind, sizeof kind, value);
    else if (!strcmp(key, "offset")) offset = atoi(value);
    else if (!strcmp(key, "limit")) limit = atoi(value);
    else if (!strcmp(key, "refresh")) refresh = !strcmp(value, "1");
    p += n;
    if (*p == '&') ++p;
  }
  if (offset < 0) offset = 0;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;
  const int any = strcmp(kind, "torrent") && strcmp(kind, "webdl");
  char words_text[200];
  copy_text(words_text, sizeof words_text, q);
  char* words[16];
  int nw = 0;
  for (char* save = NULL, *w = strtok_r(words_text, " \t", &save); w && nw < 16; w = strtok_r(NULL, " \t", &save)) words[nw++] = w;
  TlItem* page = calloc((size_t)limit, sizeof *page);
  if (!page) { monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
  pthread_mutex_lock(&g_tl_lock);
  const int64_t now = now_s();
  if (!g_tl_loading && ((!g_tl_has && (!g_tl_error[0] || now - g_tl_tried >= (g_tl_gap_s > 0 ? g_tl_gap_s : 1))) || (g_tl_has && now - g_tl_at >= TL_STALE_S) ||
                        (refresh && now - g_tl_tried >= g_tl_gap_s))) tl_start_locked();
  if (!g_tl_has) {
    char fail[16], code[64];
    copy_text(fail, sizeof fail, g_tl_loading ? "loading" : g_tl_error[0] ? g_tl_error : "loading");
    copy_text(code, sizeof code, g_tl_loading ? "" : g_tl_code);
    pthread_mutex_unlock(&g_tl_lock);
    free(page);
    tl_error_reply(fd, fail, code);
    return;
  }
  int count = 0, shown = 0;
  for (int i = 0; i < g_tl_count; ++i) {
    const TlItem* it = &g_tl[i];
    if (!any && strcmp(it->kind, kind)) continue;
    if (nw && !tl_match(it->name, words, nw)) continue;
    if (count++ >= offset && shown < limit) page[shown++] = *it;
  }
  const int total = g_tl_count, truncated = g_tl_truncated, loading = g_tl_loading;
  const int64_t at = g_tl_at;
  char fail[16], code[64];
  copy_text(fail, sizeof fail, g_tl_error);
  copy_text(code, sizeof code, g_tl_code);
  pthread_mutex_unlock(&g_tl_lock);
  int queued[100];
  pthread_mutex_lock(&g_lock);
  for (int i = 0; i < shown; ++i) queued[i] = tl_queued_locked(page[i].kind, page[i].id);
  pthread_mutex_unlock(&g_lock);
  Buf b = {0};
  buf_fmt(&b, "{\"ok\":true,\"at\":%lld,\"loading\":%s,\"total\":%d,\"count\":%d,\"offset\":%d,\"limit\":%d,\"truncated\":%s",
          (long long)at, loading ? "true" : "false", total, count, offset, limit, truncated ? "true" : "false");
  // a lista que a pagina ve e a ultima boa; o erro da ultima leitura vai junto (429, TorBox fora)
  if (fail[0]) {
    buf_str(&b, ",\"error\":"); buf_json(&b, fail);
    if (code[0]) { buf_str(&b, ",\"code\":"); buf_json(&b, code); }
    if (!strcmp(fail, "rate")) buf_fmt(&b, ",\"waitS\":%lld", (long long)(tb_cooldown_left() / 1000 + 1));
  }
  buf_str(&b, ",\"items\":[");
  for (int i = 0; i < shown; ++i) {
    if (i) buf_str(&b, ",");
    tl_item_json(&b, &page[i], queued[i]);
  }
  buf_str(&b, "]}");
  free(page);
  if (b.failed || !b.data) { free(b.data); monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
  monitor_send(fd, 200, "application/json", b.data, b.size);
  free(b.data);
}

static int tl_kind_id(const char* query, char* kind, size_t kcap, char* id, size_t icap) {
  kind[0] = id[0] = 0;
  for (const char* p = query ? query : ""; *p;) {
    const size_t n = strcspn(p, "&");
    const char* eq = memchr(p, '=', n);
    const size_t key_size = eq ? (size_t)(eq - p) : n;
    char key[16], value[64];
    url_decode(p, key_size, key, sizeof key);
    if (eq) url_decode(eq + 1, n - key_size - 1, value, sizeof value);
    else value[0] = 0;
    if (!strcmp(key, "kind")) copy_text(kind, kcap, value);
    else if (!strcmp(key, "id")) copy_text(id, icap, value);
    p += n;
    if (*p == '&') ++p;
  }
  return (!strcmp(kind, "torrent") || !strcmp(kind, "webdl")) && tl_digits(id, 20);
}
static int tl_first(JP* j, void* ctx) {
  TlParse* p = ctx;
  if (p->it.id[0]) return jp_skip(j);
  return jp_object(j, tl_item_field, p);
}
static void tl_item(int fd, Request* r, const char* query) {
  if (!monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  char kind[12], id[24], key[160];
  if (!tl_kind_id(query, kind, sizeof kind, id, sizeof id)) { monitor_json(fd, 400, "{\"error\":\"id\"}"); return; }
  if (!debrid_key("torbox", key, sizeof key)) { tl_error_reply(fd, "no-key", ""); return; }
  char path[160];
  snprintf(path, sizeof path, "/%s/mylist?id=%s&bypass_cache=true", !strcmp(kind, "webdl") ? "webdl" : "torrents", id);
  Buf body = {0}, files = {0};
  LbAnswer a;
  LbErr err;
  const int ok = tl_call(path, key, &body, &a, &err);
  memset(key, 0, sizeof key);
  if (!ok) {
    free(body.data);
    if (tl_missing(&err)) monitor_json(fd, 404, "{\"error\":\"not-found\"}");
    else tl_error_reply(fd, tl_err_kind(&err), err.code);
    return;
  }
  TlParse p;
  memset(&p, 0, sizeof p);
  p.files = &files;
  JP jp = {a.data.s, a.data.e, 0};
  int parsed = span_is(a.data, '{') ? jp_object(&jp, tl_item_field, &p) : span_is(a.data, '[') ? jp_array(&jp, tl_first, &p) : 0;
  free(body.data);
  if (!parsed || !p.it.id[0]) { free(files.data); monitor_json(fd, parsed ? 404 : 502, parsed ? "{\"error\":\"not-found\"}" : "{\"error\":\"torbox\",\"code\":\"BAD_ANSWER\"}"); return; }
  tl_settle(&p, kind, now_s());
  // o resumo guardado fica igual ao que a pagina acabou de ver (pronto, falhou, progresso)
  pthread_mutex_lock(&g_tl_lock);
  for (int i = 0; i < g_tl_count; ++i) if (!strcmp(g_tl[i].kind, kind) && !strcmp(g_tl[i].id, p.it.id)) { g_tl[i] = p.it; break; }
  pthread_mutex_unlock(&g_tl_lock);
  pthread_mutex_lock(&g_lock);
  const int queued = tl_queued_locked(kind, p.it.id);
  pthread_mutex_unlock(&g_lock);
  Buf b = {0};
  buf_str(&b, "{\"ok\":true,\"item\":");
  tl_item_json(&b, &p.it, queued);
  buf_str(&b, ",\"files\":[");
  if (files.data) buf_add(&b, files.data, files.size);
  buf_fmt(&b, "],\"more\":%d}", p.more);
  free(files.data);
  if (b.failed || !b.data) { free(b.data); monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
  monitor_send(fd, 200, "application/json", b.data, b.size);
  free(b.data);
}

typedef struct { char kind[12], id[32], file_id[32], name[256], title[200]; double size; int whole; } TlAdd;
static int tl_add_field(JP* j, const char* key, void* ctx) {
  TlAdd* a = ctx;
  if (!strcmp(key, "kind")) return lib_text(j, a->kind, sizeof a->kind) ? 1 : -1;
  if (!strcmp(key, "id")) return jp_id(j, a->id, sizeof a->id) ? 1 : -1;
  if (!strcmp(key, "fileId")) return jp_id(j, a->file_id, sizeof a->file_id) ? 1 : -1;
  if (!strcmp(key, "name")) return lib_text(j, a->name, sizeof a->name) ? 1 : -1;
  if (!strcmp(key, "title")) return lib_text(j, a->title, sizeof a->title) ? 1 : -1;
  if (!strcmp(key, "size")) return tl_num(j, &a->size) ? 1 : -1;
  if (!strcmp(key, "whole")) return tl_bool(j, &a->whole) ? 1 : -1;
  return 0;
}
// O codigo do jogo no nome (PPSA12345 / CUSA12345), para a Jobe achar o jogo do catalogo.
static void tl_code(const char* text, char* code, size_t cap, char* platform, size_t pcap) {
  for (const char* p = text; *p; ++p) {
    const int ps5 = !strncasecmp(p, "PPSA", 4), ps4 = !strncasecmp(p, "CUSA", 4);
    if (!ps5 && !ps4) continue;
    int digits = 0;
    while (digits < 6 && isdigit((unsigned char)p[4 + digits])) ++digits;
    if (digits != 5) continue;
    snprintf(code, cap, "%s%.5s", ps5 ? "PPSA" : "CUSA", p + 4);
    copy_text(platform, pcap, ps5 ? "ps5" : "ps4");
    return;
  }
}
static void tl_add(int fd, Request* r) {
  if (!monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  TlAdd a;
  memset(&a, 0, sizeof a);
  JP jp = {r->body, r->body + r->content_length, 0};
  if (!r->body || !jp_object(&jp, tl_add_field, &a) || (strcmp(a.kind, "torrent") && strcmp(a.kind, "webdl")) || !tl_digits(a.id, 20)) {
    monitor_json(fd, 400, "{\"error\":\"id\"}");
    return;
  }
  // um arquivo (id + nome) ou, so num torrent, ele inteiro como um zip (o TorBox nao junta um web download)
  if (a.whole ? !strcmp(a.kind, "webdl") : (!tl_digits(a.file_id, 20) || !a.name[0])) { monitor_json(fd, 400, "{\"error\":\"file\"}"); return; }
  char title[200];
  copy_text(title, sizeof title, a.title[0] ? a.title : a.name);
  uint64_t size = a.size > 0 ? (uint64_t)a.size : 0;
  pthread_mutex_lock(&g_tl_lock);
  for (int i = 0; i < g_tl_count; ++i) {
    const TlItem* it = &g_tl[i];
    if (strcmp(it->kind, a.kind) || strcmp(it->id, a.id)) continue;
    if (!it->ready) {
      char answer[96];
      snprintf(answer, sizeof answer, "{\"error\":\"%s\",\"why\":\"%s\"}", it->failed ? "failed" : "not-ready", it->why);
      pthread_mutex_unlock(&g_tl_lock);
      monitor_json(fd, 409, answer);
      return;
    }
    copy_text(title, sizeof title, it->name);
    if (a.whole || !size) size = a.whole ? it->size : size;
    break;
  }
  pthread_mutex_unlock(&g_tl_lock);
  if (!title[0]) copy_text(title, sizeof title, "TorBox");
  char lid[96], answer[160], job_id[24] = "";
  snprintf(lid, sizeof lid, "tb:%s:%s:%s", a.kind, a.id, a.whole ? "all" : a.file_id);
  pthread_mutex_lock(&g_lock);
  Job* same = NULL;
  for (int i = 0; i < g_job_count && !same; ++i) if (g_jobs[i]->requested && !strcmp(g_jobs[i]->lib_id, lid)) same = g_jobs[i];
  if (same && (!strcmp(same->state, "failed") || !strcmp(same->state, "cancelled")) && !same->running) { remove_job_locked(same); same = NULL; }
  if (same) {
    snprintf(answer, sizeof answer, "{\"ok\":true,\"already\":true,\"id\":\"%s\"}", same->id);
    pthread_mutex_unlock(&g_lock);
    monitor_json(fd, 200, answer);
    return;
  }
  if (g_job_count >= MAX_JOBS) { pthread_mutex_unlock(&g_lock); monitor_json(fd, 409, "{\"error\":\"full\"}"); return; }
  Job* j = calloc(1, sizeof *j);
  if (!j) { pthread_mutex_unlock(&g_lock); monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
  Hash h;
  char digest[65];
  hash_init(&h);
  hash_text0(&h, lid);
  if (!hash_finish(&h, digest)) snprintf(digest, sizeof digest, "%032x", g_next_id + 1);
  snprintf(j->key, sizeof j->key, "lib-%.24s", digest);
  j->placeholder = 1;
  j->requested = 1;
  snprintf(j->id, sizeof j->id, "b%u", ++g_next_id);
  snprintf(j->state, sizeof j->state, "waiting-app");
  copy_utf8(j->name, sizeof j->name, title);
  j->total = size;
  j->order = 100000; // depois da fila do app
  j->created = j->updated = now_s();
  copy_text(j->lib_id, sizeof j->lib_id, lid);
  tl_code(title, j->lib_code, sizeof j->lib_code, j->lib_platform, sizeof j->lib_platform);
  if (!j->lib_code[0] && !a.whole) tl_code(a.name, j->lib_code, sizeof j->lib_code, j->lib_platform, sizeof j->lib_platform);
  j->lib_whole = a.whole;
  snprintf(j->lib_via, sizeof j->lib_via, "account");
  copy_text(j->lib_item_kind, sizeof j->lib_item_kind, a.kind);
  copy_text(j->lib_item_id, sizeof j->lib_item_id, a.id);
  copy_text(j->lib_file_id, sizeof j->lib_file_id, a.whole ? "" : a.file_id);
  copy_text(j->lib_file, sizeof j->lib_file, a.whole ? "" : a.name);
  if (!a.whole) format_of_file(a.name, j->format, sizeof j->format);
  g_jobs[g_job_count++] = j;
  save_jobs_locked();
  pthread_cond_broadcast(&g_wake_downloader);
  copy_text(job_id, sizeof job_id, j->id);
  const int away = app_away();
  pthread_mutex_unlock(&g_lock);
  logf_("celular: pedido da Biblioteca TorBox (/app): %s (%s)", title, a.whole ? "o torrent inteiro" : base_name(a.name));
  if (away) {
    char text[400];
    if (g_auto_root[0]) snprintf(text, sizeof text, "Jobee'sLair: %.200s entrou na fila pelo celular e vai baixar pelo payload.", title);
    else snprintf(text, sizeof text, "Jobee'sLair: %.200s entrou na fila pelo celular. Abra a Jobee'sLair para baixar.", title);
    notify(text);
  }
  snprintf(answer, sizeof answer, "{\"ok\":true,\"id\":\"%s\",\"appOpen\":%s}", job_id, away ? "false" : "true");
  monitor_json(fd, 200, answer);
}

static int tblib_route(int fd, Request* r, const char* query) {
  if (strncmp(r->path, "/api/app/torbox", 15)) return 0;
  if (g_tl_gap_s < 0) g_tl_gap_s = atoi(env_or("BGDL_TL_GAP_S", "20"));
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/app/torbox")) { tl_list(fd, r, query); return 1; }
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/app/torbox/item")) { tl_item(fd, r, query); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/app/torbox/add")) { tl_add(fd, r); return 1; }
  return 0;
}
