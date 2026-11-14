// Copyright (C) 2026 JVK3R and Jobee'sLair contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// BANCO DE CAPAS PELO CELULAR (ideia do dono, 13/11/2026; incluido em bg_downloader.c, depois de bg_capa.c).
//
// O DNS que o console usa bloqueia a Sony DE PROPOSITO (ps5-conhecimento/07) e o payload nunca fala com ela
// (capa_sony em bg_capa.c), entao ~54% das capas do catalogo (image.api.playstation.com) nao abrem no PS5. O celular
// tem internet propria e o app JobeControle baixa NATIVAMENTE (sem CORS; a Sony nao manda Access-Control-Allow-Origin,
// uma pagina nao leria os bytes) as capas que faltam, aos poucos e so no Wi-Fi, reduz para no maximo 440 px em JPEG e
// manda ao payload por estas rotas. O console continua sem falar com a Sony: so recebe bytes do celular.
//
// O banco fica em /data/JobeesLair/capas-banco (a pasta irma de g_dir; BGDL_CAPAS_BANCO_DIR no PC), um arquivo por
// jogo: <ID>.jpg|.png|.webp. O proxy de capas (/app/capa, bg_capa.c) olha o banco PRIMEIRO; quando nada serve, o id
// entra nas "pedidas" (memoria, as BANK_ASKED mais recentes) e o celular as busca antes do resto na proxima vez.
//
// Limites: cada imagem ate BANK_IMG_MAX (o read_request aceita esse corpo so em /api/capas/enviar); o banco ate
// BANK_MAX_BYTES e BANK_MAX_FILES (BGDL_CAPAS_BANCO_MAX / BGDL_CAPAS_BANCO_ARQUIVOS no PC); e so grava com ao menos
// BANK_MIN_FREE livre no disco (BGDL_CAPAS_BANCO_LIVRE). Cheio = 507 {"error":"cheio"} e o celular para (nada e
// apagado sozinho: o que esta no banco continua servindo). So PNG, JPEG e WebP conferidos pelos primeiros bytes
// (capa_kind), e so ids do catalogo (ou das pedidas): nao vira deposito de arquivo qualquer.
//
// Rotas da pagina do celular (porta 34201), todas com monitor_allowed (aparelho pareado, o proprio PS5 ou o PIN antigo
// na transicao; sem credencial = 401 {"error":"pin"}):
//   GET  /api/capas/estado          {ok, enviadas, bytes, maxBytes, maxArquivos, maxImagem, livre, catalogo, faltando,
//                                   pedidas, falharam, cheio, recebidas, servidas}
//   GET  /api/capas/lista?max=N     {ok, enviadas, faltando, pedidas, cheio, itens:[{id, urls:[...]}]} (N ate
//                                   BANK_LIST_MAX): as pedidas primeiro, depois os jogos do catalogo na ordem da loja que
//                                   nao tem capa no banco, no cache do proxy nem instalada (icon0), e que o celular nao
//                                   marcou como "falhou" nas ultimas 24 h. As urls sao as do catalogo, INCLUSIVE as da
//                                   Sony: quem baixa e o celular, nunca o payload. Cheio = itens vazio.
//   POST /api/capas/enviar?id=ID    corpo = os bytes da imagem -> {ok, id, enviadas, bytes} | 400 {error:"id"|"vazio"}
//                                   | 404 {error:"fora-do-catalogo"} | 413 {error:"grande"} | 415 {error:"tipo"}
//                                   | 507 {error:"cheio"}
//   POST /api/capas/falhou?ids=A,B  o celular nao achou capa para esses jogos: saem da lista por 24 h -> {ok, marcadas}
//   POST /api/capas/apagar          esvazia o banco -> {ok, apagadas}
// Rota livre (como /app/capa, so o Host conferido):
//   GET  /app/capa?u=<url>          a TV (Image.setRouter no PS5, app/state/picture-route.js) pede pela URL da capa do
//                                   catalogo: o payload acha o jogo pela URL (sem a parte depois do "?") e serve SO o
//                                   que esta no disco (banco, icon0 do jogo instalado, cache do proxy): a pagina do
//                                   celular atende so MONITOR_CLIENTS (4) conexoes ao mesmo tempo e a TV pede muitas
//                                   capas de uma vez; a rede (ate 15 s cada) ocuparia as vagas do celular. Sem nada:
//                                   404 e o jogo vira "pedida". URL fora do catalogo = 404.

#define BANK_IMG_MAX (512u * 1024) // o read_request de bg_downloader.c usa o mesmo numero para /api/capas/enviar
#define BANK_MAX_BYTES (192ull * 1024 * 1024)
#define BANK_MAX_FILES 8000
#define BANK_MIN_FREE (1024ull * 1024 * 1024)
#define BANK_ASKED 256
#define BANK_FAILED 2048
#define BANK_FAILED_S (24 * 3600)
#define BANK_LIST_MAX 50
#define BANK_URLS 4

typedef struct { char id[10]; uint32_t size; int8_t kind; } BankItem;

static pthread_mutex_t g_bank_lock = PTHREAD_MUTEX_INITIALIZER; // nunca segura outra trava junto
static int g_bank_ready, g_bank_max_files;
static char g_bank_dir[640];
static uint64_t g_bank_max_bytes, g_bank_min_free, g_bank_bytes;
static BankItem* g_bank; // ordenado por id (bsearch)
static int g_bank_n, g_bank_cap;
static char g_bank_asked[BANK_ASKED][10]; // a mais recente primeiro
static int g_bank_asked_n;
static struct { char id[10]; int64_t until; } g_bank_failed[BANK_FAILED];
static int g_bank_failed_at;
static long g_bank_received, g_bank_served, g_bank_refused;

static int bank_cmp(const void* a, const void* b) { return strcmp(((const BankItem*)a)->id, ((const BankItem*)b)->id); }
static int bank_id_cmp(const void* a, const void* b) { return strcmp((const char*)a, (const char*)b); }
static uint64_t bank_env_u64(const char* name, uint64_t fallback) {
  const char* v = getenv(name);
  uint64_t n;
  return v && *v && decimal(v, &n) ? n : fallback;
}
// A extensao do arquivo: 0 png, 1 jpg, 2 webp (a mesma ordem de CAPA_TYPES e capa_kind), -1 outra.
static int bank_ext_kind(const char* ext) {
  for (int i = 0; i < 3; ++i) if (!strcmp(ext, CAPA_TYPES[i].ext)) return i;
  return -1;
}

// Com g_bank_lock: le a pasta uma vez (o resto e mantido na memoria a cada envio).
static void bank_setup_locked(void) {
  if (g_bank_ready) return;
  const char* own = getenv("BGDL_CAPAS_BANCO_DIR");
  if (own && *own) copy_text(g_bank_dir, sizeof g_bank_dir, own);
  else {
    char parent[sizeof g_dir];
    copy_text(parent, sizeof parent, g_dir);
    char* slash = strrchr(parent, '/');
    if (slash && slash != parent) *slash = 0;
    snprintf(g_bank_dir, sizeof g_bank_dir, "%.580s/capas-banco", parent); // /data/JobeesLair/bg -> /data/JobeesLair/capas-banco
  }
  g_bank_max_bytes = bank_env_u64("BGDL_CAPAS_BANCO_MAX", BANK_MAX_BYTES);
  g_bank_max_files = (int)bank_env_u64("BGDL_CAPAS_BANCO_ARQUIVOS", BANK_MAX_FILES);
  g_bank_min_free = bank_env_u64("BGDL_CAPAS_BANCO_LIVRE", BANK_MIN_FREE);
  g_bank_ready = 1;
  DIR* dir = opendir(g_bank_dir);
  if (!dir) return;
  struct dirent* e;
  while ((e = readdir(dir))) {
    const char* dot = strrchr(e->d_name, '.');
    if (!dot || dot - e->d_name != 9) continue;
    char id[10];
    memcpy(id, e->d_name, 9);
    id[9] = 0;
    const int kind = bank_ext_kind(dot);
    if (kind < 0 || !capa_id_ok(id)) continue;
    char path[700];
    snprintf(path, sizeof path, "%.600s/%.40s", g_bank_dir, e->d_name);
    struct stat st;
    if (stat(path, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0) continue;
    int dup = 0;
    for (int i = 0; i < g_bank_n && !dup; ++i) dup = !strcmp(g_bank[i].id, id);
    if (dup) continue;
    if (g_bank_n == g_bank_cap) {
      const int cap = g_bank_cap ? g_bank_cap * 2 : 256;
      BankItem* more = realloc(g_bank, sizeof *g_bank * (size_t)cap);
      if (!more) break;
      g_bank = more;
      g_bank_cap = cap;
    }
    BankItem* it = &g_bank[g_bank_n++];
    copy_text(it->id, sizeof it->id, id);
    it->size = (uint32_t)st.st_size;
    it->kind = (int8_t)kind;
    g_bank_bytes += it->size;
  }
  closedir(dir);
  if (g_bank_n > 1) qsort(g_bank, (size_t)g_bank_n, sizeof *g_bank, bank_cmp);
  if (g_bank_n) logf_("capas: banco do celular com %d capa(s), %llu KiB", g_bank_n, (unsigned long long)(g_bank_bytes / 1024));
}
static BankItem* bank_find_locked(const char* id) {
  if (!g_bank_n) return NULL;
  BankItem key;
  copy_text(key.id, sizeof key.id, id);
  return bsearch(&key, g_bank, (size_t)g_bank_n, sizeof *g_bank, bank_cmp);
}
static int bank_failed_locked(const char* id, int64_t now) {
  for (int i = 0; i < BANK_FAILED; ++i) if (g_bank_failed[i].until > now && !strcmp(g_bank_failed[i].id, id)) return 1;
  return 0;
}
static void bank_unask_locked(const char* id) {
  for (int i = 0; i < g_bank_asked_n; ++i) {
    if (strcmp(g_bank_asked[i], id)) continue;
    memmove(g_bank_asked[i], g_bank_asked[i + 1], sizeof g_bank_asked[0] * (size_t)(g_bank_asked_n - i - 1));
    --g_bank_asked_n;
    return;
  }
}

// /app/capa (bg_capa.c): 1 = serviu do banco.
static int bank_send(int fd, const char* id) {
  char path[700] = "";
  pthread_mutex_lock(&g_bank_lock);
  bank_setup_locked();
  const BankItem* it = bank_find_locked(id);
  if (it) snprintf(path, sizeof path, "%.600s/%s%s", g_bank_dir, it->id, CAPA_TYPES[it->kind].ext);
  pthread_mutex_unlock(&g_bank_lock);
  if (!path[0] || !capa_send_file(fd, path, NULL, "banco")) return 0;
  pthread_mutex_lock(&g_bank_lock);
  ++g_bank_served;
  pthread_mutex_unlock(&g_bank_lock);
  return 1;
}
// /app/capa nao achou nada: o celular busca na proxima sincronizacao (a mais recente primeiro).
static void bank_ask(const char* id) {
  pthread_mutex_lock(&g_bank_lock);
  bank_setup_locked();
  if (!bank_find_locked(id) && !bank_failed_locked(id, now_s())) {
    bank_unask_locked(id);
    if (g_bank_asked_n == BANK_ASKED) --g_bank_asked_n;
    memmove(g_bank_asked[1], g_bank_asked[0], sizeof g_bank_asked[0] * (size_t)g_bank_asked_n);
    copy_text(g_bank_asked[0], sizeof g_bank_asked[0], id);
    ++g_bank_asked_n;
  }
  pthread_mutex_unlock(&g_bank_lock);
}

// ---- O catalogo: os ids na ordem da loja e os enderecos de um jogo ----
// Os ids (malloc, *n), do catalogo do payload (Fase 3) ou, sem ele, do store-index.json do app. NULL sem catalogo.
static char (*bank_catalog_ids(int* n))[10] {
  *n = 0;
  char (*ids)[10] = NULL;
  Catalog* c = cat_get();
  if (c) {
    if (c->ngames > 0 && (ids = malloc(sizeof *ids * (size_t)c->ngames)))
      for (int i = 0; i < c->ngames; ++i) if (capa_id_ok(c->games[i]->id)) copy_text(ids[(*n)++], sizeof ids[0], c->games[i]->id);
    cat_put(c);
    return ids;
  }
  pthread_mutex_lock(&g_store_lock);
  if (st_refresh_locked() == 1 && g_store && g_store->count > 0 && (ids = malloc(sizeof *ids * (size_t)g_store->count)))
    for (int i = 0; i < g_store->count; ++i) if (capa_id_ok(g_store->games[i].id)) copy_text(ids[(*n)++], sizeof ids[0], g_store->games[i].id);
  pthread_mutex_unlock(&g_store_lock);
  return ids;
}
// 1 = o id e de um jogo do catalogo.
static int bank_known(const char* id) {
  Catalog* c = cat_get();
  if (c) {
    const int ok = ct_find_game(c, id) != NULL;
    cat_put(c);
    return ok;
  }
  StGame g;
  char key[96];
  return st_lookup(id, &g, key, sizeof key, NULL) == 1;
}
static void bank_push(char** urls, int* n, const char* url) {
  if (!url || strncmp(url, "https://", 8) || *n >= BANK_URLS || capa_ext_rank(url) < 0) return; // avif nunca
  for (int i = 0; i < *n; ++i) if (!strcmp(urls[i], url)) return;
  char* copy = strdup(url);
  if (copy) urls[(*n)++] = copy;
}
// Os enderecos que o CELULAR tenta (a capa do catalogo e as alternativas da arte embutida, como capa_urls, mas COM os
// da Sony: quem baixa e o celular). Devolve quantos (malloc cada).
static int bank_urls(const char* id, char** urls) {
  int n = 0;
  Catalog* c = cat_get();
  if (c) {
    const CtGame* g = ct_find_game(c, id);
    if (g) {
      bank_push(urls, &n, g->cover);
      if (!g->from_feed && g->lazy[0] >= 0) {
        CtDetail d;
        memset(&d, 0, sizeof d);
        char path[800];
        snprintf(path, sizeof path, "%s/catalog/art/%d.json", c->bundled_dir, g->lazy[0]);
        size_t size = 0;
        char* art = ct_read_file(path, &size, 8u << 20);
        if (art) { CtArtRead r = {&d, g->lazy[1], 0}; JP jp = {art, art + size, 0}; jp_array(&jp, ct_art_item, &r); ct_free(art); }
        for (int i = 0; i < d.fallbacks.n; ++i) {
          char* sized = ct_cover_size(d.fallbacks.v[i], c->cover_width);
          bank_push(urls, &n, sized);
          ct_free(sized);
        }
        ct_detail_free(&d);
      }
    }
    cat_put(c);
  } else {
    StGame g;
    char key[96];
    if (st_lookup(id, &g, key, sizeof key, NULL) == 1) bank_push(urls, &n, g.cover);
  }
  return n;
}
// O mesmo endereco sem a parte depois do "?" (a largura ?w= muda entre a TV, a /app e o catalogo).
static int bank_same_url(const char* a, const char* b) {
  const size_t na = strcspn(a, "?#"), nb = strcspn(b, "?#");
  return na == nb && na > 8 && !strncmp(a, b, na);
}
// O jogo de uma URL de capa do catalogo (para a TV). 1 = achou.
static int bank_id_of_url(const char* url, char id[10]) {
  int found = 0;
  Catalog* c = cat_get();
  if (c) {
    for (int i = 0; i < c->count && !found; ++i)
      if (c->all[i]->cover && bank_same_url(c->all[i]->cover, url) && capa_id_ok(c->all[i]->id)) { copy_text(id, 10, c->all[i]->id); found = 1; }
    cat_put(c);
    return found;
  }
  pthread_mutex_lock(&g_store_lock);
  if (st_refresh_locked() == 1 && g_store)
    for (int i = 0; i < g_store->count && !found; ++i)
      if (bank_same_url(g_store->games[i].cover, url) && capa_id_ok(g_store->games[i].id)) { copy_text(id, 10, g_store->games[i].id); found = 1; }
  pthread_mutex_unlock(&g_store_lock);
  return found;
}

// Os ids que ja tem capa no PS5 sem o banco: o cache do proxy (<g_dir>/capas) e os jogos instalados (appmeta).
// Ordenados (malloc, *n).
static void bank_more_ids(char (**ids)[10], int* n, int* cap, const char* path, int files) {
  DIR* dir = opendir(path);
  if (!dir) return;
  struct dirent* e;
  while ((e = readdir(dir))) {
    char id[10];
    if (strlen(e->d_name) < 9) continue;
    memcpy(id, e->d_name, 9);
    id[9] = 0;
    if (!capa_id_ok(id) || (files ? e->d_name[9] != '.' : e->d_name[9] != 0)) continue;
    if (*n == *cap) {
      const int more_cap = *cap ? *cap * 2 : 256;
      char (*more)[10] = realloc(*ids, sizeof **ids * (size_t)more_cap);
      if (!more) break;
      *ids = more;
      *cap = more_cap;
    }
    copy_text((*ids)[(*n)++], 10, id);
  }
  closedir(dir);
}
static char (*bank_elsewhere(int* n))[10] {
  char (*ids)[10] = NULL;
  int cap = 0;
  *n = 0;
  char cache[600], appmeta[512];
  pthread_mutex_lock(&g_capa_lock);
  capa_setup_locked();
  copy_text(cache, sizeof cache, g_capa_dir);
  copy_text(appmeta, sizeof appmeta, g_appmeta_dir);
  pthread_mutex_unlock(&g_capa_lock);
  bank_more_ids(&ids, n, &cap, cache, 1);
  bank_more_ids(&ids, n, &cap, appmeta, 0);
  if (*n > 1) qsort(ids, (size_t)*n, sizeof *ids, bank_id_cmp);
  return ids;
}

// O retrato do banco para /estado e /lista. Com `want` > 0, escolhe ate `want` ids (as pedidas, depois o catalogo).
typedef struct { int enviadas, catalogo, faltando, pedidas, falharam, cheio; uint64_t bytes, livre; int n; char ids[BANK_LIST_MAX][10]; } BankView;
static uint64_t bank_free_bytes(void) {
  struct statvfs vfs;
  char probe[640];
  copy_text(probe, sizeof probe, g_bank_dir);
  if (mkdir_p(probe) || statvfs(probe, &vfs)) return 0;
  return (uint64_t)vfs.f_bavail * (uint64_t)vfs.f_frsize;
}
static void bank_view(BankView* v, int want) {
  memset(v, 0, sizeof *v);
  int ncat = 0, nel = 0;
  char (*cat)[10] = bank_catalog_ids(&ncat);
  char (*el)[10] = bank_elsewhere(&nel);
  const int64_t now = now_s();
  pthread_mutex_lock(&g_bank_lock);
  bank_setup_locked();
  v->enviadas = g_bank_n;
  v->bytes = g_bank_bytes;
  v->pedidas = g_bank_asked_n;
  for (int i = 0; i < BANK_FAILED; ++i) if (g_bank_failed[i].until > now) ++v->falharam;
  v->cheio = g_bank_bytes >= g_bank_max_bytes || g_bank_n >= g_bank_max_files;
  for (int i = 0; i < g_bank_asked_n && v->n < want; ++i)
    if (!bank_find_locked(g_bank_asked[i]) && !bank_failed_locked(g_bank_asked[i], now)) copy_text(v->ids[v->n++], 10, g_bank_asked[i]);
  v->catalogo = ncat;
  for (int i = 0; i < ncat; ++i) {
    if (bank_find_locked(cat[i]) || bank_failed_locked(cat[i], now)) continue;
    if (nel && bsearch(cat[i], el, (size_t)nel, sizeof *el, bank_id_cmp)) continue;
    ++v->faltando;
    if (v->n >= want) continue;
    int dup = 0;
    for (int k = 0; k < v->n && !dup; ++k) dup = !strcmp(v->ids[k], cat[i]);
    if (!dup) copy_text(v->ids[v->n++], 10, cat[i]);
  }
  pthread_mutex_unlock(&g_bank_lock);
  free(cat);
  free(el);
  v->livre = bank_free_bytes();
  if (v->livre < g_bank_min_free) v->cheio = 1;
  if (v->cheio) v->n = 0;
}

static void bank_estado(int fd) {
  BankView v;
  bank_view(&v, 0);
  Buf b = {0};
  pthread_mutex_lock(&g_bank_lock);
  buf_fmt(&b, "{\"ok\":true,\"enviadas\":%d,\"bytes\":%llu,\"maxBytes\":%llu,\"maxArquivos\":%d,\"maxImagem\":%u,\"livre\":%llu,\"catalogo\":%d,"
              "\"faltando\":%d,\"pedidas\":%d,\"falharam\":%d,\"cheio\":%s,\"recebidas\":%ld,\"servidas\":%ld,\"recusadas\":%ld}",
          v.enviadas, (unsigned long long)v.bytes, (unsigned long long)g_bank_max_bytes, g_bank_max_files, BANK_IMG_MAX, (unsigned long long)v.livre, v.catalogo,
          v.faltando, v.pedidas, v.falharam, v.cheio ? "true" : "false", g_bank_received, g_bank_served, g_bank_refused);
  pthread_mutex_unlock(&g_bank_lock);
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_json(fd, 200, b.data);
  free(b.data);
}

// O valor de `name=` na query (cortado em cap), "" sem ele.
static void bank_param(const char* query, const char* name, char* out, size_t cap) {
  out[0] = 0;
  const size_t k = strlen(name);
  for (const char* at = query; at && *at;) {
    if (!strncmp(at, name, k) && at[k] == '=') { const char* v = at + k + 1; url_decode(v, strcspn(v, "&"), out, cap); return; }
    at = strchr(at, '&');
    if (at) ++at;
  }
}

static void bank_lista(int fd, const char* query) {
  char text[16];
  bank_param(query, "max", text, sizeof text);
  int want = atoi(text);
  if (want <= 0) want = 20;
  if (want > BANK_LIST_MAX) want = BANK_LIST_MAX;
  BankView* v = malloc(sizeof *v);
  if (!v) { monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
  bank_view(v, want);
  Buf b = {0};
  buf_fmt(&b, "{\"ok\":true,\"enviadas\":%d,\"faltando\":%d,\"pedidas\":%d,\"cheio\":%s,\"itens\":[", v->enviadas, v->faltando, v->pedidas, v->cheio ? "true" : "false");
  int shown = 0;
  for (int i = 0; i < v->n; ++i) {
    char* urls[BANK_URLS] = {0};
    const int n = bank_urls(v->ids[i], urls);
    if (n) {
      buf_fmt(&b, "%s{\"id\":\"%s\",\"urls\":[", shown++ ? "," : "", v->ids[i]);
      for (int k = 0; k < n; ++k) { if (k) buf_str(&b, ","); buf_json(&b, urls[k]); }
      buf_str(&b, "]}");
    }
    for (int k = 0; k < n; ++k) free(urls[k]);
  }
  buf_str(&b, "]}");
  free(v);
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_json(fd, 200, b.data);
  free(b.data);
}

static void bank_refuse(int fd, int status, const char* body) {
  pthread_mutex_lock(&g_bank_lock);
  ++g_bank_refused;
  pthread_mutex_unlock(&g_bank_lock);
  monitor_json(fd, status, body);
}
static void bank_enviar(int fd, Request* r, const char* query) {
  char id[16];
  bank_param(query, "id", id, sizeof id);
  if (!capa_id_ok(id)) { bank_refuse(fd, 400, "{\"error\":\"id\"}"); return; }
  if (!r->body || !r->content_length) { bank_refuse(fd, 400, "{\"error\":\"vazio\"}"); return; }
  if (r->content_length > BANK_IMG_MAX) { bank_refuse(fd, 413, "{\"error\":\"grande\"}"); return; }
  const int kind = capa_kind((const unsigned char*)r->body, r->content_length);
  if (kind < 0) { bank_refuse(fd, 415, "{\"error\":\"tipo\"}"); return; }
  int asked = 0;
  pthread_mutex_lock(&g_bank_lock);
  bank_setup_locked();
  for (int i = 0; i < g_bank_asked_n && !asked; ++i) asked = !strcmp(g_bank_asked[i], id);
  pthread_mutex_unlock(&g_bank_lock);
  if (!asked && !bank_known(id)) { bank_refuse(fd, 404, "{\"error\":\"fora-do-catalogo\"}"); return; }
  const uint64_t livre = bank_free_bytes();
  char path[700], out[200];
  pthread_mutex_lock(&g_bank_lock);
  BankItem* old = bank_find_locked(id);
  const uint64_t after = g_bank_bytes - (old ? old->size : 0) + r->content_length;
  if (after > g_bank_max_bytes || (!old && g_bank_n >= g_bank_max_files) || livre < g_bank_min_free + r->content_length) {
    ++g_bank_refused;
    pthread_mutex_unlock(&g_bank_lock);
    monitor_json(fd, 507, "{\"error\":\"cheio\"}");
    return;
  }
  int ok = !mkdir_p(g_bank_dir);
  if (ok) {
    snprintf(path, sizeof path, "%.600s/%s%s", g_bank_dir, id, CAPA_TYPES[kind].ext);
    ok = save_atomic(path, r->body, r->content_length, 0644);
  }
  if (ok) {
    for (int i = 0; i < 3; ++i) { // a mesma capa em outro formato sai (um arquivo por jogo)
      if (i == kind) continue;
      char other[700];
      snprintf(other, sizeof other, "%.600s/%s%s", g_bank_dir, id, CAPA_TYPES[i].ext);
      unlink(other);
    }
    if (old) { g_bank_bytes -= old->size; old->size = (uint32_t)r->content_length; old->kind = (int8_t)kind; g_bank_bytes += old->size; }
    else {
      if (g_bank_n == g_bank_cap) {
        const int cap = g_bank_cap ? g_bank_cap * 2 : 256;
        BankItem* more = realloc(g_bank, sizeof *g_bank * (size_t)cap);
        if (more) { g_bank = more; g_bank_cap = cap; }
      }
      if (g_bank_n < g_bank_cap) {
        int at = g_bank_n;
        while (at > 0 && strcmp(g_bank[at - 1].id, id) > 0) --at;
        memmove(&g_bank[at + 1], &g_bank[at], sizeof *g_bank * (size_t)(g_bank_n - at));
        copy_text(g_bank[at].id, sizeof g_bank[at].id, id);
        g_bank[at].size = (uint32_t)r->content_length;
        g_bank[at].kind = (int8_t)kind;
        ++g_bank_n;
        g_bank_bytes += r->content_length;
      } else ok = 0; // sem memoria para o indice: o arquivo fica e entra na proxima subida
    }
    bank_unask_locked(id);
    for (int i = 0; i < BANK_FAILED; ++i) if (!strcmp(g_bank_failed[i].id, id)) g_bank_failed[i].until = 0;
    ++g_bank_received;
    snprintf(out, sizeof out, "{\"ok\":true,\"id\":\"%s\",\"enviadas\":%d,\"bytes\":%llu}", id, g_bank_n, (unsigned long long)g_bank_bytes);
  } else ++g_bank_refused;
  const long received = g_bank_received;
  pthread_mutex_unlock(&g_bank_lock);
  if (!ok) { monitor_json(fd, 500, "{\"error\":\"disco\"}"); return; }
  if (received == 1 || received % 100 == 0) logf_("capas: banco do celular recebeu %ld capa(s) desde a subida (ultima %s, %zu bytes)", received, id, r->content_length);
  monitor_json(fd, 200, out);
}

static void bank_falhou(int fd, const char* query) {
  char list[1000];
  bank_param(query, "ids", list, sizeof list);
  int marked = 0;
  const int64_t until = now_s() + BANK_FAILED_S;
  pthread_mutex_lock(&g_bank_lock);
  bank_setup_locked();
  char* save = NULL;
  for (char* tok = strtok_r(list, ",", &save); tok; tok = strtok_r(NULL, ",", &save)) {
    if (!capa_id_ok(tok)) continue;
    copy_text(g_bank_failed[g_bank_failed_at].id, sizeof g_bank_failed[0].id, tok);
    g_bank_failed[g_bank_failed_at].until = until;
    g_bank_failed_at = (g_bank_failed_at + 1) % BANK_FAILED;
    bank_unask_locked(tok);
    ++marked;
  }
  pthread_mutex_unlock(&g_bank_lock);
  char out[80];
  snprintf(out, sizeof out, "{\"ok\":true,\"marcadas\":%d}", marked);
  monitor_json(fd, 200, out);
}

static void bank_apagar(int fd) {
  int removed = 0;
  pthread_mutex_lock(&g_bank_lock);
  bank_setup_locked();
  for (int i = 0; i < g_bank_n; ++i) {
    char path[700];
    snprintf(path, sizeof path, "%.600s/%s%s", g_bank_dir, g_bank[i].id, CAPA_TYPES[g_bank[i].kind].ext);
    if (!unlink(path)) ++removed;
  }
  g_bank_n = 0;
  g_bank_bytes = 0;
  pthread_mutex_unlock(&g_bank_lock);
  logf_("capas: banco do celular esvaziado (%d capa(s))", removed);
  char out[80];
  snprintf(out, sizeof out, "{\"ok\":true,\"apagadas\":%d}", removed);
  monitor_json(fd, 200, out);
}

// A capa para a TV, so do disco: o banco, o icon0 do jogo instalado e o cache do proxy (nunca a rede).
static void bank_tv(int fd, const char* id) {
  if (bank_send(fd, id)) return;
  char appmeta[512], cache[600], path[700];
  pthread_mutex_lock(&g_capa_lock);
  capa_setup_locked();
  copy_text(appmeta, sizeof appmeta, g_appmeta_dir);
  copy_text(cache, sizeof cache, g_capa_dir);
  pthread_mutex_unlock(&g_capa_lock);
  snprintf(path, sizeof path, "%.500s/%s/icon0.png", appmeta, id);
  if (capa_send_file(fd, path, "image/png", "local")) return;
  for (size_t i = 0; i < sizeof CAPA_TYPES / sizeof CAPA_TYPES[0]; ++i) {
    snprintf(path, sizeof path, "%.600s/%s%s", cache, id, CAPA_TYPES[i].ext);
    if (capa_send_file(fd, path, CAPA_TYPES[i].type, "cache")) return;
  }
  bank_ask(id);
  monitor_json(fd, 404, "{\"error\":\"sem-capa\"}");
}

// Pagina do celular. 1 = tratou.
static int bank_monitor_route(int fd, Request* r, const char* query) {
  if (!strcmp(r->path, "/app/capa") && query && !strstr(query, "id=") && strstr(query, "u=")) {
    if (strcmp(r->method, "GET")) { monitor_json(fd, 404, "{\"error\":\"not found\"}"); return 1; }
    char url[1024], id[10];
    bank_param(query, "u", url, sizeof url);
    if (strncmp(url, "https://", 8) || !bank_id_of_url(url, id)) { monitor_json(fd, 404, "{\"error\":\"sem-capa\"}"); return 1; }
    bank_tv(fd, id);
    return 1;
  }
  if (strncmp(r->path, "/api/capas/", 11)) return 0;
  const char* what = r->path + 11;
  const int get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST");
  if (!(get && (!strcmp(what, "estado") || !strcmp(what, "lista"))) && !(post && (!strcmp(what, "enviar") || !strcmp(what, "falhou") || !strcmp(what, "apagar")))) {
    monitor_json(fd, 404, "{\"error\":\"not found\"}");
    return 1;
  }
  if (!monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return 1; }
  if (!strcmp(what, "estado")) bank_estado(fd);
  else if (!strcmp(what, "lista")) bank_lista(fd, query);
  else if (!strcmp(what, "enviar")) bank_enviar(fd, r, query);
  else if (!strcmp(what, "falhou")) bank_falhou(fd, query);
  else bank_apagar(fd);
  return 1;
}
