// Fase 3: a montagem do catalogo (catalog.js buildSteps) e as consultas (a grade, os filtros e as contagens, a pagina
// inicial, os relacionados, a busca da tela Procurar e a ficha). Parte do bg_catalog.c.

// Um numero como o JSON.stringify do JS escreve (o menor texto que volta ao mesmo double).
static void ct_num_json(Buf* b, double v) {
  if (v != v || v > 1.7e308 || v < -1.7e308) { buf_str(b, "null"); return; } // NaN e infinito (sem o isfinite da libm)
  if (v == ct_floor(v) && fabs(v) < 1e21) { buf_fmt(b, "%.0f", v); return; }
  char text[40];
  for (int p = 1; p <= 17; ++p) { snprintf(text, sizeof text, "%.*g", p, v); if (strtod(text, NULL) == v) break; }
  buf_str(b, text);
}
static void ct_json_or_null(Buf* b, const char* s) { if (s) buf_json(b, s); else buf_str(b, "null"); }

// ---- Ordens (catalog.js SORTS) e uma carta por jogo (oneEach) ---------------------------------------------------------
static int ct_from_archive(const Catalog* c, const CtGame* g) { return c->archive >= 0 && ct_ids_has(&g->providers, c->archive); }
static double ct_score(const CtGame* g) { return g->rating_count ? (g->stars * g->rating_count + 3.5 * 500) / (g->rating_count + 500.0) : 0; }
static int ct_sign(double d) { return (d > 0) - (d < 0); } // NaN = 0, como o sort do QuickJS
// b.recommendations - a.recommendations: sem um dos dois (o embutido que nao tem) e NaN, um empate.
static int ct_rec_cmp(const CtGame* a, const CtGame* b) { return a->has_rec && b->has_rec ? ct_sign(b->rec - a->rec) : 0; }
static const Catalog* g_sorting;
static int ct_cmp(int sort, const CtGame* a, const CtGame* b) {
  switch (sort) {
    case CT_RELEVANCE: { int d = ct_from_archive(g_sorting, b) - ct_from_archive(g_sorting, a); return d ? d : ct_rec_cmp(a, b); }
    case CT_NEWEST: { int d = strcmp(b->release, a->release); return (d > 0) - (d < 0); }
    case CT_RATING: { int d = ct_sign(ct_score(b) - ct_score(a)); if (d) return d; return ct_sign((double)(b->has_meta ? b->metacritic : 0) - (a->has_meta ? a->metacritic : 0)); }
    case CT_SIZE: return ct_sign((b->has_size ? b->size_gb : 0) - (a->has_size ? a->size_gb : 0));
    default: { int d = strcmp(a->sort_title ? a->sort_title : a->title, b->sort_title ? b->sort_title : b->title); return (d > 0) - (d < 0); } // localeCompare: NFC + code points
  }
}
typedef int (*CtCmp)(const void* ctx, const CtGame* a, const CtGame* b);
static void ct_merge_sort_fn(CtGame** v, CtGame** tmp, int n, CtCmp cmp, const void* ctx) { // estavel, como o sort do QuickJS
  if (n < 2) return;
  int h = n / 2;
  ct_merge_sort_fn(v, tmp, h, cmp, ctx);
  ct_merge_sort_fn(v + h, tmp, n - h, cmp, ctx);
  int i = 0, k = h, o = 0;
  while (i < h && k < n) tmp[o++] = cmp(ctx, v[k], v[i]) < 0 ? v[k++] : v[i++];
  while (i < h) tmp[o++] = v[i++];
  while (k < n) tmp[o++] = v[k++];
  memcpy(v, tmp, sizeof *v * (size_t)n);
}
static int ct_cmp_sort(const void* ctx, const CtGame* a, const CtGame* b) { return ct_cmp(*(const int*)ctx, a, b); }
static void ct_sort(CtGame** v, int n, CtCmp cmp, const void* ctx) {
  CtGame** tmp = malloc(sizeof *tmp * ((size_t)n + 1));
  if (!tmp) abort();
  ct_merge_sort_fn(v, tmp, n, cmp, ctx);
  free(tmp);
}
// plainTitle: minusculas, sem ™®©, sem ps4/ps5/playstation 4|5 como palavra, o resto vira um espaco (memoria contada).
static char* ct_plain_title(const char* title) {
  Buf a = {0};
  buf_add(&a, "", 0);
  for (const char* p = title; *p;) {
    int l; unsigned cp = ct_cp(p, &l);
    char one[8]; memcpy(one, p, (size_t)l); one[l] = 0;
    p += l;
    if (cp == 0x2122 || cp == 0xae || cp == 0xa9) continue;
    ct_lower_into(&a, one);
  }
  Buf b = {0};
  buf_add(&b, "", 0);
  const char* s = a.data;
  const size_t n = strlen(s);
#define CT_W(c) (((c) >= 'a' && (c) <= 'z') || ((c) >= '0' && (c) <= '9') || (c) == '_' || ((c) >= 'A' && (c) <= 'Z'))
  for (size_t i = 0; i < n;) {
    const int boundary = i == 0 || !CT_W((unsigned char)s[i - 1]);
    size_t k = 0;
    if (CT_W((unsigned char)s[i]) && boundary) {
      if (!strncmp(s + i, "ps", 2) && (s[i + 2] == '4' || s[i + 2] == '5') && !CT_W((unsigned char)s[i + 3])) k = 3;
      else if (!strncmp(s + i, "playstation", 11)) {
        if (s[i + 11] == ' ' && (s[i + 12] == '4' || s[i + 12] == '5') && !CT_W((unsigned char)s[i + 13])) k = 13;
        else if ((s[i + 11] == '4' || s[i + 11] == '5') && !CT_W((unsigned char)s[i + 12])) k = 12;
      }
    }
    if (k) { i += k; continue; }
    buf_add(&b, s + i, 1);
    ++i;
  }
#undef CT_W
  free(a.data);
  Buf c = {0};
  buf_add(&c, "", 0);
  int space = 0;
  for (const char* p = b.data; *p; ++p) {
    const int keep = (*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9');
    if (keep) { if (space && c.size) buf_str(&c, " "); space = 0; buf_add(&c, p, 1); }
    else space = 1;
  }
  free(b.data);
  return ct_take(&c);
}

// ---- A montagem --------------------------------------------------------------------------------------------------
typedef struct {
  const char* bundled_dir;                    // index.json, formats.js, ratings.js, packs/ e art/ (a copia que o app deixa)
  const char* feed_id[CT_MAX_FEEDS];          // o id de cada feed como o app o conhece (o endereco ou o caminho), em ordem
  const char* feed_path[CT_MAX_FEEDS];        // o arquivo de onde ele e lido (a copia do payload ou o arquivo do PS5)
  int nfeeds;
  const char* hidden[CT_MAX_FEEDS + 1]; int nhidden; // os catalogos escondidos ("bundled" ou o id de um feed)
  int ps4, cover_width;
  const char* firmware;                       // "12.00" (o do console), "" sem
  const char* app_version;
  size_t limit;                               // o teto da montagem (bytes de ct_malloc acima do inicio); 0 sem teto
} CtInputs;
typedef struct { Catalog* c; int feed; int ps4; } CtMerge;
static void ct_destroy(Catalog* c) {
  if (!c) return;
  for (int i = 0; i < c->count; ++i) ct_game_free(c->all[i]);
  ct_free(c->all); ct_free(c->games);
  for (int s = 0; s < CT_SORTS; ++s) ct_free(c->by_rank[s]);
  ct_free(c->hash);
  ct_names_free(&c->genres); ct_names_free(&c->features); ct_names_free(&c->providers);
  for (int i = 0; i < 6; ++i) ct_names_free(&c->raw_names[i]);
  ct_free(c->feature_order); ct_free(c->provider_opts); ct_free(c->genre_opts);
  ct_free(c->feed_ids); ct_free(c->feed_stars); ct_free(c->feed_counts);
  for (int i = 0; i < c->nfeeds; ++i) { ct_free(c->feeds[i].url); ct_free(c->feeds[i].name); ct_free(c->feeds[i].path); }
  ct_free(c->solo);
  ct_free(c->known);
  ct_free(c);
}
static int ct_https_ok(const char* s) { CtUrl u; return s && ct_weburl(s, &u); }
// coverSize: uma capa da PlayStation Store na largura que a carta desenha (440, ou 300 com "Economizar energia").
static char* ct_cover_size(const char* url, int width) {
  if (!url) return NULL;
  if (strncmp(url, "https://image.api.playstation.com/", 34)) return ct_dup(url);
  const char* w = NULL;
  for (const char* p = url; *p; ++p) if ((*p == '?' || *p == '&') && p[1] == 'w' && p[2] == '=' && isdigit((unsigned char)p[3])) { w = p + 3; break; }
  if (!w) return ct_dup(url);
  const char* e = w; while (isdigit((unsigned char)*e)) ++e;
  Buf b = {0};
  buf_add(&b, url, (size_t)(w - url)); buf_fmt(&b, "%d", width); buf_str(&b, e);
  return ct_take(&b);
}
static void ct_merge(CtFeedVisit* v, CtRawGame* raw, CtRel* rels, int nrels, const int* magnets, char (*hosts)[256]) {
  CtMerge* m = v->ctx;
  Catalog* c = m->c;
  const int ps4 = raw->platform && !strcmp(raw->platform, "ps4") ? 1 : raw->platform && !strcmp(raw->platform, "ps5") ? 0 : strncmp(raw->id, "PPSA", 4) ? 1 : 0;
  if (m->ps4 && !ps4) return;
  CtIds providers = {0};
  int direct = 0;
  double bytes = 0;
  for (int i = 0; i < nrels; ++i) {
    ct_ids_add(&providers, ct_intern(&c->providers, magnets[i] ? "torrent" : hosts[i]));
    if (!magnets[i] && ct_source_kind(rels[i].url, rels[i].browser, rels[i].requires_browser, rels[i].source) == SK_DIRECT) direct = 1;
    if (rels[i].has_size) bytes += rels[i].size;
  }
  CtGame* known = ct_find_game(c, raw->id);
  const uint64_t bit = 2ull << m->feed;
  if (!known) {
    CtGame* g = ct_new_game(c, raw->id);
    ct_hash_put(c, g); // dois feeds com o mesmo jogo novo: o segundo soma no do primeiro
    g->listed = 1; g->from_feed = 1; g->page_feed = m->feed;
    g->title = ct_dup(raw->title);
    g->platform = (uint8_t)ps4;
    g->providers = providers; providers.v = NULL;
    g->direct = (uint8_t)direct;
    g->dev = ct_text(raw->developer, 120);
    g->pub = ct_text(raw->publisher, 120);
    if (ct_valid_date(raw->release_date)) { snprintf(g->release, sizeof g->release, "%s", raw->release_date); g->has_year = 1; g->year = atoi(raw->release_date); }
    if (ct_valid_date(raw->added)) snprintf(g->added, sizeof g->added, "%s", raw->added);
    for (int i = 0; i < raw->genres.n && i < 8; ++i) { char* t = ct_text(raw->genres.v[i], 40); if (*t) ct_genres_into(c, &g->genres, t); ct_free(t); }
    for (int i = 0; i < raw->features.n && i < 12; ++i) { char* t = ct_text(raw->features.v[i], 40); if (*t) ct_ids_add(&g->features, ct_intern(&c->features, t)); ct_free(t); }
    g->rec = raw->has_rec && raw->rec >= 0 && raw->rec <= 1e9 ? raw->rec : 0;
    g->has_rec = 1;
    if (raw->has_meta && raw->meta >= 0 && raw->meta <= 100) { g->has_meta = 1; g->metacritic = (int)raw->meta; }
    const double size = raw->has_size && raw->size_gb >= 0 && raw->size_gb <= 4096 ? raw->size_gb : bytes ? ct_floor(bytes / 1e8 + 0.5) / 10 : 0;
    if (size) { g->has_size = 1; g->size_gb = size; }
    if (ct_https_ok(raw->cover)) g->cover = ct_cover_size(raw->cover, c->cover_width);
    if (ct_https_ok(raw->hero)) g->hero = 1;
    if (raw->tint && strlen(raw->tint) == 7 && raw->tint[0] == '#') { int hex = 1; for (int i = 1; i < 7; ++i) if (!isxdigit((unsigned char)raw->tint[i])) hex = 0; if (hex) g->tint = ct_dup(raw->tint); }
    known = g;
  } else {
    for (int i = 0; i < providers.n; ++i) ct_ids_add(&known->providers, providers.v[i]);
    if (direct) known->direct = 1;
  }
  ct_free(providers.v);
  if (!(known->sources & bit)) { known->sources |= bit; c->feeds[m->feed].count++; }
  // os links somam no jogo (feedReleases): os formatos saem de todos eles juntos
  if (known->nrels + nrels > known->caprels) { known->caprels = known->nrels + nrels; known->rels = ct_realloc(known->rels, sizeof *known->rels * (size_t)known->caprels); }
  for (int i = 0; i < nrels; ++i) { known->rels[known->nrels++] = rels[i]; memset(&rels[i], 0, sizeof rels[i]); }
}
// Le e junta um feed (o texto inteiro na memoria contada enquanto e lido). 1 lido, 0 nao.
static int ct_read_feed_file(Catalog* c, int feed, const char* path, int ps4) {
  size_t size = 0;
  char* text = ct_read_file(path, &size, 16u << 20);
  if (!text) return 0;
  int ok = 0;
  if (ct_jlx_decode(text, &size)) {
    CtMerge m = {c, feed, ps4};
    CtFeedVisit v;
    memset(&v, 0, sizeof v);
    v.c = c; v.fn = ct_merge; v.ctx = &m; v.url = c->feeds[feed].url; v.want_ratings = 1;
    ok = ct_visit_feed(&v, text, size);
    c->feeds[feed].games = v.games;
    if (v.name) { char* t = ct_text(v.name, 80); ct_free(c->feeds[feed].name); c->feeds[feed].name = t; }
    ct_free(v.name);
    ct_strlist_free(&v.mirrors);
  }
  ct_free(text);
  return ok;
}
static double ct_now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
// O teto: os bytes de ct_malloc acima do inicio da montagem.
static int ct_over(const CtInputs* in, size_t base) { return in->limit && __atomic_load_n(&g_ctm_live, __ATOMIC_RELAXED) > base + in->limit; }
static int ct_known_cmp(const void* a, const void* b) { return strcmp(a, b); }
static int ct_firmware_low(const char* text, char* out, size_t cap) { // ps5FakePackagesLaunch: ate 11.60
  const char* p = text;
  while (*p && !isdigit((unsigned char)*p)) ++p;
  if (!*p) return 0;
  const int major = atoi(p);
  while (isdigit((unsigned char)*p)) ++p;
  if (*p != '.' || !isdigit((unsigned char)p[1])) return 0;
  char minor_text[3] = {p[1], isdigit((unsigned char)p[2]) ? p[2] : '0', 0};
  const int minor = atoi(minor_text);
  if (major > 11 || (major == 11 && minor > 60)) return 0;
  snprintf(out, cap, "%d.%02d", major, minor);
  return 1;
}
// A montagem inteira. NULL com o motivo em `error` ("over-limit" quando passou do teto).
static Catalog* ct_build(const CtInputs* in, char* error, size_t cap) {
  const double started = ct_now_ms();
  const size_t base = __atomic_load_n(&g_ctm_live, __ATOMIC_RELAXED);
  ct_mem_mark();
  Catalog* c = ct_calloc(1, sizeof *c);
  c->ps4 = in->ps4;
  c->cover_width = in->cover_width > 0 ? in->cover_width : 440;
  snprintf(c->bundled_dir, sizeof c->bundled_dir, "%s", in->bundled_dir);
  snprintf(c->app_version, sizeof c->app_version, "%s", in->app_version ? in->app_version : "");
  snprintf(c->firmware, sizeof c->firmware, "%s", in->firmware ? in->firmware : "");
  c->low_firmware = in->firmware && ct_firmware_low(in->firmware, c->low_text, sizeof c->low_text);
  c->archive = c->cdn = -1;
  for (int f = 0; f < in->nfeeds && f < CT_MAX_FEEDS; ++f) { c->feeds[f].url = ct_dup(in->feed_id[f]); c->nfeeds = f + 1; }
  for (int h = 0; h < in->nhidden; ++h) {
    if (!strcmp(in->hidden[h], "bundled")) c->hidden |= 1;
    for (int f = 0; f < c->nfeeds; ++f) if (!strcmp(in->hidden[h], c->feeds[f].url)) c->hidden |= 2ull << f;
  }
  char path[800];
  size_t size;
  snprintf(path, sizeof path, "%s/catalog/index.json", in->bundled_dir);
  char* text = ct_read_file(path, &size, 32u << 20);
  if (text) {
    CtIndexTop t = {c, 0};
    JP jp = {text, text + size, 0};
    if (!jp_object(&jp, ct_index_top, &t) || t.version != 1) {
      logf_("catalogo: %s nao leu (byte %ld); a loja sai so com os feeds", path, (long)(jp.p - text));
      for (int i = 0; i < c->count; ++i) ct_game_free(c->all[i]);
      c->count = 0;
    }
    ct_free(text);
  } else logf_("catalogo: %s nao abriu (%s); a loja sai so com os feeds", path, strerror(errno));
  for (int i = 0; i < 6; ++i) ct_names_free(&c->raw_names[i]);
  c->phase_ms[0] = ct_now_ms() - started;
  // os codigos do embutido (todos, antes do filtro do PS4): conhecidos para a lista Orbit
  int nknown_cap = c->count + 64;
  c->known = ct_malloc(sizeof *c->known * (size_t)nknown_cap);
  for (int i = 0; i < c->count; ++i) snprintf(c->known[c->nknown++], 10, "%s", c->all[i]->id);
  if (c->ps4) { // o PS4 lista so os seus: toda edicao de PS4 (mesmo a "outra edicao") e nenhuma de PS5
    int o = 0;
    for (int i = 0; i < c->count; ++i) { CtGame* g = c->all[i]; if (g->platform == 1) { g->listed = 1; c->all[o++] = g; } else ct_game_free(g); }
    // os listados primeiro, na ordem de [...games, ...twins]: ja e a ordem de all
    c->count = o;
  }
  for (int i = 0; i < c->count; ++i) ct_hash_put(c, c->all[i]);
  c->bundled_count = c->count;
  snprintf(path, sizeof path, "%s/formats.js", in->bundled_dir);
  ct_read_table(c, path, 0);
  snprintf(path, sizeof path, "%s/ratings.js", in->bundled_dir);
  ct_read_table(c, path, 1);
  c->phase_ms[1] = ct_now_ms() - started;
  if (ct_over(in, base)) goto over;
  for (int f = 0; f < c->nfeeds; ++f) {
    c->feeds[f].ok = in->feed_path[f] && ct_read_feed_file(c, f, in->feed_path[f], c->ps4);
    if (ct_over(in, base)) goto over;
  }
  c->phase_ms[2] = ct_now_ms() - started;
  // conhecidos sem a lista Orbit: tambem os que outro feed lista
  for (int i = 0; i < c->count; ++i) {
    const CtGame* g = c->all[i];
    if (!(g->sources & ~1ull)) continue;
    int other = 0;
    for (int f = 0; f < c->nfeeds; ++f) if ((g->sources & (2ull << f)) && strstr(c->feeds[f].url, "/orbit/orbit-store.json") == NULL) other = 1;
    if (!other) continue;
    if (c->nknown == nknown_cap) { nknown_cap *= 2; c->known = ct_realloc(c->known, sizeof *c->known * (size_t)nknown_cap); }
    snprintf(c->known[c->nknown++], 10, "%s", g->id);
  }
  qsort(c->known, (size_t)c->nknown, sizeof *c->known, ct_known_cmp);
  { int o = 0; for (int i = 0; i < c->nknown; ++i) if (!o || strcmp(c->known[o - 1], c->known[i])) memmove(c->known[o++], c->known[i], 10); c->nknown = o; }
  // entries = [...games, ...twins]: os listados (embutidos e depois os novos dos feeds) e as outras edicoes
  {
    CtGame** entries = ct_malloc(sizeof *entries * ((size_t)c->count + 1));
    int n = 0;
    for (int i = 0; i < c->count; ++i) if (c->all[i]->listed) entries[n++] = c->all[i];
    c->nlisted = n;
    for (int i = 0; i < c->count; ++i) if (!c->all[i]->listed) entries[n++] = c->all[i];
    ct_free(c->all);
    c->all = entries;
    c->cap = c->count;
    c->listed = entries;
  }
  // as notas dos feeds num indice (a busca linear era jogos x notas)
  size_t rcap = 64;
  while (rcap < (size_t)c->nratings * 2 + 2) rcap *= 2;
  int* rhash = malloc(sizeof(int) * rcap);
  if (!rhash) abort();
  for (size_t i = 0; i < rcap; ++i) rhash[i] = -1;
  for (int k = 0; k < c->nratings; ++k) { size_t i = ct_hash_id(c->feed_ids[k]) & (rcap - 1); while (rhash[i] >= 0) i = (i + 1) & (rcap - 1); rhash[i] = k; }
  c->archive = ct_find(&c->providers, "archive.org");
  c->cdn = ct_find(&c->providers, CT_CDN_HOST);
  for (int i = 0; i < c->count; ++i) {
    CtGame* g = c->all[i];
    g->entry = i;
    if (!g->from_feed && g->cover) { char* sized = ct_cover_size(g->cover, c->cover_width); ct_free(g->cover); g->cover = sized; }
    const uint16_t fed = g->nrels ? ct_kinds_of(g->rels, g->nrels, &g->feed_solo) : 0;
    g->formats = fed ? (uint16_t)(g->bundled_formats | fed) : g->bundled_formats;
    if (c->ps4) g->formats &= (uint16_t)(1u << 6);
    for (int r = 0; r < g->nrels; ++r) ct_rel_free(&g->rels[r]);
    ct_free(g->rels); g->rels = NULL; g->nrels = g->caprels = 0;
    int k = -1;
    for (size_t h = ct_hash_id(g->id) & (rcap - 1); rhash[h] >= 0; h = (h + 1) & (rcap - 1)) if (!strcmp(c->feed_ids[rhash[h]], g->id)) { k = rhash[h]; break; }
    if (k >= 0) { g->stars = c->feed_stars[k]; g->rating_count = c->feed_counts[k]; }
    else if (g->has_b) { g->stars = g->b_stars; g->rating_count = g->b_count; }
  }
  free(rhash);
  c->phase_ms[3] = ct_now_ms() - started;
  if (ct_over(in, base)) goto over;
  // Uma edicao sem nota fica com a da edicao da mesma obra com mais notas (a 1a delas na ordem de entries).
  {
    // editionsByWork: as edicoes de cada obra, na ordem de entries; um jogo sem nota fica com a da edicao com mais notas
    // (a primeira delas), lida na hora (uma edicao que acabou de ganhar nota conta, como no laco do app).
    int maxw = -1;
    for (int i = 0; i < c->count; ++i) if (c->all[i]->work > maxw) maxw = c->all[i]->work;
    int* head = malloc(sizeof(int) * ((size_t)maxw + 2));
    int* next = malloc(sizeof(int) * ((size_t)c->count + 1));
    if (!head || !next) abort();
    for (int w = 0; w <= maxw; ++w) head[w] = -1;
    for (int i = c->count - 1; i >= 0; --i) { const int w = c->all[i]->work; next[i] = -1; if (w >= 0) { next[i] = head[w]; head[w] = i; } }
    for (int i = 0; i < c->count; ++i) {
      CtGame* g = c->all[i];
      if (g->rating_count || g->work < 0) continue;
      const CtGame* best = NULL;
      for (int k = head[g->work]; k >= 0; k = next[k]) { const CtGame* e = c->all[k]; if (e->rating_count && (!best || e->rating_count > best->rating_count)) best = e; }
      if (best) { g->stars = best->stars; g->rating_count = best->rating_count; }
    }
    free(head); free(next);
  }
  c->phase_ms[4] = ct_now_ms() - started;
  for (int i = 0; i < c->count; ++i) {
    CtGame* g = c->all[i];
    if (!g->title) g->title = ct_dup("");
    if (!g->dev) g->dev = ct_dup("");
    if (!g->pub) g->pub = ct_dup("");
    if (!ct_ascii(g->title)) {
      char* nfc = ct_normalize(g->title, 1);
      if (strcmp(nfc, g->title)) { g->sort_title = ct_dup(nfc); c->nfc_risk++; }
      free(nfc);
    }
    Buf s = {0}; buf_str(&s, g->title); buf_str(&s, " "); buf_str(&s, g->dev); buf_str(&s, " "); buf_str(&s, g->pub); buf_add(&s, "", 0);
    g->search = ct_lower(s.data);
    g->fold = ct_fold(s.data);
    free(s.data);
    char key[600];
    if (g->work >= 0) { snprintf(key, sizeof key, "work:%d", g->work); g->keys[g->nkeys++] = ct_dup(key); }
    if (g->rating_count >= 200) {
      Buf st = {0}; ct_num_json(&st, g->stars); buf_add(&st, "", 0);
      snprintf(key, sizeof key, "rated:%s/%u", st.data, g->rating_count); g->keys[g->nkeys++] = ct_dup(key);
      char* plain = ct_plain_title(g->title);
      snprintf(key, sizeof key, "named:%.500s/%s", plain, st.data); g->keys[g->nkeys++] = ct_dup(key);
      ct_free(plain); free(st.data);
    }
    g->shown = (uint8_t)(g->listed && (g->sources & ~c->hidden) != 0);
  }
  c->phase_ms[5] = ct_now_ms() - started;
  // a lista da loja (sem os catalogos escondidos) e as ordens (rank) sobre os listados
  c->games = ct_malloc(sizeof *c->games * ((size_t)c->nlisted + 1));
  for (int i = 0; i < c->nlisted; ++i) if (c->listed[i]->shown) c->games[c->ngames++] = c->listed[i];
  g_sorting = c;
  for (int s = 0; s < CT_SORTS; ++s) {
    c->by_rank[s] = ct_malloc(sizeof **c->by_rank * ((size_t)c->nlisted + 1));
    memcpy(c->by_rank[s], c->listed, sizeof *c->listed * (size_t)c->nlisted);
    ct_sort(c->by_rank[s], c->nlisted, ct_cmp_sort, &s);
    for (int i = 0; i < c->nlisted; ++i) c->by_rank[s][i]->rank[s] = (uint32_t)i;
  }
  c->phase_ms[6] = ct_now_ms() - started;
  // opcoes dos filtros (catalog.js facetSteps), dos listados
  {
    int* gcount = calloc((size_t)c->genres.n + 1, sizeof(int));
    int* pcount = calloc((size_t)c->providers.n + 1, sizeof(int));
    int* pfirst = malloc(sizeof(int) * ((size_t)c->providers.n + 1));
    if (!gcount || !pcount || !pfirst) abort();
    int kinds[CT_KINDS] = {0};
    for (int i = 0; i < c->providers.n; ++i) pfirst[i] = INT32_MAX;
    int order = 0;
    for (int i = 0; i < c->nlisted; ++i) {
      const CtGame* g = c->listed[i];
      for (int k = 0; k < g->genres.n; ++k) gcount[g->genres.v[k]]++;
      for (int k = 0; k < g->providers.n; ++k) { if (pfirst[g->providers.v[k]] == INT32_MAX) pfirst[g->providers.v[k]] = order++; pcount[g->providers.v[k]]++; }
      for (int k = 0; k < CT_KINDS; ++k) if (g->formats & (1u << k)) kinds[k]++;
    }
    c->genre_opts = ct_malloc(sizeof(int) * ((size_t)c->genres.n + 1));
    for (int i = 0; i < c->genres.n; ++i) if (gcount[i]) c->genre_opts[c->ngenre_opts++] = i;
    for (int a = 1; a < c->ngenre_opts; ++a) for (int b = a; b > 0; --b) { // contagem decrescente, depois localeCompare
      const int x = c->genre_opts[b - 1], y = c->genre_opts[b];
      if (gcount[x] > gcount[y] || (gcount[x] == gcount[y] && strcmp(c->genres.v[x], c->genres.v[y]) <= 0)) break;
      c->genre_opts[b - 1] = y; c->genre_opts[b] = x;
    }
    c->provider_opts = ct_malloc(sizeof(int) * ((size_t)c->providers.n + 1));
    for (int o = 0; o < order; ++o) for (int i = 0; i < c->providers.n; ++i) if (pfirst[i] == o && (pcount[i] >= 20 || !strcmp(c->providers.v[i], CT_CDN_HOST))) c->provider_opts[c->nprovider_opts++] = i;
    for (int a = 1; a < c->nprovider_opts; ++a) for (int b = a; b > 0; --b) { // o CDN primeiro, depois mais jogos (estavel)
      const int x = c->provider_opts[b - 1], y = c->provider_opts[b];
      const int cx = !strcmp(c->providers.v[x], CT_CDN_HOST), cy = !strcmp(c->providers.v[y], CT_CDN_HOST);
      if (cx > cy || (cx == cy && pcount[x] >= pcount[y])) break;
      c->provider_opts[b - 1] = y; c->provider_opts[b] = x;
    }
    c->format_opts[c->nformat_opts++] = "ready";
    for (int k = 0; k < CT_KINDS; ++k) if (kinds[k] >= 5) c->format_opts[c->nformat_opts++] = CT_KIND[k];
    free(gcount); free(pcount); free(pfirst);
  }
  if (ct_over(in, base)) goto over;
  c->solo = ct_malloc((size_t)c->count + 1);
  for (int i = 0; i < c->count; ++i) c->solo[i] = c->all[i]->feed_solo ? 1 : 255;
  c->build_ms = ct_now_ms() - started;
  c->phase_ms[7] = c->build_ms;
  c->bytes = __atomic_load_n(&g_ctm_live, __ATOMIC_RELAXED) - base;
  c->peak = __atomic_load_n(&g_ctm_peak, __ATOMIC_RELAXED) - base;
  return c;
over:
  snprintf(error, cap, "over-limit");
  ct_destroy(c);
  return NULL;
}

// ---- Consultas -----------------------------------------------------------------------------------------------------
typedef struct { char* v[64]; int n; } CtPicked;
typedef struct {
  CtPicked picked[CF_COUNT];
  char* q;          // a busca em minusculas (trim)
  char* fold;       // a busca da tela Procurar (match.js fold)
  int page, per, sort, offset, limit, has_offset, solo, limit_rows;
  char id[16];
  unsigned seed;
  char today[11];
  char* copy;
} CtQuery;
static int ct_has(const Catalog* c, const CtGame* g, int facet, const char* value) {
  switch (facet) {
    case CF_PLATFORM: return !strcmp(value, g->platform ? "ps4" : "ps5");
    case CF_FORMAT:
      if (!strcmp(value, "ready")) return (g->formats & CT_READY_MASK) || (c->low_firmware && !g->platform && (g->formats & (1u << 6)));
      for (int k = 0; k < CT_KINDS; ++k) if (!strcmp(value, CT_KIND[k])) return (g->formats >> k) & 1;
      return 0;
    case CF_ACCESS: return g->direct;
    case CF_GENRE: { int id = ct_find(&c->genres, value); return id >= 0 && ct_ids_has(&g->genres, id); }
    case CF_FEATURE: { int id = ct_find(&c->features, value); return id >= 0 && ct_ids_has(&g->features, id); }
    case CF_RELEASE:
      if (!g->has_year) return 0;
      return !strcmp(value, "recent") ? g->year >= 2024 : !strcmp(value, "current") ? g->year >= 2020 && g->year <= 2023 : !strcmp(value, "older") ? g->year < 2020 : 0;
    case CF_SIZE:
      if (!g->has_size) return 0;
      return !strcmp(value, "small") ? g->size_gb < 10 : !strcmp(value, "medium") ? g->size_gb >= 10 && g->size_gb <= 50 : !strcmp(value, "large") ? g->size_gb > 50 : 0;
    default: { int id = ct_find(&c->providers, value); return id >= 0 && ct_ids_has(&g->providers, id); }
  }
}
static int ct_ready(const Catalog* c, const CtGame* g) { return ct_has(c, g, CF_FORMAT, "ready"); }
// passes + matching: `skip` = o filtro fora (-1 nenhum); `q` = busca por searchText (NULL sem).
static int ct_passes(const Catalog* c, const CtGame* g, const CtQuery* query, int skip, int use_q) {
  if (use_q && query->q && query->q[0] && !strstr(g->search, query->q)) return 0;
  for (int f = 0; f < CF_COUNT; ++f) {
    if (f == skip || !query->picked[f].n) continue;
    int any = 0, all = 1;
    for (int i = 0; i < query->picked[f].n; ++i) { if (ct_has(c, g, f, query->picked[f].v[i])) any = 1; else all = 0; }
    if (CT_FACET_ANY[f] ? !any : !all) return 0;
  }
  return 1;
}
static void ct_url_decode(char* s) {
  char* o = s;
  for (char* p = s; *p; ++p) {
    if (*p == '+') *o++ = ' ';
    else if (*p == '%' && p[1] && p[2]) { char hex[5] = {'0', '0', p[1], p[2], 0}; unsigned v; if (jp_hex(hex, &v)) { *o++ = (char)v; p += 2; } else *o++ = *p; }
    else *o++ = *p;
  }
  *o = 0;
}
static void ct_query_free(CtQuery* q) { free(q->q); free(q->fold); free(q->copy); }
static void ct_query_parse(const char* query, CtQuery* q) {
  memset(q, 0, sizeof *q);
  q->per = 60; q->limit = 40; q->limit_rows = 20;
  q->copy = strdup(query ? query : "");
  if (!q->copy) abort();
  for (char* save = NULL, *pair = strtok_r(q->copy, "&", &save); pair; pair = strtok_r(NULL, "&", &save)) {
    char* eq = strchr(pair, '=');
    if (!eq) continue;
    *eq = 0;
    char* value = eq + 1;
    ct_url_decode(value);
    if (!strcmp(pair, "page")) q->page = atoi(value);
    else if (!strcmp(pair, "per")) q->per = atoi(value);
    else if (!strcmp(pair, "offset")) { q->offset = atoi(value); q->has_offset = 1; }
    else if (!strcmp(pair, "limit")) q->limit = atoi(value);
    else if (!strcmp(pair, "rows")) q->limit_rows = atoi(value);
    else if (!strcmp(pair, "solo")) q->solo = !strcmp(value, "1") || !strcmp(value, "true");
    else if (!strcmp(pair, "seed")) q->seed = (unsigned)strtoul(value, NULL, 10);
    else if (!strcmp(pair, "today")) { if (ct_valid_date(value)) snprintf(q->today, sizeof q->today, "%s", value); }
    else if (!strcmp(pair, "id")) snprintf(q->id, sizeof q->id, "%s", value);
    else if (!strcmp(pair, "sort")) { for (int s = 0; s < CT_SORTS; ++s) if (!strcmp(value, CT_SORT_KEYS[s])) q->sort = s; }
    else if (!strcmp(pair, "q")) {
      free(q->q); free(q->fold);
      char* t = ct_trim_plain(value);
      q->q = ct_lower_plain(t);
      // a tela Procurar: fold(query.trim()) (memoria comum)
      char* f = ct_fold(t);
      q->fold = strdup(f);
      ct_free(f);
      free(t);
    } else for (int f = 0; f < CF_COUNT; ++f) if (!strcmp(pair, CT_FACET_KEYS[f])) {
      for (char* s2 = NULL, *v = strtok_r(value, ",", &s2); v && q->picked[f].n < 64; v = strtok_r(NULL, ",", &s2)) {
        int dup = 0;
        for (int i = 0; i < q->picked[f].n; ++i) if (!strcmp(q->picked[f].v[i], v)) dup = 1;
        if (!dup) q->picked[f].v[q->picked[f].n++] = v;
      }
    }
  }
  if (q->per < 1) q->per = 1;
  if (q->per > 500) q->per = 500;
  if (q->page < 0) q->page = 0;
  if (q->offset < 0) q->offset = 0;
  if (q->limit < 1) q->limit = 1;
  if (q->limit > 500) q->limit = 500;
  if (q->limit_rows < 1 || q->limit_rows > 60) q->limit_rows = 20;
}
// Um conjunto de chaves (oneEach / otherThan).
typedef struct { const char** v; size_t cap; } CtSeen;
static void ct_seen_init(CtSeen* s, size_t n) { s->cap = 64; while (s->cap < n * 4) s->cap *= 2; s->v = calloc(s->cap, sizeof *s->v); if (!s->v) abort(); }
static int ct_seen_has(const CtSeen* s, const char* key) {
  for (size_t i = ct_hash_id(key) & (s->cap - 1); s->v[i]; i = (i + 1) & (s->cap - 1)) if (!strcmp(s->v[i], key)) return 1;
  return 0;
}
static void ct_seen_add(CtSeen* s, const char* key) {
  size_t i = ct_hash_id(key) & (s->cap - 1);
  while (s->v[i]) { if (!strcmp(s->v[i], key)) return; i = (i + 1) & (s->cap - 1); }
  s->v[i] = key;
}
static int ct_any_seen(const CtSeen* s, const CtGame* g) { for (int k = 0; k < g->nkeys; ++k) if (ct_seen_has(s, g->keys[k])) return 1; return 0; }
static void ct_add_keys(CtSeen* s, const CtGame* g) { for (int k = 0; k < g->nkeys; ++k) ct_seen_add(s, g->keys[k]); }
// oneEach no lugar: o primeiro de cada jogo na ordem de `v`.
static int ct_one_each(CtGame** v, int n) {
  CtSeen seen; ct_seen_init(&seen, (size_t)n * 3 + 1);
  int o = 0;
  for (int i = 0; i < n; ++i) { if (ct_any_seen(&seen, v[i])) continue; ct_add_keys(&seen, v[i]); v[o++] = v[i]; }
  free(seen.v);
  return o;
}
// otherThan no lugar: sem os de `shown` e sem as outras edicoes deles.
static int ct_other_than(CtGame** v, int n, CtGame* const* shown, int nshown) {
  CtSeen taken; ct_seen_init(&taken, (size_t)nshown * 3 + 1);
  for (int i = 0; i < nshown; ++i) ct_add_keys(&taken, shown[i]);
  int o = 0;
  for (int i = 0; i < n; ++i) {
    int own = 0;
    for (int k = 0; k < nshown && !own; ++k) if (shown[k] == v[i]) own = 1;
    if (own || ct_any_seen(&taken, v[i])) continue;
    v[o++] = v[i];
  }
  free(taken.v);
  return o;
}
// A carta de um jogo (grade, fileiras, busca).
static void ct_card(Buf* out, const Catalog* c, const CtGame* g) {
  buf_str(out, "{\"id\":"); buf_json(out, g->id);
  buf_str(out, ",\"title\":"); buf_json(out, g->title);
  buf_fmt(out, ",\"platform\":\"%s\",\"formats\":[", g->platform ? "ps4" : "ps5");
  for (int k = 0, m = 0; k < CT_KINDS; ++k) if (g->formats & (1u << k)) buf_fmt(out, "%s\"%s\"", m++ ? "," : "", CT_KIND[k]);
  buf_fmt(out, "],\"ready\":%s,\"direct\":%s,\"sizeGb\":", ct_ready(c, g) ? "true" : "false", g->direct ? "true" : "false");
  if (g->has_size) ct_num_json(out, g->size_gb); else buf_str(out, "null");
  buf_str(out, ",\"stars\":");
  if (g->rating_count) { ct_num_json(out, g->stars); buf_fmt(out, ",\"ratingCount\":%u", g->rating_count); } else buf_str(out, "null,\"ratingCount\":null");
  buf_str(out, ",\"year\":"); if (g->has_year) buf_fmt(out, "%d", g->year); else buf_str(out, "null");
  buf_str(out, ",\"releaseDate\":"); buf_json(out, g->release);
  buf_str(out, ",\"cover\":"); buf_json(out, g->cover ? g->cover : "");
  if (g->tint) { buf_str(out, ",\"tint\":"); buf_json(out, g->tint); }
  buf_str(out, ",\"genres\":[");
  for (int k = 0; k < g->genres.n; ++k) { if (k) buf_str(out, ","); buf_json(out, c->genres.v[g->genres.v[k]]); }
  buf_str(out, "]}");
}
static void ct_cards(Buf* out, const Catalog* c, CtGame* const* v, int n) {
  buf_str(out, "[");
  for (int i = 0; i < n; ++i) { if (i) buf_str(out, ","); ct_card(out, c, v[i]); }
  buf_str(out, "]");
}
// A loja (os listados mostrados) na ordem `sort`, filtrada.
static int ct_filtered(const Catalog* c, const CtQuery* q, int sort, int use_q, CtGame** out) {
  int n = 0;
  for (int i = 0; i < c->nlisted; ++i) {
    CtGame* g = c->by_rank[sort][i];
    if (g->shown && ct_passes(c, g, q, -1, use_q)) out[n++] = g;
  }
  return n;
}
static void ct_meta_json(Buf* out, const Catalog* c) {
  buf_fmt(out, "\"listed\":%d,\"shown\":%d,\"entries\":%d,\"console\":\"%s\",\"readyFirmware\":", c->nlisted, c->ngames, c->count, c->ps4 ? "ps4" : "ps5");
  buf_json(out, c->low_firmware ? c->low_text : "13.60");
}
// GET /api/catalog: a grade de browse/Catalog.jsx (gridOf), paginada; com counts=1 as contagens dos filtros.
static void ct_page(const Catalog* c, const char* query, Buf* out) {
  CtQuery q;
  ct_query_parse(query, &q);
  CtGame** list = malloc(sizeof *list * ((size_t)c->nlisted + 1));
  if (!list) abort();
  int n = ct_filtered(c, &q, q.sort, 1, list);
  const int every = q.picked[CF_PLATFORM].n || (q.q && q.q[0]);
  if (!every) n = ct_one_each(list, n);
  const int from = q.has_offset ? q.offset : q.page * q.per, count = q.has_offset ? q.limit : q.per;
  buf_fmt(out, "{\"ok\":true,\"sort\":\"%s\",\"page\":%d,\"per\":%d,\"offset\":%d,", CT_SORT_KEYS[q.sort], q.page, q.per, from);
  ct_meta_json(out, c);
  buf_str(out, ",\"games\":");
  const int start = from < n ? from : n, end = from + count < n ? from + count : n;
  ct_cards(out, c, list + start, end - start);
  buf_fmt(out, ",\"total\":%d}", n);
  free(list);
  ct_query_free(&q);
}
static const char* ct_host_label(const char* host) { // HOST_NAMES
  static const char* const N[][2] = {{"overdrive cdn", "Overdrive CDN"}, {"archive.org", "Archive.org"}, {"1fichier", "1fichier"}, {"pippo26442999.github", "Pippo mirror"},
                                     {"datanodes", "DataNodes"}, {"mediafire", "MediaFire"}, {"filekeeper", "FileKeeper"}, {"datavaults", "DataVaults"}, {"spectrum", "Spectrum"},
                                     {"buzzheavier", "Buzzheavier"}, {"gofile", "Gofile"}, {"rapidgator", "Rapidgator"}, {"filecrypt", "Filecrypt"}, {"fileditchfiles", "FileDitch"},
                                     {"ranoz", "Ranoz"}, {"transfer", "Transfer.it"}};
  for (size_t i = 0; i < sizeof N / sizeof *N; ++i) if (!strcmp(host, N[i][0])) return N[i][1];
  return host;
}
// As opcoes de um filtro: o valor e o nome, na ordem do app.
static int ct_option_values(const Catalog* c, int f, const char** values, const char** names, int max) {
  int n = 0;
  switch (f) {
    case CF_PLATFORM: values[n] = "ps5"; names[n++] = "PS5"; values[n] = "ps4"; names[n++] = "PS4"; break;
    case CF_FORMAT: for (int i = 0; i < c->nformat_opts && n < max; ++i) { values[n] = c->format_opts[i]; names[n++] = i ? c->format_opts[i] : "13.60 Ready"; } break;
    case CF_ACCESS: values[n] = "direct"; names[n++] = "direct"; break;
    case CF_GENRE: for (int i = 0; i < c->ngenre_opts && n < max; ++i) { values[n] = names[n] = c->genres.v[c->genre_opts[i]]; ++n; } break;
    case CF_FEATURE: for (int i = 0; i < c->nfeature_order && n < max; ++i) { values[n] = names[n] = c->features.v[c->feature_order[i]]; ++n; } break;
    case CF_RELEASE: { static const char* const R[] = {"recent", "current", "older"}; for (int i = 0; i < 3; ++i) { values[n] = names[n] = R[i]; ++n; } break; }
    case CF_SIZE: { static const char* const S[] = {"small", "medium", "large"}; for (int i = 0; i < 3; ++i) { values[n] = names[n] = S[i]; ++n; } break; }
    default: for (int i = 0; i < c->nprovider_opts && n < max; ++i) { values[n] = c->providers.v[c->provider_opts[i]]; names[n] = ct_host_label(values[n]); ++n; } break;
  }
  return n;
}
// facetCounts: a contagem de cada opcao de cada filtro (um filtro "any" contado sem ele mesmo).
static void ct_counts_json(Buf* out, const Catalog* c, const CtQuery* q, int use_q, int solo_mode, const uint8_t* solo) {
  buf_str(out, "{");
  for (int f = 0; f < CF_COUNT; ++f) {
    const char* values[300]; const char* names[300];
    const int n = ct_option_values(c, f, values, names, 300);
    int counts[300] = {0};
    for (int i = 0; i < c->ngames; ++i) {
      const CtGame* g = c->games[i];
      if (!ct_passes(c, g, q, CT_FACET_ANY[f] ? f : -1, use_q)) continue;
      if (solo_mode && q->solo && !(solo && solo[g->entry] == 1)) continue;
      for (int o = 0; o < n; ++o) if (ct_has(c, g, f, values[o])) ++counts[o];
    }
    buf_fmt(out, "%s\"%s\":[", f ? "," : "", CT_FACET_KEYS[f]);
    for (int o = 0; o < n; ++o) {
      if (o) buf_str(out, ",");
      buf_str(out, "{\"value\":"); buf_json(out, values[o]);
      char ready[40];
      snprintf(ready, sizeof ready, "%s Ready", c->low_text); // readyLabel: "13.60" vira o firmware baixo
      buf_str(out, ",\"name\":"); buf_json(out, f == CF_FORMAT && !o && c->low_firmware ? ready : names[o]);
      buf_fmt(out, ",\"count\":%d}", counts[o]);
    }
    buf_str(out, "]");
  }
  buf_str(out, "}");
}
// GET /api/catalog/options: as opcoes de cada filtro, na ordem do app, e (com filtros na consulta) as contagens.
static void ct_options(const Catalog* c, const char* query, Buf* out) {
  CtQuery q;
  ct_query_parse(query, &q);
  buf_str(out, "{\"ok\":true,");
  for (int f = 0; f < CF_COUNT; ++f) {
    const char* values[300]; const char* names[300];
    const int n = ct_option_values(c, f, values, names, 300);
    buf_fmt(out, "\"%s\":[", CT_FACET_KEYS[f]);
    for (int o = 0; o < n; ++o) { if (o) buf_str(out, ","); buf_json(out, values[o]); }
    buf_str(out, "],");
  }
  buf_str(out, "\"counts\":");
  ct_counts_json(out, c, &q, 1, 0, NULL);
  buf_str(out, ",");
  ct_meta_json(out, c);
  buf_fmt(out, ",\"buildMs\":%.1f,\"nfcRisk\":%d,\"bytes\":%zu}", c->build_ms, c->nfc_risk, c->bytes);
  ct_query_free(&q);
}
// GET /api/catalog/search: a tela Procurar (search/index.jsx GameResults): os filtros sem a busca, depois a busca do
// match.js (fold, sem acentos) e a ordem; todas as copias.
static void ct_search(const Catalog* c, const char* query, Buf* out) {
  CtQuery q;
  ct_query_parse(query, &q);
  CtGame** list = malloc(sizeof *list * ((size_t)c->nlisted + 1));
  if (!list) abort();
  int n = 0;
  for (int i = 0; i < c->nlisted; ++i) {
    CtGame* g = c->by_rank[q.sort][i];
    if (!g->shown || !ct_passes(c, g, &q, -1, 0)) continue;
    if (q.fold && q.fold[0] && !strstr(g->fold, q.fold)) continue;
    list[n++] = g;
  }
  const int from = q.has_offset ? q.offset : q.page * q.per, count = q.has_offset ? q.limit : q.per;
  const int start = from < n ? from : n, end = from + count < n ? from + count : n;
  buf_fmt(out, "{\"ok\":true,\"sort\":\"%s\",\"total\":%d,\"offset\":%d,\"games\":", CT_SORT_KEYS[q.sort], n, start);
  ct_cards(out, c, list + start, end - start);
  buf_str(out, "}");
  free(list);
  ct_query_free(&q);
}
// relatedGames: os que dividem mais generos, depois os mais recomendados; empate fica na ordem do catalogo.
static int ct_related_list(const Catalog* c, const CtGame* game, int limit, const CtGame** best, int* shared_of) {
  int n = 0;
  for (int i = 0; i < c->ngames; ++i) {
    const CtGame* other = c->games[i];
    if (!strcmp(other->id, game->id)) continue;
    int shared = 0;
    for (int k = 0; k < other->genres.n; ++k) if (ct_ids_has(&game->genres, other->genres.v[k])) shared++;
    if (!shared) continue;
    int at = n;
    while (at > 0 && !(shared_of[at - 1] > shared || (shared_of[at - 1] == shared && best[at - 1]->has_rec && other->has_rec && best[at - 1]->rec >= other->rec))) at--;
    if (at < limit) {
      for (int k = n < limit ? n : limit - 1; k > at; --k) { best[k] = best[k - 1]; shared_of[k] = shared_of[k - 1]; }
      best[at] = other; shared_of[at] = shared;
      if (n < limit) ++n;
    }
  }
  return n;
}
static void ct_related(const Catalog* c, const char* query, Buf* out) {
  CtQuery q;
  ct_query_parse(query, &q);
  const CtGame* g = ct_find_game(c, q.id);
  const int limit = q.has_offset ? q.limit : q.limit == 40 ? 6 : q.limit;
  if (!g) { buf_str(out, "{\"ok\":false,\"error\":\"not-found\"}"); ct_query_free(&q); return; }
  const CtGame* best[500]; int shared[500];
  const int n = ct_related_list(c, g, limit > 500 ? 500 : limit, best, shared);
  buf_str(out, "{\"ok\":true,\"id\":"); buf_json(out, g->id);
  buf_str(out, ",\"games\":");
  ct_cards(out, c, (CtGame* const*)best, n);
  buf_str(out, "}");
  ct_query_free(&q);
}

// ---- A pagina inicial (browse/Lanes.jsx, featured.js, PopularRail.jsx, CdnRail.jsx) -----------------------------------
// PopularRail: b.ratingCount - a.ratingCount || b.recommendations - a.recommendations (sem recomendacoes: NaN, empate)
static int ct_cmp_pop(const void* ctx, const CtGame* a, const CtGame* b) { (void)ctx; int d = ct_sign((double)b->rating_count - a->rating_count); return d ? d : ct_rec_cmp(a, b); }
// featured.js: (b.ratingCount ?? 0) - (a.ratingCount ?? 0) || (b.recommendations ?? 0) - (a.recommendations ?? 0)
static int ct_cmp_feat(const void* ctx, const CtGame* a, const CtGame* b) {
  (void)ctx;
  int d = ct_sign((double)b->rating_count - a->rating_count);
  return d ? d : ct_sign((b->has_rec ? b->rec : 0) - (a->has_rec ? a->rec : 0));
}
static int ct_cmp_hero(const void* ctx, const CtGame* a, const CtGame* b) { const Catalog* c = ctx; int d = ct_from_archive(c, b) - ct_from_archive(c, a); return d ? d : ct_rec_cmp(a, b); }
static int ct_cmp_newest(const void* ctx, const CtGame* a, const CtGame* b) { (void)ctx; return ct_cmp(CT_NEWEST, a, b); }
static int ct_cmp_added(const void* ctx, const CtGame* a, const CtGame* b) { (void)ctx; int d = strcmp(b->added, a->added); if (d) return (d > 0) - (d < 0); return ct_sign(ct_score(b) - ct_score(a)); }
static int ct_cmp_rank(const void* ctx, const CtGame* a, const CtGame* b) { const int s = *(const int*)ctx; return a->rank[s] < b->rank[s] ? -1 : a->rank[s] > b->rank[s]; }
// featured.js studioOf: o primeiro "nome" da desenvolvedora (ou editora, ou id) em minusculas.
static void ct_studio(const CtGame* g, char* out, size_t cap) {
  const char* who = g->dev[0] ? g->dev : g->pub[0] ? g->pub : g->id;
  char* low = ct_lower_plain(who);
  size_t o = 0; int started = 0;
  for (const char* p = low; *p && o + 1 < cap; ++p) {
    const int keep = (*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9');
    if (keep) { out[o++] = *p; started = 1; }
    else if (started) break;
  }
  out[o] = 0;
  free(low);
}
static double ct_random(unsigned* seed) { *seed = (unsigned)(((uint64_t)*seed * 1103515245u + 12345u) % 2147483648u); return *seed / 2147483648.0; }
static void ct_shuffle(CtGame** v, int n, unsigned* seed) {
  for (int i = n - 1; i > 0; i--) { const int j = (int)ct_floor(ct_random(seed) * (i + 1)); CtGame* t = v[i]; v[i] = v[j]; v[j] = t; }
}
// pickFeatured(games, random) com o random de semente (o app sorteia a cada abertura).
static int ct_pick_featured(const Catalog* c, unsigned seed, CtGame** picks) {
  const int N = c->ngames;
  CtGame** banners = malloc(sizeof *banners * ((size_t)N + 1));
  CtGame** logos = malloc(sizeof *logos * ((size_t)N + 1));
  CtGame** tmp = malloc(sizeof *tmp * ((size_t)N + 1));
  if (!banners || !logos || !tmp) abort();
  int nb = 0, nl = 0;
  for (int i = 0; i < N; ++i) if (c->games[i]->hero) { banners[nb++] = c->games[i]; if (c->games[i]->logo) logos[nl++] = c->games[i]; }
  CtGame** showable = nl >= 5 ? logos : banners;
  int ns = ct_one_each(showable, nl >= 5 ? nl : nb);
  int nliked = 0;
  for (int i = 0; i < ns; ++i) if (ct_score(showable[i]) >= 4.3) tmp[nliked++] = showable[i];
  CtGame** ranked; int nr;
  if (nliked >= 5) { ranked = tmp; nr = nliked; } else { memcpy(tmp, showable, sizeof *tmp * (size_t)ns); ranked = tmp; nr = ns; }
  ct_sort(ranked, nr, ct_cmp_feat, NULL);
  // newest: as 60 mais recentes (com data) entre as mostraveis. Sem 5 bem avaliadas, `ranked` e a propria lista
  // mostravel ja ordenada (o sort do app e no lugar): os empates de data seguem essa ordem.
  CtGame** dated = malloc(sizeof *dated * ((size_t)ns + 1));
  if (!dated) abort();
  int nd = 0;
  CtGame** from = nliked >= 5 ? showable : ranked;
  for (int i = 0; i < ns; ++i) if (from[i]->release[0]) dated[nd++] = from[i];
  ct_sort(dated, nd, ct_cmp_newest, NULL);
  if (nd > 60) nd = 60;
  int npicks = 0;
  char studios[5][64];
  int nstudios = 0;
  #define CT_TAKE(game) do { CtGame* g_ = (game); int dup_ = 0; char st_[64]; ct_studio(g_, st_, sizeof st_); \
    for (int k_ = 0; k_ < npicks; ++k_) { if (picks[k_] == g_) dup_ = 1; }     for (int k_ = 0; k_ < nstudios; ++k_) { if (!strcmp(studios[k_], st_)) dup_ = 1; } \
    if (npicks < 5 && !dup_) { picks[npicks++] = g_; snprintf(studios[nstudios++], 64, "%s", st_); } } while (0)
  CtGame* pool[24]; int np = 0;
  for (int i = 0; i < nr && np < 8; ++i) { int in = 0; for (int k = 0; k < nd; ++k) if (dated[k] == ranked[i]) in = 1; if (in) pool[np++] = ranked[i]; }
  ct_shuffle(pool, np, &seed);
  if (np) CT_TAKE(pool[0]);
  np = 0;
  for (int i = 0; i < nr && np < 24; ++i) pool[np++] = ranked[i];
  ct_shuffle(pool, np, &seed);
  for (int i = 0; i < np; ++i) CT_TAKE(pool[i]);
  #undef CT_TAKE
  for (int i = 0; i < nr && npicks < 5; ++i) { int in = 0; for (int k = 0; k < npicks; ++k) if (picks[k] == ranked[i]) in = 1; if (!in) picks[npicks++] = ranked[i]; }
  ct_shuffle(picks, npicks, &seed);
  free(banners); free(logos); free(tmp); free(dated);
  return npicks;
}
static void ct_iso_date(int64_t ms, char out[11]) {
  int64_t days = ms >= 0 ? ms / 86400000 : -((-ms + 86399999) / 86400000);
  // civil_from_days (Howard Hinnant)
  days += 719468;
  const int64_t era = (days >= 0 ? days : days - 146096) / 146097;
  const unsigned doe = (unsigned)(days - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t y = (int64_t)yoe + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  const unsigned d = doy - (153 * mp + 2) / 5 + 1;
  const unsigned m = mp < 10 ? mp + 3 : mp - 9;
  y += m <= 2;
  char text[40];
  snprintf(text, sizeof text, "%04d-%02u-%02u", (int)y, m, d);
  copy_text(out, 11, text);
}
// GET /api/catalog/home: as fileiras da pagina inicial, cada uma ja na ordem e no tamanho do app.
static void ct_home(const Catalog* c, const char* query, Buf* out) {
  CtQuery q;
  ct_query_parse(query, &q);
  const int N = c->ngames;
  CtGame** a = malloc(sizeof *a * ((size_t)N + 1));
  CtGame** shown = malloc(sizeof *shown * ((size_t)N + 64));
  if (!a || !shown) abort();
  int nshown = 0;
  CtGame* featured[5];
  const int nfeat = ct_pick_featured(c, q.seed ? q.seed : (unsigned)time(NULL), featured);
  buf_str(out, "{\"ok\":true,");
  ct_meta_json(out, c);
  buf_str(out, ",\"carousel\":"); ct_cards(out, c, featured, nfeat);
  memcpy(shown, featured, sizeof *featured * (size_t)nfeat); nshown = nfeat;
  // FEATURED: com banner, Archive.org primeiro, depois recomendados; sem o carrossel; um por jogo; 12
  int n = 0;
  for (int i = 0; i < N; ++i) if (c->games[i]->hero) a[n++] = c->games[i];
  ct_sort(a, n, ct_cmp_hero, c);
  n = ct_other_than(a, n, featured, nfeat);
  n = ct_one_each(a, n);
  if (n > 12) n = 12;
  buf_str(out, ",\"featured\":"); ct_cards(out, c, a, n);
  CtGame* featured_row[12]; const int nfr = n; memcpy(featured_row, a, sizeof *a * (size_t)n);
  // RECENT: com data, mais novos; um por jogo; 15
  n = 0;
  for (int i = 0; i < N; ++i) if (c->games[i]->release[0]) a[n++] = c->games[i];
  { int s = CT_NEWEST; ct_sort(a, n, ct_cmp_rank, &s); }
  n = ct_one_each(a, n); if (n > 15) n = 15;
  buf_str(out, ",\"recent\":"); ct_cards(out, c, a, n);
  // TOP: 200+ notas, pela nota; um por jogo; 20
  n = 0;
  for (int i = 0; i < N; ++i) if (c->games[i]->rating_count >= 200) a[n++] = c->games[i];
  { int s = CT_RATING; ct_sort(a, n, ct_cmp_rank, &s); }
  n = ct_one_each(a, n); if (n > 20) n = 20;
  buf_str(out, ",\"top\":"); ct_cards(out, c, a, n);
  CtGame* top_row[20]; const int ntop = n; memcpy(top_row, a, sizeof *a * (size_t)n);
  // NEW_WEEK: addedAt nos ultimos 7 dias, mais novos, depois a nota; um por jogo; 20 (e o total)
  char week[11];
  if (q.today[0]) { int y, m, d; sscanf(q.today, "%d-%d-%d", &y, &m, &d); struct tm tm = {0}; tm.tm_year = y - 1900; tm.tm_mon = m - 1; tm.tm_mday = d; ct_iso_date((int64_t)timegm(&tm) * 1000 - 7 * 86400000LL, week); }
  else ct_iso_date((int64_t)time(NULL) * 1000 - 7 * 86400000LL, week);
  n = 0;
  for (int i = 0; i < N; ++i) if (c->games[i]->added[0] && strcmp(c->games[i]->added, week) >= 0) a[n++] = c->games[i];
  ct_sort(a, n, ct_cmp_added, NULL);
  n = ct_one_each(a, n);
  buf_fmt(out, ",\"newWeekCount\":%d,\"newWeek\":", n);
  ct_cards(out, c, a, n > 20 ? 20 : n);
  // READY: prontos, por relevancia, sem o carrossel nem Destaques; um por jogo; 15 (e o total)
  n = 0;
  for (int i = 0; i < c->nlisted; ++i) { CtGame* g = c->by_rank[CT_RELEVANCE][i]; if (g->shown && ct_ready(c, g)) a[n++] = g; }
  const int ready_all = n;
  memcpy(shown + nshown, featured_row, sizeof *a * (size_t)nfr);
  n = ct_other_than(a, n, shown, nshown + nfr);
  n = ct_one_each(a, n); if (n > 15) n = 15;
  buf_fmt(out, ",\"readyCount\":%d,\"ready\":", ready_all);
  ct_cards(out, c, a, n);
  CtGame* ready_row[15]; const int nready = n; memcpy(ready_row, a, sizeof *a * (size_t)n);
  // POPULAR: com nota, mais notas, depois recomendados; sem carrossel, Destaques, Top e Prontos; um por jogo; 15
  n = 0;
  for (int i = 0; i < N; ++i) if (c->games[i]->rating_count > 0) a[n++] = c->games[i];
  ct_sort(a, n, ct_cmp_pop, NULL);
  nshown = nfeat;
  memcpy(shown + nshown, featured_row, sizeof *a * (size_t)nfr); nshown += nfr;
  memcpy(shown + nshown, top_row, sizeof *a * (size_t)ntop); nshown += ntop;
  memcpy(shown + nshown, ready_row, sizeof *a * (size_t)nready); nshown += nready;
  n = ct_other_than(a, n, shown, nshown);
  n = ct_one_each(a, n); if (n > 15) n = 15;
  buf_str(out, ",\"popular\":"); ct_cards(out, c, a, n);
  // CDN: no Overdrive CDN, por relevancia; um por jogo (todos)
  n = 0;
  for (int i = 0; i < c->nlisted; ++i) { CtGame* g = c->by_rank[CT_RELEVANCE][i]; if (g->shown && c->cdn >= 0 && ct_ids_has(&g->providers, c->cdn)) a[n++] = g; }
  n = ct_one_each(a, n);
  buf_str(out, ",\"cdn\":"); ct_cards(out, c, a, n);
  buf_str(out, "}");
  free(a); free(shown);
  ct_query_free(&q);
}

// ---- Fontes e catalogos escondidos (catalogSources, sourcesOfGame) ---------------------------------------------------
static void ct_sources(const Catalog* c, Buf* out) {
  buf_fmt(out, "{\"ok\":true,\"sources\":[{\"id\":\"bundled\",\"count\":%d,\"shown\":%s}", c->bundled_count, c->hidden & 1 ? "false" : "true");
  for (int f = 0; f < c->nfeeds; ++f) {
    if (!c->feeds[f].count) continue;
    buf_str(out, ",{\"id\":"); buf_json(out, c->feeds[f].url);
    buf_fmt(out, ",\"count\":%d,\"shown\":%s,\"name\":", c->feeds[f].count, c->hidden & (2ull << f) ? "false" : "true");
    ct_json_or_null(out, c->feeds[f].name);
    buf_str(out, "}");
  }
  buf_str(out, "],\"feeds\":[");
  for (int f = 0; f < c->nfeeds; ++f) {
    if (f) buf_str(out, ",");
    buf_str(out, "{\"id\":"); buf_json(out, c->feeds[f].url);
    buf_fmt(out, ",\"read\":%s,\"games\":%d,\"name\":", c->feeds[f].ok ? "true" : "false", c->feeds[f].games);
    ct_json_or_null(out, c->feeds[f].name);
    buf_str(out, "}");
  }
  buf_str(out, "]}");
}
