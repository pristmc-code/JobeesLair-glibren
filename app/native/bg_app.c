// Fase 8 (ps5/ESTUDO-jobe-como-payload.md): a JOBE WEB COMPLETA (incluido em bg_downloader.c, depois de bg_settings.c).
// Uma pagina NOVA, em /app, que convive com a pagina do celular ("/", bg_monitor.html) sem substitui-la: loja em grade de
// capas (lista virtual, paginas do /api/store), ficha com "Baixar" (/api/store/add), downloads ao vivo (/api/status e
// /api/jobs/<id>/<acao>), Configuracoes (/api/settings, Fase 7), Biblioteca/Homebrew "em breve"; layouts de celular em pe
// e deitado, PC e navegador do PS5 (1540x700 com a moldura, 1920x1080 em tela cheia) e navegacao por controle e teclado.
// A pagina (bg_app.html, embutida em bg_app_html.h por tools/bg-monitor/embed.mjs) sai sem sessao, como "/" (nao traz
// dado nenhum). Protecao: Host conferido (J6, monitor_host_ok, TODO pedido desta porta) e as rotas de sempre com
// monitor_allowed (pareamento por aparelho, bg_pair.c; o PIN antigo na transicao).
//
//   GET  /app, /app/, /app/index.html   a pagina (text/html; a CSP de monitor_send: scripts e estilos so inline,
//                                       dados so deste payload, imagens data:, https: e deste payload: .56)
//   GET  /app/capa?id=, /api/app/capas   .56: o proxy de capas do navegador do PS5 (bg_capa.c)
//   GET  /api/app/telacheia            {ok, glibren, item, estado, ocupado}: o glibren (porta 8765 no mesmo PS5) esta no
//                                       ar e tem o item "web-browser-fullscreen" (0.9.20+)? Livre (nao traz dado).
//   POST /api/app/telacheia {volta}    (monitor_strong: aparelho pareado ou o proprio PS5; o PIN antigo nao) pede ao
//                                       glibren a ativacao do ps5-web-browser-fullscreen (owendswang, GPL-3): o glibren
//                                       volta a tela inicial e corrige o ShellUI na memoria; quando ele termina, ESTE
//                                       payload reabre o navegador do PS5 em http://127.0.0.1:<porta>/app<volta>
//                                       (o glibren so sabe reabrir paginas dele). -> {ok} | 409 {error:"jogo"|"ocupado"}
//                                       | 502 {error:"glibren", status} | 503 {error:"sem-glibren"}.
//   A pagina so mostra o botao no PS5, com o glibren no ar, e fora da tela cheia (a CSP dela nao deixa falar com a 8765:
//   por isso a ponte e aqui). Glibren: POST /api/payloads/ativar (form id=..., cabecalho X-GLR, User-Agent do PS5, de
//   127.0.0.1: isento do pareamento dele) e GET /api/payloads ({ocupado, itens:[{id, estado}]}).
#include "bg_app_html.h"

#if defined(__PROSPERO__)
int sceSystemServiceLaunchWebBrowser(const char*, void*) __attribute__((weak));
#endif
#define APP_GLR_ITEM "web-browser-fullscreen"
#define APP_GLR_UA "Mozilla/5.0 (PlayStation; PlayStation 5) JobeesLair-bg"

static int app_glr_port(void) { const int p = atoi(env_or("BGDL_GLIBREN_PORT", "8765")); return p > 0 && p < 65536 ? p : 8765; }

// Um pedido curto ao glibren em 127.0.0.1. `form`: corpo x-www-form-urlencoded (POST) ou NULL (GET). Devolve o status HTTP
// (0 = nao respondeu) e o corpo em *out (malloc; o chamador libera).
static long app_glr(const char* path, const char* form, char** out) {
  *out = NULL;
  CURL* curl = curl_easy_init();
  if (!curl) return 0;
  char url[128];
  snprintf(url, sizeof url, "http://127.0.0.1:%d%s", app_glr_port(), path);
  Body body = {0};
  curl_easy_setopt(curl, CURLOPT_URL, url);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 1500L);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 5000L);
  curl_easy_setopt(curl, CURLOPT_USERAGENT, APP_GLR_UA);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, on_small_body);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
  struct curl_slist* headers = curl_slist_append(NULL, "X-GLR: 1");
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  if (form) curl_easy_setopt(curl, CURLOPT_POSTFIELDS, form);
  long status = 0;
  if (curl_easy_perform(curl) == CURLE_OK) curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
  *out = body.data;
  return status;
}

// O estado do item de tela cheia no JSON do glibren: "" = sem o item. *busy = o glibren esta ocupado.
static void app_glr_item(const char* json, char* estado, size_t cap, int* busy) {
  estado[0] = 0;
  *busy = json && strstr(json, "\"ocupado\":true") != NULL;
  const char* item = json ? strstr(json, "\"id\":\"" APP_GLR_ITEM "\"") : NULL;
  if (!item) return;
  const char* e = strstr(item, "\"estado\":\"");
  const char* next = strstr(item + 1, "\"id\":\"");
  if (!e || (next && e > next)) { copy_text(estado, cap, "?"); return; }
  e += 10;
  size_t n = 0;
  while (e[n] && e[n] != '"' && n + 1 < cap) { estado[n] = e[n]; ++n; }
  estado[n] = 0;
}

static void app_open_browser(const char* url) {
#if defined(__PROSPERO__)
  const int r = sceSystemServiceLaunchWebBrowser ? sceSystemServiceLaunchWebBrowser(url, NULL) : -1;
  logk_("tela cheia: navegador reaberto em %s (0x%08x)", url, (unsigned)r);
#else
  logk_("tela cheia: (PC) abriria o navegador em %s", url);
#endif
}

// Espera o glibren terminar (ate 2 min) e reabre o navegador na /app, mesmo se falhou: ninguem fica na tela inicial.
static void* app_fullscreen_wait(void* arg) {
  char* url = arg;
  const int64_t until = mono_ms() + 120000;
  int seen_busy = 0;
  char estado[32] = "";
  while (mono_ms() < until) {
    sleep_ms(1000);
    char* json = NULL;
    const long status = app_glr("/api/payloads", NULL, &json);
    int busy = 0;
    if (status == 200) app_glr_item(json, estado, sizeof estado, &busy);
    free(json);
    if (busy) { seen_busy = 1; continue; }
    if (status == 200 && (seen_busy || !strcmp(estado, "ativado") || !strcmp(estado, "erro"))) break;
  }
  logk_("tela cheia: glibren terminou (%s)", estado[0] ? estado : "sem resposta");
  app_open_browser(url);
  free(url);
  return NULL;
}

typedef struct { char back[96]; } AppFullBody;
static int app_full_field(JP* jp, const char* key, void* ctx) {
  if (!strcmp(key, "volta")) return jp_text(jp, ((AppFullBody*)ctx)->back, sizeof ((AppFullBody*)ctx)->back) ? 1 : -1;
  return jp_skip(jp) ? 1 : -1;
}

static void app_fullscreen(int fd, Request* r, int post) {
  char* json = NULL;
  char estado[32] = "";
  int busy = 0;
  if (!post) {
    const long status = app_glr("/api/payloads", NULL, &json);
    if (status == 200) app_glr_item(json, estado, sizeof estado, &busy);
    free(json);
    char out[200];
    snprintf(out, sizeof out, "{\"ok\":true,\"glibren\":%s,\"item\":%s,\"estado\":\"%s\",\"ocupado\":%s}", status == 200 ? "true" : "false",
             estado[0] ? "true" : "false", estado, busy ? "true" : "false");
    monitor_json(fd, 200, out);
    return;
  }
  if (!monitor_strong(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  AppFullBody b;
  memset(&b, 0, sizeof b);
  JP jp = {r->body ? r->body : "", r->body ? r->body + r->content_length : "", 0};
  if (r->body && r->content_length && !jp_object(&jp, app_full_field, &b)) { monitor_json(fd, 400, "{\"error\":\"body\"}"); return; }
  // "volta": so o hash da /app (#/loja, #/jogo/PPSA01234...): letras, numeros e # / - _ . =
  if (b.back[0] && (b.back[0] != '#' || strspn(b.back, "#/-_.=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") != strlen(b.back))) b.back[0] = 0;
  const long status = app_glr("/api/payloads/ativar", "id=" APP_GLR_ITEM, &json);
  if (status == 200 && json && strstr(json, "\"ok\":true")) {
    free(json);
    char* url = malloc(200);
    if (url) {
      snprintf(url, 200, "http://127.0.0.1:%d/app%s", g_monitor_port_now(), b.back);
      pthread_t t;
      if (pthread_create(&t, NULL, app_fullscreen_wait, url)) { free(url); }
      else pthread_detach(t);
    }
    logk_("tela cheia: pedida ao glibren (reabre a /app%s)", b.back);
    monitor_json(fd, 200, "{\"ok\":true}");
    return;
  }
  const int game = json && strstr(json, "payload_jogo_aberto"), occupied = json && strstr(json, "payload_ocupado");
  free(json);
  char out[96];
  if (!status) monitor_json(fd, 503, "{\"error\":\"sem-glibren\"}");
  else if (game) monitor_json(fd, 409, "{\"error\":\"jogo\"}");
  else if (occupied) monitor_json(fd, 409, "{\"error\":\"ocupado\"}");
  else { snprintf(out, sizeof out, "{\"error\":\"glibren\",\"status\":%ld}", status); monitor_json(fd, 502, out); }
}

// Pagina do celular. 1 = tratou.
static int app_monitor_route(int fd, Request* r) {
  if (!strcmp(r->path, "/api/app/telacheia")) {
    if (!strcmp(r->method, "GET")) app_fullscreen(fd, r, 0);
    else if (!strcmp(r->method, "POST")) app_fullscreen(fd, r, 1);
    else monitor_json(fd, 404, "{\"error\":\"not found\"}");
    return 1;
  }
  if (strcmp(r->path, "/app") && strcmp(r->path, "/app/") && strcmp(r->path, "/app/index.html")) return 0;
  if (strcmp(r->method, "GET")) { monitor_json(fd, 404, "{\"error\":\"not found\"}"); return 1; }
  monitor_send(fd, 200, "text/html; charset=utf-8", BG_APP_HTML, BG_APP_HTML_SIZE);
  return 1;
}
