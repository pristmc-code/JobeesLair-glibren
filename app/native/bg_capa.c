// .56: o PROXY DE CAPAS da /app (incluido em bg_downloader.c, depois de bg_app.c).
// No navegador do PS5 a maioria das capas da /app nao abria (13/11/2026, Jobe .54) e no celular, na mesma rede, abriam
// todas. As capas do catalogo vem de image.api.playstation.com (~54%, png), cdn.prosperopatches.com (~38%, webp),
// archive.org e outros. O DNS que o console usa com o Y2JB (45.56.67.85) responde 0.0.0.0 para image.api.playstation.com
// (bloqueio de proposito; ps5-conhecimento/07); o celular usa o DNS do roteador. O WebP o navegador do PS5 12.00 mostra
// (glibren 0.7: "navegador: webp sim"). So o navegador do PS5 usa esta rota, quando a capa original falha ou demora.
//
//   GET /app/capa?id=<PPSA01234|CUSA01234>   a imagem (image/png|jpeg|webp), sem sessao, como a propria /app (so o Host
//        conferido, J6): capa de jogo do catalogo nao e segredo. Na ordem:
//        1. o icon0.png do jogo instalado (/user/appmeta/<ID>/icon0.png; BGDL_APPMETA_DIR no PC), sem internet;
//        2. o cache em disco (<g_dir>/capas/<ID>.png|.jpg|.webp; BGDL_CAPAS_DIR no PC), ate CAPA_CACHE_MAX_BYTES e
//           CAPA_CACHE_MAX_FILES (sai a mais antiga);
//        3. a rede, pelo payload (NUNCA hosts da Sony: capa_sony; o DNS do console os bloqueia de proposito): a capa do
//           catalogo e as alternativas dele (coverFallbacks da arte embutida), png/jpg
//           antes, webp por ultimo, avif nunca. Cada endereco e baixado com as raizes do payload (HTTPS verificado); se o
//           nome nao resolve ou a conexao e recusada (o 0.0.0.0 do DNS que bloqueia), tenta de novo com DNS sobre HTTPS
//           (CURLOPT_DOH_URL, 1.1.1.1; BGDL_CAPA_DOH no PC, "off" desliga). So enderecos que vem do catalogo: nada da
//           pagina, entao nao vira um proxy aberto.
//        4. o site de patches pelo TitleID (prosperopatches PS5, orbispatches PS4: capa_patches_url), pelo payload;
//        404 {"error":"sem-capa"} quando nada serviu (a pagina mostra o nome do jogo no lugar); o mesmo id fica 10 min
//        sem tentar a rede de novo. No maximo CAPA_PARALLEL baixando ao mesmo tempo (os outros esperam a vez).
//   GET /api/app/capas   {ok, local, cache, rede, doh, falhou, semCapa, ocupado}: as contagens desde a subida (vao para
//        as medidas da /app e o diario registra as primeiras falhas de rede com o motivo).

#include <dirent.h>

#define CAPA_MAX_BYTES (3u * 1024 * 1024)
#define CAPA_CACHE_MAX_BYTES (48ull * 1024 * 1024)
#define CAPA_CACHE_MAX_FILES 1500
#define CAPA_PARALLEL 2
#define CAPA_NEG 256
#define CAPA_NEG_S 600
#define CAPA_LOG_MAX 60
#define CAPA_URLS 6

static pthread_mutex_t g_capa_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_capa_cond = PTHREAD_COND_INITIALIZER;
static int g_capa_running, g_capa_logged;
static char g_capa_dir[600], g_appmeta_dir[512], g_capa_doh[160];
static int g_capa_ready;
static struct { char id[16]; int64_t until; } g_capa_neg[CAPA_NEG];
static int g_capa_neg_at;
static struct { long local, cache, rede, doh, patches, falhou, sem; } g_capa_count;

static const struct { const char* ext; const char* type; } CAPA_TYPES[] = {{".png", "image/png"}, {".jpg", "image/jpeg"}, {".webp", "image/webp"}};

static void capa_setup_locked(void) {
  if (g_capa_ready) return;
  char fallback[600];
  snprintf(fallback, sizeof fallback, "%.580s/capas", g_dir);
  copy_text(g_capa_dir, sizeof g_capa_dir, env_or("BGDL_CAPAS_DIR", fallback));
  copy_text(g_appmeta_dir, sizeof g_appmeta_dir, env_or("BGDL_APPMETA_DIR", "/user/appmeta"));
  copy_text(g_capa_doh, sizeof g_capa_doh, env_or("BGDL_CAPA_DOH", "https://1.1.1.1/dns-query"));
  if (!strcmp(g_capa_doh, "off")) g_capa_doh[0] = 0; // so nos testes do PC
  g_capa_ready = 1;
}

static int capa_id_ok(const char* id) {
  return strlen(id) == 9 && strspn(id, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") == 4 && strspn(id + 4, "0123456789") == 5;
}
// O tipo pelos primeiros bytes: 0 png, 1 jpg, 2 webp, -1 outro (avif, html de erro...).
static int capa_kind(const unsigned char* d, size_t n) {
  if (n >= 8 && !memcmp(d, "\x89PNG\r\n\x1a\n", 8)) return 0;
  if (n >= 3 && d[0] == 0xFF && d[1] == 0xD8 && d[2] == 0xFF) return 1;
  if (n >= 12 && !memcmp(d, "RIFF", 4) && !memcmp(d + 8, "WEBP", 4)) return 2;
  return -1;
}
static void capa_send(int fd, const char* type, const char* data, size_t size, const char* source) {
  char head[400];
  const int n = snprintf(head, sizeof head,
                         "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %zu\r\nCache-Control: private, max-age=86400\r\n"
                         "X-Content-Type-Options: nosniff\r\nX-Capa-Fonte: %s\r\nConnection: close\r\n\r\n", type, size, source);
  if (send_all(fd, head, (size_t)n) && size) send_all(fd, data, size);
}
// Serve um arquivo do disco. 1 = serviu.
static int capa_send_file(int fd, const char* path, const char* type, const char* source) {
  struct stat st;
  if (stat(path, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0 || (uint64_t)st.st_size > CAPA_MAX_BYTES) return 0;
  size_t size = 0;
  char* data = read_text(path, CAPA_MAX_BYTES, &size);
  if (!data) return 0;
  const int kind = capa_kind((const unsigned char*)data, size);
  if (kind < 0) { free(data); return 0; }
  capa_send(fd, type ? type : CAPA_TYPES[kind].type, data, size, source);
  free(data);
  return 1;
}

static int capa_neg_has(const char* id) {
  const int64_t now = now_s();
  for (int i = 0; i < CAPA_NEG; ++i) if (g_capa_neg[i].until > now && !strcmp(g_capa_neg[i].id, id)) return 1;
  return 0;
}
static void capa_neg_add(const char* id) {
  copy_text(g_capa_neg[g_capa_neg_at].id, sizeof g_capa_neg[0].id, id);
  g_capa_neg[g_capa_neg_at].until = now_s() + CAPA_NEG_S;
  g_capa_neg_at = (g_capa_neg_at + 1) % CAPA_NEG;
}

// Os enderecos do jogo: a capa e as alternativas (png/jpg antes, webp depois, sem avif). Devolve quantos (malloc cada).
static int capa_ext_rank(const char* url) {
  char path[300];
  copy_text(path, sizeof path, url);
  path[strcspn(path, "?#")] = 0;
  for (char* c = path; *c; ++c) if (*c >= 'A' && *c <= 'Z') *c = (char)(*c - 'A' + 'a');
  const size_t n = strlen(path);
  if (n > 5 && !strcmp(path + n - 5, ".avif")) return -1;
  if (n > 5 && !strcmp(path + n - 5, ".webp")) return 1;
  return 0;
}
// REGRA FIXA DO PROJETO: o DNS do console bloqueia a Sony DE PROPOSITO (o console desbloqueado nao pode falar com
// ela). Nenhum host da Sony e baixado pelo payload nem resolvido por DoH: a capa deles fica so com o icon0.png local e
// as alternativas de outros sites; sem nenhuma, a pagina mostra o nome do jogo.
static const char* const CAPA_SONY[] = {"playstation.com", "playstation.net", "sony.com", "sony.net", "scea.com", "sonyentertainmentnetwork.com",
                                        "playstationnetwork.com", "sie.com", "np.community.playstation.net", NULL};
static int capa_sony(const char* url) {
  char host[128];
  const char* h = strstr(url, "://");
  h = h ? h + 3 : url;
  size_t n = strcspn(h, "/?#:@");
  if (n >= sizeof host) return 1; // host absurdo: nao arrisca
  for (size_t i = 0; i < n; ++i) host[i] = (char)tolower((unsigned char)h[i]);
  host[n] = 0;
  while (n && host[n - 1] == '.') host[--n] = 0;
  for (int i = 0; CAPA_SONY[i]; ++i) {
    const size_t k = strlen(CAPA_SONY[i]);
    if (n == k ? !strcmp(host, CAPA_SONY[i]) : n > k && host[n - k - 1] == '.' && !strcmp(host + n - k, CAPA_SONY[i])) return 1;
  }
  return 0;
}
static void capa_push(char** urls, int* n, const char* url) {
  if (!url || strncmp(url, "https://", 8) || *n >= CAPA_URLS || capa_ext_rank(url) < 0) return;
  if (capa_sony(url)) return; // nunca a Sony (nem direto, nem por DoH)
  for (int i = 0; i < *n; ++i) if (!strcmp(urls[i], url)) return;
  char* copy = strdup(url);
  if (copy) urls[(*n)++] = copy;
}
static int capa_urls(const char* id, char** urls) {
  int n = 0;
  Catalog* c = cat_get();
  if (c) {
    const CtGame* g = ct_find_game(c, id);
    if (g) {
      capa_push(urls, &n, g->cover);
      if (!g->from_feed && g->lazy[0] >= 0) { // a arte do embutido: art/<n>.json (~12 KB), so a posicao deste jogo
        CtDetail d;
        memset(&d, 0, sizeof d);
        char path[800];
        snprintf(path, sizeof path, "%s/catalog/art/%d.json", c->bundled_dir, g->lazy[0]);
        size_t size = 0;
        char* art = ct_read_file(path, &size, 8u << 20);
        if (art) { CtArtRead r = {&d, g->lazy[1], 0}; JP jp = {art, art + size, 0}; jp_array(&jp, ct_art_item, &r); ct_free(art); }
        for (int i = 0; i < d.fallbacks.n; ++i) {
          char* sized = ct_cover_size(d.fallbacks.v[i], c->cover_width);
          capa_push(urls, &n, sized);
          ct_free(sized);
        }
        ct_detail_free(&d);
      }
    }
    cat_put(c);
  } else {
    StGame g;
    char key[96];
    if (st_lookup(id, &g, key, sizeof key, NULL) == 1) capa_push(urls, &n, g.cover);
  }
  // png/jpg antes de webp (ordem estavel)
  for (int i = 1; i < n; ++i)
    for (int k = i; k > 0 && capa_ext_rank(urls[k - 1]) > capa_ext_rank(urls[k]); --k) { char* t = urls[k]; urls[k] = urls[k - 1]; urls[k - 1] = t; }
  return n;
}

static size_t capa_on_body(char* data, size_t size, size_t count, void* ctx) {
  Buf* b = ctx;
  const size_t n = size * count;
  if (b->size + n > CAPA_MAX_BYTES) return 0;
  buf_add(b, data, n);
  return b->failed ? 0 : n;
}
// Um GET. CURLcode; *status o HTTP.
static CURLcode capa_get(const char* url, int doh, Buf* out, long* status) {
  *status = 0;
  CURL* curl = curl_easy_init();
  if (!curl) return CURLE_OUT_OF_MEMORY;
  configure_transport(curl, url);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 6L);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
  curl_easy_setopt(curl, CURLOPT_MAXFILESIZE, (long)CAPA_MAX_BYTES);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, capa_on_body);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, out);
#if LIBCURL_VERSION_NUM >= 0x073E00
  if (doh && g_capa_doh[0]) curl_easy_setopt(curl, CURLOPT_DOH_URL, g_capa_doh);
#else
  (void)doh;
#endif
  const CURLcode r = curl_easy_perform(curl);
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, status);
  curl_easy_cleanup(curl);
  return r;
}
static void capa_host(const char* url, char* out, size_t cap) {
  const char* h = strstr(url, "://");
  h = h ? h + 3 : url;
  size_t n = strcspn(h, "/?#:");
  if (n >= cap) n = cap - 1;
  memcpy(out, h, n);
  out[n] = 0;
}
static void capa_log(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
static void capa_log(const char* fmt, ...) {
  pthread_mutex_lock(&g_capa_lock);
  const int ok = g_capa_logged < CAPA_LOG_MAX;
  if (ok) ++g_capa_logged;
  pthread_mutex_unlock(&g_capa_lock);
  if (!ok) return;
  char line[400];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(line, sizeof line, fmt, ap);
  va_end(ap);
  logf_("capa: %s", line);
}

// Limpa o cache: acima do teto (bytes ou arquivos), apaga as mais antigas ate 80%.
static void capa_trim(void) {
  DIR* dir = opendir(g_capa_dir);
  if (!dir) return;
  typedef struct { char name[32]; int64_t mtime; uint64_t size; } CapaEntry;
  CapaEntry* list = NULL;
  int n = 0, cap = 0;
  uint64_t total = 0;
  struct dirent* e;
  while ((e = readdir(dir))) {
    if (e->d_name[0] == '.' || strlen(e->d_name) >= sizeof list[0].name) continue;
    char path[700];
    snprintf(path, sizeof path, "%.600s/%s", g_capa_dir, e->d_name);
    struct stat st;
    if (stat(path, &st) || !S_ISREG(st.st_mode)) continue;
    if (n == cap) { cap = cap ? cap * 2 : 256; CapaEntry* more = realloc(list, sizeof *list * (size_t)cap); if (!more) break; list = more; }
    copy_text(list[n].name, sizeof list[n].name, e->d_name);
    list[n].mtime = (int64_t)st.st_mtime;
    list[n].size = (uint64_t)st.st_size;
    total += list[n].size;
    ++n;
  }
  closedir(dir);
  if (total > CAPA_CACHE_MAX_BYTES || n > CAPA_CACHE_MAX_FILES) {
    for (int i = 1; i < n; ++i) for (int k = i; k > 0 && list[k - 1].mtime > list[k].mtime; --k) { CapaEntry t = list[k]; list[k] = list[k - 1]; list[k - 1] = t; }
    int left = n, removed = 0;
    for (int i = 0; i < n && (total > CAPA_CACHE_MAX_BYTES * 8 / 10 || left > CAPA_CACHE_MAX_FILES * 8 / 10); ++i) {
      char path[700];
      snprintf(path, sizeof path, "%.600s/%s", g_capa_dir, list[i].name);
      if (!unlink(path)) { total -= list[i].size; --left; ++removed; }
    }
    logf_("capa: cache acima do teto, %d capa(s) antiga(s) apagada(s)", removed);
  }
  free(list);
}

// Baixa a primeira capa que servir. 1 = serviu (e guardou no cache).
static int capa_fetch(int fd, const char* id, char** urls, int n, int patches) {
  for (int i = 0; i < n; ++i) {
    char host[128];
    capa_host(urls[i], host, sizeof host);
    for (int doh = 0; doh < 2; ++doh) {
      Buf b = {0};
      long status = 0;
      const CURLcode r = capa_get(urls[i], doh, &b, &status);
      const int kind = r == CURLE_OK && status == 200 && b.data ? capa_kind((const unsigned char*)b.data, b.size) : -1;
      if (kind >= 0) {
        char path[700];
        if (!mkdir_p(g_capa_dir)) {
          snprintf(path, sizeof path, "%.600s/%s%s", g_capa_dir, id, CAPA_TYPES[kind].ext);
          if (save_atomic(path, b.data, b.size, 0644)) capa_trim();
        }
        capa_send(fd, CAPA_TYPES[kind].type, b.data, b.size, doh ? "doh" : "rede");
        pthread_mutex_lock(&g_capa_lock);
        if (patches) ++g_capa_count.patches; else if (doh) ++g_capa_count.doh; else ++g_capa_count.rede;
        pthread_mutex_unlock(&g_capa_lock);
        if (doh || i || patches) capa_log("%s: %s%s (%zu bytes)", id, host, doh ? " pelo DoH" : patches ? " (site de patches)" : i ? " (alternativa)" : "", b.size);
        free(b.data);
        return 1;
      }
      capa_log("%s: %s falhou%s (curl %d %s, HTTP %ld, %zu bytes)", id, host, doh ? " pelo DoH" : "", (int)r, curl_easy_strerror(r), status, b.size);
      free(b.data);
      // DoH so quando nao veio resposta HTTP nenhuma (nome que nao resolve, o 0.0.0.0 do DNS que bloqueia: conexao
      // recusada, ou o TLS de outro servidor); um 404 do site ou um tempo esgotado nao mudam com outro DNS.
      if (doh || !g_capa_doh[0] || status || r == CURLE_OK || r == CURLE_OPERATION_TIMEDOUT) break;
    }
  }
  return 0;
}

// .56 (pedido do dono): nenhuma capa do catalogo abriu (ou nao ha): a do site de patches pelo TitleID, como o glibren
// faz com os icones desde o comeco: prosperopatches.com/<ID> (PS5) e orbispatches.com/<CUSA> (PS4); a pagina traz o
// icone em class="game-icon..." ... url(https://...). O PAYLOAD baixa a pagina e a imagem e a /app recebe pelo
// /app/capa: no glibren 0.6 o navegador do PS5 nao mostrava as do prosperopatches pedidas direto, e pelo payload sim
// (PS5 real). Nunca nada da Sony (capa_sony vale para o endereco achado). BGDL_CAPA_PATCHES (PC): "off" ou outra base
// (os testes: http://127.0.0.1:<porta>/), a mesma para PS4 e PS5. 1 = achou o endereco da imagem.
static int capa_patches_url(const char* id, char* out, size_t cap) {
  const char* base = getenv("BGDL_CAPA_PATCHES");
  if (base && !strcmp(base, "off")) return 0;
  char page[320];
  if (base && *base) snprintf(page, sizeof page, "%.280s%s", base, id);
  else snprintf(page, sizeof page, "https://%s/%s", strncmp(id, "CUSA", 4) ? "prosperopatches.com" : "orbispatches.com", id);
  Buf b = {0};
  long status = 0;
  const CURLcode r = capa_get(page, 0, &b, &status);
  int ok = 0;
  if (r == CURLE_OK && status == 200 && b.data) {
    const char* d = b.data;
    const size_t n = b.size;
    for (size_t i = 0; !ok && i + 9 < n; ++i) {
      if (memcmp(d + i, "game-icon", 9)) continue;
      size_t lim = i + 800 < n ? i + 800 : n; // o url( fica na mesma tag
      for (size_t k = i + 9; k + 4 < lim; ++k) {
        if (d[k] == '>') break;
        if (memcmp(d + k, "url(", 4)) continue;
        size_t a = k + 4;
        if (a < n && (d[a] == '\'' || d[a] == '"' || (d[a] == '&' && a + 6 < n && !memcmp(d + a, "&quot;", 6)))) a += d[a] == '&' ? 6 : 1;
        size_t e = a;
        while (e < n && e - a < cap - 1 && d[e] != ')' && d[e] != '\'' && d[e] != '"' && d[e] != '&' && d[e] > ' ') ++e;
        if (e - a < 12 || e - a >= cap) break;
        memcpy(out, d + a, e - a);
        out[e - a] = 0;
        const int https = !strncmp(out, "https://", 8), teste = base && *base && !strncmp(out, "http://", 7);
        if ((https || teste) && !capa_sony(out)) ok = 1;
        else capa_log("%s: site de patches com icone recusado (%.80s)", id, out);
        break;
      }
    }
    if (!ok) capa_log("%s: site de patches sem icone na pagina (%zu bytes)", id, n);
  } else {
    capa_log("%s: site de patches falhou (curl %d, HTTP %ld)", id, (int)r, status);
  }
  free(b.data);
  return ok;
}

static void capa_route(int fd, const char* query) {
  char id[16] = "";
  const char* at = query ? strstr(query, "id=") : NULL;
  if (at && (at == query || at[-1] == '&')) { at += 3; size_t n = strcspn(at, "&"); if (n < sizeof id) { memcpy(id, at, n); id[n] = 0; } }
  if (!capa_id_ok(id)) { monitor_json(fd, 400, "{\"error\":\"id\"}"); return; }
  pthread_mutex_lock(&g_capa_lock);
  capa_setup_locked();
  pthread_mutex_unlock(&g_capa_lock);
  char path[700];
  // 1. o jogo instalado
  snprintf(path, sizeof path, "%.500s/%s/icon0.png", g_appmeta_dir, id);
  if (capa_send_file(fd, path, "image/png", "local")) { pthread_mutex_lock(&g_capa_lock); ++g_capa_count.local; pthread_mutex_unlock(&g_capa_lock); return; }
  // 2. o cache
  for (size_t i = 0; i < sizeof CAPA_TYPES / sizeof CAPA_TYPES[0]; ++i) {
    snprintf(path, sizeof path, "%.600s/%s%s", g_capa_dir, id, CAPA_TYPES[i].ext);
    if (capa_send_file(fd, path, CAPA_TYPES[i].type, "cache")) { pthread_mutex_lock(&g_capa_lock); ++g_capa_count.cache; pthread_mutex_unlock(&g_capa_lock); return; }
  }
  // 3. a rede (uma vez a cada 10 min por jogo; no maximo CAPA_PARALLEL ao mesmo tempo)
  pthread_mutex_lock(&g_capa_lock);
  const int negative = capa_neg_has(id);
  if (negative) ++g_capa_count.sem;
  pthread_mutex_unlock(&g_capa_lock);
  if (negative) { monitor_json(fd, 404, "{\"error\":\"sem-capa\"}"); return; }
  char* urls[CAPA_URLS] = {0};
  const int n = capa_urls(id, urls);
  int served = 0;
  {
    pthread_mutex_lock(&g_capa_lock);
    while (g_capa_running >= CAPA_PARALLEL) pthread_cond_wait(&g_capa_cond, &g_capa_lock);
    ++g_capa_running;
    pthread_mutex_unlock(&g_capa_lock);
    if (n) served = capa_fetch(fd, id, urls, n, 0);
    if (!served) { // 4. o site de patches pelo TitleID
      char icon[1024];
      char* one[1] = {icon};
      if (capa_patches_url(id, icon, sizeof icon)) served = capa_fetch(fd, id, one, 1, 1);
    }
    pthread_mutex_lock(&g_capa_lock);
    --g_capa_running;
    pthread_cond_signal(&g_capa_cond);
    pthread_mutex_unlock(&g_capa_lock);
  }
  for (int i = 0; i < n; ++i) free(urls[i]);
  if (served) return;
  pthread_mutex_lock(&g_capa_lock);
  capa_neg_add(id);
  if (n) ++g_capa_count.falhou; else ++g_capa_count.sem;
  pthread_mutex_unlock(&g_capa_lock);
  if (!n) capa_log("%s: sem endereco de capa no catalogo", id);
  monitor_json(fd, 404, "{\"error\":\"sem-capa\"}");
}

static void capa_status(int fd) {
  char out[240];
  pthread_mutex_lock(&g_capa_lock);
  snprintf(out, sizeof out, "{\"ok\":true,\"local\":%ld,\"cache\":%ld,\"rede\":%ld,\"doh\":%ld,\"patches\":%ld,\"falhou\":%ld,\"semCapa\":%ld,\"ocupado\":%d}",
           g_capa_count.local, g_capa_count.cache, g_capa_count.rede, g_capa_count.doh, g_capa_count.patches, g_capa_count.falhou, g_capa_count.sem, g_capa_running);
  pthread_mutex_unlock(&g_capa_lock);
  monitor_json(fd, 200, out);
}

// Pagina do celular. 1 = tratou.
static int capa_monitor_route(int fd, Request* r, const char* query) {
  const int capa = !strcmp(r->path, "/app/capa"), status = !strcmp(r->path, "/api/app/capas");
  if (!capa && !status) return 0;
  if (strcmp(r->method, "GET")) { monitor_json(fd, 404, "{\"error\":\"not found\"}"); return 1; }
  if (capa) capa_route(fd, query); else capa_status(fd);
  return 1;
}
