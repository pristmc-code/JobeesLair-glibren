// glibren.44: a area "Jobe" da pagina do celular (incluido em bg_downloader.c, depois de bg_diag.c): a versao
// instalada, a ultima publicada e o botao "Atualizar a Jobe", para o jogador nao depender do PC nem do controle.
// O payload NAO instala nada: so guarda o pedido ("update requested", <dir>/jobe-update.json, sobrevive a reiniciar o
// payload) e o estado que o app manda. O app (state/jobe-remote.js), que ja conversa com o payload, ve o pedido e roda
// o mesmo fluxo da atualizacao (state/update.js: procurar -> baixar -> reiniciar para aplicar), com as travas de
// sempre, e devolve o estado. Com a Jobe fechada a pagina diz "Abra a Jobe para concluir"; o pedido vale 24 h.
//
// Rotas da pagina do celular (34201, todas com a sessao do PIN; 401 {error:"pin"} sem ela):
//   GET  /api/jobe          {ok, installed, latest, checkedAt, phase, percent, error, detail, auto, appOpen,
//                            requested, requestedAt, at}
//   POST /api/jobe/update   pede a atualizacao: 200 = o mesmo do GET (requested: true)
// Rotas do app (34200, com o token):
//   GET  /jobe              {request: {id, at} | null}  o pedido ainda nao atendido
//   POST /jobe/state        {installed, latest, checkedAt, phase, percent, error, detail, auto, taken?}
//                           o estado do app; "taken" = id do pedido que o app assumiu (sai da fila) -> {ok}
//   GET  /focus             {ok, known, jobe, focus, at}: o foco do controle pelo kern.msgbuf (ver jobe_focus)
// phase (do app): idle | checking | current | downloading | ready | waiting | restarting | failed.

#define JOBE_REQUEST_TTL_S (24 * 3600)
#define JOBE_APP_SEEN_MS 30000 // sem noticia do app ha mais que isso: "Abra a Jobe para concluir"

static pthread_mutex_t g_jobe_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t g_jobe_once = PTHREAD_ONCE_INIT;
static struct {
  char request[24];          // id do pedido pendente ("" = nenhum)
  int64_t request_at;        // segundos (epoch)
  char installed[48], latest[48], phase[16], error[32], detail[240];
  int64_t checked_at, state_mono;
  int percent, autoinstall;
} g_jobe;

static void jobe_path(char* out, size_t cap) { snprintf(out, cap, "%.500s/jobe-update.json", g_dir); }
typedef struct { char id[24]; int64_t at; } JobeSaved;
static int jobe_saved_field(JP* jp, const char* key, void* ctx) {
  JobeSaved* s = ctx;
  if (!strcmp(key, "id")) return lib_text(jp, s->id, sizeof s->id) ? 1 : -1;
  if (!strcmp(key, "at")) return jp_int64(jp, &s->at) ? 1 : -1;
  return 0;
}
static void jobe_setup(void) {
  copy_text(g_jobe.phase, sizeof g_jobe.phase, "idle");
  char path[600];
  jobe_path(path, sizeof path);
  size_t size = 0;
  char* text = read_text(path, 4096, &size);
  if (!text) return;
  JobeSaved s;
  memset(&s, 0, sizeof s);
  JP jp = {text, text + size, 0};
  if (jp_object(&jp, jobe_saved_field, &s) && s.id[0] && strspn(s.id, "0123456789") == strlen(s.id) && now_s() - s.at < JOBE_REQUEST_TTL_S) {
    copy_text(g_jobe.request, sizeof g_jobe.request, s.id);
    g_jobe.request_at = s.at;
  }
  free(text);
}
static void jobe_init(void) { pthread_once(&g_jobe_once, jobe_setup); }
// Com g_jobe_lock.
static void jobe_save_locked(void) {
  char path[600];
  jobe_path(path, sizeof path);
  if (!g_jobe.request[0]) { unlink(path); return; }
  char text[96];
  const int n = snprintf(text, sizeof text, "{\"id\":\"%s\",\"at\":%lld}\n", g_jobe.request, (long long)g_jobe.request_at);
  if (!save_atomic(path, text, (size_t)n, 0600)) logf_("jobe: pedido de atualizacao nao gravado");
}
// Com g_jobe_lock: o pedido vencido (24 h) sai.
static void jobe_expire_locked(void) {
  if (g_jobe.request[0] && now_s() - g_jobe.request_at >= JOBE_REQUEST_TTL_S) {
    logk_("jobe: pedido de atualizacao %s venceu (24 h sem a Jobe abrir)", g_jobe.request);
    g_jobe.request[0] = 0;
    jobe_save_locked();
  }
}

static void jobe_status_json(Buf* b) {
  pthread_mutex_lock(&g_jobe_lock);
  jobe_expire_locked();
  const int app_open = g_jobe.state_mono && mono_ms() - g_jobe.state_mono < JOBE_APP_SEEN_MS && !app_away();
  buf_str(b, "{\"ok\":true,\"installed\":");
  buf_json(b, g_jobe.installed);
  buf_str(b, ",\"latest\":");
  buf_json(b, g_jobe.latest);
  buf_fmt(b, ",\"checkedAt\":%lld,\"phase\":", (long long)g_jobe.checked_at);
  buf_json(b, g_jobe.phase);
  buf_fmt(b, ",\"percent\":%d,\"error\":", g_jobe.percent);
  buf_json(b, g_jobe.error);
  buf_str(b, ",\"detail\":");
  buf_json(b, g_jobe.detail);
  buf_fmt(b, ",\"auto\":%s,\"appOpen\":%s,\"requested\":%s,\"requestedAt\":%lld,\"at\":%lld}", g_jobe.autoinstall ? "true" : "false",
          app_open ? "true" : "false", g_jobe.request[0] ? "true" : "false", (long long)(g_jobe.request[0] ? g_jobe.request_at : 0), (long long)now_s());
  pthread_mutex_unlock(&g_jobe_lock);
}
static void jobe_reply_status(int fd) {
  Buf b = {0};
  jobe_status_json(&b);
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_json(fd, 200, b.data);
  free(b.data);
}

// O estado que o app manda (POST /jobe/state).
typedef struct { char installed[48], latest[48], phase[16], error[32], detail[240], taken[24]; int64_t checked_at; uint64_t percent; int autoinstall, has_percent; } JobeState;
static int jobe_state_field(JP* jp, const char* key, void* ctx) {
  JobeState* s = ctx;
  if (!strcmp(key, "installed")) return lib_text(jp, s->installed, sizeof s->installed) ? 1 : -1;
  if (!strcmp(key, "latest")) return lib_text(jp, s->latest, sizeof s->latest) ? 1 : -1;
  if (!strcmp(key, "phase")) return lib_text(jp, s->phase, sizeof s->phase) ? 1 : -1;
  if (!strcmp(key, "error")) return lib_text(jp, s->error, sizeof s->error) ? 1 : -1;
  if (!strcmp(key, "detail")) return lib_text(jp, s->detail, sizeof s->detail) ? 1 : -1;
  if (!strcmp(key, "taken")) return lib_text(jp, s->taken, sizeof s->taken) ? 1 : -1;
  if (!strcmp(key, "checkedAt")) return jp_int64(jp, &s->checked_at) ? 1 : -1;
  if (!strcmp(key, "percent")) { s->has_percent = 1; return lib_uint(jp, &s->percent) ? 1 : -1; }
  if (!strcmp(key, "auto")) return jp_bool(jp, &s->autoinstall) ? 1 : -1;
  return 0;
}
static int jobe_version_ok(const char* text) {
  return strspn(text, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+-") == strlen(text);
}
static int jobe_phase_ok(const char* phase) {
  static const char* const PHASES[] = {"idle", "checking", "current", "downloading", "ready", "waiting", "restarting", "failed", NULL};
  for (int i = 0; PHASES[i]; ++i) if (!strcmp(phase, PHASES[i])) return 1;
  return 0;
}
static void jobe_take_state(int fd, Request* r) {
  JobeState s;
  memset(&s, 0, sizeof s);
  JP jp = {r->body ? r->body : "", r->body ? r->body + r->content_length : "", 0};
  if (!r->body || !jp_object(&jp, jobe_state_field, &s) || !jobe_version_ok(s.installed) || !jobe_version_ok(s.latest) || (s.phase[0] && !jobe_phase_ok(s.phase)) ||
      strspn(s.error, "abcdefghijklmnopqrstuvwxyz-") != strlen(s.error)) {
    respond_error(fd, 400, "expected {installed, latest, checkedAt, phase, percent, error, detail, auto, taken?}");
    return;
  }
  for (char* c = s.detail; *c; ++c) if ((unsigned char)*c < 0x20) *c = ' ';
  pthread_mutex_lock(&g_jobe_lock);
  copy_text(g_jobe.installed, sizeof g_jobe.installed, s.installed);
  copy_text(g_jobe.latest, sizeof g_jobe.latest, s.latest);
  copy_text(g_jobe.phase, sizeof g_jobe.phase, s.phase[0] ? s.phase : "idle");
  copy_text(g_jobe.error, sizeof g_jobe.error, s.error);
  copy_text(g_jobe.detail, sizeof g_jobe.detail, s.detail);
  g_jobe.checked_at = s.checked_at;
  g_jobe.percent = s.percent > 100 ? 100 : (int)s.percent;
  g_jobe.autoinstall = s.autoinstall;
  g_jobe.state_mono = mono_ms();
  if (s.taken[0] && !strcmp(s.taken, g_jobe.request)) {
    logk_("jobe: o app assumiu o pedido de atualizacao %s", g_jobe.request);
    g_jobe.request[0] = 0;
    jobe_save_locked();
  }
  pthread_mutex_unlock(&g_jobe_lock);
  respond(fd, 200, "{\"ok\":true}");
}

// Pagina do celular. 1 = tratou.
static int jobe_monitor_route(int fd, Request* r) {
  if (strncmp(r->path, "/api/jobe", 9) || (r->path[9] && r->path[9] != '/')) return 0;
  jobe_init();
  if (!session_ok(r->session)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return 1; }
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/jobe")) { jobe_reply_status(fd); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/jobe/update")) {
    pthread_mutex_lock(&g_jobe_lock);
    jobe_expire_locked();
    if (!g_jobe.request[0]) {
      snprintf(g_jobe.request, sizeof g_jobe.request, "%lld", (long long)(now_s() * 1000 + mono_ms() % 1000));
      g_jobe.request_at = now_s();
      jobe_save_locked();
      logk_("jobe: atualizacao pedida pela pagina do celular (pedido %s)", g_jobe.request);
    }
    pthread_mutex_unlock(&g_jobe_lock);
    jobe_reply_status(fd);
    return 1;
  }
  monitor_json(fd, 404, "{\"error\":\"not found\"}");
  return 1;
}

// GET /focus (API do app): quem tem o foco do controle agora, pela mesma leitura do kern.msgbuf do /switch (fg_read,
// a ultima SetControllerFocus). So leitura: nunca abre nem fecha nada. {ok, known, jobe, focus, at}: known = achou a
// linha; jobe = o foco e o appId da propria Jobe (BG_TITLE; null sem linha); focus = "0x..." ou null. "at" fica null:
// as linhas do msgbuf nao trazem uma hora confiavel.
static void jobe_focus(int fd) {
  Foreground f;
  char body[192];
  if (!fg_read(&f) || !f.signal) snprintf(body, sizeof body, "{\"ok\":true,\"known\":false,\"jobe\":null,\"focus\":null,\"at\":null}");
  else {
    const int64_t self = switch_app_id(BG_TITLE);
    snprintf(body, sizeof body, "{\"ok\":true,\"known\":true,\"jobe\":%s,\"focus\":\"0x%x\",\"at\":null}", self >= 0 && (uint32_t)self == f.focus ? "true" : "false", (unsigned)f.focus);
  }
  respond(fd, 200, body);
}

// API do app (o token ja foi conferido). 1 = tratou.
static int jobe_app_route(int fd, Request* r) {
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/focus")) { jobe_focus(fd); return 1; } // glibren.44: o foco do controle
  if (strcmp(r->path, "/jobe") && strcmp(r->path, "/jobe/state")) return 0;
  jobe_init();
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/jobe")) {
    char body[96];
    pthread_mutex_lock(&g_jobe_lock);
    jobe_expire_locked();
    if (g_jobe.request[0]) snprintf(body, sizeof body, "{\"request\":{\"id\":\"%s\",\"at\":%lld}}", g_jobe.request, (long long)g_jobe.request_at);
    else snprintf(body, sizeof body, "{\"request\":null}");
    pthread_mutex_unlock(&g_jobe_lock);
    respond(fd, 200, body);
    return 1;
  }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/jobe/state")) { jobe_take_state(fd, r); return 1; }
  respond_error(fd, 404, "not found");
  return 1;
}
