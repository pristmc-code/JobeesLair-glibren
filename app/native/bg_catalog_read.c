// Fase 3: a leitura dos feeds (feed-format.js game/release/fromPackages) e do catalogo embutido (index.json, formats.js,
// ratings.js). Parte do bg_catalog.c.

// ---- Feeds -------------------------------------------------------------------------------------------------------
typedef struct {
  char *id, *title, *platform, *developer, *publisher, *release_date, *added, *summary, *cover, *hero, *tint;
  CtStrList genres, features, about, shots, fallbacks, videos;
  CtRels rels;
  double rec, meta, size_gb; int has_rec, has_meta, has_size;
} CtRawGame;
static void ct_raw_game_free(CtRawGame* g) {
  char** s[] = {&g->id, &g->title, &g->platform, &g->developer, &g->publisher, &g->release_date, &g->added, &g->summary, &g->cover, &g->hero, &g->tint};
  for (size_t i = 0; i < sizeof s / sizeof *s; ++i) ct_free(*s[i]);
  ct_strlist_free(&g->genres); ct_strlist_free(&g->features); ct_strlist_free(&g->about); ct_strlist_free(&g->shots); ct_strlist_free(&g->fallbacks); ct_strlist_free(&g->videos);
  ct_rels_free(&g->rels);
  memset(g, 0, sizeof *g);
}
static int ct_art_field(JP* j, const char* key, void* ctx) {
  CtRawGame* g = ctx;
  if (!strcmp(key, "cover")) { ct_free(g->cover); return ct_str(j, &g->cover) ? 1 : -1; }
  if (!strcmp(key, "hero")) { ct_free(g->hero); return ct_str(j, &g->hero) ? 1 : -1; }
  if (!strcmp(key, "tint")) { ct_free(g->tint); return ct_str(j, &g->tint) ? 1 : -1; }
  if (!strcmp(key, "coverFallbacks")) { ct_strlist_free(&g->fallbacks); return jp_array(j, ct_strlist_item, &g->fallbacks) ? 1 : -1; }
  return 0;
}
static int ct_game_field(JP* j, const char* key, void* ctx) {
  CtRawGame* g = ctx;
  char** slot = !strcmp(key, "id") ? &g->id : !strcmp(key, "title") ? &g->title : !strcmp(key, "platform") ? &g->platform : !strcmp(key, "developer") ? &g->developer :
                !strcmp(key, "publisher") ? &g->publisher : !strcmp(key, "releaseDate") ? &g->release_date : !strcmp(key, "addedAt") ? &g->added :
                !strcmp(key, "summary") ? &g->summary : NULL;
  if (slot) { ct_free(*slot); return ct_str(j, slot) ? 1 : -1; }
  CtStrList* list = !strcmp(key, "genres") ? &g->genres : !strcmp(key, "features") ? &g->features : !strcmp(key, "about") ? &g->about :
                    !strcmp(key, "shots") ? &g->shots : !strcmp(key, "videos") ? &g->videos : NULL;
  if (list) { ct_strlist_free(list); return jp_array(j, ct_strlist_item, list) ? 1 : -1; }
  if (!strcmp(key, "releases")) { ct_rels_free(&g->rels); g->rels.max = 64; return jp_array(j, ct_rel_item, &g->rels) ? 1 : -1; }
  if (!strcmp(key, "recommendations")) return ct_num(j, &g->rec, &g->has_rec) ? 1 : -1;
  if (!strcmp(key, "metacritic")) return ct_num(j, &g->meta, &g->has_meta) ? 1 : -1;
  if (!strcmp(key, "sizeGb")) return ct_num(j, &g->size_gb, &g->has_size) ? 1 : -1;
  if (!strcmp(key, "art")) { jp_ws(j); return (j->p < j->end && *j->p == '{' ? jp_object(j, ct_art_field, g) : jp_skip(j)) ? 1 : -1; }
  return 0;
}
static int ct_valid_date(const char* s) {
  if (!s || strlen(s) != 10) return 0;
  for (int i = 0; i < 10; ++i) if (i == 4 || i == 7 ? s[i] != '-' : !isdigit((unsigned char)s[i])) return 0;
  return 1;
}
static int ct_usable_filename(const char* n) {
  if (!n || !*n || !strcmp(n, ".") || strstr(n, "..")) return 0;
  int units = 0;
  for (const char* p = n; *p; p += ct_utf8_len((unsigned char)*p)) { unsigned char c = (unsigned char)*p; if (c == '/' || c == '\\' || c < 0x20 || c == 0x7f) return 0; units += ct_utf8_len(c) == 4 ? 2 : 1; }
  return units <= 160;
}
static const char* const CT_FEED_FORMATS[] = {"pkg", "fpkg", "binary", "ffpfsc", "ffpfs", "ffpkg", "exfat", "rar", "7z", "zip"};
static int ct_feed_format(const char* f) { for (size_t i = 0; i < sizeof CT_FEED_FORMATS / sizeof *CT_FEED_FORMATS; ++i) if (f && !strcmp(f, CT_FEED_FORMATS[i])) return (int)i; return -1; }
// feed-format.js release(): o link de feed validado (memoria contada), ou 0. `host`: o hostName (vazio num magnet).
static int ct_feed_release(const CtRel* raw, const char* game_id, int index, const char* feed_key, CtRel* rel, int* magnet_out, char* host, size_t host_cap) {
  memset(rel, 0, sizeof *rel);
  if (!raw->object || !raw->url) return 0;
  char* trimmed = ct_trim_plain(raw->url);
  const int magnet = ct_magnet(trimmed);
  CtUrl u;
  const char* url = magnet ? trimmed : (ct_weburl(raw->url, &u) ? raw->url : NULL);
  if (!url) { free(trimmed); return 0; }
  CtUrl bu;
  const char* browser = magnet || !raw->browser ? NULL : ct_weburl(raw->browser, &bu) ? raw->browser : NULL;
  char* named = ct_text(raw->filename, 160);
  char* from_link = NULL;
  if (magnet) {
    const char* dn = NULL;
    for (const char* p = url; *p; ++p) if ((*p == '?' || *p == '&') && !strncasecmp(p + 1, "dn=", 3)) { dn = p + 4; break; }
    if (dn) {
      size_t k = strcspn(dn, "&");
      char* v = malloc(k + 1); if (!v) abort();
      memcpy(v, dn, k); v[k] = 0;
      for (char* q = v; *q; ++q) if (*q == '+') *q = ' ';
      from_link = ct_uri_decode(v);
      free(v);
    }
  } else {
    char seg[4096];
    size_t n = strcspn(u.path, "?#");
    const char* s = u.path;
    for (size_t k = 0; k < n; ++k) if (u.path[k] == '/') s = u.path + k + 1;
    size_t len = (size_t)(u.path + n - s); if (len >= sizeof seg) len = sizeof seg - 1;
    memcpy(seg, s, len); seg[len] = 0;
    from_link = ct_uri_decode(seg);
  }
  char gen[32]; snprintf(gen, sizeof gen, "%s-%d", game_id, index + 1);
  const char* filename = ct_usable_filename(named) ? named : ct_usable_filename(from_link) ? from_link : gen;
  const char* dot = strrchr(filename, '.');
  char ext[32] = "";
  if (dot && dot[1]) { int alnum = 1; for (const char* q = dot + 1; *q; ++q) if (!ct_alnum((unsigned char)*q)) alnum = 0; if (alnum && strlen(dot + 1) < sizeof ext) { snprintf(ext, sizeof ext, "%s", dot + 1); for (char* q = ext; *q; ++q) *q = (char)tolower((unsigned char)*q); } }
  const int fi = ct_feed_format(raw->format);
  const char* format = fi >= 0 ? CT_FEED_FORMATS[fi] : ct_feed_format(ext) >= 0 ? ext : "binary";
  host[0] = 0;
  if (!magnet) ct_host_name(url, host, host_cap);
  char* provider = ct_text(raw->provider, 40);
  if (!*provider) { ct_free(provider); provider = ct_dup(magnet ? "Torrent" : host); }
  char* label = ct_text(raw->label, 200);
  if (!*label) { ct_free(label); label = ct_dup(provider); }
  char* record = ct_text(raw->record, 80);
  if (!*record) { ct_free(record); Buf b = {0}; buf_fmt(&b, "feed-%s-%s", feed_key, game_id); record = ct_take(&b); }
  char* volume = ct_text(raw->volume, 40);
  char* password = ct_text(raw->password, 256);
  Buf idb = {0};
  buf_str(&idb, url); buf_str(&idb, " "); buf_str(&idb, label);
  char k[20]; ct_stable_key(idb.data ? idb.data : "", k);
  free(idb.data);
  Buf rid = {0}; buf_fmt(&rid, "feed-%s-%s-%s", feed_key, game_id, k);
  rel->id = ct_take(&rid);
  rel->format = ct_dup(format);
  rel->filename = ct_dup(filename);
  rel->url = ct_dup(url);
  rel->browser = browser ? ct_dup(browser) : NULL;
  rel->requires_browser = raw->requires_browser;
  if (raw->has_size && raw->size > 0 && raw->size == ct_floor(raw->size) && raw->size <= 9007199254740991.0) { rel->has_size = 1; rel->size = raw->size; }
  rel->version = ct_text(raw->version, 32);
  char* category = ct_text(raw->category, 16);
  if (!*category) { ct_free(category); category = ct_dup("game"); }
  rel->category = category;
  rel->provider = provider;
  rel->source = ct_dup("feed");
  rel->flow = ct_dup("feed");
  rel->label = label;
  rel->record = record;
  rel->object = 1;
  if (*volume) rel->volume = volume; else ct_free(volume);
  if (*password) rel->password = password; else ct_free(password);
  if (raw->sha256 && strlen(raw->sha256) == 64) {
    int hex = 1; for (const char* p = raw->sha256; *p; ++p) if (!isxdigit((unsigned char)*p)) hex = 0;
    if (hex) { rel->sha256 = ct_dup(raw->sha256); for (char* p = rel->sha256; *p; ++p) *p = (char)tolower((unsigned char)*p); }
  }
  ct_rel_patch(rel);
  *magnet_out = magnet;
  ct_free(named); free(from_link); free(trimmed);
  return 1;
}

// fromPackages (Pegasus): cada item de "packages" vira um jogo de feed; um codigo repetido junta os links.
typedef struct { char *title_id, *title, *version, *description, *poster, *original; CtStrList names, urls, builds, hosts; int has_links; } CtPkg;
typedef struct { char *name, *url, *build, *host; } CtPkgLink;
static int ct_pkg_details(JP* j, const char* key, void* ctx) {
  CtPkgLink* l = ctx;
  if (!strcmp(key, "buildKey")) { ct_free(l->build); return ct_str(j, &l->build) ? 1 : -1; }
  if (!strcmp(key, "hostLabel")) { ct_free(l->host); return ct_str(j, &l->host) ? 1 : -1; }
  return 0;
}
static int ct_pkg_link_field(JP* j, const char* key, void* ctx) {
  CtPkgLink* l = ctx;
  if (!strcmp(key, "name")) { ct_free(l->name); return ct_str(j, &l->name) ? 1 : -1; }
  if (!strcmp(key, "url")) { ct_free(l->url); return ct_str(j, &l->url) ? 1 : -1; }
  if (!strcmp(key, "details")) { jp_ws(j); return (j->p < j->end && *j->p == '{' ? jp_object(j, ct_pkg_details, l) : jp_skip(j)) ? 1 : -1; }
  return 0;
}
static int ct_pkg_link(JP* j, void* ctx) {
  CtPkg* p = ctx;
  CtPkgLink l = {NULL, NULL, NULL, NULL};
  jp_ws(j);
  if (j->p < j->end && *j->p == '{') { if (!jp_object(j, ct_pkg_link_field, &l)) { ct_free(l.name); ct_free(l.url); ct_free(l.build); ct_free(l.host); return 0; } }
  else if (!jp_skip(j)) return 0;
  ct_strlist_push(&p->names, l.name); ct_strlist_push(&p->urls, l.url); ct_strlist_push(&p->builds, l.build); ct_strlist_push(&p->hosts, l.host);
  return 1;
}
static void ct_pkg_free(CtPkg* p) {
  ct_free(p->title_id); ct_free(p->title); ct_free(p->version); ct_free(p->description); ct_free(p->poster); ct_free(p->original);
  ct_strlist_free(&p->names); ct_strlist_free(&p->urls); ct_strlist_free(&p->builds); ct_strlist_free(&p->hosts);
  memset(p, 0, sizeof *p);
}
static int ct_pkg_field(JP* j, const char* key, void* ctx) {
  CtPkg* p = ctx;
  char** slot = !strcmp(key, "titleId") ? &p->title_id : !strcmp(key, "title") ? &p->title : !strcmp(key, "version") ? &p->version :
                !strcmp(key, "description") ? &p->description : !strcmp(key, "posterUrl") ? &p->poster : !strcmp(key, "originalPosterUrl") ? &p->original : NULL;
  if (slot) { ct_free(*slot); return ct_str(j, slot) ? 1 : -1; }
  if (!strcmp(key, "downloadLinks")) {
    jp_ws(j);
    ct_strlist_free(&p->names); ct_strlist_free(&p->urls); ct_strlist_free(&p->builds); ct_strlist_free(&p->hosts);
    if (j->p >= j->end || *j->p != '[') { p->has_links = 0; return jp_skip(j) ? 1 : -1; }
    p->has_links = 1;
    return jp_array(j, ct_pkg_link, p) ? 1 : -1;
  }
  return 0;
}
// slug: minusculas, o que nao e [a-z0-9] vira "-", sem "-" nas pontas.
static void ct_slug(const char* s, Buf* out) {
  char* low = ct_lower_plain(s);
  int dash = 0;
  const size_t start = out->size;
  for (const char* p = low; *p; ++p) {
    if ((*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9')) { if (dash && out->size > start) buf_str(out, "-"); dash = 0; buf_add(out, p, 1); }
    else dash = 1;
  }
  free(low);
}
// plainText do HTML: <br>/</p> viram quebra, tags somem, 6 entidades (malloc comum).
static char* ct_plain_html(const char* html) {
  Buf b = {0};
  buf_add(&b, "", 0);
  for (const char* p = html; *p;) {
    if (*p == '<') {
      if (!strncasecmp(p, "</p>", 4)) { buf_str(&b, "\n"); p += 4; continue; }
      if (!strncasecmp(p, "<br", 3)) {
        const char* q = p + 3; while (ct_ws((unsigned char)*q)) ++q; if (*q == '/') ++q;
        if (*q == '>') { buf_str(&b, "\n"); p = q + 1; continue; }
      }
      const char* close = strchr(p, '>');
      if (close) { p = close + 1; continue; }
    }
    if (*p == '&') {
      static const char* const E[][2] = {{"&amp;", "&"}, {"&lt;", "<"}, {"&gt;", ">"}, {"&quot;", "\""}, {"&#39;", "'"}, {"&nbsp;", " "}};
      int done = 0;
      for (int e = 0; e < 6 && !done; ++e) { size_t k = strlen(E[e][0]); if (!strncmp(p, E[e][0], k)) { buf_str(&b, E[e][1]); p += k; done = 1; } }
      if (done) continue;
    }
    buf_add(&b, p, 1);
    ++p;
  }
  return b.data;
}
// PART /\s*\bpart\s*(\d{1,3})\s*$/i num rotulo: o numero (ou -1) e onde o trecho comeca.
static int ct_pkg_part(const char* label, size_t* at) {
  size_t e = strlen(label);
  while (e > 0 && ct_ws((unsigned char)label[e - 1])) --e;
  size_t d = e;
  while (d > 0 && isdigit((unsigned char)label[d - 1])) --d;
  if (d == e || e - d > 3) return -1;
  size_t q = d;
  while (q > 0 && ct_ws((unsigned char)label[q - 1])) --q;
  if (q < 4 || strncasecmp(label + q - 4, "part", 4)) return -1;
  if (q > 4 && (ct_alnum((unsigned char)label[q - 5]) || label[q - 5] == '_')) return -1;
  size_t s0 = q - 4;
  while (s0 > 0 && ct_ws((unsigned char)label[s0 - 1])) --s0;
  *at = s0;
  return atoi(label + d);
}
// Um item de "packages" como o jogo de feed que packageGame da (o JSON que game() le).
static int ct_pkg_to_raw(CtPkg* p, CtRawGame* g) {
  if (!p->has_links) return 0;
  memset(g, 0, sizeof *g);
  g->id = p->title_id ? ct_dup(p->title_id) : NULL;
  g->title = p->title ? ct_dup(p->title) : NULL;
  g->cover = p->original && *p->original ? ct_dup(p->original) : p->poster ? ct_dup(p->poster) : NULL;
  char* plain = ct_plain_html(ct_s(p->description));
  Buf joined = {0};
  buf_add(&joined, "", 0);
  int lines = 0;
  for (char* line = plain; line;) {
    char* nl = strchr(line, '\n');
    if (nl) *nl = 0;
    char* t = ct_text(line, 4000);
    if (*t) { if (lines < 2) { if (lines) buf_str(&joined, " "); buf_str(&joined, t); } ++lines; ct_strlist_push(&g->about, t); } else ct_free(t);
    line = nl ? nl + 1 : NULL;
  }
  free(plain);
  g->summary = ct_take(&joined);
  char* version = ct_text(p->version, 32);
  for (int i = 0; i < p->urls.n; ++i) {
    char* build0 = ct_text(p->builds.v[i], 16);
    char* build = ct_lower(build0); ct_free(build0);
    char* host = ct_text(p->hosts.v[i], 40);
    char* label = ct_text(p->names.v[i], 100);
    if (!*label) { ct_free(label); Buf b = {0}; buf_add(&b, "", 0); if (*build) buf_str(&b, build); if (*build && *host) buf_str(&b, " - "); if (*host) buf_str(&b, host); label = ct_take(&b); }
    const char* url = ct_s(p->urls.v[i]);
    size_t part_at = 0;
    const int part = ct_pkg_part(label, &part_at);
    CtRel* r = ct_rels_push(&g->rels);
    r->object = 1;
    r->url = ct_dup(url);
    char k[20]; ct_stable_key(url, k);
    Buf src = {0}, sl = {0}, fn = {0};
    buf_str(&src, ct_s(p->title_id)); buf_str(&src, "-"); buf_str(&src, label);
    ct_slug(src.data ? src.data : "", &sl);
    free(src.data);
    buf_add(&fn, "", 0);
    buf_add(&fn, sl.data ? sl.data : "", sl.size > 80 ? 80 : sl.size); buf_fmt(&fn, "-%.8s", k);
    free(sl.data);
    r->filename = ct_take(&fn);
    r->label = ct_dup(label);
    if (part >= 0) { Buf v = {0}; buf_fmt(&v, "part %d", part); r->volume = ct_take(&v); }
    if (*host) r->provider = ct_lower(host);
    r->version = ct_dup(version);
    r->category = ct_dup(!strcmp(build, "dlc") ? "dlc" : "game");
    if (!strcmp(build, "fpkg")) r->format = ct_dup("fpkg");
    r->requires_browser = 1;
    Buf rec = {0}, s1 = {0};
    buf_str(&rec, "pkg-");
    if (part >= 0) {
      Buf a = {0}; buf_str(&a, ct_s(p->title_id)); buf_str(&a, "-"); buf_str(&a, build);
      ct_slug(a.data ? a.data : "", &s1); free(a.data);
      char* base = ct_ndup(label, part_at);
      char k2[20]; ct_stable_key(base, k2); ct_free(base);
      buf_add(&rec, s1.data ? s1.data : "", s1.size); buf_fmt(&rec, "-%s", k2);
    } else {
      ct_slug(ct_s(p->title_id), &s1);
      buf_add(&rec, s1.data ? s1.data : "", s1.size); buf_fmt(&rec, "-%s", k);
    }
    free(s1.data);
    r->record = ct_take(&rec);
    ct_free(build); ct_free(host); ct_free(label);
  }
  ct_free(version);
  return 1;
}

// A leitura de um feed: cada jogo validado vai para `fn` (com os links ja normalizados), na ordem do feed.
typedef struct CtFeedVisit CtFeedVisit;
typedef void (*CtGameFn)(CtFeedVisit* v, CtRawGame* raw, CtRel* rels, int nrels, const int* magnets, char (*hosts)[256]);
struct CtFeedVisit {
  Catalog* c; CtGameFn fn; void* ctx;
  const char* url; char key[20];
  char (*seen)[10]; int nseen, offered, releases, games, skipped, stop;
  CtPkg* pkgs; int npkgs, cappkgs;
  char* name; CtStrList mirrors;
  int ratings_kept, want_ratings;
};
static void ct_feed_take(CtFeedVisit* v, CtRawGame* raw) {
  char* idt = ct_text(raw->id, 9);
  for (char* p = idt; *p; ++p) *p = (char)toupper((unsigned char)*p);
  char* title = ct_text(raw->title, 200);
  int ok = strlen(idt) == 9 && (!strncmp(idt, "CUSA", 4) || !strncmp(idt, "PPSA", 4)) && *title;
  for (int i = 4; ok && i < 9; ++i) if (!isdigit((unsigned char)idt[i])) ok = 0;
  if (!ok) { ct_free(idt); ct_free(title); return; }
  const int n = raw->rels.n;
  CtRel* rels = calloc((size_t)n + 1, sizeof *rels);
  int* magnets = calloc((size_t)n + 1, sizeof *magnets);
  char (*hosts)[256] = calloc((size_t)n + 1, sizeof *hosts);
  if (!rels || !magnets || !hosts) abort();
  int nrels = 0;
  for (int i = 0; i < n; ++i) if (ct_feed_release(&raw->rels.v[i], idt, i, v->key, &rels[nrels], &magnets[nrels], hosts[nrels], sizeof hosts[0])) ++nrels;
  int dup = 0;
  for (int k = v->nseen - 1; k >= 0 && !dup; --k) if (v->seen[k][8] == idt[8] && !strcmp(v->seen[k], idt)) dup = 1;
  if (nrels && !dup) {
    if (nrels > 20000 - v->releases) { for (int i = 20000 - v->releases; i < nrels; ++i) ct_rel_free(&rels[i]); nrels = 20000 - v->releases; }
    if (!(v->nseen & 1023)) { v->seen = realloc(v->seen, sizeof *v->seen * (size_t)(v->nseen + 1024)); if (!v->seen) abort(); }
    snprintf(v->seen[v->nseen++], 10, "%s", idt);
    v->releases += nrels;
    ++v->games;
    ct_free(raw->id); raw->id = idt; idt = NULL;
    ct_free(raw->title); raw->title = title; title = NULL;
    v->fn(v, raw, rels, nrels, magnets, hosts);
  }
  for (int i = 0; i < nrels; ++i) ct_rel_free(&rels[i]);
  free(rels); free(magnets); free(hosts); ct_free(idt); ct_free(title);
}
static int ct_feed_game_item(JP* j, void* ctx) {
  CtFeedVisit* v = ctx;
  if (v->stop || v->offered >= 5000) return jp_skip(j);
  ++v->offered;
  if (v->releases >= 20000) return jp_skip(j);
  CtRawGame raw;
  memset(&raw, 0, sizeof raw);
  jp_ws(j);
  if (j->p < j->end && *j->p != '{') return jp_skip(j);
  if (!jp_object(j, ct_game_field, &raw)) { ct_raw_game_free(&raw); return 0; }
  ct_feed_take(v, &raw);
  ct_raw_game_free(&raw);
  return 1;
}
static int ct_pkg_item(JP* j, void* ctx) {
  CtFeedVisit* v = ctx;
  jp_ws(j);
  if (v->npkgs == v->cappkgs) { v->cappkgs = v->cappkgs ? v->cappkgs * 2 : 64; v->pkgs = ct_realloc(v->pkgs, sizeof *v->pkgs * (size_t)v->cappkgs); }
  CtPkg* p = &v->pkgs[v->npkgs];
  memset(p, 0, sizeof *p);
  if (j->p < j->end && *j->p == '{') { if (!jp_object(j, ct_pkg_field, p)) { ct_pkg_free(p); return 0; } ++v->npkgs; }
  else if (!jp_skip(j)) return 0;
  return 1;
}
// As notas de um feed ({"PPSA...": [estrelas, quantas]}): a primeira lista que da uma nota a um jogo vale.
typedef struct { double pair[2]; int npair, bad; } CtPair;
static int ct_pair_item(JP* j, void* ctx) {
  CtPair* r = ctx;
  double v; int has;
  if (!ct_num(j, &v, &has)) return 0;
  if (r->npair < 2) { if (!has) r->bad = 1; r->pair[r->npair] = v; }
  ++r->npair;
  return 1;
}
static int ct_rating_field(JP* j, const char* key, void* ctx) {
  CtFeedVisit* v = ctx;
  Catalog* c = v->c;
  jp_ws(j);
  int title = strlen(key) == 9;
  for (int i = 0; title && i < 4; ++i) if (key[i] < 'A' || key[i] > 'Z') title = 0;
  for (int i = 4; title && i < 9; ++i) if (!isdigit((unsigned char)key[i])) title = 0;
  if (!v->want_ratings || v->ratings_kept >= 6000 || !title || j->p >= j->end || *j->p != '[') return jp_skip(j) ? 1 : -1;
  CtPair r = {{0, 0}, 0, 0};
  if (!jp_array(j, ct_pair_item, &r)) return -1;
  const double stars = r.pair[0], count = r.pair[1];
  if (r.bad || r.npair < 2 || !(stars >= 1 && stars <= 5) || count <= 0 || count != ct_floor(count) || count > 9007199254740991.0) return 1;
  ++v->ratings_kept;
  for (int i = 0; i < c->nratings; ++i) if (!strcmp(c->feed_ids[i], key)) return 1;
  if (c->nratings == c->capratings) {
    c->capratings = c->capratings ? c->capratings * 2 : 4096;
    c->feed_stars = ct_realloc(c->feed_stars, sizeof *c->feed_stars * (size_t)c->capratings);
    c->feed_counts = ct_realloc(c->feed_counts, sizeof *c->feed_counts * (size_t)c->capratings);
    c->feed_ids = ct_realloc(c->feed_ids, sizeof *c->feed_ids * (size_t)c->capratings);
  }
  snprintf(c->feed_ids[c->nratings], 10, "%s", key);
  c->feed_stars[c->nratings] = stars;
  c->feed_counts[c->nratings++] = (uint32_t)count;
  return 1;
}
typedef struct { CtFeedVisit* v; int version, has_games, has_packages; } CtTop;
static int ct_feed_top(JP* j, const char* key, void* ctx) {
  CtTop* t = ctx;
  CtFeedVisit* v = t->v;
  if (!strcmp(key, "version")) { double d; int has; if (!ct_num(j, &d, &has)) return -1; t->version = has && d == 1; return 1; }
  if (!strcmp(key, "name")) { ct_free(v->name); return ct_str(j, &v->name) ? 1 : -1; }
  if (!strcmp(key, "mirrors")) { ct_strlist_free(&v->mirrors); return jp_array(j, ct_strlist_item, &v->mirrors) ? 1 : -1; }
  if (!strcmp(key, "games")) {
    jp_ws(j);
    if (j->p >= j->end || *j->p != '[') return jp_skip(j) ? 1 : -1;
    t->has_games = 1;
    return jp_array(j, ct_feed_game_item, v) ? 1 : -1;
  }
  if (!strcmp(key, "packages")) { jp_ws(j); if (j->p >= j->end || *j->p != '[') return jp_skip(j) ? 1 : -1; t->has_packages = 1; return jp_array(j, ct_pkg_item, v) ? 1 : -1; }
  if (!strcmp(key, "ratings")) { jp_ws(j); return (j->p < j->end && *j->p == '{' ? jp_object(j, ct_rating_field, v) : jp_skip(j)) ? 1 : -1; }
  return 0;
}
// Le um feed inteiro (texto ja decifrado), chamando v->fn para cada jogo valido. 1 ok, 0 nao e um feed.
static int ct_visit_feed(CtFeedVisit* v, char* text, size_t size) {
  ct_stable_key(v->url, v->key);
  CtTop t = {v, 0, 0, 0};
  JP jp = {text, text + size, 0};
  const int ok = jp_object(&jp, ct_feed_top, &t);
  if (ok && !t.has_games && t.has_packages) {
    // byId: o primeiro de cada codigo; os seguintes somam links (sem repetir o endereco nem record|label).
    CtRawGame* games = calloc((size_t)v->npkgs + 1, sizeof *games);
    int* state = calloc((size_t)v->npkgs + 1, sizeof *state); // 1 primeiro do codigo, 2 juntado a outro
    char (*keys)[64] = calloc((size_t)v->npkgs + 1, sizeof *keys);
    if (!games || !state || !keys) abort();
    for (int i = 0; i < v->npkgs; ++i) {
      if (!ct_pkg_to_raw(&v->pkgs[i], &games[i])) continue;
      char* up = ct_lower_plain(ct_s(v->pkgs[i].title_id));
      snprintf(keys[i], sizeof keys[i], "%s", up);
      free(up);
      int known = -1;
      for (int k = 0; k < i && known < 0; ++k) if (state[k] == 1 && !strcmp(keys[k], keys[i])) known = k;
      if (known < 0) { state[i] = 1; continue; }
      state[i] = 2;
      CtRawGame* to = &games[known];
      const int had = to->rels.n;
      for (int r = 0; r < games[i].rels.n; ++r) {
        CtRel* x = &games[i].rels.v[r];
        int dup = 0;
        for (int q = 0; q < had && !dup; ++q) {
          if (!strcmp(ct_s(to->rels.v[q].url), ct_s(x->url))) dup = 1;
          else if (!strcmp(ct_s(to->rels.v[q].record), ct_s(x->record)) && !strcmp(ct_s(to->rels.v[q].label), ct_s(x->label))) dup = 1;
        }
        if (dup) continue;
        CtRel* y = ct_rels_push(&to->rels);
        *y = *x;
        memset(x, 0, sizeof *x);
      }
      if (!to->about.n) { CtStrList t2 = to->about; to->about = games[i].about; games[i].about = t2; }
    }
    for (int i = 0; i < v->npkgs; ++i) {
      if (state[i] == 1 && !v->stop && v->offered < 5000) {
        ++v->offered;
        if (games[i].rels.n > 64) { for (int r = 64; r < games[i].rels.n; ++r) ct_rel_free(&games[i].rels.v[r]); games[i].rels.n = 64; }
        if (v->releases < 20000) ct_feed_take(v, &games[i]);
      }
      ct_raw_game_free(&games[i]);
    }
    free(games); free(state); free(keys);
    t.version = 1;
    t.has_games = 1;
  }
  for (int i = 0; i < v->npkgs; ++i) ct_pkg_free(&v->pkgs[i]);
  ct_free(v->pkgs); v->pkgs = NULL; v->npkgs = v->cappkgs = 0;
  free(v->seen); v->seen = NULL; v->nseen = 0;
  return ok && t.version == 1 && t.has_games;
}

// ---- O catalogo embutido (index.json, formats.js, ratings.js) ----------------------------------------------------
static const char* const CT_NAMED[6] = {"platform", "providers", "developer", "publisher", "genres", "features"};
static uint32_t ct_hash_id(const char* s) { uint32_t h = 2166136261u; for (; *s; ++s) h = (h ^ (unsigned char)*s) * 16777619u; return h; }
static void ct_hash_put(Catalog* c, CtGame* g) {
  if (!c->hcap) { c->hcap = 16384; c->hash = ct_calloc(c->hcap, sizeof *c->hash); }
  for (size_t i = ct_hash_id(g->id) & (c->hcap - 1);; i = (i + 1) & (c->hcap - 1))
    if (!c->hash[i] || !strcmp(c->hash[i]->id, g->id)) { c->hash[i] = g; return; } // um id repetido: vale o ultimo (o Map do app)
}
static CtGame* ct_find_game(const Catalog* c, const char* id) {
  if (!c->hcap || !id) return NULL;
  for (size_t i = ct_hash_id(id) & (c->hcap - 1); c->hash[i]; i = (i + 1) & (c->hcap - 1)) if (!strcmp(c->hash[i]->id, id)) return c->hash[i];
  return NULL;
}
static CtGame* ct_new_game(Catalog* c, const char* id) {
  CtGame* g = ct_calloc(1, sizeof *g);
  snprintf(g->id, sizeof g->id, "%s", id);
  g->work = -1; g->page_feed = -1; g->lazy[0] = -1;
  if (c->count == c->cap) { c->cap = c->cap ? c->cap * 2 : 4096; c->all = ct_realloc(c->all, sizeof *c->all * (size_t)c->cap); }
  c->all[c->count++] = g;
  return g;
}
static void ct_game_free(CtGame* g) {
  char* s[] = {g->title, g->sort_title, g->dev, g->pub, g->cover, g->tint, g->search, g->fold, g->keys[0], g->keys[1], g->keys[2]};
  for (size_t i = 0; i < sizeof s / sizeof *s; ++i) ct_free(s[i]);
  ct_free(g->genres.v); ct_free(g->features.v); ct_free(g->providers.v);
  for (int i = 0; i < g->nrels; ++i) ct_rel_free(&g->rels[i]);
  ct_free(g->rels);
  ct_free(g);
}
static void ct_genres_into(Catalog* c, CtIds* into, const char* genre) { // split(" / ") + SYNONYMS
  static const char* const SYN[][2] = {{"Role Playing Game (RPG)", "RPG"}, {"Role Playing Games", "RPG"}, {"Role-playing", "RPG"}, {"Simulator", "Simulation"}, {"Driving/Racing", "Racing"}};
  const char* p = genre;
  for (;;) {
    const char* sep = strstr(p, " / ");
    size_t len = sep ? (size_t)(sep - p) : strlen(p);
    char part[256]; if (len >= sizeof part) len = sizeof part - 1;
    memcpy(part, p, len); part[len] = 0;
    const char* name = part;
    for (size_t i = 0; i < sizeof SYN / sizeof *SYN; ++i) if (!strcmp(part, SYN[i][0])) name = SYN[i][1];
    ct_ids_add(into, ct_intern(&c->genres, name));
    if (!sep) break;
    p = sep + 3;
  }
}
typedef struct { Catalog* c; int twin; CtGame* g; int which, lazy_at; } CtIndexRead;
static int ct_names_item(JP* j, void* ctx) { CtNames* t = ctx; char* s; if (!ct_str(j, &s)) return 0; if (t->n == t->cap) { t->cap = t->cap ? t->cap * 2 : 64; t->v = ct_realloc(t->v, sizeof *t->v * (size_t)t->cap); } t->v[t->n++] = s ? s : ct_dup(""); return 1; }
static int ct_names_field(JP* j, const char* key, void* ctx) {
  Catalog* c = ctx;
  for (int i = 0; i < 6; ++i) if (!strcmp(key, CT_NAMED[i])) return jp_array(j, ct_names_item, &c->raw_names[i]) ? 1 : -1;
  return 0;
}
static int ct_index_place(JP* j, void* ctx) {
  CtIndexRead* r = ctx;
  double v; int has;
  if (!ct_num(j, &v, &has)) return 0;
  if (r->which == 7) { if (r->lazy_at < 3) r->g->lazy[r->lazy_at] = has ? (int)v : -1; ++r->lazy_at; return 1; }
  if (!has || v < 0 || (int)v >= r->c->raw_names[r->which].n) return 1;
  const char* name = r->c->raw_names[r->which].v[(int)v];
  if (r->which == 1) ct_ids_add(&r->g->providers, ct_intern(&r->c->providers, name));
  else if (r->which == 4) ct_genres_into(r->c, &r->g->genres, name);
  else if (r->which == 5) ct_ids_add(&r->g->features, ct_intern(&r->c->features, name));
  return 1;
}
static int ct_index_art(JP* j, const char* key, void* ctx) {
  CtIndexRead* r = ctx;
  if (!strcmp(key, "cover")) { ct_free(r->g->cover); return ct_str(j, &r->g->cover) ? 1 : -1; }
  if (!strcmp(key, "tint")) { ct_free(r->g->tint); return ct_str(j, &r->g->tint) ? 1 : -1; }
  if (!strcmp(key, "lazy")) { r->which = 7; r->lazy_at = 0; return jp_array(j, ct_index_place, r) ? 1 : -1; }
  if (!strcmp(key, "hero")) { r->g->hero = 1; return 0; }
  if (!strcmp(key, "logo")) { r->g->logo = 1; return 0; }
  return 0;
}
static int ct_index_game_field(JP* j, const char* key, void* ctx) {
  CtIndexRead* r = ctx;
  CtGame* g = r->g;
  char* s;
  double v; int has;
  if (!strcmp(key, "id")) { if (!ct_str(j, &s)) return -1; snprintf(g->id, sizeof g->id, "%s", s ? s : ""); ct_free(s); return 1; }
  if (!strcmp(key, "title")) { ct_free(g->title); return ct_str(j, &g->title) ? 1 : -1; }
  if (!strcmp(key, "releaseDate")) { if (!ct_str(j, &s)) return -1; snprintf(g->release, sizeof g->release, "%s", s ? s : ""); ct_free(s); return 1; }
  if (!strcmp(key, "platform") || !strcmp(key, "developer") || !strcmp(key, "publisher")) {
    if (!ct_num(j, &v, &has)) return -1;
    const int which = key[0] == 'p' && key[1] == 'l' ? 0 : key[0] == 'd' ? 2 : 3;
    const char* name = has && v >= 0 && (int)v < r->c->raw_names[which].n ? r->c->raw_names[which].v[(int)v] : "";
    if (which == 0) g->platform = !strcmp(name, "ps4") ? 1 : 0;
    else if (which == 2) { ct_free(g->dev); g->dev = ct_dup(name); }
    else { ct_free(g->pub); g->pub = ct_dup(name); }
    return 1;
  }
  if (!strcmp(key, "providers")) { r->which = 1; return jp_array(j, ct_index_place, r) ? 1 : -1; }
  if (!strcmp(key, "genres")) { r->which = 4; return jp_array(j, ct_index_place, r) ? 1 : -1; }
  if (!strcmp(key, "features")) { r->which = 5; return jp_array(j, ct_index_place, r) ? 1 : -1; }
  if (!strcmp(key, "year")) { if (!ct_num(j, &v, &has)) return -1; g->has_year = (uint8_t)has; g->year = (int)v; return 1; }
  if (!strcmp(key, "metacritic")) { if (!ct_num(j, &v, &has)) return -1; g->has_meta = (uint8_t)has; g->metacritic = (int)v; return 1; }
  if (!strcmp(key, "recommendations")) { if (!ct_num(j, &g->rec, &has)) return -1; g->has_rec = (uint8_t)has; return 1; }
  if (!strcmp(key, "sizeGb")) { if (!ct_num(j, &g->size_gb, &has)) return -1; g->has_size = (uint8_t)has; return 1; }
  if (!strcmp(key, "work")) { if (!ct_num(j, &v, &has)) return -1; g->work = has && v > 0 ? (int)v : -1; return 1; } // work 0 e falso
  if (!strcmp(key, "direct")) { int b = 0; jp_ws(j); if (!jp_bool(j, &b)) return jp_skip(j) ? 1 : -1; g->direct = (uint8_t)b; return 1; }
  if (!strcmp(key, "art")) { jp_ws(j); return (j->p < j->end && *j->p == '{' ? jp_object(j, ct_index_art, r) : jp_skip(j)) ? 1 : -1; }
  return 0;
}
static int ct_index_game(JP* j, void* ctx) {
  CtIndexRead* r = ctx;
  CtGame* g = ct_new_game(r->c, "");
  g->listed = (uint8_t)!r->twin;
  g->sources = 1;
  r->g = g;
  if (!jp_object(j, ct_index_game_field, r)) return 0;
  if (g->lazy[0] >= 0 && g->lazy[2] > 0) { g->hero |= (uint8_t)(g->lazy[2] & 1); g->logo |= (uint8_t)((g->lazy[2] >> 1) & 1); }
  return 1;
}
static int ct_feature_item(JP* j, void* ctx) {
  Catalog* c = ctx;
  char* s;
  if (!ct_str(j, &s)) return 0;
  c->feature_order = ct_realloc(c->feature_order, sizeof(int) * (size_t)(c->nfeature_order + 1));
  c->feature_order[c->nfeature_order++] = ct_intern(&c->features, s ? s : "");
  ct_free(s);
  return 1;
}
typedef struct { Catalog* c; int version; } CtIndexTop;
static int ct_index_top(JP* j, const char* key, void* ctx) {
  CtIndexTop* t = ctx;
  Catalog* c = t->c;
  CtIndexRead r;
  memset(&r, 0, sizeof r);
  r.c = c;
  if (!strcmp(key, "version")) { double v; int has; if (!ct_num(j, &v, &has)) return -1; t->version = has ? (int)v : 0; return 1; }
  if (!strcmp(key, "names")) return jp_object(j, ct_names_field, c) ? 1 : -1;
  if (!strcmp(key, "features")) return jp_array(j, ct_feature_item, c) ? 1 : -1;
  if (!strcmp(key, "games")) return jp_array(j, ct_index_game, &r) ? 1 : -1;
  if (!strcmp(key, "twins")) { r.twin = 1; return jp_array(j, ct_index_game, &r) ? 1 : -1; }
  return 0;
}
// data/formats.js e data/ratings.js: o objeto literal (JSON valido) depois do primeiro "{".
typedef struct { Catalog* c; int ratings; } CtTable;
static int ct_table_field(JP* j, const char* key, void* ctx) {
  CtTable* t = ctx;
  CtGame* g = ct_find_game(t->c, key);
  if (!t->ratings) {
    char* s;
    if (!ct_str(j, &s)) return -1;
    if (g && s) for (char* save = NULL, *w = strtok_r(s, " ", &save); w; w = strtok_r(NULL, " ", &save)) for (int k = 0; k < CT_KINDS; ++k) if (!strcmp(w, CT_KIND[k])) g->bundled_formats |= (uint16_t)(1u << k);
    ct_free(s);
    return 1;
  }
  CtPair r = {{0, 0}, 0, 0};
  if (!jp_array(j, ct_pair_item, &r)) return -1;
  if (g && r.npair >= 2 && !r.bad) { g->has_b = 1; g->b_stars = r.pair[0]; g->b_count = (uint32_t)r.pair[1]; }
  return 1;
}
static int ct_read_table(Catalog* c, const char* path, int ratings) {
  size_t size;
  char* text = ct_read_file(path, &size, 16u << 20);
  if (!text) return 0;
  char* open = strchr(text, '{');
  CtTable t = {c, ratings};
  JP jp = {open ? open : text, text + size, 0};
  const int ok = open && jp_object(&jp, ct_table_field, &t);
  ct_free(text);
  return ok;
}
