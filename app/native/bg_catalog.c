// Fase 3 (13/11/2026): o catalogo da loja montado no payload, em C, a partir dos mesmos arquivos que o app le: o catalogo
// embutido (index.json, formats.js, ratings.js, packs/ e art/ que o app copia para /data/JobeesLair/catalog/bundled), o
// catalogo ao vivo (live.jlx), as listas do jogador (web, Pegasus "packages" e arquivos do PS5) e a lista Orbit.
//   bg_catalog.c        texto (NFC, minusculas, stableKey), links, feeds e o catalogo embutido (a leitura)
//   bg_catalog_query.c  a montagem e as consultas (grade, filtros e contagens, pagina inicial, relacionados, busca, ficha)
//   bg_catalog_api.c    a thread que monta e troca o catalogo, os feeds baixados pelo payload, o teto de memoria e as rotas
// Incluido depois de bg_store.c (usa JP, Buf, buf_json e os ajudantes do bg_downloader.c).
//
// Regras copiadas do app (cada bloco diz de onde): feed-format.js (game, release, fromPackages, stableKey, text),
// download-sources.js (webURL, isMagnetLink, sourceKind), release-sets.js (releaseSets, releaseType), formats.js,
// catalog.js (buildSteps, SORTS, FACETS, passes, matching, facetCounts, oneEach, otherThan, topRated, relatedGames,
// editionsOf), store-mode.js (catalogos escondidos), browse/Lanes.jsx + featured.js + PopularRail.jsx + CdnRail.jsx (as
// fileiras da pagina inicial), search/match.js (a busca da tela Procurar) e game/sources.js (a ordem e o tipo dos links).
// O ponto critico, a ordem: o localeCompare do QuickJS-ng 0.15 (o motor do ps5-react) e NFC + comparar code points, e o
// sort do QuickJS e estavel. Cada ordem e calculada uma vez na montagem (rank) sobre o titulo em NFC.
//
// Memoria: tudo o que o catalogo guarda (e os arquivos lidos durante a montagem) passa por ct_malloc, que conta os bytes
// vivos e o pico; a montagem para entre uma fase e outra quando passa do teto (bg_catalog_api.c: o app continua no caminho
// antigo). Nada de coletor de lixo: ~2 KB por jogo.

#include <math.h>
#include "bg_unicode.h"

// floor sem a libm (o payload de PC dos testes nao liga -lm): os numeros daqui cabem num int64.
static double ct_floor(double x) { if (!(x == x) || x > 9e18 || x < -9e18) return x; const double t = (double)(long long)x; return t > x ? t - 1 : t; }

// ---- Memoria contada -----------------------------------------------------------------------------------------
static size_t g_ctm_live, g_ctm_peak; // bytes vivos de todos os catalogos + temporarios da montagem; o pico desde ct_mem_mark
static void ct_mem_add(ptrdiff_t n) {
  const size_t now = __atomic_add_fetch(&g_ctm_live, (size_t)n, __ATOMIC_RELAXED);
  size_t peak = __atomic_load_n(&g_ctm_peak, __ATOMIC_RELAXED);
  while (now > peak && !__atomic_compare_exchange_n(&g_ctm_peak, &peak, now, 1, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {}
}
static void ct_mem_mark(void) { __atomic_store_n(&g_ctm_peak, __atomic_load_n(&g_ctm_live, __ATOMIC_RELAXED), __ATOMIC_RELAXED); }
#define CT_HEAD 16
static void* ct_malloc(size_t n) {
  char* p = malloc(n + CT_HEAD);
  if (!p) abort();
  *(size_t*)p = n;
  ct_mem_add((ptrdiff_t)n);
  return p + CT_HEAD;
}
static void* ct_calloc(size_t a, size_t b) { void* p = ct_malloc(a * b); memset(p, 0, a * b); return p; }
static void ct_free(void* q) {
  if (!q) return;
  char* p = (char*)q - CT_HEAD;
  ct_mem_add(-(ptrdiff_t)*(size_t*)p);
  free(p);
}
static void* ct_realloc(void* q, size_t n) {
  if (!q) return ct_malloc(n);
  char* p = (char*)q - CT_HEAD;
  const size_t old = *(size_t*)p;
  char* next = realloc(p, n + CT_HEAD);
  if (!next) abort();
  *(size_t*)next = n;
  ct_mem_add((ptrdiff_t)n - (ptrdiff_t)old);
  return next + CT_HEAD;
}
static char* ct_dup(const char* s) { if (!s) s = ""; size_t n = strlen(s); char* d = ct_malloc(n + 1); memcpy(d, s, n + 1); return d; }
static char* ct_ndup(const char* s, size_t n) { char* d = ct_malloc(n + 1); memcpy(d, s, n); d[n] = 0; return d; }
// Um Buf (bg_downloader.c) passado a memoria contada.
static char* ct_take(Buf* b) { char* s = ct_ndup(b->data ? b->data : "", b->size); free(b->data); memset(b, 0, sizeof *b); return s; }

// ---- Constantes da loja ----------------------------------------------------------------------------------------
#define CT_KINDS 7
static const char* const CT_KIND[CT_KINDS] = {"folder", "exfat", "ffpkg", "ffpfs", "image", "backport", "fpkg"};
#define CT_READY_MASK 0x1fu // folder, exfat, ffpkg, ffpfs, image (formats.js READY)
enum { CT_RELEVANCE, CT_NEWEST, CT_RATING, CT_SIZE, CT_TITLE, CT_SORTS };
static const char* const CT_SORT_KEYS[CT_SORTS] = {"relevance", "newest", "rating", "size", "title"};
enum { CF_PLATFORM, CF_FORMAT, CF_ACCESS, CF_GENRE, CF_FEATURE, CF_RELEASE, CF_SIZE, CF_PROVIDER, CF_COUNT };
static const char* const CT_FACET_KEYS[CF_COUNT] = {"platform", "format", "access", "genre", "feature", "release", "size", "provider"};
static const int CT_FACET_ANY[CF_COUNT] = {1, 1, 0, 0, 0, 1, 1, 1};
#define CT_MAX_FEEDS 50
#define CT_LIVE_FEED "https://raw.githubusercontent.com/JVK3R/JobeesLair/main/catalog/live.json"
#define CT_CDN_HOST "overdrive cdn"

typedef struct { char** v; int n, cap; } CtNames; // textos unicos (generos, recursos, sites)
typedef struct { uint16_t* v; uint8_t n, cap; } CtIds;
typedef struct CtGame {
  char id[10], release[11], added[11];
  char *title, *sort_title, *dev, *pub, *cover, *tint, *search, *fold, *keys[3];
  uint8_t platform, direct, listed, shown, nkeys, has_size, has_year, has_meta, has_rec, from_feed, has_b, hero, logo, feed_solo;
  uint16_t formats, bundled_formats;
  double size_gb, stars, rec, b_stars;
  uint32_t rating_count, b_count;
  int year, metacritic, work, entry, page_feed; // page_feed: o feed de onde vem a pagina (-1 embutido)
  int lazy[3];                                   // art/<arquivo>.json, posicao, mascara (embutido)
  uint64_t sources;                              // bit 0 embutido, bit 1 + i o feed i
  CtIds genres, features, providers;
  uint32_t rank[CT_SORTS];
  struct CtRel* rels; int nrels, caprels;        // os links dos feeds (so durante a montagem)
} CtGame;
typedef struct { char* url; char* name; char* path; int count, games, ok; } CtFeedInfo;
typedef struct Catalog {
  int refs;
  CtGame** all; int count, cap;  // entries: os listados (games) e as outras edicoes (twins)
  CtGame** listed; int nlisted;  // allListed (catalog.js), na ordem do app
  CtGame** games; int ngames;    // a lista da loja (store-mode.js: sem os catalogos escondidos)
  CtGame** by_rank[CT_SORTS];    // os listados (allListed) em cada ordem
  CtGame** hash; size_t hcap;
  CtNames genres, features, providers, raw_names[6];
  int* feature_order; int nfeature_order;
  const char* format_opts[CT_KINDS + 1]; int nformat_opts;
  int* provider_opts; int nprovider_opts;
  int* genre_opts; int ngenre_opts;
  char (*feed_ids)[10]; double* feed_stars; uint32_t* feed_counts; int nratings, capratings; // as notas dos feeds
  CtFeedInfo feeds[CT_MAX_FEEDS]; int nfeeds;
  int bundled_count, nfc_risk, ps4, low_firmware, cover_width;
  uint64_t hidden;               // os catalogos escondidos (bit 0 embutido, bit 1 + i o feed i)
  char low_text[16], bundled_dir[600], app_version[64], firmware[32];
  char (*known)[10]; int nknown; // os codigos que a lista Orbit nao precisa mandar inteiros (setOrbitKnown)
  double build_ms;
  double phase_ms[8];             // index, tabelas, feeds, formatos, notas, textos, ordens, filtros (ms desde o inicio)
  size_t bytes, peak;            // o que o catalogo guarda e o pico da montagem (ct_malloc)
  uint8_t* solo;                 // por entrada: 1 o payload baixa sozinho, 0 nao, 255 ainda nao calculado (store-export soloLink)
  int solo_done;                 // os links do pacote ja foram lidos (a 2a fase, depois da troca)
  int archive;                   // o id de "archive.org" entre os sites
  int cdn;                       // o id de "overdrive cdn"
} Catalog;

static int ct_intern(CtNames* t, const char* s) {
  for (int i = 0; i < t->n; ++i) if (!strcmp(t->v[i], s)) return i;
  if (t->n == t->cap) { t->cap = t->cap ? t->cap * 2 : 32; t->v = ct_realloc(t->v, sizeof *t->v * (size_t)t->cap); }
  t->v[t->n] = ct_dup(s);
  return t->n++;
}
static void ct_names_free(CtNames* t) { for (int i = 0; i < t->n; ++i) ct_free(t->v[i]); ct_free(t->v); memset(t, 0, sizeof *t); }
static int ct_find(const CtNames* t, const char* s) { for (int i = 0; i < t->n; ++i) if (!strcmp(t->v[i], s)) return i; return -1; }
static int ct_ids_has(const CtIds* l, int id) { for (int i = 0; i < l->n; ++i) if (l->v[i] == id) return 1; return 0; }
static void ct_ids_add(CtIds* l, int id) { // sem repetir, na ordem (o new Set do app)
  if (id < 0 || ct_ids_has(l, id) || l->n == 255) return;
  if (l->n == l->cap) { l->cap = l->cap ? (uint8_t)(l->cap * 2 > 255 ? 255 : l->cap * 2) : 4; l->v = ct_realloc(l->v, sizeof *l->v * l->cap); }
  l->v[l->n++] = (uint16_t)id;
}

// ---- Texto como o JS ve ------------------------------------------------------------------------------------------
static int ct_utf8_len(unsigned char c) { return c < 0x80 ? 1 : c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1; }
static unsigned ct_cp(const char* s, int* len) {
  const unsigned char* p = (const unsigned char*)s;
  *len = ct_utf8_len(p[0]);
  if (*len == 1) return p[0];
  for (int k = 1; k < *len; ++k) if (!p[k]) { *len = 1; return p[0]; }
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
static void ct_buf_cp(Buf* b, unsigned cp) { char u[4]; buf_add(b, u, (size_t)ct_put(u, cp)); }
// O espaco do trim() do JS (WhiteSpace + LineTerminator).
static int ct_js_space(unsigned cp) {
  return cp == 9 || cp == 10 || cp == 11 || cp == 12 || cp == 13 || cp == 32 || cp == 0xa0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200a) ||
         cp == 0x2028 || cp == 0x2029 || cp == 0x202f || cp == 0x205f || cp == 0x3000 || cp == 0xfeff;
}
// Um texto com o trim() do JS (malloc comum).
static char* ct_trim_plain(const char* in) {
  const char* start = in; const char* end = in + strlen(in);
  for (;;) { int l; if (start < end && ct_js_space(ct_cp(start, &l))) start += l; else break; }
  while (end > start) {
    const char* p = end - 1;
    while (p > start && ((unsigned char)*p & 0xc0) == 0x80) --p;
    int l; if (ct_js_space(ct_cp(p, &l))) end = p; else break;
  }
  char* out = malloc((size_t)(end - start) + 1);
  if (!out) abort();
  memcpy(out, start, (size_t)(end - start)); out[end - start] = 0;
  return out;
}
// feed-format.js text(value, max): controles viram um espaco, trim, e no maximo `max` unidades UTF-16 (memoria contada).
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
  char* t = ct_trim_plain(tmp);
  free(tmp);
  int units = 0; char* p = t;
  while (*p) { int l = ct_utf8_len((unsigned char)*p); int u = l == 4 ? 2 : 1; if (units + u > max) break; units += u; p += l; }
  *p = 0;
  char* out = ct_dup(t);
  free(t);
  return out;
}
// toLowerCase de um code point (tabela do QuickJS-ng 0.15); o sigma final e o U+0130 ficam com ct_lower_into.
static unsigned ct_lower_cp(unsigned cp) {
  if (cp < 0x80) return cp >= 'A' && cp <= 'Z' ? cp + 32 : cp;
  int lo = 0, hi = UNI_LOWER_COUNT - 1;
  while (lo <= hi) {
    const int mid = (lo + hi) / 2;
    if (cp < UNI_LOWER[mid].from) hi = mid - 1;
    else if (cp > UNI_LOWER[mid].to) lo = mid + 1;
    else {
      if (UNI_LOWER[mid].step == 2 && ((cp - UNI_LOWER[mid].from) & 1)) return cp;
      return (unsigned)((int)cp + UNI_LOWER[mid].delta);
    }
  }
  return cp;
}
// Final_Sigma: "cased" e "case-ignorable" aproximados (letras com caixa nos dois sentidos; apostrofos, pontos e as marcas
// combinantes basicas). Basta para os titulos (o teste confere com o qjs).
static int ct_is_cased(unsigned cp) {
  if ((cp | 32) >= 'a' && (cp | 32) <= 'z') return 1;
  if (cp < 0xaa) return 0;
  if (ct_lower_cp(cp) != cp) return 1;
  for (int i = 0; i < UNI_LOWER_COUNT; ++i) { // e a minuscula de alguem?
    const unsigned from = (unsigned)((int)UNI_LOWER[i].from + UNI_LOWER[i].delta), to = (unsigned)((int)UNI_LOWER[i].to + UNI_LOWER[i].delta);
    if (cp >= from && cp <= to && (UNI_LOWER[i].step != 2 || !((cp - from) & 1))) return 1;
  }
  return cp == 0xdf || cp == 0x3c2;
}
static int ct_is_ignorable(unsigned cp) { return cp == '\'' || cp == '.' || cp == ':' || cp == 0xb7 || cp == 0x2019 || cp == 0xad || cp == 0x5e || cp == 0x60 || (cp >= 0x300 && cp <= 0x36f); }
// String.prototype.toLowerCase completo: tabela + U+0130 ("i" + U+0307) + sigma final.
static void ct_lower_into(Buf* b, const char* s) {
  const size_t n = strlen(s);
  for (size_t i = 0; i < n;) {
    int l; unsigned cp = ct_cp(s + i, &l);
    if (cp < 0x80) { char c = (char)(cp >= 'A' && cp <= 'Z' ? cp + 32 : cp); buf_add(b, &c, 1); ++i; continue; }
    if (cp == 0x130) { buf_str(b, "i\xcc\x87"); i += (size_t)l; continue; }
    if (cp == 0x3a3) {
      int before = 0, after = 0;
      for (size_t k = i; k > 0;) { // antes: uma letra com caixa (pulando as ignoraveis)
        size_t p = k - 1; while (p > 0 && ((unsigned char)s[p] & 0xc0) == 0x80) --p;
        int pl; unsigned c = ct_cp(s + p, &pl);
        k = p;
        if (ct_is_ignorable(c)) continue;
        before = ct_is_cased(c);
        break;
      }
      for (size_t k = i + (size_t)l; k < n;) {
        int nl; unsigned c = ct_cp(s + k, &nl);
        k += (size_t)nl;
        if (ct_is_ignorable(c)) continue;
        after = ct_is_cased(c);
        break;
      }
      ct_buf_cp(b, before && !after ? 0x3c2 : 0x3c3);
      i += (size_t)l;
      continue;
    }
    ct_buf_cp(b, ct_lower_cp(cp));
    i += (size_t)l;
  }
}
static char* ct_lower_plain(const char* s) { Buf b = {0}; buf_add(&b, "", 0); ct_lower_into(&b, s); if (!b.data) { b.data = strdup(""); if (!b.data) abort(); } return b.data; }
static char* ct_lower(const char* s) { char* p = ct_lower_plain(s); char* d = ct_dup(p); free(p); return d; }

// NFC/NFD (bg_unicode.h).
static int ct_ccc(unsigned cp) {
  if (cp < 0x300) return 0;
  int lo = 0, hi = UNI_CCC_COUNT - 1;
  while (lo <= hi) { const int mid = (lo + hi) / 2; if (cp < UNI_CCC[mid].from) hi = mid - 1; else if (cp > UNI_CCC[mid].to) lo = mid + 1; else return UNI_CCC[mid].ccc; }
  return 0;
}
static const uint32_t* ct_decomp(unsigned cp) {
  if (cp < 0xc0) return NULL;
  int lo = 0, hi = UNI_DECOMP_COUNT - 1;
  while (lo <= hi) { const int mid = (lo + hi) / 2; if (cp < UNI_DECOMP[mid][0]) hi = mid - 1; else if (cp > UNI_DECOMP[mid][0]) lo = mid + 1; else return UNI_DECOMP[mid]; }
  return NULL;
}
static unsigned ct_compose(unsigned a, unsigned b) {
  if (a >= 0x1100 && a < 0x1113 && b >= 0x1161 && b < 0x1176) return 0xac00 + ((a - 0x1100) * 21 + (b - 0x1161)) * 28;
  if (a >= 0xac00 && a < 0xac00 + 11172 && !((a - 0xac00) % 28) && b > 0x11a7 && b < 0x11c3) return a + (b - 0x11a7);
  const uint64_t key = ((uint64_t)a << 21) | b;
  int lo = 0, hi = UNI_COMP_COUNT - 1;
  while (lo <= hi) { const int mid = (lo + hi) / 2; if (key < UNI_COMP[mid].pair) hi = mid - 1; else if (key > UNI_COMP[mid].pair) lo = mid + 1; else return UNI_COMP[mid].cp; }
  return 0;
}
typedef struct { uint32_t* v; size_t n, cap; } CtCps;
static void ct_cps_add(CtCps* c, uint32_t cp) {
  if (c->n == c->cap) { c->cap = c->cap ? c->cap * 2 : 64; c->v = realloc(c->v, c->cap * sizeof *c->v); if (!c->v) abort(); }
  c->v[c->n++] = cp;
}
static void ct_decompose(CtCps* out, unsigned cp, int depth) {
  if (cp >= 0xac00 && cp < 0xac00 + 11172) {
    const unsigned s = cp - 0xac00;
    ct_cps_add(out, 0x1100 + s / (21 * 28)); ct_cps_add(out, 0x1161 + (s % (21 * 28)) / 28);
    if (s % 28) ct_cps_add(out, 0x11a7 + s % 28);
    return;
  }
  const uint32_t* d = depth < 8 ? ct_decomp(cp) : NULL;
  if (!d) { ct_cps_add(out, cp); return; }
  ct_decompose(out, d[1], depth + 1);
  if (d[2]) ct_decompose(out, d[2], depth + 1);
}
// NFD (compose = 0) ou NFC (1) de um texto UTF-8 (malloc comum).
static char* ct_normalize(const char* s, int compose) {
  CtCps c = {0};
  for (const char* p = s; *p;) { int l; unsigned cp = ct_cp(p, &l); p += l; ct_decompose(&c, cp, 0); }
  for (size_t i = 1; i < c.n; ++i) { // ordem canonica (estavel)
    for (size_t k = i; k > 0; --k) {
      const int a = ct_ccc(c.v[k - 1]), b = ct_ccc(c.v[k]);
      if (!b || a <= b) break;
      uint32_t t = c.v[k]; c.v[k] = c.v[k - 1]; c.v[k - 1] = t;
    }
  }
  if (compose && c.n) {
    size_t starter = 0, o = 1;
    int have_starter = !ct_ccc(c.v[0]);
    int last = have_starter ? 0 : 256; // o ccc do ultimo que ficou depois do starter (0: nenhum)
    for (size_t i = 1; i < c.n; ++i) {
      const unsigned cp = c.v[i];
      const int cc = ct_ccc(cp);
      const int blocked = o > starter + 1 && (last == 0 || last >= cc);
      const unsigned composed = have_starter && !blocked ? ct_compose(c.v[starter], cp) : 0;
      if (composed) { c.v[starter] = composed; continue; }
      if (!cc) { starter = o; have_starter = 1; last = 0; }
      else last = cc;
      c.v[o++] = cp;
    }
    c.n = o;
  }
  Buf b = {0};
  buf_add(&b, "", 0);
  for (size_t i = 0; i < c.n; ++i) ct_buf_cp(&b, c.v[i]);
  free(c.v);
  if (!b.data) { b.data = strdup(""); if (!b.data) abort(); }
  return b.data;
}
static int ct_ascii(const char* s) { for (; *s; ++s) if ((unsigned char)*s >= 0x80) return 0; return 1; }
// search/match.js fold: toLowerCase, NFD, sem U+0300..U+036F (memoria contada).
static char* ct_fold(const char* s) {
  char* low = ct_lower_plain(s);
  if (ct_ascii(low)) { char* d = ct_dup(low); free(low); return d; }
  char* nfd = ct_normalize(low, 0);
  free(low);
  Buf b = {0};
  buf_add(&b, "", 0);
  for (const char* p = nfd; *p;) { int l; unsigned cp = ct_cp(p, &l); if (cp < 0x300 || cp > 0x36f) buf_add(&b, p, (size_t)l); p += l; }
  free(nfd);
  return ct_take(&b);
}
// feed-format.js / release-sets.js stableKey: FNV-1a e djb2 sobre as unidades UTF-16 do texto.
static void ct_stable_key(const char* s, char out[20]) {
  uint32_t first = 2166136261u, second = 5381u;
  for (const char* p = s; *p;) {
    int l; unsigned cp = ct_cp(p, &l); p += l;
    unsigned units[2]; int n = 1;
    if (cp >= 0x10000) { units[0] = 0xd800 + ((cp - 0x10000) >> 10); units[1] = 0xdc00 + ((cp - 0x10000) & 0x3ff); n = 2; } else units[0] = cp;
    for (int k = 0; k < n; ++k) { first = (first ^ units[k]) * 16777619u; second = (second * 33u) ^ units[k]; }
  }
  snprintf(out, 20, "%x%x", first, second);
}
// decodeURIComponent: NULL quando o JS jogaria URIError (% sem 2 hex, ou bytes que nao sao UTF-8). malloc comum.
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
  for (size_t i = 0; i < o;) {
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

// ---- download-sources.js webURL / isMagnetLink / sourceKind ----------------------------------------------------
typedef struct { char host[256]; const char* path; } CtUrl;
static int ct_weburl(const char* v, CtUrl* u) {
  if (!v) return 0;
  size_t n = strlen(v);
  if (n > 8192) return 0;
  for (size_t i = 0; i < n; ++i) {
    unsigned char c = (unsigned char)v[i];
    if (c <= 0x20 || c == '\\') return 0;
    if (c == 0xc2 && (unsigned char)v[i + 1] == 0xa0) return 0; // \s do JS
    if (c == 0xe2 && (unsigned char)v[i + 1] == 0x80 && (((unsigned char)v[i + 2] >= 0x80 && (unsigned char)v[i + 2] <= 0x8a) || (unsigned char)v[i + 2] == 0xa8 || (unsigned char)v[i + 2] == 0xa9 || (unsigned char)v[i + 2] == 0xaf)) return 0;
    if (c == 0xe2 && (unsigned char)v[i + 1] == 0x81 && (unsigned char)v[i + 2] == 0x9f) return 0;
    if (c == 0xe1 && (unsigned char)v[i + 1] == 0x9a && (unsigned char)v[i + 2] == 0x80) return 0;
    if (c == 0xe3 && (unsigned char)v[i + 1] == 0x80 && (unsigned char)v[i + 2] == 0x80) return 0;
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
  if (!v) return 0;
  size_t n = strlen(v);
  if (n > 8192 || strncasecmp(v, "magnet:?", 8)) return 0;
  for (size_t i = 0; i < n; ++i) if ((unsigned char)v[i] <= 0x20) return 0;
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
enum { SK_DIRECT, SK_TORRENT, SK_UNAVAILABLE, SK_BROWSER, SK_MEDIAFIRE, SK_BUZZHEAVIER, SK_VIKINGFILE, SK_DATANODES, SK_FILEKEEPER, SK_ROOTZ, SK_INVALID };
// sourceKind (sem debrid/manifest, que um link do catalogo nunca tem). SK_INVALID: o JS jogaria (webURL).
static int ct_source_kind(const char* url, const char* browser, int requires_browser, const char* source) {
  const char* value = browser && *browser ? browser : url;
  if (!value || !*value) return SK_UNAVAILABLE;
  if (ct_magnet(value)) return SK_TORRENT;
  CtUrl u;
  if (!ct_weburl(value, &u)) return SK_INVALID;
  static const char* const HOSTS[][2] = {{"mediafire.com", NULL}, {"buzzheavier.com", NULL}, {"vikingfile.com", "vik1ngfile.site"}, {"datanodes.to", NULL}, {"filekeeper.net", NULL}, {"rootz.so", NULL}};
  for (int i = 0; i < 6; ++i) {
    if (!ct_is_host(u.host, HOSTS[i][0]) && !(HOSTS[i][1] && ct_is_host(u.host, HOSTS[i][1]))) continue;
    if (i == 0 && !strncmp(u.host, "download", 8)) return SK_DIRECT;
    if (i == 2 && !strncmp(u.path, "/d/", 3) && !(browser && *browser)) return SK_DIRECT;
    return SK_MEDIAFIRE + i;
  }
  if ((!strcmp(u.host, "archive.org") && !strncmp(u.path, "/download/", 10)) || (!strcmp(u.host, "github.com") && strstr(u.path, "/releases/download/"))) return SK_DIRECT;
  static const char* const EXT[] = {".ffpfsc", ".ffpfs", ".ffpkg", ".exfat", ".pkg", ".zip", ".rar", ".7z"};
  for (const char* p = u.path; *p; ++p) {
    if (*p != '.') continue;
    for (size_t e = 0; e < sizeof EXT / sizeof *EXT; ++e) {
      size_t k = strlen(EXT[e]);
      if (!strncasecmp(p, EXT[e], k) && (p[k] == 0 || p[k] == '?' || p[k] == '#')) return SK_DIRECT;
    }
  }
  if (requires_browser || (source && !strncmp(source, "pegasus", 7))) return SK_BROWSER;
  return SK_DIRECT;
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

// ---- Um link (os campos que os links do catalogo embutido e dos feeds tem) ---------------------------------------
typedef struct CtRel {
  char *id, *format, *filename, *url, *browser, *version, *category, *provider, *source, *flow, *label, *record, *volume, *password, *unavailable,
      *platform, *health, *sha256;
  double size; uint8_t has_size, requires_browser, patch, object;
} CtRel;
#define CT_REL_FIELDS 18
static char** ct_rel_slot(CtRel* r, int i) { return &(&r->id)[i]; }
static void ct_rel_free(CtRel* r) { for (int i = 0; i < CT_REL_FIELDS; ++i) ct_free(*ct_rel_slot(r, i)); memset(r, 0, sizeof *r); }
static const char* ct_s(const char* s) { return s ? s : ""; }
static int ct_patch_text(const char* text) { // /backport[+_ -]*files/i
  for (const char* p = text; *p; ++p) {
    if (strncasecmp(p, "backport", 8)) continue;
    const char* q = p + 8;
    while (*q == '+' || *q == '_' || *q == ' ' || *q == '-') ++q;
    if (!strncasecmp(q, "files", 5)) return 1;
  }
  return 0;
}
static void ct_rel_patch(CtRel* r) { // release-sets.js isPatchOnly
  Buf pt = {0};
  buf_str(&pt, ct_s(r->url)); buf_str(&pt, " "); buf_str(&pt, ct_s(r->browser)); buf_str(&pt, " "); buf_str(&pt, ct_s(r->label));
  r->patch = (uint8_t)ct_patch_text(pt.data ? pt.data : "");
  free(pt.data);
}

// (?<![a-z0-9])(?:corpo)(?![a-z0-9]) com /i: `body` diz quantos bytes o corpo casa em p (0 = nao casa).
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
static size_t ct_b_ffpfs(const char* p) {
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
// /\bpart\s*(\d+)\b/i: 1 com o numero, e onde o trecho comeca e acaba.
static int ct_part(const char* s, double* number, size_t* at, size_t* end) {
  for (size_t i = 0; s[i]; ++i) {
    if (i > 0 && (ct_alnum((unsigned char)s[i - 1]) || s[i - 1] == '_')) continue;
    if (strncasecmp(s + i, "part", 4)) continue;
    size_t k = i + 4;
    while (s[k] && ct_ws((unsigned char)s[k])) ++k;
    if (!isdigit((unsigned char)s[k])) continue;
    size_t d = k;
    while (isdigit((unsigned char)s[k])) ++k;
    if (ct_alnum((unsigned char)s[k]) || s[k] == '_') continue;
    char digits[64]; size_t len = k - d < 63 ? k - d : 63;
    memcpy(digits, s + d, len); digits[len] = 0;
    *number = strtod(digits, NULL);
    *at = i; *end = k;
    return 1;
  }
  return 0;
}
static void ct_host_key(const char* provider, char* out, size_t cap) { // release-sets.js hostKey
  char* l = ct_lower_plain(provider);
  const char* h = !strncmp(l, "www.", 4) ? l + 4 : l;
  snprintf(out, cap, "%s", h);
  char* dot = strrchr(out, '.');
  if (dot && dot[1]) { int letters = 1; for (char* c = dot + 1; *c; ++c) if (*c < 'a' || *c > 'z') letters = 0; if (letters) *dot = 0; }
  free(l);
}
static void ct_last_segment_raw(const char* url, char* out, size_t cap) { // (url).split(/[?#]/)[0].split("/").pop()
  size_t n = strcspn(url, "?#");
  const char* s = url;
  for (size_t i = 0; i < n; ++i) if (url[i] == '/') s = url + i + 1;
  size_t len = (size_t)(url + n - s);
  if (len >= cap) len = cap - 1;
  memcpy(out, s, len); out[len] = 0;
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
  ct_last_segment_raw(link, seg, sizeof seg);
  ct_add_text(b, seg);
}
// releaseType: o dumpType e o bit do formato em CT_KIND (-1 sem).
enum { DT_FOLDER, DT_IMAGE, DT_BACKPORT, DT_FPKG };
static const char* const CT_DUMP[] = {"folder", "image", "backport", "fpkg"};
static int ct_dump_type(const char* format, const char* label, const char* text, int* kind) {
  char f[24]; snprintf(f, sizeof f, "%s", format ? format : "");
  for (char* c = f; *c; ++c) *c = (char)tolower((unsigned char)*c);
  const int image_format = !strcmp(f, "exfat") || !strcmp(f, "ffpkg") || !strcmp(f, "ffpfs") || !strcmp(f, "ffpfsc");
  int dump = -1;
  if (!strcmp(f, "pkg") || !strcmp(f, "fpkg")) dump = DT_FPKG;
  else if (ct_word(label ? label : "", ct_b_backport)) dump = DT_BACKPORT;
  else if (image_format) dump = DT_IMAGE;
  else if (ct_word(text, ct_b_folder)) dump = DT_FOLDER;
  else if (ct_image_words(text)) dump = DT_IMAGE;
  else if (ct_package_words(text)) dump = DT_FPKG;
  *kind = dump == DT_FOLDER ? 0 : dump == DT_BACKPORT ? 5 : dump == DT_FPKG ? 6 : -1;
  if (dump == DT_IMAGE) {
    const char* named = image_format ? f : ct_word(text, ct_b_ffpkg) ? "ffpkg" : ct_word(text, ct_b_ffpfs) ? "ffpfs" : ct_word(text, ct_b_exfat) ? "exfat" : NULL;
    *kind = !named ? 4 : (!strcmp(named, "ffpfsc") || !strcmp(named, "ffpfs")) ? 3 : !strcmp(named, "exfat") ? 1 : 2;
  }
  return dump;
}

// releaseSets: cada item e um link sozinho ou um conjunto de partes. Os textos aqui sao malloc comum (vida curta).
typedef struct { int number; const CtRel* src; } CtPart;
typedef struct {
  const CtRel* rel;        // um link (sem partes)
  const CtRel* base;       // o primeiro link do conjunto (os campos que ele herda)
  char *key, *label, *id, *password;
  const char* unavailable;
  CtPart* parts; int nparts, cap;
  int invalid_volume;      // "Invalid volume number."
  int dump, kind;          // releaseType
} CtItem;
typedef struct { CtItem* v; int n; } CtItems;
static void ct_items_free(CtItems* l) {
  for (int i = 0; i < l->n; ++i) { CtItem* t = &l->v[i]; free(t->key); free(t->label); free(t->id); free(t->password); free(t->parts); }
  free(l->v);
  memset(l, 0, sizeof *l);
}
// VOLUME_NAME /\bpart(\d+)\.(?:rar|7z|zip)\b/i: o numero (0 sem).
static int ct_volume_name(const char* name) {
  for (const char* p = name; *p; ++p) {
    if (p > name && (ct_alnum((unsigned char)p[-1]) || p[-1] == '_')) continue;
    if (strncasecmp(p, "part", 4) || !isdigit((unsigned char)p[4])) continue;
    const char* q = p + 4; int v = 0;
    while (isdigit((unsigned char)*q)) { if (v < 100000) v = v * 10 + (*q - '0'); ++q; }
    if (*q != '.') continue;
    ++q;
    size_t k = !strncasecmp(q, "rar", 3) || !strncasecmp(q, "zip", 3) ? 3 : !strncasecmp(q, "7z", 2) ? 2 : 0;
    if (k && !(ct_alnum((unsigned char)q[k]) || q[k] == '_')) return v ? v : -1;
  }
  return 0;
}
static int ct_same_link(const CtRel* a, const CtRel* b) {
  return !strcmp(ct_s(a->url), ct_s(b->url)) && ((!a->browser && !b->browser) || (a->browser && b->browser && !strcmp(a->browser, b->browser)));
}
static void ct_release_sets(const CtRel* rels, int n, CtItems* out) {
  out->v = calloc((size_t)n + 1, sizeof *out->v);
  if (!out->v) abort();
  out->n = 0;
  for (int i = 0; i < n; ++i) {
    const CtRel* r = &rels[i];
    double number; size_t at, end;
    const char* named = r->label && *r->label ? r->label : r->volume ? r->volume : "";
    if (r->patch || !ct_part(named, &number, &at, &end)) { out->v[out->n++].rel = r; continue; }
    if (!(number >= 1 && number <= 1024) || number != ct_floor(number)) { CtItem* t = &out->v[out->n++]; t->rel = r; t->invalid_volume = 1; continue; }
    const char* label = ct_s(r->label);
    double n2; size_t a2 = 0, e2 = 0;
    Buf stripped = {0};
    buf_add(&stripped, "", 0);
    if (ct_part(label, &n2, &a2, &e2)) { buf_add(&stripped, label, a2); buf_str(&stripped, label + e2); } else buf_str(&stripped, label);
    char* clean = ct_trim_plain(stripped.data);
    free(stripped.data);
    char hk[256]; ct_host_key(ct_s(r->provider), hk, sizeof hk);
    char* low = ct_lower_plain(clean);
    Buf key = {0};
    if (r->record) buf_str(&key, r->record);
    else { const char* id = ct_s(r->id); size_t m = strlen(id), k = m; while (k > 0 && isdigit((unsigned char)id[k - 1])) --k; if (k > 0 && k < m && id[k - 1] == '-') m = k - 1; buf_add(&key, id, m); }
    buf_str(&key, "/"); buf_str(&key, hk); buf_str(&key, "/"); buf_str(&key, low);
    free(low);
    int s = -1;
    for (int k = out->n - 1; k >= 0; --k) if (out->v[k].key && !strcmp(out->v[k].key, key.data)) { s = k; break; }
    if (s >= 0 && (int)number == 1) {
      const CtPart* first = NULL;
      for (int p = 0; p < out->v[s].nparts; ++p) if (out->v[s].parts[p].number == 1) first = &out->v[s].parts[p];
      if (first && !ct_same_link(first->src, r)) { free(out->v[s].key); out->v[s].key = NULL; s = -1; } // o mapa passa ao conjunto novo
    }
    if (s < 0) {
      s = out->n++;
      out->v[s].key = key.data; key.data = NULL;
      out->v[s].label = clean; clean = NULL;
      out->v[s].base = r;
    }
    free(key.data); free(clean);
    CtItem* set = &out->v[s];
    CtPart* part = NULL;
    for (int p = 0; p < set->nparts; ++p) if (set->parts[p].number == (int)number) part = &set->parts[p];
    if (!part) {
      if (set->nparts == set->cap) { set->cap = set->cap ? set->cap * 2 : 4; set->parts = realloc(set->parts, sizeof *set->parts * (size_t)set->cap); if (!set->parts) abort(); }
      part = &set->parts[set->nparts++];
      part->number = (int)number;
      part->src = r;
    } else if (!ct_same_link(part->src, r)) set->unavailable = "Ambiguous duplicate volume. Choose another complete set.";
  }
  for (int i = 0; i < out->n; ++i) {
    CtItem* t = &out->v[i];
    if (!t->rel) {
      for (int a = 1; a < t->nparts; ++a) for (int b = a; b > 0 && t->parts[b - 1].number > t->parts[b].number; --b) { CtPart x = t->parts[b]; t->parts[b] = t->parts[b - 1]; t->parts[b - 1] = x; }
      Buf sp = {0};
      for (int p = 0, m = 0; p < t->nparts; ++p) { // spellings: os provedores, sem repetir, por "+"
        int seen = 0;
        for (int q = 0; q < p; ++q) if (!strcmp(ct_s(t->parts[q].src->provider), ct_s(t->parts[p].src->provider))) seen = 1;
        if (seen) continue;
        if (m++) buf_str(&sp, "+");
        buf_str(&sp, ct_s(t->parts[p].src->provider));
      }
      char* low = ct_lower_plain(t->label);
      buf_str(&sp, "/"); buf_str(&sp, low); buf_str(&sp, "/"); buf_str(&sp, ct_s(t->parts[0].src->id));
      free(low);
      char k[20]; ct_stable_key(sp.data ? sp.data : "", k);
      free(sp.data);
      char idbuf[32]; snprintf(idbuf, sizeof idbuf, "set-%s", k);
      t->id = strdup(idbuf);
      // missingVolumes (o app so passa os numeros e os nomes)
      int missing = 0;
      for (int p = 0; p < t->nparts; ++p) if (t->parts[p].number != p + 1) missing = 1;
      if (!missing) {
        int any = 0;
        for (int p = 0; p < t->nparts; ++p) {
          const CtRel* s0 = t->parts[p].src;
          const int v = ct_volume_name(s0->url && *s0->url ? s0->url : ct_s(s0->browser));
          if (v) { any = 1; if (v != p + 1) missing = 1; }
        }
        if (!missing && t->nparts == 1 && any) missing = 1;
      }
      if (missing) t->unavailable = "This source has missing volumes. Choose another complete set.";
      // archivePassword: o do conjunto (o primeiro link) e o das partes; dois diferentes = indisponivel.
      const char* pass = NULL;
      int conflict = 0;
      for (int q = -1; q < t->nparts; ++q) {
        const char* v = (q < 0 ? t->base : t->parts[q].src)->password;
        if (!v || !*v) continue;
        if (!pass) pass = v; else if (strcmp(pass, v)) conflict = 1;
      }
      if (conflict) t->unavailable = "Archive volumes have conflicting passwords. Choose another complete source.";
      else if (pass) t->password = strdup(pass);
      Buf lb = {0};
      buf_str(&lb, t->label); buf_fmt(&lb, " \xc2\xb7 %d parts", t->nparts);
      free(t->label);
      t->label = lb.data;
    }
    Buf text = {0};
    buf_add(&text, "", 0);
    if (t->rel) { ct_add_text(&text, t->rel->label); ct_add_names(&text, t->rel); }
    else { ct_add_text(&text, t->label); for (int p = 0; p < t->nparts; ++p) ct_add_names(&text, t->parts[p].src); }
    t->dump = ct_dump_type(t->rel ? t->rel->format : "archive-set", t->rel ? t->rel->label : t->label, text.data, &t->kind);
    free(text.data);
  }
}
// gameFormats(releases, platform): os formatos (bits de CT_KIND) dos links.
static int ct_solo(const CtItem* t);
static uint16_t ct_kinds_of(const CtRel* rels, int n, uint8_t* solo) {
  CtItems items;
  ct_release_sets(rels, n, &items);
  uint16_t mask = 0;
  for (int i = 0; i < items.n; ++i) { if (items.v[i].kind >= 0) mask |= (uint16_t)(1u << items.v[i].kind); if (solo && ct_solo(&items.v[i])) *solo = 1; }
  ct_items_free(&items);
  return mask;
}

// ---- Leitura de arquivos -------------------------------------------------------------------------------------------
static char* ct_read_file(const char* path, size_t* size, size_t limit) {
  FILE* f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char* data = n >= 0 && (size_t)n <= limit ? ct_malloc((size_t)n + 1) : NULL;
  if (data && fread(data, 1, (size_t)n, f) != (size_t)n) { ct_free(data); data = NULL; }
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
// Um texto JSON inteiro (memoria contada); NULL quando nao e texto (pulado).
static int ct_str(JP* j, char** out) {
  *out = NULL;
  jp_ws(j);
  if (j->p >= j->end || *j->p != '"') return jp_skip(j);
  const char* start = j->p;
  if (!jp_string(j, NULL, 0)) return 0;
  size_t cap = (size_t)(j->p - start) + 8;
  char* s = ct_malloc(cap);
  j->p = start;
  if (!jp_string(j, s, cap)) { ct_free(s); return 0; }
  *out = s;
  return 1;
}
static int ct_num(JP* j, double* out, int* has) {
  *has = 0; *out = 0;
  jp_ws(j);
  if (j->p < j->end && (*j->p == '-' || isdigit((unsigned char)*j->p))) { uint64_t u; int i; if (!jp_number(j, out, &u, &i)) return 0; *has = 1; return 1; }
  return jp_skip(j);
}
typedef struct { char** v; int n, cap; } CtStrList;
static void ct_strlist_free(CtStrList* l) { for (int i = 0; i < l->n; ++i) ct_free(l->v[i]); ct_free(l->v); memset(l, 0, sizeof *l); }
static void ct_strlist_push(CtStrList* l, char* s) {
  if (l->n == l->cap) { l->cap = l->cap ? l->cap * 2 : 8; l->v = ct_realloc(l->v, sizeof *l->v * (size_t)l->cap); }
  l->v[l->n++] = s;
}
static int ct_strlist_item(JP* j, void* ctx) { char* s; if (!ct_str(j, &s)) return 0; ct_strlist_push(ctx, s); return 1; } // NULL = nao era texto

// Um link cru (de um pacote do embutido ou de um feed).
static int ct_rel_field(JP* j, const char* key, void* ctx) {
  CtRel* r = ctx;
  static const char* const KEYS[CT_REL_FIELDS] = {"id", "format", "filename", "url", "browserUrl", "version", "category", "provider", "source", "flow", "label",
                                                  "record", "volume", "archivePassword", "unavailableReason", "platform", "health", "sha256"};
  for (int i = 0; i < CT_REL_FIELDS; ++i) if (!strcmp(key, KEYS[i])) { char** s = ct_rel_slot(r, i); ct_free(*s); return ct_str(j, s) ? 1 : -1; }
  if (!strcmp(key, "requiresBrowser")) { jp_ws(j); r->requires_browser = (uint8_t)jp_literal(j, "true"); return r->requires_browser || jp_skip(j) ? 1 : -1; }
  if (!strcmp(key, "sizeBytes")) { int has; if (!ct_num(j, &r->size, &has)) return -1; r->has_size = (uint8_t)has; return 1; }
  return 0;
}
typedef struct { CtRel* v; int n, cap, total, max; } CtRels;
static void ct_rels_free(CtRels* l) { for (int i = 0; i < l->n; ++i) ct_rel_free(&l->v[i]); ct_free(l->v); memset(l, 0, sizeof *l); }
static CtRel* ct_rels_push(CtRels* l) {
  if (l->n == l->cap) { l->cap = l->cap ? l->cap * 2 : 4; l->v = ct_realloc(l->v, sizeof *l->v * (size_t)l->cap); }
  CtRel* r = &l->v[l->n++];
  memset(r, 0, sizeof *r);
  return r;
}
static int ct_rel_item(JP* j, void* ctx) {
  CtRels* l = ctx;
  ++l->total;
  if (l->max && l->total > l->max) return jp_skip(j);
  jp_ws(j);
  CtRel* r = ct_rels_push(l);
  if (j->p < j->end && *j->p == '{') { if (!jp_object(j, ct_rel_field, r)) return 0; r->object = 1; }
  else if (!jp_skip(j)) return 0;
  return 1;
}

#include "bg_catalog_read.c"
#include "bg_catalog_query.c"
#include "bg_catalog_game.c"
#include "bg_catalog_api.c"
