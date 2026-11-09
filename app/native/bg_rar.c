// glibren.20b: RAR (cifrado ou nao) extraido pelo rar-extract.elf do proprio app (ps5-react native/rar_worker, a
// biblioteca UnRAR num programa separado, como o motor da Jobe faz: a licenca do UnRAR nao deixa liga-la a este
// payload GPL). A libarchive nao abre RAR com senha ("Encryption is not supported"), e os RAR do DLPSGAME sao todos
// cifrados. O payload manda o ELF ao carregador de payloads (elfldr, 127.0.0.1:9021) seguido do pedido "RARX1" e le as
// respostas pelo mesmo socket ("p <bytes>", "d <bytes>", "ok", "fail <motivo>"); uma senha errada passa para a
// proxima das conhecidas. O app copia /app0/rar-extract.elf para <bg>/rar-extract.elf ao subir o payload.
#define RAR_WINDOW (256ull * 1024 * 1024) // o dicionario maximo aceito (o app usa 32 MiB, com pouca memoria)
#define RAR_LOADER_PORT 9021

static int rar_name(const char* path) {
  const char* name = base_name(path);
  if (arc_ends(name, ".rar")) return 1;
  const size_t n = strlen(name);
  // volumes do jeito antigo: .r00, .r01, ...
  return n > 4 && name[n - 4] == '.' && (name[n - 3] == 'r' || name[n - 3] == 'R') && isdigit((unsigned char)name[n - 2]) && isdigit((unsigned char)name[n - 1]);
}

// O rar-extract.elf: o que o app deixou na pasta do payload, ou o do app instalado.
static int rar_elf_path(char* out, size_t cap) {
  struct stat st;
#ifndef __PROSPERO__
  const char* test = env_or("BGDL_RAR_ELF", "");
  if (test[0]) { copy_text(out, cap, test); return !stat(out, &st) && S_ISREG(st.st_mode); }
#endif
  snprintf(out, cap, "%s/rar-extract.elf", g_dir);
  if (!stat(out, &st) && S_ISREG(st.st_mode) && st.st_size > 0) return 1;
  snprintf(out, cap, "/system_ex/app/%s/rar-extract.elf", BG_TITLE);
  if (!stat(out, &st) && S_ISREG(st.st_mode) && st.st_size > 0) return 1;
  out[0] = 0;
  return 0;
}

static int rar_connect(void) {
  int port = RAR_LOADER_PORT;
#ifndef __PROSPERO__
  if (atoi(env_or("BGDL_ELFLDR_PORT", "0")) > 0) port = atoi(env_or("BGDL_ELFLDR_PORT", "0"));
#endif
  const int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof addr);
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)port);
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (struct sockaddr*)&addr, sizeof addr)) { close(fd); return -1; }
  return fd;
}

typedef struct { int ok, bad_password, unavailable; char reason[300]; } RarResult;

// Uma tentativa com uma senha ("" = sem senha). Le as respostas ate "ok", "cancelled" ou "fail".
static void rar_try(Conv* c, const char* elf, const char* work, const char* password, uint64_t limit, RarResult* res) {
  memset(res, 0, sizeof *res);
  const int file = open(elf, O_RDONLY);
  if (file < 0) { res->unavailable = 1; snprintf(res->reason, sizeof res->reason, "rar-extract.elf could not be opened (%s)", strerror(errno)); return; }
  const int fd = rar_connect();
  if (fd < 0) { close(file); res->unavailable = 1; snprintf(res->reason, sizeof res->reason, "the payload loader (port %d) did not answer", RAR_LOADER_PORT); return; }
  char block[65536];
  int sent = 1;
  for (ssize_t n; sent && (n = read(file, block, sizeof block)) != 0;) sent = n > 0 && send_all(fd, block, (size_t)n);
  close(file);
  Buf req = {0};
  buf_fmt(&req, "RARX1\nthreads 0\nwindow %llu\nlimit %llu\nreserved .jobe-rar-\n", (unsigned long long)RAR_WINDOW, (unsigned long long)limit);
  if (password[0]) {
    buf_str(&req, "password ");
    for (const unsigned char* p = (const unsigned char*)password; *p; ++p) buf_fmt(&req, "%02x", *p);
    buf_str(&req, "\n");
  }
  buf_fmt(&req, "dest %s\n", work);
  for (int i = 0; i < c->nsources; ++i) buf_fmt(&req, "source %s\n", c->sources[i]);
  if (!c->nsources) buf_fmt(&req, "source %s\n", c->source);
  buf_str(&req, "end\n");
  if (sent) sent = !req.failed && req.data && send_all(fd, req.data, req.size);
  free(req.data);
  if (!sent) { close(fd); res->unavailable = 1; snprintf(res->reason, sizeof res->reason, "rar-extract.elf could not be sent to the payload loader"); return; }
  char line[1200];
  size_t have = 0;
  int64_t last = mono_ms();
  int cancel_sent = 0;
  for (;;) {
    if ((c->cancel || g_stop) && !cancel_sent) { send_all(fd, "cancel\n", 7); cancel_sent = 1; }
    struct pollfd p = {fd, POLLIN, 0};
    const int ready = poll(&p, 1, 250);
    if (ready < 0 && errno == EINTR) continue;
    if (ready == 0) {
      // O trabalhador diz "k" a cada segundo: 2 minutos calado e porque morreu.
      if (mono_ms() - last > 120000) { snprintf(res->reason, sizeof res->reason, "rar-extract stopped answering"); break; }
      continue;
    }
    char chunk[4096];
    const ssize_t n = recv(fd, chunk, sizeof chunk, 0);
    if (n <= 0) { if (!res->reason[0]) snprintf(res->reason, sizeof res->reason, "rar-extract ended without an answer"); break; }
    last = mono_ms();
    int done = 0;
    for (ssize_t i = 0; i < n && !done; ++i) {
      if (chunk[i] != '\n') { if (have < sizeof line - 1) line[have++] = chunk[i]; continue; }
      line[have] = 0;
      have = 0;
      if (line[0] == 'p' && line[1] == ' ') {
        pthread_mutex_lock(&g_conv_lock);
        c->written = strtoull(line + 2, NULL, 10);
        pthread_mutex_unlock(&g_conv_lock);
      } else if (line[0] == 'd' && line[1] == ' ') {
        pthread_mutex_lock(&g_conv_lock);
        c->total = strtoull(line + 2, NULL, 10);
        pthread_mutex_unlock(&g_conv_lock);
      } else if (!strcmp(line, "ok")) {
        res->ok = 1;
        done = 1;
      } else if (!strcmp(line, "cancelled")) {
        snprintf(res->reason, sizeof res->reason, "cancelled");
        done = 1;
      } else if (!strncmp(line, "fail ", 5)) {
        copy_utf8(res->reason, sizeof res->reason, line + 5);
        res->bad_password = strstr(line, "password") != NULL;
        done = 1;
      }
    }
    if (done) break;
  }
  close(fd);
}

// Extrai o RAR de `c` em `work` tentando as senhas: as que vieram no pedido, as conhecidas dos sites e, por ultimo,
// nenhuma. 1 = extraido; 0 = err (com o motivo); -1 = sem rar-extract.elf ou sem o carregador (usa a libarchive).
static int rar_extract(Conv* c, const char* work, char* err, size_t cap) {
  char elf[600];
  if (!rar_elf_path(elf, sizeof elf)) { snprintf(err, cap, "rar-extract.elf not found (open Jobee'sLair once)"); return -1; }
  const char* tries[ARC_MAX_PASSWORDS + sizeof AUTO_PASSWORDS / sizeof *AUTO_PASSWORDS + 1];
  int count = 0;
  for (int i = 0; i < c->npasswords; ++i) tries[count++] = c->passwords[i];
  for (size_t i = 0; i < sizeof AUTO_PASSWORDS / sizeof *AUTO_PASSWORDS; ++i) {
    int seen = 0;
    for (int k = 0; k < count; ++k) if (!strcmp(tries[k], AUTO_PASSWORDS[i])) seen = 1;
    if (!seen) tries[count++] = AUTO_PASSWORDS[i];
  }
  tries[count++] = "";
  const uint64_t free_bytes = conv_free_bytes(c->root);
  const uint64_t limit = free_bytes > CONV_MARGIN ? free_bytes - CONV_MARGIN : 1;
  RarResult res;
  for (int i = 0; i < count; ++i) {
    conv_remove_tree(work, 0);
    mkdir_p(work);
    rar_try(c, elf, work, tries[i], limit, &res);
    if (res.ok) { logk_("conversao %s: RAR extraido pelo rar-extract%s", c->id, tries[i][0] ? " (com uma das senhas conhecidas)" : ""); return 1; }
    if (res.unavailable) { snprintf(err, cap, "%s", res.reason); return -1; }
    if (!res.bad_password) break;
  }
  snprintf(err, cap, "%s", res.bad_password ? "none of the known passwords opens this RAR" : res.reason);
  return 0;
}
