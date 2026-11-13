// glibren.20: o catalogo publico do Orbit Store como um feed da Jobe, ligado nas Configuracoes (POST /orbit).
//
// Como o proprio Orbit faz (backend/catalog.c do fonte GPL-3 dele): baixa catalogue-v8.enc do GitHub ao ligar e depois
// a cada 6 h, respeitando Retry-After. O arquivo e um envelope "ORBITENC" (magic[8], formato 1, id de chave 1,
// proposito 1 = feed, 0, nonce[12], texto cifrado, tag[16]) em AES-256-GCM com os 24 bytes do cabecalho como AAD.
// Decifrado, e { schemaVersion: 1, feedVersion: 8, revision, releases: [...], addons: [...] }, um item por link.
//
// O payload agrupa os links por codigo do jogo e grava o feed da Jobe (version 1, games, releases) em
// <dir>/orbit-store.json, com descricao, capa e fundo; o app le esse arquivo como um feed do PS5. Os add-ons ficam de
// fora (o feed da Jobe nao tem DLC separado do jogo). Uma revisao igual a gravada nao reescreve o arquivo: o app so le
// de novo quando ele muda.
//
// glibren.27: o app manda os codigos que ja conhece sem a lista (o catalogo embutido, as outras edicoes e os outros feeds)
// no POST /orbit {"known": [...]}; o payload guarda em <dir>/orbit-known.txt e, para um jogo conhecido, grava so codigo,
// nome, plataforma e os links (o app junta os links ao jogo que ja tem; descricao, capa e fundo sao os do catalogo). So os
// ~220 jogos que o app nao tem vao com a pagina inteira. Com 2.458 jogos a lista inteira pesava ~11 MB no heap de 32 MiB
// do app e ele fechava ao abrir. Uma lista de conhecidos diferente regrava o feed (baixa de novo).
//
// <dir>/orbit-store-status.json guarda o estado (ligado, ultima tentativa, ultima vez que deu certo, revisao e desde
// quando ela nao muda, erro). "stale" diz quando a lista parou de atualizar, e o payload manda uma notificacao do PS5
// quando isso comeca e quando volta:
//   "broken"  o arquivo baixou mas nao abre (o Orbit trocou a chave ou o formato): na hora;
//   "failing" nenhuma atualizacao deu certo nas ultimas 24 h (rede, GitHub fora, arquivo removido);
//   "quiet"   baixa, mas o Orbit nao publica uma revisao nova ha 14 dias (o projeto pode ter parado).
#include "orbit_key.h"

#define ORBIT_URL "https://raw.githubusercontent.com/saawant12/orbit-store-ps5/main/catalogue-v8.enc"
#define ORBIT_SEAL_LIMIT (16u * 1024u * 1024u)
#define ORBIT_OVERHEAD 40u
#define ORBIT_HEADER 24u
#define ORBIT_TAG 16u
#define ORBIT_STALE_S (24 * 3600)
#define ORBIT_QUIET_S (14 * 24 * 3600)
// glibren.26: versao da conversao; mudou, o feed e regravado mesmo sem revisao nova do Orbit (o corte do about).
// glibren.27: 3, o jogo que o app ja conhece vai so com os links (ver "known").
#define ORBIT_CONV 3
#define ORBIT_KNOWN_MAX 20000         // glibren.27: codigos conhecidos aceitos no POST /orbit (o resto e ignorado)
#define ORBIT_KNOWN_RETRY_S (15 * 60) // glibren.27: regravar para uma lista de conhecidos nova depois de uma falha
#define ORBIT_MIN_GAP_S 60 // um "Atualizar" logo depois de outra tentativa nao baixa de novo

typedef struct {
  int enabled, busy, kick;
  int64_t enabled_at, last_try, last_ok, revision_since, retry_until, next_try;
  uint64_t revision;
  int games, releases;
  int conv; // glibren.26: ORBIT_CONV de quem gravou o feed
  int known; // glibren.27: quantos codigos conhecidos o feed gravado usou (0: a lista inteira, sem nenhum)
  char known_hash[17]; // glibren.27: o hash da lista de conhecidos do feed gravado ("" sem lista)
  char kind[12];   // "", "network", "broken"
  char error[200];
  char said[12];   // o "stale" que ja foi notificado
} OrbitState;
static OrbitState g_orbit;
static pthread_mutex_t g_orbit_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_orbit_wake = PTHREAD_COND_INITIALIZER;
static char g_orbit_dir[600], g_orbit_feed[700], g_orbit_status[700], g_orbit_url[600];
static int64_t g_orbit_every = 6 * 3600;
// glibren.27: os codigos que o app conhece (ordenados, sem repetir), o hash deles e o arquivo onde ficam.
typedef char OrbitId[10];
static OrbitId* g_known;
static size_t g_known_count;
static char g_known_hex[17], g_orbit_known_file[700];

// Em que pe a lista esta (com g_orbit_lock): "" quando esta em dia ou desligada.
static const char* orbit_stale_locked(int64_t now) {
  if (!g_orbit.enabled) return "";
  if (!strcmp(g_orbit.kind, "broken")) return "broken";
  const int64_t since = g_orbit.last_ok ? g_orbit.last_ok : g_orbit.enabled_at;
  if (g_orbit.last_try && since && now - since > ORBIT_STALE_S) return "failing";
  if (g_orbit.last_ok && g_orbit.revision_since && now - g_orbit.revision_since > ORBIT_QUIET_S) return "quiet";
  return "";
}

static void orbit_json_locked(Buf* b, int64_t now) {
  buf_fmt(b, "{\"enabled\":%s,\"busy\":%s,\"enabledAt\":%lld,\"lastTry\":%lld,\"lastOk\":%lld,\"revision\":%llu,"
          "\"revisionSince\":%lld,\"retryUntil\":%lld,\"games\":%d,\"releases\":%d,\"conv\":%d,\"known\":%d,\"knownIds\":%zu,"
          "\"knownHash\":\"%s\",\"kind\":",
          g_orbit.enabled ? "true" : "false", g_orbit.busy ? "true" : "false", (long long)g_orbit.enabled_at,
          (long long)g_orbit.last_try, (long long)g_orbit.last_ok, (unsigned long long)g_orbit.revision,
          (long long)g_orbit.revision_since, (long long)g_orbit.retry_until, g_orbit.games, g_orbit.releases, g_orbit.conv,
          g_orbit.known, g_known_count, g_orbit.known_hash);
  buf_json(b, g_orbit.kind);
  buf_str(b, ",\"error\":");
  buf_json(b, g_orbit.error);
  buf_str(b, ",\"stale\":");
  buf_json(b, orbit_stale_locked(now));
  buf_str(b, ",\"said\":");
  buf_json(b, g_orbit.said);
  buf_fmt(b, ",\"feed\":");
  buf_json(b, g_orbit_feed);
  buf_fmt(b, ",\"now\":%lld}", (long long)now);
}

static void orbit_save_locked(void) {
  Buf b = {0};
  orbit_json_locked(&b, now_s());
  buf_str(&b, "\n");
  if (b.failed || !b.data || !save_atomic(g_orbit_status, b.data, b.size, 0644)) logf_("orbit: estado nao gravado: %s", strerror(errno));
  free(b.data);
}

static int orbit_status_field(JP* jp, const char* key, void* ctx) {
  OrbitState* s = ctx;
  int64_t value = 0;
  uint64_t number = 0;
  if (!strcmp(key, "enabled")) return jp_bool(jp, &s->enabled) ? 1 : -1;
  if (!strcmp(key, "revision")) { if (!jp_uint(jp, &number)) return -1; s->revision = number; return 1; }
  if (!strcmp(key, "kind")) return jp_text(jp, s->kind, sizeof s->kind) ? 1 : -1;
  if (!strcmp(key, "error")) return lib_text(jp, s->error, sizeof s->error) ? 1 : -1;
  if (!strcmp(key, "conv")) { if (!jp_uint(jp, &number)) return -1; s->conv = (int)number; return 1; }
  if (!strcmp(key, "known")) { if (!jp_uint(jp, &number)) return -1; s->known = (int)(number > ORBIT_KNOWN_MAX ? 0 : number); return 1; }
  if (!strcmp(key, "knownHash")) return lib_text(jp, s->known_hash, sizeof s->known_hash) ? 1 : -1;
  if (!strcmp(key, "said")) return jp_text(jp, s->said, sizeof s->said) ? 1 : -1;
  int64_t* slot = !strcmp(key, "enabledAt") ? &s->enabled_at : !strcmp(key, "lastTry") ? &s->last_try :
                  !strcmp(key, "lastOk") ? &s->last_ok : !strcmp(key, "revisionSince") ? &s->revision_since :
                  !strcmp(key, "retryUntil") ? &s->retry_until : NULL;
  if (slot) { if (!jp_int64(jp, &value)) return -1; *slot = value; return 1; }
  if (!strcmp(key, "games") || !strcmp(key, "releases")) {
    if (!jp_uint(jp, &number)) return -1;
    *(!strcmp(key, "games") ? &s->games : &s->releases) = (int)(number > 1000000 ? 0 : number);
    return 1;
  }
  return jp_skip(jp) ? 1 : -1;
}

static void orbit_load(void) {
  size_t size = 0;
  char* text = read_text(g_orbit_status, 64 * 1024, &size);
  if (!text) return;
  OrbitState s;
  memset(&s, 0, sizeof s);
  JP jp = {text, text + size, 0};
  if (jp_object(&jp, orbit_status_field, &s)) {
    pthread_mutex_lock(&g_orbit_lock);
    g_orbit = s;
    g_orbit.busy = 0;
    g_orbit.kick = 0;
    pthread_mutex_unlock(&g_orbit_lock);
  } else {
    logf_("orbit: %s ilegivel; comecando do zero", g_orbit_status);
  }
  free(text);
}

// ---- glibren.27: os codigos que o app ja conhece ------------------------------------------------------------

static int orbit_id_cmp(const void* a, const void* b) { return strcmp(a, b); }
// Ordena, tira repetidos e calcula o hash (FNV-1a 64 dos codigos em ordem); "" para a lista vazia.
static size_t orbit_known_tidy(OrbitId* ids, size_t count, char hex[17]) {
  size_t n = 0;
  if (count) qsort(ids, count, sizeof *ids, orbit_id_cmp);
  for (size_t i = 0; i < count; ++i) if (!n || strcmp(ids[n - 1], ids[i])) memmove(ids[n++], ids[i], sizeof *ids);
  uint64_t h = 1469598103934665603ull;
  for (size_t i = 0; i < n; ++i)
    for (const char* p = ids[i];; ++p) { h = (h ^ (unsigned char)(*p ? *p : '\n')) * 1099511628211ull; if (!*p) break; }
  if (n) snprintf(hex, 17, "%016llx", (unsigned long long)h);
  else hex[0] = 0;
  return n;
}
static int orbit_title_ok(const char* id);
static void orbit_known_app_locked(OrbitId* ids, size_t count); // Fase 3 (bg_catalog_api.c)
// Um codigo valido de PS4/PS5 vai para a lista (em maiusculas); o resto e ignorado. 0 sem memoria.
static int orbit_known_add(OrbitId** ids, size_t* count, size_t* cap, const char* text) {
  char id[10];
  if (strlen(text) != 9) return 1;
  for (int i = 0; i < 10; ++i) id[i] = (char)toupper((unsigned char)text[i]);
  if (!orbit_title_ok(id) || *count >= ORBIT_KNOWN_MAX) return 1;
  if (*count == *cap) {
    const size_t next_cap = *cap ? *cap * 2 : 1024;
    OrbitId* next = realloc(*ids, next_cap * sizeof *next);
    if (!next) return 0;
    *ids = next;
    *cap = next_cap;
  }
  memcpy((*ids)[(*count)++], id, sizeof id);
  return 1;
}
// Troca a lista (com g_orbit_lock; fica com `ids`) e grava o arquivo; 1 se mudou.
static int orbit_known_set_locked(OrbitId* ids, size_t count) {
  char hex[17];
  count = orbit_known_tidy(ids, count, hex);
  if (!strcmp(hex, g_known_hex)) { free(ids); return 0; }
  free(g_known);
  g_known = ids;
  g_known_count = count;
  snprintf(g_known_hex, sizeof g_known_hex, "%s", hex);
  Buf b = {0};
  for (size_t i = 0; i < count; ++i) { buf_str(&b, ids[i]); buf_str(&b, "\n"); }
  if (b.failed || !save_atomic(g_orbit_known_file, b.data ? b.data : "", b.size, 0644))
    logf_("orbit: %s nao gravado: %s", g_orbit_known_file, strerror(errno));
  free(b.data);
  return 1;
}
// Ao subir: a lista que o app mandou da ultima vez.
static void orbit_known_load(void) {
  size_t size = 0;
  char* text = read_text(g_orbit_known_file, 1024 * 1024, &size);
  if (!text) return;
  OrbitId* ids = NULL;
  size_t count = 0, cap = 0;
  for (char* line = text; line && *line;) {
    char* next = strchr(line, '\n');
    if (next) *next++ = 0;
    if (!orbit_known_add(&ids, &count, &cap, line)) break;
    line = next;
  }
  free(text);
  pthread_mutex_lock(&g_orbit_lock);
  if (orbit_known_set_locked(ids, count)) logf_("orbit: %zu codigos conhecidos lidos de %s", g_known_count, g_orbit_known_file);
  pthread_mutex_unlock(&g_orbit_lock);
}

// ---- Envelope ORBITENC ----------------------------------------------------------------------------------

// 0 com o JSON em *out (terminado em 0); -1 nao e um envelope de feed do Orbit; -2 nao autentica (outra chave).
static int orbit_open(const unsigned char* buf, size_t size, char** out, size_t* length) {
  static const unsigned char prefix[10] = {'O', 'R', 'B', 'I', 'T', 'E', 'N', 'C', 1, 1};
  *out = NULL;
  *length = 0;
  if (size <= ORBIT_OVERHEAD || size > ORBIT_SEAL_LIMIT + ORBIT_OVERHEAD) return -1;
  if (memcmp(buf, prefix, 8)) return -1;
  if (memcmp(buf, prefix, sizeof prefix) || buf[10] != 1 || buf[11]) return -2; // outro formato ou id de chave
  const size_t plain_size = size - ORBIT_OVERHEAD;
  unsigned char* plain = malloc(plain_size + 1);
  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  int n = 0, final = 0, ignored = 0, ok = 0;
  const int allocated = plain && ctx;
  if (allocated &&
      EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL) == 1 &&
      EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, NULL) == 1 &&
      EVP_DecryptInit_ex(ctx, NULL, NULL, orbit_key, buf + 12) == 1 &&
      EVP_DecryptUpdate(ctx, NULL, &ignored, buf, (int)ORBIT_HEADER) == 1 &&
      EVP_DecryptUpdate(ctx, plain, &n, buf + ORBIT_HEADER, (int)plain_size) == 1 &&
      EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, (int)ORBIT_TAG, (void*)(buf + ORBIT_HEADER + plain_size)) == 1 &&
      EVP_DecryptFinal_ex(ctx, plain + n, &final) == 1 && (size_t)(n + final) == plain_size)
    ok = 1;
  EVP_CIPHER_CTX_free(ctx);
  if (!ok) { free(plain); return allocated ? -2 : -1; }
  plain[plain_size] = 0;
  *out = (char*)plain;
  *length = plain_size;
  return 0;
}

// ---- Conversao para o feed da Jobe ----------------------------------------------------------------------

enum { OF_ID, OF_TITLE_ID, OF_PLATFORM, OF_SOURCE, OF_PROVIDER, OF_URL, OF_FILENAME, OF_FORMAT, OF_COMPRESSION,
       OF_SHA, OF_VERSION, OF_REGION, OF_TITLE, OF_GENRE, OF_TAGLINE, OF_DESCRIPTION, OF_NOTES, OF_COVER, OF_HERO,
       OF_COVER_FALLBACK, OF_PUBLISHER, OF_DATE, OF_ADDED, OF_COUNT };
static const struct { const char* key; size_t cap; } ORBIT_FIELDS[OF_COUNT] = {
  {"id", 80}, {"titleId", 16}, {"platform", 8}, {"sourceId", 24}, {"provider", 40}, {"url", 2048}, {"filename", 160},
  {"format", 24}, {"compression", 12}, {"sha256", 72}, {"version", 32}, {"region", 16}, {"title", 200}, {"genre", 40},
  {"tagline", 600}, {"description", 4000}, {"notes", 600}, {"cover", 1024}, {"hero", 1024}, {"coverFallback", 1024},
  {"publisher", 120}, {"releaseDate", 16}, {"addedAt", 40},
};
typedef struct { char* f[OF_COUNT]; uint64_t size; size_t order; } OrbitRel;
typedef struct { OrbitRel* items; size_t count, cap; uint64_t revision; int has_revision, has_releases, failed; } OrbitDoc;

static void orbit_rel_free(OrbitRel* r) {
  for (int i = 0; i < OF_COUNT; ++i) free(r->f[i]);
}
static int orbit_rel_field(JP* jp, const char* key, void* ctx) {
  OrbitRel* r = ctx;
  if (!strcmp(key, "sizeBytes")) return lib_uint(jp, &r->size) ? 1 : -1;
  for (int i = 0; i < OF_COUNT; ++i) {
    if (strcmp(key, ORBIT_FIELDS[i].key)) continue;
    char text[4097];
    if (!lib_text(jp, text, ORBIT_FIELDS[i].cap + 1 < sizeof text ? ORBIT_FIELDS[i].cap + 1 : sizeof text)) return -1;
    if (text[0] && !r->f[i]) r->f[i] = strdup(text);
    return 1;
  }
  return jp_skip(jp) ? 1 : -1;
}
static int orbit_title_ok(const char* id) {
  if (!id || strlen(id) != 9 || (strncmp(id, "PPSA", 4) && strncmp(id, "CUSA", 4))) return 0;
  for (int i = 4; i < 9; ++i) if (!isdigit((unsigned char)id[i])) return 0;
  return 1;
}
static int orbit_rel_item(JP* jp, void* ctx) {
  OrbitDoc* d = ctx;
  OrbitRel r;
  memset(&r, 0, sizeof r);
  jp_ws(jp);
  if (jp->p >= jp->end || *jp->p != '{') return jp_skip(jp);
  if (!jp_object(jp, orbit_rel_field, &r)) { orbit_rel_free(&r); return 0; }
  if (r.f[OF_TITLE_ID]) for (char* p = r.f[OF_TITLE_ID]; *p; ++p) *p = (char)toupper((unsigned char)*p);
  // So jogos com codigo de PS4/PS5, nome e um link https (o resto o app tambem largaria).
  if (!orbit_title_ok(r.f[OF_TITLE_ID]) || !r.f[OF_TITLE] || !r.f[OF_URL] || strncmp(r.f[OF_URL], "https://", 8)) {
    orbit_rel_free(&r);
    return 1;
  }
  if (d->count == d->cap) {
    const size_t cap = d->cap ? d->cap * 2 : 1024;
    OrbitRel* next = realloc(d->items, cap * sizeof *next);
    if (!next) { orbit_rel_free(&r); d->failed = 1; return 0; }
    d->items = next;
    d->cap = cap;
  }
  r.order = d->count;
  d->items[d->count++] = r;
  return 1;
}
static int orbit_doc_field(JP* jp, const char* key, void* ctx) {
  OrbitDoc* d = ctx;
  if (!strcmp(key, "revision")) { d->has_revision = 1; return jp_uint(jp, &d->revision) ? 1 : -1; }
  if (!strcmp(key, "releases")) {
    jp_ws(jp);
    if (jp->p >= jp->end || *jp->p != '[') return -1;
    d->has_releases = 1;
    return jp_array(jp, orbit_rel_item, d) ? 1 : -1;
  }
  return jp_skip(jp) ? 1 : -1;
}
static int orbit_rel_cmp(const void* a, const void* b) {
  const OrbitRel* x = a;
  const OrbitRel* y = b;
  const int c = strcmp(x->f[OF_TITLE_ID], y->f[OF_TITLE_ID]);
  return c ? c : x->order < y->order ? -1 : x->order > y->order;
}
static const char* orbit_s(const OrbitRel* r, int field) { return r->f[field] ? r->f[field] : ""; }
// O formato da Jobe: o do compactado quando ha um (o app extrai e acha o jogo dentro), senao o da imagem/pacote.
static const char* orbit_format(const OrbitRel* r) {
  const char* c = orbit_s(r, OF_COMPRESSION);
  if (!strcmp(c, "rar") || !strcmp(c, "7z") || !strcmp(c, "zip")) return c;
  const char* f = orbit_s(r, OF_FORMAT);
  if (!strcasecmp(f, "FFPFSC")) return "ffpfsc";
  if (!strcasecmp(f, "exFAT")) return "exfat";
  if (!strcasecmp(f, "PKG")) return "pkg";
  if (!strcasecmp(f, "FPKG")) return "fpkg";
  return "";
}
// "Vikingfile - EUR - exFAT (rar)": de onde vem, a regiao e o que tem dentro.
static void orbit_label(const OrbitRel* r, char* out, size_t cap) {
  const char* provider = r->f[OF_PROVIDER] ? r->f[OF_PROVIDER] : orbit_s(r, OF_SOURCE);
  const char* region = orbit_s(r, OF_REGION);
  const char* format = orbit_s(r, OF_FORMAT);
  const char* compression = orbit_s(r, OF_COMPRESSION);
  snprintf(out, cap, "%s%s%s%s%s%s%s%s", provider, *region ? " - " : "", region, *format ? " - " : "", format,
           *compression ? " (" : "", compression, *compression ? ")" : "");
}
static void orbit_release_json(Buf* b, const OrbitRel* r) {
  char label[200];
  orbit_label(r, label, sizeof label);
  buf_str(b, "{\"url\":");
  buf_json(b, r->f[OF_URL]);
  if (r->f[OF_FILENAME]) { buf_str(b, ",\"filename\":"); buf_json(b, r->f[OF_FILENAME]); }
  if (r->size > 0 && r->size <= SAFE_INTEGER) buf_fmt(b, ",\"sizeBytes\":%llu", (unsigned long long)r->size);
  const char* format = orbit_format(r);
  if (*format) { buf_str(b, ",\"format\":"); buf_json(b, format); }
  if (r->f[OF_VERSION]) { buf_str(b, ",\"version\":"); buf_json(b, r->f[OF_VERSION]); }
  if (r->f[OF_SHA] && strlen(r->f[OF_SHA]) == 64) { buf_str(b, ",\"sha256\":"); buf_json(b, r->f[OF_SHA]); }
  buf_str(b, ",\"provider\":");
  buf_json(b, r->f[OF_PROVIDER] ? r->f[OF_PROVIDER] : orbit_s(r, OF_SOURCE));
  buf_str(b, ",\"label\":");
  buf_json(b, label);
  // Cada link e o seu proprio conjunto (sem "record", a Jobe juntaria os links do jogo como partes de um so).
  char record[100];
  snprintf(record, sizeof record, "orbit-%s", r->f[OF_ID] ? r->f[OF_ID] : "");
  if (!r->f[OF_ID]) snprintf(record, sizeof record, "orbit-%s-%zu", r->f[OF_TITLE_ID], r->order);
  buf_str(b, ",\"record\":");
  buf_json(b, record);
  buf_str(b, "}");
}
#define ORBIT_ABOUT_MAX 1500
static void orbit_game_json(Buf* b, OrbitRel* first, size_t count, int known) {
  const OrbitRel* g = first;
  buf_str(b, "{\"id\":");
  buf_json(b, g->f[OF_TITLE_ID]);
  buf_str(b, ",\"title\":");
  buf_json(b, g->f[OF_TITLE]);
  const char* platform = orbit_s(g, OF_PLATFORM);
  buf_str(b, ",\"platform\":");
  buf_json(b, !strcmp(platform, "ps4") || !strcmp(platform, "ps5") ? platform : !strncmp(g->f[OF_TITLE_ID], "PPSA", 4) ? "ps5" : "ps4");
  // glibren.27: um jogo que o app ja conhece vai so com os links (o app usa a pagina, a capa e o fundo que ja tem).
  if (known) goto releases;
  if (g->f[OF_PUBLISHER]) { buf_str(b, ",\"publisher\":"); buf_json(b, g->f[OF_PUBLISHER]); }
  const char* date = orbit_s(g, OF_DATE);
  if (strlen(date) == 10) { buf_str(b, ",\"releaseDate\":"); buf_json(b, date); }
  const char* added = orbit_s(g, OF_ADDED);
  if (strlen(added) >= 10) {
    char day[11];
    memcpy(day, added, 10);
    day[10] = 0;
    buf_str(b, ",\"addedAt\":");
    buf_json(b, day);
  }
  if (g->f[OF_GENRE]) { buf_str(b, ",\"genres\":["); buf_json(b, g->f[OF_GENRE]); buf_str(b, "]"); }
  // A descricao e a frase de efeito (a ficha do jogo); o resumo e a frase, ou a descricao quando nao ha frase.
  const char* summary = g->f[OF_TAGLINE] ? g->f[OF_TAGLINE] : orbit_s(g, OF_DESCRIPTION);
  if (*summary) {
    char cut[601];
    copy_utf8(cut, sizeof cut, summary);
    buf_str(b, ",\"summary\":");
    buf_json(b, cut);
  }
  // glibren.26: a descricao vai com no maximo ORBIT_ABOUT_MAX bytes (cortada numa palavra, com "..."): o app le a lista
  // inteira no heap de 32 MiB e, com 2.458 jogos, descricoes de ate 4.000 caracteres pesavam ao lado da Biblioteca
  // TorBox. A capa, o fundo (hero) e as outras capas ficam todos.
  if (g->f[OF_DESCRIPTION]) {
    char about[ORBIT_ABOUT_MAX + 4];
    copy_utf8(about, ORBIT_ABOUT_MAX + 1, g->f[OF_DESCRIPTION]);
    size_t n = strlen(about);
    if (g->f[OF_DESCRIPTION][n]) {
      while (n > ORBIT_ABOUT_MAX / 2 && about[n - 1] != ' ') --n;
      while (n > 0 && about[n - 1] == ' ') --n;
      memcpy(about + n, "...", 4);
    }
    buf_str(b, ",\"about\":[");
    buf_json(b, about);
    buf_str(b, "]");
  }
  buf_str(b, ",\"art\":{");
  int comma = 0;
  if (g->f[OF_COVER]) { buf_str(b, "\"cover\":"); buf_json(b, g->f[OF_COVER]); comma = 1; }
  if (g->f[OF_HERO]) { buf_str(b, comma ? ",\"hero\":" : "\"hero\":"); buf_json(b, g->f[OF_HERO]); comma = 1; }
  if (g->f[OF_COVER_FALLBACK]) { buf_str(b, comma ? ",\"coverFallbacks\":[" : "\"coverFallbacks\":["); buf_json(b, g->f[OF_COVER_FALLBACK]); buf_str(b, "]"); }
  buf_str(b, "}");
releases:
  buf_str(b, ",\"releases\":[");
  for (size_t i = 0; i < count; ++i) {
    if (i) buf_str(b, ",");
    orbit_release_json(b, first + i);
  }
  buf_str(b, "]}");
}
// O feed da Jobe a partir do catalogo decifrado. 0 ok (o feed em *out, revisao, jogos e links); -1 nao e o catalogo.
// glibren.27: `known` (ordenada, `nknown` codigos): os jogos que o app ja tem, gravados so com os links (*slim conta).
static int orbit_convert(const char* text, size_t size, const OrbitId* known, size_t nknown, Buf* out, uint64_t* revision,
                         int* games, int* releases, int* slim) {
  OrbitDoc d;
  memset(&d, 0, sizeof d);
  JP jp = {text, text + size, 0};
  const int parsed = jp_object(&jp, orbit_doc_field, &d);
  int result = -1;
  if (parsed && !d.failed && d.has_revision && d.has_releases && d.count) {
    qsort(d.items, d.count, sizeof *d.items, orbit_rel_cmp);
    buf_fmt(out, "{\"version\":1,\"name\":\"Orbit Store\",\"orbitRevision\":%llu,\"games\":[", (unsigned long long)d.revision);
    int n = 0, light = 0;
    for (size_t i = 0; i < d.count;) {
      size_t j = i + 1;
      while (j < d.count && !strcmp(d.items[j].f[OF_TITLE_ID], d.items[i].f[OF_TITLE_ID])) ++j;
      if (n++) buf_str(out, ",");
      const int is_known = nknown && bsearch(d.items[i].f[OF_TITLE_ID], known, nknown, sizeof *known, orbit_id_cmp) != NULL;
      light += is_known;
      orbit_game_json(out, d.items + i, j - i, is_known);
      i = j;
    }
    buf_str(out, "]}\n");
    if (!out->failed) {
      *revision = d.revision;
      *games = n;
      *releases = (int)d.count;
      *slim = light;
      result = 0;
    }
  }
  for (size_t i = 0; i < d.count; ++i) orbit_rel_free(&d.items[i]);
  free(d.items);
  return result;
}

// ---- Download -------------------------------------------------------------------------------------------

typedef struct { unsigned char* data; size_t size; int64_t retry; int too_big; } OrbitFetch;
static size_t orbit_collect(char* data, size_t a, size_t b, void* ctx) {
  OrbitFetch* f = ctx;
  if (a && b > SIZE_MAX / a) return 0;
  const size_t n = a * b;
  if (g_stop) return 0;
  if (n > ORBIT_SEAL_LIMIT + ORBIT_OVERHEAD - f->size) { f->too_big = 1; return 0; }
  unsigned char* next = realloc(f->data, f->size + n);
  if (!next) return 0;
  memcpy(next + f->size, data, n);
  f->data = next;
  f->size += n;
  return n;
}
static size_t orbit_header(char* data, size_t a, size_t b, void* ctx) {
  OrbitFetch* f = ctx;
  const size_t n = a * b;
  if (n > 12 && !strncasecmp(data, "Retry-After:", 12)) {
    char value[64];
    const size_t len = n - 12 < sizeof value - 1 ? n - 12 : sizeof value - 1;
    memcpy(value, data + 12, len);
    value[len] = 0;
    char* end;
    long seconds = strtol(value, &end, 10);
    if (end == value) {
      const time_t when = curl_getdate(value, NULL);
      seconds = when > time(NULL) ? (long)(when - time(NULL)) : 0;
    }
    if (seconds > 7 * 86400) seconds = 7 * 86400;
    if (seconds > f->retry) f->retry = seconds;
  }
  return n;
}

// Uma atualizacao (sem g_orbit_lock: baixa, decifra e converte; so o resultado entra no estado).
static void orbit_check(void) {
  OrbitFetch f;
  memset(&f, 0, sizeof f);
  // glibren.27: a lista de conhecidos de agora (uma copia: o app pode mandar outra enquanto isto roda).
  char known_hex[17] = "";
  pthread_mutex_lock(&g_orbit_lock);
  size_t nknown = g_known_count;
  OrbitId* known = nknown ? malloc(nknown * sizeof *known) : NULL;
  if (known) { memcpy(known, g_known, nknown * sizeof *known); snprintf(known_hex, sizeof known_hex, "%s", g_known_hex); }
  else nknown = 0;
  pthread_mutex_unlock(&g_orbit_lock);
  long status = 0;
  CURLcode code = CURLE_FAILED_INIT;
  CURL* curl = curl_easy_init();
  if (curl) {
    configure_transport(curl, g_orbit_url);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 600L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, orbit_collect);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &f);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, orbit_header);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &f);
    code = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    curl_easy_cleanup(curl);
  }
  char error[200] = "";
  const char* kind = "";
  uint64_t revision = 0;
  int games = 0, releases = 0, wrote = 0, same = 0, slim = 0;
  if (code != CURLE_OK || status != 200 || !f.data) {
    kind = "network";
    if (f.too_big) snprintf(error, sizeof error, "the catalogue is larger than 16 MiB");
    else if (code != CURLE_OK) snprintf(error, sizeof error, "download failed: %s", curl_easy_strerror(code));
    else snprintf(error, sizeof error, "download failed: HTTP %ld", status);
  } else {
    char* plain = NULL;
    size_t plain_size = 0;
    const int opened = orbit_open(f.data, f.size, &plain, &plain_size);
    if (opened) {
      kind = "broken";
      snprintf(error, sizeof error, opened == -2 ? "the catalogue no longer opens (Orbit changed its key or format)"
                                                 : "the file is not an Orbit catalogue");
    } else {
      Buf out = {0};
      if (orbit_convert(plain, plain_size, known, nknown, &out, &revision, &games, &releases, &slim)) {
        kind = "broken";
        snprintf(error, sizeof error, "the catalogue opened but its contents changed (no games read)");
      } else {
        pthread_mutex_lock(&g_orbit_lock);
        same = revision == g_orbit.revision && g_orbit.last_ok && g_orbit.conv == ORBIT_CONV && !strcmp(g_orbit.known_hash, known_hex);
        pthread_mutex_unlock(&g_orbit_lock);
        struct stat st;
        if (same && !stat(g_orbit_feed, &st)) wrote = 1;
        else if (save_atomic(g_orbit_feed, out.data, out.size, 0644)) wrote = 1;
        if (!wrote) { kind = "network"; snprintf(error, sizeof error, "the feed file could not be written: %s", strerror(errno)); }
        else if (!same) logk_("orbit: revisao %llu gravada: %d jogos (%d ja conhecidos, so com os links), %d links, %zu bytes",
                              (unsigned long long)revision, games, slim, releases, out.size);
      }
      free(out.data);
      if (plain) { OPENSSL_cleanse(plain, plain_size); free(plain); }
    }
  }
  free(f.data);
  free(known);
  const int64_t now = now_s();
  pthread_mutex_lock(&g_orbit_lock);
  g_orbit.last_try = now;
  g_orbit.next_try = now + g_orbit_every;
  g_orbit.retry_until = f.retry > 0 ? now + f.retry : 0;
  if (g_orbit.retry_until > g_orbit.next_try) g_orbit.next_try = g_orbit.retry_until;
  if (wrote) {
    if (!g_orbit.revision_since || revision != g_orbit.revision) g_orbit.revision_since = now;
    g_orbit.revision = revision;
    g_orbit.conv = ORBIT_CONV;
    if (!same) g_orbit.known = (int)nknown;
    snprintf(g_orbit.known_hash, sizeof g_orbit.known_hash, "%s", known_hex);
    g_orbit.games = games;
    g_orbit.releases = releases;
    g_orbit.last_ok = now;
    g_orbit.kind[0] = g_orbit.error[0] = 0;
    if (same) logf_("orbit: revisao %llu sem mudanca", (unsigned long long)revision);
  } else {
    snprintf(g_orbit.kind, sizeof g_orbit.kind, "%s", kind);
    snprintf(g_orbit.error, sizeof g_orbit.error, "%s", error);
    logk_("orbit: atualizacao falhou (%s): %s", kind, error);
  }
  g_orbit.busy = 0;
  orbit_save_locked();
  pthread_mutex_unlock(&g_orbit_lock);
}

// A notificacao do PS5 quando a lista para de atualizar (e quando volta), uma vez por mudanca.
static void orbit_tell_locked(int64_t now) {
  const char* stale = orbit_stale_locked(now);
  if (!strcmp(stale, g_orbit.said)) return;
  const char* text = !strcmp(stale, "broken") ? "Jobee'sLair: a lista Orbit Store parou de atualizar (o catalogo do Orbit mudou)"
                   : !strcmp(stale, "failing") ? "Jobee'sLair: a lista Orbit Store nao atualiza ha mais de 24 h"
                   : !strcmp(stale, "quiet") ? "Jobee'sLair: o Orbit Store nao publica jogos novos ha 14 dias"
                   : g_orbit.enabled && g_orbit.said[0] ? "Jobee'sLair: a lista Orbit Store voltou a atualizar" : NULL;
  snprintf(g_orbit.said, sizeof g_orbit.said, "%s", stale);
  orbit_save_locked();
  if (text) notify(text);
}

static volatile int g_orbit_loaded; // Fase 3: o estado e os codigos conhecidos ja lidos (o catalogo espera para saber se a lista entra)
static void* orbit_loop(void* unused) {
  (void)unused;
  orbit_load();
  orbit_known_load();
  __atomic_store_n(&g_orbit_loaded, 1, __ATOMIC_RELEASE);
  pthread_mutex_lock(&g_orbit_lock);
  // Ao subir, a proxima tentativa conta da ultima (um payload reiniciado nao baixa de novo antes das 6 h).
  g_orbit.next_try = g_orbit.last_try ? g_orbit.last_try + g_orbit_every : 0;
  if (g_orbit.retry_until > g_orbit.next_try) g_orbit.next_try = g_orbit.retry_until;
  // glibren.26: feed gravado por uma conversao antiga: regrava ja (sem esperar as 6 h).
  if (g_orbit.last_ok && g_orbit.conv != ORBIT_CONV) g_orbit.next_try = 0;
  while (!g_stop) {
    const int64_t now = now_s();
    // O relogio voltou (PS5 acertou a hora): nao espera anos pela proxima.
    if (g_orbit.next_try > now + g_orbit_every + 7 * 86400) g_orbit.next_try = now;
    // glibren.27: o feed gravado com outra lista de conhecidos (ou outra conversao) e regravado logo, sem esperar as 6 h:
    // 1 min depois da ultima tentativa, ou 15 min se ela falhou (sem martelar o GitHub com a rede fora).
    const int outdated = g_orbit.last_ok && (g_orbit.conv != ORBIT_CONV || strcmp(g_orbit.known_hash, g_known_hex));
    const int redo = outdated && now >= g_orbit.retry_until &&
                     now - g_orbit.last_try >= (g_orbit.last_ok >= g_orbit.last_try ? ORBIT_MIN_GAP_S : ORBIT_KNOWN_RETRY_S);
    if (g_orbit.enabled && (g_orbit.kick || now >= g_orbit.next_try || redo)) {
      g_orbit.kick = 0;
      g_orbit.busy = 1;
      orbit_save_locked(); // glibren.25: o app (Configuracoes) mostra "Atualizando..." enquanto baixa
      pthread_mutex_unlock(&g_orbit_lock);
      orbit_check();
      pthread_mutex_lock(&g_orbit_lock);
      orbit_tell_locked(now_s());
      continue;
    }
    orbit_tell_locked(now);
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += 30;
    pthread_cond_timedwait(&g_orbit_wake, &g_orbit_lock, &deadline);
  }
  pthread_mutex_unlock(&g_orbit_lock);
  return NULL;
}

typedef struct { int has_enabled, enabled, refresh, has_known, failed; OrbitId* known; size_t count, cap; } OrbitBody;
static int orbit_known_item(JP* jp, void* ctx) {
  OrbitBody* o = ctx;
  char text[16];
  if (!lib_text(jp, text, sizeof text)) return 0;
  if (!orbit_known_add(&o->known, &o->count, &o->cap, text)) o->failed = 1;
  return 1;
}
static int orbit_body_field(JP* jp, const char* key, void* ctx) {
  OrbitBody* o = ctx;
  if (!strcmp(key, "enabled")) { o->has_enabled = 1; return jp_bool(jp, &o->enabled) ? 1 : -1; }
  if (!strcmp(key, "known")) {
    jp_ws(jp);
    if (jp->p >= jp->end || *jp->p != '[') return -1;
    o->has_known = 1;
    return jp_array(jp, orbit_known_item, o) ? 1 : -1;
  }
  if (!strcmp(key, "refresh")) return jp_bool(jp, &o->refresh) ? 1 : -1;
  return jp_skip(jp) ? 1 : -1;
}

// GET /orbit: o estado. POST /orbit {enabled?, refresh?, known?}: liga/desliga, pede uma atualizacao agora e (glibren.27)
// troca a lista de codigos que o app ja conhece.
static int orbit_route(int fd, Request* r) {
  if (strcmp(r->path, "/orbit")) return 0;
  if (!strcmp(r->method, "POST")) {
    OrbitBody o;
    memset(&o, 0, sizeof o);
    JP jp = {r->body, r->body + r->content_length, 0};
    if (!r->body || !jp_object(&jp, orbit_body_field, &o) || o.failed) {
      free(o.known);
      respond_error(fd, 400, "expected {enabled?: bool, refresh?: bool, known?: [title ids]}");
      return 1;
    }
    const int64_t now = now_s();
    pthread_mutex_lock(&g_orbit_lock);
    if (o.has_enabled && o.enabled != g_orbit.enabled) {
      g_orbit.enabled = o.enabled;
      logk_("orbit: lista %s", o.enabled ? "ligada" : "desligada");
      if (o.enabled) {
        g_orbit.enabled_at = now;
        g_orbit.said[0] = 0;
        if (!g_orbit.last_ok || now - g_orbit.last_try >= ORBIT_MIN_GAP_S) g_orbit.kick = 1;
      }
      orbit_save_locked();
    }
    if (o.refresh && g_orbit.enabled && !g_orbit.busy && now - g_orbit.last_try >= ORBIT_MIN_GAP_S && now >= g_orbit.retry_until)
      g_orbit.kick = 1;
    // glibren.27: a lista nova fica com o payload (orbit_known_set_locked fica com ela); o laco regrava o feed.
    if (!o.has_known) free(o.known);
    else { orbit_known_app_locked(o.known, o.count); logf_("orbit: %zu codigos conhecidos pelo app", o.count); } // Fase 3: unidos aos do catalogo do payload
    pthread_cond_broadcast(&g_orbit_wake);
    pthread_mutex_unlock(&g_orbit_lock);
  } else if (strcmp(r->method, "GET")) {
    respond_error(fd, 404, "not found");
    return 1;
  }
  Buf b = {0};
  pthread_mutex_lock(&g_orbit_lock);
  orbit_json_locked(&b, now_s());
  pthread_mutex_unlock(&g_orbit_lock);
  respond(fd, 200, b.failed || !b.data ? "{\"enabled\":false}" : b.data);
  free(b.data);
  return 1;
}

static void orbit_setup(void) {
  snprintf(g_orbit_dir, sizeof g_orbit_dir, "%s", env_or("BGDL_ORBIT_DIR", "/data/JobeesLair/orbit"));
  snprintf(g_orbit_feed, sizeof g_orbit_feed, "%s/orbit-store.json", g_orbit_dir);
  snprintf(g_orbit_status, sizeof g_orbit_status, "%s/orbit-store-status.json", g_orbit_dir);
  snprintf(g_orbit_known_file, sizeof g_orbit_known_file, "%s/orbit-known.txt", g_orbit_dir); // glibren.27
  snprintf(g_orbit_url, sizeof g_orbit_url, "%s", ORBIT_URL);
#ifndef __PROSPERO__
  // Nos testes: o servidor local e um intervalo curto.
  if (env_or("BGDL_ORBIT_URL", "")[0]) snprintf(g_orbit_url, sizeof g_orbit_url, "%s", env_or("BGDL_ORBIT_URL", ""));
  if (atoll(env_or("BGDL_ORBIT_EVERY_S", "0")) > 0) g_orbit_every = atoll(env_or("BGDL_ORBIT_EVERY_S", "0"));
#endif
  if (mkdir_p(g_orbit_dir)) logf_("orbit: pasta %s nao criada: %s", g_orbit_dir, strerror(errno));
}
