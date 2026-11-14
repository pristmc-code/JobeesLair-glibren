// glibren (item 2): a LOJA COMPLETA na pagina do celular, servida pelo payload com a Jobee'sLair aberta ou fechada.
//
// A Jobe grava em /data/JobeesLair/store (BGDL_STORE_DIR nos testes; app/state/store-export.js):
//   store-index.json  os jogos que a loja completa mostra (embutido + feeds + lista Orbit, sem os catalogos escondidos),
//                     na ordem da loja, com o que a lista, a busca, os filtros e as ordens leem; as opcoes de cada filtro
//                     na ordem do app; e em cada jogo `rank` = a posicao dele em cada ordem (relevance, newest, rating,
//                     size, title) calculada no console (o mesmo localeCompare do app): aqui a ordem e so comparar rank.
//                     `solo`: true = tem ao menos um link direto de arquivo unico (o payload baixa sozinho), false = todos
//                     precisam da Jobe aberta, null = ainda nao calculado (o indice e gravado antes de store-games.json).
//   store-games.json  a ficha (resumo, texto, fotos, banner) e os links de cada jogo na ordem da Jobe (o 1o e o que o
//                     Baixar da ficha escolheria), cada um com kind (direct|browser|torrent|set|unavailable), host,
//                     formato, tamanho, partes, solo, `source` (o indice dele em game.releases) e a URL so quando direto.
//                     Lido do disco so quando o celular abre um jogo ou pede para baixar, parando no jogo pedido; vale so
//                     com a mesma `key` do indice (senao: ficha sem texto e download pelo app).
// Na memoria do payload fica so o indice compacto (StIndex), relido quando o arquivo muda (mtime/tamanho).
//
// As regras dos filtros sao as de app/state/catalog.js (FACETS, passes, matching, facetCounts): os filtros "any"
// (platform, format, release, size, provider) valem com qualquer valor escolhido; os outros (access, genre, feature e o
// solo daqui) com todos. A contagem de uma opcao de filtro "any" e feita com todos os OUTROS filtros (o dele fora); a de
// um filtro que nao e "any", com todos (ele inclusive). Busca: o texto (q, sem espacos nas pontas, em minusculas)
// contido em `s` (titulo, desenvolvedora e editora em minusculas, como searchText do app).
//   GET  /api/store?q=&platform=&format=&access=&genre=&feature=&release=&size=&provider=&solo=1&sort=&offset=&limit=
//        -> {ok, key, builtAt, console, readyFirmware, total, count, offset, limit, games:[{id, title, code, platform,
//            cover, sizeGb, formats, ready, stars, ratingCount, year, solo, queued}], facets:{<filtro>:[{value, name, count}]}}
//        (valores separados por virgula; sort: relevance|newest|rating|size|title). 404 {"error":"no-store"} sem o
//        arquivo, 500 {"error":"bad-store"} quando nada se aproveita dele. Sem sessao (como /api/library): nada de link.
//   GET  /api/store/game?id= -> {ok, game:{...}, details?:{summary, about, shots, hero}, links:[{i, kind, group, host,
//        format, size, label, parts, solo, ref}] (sem URL), download:"payload"|"app"}
//        glibren.55: `i` (a posicao na lista, na ordem da ficha da TV), `group` (direct|page|torrent|browser|unavailable,
//        tambem num conjunto de partes: "browser" = precisa do navegador do PS5 na TV) e `ref` (o link deste jogo).
//   POST /api/store/add {id, link?, ref?} (sessao do PIN) -> {ok, id, via:"payload"} (o payload comeca a baixar sozinho: Jobe fechada,
//        glibren.55: `link` + `ref` = o link escolhido na /app (sem eles, o automatico: o 1o solo, senao a Jobe escolhe
//        como a ficha da TV); um `ref` que nao e deste jogo/link da 400 {"error":"link"}. A resposta diz `picked` (o link
//        escolhido, -1 no automatico) e `browser` (o link vai precisar do navegador do PS5 na TV, se o TorBox nao o pegar).
//        Um link escolhido que o payload nao baixa sozinho vai ao marcador com a fonte dele (`source`): a Jobe usa ela.
//        disco padrao conhecido e um link solo) | {ok, id, via:"app", appOpen, reason} (marcador "waiting-app": a Jobe poe
//        na fila dela quando abrir, ou ja, se aberta) | {ok, already, id}. 409 {"error":"exists"} (o arquivo ja esta no
//        disco) ou {"error":"full"}.
// O job comecado aqui segue as regras do pedido da Biblioteca TorBox comecado com o app fechado (glibren.18): `requested`
// + `auto_started`, destino de auto_plan (as regras do app), e a Jobe o adota ao abrir (phone-library.js: o jogo pela
// loja, a mesma fonte `source`, o disco padrao). Nenhum segredo e gravado: so links publicos do catalogo.
#define ST_MAX_BYTES (48u * 1024 * 1024)
#define ST_GAMES_MAX_BYTES (96u * 1024 * 1024)
#define ST_MAX_GAMES 30000
#define ST_BITS 128
#define ST_FORMATS 32
#define ST_OPTS 128
#define ST_SORTS 5
#define ST_PAGE 200
#define ST_ABOUT 3
#define ST_SHOTS 10
#define ST_LINKS 24
#define ST_SELECT 32

enum { SF_PLATFORM, SF_FORMAT, SF_ACCESS, SF_GENRE, SF_FEATURE, SF_RELEASE, SF_SIZE, SF_PROVIDER, SF_SOLO, SF_COUNT };
static const char* const ST_FACET_KEYS[SF_COUNT] = {"platform", "format", "access", "genre", "feature", "release", "size", "provider", "solo"};
static const int ST_FACET_ANY[SF_COUNT] = {1, 1, 0, 0, 0, 1, 1, 1, 0};
static const char* const ST_SORT_KEYS[ST_SORTS] = {"relevance", "newest", "rating", "size", "title"};

typedef struct { uint64_t w[2]; } StBits;
static void st_bit_set(StBits* b, int i) { if (i >= 0 && i < ST_BITS) b->w[i >> 6] |= 1ull << (i & 63); }
static int st_bit_has(const StBits* b, int i) { return i >= 0 && i < ST_BITS && ((b->w[i >> 6] >> (i & 63)) & 1); }

typedef struct {
  char id[16], code[16], title[160], cover[LIB_COVER], developer[96], publisher[96], release_date[12];
  char* s; // o texto da busca (malloc)
  StBits genres, features, providers;
  uint32_t formats;
  double size_gb, stars;
  uint32_t rating_count, rank[ST_SORTS];
  int year;
  uint8_t platform; // 1 ps5, 2 ps4, 0 outro
  uint8_t ready, direct, has_size, has_stars, has_year;
  int8_t solo; // 1, 0, -1 (null: ainda nao calculado)
} StGame;
typedef struct { char value[64], name[96]; } StOpt;
typedef struct {
  StGame* games;
  int count, cap, partial;
  char key[96], built[40], console[8], ready_fw[24];
  char genres[ST_BITS][64], features[ST_BITS][64], providers[ST_BITS][64], formats[ST_FORMATS][16];
  int genre_count, feature_count, provider_count, format_count;
  StOpt opts[SF_COUNT][ST_OPTS];
  int opt_count[SF_COUNT];
} StIndex;

static pthread_mutex_t g_store_lock = PTHREAD_MUTEX_INITIALIZER; // antes de g_lock, nunca depois
// Fase 3 (bg_catalog_api.c): com o catalogo montado no payload, a loja sai dele; senao, do store-index.json do app.
static int catalog_store_list(int fd, const char* query);
static char g_store_dir[600];
static StIndex* g_store;
static int g_store_state; // 0 nao lido, 1 lido, 2 sem o arquivo, 3 invalido
static int64_t g_store_mtime, g_store_checked, g_store_check_ms = -1;
static uint64_t g_store_bytes;

static void st_paths(char* index, size_t index_cap, char* games, size_t games_cap) {
  if (!g_store_dir[0]) copy_text(g_store_dir, sizeof g_store_dir, env_or("BGDL_STORE_DIR", "/data/JobeesLair/store"));
  if (index) snprintf(index, index_cap, "%.580s/store-index.json", g_store_dir);
  if (games) snprintf(games, games_cap, "%.580s/store-games.json", g_store_dir);
}
static void st_index_free(StIndex* x) {
  if (!x) return;
  for (int i = 0; i < x->count; ++i) free(x->games[i].s);
  free(x->games);
  free(x);
}
static int st_intern(char* table, size_t width, int* count, int max, const char* name) {
  if (!name[0]) return -1;
  for (int i = 0; i < *count; ++i) if (!strcmp(table + (size_t)i * width, name)) return i;
  if (*count >= max) return -1;
  copy_utf8(table + (size_t)*count * width, width, name);
  return (*count)++;
}
static int st_find_name(const char* table, size_t width, int count, const char* name) {
  for (int i = 0; i < count; ++i) if (!strcmp(table + (size_t)i * width, name)) return i;
  return -1;
}
// Um numero (ou null): *has = 0 com null ou outro tipo.
static int st_number(JP* j, double* out, int* has) {
  *out = 0;
  *has = 0;
  jp_ws(j);
  if (j->p < j->end && (*j->p == '-' || isdigit((unsigned char)*j->p))) {
    double d; uint64_t u; int integer;
    if (!jp_number(j, &d, &u, &integer)) return 0;
    *out = integer ? (double)u : d;
    *has = 1;
    return 1;
  }
  return jp_skip(j);
}
// -1 com null ou outro tipo.
static int st_tristate(JP* j, int8_t* out) {
  *out = -1;
  jp_ws(j);
  if (j->p < j->end && (*j->p == 't' || *j->p == 'f')) {
    int v = 0;
    if (!jp_bool(j, &v)) return 0;
    *out = v ? 1 : 0;
    return 1;
  }
  return jp_skip(j);
}

typedef struct { StIndex* x; StGame g; int rank_at, facet; StOpt opt; } StParse;
typedef struct { StParse* p; int which; } StListCtx; // which: 0 genres, 1 features, 2 providers, 3 formats
static int st_name_item(JP* j, void* ctx) {
  StListCtx* c = ctx;
  char name[64];
  if (!lib_text(j, name, sizeof name)) return 0;
  StIndex* x = c->p->x;
  StGame* g = &c->p->g;
  if (c->which == 0) st_bit_set(&g->genres, st_intern(&x->genres[0][0], sizeof x->genres[0], &x->genre_count, ST_BITS, name));
  else if (c->which == 1) st_bit_set(&g->features, st_intern(&x->features[0][0], sizeof x->features[0], &x->feature_count, ST_BITS, name));
  else if (c->which == 2) st_bit_set(&g->providers, st_intern(&x->providers[0][0], sizeof x->providers[0], &x->provider_count, ST_BITS, name));
  else {
    const int slot = st_intern(&x->formats[0][0], sizeof x->formats[0], &x->format_count, ST_FORMATS, name);
    if (slot >= 0) g->formats |= 1u << slot;
  }
  return 1;
}
static int st_rank_item(JP* j, void* ctx) {
  StParse* p = ctx;
  double v; int has;
  if (!st_number(j, &v, &has)) return 0;
  if (p->rank_at < ST_SORTS && has && v >= 0 && v < 4e9) p->g.rank[p->rank_at] = (uint32_t)v;
  ++p->rank_at;
  return 1;
}
static int st_game_field(JP* jp, const char* key, void* ctx) {
  StParse* p = ctx;
  StGame* g = &p->g;
  if (!strcmp(key, "id")) return lib_text(jp, g->id, sizeof g->id) ? 1 : -1;
  if (!strcmp(key, "code")) return lib_text(jp, g->code, sizeof g->code) ? 1 : -1;
  if (!strcmp(key, "title")) return lib_text(jp, g->title, sizeof g->title) ? 1 : -1;
  if (!strcmp(key, "developer")) return lib_text(jp, g->developer, sizeof g->developer) ? 1 : -1;
  if (!strcmp(key, "publisher")) return lib_text(jp, g->publisher, sizeof g->publisher) ? 1 : -1;
  if (!strcmp(key, "releaseDate")) return lib_text(jp, g->release_date, sizeof g->release_date) ? 1 : -1;
  if (!strcmp(key, "cover")) return lib_https(jp, g->cover, sizeof g->cover) ? 1 : -1;
  if (!strcmp(key, "platform")) {
    char value[16];
    if (!lib_text(jp, value, sizeof value)) return -1;
    g->platform = !strcmp(value, "ps5") ? 1 : !strcmp(value, "ps4") ? 2 : 0;
    return 1;
  }
  if (!strcmp(key, "s")) {
    jp_ws(jp);
    if (jp->p >= jp->end || *jp->p != '"') return jp_skip(jp) ? 1 : -1;
    char* text = malloc(1024);
    if (!text) return -1;
    if (!lib_text(jp, text, 1024)) { free(text); return -1; }
    lower_ascii(text);
    free(g->s);
    g->s = text;
    return 1;
  }
  if (!strcmp(key, "genres")) { StListCtx c = {p, 0}; return lib_list(jp, st_name_item, &c) ? 1 : -1; }
  if (!strcmp(key, "features")) { StListCtx c = {p, 1}; return lib_list(jp, st_name_item, &c) ? 1 : -1; }
  if (!strcmp(key, "providers")) { StListCtx c = {p, 2}; return lib_list(jp, st_name_item, &c) ? 1 : -1; }
  if (!strcmp(key, "formats")) { StListCtx c = {p, 3}; return lib_list(jp, st_name_item, &c) ? 1 : -1; }
  if (!strcmp(key, "ready") || !strcmp(key, "direct")) {
    int8_t v;
    if (!st_tristate(jp, &v)) return -1;
    if (key[0] == 'r') g->ready = v == 1; else g->direct = v == 1;
    return 1;
  }
  if (!strcmp(key, "solo")) return st_tristate(jp, &g->solo) ? 1 : -1;
  if (!strcmp(key, "year")) { double v; int has; if (!st_number(jp, &v, &has)) return -1; g->has_year = has; g->year = has ? (int)v : 0; return 1; }
  if (!strcmp(key, "sizeGb")) { int has; if (!st_number(jp, &g->size_gb, &has)) return -1; g->has_size = has; return 1; }
  if (!strcmp(key, "stars")) { int has; if (!st_number(jp, &g->stars, &has)) return -1; g->has_stars = has; return 1; }
  if (!strcmp(key, "ratingCount")) { double v; int has; if (!st_number(jp, &v, &has)) return -1; g->rating_count = has && v > 0 && v < 4e9 ? (uint32_t)v : 0; return 1; }
  if (!strcmp(key, "rank")) { p->rank_at = 0; return jp_array(jp, st_rank_item, p) ? 1 : -1; }
  return 0;
}
static int st_game_item(JP* j, void* ctx) {
  StParse* p = ctx;
  StIndex* x = p->x;
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{') return jp_skip(j);
  memset(&p->g, 0, sizeof p->g);
  p->g.solo = -1;
  for (int k = 0; k < ST_SORTS; ++k) p->g.rank[k] = UINT32_MAX;
  if (!jp_object(j, st_game_field, p)) { free(p->g.s); p->g.s = NULL; return 0; }
  StGame* g = &p->g;
  if (!g->id[0] || !g->title[0]) { free(g->s); g->s = NULL; return 1; }
  if (!g->code[0]) copy_text(g->code, sizeof g->code, g->id);
  if (!g->s) {
    char text[512];
    snprintf(text, sizeof text, "%.159s %.95s %.95s", g->title, g->developer, g->publisher);
    lower_ascii(text);
    g->s = strdup(text);
    if (!g->s) return 0;
  }
  if (x->count >= ST_MAX_GAMES) { free(g->s); g->s = NULL; x->partial = 1; return 0; }
  if (x->count == x->cap) {
    const int cap = x->cap ? x->cap * 2 : 512;
    StGame* next = realloc(x->games, sizeof *next * (size_t)cap);
    if (!next) { free(g->s); g->s = NULL; x->partial = 1; return 0; }
    x->games = next;
    x->cap = cap;
  }
  // Sem rank (um indice de antes): a ordem da lista.
  for (int k = 0; k < ST_SORTS; ++k) if (g->rank[k] == UINT32_MAX) g->rank[k] = (uint32_t)x->count;
  x->games[x->count++] = *g;
  g->s = NULL;
  return 1;
}
// Uma opcao de filtro: "valor" ou {"value", "name"}.
static int st_opt_field(JP* jp, const char* key, void* ctx) {
  StOpt* o = ctx;
  if (!strcmp(key, "value")) return lib_text(jp, o->value, sizeof o->value) ? 1 : -1;
  if (!strcmp(key, "name")) return lib_text(jp, o->name, sizeof o->name) ? 1 : -1;
  return 0;
}
static int st_opt_item(JP* j, void* ctx) {
  StParse* p = ctx;
  StOpt o;
  memset(&o, 0, sizeof o);
  jp_ws(j);
  if (j->p < j->end && *j->p == '{') { if (!jp_object(j, st_opt_field, &o)) return 0; }
  else if (!lib_text(j, o.value, sizeof o.value)) return 0;
  if (!o.value[0]) return 1;
  if (!o.name[0]) snprintf(o.name, sizeof o.name, "%s", o.value);
  StIndex* x = p->x;
  if (x->opt_count[p->facet] < ST_OPTS) x->opts[p->facet][x->opt_count[p->facet]++] = o;
  return 1;
}
static int st_facets_field(JP* jp, const char* key, void* ctx) {
  StParse* p = ctx;
  for (int f = 0; f < SF_COUNT; ++f) {
    if (strcmp(key, ST_FACET_KEYS[f])) continue;
    p->facet = f;
    p->x->opt_count[f] = 0;
    return jp_array(jp, st_opt_item, p) ? 1 : -1;
  }
  return 0;
}
static int st_top_field(JP* jp, const char* key, void* ctx) {
  StParse* p = ctx;
  StIndex* x = p->x;
  if (!strcmp(key, "key")) return lib_text(jp, x->key, sizeof x->key) ? 1 : -1;
  if (!strcmp(key, "builtAt")) return lib_text(jp, x->built, sizeof x->built) ? 1 : -1;
  if (!strcmp(key, "console")) return lib_text(jp, x->console, sizeof x->console) ? 1 : -1;
  if (!strcmp(key, "readyFirmware")) return lib_text(jp, x->ready_fw, sizeof x->ready_fw) ? 1 : -1;
  if (!strcmp(key, "facets")) {
    jp_ws(jp);
    if (jp->p >= jp->end || *jp->p != '{') return jp_skip(jp) ? 1 : -1;
    return jp_object(jp, st_facets_field, p) ? 1 : -1;
  }
  if (!strcmp(key, "games")) return jp_array(jp, st_game_item, p) ? 1 : -1;
  return 0;
}
// Le o indice (com g_store_lock): 1 lido, 2 sem o arquivo, 3 invalido.
static int st_read(StIndex** out) {
  char path[700];
  st_paths(path, sizeof path, NULL, 0);
  size_t size = 0;
  errno = 0;
  char* text = read_text(path, ST_MAX_BYTES, &size);
  if (!text) return errno == ENOENT ? 2 : 3;
  StParse* p = calloc(1, sizeof *p);
  StIndex* x = calloc(1, sizeof *x);
  if (!p || !x) { free(p); free(x); free(text); return 3; }
  p->x = x;
  // Sem a lista de um filtro no arquivo: as opcoes fixas do app.
  static const char* const fixed[][4] = {{"ps5", "ps4", NULL, NULL}, {"ready", NULL, NULL, NULL}, {"direct", NULL, NULL, NULL}};
  for (int f = 0; f < 3; ++f)
    for (int k = 0; fixed[f][k]; ++k) { copy_text(x->opts[f][k].value, sizeof x->opts[f][k].value, fixed[f][k]); copy_text(x->opts[f][k].name, sizeof x->opts[f][k].name, fixed[f][k]); x->opt_count[f] = k + 1; }
  static const char* const releases[] = {"recent", "current", "older"}, *const sizes[] = {"small", "medium", "large"};
  for (int k = 0; k < 3; ++k) {
    copy_text(x->opts[SF_RELEASE][k].value, sizeof x->opts[SF_RELEASE][k].value, releases[k]);
    copy_text(x->opts[SF_RELEASE][k].name, sizeof x->opts[SF_RELEASE][k].name, releases[k]);
    copy_text(x->opts[SF_SIZE][k].value, sizeof x->opts[SF_SIZE][k].value, sizes[k]);
    copy_text(x->opts[SF_SIZE][k].name, sizeof x->opts[SF_SIZE][k].name, sizes[k]);
  }
  x->opt_count[SF_RELEASE] = x->opt_count[SF_SIZE] = 3;
  copy_text(x->opts[SF_SOLO][0].value, sizeof x->opts[SF_SOLO][0].value, "1");
  copy_text(x->opts[SF_SOLO][0].name, sizeof x->opts[SF_SOLO][0].name, "solo");
  x->opt_count[SF_SOLO] = 1;
  copy_text(x->ready_fw, sizeof x->ready_fw, "13.60");
  JP jp = {text, text + size, 0};
  const int whole = jp_object(&jp, st_top_field, p);
  free(text);
  free(p->g.s);
  free(p);
  // O solo e daqui (nao vem no arquivo): sempre a mesma opcao.
  x->opt_count[SF_SOLO] = 1;
  copy_text(x->opts[SF_SOLO][0].value, sizeof x->opts[SF_SOLO][0].value, "1");
  if (!whole) x->partial = 1;
  if (!whole && !x->count) { st_index_free(x); return 3; }
  *out = x;
  return 1;
}
static int st_refresh_locked(void) {
  if (g_store_check_ms < 0) g_store_check_ms = atoi(env_or("BGDL_STORE_CHECK_MS", "2000"));
  const int64_t now = mono_ms();
  if (g_store_state && now - g_store_checked < g_store_check_ms) return g_store_state;
  g_store_checked = now;
  char path[700];
  st_paths(path, sizeof path, NULL, 0);
  struct stat st;
  if (stat(path, &st)) {
    if (g_store_state != 2) logf_("loja completa: sem o indice (%s)", path);
    st_index_free(g_store);
    g_store = NULL;
    return g_store_state = 2;
  }
  if ((g_store_state == 1 || g_store_state == 3) && (int64_t)st.st_mtime == g_store_mtime && (uint64_t)st.st_size == g_store_bytes) return g_store_state;
  g_store_mtime = (int64_t)st.st_mtime;
  g_store_bytes = (uint64_t)st.st_size;
  const int64_t started = mono_ms();
  StIndex* x = NULL;
  const int state = st_read(&x);
  if (state != 1) {
    st_index_free(g_store);
    g_store = NULL;
    logf_("loja completa: indice %s", state == 2 ? "sumiu" : "invalido (nenhum jogo lido)");
    return g_store_state = state;
  }
  st_index_free(g_store);
  g_store = x;
  logf_("loja completa: %d jogo(s) lido(s) em %lld ms (%llu KiB)%s", x->count, (long long)(mono_ms() - started),
        (unsigned long long)(g_store_bytes / 1024), x->partial ? ", incompleto" : "");
  return g_store_state = 1;
}

// ---- Os filtros ----
// Um valor escolhido ja traduzido: o lugar dele na tabela do indice (formato, genero...), o codigo fixo (plataforma,
// faixa) ou -1 (desconhecido: nada tem). -2 e o "ready" do formato.
typedef struct { int n; int code[ST_SELECT]; } StSel;
typedef struct {
  char q[200];
  StSel sel[SF_COUNT];
  int sort, offset, limit;
} StQuery;
static int st_code(const StIndex* x, int facet, const char* value) {
  switch (facet) {
    case SF_PLATFORM: return !strcmp(value, "ps5") ? 1 : !strcmp(value, "ps4") ? 2 : -1;
    case SF_FORMAT: return !strcmp(value, "ready") ? -2 : st_find_name(&x->formats[0][0], sizeof x->formats[0], x->format_count, value);
    case SF_ACCESS: return !strcmp(value, "direct") ? 0 : -1;
    case SF_GENRE: return st_find_name(&x->genres[0][0], sizeof x->genres[0], x->genre_count, value);
    case SF_FEATURE: return st_find_name(&x->features[0][0], sizeof x->features[0], x->feature_count, value);
    case SF_RELEASE: return !strcmp(value, "recent") ? 0 : !strcmp(value, "current") ? 1 : !strcmp(value, "older") ? 2 : -1;
    case SF_SIZE: return !strcmp(value, "small") ? 0 : !strcmp(value, "medium") ? 1 : !strcmp(value, "large") ? 2 : -1;
    case SF_PROVIDER: return st_find_name(&x->providers[0][0], sizeof x->providers[0], x->provider_count, value);
    case SF_SOLO: return !strcmp(value, "1") || !strcmp(value, "true") ? 0 : -1;
  }
  return -1;
}
// facet.has(game, value) do app.
static int st_has(const StGame* g, int facet, int code) {
  switch (facet) {
    case SF_PLATFORM: return code > 0 && g->platform == code;
    case SF_FORMAT: return code == -2 ? g->ready : code >= 0 && code < ST_FORMATS && ((g->formats >> code) & 1);
    case SF_ACCESS: return code == 0 && g->direct;
    case SF_GENRE: return st_bit_has(&g->genres, code);
    case SF_FEATURE: return st_bit_has(&g->features, code);
    case SF_RELEASE:
      if (!g->has_year) return 0;
      return code == 0 ? g->year >= 2024 : code == 1 ? g->year >= 2020 && g->year <= 2023 : code == 2 ? g->year < 2020 : 0;
    case SF_SIZE:
      if (!g->has_size) return 0;
      return code == 0 ? g->size_gb < 10 : code == 1 ? g->size_gb >= 10 && g->size_gb <= 50 : code == 2 ? g->size_gb > 50 : 0;
    case SF_PROVIDER: return st_bit_has(&g->providers, code);
    case SF_SOLO: return code == 0 && g->solo == 1;
  }
  return 0;
}
// passes() do app: sem escolha passa; "any" com um dos valores; os outros com todos.
static int st_passes(const StGame* g, int facet, const StSel* s) {
  if (!s->n) return 1;
  if (ST_FACET_ANY[facet]) {
    for (int i = 0; i < s->n; ++i) if (st_has(g, facet, s->code[i])) return 1;
    return 0;
  }
  for (int i = 0; i < s->n; ++i) if (!st_has(g, facet, s->code[i])) return 0;
  return 1;
}
static void st_query_parse(const char* query, const StIndex* x, StQuery* q) {
  memset(q, 0, sizeof *q);
  q->limit = 40;
  for (const char* p = query ? query : ""; *p;) {
    const size_t n = strcspn(p, "&");
    const char* eq = memchr(p, '=', n);
    const size_t key_size = eq ? (size_t)(eq - p) : n;
    char key[24], value[1000];
    url_decode(p, key_size, key, sizeof key);
    if (eq) url_decode(eq + 1, n - key_size - 1, value, sizeof value);
    else value[0] = 0;
    if (!strcmp(key, "q")) {
      // query.trim().toLowerCase()
      char* start = value;
      while (*start == ' ' || *start == '\t' || *start == '\n' || *start == '\r') ++start;
      size_t len = strlen(start);
      while (len && (start[len - 1] == ' ' || start[len - 1] == '\t' || start[len - 1] == '\n' || start[len - 1] == '\r')) start[--len] = 0;
      copy_utf8(q->q, sizeof q->q, start);
      lower_ascii(q->q);
    } else if (!strcmp(key, "sort")) {
      for (int k = 0; k < ST_SORTS; ++k) if (!strcmp(value, ST_SORT_KEYS[k])) q->sort = k;
    } else if (!strcmp(key, "offset")) { const long v = strtol(value, NULL, 10); q->offset = v < 0 ? 0 : v > ST_MAX_GAMES ? ST_MAX_GAMES : (int)v; }
    else if (!strcmp(key, "limit")) { const long v = strtol(value, NULL, 10); q->limit = v < 1 ? 1 : v > ST_PAGE ? ST_PAGE : (int)v; }
    else {
      for (int f = 0; f < SF_COUNT; ++f) {
        if (strcmp(key, ST_FACET_KEYS[f])) continue;
        StSel* s = &q->sel[f];
        for (const char* v = value; *v;) {
          const size_t m = strcspn(v, ",");
          char one[96];
          if (m && m < sizeof one) {
            memcpy(one, v, m);
            one[m] = 0;
            int dup = 0;
            const int code = st_code(x, f, one);
            // O mesmo valor duas vezes vale uma (a lista do app nao repete).
            for (int i = 0; i < s->n; ++i) if (s->code[i] == code && code != -1) dup = 1;
            if (!dup && s->n < ST_SELECT) s->code[s->n++] = code;
          }
          v += m;
          if (*v == ',') ++v;
        }
      }
    }
    p += n;
    if (*p == '&') ++p;
  }
}
typedef struct { uint32_t rank; int index; } StOrder;
static int st_order_cmp(const void* a, const void* b) {
  const StOrder* x = a;
  const StOrder* y = b;
  if (x->rank != y->rank) return x->rank < y->rank ? -1 : 1;
  return (x->index > y->index) - (x->index < y->index);
}
static void st_number_json(Buf* b, const char* name, double value, int has) {
  if (has) buf_fmt(b, ",\"%s\":%.10g", name, value);
  else buf_fmt(b, ",\"%s\":null", name);
}
static void st_formats_json(Buf* b, const StIndex* x, const StGame* g) {
  buf_str(b, "[");
  int first = 1;
  for (int k = 0; k < x->format_count; ++k) {
    if (!((g->formats >> k) & 1)) continue;
    if (!first) buf_str(b, ",");
    first = 0;
    buf_json(b, x->formats[k]);
  }
  buf_str(b, "]");
}
static void st_names_json(Buf* b, const char* table, size_t width, int count, const StBits* bits) {
  buf_str(b, "[");
  int first = 1;
  for (int k = 0; k < count; ++k) {
    if (!st_bit_has(bits, k)) continue;
    if (!first) buf_str(b, ",");
    first = 0;
    buf_json(b, table + (size_t)k * width);
  }
  buf_str(b, "]");
}
// Um pedido da loja deste jogo ainda vivo (com g_lock).
static Job* st_request_locked(const char* id) {
  for (int i = 0; i < g_job_count; ++i) {
    Job* j = g_jobs[i];
    if (j->lib_store[0] && !strcmp(j->lib_store, id)) return j;
  }
  return NULL;
}
static int st_queued_locked(const char* id) {
  const Job* j = st_request_locked(id);
  return j && strcmp(j->state, "failed") && strcmp(j->state, "cancelled");
}
static void st_game_json(Buf* b, const StIndex* x, const StGame* g, int queued, int full) {
  buf_str(b, "{\"id\":"); buf_json(b, g->id);
  buf_str(b, ",\"title\":"); buf_json(b, g->title);
  buf_str(b, ",\"code\":"); buf_json(b, g->code);
  buf_fmt(b, ",\"platform\":\"%s\"", g->platform == 1 ? "ps5" : g->platform == 2 ? "ps4" : "");
  buf_str(b, ",\"cover\":"); buf_json(b, g->cover);
  st_number_json(b, "sizeGb", g->size_gb, g->has_size);
  buf_str(b, ",\"formats\":"); st_formats_json(b, x, g);
  buf_fmt(b, ",\"ready\":%s", g->ready ? "true" : "false");
  st_number_json(b, "stars", g->stars, g->has_stars);
  buf_fmt(b, ",\"ratingCount\":%u", g->rating_count);
  st_number_json(b, "year", g->year, g->has_year);
  buf_fmt(b, ",\"solo\":%s,\"queued\":%s", g->solo == 1 ? "true" : g->solo == 0 ? "false" : "null", queued ? "true" : "false");
  if (full) {
    buf_fmt(b, ",\"direct\":%s", g->direct ? "true" : "false");
    buf_str(b, ",\"genres\":"); st_names_json(b, &x->genres[0][0], sizeof x->genres[0], x->genre_count, &g->genres);
    buf_str(b, ",\"features\":"); st_names_json(b, &x->features[0][0], sizeof x->features[0], x->feature_count, &g->features);
    buf_str(b, ",\"providers\":"); st_names_json(b, &x->providers[0][0], sizeof x->providers[0], x->provider_count, &g->providers);
    buf_str(b, ",\"developer\":"); buf_json(b, g->developer);
    buf_str(b, ",\"publisher\":"); buf_json(b, g->publisher);
    buf_str(b, ",\"releaseDate\":"); buf_json(b, g->release_date);
  } else if (g->genres.w[0] || g->genres.w[1]) {
    buf_str(b, ",\"genres\":"); st_names_json(b, &x->genres[0][0], sizeof x->genres[0], x->genre_count, &g->genres);
  }
  buf_str(b, "}");
}
static void st_store_error(int fd, int state) {
  if (state == 2) monitor_json(fd, 404, "{\"error\":\"no-store\"}");
  else monitor_json(fd, 500, "{\"error\":\"bad-store\"}");
}

// GET /api/store
static void store_list(int fd, const char* query) {
  if (catalog_store_list(fd, query)) return; // Fase 3
  pthread_mutex_lock(&g_store_lock);
  const int state = st_refresh_locked();
  if (state != 1 || !g_store) { pthread_mutex_unlock(&g_store_lock); st_store_error(fd, state); return; }
  const StIndex* x = g_store;
  StQuery* q = calloc(1, sizeof *q);
  StOrder* matches = malloc(sizeof *matches * (size_t)(x->count + 1));
  int (*counts)[ST_OPTS] = calloc(SF_COUNT, sizeof *counts);
  if (!q || !matches || !counts) {
    pthread_mutex_unlock(&g_store_lock);
    free(q); free(matches); free(counts);
    monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
    return;
  }
  st_query_parse(query, x, q);
  // As opcoes de cada filtro ja traduzidas, uma vez.
  int codes[SF_COUNT][ST_OPTS];
  for (int f = 0; f < SF_COUNT; ++f) for (int o = 0; o < x->opt_count[f]; ++o) codes[f][o] = st_code(x, f, x->opts[f][o].value);
  int count = 0;
  for (int i = 0; i < x->count; ++i) {
    const StGame* g = &x->games[i];
    if (q->q[0] && !(g->s && strstr(g->s, q->q))) continue;
    unsigned failed = 0;
    for (int f = 0; f < SF_COUNT; ++f) if (!st_passes(g, f, &q->sel[f])) failed |= 1u << f;
    if (!failed) { matches[count].rank = g->rank[q->sort]; matches[count].index = i; ++count; }
    for (int f = 0; f < SF_COUNT; ++f) {
      const int in_pool = ST_FACET_ANY[f] ? !(failed & ~(1u << f)) : !failed;
      if (!in_pool) continue;
      for (int o = 0; o < x->opt_count[f]; ++o) if (st_has(g, f, codes[f][o])) ++counts[f][o];
    }
  }
  if (count > 1) qsort(matches, (size_t)count, sizeof *matches, st_order_cmp);
  Buf b = {0};
  buf_str(&b, "{\"ok\":true,\"key\":"); buf_json(&b, x->key);
  buf_str(&b, ",\"builtAt\":"); buf_json(&b, x->built);
  buf_str(&b, ",\"console\":"); buf_json(&b, x->console);
  buf_str(&b, ",\"readyFirmware\":"); buf_json(&b, x->ready_fw);
  buf_fmt(&b, ",\"partial\":%s,\"total\":%d,\"count\":%d,\"offset\":%d,\"limit\":%d,\"sort\":\"%s\",\"games\":[", x->partial ? "true" : "false",
          x->count, count, q->offset, q->limit, ST_SORT_KEYS[q->sort]);
  pthread_mutex_lock(&g_lock);
  for (int i = q->offset, shown = 0; i < count && shown < q->limit; ++i, ++shown) {
    if (shown) buf_str(&b, ",");
    const StGame* g = &x->games[matches[i].index];
    st_game_json(&b, x, g, st_queued_locked(g->id), 0);
  }
  pthread_mutex_unlock(&g_lock);
  buf_str(&b, "],\"facets\":{");
  for (int f = 0; f < SF_COUNT; ++f) {
    buf_fmt(&b, "%s\"%s\":[", f ? "," : "", ST_FACET_KEYS[f]);
    for (int o = 0; o < x->opt_count[f]; ++o) {
      if (o) buf_str(&b, ",");
      buf_str(&b, "{\"value\":"); buf_json(&b, x->opts[f][o].value);
      buf_str(&b, ",\"name\":"); buf_json(&b, x->opts[f][o].name);
      buf_fmt(&b, ",\"count\":%d}", counts[f][o]);
    }
    buf_str(&b, "]");
  }
  buf_str(&b, "}}");
  pthread_mutex_unlock(&g_store_lock);
  free(q); free(matches); free(counts);
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_send(fd, 200, "application/json", b.data, b.size);
  free(b.data);
}

// ---- A ficha e os links (store-games.json, lido do disco quando pedido) ----
typedef struct {
  char kind[16], host[64], format[16], label[160], filename[256], url[2048], sha256[72];
  char group[16]; // glibren.55: o grupo do link (num conjunto, o das partes); vazio = o kind
  uint64_t size;
  int has_size, source; // source: o indice em game.releases (-1 sem)
  char rid[96]; // .58: o id do link em game.releases (release.id): estavel entre o catalogo do payload e o do app
  unsigned parts;
  int8_t solo; // -1: nao veio (calculado aqui)
} StLink;
typedef struct {
  char summary[1600], about[ST_ABOUT][3000], hero[512], shots[ST_SHOTS][512];
  int about_count, shot_count;
  StLink links[ST_LINKS];
  int link_count;
} StDetail;
// glibren.42 (J7): onde cada jogo esta no store-games.json (deslocamento e tamanho do objeto), montado numa leitura so
// quando o arquivo muda (mtime, tamanho e inode); depois a ficha de um jogo e um pread so do pedaco dele.
typedef struct { char id[16]; uint64_t off; uint32_t len; } StGameAt;
typedef struct {
  const char* want;
  const char* key; // a key do indice
  int key_state;   // 0 nao visto, 1 igual, 2 diferente
  int found;
  char id[16];
  StDetail* d;
  // glibren.42 (J7): modo varredura (scan): anota cada jogo em `at` e a key do arquivo em scan_key, sem parar.
  int scan, at_count, at_cap;
  const char* base;
  StGameAt* at;
  char scan_key[96];
} StDetailParse;
static int st_about_item(JP* j, void* ctx) {
  StDetail* d = ctx;
  if (d->about_count >= ST_ABOUT) return jp_skip(j);
  if (!lib_text(j, d->about[d->about_count], sizeof d->about[0])) return 0;
  if (d->about[d->about_count][0]) ++d->about_count;
  return 1;
}
static int st_shot_item(JP* j, void* ctx) {
  StDetail* d = ctx;
  if (d->shot_count >= ST_SHOTS) return jp_skip(j);
  if (!lib_https(j, d->shots[d->shot_count], sizeof d->shots[0])) return 0;
  if (d->shots[d->shot_count][0]) ++d->shot_count;
  return 1;
}
static int st_link_field(JP* jp, const char* key, void* ctx) {
  StLink* l = ctx;
  if (!strcmp(key, "kind")) return lib_text(jp, l->kind, sizeof l->kind) ? 1 : -1;
  if (!strcmp(key, "group")) return lib_text(jp, l->group, sizeof l->group) ? 1 : -1;
  if (!strcmp(key, "host")) return lib_text(jp, l->host, sizeof l->host) ? 1 : -1;
  if (!strcmp(key, "format")) { if (!lib_text(jp, l->format, sizeof l->format)) return -1; lower_ascii(l->format); return 1; }
  if (!strcmp(key, "label")) return lib_text(jp, l->label, sizeof l->label) ? 1 : -1;
  if (!strcmp(key, "filename")) return lib_text(jp, l->filename, sizeof l->filename) ? 1 : -1;
  if (!strcmp(key, "rid")) return lib_text(jp, l->rid, sizeof l->rid) ? 1 : -1; // .58
  if (!strcmp(key, "url")) return lib_text(jp, l->url, sizeof l->url) ? 1 : -1;
  if (!strcmp(key, "sha256")) { if (!lib_text(jp, l->sha256, sizeof l->sha256)) return -1; lower_ascii(l->sha256); return 1; }
  if (!strcmp(key, "size")) { double v; int has; if (!st_number(jp, &v, &has)) return -1; l->has_size = has && v > 0; l->size = l->has_size ? (uint64_t)v : 0; return 1; }
  if (!strcmp(key, "parts")) { double v; int has; if (!st_number(jp, &v, &has)) return -1; l->parts = has && v > 0 && v < 1000 ? (unsigned)v : 0; return 1; }
  if (!strcmp(key, "source")) { double v; int has; if (!st_number(jp, &v, &has)) return -1; l->source = has && v >= 0 && v < 100000 ? (int)v : -1; return 1; }
  if (!strcmp(key, "solo")) return st_tristate(jp, &l->solo) ? 1 : -1;
  return 0;
}
// Um link que o payload baixa sozinho: direto, de um arquivo so, com URL http(s) e nome de arquivo. O "solo" que a Jobe
// grava manda; sem ele, a mesma regra daqui.
static int st_link_solo(const StLink* l) {
  const int usable = !strcmp(l->kind, "direct") && l->parts <= 1 && l->url[0] && safe_url(l->url) && lib_link_ok(l->url) && l->filename[0];
  if (l->solo == 0) return 0;
  return usable;
}
static int st_link_item(JP* j, void* ctx) {
  StDetail* d = ctx;
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{' || d->link_count >= ST_LINKS) return jp_skip(j);
  StLink* l = &d->links[d->link_count];
  memset(l, 0, sizeof *l);
  l->source = -1;
  l->solo = -1;
  if (!jp_object(j, st_link_field, l)) return 0;
  if (!l->kind[0]) copy_text(l->kind, sizeof l->kind, "unavailable");
  // A URL so vale num link direto (o resto nunca e baixado daqui).
  if (strcmp(l->kind, "direct")) l->url[0] = 0;
  if (!is_hex64(l->sha256)) l->sha256[0] = 0;
  ++d->link_count;
  return 1;
}
static int st_detail_field(JP* jp, const char* key, void* ctx) {
  StDetailParse* p = ctx;
  StDetail* d = p->d;
  if (!strcmp(key, "id")) return lib_text(jp, p->id, sizeof p->id) ? 1 : -1;
  if (!strcmp(key, "summary")) return lib_text(jp, d->summary, sizeof d->summary) ? 1 : -1;
  if (!strcmp(key, "hero")) return lib_https(jp, d->hero, sizeof d->hero) ? 1 : -1;
  if (!strcmp(key, "about")) return lib_list(jp, st_about_item, d) ? 1 : -1;
  if (!strcmp(key, "shots")) return jp_array(jp, st_shot_item, d) ? 1 : -1;
  if (!strcmp(key, "links")) return jp_array(jp, st_link_item, d) ? 1 : -1;
  return 0;
}
static int st_detail_item(JP* j, void* ctx) {
  StDetailParse* p = ctx;
  if (p->key_state == 2) return 0;
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{') return jp_skip(j);
  memset(p->d, 0, sizeof *p->d);
  p->id[0] = 0;
  const char* start = j->p;
  if (!jp_object(j, st_detail_field, p)) return 0;
  if (p->scan) {
    const uint64_t len = (uint64_t)(j->p - start);
    if (p->id[0] && len < (4u << 20)) {
      if (p->at_count == p->at_cap) {
        const int grown = p->at_cap ? p->at_cap * 2 : 1024;
        if (grown > ST_MAX_GAMES * 2) return 0;
        StGameAt* more = realloc(p->at, (size_t)grown * sizeof *more);
        if (!more) return 0;
        p->at = more;
        p->at_cap = grown;
      }
      StGameAt* a = &p->at[p->at_count++];
      copy_text(a->id, sizeof a->id, p->id);
      a->off = (uint64_t)(start - p->base);
      a->len = (uint32_t)len;
    }
    return 1;
  }
  if (strcmp(p->id, p->want)) return 1;
  p->found = 1;
  return p->key_state != 1; // achou: com a key ja conferida, o resto nao interessa
}
static int st_detail_top(JP* jp, const char* key, void* ctx) {
  StDetailParse* p = ctx;
  if (!strcmp(key, "key")) {
    char value[96];
    if (!lib_text(jp, value, sizeof value)) return -1;
    if (p->scan) { copy_text(p->scan_key, sizeof p->scan_key, value); p->key_state = 1; return 1; }
    p->key_state = strcmp(value, p->key) ? 2 : 1;
    return p->key_state == 2 ? -1 : 1; // outra key: para (vale como nao achado)
  }
  if (!strcmp(key, "games")) return jp_array(jp, st_detail_item, p) ? 1 : -1;
  return 0;
}
// A ficha e os links do jogo `id`: 1 achou (com a key do indice), 0 nao achou, 2 sem o arquivo, 4 de outra key.
// Lendo o arquivo inteiro (o caminho de antes; agora so a reserva do J7).
static int st_find_detail_full(const char* id, const char* key, StDetail* d) {
  char path[700];
  st_paths(NULL, 0, path, sizeof path);
  size_t size = 0;
  errno = 0;
  char* text = read_text(path, ST_GAMES_MAX_BYTES, &size);
  if (!text) return 2;
  StDetailParse p;
  memset(&p, 0, sizeof p);
  p.want = id;
  p.key = key;
  p.d = d;
  JP jp = {text, text + size, 0};
  jp_object(&jp, st_detail_top, &p);
  free(text);
  if (p.key_state == 2) return 4;
  if (!p.found) return 0;
  if (p.key_state != 1) return 4; // sem key: nao da para saber se e deste indice
  return 1;
}
// glibren.42 (J7): a tabela de deslocamentos do store-games.json (com g_store_games_lock).
static pthread_mutex_t g_store_games_lock = PTHREAD_MUTEX_INITIALIZER;
static StGameAt* g_games_at;
static int g_games_at_count, g_games_at_ok;
static int64_t g_games_at_mtime, g_games_at_mtime_ns;
static uint64_t g_games_at_size, g_games_at_ino;
static char g_games_at_key[96];
// Monta a tabela lendo o arquivo uma vez. 1 ok, 0 nao deu (o chamador usa a leitura inteira).
static int st_games_scan_locked(const char* path, const struct stat* st) {
  free(g_games_at);
  g_games_at = NULL;
  g_games_at_count = g_games_at_ok = 0;
  g_games_at_key[0] = 0;
  size_t size = 0;
  char* text = read_text(path, ST_GAMES_MAX_BYTES, &size);
  if (!text) return 0;
  StDetail* scratch = malloc(sizeof *scratch);
  if (!scratch) { free(text); return 0; }
  StDetailParse p;
  memset(&p, 0, sizeof p);
  p.want = "";
  p.key = "";
  p.d = scratch;
  p.scan = 1;
  p.base = text;
  JP jp = {text, text + size, 0};
  const int parsed = jp_object(&jp, st_detail_top, &p);
  free(scratch);
  free(text);
  if (!parsed || (uint64_t)size != (uint64_t)st->st_size) { free(p.at); return 0; }
  g_games_at = p.at;
  g_games_at_count = p.at_count;
  copy_text(g_games_at_key, sizeof g_games_at_key, p.scan_key);
  g_games_at_mtime = (int64_t)st->st_mtime;
  g_games_at_mtime_ns = (int64_t)st->st_mtim.tv_nsec;
  g_games_at_size = (uint64_t)st->st_size;
  g_games_at_ino = (uint64_t)st->st_ino;
  g_games_at_ok = 1;
  logf_("loja completa: indice de deslocamentos do store-games.json montado (%d jogos)", g_games_at_count);
  return 1;
}
static int st_find_detail(const char* id, const char* key, StDetail* d) {
  char path[700];
  st_paths(NULL, 0, path, sizeof path);
  struct stat st;
  if (stat(path, &st)) return 2;
  pthread_mutex_lock(&g_store_games_lock);
  const int same = g_games_at_ok && g_games_at_mtime == (int64_t)st.st_mtime && g_games_at_mtime_ns == (int64_t)st.st_mtim.tv_nsec &&
                   g_games_at_size == (uint64_t)st.st_size && g_games_at_ino == (uint64_t)st.st_ino;
  if (!same && !st_games_scan_locked(path, &st)) {
    pthread_mutex_unlock(&g_store_games_lock);
    return st_find_detail_full(id, key, d);
  }
  if (!g_games_at_key[0] || strcmp(g_games_at_key, key)) { pthread_mutex_unlock(&g_store_games_lock); return 4; }
  uint64_t off = 0;
  uint32_t len = 0;
  int found = 0;
  for (int i = 0; i < g_games_at_count && !found; ++i) if (!strcmp(g_games_at[i].id, id)) { off = g_games_at[i].off; len = g_games_at[i].len; found = 1; }
  pthread_mutex_unlock(&g_store_games_lock);
  if (!found) return 0;
  // Le so o objeto do jogo; o arquivo trocado no meio (outro inode/tamanho/mtime) ou outro id: a leitura inteira decide.
  char* slice = malloc((size_t)len + 1);
  if (!slice) return st_find_detail_full(id, key, d);
  int fd = open(path, O_RDONLY);
  struct stat now;
  int ok = fd >= 0 && !fstat(fd, &now) && (uint64_t)now.st_ino == (uint64_t)st.st_ino && now.st_size == st.st_size && now.st_mtime == st.st_mtime && now.st_mtim.tv_nsec == st.st_mtim.tv_nsec;
  size_t got = 0;
  while (ok && got < len) {
    const ssize_t n = pread(fd, slice + got, len - got, (off_t)(off + got));
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { ok = 0; break; }
    got += (size_t)n;
  }
  if (fd >= 0) close(fd);
  if (ok) {
    slice[len] = 0;
    StDetailParse p;
    memset(&p, 0, sizeof p);
    p.want = id;
    p.key = key;
    p.d = d;
    memset(d, 0, sizeof *d);
    JP jp = {slice, slice + len, 0};
    ok = jp_object(&jp, st_detail_field, &p) && !strcmp(p.id, id);
  }
  free(slice);
  if (ok) return 1;
  pthread_mutex_lock(&g_store_games_lock);
  g_games_at_ok = 0;
  pthread_mutex_unlock(&g_store_games_lock);
  return st_find_detail_full(id, key, d);
}
// Fase 3 (bg_catalog_api.c): o jogo e a ficha a partir do catalogo do payload. 1 achou, 0 nao, -1 sem catalogo.
static int catalog_store_entry(const char* id, StGame* out, char* key, size_t key_cap, StIndex* tables, StDetail* d);
// glibren.55: o grupo de um link (direct|page|torrent|browser|unavailable); um conjunto sem grupo gravado: "set".
static const char* st_link_group(const StLink* l) { return l->group[0] ? l->group : l->kind; }
// glibren.55: a referencia de um link de um jogo (16 hex): o id do jogo, a fonte, o host e o rotulo. A /app manda de
// volta com o indice escolhido; um link de outro jogo nao confere.
// .58: com o id do link (release.id) a referencia e so dele (jogo + id + host + rotulo), sem a posicao: o catalogo
// refeito entre abrir a ficha e tocar em Baixar (ou a ordem mudada pela saude dos links) nao a invalida.
static void st_link_ref(const char* game_id, const StLink* l, int index, char out[17]) {
  Hash h;
  char digest[65], number[24];
  hash_init(&h);
  hash_text0(&h, game_id);
  hash_text0(&h, "store-link");
  if (l->rid[0]) { hash_text0(&h, "rid"); hash_text0(&h, l->rid); }
  else { snprintf(number, sizeof number, "%d/%d", index, l->source); hash_text0(&h, number); }
  hash_text0(&h, l->host);
  hash_text0(&h, l->label);
  if (!hash_finish(&h, digest)) snprintf(digest, sizeof digest, "%016x", (unsigned)index);
  memcpy(out, digest, 16);
  out[16] = 0;
}
static int st_first_solo(const StDetail* d) {
  for (int i = 0; i < d->link_count; ++i) if (st_link_solo(&d->links[i])) return i;
  return -1;
}
// Copia o jogo `id` do indice (com g_store_lock): 1 achou, 0 nao, 2/3 o estado do indice.
static int st_lookup(const char* id, StGame* out, char* key, size_t key_cap, StIndex* tables) {
  pthread_mutex_lock(&g_store_lock);
  const int state = st_refresh_locked();
  if (state != 1 || !g_store) { pthread_mutex_unlock(&g_store_lock); return state == 1 ? 3 : state; }
  int found = 0;
  for (int i = 0; i < g_store->count && !found; ++i) {
    if (strcmp(g_store->games[i].id, id)) continue;
    *out = g_store->games[i];
    out->s = NULL;
    found = 1;
  }
  copy_text(key, key_cap, g_store->key);
  if (tables && found) {
    // So as tabelas de nomes (para o JSON do jogo), sem os jogos.
    StGame* games = tables->games;
    *tables = *g_store;
    tables->games = games;
    tables->count = tables->cap = 0;
  }
  pthread_mutex_unlock(&g_store_lock);
  return found;
}

// GET /api/store/game?id=
static void store_game(int fd, const char* query) {
  char id[64] = "";
  for (const char* p = query ? query : ""; *p;) {
    const size_t n = strcspn(p, "&");
    if (n > 3 && !strncmp(p, "id=", 3)) url_decode(p + 3, n - 3, id, sizeof id);
    p += n;
    if (*p == '&') ++p;
  }
  if (!id[0]) { monitor_json(fd, 400, "{\"error\":\"id\"}"); return; }
  StIndex* tables = calloc(1, sizeof *tables);
  StDetail* d = calloc(1, sizeof *d);
  if (!tables || !d) { free(tables); free(d); monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
  StGame g;
  char key[96];
  const int from_catalog = catalog_store_entry(id, &g, key, sizeof key, tables, d); // Fase 3
  const int found = from_catalog >= 0 ? from_catalog : st_lookup(id, &g, key, sizeof key, tables);
  if (found != 1) {
    free(tables); free(d);
    if (found == 0) monitor_json(fd, 404, "{\"error\":\"not-found\"}");
    else st_store_error(fd, found);
    return;
  }
  const int detail = from_catalog == 1 ? 1 : st_find_detail(id, key, d);
  Buf b = {0};
  buf_str(&b, "{\"ok\":true,\"game\":");
  pthread_mutex_lock(&g_lock);
  st_game_json(&b, tables, &g, st_queued_locked(g.id), 1);
  pthread_mutex_unlock(&g_lock);
  if (detail == 1) {
    buf_str(&b, ",\"details\":{\"summary\":"); buf_json(&b, d->summary);
    buf_str(&b, ",\"about\":[");
    for (int i = 0; i < d->about_count; ++i) { if (i) buf_str(&b, ","); buf_json(&b, d->about[i]); }
    buf_str(&b, "],\"shots\":[");
    for (int i = 0; i < d->shot_count; ++i) { if (i) buf_str(&b, ","); buf_json(&b, d->shots[i]); }
    buf_str(&b, "],\"hero\":"); buf_json(&b, d->hero);
    buf_str(&b, "}");
  }
  buf_str(&b, ",\"links\":[");
  for (int i = 0; detail == 1 && i < d->link_count; ++i) {
    const StLink* l = &d->links[i];
    char ref[17];
    st_link_ref(g.id, l, i, ref);
    if (i) buf_str(&b, ",");
    buf_fmt(&b, "{\"i\":%d,\"ref\":\"%s\",\"group\":", i, ref); buf_json(&b, st_link_group(l));
    buf_str(&b, ",\"kind\":"); buf_json(&b, l->kind);
    buf_str(&b, ",\"host\":"); buf_json(&b, l->host);
    buf_str(&b, ",\"format\":"); buf_json(&b, l->format);
    if (l->has_size) buf_fmt(&b, ",\"size\":%llu", (unsigned long long)l->size); else buf_str(&b, ",\"size\":null");
    buf_str(&b, ",\"label\":"); buf_json(&b, l->label);
    buf_fmt(&b, ",\"parts\":%u,\"solo\":%s", l->parts, st_link_solo(l) ? "true" : "false");
    if (l->rid[0]) { buf_str(&b, ",\"rid\":"); buf_json(&b, l->rid); } // .58
    buf_str(&b, "}");
  }
  // .58: o servico de debrid com chave neste console (a /app diz "via TorBox" num link de navegador ou torrent)
  char dkey[160];
  const char* debrid = debrid_key("torbox", dkey, sizeof dkey) ? "TorBox" : debrid_key("alldebrid", dkey, sizeof dkey) ? "AllDebrid" : "";
  memset(dkey, 0, sizeof dkey);
  buf_fmt(&b, "],\"download\":\"%s\",\"detailsState\":\"%s\",\"debrid\":\"%s\"}", detail == 1 && st_first_solo(d) >= 0 ? "payload" : "app",
          detail == 1 ? "ok" : detail == 2 ? "missing" : detail == 4 ? "stale" : "none", debrid);
  free(tables); free(d);
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_send(fd, 200, "application/json", b.data, b.size);
  free(b.data);
}

// POST /api/store/add {id, link?, ref?}
typedef struct { char id[32], ref[24]; int64_t link; int has_link; } StAddBody;
static int st_add_field(JP* jp, const char* key, void* ctx) {
  StAddBody* a = ctx;
  if (!strcmp(key, "id")) return lib_text(jp, a->id, sizeof a->id) ? 1 : -1;
  if (!strcmp(key, "ref")) return lib_text(jp, a->ref, sizeof a->ref) ? 1 : -1;
  if (!strcmp(key, "link")) { if (!jp_int64(jp, &a->link)) return -1; a->has_link = 1; return 1; }
  return 0;
}
static void store_add(int fd, Request* r) {
  if (!monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  StAddBody body;
  memset(&body, 0, sizeof body);
  body.link = -1;
  JP jp = {r->body, r->body + r->content_length, 0};
  if (!r->body || !jp_object(&jp, st_add_field, &body) || !body.id[0]) { monitor_json(fd, 400, "{\"error\":\"id\"}"); return; }
  const char* id = body.id;
  StDetail* d = calloc(1, sizeof *d);
  if (!d) { monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
  StGame g;
  char key[96];
  const int from_catalog = catalog_store_entry(id, &g, key, sizeof key, NULL, d); // Fase 3
  const int found = from_catalog >= 0 ? from_catalog : st_lookup(id, &g, key, sizeof key, NULL);
  if (found != 1) {
    free(d);
    if (found == 0) monitor_json(fd, 404, "{\"error\":\"not-found\"}");
    else st_store_error(fd, found);
    return;
  }
  const int have_links = from_catalog == 1 || st_find_detail(id, key, d) == 1;
  // glibren.55: o link escolhido na /app, conferido (o indice nesta ficha e a referencia deste jogo).
  // .58: o indice e so a dica; vale a referencia (o link pode ter mudado de lugar com o catalogo refeito).
  int picked = -1;
  if (body.has_link && body.link >= 0) {
    char ref[17] = "";
    if (have_links && body.link < d->link_count) st_link_ref(g.id, &d->links[body.link], (int)body.link, ref);
    if (ref[0] && !strcmp(ref, body.ref)) picked = (int)body.link;
    for (int i = 0; picked < 0 && have_links && body.ref[0] && i < d->link_count; ++i) {
      st_link_ref(g.id, &d->links[i], i, ref);
      if (!strcmp(ref, body.ref)) picked = i;
    }
    if (picked < 0) { free(d); monitor_json(fd, 400, "{\"error\":\"link\"}"); return; }
  }
  const int chosen = picked >= 0 ? (st_link_solo(&d->links[picked]) ? picked : -1) : have_links ? st_first_solo(d) : -1;
  const StLink* link = chosen >= 0 ? &d->links[chosen] : NULL;
  // O link que a Jobe vai usar no marcador: o escolhido; no automatico, o 1o da ordem da TV (ela pode passar pelo TorBox).
  const StLink* shown = picked >= 0 ? &d->links[picked] : have_links && d->link_count ? &d->links[0] : NULL;
  const int browser = !link && shown && (!strcmp(st_link_group(shown), "browser") || !strcmp(st_link_group(shown), "set"));
  // O destino (as regras do app) antes de travar a fila: so quando o payload pode baixar sozinho.
  char root[1024], name[256] = "";
  int convert = 0;
  pthread_mutex_lock(&g_lock);
  copy_text(root, sizeof root, g_auto_root);
  convert = g_auto_convert;
  pthread_mutex_unlock(&g_lock);
  AutoPlan plan;
  int planned = 0;
  if (link && root[0] && app_away()) {
    auto_safe_name(link->filename, name, sizeof name);
    planned = auto_plan(root, name, g.title, g.code, convert, &plan);
    struct stat st;
    if (planned && (!stat(plan.destination, &st) || (plan.publish[0] && !stat(plan.publish, &st)))) {
      free(d);
      monitor_json(fd, 409, "{\"error\":\"exists\"}");
      return;
    }
    if (planned) {
      char parent[1500];
      copy_text(parent, sizeof parent, plan.destination);
      char* slash = strrchr(parent, '/');
      if (slash) { *slash = 0; mkdir_p(parent); }
    }
  }
  char answer[260], job_id[24] = "";
  const char* platform = g.platform == 1 ? "ps5" : g.platform == 2 ? "ps4" : "";
  pthread_mutex_lock(&g_lock);
  Job* same = st_request_locked(g.id);
  // Um pedido que falhou (ou foi recusado pelo app) da lugar a um novo; um vivo responde "ja esta".
  if (same && (!strcmp(same->state, "failed") || !strcmp(same->state, "cancelled")) && !same->running) { remove_job_locked(same); same = NULL; }
  const int away = app_away();
  int via_payload = 0;
  const char* reason = "";
  if (same) {
    copy_text(job_id, sizeof job_id, same->id);
    snprintf(answer, sizeof answer, "{\"ok\":true,\"already\":true,\"id\":\"%s\"}", job_id);
  } else if (g_job_count >= MAX_JOBS) {
    pthread_mutex_unlock(&g_lock);
    free(d);
    monitor_json(fd, 409, "{\"error\":\"full\"}");
    return;
  } else {
    Job* j = calloc(1, sizeof *j);
    if (!j) { pthread_mutex_unlock(&g_lock); free(d); monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
    Hash h;
    char digest[65];
    hash_init(&h);
    hash_text0(&h, g.id);
    hash_text0(&h, "store");
    if (!hash_finish(&h, digest)) snprintf(digest, sizeof digest, "%032x", g_next_id + 1);
    snprintf(j->key, sizeof j->key, "store-%.24s", digest);
    snprintf(j->id, sizeof j->id, "b%u", ++g_next_id);
    j->requested = 1;
    copy_utf8(j->name, sizeof j->name, g.title);
    j->created = j->updated = now_s();
    snprintf(j->lib_id, sizeof j->lib_id, "%s", g.id);
    copy_text(j->lib_store, sizeof j->lib_store, g.id);
    snprintf(j->lib_release, sizeof j->lib_release, "store");
    copy_text(j->lib_code, sizeof j->lib_code, g.code);
    snprintf(j->lib_platform, sizeof j->lib_platform, "%s", platform);
    j->total = link && link->has_size ? link->size : 0;
    via_payload = away && planned && link;
    if (via_payload) {
      j->ahead = 1;
      j->auto_started = 1;
      j->auto_convert = plan.convert;
      j->store_source = link->source >= 0 ? link->source + 1 : 0;
      copy_text(j->store_rid, sizeof j->store_rid, link->rid); // .58
      snprintf(j->lib_via, sizeof j->lib_via, "direct");
      copy_text(j->lib_file, sizeof j->lib_file, name);
      snprintf(j->url, sizeof j->url, "%s", link->url);
      copy_text(j->destination, sizeof j->destination, plan.destination);
      copy_text(j->storage_root, sizeof j->storage_root, root);
      copy_text(j->publish_to, sizeof j->publish_to, plan.publish);
      snprintf(j->provider, sizeof j->provider, "direct");
      copy_text(j->sha256, sizeof j->sha256, link->sha256);
      j->link_at = now_s();
      j->reject_html = 1;
      j->range_bytes = DEFAULT_RANGE;
      j->connections = 8;
      j->expected_bytes = 0; // o tamanho do catalogo e uma ideia; vale o do servidor
      copy_text(j->code, sizeof j->code, g.code);
      snprintf(j->platform, sizeof j->platform, "%s", plan.ps4 ? "ps4" : "ps5");
      copy_text(j->file, sizeof j->file, name);
      if (origin_format_ok(plan.format)) copy_text(j->format, sizeof j->format, plan.format);
      snprintf(j->state, sizeof j->state, "queued");
      snprintf(j->notify_done, sizeof j->notify_done, "Jobee'sLair: %.120s %s", j->name,
               plan.convert ? "baixado pelo celular; convertendo para .exfat." : plan.pkg && plan.ps4 ? "baixado pelo celular; abra a Jobee'sLair para instalar (aba Arquivos)." : "baixado pelo celular.");
      snprintf(j->notify_failed, sizeof j->notify_failed, "Jobee'sLair: %.120s nao baixou pelo celular.", j->name);
    } else {
      // Marcador: a Jobe poe na fila dela (aberta agora, ou quando abrir) com a fonte que ela escolher.
      j->placeholder = 1;
      j->order = 100000; // depois da fila do app
      if (picked >= 0 && d->links[picked].source >= 0) j->store_source = d->links[picked].source + 1; // glibren.55
      if (picked >= 0) copy_text(j->store_rid, sizeof j->store_rid, d->links[picked].rid); // .58: o app acha a fonte pelo id
      snprintf(j->lib_via, sizeof j->lib_via, "store");
      snprintf(j->state, sizeof j->state, "waiting-app");
      reason = !away ? "open" : !link ? "needs-app" : !root[0] ? "no-root" : "plan";
      snprintf(j->auto_note, sizeof j->auto_note, "%s", !away ? "store" : !link ? "needs-app" : !root[0] ? "no-root" : "needs-app");
    }
    g_jobs[g_job_count++] = j;
    save_jobs_locked();
    pthread_cond_broadcast(&g_wake_downloader);
    copy_text(job_id, sizeof job_id, j->id);
    if (via_payload) snprintf(answer, sizeof answer, "{\"ok\":true,\"id\":\"%s\",\"via\":\"payload\",\"picked\":%d,\"browser\":false}", job_id, picked);
    else snprintf(answer, sizeof answer, "{\"ok\":true,\"id\":\"%s\",\"via\":\"app\",\"appOpen\":%s,\"reason\":\"%s\",\"picked\":%d,\"browser\":%s}", job_id, away ? "false" : "true", reason, picked, browser ? "true" : "false");
  }
  const int created = !same;
  pthread_mutex_unlock(&g_lock);
  if (created) {
    logf_("celular: pedido da loja completa: %s (%s)", g.title, via_payload ? "o payload baixa sozinho" : "espera a Jobee'sLair");
    if (away) {
      char text[400];
      if (via_payload) snprintf(text, sizeof text, "Jobee'sLair: %.200s entrou na fila pelo celular e vai baixar pelo payload.", g.title);
      else snprintf(text, sizeof text, "Jobee'sLair: %.200s entrou na fila pelo celular. Abra a Jobee'sLair para baixar.", g.title);
      notify(text);
    }
  }
  free(d);
  monitor_json(fd, 200, answer);
}

// As rotas da loja na porta do celular: 1 quando era uma delas.
static int store_route(int fd, Request* r, const char* query) {
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/store")) { store_list(fd, query); return 1; }
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/store/game")) { store_game(fd, query); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/store/add")) { store_add(fd, r); return 1; }
  return 0;
}
