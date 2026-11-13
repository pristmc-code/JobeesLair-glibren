// glibren.49 (Fase 2 do modelo Orbit): o payload se atualiza sozinho, com assinatura, sem baixar a imagem da Jobe.
// Incluido em bg_downloader.c depois de bg_teste.c.
//
// Publicacao (fora do app: ps5/jobe/ferramentas/publicar_bg.py): uma release do repositorio da Jobe com a tag
// "bg-downloader-<versao>", NAO latest (o verificador de versoes do app ignora essas tags, state/updater.js), com 3 arquivos:
//   bg-downloader.elf        o payload
//   bg-downloader.json       o manifesto, ASCII: {"format":1,"name":"bg-downloader","version","api","minAppApi","size","sha256"}
//   bg-downloader.json.sig   128 hex + \n: Ed25519 de "jobe-bg-signature-v1\n" + os bytes exatos do manifesto
// A chave e a do glibren/tube-service/Jobe (a publica abaixo); o prefixo de dominio impede reaproveitar uma assinatura
// de outro contexto (o ELF cru do glibren, o manifesto da Jobe, o do tube-service).
//
// CONTRATO DE API (tambem em ps5/jobe/ferramentas/LEIA-ME.md):
//   - "api" (BG_API) e a versao do protocolo que este payload oferece ao app; "minAppApi" (BG_MIN_APP_API) e o menor
//     PAYLOAD_API de app com que ele continua compativel (todas as rotas e campos que esse app usa continuam iguais).
//   - O app diz o PAYLOAD_API dele em <dir>/app.json ({"api":N,"embedded":"X.Y.Z"}, gravado antes de subir o payload).
//   - Um payload baixado so e usado (e so e baixado) se: api >= appApi (tem tudo o que o app usa) e, quando api > appApi,
//     minAppApi <= appApi (declarou que continua compativel com esse app). Senao: "needs-app" (espera uma Jobe nova).
//   - Quem sobe e sempre o app (Payloads.send do ELF embutido em /app0). Ao iniciar, o payload procura um baixado valido
//     MAIS NOVO que ele e que o embutido do app (assinatura, sha256, tamanho, compatibilidade, nao marcado como ruim) e,
//     se achar, passa a vez: conta uma tentativa, manda esse ELF ao elfldr (127.0.0.1:9021) e sai sem tocar no que esta
//     no ar (o novo assume pelo lock, pedindo a saida limpa do antigo). Um baixado mais velho ou igual ao embutido nunca
//     e usado. So passa a vez para uma versao estritamente mais nova: sem laco.
//   - A versao que sobe e fica SELF_CONFIRM_MS no ar zera as tentativas dela. Duas tentativas sem confirmar (SELF_STRIKES)
//     = versao ruim: nunca mais e usada nem baixada; a seguinte (a anterior baixada, ou o proprio embutido) sobe.
//
// Arquivos em <dir> (/data/JobeesLair/bg): bg-downloader.elf/.json/.json.sig (o baixado atual), bg-downloader.prev.*
// (o anterior, para voltar), bg-downloader.part (o download em andamento, renomeado no fim), self-update.json (estado:
// ruins, tentativas, ultima procura), app.json (do app) e embedded.elf (copia do ELF embutido, posta pelo app, usada so
// para "Voltar ao payload embutido" sem o app aberto).
//
// Rotas do app (34200, com o token):
//   GET  /self-update                       o estado (self_status_json)
//   POST /self-update {action, force?}      action: "check" (procura; force ignora o intervalo de 6 h), "revert"
// Rotas da pagina do celular (34201, com a sessao do PIN; 401 {error:"pin"} sem ela):
//   GET  /api/payload, POST /api/payload/update (procura agora), POST /api/payload/revert

#define SELF_TAG_PREFIX "bg-downloader-"
#define SELF_REPO "pristmc-code/JobeesLair-glibren"
#define SELF_DOMAIN "jobe-bg-signature-v1\n"
#define SELF_MAX_ELF (32u * 1024 * 1024)
#define SELF_STRIKES 2
#define SELF_CHECK_S (6 * 3600)
#define SELF_RETRY_S 3600
#define SELF_SWAP_GIVEUP_MS 60000
#define SELF_XSTR(x) SELF_STR(x)
#define SELF_STR(x) #x

// O marcador que o publicar_bg.py le do ELF (versao, api e minAppApi deste build).
__attribute__((used)) static const char g_self_marker[] =
    "BG-DOWNLOADER-VERSION:" BG_VERSION ";API:" SELF_XSTR(BG_API) ";MINAPP:" SELF_XSTR(BG_MIN_APP_API) ";\n";

// A chave publica Ed25519 do glibren (a mesma de app/state/release-signature.js e tube-update.js).
static const char SELF_PUBLIC_KEY[] = "ce2767604727310aa1b2a5713fe7b76774b7ecd8c68240fef789819a473847c0";

static pthread_mutex_t g_self_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t g_self_once = PTHREAD_ONCE_INIT;
static char g_self_key[65], g_self_api_base[256], g_self_dl_base[256];
static int g_self_loader_port = 9021;
static int64_t g_self_confirm_ms = 20000;
static struct {
  int running;                 // uma procura/download em andamento
  char phase[16];              // idle|checking|downloading|ready|waiting|swapping|current|needs-app|failed
  char latest[24], error[160], swap_to[24];
  const char* waiting;         // o que segura a troca (self_busy) ou NULL
  int percent;
  int64_t at;                  // epoch da ultima mudanca
  int swap_pending;            // 1: trocar por bg-downloader.elf quando ocioso; 2: pelo embedded.elf (voltar)
  int64_t swap_sent_mono;      // quando o ELF novo foi mandado ao elfldr (0 = ainda nao)
  int confirmed;
} g_self;

static void self_setup(void) {
  copy_text(g_self_key, sizeof g_self_key, env_or("BGDL_SELF_PUBLIC_KEY", SELF_PUBLIC_KEY));
  copy_text(g_self_api_base, sizeof g_self_api_base, env_or("BGDL_GITHUB_BASE", "https://api.github.com"));
  copy_text(g_self_dl_base, sizeof g_self_dl_base, env_or("BGDL_RELEASES_BASE", "https://github.com"));
  g_self_loader_port = atoi(env_or("BGDL_ELFLDR_PORT", "9021"));
  if (g_self_loader_port <= 0 || g_self_loader_port > 65535) g_self_loader_port = 9021;
  g_self_confirm_ms = atoll(env_or("BGDL_SELF_CONFIRM_MS", "20000"));
  if (g_self_confirm_ms < 0) g_self_confirm_ms = 20000;
  copy_text(g_self.phase, sizeof g_self.phase, "idle");
}
static void self_init(void) { pthread_once(&g_self_once, self_setup); }
static void self_path(char* out, size_t cap, const char* name) { snprintf(out, cap, "%.500s/%s", g_dir, name); }

// ---- Versoes ----------------------------------------------------------------------------------------------
// So X.Y.Z (numeros de ate 4 digitos). 1 = valida.
static int self_version_parse(const char* text, int out[3]) {
  if (!text || !*text) return 0;
  const char* p = text;
  for (int i = 0; i < 3; ++i) {
    int digits = 0, value = 0;
    while (isdigit((unsigned char)*p) && digits < 5) { value = value * 10 + (*p - '0'); ++p; ++digits; }
    if (!digits || digits > 4) return 0;
    out[i] = value;
    if (i < 2) { if (*p != '.') return 0; ++p; }
  }
  return *p == 0;
}
// >0: a mais nova que b; 0: igual; <0: mais velha. Uma invalida perde para qualquer valida.
static int self_version_cmp(const char* a, const char* b) {
  int x[3], y[3];
  const int va = self_version_parse(a, x), vb = self_version_parse(b, y);
  if (!va || !vb) return va - vb;
  for (int i = 0; i < 3; ++i) if (x[i] != y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

// ---- O que o app disse (app.json) e o estado guardado (self-update.json) ----------------------------------------
typedef struct { int64_t api; char embedded[24]; } SelfApp;
static int self_app_field(JP* jp, const char* key, void* ctx) {
  SelfApp* a = ctx;
  if (!strcmp(key, "api")) return jp_int64(jp, &a->api) ? 1 : -1;
  if (!strcmp(key, "embedded")) return lib_text(jp, a->embedded, sizeof a->embedded) ? 1 : -1;
  return 0;
}
// O PAYLOAD_API do app e a versao do payload embutido nele. Sem app.json: este proprio payload (BG_API, BG_VERSION).
static void self_app(SelfApp* a) {
  memset(a, 0, sizeof *a);
  char path[600];
  self_path(path, sizeof path, "app.json");
  size_t size = 0;
  char* text = read_text(path, 4096, &size);
  if (text) {
    JP jp = {text, text + size, 0};
    if (!jp_object(&jp, self_app_field, a)) memset(a, 0, sizeof *a);
    free(text);
  }
  if (a->api < 1 || a->api > 1000000) a->api = BG_API;
  if (!self_version_parse(a->embedded, (int[3]){0})) copy_text(a->embedded, sizeof a->embedded, BG_VERSION);
}

#define SELF_MAX_BAD 16
#define SELF_MAX_STRIKES 8
typedef struct {
  char bad[SELF_MAX_BAD][24];
  int nbad;
  char strike_v[SELF_MAX_STRIKES][24];
  int strike_n[SELF_MAX_STRIKES];
  int nstrikes;
  int64_t checked_at, failed_at;
  char latest[24];
} SelfState;
static int self_bad_item(JP* jp, void* ctx) {
  SelfState* s = ctx;
  char v[24];
  if (!lib_text(jp, v, sizeof v)) return 0;
  if (s->nbad < SELF_MAX_BAD && self_version_parse(v, (int[3]){0})) copy_text(s->bad[s->nbad++], sizeof s->bad[0], v);
  return 1;
}
static int self_strike_field(JP* jp, const char* key, void* ctx) {
  SelfState* s = ctx;
  int64_t n = 0;
  if (!jp_int64(jp, &n)) return -1;
  if (s->nstrikes < SELF_MAX_STRIKES && self_version_parse(key, (int[3]){0}) && n > 0 && n < 100) {
    copy_text(s->strike_v[s->nstrikes], sizeof s->strike_v[0], key);
    s->strike_n[s->nstrikes++] = (int)n;
  }
  return 1;
}
static int self_state_field(JP* jp, const char* key, void* ctx) {
  SelfState* s = ctx;
  if (!strcmp(key, "bad")) return jp_array(jp, self_bad_item, s) ? 1 : -1;
  if (!strcmp(key, "strikes")) return jp_object(jp, self_strike_field, s) ? 1 : -1;
  if (!strcmp(key, "checkedAt")) return jp_int64(jp, &s->checked_at) ? 1 : -1;
  if (!strcmp(key, "failedAt")) return jp_int64(jp, &s->failed_at) ? 1 : -1;
  if (!strcmp(key, "latest")) return lib_text(jp, s->latest, sizeof s->latest) ? 1 : -1;
  return 0;
}
static void self_load(SelfState* s) {
  memset(s, 0, sizeof *s);
  char path[600];
  self_path(path, sizeof path, "self-update.json");
  size_t size = 0;
  char* text = read_text(path, 64 * 1024, &size);
  if (!text) return;
  JP jp = {text, text + size, 0};
  if (!jp_object(&jp, self_state_field, s)) { logf_("self-update.json ilegivel: recomecando"); memset(s, 0, sizeof *s); }
  free(text);
}
static void self_save(const SelfState* s) {
  Buf b = {0};
  buf_str(&b, "{\"bad\":[");
  for (int i = 0; i < s->nbad; ++i) buf_fmt(&b, "%s\"%s\"", i ? "," : "", s->bad[i]);
  buf_str(&b, "],\"strikes\":{");
  for (int i = 0; i < s->nstrikes; ++i) buf_fmt(&b, "%s\"%s\":%d", i ? "," : "", s->strike_v[i], s->strike_n[i]);
  buf_fmt(&b, "},\"checkedAt\":%lld,\"failedAt\":%lld,\"latest\":\"%s\"}\n", (long long)s->checked_at, (long long)s->failed_at, s->latest);
  char path[600];
  self_path(path, sizeof path, "self-update.json");
  if (b.failed || !b.data || !save_atomic(path, b.data, b.size, 0600)) logf_("self-update.json nao gravado");
  free(b.data);
}
static int self_is_bad(const SelfState* s, const char* v) {
  for (int i = 0; i < s->nbad; ++i) if (!strcmp(s->bad[i], v)) return 1;
  return 0;
}
static int self_strikes(const SelfState* s, const char* v) {
  for (int i = 0; i < s->nstrikes; ++i) if (!strcmp(s->strike_v[i], v)) return s->strike_n[i];
  return 0;
}
static void self_set_strikes(SelfState* s, const char* v, int n) {
  for (int i = 0; i < s->nstrikes; ++i) {
    if (strcmp(s->strike_v[i], v)) continue;
    if (n > 0) { s->strike_n[i] = n; return; }
    memmove(&s->strike_v[i], &s->strike_v[i + 1], sizeof s->strike_v[0] * (size_t)(s->nstrikes - i - 1));
    memmove(&s->strike_n[i], &s->strike_n[i + 1], sizeof s->strike_n[0] * (size_t)(s->nstrikes - i - 1));
    --s->nstrikes;
    return;
  }
  if (n <= 0) return;
  if (s->nstrikes == SELF_MAX_STRIKES) { // a mais antiga sai
    memmove(&s->strike_v[0], &s->strike_v[1], sizeof s->strike_v[0] * (SELF_MAX_STRIKES - 1));
    memmove(&s->strike_n[0], &s->strike_n[1], sizeof s->strike_n[0] * (SELF_MAX_STRIKES - 1));
    --s->nstrikes;
  }
  copy_text(s->strike_v[s->nstrikes], sizeof s->strike_v[0], v);
  s->strike_n[s->nstrikes++] = n;
}
static void self_mark_bad(SelfState* s, const char* v, const char* why) {
  self_set_strikes(s, v, 0);
  if (self_is_bad(s, v)) return;
  if (s->nbad == SELF_MAX_BAD) { memmove(&s->bad[0], &s->bad[1], sizeof s->bad[0] * (SELF_MAX_BAD - 1)); --s->nbad; }
  copy_text(s->bad[s->nbad++], sizeof s->bad[0], v);
  logk_("self-update: versao %s marcada como ruim (%s)", v, why);
}

// ---- Manifesto e assinatura ---------------------------------------------------------------------------------
typedef struct { int64_t format, api, min_app_api; uint64_t size; char name[32], version[24], sha256[65]; } SelfManifest;
static int self_manifest_field(JP* jp, const char* key, void* ctx) {
  SelfManifest* m = ctx;
  if (!strcmp(key, "format")) return jp_int64(jp, &m->format) ? 1 : -1;
  if (!strcmp(key, "name")) return jp_text(jp, m->name, sizeof m->name) ? 1 : -1;
  if (!strcmp(key, "version")) return jp_text(jp, m->version, sizeof m->version) ? 1 : -1;
  if (!strcmp(key, "api")) return jp_int64(jp, &m->api) ? 1 : -1;
  if (!strcmp(key, "minAppApi")) return jp_int64(jp, &m->min_app_api) ? 1 : -1;
  if (!strcmp(key, "size")) return jp_uint(jp, &m->size) ? 1 : -1;
  if (!strcmp(key, "sha256")) return jp_text(jp, m->sha256, sizeof m->sha256) ? 1 : -1;
  return 0;
}
static int self_hex(const char* text, unsigned char* out, size_t bytes) {
  if (strlen(text) != bytes * 2) return 0;
  for (size_t i = 0; i < bytes; ++i) {
    unsigned v = 0;
    for (int k = 0; k < 2; ++k) {
      const char c = text[2 * i + k];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
      else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
      else return 0;
    }
    out[i] = (unsigned char)v;
  }
  return 1;
}
// Confere a assinatura (sig_text: 128 hex, com ou sem \n no fim) do manifesto com a chave publica embutida.
static int self_signature_ok(const char* manifest, size_t size, const char* sig_text) {
  char sig_hex[129];
  size_t n = strcspn(sig_text, "\r\n");
  if (n != 128) return 0;
  memcpy(sig_hex, sig_text, 128);
  sig_hex[128] = 0;
  unsigned char sig[64], pub[32];
  if (!self_hex(sig_hex, sig, sizeof sig) || !self_hex(g_self_key, pub, sizeof pub)) return 0;
  const size_t dn = strlen(SELF_DOMAIN);
  unsigned char* message = malloc(dn + size);
  if (!message) return 0;
  memcpy(message, SELF_DOMAIN, dn);
  memcpy(message + dn, manifest, size);
  int ok = 0;
  EVP_PKEY* key = EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, NULL, pub, sizeof pub);
  EVP_MD_CTX* ctx = EVP_MD_CTX_new();
  if (key && ctx && EVP_DigestVerifyInit(ctx, NULL, NULL, NULL, key) == 1) ok = EVP_DigestVerify(ctx, sig, sizeof sig, message, dn + size) == 1;
  EVP_MD_CTX_free(ctx);
  EVP_PKEY_free(key);
  free(message);
  return ok;
}
// O manifesto (texto exato) + a assinatura conferidos e os campos validos. "" = ok; senao o motivo curto
// (signature, fields, version, api, needs-app).
static const char* self_manifest_check(const char* text, size_t size, const char* sig, const char* want_version, const SelfApp* app, SelfManifest* m) {
  memset(m, 0, sizeof *m);
  if (!sig || !self_signature_ok(text, size, sig)) return "signature";
  for (size_t i = 0; i < size; ++i) if ((unsigned char)text[i] > 0x7e) return "fields"; // ASCII
  JP jp = {text, text + size, 0};
  if (!jp_object(&jp, self_manifest_field, m)) return "fields";
  if (m->format != 1 || strcmp(m->name, "bg-downloader") || !self_version_parse(m->version, (int[3]){0}) || m->api < 1 || m->api > 1000000 ||
      m->min_app_api < 1 || m->min_app_api > m->api || !m->size || m->size > SELF_MAX_ELF || strlen(m->sha256) != 64 ||
      strspn(m->sha256, "0123456789abcdef") != 64)
    return "fields";
  if (want_version && *want_version && strcmp(m->version, want_version)) return "version";
  if (m->api < app->api) return "api";                                // falta o que o app usa
  if (m->api > app->api && m->min_app_api > app->api) return "needs-app"; // nao declarou compatibilidade com este app
  return "";
}
// sha256 de um arquivo (no maximo `limit` bytes). 1 = calculou.
static int self_file_sha(const char* path, uint64_t limit, char out[65], uint64_t* size) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) return 0;
  Hash h;
  hash_init(&h);
  char* block = malloc(256 * 1024);
  uint64_t total = 0;
  int ok = block != NULL;
  for (ssize_t n; ok && (n = read(fd, block, 256 * 1024)) != 0;) {
    if (n < 0) { if (errno == EINTR) continue; ok = 0; break; }
    total += (uint64_t)n;
    if (total > limit) { ok = 0; break; }
    hash_add(&h, block, (size_t)n);
  }
  free(block);
  close(fd);
  const int done = hash_finish(&h, out);
  if (size) *size = total;
  return ok && done;
}

// Um baixado no disco (base = "bg-downloader" ou "bg-downloader.prev") conferido por inteiro: assinatura, campos,
// compatibilidade com o app, tamanho e sha256 do ELF. "" = ok (m preenchido); senao o motivo.
static const char* self_installed(const char* base, const SelfApp* app, SelfManifest* m, int check_elf) {
  char json[600], sig[600], elf[600];
  snprintf(json, sizeof json, "%.500s/%s.json", g_dir, base);
  snprintf(sig, sizeof sig, "%.500s/%s.json.sig", g_dir, base);
  snprintf(elf, sizeof elf, "%.500s/%s.elf", g_dir, base);
  size_t jn = 0;
  char* jt = read_text(json, 4096, &jn);
  if (!jt) { memset(m, 0, sizeof *m); return "missing"; }
  char* st = read_text(sig, 1024, NULL);
  const char* why = self_manifest_check(jt, jn, st, NULL, app, m);
  free(jt);
  free(st);
  if (*why || !check_elf) return why;
  char sha[65];
  uint64_t size = 0;
  if (!self_file_sha(elf, SELF_MAX_ELF, sha, &size)) return "elf";
  if (size != m->size || strcmp(sha, m->sha256)) return "sha256";
  return "";
}

// ---- elfldr ---------------------------------------------------------------------------------------------------
// Manda o ELF ao carregador de payloads (127.0.0.1:9021), como o Payloads.send do app. 1 = mandou.
static int self_loader_send(const char* path) {
  const int file = open(path, O_RDONLY);
  if (file < 0) { logk_("self-update: %s nao abriu (%s)", path, strerror(errno)); return 0; }
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof addr);
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)g_self_loader_port);
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (fd < 0 || connect(fd, (struct sockaddr*)&addr, sizeof addr)) {
    logk_("self-update: o carregador de payloads (porta %d) nao respondeu", g_self_loader_port);
    if (fd >= 0) close(fd);
    close(file);
    return 0;
  }
  char block[65536];
  int sent = 1;
  for (ssize_t n; sent && (n = read(file, block, sizeof block)) != 0;) {
    if (n < 0 && errno == EINTR) continue;
    sent = n > 0 && send_all(fd, block, (size_t)n);
  }
  close(file);
  shutdown(fd, SHUT_WR);
  close(fd);
  if (!sent) logk_("self-update: %s nao foi inteiro ao carregador", path);
  return sent;
}

// ---- A subida: passar a vez para um baixado mais novo -------------------------------------------------------------
// Chamado no inicio do main, ANTES do lock (nada do que esta no ar e tocado). 1 = passou a vez (o main sai).
static int self_boot_handoff(void) {
  self_init();
  if (getenv("BGDL_NO_HANDOFF")) return 0;
  SelfApp app;
  self_app(&app);
  SelfState s;
  self_load(&s);
  const char* floor_v = self_version_cmp(app.embedded, BG_VERSION) > 0 ? app.embedded : BG_VERSION; // o baixado tem de ser mais novo que os dois
  const char* const bases[2] = {"bg-downloader", "bg-downloader.prev"};
  SelfManifest best;
  const char* best_base = NULL;
  int changed = 0;
  for (int i = 0; i < 2; ++i) {
    SelfManifest m;
    const char* why = self_installed(bases[i], &app, &m, 0);
    if (!strcmp(why, "missing")) continue;
    if (*why) { logk_("self-update: %s.elf ignorado na subida (%s)", bases[i], why); continue; }
    if (self_version_cmp(m.version, floor_v) <= 0 || self_is_bad(&s, m.version)) continue;
    if (best_base && self_version_cmp(m.version, best.version) <= 0) continue;
    if (self_strikes(&s, m.version) >= SELF_STRIKES) { self_mark_bad(&s, m.version, "nao subiu em 2 tentativas"); changed = 1; continue; }
    // So agora o ELF inteiro (sha256): custa ler o arquivo.
    why = self_installed(bases[i], &app, &m, 1);
    if (*why) { logk_("self-update: %s.elf ignorado na subida (%s)", bases[i], why); continue; }
    best = m;
    best_base = bases[i];
  }
  if (!best_base) { if (changed) self_save(&s); return 0; }
  const int tries = self_strikes(&s, best.version) + 1;
  self_set_strikes(&s, best.version, tries);
  self_save(&s);
  char elf[600];
  snprintf(elf, sizeof elf, "%.500s/%s.elf", g_dir, best_base);
  logk_("self-update: passando a vez para o payload baixado %s (api %lld; tentativa %d de %d; este e o %s)", best.version, (long long)best.api, tries,
        SELF_STRIKES, BG_VERSION);
  if (self_loader_send(elf)) return 1;
  self_set_strikes(&s, best.version, tries - 1); // nao chegou ao carregador: nao conta
  self_save(&s);
  return 0;
}
// No laco principal: a versao no ar ha SELF_CONFIRM_MS zera as tentativas dela (subiu). E a troca pendente.
static void self_tick(int64_t uptime_ms);

// ---- Rede (GitHub) -------------------------------------------------------------------------------------------
typedef struct { Buf* b; size_t cap; } SelfSink;
static size_t self_on_body(char* data, size_t size, size_t count, void* ctx) {
  SelfSink* sink = ctx;
  const size_t n = size * count;
  if (sink->b->size + n > sink->cap) return 0;
  buf_add(sink->b, data, n);
  return sink->b->failed ? 0 : n;
}
// GET pequeno para a memoria. O codigo HTTP (-1 sem resposta).
static long self_get(const char* url, Buf* b, size_t cap, int github_api) {
  CURL* curl = curl_easy_init();
  if (!curl) return -1;
  SelfSink sink = {b, cap};
  configure_transport(curl, url); // HTTPS com o certificado conferido; segue o redirect do download do GitHub
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 60L);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, self_on_body);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &sink);
  struct curl_slist* headers = NULL;
  if (github_api) {
    headers = curl_slist_append(headers, "Accept: application/vnd.github+json");
    headers = curl_slist_append(headers, "X-GitHub-Api-Version: 2022-11-28");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  }
  const CURLcode result = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_cleanup(curl);
  curl_slist_free_all(headers);
  return result == CURLE_OK ? status : -1;
}
typedef struct { int fd; Hash h; uint64_t got, limit; int failed; } SelfFile; // failed: 1 = maior que o manifesto, 2 = nao gravou
static size_t self_on_file(char* data, size_t size, size_t count, void* ctx) {
  SelfFile* f = ctx;
  const size_t n = size * count;
  if (f->got + n > f->limit) { f->failed = 1; return 0; }
  if (!write_all(f->fd, data, n, f->got)) { f->failed = 2; return 0; }
  hash_add(&f->h, data, n);
  f->got += n;
  pthread_mutex_lock(&g_self_lock);
  g_self.percent = (int)(f->got * 100 / (f->limit ? f->limit : 1));
  pthread_mutex_unlock(&g_self_lock);
  return n;
}

static void self_phase(const char* phase, const char* error) {
  pthread_mutex_lock(&g_self_lock);
  copy_text(g_self.phase, sizeof g_self.phase, phase);
  copy_text(g_self.error, sizeof g_self.error, error ? error : "");
  g_self.at = now_s();
  pthread_mutex_unlock(&g_self_lock);
}

// As versoes das tags bg-downloader-* na resposta do matching-refs: a maior que serve (mais nova que `have`, nao ruim).
static int self_pick_tag(const char* text, const char* have, const SelfState* s, char* out, size_t cap) {
  out[0] = 0;
  const char* needle = "\"refs/tags/" SELF_TAG_PREFIX;
  for (const char* p = strstr(text, needle); p; p = strstr(p + 1, needle)) {
    const char* v = p + strlen(needle);
    const size_t n = strcspn(v, "\"");
    if (!n || n >= 24 || v[n] != '"') continue;
    char version[24];
    memcpy(version, v, n);
    version[n] = 0;
    if (!self_version_parse(version, (int[3]){0}) || self_is_bad(s, version) || self_version_cmp(version, have) <= 0) continue;
    if (!out[0] || self_version_cmp(version, out) > 0) copy_text(out, cap, version);
  }
  return out[0] != 0;
}

// A troca do baixado atual pelo novo: o atual vira o anterior; o .part entra por rename; a assinatura e o manifesto por
// ultimo (um ELF sem manifesto valido nao e usado).
static int self_install(const char* part, const char* manifest, size_t msize, const char* sig) {
  char cur[600], prev[600], from[620], to[620];
  snprintf(cur, sizeof cur, "%.500s/bg-downloader", g_dir);
  snprintf(prev, sizeof prev, "%.500s/bg-downloader.prev", g_dir);
  static const char* const EXT[3] = {".json", ".json.sig", ".elf"};
  snprintf(from, sizeof from, "%s.json", cur);
  struct stat st;
  if (!stat(from, &st)) {
    for (int i = 0; i < 3; ++i) {
      snprintf(to, sizeof to, "%s%s", prev, EXT[i]);
      unlink(to);
    }
    for (int i = 0; i < 3; ++i) {
      snprintf(from, sizeof from, "%s%s", cur, EXT[i]);
      snprintf(to, sizeof to, "%s%s", prev, EXT[i]);
      if (!stat(from, &st) && rename(from, to)) return 0;
    }
  } else {
    for (int i = 0; i < 3; ++i) { snprintf(to, sizeof to, "%s%s", cur, EXT[i]); unlink(to); }
  }
  snprintf(to, sizeof to, "%s.elf", cur);
  if (rename(part, to) || !sync_parent(to)) return 0;
  snprintf(to, sizeof to, "%s.json.sig", cur);
  if (!save_atomic(to, sig, strlen(sig), 0600)) return 0;
  snprintf(to, sizeof to, "%s.json", cur);
  return save_atomic(to, manifest, msize, 0600);
}

static void self_schedule_swap(int kind, const char* version);
// Procura (e baixa) a versao nova. Roda numa thread (self_start). `force`: ignora o intervalo.
static void self_check_now(int force) {
  SelfApp app;
  self_app(&app);
  SelfState s;
  self_load(&s);
  const int64_t now = now_s();
  if (!force && ((s.checked_at && now - s.checked_at < SELF_CHECK_S) || (s.failed_at && now - s.failed_at < SELF_RETRY_S))) {
    pthread_mutex_lock(&g_self_lock);
    if (!strcmp(g_self.phase, "idle") && s.checked_at && now - s.checked_at < SELF_CHECK_S) copy_text(g_self.phase, sizeof g_self.phase, "current");
    copy_text(g_self.latest, sizeof g_self.latest, s.latest);
    pthread_mutex_unlock(&g_self_lock);
    return;
  }
  self_phase("checking", "");
  // O que ja tem: o maior entre este, o embutido do app e o baixado atual valido.
  char have[24];
  copy_text(have, sizeof have, self_version_cmp(app.embedded, BG_VERSION) > 0 ? app.embedded : BG_VERSION);
  SelfManifest cur;
  if (!*self_installed("bg-downloader", &app, &cur, 0) && !self_is_bad(&s, cur.version) && self_version_cmp(cur.version, have) > 0) copy_text(have, sizeof have, cur.version);
  char url[700];
  snprintf(url, sizeof url, "%.250s/repos/" SELF_REPO "/git/matching-refs/tags/" SELF_TAG_PREFIX, g_self_api_base);
  Buf refs = {0};
  long status = self_get(url, &refs, 256 * 1024, 1);
  char pick[24] = "";
  const char* fail = NULL;
  if (status == 404) pick[0] = 0;
  else if (status != 200 || !refs.data) fail = status < 0 ? "GitHub could not be reached" : "GitHub answered with an error";
  else self_pick_tag(refs.data, have, &s, pick, sizeof pick);
  free(refs.data);
  if (fail) {
    s.failed_at = now;
    self_save(&s);
    logk_("self-update: procura falhou (%s, HTTP %ld)", fail, status);
    self_phase("failed", fail);
    return;
  }
  if (!pick[0]) {
    s.checked_at = now;
    s.failed_at = 0;
    copy_text(s.latest, sizeof s.latest, have);
    self_save(&s);
    pthread_mutex_lock(&g_self_lock);
    copy_text(g_self.latest, sizeof g_self.latest, have);
    const int swapping = g_self.swap_pending != 0;
    pthread_mutex_unlock(&g_self_lock);
    logk_("self-update: em dia (%s)", have);
    if (!swapping) self_phase("current", "");
    return;
  }
  // O manifesto e a assinatura da versao escolhida.
  Buf man = {0}, sig = {0};
  snprintf(url, sizeof url, "%.250s/" SELF_REPO "/releases/download/" SELF_TAG_PREFIX "%s/bg-downloader.json", g_self_dl_base, pick);
  const long ms = self_get(url, &man, 16 * 1024, 0);
  snprintf(url, sizeof url, "%.250s/" SELF_REPO "/releases/download/" SELF_TAG_PREFIX "%s/bg-downloader.json.sig", g_self_dl_base, pick);
  const long ss = self_get(url, &sig, 1024, 0);
  buf_add(&sig, "", 0);
  SelfManifest m;
  const char* why = ms != 200 || !man.data ? "manifest" : ss != 200 || !sig.data ? "signature" : self_manifest_check(man.data, man.size, sig.data, pick, &app, &m);
  if (*why) {
    s.checked_at = now;
    s.failed_at = 0;
    self_save(&s);
    logk_("self-update: %s recusada (%s)", pick, why);
    pthread_mutex_lock(&g_self_lock);
    copy_text(g_self.latest, sizeof g_self.latest, pick);
    pthread_mutex_unlock(&g_self_lock);
    char text[160];
    snprintf(text, sizeof text, "%s: %s", pick, why);
    self_phase(!strcmp(why, "needs-app") ? "needs-app" : "failed", text);
    free(man.data);
    free(sig.data);
    return;
  }
  // O ELF: .part com o sha256 calculado enquanto chega; tamanho e sha256 do manifesto assinado.
  self_phase("downloading", "");
  pthread_mutex_lock(&g_self_lock);
  copy_text(g_self.latest, sizeof g_self.latest, pick);
  g_self.percent = 0;
  pthread_mutex_unlock(&g_self_lock);
  logk_("self-update: baixando %s (%llu bytes; tinha %s)", pick, (unsigned long long)m.size, have);
  char part[600];
  self_path(part, sizeof part, "bg-downloader.part");
  unlink(part);
  SelfFile f = {open(part, O_WRONLY | O_CREAT | O_TRUNC, 0644), {0}, 0, m.size, 0};
  char sha[65] = "";
  const char* err = NULL;
  if (f.fd < 0) err = "the file could not be created";
  else {
    hash_init(&f.h);
    snprintf(url, sizeof url, "%.250s/" SELF_REPO "/releases/download/" SELF_TAG_PREFIX "%s/bg-downloader.elf", g_self_dl_base, pick);
    CURL* curl = curl_easy_init();
    long code = 0;
    CURLcode result = CURLE_FAILED_INIT;
    if (curl) {
      configure_transport(curl, url);
      curl_easy_setopt(curl, CURLOPT_TIMEOUT, 600L);
      curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, self_on_file);
      curl_easy_setopt(curl, CURLOPT_WRITEDATA, &f);
      result = curl_easy_perform(curl);
      curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
      curl_easy_cleanup(curl);
    }
    const int synced = fsync(f.fd) == 0;
    close(f.fd);
    const int hashed = hash_finish(&f.h, sha);
    if (f.failed == 1) err = "the file is bigger than the manifest says";
    else if (f.failed == 2) err = "the file could not be written";
    else if (result != CURLE_OK || code != 200) err = "the download failed";
    else if (!synced || !hashed) err = "the file could not be written";
    else if (f.got != m.size) err = "the file has the wrong size";
    else if (strcmp(sha, m.sha256)) err = "sha256 mismatch";
  }
  if (!err) {
    buf_add(&sig, "", 0);
    char sig_line[130];
    snprintf(sig_line, sizeof sig_line, "%.128s\n", sig.data);
    if (!self_install(part, man.data, man.size, sig_line)) err = "the new version could not be put in place";
  }
  free(man.data);
  free(sig.data);
  if (err) {
    unlink(part);
    s.failed_at = now;
    self_save(&s);
    logk_("self-update: %s nao instalada: %s", pick, err);
    char text[160];
    snprintf(text, sizeof text, "%s: %s", pick, err);
    self_phase("failed", text);
    return;
  }
  s.checked_at = now;
  s.failed_at = 0;
  copy_text(s.latest, sizeof s.latest, pick);
  self_set_strikes(&s, pick, 0);
  self_save(&s);
  logk_("self-update: %s pronta (sha256 %.16s...); troca quando nada estiver baixando nem convertendo", pick, sha);
  self_phase("ready", "");
  self_schedule_swap(1, pick);
}

static void* self_thread(void* arg) {
  const int force = (int)(intptr_t)arg;
  self_check_now(force);
  pthread_mutex_lock(&g_self_lock);
  g_self.running = 0;
  pthread_mutex_unlock(&g_self_lock);
  return NULL;
}
// Comeca uma procura (se nenhuma estiver em andamento). 1 = comecou ou ja estava.
static int self_start(int force) {
  self_init();
  pthread_mutex_lock(&g_self_lock);
  if (g_self.running) { pthread_mutex_unlock(&g_self_lock); return 1; }
  g_self.running = 1;
  pthread_mutex_unlock(&g_self_lock);
  pthread_t t;
  if (spawn_thread(self_thread, (void*)(intptr_t)force, &t)) {
    pthread_mutex_lock(&g_self_lock);
    g_self.running = 0;
    pthread_mutex_unlock(&g_self_lock);
    return 0;
  }
  pthread_detach(t);
  return 1;
}

// ---- A troca quando ocioso --------------------------------------------------------------------------------------
static void self_schedule_swap(int kind, const char* version) {
  pthread_mutex_lock(&g_self_lock);
  g_self.swap_pending = kind;
  g_self.swap_sent_mono = 0;
  copy_text(g_self.swap_to, sizeof g_self.swap_to, version);
  pthread_mutex_unlock(&g_self_lock);
}
// O que impede a troca agora: "download" (um job gravando), "convert" (uma conversao na fila ou rodando), "quiet" (o app
// acabou de fechar) ou NULL (pode trocar).
static const char* self_busy(void) {
  pthread_mutex_lock(&g_lock);
  const int downloading = g_running_count > 0;
  pthread_mutex_unlock(&g_lock);
  if (downloading) return "download";
  int converting = 0;
  pthread_mutex_lock(&g_conv_lock);
  for (int i = 0; i < g_conv_count && !converting; ++i) {
    const char* st = g_convs[i]->state;
    converting = !strcmp(st, "queued") || !strcmp(st, "extracting") || !strcmp(st, "converting") || !strcmp(st, "verifying");
  }
  pthread_mutex_unlock(&g_conv_lock);
  if (converting) return "convert";
  if (quiet_now()) return "quiet";
  return NULL;
}
static void self_tick(int64_t uptime_ms) {
  self_init();
  // Subiu: a versao no ar ha SELF_CONFIRM_MS zera as tentativas dela.
  if (!g_self.confirmed && uptime_ms >= g_self_confirm_ms) {
    g_self.confirmed = 1;
    SelfState s;
    self_load(&s);
    if (self_strikes(&s, BG_VERSION)) {
      self_set_strikes(&s, BG_VERSION, 0);
      self_save(&s);
      logk_("self-update: payload %s confirmado (subiu e ficou no ar)", BG_VERSION);
    }
  }
  pthread_mutex_lock(&g_self_lock);
  const int kind = g_self.swap_pending;
  const int64_t sent = g_self.swap_sent_mono;
  char to[24];
  copy_text(to, sizeof to, g_self.swap_to);
  pthread_mutex_unlock(&g_self_lock);
  if (!kind) return;
  if (sent) {
    // O novo assume pelo lock (este recebe SIGTERM e sai limpo). Se nao assumiu, segue este; a tentativa ja contou.
    if (mono_ms() - sent < SELF_SWAP_GIVEUP_MS) return;
    logk_("self-update: a versao %s nao assumiu em %d s; este (%s) continua", to, SELF_SWAP_GIVEUP_MS / 1000, BG_VERSION);
    pthread_mutex_lock(&g_self_lock);
    g_self.swap_pending = 0;
    g_self.swap_sent_mono = 0;
    pthread_mutex_unlock(&g_self_lock);
    self_phase("failed", "the new version did not take over");
    return;
  }
  const char* busy = self_busy();
  pthread_mutex_lock(&g_self_lock);
  const int said = g_self.waiting == busy;
  g_self.waiting = busy;
  if (busy) copy_text(g_self.phase, sizeof g_self.phase, "waiting");
  pthread_mutex_unlock(&g_self_lock);
  if (busy) {
    if (!said) logk_("self-update: troca para %s esperando (%s em andamento)", to, busy);
    return;
  }
  char elf[600];
  if (kind == 1) {
    // Confere de novo (o arquivo pode ter mudado) e conta a tentativa antes de mandar.
    SelfApp app;
    self_app(&app);
    SelfManifest m;
    const char* why = self_installed("bg-downloader", &app, &m, 1);
    SelfState s;
    self_load(&s);
    if (*why || strcmp(m.version, to) || self_is_bad(&s, m.version)) {
      logk_("self-update: troca para %s cancelada (%s)", to, *why ? why : "outra versao no lugar");
      pthread_mutex_lock(&g_self_lock);
      g_self.swap_pending = 0;
      pthread_mutex_unlock(&g_self_lock);
      self_phase("failed", *why ? why : "changed");
      return;
    }
    const int tries = self_strikes(&s, to) + 1;
    if (tries > SELF_STRIKES) {
      self_mark_bad(&s, to, "nao subiu em 2 tentativas");
      self_save(&s);
      pthread_mutex_lock(&g_self_lock);
      g_self.swap_pending = 0;
      pthread_mutex_unlock(&g_self_lock);
      self_phase("failed", "the new version did not start twice");
      return;
    }
    self_set_strikes(&s, to, tries);
    self_save(&s);
    self_path(elf, sizeof elf, "bg-downloader.elf");
    logk_("self-update: trocando %s por %s (tentativa %d de %d): o novo pede a saida limpa deste", BG_VERSION, to, tries, SELF_STRIKES);
  } else {
    self_path(elf, sizeof elf, "embedded.elf");
    logk_("self-update: voltando ao payload embutido (%s)", to);
  }
  self_phase("swapping", "");
  pthread_mutex_lock(&g_self_lock);
  g_self.swap_sent_mono = mono_ms();
  pthread_mutex_unlock(&g_self_lock);
  if (!self_loader_send(elf)) {
    pthread_mutex_lock(&g_self_lock);
    g_self.swap_pending = 0;
    g_self.swap_sent_mono = 0;
    pthread_mutex_unlock(&g_self_lock);
    if (kind == 1) { SelfState s; self_load(&s); self_set_strikes(&s, to, self_strikes(&s, to) - 1); self_save(&s); }
    self_phase("failed", "the payload loader did not answer");
  }
}

// "Voltar ao payload embutido": todo baixado mais novo que o embutido fica marcado como ruim (nao e usado nem baixado de
// novo; uma versao ainda mais nova, quando sair, e baixada normalmente). Se este no ar e um deles, troca pelo embedded.elf
// quando ocioso (ou o app sobe o embutido na proxima vez: /health diz "replace"). Devolve quantas marcou.
static int self_revert(char* note, size_t cap) {
  self_init();
  SelfApp app;
  self_app(&app);
  SelfState s;
  self_load(&s);
  int marked = 0;
  const char* const bases[2] = {"bg-downloader", "bg-downloader.prev"};
  for (int i = 0; i < 2; ++i) {
    SelfManifest m;
    const char* why = self_installed(bases[i], &app, &m, 0);
    if (!strcmp(why, "missing") || !self_version_parse(m.version, (int[3]){0})) continue;
    if (self_version_cmp(m.version, app.embedded) <= 0 || self_is_bad(&s, m.version)) continue;
    self_mark_bad(&s, m.version, "o jogador escolheu o embutido");
    ++marked;
  }
  if (self_version_cmp(BG_VERSION, app.embedded) > 0 && !self_is_bad(&s, BG_VERSION)) { self_mark_bad(&s, BG_VERSION, "o jogador escolheu o embutido"); ++marked; }
  self_save(&s);
  char embedded[600];
  self_path(embedded, sizeof embedded, "embedded.elf");
  struct stat st;
  const int running_downloaded = self_version_cmp(BG_VERSION, app.embedded) > 0;
  if (running_downloaded && !stat(embedded, &st)) {
    self_schedule_swap(2, app.embedded);
    snprintf(note, cap, "the built-in payload %s comes back when nothing is downloading", app.embedded);
  } else if (running_downloaded) snprintf(note, cap, "the built-in payload %s comes back when Jobe opens", app.embedded);
  else snprintf(note, cap, "the built-in payload %s is the one running", BG_VERSION);
  logk_("self-update: voltar ao embutido pedido (%d versao(oes) marcada(s)); %s", marked, note);
  return marked;
}

// O estado (para o app, a pagina do celular e o /health).
static void self_status_json(Buf* b) {
  self_init();
  SelfApp app;
  self_app(&app);
  SelfState s;
  self_load(&s);
  SelfManifest cur, prev;
  const char* cw = self_installed("bg-downloader", &app, &cur, 0);
  const char* pw = self_installed("bg-downloader.prev", &app, &prev, 0);
  const int downloaded = self_version_cmp(BG_VERSION, app.embedded) > 0;
  pthread_mutex_lock(&g_self_lock);
  buf_fmt(b, "{\"ok\":true,\"version\":\"%s\",\"api\":%d,\"minAppApi\":%d,\"source\":\"%s\",\"embedded\":", BG_VERSION, BG_API, BG_MIN_APP_API,
          downloaded ? "downloaded" : "embedded");
  buf_json(b, app.embedded);
  buf_fmt(b, ",\"appApi\":%lld,\"installed\":", (long long)app.api);
  if (*cw) buf_str(b, "null"); else buf_json(b, cur.version);
  buf_str(b, ",\"previous\":");
  if (*pw) buf_str(b, "null"); else buf_json(b, prev.version);
  buf_str(b, ",\"latest\":");
  buf_json(b, g_self.latest[0] ? g_self.latest : s.latest);
  buf_fmt(b, ",\"checkedAt\":%lld,\"phase\":", (long long)s.checked_at);
  buf_json(b, g_self.phase);
  buf_fmt(b, ",\"percent\":%d,\"error\":", g_self.percent);
  buf_json(b, g_self.error);
  buf_str(b, ",\"waiting\":");
  buf_json(b, g_self.waiting ? g_self.waiting : "");
  buf_fmt(b, ",\"swap\":%s,\"replace\":%s,\"bad\":[", g_self.swap_pending ? "true" : "false", self_is_bad(&s, BG_VERSION) ? "true" : "false");
  for (int i = 0; i < s.nbad; ++i) { if (i) buf_str(b, ","); buf_json(b, s.bad[i]); }
  buf_str(b, "]}");
  pthread_mutex_unlock(&g_self_lock);
}
static void self_reply(int fd, int monitor) {
  Buf b = {0};
  self_status_json(&b);
  if (monitor) {
    if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
    else monitor_json(fd, 200, b.data);
  } else respond(fd, b.failed || !b.data ? 500 : 200, b.failed || !b.data ? "{\"error\":\"out of memory\"}" : b.data);
  free(b.data);
}

typedef struct { char action[16]; int force; } SelfAsk;
static int self_ask_field(JP* jp, const char* key, void* ctx) {
  SelfAsk* a = ctx;
  if (!strcmp(key, "action")) return jp_text(jp, a->action, sizeof a->action) ? 1 : -1;
  if (!strcmp(key, "force")) return jp_bool(jp, &a->force) ? 1 : -1;
  return 0;
}
// API do app (o token ja foi conferido). 1 = tratou.
static int self_app_route(int fd, Request* r) {
  if (strcmp(r->path, "/self-update")) return 0;
  self_init();
  if (!strcmp(r->method, "GET")) { self_reply(fd, 0); return 1; }
  if (strcmp(r->method, "POST")) { respond_error(fd, 404, "not found"); return 1; }
  SelfAsk a;
  memset(&a, 0, sizeof a);
  JP jp = {r->body ? r->body : "", r->body ? r->body + r->content_length : "", 0};
  if (!r->body || !jp_object(&jp, self_ask_field, &a) || (strcmp(a.action, "check") && strcmp(a.action, "revert"))) {
    respond_error(fd, 400, "expected {action: \"check\" | \"revert\", force?}");
    return 1;
  }
  if (!strcmp(a.action, "revert")) { char note[200]; self_revert(note, sizeof note); }
  else self_start(a.force);
  self_reply(fd, 0);
  return 1;
}
// Pagina do celular. 1 = tratou.
static int self_monitor_route(int fd, Request* r) {
  if (strncmp(r->path, "/api/payload", 12) || (r->path[12] && r->path[12] != '/')) return 0;
  self_init();
  if (!session_ok(r->session)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return 1; }
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/payload")) { self_reply(fd, 1); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/payload/update")) {
    logk_("self-update: procura pedida pela pagina do celular");
    self_start(1);
    self_reply(fd, 1);
    return 1;
  }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/payload/revert")) {
    char note[200];
    self_revert(note, sizeof note);
    self_reply(fd, 1);
    return 1;
  }
  monitor_json(fd, 404, "{\"error\":\"not found\"}");
  return 1;
}
