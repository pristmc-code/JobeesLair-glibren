// Copyright (C) 2026 JVK3R and Jobee'sLair contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fase 7 do modelo Orbit (ps5/ESTUDO-jobe-como-payload.md): as configuracoes da Jobe ficam no payload, uma fonte so.
// O app (state/settings-sync.js) e a pagina do celular leem e gravam por aqui; o settings.json do app continua como a
// copia local (o app usa ela quando o payload nao responde ou e antigo, sem o campo "settings" no /health).
// Incluido em bg_downloader.c (depois de bg_diag.c: usa a chave do GitHub e a pasta do tube-service).
//
// Arquivo: <dir>/settings.json (0600), gravado com <dir>/settings.json.part + fsync + rename + fsync da pasta:
//   {"schema": 1, "rev": N, "store": "<32 hex>", "migratedFrom": "<caminho>", "values": {"<chave>": <valor>, ...}}
//   - "rev" sobe a cada mudanca (o app compara com o "settingsRev" do /health e so entao pede de novo);
//   - "store" e a identidade deste armazenamento (nasce com ele): o app que nunca falou com ESTE store manda o settings.json
//     dele inteiro (replace) em vez de adotar o daqui (ex.: um payload novo que rodou com um app antigo);
//   - um .part que sobrou de uma queda no meio da gravacao e descartado na leitura (o arquivo anterior fica valendo).
// Esquema (SETTINGS_SCHEMA) e migracao:
//   - sem o arquivo: o payload procura o settings.json antigo do app (settings_legacy_paths: o download0 do app, a pasta
//     dele em /data/ps5-react e a copia em /data/JobeesLair/saved; no PC, $BGDL_APP_SETTINGS) e importa chave a chave:
//     os segredos ficam de fora, um valor invalido sai (contado no diario), uma chave desconhecida fica (so o app ve);
//   - um arquivo sem "schema"/"values" (um settings.json do app posto aqui) e importado do mesmo jeito;
//   - schema menor: settings_upgrade() (a 1 e a primeira; os passos futuros entram la); schema maior (um payload novo que
//     foi trocado pelo embutido): as chaves sao lidas como estao e o arquivo volta a ser gravado no schema daqui.
// Classes de chave (SETTING_SPECS):
//   - SC_PREF: preferencia do jogador. Tipo e limites conferidos. A pagina le e grava; o app tambem.
//   - SC_INTERNAL: controle do app (o que ja viu, a ultima unidade...). So o app le e grava. Chave desconhecida = interna
//     (qualquer JSON de ate SETTINGS_VALUE_MAX bytes): um app mais novo que o payload nao perde nada.
//   - SC_SECRET: nunca entra aqui (o PIN do companion e a sessao dele, o sal+hash do PIN da pagina). O app nao manda; se
//     vierem, o payload recusa (400 "secret") ou, na migracao/replace, descarta.
// Segredos que o payload conhece por outros caminhos aparecem so como estado: {"set": true, "tail": "abcd"} (o fim so
// para chaves de 12+ caracteres) ou {"set": false}: torbox/alldebrid (debrid_key: memoria do POST /secret ou o
// debrid.json do app), github (a chave do diagnostico, bg_diag.c), youtube (tube/account.json existe; sem fim) e
// phonePin (o PIN da pagina; sem fim). Gravar um segredo continua nas rotas proprias (POST /secret do app,
// /api/diag/key da pagina, a conta do YouTube no app); aqui nunca.
//
// Rotas da API local (127.0.0.1:<porta>, com o token do app):
//   GET  /settings      {ok, schema, rev, store, migratedFrom, values: {todas as chaves guardadas}, secrets: {...}}
//   POST /settings      {set: {chave: valor}, unset: [chave], replace: bool} -> o mesmo do GET + changed/dropped.
//                       Normal: tudo ou nada (400 {error:"invalid"|"secret"|"key", key}). replace (a primeira conversa
//                       do app com este store): as chaves que nao vieram saem, e as invalidas/segredos sao descartadas
//                       ("dropped") em vez de recusar tudo.
// Rotas da pagina do celular (porta 34201), as duas com monitor_allowed (bg_pair.c; sem credencial = 401 {error:"pin"}):
//   GET  /api/settings  {ok, schema, rev, store, values: {so SC_PREF}, secrets: {...}} ("tail" so com monitor_strong)
//   POST /api/settings  {set, unset} so de chaves SC_PREF (400 {error:"readonly"|"unknown"|"secret"|"invalid", key});
//                       speedLimit, simultaneousDownloads, pauseOnCloseSeconds e convert* valem na hora tambem para os
//                       downloads e conversoes (como POST /api/config), mesmo com o app fechado.
// /health ganha "settings" (SETTINGS_SCHEMA), "settingsRev" e "settingsStore": e por eles que o app sabe que este
// payload guarda as configuracoes e quando ha mudanca.
//
// Testes no PC: BGDL_SETTINGS_CRASH=half (cai no meio do .part) ou =before-rename (cai com o .part completo, antes do
// rename) simulam a queda durante a gravacao (tests/bg-settings.test.mjs). Nao existe no build do PS5.

#define SETTINGS_SCHEMA 1
#define SETTINGS_MAX 128                 // chaves guardadas
#define SETTINGS_KEY_MAX 48              // [A-Za-z0-9_], 1..48
#define SETTINGS_VALUE_MAX 4096          // um valor (JSON) de chave interna/desconhecida
#define SETTINGS_OBJECT_MAX 2048         // um objeto de preferencia (linkFormats)
#define SETTINGS_FILE_MAX (192 * 1024)   // o arquivo inteiro

enum { ST_BOOL, ST_INT, ST_INTS, ST_TEXT, ST_TEXTS, ST_PATH, ST_LIST, ST_OBJECT, ST_ANY };
enum { SC_PREF, SC_INTERNAL, SC_SECRET };
enum { SRC_APP, SRC_WEB, SRC_DISK };
// min/max: ST_INT (limites), ST_TEXT (max = bytes), ST_LIST (max = itens). choices: ST_INTS/ST_TEXTS, separados por virgula.
typedef struct { const char* key; unsigned char type, cls; long long min, max; const char* choices; } SettingSpec;

// O inventario das chaves do settings.json do app (glibren.49), com quem le e grava cada uma: ESTUDO, Andamento da Fase 7.
static const SettingSpec SETTING_SPECS[] = {
  // Downloads (state/background-downloads.js, simultaneous-downloads.js, speed-limit.js, last-drive.js, ...)
  {"backgroundDownloads", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"pauseOnCloseSeconds", ST_INTS, SC_PREF, 0, 0, "0,5,10,15,20,25,30"},
  {"simultaneousDownloads", ST_INTS, SC_PREF, 0, 0, "1,2,3,4"},
  {"speedLimit", ST_INT, SC_PREF, 0, 1000, NULL},
  {"defaultDrive", ST_PATH, SC_PREF, 0, 0, NULL},
  {"autoContinueParts", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"convertExfat", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"convertPauseSeconds", ST_INTS, SC_PREF, 0, 0, "0,30,60,120,300"},
  {"convertWriteLimit", ST_INTS, SC_PREF, 0, 0, "0,25,50,100,200"},
  {"convertSyncMB", ST_INTS, SC_PREF, 0, 0, "0,64,128,256,512"},
  {"warnPs5Pkg", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"phoneMonitor", ST_BOOL, SC_PREF, 0, 0, NULL},
  // TorBox, loja e catalogos (state/debrid.js, orbit-feed.js, homebrew-store.js, store-mode.js, format-filter.js)
  {"torboxQuick", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"orbitFeed", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"homebrewDarkxex", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"storeMode", ST_TEXTS, SC_PREF, 0, 0, "full,torbox"},
  {"hiddenSources", ST_LIST, SC_PREF, 0, 64, NULL},
  {"linkFormats", ST_OBJECT, SC_PREF, 0, 0, NULL},
  // Aparencia, controle e idioma (i18n/index.js, screen-saver.js, power.js, ui/lightBar.js, ui/haptics.js, system-keyboard.js)
  {"language", ST_TEXTS, SC_PREF, 0, 0, "ar,bn,de,en,es,fr,hi,id,it,ja,pt-BR,ru,ur,zh-Hans"},
  {"screenSaver", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"energySaver", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"statusLight", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"vibration", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"typing", ST_TEXTS, SC_PREF, 0, 0, "system,keys"},
  // Atualizacoes e relatorios (state/update.js, bug-report.js)
  {"autoInstallUpdates", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"autoReports", ST_BOOL, SC_PREF, 0, 0, NULL},
  // Videos (state/tube-settings.js, auto-play-first.js)
  {"tubeSponsorBlock", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"tubeSubtitles", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"tubeAutoUpdate", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"tubeQuality", ST_INTS, SC_PREF, 0, 0, "1080,1440,2160"},
  {"tubeDownloadCap", ST_INT, SC_PREF, 0, 1000, NULL},
  {"autoPlayFirstVideo", ST_BOOL, SC_PREF, 0, 0, NULL},
  // Companion (companion/service.js): ligar/desligar sao preferencias; o PIN e a sessao, segredos.
  {"companion", ST_BOOL, SC_PREF, 0, 0, NULL},
  {"companionAway", ST_BOOL, SC_PREF, 0, 0, NULL},
  // Controle do app (so o app)
  {"whatsNewSeen", ST_TEXT, SC_INTERNAL, 0, 32, NULL},
  {"crashSeen", ST_TEXT, SC_INTERNAL, 0, 200, NULL},
  {"thanked", ST_BOOL, SC_INTERNAL, 0, 0, NULL},
  {"finished", ST_INT, SC_INTERNAL, 0, 1000000, NULL},
  {"lastDrive", ST_PATH, SC_INTERNAL, 0, 0, NULL},
  {"orbitTold", ST_TEXT, SC_INTERNAL, 0, 32, NULL},
  {"reportCode", ST_TEXT, SC_INTERNAL, 0, 16, NULL},
  {"keyboardOpen", ST_ANY, SC_INTERNAL, 0, 0, NULL},
  {"keyboardStopped", ST_ANY, SC_INTERNAL, 0, 0, NULL},
  // Segredos: nunca aqui
  {"companionPin", ST_ANY, SC_SECRET, 0, 0, NULL},
  {"companionSession", ST_ANY, SC_SECRET, 0, 0, NULL},
  {"companionCode", ST_ANY, SC_SECRET, 0, 0, NULL},
  {"phoneMonitorPin", ST_ANY, SC_SECRET, 0, 0, NULL},
};
#define SETTING_SPEC_COUNT ((int)(sizeof SETTING_SPECS / sizeof SETTING_SPECS[0]))

typedef struct { char key[SETTINGS_KEY_MAX + 1]; char* value; } Setting; // value: o JSON do valor
typedef struct { Setting items[SETTINGS_MAX]; int count; } SettingsSet;

static pthread_mutex_t g_settings_lock = PTHREAD_MUTEX_INITIALIZER;
static SettingsSet g_settings;
static uint64_t g_settings_rev;
static char g_settings_store[33];
static char g_settings_from[300];
static int g_settings_loaded;

// ---- Checagem das rotas da pagina -------------------------------------------------------------------------------
//
// As do pareamento por aparelho (bg_pair.c), sem criar outra: GET e POST /api/settings pedem monitor_allowed (127.0.0.1
// sem Origin de fora, aparelho pareado ou, na transicao, a sessao do PIN antigo); o fim dos segredos ("tail") so vai para
// quem passa em monitor_strong (aparelho pareado ou o proprio PS5). Gravar segredo nao existe aqui (rotas proprias).

// ---- Esquema ---------------------------------------------------------------------------------------------------

static const SettingSpec* setting_spec(const char* key) {
  for (int i = 0; i < SETTING_SPEC_COUNT; ++i) if (!strcmp(SETTING_SPECS[i].key, key)) return &SETTING_SPECS[i];
  return NULL;
}
static int setting_class(const char* key) {
  const SettingSpec* spec = setting_spec(key);
  return spec ? spec->cls : SC_INTERNAL;
}
static int settings_key_ok(const char* key) {
  const size_t n = strlen(key);
  return n >= 1 && n <= SETTINGS_KEY_MAX && strspn(key, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_") == n;
}
// `value` esta na lista "a,b,c" (texto exato).
static int setting_choice(const char* choices, const char* value) {
  const size_t n = strlen(value);
  for (const char* at = choices; *at;) {
    const char* comma = strchr(at, ',');
    const size_t length = comma ? (size_t)(comma - at) : strlen(at);
    if (length == n && !strncmp(at, value, n)) return 1;
    if (!comma) break;
    at = comma + 1;
  }
  return 0;
}
typedef struct { int count, max, ok; } ListCheck;
static int settings_list_item(JP* jp, void* ctx) {
  ListCheck* c = ctx;
  char text[1025];
  jp_ws(jp);
  if (!jp_string(jp, text, sizeof text) || !text[0]) { c->ok = 0; return 0; }
  return ++c->count <= c->max;
}
// O valor JSON em [start, end) (ja conferido como JSON por jp_skip) conferido pelo tipo da chave e escrito em `out` na
// forma canonica (logico/numero/texto refeitos; lista/objeto/qualquer copiados). 0 = invalido.
static int setting_canon(const SettingSpec* spec, const char* start, const char* end, Buf* out) {
  const int type = spec ? spec->type : ST_ANY;
  const size_t size = (size_t)(end - start);
  JP v = {start, end, 0};
  switch (type) {
    case ST_BOOL: {
      int on;
      if (jp_literal(&v, "true")) on = 1;
      else if (jp_literal(&v, "false")) on = 0;
      else return 0;
      jp_ws(&v);
      if (v.p != end) return 0;
      buf_str(out, on ? "true" : "false");
      return !out->failed;
    }
    case ST_INT:
    case ST_INTS: {
      double d;
      uint64_t u;
      int integer;
      if (!jp_number(&v, &d, &u, &integer) || !integer) return 0;
      jp_ws(&v);
      if (v.p != end) return 0;
      if (type == ST_INT && ((long long)u < spec->min || (long long)u > spec->max || u > 1000000000ull)) return 0;
      char text[24];
      snprintf(text, sizeof text, "%llu", (unsigned long long)u);
      if (type == ST_INTS && !setting_choice(spec->choices, text)) return 0;
      buf_str(out, text);
      return !out->failed;
    }
    case ST_TEXT:
    case ST_TEXTS:
    case ST_PATH: {
      char text[1024];
      if (!jp_string(&v, text, sizeof text)) return 0;
      jp_ws(&v);
      if (v.p != end) return 0;
      if (type == ST_TEXT && (long long)strlen(text) > spec->max) return 0;
      if (type == ST_TEXTS && !setting_choice(spec->choices, text)) return 0;
      if (type == ST_PATH && !safe_path(text)) return 0;
      buf_json(out, text);
      return !out->failed;
    }
    case ST_LIST: {
      ListCheck c = {0, (int)spec->max, 1};
      jp_ws(&v);
      if (v.p >= end || *v.p != '[' || size > 32 * 1024) return 0;
      if (!jp_array(&v, settings_list_item, &c) || !c.ok || c.count > c.max) return 0;
      jp_ws(&v);
      if (v.p != end) return 0;
      break;
    }
    case ST_OBJECT:
      jp_ws(&v);
      if (v.p >= end || *v.p != '{' || size > SETTINGS_OBJECT_MAX) return 0;
      break;
    default:
      if (!size || size > SETTINGS_VALUE_MAX) return 0;
      break;
  }
  buf_add(out, start, size);
  return !out->failed;
}

// ---- O conjunto de chaves ----------------------------------------------------------------------------------------

static int settings_find(const SettingsSet* s, const char* key) {
  for (int i = 0; i < s->count; ++i) if (!strcmp(s->items[i].key, key)) return i;
  return -1;
}
// Guarda `value` (passa a ser do conjunto). 0 = cheio.
static int settings_put(SettingsSet* s, const char* key, char* value) {
  const int at = settings_find(s, key);
  if (at >= 0) { free(s->items[at].value); s->items[at].value = value; return 1; }
  if (s->count >= SETTINGS_MAX) return 0;
  copy_text(s->items[s->count].key, sizeof s->items[s->count].key, key);
  s->items[s->count++].value = value;
  return 1;
}
static void settings_del(SettingsSet* s, const char* key) {
  const int at = settings_find(s, key);
  if (at < 0) return;
  free(s->items[at].value);
  s->items[at] = s->items[--s->count];
  memset(&s->items[s->count], 0, sizeof s->items[s->count]);
}
static void settings_clear(SettingsSet* s) {
  for (int i = 0; i < s->count; ++i) free(s->items[i].value);
  memset(s, 0, sizeof *s);
}
static int settings_copy(SettingsSet* to, const SettingsSet* from) {
  memset(to, 0, sizeof *to);
  for (int i = 0; i < from->count; ++i) {
    char* value = strdup(from->items[i].value);
    if (!value) { settings_clear(to); return 0; }
    copy_text(to->items[i].key, sizeof to->items[i].key, from->items[i].key);
    to->items[i].value = value;
    to->count = i + 1;
  }
  return 1;
}
static size_t settings_bytes(const SettingsSet* s) {
  size_t n = 64;
  for (int i = 0; i < s->count; ++i) n += strlen(s->items[i].key) + strlen(s->items[i].value) + 4;
  return n;
}

// ---- Corpo de um pedido (e o arquivo) ----------------------------------------------------------------------------

typedef struct { char key[SETTINGS_KEY_MAX + 1]; char* value; } SettingChange; // value NULL = tirar a chave
typedef struct {
  int source, lenient, replace, found;
  SettingChange changes[SETTINGS_MAX];
  int count;
  char dropped[SETTINGS_MAX][SETTINGS_KEY_MAX + 1];
  int dropped_count, secrets_skipped, invalid_skipped;
  char error[16], error_key[SETTINGS_KEY_MAX + 1];
  // so do arquivo
  uint64_t schema, rev;
  int has_schema, has_values;
  char store[40], from[300];
} SettingsBody;

static void settings_body_free(SettingsBody* b) {
  for (int i = 0; i < b->count; ++i) free(b->changes[i].value);
  b->count = 0;
}
static int settings_fail(SettingsBody* b, const char* error, const char* key) {
  snprintf(b->error, sizeof b->error, "%s", error);
  snprintf(b->error_key, sizeof b->error_key, "%s", key);
  return -1;
}
static void settings_drop(SettingsBody* b, const char* key) {
  for (int i = 0; i < b->dropped_count; ++i) if (!strcmp(b->dropped[i], key)) return;
  if (b->dropped_count < SETTINGS_MAX) copy_text(b->dropped[b->dropped_count++], sizeof b->dropped[0], key);
}
static int settings_change(SettingsBody* b, const char* key, char* value) {
  for (int i = 0; i < b->count; ++i) {
    if (strcmp(b->changes[i].key, key)) continue;
    free(b->changes[i].value);
    b->changes[i].value = value;
    return 1;
  }
  if (b->count >= SETTINGS_MAX) { free(value); return settings_fail(b, "full", key); }
  copy_text(b->changes[b->count].key, sizeof b->changes[0].key, key);
  b->changes[b->count++].value = value;
  return 1;
}
// Uma chave de "set" (ou de "values" no arquivo, ou do settings.json antigo do app).
static int settings_entry(JP* jp, const char* key, void* ctx) {
  SettingsBody* b = ctx;
  b->found = 1;
  if (!settings_key_ok(key)) {
    if (!b->lenient) return settings_fail(b, "key", key);
    settings_drop(b, key);
    return jp_skip(jp) ? 1 : -1;
  }
  const SettingSpec* spec = setting_spec(key);
  const int cls = spec ? spec->cls : SC_INTERNAL;
  if (cls == SC_SECRET) {
    if (!b->lenient) return settings_fail(b, "secret", key);
    ++b->secrets_skipped;
    return jp_skip(jp) ? 1 : -1;
  }
  if (b->source == SRC_WEB && cls != SC_PREF) return settings_fail(b, spec ? "readonly" : "unknown", key);
  jp_ws(jp);
  const char* start = jp->p;
  if (!jp_skip(jp)) return -1;
  Buf value = {0};
  if (!setting_canon(spec, start, jp->p, &value) || !value.data) {
    free(value.data);
    if (!b->lenient) return settings_fail(b, "invalid", key);
    ++b->invalid_skipped;
    settings_drop(b, key);
    return 1;
  }
  return settings_change(b, key, value.data);
}
static int settings_unset_item(JP* jp, void* ctx) {
  SettingsBody* b = ctx;
  char key[64];
  if (!jp_string(jp, key, sizeof key)) return 0;
  b->found = 1;
  if (!settings_key_ok(key)) { settings_fail(b, "key", key); return 0; }
  const int cls = setting_class(key);
  if (cls == SC_SECRET) return 1; // nunca guardado: tirar nao muda nada
  if (b->source == SRC_WEB && cls != SC_PREF) { settings_fail(b, setting_spec(key) ? "readonly" : "unknown", key); return 0; }
  return settings_change(b, key, NULL) > 0;
}
static int settings_body_field(JP* jp, const char* key, void* ctx) {
  SettingsBody* b = ctx;
  if (!strcmp(key, "set")) {
    jp_ws(jp);
    if (jp->p >= jp->end || *jp->p != '{') return settings_fail(b, "set", "");
    return jp_object(jp, settings_entry, b) ? 1 : -1;
  }
  if (!strcmp(key, "unset")) {
    jp_ws(jp);
    if (jp->p >= jp->end || *jp->p != '[') return settings_fail(b, "unset", "");
    return jp_array(jp, settings_unset_item, b) ? 1 : -1;
  }
  if (!strcmp(key, "replace")) {
    if (b->source == SRC_WEB) return settings_fail(b, "replace", "");
    int on = 0;
    if (!jp_bool(jp, &on)) return -1;
    b->replace = on;
    b->lenient = on;
    return 1;
  }
  return jp_skip(jp) ? 1 : -1; // campos a mais (ex.: "baseRev" de um app mais novo) sao ignorados
}
static int settings_file_field(JP* jp, const char* key, void* ctx) {
  SettingsBody* b = ctx;
  if (!strcmp(key, "schema")) { b->has_schema = 1; return jp_uint(jp, &b->schema) ? 1 : -1; }
  if (!strcmp(key, "rev")) return jp_uint(jp, &b->rev) ? 1 : -1;
  if (!strcmp(key, "store")) return jp_text(jp, b->store, sizeof b->store) ? 1 : -1;
  if (!strcmp(key, "migratedFrom")) return jp_text(jp, b->from, sizeof b->from) ? 1 : -1;
  if (!strcmp(key, "values")) {
    b->has_values = 1;
    jp_ws(jp);
    if (jp->p >= jp->end || *jp->p != '{') return -1;
    return jp_object(jp, settings_entry, b) ? 1 : -1;
  }
  return jp_skip(jp) ? 1 : -1;
}

// ---- Arquivo -----------------------------------------------------------------------------------------------------

static void settings_path(char* out, size_t cap) { snprintf(out, cap, "%.500s/settings.json", g_dir); }
static void settings_new_store(char out[33]) {
  unsigned char bytes[16];
  int fd = open("/dev/urandom", O_RDONLY);
  int ok = fd >= 0 && read(fd, bytes, sizeof bytes) == (ssize_t)sizeof bytes;
  if (fd >= 0) close(fd);
  if (!ok) {
    const uint64_t seed = (uint64_t)mono_ms() ^ ((uint64_t)getpid() << 32) ^ (uint64_t)time(NULL);
    for (int i = 0; i < 16; ++i) bytes[i] = (unsigned char)(seed >> ((i % 8) * 8)) ^ (unsigned char)(i * 37);
  }
  static const char digits[] = "0123456789abcdef";
  for (int i = 0; i < 16; ++i) { out[2 * i] = digits[bytes[i] >> 4]; out[2 * i + 1] = digits[bytes[i] & 15]; }
  out[32] = 0;
}
// .part + fsync + rename + fsync da pasta. No PC, BGDL_SETTINGS_CRASH simula a queda no meio (so para os testes).
static int settings_write_file(const char* path, const char* text, size_t size) {
  char part[700];
  snprintf(part, sizeof part, "%s.part", path);
  int fd = open(part, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return 0;
#ifndef __PROSPERO__
  const char* crash = getenv("BGDL_SETTINGS_CRASH");
  if (crash && !strcmp(crash, "half")) {
    write_all(fd, text, size / 2, 0);
    fsync(fd);
    _exit(86);
  }
#endif
  int ok = write_all(fd, text, size, 0) && fsync(fd) == 0;
  if (close(fd)) ok = 0;
#ifndef __PROSPERO__
  if (ok && crash && !strcmp(crash, "before-rename")) _exit(86);
#endif
  if (ok) ok = rename(part, path) == 0 && sync_parent(path);
  if (!ok) unlink(part);
  return ok;
}
static void settings_values_json(Buf* b, const SettingsSet* s, int prefs_only) {
  buf_str(b, "{");
  int first = 1;
  for (int i = 0; i < s->count; ++i) {
    if (prefs_only && setting_class(s->items[i].key) != SC_PREF) continue;
    if (!first) buf_str(b, ",");
    first = 0;
    buf_json(b, s->items[i].key);
    buf_str(b, ":");
    buf_str(b, s->items[i].value);
  }
  buf_str(b, "}");
}
static int settings_save(const SettingsSet* s, uint64_t rev, const char* store, const char* from) {
  char path[600];
  settings_path(path, sizeof path);
  Buf b = {0};
  buf_fmt(&b, "{\"schema\":%d,\"rev\":%llu,\"store\":", SETTINGS_SCHEMA, (unsigned long long)rev);
  buf_json(&b, store);
  buf_str(&b, ",\"migratedFrom\":");
  buf_json(&b, from);
  buf_str(&b, ",\"values\":");
  settings_values_json(&b, s, 0);
  buf_str(&b, "}\n");
  const int ok = !b.failed && b.data && b.size <= SETTINGS_FILE_MAX && settings_write_file(path, b.data, b.size);
  if (!ok) logf_("configuracoes: settings.json nao gravado: %s", b.failed ? "sem memoria" : b.size > SETTINGS_FILE_MAX ? "grande demais" : strerror(errno));
  free(b.data);
  return ok;
}
// Le um objeto de chaves (lenient) para `set`. 1 = era um objeto valido.
static int settings_read_values(const char* text, size_t size, int file_format, SettingsBody* b) {
  memset(b, 0, sizeof *b);
  b->source = SRC_DISK;
  b->lenient = 1;
  JP jp = {text, text + size, 0};
  return jp_object(&jp, file_format ? settings_file_field : settings_entry, b);
}
static void settings_take(SettingsBody* b, SettingsSet* to) {
  settings_clear(to);
  for (int i = 0; i < b->count; ++i) {
    if (!b->changes[i].value) continue;
    if (!settings_put(to, b->changes[i].key, b->changes[i].value)) { free(b->changes[i].value); continue; }
  }
  b->count = 0;
}
// Os passos de uma versao do esquema para a seguinte (a 1 e a primeira: nada ainda). Devolve 1 se mudou algo.
static int settings_upgrade(SettingsSet* s, uint64_t from) {
  (void)s;
  (void)from;
  return 0;
}
static int settings_legacy_paths(char paths[][300], int max) {
  int n = 0;
#ifdef __PROSPERO__
  for (int i = 0; i < 4 && n < max; ++i) snprintf(paths[n++], 300, "/mnt/sandbox/%s_%03d/download0/JobeesLair/settings.json", BG_TITLE, i);
  if (n < max) snprintf(paths[n++], 300, "/data/ps5-react/%s/JobeesLair/settings.json", BG_TITLE);
  if (n < max) snprintf(paths[n++], 300, "/data/JobeesLair/saved/settings.json");
#else
  const char* path = getenv("BGDL_APP_SETTINGS");
  if (path && *path && n < max) snprintf(paths[n++], 300, "%s", path);
#endif
  return n;
}
// O settings.json antigo do app, chave a chave. 1 = achou e importou.
static int settings_migrate_legacy_locked(void) {
  char paths[8][300];
  const int count = settings_legacy_paths(paths, 8);
  for (int i = 0; i < count; ++i) {
    size_t size = 0;
    char* text = read_text(paths[i], SETTINGS_FILE_MAX, &size);
    if (!text) continue;
    SettingsBody* b = calloc(1, sizeof *b);
    const int ok = b && settings_read_values(text, size, 0, b);
    free(text);
    if (!ok) {
      if (b) settings_body_free(b);
      free(b);
      logf_("configuracoes: %s nao e um objeto JSON; ignorado", paths[i]);
      continue;
    }
    SettingsSet* set = calloc(1, sizeof *set);
    if (!set) { settings_body_free(b); free(b); return 0; }
    settings_take(b, set);
    char store[33];
    settings_new_store(store);
    if (!settings_save(set, 1, store, paths[i])) { settings_clear(set); free(set); settings_body_free(b); free(b); return 0; }
    settings_clear(&g_settings);
    g_settings = *set;
    free(set);
    g_settings_rev = 1;
    copy_text(g_settings_store, sizeof g_settings_store, store);
    copy_text(g_settings_from, sizeof g_settings_from, paths[i]);
    logk_("configuracoes migradas de %s: %d chave(s); %d segredo(s) ficaram no app; %d invalida(s) descartada(s)", paths[i],
          g_settings.count, b->secrets_skipped, b->invalid_skipped);
    free(b);
    return 1;
  }
  return 0;
}
static void settings_load_locked(void) {
  if (g_settings_loaded) return;
  g_settings_loaded = 1;
  char path[600], part[700];
  settings_path(path, sizeof path);
  snprintf(part, sizeof part, "%s.part", path);
  if (!access(part, F_OK)) {
    unlink(part);
    logk_("configuracoes: gravacao interrompida descartada (settings.json.part); vale o settings.json anterior");
  }
  size_t size = 0;
  char* text = read_text(path, SETTINGS_FILE_MAX, &size);
  if (text) {
    SettingsBody* b = calloc(1, sizeof *b);
    int ok = b && settings_read_values(text, size, 1, b);
    if (ok && !b->has_schema && !b->has_values) {
      // Um settings.json do app posto aqui (sem o envelope): importado como o antigo.
      settings_body_free(b);
      ok = settings_read_values(text, size, 0, b);
      if (ok) { b->schema = 0; b->rev = 1; b->from[0] = 0; copy_text(b->from, sizeof b->from, "settings.json (formato do app)"); }
    }
    free(text);
    if (!ok) {
      if (b) settings_body_free(b);
      free(b);
      char aside[700];
      snprintf(aside, sizeof aside, "%s.unreadable-%lld", path, (long long)time(NULL));
      rename(path, aside);
      logk_("configuracoes: settings.json ilegivel; guardado como %s", aside);
    } else {
      SettingsSet* set = calloc(1, sizeof *set);
      if (set) {
        settings_take(b, set);
        settings_clear(&g_settings);
        g_settings = *set;
        free(set);
      }
      g_settings_rev = b->rev ? b->rev : 1;
      if (strlen(b->store) == 32 && strspn(b->store, "0123456789abcdef") == 32) copy_text(g_settings_store, sizeof g_settings_store, b->store);
      else settings_new_store(g_settings_store);
      copy_text(g_settings_from, sizeof g_settings_from, b->from);
      int save = !b->has_values || b->schema != SETTINGS_SCHEMA || b->invalid_skipped || b->secrets_skipped;
      if (b->has_values && b->schema < SETTINGS_SCHEMA) save |= settings_upgrade(&g_settings, b->schema);
      if (b->schema > SETTINGS_SCHEMA) logk_("configuracoes: esquema %llu e mais novo que o deste payload (%d); chaves mantidas como estao",
                                             (unsigned long long)b->schema, SETTINGS_SCHEMA);
      if (b->invalid_skipped || b->secrets_skipped)
        logk_("configuracoes: %d valor(es) invalido(s) e %d segredo(s) tirados do settings.json", b->invalid_skipped, b->secrets_skipped);
      if (save && settings_save(&g_settings, g_settings_rev, g_settings_store, g_settings_from)) logf_("configuracoes: settings.json regravado no esquema %d", SETTINGS_SCHEMA);
      free(b);
      return;
    }
  }
  if (!settings_migrate_legacy_locked()) {
    settings_clear(&g_settings);
    g_settings_rev = 0;
    g_settings_store[0] = 0; // nasce na primeira gravacao (o app manda o settings.json dele)
    g_settings_from[0] = 0;
  }
}

// ---- Respostas ---------------------------------------------------------------------------------------------------

static void settings_secret(Buf* b, const char* name, int set, const char* value, int tails, int* first) {
  if (!*first) buf_str(b, ",");
  *first = 0;
  buf_json(b, name);
  if (!set) { buf_str(b, ":{\"set\":false}"); return; }
  buf_str(b, ":{\"set\":true");
  const size_t n = value ? strlen(value) : 0;
  if (tails && n >= 12) {
    buf_str(b, ",\"tail\":");
    buf_json(b, value + n - 4);
  }
  buf_str(b, "}");
}
// O estado dos segredos que o payload conhece (nunca o valor). Sem trava (cada fonte tem a sua).
static void settings_secrets_json(Buf* b, int tails) {
  char key[256];
  int first = 1, set;
  buf_str(b, "\"secrets\":{");
  set = debrid_key("torbox", key, sizeof key);
  settings_secret(b, "torbox", set, key, tails, &first);
  memset(key, 0, sizeof key);
  set = debrid_key("alldebrid", key, sizeof key);
  settings_secret(b, "alldebrid", set, key, tails, &first);
  memset(key, 0, sizeof key);
  diag_init();
  set = diag_read_key(key, sizeof key);
  settings_secret(b, "github", set, key, tails, &first);
  memset(key, 0, sizeof key);
  char path[600];
  struct stat st;
  snprintf(path, sizeof path, "%.500s/account.json", g_tube_dir);
  settings_secret(b, "youtube", !stat(path, &st) && st.st_size > 2, NULL, tails, &first);
  pthread_mutex_lock(&g_lock);
  set = g_pin_hash[0] != 0;
  pthread_mutex_unlock(&g_lock);
  settings_secret(b, "phonePin", set, NULL, tails, &first);
  buf_str(b, "}");
}
// O corpo de GET (e da resposta do POST): `app` = tudo; senao so as preferencias.
static void settings_reply_json(Buf* b, int app, int tails, const SettingsBody* done, const char changed[][SETTINGS_KEY_MAX + 1], int changed_count) {
  pthread_mutex_lock(&g_settings_lock);
  settings_load_locked();
  buf_fmt(b, "{\"ok\":true,\"schema\":%d,\"rev\":%llu,\"store\":", SETTINGS_SCHEMA, (unsigned long long)g_settings_rev);
  buf_json(b, g_settings_store);
  if (app) {
    buf_str(b, ",\"migratedFrom\":");
    buf_json(b, g_settings_from);
  }
  buf_str(b, ",\"values\":");
  settings_values_json(b, &g_settings, !app);
  pthread_mutex_unlock(&g_settings_lock);
  if (done) {
    buf_str(b, ",\"changed\":[");
    for (int i = 0; i < changed_count; ++i) { if (i) buf_str(b, ","); buf_json(b, changed[i]); }
    buf_str(b, "],\"dropped\":[");
    for (int i = 0; i < done->dropped_count; ++i) { if (i) buf_str(b, ","); buf_json(b, done->dropped[i]); }
    buf_str(b, "]");
  }
  buf_str(b, ",");
  settings_secrets_json(b, tails);
  buf_str(b, "}");
}

// ---- Gravar ------------------------------------------------------------------------------------------------------

// Na pagina: as chaves que tambem mandam nos downloads e conversoes valem na hora (como POST /api/config, marcadas
// como do celular; o app adota pelo /health e pelas configuracoes).
static void settings_mirror_config(const SettingsSet* s, const char changed[][SETTINGS_KEY_MAX + 1], int count) {
  ConfigBody c;
  memset(&c, 0, sizeof c);
  int concurrency = -1, speed = -1;
  for (int i = 0; i < count; ++i) {
    const int at = settings_find(s, changed[i]);
    const long long value = at >= 0 ? strtoll(s->items[at].value, NULL, 10) : -1;
    if (!strcmp(changed[i], "simultaneousDownloads")) concurrency = value >= 1 ? (int)value : 1;
    else if (!strcmp(changed[i], "speedLimit")) speed = value >= 0 ? (int)value : 0;
    else if (!strcmp(changed[i], "pauseOnCloseSeconds")) { c.found = c.has_pause = 1; c.pause_seconds = value >= 0 ? (uint64_t)value : 30; }
    else if (!strcmp(changed[i], "convertPauseSeconds")) { c.found = c.has_conv_pause = 1; c.conv_pause = value >= 0 ? (uint64_t)value : 0; }
    else if (!strcmp(changed[i], "convertWriteLimit")) { c.found = c.has_conv_write = 1; c.conv_write = value >= 0 ? (uint64_t)value : 0; }
    else if (!strcmp(changed[i], "convertSyncMB")) { c.found = c.has_conv_sync = 1; c.conv_sync = value >= 0 ? (uint64_t)value : 0; }
  }
  if (concurrency < 0 && speed < 0 && !c.found) return;
  pthread_mutex_lock(&g_lock);
  int changed_config = c.found && config_valid(&c) && config_apply_locked(&c);
  if (concurrency > 0 && concurrency <= MAX_WORKERS && (g_max_running != concurrency || !g_concurrency_remote)) {
    logf_("celular (configuracoes): downloads simultaneos %d -> %d", g_max_running, concurrency);
    g_max_running = concurrency;
    g_concurrency_remote = 1;
    ++g_concurrency_stamp;
    changed_config = 1;
  }
  if (speed >= 0 && speed <= MAX_SPEED_LIMIT && (g_speed_limit != speed || !g_speed_remote)) {
    logf_("celular (configuracoes): limite de velocidade %d -> %d MB/s (0 = sem limite)", g_speed_limit, speed);
    g_speed_limit = speed;
    g_speed_remote = 1;
    ++g_speed_stamp;
    rate_set(g_speed_limit);
    changed_config = 1;
  }
  if (changed_config) save_config_locked();
  pthread_cond_broadcast(&g_wake_downloader);
  pthread_mutex_unlock(&g_lock);
}
// POST de /settings (app) ou /api/settings (pagina). Devolve o status HTTP e o corpo em `out`.
static int settings_post(const Request* r, int source, int tails, Buf* out) {
  SettingsBody* b = calloc(1, sizeof *b);
  if (!b) { buf_str(out, "{\"error\":\"out of memory\"}"); return 500; }
  b->source = source;
  JP jp = {r->body ? r->body : "", r->body ? r->body + r->content_length : "", 0};
  if (!jp_object(&jp, settings_body_field, b) || (!b->found && !b->replace)) {
    buf_str(out, "{\"error\":");
    buf_json(out, b->error[0] ? b->error : b->found ? "json" : "empty");
    buf_str(out, ",\"key\":");
    buf_json(out, b->error_key);
    buf_str(out, "}");
    settings_body_free(b);
    free(b);
    return 400;
  }
  static char changed[SETTINGS_MAX * 2][SETTINGS_KEY_MAX + 1];
  static pthread_mutex_t changed_lock = PTHREAD_MUTEX_INITIALIZER; // `changed` e grande: um POST por vez
  pthread_mutex_lock(&changed_lock);
  int changed_count = 0, status = 200;
  SettingsSet* next = calloc(1, sizeof *next);
  pthread_mutex_lock(&g_settings_lock);
  settings_load_locked();
  if (!next || (!b->replace && !settings_copy(next, &g_settings))) {
    status = 500;
  } else {
    for (int i = 0; i < b->count && status == 200; ++i) {
      if (!b->changes[i].value) { settings_del(next, b->changes[i].key); continue; }
      if (!settings_put(next, b->changes[i].key, b->changes[i].value)) status = 413;
      else b->changes[i].value = NULL;
    }
    if (status == 200 && settings_bytes(next) > SETTINGS_FILE_MAX - 1024) status = 413;
    if (status == 200) {
      for (int i = 0; i < next->count; ++i) {
        const int at = settings_find(&g_settings, next->items[i].key);
        if (at < 0 || strcmp(g_settings.items[at].value, next->items[i].value)) copy_text(changed[changed_count++], sizeof changed[0], next->items[i].key);
      }
      for (int i = 0; i < g_settings.count; ++i)
        if (settings_find(next, g_settings.items[i].key) < 0) copy_text(changed[changed_count++], sizeof changed[0], g_settings.items[i].key);
      if (changed_count || !g_settings_store[0]) {
        char store[33];
        copy_text(store, sizeof store, g_settings_store);
        if (!store[0]) settings_new_store(store);
        if (settings_save(next, g_settings_rev + 1, store, g_settings_from)) {
          settings_clear(&g_settings);
          g_settings = *next;
          memset(next, 0, sizeof *next);
          ++g_settings_rev;
          copy_text(g_settings_store, sizeof g_settings_store, store);
        } else {
          status = 500;
        }
      }
    }
  }
  SettingsSet* mirror = NULL;
  if (status == 200 && changed_count && source == SRC_WEB) {
    mirror = calloc(1, sizeof *mirror);
    if (mirror && !settings_copy(mirror, &g_settings)) { free(mirror); mirror = NULL; }
  }
  const uint64_t rev = g_settings_rev;
  pthread_mutex_unlock(&g_settings_lock);
  if (next) { settings_clear(next); free(next); }
  if (status == 200) {
    if (changed_count) {
      Buf keys = {0};
      for (int i = 0; i < changed_count && i < 12; ++i) { if (i) buf_str(&keys, ", "); buf_str(&keys, changed[i]); }
      logf_("configuracoes: rev %llu (%s%s): %s%s", (unsigned long long)rev, source == SRC_WEB ? "celular" : "app", b->replace ? ", completas" : "",
            keys.data ? keys.data : "", changed_count > 12 ? ", ..." : "");
      free(keys.data);
    }
    if (b->dropped_count || b->secrets_skipped)
      logf_("configuracoes: %d chave(s) invalida(s) e %d segredo(s) nao guardados", b->dropped_count, b->secrets_skipped);
    if (mirror) settings_mirror_config(mirror, changed, changed_count);
    settings_reply_json(out, source != SRC_WEB, tails, b, (const char(*)[SETTINGS_KEY_MAX + 1])changed, changed_count);
  } else {
    buf_str(out, status == 413 ? "{\"error\":\"full\"}" : "{\"error\":\"not saved\"}");
  }
  pthread_mutex_unlock(&changed_lock);
  if (mirror) { settings_clear(mirror); free(mirror); }
  settings_body_free(b);
  free(b);
  return status;
}

// ---- Rotas -------------------------------------------------------------------------------------------------------

// Para o /health: devolve o esquema; a revisao e o store em rev/store (chamar sem o g_lock).
static int settings_health(uint64_t* rev, char store[33]) {
  pthread_mutex_lock(&g_settings_lock);
  settings_load_locked();
  *rev = g_settings_rev;
  copy_text(store, 33, g_settings_store);
  pthread_mutex_unlock(&g_settings_lock);
  return SETTINGS_SCHEMA;
}
static int settings_app_route(int fd, Request* r) {
  if (strcmp(r->path, "/settings")) return 0;
  Buf b = {0};
  int status = 404;
  if (!strcmp(r->method, "GET")) { settings_reply_json(&b, 1, 1, NULL, NULL, 0); status = 200; }
  else if (!strcmp(r->method, "POST")) status = settings_post(r, SRC_APP, 1, &b);
  if (status == 404) respond_error(fd, 404, "not found");
  else respond(fd, b.failed || !b.data ? 500 : status, b.failed || !b.data ? "{\"error\":\"out of memory\"}" : b.data);
  free(b.data);
  return 1;
}
static int settings_monitor_route(int fd, Request* r) {
  if (strcmp(r->path, "/api/settings")) return 0;
  const int writes = !strcmp(r->method, "POST");
  if (!writes && strcmp(r->method, "GET")) { monitor_json(fd, 404, "{\"error\":\"not found\"}"); return 1; }
  if (!monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return 1; }
  const int tails = monitor_strong(r);
  Buf b = {0};
  int status = 200;
  if (writes) status = settings_post(r, SRC_WEB, tails, &b);
  else settings_reply_json(&b, 0, tails, NULL, NULL, 0);
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_send(fd, status, "application/json", b.data, b.size);
  free(b.data);
  return 1;
}
