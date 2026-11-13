// Fase 3 (PROTOTIPO A, 13/11/2026): o catalogo da loja montado no payload, em C, a partir dos mesmos arquivos que o app
// le: o catalogo embutido (data/catalog/index.json, data/formats.js, data/ratings.js), o catalogo ao vivo (live.jlx, JLX1)
// e a lista Orbit (orbit-store.json, o feed que bg_orbit.c grava). Incluido depois de bg_store.c (usa JP, Buf, buf_json).
//
// Regras copiadas do app (cada bloco diz de onde):
//   feed-format.js  game()/release(): o que vale de cada jogo e link de um feed (text(), webURL, magnet, hostName...)
//   download-sources.js sourceKind(): "direct"
//   release-sets.js releaseSets() + releaseType() e formats.js gameFormats(): os formatos de um jogo de feed
//   catalog.js      buildSteps (juncao, generos, formatos, notas, edicoes), SORTS, FACETS, passes, matching, oneEach
//   browse/Catalog.jsx gridOf: a grade (sem filtro = o catalogo inteiro; uma carta por jogo sem plataforma nem busca)
// O ponto critico, a ordem: o localeCompare do QuickJS-ng 0.15 (o motor do ps5-react) e NFC + comparar code points
// (quickjs.c js_string_localeCompare), e o sort do QuickJS e estavel. Em UTF-8, strcmp ja compara por code point; o NFC
// so mudaria um texto com marcas combinantes (nenhum no catalogo de 13/11: ct_nfc_risk conta). Cada ordem e calculada uma
// vez na montagem (rank); uma consulta filtra e ordena pelo rank (o subconjunto de um sort estavel e o sort estavel dele).
//
// GET /api/catalog?page=&per=&sort=relevance|newest|rating|size|title&q=&platform=&format=&access=&genre=&feature=
//     &release=&size=&provider=   (valores separados por virgula)
//   -> {ok, total, page, per, sort, games:[{id, title, platform, formats, direct, sizeGb, stars, ratingCount, cover}]}

#include <math.h>

#define CT_KINDS 7
static const char* const CT_KIND[CT_KINDS] = {"folder", "exfat", "ffpkg", "ffpfs", "image", "backport", "fpkg"};
#define CT_READY_MASK 0x1fu // folder, exfat, ffpkg, ffpfs, image (formats.js READY)
enum { CT_RELEVANCE, CT_NEWEST, CT_RATING, CT_SIZE, CT_TITLE, CT_SORTS };
static const char* const CT_SORT_KEYS[CT_SORTS] = {"relevance", "newest", "rating", "size", "title"};
enum { CF_PLATFORM, CF_FORMAT, CF_ACCESS, CF_GENRE, CF_FEATURE, CF_RELEASE, CF_SIZE, CF_PROVIDER, CF_COUNT };
static const char* const CT_FACET_KEYS[CF_COUNT] = {"platform", "format", "access", "genre", "feature", "release", "size", "provider"};
static const int CT_FACET_ANY[CF_COUNT] = {1, 1, 0, 0, 0, 1, 1, 1};

typedef struct { char** v; int n, cap; } CtNames; // textos unicos (generos, recursos, sites)
typedef struct { uint16_t* v; uint8_t n, cap; } CtIds;
typedef struct {
  char *url, *browser, *filename, *volume, *format, *label, *record, *provider;
  uint8_t patch;
} CtRel; // um link de feed, so o que os formatos leem
typedef struct {
  char id[10], release[11];
  char *title, *dev, *pub, *cover, *search, *keys[3];
  uint8_t platform, direct, listed, nkeys, has_size, has_year, has_meta, has_rec, from_feed;
  uint16_t formats, bundled_formats;
  double size_gb, stars, rec, b_stars;
  uint32_t rating_count, b_count; // b_*: a nota de data/ratings.js
  uint8_t has_b;
  int year, metacritic, work;
  CtIds genres, features, providers;
  CtRel* rels; int nrels, caprels; // os links dos feeds (so durante a montagem)
  uint32_t rank[CT_SORTS];
} CtGame;
typedef struct {
  CtGame** all; int count, cap;   // entries: os listados (games) e as outras edicoes (twins)
  CtGame** listed; int nlisted;   // a grade, na ordem do app
  CtGame** by_rank[CT_SORTS];
  CtNames genres, features, providers, raw_names[6];
  int* feature_order; int nfeature_order; // index.features (na ordem do indice)
  char** format_opts; int nformat_opts;
  int* provider_opts; int nprovider_opts;
  int* genre_opts; int ngenre_opts;
  int nfc_risk;
  double build_ms;
} Catalog;
static Catalog g_ct;

static char* ct_dup(const char* s) { char* d = strdup(s ? s : ""); if (!d) abort(); return d; }
static int ct_intern(CtNames* t, const char* s) {
  for (int i = 0; i < t->n; ++i) if (!strcmp(t->v[i], s)) return i;
  if (t->n == t->cap) { t->cap = t->cap ? t->cap * 2 : 32; t->v = realloc(t->v, sizeof *t->v * (size_t)t->cap); if (!t->v) abort(); }
  t->v[t->n] = ct_dup(s);
  return t->n++;
}
static int ct_find(const CtNames* t, const char* s) { for (int i = 0; i < t->n; ++i) if (!strcmp(t->v[i], s)) return i; return -1; }
static int ct_ids_has(const CtIds* l, int id) { for (int i = 0; i < l->n; ++i) if (l->v[i] == id) return 1; return 0; }
static void ct_ids_add(CtIds* l, int id) { // sem repetir, na ordem (o new Set do app)
  if (id < 0 || ct_ids_has(l, id) || l->n == 255) return;
  if (l->n == l->cap) { l->cap = l->cap ? (uint8_t)(l->cap * 2 > 255 ? 255 : l->cap * 2) : 4; l->v = realloc(l->v, sizeof *l->v * l->cap); if (!l->v) abort(); }
  l->v[l->n++] = (uint16_t)id;
}

// ---- Texto como o JS ve ----------------------------------------------------------------------------------
static int ct_utf8_len(unsigned char c) { return c < 0x80 ? 1 : c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1; }
static unsigned ct_cp(const char* s, int* len) {
  const unsigned char* p = (const unsigned char*)s;
  *len = ct_utf8_len(p[0]);
  if (*len == 1) return p[0];
  if (*len == 2) return ((p[0] & 31u) << 6) | (p[1] & 63u);
  if (*len == 3) return ((p[0] & 15u) << 12) | ((p[1] & 63u) << 6) | (p[2] & 63u);
  return ((p[0] & 7u) << 18) | ((p[1] & 63u) << 12) | ((p[2] & 63u) << 6) | (p[3] & 63u);
}
static int ct_put(char* out, unsigned cp) {
  if (cp < 0x80) { out[0] = (char)cp; return 1; }
  if (cp < 0x800) { out[0] = (char)(0xc0 | (cp >> 6)); out[1] = (char)(0x80 | (cp & 63)); return 2; }
  if (cp < 0x10000) { out[0] = (char)(0xe0 | (cp >> 12)); out[1] = (char)(0x80 | ((cp >> 6) & 63)); out[2] = (char)(0x80 | (cp & 63)); return 3; }
  out[0] = (char)(0xf0 | (cp >> 18)); out[1] = (char)(0x80 | ((cp >> 12) & 63)); out[2] = (char)(0x80 | ((cp >> 6) & 63)); out[3] = (char)(0x80 | (cp & 63)); return 4;
}
// O espaco do trim() do JS (WhiteSpace + LineTerminator).
static int ct_js_space(unsigned cp) {
  return cp == 9 || cp == 10 || cp == 11 || cp == 12 || cp == 13 || cp == 32 || cp == 0xa0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200a) ||
         cp == 0x2028 || cp == 0x2029 || cp == 0x202f || cp == 0x205f || cp == 0x3000 || cp == 0xfeff;
}
// feed-format.js text(value, max): controles viram um espaco, trim, e no maximo `max` unidades UTF-16. Em `out` (malloc).
static char* ct_text(const char* in, int max) {
  if (!in) return ct_dup("");
  size_t n = strlen(in);
  char* tmp = malloc(n + 1);
  if (!tmp) abort();
  size_t o = 0;
  for (size_t i = 0; i < n;) {
    unsigned char c = (unsigned char)in[i];
    if (c < 0x20 || c == 0x7f) { while (i < n && ((unsigned char)in[i] < 0x20 || (unsigned char)in[i] == 0x7f)) ++i; tmp[o++] = ' '; continue; }
    tmp[o++] = in[i++];
  }
  tmp[o] = 0;
  // trim
  char* start = tmp; char* end = tmp + o;
  for (;;) { int l; if (start < end && ct_js_space(ct_cp(start, &l))) start += l; else break; }
  while (end > start) {
    char* p = end - 1;
    while (p > start && ((unsigned char)*p & 0xc0) == 0x80) --p;
    int l; if (ct_js_space(ct_cp(p, &l))) end = p; else break;
  }
  // corte em `max` unidades UTF-16
  int units = 0; char* p = start;
  while (p < end) { int l = ct_utf8_len((unsigned char)*p); int u = l == 4 ? 2 : 1; if (units + u > max) break; units += u; p += l; }
  *p = 0;
  char* out = ct_dup(start);
  free(tmp);
  return out;
}
// String.prototype.toLowerCase para o que o catalogo tem (ASCII, Latin-1, Latin Ext-A, grego e cirilico basicos).
static unsigned ct_lower_cp(unsigned cp) {
  if (cp >= 'A' && cp <= 'Z') return cp + 32;
  if (cp < 0x80) return cp;
  if ((cp >= 0xc0 && cp <= 0xde && cp != 0xd7)) return cp + 32;
  if (cp >= 0x100 && cp <= 0x137 && !(cp & 1)) return cp + 1;
  if (cp >= 0x139 && cp <= 0x148 && (cp & 1)) return cp + 1;
  if (cp >= 0x14a && cp <= 0x177 && !(cp & 1)) return cp + 1;
  if (cp == 0x178) return 0xff;
  if (cp >= 0x179 && cp <= 0x17e && (cp & 1)) return cp + 1;
  if (cp >= 0x391 && cp <= 0x3ab && cp != 0x3a2) return cp + 32;
  if (cp >= 0x410 && cp <= 0x42f) return cp + 32;
  if (cp >= 0x400 && cp <= 0x40f) return cp + 80;
  return cp;
}
static char* ct_lower(const char* s) {
  size_t n = strlen(s);
  char* out = malloc(n * 2 + 1);
  if (!out) abort();
  size_t o = 0;
  for (size_t i = 0; i < n;) { int l; unsigned cp = ct_cp(s + i, &l); o += (size_t)ct_put(out + o, ct_lower_cp(cp)); i += (size_t)l; }
  out[o] = 0;
  return out;
}
// decodeURIComponent: NULL quando o JS jogaria URIError (% sem 2 hex, ou bytes que nao sao UTF-8).
static char* ct_uri_decode(const char* s) {
  size_t n = strlen(s);
  char* out = malloc(n + 1);
  if (!out) abort();
  size_t o = 0;
  for (size_t i = 0; i < n;) {
    if (s[i] != '%') { out[o++] = s[i++]; continue; }
    unsigned v;
    char hex[5] = {'0', '0', 0, 0, 0};
    if (i + 3 > n) { free(out); return NULL; }
    hex[2] = s[i + 1]; hex[3] = s[i + 2];
    if (!jp_hex(hex, &v)) { free(out); return NULL; }
    out[o++] = (char)v;
    i += 3;
  }
  out[o] = 0;
  for (size_t i = 0; i < o;) { // UTF-8 valido?
    unsigned char c = (unsigned char)out[i];
    int l = c < 0x80 ? 1 : (c >= 0xc2 && c <= 0xdf) ? 2 : (c >= 0xe0 && c <= 0xef) ? 3 : (c >= 0xf0 && c <= 0xf4) ? 4 : 0;
    if (!l || i + (size_t)l > o) { free(out); return NULL; }
    for (int k = 1; k < l; ++k) if (((unsigned char)out[i + (size_t)k] & 0xc0) != 0x80) { free(out); return NULL; }
    i += (size_t)l;
  }
  return out;
}
static int ct_alnum(unsigned char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'); }
static int ct_ws(unsigned char c) { return c == ' ' || (c >= 9 && c <= 13); }

// ---- download-sources.js webURL / isMagnetLink / sourceKind ----------------------------------------------
typedef struct { char host[256]; const char* path; } CtUrl;
static int ct_weburl(const char* v, CtUrl* u) {
  size_t n = strlen(v);
  if (n > 8192) return 0;
  for (size_t i = 0; i < n; ++i) {
    unsigned char c = (unsigned char)v[i];
    if (c <= 0x20 || c == '\\' || c == 0x7f) { if (c != 0x7f) return 0; }
    if (c == 0xc2 && (unsigned char)v[i + 1] == 0xa0) return 0;           // \s do JS: NBSP
    if (c == 0xe2 && (unsigned char)v[i + 1] == 0x80 && (((unsigned char)v[i + 2] >= 0x80 && (unsigned char)v[i + 2] <= 0x8a) || (unsigned char)v[i + 2] == 0xa8 || (unsigned char)v[i + 2] == 0xa9 || (unsigned char)v[i + 2] == 0xaf)) return 0;
    if (c == 0xef && (unsigned char)v[i + 1] == 0xbb && (unsigned char)v[i + 2] == 0xbf) return 0;
  }
  const char* p;
  if (!strncasecmp(v, "https://", 8)) p = v + 8; else if (!strncasecmp(v, "http://", 7)) p = v + 7; else return 0;
  const char* h = p;
  while ((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || *p == '.' || *p == '-') ++p;
  if (p == h || *h == '.' || (size_t)(p - h) >= sizeof u->host) return 0;
  for (size_t i = 0; i < (size_t)(p - h); ++i) u->host[i] = (char)tolower((unsigned char)h[i]);
  u->host[p - h] = 0;
  if (*p == ':') { const char* d = ++p; while (*p >= '0' && *p <= '9') ++p; if (p == d || p - d > 5) return 0; }
  if (*p && *p != '/' && *p != '?' && *p != '#') return 0;
  u->path = *p ? p : "/";
  return 1;
}
static int ct_magnet(const char* v) {
  size_t n = strlen(v);
  if (n > 8192 || strncasecmp(v, "magnet:?", 8)) return 0;
  for (size_t i = 0; i < n; ++i) if ((unsigned char)v[i] <= 0x20 || v[i] == 0x7f) { if (v[i] != 0x7f) return 0; }
  for (const char* p = v + 8; p && *p; p = strchr(p, '&') ? strchr(p, '&') + 1 : NULL) {
    if (strncasecmp(p, "xt=urn:btih:", 12)) continue;
    const char* h = p + 12; size_t k = 0;
    while (h[k] && h[k] != '&') ++k;
    int hex = k == 40, b32 = k == 32;
    for (size_t i = 0; i < k; ++i) { char c = (char)tolower((unsigned char)h[i]); if (!isxdigit((unsigned char)c)) hex = 0; if (!((c >= 'a' && c <= 'z') || (c >= '2' && c <= '7'))) b32 = 0; }
    if (hex || b32) return 1;
  }
  return 0;
}
static int ct_is_host(const char* host, const char* domain) {
  size_t a = strlen(host), b = strlen(domain);
  return !strcmp(host, domain) || (a > b && host[a - b - 1] == '.' && !strcmp(host + a - b, domain));
}
static int ct_ends_ci(const char* s, size_t n, const char* tail) { size_t k = strlen(tail); return n >= k && !strncasecmp(s + n - k, tail, k); }
static int ct_direct(const char* url, const char* browser, int requires_browser) {
  const char* value = browser ? browser : url;
  if (!value || !*value) return 0;
  if (ct_magnet(value)) return 0;
  CtUrl u;
  if (!ct_weburl(value, &u)) return 0; // sourceKind joga; direct() devolve false
  static const char* const HOSTS[][3] = {{"mediafire", "mediafire.com", NULL}, {"buzzheavier", "buzzheavier.com", NULL}, {"vikingfile", "vikingfile.com", "vik1ngfile.site"},
                                         {"datanodes", "datanodes.to", NULL}, {"filekeeper", "filekeeper.net", NULL}, {"rootz", "rootz.so", NULL}};
  for (size_t i = 0; i < sizeof HOSTS / sizeof *HOSTS; ++i) {
    if (!ct_is_host(u.host, HOSTS[i][1]) && !(HOSTS[i][2] && ct_is_host(u.host, HOSTS[i][2]))) continue;
    if (i == 0 && !strncmp(u.host, "download", 8)) return 1;
    if (i == 2 && !strncmp(u.path, "/d/", 3) && !browser) return 1;
    return 0;
  }
  if ((!strcmp(u.host, "archive.org") && !strncmp(u.path, "/download/", 10)) || (!strcmp(u.host, "github.com") && strstr(u.path, "/releases/download/"))) return 1;
  // /\.(?:ffpfsc|ffpfs|ffpkg|exfat|pkg|zip|rar|7z)(?:[?#]|$)/i em algum ponto do caminho
  static const char* const EXT[] = {".ffpfsc", ".ffpfs", ".ffpkg", ".exfat", ".pkg", ".zip", ".rar", ".7z"};
  for (const char* p = u.path; *p; ++p) {
    if (*p != '.') continue;
    for (size_t e = 0; e < sizeof EXT / sizeof *EXT; ++e) {
      size_t k = strlen(EXT[e]);
      if (!strncasecmp(p, EXT[e], k) && (p[k] == 0 || p[k] == '?' || p[k] == '#')) return 1;
    }
  }
  (void)ct_ends_ci;
  if (requires_browser) return 0;
  return 1;
}
// feed-format.js hostName: archive.org inteiro; os outros sem www. e sem o TLD.
static void ct_host_name(const char* url, char* out, size_t cap) {
  CtUrl u;
  out[0] = 0;
  if (!ct_weburl(url, &u)) return;
  const char* h = !strncmp(u.host, "www.", 4) ? u.host + 4 : u.host;
  if (ct_is_host(h, "archive.org")) { snprintf(out, cap, "archive.org"); return; }
  snprintf(out, cap, "%.250s", h);
  char* dot = strrchr(out, '.');
  if (dot && dot[1]) { int letters = 1; for (char* c = dot + 1; *c; ++c) if (*c < 'a' || *c > 'z') letters = 0; if (letters) *dot = 0; }
}

// ---- release-sets.js + formats.js: os formatos dos links de feed de um jogo --------------------------------
// (?<![a-z0-9])(?:body)(?![a-z0-9]) com /i: `match` diz quantos bytes o corpo casa em p (0 = nao casa).
typedef size_t (*CtBody)(const char* p);
static int ct_word(const char* text, CtBody body) {
  for (const char* p = text; *p; ++p) {
    if (p > text && ct_alnum((unsigned char)p[-1])) continue;
    size_t k = body(p);
    if (k && !ct_alnum((unsigned char)p[k])) return 1;
  }
  return 0;
}
static size_t ct_seq(const char* p, const char* a, const char* gap, const char* b) { // a [gap]* b
  size_t k = strlen(a);
  if (strncasecmp(p, a, k)) return 0;
  while (p[k] && ((ct_ws((unsigned char)p[k]) && strchr(gap, 's')) || (p[k] != 's' && strchr(gap, p[k])))) ++k;
  size_t m = strlen(b);
  return strncasecmp(p + k, b, m) ? 0 : k + m;
}
static size_t ct_b_folder(const char* p) { size_t k = ct_seq(p, "folder", "s_.-", "dump"); return k ? k : ct_seq(p, "shadow", "s_.-", "mount"); }
static size_t ct_b_backport(const char* p) { return ct_seq(p, "back", "s_-", "port"); }
static size_t ct_b_ffpkg(const char* p) { return strncasecmp(p, "ffpkg", 5) ? 0 : 5; }
static size_t ct_b_exfat(const char* p) { return strncasecmp(p, "exfat", 5) ? 0 : 5; }
static size_t ct_b_ffpfs(const char* p) { // ffpfsc? com a volta do regex: ffpfsc e depois ffpfs
  if (strncasecmp(p, "ffpfs", 5)) return 0;
  if ((p[5] == 'c' || p[5] == 'C') && !ct_alnum((unsigned char)p[6])) return 6;
  return 5;
}
static int ct_image_words(const char* t) { return ct_word(t, ct_b_exfat) || ct_word(t, ct_b_ffpkg) || ct_word(t, ct_b_ffpfs); }
static int ct_package_words(const char* t) { // fpkg|(?<=\.)pkg
  for (const char* p = t; *p; ++p) {
    if (p > t && ct_alnum((unsigned char)p[-1])) continue;
    if (!strncasecmp(p, "fpkg", 4) && !ct_alnum((unsigned char)p[4])) return 1;
    if (p > t && p[-1] == '.' && !strncasecmp(p, "pkg", 3) && !ct_alnum((unsigned char)p[3])) return 1;
  }
  return 0;
}
static int ct_patch_only(const char* text) { // /backport[+_ -]*files/i
  for (const char* p = text; *p; ++p) {
    if (strncasecmp(p, "backport", 8)) continue;
    const char* q = p + 8;
    while (*q == '+' || *q == '_' || *q == ' ' || *q == '-') ++q;
    if (!strncasecmp(q, "files", 5)) return 1;
  }
  return 0;
}
// /\bpart\s*(\d+)\b/i: 1 com o numero (ou -1 quando nao e um inteiro seguro), e onde o trecho comeca e acaba.
static int ct_part(const char* s, double* number, size_t* at, size_t* end) {
  for (size_t i = 0; s[i]; ++i) {
    if (i > 0 && (ct_alnum((unsigned char)s[i - 1]) || s[i - 1] == '_')) continue;
    if (strncasecmp(s + i, "part", 4)) continue;
    size_t k = i + 4;
    while (s[k] && ct_ws((unsigned char)s[k])) ++k;
    if (!isdigit((unsigned char)s[k])) continue;
    size_t d = k;
    while (isdigit((unsigned char)s[k])) ++k;
    if (ct_alnum((unsigned char)s[k]) || s[k] == '_') continue; // \b depois dos digitos
    char digits[64]; size_t len = k - d < 63 ? k - d : 63;
    memcpy(digits, s + d, len); digits[len] = 0;
    *number = strtod(digits, NULL);
    *at = i; *end = k;
    return 1;
  }
  return 0;
}
static void ct_host_key(const char* provider, char* out, size_t cap) { // release-sets.js hostKey
  char* l = ct_lower(provider);
  const char* h = !strncmp(l, "www.", 4) ? l + 4 : l;
  snprintf(out, cap, "%s", h);
  char* dot = strrchr(out, '.');
  if (dot && dot[1]) { int letters = 1; for (char* c = dot + 1; *c; ++c) if (*c < 'a' || *c > 'z') letters = 0; if (letters) *dot = 0; }
  free(l);
}
static const char* ct_last_segment_raw(const char* url, char* out, size_t cap) { // (url).split(/[?#]/)[0].split("/").pop()
  size_t n = strcspn(url, "?#");
  const char* s = url;
  for (size_t i = 0; i < n; ++i) if (url[i] == '/') s = url + i + 1;
  size_t len = (size_t)(url + n - s);
  if (len >= cap) len = cap - 1;
  memcpy(out, s, len); out[len] = 0;
  return out;
}
static void ct_add_text(Buf* b, const char* value) { // textOf: cada parte decodificada (ou como esta), juntas por espaco
  if (!value || !*value) return;
  char* d = ct_uri_decode(value);
  if (b->size) buf_str(b, " ");
  buf_str(b, d ? d : value);
  free(d);
}
static void ct_add_names(Buf* b, const CtRel* r) {
  ct_add_text(b, r->filename);
  ct_add_text(b, r->volume);
  char seg[2048];
  const char* link = r->url && *r->url ? r->url : r->browser ? r->browser : "";
  ct_add_text(b, ct_last_segment_raw(link, seg, sizeof seg));
}
// releaseType + kindOf de um item (um link ou um conjunto): o bit do formato, ou -1.
static int ct_kind(const char* format, const char* label, const char* text) {
  char f[24]; snprintf(f, sizeof f, "%s", format ? format : "");
  for (char* c = f; *c; ++c) *c = (char)tolower((unsigned char)*c);
  const int image_format = !strcmp(f, "exfat") || !strcmp(f, "ffpkg") || !strcmp(f, "ffpfs") || !strcmp(f, "ffpfsc");
  if (!strcmp(f, "pkg") || !strcmp(f, "fpkg")) return 6;
  if (ct_word(label ? label : "", ct_b_backport)) return 5;
  int image = 0;
  if (image_format) image = 1;
  else if (ct_word(text, ct_b_folder)) return 0;
  else if (ct_image_words(text)) image = 1;
  else if (ct_package_words(text)) return 6;
  if (!image) return -1;
  // imageFormatOf
  const char* named = image_format ? f : ct_word(text, ct_b_ffpkg) ? "ffpkg" : ct_word(text, ct_b_ffpfs) ? "ffpfs" : ct_word(text, ct_b_exfat) ? "exfat" : NULL;
  if (!named) return 4;
  if (!strcmp(named, "ffpfsc") || !strcmp(named, "ffpfs")) return 3;
  return !strcmp(named, "exfat") ? 1 : 2;
}
typedef struct { int number; const CtRel* src; } CtPart;
typedef struct { char* key; char* label; CtPart* parts; int nparts, cap; } CtSet;
static uint16_t ct_feed_kinds(const CtGame* g) {
  uint16_t mask = 0;
  CtSet* sets = calloc((size_t)g->nrels + 1, sizeof *sets);
  int* order = malloc(sizeof(int) * ((size_t)g->nrels + 1)); // a saida do releaseSets: >= 0 link, < 0 conjunto -(i+1)
  if (!sets || !order) abort();
  int nsets = 0, nout = 0;
  for (int i = 0; i < g->nrels; ++i) {
    const CtRel* r = &g->rels[i];
    double number; size_t at, end;
    const char* named = r->label && *r->label ? r->label : r->volume ? r->volume : "";
    if (r->patch || !ct_part(named, &number, &at, &end)) { order[nout++] = i; continue; }
    if (!(number >= 1 && number <= 1024) || number != floor(number)) { order[nout++] = i; continue; }
    // o rotulo sem o "part N" (o primeiro, como o replace sem /g), trim
    const char* label = r->label ? r->label : "";
    double n2; size_t a2 = 0, e2 = 0;
    Buf stripped = {0};
    if (ct_part(label, &n2, &a2, &e2)) { buf_add(&stripped, label, a2); buf_str(&stripped, label + e2); } else buf_str(&stripped, label);
    buf_add(&stripped, "", 1);
    char* clean = ct_text(stripped.data, 1 << 20); // so o trim (sem controles num rotulo validado)
    free(stripped.data);
    char hk[256]; ct_host_key(r->provider ? r->provider : "", hk, sizeof hk);
    char* low = ct_lower(clean);
    Buf key = {0};
    buf_str(&key, r->record ? r->record : ""); buf_str(&key, "/"); buf_str(&key, hk); buf_str(&key, "/"); buf_str(&key, low); buf_add(&key, "", 1);
    free(low);
    int s = -1;
    for (int k = nsets - 1; k >= 0; --k) if (sets[k].key && !strcmp(sets[k].key, key.data)) { s = k; break; }
    if (s >= 0 && (int)number == 1) {
      const CtPart* first = NULL;
      for (int p = 0; p < sets[s].nparts; ++p) if (sets[s].parts[p].number == 1) first = &sets[s].parts[p];
      if (first && !(!strcmp(first->src->url ? first->src->url : "", r->url ? r->url : "") && !strcmp(first->src->browser ? first->src->browser : "", r->browser ? r->browser : ""))) {
        free(sets[s].key); sets[s].key = NULL; // o mapa passa a apontar o conjunto novo
        s = -1;
      }
    }
    if (s < 0) {
      s = nsets++;
      sets[s].key = key.data; key.data = NULL;
      sets[s].label = clean; clean = NULL;
      order[nout++] = -(s + 1);
    }
    free(key.data); free(clean);
    CtPart* part = NULL;
    for (int p = 0; p < sets[s].nparts; ++p) if (sets[s].parts[p].number == (int)number) part = &sets[s].parts[p];
    if (!part) {
      if (sets[s].nparts == sets[s].cap) { sets[s].cap = sets[s].cap ? sets[s].cap * 2 : 4; sets[s].parts = realloc(sets[s].parts, sizeof *sets[s].parts * (size_t)sets[s].cap); if (!sets[s].parts) abort(); }
      part = &sets[s].parts[sets[s].nparts++];
      part->number = (int)number;
      part->src = r;
    }
  }
  for (int o = 0; o < nout; ++o) {
    Buf text = {0};
    int kind;
    if (order[o] >= 0) {
      const CtRel* r = &g->rels[order[o]];
      ct_add_text(&text, r->label);
      ct_add_names(&text, r);
      buf_add(&text, "", 1);
      kind = ct_kind(r->format, r->label, text.data);
    } else {
      CtSet* set = &sets[-order[o] - 1];
      for (int a = 1; a < set->nparts; ++a) for (int b = a; b > 0 && set->parts[b - 1].number > set->parts[b].number; --b) {
        CtPart t = set->parts[b]; set->parts[b] = set->parts[b - 1]; set->parts[b - 1] = t;
      }
      ct_add_text(&text, set->label);
      for (int p = 0; p < set->nparts; ++p) ct_add_names(&text, set->parts[p].src);
      buf_add(&text, "", 1);
      kind = ct_kind("archive-set", set->label, text.data);
    }
    free(text.data);
    if (kind >= 0) mask |= (uint16_t)(1u << kind);
  }
  for (int k = 0; k < nsets; ++k) { free(sets[k].key); free(sets[k].label); free(sets[k].parts); }
  free(sets); free(order);
  return mask;
}

// ---- Leitura dos arquivos ------------------------------------------------------------------------------------
static char* ct_read_file(const char* path, size_t* size) {
  FILE* f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char* data = n >= 0 ? malloc((size_t)n + 1) : NULL;
  if (data && fread(data, 1, (size_t)n, f) != (size_t)n) { free(data); data = NULL; }
  fclose(f);
  if (data) { data[n] = 0; *size = (size_t)n; }
  return data;
}
// state/jlx.js decodeJlx (no lugar: o texto tem o mesmo tamanho).
static int ct_jlx_decode(char* text, size_t* size) {
  if (*size < 5 || strncmp(text, "JLX1:", 5)) return 1; // texto comum
  size_t end = *size;
  if (end >= 2 && text[end - 2] == '\r' && text[end - 1] == '\n') end -= 2; else if (end >= 1 && text[end - 1] == '\n') end -= 1;
  uint32_t s = 0x4a4c5831u;
  size_t o = 0;
  for (size_t i = 5; i < end; ++i) {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    int c = (unsigned char)text[i] - 32;
    if (c < 0 || c >= 95) return 0;
    text[o++] = (char)(((c - (int)(s % 95u)) % 95 + 95) % 95 + 32);
  }
  text[o] = 0;
  *size = o;
  return 1;
}
// Um texto JSON inteiro em malloc (NULL quando nao e texto: pulado).
static int ct_str(JP* j, char** out) {
  *out = NULL;
  jp_ws(j);
  if (j->p >= j->end || *j->p != '"') return jp_skip(j);
  const char* start = j->p;
  if (!jp_string(j, NULL, 0)) return 0;
  size_t cap = (size_t)(j->p - start) + 8;
  char* s = malloc(cap);
  if (!s) abort();
  j->p = start;
  if (!jp_string(j, s, cap)) { free(s); return 0; }
  *out = s;
  return 1;
}
// Um numero do JSON (has = 0 quando e outro tipo).
static int ct_num(JP* j, double* out, int* has) {
  *has = 0; *out = 0;
  jp_ws(j);
  if (j->p < j->end && (*j->p == '-' || isdigit((unsigned char)*j->p))) { uint64_t u; int i; if (!jp_number(j, out, &u, &i)) return 0; *has = 1; return 1; }
  return jp_skip(j);
}
typedef struct { char** v; int n, cap; } CtStrList;
static void ct_strlist_free(CtStrList* l) { for (int i = 0; i < l->n; ++i) free(l->v[i]); free(l->v); memset(l, 0, sizeof *l); }
static int ct_strlist_item(JP* j, void* ctx) {
  CtStrList* l = ctx;
  char* s;
  if (!ct_str(j, &s)) return 0;
  if (l->n == l->cap) { l->cap = l->cap ? l->cap * 2 : 8; l->v = realloc(l->v, sizeof *l->v * (size_t)l->cap); if (!l->v) abort(); }
  l->v[l->n++] = s; // NULL = nao era texto (conta como item, como no slice do app)
  return 1;
}

// ---- Feeds (feed-format.js game/release) ---------------------------------------------------------------------
typedef struct {
  char *url, *browser, *filename, *format, *label, *provider, *record, *volume;
  int requires_browser, has_bytes; double bytes;
} CtRawRel;
typedef struct { CtRawRel* v; int n, cap, total; } CtRawRels;
typedef struct {
  char *id, *title, *platform, *developer, *publisher, *release_date, *cover;
  CtStrList genres, features;
  CtRawRels rels;
  double rec, meta, size_gb; int has_rec, has_meta, has_size;
} CtRawGame;
static void ct_raw_rel_free(CtRawRel* r) { free(r->url); free(r->browser); free(r->filename); free(r->format); free(r->label); free(r->provider); free(r->record); free(r->volume); }
static void ct_raw_game_free(CtRawGame* g) {
  free(g->id); free(g->title); free(g->platform); free(g->developer); free(g->publisher); free(g->release_date); free(g->cover);
  ct_strlist_free(&g->genres); ct_strlist_free(&g->features);
  for (int i = 0; i < g->rels.n; ++i) ct_raw_rel_free(&g->rels.v[i]);
  free(g->rels.v);
  memset(g, 0, sizeof *g);
}
static int ct_rel_field(JP* j, const char* key, void* ctx) {
  CtRawRel* r = ctx;
  char** slot = !strcmp(key, "url") ? &r->url : !strcmp(key, "browserUrl") ? &r->browser : !strcmp(key, "filename") ? &r->filename : !strcmp(key, "format") ? &r->format :
                !strcmp(key, "label") ? &r->label : !strcmp(key, "provider") ? &r->provider : !strcmp(key, "record") ? &r->record : !strcmp(key, "volume") ? &r->volume : NULL;
  if (slot) { free(*slot); return ct_str(j, slot) ? 1 : -1; }
  if (!strcmp(key, "requiresBrowser")) { jp_ws(j); r->requires_browser = jp_literal(j, "true"); return r->requires_browser || jp_skip(j) ? 1 : -1; }
  if (!strcmp(key, "sizeBytes")) return ct_num(j, &r->bytes, &r->has_bytes) ? 1 : -1;
  return 0;
}
static int ct_rel_item(JP* j, void* ctx) {
  CtRawRels* l = ctx;
  ++l->total;
  if (l->total > 64) return jp_skip(j); // list(raw.releases, MAX_RELEASES): so os 64 primeiros
  jp_ws(j);
  if (l->n == l->cap) { l->cap = l->cap ? l->cap * 2 : 4; l->v = realloc(l->v, sizeof *l->v * (size_t)l->cap); if (!l->v) abort(); }
  CtRawRel* r = &l->v[l->n];
  memset(r, 0, sizeof *r);
  if (j->p < j->end && *j->p == '{') { if (!jp_object(j, ct_rel_field, r)) { ct_raw_rel_free(r); return 0; } }
  else { if (!jp_skip(j)) return 0; r->url = NULL; }
  ++l->n;
  return 1;
}
static int ct_art_field(JP* j, const char* key, void* ctx) {
  CtRawGame* g = ctx;
  if (!strcmp(key, "cover")) { free(g->cover); return ct_str(j, &g->cover) ? 1 : -1; }
  return 0;
}
static int ct_game_field(JP* j, const char* key, void* ctx) {
  CtRawGame* g = ctx;
  char** slot = !strcmp(key, "id") ? &g->id : !strcmp(key, "title") ? &g->title : !strcmp(key, "platform") ? &g->platform : !strcmp(key, "developer") ? &g->developer :
                !strcmp(key, "publisher") ? &g->publisher : !strcmp(key, "releaseDate") ? &g->release_date : NULL;
  if (slot) { free(*slot); return ct_str(j, slot) ? 1 : -1; }
  if (!strcmp(key, "genres")) { ct_strlist_free(&g->genres); return jp_array(j, ct_strlist_item, &g->genres) ? 1 : -1; }
  if (!strcmp(key, "features")) { ct_strlist_free(&g->features); return jp_array(j, ct_strlist_item, &g->features) ? 1 : -1; }
  if (!strcmp(key, "releases")) return jp_array(j, ct_rel_item, &g->rels) ? 1 : -1;
  if (!strcmp(key, "recommendations")) return ct_num(j, &g->rec, &g->has_rec) ? 1 : -1;
  if (!strcmp(key, "metacritic")) return ct_num(j, &g->meta, &g->has_meta) ? 1 : -1;
  if (!strcmp(key, "sizeGb")) return ct_num(j, &g->size_gb, &g->has_size) ? 1 : -1;
  if (!strcmp(key, "art")) { jp_ws(j); return (j->p < j->end && *j->p == '{' ? jp_object(j, ct_art_field, g) : jp_skip(j)) ? 1 : -1; }
  return 0;
}
typedef struct {
  Catalog* c; CtGame** by_id_new; int* nnew;
  char ids_seen[5000][10]; int nseen; int offered; int releases;
  int failed;
} CtFeedRead;
static CtGame* ct_find_game(Catalog* c, const char* id);
static void ct_hash_put(CtGame* g);
static CtGame* ct_new_game(Catalog* c, const char* id) {
  CtGame* g = calloc(1, sizeof *g);
  if (!g) abort();
  snprintf(g->id, sizeof g->id, "%s", id);
  g->work = -1;
  if (c->count == c->cap) { c->cap = c->cap ? c->cap * 2 : 4096; c->all = realloc(c->all, sizeof *c->all * (size_t)c->cap); if (!c->all) abort(); }
  c->all[c->count++] = g;
  return g;
}
static void ct_genres_into(Catalog* c, CtIds* into, const char* genre);
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
// Um jogo de feed validado e juntado ao catalogo (catalog.js buildSteps "merge").
static void ct_take_feed_game(CtFeedRead* fr, CtRawGame* raw) {
  Catalog* c = fr->c;
  char* idt = ct_text(raw->id, 9);
  for (char* p = idt; *p; ++p) *p = (char)toupper((unsigned char)*p);
  char* title = ct_text(raw->title, 200);
  int ok = strlen(idt) == 9 && (!strncmp(idt, "CUSA", 4) || !strncmp(idt, "PPSA", 4)) && *title;
  for (int i = 4; ok && i < 9; ++i) if (!isdigit((unsigned char)idt[i])) ok = 0;
  if (!ok) { free(idt); free(title); return; }
  // os links validos
  CtRel* rels = calloc((size_t)raw->rels.n + 1, sizeof *rels);
  int nrels = 0, direct = 0;
  double bytes = 0;
  CtIds providers = {0};
  CtNames* prov_names = &c->providers;
  for (int i = 0; i < raw->rels.n; ++i) {
    CtRawRel* r = &raw->rels.v[i];
    if (!r->url) continue;
    char* trimmed = ct_text(r->url, 1 << 20); // so para o magnet: url.trim()
    int magnet = ct_magnet(trimmed);
    CtUrl u;
    const char* url = magnet ? trimmed : (ct_weburl(r->url, &u) ? r->url : NULL);
    if (!url) { free(trimmed); continue; }
    CtUrl bu;
    const char* browser = magnet || !r->browser ? NULL : ct_weburl(r->browser, &bu) ? r->browser : NULL;
    char* named = ct_text(r->filename, 160);
    char* from_link = NULL;
    if (magnet) {
      const char* dn = NULL;
      for (const char* p = url; *p; ++p) if ((*p == '?' || *p == '&') && !strncasecmp(p + 1, "dn=", 3)) { dn = p + 4; break; }
      if (dn) {
        size_t k = strcspn(dn, "&");
        char* v = malloc(k + 1); memcpy(v, dn, k); v[k] = 0;
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
    char gen[32]; snprintf(gen, sizeof gen, "%s-%d", idt, i + 1);
    const char* filename = ct_usable_filename(named) ? named : ct_usable_filename(from_link) ? from_link : gen;
    const char* dot = strrchr(filename, '.');
    char ext[32] = "";
    if (dot && dot[1]) { int alnum = 1; for (const char* q = dot + 1; *q; ++q) if (!ct_alnum((unsigned char)*q)) alnum = 0; if (alnum && strlen(dot + 1) < sizeof ext) { snprintf(ext, sizeof ext, "%s", dot + 1); for (char* q = ext; *q; ++q) *q = (char)tolower((unsigned char)*q); } }
    int fi = ct_feed_format(r->format);
    const char* format = fi >= 0 ? CT_FEED_FORMATS[fi] : ct_feed_format(ext) >= 0 ? ext : "binary";
    char* provider = ct_text(r->provider, 40);
    char host[256] = "";
    if (!magnet) ct_host_name(url, host, sizeof host);
    if (!*provider) { free(provider); provider = ct_dup(magnet ? "Torrent" : host); }
    char* label = ct_text(r->label, 200);
    if (!*label) { free(label); label = ct_dup(provider); }
    char* record = ct_text(r->record, 80);
    if (!*record) { free(record); Buf b = {0}; buf_fmt(&b, "feed-%s", idt); buf_add(&b, "", 1); record = b.data; }
    char* volume = ct_text(r->volume, 40);
    CtRel* rel = &rels[nrels++];
    rel->url = ct_dup(url); rel->browser = browser ? ct_dup(browser) : NULL; rel->filename = ct_dup(filename); rel->format = ct_dup(format);
    rel->label = label; rel->record = record; rel->provider = provider; rel->volume = *volume ? volume : (free(volume), (char*)NULL);
    Buf pt = {0}; buf_str(&pt, rel->url); buf_str(&pt, " "); buf_str(&pt, rel->browser ? rel->browser : ""); buf_str(&pt, " "); buf_str(&pt, rel->label); buf_add(&pt, "", 1);
    rel->patch = (uint8_t)ct_patch_only(pt.data);
    free(pt.data);
    if (r->has_bytes && r->bytes > 0 && r->bytes == floor(r->bytes) && r->bytes <= 9007199254740991.0) bytes += r->bytes;
    if (!magnet && ct_direct(rel->url, rel->browser, r->requires_browser)) direct = 1;
    ct_ids_add(&providers, ct_intern(prov_names, magnet ? "torrent" : host));
    free(named); free(from_link); free(trimmed);
  }
  if (!nrels || fr->releases >= 20000) { free(idt); free(title); free(rels); free(providers.v); return; }
  for (int k = 0; k < fr->nseen; ++k) if (!strcmp(fr->ids_seen[k], idt)) { // um id repetido no mesmo feed: vale o primeiro
    for (int i = 0; i < nrels; ++i) { CtRel* r = &rels[i]; free(r->url); free(r->browser); free(r->filename); free(r->format); free(r->label); free(r->record); free(r->provider); free(r->volume); }
    free(idt); free(title); free(rels); free(providers.v); return;
  }
  if (fr->nseen < 5000) snprintf(fr->ids_seen[fr->nseen++], 10, "%s", idt);
  fr->releases += nrels;
  CtGame* known = ct_find_game(c, idt);
  if (known) {
    for (int i = 0; i < providers.n; ++i) ct_ids_add(&known->providers, providers.v[i]);
    if (direct) known->direct = 1;
    free(providers.v);
  } else {
    CtGame* g = ct_new_game(c, idt);
    ct_hash_put(g); // dois feeds com o mesmo jogo novo: o segundo soma no do primeiro
    g->listed = 1; g->from_feed = 1;
    g->title = title; title = NULL;
    g->platform = raw->platform && !strcmp(raw->platform, "ps4") ? 1 : raw->platform && !strcmp(raw->platform, "ps5") ? 0 : !strncmp(idt, "PPSA", 4) ? 0 : 1;
    g->providers = providers;
    g->direct = (uint8_t)direct;
    g->dev = ct_text(raw->developer, 120);
    g->pub = ct_text(raw->publisher, 120);
    if (ct_valid_date(raw->release_date)) { snprintf(g->release, sizeof g->release, "%s", raw->release_date); g->has_year = 1; g->year = atoi(raw->release_date); }
    for (int i = 0; i < raw->genres.n && i < 8; ++i) { char* t = ct_text(raw->genres.v[i], 40); if (*t) ct_genres_into(c, &g->genres, t); free(t); }
    for (int i = 0; i < raw->features.n && i < 12; ++i) { char* t = ct_text(raw->features.v[i], 40); if (*t) ct_ids_add(&g->features, ct_intern(&c->features, t)); free(t); }
    g->has_rec = 1; g->rec = raw->has_rec && raw->rec >= 0 && raw->rec <= 1e9 ? raw->rec : 0;
    if (raw->has_meta && raw->meta >= 0 && raw->meta <= 100) { g->has_meta = 1; g->metacritic = (int)raw->meta; }
    double size = raw->has_size && raw->size_gb >= 0 && raw->size_gb <= 4096 ? raw->size_gb : bytes ? floor(bytes / 1e8 + 0.5) / 10 : 0;
    if (size) { g->has_size = 1; g->size_gb = size; }
    CtUrl cu;
    if (raw->cover && ct_weburl(raw->cover, &cu)) g->cover = ct_dup(raw->cover);
    known = g;
  }
  // os links somam no jogo (feedReleases): os formatos saem de todos eles juntos
  if (known->nrels + nrels > known->caprels) { known->caprels = known->nrels + nrels; known->rels = realloc(known->rels, sizeof *known->rels * (size_t)known->caprels); if (!known->rels) abort(); }
  memcpy(known->rels + known->nrels, rels, sizeof *rels * (size_t)nrels);
  known->nrels += nrels;
  free(rels); free(idt); free(title);
}
static int ct_feed_game_item(JP* j, void* ctx) {
  CtFeedRead* fr = ctx;
  CtRawGame raw;
  memset(&raw, 0, sizeof raw);
  jp_ws(j);
  if (j->p < j->end && *j->p != '{') { ++fr->offered; return jp_skip(j); }
  if (fr->offered >= 5000) return jp_skip(j);
  ++fr->offered;
  if (!jp_object(j, ct_game_field, &raw)) { ct_raw_game_free(&raw); return 0; }
  if (fr->releases < 20000) ct_take_feed_game(fr, &raw);
  ct_raw_game_free(&raw);
  return 1;
}
// As notas de um feed ({"PPSA...": [estrelas, quantas]}): a primeira lista que da uma nota a um jogo vale.
typedef struct { Catalog* c; int kept; double pair[2]; int npair, bad; } CtRatings;
static int ct_pair_item(JP* j, void* ctx) {
  CtRatings* r = ctx;
  double v; int has;
  if (!ct_num(j, &v, &has)) return 0;
  if (r->npair < 2) { if (!has) r->bad = 1; r->pair[r->npair] = v; }
  ++r->npair;
  return 1;
}
static double* g_feed_stars; static uint32_t* g_feed_counts; static char (*g_feed_ids)[10]; static int g_feed_nratings, g_feed_capratings;
static int ct_rating_field(JP* j, const char* key, void* ctx) {
  CtRatings* r = ctx;
  jp_ws(j);
  int title = strlen(key) == 9;
  for (int i = 0; title && i < 4; ++i) if (key[i] < 'A' || key[i] > 'Z') title = 0;
  for (int i = 4; title && i < 9; ++i) if (!isdigit((unsigned char)key[i])) title = 0;
  if (r->kept >= 6000 || !title || j->p >= j->end || *j->p != '[') return jp_skip(j) ? 1 : -1;
  r->npair = 0; r->bad = 0;
  if (!jp_array(j, ct_pair_item, r)) return -1;
  const double stars = r->pair[0], count = r->pair[1];
  if (r->bad || r->npair < 2 || !(stars >= 1 && stars <= 5) || count <= 0 || count != floor(count) || count > 9007199254740991.0) return 1;
  ++r->kept;
  for (int i = 0; i < g_feed_nratings; ++i) if (!strcmp(g_feed_ids[i], key)) return 1;
  if (g_feed_nratings == g_feed_capratings) {
    g_feed_capratings = g_feed_capratings ? g_feed_capratings * 2 : 4096;
    g_feed_stars = realloc(g_feed_stars, sizeof *g_feed_stars * (size_t)g_feed_capratings);
    g_feed_counts = realloc(g_feed_counts, sizeof *g_feed_counts * (size_t)g_feed_capratings);
    g_feed_ids = realloc(g_feed_ids, sizeof *g_feed_ids * (size_t)g_feed_capratings);
    if (!g_feed_stars || !g_feed_counts || !g_feed_ids) abort();
  }
  snprintf(g_feed_ids[g_feed_nratings], 10, "%s", key);
  g_feed_stars[g_feed_nratings] = stars;
  g_feed_counts[g_feed_nratings++] = (uint32_t)count;
  return 1;
}
static int ct_feed_top(JP* j, const char* key, void* ctx) {
  CtFeedRead* fr = ctx;
  if (!strcmp(key, "games")) return jp_array(j, ct_feed_game_item, fr) ? 1 : -1;
  if (!strcmp(key, "ratings")) { CtRatings r = {fr->c, 0, {0, 0}, 0, 0}; jp_ws(j); return (j->p < j->end && *j->p == '{' ? jp_object(j, ct_rating_field, &r) : jp_skip(j)) ? 1 : -1; }
  return 0;
}
// Um feed inteiro (o texto ja decifrado). Os jogos entram na ordem do feed. Sem "version": 1 e "games", nada.
static int ct_read_feed(Catalog* c, char* text, size_t size) {
  CtFeedRead* fr = calloc(1, sizeof *fr);
  if (!fr) abort();
  fr->c = c;
  JP jp = {text, text + size, 0};
  const int ok = jp_object(&jp, ct_feed_top, fr);
  free(fr);
  return ok;
}

// ---- O catalogo embutido (data/catalog-index.js) -------------------------------------------------------------
static const char* const CT_NAMED[6] = {"platform", "providers", "developer", "publisher", "genres", "features"};
typedef struct { Catalog* c; int twin; CtGame* g; int which; } CtIndexRead;
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
static int ct_names_item(JP* j, void* ctx) { CtNames* t = ctx; char* s; if (!ct_str(j, &s)) return 0; if (t->n == t->cap) { t->cap = t->cap ? t->cap * 2 : 64; t->v = realloc(t->v, sizeof *t->v * (size_t)t->cap); if (!t->v) abort(); } t->v[t->n++] = s ? s : ct_dup(""); return 1; }
static int ct_names_field(JP* j, const char* key, void* ctx) {
  Catalog* c = ctx;
  for (int i = 0; i < 6; ++i) if (!strcmp(key, CT_NAMED[i])) return jp_array(j, ct_names_item, &c->raw_names[i]) ? 1 : -1;
  return 0;
}
static int ct_index_place(JP* j, void* ctx) {
  CtIndexRead* r = ctx;
  double v; int has;
  if (!ct_num(j, &v, &has)) return 0;
  if (!has || v < 0 || (int)v >= r->c->raw_names[r->which].n) return 1;
  const char* name = r->c->raw_names[r->which].v[(int)v];
  if (r->which == 1) ct_ids_add(&r->g->providers, ct_intern(&r->c->providers, name));
  else if (r->which == 4) ct_genres_into(r->c, &r->g->genres, name);
  else if (r->which == 5) ct_ids_add(&r->g->features, ct_intern(&r->c->features, name));
  return 1;
}
static int ct_index_art(JP* j, const char* key, void* ctx) {
  CtIndexRead* r = ctx;
  if (!strcmp(key, "cover")) { free(r->g->cover); return ct_str(j, &r->g->cover) ? 1 : -1; }
  return 0;
}
static int ct_index_game_field(JP* j, const char* key, void* ctx) {
  CtIndexRead* r = ctx;
  CtGame* g = r->g;
  char* s;
  double v; int has;
  if (!strcmp(key, "id")) { if (!ct_str(j, &s)) return -1; snprintf(g->id, sizeof g->id, "%s", s ? s : ""); free(s); return 1; }
  if (!strcmp(key, "title")) { free(g->title); return ct_str(j, &g->title) ? 1 : -1; }
  if (!strcmp(key, "releaseDate")) { if (!ct_str(j, &s)) return -1; snprintf(g->release, sizeof g->release, "%s", s ? s : ""); free(s); return 1; }
  if (!strcmp(key, "platform") || !strcmp(key, "developer") || !strcmp(key, "publisher")) {
    if (!ct_num(j, &v, &has)) return -1;
    const int which = key[0] == 'p' && key[1] == 'l' ? 0 : key[0] == 'd' ? 2 : 3;
    const char* name = has && v >= 0 && (int)v < r->c->raw_names[which].n ? r->c->raw_names[which].v[(int)v] : "";
    if (which == 0) g->platform = !strcmp(name, "ps4") ? 1 : 0;
    else if (which == 2) { free(g->dev); g->dev = ct_dup(name); }
    else { free(g->pub); g->pub = ct_dup(name); }
    return 1;
  }
  if (!strcmp(key, "providers")) { r->which = 1; return jp_array(j, ct_index_place, r) ? 1 : -1; }
  if (!strcmp(key, "genres")) { r->which = 4; return jp_array(j, ct_index_place, r) ? 1 : -1; }
  if (!strcmp(key, "features")) { r->which = 5; return jp_array(j, ct_index_place, r) ? 1 : -1; }
  if (!strcmp(key, "year")) { if (!ct_num(j, &v, &has)) return -1; g->has_year = (uint8_t)has; g->year = (int)v; return 1; }
  if (!strcmp(key, "metacritic")) { if (!ct_num(j, &v, &has)) return -1; g->has_meta = (uint8_t)has; g->metacritic = (int)v; return 1; }
  if (!strcmp(key, "recommendations")) { if (!ct_num(j, &g->rec, &has)) return -1; g->has_rec = (uint8_t)has; return 1; }
  if (!strcmp(key, "sizeGb")) { if (!ct_num(j, &g->size_gb, &has)) return -1; g->has_size = (uint8_t)has; return 1; }
  if (!strcmp(key, "work")) { if (!ct_num(j, &v, &has)) return -1; g->work = has && v > 0 ? (int)v : -1; return 1; } // work 0 e falso no app (if (game.work))
  if (!strcmp(key, "direct")) { int b = 0; jp_ws(j); if (!jp_bool(j, &b)) return jp_skip(j) ? 1 : -1; g->direct = (uint8_t)b; return 1; }
  if (!strcmp(key, "art")) { jp_ws(j); return (j->p < j->end && *j->p == '{' ? jp_object(j, ct_index_art, r) : jp_skip(j)) ? 1 : -1; }
  return 0;
}
static int ct_index_game(JP* j, void* ctx) {
  CtIndexRead* r = ctx;
  CtGame* g = ct_new_game(r->c, "");
  g->listed = (uint8_t)!r->twin;
  r->g = g;
  return jp_object(j, ct_index_game_field, r);
}
static int ct_feature_item(JP* j, void* ctx) {
  Catalog* c = ctx;
  char* s;
  if (!ct_str(j, &s)) return 0;
  c->feature_order = realloc(c->feature_order, sizeof(int) * (size_t)(c->nfeature_order + 1));
  if (!c->feature_order) abort();
  c->feature_order[c->nfeature_order++] = ct_intern(&c->features, s ? s : "");
  free(s);
  return 1;
}
static int ct_index_top(JP* j, const char* key, void* ctx) {
  Catalog* c = ctx;
  CtIndexRead r = {c, 0, NULL, 0};
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
    if (g && s) for (char* w = strtok(s, " "); w; w = strtok(NULL, " ")) for (int k = 0; k < CT_KINDS; ++k) if (!strcmp(w, CT_KIND[k])) g->bundled_formats |= (uint16_t)(1u << k);
    free(s);
    return 1;
  }
  CtRatings r = {t->c, 0, {0, 0}, 0, 0};
  if (!jp_array(j, ct_pair_item, &r)) return -1;
  if (g && r.npair >= 2 && !r.bad) { g->has_b = 1; g->b_stars = r.pair[0]; g->b_count = (uint32_t)r.pair[1]; }
  return 1;
}
static int ct_read_table(Catalog* c, const char* path, int ratings) {
  size_t size;
  char* text = ct_read_file(path, &size);
  if (!text) return 0;
  char* open = strchr(text, '{');
  CtTable t = {c, ratings};
  JP jp = {open ? open : text, text + size, 0};
  const int ok = open && jp_object(&jp, ct_table_field, &t);
  free(text);
  return ok;
}

// ---- Indice por id ---------------------------------------------------------------------------------------------
static CtGame** g_ct_hash; static size_t g_ct_hcap;
static uint32_t ct_hash_id(const char* s) { uint32_t h = 2166136261u; for (; *s; ++s) h = (h ^ (unsigned char)*s) * 16777619u; return h; }
static void ct_hash_put(CtGame* g) {
  if (!g_ct_hcap) { g_ct_hcap = 16384; g_ct_hash = calloc(g_ct_hcap, sizeof *g_ct_hash); if (!g_ct_hash) abort(); }
  for (size_t i = ct_hash_id(g->id) & (g_ct_hcap - 1);; i = (i + 1) & (g_ct_hcap - 1))
    if (!g_ct_hash[i] || !strcmp(g_ct_hash[i]->id, g->id)) { g_ct_hash[i] = g; return; } // um id repetido: vale o ultimo (o Map do app)
}
static CtGame* ct_find_game(Catalog* c, const char* id) {
  (void)c;
  if (!g_ct_hcap) return NULL;
  for (size_t i = ct_hash_id(id) & (g_ct_hcap - 1); g_ct_hash[i]; i = (i + 1) & (g_ct_hcap - 1)) if (!strcmp(g_ct_hash[i]->id, id)) return g_ct_hash[i];
  return NULL;
}

// ---- Ordens (catalog.js SORTS), filtros (FACETS) e uma carta por jogo (oneEach) --------------------------------
static int g_ct_archive = -1; // o id de "archive.org" entre os sites
static int ct_from_archive(const CtGame* g) { return g_ct_archive >= 0 && ct_ids_has(&g->providers, g_ct_archive); }
static double ct_score(const CtGame* g) { return g->rating_count ? (g->stars * g->rating_count + 3.5 * 500) / (g->rating_count + 500.0) : 0; }
static int ct_sign(double d) { return (d > 0) - (d < 0); } // NaN = 0, como o sort do QuickJS
static int ct_cmp(int sort, const CtGame* a, const CtGame* b) {
  switch (sort) {
    case CT_RELEVANCE: { int d = ct_from_archive(b) - ct_from_archive(a); if (d) return d; return a->has_rec && b->has_rec ? ct_sign(b->rec - a->rec) : 0; }
    case CT_NEWEST: { int d = strcmp(b->release, a->release); return (d > 0) - (d < 0); }
    case CT_RATING: { int d = ct_sign(ct_score(b) - ct_score(a)); if (d) return d; return ct_sign((double)(b->has_meta ? b->metacritic : 0) - (a->has_meta ? a->metacritic : 0)); }
    case CT_SIZE: return ct_sign((b->has_size ? b->size_gb : 0) - (a->has_size ? a->size_gb : 0));
    default: { int d = strcmp(a->title, b->title); return (d > 0) - (d < 0); } // localeCompare do QuickJS: NFC + code points
  }
}
static void ct_merge_sort(CtGame** v, CtGame** tmp, int n, int sort) { // estavel, como o sort do QuickJS
  if (n < 2) return;
  int h = n / 2;
  ct_merge_sort(v, tmp, h, sort);
  ct_merge_sort(v + h, tmp, n - h, sort);
  int i = 0, k = h, o = 0;
  while (i < h && k < n) tmp[o++] = ct_cmp(sort, v[k], v[i]) < 0 ? v[k++] : v[i++];
  while (i < h) tmp[o++] = v[i++];
  while (k < n) tmp[o++] = v[k++];
  memcpy(v, tmp, sizeof *v * (size_t)n);
}
// plainTitle: minusculas, sem ™®©, sem ps4/ps5/playstation 4|5 como palavra, o resto vira um espaco.
static char* ct_plain_title(const char* title) {
  Buf a = {0};
  for (const char* p = title; *p;) {
    int l; unsigned cp = ct_cp(p, &l);
    p += l;
    if (cp == 0x2122 || cp == 0xae || cp == 0xa9) continue;
    if (cp == 0x130) { buf_str(&a, "i\xcc\x87"); continue; } // toLowerCase("İ") = "i̇"
    if (cp == 0x212a) cp = 'k';
    char u[4]; int k = ct_put(u, ct_lower_cp(cp)); buf_add(&a, u, (size_t)k);
  }
  buf_add(&a, "", 1);
  Buf b = {0};
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
  buf_add(&b, "", 1);
  free(a.data);
  Buf c = {0};
  int space = 0;
  for (const char* p = b.data; *p; ++p) {
    const int keep = (*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9');
    if (keep) { if (space && c.size) buf_str(&c, " "); space = 0; buf_add(&c, p, 1); }
    else space = 1;
  }
  buf_add(&c, "", 1);
  free(b.data);
  return c.data;
}

// ---- A montagem ---------------------------------------------------------------------------------------------------
typedef struct { const char* index; const char* formats; const char* ratings; const char* feeds[8]; int nfeeds; int low_firmware; } CtPaths;
static int g_ct_low_firmware; // 11.60 ou menos: um fpkg de PS5 tambem e "pronto" (catalog.js readyHere)
static double ct_now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
static int ct_build(const CtPaths* paths) {
  Catalog* c = &g_ct;
  const double started = ct_now_ms();
  g_ct_low_firmware = paths->low_firmware;
  size_t size;
  char* text = ct_read_file(paths->index, &size);
  if (!text) { fprintf(stderr, "catalog: %s nao abriu: %s\n", paths->index, strerror(errno)); return 0; }
  JP jp = {text, text + size, 0};
  if (!jp_object(&jp, ct_index_top, c)) { fprintf(stderr, "catalog: index.json nao leu (byte %ld: %.40s)\n", (long)(jp.p - text), jp.p); free(text); return 0; }
  free(text);
  for (int i = 0; i < c->count; ++i) ct_hash_put(c->all[i]);
  for (int i = 0; i < 6; ++i) { for (int k = 0; k < c->raw_names[i].n; ++k) free(c->raw_names[i].v[k]); free(c->raw_names[i].v); memset(&c->raw_names[i], 0, sizeof c->raw_names[i]); }
  const int bundled = c->count;
  ct_read_table(c, paths->formats, 0);
  ct_read_table(c, paths->ratings, 1);
  for (int f = 0; f < paths->nfeeds; ++f) {
    char* feed = ct_read_file(paths->feeds[f], &size);
    if (!feed) continue;
    if (ct_jlx_decode(feed, &size)) ct_read_feed(c, feed, size);
    free(feed);
  }
  // entries = [...games, ...twins]: os listados (embutidos e depois os novos dos feeds) e as outras edicoes
  CtGame** entries = malloc(sizeof *entries * (size_t)c->count);
  int n = 0;
  for (int i = 0; i < c->count; ++i) if (c->all[i]->listed) entries[n++] = c->all[i];
  c->nlisted = n;
  for (int i = 0; i < bundled; ++i) if (!c->all[i]->listed) entries[n++] = c->all[i];
  free(c->all);
  c->all = entries;
  c->listed = entries;
  g_ct_archive = ct_find(&c->providers, "archive.org");
  int max_work = -1;
  for (int i = 0; i < c->count; ++i) {
    CtGame* g = c->all[i];
    uint16_t fed = g->nrels ? ct_feed_kinds(g) : 0;
    g->formats = fed ? (uint16_t)(g->bundled_formats | fed) : g->bundled_formats;
    for (int r = 0; r < g->nrels; ++r) { CtRel* x = &g->rels[r]; free(x->url); free(x->browser); free(x->filename); free(x->format); free(x->label); free(x->record); free(x->provider); free(x->volume); }
    free(g->rels); g->rels = NULL; g->nrels = 0;
    int k;
    for (k = 0; k < g_feed_nratings; ++k) if (!strcmp(g_feed_ids[k], g->id)) break;
    if (k < g_feed_nratings) { g->stars = g_feed_stars[k]; g->rating_count = g_feed_counts[k]; }
    else if (g->has_b) { g->stars = g->b_stars; g->rating_count = g->b_count; }
    if (g->work > max_work) max_work = g->work;
  }
  free(g_feed_stars); free(g_feed_counts); free(g_feed_ids); g_feed_stars = NULL; g_feed_counts = NULL; g_feed_ids = NULL; g_feed_nratings = g_feed_capratings = 0;
  // Uma edicao sem nota fica com a da edicao da mesma obra com mais notas (a 1a delas na ordem de entries).
  for (int i = 0; i < c->count; ++i) {
    CtGame* g = c->all[i];
    if (g->rating_count || g->work < 0) continue;
    const CtGame* best = NULL;
    for (int k = 0; k < c->count; ++k) { const CtGame* e = c->all[k]; if (e->work == g->work && e->rating_count && (!best || e->rating_count > best->rating_count)) best = e; }
    if (best) { g->stars = best->stars; g->rating_count = best->rating_count; }
  }
  for (int i = 0; i < c->count; ++i) {
    CtGame* g = c->all[i];
    if (!g->title) g->title = ct_dup("");
    if (!g->dev) g->dev = ct_dup("");
    if (!g->pub) g->pub = ct_dup("");
    for (const unsigned char* p = (const unsigned char*)g->title; *p; ++p) if (*p == 0xcc || (*p == 0xcd && p[1] <= 0xaf)) { c->nfc_risk++; break; } // U+0300..U+036F
    Buf s = {0}; buf_str(&s, g->title); buf_str(&s, " "); buf_str(&s, g->dev); buf_str(&s, " "); buf_str(&s, g->pub); buf_add(&s, "", 1);
    g->search = ct_lower(s.data);
    free(s.data);
    char key[600];
    if (g->work >= 0) { snprintf(key, sizeof key, "work:%d", g->work); g->keys[g->nkeys++] = ct_dup(key); }
    if (g->rating_count >= 200) {
      snprintf(key, sizeof key, "rated:%.17g/%u", g->stars, g->rating_count); g->keys[g->nkeys++] = ct_dup(key);
      char* plain = ct_plain_title(g->title);
      snprintf(key, sizeof key, "named:%.500s/%.17g", plain, g->stars); g->keys[g->nkeys++] = ct_dup(key);
      free(plain);
    }
  }
  (void)max_work;
  // as ordens de uma vez (rank) sobre os listados
  CtGame** tmp = malloc(sizeof *tmp * (size_t)(c->nlisted + 1));
  for (int s = 0; s < CT_SORTS; ++s) {
    c->by_rank[s] = malloc(sizeof **c->by_rank * (size_t)(c->nlisted + 1));
    memcpy(c->by_rank[s], c->listed, sizeof *c->listed * (size_t)c->nlisted);
    ct_merge_sort(c->by_rank[s], tmp, c->nlisted, s);
    for (int i = 0; i < c->nlisted; ++i) c->by_rank[s][i]->rank[s] = (uint32_t)i;
  }
  free(tmp);
  // opcoes dos filtros (catalog.js facetSteps), dos listados
  int* gcount = calloc((size_t)c->genres.n + 1, sizeof(int));
  int* pcount = calloc((size_t)c->providers.n + 1, sizeof(int));
  int* pfirst = malloc(sizeof(int) * ((size_t)c->providers.n + 1));
  int kinds[CT_KINDS] = {0};
  for (int i = 0; i < c->providers.n; ++i) pfirst[i] = INT32_MAX;
  int order = 0;
  for (int i = 0; i < c->nlisted; ++i) {
    const CtGame* g = c->listed[i];
    for (int k = 0; k < g->genres.n; ++k) gcount[g->genres.v[k]]++;
    for (int k = 0; k < g->providers.n; ++k) { if (pfirst[g->providers.v[k]] == INT32_MAX) pfirst[g->providers.v[k]] = order++; pcount[g->providers.v[k]]++; }
    for (int k = 0; k < CT_KINDS; ++k) if (g->formats & (1u << k)) kinds[k]++;
  }
  c->genre_opts = malloc(sizeof(int) * ((size_t)c->genres.n + 1));
  for (int i = 0; i < c->genres.n; ++i) if (gcount[i]) c->genre_opts[c->ngenre_opts++] = i;
  for (int a = 1; a < c->ngenre_opts; ++a) for (int b = a; b > 0; --b) { // contagem decrescente, depois localeCompare
    const int x = c->genre_opts[b - 1], y = c->genre_opts[b];
    if (gcount[x] > gcount[y] || (gcount[x] == gcount[y] && strcmp(c->genres.v[x], c->genres.v[y]) <= 0)) break;
    c->genre_opts[b - 1] = y; c->genre_opts[b] = x;
  }
  c->provider_opts = malloc(sizeof(int) * ((size_t)c->providers.n + 1));
  for (int o = 0; o < order; ++o) for (int i = 0; i < c->providers.n; ++i) if (pfirst[i] == o && (pcount[i] >= 20 || !strcmp(c->providers.v[i], "overdrive cdn"))) c->provider_opts[c->nprovider_opts++] = i;
  for (int a = 1; a < c->nprovider_opts; ++a) for (int b = a; b > 0; --b) { // o CDN primeiro, depois mais jogos (estavel)
    const int x = c->provider_opts[b - 1], y = c->provider_opts[b];
    const int cx = !strcmp(c->providers.v[x], "overdrive cdn"), cy = !strcmp(c->providers.v[y], "overdrive cdn");
    if (cx > cy || (cx == cy && pcount[x] >= pcount[y])) break;
    c->provider_opts[b - 1] = y; c->provider_opts[b] = x;
  }
  c->format_opts = malloc(sizeof(char*) * (CT_KINDS + 1));
  c->format_opts[c->nformat_opts++] = "ready";
  for (int k = 0; k < CT_KINDS; ++k) if (kinds[k] >= 5) c->format_opts[c->nformat_opts++] = (char*)CT_KIND[k];
  free(gcount); free(pcount); free(pfirst);
  c->build_ms = ct_now_ms() - started;
  return 1;
}

// ---- Consulta ------------------------------------------------------------------------------------------------------
typedef struct { char* v[64]; int n; } CtPicked;
static int ct_has(const CtGame* g, int facet, const char* value) {
  switch (facet) {
    case CF_PLATFORM: return !strcmp(value, g->platform ? "ps4" : "ps5");
    case CF_FORMAT:
      if (!strcmp(value, "ready")) return (g->formats & CT_READY_MASK) || (g_ct_low_firmware && !g->platform && (g->formats & (1u << 6)));
      for (int k = 0; k < CT_KINDS; ++k) if (!strcmp(value, CT_KIND[k])) return (g->formats >> k) & 1;
      return 0;
    case CF_ACCESS: return g->direct;
    case CF_GENRE: { int id = ct_find(&g_ct.genres, value); return id >= 0 && ct_ids_has(&g->genres, id); }
    case CF_FEATURE: { int id = ct_find(&g_ct.features, value); return id >= 0 && ct_ids_has(&g->features, id); }
    case CF_RELEASE:
      if (!g->has_year) return 0;
      return !strcmp(value, "recent") ? g->year >= 2024 : !strcmp(value, "current") ? g->year >= 2020 && g->year <= 2023 : !strcmp(value, "older") ? g->year < 2020 : 0;
    case CF_SIZE:
      if (!g->has_size) return 0;
      return !strcmp(value, "small") ? g->size_gb < 10 : !strcmp(value, "medium") ? g->size_gb >= 10 && g->size_gb <= 50 : !strcmp(value, "large") ? g->size_gb > 50 : 0;
    default: { int id = ct_find(&g_ct.providers, value); return id >= 0 && ct_ids_has(&g->providers, id); }
  }
}
static int ct_passes(const CtGame* g, const CtPicked* picked, const char* q) {
  if (q[0] && !strstr(g->search, q)) return 0;
  for (int f = 0; f < CF_COUNT; ++f) {
    if (!picked[f].n) continue;
    int any = 0, all = 1;
    for (int i = 0; i < picked[f].n; ++i) { if (ct_has(g, f, picked[f].v[i])) any = 1; else all = 0; }
    if (CT_FACET_ANY[f] ? !any : !all) return 0;
  }
  return 1;
}
typedef struct { const char** v; size_t cap, n; } CtSeen;
static int ct_seen_has(CtSeen* s, const char* key) {
  for (size_t i = ct_hash_id(key) & (s->cap - 1); s->v[i]; i = (i + 1) & (s->cap - 1)) if (!strcmp(s->v[i], key)) return 1;
  return 0;
}
static void ct_seen_add(CtSeen* s, const char* key) {
  size_t i = ct_hash_id(key) & (s->cap - 1);
  while (s->v[i]) { if (!strcmp(s->v[i], key)) return; i = (i + 1) & (s->cap - 1); }
  s->v[i] = key; s->n++;
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
// GET /api/catalog: a grade de browse/Catalog.jsx (gridOf), paginada.
static void ct_page(const char* query, Buf* out) {
  Catalog* c = &g_ct;
  CtPicked picked[CF_COUNT];
  memset(picked, 0, sizeof picked);
  char* copy = ct_dup(query ? query : "");
  char* q = ct_dup("");
  int page = 0, per = 60, sort = CT_RELEVANCE;
  for (char* save = NULL, *pair = strtok_r(copy, "&", &save); pair; pair = strtok_r(NULL, "&", &save)) {
    char* eq = strchr(pair, '=');
    if (!eq) continue;
    *eq = 0;
    char* value = eq + 1;
    ct_url_decode(value);
    if (!strcmp(pair, "page")) page = atoi(value);
    else if (!strcmp(pair, "per")) per = atoi(value);
    else if (!strcmp(pair, "sort")) { for (int s = 0; s < CT_SORTS; ++s) if (!strcmp(value, CT_SORT_KEYS[s])) sort = s; }
    else if (!strcmp(pair, "q")) { free(q); q = ct_text(value, 1 << 20); char* low = ct_lower(q); free(q); q = low; }
    else for (int f = 0; f < CF_COUNT; ++f) if (!strcmp(pair, CT_FACET_KEYS[f])) {
      for (char* s2 = NULL, *v = strtok_r(value, ",", &s2); v && picked[f].n < 64; v = strtok_r(NULL, ",", &s2)) picked[f].v[picked[f].n++] = v;
    }
  }
  if (per < 1) per = 1;
  if (per > 500) per = 500;
  if (page < 0) page = 0;
  const int every = picked[CF_PLATFORM].n || q[0];
  CtSeen seen = {0};
  if (!every) { seen.cap = 16384; seen.v = calloc(seen.cap, sizeof *seen.v); }
  int total = 0;
  const int from = page * per, to = from + per;
  buf_fmt(out, "{\"ok\":true,\"sort\":\"%s\",\"page\":%d,\"per\":%d,\"games\":[", CT_SORT_KEYS[sort], page, per);
  for (int i = 0; i < c->nlisted; ++i) {
    const CtGame* g = c->by_rank[sort][i];
    if (!ct_passes(g, picked, q)) continue;
    if (!every) { // oneEach
      int dup = 0;
      for (int k = 0; k < g->nkeys; ++k) if (ct_seen_has(&seen, g->keys[k])) dup = 1;
      if (dup) continue;
      for (int k = 0; k < g->nkeys; ++k) ct_seen_add(&seen, g->keys[k]);
    }
    if (total >= from && total < to) {
      if (total > from) buf_str(out, ",");
      buf_str(out, "{\"id\":"); buf_json(out, g->id);
      buf_str(out, ",\"title\":"); buf_json(out, g->title);
      buf_fmt(out, ",\"platform\":\"%s\",\"formats\":[", g->platform ? "ps4" : "ps5");
      for (int k = 0, m = 0; k < CT_KINDS; ++k) if (g->formats & (1u << k)) buf_fmt(out, "%s\"%s\"", m++ ? "," : "", CT_KIND[k]);
      buf_fmt(out, "],\"direct\":%s", g->direct ? "true" : "false");
      if (g->has_size) buf_fmt(out, ",\"sizeGb\":%.17g", g->size_gb); else buf_str(out, ",\"sizeGb\":null");
      if (g->rating_count) buf_fmt(out, ",\"stars\":%.17g,\"ratingCount\":%u", g->stars, g->rating_count); else buf_str(out, ",\"stars\":null,\"ratingCount\":null");
      buf_str(out, ",\"cover\":"); buf_json(out, g->cover ? g->cover : "");
      buf_str(out, "}");
    }
    ++total;
  }
  buf_fmt(out, "],\"total\":%d}", total);
  free(seen.v); free(copy); free(q);
}
// GET /api/catalog/options: as opcoes de cada filtro, na ordem do app.
static void ct_options(Buf* out) {
  Catalog* c = &g_ct;
  buf_str(out, "{\"platform\":[\"ps5\",\"ps4\"],\"format\":[");
  for (int i = 0; i < c->nformat_opts; ++i) { if (i) buf_str(out, ","); buf_json(out, c->format_opts[i]); }
  buf_str(out, "],\"access\":[\"direct\"],\"genre\":[");
  for (int i = 0; i < c->ngenre_opts; ++i) { if (i) buf_str(out, ","); buf_json(out, c->genres.v[c->genre_opts[i]]); }
  buf_str(out, "],\"feature\":[");
  for (int i = 0; i < c->nfeature_order; ++i) { if (i) buf_str(out, ","); buf_json(out, c->features.v[c->feature_order[i]]); }
  buf_str(out, "],\"release\":[\"recent\",\"current\",\"older\"],\"size\":[\"small\",\"medium\",\"large\"],\"provider\":[");
  for (int i = 0; i < c->nprovider_opts; ++i) { if (i) buf_str(out, ","); buf_json(out, c->providers.v[c->provider_opts[i]]); }
  buf_fmt(out, "],\"listed\":%d,\"entries\":%d,\"buildMs\":%.1f,\"nfcRisk\":%d}", c->nlisted, c->count, c->build_ms, c->nfc_risk);
}
