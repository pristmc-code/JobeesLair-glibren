// glibren.47: a PAGINA DE TESTES da Fase 0 (incluido em bg_downloader.c, depois de bg_diag.c e bg_jobe.c).
// O jogador abre http://<ip-do-ps5>:34201/teste no navegador do PS5 (aba Midia) ou no celular e mede o que decide a
// "Jobe como payload" (ps5/ESTUDO-jobe-como-payload.md, Fase 0): tela cheia, controle (Gamepad API e teclado), a loja
// grande (/api/store inteira), a memoria deste payload e se ele sobrevive ao repouso. A pagina (bg_teste.html, embutida
// em bg_teste_html.h por tools/bg-monitor/embed.mjs) e servida sem sessao, como "/" (nao traz dado nenhum); as rotas
// abaixo pedem a sessao do PIN (X-Session; 401 {error:"pin"} sem ela) e passam pelo Host conferido (J6) do servidor.
//
//   GET  /teste, /teste/          a pagina (text/html)
//   GET  /api/teste/estado        {ok, pid, started, uptimeSeconds, now, version, build, api, rssBytes, rssSource,
//                                  peakBytes, peakSource, requests, lastRequest, previous}
//        rssBytes: memoria residente AGORA, em bytes (Linux: /proc/self/statm; PS5/FreeBSD: sysctl kern.proc.pid,
//        ki_rssize em paginas * getpagesize()); null se o sistema nao disser (rssSource null).
//        peakBytes: o PICO da residente desde o inicio do processo, em bytes (getrusage ru_maxrss, que o Linux e o
//        FreeBSD dao em KiB; aqui * 1024).
//        lastRequest: a hora (unix s) do pedido ANTERIOR a este (null no primeiro); requests: quantos desde o inicio.
//        previous: o que estava em <dir>/teste-estado.json quando este processo subiu ({pid, started, last}) ou null: o
//        processo anterior (se o payload reiniciou durante o repouso, e o pid antigo e a hora do ultimo pedido a ele).
//        Cada pedido grava <dir>/teste-estado.json = {pid, started, last} (pequeno, atomico).
//   POST /api/teste/enviar {texto} grava os resultados da pagina em <diag>/teste-resultados.txt (ate 64 KB, 0600) e
//        comeca uma rodada do diagnostico (bg_diag.c, a mesma do "Enviar diagnostico"): o arquivo vai junto, passado
//        pela mesma higienizacao (diag_clean). Respostas iguais as de POST /api/diag/send (200/400 no-key/409 busy);
//        400 {error:"texto"} sem o campo.
//   POST /api/teste/gravar {texto} (glibren.65) so grava teste-resultados.txt, sem rodada: a loja /app manda as medidas
//        sozinha a cada 15 s quando mudam, e o diagnostico pedido pelo celular ja as leva.
#include "bg_teste_html.h"
#include <sys/resource.h>
#if !defined(__linux__)
#include <sys/user.h>
#endif

#define TESTE_TEXT_MAX (64u * 1024)

static pthread_mutex_t g_teste_lock = PTHREAD_MUTEX_INITIALIZER;
static int64_t g_teste_started, g_teste_started_mono, g_teste_last;
static long g_teste_requests;
static struct { int known; long pid; int64_t started, last; } g_teste_previous;

// Na subida (main, depois do mkdir de g_dir): a hora de inicio e o estado que o processo anterior deixou.
typedef struct { long pid; int64_t started, last; } TesteFile;
static int teste_file_field(JP* jp, const char* key, void* ctx) {
  TesteFile* f = ctx;
  uint64_t v = 0;
  if (strcmp(key, "pid") && strcmp(key, "started") && strcmp(key, "last")) return 0;
  if (!jp_uint(jp, &v)) return -1;
  if (!strcmp(key, "pid")) f->pid = (long)v;
  else if (!strcmp(key, "started")) f->started = (int64_t)v;
  else f->last = (int64_t)v;
  return 1;
}
static void teste_boot(void) {
  g_teste_started = now_s();
  g_teste_started_mono = mono_ms();
  char path[600];
  snprintf(path, sizeof path, "%.500s/teste-estado.json", g_dir);
  size_t size = 0;
  char* text = read_text(path, 4096, &size);
  if (!text) return;
  TesteFile f = {0, 0, 0};
  JP jp = {text, text + size, 0};
  if (jp_object(&jp, teste_file_field, &f) && f.pid > 0) {
    g_teste_previous.known = 1;
    g_teste_previous.pid = f.pid;
    g_teste_previous.started = f.started;
    g_teste_previous.last = f.last;
  }
  free(text);
}

// A residente agora, em bytes; 0 = o sistema nao disse. `source` diz de onde veio.
static uint64_t teste_rss(const char** source) {
  *source = NULL;
#if defined(__linux__)
  FILE* file = fopen("/proc/self/statm", "r");
  if (!file) return 0;
  unsigned long long pages_total = 0, pages_resident = 0;
  const int got = fscanf(file, "%llu %llu", &pages_total, &pages_resident);
  fclose(file);
  if (got != 2) return 0;
  *source = "proc";
  return (uint64_t)pages_resident * (uint64_t)sysconf(_SC_PAGESIZE);
#else
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)getpid()};
  struct kinfo_proc info;
  size_t length = sizeof info;
  memset(&info, 0, sizeof info);
  if (sysctl(mib, 4, &info, &length, NULL, 0) || length < sizeof info) return 0;
  *source = "sysctl";
  return (uint64_t)info.ki_rssize * (uint64_t)getpagesize();
#endif
}

static void teste_estado(int fd) {
  const int64_t now = now_s();
  pthread_mutex_lock(&g_teste_lock);
  const int64_t last = g_teste_last;
  g_teste_last = now;
  const long requests = ++g_teste_requests;
  pthread_mutex_unlock(&g_teste_lock);
  // grava {pid, started, last}: o proximo processo (se este morrer no repouso) le e a pagina mostra
  char path[600], line[160];
  snprintf(path, sizeof path, "%.500s/teste-estado.json", g_dir);
  const int n = snprintf(line, sizeof line, "{\"pid\":%ld,\"started\":%lld,\"last\":%lld}\n", (long)getpid(), (long long)g_teste_started, (long long)now);
  if (n > 0 && !save_atomic(path, line, (size_t)n, 0600)) logf_("teste-estado.json nao gravado: %s", strerror(errno));
  const char* rss_source = NULL;
  const uint64_t rss = teste_rss(&rss_source);
  struct rusage usage;
  memset(&usage, 0, sizeof usage);
  const int has_peak = !getrusage(RUSAGE_SELF, &usage) && usage.ru_maxrss > 0;
  Buf b = {0};
  buf_fmt(&b, "{\"ok\":true,\"pid\":%ld,\"started\":%lld,\"uptimeSeconds\":%lld,\"now\":%lld", (long)getpid(), (long long)g_teste_started,
          (long long)((mono_ms() - g_teste_started_mono) / 1000), (long long)now);
  buf_fmt(&b, ",\"version\":\"%s\",\"build\":\"%s\",\"api\":%d", BG_VERSION, BG_BUILD, BG_API);
  if (rss && rss_source) buf_fmt(&b, ",\"rssBytes\":%llu,\"rssSource\":\"%s\"", (unsigned long long)rss, rss_source);
  else buf_str(&b, ",\"rssBytes\":null,\"rssSource\":null");
  if (has_peak) buf_fmt(&b, ",\"peakBytes\":%llu,\"peakSource\":\"getrusage\"", (unsigned long long)usage.ru_maxrss * 1024ull);
  else buf_str(&b, ",\"peakBytes\":null,\"peakSource\":null");
  buf_fmt(&b, ",\"requests\":%ld", requests);
  if (last) buf_fmt(&b, ",\"lastRequest\":%lld", (long long)last);
  else buf_str(&b, ",\"lastRequest\":null");
  if (g_teste_previous.known)
    buf_fmt(&b, ",\"previous\":{\"pid\":%ld,\"started\":%lld,\"last\":%lld}}", g_teste_previous.pid, (long long)g_teste_previous.started, (long long)g_teste_previous.last);
  else buf_str(&b, ",\"previous\":null}");
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_send(fd, 200, "application/json", b.data, b.size);
  free(b.data);
}

typedef struct { char* text; int seen; } TesteBody;
static int teste_body_field(JP* jp, const char* key, void* ctx) {
  TesteBody* t = ctx;
  if (strcmp(key, "texto")) return 0;
  t->seen = 1;
  return jp_text(jp, t->text, TESTE_TEXT_MAX) ? 1 : -1;
}
static void teste_enviar(int fd, Request* r, int so_gravar) {
  TesteBody t = {calloc(1, TESTE_TEXT_MAX), 0};
  if (!t.text) { monitor_json(fd, 500, "{\"error\":\"memory\"}"); return; }
  JP jp = {r->body ? r->body : "", r->body ? r->body + r->content_length : "", 0};
  const int parsed = r->body && jp_object(&jp, teste_body_field, &t);
  if (!parsed || !t.seen) { free(t.text); monitor_json(fd, 400, "{\"error\":\"texto\"}"); return; }
  int ok = !mkdir_p(g_diag_dir);
  if (ok) {
    chmod(g_diag_dir, 0700);
    char path[600];
    snprintf(path, sizeof path, "%.500s/teste-resultados.txt", g_diag_dir);
    ok = save_atomic(path, t.text, strlen(t.text), 0600);
  }
  free(t.text);
  if (!ok) { monitor_json(fd, 500, "{\"error\":\"not saved\"}"); return; }
  if (so_gravar) { monitor_json(fd, 200, "{\"ok\":true}"); return; } // glibren.65: a loja /app grava sozinha (sem log)
  logk_("teste: resultados da pagina /teste gravados para o diagnostico");
  diag_reply_start(fd, 0, "teste"); // "from" do info.json (ate 11 letras)
}

// Pagina do celular. 1 = tratou.
static int teste_monitor_route(int fd, Request* r) {
  const int get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST");
  if (get && (!strcmp(r->path, "/teste") || !strcmp(r->path, "/teste/"))) {
    monitor_send(fd, 200, "text/html; charset=utf-8", BG_TESTE_HTML, BG_TESTE_HTML_SIZE);
    return 1;
  }
  if (strncmp(r->path, "/api/teste", 10) || (r->path[10] && r->path[10] != '/')) return 0;
  diag_init();
  if (!monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return 1; }
  if (get && !strcmp(r->path, "/api/teste/estado")) teste_estado(fd);
  else if (get && !strcmp(r->path, "/api/teste/catalogo")) teste_catalogo(fd); // Fase 3: o catalogo no payload (bg_catalog_api.c)
  else if (post && !strcmp(r->path, "/api/teste/enviar")) teste_enviar(fd, r, 0);
  else if (post && !strcmp(r->path, "/api/teste/gravar")) teste_enviar(fd, r, 1); // glibren.65: so grava (loja /app)
  else monitor_json(fd, 404, "{\"error\":\"not found\"}");
  return 1;
}
