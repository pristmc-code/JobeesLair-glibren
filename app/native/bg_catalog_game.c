// Fase 3: a ficha de um jogo (os links como game.releases os da: releaseSets + releaseType sobre os do pacote embutido e os
// dos feeds; a pagina do pacote ou do feed; a arte dos arquivos art/) e a ordem e o tipo dos links (game/sources.js), que
// a loja do celular usa. Parte do bg_catalog.c.

// ---- Pacotes de dados (state/data-pack.js): o indice conferido e um item lido por deslocamento -------------------------
// O item `id` de data/packs/<name>.pack (texto em malloc comum), ou NULL.
static char* ct_pack_item(const char* dir, const char* name, const char* id, size_t* length) {
  char path[800];
  snprintf(path, sizeof path, "%s/packs/%s.idx", dir, name);
  size_t size = 0;
  char* idx = read_text(path, 4u << 20, &size);
  if (!idx) return NULL;
  char header[96];
  const char* nl = strchr(idx, '\n');
  const size_t hl = nl ? (size_t)(nl - idx) : 0;
  char* found = NULL;
  uint64_t off = 0, len = 0, next = 0, count = 0, items = 0, total = 0;
  int ok = nl && hl < sizeof header && size && idx[size - 1] == '\n';
  if (ok) {
    memcpy(header, idx, hl); header[hl] = 0;
    char hname[32];
    unsigned long long a = 0, b = 0;
    ok = sscanf(header, "JPK1 %31s %llu %llu", hname, &a, &b) == 3 && !strcmp(hname, name);
    items = a; total = b;
  }
  // cada linha "<item> <inicio> <tamanho>", contiguas, somando o total (checkIndex)
  for (const char* p = nl ? nl + 1 : idx; ok && p < idx + size;) {
    const char* e = strchr(p, '\n');
    if (!e) { ok = 0; break; }
    const char* sp1 = memchr(p, ' ', (size_t)(e - p));
    unsigned long long o2 = 0, l2 = 0;
    if (!sp1 || sscanf(sp1 + 1, "%llu %llu", &o2, &l2) != 2 || o2 != next) { ok = 0; break; }
    if ((size_t)(sp1 - p) == strlen(id) && !strncmp(p, id, (size_t)(sp1 - p))) { found = (char*)p; off = o2; len = l2; }
    next += l2;
    ++count;
    p = e + 1;
  }
  free(idx);
  if (!ok || count != items || next != total || !found) return NULL;
  snprintf(path, sizeof path, "%s/packs/%s.pack", dir, name);
  struct stat st;
  if (stat(path, &st) || (uint64_t)st.st_size != total || len > (64u << 20)) return NULL;
  int fd = open(path, O_RDONLY);
  if (fd < 0) return NULL;
  char* text = malloc((size_t)len + 1);
  size_t got = 0;
  while (text && got < len) {
    const ssize_t n = pread(fd, text + got, (size_t)(len - got), (off_t)(off + got));
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    got += (size_t)n;
  }
  close(fd);
  if (!text || got != len) { free(text); return NULL; }
  text[len] = 0;
  *length = (size_t)len;
  return text;
}

// ---- A ficha -----------------------------------------------------------------------------------------------------
typedef struct {
  CtRels rels;              // os links na ordem do app: os do pacote, depois os dos feeds (memoria contada)
  CtStrList about, shots, videos, fallbacks;
  char *summary, *hero, *logo, *logo_dark, *page_hero;
  double logo_aspect; int has_logo_aspect;
  int page_found, cut;
} CtDetail;
static void ct_detail_free(CtDetail* d) {
  ct_rels_free(&d->rels);
  ct_strlist_free(&d->about); ct_strlist_free(&d->shots); ct_strlist_free(&d->videos); ct_strlist_free(&d->fallbacks);
  ct_free(d->summary); ct_free(d->hero); ct_free(d->logo); ct_free(d->logo_dark); ct_free(d->page_hero);
  memset(d, 0, sizeof *d);
}
static int ct_page_field(JP* j, const char* key, void* ctx) {
  CtDetail* d = ctx;
  if (!strcmp(key, "about")) { ct_strlist_free(&d->about); return jp_array(j, ct_strlist_item, &d->about) ? 1 : -1; }
  if (!strcmp(key, "shots")) { ct_strlist_free(&d->shots); return jp_array(j, ct_strlist_item, &d->shots) ? 1 : -1; }
  if (!strcmp(key, "videos")) { ct_strlist_free(&d->videos); return jp_array(j, ct_strlist_item, &d->videos) ? 1 : -1; }
  if (!strcmp(key, "summary")) { ct_free(d->summary); return ct_str(j, &d->summary) ? 1 : -1; }
  return 0;
}
// A arte de um jogo embutido: art/<arquivo>.json, a posicao dele.
typedef struct { CtDetail* d; int want, at; } CtArtRead;
static int ct_art_obj(JP* j, const char* key, void* ctx) {
  CtDetail* d = ctx;
  if (!strcmp(key, "hero")) { ct_free(d->hero); return ct_str(j, &d->hero) ? 1 : -1; }
  if (!strcmp(key, "logo")) { ct_free(d->logo); return ct_str(j, &d->logo) ? 1 : -1; }
  if (!strcmp(key, "logoDark")) { ct_free(d->logo_dark); return ct_str(j, &d->logo_dark) ? 1 : -1; }
  if (!strcmp(key, "logoAspect")) return ct_num(j, &d->logo_aspect, &d->has_logo_aspect) ? 1 : -1;
  if (!strcmp(key, "coverFallbacks")) { ct_strlist_free(&d->fallbacks); return jp_array(j, ct_strlist_item, &d->fallbacks) ? 1 : -1; }
  return 0;
}
static int ct_art_item(JP* j, void* ctx) {
  CtArtRead* r = ctx;
  const int mine = r->at++ == r->want;
  jp_ws(j);
  if (!mine || j->p >= j->end || *j->p != '{') return jp_skip(j);
  return jp_object(j, ct_art_obj, r->d);
}
// O jogo `want` nos feeds: os links (somados na ordem dos feeds) e, do feed da pagina, a pagina e a arte.
typedef struct { const char* want; CtDetail* d; int page; int found; } CtFind;
static void ct_find_fn(CtFeedVisit* v, CtRawGame* raw, CtRel* rels, int nrels, const int* magnets, char (*hosts)[256]) {
  (void)magnets; (void)hosts;
  CtFind* f = v->ctx;
  if (strcmp(raw->id, f->want)) return;
  f->found = 1;
  v->stop = 1;
  for (int i = 0; i < nrels; ++i) { CtRel* r = ct_rels_push(&f->d->rels); *r = rels[i]; memset(&rels[i], 0, sizeof rels[i]); }
  if (!f->page) return;
  CtDetail* d = f->d;
  d->page_found = 1;
  for (int i = 0; i < raw->about.n && i < 20; ++i) { char* t = ct_text(raw->about.v[i], 4000); if (*t) ct_strlist_push(&d->about, t); else ct_free(t); }
  for (int i = 0; i < raw->shots.n && i < 12; ++i) if (ct_https_ok(raw->shots.v[i])) ct_strlist_push(&d->shots, ct_dup(raw->shots.v[i]));
  for (int i = 0; i < raw->videos.n && i < 6; ++i) { // youtubeId: so o id de 11 (ou um endereco do YouTube)
    const char* s = raw->videos.v[i];
    if (!s) continue;
    char id[12] = "";
    const char* at = strlen(s) == 11 ? s : NULL;
    if (!at) { const char* m = strstr(s, "v="); if (!m) m = strstr(s, "youtu.be/"), m = m ? m + 7 : NULL; if (!m) { m = strstr(s, "/shorts/"); if (m) m += 6; } if (m) at = m + 2; }
    if (!at) continue;
    int okid = 1; for (int k = 0; k < 11; ++k) { char ch = at[k]; if (!(ct_alnum((unsigned char)ch) || ch == '_' || ch == '-')) okid = 0; }
    if (!okid || (at != s && at[11] && strchr("?&#/", at[11]) == NULL)) continue;
    memcpy(id, at, 11); id[11] = 0;
    int dup = 0; for (int k = 0; k < d->videos.n; ++k) if (!strcmp(d->videos.v[k], id)) dup = 1;
    if (!dup) ct_strlist_push(&d->videos, ct_dup(id));
  }
  char* summary = ct_text(raw->summary, 600);
  if (*summary && d->about.n && !strncmp(d->about.v[0], summary, strlen(summary))) d->cut = 1; // o resumo e o comeco da descricao
  ct_free(d->summary); d->summary = summary;
  if (ct_https_ok(raw->hero)) d->page_hero = ct_dup(raw->hero);
  for (int i = 0; i < raw->fallbacks.n && d->fallbacks.n < 4; ++i) if (ct_https_ok(raw->fallbacks.v[i])) ct_strlist_push(&d->fallbacks, ct_cover_size(raw->fallbacks.v[i], 440));
}
// Le tudo da ficha de `g`. Os arquivos dos feeds sao lidos de novo (um por vez, so os que listam o jogo).
static void ct_detail(const Catalog* c, const CtGame* g, CtDetail* d, const char* const* feed_paths) {
  memset(d, 0, sizeof *d);
  size_t len = 0;
  char* text = ct_pack_item(c->bundled_dir, "releases", g->id, &len);
  if (text) {
    if (ct_jlx_decode(text, &len)) { JP jp = {text, text + len, 0}; if (!jp_array(&jp, ct_rel_item, &d->rels)) ct_rels_free(&d->rels); }
    free(text);
    for (int i = 0; i < d->rels.n; ++i) ct_rel_patch(&d->rels.v[i]);
  }
  if (!g->from_feed) {
    text = ct_pack_item(c->bundled_dir, "pages", g->id, &len);
    if (text) { JP jp = {text, text + len, 0}; jp_object(&jp, ct_page_field, d); free(text); d->page_found = 1; }
    if (g->lazy[0] >= 0) {
      char path[800];
      snprintf(path, sizeof path, "%s/catalog/art/%d.json", c->bundled_dir, g->lazy[0]);
      size_t size = 0;
      char* art = ct_read_file(path, &size, 8u << 20);
      if (art) { CtArtRead r = {d, g->lazy[1], 0}; JP jp = {art, art + size, 0}; jp_array(&jp, ct_art_item, &r); ct_free(art); }
      for (int i = 0; i < d->fallbacks.n; ++i) { char* s = ct_cover_size(d->fallbacks.v[i], c->cover_width); ct_free(d->fallbacks.v[i]); d->fallbacks.v[i] = s; }
    }
  }
  for (int f = 0; f < c->nfeeds; ++f) {
    if (!(g->sources & (2ull << f)) || !feed_paths[f]) continue;
    size_t size = 0;
    char* feed = ct_read_file(feed_paths[f], &size, 16u << 20);
    if (!feed) continue;
    if (ct_jlx_decode(feed, &size)) {
      CtFind find = {g->id, d, g->from_feed && g->page_feed == f, 0};
      CtFeedVisit v;
      memset(&v, 0, sizeof v);
      v.c = (Catalog*)c; v.fn = ct_find_fn; v.ctx = &find; v.url = c->feeds[f].url;
      ct_visit_feed(&v, feed, size);
      ct_free(v.name); ct_strlist_free(&v.mirrors);
    }
    ct_free(feed);
  }
  if (g->hero && !d->hero && d->page_hero) { d->hero = d->page_hero; d->page_hero = NULL; }
}
static const char* ct_release_platform(const CtGame* g) { return !strncasecmp(g->id, "PPSA", 4) ? "ps5" : !strncasecmp(g->id, "CUSA", 4) ? "ps4" : NULL; }
static void ct_rel_fields_json(Buf* out, const CtRel* r, int skip_links, const char* unavailable, const char* label) {
  static const char* const KEYS[CT_REL_FIELDS] = {"id", "format", "filename", "url", "browserUrl", "version", "category", "provider", "source", "flow", "label",
                                                  "record", "volume", "archivePassword", "unavailableReason", "platform", "health", "sha256"};
  int first = 1;
  for (int i = 0; i < CT_REL_FIELDS; ++i) {
    const char* v = *ct_rel_slot((CtRel*)r, i);
    if (i == 14 && unavailable) v = unavailable;
    if (i == 10 && label) v = label;
    if (!v) continue;
    if (skip_links && (i == 3 || i == 4 || i == 0 || i == 2 || i == 12 || i == 17 || i == 1)) continue; // o conjunto escreve os seus
    if (i == 15) continue; // platform: a do releaseType
    buf_fmt(out, "%s\"%s\":", first ? "" : ",", KEYS[i]);
    buf_json(out, v);
    first = 0;
  }
  buf_fmt(out, "%s\"requiresBrowser\":%s", first ? "" : ",", r->requires_browser ? "true" : "false");
  if (!skip_links) { buf_str(out, ",\"sizeBytes\":"); if (r->has_size) ct_num_json(out, r->size); else buf_str(out, "null"); }
}
// Um link como game.releases o tem (o de um feed com o tipo; o do pacote com o tipo tambem).
static void ct_release_json(Buf* out, const CtItem* t, const char* platform) {
  buf_str(out, "{");
  if (t->rel) {
    ct_rel_fields_json(out, t->rel, 0, t->invalid_volume ? "Invalid volume number." : NULL, NULL);
  } else {
    const CtRel* base = t->base;
    ct_rel_fields_json(out, base, 1, t->unavailable, t->label);
    buf_str(out, ",\"format\":\"archive-set\",\"sizeBytes\":null,\"id\":"); buf_json(out, t->id);
    buf_str(out, ",\"filename\":"); buf_json(out, t->id);
    if (!base->password && t->password) { buf_str(out, ",\"archivePassword\":"); buf_json(out, t->password); }
    buf_str(out, ",\"parts\":[");
    for (int p = 0; p < t->nparts; ++p) {
      buf_fmt(out, "%s{\"number\":%d,\"sources\":[{", p ? "," : "", t->parts[p].number);
      ct_rel_fields_json(out, t->parts[p].src, 0, NULL, NULL);
      if (t->parts[p].src->platform) { buf_str(out, ",\"platform\":"); buf_json(out, t->parts[p].src->platform); }
      buf_str(out, "}]}");
    }
    buf_str(out, "]");
  }
  const char* system = platform ? platform : t->rel ? t->rel->platform : t->base->platform;
  buf_fmt(out, ",\"dumpType\":\"%s\",\"imageFormat\":", t->dump >= 0 ? CT_DUMP[t->dump] : "unknown");
  if (t->dump == DT_IMAGE && t->kind >= 1 && t->kind <= 3) buf_fmt(out, "\"%s\"", CT_KIND[t->kind]); else buf_str(out, "null");
  buf_str(out, ",\"compatible1360\":");
  buf_str(out, t->dump == DT_FOLDER || t->dump == DT_IMAGE || t->dump == DT_BACKPORT ? "true" : t->dump == DT_FPKG && system && !strcmp(system, "ps5") ? "false" : "null");
  buf_str(out, ",\"platform\":"); ct_json_or_null(out, system);
  buf_str(out, "}");
}

// ---- game/sources.js: o tipo de cada link e a ordem em que a Jobe os oferece --------------------------------------------
enum { GR_DIRECT, GR_PAGE, GR_TORRENT, GR_BROWSER, GR_UNAVAILABLE };
static const char* const CT_GROUP[] = {"direct", "page", "torrent", "browser", "unavailable"};
static const CtRel* ct_item_first(const CtItem* t) { return t->rel ? t->rel : t->nparts ? t->parts[0].src : t->base; }
static const char* ct_item_unavailable(const CtItem* t) {
  if (t->rel) return t->invalid_volume ? "Invalid volume number." : t->rel->unavailable;
  return t->unavailable ? t->unavailable : t->base->unavailable;
}
static int ct_access(const CtItem* t) {
  const CtRel* f = ct_item_first(t);
  const int k = ct_source_kind(f->url, f->browser, f->requires_browser, f->source);
  if (k == SK_INVALID) return GR_BROWSER;
  if (k == SK_DIRECT) return GR_DIRECT;
  if (k == SK_TORRENT) return GR_TORRENT;
  if (k == SK_BROWSER || k == SK_DATANODES || k == SK_UNAVAILABLE || k == SK_VIKINGFILE || k == SK_BUZZHEAVIER) return GR_BROWSER;
  return GR_PAGE;
}
static int ct_group(const CtItem* t) { return ct_item_unavailable(t) ? GR_UNAVAILABLE : ct_access(t); }
static const char* ct_item_label(const CtItem* t) { return t->rel ? ct_s(t->rel->label) : ct_s(t->label); }
// /\bword\b/i com palavras ASCII.
static int ct_has_word(const char* s, const char* w) {
  const size_t k = strlen(w);
  for (const char* p = s; *p; ++p) {
    if (p > s && (ct_alnum((unsigned char)p[-1]) || p[-1] == '_')) continue;
    if (!strncasecmp(p, w, k) && !(ct_alnum((unsigned char)p[k]) || p[k] == '_')) return 1;
  }
  return 0;
}
static int ct_is_dlc(const char* label) { // /\bDLCs?\b/i e nada de "game", "full", "+ DLC", "with DLC", "incl"
  if (!ct_has_word(label, "dlc") && !ct_has_word(label, "dlcs")) return 0;
  if (ct_has_word(label, "game") || ct_has_word(label, "full")) return 0;
  for (const char* p = label; *p; ++p) {
    if (*p == '+') { const char* q = p + 1; while (ct_ws((unsigned char)*q)) ++q; if (!strncasecmp(q, "all", 3) && ct_ws((unsigned char)q[3])) { q += 3; while (ct_ws((unsigned char)*q)) ++q; } if (!strncasecmp(q, "dlc", 3) && !ct_alnum((unsigned char)q[(q[3] == 's' || q[3] == 'S') ? 4 : 3])) return 0; }
    if ((p == label || !(ct_alnum((unsigned char)p[-1]) || p[-1] == '_')) && !strncasecmp(p, "with", 4) && ct_ws((unsigned char)p[4])) {
      const char* q = p + 4; while (ct_ws((unsigned char)*q)) ++q;
      if (!strncasecmp(q, "all", 3) && ct_ws((unsigned char)q[3])) { q += 3; while (ct_ws((unsigned char)*q)) ++q; }
      if (!strncasecmp(q, "dlc", 3) && !ct_alnum((unsigned char)q[(q[3] == 's' || q[3] == 'S') ? 4 : 3])) return 0;
    }
    if ((p == label || !(ct_alnum((unsigned char)p[-1]) || p[-1] == '_')) && !strncasecmp(p, "incl", 4)) return 0;
  }
  return 1;
}
static int ct_is_backport(const char* label) { // /\bback\s*port\b/i
  for (const char* p = label; *p; ++p) {
    if (p > label && (ct_alnum((unsigned char)p[-1]) || p[-1] == '_')) continue;
    if (strncasecmp(p, "back", 4)) continue;
    const char* q = p + 4; while (ct_ws((unsigned char)*q)) ++q;
    if (!strncasecmp(q, "port", 4) && !(ct_alnum((unsigned char)q[4]) || q[4] == '_')) return 1;
  }
  return 0;
}
// capture-hosts.js hostStanding, so com as listas fixas (o historico de capturas e do app): 0 works, 1 hard, 2 unknown.
static int ct_standing(const CtItem* t) {
  const CtRel* f = ct_item_first(t);
  CtUrl u;
  if (!ct_weburl(f->browser && *f->browser ? f->browser : f->url, &u)) return 2;
  const char* host = !strncmp(u.host, "www.", 4) ? u.host + 4 : u.host;
  char name[260] = "";
  const char* last = strrchr(host, '.');
  if (last) { const char* prev = last; while (prev > host && prev[-1] != '.') --prev; snprintf(name, sizeof name, "%.*s", (int)(last - prev), prev); }
  else snprintf(name, sizeof name, "%s", host);
  if (!strcmp(name, "vik1ngfile")) snprintf(name, sizeof name, "vikingfile");
  static const char* const WORKS[] = {"filekeeper", "rootz", "vikingfile", "datanodes", "akirabox"};
  static const char* const HARD[] = {"datavaults", "buzzheavier", "1fichier", "gofile", "rapidgator", "filecrypt", "ranoz", "transfer", "mega", "urlvanish", "fileditchfiles", "tinyurl", "fuckingfast", "1024terabox"};
  for (size_t i = 0; i < sizeof WORKS / sizeof *WORKS; ++i) if (!strcmp(name, WORKS[i])) return 0;
  for (size_t i = 0; i < sizeof HARD / sizeof *HARD; ++i) if (!strcmp(name, HARD[i])) return 1;
  return 2;
}
typedef struct { int index; double rank[14]; } CtRanked;
static int g_ct_has_debrid; // activeService(): uma chave de TorBox/AllDebrid conhecida
static void ct_rank_item(const CtItem* t, int index, CtRanked* r) {
  const int group = ct_group(t);
  const double grank = group == GR_TORRENT && !g_ct_has_debrid ? GR_BROWSER + 0.5 : group;
  const int standing = ct_access(t) == GR_BROWSER ? ct_standing(t) : -1;
  const CtRel* base = t->rel ? t->rel : t->base;
  const char* label = ct_item_label(t);
  const char* format = t->rel ? ct_s(t->rel->format) : "archive-set";
  const char* provider = ct_s(base->provider);
  char* lowp = ct_lower_plain(provider);
  const int image = !strcmp(format, "exfat") || !strcmp(format, "ffpkg") || !strcmp(format, "ffpfs") || !strcmp(format, "ffpfsc");
  int cdn = 0;
  { const char* p = lowp; if (!strncmp(p, "overdrive", 9)) { p += 9; while (ct_ws((unsigned char)*p)) ++p; cdn = !strcmp(p, "cdn"); } }
  const int host_rank = cdn ? 0 : !strcmp(lowp, "archive.org") ? 1 : !strcmp(lowp, "mediafire") ? 2 : 3;
  free(lowp);
  const char* health = base->health;
  r->index = index;
  double* k = r->rank;
  k[0] = ct_is_dlc(label) || ct_is_backport(label);
  k[1] = ct_item_unavailable(t) ? 1 : 0;
  k[2] = 0; // linkHealth "dead": so o app sabe
  k[3] = grank == GR_BROWSER + 0.5; // group > browser && group < unavailable: so o torrent sem chave de debrid (3.5)
  k[4] = standing == 1;
  k[5] = 0; // "unreachable": so o app sabe
  k[6] = 0; // compatible1360 === false: ct_source_order preenche (precisa da plataforma do jogo)
  k[7] = image ? 0 : 1;
  k[8] = host_rank;
  k[9] = standing == 2;
  k[10] = grank;
  k[11] = health && !strcmp(health, "ok") ? 0 : health && !strcmp(health, "flaky") ? 2 : 1;
  k[12] = base->source && !strcmp(base->source, "orbit") ? 0 : 1;
  k[13] = base->requires_browser ? 1 : 0;
}
static int ct_ranked_cmp(const void* a, const void* b) {
  const CtRanked* x = a; const CtRanked* y = b;
  for (int i = 0; i < 14; ++i) if (x->rank[i] != y->rank[i]) return x->rank[i] < y->rank[i] ? -1 : 1;
  return x->index - y->index;
}
// sourceOrder(releases): os indices na ordem oferecida (compatible1360 === false: o fpkg de PS5, preenchido aqui).
static void ct_source_order(const CtItems* items, const char* platform, int* order) {
  CtRanked* r = malloc(sizeof *r * ((size_t)items->n + 1));
  if (!r) abort();
  for (int i = 0; i < items->n; ++i) {
    ct_rank_item(&items->v[i], i, &r[i]);
    const CtRel* base = items->v[i].rel ? items->v[i].rel : items->v[i].base;
    const char* system = platform ? platform : base->platform;
    r[i].rank[6] = items->v[i].dump == DT_FPKG && system && !strcmp(system, "ps5") ? 1 : 0;
  }
  qsort(r, (size_t)items->n, sizeof *r, ct_ranked_cmp);
  for (int i = 0; i < items->n; ++i) order[i] = r[i].index;
  free(r);
}
// store-export.js soloLink: o payload baixa sozinho (direto, publico, um arquivo, nem add-on nem backport).
static int ct_solo(const CtItem* t) {
  if (!t->rel || t->invalid_volume) return 0;
  const CtRel* r = t->rel;
  if (r->browser || r->requires_browser || r->unavailable) return 0;
  if (ct_is_dlc(ct_s(r->label)) || ct_is_backport(ct_s(r->label))) return 0;
  const char* u = ct_s(r->url);
  if (strncasecmp(u, "http://", 7) && strncasecmp(u, "https://", 8)) return 0;
  if (strlen(u) > 1000 || !r->filename || !*r->filename) return 0;
  for (const char* p = u; *p; ++p) if ((unsigned char)*p <= 0x20 || strchr("\"'<>\\`", *p)) return 0;
  return ct_source_kind(r->url, r->browser, r->requires_browser, r->source) == SK_DIRECT;
}

// summaryOf(game): o primeiro paragrafo de mais de 80 unidades que nao esta todo em maiusculas, senao o resumo.
static int ct_units(const char* s) { int n = 0; for (const char* p = s; *p; p += ct_utf8_len((unsigned char)*p)) n += ct_utf8_len((unsigned char)*p) == 4 ? 2 : 1; return n; }
static int ct_has_lower(const char* s) {
  for (const char* p = s; *p;) { int l; unsigned cp = ct_cp(p, &l); p += l; if ((cp >= 'a' && cp <= 'z') || (cp >= 0x80 && ct_lower_cp(cp) == cp && ct_is_cased(cp))) return 1; }
  return 0;
}
static const char* ct_summary_of(const CtDetail* d) {
  for (int i = 0; i < d->about.n; ++i) if (d->about.v[i] && ct_units(d->about.v[i]) > 80 && ct_has_lower(d->about.v[i])) return d->about.v[i];
  return NULL;
}
// A 2a fase da montagem (depois da troca, na thread que monta): o "solo" dos jogos pelos links do pacote embutido (os
// dos feeds ja contaram na montagem). Um jogo por vez, gravado com __atomic (os pedidos leem ao mesmo tempo).
typedef struct { char id[16]; uint64_t off; uint32_t len; } CtPackAt;
static int ct_pack_at_cmp(const void* a, const void* b) { return strcmp(((const CtPackAt*)a)->id, ((const CtPackAt*)b)->id); }
static void ct_solo_bundled(Catalog* c) {
  char path[800];
  snprintf(path, sizeof path, "%s/packs/releases.idx", c->bundled_dir);
  size_t size = 0;
  char* idx = read_text(path, 4u << 20, &size);
  CtPackAt* at = NULL;
  int n = 0, cap = 0;
  for (const char* p = idx ? strchr(idx, 10) : NULL; p && *++p;) {
    const char* e = strchr(p, 10);
    if (!e) break;
    char id[16]; unsigned long long o = 0, l = 0;
    if (sscanf(p, "%15s %llu %llu", id, &o, &l) == 3) {
      if (n == cap) { cap = cap ? cap * 2 : 2048; at = realloc(at, sizeof *at * (size_t)cap); if (!at) abort(); }
      snprintf(at[n].id, sizeof at[n].id, "%s", id); at[n].off = o; at[n].len = (uint32_t)l; ++n;
    }
    p = e;
  }
  free(idx);
  if (n) qsort(at, (size_t)n, sizeof *at, ct_pack_at_cmp);
  snprintf(path, sizeof path, "%s/packs/releases.pack", c->bundled_dir);
  const int fd = n ? open(path, O_RDONLY) : -1;
  for (int i = 0; i < c->count && !g_stop; ++i) {
    const CtGame* g = c->all[i];
    if (__atomic_load_n(&c->solo[i], __ATOMIC_RELAXED) == 1) continue;
    uint8_t solo = 0;
    CtPackAt key;
    memset(&key, 0, sizeof key);
    snprintf(key.id, sizeof key.id, "%s", g->id);
    const CtPackAt* hit = fd >= 0 ? bsearch(&key, at, (size_t)n, sizeof *at, ct_pack_at_cmp) : NULL;
    if (hit && hit->len < (16u << 20)) {
      char* text = malloc((size_t)hit->len + 1);
      size_t got = 0;
      while (text && got < hit->len) { const ssize_t r = pread(fd, text + got, hit->len - got, (off_t)(hit->off + got)); if (r < 0 && errno == EINTR) continue; if (r <= 0) break; got += (size_t)r; }
      if (text && got == hit->len) {
        text[got] = 0;
        size_t len = got;
        CtRels rels;
        memset(&rels, 0, sizeof rels);
        if (ct_jlx_decode(text, &len)) { JP jp = {text, text + len, 0}; if (jp_array(&jp, ct_rel_item, &rels)) { for (int k = 0; k < rels.n; ++k) ct_rel_patch(&rels.v[k]); ct_kinds_of(rels.v, rels.n, &solo); } }
        ct_rels_free(&rels);
      }
      free(text);
    }
    __atomic_store_n(&c->solo[i], solo ? (uint8_t)1 : (uint8_t)0, __ATOMIC_RELAXED);
  }
  if (fd >= 0) close(fd);
  free(at);
  __atomic_store_n(&c->solo_done, 1, __ATOMIC_RELAXED);
}

// GET /api/catalog/game?id=: a ficha inteira (o que game/index.jsx le).
static void ct_game(const Catalog* c, const char* query, const char* const* feed_paths, Buf* out) {
  CtQuery q;
  ct_query_parse(query, &q);
  const CtGame* g = ct_find_game(c, q.id);
  if (!g) { buf_str(out, "{\"ok\":false,\"error\":\"not-found\"}"); ct_query_free(&q); return; }
  CtDetail d;
  ct_detail(c, g, &d, feed_paths);
  CtItems items;
  ct_release_sets(d.rels.v, d.rels.n, &items);
  const char* platform = ct_release_platform(g);
  buf_str(out, "{\"ok\":true,\"game\":");
  ct_card(out, c, g);
  out->size--; // reabre a carta
  buf_str(out, ",\"developer\":"); buf_json(out, g->dev);
  buf_str(out, ",\"publisher\":"); buf_json(out, g->pub);
  buf_str(out, ",\"features\":[");
  for (int k = 0; k < g->features.n; ++k) { if (k) buf_str(out, ","); buf_json(out, c->features.v[g->features.v[k]]); }
  buf_str(out, "],\"providers\":[");
  for (int k = 0; k < g->providers.n; ++k) { if (k) buf_str(out, ","); buf_json(out, c->providers.v[g->providers.v[k]]); }
  buf_str(out, "],\"recommendations\":"); if (g->has_rec) ct_num_json(out, g->rec); else buf_str(out, "null");
  buf_str(out, ",\"metacritic\":"); if (g->has_meta) buf_fmt(out, "%d", g->metacritic); else buf_str(out, "null");
  buf_str(out, ",\"work\":"); if (g->work >= 0) buf_fmt(out, "%d", g->work); else buf_str(out, "null");
  buf_str(out, ",\"addedAt\":"); ct_json_or_null(out, g->added[0] ? g->added : NULL);
  buf_fmt(out, ",\"listed\":%s,\"shown\":%s,\"fromFeed\":%s,\"sources\":[", g->listed ? "true" : "false", g->shown ? "true" : "false", g->from_feed ? "true" : "false");
  int m = 0;
  if (g->sources & 1) { buf_str(out, "\"bundled\""); ++m; }
  for (int f = 0; f < c->nfeeds; ++f) if (g->sources & (2ull << f)) { if (m++) buf_str(out, ","); buf_json(out, c->feeds[f].url); }
  buf_str(out, "]}");
  // a pagina: about, shots, resumo (pageSummary), videos e o summaryOf
  buf_str(out, ",\"page\":{\"about\":[");
  for (int i = 0; i < d.about.n; ++i) { if (i) buf_str(out, ","); buf_json(out, ct_s(d.about.v[i])); }
  buf_str(out, "],\"shots\":[");
  for (int i = 0, k = 0; i < d.shots.n; ++i) if (d.shots.v[i]) { if (k++) buf_str(out, ","); buf_json(out, d.shots.v[i]); }
  buf_str(out, "],\"summary\":"); buf_json(out, ct_s(d.summary));
  buf_str(out, ",\"videos\":[");
  for (int i = 0, k = 0; i < d.videos.n; ++i) if (d.videos.v[i]) { if (k++) buf_str(out, ","); buf_json(out, d.videos.v[i]); }
  buf_str(out, "]},\"summary\":");
  const char* sum = ct_summary_of(&d);
  buf_json(out, sum ? sum : ct_s(d.summary));
  buf_str(out, ",\"art\":{\"cover\":"); buf_json(out, ct_s(g->cover));
  if (g->tint) { buf_str(out, ",\"tint\":"); buf_json(out, g->tint); }
  if (d.hero) { buf_str(out, ",\"hero\":"); buf_json(out, d.hero); }
  if (d.logo) { buf_str(out, ",\"logo\":"); buf_json(out, d.logo); }
  if (d.has_logo_aspect) { buf_str(out, ",\"logoAspect\":"); ct_num_json(out, d.logo_aspect); }
  if (d.logo_dark) { buf_str(out, ",\"logoDark\":"); buf_json(out, d.logo_dark); }
  if (d.fallbacks.n) { buf_str(out, ",\"coverFallbacks\":["); for (int i = 0, k = 0; i < d.fallbacks.n; ++i) if (d.fallbacks.v[i]) { if (k++) buf_str(out, ","); buf_json(out, d.fallbacks.v[i]); } buf_str(out, "]"); }
  buf_str(out, "},\"releases\":[");
  for (int i = 0; i < items.n; ++i) { if (i) buf_str(out, ","); ct_release_json(out, &items.v[i], platform); }
  buf_str(out, "],\"order\":[");
  int* order = malloc(sizeof(int) * ((size_t)items.n + 1));
  if (!order) abort();
  ct_source_order(&items, platform, order);
  for (int i = 0; i < items.n; ++i) buf_fmt(out, "%s%d", i ? "," : "", order[i]);
  free(order);
  // editionsOf: a obra inteira, PS5 antes, listados antes, por codigo
  buf_str(out, "],\"editions\":[");
  CtGame* eds[64]; int ne = 0;
  if (g->work >= 0) { for (int i = 0; i < c->count && ne < 64; ++i) if (c->all[i]->work == g->work) eds[ne++] = c->all[i]; }
  else eds[ne++] = (CtGame*)g;
  for (int a = 1; a < ne; ++a) for (int b = a; b > 0; --b) {
    const CtGame* x = eds[b - 1]; const CtGame* y = eds[b];
    int d1 = (int)x->platform - (int)y->platform; // b.platform.localeCompare(a.platform): ps5 (0) antes de ps4 (1)
    if (!d1) d1 = (int)y->listed - (int)x->listed;
    if (!d1) d1 = strcmp(x->id, y->id);
    if (d1 <= 0) break;
    CtGame* t = eds[b]; eds[b] = eds[b - 1]; eds[b - 1] = t;
  }
  for (int i = 0; i < ne; ++i) { buf_fmt(out, "%s{\"id\":", i ? "," : ""); buf_json(out, eds[i]->id); buf_fmt(out, ",\"platform\":\"%s\",\"listed\":%s}", eds[i]->platform ? "ps4" : "ps5", eds[i]->listed ? "true" : "false"); }
  buf_str(out, "],\"related\":");
  const CtGame* best[6]; int shared[6];
  const int nr = ct_related_list(c, g, 6, best, shared);
  ct_cards(out, c, (CtGame* const*)best, nr);
  buf_str(out, "}");
  ct_items_free(&items);
  ct_detail_free(&d);
  ct_query_free(&q);
}
