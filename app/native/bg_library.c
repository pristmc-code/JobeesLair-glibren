// glibren.38 (item 3 do plano de melhorias): a parte de REDE da Biblioteca TorBox no payload.
//
// Ate a .37 o app fazia tudo: as chamadas ao TorBox (conta, lista de hashes, checkcached de cada link do catalogo e dos
// nomes de arquivo), o casamento e a gravacao. Com a lista Orbit ligada o app fechou "na hora de gerar a lista"
// (11/11/2026). Agora a rede vem para ca, numa thread propria, que continua com o app em outra tela, fechado ou
// reaberto (a rodada e retomavel), e o app so casa e grava (app/state/torbox-library-payload.js), um bloco por vez.
//
// O corte (por que o casamento fica no app): o banco, a lista e as fichas sao gravados exatamente como antes, e isso
// depende de regras do JavaScript que o C nao reproduz byte a byte sem risco: a ordem da lista (localeCompare do titulo),
// o formato de cada arquivo (link-formats.js: decodeURIComponent e as expressoes de cada tipo), as copias quebradas, os
// conjuntos em partes e o JSON.stringify do app. A rede (o que mais demora e o que respondia com textos grandes) e a
// parte que da para mover sem mudar o resultado: o app recebe as mesmas entradas que receberia do TorBox.
//
// O plano (<dir>/library/plan.ndjson), escrito pelo app em pedacos, uma linha por registro:
//   {"v":1,"run":"<id da rodada>","blocks":N,"account":true}
//   {"list":["<info hash>",...]}                 (a lista de hashes do jogador; varias linhas)
//   {"b":0,"games":[{"id","code","links":[...],"parts":[...],"names":[...]}]}   (um bloco de jogos por linha)
// "links" sao os links de um arquivo so do jogo (catalogLinks), "parts" os das partes dos conjuntos (catalogSets), "names"
// os nomes de arquivo do catalogo e "code" o codigo (para os MD5 de "<nome>" e "<codigo>.<tipo>").
// O que o payload grava ao lado (cada arquivo uma vez, tmp + rename):
//   account.json  {"webdl":[item...],"torrent":[item...]} ou {"error":"<codigo>"}; item = {id,name,hash,size,files}
//   list.json     {"held":{"<info hash>":entrada}}
//   b00000.json   {"b":0,"ids":[...],"held":{"<link>":entrada},"failed":{"<link>":"<codigo>"},"names":[{"hash",...entrada}]}
//   state.json    o estado (o mesmo de GET /library/build)
// "entrada" e a do checkcached com list_files ({name,size,files:[{id,name,short_name,size}]}), com os mesmos valores
// que o TorBox mandou; o app ainda passa cada uma por services/torbox.js cachedEntry. Uma pasta de milhares de arquivos
// vem cortada em LB_FILES_KEPT, sempre com todos os que o app usa (os de nome de jogo/pacote/compactado, os de 1 MB ou
// mais, o maior e o da pasta de backport).
// "names" sao os MD5 dos nomes so dos jogos que nenhum link de arquivo unico achou: o app ainda escolhe quais jogos de
// fato ficaram sem nada (a conta e a lista de hashes podem achar) e casa as entradas so com eles.
//
// Como o app (state/torbox-library.js): 50 links web por grupo (um link vira ate 2 MD5) e 100 magnets, 10 hashes por
// chamada (LIST_GROUP), um grupo recusado (414, resposta grande demais, ou outro erro do TorBox) e partido ao meio ate
// um link sozinho, que fica com o erro; 429 espera 61 s, 2 e 4 min (5 tentativas), rede/5xx 5 e 10 s (3); passou disso a
// rodada para ("failed") e o "Continuar" do app retoma dos blocos que faltam. Uma chamada por vez, no ritmo unico do TorBox (glibren.43:
// tb_turn, junto com o resto do payload; o TorBox da 300 por minuto), e nada no modo quieto (app fechando).
//
// Rotas (com o token do app):
//   GET  /library/build          {ok, api, run, state: ""|running|done|failed|cancelled, phase, busy, blocks, done,
//                                 calls, waitMs, error}
//   POST /library/build {run}    comeca (ou continua) a rodada do plano gravado; outra rodada andando: 409
//   POST /library/build/cancel   para (a rodada fica "cancelled", retomavel)
// A chave do TorBox e a do POST /secret (ou o debrid.json do app), lida a cada rodada e nunca gravada nem registrada.
#include <dirent.h>

#define LB_BODY_MAX (8u * 1024u * 1024u)
#define LB_PLAN_MAX (48u * 1024u * 1024u)
#define LB_WEB_GROUP 50
#define LB_MAGNET_GROUP 100
#define LB_ALT_GROUP 100
#define LB_ASK 10
#define LB_PAGE 250
#define LB_PAGES_MAX 1000
#define LB_FILES_KEPT 400
#define LB_SMALL 1e6
#define LB_TEXT_MAX 8192

typedef struct {
  int busy, kick;
  volatile int cancel;
  char run[48], state[12], phase[12], error[200];
  int blocks, done;
  long calls;
  int64_t wait_until; // mono_ms; 0 sem espera
} LbState;
static LbState g_lb;
static pthread_mutex_t g_lb_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_lb_wake = PTHREAD_COND_INITIALIZER;
static char g_lb_dir[600], g_lb_state_path[700], g_lb_plan_path[700];
static int g_lb_rate_ms = 61000, g_lb_retry_ms = 5000;

// ---- MD5 (o hash de um link web no TorBox; RFC 1321) ----
static void lb_md5(const char* text, size_t n, char out[33]) {
  static const uint32_t K[64] = {
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af,
    0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
    0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97,
    0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391};
  static const unsigned R[16] = {7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21};
  uint32_t h[4] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476};
  const uint64_t bits = (uint64_t)n * 8;
  size_t total = n + 1;
  while (total % 64 != 56) ++total;
  total += 8;
  for (size_t offset = 0; offset < total; offset += 64) {
    uint32_t w[16];
    for (int i = 0; i < 16; ++i) {
      uint32_t word = 0;
      for (int k = 0; k < 4; ++k) {
        const size_t at = offset + (size_t)i * 4 + (size_t)k;
        uint32_t byte;
        if (at < n) byte = (unsigned char)text[at];
        else if (at == n) byte = 0x80;
        else if (at >= total - 8) byte = (uint32_t)((bits >> (8 * (at - (total - 8)))) & 0xff);
        else byte = 0;
        word |= byte << (8 * k);
      }
      w[i] = word;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
    for (int i = 0; i < 64; ++i) {
      const int round = i >> 4;
      uint32_t f;
      int g;
      if (round == 0) { f = (b & c) | (~b & d); g = i; }
      else if (round == 1) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (round == 2) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const uint32_t sum = a + f + K[i] + w[g];
      const unsigned shift = R[round * 4 + i % 4];
      a = d; d = c; c = b;
      b = b + ((sum << shift) | (sum >> (32 - shift)));
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d;
  }
  static const char digits[] = "0123456789abcdef";
  for (int i = 0; i < 16; ++i) {
    const unsigned byte = (h[i / 4] >> (8 * (i % 4))) & 0xff;
    out[2 * i] = digits[byte >> 4];
    out[2 * i + 1] = digits[byte & 15];
  }
  out[32] = 0;
}

// ---- Os hashes de um link (services/torbox.js linkHashes, magnetHash) ----
static int lb_is_magnet(const char* link) { return !strncasecmp(link, "magnet:?", 8); }
// O link como esta e, quando sobra caminho depois do host, sem a consulta: 1 ou 2 MD5.
static int lb_link_hashes(const char* link, char out[2][33]) {
  lb_md5(link, strlen(link), out[0]);
  const size_t bare = strcspn(link, "?#");
  // ^[a-z][a-z0-9+.-]*://[^/]+/. no link sem a consulta
  size_t i = 0;
  int ok = bare > 0 && isalpha((unsigned char)link[0]);
  if (ok) {
    for (i = 1; i < bare && (isalnum((unsigned char)link[i]) || link[i] == '+' || link[i] == '.' || link[i] == '-'); ++i) {}
    ok = i + 3 <= bare && !strncmp(link + i, "://", 3);
  }
  if (ok) {
    size_t host = i + 3, end = host;
    while (end < bare && link[end] != '/') ++end;
    ok = end > host && end + 1 < bare && link[end + 1] != '\n' && link[end + 1] != '\r';
  }
  if (!ok) return 1;
  lb_md5(link, bare, out[1]);
  return strcmp(out[0], out[1]) ? 2 : 1;
}
// O info hash de um magnet (40 hex, ou 32 base32 em hex), minusculo; 0 sem um.
static int lb_magnet_hash(const char* magnet, char out[41]) {
  const char* p = magnet;
  for (;;) {
    const char* at = strcasestr(p, "xt=urn:btih:");
    if (!at) return 0;
    if (at > magnet && (at[-1] == '?' || at[-1] == '&')) { p = at + 12; break; }
    p = at + 1;
  }
  size_t n = 0;
  while (isalnum((unsigned char)p[n])) ++n;
  if (n == 40) {
    for (size_t i = 0; i < 40; ++i) {
      if (!isxdigit((unsigned char)p[i])) return 0;
      out[i] = (char)tolower((unsigned char)p[i]);
    }
    out[40] = 0;
    return 1;
  }
  if (n != 32) return 0;
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  static const char digits[] = "0123456789abcdef";
  unsigned buffer = 0, have = 0, at = 0;
  for (size_t i = 0; i < 32; ++i) {
    const char* hit = strchr(alphabet, toupper((unsigned char)p[i]));
    if (!hit || !*hit) return 0;
    buffer = (buffer << 5) | (unsigned)(hit - alphabet);
    have += 5;
    while (have >= 4) { have -= 4; out[at++] = digits[(buffer >> have) & 15]; }
    buffer &= (1u << have) - 1;
  }
  out[40] = 0;
  return at == 40;
}

// ---- Respostas do TorBox: os valores copiados como vieram ----
typedef struct { const char* s; const char* e; } Span;
static int lb_raw(JP* j, Span* out) {
  jp_ws(j);
  out->s = j->p;
  if (!jp_skip(j)) return 0;
  out->e = j->p;
  return 1;
}
static void buf_span(Buf* b, Span s) { buf_add(b, s.s, (size_t)(s.e - s.s)); }
static int span_is(Span s, char c) { return s.s && s.e > s.s && *s.s == c; }
// Um texto da resposta (0 se nao e texto ou e maior que `cap`).
static int lb_text(Span s, char* out, size_t cap) {
  out[0] = 0;
  if (!span_is(s, '"')) return 0;
  JP j = {s.s, s.e, 0};
  return jp_string(&j, out, cap);
}
// Number(valor) do app para um tamanho: numero, ou texto so com numero; o resto vale 0.
static double lb_number(Span s) {
  if (!s.s || s.e <= s.s) return 0;
  char text[64];
  if (*s.s == '"') { if (!lb_text(s, text, sizeof text)) return 0; }
  else {
    const size_t n = (size_t)(s.e - s.s);
    if (n >= sizeof text) return 0;
    memcpy(text, s.s, n);
    text[n] = 0;
  }
  char* end = NULL;
  const double value = strtod(text, &end);
  if (end == text) return 0;
  while (*end == ' ') ++end;
  return *end ? 0 : value;
}

typedef struct { Span id, name, short_name, size, hash; } LbFile;
typedef struct { Span id, name, size, hash; LbFile* files; int count, cap, has_files, failed; } LbEntry;
static int lb_file_field(JP* j, const char* key, void* ctx) {
  LbFile* f = ctx;
  Span* slot = !strcmp(key, "id") ? &f->id : !strcmp(key, "name") ? &f->name : !strcmp(key, "short_name") ? &f->short_name :
               !strcmp(key, "size") ? &f->size : NULL;
  if (!slot) return 0;
  return lb_raw(j, slot) ? 1 : -1;
}
static int lb_file_item(JP* j, void* ctx) {
  LbEntry* e = ctx;
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{') return jp_skip(j); // o app so usa os arquivos que sao objetos
  if (e->count == e->cap) {
    const int cap = e->cap ? e->cap * 2 : 16;
    LbFile* next = realloc(e->files, sizeof *next * (size_t)cap);
    if (!next) { e->failed = 1; return jp_skip(j); }
    e->files = next;
    e->cap = cap;
  }
  LbFile* f = &e->files[e->count];
  memset(f, 0, sizeof *f);
  if (!jp_object(j, lb_file_field, f)) return 0;
  ++e->count;
  return 1;
}
static int lb_entry_field(JP* j, const char* key, void* ctx) {
  LbEntry* e = ctx;
  if (!strcmp(key, "id")) return lb_raw(j, &e->id) ? 1 : -1;
  if (!strcmp(key, "name")) return lb_raw(j, &e->name) ? 1 : -1;
  if (!strcmp(key, "size")) return lb_raw(j, &e->size) ? 1 : -1;
  if (!strcmp(key, "hash")) return lb_raw(j, &e->hash) ? 1 : -1;
  if (!strcmp(key, "files")) {
    jp_ws(j);
    if (j->p >= j->end || *j->p != '[') return 0;
    e->has_files = 1;
    e->count = 0; // a ultima chave repetida vale, como no JSON.parse
    return jp_array(j, lb_file_item, e) ? 1 : -1;
  }
  return 0;
}
static int lb_entry_read(JP* j, LbEntry* e) {
  memset(e, 0, sizeof *e);
  return jp_object(j, lb_entry_field, e) && !e->failed;
}
static void lb_entry_free(LbEntry* e) { free(e->files); e->files = NULL; e->count = e->cap = 0; }

// Um nome que PODE ter formato (link-formats.js formatFromName da mais ou menos isto; aqui sobra, nunca falta).
static int lb_named(const char* name) {
  char low[1024];
  size_t n = strnlen(name, sizeof low - 1);
  for (size_t i = 0; i < n; ++i) low[i] = (char)tolower((unsigned char)name[i]);
  low[n] = 0;
  if (strchr(low, '%') || strchr(low, '+')) return 1;
  static const char* const kinds[] = {".rar", ".zip", ".7z", ".tar", ".tgz", ".exfat", ".ffpkg", ".ffpfs", ".pkg"};
  for (size_t i = 0; i < sizeof kinds / sizeof *kinds; ++i) if (strstr(low, kinds[i])) return 1;
  for (const char* p = low; (p = strchr(p, '.')); ++p) {
    if ((p[1] == 'r' || p[1] == 'z') && isdigit((unsigned char)p[2]) && isdigit((unsigned char)p[3])) return 1;
  }
  return 0;
}
// O nome que o app olha num arquivo (short_name, senao name); um texto que nao deu para ler conta como nomeado.
static int lb_file_named(const LbFile* f) {
  char text[1024];
  if (span_is(f->short_name, '"')) {
    if (!lb_text(f->short_name, text, sizeof text)) return 1;
    if (text[0]) return lb_named(text);
  }
  if (span_is(f->name, '"')) return lb_text(f->name, text, sizeof text) ? lb_named(text) : 1;
  return 0;
}
typedef struct { int index, named; double size; } LbRank;
static int lb_rank_order(const void* a, const void* b) {
  const LbRank* x = a;
  const LbRank* y = b;
  if (x->named != y->named) return y->named - x->named;
  if (x->size != y->size) return x->size < y->size ? 1 : -1;
  return x->index - y->index;
}
static void lb_file_write(Buf* b, const LbFile* f) {
  int first = 1;
  const struct { const char* key; Span value; } fields[] = {{"id", f->id}, {"name", f->name}, {"short_name", f->short_name}, {"size", f->size}};
  buf_str(b, "{");
  for (size_t i = 0; i < sizeof fields / sizeof *fields; ++i) {
    if (!fields[i].value.s) continue;
    buf_fmt(b, "%s\"%s\":", first ? "" : ",", fields[i].key);
    buf_span(b, fields[i].value);
    first = 0;
  }
  buf_str(b, "}");
}
// A entrada como o app a recebe (cortada so numa pasta de mais de LB_FILES_KEPT arquivos que valem).
static void lb_entry_write(Buf* b, const LbEntry* e, int all_files) {
  buf_str(b, "\"name\":");
  if (e->name.s) buf_span(b, e->name); else buf_str(b, "\"\"");
  buf_str(b, ",\"size\":");
  if (e->size.s) buf_span(b, e->size); else buf_str(b, "0");
  if (!e->has_files) return;
  buf_str(b, ",\"files\":[");
  char* keep = e->count ? calloc((size_t)e->count, 1) : NULL;
  LbRank* ranks = e->count ? malloc(sizeof *ranks * (size_t)e->count) : NULL;
  int largest = -1, port = -1, kept = 0;
  double largest_size = 0;
  for (int i = 0; i < e->count && keep && ranks; ++i) {
    const LbFile* f = &e->files[i];
    const double size = lb_number(f->size);
    if (largest < 0 || size > largest_size) { largest = i; largest_size = size; }
    const int named = lb_file_named(f);
    char path[1024];
    if (port < 0 && ((lb_text(f->name, path, sizeof path) && path[0]) || lb_text(f->short_name, path, sizeof path))) {
      lower_ascii(path);
      if (strstr(path, "backport")) port = i;
    }
    if (all_files || named || size >= LB_SMALL) { keep[i] = 1; ranks[kept++] = (LbRank){i, named, size}; }
  }
  if (keep && ranks && kept > LB_FILES_KEPT) {
    qsort(ranks, (size_t)kept, sizeof *ranks, lb_rank_order);
    for (int i = LB_FILES_KEPT; i < kept; ++i) keep[ranks[i].index] = 0;
  }
  if (keep && largest >= 0) keep[largest] = 1;
  if (keep && port >= 0) keep[port] = 1;
  int first = 1;
  for (int i = 0; i < e->count; ++i) {
    if (keep && !keep[i]) continue;
    if (!first) buf_str(b, ",");
    lb_file_write(b, &e->files[i]);
    first = 0;
  }
  free(keep);
  free(ranks);
  buf_str(b, "]");
}

// ---- Chamadas ----
// glibren.41 (J5): "fatal" = a chave foi recusada (HTTP 401/403 ou erro de autenticacao do TorBox): nenhuma outra chamada
// vai dar certo, entao a rodada para na hora com o motivo (antes cada grupo de 50 links era partido ate o link sozinho:
// milhares de chamadas recusadas e a rodada terminava "pronta" com tudo em falha, sem aviso).
typedef struct { char code[64]; int transient, rate, fatal; } LbErr;
static int lb_auth_code(const char* code) {
  return !strcmp(code, "BAD_TOKEN") || !strcmp(code, "NO_AUTH") || !strcmp(code, "AUTH_ERROR") || !strcmp(code, "INVALID_TOKEN") ||
         !strcmp(code, "TOKEN_EXPIRED") || !strcmp(code, "HTTP_401") || !strcmp(code, "HTTP_403");
}
typedef struct { int success; char error[64]; Span data; } LbAnswer;
static int lb_answer_field(JP* j, const char* key, void* ctx) {
  LbAnswer* a = ctx;
  if (!strcmp(key, "success")) {
    jp_ws(j);
    if (jp_literal(j, "true")) { a->success = 1; return 1; }
    a->success = 0;
    return jp_skip(j) ? 1 : -1;
  }
  if (!strcmp(key, "error")) {
    jp_ws(j);
    if (j->p < j->end && *j->p == '"') {
      const char* start = j->p;
      if (jp_string(j, a->error, sizeof a->error)) return 1;
      j->p = start;
      a->error[0] = 0;
    } else a->error[0] = 0;
    return jp_skip(j) ? 1 : -1;
  }
  if (!strcmp(key, "data")) return lb_raw(j, &a->data) ? 1 : -1;
  return 0;
}
typedef struct { Buf* b; int over; } LbSink;
static size_t lb_on_body(char* data, size_t size, size_t count, void* opaque) {
  LbSink* sink = opaque;
  const size_t length = size * count;
  if (sink->b->size + length > LB_BODY_MAX) { sink->over = 1; return 0; }
  buf_add(sink->b, data, length);
  return sink->b->failed ? 0 : length;
}
static int lb_stopping(void) { return g_stop || g_lb.cancel; }
// Espera ate `until` (mono) e o fim do modo quieto; 0 se mandaram parar.
static int lb_wait_until(int64_t until) {
  while (mono_ms() < until || quiet_now()) {
    if (lb_stopping()) return 0;
    sleep_ms(100);
  }
  return !lb_stopping();
}
static void lb_save_state_locked(void);
// Um GET ao TorBox: 1 respondeu com success (o texto em `body`, `a` aponta para ele); 0 erro em `err`.
static int lb_get(const char* path, const char* key, Buf* body, LbAnswer* a, LbErr* err) {
  memset(a, 0, sizeof *a);
  memset(err, 0, sizeof *err);
  body->size = 0;
  body->failed = 0;
  if (body->data) body->data[0] = 0;
  char url[4096];
  if ((size_t)snprintf(url, sizeof url, "%s%s", g_torbox_base, path) >= sizeof url) { snprintf(err->code, sizeof err->code, "HTTP_414"); return 0; }
  CURL* curl = curl_easy_init();
  if (!curl) { snprintf(err->code, sizeof err->code, "NETWORK"); err->transient = 1; return 0; }
  configure_transport(curl, url);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 90L); // CALL_LIMIT_MS do app
  LbSink sink = {body, 0};
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, lb_on_body);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &sink);
  char auth[160];
  snprintf(auth, sizeof auth, "Authorization: Bearer %s", key);
  struct curl_slist* headers = curl_slist_append(NULL, auth);
  memset(auth, 0, sizeof auth);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  const CURLcode result = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_cleanup(curl);
  curl_slist_free_all(headers);
  if (sink.over || body->failed) { snprintf(err->code, sizeof err->code, "TOO_LARGE"); return 0; } // partido como um 414
  if (result != CURLE_OK) { snprintf(err->code, sizeof err->code, "NETWORK"); err->transient = 1; return 0; }
  if (status == 429) { snprintf(err->code, sizeof err->code, "RATE_LIMITED"); err->rate = 1; return 0; }
  JP jp = {body->data ? body->data : "", body->data ? body->data + body->size : "", 0};
  if (!body->data || !jp_object(&jp, lb_answer_field, a)) {
    snprintf(err->code, sizeof err->code, "HTTP_%ld", status);
    err->transient = status >= 500 && status <= 599;
    err->fatal = lb_auth_code(err->code);
    return 0;
  }
  if (!a->success) {
    if (a->error[0]) snprintf(err->code, sizeof err->code, "%s", a->error);
    else { snprintf(err->code, sizeof err->code, "HTTP_%ld", status); err->transient = status >= 500 && status <= 599; }
    err->fatal = lb_auth_code(err->code) || status == 401 || status == 403;
    return 0;
  }
  return 1;
}
// Como polite() do app: o ritmo e as esperas. 1 ok; 0 erro definitivo (`err`); -1 parou.
static int lb_polite(const char* path, const char* key, Buf* body, LbAnswer* a, LbErr* err) {
  for (int attempt = 0;; ++attempt) {
    // glibren.43: o ritmo unico do TorBox (tb_turn, em bg_downloader.c), junto com os pedidos do celular e a renovacao
    // de links; uma espera de 429 de outra parte aparece no estado (waitMs).
    const int64_t cool = tb_cooldown_left();
    if (cool > 0) {
      pthread_mutex_lock(&g_lb_lock);
      g_lb.wait_until = mono_ms() + cool;
      lb_save_state_locked();
      pthread_mutex_unlock(&g_lb_lock);
    }
    if (!lb_wait_until(0)) return -1;
    const int turn = tb_turn(-1, lb_stopping);
    if (cool > 0) {
      pthread_mutex_lock(&g_lb_lock);
      g_lb.wait_until = 0;
      pthread_mutex_unlock(&g_lb_lock);
    }
    if (turn != 1) return -1;
    pthread_mutex_lock(&g_lb_lock);
    ++g_lb.calls;
    pthread_mutex_unlock(&g_lb_lock);
    if (lb_get(path, key, body, a, err)) return 1;
    if ((err->rate && attempt < 4) || (err->transient && attempt < 2)) {
      const int64_t ms = err->rate ? (int64_t)g_lb_rate_ms << (attempt < 2 ? attempt : 2) : (int64_t)g_lb_retry_ms * (attempt + 1);
      logf_("biblioteca: %s; esperando %lld s", err->code, (long long)(ms / 1000));
      if (err->rate) tb_slow_down(ms, "biblioteca"); // glibren.43: segura tambem as outras partes
      pthread_mutex_lock(&g_lb_lock);
      g_lb.wait_until = mono_ms() + ms;
      lb_save_state_locked();
      pthread_mutex_unlock(&g_lb_lock);
      const int ok = lb_wait_until(mono_ms() + ms);
      pthread_mutex_lock(&g_lb_lock);
      g_lb.wait_until = 0;
      pthread_mutex_unlock(&g_lb_lock);
      if (!ok) return -1;
      continue;
    }
    return 0;
  }
}

// ---- O que o TorBox tem de um grupo de links ----
typedef struct { char hash[41]; int link; } LbHash;
typedef struct { LbHash* map; int count; char** found; } LbAsk;
static int lb_ask_field(JP* j, const char* key, void* ctx) {
  LbAsk* ask = ctx;
  char low[64];
  snprintf(low, sizeof low, "%s", key);
  lower_ascii(low);
  int link = -1;
  for (int i = 0; i < ask->count; ++i) if (!strcmp(ask->map[i].hash, low)) { link = ask->map[i].link; break; }
  jp_ws(j);
  if (link < 0 || ask->found[link] || j->p >= j->end || *j->p != '{') return 0;
  LbEntry e;
  if (!lb_entry_read(j, &e)) { lb_entry_free(&e); return -1; }
  Buf b = {0};
  buf_str(&b, "{");
  lb_entry_write(&b, &e, 0);
  buf_str(&b, "}");
  lb_entry_free(&e);
  if (b.failed) { free(b.data); return -1; }
  ask->found[link] = b.data;
  return 1;
}
// Uma chamada do checkcached com `count` hashes de `map` a partir de `from`; as respostas vao a found[link].
static int lb_checkcached(const char* kind, const char* key, LbHash* map, int from, int count, LbAsk* ask, Buf* body, LbErr* err) {
  char path[2048];
  int n = snprintf(path, sizeof path, "/%s/checkcached?hash=", kind);
  for (int i = 0; i < count && n < (int)sizeof path - 64; ++i) n += snprintf(path + n, sizeof path - (size_t)n, "%s%s", i ? "%2C" : "", map[from + i].hash);
  snprintf(path + n, sizeof path - (size_t)n, "&format=object&list_files=true");
  LbAnswer a;
  const int r = lb_polite(path, key, body, &a, err);
  if (r <= 0) return r;
  if (span_is(a.data, '{')) {
    JP jp = {a.data.s, a.data.e, 0};
    if (!jp_object(&jp, lb_ask_field, ask)) { snprintf(err->code, sizeof err->code, "BAD_ANSWER"); return 0; }
  }
  return 1;
}
static void lb_free_list(char** list, int n) {
  for (int i = 0; i < n; ++i) { free(list[i]); list[i] = NULL; }
}
// cachedEntries do app para um grupo (so web ou so magnets): 1 ok (found[i] com a entrada de links[i] ou NULL); 0 erro;
// -1 parou. Um erro no meio descarta o grupo inteiro, como a promessa rejeitada do app.
static int lb_ask_group(const char* key, char** links, int n, char** found, Buf* body, LbErr* err) {
  LbHash* map = malloc(sizeof *map * (size_t)(n * 2 + 1));
  if (!map) { snprintf(err->code, sizeof err->code, "NO_MEMORY"); return 0; }
  int m = 0;
  const int magnets = lb_is_magnet(links[0]);
  for (int i = 0; i < n; ++i) {
    char hashes[2][33], torrent[41];
    const char* list[2];
    int count = 0;
    if (magnets) { if (lb_magnet_hash(links[i], torrent)) list[count++] = torrent; }
    else {
      count = lb_link_hashes(links[i], hashes);
      list[0] = hashes[0];
      list[1] = hashes[1];
    }
    for (int h = 0; h < count; ++h) {
      int at = -1;
      for (int k = 0; k < m; ++k) if (!strcmp(map[k].hash, list[h])) { at = k; break; }
      if (at < 0) { at = m++; snprintf(map[at].hash, sizeof map[at].hash, "%s", list[h]); }
      map[at].link = i; // como o Map do app: o ultimo link com o hash fica com ele
    }
  }
  LbAsk ask = {map, m, found};
  int r = 1;
  for (int from = 0; from < m && r == 1; from += LB_ASK) r = lb_checkcached(magnets ? "torrents" : "webdl", key, map, from, m - from < LB_ASK ? m - from : LB_ASK, &ask, body, err);
  free(map);
  if (r != 1) lb_free_list(found, n);
  return r;
}
// held() do app: um erro definitivo parte o grupo ao meio; um link sozinho que falha fica com o erro em failed[i].
// 1 ok; 0 a rodada para (429 ou rede depois das esperas: `err`); -1 parou.
static int lb_held(const char* key, char** links, int n, char** found, char** failed, Buf* body, LbErr* err) {
  if (!n) return 1;
  const int r = lb_ask_group(key, links, n, found, body, err);
  if (r != 0) return r;
  if (err->rate || err->transient || err->fatal) return 0; // glibren.41 (J5): chave recusada para tudo
  if (n == 1) { failed[0] = strdup(err->code); return 1; }
  const int half = (n + 1) / 2;
  const int first = lb_held(key, links, half, found, failed, body, err);
  if (first != 1) return first;
  return lb_held(key, links + half, n - half, found + half, failed + half, body, err);
}
// heldAll() do app: os links web em grupos de 50, depois os magnets em grupos de 100.
static int lb_held_all(const char* key, char** links, int n, char** found, char** failed, Buf* body, LbErr* err) {
  char** order = malloc(sizeof *order * (size_t)(n + 1));
  int* at = malloc(sizeof *at * (size_t)(n + 1));
  char** got = calloc((size_t)n + 1, sizeof *got);
  char** bad = calloc((size_t)n + 1, sizeof *bad);
  if (!order || !at || !got || !bad) { free(order); free(at); free(got); free(bad); snprintf(err->code, sizeof err->code, "NO_MEMORY"); return 0; }
  int count = 0, web = 0;
  for (int i = 0; i < n; ++i) if (!lb_is_magnet(links[i])) { at[count] = i; order[count++] = links[i]; }
  web = count;
  for (int i = 0; i < n; ++i) if (lb_is_magnet(links[i])) { at[count] = i; order[count++] = links[i]; }
  int r = 1;
  for (int from = 0; from < web && r == 1; from += LB_WEB_GROUP) {
    const int size = web - from < LB_WEB_GROUP ? web - from : LB_WEB_GROUP;
    r = lb_held(key, order + from, size, got + from, bad + from, body, err);
  }
  for (int from = web; from < count && r == 1; from += LB_MAGNET_GROUP) {
    const int size = count - from < LB_MAGNET_GROUP ? count - from : LB_MAGNET_GROUP;
    r = lb_held(key, order + from, size, got + from, bad + from, body, err);
  }
  for (int k = 0; k < count; ++k) {
    if (r == 1) { found[at[k]] = got[k]; failed[at[k]] = bad[k]; }
    else { free(got[k]); free(bad[k]); }
  }
  free(order); free(at); free(got); free(bad);
  return r;
}

// ---- O plano ----
typedef struct { char* id; char code[16]; char** links; int nlinks; char** parts; int nparts; char** names; int nnames; } LbGame;
typedef struct { LbGame* games; int count, cap; int failed; } LbBlock;
typedef struct { char*** list; int* count; int failed; } LbStrings;
static int lb_string_item(JP* j, void* ctx) {
  LbStrings* s = ctx;
  char* text = malloc(LB_TEXT_MAX);
  if (!text) { s->failed = 1; return jp_skip(j); }
  jp_ws(j);
  const char* start = j->p;
  if (j->p >= j->end || *j->p != '"' || !jp_string(j, text, LB_TEXT_MAX)) {
    free(text);
    j->p = start;
    return jp_skip(j); // um link longo demais ou que nao e texto fica de fora
  }
  char** next = realloc(*s->list, sizeof *next * (size_t)(*s->count + 1));
  if (!next) { free(text); s->failed = 1; return 1; }
  *s->list = next;
  char* small = realloc(text, strlen(text) + 1);
  next[(*s->count)++] = small ? small : text;
  return 1;
}
static int lb_game_field(JP* j, const char* key, void* ctx) {
  LbGame* g = ctx;
  if (!strcmp(key, "id")) {
    char text[256];
    if (!lib_text(j, text, sizeof text)) return -1;
    free(g->id);
    g->id = strdup(text);
    return 1;
  }
  if (!strcmp(key, "code")) return lib_text(j, g->code, sizeof g->code) ? 1 : -1;
  LbStrings s = {NULL, NULL, 0};
  if (!strcmp(key, "links")) { s.list = &g->links; s.count = &g->nlinks; }
  else if (!strcmp(key, "parts")) { s.list = &g->parts; s.count = &g->nparts; }
  else if (!strcmp(key, "names")) { s.list = &g->names; s.count = &g->nnames; }
  else return 0;
  return jp_array(j, lb_string_item, &s) && !s.failed ? 1 : -1;
}
static int lb_game_item(JP* j, void* ctx) {
  LbBlock* b = ctx;
  if (b->count == b->cap) {
    const int cap = b->cap ? b->cap * 2 : 64;
    LbGame* next = realloc(b->games, sizeof *next * (size_t)cap);
    if (!next) { b->failed = 1; return 0; }
    b->games = next;
    b->cap = cap;
  }
  LbGame* g = &b->games[b->count];
  memset(g, 0, sizeof *g);
  ++b->count; // conta antes: o que ja leu e liberado mesmo se o resto falhar
  if (!jp_object(j, lb_game_field, g)) return 0;
  return g->id != NULL;
}
static void lb_block_free(LbBlock* b) {
  for (int i = 0; i < b->count; ++i) {
    LbGame* g = &b->games[i];
    free(g->id);
    lb_free_list(g->links, g->nlinks); free(g->links);
    lb_free_list(g->parts, g->nparts); free(g->parts);
    lb_free_list(g->names, g->nnames); free(g->names);
  }
  free(b->games);
  memset(b, 0, sizeof *b);
}
typedef struct { char run[48]; int64_t v, blocks, b; int account, has_b; Span games; LbStrings list; } LbLine;
static int lb_line_field(JP* j, const char* key, void* ctx) {
  LbLine* l = ctx;
  if (!strcmp(key, "run")) return lib_text(j, l->run, sizeof l->run) ? 1 : -1;
  if (!strcmp(key, "v")) return jp_int64(j, &l->v) ? 1 : -1;
  if (!strcmp(key, "blocks")) return jp_int64(j, &l->blocks) ? 1 : -1;
  if (!strcmp(key, "account")) return jp_bool(j, &l->account) ? 1 : -1;
  if (!strcmp(key, "b")) { l->has_b = 1; return jp_int64(j, &l->b) ? 1 : -1; }
  if (!strcmp(key, "games")) return lb_raw(j, &l->games) ? 1 : -1;
  if (!strcmp(key, "list") && l->list.list) return jp_array(j, lb_string_item, &l->list) && !l->list.failed ? 1 : -1;
  return 0;
}
// A primeira linha do plano (o cabecalho): 1 com a rodada em `run`.
static int lb_plan_header(const char* path, char* run, size_t cap, int64_t* blocks) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) return 0;
  char head[1024];
  const ssize_t n = read(fd, head, sizeof head - 1);
  close(fd);
  if (n <= 0) return 0;
  head[n] = 0;
  char* end = strchr(head, '\n');
  if (end) *end = 0;
  LbLine l;
  memset(&l, 0, sizeof l);
  JP jp = {head, head + strlen(head), 0};
  if (!jp_object(&jp, lb_line_field, &l) || l.v != 1 || !l.run[0] || !safe_token_text(l.run) || l.blocks < 0 || l.blocks > 100000) return 0;
  copy_text(run, cap, l.run);
  if (blocks) *blocks = l.blocks;
  return 1;
}

// ---- O estado ----
static void lb_json_locked(Buf* b) {
  const int64_t wait = g_lb.wait_until ? g_lb.wait_until - mono_ms() : 0;
  buf_fmt(b, "{\"ok\":true,\"api\":%d,\"run\":", BG_API);
  buf_json(b, g_lb.run);
  buf_str(b, ",\"state\":");
  buf_json(b, g_lb.state);
  buf_str(b, ",\"phase\":");
  buf_json(b, g_lb.phase);
  buf_fmt(b, ",\"busy\":%s,\"blocks\":%d,\"done\":%d,\"calls\":%ld,\"waitMs\":%lld,\"error\":", g_lb.busy ? "true" : "false",
          g_lb.blocks, g_lb.done, g_lb.calls, (long long)(wait > 0 ? wait : 0));
  buf_json(b, g_lb.error);
  buf_str(b, "}");
}
static void lb_save_state_locked(void) {
  Buf b = {0};
  lb_json_locked(&b);
  if (b.failed || !b.data || !save_atomic(g_lb_state_path, b.data, b.size, 0644)) logf_("biblioteca: estado nao gravado: %s", strerror(errno));
  free(b.data);
}
static int lb_state_field(JP* j, const char* key, void* ctx) {
  LbState* s = ctx;
  int64_t number = 0;
  if (!strcmp(key, "run")) return lib_text(j, s->run, sizeof s->run) ? 1 : -1;
  if (!strcmp(key, "state")) return lib_text(j, s->state, sizeof s->state) ? 1 : -1;
  if (!strcmp(key, "phase")) return lib_text(j, s->phase, sizeof s->phase) ? 1 : -1;
  if (!strcmp(key, "error")) return lib_text(j, s->error, sizeof s->error) ? 1 : -1;
  if (!strcmp(key, "blocks")) { if (!jp_int64(j, &number)) return -1; s->blocks = (int)number; return 1; }
  if (!strcmp(key, "done")) { if (!jp_int64(j, &number)) return -1; s->done = (int)number; return 1; }
  if (!strcmp(key, "calls")) { if (!jp_int64(j, &number)) return -1; s->calls = (long)number; return 1; }
  return 0;
}
static void lb_set(const char* state, const char* phase, const char* error) {
  pthread_mutex_lock(&g_lb_lock);
  if (state) snprintf(g_lb.state, sizeof g_lb.state, "%s", state);
  if (phase) snprintf(g_lb.phase, sizeof g_lb.phase, "%s", phase);
  if (error) snprintf(g_lb.error, sizeof g_lb.error, "%s", error);
  lb_save_state_locked();
  pthread_mutex_unlock(&g_lb_lock);
}
static void lb_path(char* out, size_t cap, const char* name) { snprintf(out, cap, "%s/%s", g_lb_dir, name); }
static int lb_exists(const char* name) {
  char path[1024];
  struct stat st;
  lb_path(path, sizeof path, name);
  return !stat(path, &st);
}
static int lb_write(const char* name, Buf* b) {
  char path[1024];
  lb_path(path, sizeof path, name);
  return !b->failed && b->data && save_atomic(path, b->data, b->size, 0644);
}
// Os resultados de outra rodada saem (o plano e o estado ficam).
static void lb_clear(void) {
  DIR* dir = opendir(g_lb_dir);
  if (!dir) return;
  struct dirent* item;
  while ((item = readdir(dir))) {
    const char* name = item->d_name;
    const size_t n = strlen(name);
    const int block = name[0] == 'b' && n == 11 && !strcmp(name + 6, ".json");
    if (!block && strcmp(name, "account.json") && strcmp(name, "list.json")) continue;
    char path[1024];
    lb_path(path, sizeof path, name);
    unlink(path);
  }
  closedir(dir);
}

// ---- As fases ----
// A conta (myList do app): /webdl/mylist e /torrents/mylist em paginas de 250, ate 1000 itens cada.
typedef struct { Buf* out; int first, page, fresh, failed; char (*seen)[64]; int nseen, capseen; } LbPage;
static int lb_page_item(JP* j, void* ctx) {
  LbPage* p = ctx;
  ++p->page;
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{') return jp_skip(j);
  LbEntry e;
  if (!lb_entry_read(j, &e)) { lb_entry_free(&e); return 0; }
  char id[64] = "";
  int has_id = e.id.s && !(e.id.e - e.id.s == 4 && !strncmp(e.id.s, "null", 4));
  if (has_id) {
    const size_t n = (size_t)(e.id.e - e.id.s) < sizeof id - 1 ? (size_t)(e.id.e - e.id.s) : sizeof id - 1;
    memcpy(id, e.id.s, n);
    id[n] = 0;
    for (int i = 0; i < p->nseen; ++i) if (!strcmp(p->seen[i], id)) { lb_entry_free(&e); return 1; }
    if (p->nseen == p->capseen) {
      const int cap = p->capseen ? p->capseen * 2 : 256;
      char (*next)[64] = realloc(p->seen, sizeof *next * (size_t)cap);
      if (!next) { lb_entry_free(&e); p->failed = 1; return 0; }
      p->seen = next;
      p->capseen = cap;
    }
    copy_text(p->seen[p->nseen++], 64, id);
  }
  ++p->fresh;
  buf_str(p->out, p->first ? "{" : ",{");
  p->first = 0;
  int field = 0;
  const struct { const char* key; Span value; } fields[] = {{"id", e.id}, {"name", e.name}, {"hash", e.hash}, {"size", e.size}};
  for (size_t i = 0; i < sizeof fields / sizeof *fields; ++i) {
    if (!fields[i].value.s) continue;
    buf_fmt(p->out, "%s\"%s\":", field++ ? "," : "", fields[i].key);
    buf_span(p->out, fields[i].value);
  }
  buf_fmt(p->out, "%s\"files\":[", field ? "," : "");
  for (int i = 0; i < e.count; ++i) {
    if (i) buf_str(p->out, ",");
    lb_file_write(p->out, &e.files[i]);
  }
  buf_str(p->out, "]}");
  lb_entry_free(&e);
  return 1;
}
// 1 ok; 0 a rodada para (err); -1 parou; 2 a conta nao deu (erro do TorBox em `err`, a montagem segue sem ela).
static int lb_account(const char* key, Buf* body, LbErr* err) {
  Buf out = {0};
  buf_str(&out, "{");
  static const char* const kinds[2] = {"webdl", "torrent"};
  int r = 1;
  for (int k = 0; k < 2 && r == 1; ++k) {
    buf_fmt(&out, "%s\"%s\":[", k ? "," : "", kinds[k]);
    LbPage page = {&out, 1, 0, 0, 0, NULL, 0, 0};
    for (int offset = 0; offset < LB_PAGES_MAX; offset += LB_PAGE) {
      char path[160];
      snprintf(path, sizeof path, "/%s/mylist?bypass_cache=true&offset=%d&limit=%d", k ? "torrents" : "webdl", offset, LB_PAGE);
      LbAnswer a;
      r = lb_polite(path, key, body, &a, err);
      if (r == 0 && (!strcmp(err->code, "ITEM_NOT_FOUND") || !strcmp(err->code, "HTTP_404"))) { r = 1; break; }
      if (r != 1) break;
      page.page = page.fresh = 0;
      JP jp = {a.data.s, a.data.e, 0};
      if (span_is(a.data, '[')) { if (!jp_array(&jp, lb_page_item, &page)) { snprintf(err->code, sizeof err->code, "BAD_ANSWER"); r = 0; break; } }
      else if (span_is(a.data, '{')) { if (!lb_page_item(&jp, &page)) { snprintf(err->code, sizeof err->code, "BAD_ANSWER"); r = 0; break; } }
      if (page.failed) { snprintf(err->code, sizeof err->code, "NO_MEMORY"); r = 0; break; }
      if (page.page < LB_PAGE || !page.fresh) break;
    }
    free(page.seen);
    buf_str(&out, "]");
  }
  buf_str(&out, "}");
  if (r == 1) {
    if (!lb_write("account.json", &out)) { free(out.data); snprintf(err->code, sizeof err->code, "NOT_SAVED"); return 0; }
  } else if (r == 0 && !err->rate && !err->transient && !err->fatal) {
    // Como o app: "account not read" e a montagem segue sem a conta (glibren.41: menos com a chave recusada, que para).
    Buf note = {0};
    buf_str(&note, "{\"error\":");
    buf_json(&note, err->code);
    buf_str(&note, "}");
    const int saved = lb_write("account.json", &note);
    free(note.data);
    free(out.data);
    logf_("biblioteca: conta nao lida (%s)", err->code);
    return saved ? 2 : 0;
  }
  free(out.data);
  return r;
}
static void lb_held_json(Buf* b, const char* name, char** keys, char** values, int n, int text_values) {
  buf_fmt(b, "\"%s\":{", name);
  int first = 1;
  for (int i = 0; i < n; ++i) {
    if (!values[i]) continue;
    if (!first) buf_str(b, ",");
    buf_json(b, keys[i]);
    buf_str(b, ":");
    if (text_values) buf_json(b, values[i]); else buf_str(b, values[i]);
    first = 0;
  }
  buf_str(b, "}");
}
// A lista de hashes do jogador: os magnets dela, uma vez por rodada.
static int lb_list(const char* key, char** hashes, int n, Buf* body, LbErr* err) {
  char** links = calloc((size_t)n + 1, sizeof *links);
  char** found = calloc((size_t)n + 1, sizeof *found);
  char** failed = calloc((size_t)n + 1, sizeof *failed);
  int r = links && found && failed;
  for (int i = 0; r && i < n; ++i) {
    links[i] = malloc(strlen(hashes[i]) + 21);
    if (!links[i]) { r = 0; break; }
    sprintf(links[i], "magnet:?xt=urn:btih:%s", hashes[i]);
  }
  if (!r) snprintf(err->code, sizeof err->code, "NO_MEMORY");
  else r = lb_held_all(key, links, n, found, failed, body, err);
  if (r == 1) {
    Buf out = {0};
    buf_str(&out, "{");
    lb_held_json(&out, "held", hashes, found, n, 0);
    buf_str(&out, "}");
    if (!lb_write("list.json", &out)) { snprintf(err->code, sizeof err->code, "NOT_SAVED"); r = 0; }
    free(out.data);
  }
  if (links) lb_free_list(links, n);
  if (found) lb_free_list(found, n);
  if (failed) lb_free_list(failed, n);
  free(links); free(found); free(failed);
  return r;
}
// Os MD5 dos nomes (knownByName do app) de um grupo: as entradas que voltam, cada uma com o hash com que o TorBox respondeu.
typedef struct { Buf* out; int* first; int failed; } LbNames;
static int lb_names_field(JP* j, const char* key, void* ctx) {
  LbNames* n = ctx;
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{') return 0;
  LbEntry e;
  if (!lb_entry_read(j, &e)) { lb_entry_free(&e); return -1; }
  char low[64];
  snprintf(low, sizeof low, "%s", key);
  lower_ascii(low);
  buf_str(n->out, *n->first ? "{\"hash\":" : ",{\"hash\":");
  *n->first = 0;
  buf_json(n->out, low);
  buf_str(n->out, ",");
  lb_entry_write(n->out, &e, 0);
  buf_str(n->out, "}");
  lb_entry_free(&e);
  return 1;
}
static int lb_names(const char* key, char (*hashes)[33], int n, Buf* out, Buf* body, LbErr* err) {
  int first = 1;
  for (int group = 0; group < n; group += LB_ALT_GROUP) {
    const int size = n - group < LB_ALT_GROUP ? n - group : LB_ALT_GROUP;
    Buf part = {0};
    int part_first = first, r = 1;
    LbNames names = {&part, &part_first, 0};
    for (int from = 0; from < size && r == 1; from += LB_ASK) {
      const int count = size - from < LB_ASK ? size - from : LB_ASK;
      char path[2048];
      int len = snprintf(path, sizeof path, "/webdl/checkcached?hash=");
      for (int i = 0; i < count; ++i) len += snprintf(path + len, sizeof path - (size_t)len, "%s%s", i ? "%2C" : "", hashes[group + from + i]);
      snprintf(path + len, sizeof path - (size_t)len, "&format=object&list_files=true");
      LbAnswer a;
      r = lb_polite(path, key, body, &a, err);
      if (r == 1 && span_is(a.data, '{')) {
        JP jp = {a.data.s, a.data.e, 0};
        if (!jp_object(&jp, lb_names_field, &names)) { snprintf(err->code, sizeof err->code, "BAD_ANSWER"); r = 0; }
      }
    }
    if (r == 1) {
      if (part.data) buf_add(out, part.data, part.size);
      first = part_first;
    } else if (r < 0 || err->rate || err->transient) {
      free(part.data);
      return r;
    } else logf_("biblioteca: nomes nao checados: %s", err->code); // como o app: o grupo fica de fora
    free(part.data);
  }
  return 1;
}
static int lb_add_hash(char (**list)[33], int* count, int* cap, const char* hash) {
  for (int i = 0; i < *count; ++i) if (!strcmp((*list)[i], hash)) return 1;
  if (*count == *cap) {
    const int next_cap = *cap ? *cap * 2 : 64;
    char (*next)[33] = realloc(*list, sizeof *next * (size_t)next_cap);
    if (!next) return 0;
    *list = next;
    *cap = next_cap;
  }
  copy_text((*list)[(*count)++], 33, hash);
  return 1;
}
// Um bloco: os links (de arquivo unico e das partes, uma vez cada) e, dos jogos que nenhum link de arquivo unico achou, os
// nomes. 1 gravou b<N>.json; 0 a rodada para; -1 parou.
static int lb_block(const char* key, int index, LbBlock* block, Buf* body, LbErr* err) {
  int n = 0, cap = 0;
  char** links = NULL;
  for (int g = 0; g < block->count; ++g) {
    LbGame* game = &block->games[g];
    for (int pass = 0; pass < 2; ++pass) {
      char** list = pass ? game->parts : game->links;
      const int count = pass ? game->nparts : game->nlinks;
      for (int i = 0; i < count; ++i) {
        int seen = 0;
        for (int k = 0; k < n && !seen; ++k) seen = !strcmp(links[k], list[i]);
        if (seen) continue;
        if (n == cap) {
          cap = cap ? cap * 2 : 128;
          char** next = realloc(links, sizeof *next * (size_t)cap);
          if (!next) { free(links); snprintf(err->code, sizeof err->code, "NO_MEMORY"); return 0; }
          links = next;
        }
        links[n++] = list[i]; // emprestados do bloco
      }
    }
  }
  char** found = calloc((size_t)n + 1, sizeof *found);
  char** failed = calloc((size_t)n + 1, sizeof *failed);
  int r = found && failed ? lb_held_all(key, links, n, found, failed, body, err) : 0;
  if (!found || !failed) snprintf(err->code, sizeof err->code, "NO_MEMORY");
  Buf names = {0};
  if (r == 1) {
    char (*hashes)[33] = NULL;
    int count = 0, hcap = 0, ok = 1;
    static const char* const types[] = {"exfat", "ffpkg", "ffpfs", "ffpfsc"};
    for (int g = 0; g < block->count && ok; ++g) {
      LbGame* game = &block->games[g];
      int held = 0;
      for (int i = 0; i < game->nlinks && !held; ++i) for (int k = 0; k < n && !held; ++k) held = found[k] && !strcmp(links[k], game->links[i]);
      if (held) continue;
      char hash[33], text[64];
      if (game->code[0]) {
        for (size_t t = 0; t < sizeof types / sizeof *types && ok; ++t) {
          snprintf(text, sizeof text, "%s.%s", game->code, types[t]);
          lb_md5(text, strlen(text), hash);
          ok = lb_add_hash(&hashes, &count, &hcap, hash);
        }
      }
      for (int i = 0; i < game->nnames && ok; ++i) {
        lb_md5(game->names[i], strlen(game->names[i]), hash);
        ok = lb_add_hash(&hashes, &count, &hcap, hash);
      }
    }
    if (!ok) { snprintf(err->code, sizeof err->code, "NO_MEMORY"); r = 0; }
    else r = lb_names(key, hashes, count, &names, body, err);
    free(hashes);
  }
  if (r == 1) {
    Buf out = {0};
    buf_fmt(&out, "{\"b\":%d,\"ids\":[", index);
    for (int g = 0; g < block->count; ++g) { if (g) buf_str(&out, ","); buf_json(&out, block->games[g].id); }
    buf_str(&out, "],");
    lb_held_json(&out, "held", links, found, n, 0);
    buf_str(&out, ",");
    lb_held_json(&out, "failed", links, failed, n, 1);
    buf_str(&out, ",\"names\":[");
    if (names.data) buf_add(&out, names.data, names.size);
    buf_str(&out, "]}");
    char name[32];
    snprintf(name, sizeof name, "b%05d.json", index);
    if (!lb_write(name, &out)) { snprintf(err->code, sizeof err->code, "NOT_SAVED"); r = 0; }
    free(out.data);
  }
  free(names.data);
  if (found) lb_free_list(found, n);
  if (failed) lb_free_list(failed, n);
  free(found); free(failed); free(links);
  return r;
}

// Uma rodada inteira (a thread); o estado diz como acabou.
static void lb_run(void) {
  char run[48];
  pthread_mutex_lock(&g_lb_lock);
  copy_text(run, sizeof run, g_lb.run);
  pthread_mutex_unlock(&g_lb_lock);
  size_t size = 0;
  char* plan = read_text(g_lb_plan_path, LB_PLAN_MAX, &size);
  if (!plan) { lb_set("failed", NULL, "PLAN: the plan file is missing"); return; }
  // As linhas: o cabecalho, as da lista de hashes e as dos blocos (cada bloco lido so na vez dele).
  char** hashes = NULL;
  int nhashes = 0, account = 0, ok = 1, blocks = 0;
  Span* lines = NULL;
  int* numbers = NULL;
  int nlines = 0;
  char* line = plan;
  for (int at = 0; ok && line < plan + size; ++at) {
    char* end = memchr(line, '\n', (size_t)(plan + size - line));
    if (!end) end = plan + size;
    LbLine l;
    memset(&l, 0, sizeof l);
    l.list.list = &hashes;
    l.list.count = &nhashes;
    JP jp = {line, end, 0};
    jp_ws(&jp);
    if (jp.p < end) {
      if (!jp_object(&jp, lb_line_field, &l) || l.list.failed) ok = 0;
      else if (at == 0) {
        ok = l.v == 1 && !strcmp(l.run, run);
        account = l.account;
        blocks = (int)l.blocks;
      } else if (l.has_b && l.games.s) {
        Span* next = realloc(lines, sizeof *next * (size_t)(nlines + 1));
        int* next_numbers = realloc(numbers, sizeof *next_numbers * (size_t)(nlines + 1));
        if (next) lines = next;
        if (next_numbers) numbers = next_numbers;
        if (!next || !next_numbers) ok = 0;
        else { lines[nlines] = l.games; numbers[nlines++] = (int)l.b; }
      }
    }
    line = end + 1;
  }
  char key[160];
  if (!ok) lb_set("failed", NULL, "PLAN: the plan does not belong to this run");
  else if (!debrid_key("torbox", key, sizeof key)) { ok = 0; lb_set("failed", NULL, "NO_AUTH: TorBox needs an API key"); }
  pthread_mutex_lock(&g_lb_lock);
  g_lb.blocks = blocks;
  pthread_mutex_unlock(&g_lb_lock);
  Buf body = {0};
  LbErr err;
  memset(&err, 0, sizeof err);
  int r = ok ? 1 : -2;
  logf_("biblioteca: rodada %s, %d bloco(s), %d hash(es) da lista%s", run, nlines, nhashes, ok ? "" : " (nao comecou)");
  if (r == 1 && account && !lb_exists("account.json")) {
    lb_set(NULL, "account", NULL);
    r = lb_account(key, &body, &err);
    if (r == 2) r = 1;
  }
  if (r == 1 && nhashes && !lb_exists("list.json")) {
    lb_set(NULL, "list", NULL);
    r = lb_list(key, hashes, nhashes, &body, &err);
  }
  if (r == 1) lb_set(NULL, "games", NULL);
  for (int i = 0; i < nlines && r == 1; ++i) {
    char name[32];
    snprintf(name, sizeof name, "b%05d.json", numbers[i]);
    if (!lb_exists(name)) {
      LbBlock block;
      memset(&block, 0, sizeof block);
      JP jp = {lines[i].s, lines[i].e, 0};
      if (!jp_array(&jp, lb_game_item, &block) || block.failed) { r = 0; snprintf(err.code, sizeof err.code, "PLAN"); }
      else r = lb_block(key, numbers[i], &block, &body, &err);
      lb_block_free(&block);
    }
    if (r == 1) {
      pthread_mutex_lock(&g_lb_lock);
      g_lb.done = i + 1;
      lb_save_state_locked();
      pthread_mutex_unlock(&g_lb_lock);
    }
  }
  memset(key, 0, sizeof key);
  free(body.data);
  free(lines);
  free(numbers);
  lb_free_list(hashes, nhashes);
  free(hashes);
  free(plan);
  if (r == 1) { lb_set("done", "done", ""); logf_("biblioteca: rodada %s terminada", run); }
  else if (r == -1) { lb_set(g_stop && !g_lb.cancel ? "running" : "cancelled", NULL, NULL); logf_("biblioteca: rodada %s parada", run); }
  else if (r == 0) {
    char why[200];
    snprintf(why, sizeof why, "%s", err.code);
    lb_set("failed", NULL, why);
    logf_("biblioteca: rodada %s parou: %s", run, why);
  }
}

static void* lb_loop(void* unused) {
  (void)unused;
  pthread_mutex_lock(&g_lb_lock);
  while (!g_stop) {
    if (g_lb.kick) {
      g_lb.kick = 0;
      g_lb.busy = 1;
      g_lb.cancel = 0;
      pthread_mutex_unlock(&g_lb_lock);
      lb_run();
      pthread_mutex_lock(&g_lb_lock);
      g_lb.busy = 0;
      g_lb.wait_until = 0;
      lb_save_state_locked();
      continue;
    }
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += 30;
    pthread_cond_timedwait(&g_lb_wake, &g_lb_lock, &deadline);
  }
  pthread_mutex_unlock(&g_lb_lock);
  return NULL;
}

typedef struct { char run[48]; } LbBody;
static int lb_body_field(JP* j, const char* key, void* ctx) {
  LbBody* b = ctx;
  if (!strcmp(key, "run")) return lib_text(j, b->run, sizeof b->run) ? 1 : -1;
  return 0;
}
static void lb_respond_locked(int fd, int status) {
  Buf b = {0};
  lb_json_locked(&b);
  respond(fd, status, b.failed || !b.data ? "{\"ok\":false}" : b.data);
  free(b.data);
}
static int lb_route(int fd, Request* r) {
  if (strncmp(r->path, "/library/build", 14) || (r->path[14] && r->path[14] != '/')) return 0;
  const char* rest = r->path + 14;
  if (!strcmp(r->method, "GET") && !*rest) {
    pthread_mutex_lock(&g_lb_lock);
    lb_respond_locked(fd, 200);
    pthread_mutex_unlock(&g_lb_lock);
    return 1;
  }
  if (strcmp(r->method, "POST")) { respond_error(fd, 404, "not found"); return 1; }
  if (!strcmp(rest, "/cancel")) {
    pthread_mutex_lock(&g_lb_lock);
    if (g_lb.busy) { g_lb.cancel = 1; logk_("biblioteca: o app cancelou a rodada %s", g_lb.run); }
    lb_respond_locked(fd, 200);
    pthread_mutex_unlock(&g_lb_lock);
    return 1;
  }
  if (*rest) { respond_error(fd, 404, "not found"); return 1; }
  LbBody body;
  memset(&body, 0, sizeof body);
  JP jp = {r->body, r->body + r->content_length, 0};
  if (!r->body || !jp_object(&jp, lb_body_field, &body) || !body.run[0] || !safe_token_text(body.run)) {
    respond_error(fd, 400, "expected {run}");
    return 1;
  }
  char planned[48];
  int64_t blocks = 0;
  if (!lb_plan_header(g_lb_plan_path, planned, sizeof planned, &blocks) || strcmp(planned, body.run)) {
    respond_error(fd, 409, "the plan file is missing or belongs to another run");
    return 1;
  }
  pthread_mutex_lock(&g_lb_lock);
  if (g_lb.busy && strcmp(g_lb.run, body.run)) {
    pthread_mutex_unlock(&g_lb_lock);
    respond_error(fd, 409, "another run is going; cancel it first");
    return 1;
  }
  const int same = !strcmp(g_lb.run, body.run);
  // Uma rodada parada (cancelada, que falhou, ou deixada no meio) continua; a mesma ja terminada so responde.
  if (!g_lb.busy && (!same || strcmp(g_lb.state, "done"))) {
    if (strcmp(g_lb.run, body.run)) {
      lb_clear();
      copy_text(g_lb.run, sizeof g_lb.run, body.run);
      g_lb.done = g_lb.blocks = 0;
      g_lb.calls = 0;
      logk_("biblioteca: rodada nova %s", body.run);
    } else logk_("biblioteca: rodada %s continua", body.run);
    snprintf(g_lb.state, sizeof g_lb.state, "running");
    snprintf(g_lb.phase, sizeof g_lb.phase, "account");
    g_lb.blocks = (int)blocks;
    g_lb.error[0] = 0;
    g_lb.kick = 1;
    g_lb.cancel = 0;
    lb_save_state_locked();
    pthread_cond_broadcast(&g_lb_wake);
  }
  lb_respond_locked(fd, 200);
  pthread_mutex_unlock(&g_lb_lock);
  return 1;
}

static void lb_setup(void) {
  snprintf(g_lb_dir, sizeof g_lb_dir, "%s/library", g_dir);
  snprintf(g_lb_state_path, sizeof g_lb_state_path, "%s/state.json", g_lb_dir);
  snprintf(g_lb_plan_path, sizeof g_lb_plan_path, "%s/plan.ndjson", g_lb_dir);
#ifndef __PROSPERO__
  // Nos testes: sem as esperas de verdade.
  g_lb_rate_ms = atoi(env_or("BGDL_LIB_RATE_WAIT_MS", "61000"));
  g_lb_retry_ms = atoi(env_or("BGDL_LIB_RETRY_MS", "5000"));
#endif
  if (mkdir_p(g_lb_dir)) logf_("biblioteca: pasta %s nao criada: %s", g_lb_dir, strerror(errno));
  size_t size = 0;
  char* text = read_text(g_lb_state_path, 64 * 1024, &size);
  if (text) {
    LbState s;
    memset(&s, 0, sizeof s);
    JP jp = {text, text + size, 0};
    if (jp_object(&jp, lb_state_field, &s) && safe_token_text(s.run)) {
      pthread_mutex_lock(&g_lb_lock);
      copy_text(g_lb.run, sizeof g_lb.run, s.run);
      copy_text(g_lb.state, sizeof g_lb.state, s.state);
      copy_text(g_lb.phase, sizeof g_lb.phase, s.phase);
      copy_text(g_lb.error, sizeof g_lb.error, s.error);
      g_lb.blocks = s.blocks;
      g_lb.done = s.done;
      g_lb.calls = s.calls;
      // Uma rodada que o payload deixou no meio (reiniciou, PS5 desligou) continua sozinha.
      if (!strcmp(g_lb.state, "running")) { g_lb.kick = 1; logk_("biblioteca: a rodada %s continua de onde parou", g_lb.run); }
      pthread_mutex_unlock(&g_lb_lock);
    }
    free(text);
  }
}
