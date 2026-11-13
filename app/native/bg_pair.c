// Copyright (C) 2026 JVK3R and Jobee'sLair contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pareamento por aparelho da pagina do celular (porta 34201), no modelo da Orbit Store (backend/api.c) e do pareamento
// do glibren 0.9.16 (glibren-payload/src/pareamento.c). Incluido em bg_downloader.c (perto das sessoes do PIN).
//
// Fluxo: o aparelho pede um codigo (POST /api/pair/request {name}); o PS5 mostra um codigo de 6 digitos numa notificacao
// e na tela da Jobe, se ela estiver aberta (o app le GET /pair na API local); o aparelho manda o codigo
// (POST /api/pair/confirm {code, name}) e recebe um token SO DELE (64 hex), que fica no localStorage da pagina (ou da
// WebView do JobeControle) e vai em "X-Session: <token>" ou "Authorization: Bearer <token>". O payload guarda so o
// SHA-256 do token, com o nome do aparelho e a data, em <dir>/devices.json (0600). Remover um aparelho (na Jobe ou na
// pagina) invalida o token na hora.
//
// Regras: codigo e token comparados em tempo constante (todos os aparelhos sao percorridos); o codigo vale 2 min e
// aguenta 5 tentativas erradas (depois e descartado e os pedidos e tentativas ficam bloqueados por 30 s, 1, 2, 4... ate
// 15 min; o bloqueio e geral, nao por IP, porque o codigo e um so); um codigo novo no maximo a cada 10 s (nao enche a TV
// de notificacoes); o codigo nunca vai para o diario nem para a resposta da pagina. 127.0.0.1 (a Jobe e o navegador do
// proprio PS5) continua isento (Request.local). Ate PAIR_DEVICES aparelhos: o 17o tira o pareado ha mais tempo.
//
// Transicao do PIN unico: o PIN antigo (sessoes de 32 hex abertas por POST /api/unlock) continua valendo enquanto o
// jogador nao desligar ("pinOff" em devices.json; POST /api/pair/pin {on:false} na pagina, ou POST /pair/pin na API
// local). Desligar derruba as sessoes do PIN na hora; ligar de novo nao as traz de volta (o PIN as abre de novo).
//
// Rotas da pagina (porta 34201):
//   GET  /api/pair               {ok, paired, local, allowed, pinOn, pinSet, devices, retryIn} (livre: a pagina decide o
//                                que mostrar; "paired" = o token mandado e de um aparelho pareado)
//   POST /api/pair/request       {name} -> {ok, validFor} | 429 {error:"wait", retryIn} | 429 {error:"blocked", retryIn}
//   POST /api/pair/confirm       {code, name} -> {ok, token, id} | 403 {error:"wrong", left} | 429 {error:"blocked", retryIn}
//                                | 410 {error:"expired"} | 409 {error:"no-code"}
//   GET  /api/pair/devices       (aparelho pareado ou local) {ok, devices:[{id, name, at, self}], pinOn, pinSet}
//   POST /api/pair/remove        (aparelho pareado ou local) {id} -> {ok, self}
//   POST /api/pair/pin           (aparelho pareado ou local) {on} -> {ok, pinOn}
//
// Rotas protegidas da pagina (monitor_allowed: 127.0.0.1, aparelho pareado ou, com o PIN antigo ligado, a sessao dele;
// sem credencial = 401 {"error":"pin"}). Toda rota NOVA que mude algo ou mostre dado sensivel (configuracoes, chave do
// TorBox, Fases 7 e 8 do modelo Orbit) entra aqui com monitor_allowed (ou monitor_strong):
//   downloads: POST /api/jobs/<id>/pause|resume|cancel|connections, POST /api/cancelled/clear
//   configuracoes: POST /api/config (simultaneos, velocidade), POST /api/power (desligar/repouso)
//   pedidos: POST /api/library/add, POST /api/store/add
//   BACKUP e diario: POST /api/backup/delete|convert|convert-all, GET /api/log
//   diagnostico: GET /api/diag, POST /api/diag/key, /api/diag/key/remove (chave do GitHub), /api/diag/send, GET /api/diag/zip
//   Jobe: GET /api/jobe, POST /api/jobe/update (atualizar a Jobe)
//   payload (.49): GET /api/payload, POST /api/payload/update ("Procurar e atualizar"), /api/payload/revert ("Voltar ao
//   payload embutido")
//   testes da Fase 0: GET /api/teste/estado, POST /api/teste/enviar
//   a propria sessao: GET /api/session
//   so aparelho pareado ou 127.0.0.1 (monitor_strong; o PIN antigo nao): GET /api/pair/devices, POST /api/pair/remove|pin
// Livres (leitura simples, como antes): GET /, GET /teste (a pagina), GET /api/status, /api/library, /api/library/game,
// /api/store, /api/store/game, /api/backup (a lista), GET /api/pair, POST /api/pair/request|confirm, POST /api/unlock.
// A troca de app (POST /switch) nao existe na pagina: so na API local (127.0.0.1:34200).
//
// Rotas da API local (127.0.0.1:34200, com o token do app):
//   GET  /pair                   {ok, code, name, expiresIn, devices:[{id, name, at}], pinOn, pinSet} (o codigo so vai
//                                ao app, para a tela da Jobe; "" sem codigo valendo)
//   POST /pair/remove {id}, POST /pair/pin {on}

#define PAIR_DEVICES 16
#define PAIR_CODE_SECONDS 120
#define PAIR_CODE_TRIES 5
#define PAIR_REQUEST_GAP 10
#define PAIR_BLOCK_MIN 30
#define PAIR_BLOCK_MAX 900
#define PAIR_NAME 48

static int same_text(const char* a, const char* b, size_t size);
static void session_hash(const char* token, char out[65]);
static void monitor_json(int fd, int status, const char* body);
static void monitor_send(int fd, int status, const char* type, const void* body, size_t size);

typedef struct { char id[17], hash[65], name[PAIR_NAME + 1]; int64_t at; } PairDevice;
// Tudo com g_monitor_lock (a mesma trava das sessoes do PIN).
static PairDevice g_devices[PAIR_DEVICES];
static int g_device_count;
static int g_pair_pin_off;                 // 1 = o PIN antigo nao abre mais nada
static char g_pair_code[7];                // "" = nenhum codigo valendo
static char g_pair_for[PAIR_NAME + 1];     // o nome de quem pediu (para a tela da Jobe)
static int64_t g_pair_until, g_pair_last_ask, g_pair_blocked_until;
static int g_pair_errors, g_pair_level;

// O nome do aparelho: UTF-8 valido, sem controles nem < > " \ (vai para a tela da Jobe e para a notificacao), espacos
// juntos, ate PAIR_NAME bytes sem partir um caractere. Vazio vira "aparelho".
static void pair_clean_name(const char* in, char out[PAIR_NAME + 1]) {
  size_t k = 0;
  int space = 1;
  for (const unsigned char* p = (const unsigned char*)in; *p && k < PAIR_NAME;) {
    size_t n = *p < 0x80 ? 1 : (*p & 0xe0) == 0xc0 ? 2 : (*p & 0xf0) == 0xe0 ? 3 : (*p & 0xf8) == 0xf0 ? 4 : 0;
    int ok = n > 0;
    for (size_t i = 1; ok && i < n; ++i) ok = (p[i] & 0xc0) == 0x80;
    if (!ok) { ++p; continue; }
    if (n == 1) {
      const unsigned char c = *p;
      if (c < 0x20 || c == 0x7f || c == '<' || c == '>' || c == '"' || c == '\\' || c == '`') { ++p; continue; }
      if (c == ' ' || c == '\t') {
        if (!space && k < PAIR_NAME) { out[k++] = ' '; space = 1; }
        ++p;
        continue;
      }
    }
    if (k + n > PAIR_NAME) break;
    memcpy(out + k, p, n);
    k += n;
    p += n;
    space = 0;
  }
  while (k && out[k - 1] == ' ') --k;
  out[k] = 0;
  if (!k) snprintf(out, PAIR_NAME + 1, "aparelho");
}

// devices.json: {"pinOff": bool, "devices": [{"id", "hash": sha256(token), "name", "at": s}]}. Com g_monitor_lock.
static void pair_save_locked(void) {
  char path[600];
  snprintf(path, sizeof path, "%s/devices.json", g_dir);
  Buf b = {0};
  buf_fmt(&b, "{\"pinOff\":%s,\"devices\":[", g_pair_pin_off ? "true" : "false");
  for (int i = 0; i < g_device_count; ++i) {
    buf_fmt(&b, "%s{\"id\":\"%s\",\"hash\":\"%s\",\"name\":", i ? "," : "", g_devices[i].id, g_devices[i].hash);
    buf_json(&b, g_devices[i].name);
    buf_fmt(&b, ",\"at\":%lld}", (long long)g_devices[i].at);
  }
  buf_str(&b, "]}\n");
  if (b.failed || !b.data || !save_atomic(path, b.data, b.size, 0600)) logf_("devices.json nao gravado: %s", strerror(errno));
  free(b.data);
}

static int pair_id_ok(const char* id) {
  if (strlen(id) != 16) return 0;
  for (const char* p = id; *p; ++p) if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) return 0;
  return 1;
}
typedef struct { char name[256]; PairDevice d; } PairItem;
static int pair_item_field(JP* jp, const char* key, void* ctx) {
  PairItem* it = ctx;
  if (!strcmp(key, "id")) return jp_text(jp, it->d.id, sizeof it->d.id) ? 1 : -1;
  if (!strcmp(key, "hash")) return jp_text(jp, it->d.hash, sizeof it->d.hash) ? 1 : -1;
  if (!strcmp(key, "name")) return jp_text(jp, it->name, sizeof it->name) ? 1 : -1;
  if (!strcmp(key, "at")) {
    uint64_t v = 0;
    if (!jp_uint(jp, &v)) return -1;
    it->d.at = (int64_t)v;
    return 1;
  }
  return jp_skip(jp) ? 1 : -1;
}
static int pair_item(JP* jp, void* ctx) {
  (void)ctx;
  PairItem it;
  memset(&it, 0, sizeof it);
  if (!jp_object(jp, pair_item_field, &it)) return 0;
  if (g_device_count < PAIR_DEVICES && pair_id_ok(it.d.id) && is_hex64(it.d.hash)) {
    pair_clean_name(it.name, it.d.name);
    g_devices[g_device_count++] = it.d;
  }
  return 1;
}
static int pair_file_field(JP* jp, const char* key, void* ctx) {
  (void)ctx;
  if (!strcmp(key, "pinOff")) return jp_bool(jp, &g_pair_pin_off) ? 1 : -1;
  if (!strcmp(key, "devices")) return jp_array(jp, pair_item, NULL) ? 1 : -1;
  return jp_skip(jp) ? 1 : -1;
}
// Na subida (depois das sessoes do PIN). Arquivo estragado = nenhum aparelho e o PIN antigo ligado (como antes).
static void pair_load(void) {
  char path[600];
  snprintf(path, sizeof path, "%s/devices.json", g_dir);
  size_t size = 0;
  char* text = read_text(path, 64 * 1024, &size);
  pthread_mutex_lock(&g_monitor_lock);
  g_device_count = 0;
  g_pair_pin_off = 0;
  if (text) {
    JP jp = {text, text + size, 0};
    if (!jp_object(&jp, pair_file_field, NULL)) { g_device_count = 0; g_pair_pin_off = 0; logf_("devices.json estragado: ignorado"); }
    else logf_("pagina do celular: %d aparelho(s) pareado(s); PIN antigo %s", g_device_count, g_pair_pin_off ? "desligado" : "ligado");
  }
  pthread_mutex_unlock(&g_monitor_lock);
  free(text);
}

// O indice do aparelho deste token, ou -1. Percorre todos (o tempo nao depende de qual bateu). Com g_monitor_lock.
static int pair_find_locked(const char* token) {
  if (!is_hex64(token)) return -1;
  char hash[65];
  session_hash(token, hash);
  if (!hash[0]) return -1;
  int found = -1;
  for (int i = 0; i < g_device_count; ++i) {
    const int hit = same_text(g_devices[i].hash, hash, 64);
    found = hit && found < 0 ? i : found;
  }
  return found;
}
static int pair_device_ok(const char* token) {
  pthread_mutex_lock(&g_monitor_lock);
  const int ok = pair_find_locked(token) >= 0;
  pthread_mutex_unlock(&g_monitor_lock);
  return ok;
}
// O token de aparelho de um pedido: "X-Session" com 64 hex, ou "Authorization: Bearer" (o JobeControle pode usar).
static const char* pair_token_of(const Request* r) {
  if (strlen(r->session) == 64) return r->session;
  if (strlen(r->token) == 64) return r->token;
  return "";
}

// Quem pode usar uma rota protegida da pagina: o proprio PS5 (127.0.0.1), um aparelho pareado, ou (na transicao, com o
// PIN antigo ligado) uma sessao aberta pelo PIN. session_ok cuida das duas ultimas.
static int session_ok(const char* given);
static int monitor_allowed(const Request* r) {
  if (r->local) return 1;
  const char* device = pair_token_of(r);
  if (device[0] && pair_device_ok(device)) return 1;
  return session_ok(r->session);
}
// Gestao dos aparelhos e do PIN antigo: so o proprio PS5 ou um aparelho pareado (o PIN antigo, mais fraco, nao).
static int monitor_strong(const Request* r) {
  if (r->local) return 1;
  const char* device = pair_token_of(r);
  return device[0] && pair_device_ok(device);
}

// Bloqueio restante (s), ou 0. Com g_monitor_lock.
static int64_t pair_blocked_locked(int64_t now) { return g_pair_blocked_until > now ? g_pair_blocked_until - now : 0; }

static void pair_set_pin_off(int off) {
  pthread_mutex_lock(&g_monitor_lock);
  const int changed = g_pair_pin_off != (off ? 1 : 0);
  g_pair_pin_off = off ? 1 : 0;
  if (changed) pair_save_locked();
  pthread_mutex_unlock(&g_monitor_lock);
  if (!changed) return;
  if (off) {
    char pin_hash[65];
    pthread_mutex_lock(&g_lock);
    snprintf(pin_hash, sizeof pin_hash, "%s", g_pin_hash);
    pthread_mutex_unlock(&g_lock);
    monitor_clear_sessions(pin_hash, 1); // as sessoes do PIN caem na hora
  }
  logk_("pagina do celular: PIN antigo %s", off ? "desligado (so aparelhos pareados)" : "ligado de novo");
}

// 1 = removido. self: o aparelho removido e o do proprio pedido.
static int pair_remove(const char* id, const char* token, int* self) {
  if (!pair_id_ok(id)) return 0;
  char name[PAIR_NAME + 1] = "";
  pthread_mutex_lock(&g_monitor_lock);
  const int mine = token[0] ? pair_find_locked(token) : -1;
  int at = -1;
  for (int i = 0; i < g_device_count; ++i) if (!strcmp(g_devices[i].id, id)) at = i;
  if (at >= 0) {
    snprintf(name, sizeof name, "%s", g_devices[at].name);
    *self = mine == at;
    memmove(&g_devices[at], &g_devices[at + 1], sizeof g_devices[0] * (size_t)(g_device_count - at - 1));
    memset(&g_devices[--g_device_count], 0, sizeof g_devices[0]);
    pair_save_locked();
  }
  pthread_mutex_unlock(&g_monitor_lock);
  if (at >= 0) logk_("pagina do celular: aparelho \"%s\" removido", name);
  return at >= 0;
}

// A lista para a Jobe e para a pagina (sem o hash). self_token: marca o aparelho do pedido.
static void pair_devices_json(Buf* b, const char* self_token) {
  pthread_mutex_lock(&g_monitor_lock);
  const int mine = self_token && self_token[0] ? pair_find_locked(self_token) : -1;
  buf_str(b, "\"devices\":[");
  for (int i = g_device_count - 1; i >= 0; --i) { // o mais novo primeiro
    buf_fmt(b, "%s{\"id\":\"%s\",\"name\":", i == g_device_count - 1 ? "" : ",", g_devices[i].id);
    buf_json(b, g_devices[i].name);
    buf_fmt(b, ",\"at\":%lld%s}", (long long)g_devices[i].at, self_token ? (mine == i ? ",\"self\":true" : ",\"self\":false") : "");
  }
  buf_fmt(b, "],\"pinOn\":%s", g_pair_pin_off ? "false" : "true");
  pthread_mutex_unlock(&g_monitor_lock);
  pthread_mutex_lock(&g_lock);
  buf_fmt(b, ",\"pinSet\":%s", g_pin_hash[0] ? "true" : "false");
  pthread_mutex_unlock(&g_lock);
}

typedef struct { char name[256], code[16], id[24]; int on, has_on; } PairBody;
static int pair_body_field(JP* jp, const char* key, void* ctx) {
  PairBody* p = ctx;
  if (!strcmp(key, "name")) return jp_text(jp, p->name, sizeof p->name) ? 1 : -1;
  if (!strcmp(key, "code")) return jp_text(jp, p->code, sizeof p->code) ? 1 : -1;
  if (!strcmp(key, "id")) return jp_text(jp, p->id, sizeof p->id) ? 1 : -1;
  if (!strcmp(key, "on")) { p->has_on = 1; return jp_bool(jp, &p->on) ? 1 : -1; }
  return jp_skip(jp) ? 1 : -1;
}
static int pair_body(const Request* r, PairBody* p) {
  memset(p, 0, sizeof *p);
  if (!r->body || !r->content_length) return 1; // sem corpo: tudo vazio
  JP jp = {r->body, r->body + r->content_length, 0};
  return jp_object(&jp, pair_body_field, p);
}

// O aviso do codigo, no idioma do jogador ("pairText" com {code} e {name}); sem ele, em portugues.
static void pair_notify(const char* code, const char* name) {
  char model[240], text[400];
  pthread_mutex_lock(&g_lock);
  snprintf(model, sizeof model, "%s", g_pair_text[0] ? g_pair_text : "Jobe: codigo de pareamento {code} para \"{name}\" (vale 2 min)");
  pthread_mutex_unlock(&g_lock);
  char spaced[8];
  snprintf(spaced, sizeof spaced, "%.3s %.3s", code, code + 3);
  size_t k = 0;
  for (const char* p = model; *p && k + 1 < sizeof text;) {
    const char* put = NULL;
    if (!strncmp(p, "{code}", 6)) { put = spaced; p += 6; }
    else if (!strncmp(p, "{name}", 6)) { put = name; p += 6; }
    if (put) { for (; *put && k + 1 < sizeof text; ++put) text[k++] = *put; continue; }
    text[k++] = *p++;
  }
  text[k] = 0;
  // notify() poe o texto no diario; o codigo nao pode ir para la (o /api/log e de quem tem o PIN, nao do PS5 so).
#ifdef __PROSPERO__
  NotifyRequest request;
  memset(&request, 0, sizeof request);
  snprintf(request.message, sizeof request.message, "%s", text);
  sceKernelSendNotificationRequest(0, &request, sizeof request, 0);
#else
  const char* path = getenv("BGDL_NOTIFY_FILE");
  FILE* file = path ? fopen(path, "a") : NULL;
  if (file) { fprintf(file, "%s\n", text); fclose(file); }
#endif
}

static void pair_route_request(int fd, const Request* r) {
  PairBody p;
  if (!pair_body(r, &p)) { monitor_json(fd, 400, "{\"error\":\"body\"}"); return; }
  char name[PAIR_NAME + 1], body[96];
  pair_clean_name(p.name, name);
  const int64_t now = session_now();
  pthread_mutex_lock(&g_monitor_lock);
  int64_t wait = pair_blocked_locked(now);
  const char* why = wait ? "blocked" : "wait";
  if (!wait && g_pair_code[0] && g_pair_until > now && now - g_pair_last_ask < PAIR_REQUEST_GAP) wait = PAIR_REQUEST_GAP - (now - g_pair_last_ask);
  if (wait) {
    pthread_mutex_unlock(&g_monitor_lock);
    snprintf(body, sizeof body, "{\"error\":\"%s\",\"retryIn\":%lld}", why, (long long)wait);
    monitor_json(fd, 429, body);
    return;
  }
  uint32_t n;
  do random_bytes((unsigned char*)&n, sizeof n); while (n >= 4294000000u); // sem vies no % 1000000
  snprintf(g_pair_code, sizeof g_pair_code, "%06u", (unsigned)(n % 1000000u));
  snprintf(g_pair_for, sizeof g_pair_for, "%s", name);
  g_pair_until = now + PAIR_CODE_SECONDS;
  g_pair_last_ask = now;
  g_pair_errors = 0;
  char code[7];
  memcpy(code, g_pair_code, sizeof code);
  pthread_mutex_unlock(&g_monitor_lock);
  pair_notify(code, name); // so na tela do PS5 (nunca no diario nem na resposta)
  memset(code, 0, sizeof code);
  logk_("pagina do celular: codigo de pareamento pedido por \"%s\" (mostrado na TV)", name);
  snprintf(body, sizeof body, "{\"ok\":true,\"validFor\":%d}", PAIR_CODE_SECONDS);
  monitor_json(fd, 200, body);
}

// Mais uma falha seguida: codigo descartado e bloqueio crescente (30 s, 1, 2, 4... ate 15 min). Com g_monitor_lock.
static int64_t pair_block_locked(int64_t now) {
  int64_t s = PAIR_BLOCK_MIN;
  for (int i = 0; i < g_pair_level && s < PAIR_BLOCK_MAX; ++i) s *= 2;
  if (s > PAIR_BLOCK_MAX) s = PAIR_BLOCK_MAX;
  g_pair_blocked_until = now + s;
  ++g_pair_level;
  g_pair_code[0] = 0;
  g_pair_errors = 0;
  return s;
}

static void pair_route_confirm(int fd, const Request* r) {
  PairBody p;
  if (!pair_body(r, &p)) { monitor_json(fd, 400, "{\"error\":\"body\"}"); return; }
  char name[PAIR_NAME + 1], body[160];
  pair_clean_name(p.name, name);
  const int64_t now = session_now();
  pthread_mutex_lock(&g_monitor_lock);
  int64_t wait = pair_blocked_locked(now);
  if (wait) {
    pthread_mutex_unlock(&g_monitor_lock);
    memset(&p, 0, sizeof p);
    snprintf(body, sizeof body, "{\"error\":\"blocked\",\"retryIn\":%lld}", (long long)wait);
    monitor_json(fd, 429, body);
    return;
  }
  if (!g_pair_code[0]) { pthread_mutex_unlock(&g_monitor_lock); monitor_json(fd, 409, "{\"error\":\"no-code\"}"); return; }
  if (now > g_pair_until) {
    g_pair_code[0] = 0;
    pthread_mutex_unlock(&g_monitor_lock);
    monitor_json(fd, 410, "{\"error\":\"expired\"}");
    return;
  }
  // Sempre 6 posicoes (um codigo de outro tamanho tambem conta como erro), em tempo constante.
  char attempt[7] = "______";
  if (strlen(p.code) == 6) memcpy(attempt, p.code, 6);
  memset(&p.code, 0, sizeof p.code);
  if (!same_text(attempt, g_pair_code, 6)) {
    const int left = PAIR_CODE_TRIES - ++g_pair_errors;
    if (left <= 0) {
      const int64_t s = pair_block_locked(now);
      pthread_mutex_unlock(&g_monitor_lock);
      logk_("pagina do celular: %d codigos de pareamento errados; bloqueado por %lld s", PAIR_CODE_TRIES, (long long)s);
      snprintf(body, sizeof body, "{\"error\":\"blocked\",\"retryIn\":%lld}", (long long)s);
      monitor_json(fd, 429, body);
      return;
    }
    pthread_mutex_unlock(&g_monitor_lock);
    logf_("pagina do celular: codigo de pareamento errado (%d de %d)", PAIR_CODE_TRIES - left, PAIR_CODE_TRIES);
    snprintf(body, sizeof body, "{\"error\":\"wrong\",\"left\":%d}", left);
    monitor_json(fd, 403, body);
    return;
  }
  // Certo: um codigo, um aparelho.
  g_pair_code[0] = 0;
  g_pair_for[0] = 0;
  g_pair_errors = 0;
  g_pair_level = 0;
  unsigned char raw[32], rid[8];
  random_bytes(raw, sizeof raw);
  random_bytes(rid, sizeof rid);
  static const char digits[] = "0123456789abcdef";
  char token[65], id[17];
  for (int i = 0; i < 32; ++i) { token[2 * i] = digits[raw[i] >> 4]; token[2 * i + 1] = digits[raw[i] & 15]; }
  token[64] = 0;
  for (int i = 0; i < 8; ++i) { id[2 * i] = digits[rid[i] >> 4]; id[2 * i + 1] = digits[rid[i] & 15]; }
  id[16] = 0;
  memset(raw, 0, sizeof raw);
  if (g_device_count == PAIR_DEVICES) { // cheio: sai o pareado ha mais tempo
    memmove(&g_devices[0], &g_devices[1], sizeof g_devices[0] * (PAIR_DEVICES - 1));
    --g_device_count;
  }
  PairDevice* d = &g_devices[g_device_count++];
  memset(d, 0, sizeof *d);
  snprintf(d->id, sizeof d->id, "%s", id);
  session_hash(token, d->hash);
  snprintf(d->name, sizeof d->name, "%s", name);
  d->at = now;
  const int total = g_device_count;
  pair_save_locked();
  pthread_mutex_unlock(&g_monitor_lock);
  logk_("pagina do celular: aparelho \"%s\" pareado (%d no total)", name, total);
  char note[160];
  snprintf(note, sizeof note, "Jobe: \"%s\" pareado", name);
  notify(note);
  snprintf(body, sizeof body, "{\"ok\":true,\"token\":\"%s\",\"id\":\"%s\"}", token, id);
  memset(token, 0, sizeof token);
  monitor_json(fd, 200, body);
  memset(body, 0, sizeof body);
}

static void pair_reply(int fd, int status, Buf* b) {
  if (b->failed || !b->data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_send(fd, status, "application/json", b->data, b->size);
  free(b->data);
}

// /api/pair* na pagina do celular. 1 = era uma delas.
static int pair_monitor_route(int fd, const Request* r) {
  if (strncmp(r->path, "/api/pair", 9) || (r->path[9] && r->path[9] != '/')) return 0;
  const int get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST");
  const char* device = pair_token_of(r);
  if (get && !strcmp(r->path, "/api/pair")) {
    const int paired = device[0] && pair_device_ok(device);
    const int allowed = monitor_allowed(r);
    const int64_t now = session_now();
    Buf b = {0};
    pthread_mutex_lock(&g_monitor_lock);
    buf_fmt(&b, "{\"ok\":true,\"paired\":%s,\"local\":%s,\"allowed\":%s,\"devices\":%d,\"retryIn\":%lld,", paired ? "true" : "false",
            r->local ? "true" : "false", allowed ? "true" : "false", g_device_count, (long long)pair_blocked_locked(now));
    buf_fmt(&b, "\"pinOn\":%s", g_pair_pin_off ? "false" : "true");
    pthread_mutex_unlock(&g_monitor_lock);
    pthread_mutex_lock(&g_lock);
    buf_fmt(&b, ",\"pinSet\":%s}", g_pin_hash[0] ? "true" : "false");
    pthread_mutex_unlock(&g_lock);
    pair_reply(fd, 200, &b);
    return 1;
  }
  if (post && !strcmp(r->path, "/api/pair/request")) { pair_route_request(fd, r); return 1; }
  if (post && !strcmp(r->path, "/api/pair/confirm")) { pair_route_confirm(fd, r); return 1; }
  if (!monitor_strong(r)) { monitor_json(fd, 401, "{\"error\":\"pair\"}"); return 1; }
  if (get && !strcmp(r->path, "/api/pair/devices")) {
    Buf b = {0};
    buf_str(&b, "{\"ok\":true,");
    pair_devices_json(&b, device);
    buf_str(&b, "}");
    pair_reply(fd, 200, &b);
    return 1;
  }
  PairBody p;
  memset(&p, 0, sizeof p);
  if (post && !pair_body(r, &p)) { monitor_json(fd, 400, "{\"error\":\"body\"}"); return 1; }
  if (post && !strcmp(r->path, "/api/pair/remove")) {
    int self = 0;
    if (!pair_remove(p.id, device, &self)) { monitor_json(fd, 404, "{\"error\":\"no such device\"}"); return 1; }
    monitor_json(fd, 200, self ? "{\"ok\":true,\"self\":true}" : "{\"ok\":true,\"self\":false}");
    return 1;
  }
  if (post && !strcmp(r->path, "/api/pair/pin")) {
    if (!p.has_on) { monitor_json(fd, 400, "{\"error\":\"on\"}"); return 1; }
    pair_set_pin_off(!p.on);
    monitor_json(fd, 200, p.on ? "{\"ok\":true,\"pinOn\":true}" : "{\"ok\":true,\"pinOn\":false}");
    return 1;
  }
  monitor_json(fd, 404, "{\"error\":\"not found\"}");
  return 1;
}

// /pair* na API local (com o token do app). 1 = era uma delas.
static int pair_app_route(int fd, Request* r) {
  if (strncmp(r->path, "/pair", 5) || (r->path[5] && r->path[5] != '/')) return 0;
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/pair")) {
    const int64_t now = session_now();
    Buf b = {0};
    pthread_mutex_lock(&g_monitor_lock);
    if (g_pair_code[0] && now > g_pair_until) g_pair_code[0] = 0;
    buf_fmt(&b, "{\"ok\":true,\"code\":\"%s\",\"name\":", g_pair_code);
    buf_json(&b, g_pair_code[0] ? g_pair_for : "");
    buf_fmt(&b, ",\"expiresIn\":%lld,", (long long)(g_pair_code[0] ? g_pair_until - now : 0));
    pthread_mutex_unlock(&g_monitor_lock);
    pair_devices_json(&b, NULL);
    buf_str(&b, "}");
    if (b.failed || !b.data) respond_error(fd, 500, "out of memory");
    else respond(fd, 200, b.data);
    free(b.data);
    return 1;
  }
  if (strcmp(r->method, "POST")) { respond_error(fd, 404, "not found"); return 1; }
  PairBody p;
  if (!pair_body(r, &p)) { respond_error(fd, 400, "expected a JSON object"); return 1; }
  if (!strcmp(r->path, "/pair/remove")) {
    int self = 0;
    if (!pair_remove(p.id, "", &self)) { respond_error(fd, 404, "no such device"); return 1; }
    respond(fd, 200, "{\"ok\":true}");
    return 1;
  }
  if (!strcmp(r->path, "/pair/pin")) {
    if (!p.has_on) { respond_error(fd, 400, "expected {on}"); return 1; }
    pair_set_pin_off(!p.on);
    respond(fd, 200, p.on ? "{\"ok\":true,\"pinOn\":true}" : "{\"ok\":true,\"pinOn\":false}");
    return 1;
  }
  respond_error(fd, 404, "not found");
  return 1;
}
