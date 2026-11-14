// glibren.44: diagnostico pelo GitHub (incluido em bg_downloader.c, depois de bg_store.c).
// O jogador manda os logs sem o PC: cola UMA vez, na pagina do celular, uma chave do GitHub (fine-grained PAT so do
// repositorio privado pristmc-code/ps5-diagnosticos, Contents read/write); o payload a grava em <diag>/token (0600) e
// nunca a devolve (so "configurada, termina em ...xxxx"), nem a escreve no diario. "Enviar diagnostico" (pagina do
// celular ou Configuracoes > Sobre na Jobe) junta os logs, higieniza (diag_clean: a lista de regras fica so em
// DIAG_SECRET_NAMES / DIAG_PRIVATE_HOSTS / DIAG_TOKEN_PREFIXES, logo abaixo) e manda um arquivo por PUT para
// /repos/pristmc-code/ps5-diagnosticos/contents/<AAAA-MM-DD_HHMMSS>/<arquivo>, na hora local do console. O envio e do
// payload (funciona com o app fechado); uma rodada por vez. Reserva: "Baixar diagnostico (.zip)" com os mesmos arquivos.
//
// Rotas da pagina do celular (34201, todas com a sessao do PIN, X-Session; 401 {error:"pin"} sem ela):
//   GET  /api/diag              {ok, configured, tail, state, folder, error, http, sent, total, at}
//   POST /api/diag/key {key}    grava a chave: 200 = o mesmo do GET; 400 {error:"key"} (nao parece chave do GitHub)
//   POST /api/diag/key/remove   apaga a chave: 200 = o mesmo do GET
//   POST /api/diag/send         comeca uma rodada: 200 {ok, state:"running"}; 400 {error:"no-key"}; 409 {error:"busy"}
//   GET  /api/diag/zip          os mesmos arquivos ja higienizados num .zip (application/zip)
// Rotas do app (34200, com o token do app):
//   GET  /diag                  como GET /api/diag
//   POST /diag/send {memory, versions:{jobe, tube, title}}   grava <diag>/app-info.json e comeca a rodada (como acima)
//
// Estado: state "idle" | "running" | "done" | "failed"; error "no-key" | "network" (sem internet) | "unauthorized" (401,
// chave invalida/expirada) | "forbidden" (403) | "no-repo" (404: a chave nao ve o repositorio) | "http" (outro codigo,
// em "http") | "nothing" | "memory".
// Nos testes do PC (env_or so vale fora do PS5): BGDL_DIAG_DIR, BGDL_TUBE_DIR, BGDL_APP_LOGS_ROOT, BGDL_GITHUB_BASE e
// BGDL_GLIBREN_BASE apontam para pastas e servidores falsos.

#define DIAG_TAIL (2u * 1024 * 1024)       // cada log: so os ultimos ~2 MB
#define DIAG_MAX_FILES 16 // glibren.47: + teste-resultados.txt e teste-estado.json (pagina /teste)
#define DIAG_MEMORY_MAX (48 * 1024)        // a amostra da Memoria que o app manda
#define DIAG_REPO_PATH "/repos/pristmc-code/ps5-diagnosticos/contents/"
#define DIAG_COMMITTER "{\"name\":\"PristMC\",\"email\":\"285300718+pristmc-code@users.noreply.github.com\"}"

// ---- AS REGRAS DE HIGIENIZACAO (lista unica; diag_clean as aplica a tudo que sai, envio e .zip) ----------------
// 1. Valores secretos conhecidos (a chave do GitHub, as chaves do TorBox/AllDebrid, o token do app e do tube-service,
//    o sal/hash do PIN) saem onde aparecerem.
// 2. Endereco http(s): usuario:senha sai; a consulta (?...) e o #... saem sempre; num host de DIAG_PRIVATE_HOSTS
//    (links assinados/temporarios: googlevideo, servicos debrid) sai o caminho inteiro.
// 3. "Bearer xxx" / "Basic xxx" (Authorization).
// 4. nome=valor / nome: valor / "nome":"valor" com um nome de DIAG_SECRET_NAMES (cookie, authorization e set-cookie
//    levam a linha inteira).
// 5. E-mails.
// 6. Tokens soltos: os prefixos de DIAG_TOKEN_PREFIXES (chaves do GitHub), UUID (formato da chave do TorBox) e
//    qualquer trecho de 32+ letras e digitos misturados (hashes, chaves do Real-Debrid, cookies).
// Arquivos que nunca vao: tube/account.json (a conta do YouTube), tube/token, <diag>/token, o debrid.json do app.
static const char* const DIAG_SECRET_NAMES[] = {
  "access_token", "refresh_token", "id_token", "token", "apikey", "api_key", "api-key", "key", "password", "passwd",
  "secret", "client_secret", "authorization", "auth", "set-cookie", "cookie", "sessionid", "session", "sid", "sapisid",
  "pinhash", "pinsalt", "signature", "sig", "x-jobe-token", "x-session", "code_verifier", "device_code", "user_code", NULL};
static const char* const DIAG_LINE_NAMES[] = {"authorization", "set-cookie", "cookie", NULL}; // levam a linha inteira
static const char* const DIAG_PRIVATE_HOSTS[] = {
  "googlevideo.com", "youtube.com", "youtu.be", "googleapis.com", "torbox", "tb-cdn", "alldebrid", "debrid", "real-debrid",
  "rdeb.io", "premiumize", "debrid-link", "1fichier", NULL};
static const char* const DIAG_TOKEN_PREFIXES[] = {"github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", NULL};
#define DIAG_HIDDEN "[segredo]"

static pthread_mutex_t g_diag_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t g_diag_once = PTHREAD_ONCE_INIT;
static char g_diag_dir[512], g_tube_dir[512], g_app_logs_root[512], g_github_base[256], g_glibren_base[160];
// glibren.44: a pasta da ultima rodada (sem sufixo) e quantas ja usaram essa hora: duas rodadas no mesmo segundo nao
// caem na mesma pasta (no GitHub, um PUT num arquivo que ja existe sem "sha" da 422). BGDL_DIAG_FOLDER_AT (so no PC)
// fixa a hora da pasta, para o teste conferir o sufixo sem depender do relogio.
static char g_diag_last_folder[24], g_diag_fixed_folder[24];
static int g_diag_folder_uses;
static struct {
  int running;
  char state[12], folder[24], error[16];
  long http;
  int sent, total;
  int64_t at;
} g_diag;

static void diag_setup(void) {
  copy_text(g_diag_dir, sizeof g_diag_dir, env_or("BGDL_DIAG_DIR", "/data/JobeesLair/diag"));
  copy_text(g_tube_dir, sizeof g_tube_dir, env_or("BGDL_TUBE_DIR", "/data/JobeesLair/tube"));
  copy_text(g_app_logs_root, sizeof g_app_logs_root, env_or("BGDL_APP_LOGS_ROOT", "/data/ps5-react"));
  copy_text(g_github_base, sizeof g_github_base, env_or("BGDL_GITHUB_BASE", "https://api.github.com"));
  copy_text(g_glibren_base, sizeof g_glibren_base, env_or("BGDL_GLIBREN_BASE", "http://127.0.0.1:8765"));
  copy_text(g_diag.state, sizeof g_diag.state, "idle");
  copy_text(g_diag_fixed_folder, sizeof g_diag_fixed_folder, env_or("BGDL_DIAG_FOLDER_AT", ""));
}
static void diag_init(void) { pthread_once(&g_diag_once, diag_setup); }

// ---- A chave ------------------------------------------------------------------------------------------------
static int diag_key_ok(const char* key) {
  const size_t n = strlen(key);
  return n >= 20 && n <= 200 && strspn(key, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_") == n;
}
static void diag_key_path(char* out, size_t cap) { snprintf(out, cap, "%.500s/token", g_diag_dir); }
// 1 = ha chave valida em `out`. Quem chama apaga `out` (memset) depois de usar.
static int diag_read_key(char* out, size_t cap) {
  char path[600];
  diag_key_path(path, sizeof path);
  size_t size = 0;
  char* text = read_text(path, 1024, &size);
  out[0] = 0;
  if (!text) return 0;
  char* start = text;
  while (*start == ' ' || *start == '\n' || *start == '\r' || *start == '\t') ++start;
  size_t n = strcspn(start, " \r\n\t");
  if (n < cap) { memcpy(out, start, n); out[n] = 0; }
  memset(text, 0, size);
  free(text);
  if (!diag_key_ok(out)) { memset(out, 0, cap); return 0; }
  return 1;
}

static void diag_status_json(Buf* b) {
  char key[256], tail[8] = "";
  const int has = diag_read_key(key, sizeof key);
  if (has) copy_text(tail, sizeof tail, key + strlen(key) - 4);
  memset(key, 0, sizeof key);
  pthread_mutex_lock(&g_diag_lock);
  buf_fmt(b, "{\"ok\":true,\"configured\":%s,\"tail\":", has ? "true" : "false");
  buf_json(b, tail);
  buf_str(b, ",\"state\":");
  buf_json(b, g_diag.state);
  buf_str(b, ",\"folder\":");
  buf_json(b, g_diag.folder);
  buf_str(b, ",\"error\":");
  buf_json(b, g_diag.error);
  buf_fmt(b, ",\"http\":%ld,\"sent\":%d,\"total\":%d,\"at\":%lld}", g_diag.http, g_diag.sent, g_diag.total, (long long)g_diag.at);
  pthread_mutex_unlock(&g_diag_lock);
}

// ---- Higienizacao (as regras estao no topo do arquivo) ---------------------------------------------------------
typedef struct { char value[8][160]; int count; } DiagSecrets;
static void diag_secret_add(DiagSecrets* s, const char* value) {
  if (s->count < 8 && strlen(value) >= 6) copy_text(s->value[s->count++], sizeof s->value[0], value);
}
// Os valores que o payload conhece. Quem chama apaga (memset) depois.
static void diag_known_secrets(DiagSecrets* s) {
  memset(s, 0, sizeof *s);
  char text[256];
  if (diag_read_key(text, sizeof text)) diag_secret_add(s, text);
  if (debrid_key("torbox", text, sizeof text)) diag_secret_add(s, text);
  if (debrid_key("alldebrid", text, sizeof text)) diag_secret_add(s, text);
  memset(text, 0, sizeof text);
  char path[600];
  snprintf(path, sizeof path, "%.500s/token", g_tube_dir);
  size_t size = 0;
  char* tube = read_text(path, 1024, &size);
  if (tube) {
    tube[strcspn(tube, " \r\n\t")] = 0;
    diag_secret_add(s, tube);
    memset(tube, 0, size);
    free(tube);
  }
  pthread_mutex_lock(&g_lock);
  diag_secret_add(s, g_token);
  diag_secret_add(s, g_pin_hash);
  diag_secret_add(s, g_pin_salt);
  pthread_mutex_unlock(&g_lock);
}

static int diag_alnum(char c) { return isalnum((unsigned char)c) != 0; }
static int diag_tokch(char c) { return diag_alnum(c) || c == '-' || c == '_'; }
static int diag_mailch(char c) { return diag_alnum(c) || c == '.' || c == '_' || c == '%' || c == '+' || c == '-'; }
static int diag_hexch(char c) { return isxdigit((unsigned char)c) != 0; }
// O fim de um valor sem aspas.
static int diag_stop(char c) { return !c || isspace((unsigned char)c) || strchr("\"',;&}])<>`", c); }
static int diag_url_stop(char c) { return !c || isspace((unsigned char)c) || strchr("\"'<>`\\", c); }

// Regra 2: o endereco em `p` (comeca com http:// ou https://). Escreve a versao limpa e devolve quantos bytes leu.
static size_t diag_url(Buf* out, const char* p) {
  const size_t scheme = !strncasecmp(p, "https://", 8) ? 8 : 7;
  size_t end = scheme;
  while (!diag_url_stop(p[end])) ++end;
  size_t host_end = scheme;
  while (host_end < end && p[host_end] != '/' && p[host_end] != '?' && p[host_end] != '#') ++host_end;
  buf_add(out, p, scheme);
  size_t host = scheme;
  const char* at = memchr(p + scheme, '@', host_end - scheme);
  if (at) { buf_str(out, DIAG_HIDDEN "@"); host = (size_t)(at - p) + 1; }
  buf_add(out, p + host, host_end - host);
  char name[256];
  const size_t length = host_end - host < sizeof name - 1 ? host_end - host : sizeof name - 1;
  memcpy(name, p + host, length);
  name[length] = 0;
  lower_ascii(name);
  int private_host = 0;
  for (int i = 0; DIAG_PRIVATE_HOSTS[i] && !private_host; ++i) private_host = strstr(name, DIAG_PRIVATE_HOSTS[i]) != NULL;
  if (private_host) {
    if (host_end < end) buf_str(out, "/[...]");
    return end;
  }
  size_t path_end = host_end;
  while (path_end < end && p[path_end] != '?' && p[path_end] != '#') ++path_end;
  buf_add(out, p + host_end, path_end - host_end);
  if (path_end < end) buf_str(out, p[path_end] == '?' ? "?[...]" : "#[...]");
  return end;
}

// Regra 4: um nome de DIAG_SECRET_NAMES em `p` seguido de = ou :. Devolve quantos bytes leu (0 = nao e).
static size_t diag_named(Buf* out, const char* p, int quoted_name) {
  for (int i = 0; DIAG_SECRET_NAMES[i]; ++i) {
    const size_t n = strlen(DIAG_SECRET_NAMES[i]);
    if (strncasecmp(p, DIAG_SECRET_NAMES[i], n) || diag_alnum(p[n]) || p[n] == '_' || p[n] == '-') continue;
    size_t at = n;
    if (p[at] == '"') ++at;
    while (p[at] == ' ' || p[at] == '\t') ++at;
    if (p[at] != '=' && p[at] != ':') continue;
    ++at;
    while (p[at] == ' ' || p[at] == '\t') ++at;
    // um objeto, uma lista, null/true/false, ou nada: nao e um valor secreto
    if (!p[at] || p[at] == '{' || p[at] == '[' || p[at] == '\n' || p[at] == '\r' || !strncmp(p + at, "null", 4) ||
        !strncmp(p + at, "true", 4) || !strncmp(p + at, "false", 5)) return 0;
    int whole_line = 0;
    for (int k = 0; DIAG_LINE_NAMES[k]; ++k) whole_line |= !strcasecmp(DIAG_SECRET_NAMES[i], DIAG_LINE_NAMES[k]);
    if (p[at] == '"') {
      buf_add(out, p, at + 1);
      buf_str(out, DIAG_HIDDEN);
      ++at;
      while (p[at] && p[at] != '"' && p[at] != '\n') at += p[at] == '\\' && p[at + 1] ? 2 : 1;
      return at; // a aspa de fechamento segue como texto
    }
    buf_add(out, p, at);
    buf_str(out, quoted_name ? "\"" DIAG_HIDDEN "\"" : DIAG_HIDDEN);
    if (whole_line && !quoted_name) while (p[at] && p[at] != '\n' && p[at] != '\r') ++at;
    else while (!diag_stop(p[at])) ++at;
    return at;
  }
  return 0;
}

// Regra 5: um e-mail em `p` (comeco de palavra). Devolve o tamanho (0 = nao e).
static size_t diag_email(const char* p) {
  size_t local = 0;
  while (local < 64 && diag_mailch(p[local])) ++local;
  if (!local || p[local] != '@') return 0;
  size_t at = local + 1, label = 0, dots = 0, last = 0;
  for (;; ++at) {
    const char c = p[at];
    if (diag_alnum(c) || c == '-') { ++label; continue; }
    if (c == '.' && label) { ++dots; last = 0; label = 0; continue; }
    break;
  }
  // o ultimo rotulo: letras, 2 ou mais
  for (size_t k = at; k > local + 1 && p[k - 1] != '.'; --k) { if (!isalpha((unsigned char)p[k - 1])) return 0; ++last; }
  return dots && label && last >= 2 ? at : 0;
}

// Regra 6: um token solto em `p` (comeco de trecho [A-Za-z0-9_-]). Devolve o tamanho do trecho e se e segredo.
static size_t diag_token_run(const char* p, int* secret) {
  size_t n = 0;
  while (diag_tokch(p[n])) ++n;
  *secret = 0;
  for (int i = 0; DIAG_TOKEN_PREFIXES[i]; ++i) if (!strncmp(p, DIAG_TOKEN_PREFIXES[i], strlen(DIAG_TOKEN_PREFIXES[i])) && n > strlen(DIAG_TOKEN_PREFIXES[i]) + 8) *secret = 1;
  if (n == 36) { // UUID 8-4-4-4-12
    int uuid = 1;
    for (size_t i = 0; i < 36 && uuid; ++i) uuid = i == 8 || i == 13 || i == 18 || i == 23 ? p[i] == '-' : diag_hexch(p[i]);
    if (uuid) *secret = 1;
  }
  for (size_t start = 0; start < n && !*secret;) { // um pedaco sem - ou _ de 32+ com letras e digitos
    size_t end = start;
    int letters = 0, digits = 0;
    while (end < n && diag_alnum(p[end])) { letters += isalpha((unsigned char)p[end]) != 0; digits += isdigit((unsigned char)p[end]) != 0; ++end; }
    if (end - start >= 32 && letters && digits) *secret = 1;
    start = end + 1;
  }
  return n;
}

// O texto limpo (malloc; NULL sem memoria). `in` termina com \0.
static char* diag_clean(const char* in, size_t size, const DiagSecrets* known, size_t* out_size) {
  Buf out = {0};
  buf_add(&out, "", 0);
  for (size_t i = 0; i < size && !out.failed;) {
    const char* p = in + i;
    const char prev = i ? in[i - 1] : ' ';
    size_t used = 0;
    // 1
    for (int k = 0; k < known->count && !used; ++k) {
      const size_t n = strlen(known->value[k]);
      if (*p == known->value[k][0] && !strncmp(p, known->value[k], n)) { buf_str(&out, DIAG_HIDDEN); used = n; }
    }
    if (used) { i += used; continue; }
    // 2
    if ((*p == 'h' || *p == 'H') && !diag_alnum(prev) && (!strncasecmp(p, "http://", 7) || !strncasecmp(p, "https://", 8))) { i += diag_url(&out, p); continue; }
    // 3
    if (!diag_alnum(prev) && (!strncasecmp(p, "bearer ", 7) || !strncmp(p, "Basic ", 6))) {
      size_t at = *p == 'B' && p[1] == 'a' ? 6 : 7;
      while (p[at] == ' ') ++at;
      if (!diag_stop(p[at])) {
        buf_add(&out, p, at);
        buf_str(&out, DIAG_HIDDEN);
        while (!diag_stop(p[at])) ++at;
        i += at;
        continue;
      }
    }
    // 4
    if (!diag_alnum(prev) && isalpha((unsigned char)*p) && (used = diag_named(&out, p, prev == '"'))) { i += used; continue; }
    // 5
    if (diag_mailch(*p) && !diag_mailch(prev) && (used = diag_email(p))) { buf_str(&out, "[email]"); i += used; continue; }
    // 6
    if (diag_tokch(*p) && !diag_tokch(prev)) {
      int secret = 0;
      used = diag_token_run(p, &secret);
      if (secret) { buf_str(&out, DIAG_HIDDEN); i += used; continue; }
      // nada no trecho: segue um caractere por vez (a regra 4 pode comecar depois de um - ou _)
    }
    buf_add(&out, p, 1);
    ++i;
  }
  if (out.failed) { free(out.data); return NULL; }
  *out_size = out.size;
  return out.data;
}

// ---- Os arquivos -------------------------------------------------------------------------------------------
typedef struct { char name[48]; char* data; size_t size; int cut; } DiagFile;
typedef struct { DiagFile file[DIAG_MAX_FILES]; int count; char missing[400]; } DiagSet;

static void diag_set_free(DiagSet* s) {
  for (int i = 0; i < s->count; ++i) { if (s->file[i].data) memset(s->file[i].data, 0, s->file[i].size); free(s->file[i].data); }
  memset(s, 0, sizeof *s);
}
// Os ultimos `cap` bytes de `path` (comecando numa linha inteira quando corta). NULL se nao existe/vazio.
static char* diag_tail(const char* path, size_t cap, size_t* size, int* cut) {
  *cut = 0;
  int fd = open(path, O_RDONLY);
  if (fd < 0) return NULL;
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0) { close(fd); return NULL; }
  size_t want = (size_t)st.st_size;
  off_t from = 0;
  if (want > cap) { from = st.st_size - (off_t)cap; want = cap; *cut = 1; }
  char* text = malloc(want + 1);
  if (!text) { close(fd); return NULL; }
  size_t got = 0;
  while (got < want) {
    ssize_t n = pread(fd, text + got, want - got, from + (off_t)got);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    got += (size_t)n;
  }
  close(fd);
  text[got] = 0;
  if (*cut) {
    char* line = memchr(text, '\n', got);
    if (line && (size_t)(line - text) + 1 < got) { const size_t skip = (size_t)(line - text) + 1; memmove(text, text + skip, got - skip + 1); got -= skip; }
  }
  for (size_t i = 0; i < got; ++i) if (!text[i]) text[i] = ' '; // um \0 no meio cortaria o texto na limpeza
  *size = got;
  if (!got) { free(text); return NULL; }
  return text;
}
static void diag_missing(DiagSet* s, const char* name) {
  const size_t n = strlen(s->missing);
  snprintf(s->missing + n, sizeof s->missing - n, "%s%s", n ? "," : "", name);
}
// Junta o texto ja limpo (fica com `text`).
// Existe? Pelo uid efetivo (stat), nunca access() (ver diag_collect).
static int diag_exists(const char* path) { struct stat st; return !stat(path, &st) && S_ISREG(st.st_mode); }
static void diag_put_file(DiagSet* s, const char* name, char* text, size_t size, int cut, const DiagSecrets* known) {
  if (s->count >= DIAG_MAX_FILES) { free(text); return; }
  size_t clean_size = 0;
  char* clean = diag_clean(text, size, known, &clean_size);
  memset(text, 0, size);
  free(text);
  if (!clean) { diag_missing(s, name); return; }
  DiagFile* f = &s->file[s->count++];
  copy_text(f->name, sizeof f->name, name);
  f->data = clean;
  f->size = clean_size;
  f->cut = cut;
}
static void diag_add_path(DiagSet* s, const char* name, const char* path, const DiagSecrets* known) {
  size_t size = 0;
  int cut = 0;
  char* text = diag_tail(path, DIAG_TAIL, &size, &cut);
  if (!text) { diag_missing(s, name); return; }
  // glibren.60: as linhas do jobeeslair.log so tem a hora (o motor JS do console nao monta datas): a data da ultima
  // gravacao vai numa linha no comeco, para ler o diagnostico sem adivinhar o dia.
  struct stat st;
  if (!strncmp(name, "jobeeslair", 10) && !stat(path, &st)) {
    char head[160], when[32] = "?";
    struct tm tm;
    const time_t mtime = st.st_mtime;
    if (localtime_r(&mtime, &tm)) strftime(when, sizeof when, "%Y-%m-%d %H:%M:%S", &tm);
    const int n = snprintf(head, sizeof head, "# %s: ultima gravacao em %s (relogio do console); as linhas abaixo so tem a hora\n", name, when);
    char* joined = n > 0 ? malloc(size + (size_t)n + 1) : NULL;
    if (joined) {
      memcpy(joined, head, (size_t)n);
      memcpy(joined + n, text, size);
      joined[size + (size_t)n] = 0;
      free(text);
      text = joined;
      size += (size_t)n;
    }
  }
  diag_put_file(s, name, text, size, cut, known);
}

typedef struct { Buf* b; size_t cap; } DiagSink;
static size_t diag_on_body(char* data, size_t size, size_t count, void* ctx) {
  DiagSink* sink = ctx;
  const size_t n = size * count;
  if (sink->b->size + n > sink->cap) return 0;
  buf_add(sink->b, data, n);
  return sink->b->failed ? 0 : n;
}
// O diario do glibren (outro payload, 127.0.0.1:8765, GET /diario; pedido local e isento do pareamento).
static void diag_add_glibren(DiagSet* s, const DiagSecrets* known) {
  char url[256];
  snprintf(url, sizeof url, "%.200s/diario", g_glibren_base);
  CURL* curl = curl_easy_init();
  if (!curl) { diag_missing(s, "glibren.log"); return; }
  Buf b = {0};
  DiagSink sink = {&b, 16u * 1024 * 1024};
  configure_transport(curl, url);
  curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 3L);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, diag_on_body);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &sink);
  const CURLcode result = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_cleanup(curl);
  if (result != CURLE_OK || status != 200 || !b.data || !b.size) { free(b.data); diag_missing(s, "glibren.log"); return; }
  size_t from = 0;
  int cut = 0;
  if (b.size > DIAG_TAIL) {
    from = b.size - DIAG_TAIL;
    cut = 1;
    const char* line = memchr(b.data + from, '\n', b.size - from);
    if (line) from = (size_t)(line - b.data) + 1;
  }
  const size_t size = b.size - from;
  char* text = malloc(size + 1);
  if (text) {
    memcpy(text, b.data + from, size);
    text[size] = 0;
    for (size_t i = 0; i < size; ++i) if (!text[i]) text[i] = ' ';
  }
  free(b.data);
  if (!text) { diag_missing(s, "glibren.log"); return; }
  diag_put_file(s, "glibren.log", text, size, cut, known);
}

// ---- O que o app manda (POST /diag/send): a Memoria e as versoes, gravadas para a pagina do celular tambem --------
typedef struct { char jobe[48], tube[48], title[16]; const char* memory; size_t memory_size; } DiagApp;
static void diag_clean_version(char* text) {
  if (strspn(text, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+-") != strlen(text)) text[0] = 0;
}
static int diag_versions_field(JP* jp, const char* key, void* ctx) {
  DiagApp* a = ctx;
  char* out = !strcmp(key, "jobe") ? a->jobe : !strcmp(key, "tube") ? a->tube : !strcmp(key, "title") ? a->title : NULL;
  if (!out) return 0;
  const size_t cap = out == a->title ? sizeof a->title : sizeof a->jobe;
  return lib_text(jp, out, cap) ? 1 : -1;
}
static int diag_app_field(JP* jp, const char* key, void* ctx) {
  DiagApp* a = ctx;
  if (!strcmp(key, "memory")) {
    jp_ws(jp);
    const char* start = jp->p;
    if (!jp_skip(jp)) return -1;
    if (*start == '{' && (size_t)(jp->p - start) <= DIAG_MEMORY_MAX) { a->memory = start; a->memory_size = (size_t)(jp->p - start); }
    return 1;
  }
  if (!strcmp(key, "versions")) {
    jp_ws(jp);
    if (jp->p < jp->end && *jp->p == '{') return jp_object(jp, diag_versions_field, a) ? 1 : -1;
    return 0;
  }
  return 0;
}
static int diag_title_ok(const char* title) {
  return strlen(title) == 9 && strspn(title, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") == 4 && strspn(title + 4, "0123456789") == 5;
}
// 1 = gravou <diag>/app-info.json.
static int diag_save_app(const DiagApp* a) {
  Buf b = {0};
  buf_fmt(&b, "{\"at\":%lld,\"jobe\":", (long long)now_s());
  buf_json(&b, a->jobe);
  buf_str(&b, ",\"tube\":");
  buf_json(&b, a->tube);
  buf_str(&b, ",\"title\":");
  buf_json(&b, a->title);
  buf_str(&b, ",\"memory\":");
  if (a->memory) buf_add(&b, a->memory, a->memory_size); else buf_str(&b, "null");
  buf_str(&b, "}\n");
  int ok = 0;
  if (!b.failed && b.data && !mkdir_p(g_diag_dir)) {
    chmod(g_diag_dir, 0700);
    char path[600];
    snprintf(path, sizeof path, "%.500s/app-info.json", g_diag_dir);
    ok = save_atomic(path, b.data, b.size, 0600);
  }
  free(b.data);
  return ok;
}
// O titulo do app em app-info.json (para achar o jobeeslair.log); BG_TITLE sem ele.
typedef struct { char title[16]; } DiagTitle;
static int diag_title_field(JP* jp, const char* key, void* ctx) {
  if (strcmp(key, "title")) return 0;
  return lib_text(jp, ((DiagTitle*)ctx)->title, sizeof ((DiagTitle*)ctx)->title) ? 1 : -1;
}

// Junta tudo (ja limpo) em `s`; `folder` e `from` vao no info.json.
static void diag_collect(DiagSet* s, const char* folder, const char* from) {
  memset(s, 0, sizeof *s);
  DiagSecrets known;
  diag_known_secrets(&known);
  char path[700];
  // o app-info.json (versoes + Memoria) que o app mandou por ultimo
  snprintf(path, sizeof path, "%.500s/app-info.json", g_diag_dir);
  size_t info_size = 0;
  char* app_info = read_text(path, 256 * 1024, &info_size);
  DiagTitle title = {""};
  if (app_info) { JP jp = {app_info, app_info + info_size, 0}; if (!jp_object(&jp, diag_title_field, &title)) title.title[0] = 0; }
  if (!diag_title_ok(title.title)) copy_text(title.title, sizeof title.title, BG_TITLE);
  // jobeeslair.log do app (e o anterior, .1), bgdl.log do payload (e o .old), tube.log (e o .1)
  snprintf(path, sizeof path, "%.400s/%s/logs/jobeeslair.log", g_app_logs_root, title.title);
  diag_add_path(s, "jobeeslair.log", path, &known);
  snprintf(path, sizeof path, "%.400s/%s/logs/jobeeslair.1.log", g_app_logs_root, title.title);
  diag_add_path(s, "jobeeslair.1.log", path, &known);
  diag_add_path(s, "bgdl.log", g_log_path, &known);
  snprintf(path, sizeof path, "%.600s.old", g_log_path);
  diag_add_path(s, "bgdl.log.old", path, &known);
  snprintf(path, sizeof path, "%.500s/tube.log", g_tube_dir);
  diag_add_path(s, "tube.log", path, &known);
  snprintf(path, sizeof path, "%.500s/tube.log.1", g_tube_dir);
  diag_add_path(s, "tube.log.1", path, &known);
  // a queda da sessao anterior, a fila e a configuracao do payload (sem segredos: as regras tiram sal/hash do PIN)
  snprintf(path, sizeof path, "%.500s/last-crash.json", g_dir);
  diag_add_path(s, "last-crash.json", path, &known);
  snprintf(path, sizeof path, "%.500s/jobs.json", g_dir);
  diag_add_path(s, "jobs.json", path, &known);
  snprintf(path, sizeof path, "%.500s/config.json", g_dir);
  diag_add_path(s, "config.json", path, &known);
  // glibren.47: os resultados da pagina /teste (POST /api/teste/enviar) e o teste-estado.json, so quando existem
  // .56: com stat, nao access(). No PS5 o payload roda com o uid EFETIVO elevado e o REAL de outro usuario; access()
  // confere pelo real e a pasta do diagnostico e 0700: dava EACCES, e as medidas da /app e da /teste nunca iam junto
  // (rodadas 2026-11-13_211406/211434: o diario dizia "gravados", o info.json nem as listava). Pedido pelo teste sem o
  // arquivo: entra em "missing", para a falta aparecer.
  snprintf(path, sizeof path, "%.500s/teste-resultados.txt", g_diag_dir);
  if (diag_exists(path)) diag_add_path(s, "teste-resultados.txt", path, &known);
  else if (!strcmp(from, "teste")) { diag_missing(s, "teste-resultados.txt"); logf_("diagnostico: teste-resultados.txt nao achado (%s)", strerror(errno)); }
  snprintf(path, sizeof path, "%.500s/teste-estado.json", g_dir);
  if (diag_exists(path)) diag_add_path(s, "teste-estado.json", path, &known);
  diag_add_glibren(s, &known);
  // info.json: versoes, a Memoria do app, de onde veio o pedido e o que foi junto
  Buf b = {0};
  buf_str(&b, "{\"folder\":");
  buf_json(&b, folder);
  buf_str(&b, ",\"from\":");
  buf_json(&b, from);
  buf_fmt(&b, ",\"payload\":{\"version\":\"%s\",\"build\":\"%s\",\"api\":%d},\"app\":", BG_VERSION, BG_BUILD, BG_API);
  if (app_info && info_size) buf_add(&b, app_info, info_size); else buf_str(&b, "null");
  buf_str(&b, ",\"files\":[");
  for (int i = 0; i < s->count; ++i) {
    buf_str(&b, i ? ",{\"name\":" : "{\"name\":");
    buf_json(&b, s->file[i].name);
    buf_fmt(&b, ",\"bytes\":%zu,\"cut\":%s}", s->file[i].size, s->file[i].cut ? "true" : "false");
  }
  buf_str(&b, "],\"missing\":");
  buf_json(&b, s->missing);
  buf_str(&b, "}\n");
  if (app_info) { memset(app_info, 0, info_size); free(app_info); }
  if (!b.failed && b.data) diag_put_file(s, "info.json", b.data, b.size, 0, &known);
  else free(b.data);
  memset(&known, 0, sizeof known);
  // .56: o info.json vai PRIMEIRO. Ele lista os arquivos da rodada: uma pasta baixada no meio do envio (a 211434 veio
  // sem ele porque foi lida antes do ultimo PUT) mostra o que ainda falta chegar.
  if (s->count > 1 && !strcmp(s->file[s->count - 1].name, "info.json")) {
    const DiagFile info = s->file[s->count - 1];
    memmove(&s->file[1], &s->file[0], sizeof s->file[0] * (size_t)(s->count - 1));
    s->file[0] = info;
  }
}

// ---- O envio -----------------------------------------------------------------------------------------------
static size_t diag_discard(char* data, size_t size, size_t count, void* ctx) { (void)data; (void)ctx; return size * count; }
// Um PUT. O codigo HTTP, ou -1 sem resposta (sem internet).
static long diag_put(const char* key, const char* folder, const char* message, const DiagFile* f) {
  const size_t encoded = 4 * ((f->size + 2) / 3) + 1;
  unsigned char* base64 = malloc(encoded);
  if (!base64) return -2;
  EVP_EncodeBlock(base64, (const unsigned char*)f->data, (int)f->size);
  Buf body = {0};
  buf_str(&body, "{\"message\":");
  buf_json(&body, message);
  buf_str(&body, ",\"committer\":" DIAG_COMMITTER ",\"branch\":\"main\",\"content\":\"");
  buf_str(&body, (const char*)base64);
  buf_str(&body, "\"}");
  free(base64);
  if (body.failed || !body.data) { free(body.data); return -2; }
  char url[700];
  snprintf(url, sizeof url, "%.250s" DIAG_REPO_PATH "%s/%s", g_github_base, folder, f->name);
  CURL* curl = curl_easy_init();
  if (!curl) { free(body.data); return -1; }
  configure_transport(curl, url); // HTTPS com o certificado conferido (CA_LIST do PS5), como TorBox/GitHub
  curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L); // a chave nunca segue um redirecionamento
  curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.data);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)body.size);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 180L);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, diag_discard);
  char auth[300];
  snprintf(auth, sizeof auth, "Authorization: Bearer %s", key);
  struct curl_slist* headers = curl_slist_append(NULL, auth);
  memset(auth, 0, sizeof auth);
  headers = curl_slist_append(headers, "Accept: application/vnd.github+json");
  headers = curl_slist_append(headers, "X-GitHub-Api-Version: 2022-11-28");
  headers = curl_slist_append(headers, "Content-Type: application/json");
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  const CURLcode result = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_cleanup(curl);
  // a lista de cabecalhos tem a chave: apaga antes de soltar
  for (struct curl_slist* h = headers; h; h = h->next) memset(h->data, 0, strlen(h->data));
  curl_slist_free_all(headers);
  free(body.data);
  return result == CURLE_OK ? status : -1;
}

static void diag_finish(const char* state, const char* error, long http) {
  pthread_mutex_lock(&g_diag_lock);
  snprintf(g_diag.state, sizeof g_diag.state, "%s", state);
  snprintf(g_diag.error, sizeof g_diag.error, "%s", error);
  g_diag.http = http;
  g_diag.running = 0;
  g_diag.at = now_s();
  pthread_mutex_unlock(&g_diag_lock);
}
static void diag_folder(char* out, size_t cap) {
  if (g_diag_fixed_folder[0]) { copy_text(out, cap, g_diag_fixed_folder); return; }
  time_t now = time(NULL);
  struct tm tm;
  localtime_r(&now, &tm);
  if (!strftime(out, cap, "%Y-%m-%d_%H%M%S", &tm)) copy_text(out, cap, "sem-data");
}

typedef struct { char from[12], folder[24]; } DiagJob;
static void* diag_thread(void* arg) {
  DiagJob job = *(DiagJob*)arg;
  free(arg);
  char key[256];
  if (!diag_read_key(key, sizeof key)) { diag_finish("failed", "no-key", 0); return NULL; }
  DiagSet* s = malloc(sizeof *s);
  if (!s) { memset(key, 0, sizeof key); diag_finish("failed", "memory", 0); return NULL; }
  diag_collect(s, job.folder, job.from);
  // a versao da Jobe (do app-info.json) vai na mensagem do commit
  char version[48] = "?";
  for (int i = 0; i < s->count; ++i) {
    if (strcmp(s->file[i].name, "info.json")) continue;
    const char* at = strstr(s->file[i].data, "\"jobe\":\"");
    if (at) { at += 8; size_t n = strcspn(at, "\""); if (n && n < sizeof version) { memcpy(version, at, n); version[n] = 0; } }
  }
  char message[120];
  snprintf(message, sizeof message, "diagnostico %s %s", job.folder, version);
  pthread_mutex_lock(&g_diag_lock);
  g_diag.total = s->count;
  pthread_mutex_unlock(&g_diag_lock);
  long status = 0;
  int sent = 0;
  for (int i = 0; i < s->count; ++i) {
    // glibren.60: sem resposta, 409 (dois commits ao mesmo tempo no repositorio), 429 ou 5xx: ate 3 novas tentativas
    // (2, 5 e 10 s; BGDL_DIAG_RETRY_MS no PC). Um 422 numa nova tentativa e o arquivo que ja tinha subido (a resposta
    // se perdeu): conta como enviado. Antes, uma falha de rede no meio perdia a rodada inteira.
    static const int waits[] = {2000, 5000, 10000};
    int64_t unit = atoll(env_or("BGDL_DIAG_RETRY_MS", "0"));
    for (int attempt = 0;; ++attempt) {
      status = diag_put(key, job.folder, message, &s->file[i]);
      if (attempt && status == 422) status = 201;
      const int again = status == -1 || status == 409 || status == 429 || status >= 500;
      if (!again || attempt >= 3) break;
      logf_("diagnostico: %s tentativa %d falhou (%s%ld); tenta de novo", s->file[i].name, attempt + 1, status == -1 ? "sem resposta" : "HTTP ", status == -1 ? 0L : status);
      sleep_ms(unit > 0 ? (int)unit : waits[attempt]);
    }
    if (status != 200 && status != 201) break;
    pthread_mutex_lock(&g_diag_lock);
    g_diag.sent = ++sent;
    pthread_mutex_unlock(&g_diag_lock);
  }
  memset(key, 0, sizeof key);
  const int total = s->count;
  diag_set_free(s);
  free(s);
  if (!total) { diag_finish("failed", "nothing", 0); logk_("diagnostico: nada para enviar"); return NULL; }
  if (sent == total) {
    diag_finish("done", "", status);
    logk_("diagnostico: enviado (%d arquivo(s), pasta %s, pedido pelo %s)", sent, job.folder, job.from);
    return NULL;
  }
  const char* error = status == -1 ? "network" : status == -2 ? "memory" : status == 401 ? "unauthorized" : status == 403 ? "forbidden" : status == 404 ? "no-repo" : "http";
  diag_finish("failed", error, status > 0 ? status : 0);
  logk_("diagnostico: falhou (%s, HTTP %ld) depois de %d de %d arquivo(s), pasta %s", error, status > 0 ? status : 0, sent, total, job.folder);
  return NULL;
}

// Comeca uma rodada. 200 / 400 no-key / 409 busy / 500.
static int diag_start(const char* from, char* error, size_t cap) {
  char key[256];
  const int has = diag_read_key(key, sizeof key);
  memset(key, 0, sizeof key);
  if (!has) { copy_text(error, cap, "no-key"); return 400; }
  DiagJob* job = calloc(1, sizeof *job);
  if (!job) { copy_text(error, cap, "memory"); return 500; }
  copy_text(job->from, sizeof job->from, from);
  diag_folder(job->folder, sizeof job->folder);
  pthread_mutex_lock(&g_diag_lock);
  if (g_diag.running) { pthread_mutex_unlock(&g_diag_lock); free(job); copy_text(error, cap, "busy"); return 409; }
  // a mesma hora da rodada anterior: -2, -3...
  if (!strcmp(job->folder, g_diag_last_folder)) {
    char base[24];
    copy_text(base, sizeof base, job->folder);
    if (g_diag_folder_uses < 99) ++g_diag_folder_uses;
    snprintf(job->folder, sizeof job->folder, "%.17s-%u", base, (unsigned)g_diag_folder_uses % 100u);
  } else {
    copy_text(g_diag_last_folder, sizeof g_diag_last_folder, job->folder);
    g_diag_folder_uses = 1;
  }
  g_diag.running = 1;
  copy_text(g_diag.state, sizeof g_diag.state, "running");
  copy_text(g_diag.folder, sizeof g_diag.folder, job->folder);
  g_diag.error[0] = 0;
  g_diag.http = 0;
  g_diag.sent = g_diag.total = 0;
  g_diag.at = now_s();
  pthread_mutex_unlock(&g_diag_lock);
  logk_("diagnostico: rodada pedida pelo %s (pasta %s)", from, job->folder);
  if (spawn_thread(diag_thread, job, NULL)) { free(job); diag_finish("failed", "memory", 0); copy_text(error, cap, "memory"); return 500; }
  return 200;
}
static void diag_reply_start(int fd, int app, const char* from) {
  char error[16] = "", body[96], folder[24] = "";
  const int status = diag_start(from, error, sizeof error);
  // .56: a pasta da rodada vai na resposta (a /app mostra "enviado para a pasta ...")
  if (status == 200) {
    pthread_mutex_lock(&g_diag_lock);
    copy_text(folder, sizeof folder, g_diag.folder);
    pthread_mutex_unlock(&g_diag_lock);
    snprintf(body, sizeof body, "{\"ok\":true,\"state\":\"running\",\"folder\":\"%s\"}", folder);
  }
  else snprintf(body, sizeof body, "{\"error\":\"%s\"}", error);
  if (app) respond(fd, status, body); else monitor_json(fd, status, body);
}
static void diag_reply_status(int fd, int app) {
  Buf b = {0};
  diag_status_json(&b);
  const char* body = b.failed || !b.data ? "{\"error\":\"out of memory\"}" : b.data;
  const int status = b.failed || !b.data ? 500 : 200;
  if (app) respond(fd, status, body); else monitor_json(fd, status, body);
  free(b.data);
}

// ---- O .zip (libarchive, na memoria) -----------------------------------------------------------------------
static la_ssize_t diag_zip_write(struct archive* a, void* ctx, const void* data, size_t size) {
  (void)a;
  Buf* b = ctx;
  buf_add(b, data, size);
  return b->failed ? -1 : (la_ssize_t)size;
}
static int diag_zip(const DiagSet* s, const char* folder, Buf* out) {
  struct archive* a = archive_write_new();
  if (!a) return 0;
  int ok = archive_write_set_format_zip(a) == ARCHIVE_OK;
  if (ok) archive_write_set_options(a, "zip:compression=deflate"); // sem zlib fica "store" (tudo bem)
  if (ok) archive_write_set_bytes_in_last_block(a, 1);
  if (ok) ok = archive_write_open(a, out, NULL, diag_zip_write, NULL) == ARCHIVE_OK;
  for (int i = 0; ok && i < s->count; ++i) {
    struct archive_entry* e = archive_entry_new();
    if (!e) { ok = 0; break; }
    char name[128];
    snprintf(name, sizeof name, "%s/%s", folder, s->file[i].name);
    archive_entry_set_pathname(e, name);
    archive_entry_set_filetype(e, AE_IFREG);
    archive_entry_set_perm(e, 0644);
    archive_entry_set_size(e, (la_int64_t)s->file[i].size);
    archive_entry_set_mtime(e, time(NULL), 0);
    ok = archive_write_header(a, e) == ARCHIVE_OK && archive_write_data(a, s->file[i].data, s->file[i].size) == (la_ssize_t)s->file[i].size;
    archive_entry_free(e);
  }
  if (archive_write_close(a) != ARCHIVE_OK) ok = 0;
  archive_write_free(a);
  return ok && !out->failed && out->data;
}
static void diag_zip_route(int fd) {
  char folder[24];
  diag_folder(folder, sizeof folder);
  DiagSet* s = malloc(sizeof *s);
  if (!s) { monitor_json(fd, 500, "{\"error\":\"memory\"}"); return; }
  diag_collect(s, folder, "celular-zip");
  Buf out = {0};
  const int ok = diag_zip(s, folder, &out);
  diag_set_free(s);
  free(s);
  if (!ok) { free(out.data); monitor_json(fd, 500, "{\"error\":\"zip\"}"); return; }
  logk_("diagnostico: .zip baixado pelo celular (%zu bytes)", out.size);
  monitor_send(fd, 200, "application/zip", out.data, out.size);
  memset(out.data, 0, out.size);
  free(out.data);
}

// ---- Rotas -------------------------------------------------------------------------------------------------
typedef struct { char key[256]; } DiagKeyBody;
static int diag_key_field(JP* jp, const char* key, void* ctx) {
  if (strcmp(key, "key")) return 0;
  return jp_text(jp, ((DiagKeyBody*)ctx)->key, sizeof ((DiagKeyBody*)ctx)->key) ? 1 : -1;
}
static void diag_key_save(int fd, Request* r) {
  DiagKeyBody k;
  memset(&k, 0, sizeof k);
  JP jp = {r->body, r->body + r->content_length, 0};
  const int parsed = r->body && jp_object(&jp, diag_key_field, &k);
  // espacos ou quebra de linha colados junto saem
  char* start = k.key;
  while (*start == ' ' || *start == '\t') ++start;
  size_t n = strlen(start);
  while (n && (start[n - 1] == ' ' || start[n - 1] == '\t')) start[--n] = 0;
  if (!parsed || !diag_key_ok(start)) { memset(&k, 0, sizeof k); monitor_json(fd, 400, "{\"error\":\"key\"}"); return; }
  char path[600];
  diag_key_path(path, sizeof path);
  int ok = !mkdir_p(g_diag_dir);
  if (ok) { chmod(g_diag_dir, 0700); ok = save_atomic(path, start, n, 0600); }
  if (ok) chmod(path, 0600);
  memset(&k, 0, sizeof k);
  if (!ok) { monitor_json(fd, 500, "{\"error\":\"not saved\"}"); return; }
  logk_("diagnostico: chave do GitHub gravada pela pagina do celular");
  diag_reply_status(fd, 0);
}

// Pagina do celular. 1 = tratou.
static int diag_monitor_route(int fd, Request* r) {
  if (strncmp(r->path, "/api/diag", 9) || (r->path[9] && r->path[9] != '/')) return 0;
  diag_init();
  if (!monitor_allowed(r)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return 1; }
  const int get = !strcmp(r->method, "GET"), post = !strcmp(r->method, "POST");
  if (get && !strcmp(r->path, "/api/diag")) diag_reply_status(fd, 0);
  else if (post && !strcmp(r->path, "/api/diag/key")) diag_key_save(fd, r);
  else if (post && !strcmp(r->path, "/api/diag/key/remove")) {
    char path[600];
    diag_key_path(path, sizeof path);
    if (!unlink(path)) logk_("diagnostico: chave do GitHub removida pela pagina do celular");
    diag_reply_status(fd, 0);
  } else if (post && !strcmp(r->path, "/api/diag/send")) diag_reply_start(fd, 0, "celular");
  else if (get && !strcmp(r->path, "/api/diag/zip")) diag_zip_route(fd);
  else monitor_json(fd, 404, "{\"error\":\"not found\"}");
  return 1;
}

// API do app (o token ja foi conferido). 1 = tratou.
static int diag_app_route(int fd, Request* r) {
  if (strcmp(r->path, "/diag") && strcmp(r->path, "/diag/send") && strcmp(r->path, "/diag/app")) return 0;
  diag_init();
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/diag")) { diag_reply_status(fd, 1); return 1; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/diag/send")) {
    DiagApp a;
    memset(&a, 0, sizeof a);
    JP jp = {r->body ? r->body : "", r->body ? r->body + r->content_length : "", 0};
    if (r->content_length && !jp_object(&jp, diag_app_field, &a)) { respond_error(fd, 400, "expected {memory, versions: {jobe, tube, title}}"); return 1; }
    diag_clean_version(a.jobe);
    diag_clean_version(a.tube);
    if (!diag_title_ok(a.title)) a.title[0] = 0;
    if (!diag_save_app(&a)) logf_("diagnostico: app-info.json nao gravado");
    diag_reply_start(fd, 1, "app");
    return 1;
  }
  // glibren.60: o app manda as versoes e a Memoria ao abrir e de tempos em tempos, sem enviar nada: um diagnostico pedido
  // pelo celular (app fechado) leva o app-info.json mais recente em vez de "app": null.
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/diag/app")) {
    DiagApp a;
    memset(&a, 0, sizeof a);
    JP jp = {r->body ? r->body : "", r->body ? r->body + r->content_length : "", 0};
    if (!r->content_length || !jp_object(&jp, diag_app_field, &a)) { respond_error(fd, 400, "expected {memory, versions: {jobe, tube, title}}"); return 1; }
    diag_clean_version(a.jobe);
    diag_clean_version(a.tube);
    if (!diag_title_ok(a.title)) a.title[0] = 0;
    // sem a versao da Jobe nao grava (um corpo vazio apagaria o app-info bom de antes)
    if (!a.jobe[0]) { respond_error(fd, 400, "expected {memory, versions: {jobe, tube, title}}"); return 1; }
    const int saved = diag_save_app(&a);
    if (!saved) logf_("diagnostico: app-info.json nao gravado");
    if (saved) respond(fd, 200, "{\"ok\":true}"); else respond_error(fd, 500, "not saved");
    return 1;
  }
  respond_error(fd, 404, "not found");
  return 1;
}
