// Copyright (C) 2026 JVK3R and Jobee'sLair contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// bg-downloader.elf: downloads em segundo plano da Jobee'sLair (payload separado, como o companion_daemon).
//
// O app envia este ELF ao elfldr (127.0.0.1:9021, Payloads.send) e entrega a ele os downloads. O payload
// continua vivo quando o app fecha (ex.: o jogador abre um jogo), entao o download continua.
//
// - Uma copia so: flock em <dir>/bgdl.pid; a copia nova manda SIGTERM a antiga e espera o lock (a antiga grava
//   o checkpoint e sai limpa). Nome de processo proprio (sceKernelSetProcessName / thr_set_name).
// - API HTTP so em 127.0.0.1:<porta> com token (<dir>/token, 0600), exigido em toda chamada
//   (cabecalho "X-Jobe-Token: <token>" ou "Authorization: Bearer <token>"):
//     GET  /health                 {ok, version, pid, active}
//     GET  /jobs                   {jobs:[...]}
//     POST /jobs                   cria (corpo JSON, ver parse_job_body); 409 {id} se o destino ja tem job ativo
//     POST /jobs/<id>/pause|resume|cancel|release|forget|park
//                                  (glibren.8: park = a pausa do app; o job fica, pausado, na fila entregue)
//     POST /jobs/<id>/connections  glibren.8: {connections: 1..64 | 0 = as do app}, o mesmo do celular (abaixo)
//   Pagina do celular (porta 34201, sem token; as acoes exigem a sessao do PIN em X-Session):
//     GET  /api/status             {jobs:[{..., connectionsActive, connections (alvo), connectionsSet}], limit, maxLimit,
//                                  maxConnections, limitSet, pinSet}
//     POST /api/unlock             {pin} -> {session}
//     POST /api/jobs/<id>/pause|resume|cancel
//     POST /api/jobs/<id>/connections  glibren.8: {connections: 1..64 | 0/null = as do app} -> {ok, connections, connectionsSet}
//     POST /api/config             glibren.8: {concurrency: 1..4} -> {ok, limit, limitSet}; o app adota o numero
//     GET  /api/library[?filtros]  glibren: a Biblioteca TorBox (torbox-lista.json) resumida, filtrada e paginada; ver
//     GET  /api/library/game?id=   "Biblioteca TorBox na pagina do celular" abaixo
//     POST /api/library/add        {id, file?} com a sessao: o jogo entra na fila (pedido que o app poe na fila dele)
//     POST /jobs/<id>/refuse       glibren: {error} o app nao conseguiu por na fila um pedido do celular (fica "failed")
//     POST /secret                {service:"torbox", key} -> chave so em memoria (nunca gravada nem registrada)
//     POST /quit                   encerra limpo (checkpoint gravado)
//     POST /bye                    glibren.5: o app avisa que vai fechar (botao "Sair"): conta como fechado ja, sem
//                                  esperar o silencio, e aplica a pausa ao fechar conforme a opcao
// - Fila persistida em <dir>/jobs.json (tmp + fsync + rename + fsync da pasta). Um download por vez.
// - Varias conexoes por arquivo (faixas HTTP Range + If-Range, janela AIMD) e retomada no MESMO formato
//   .part/.resume/.complete do motor nativo do ps5-react (native/shared/network.cpp): o app e o payload
//   aproveitam as parciais um do outro. Offsets de 64 bits (arquivos > 4 GB).
// - TorBox: link vencido (401/403 ou idade > 2h30) -> pede outro (requestdl) com a chave do app (debrid_key()).
// - Repouso: SIGCONT e troca de IP (checada a cada 1 s) reabrem o servidor e reiniciam as conexoes.
//   Notificacao do sistema ao concluir/falhar. sceSystemServicePowerTick so com "powerTick": true no config.json
//   (desligado por padrao: chamada do sistema nunca validada fora de um app).
// - Ao concluir: imagens .exfat/.ffpkg/.ffpfs/.ffpfsc vao para publishTo (<disco>/homebrew/<nome>) se o app nao
//   estiver aberto; o resto fica "aguardando o app" (extrair/instalar quando a Jobe abrir).
// - Fechar a Jobe (glibren-fechar): o payload percebe o fechamento (sceLncUtilGetAppId a cada 1 s, como o
//   sandbox-sweeper; ou o app calado) e fica QUIETO por um tempo (sem rede, sem disco, sem comecar job, sem mover
//   imagem) enquanto o sistema desmonta o app, o sandbox-sweeper limpa o sandbox e o ShadowMount+ solta a imagem.
//   Depois volta devagar (janela de conexoes recomeca em 2). glibren.5: o tempo da pausa e uma opcao do app
//   ("pauseOnCloseSeconds" no POST /config, 0 a 30 s, padrao 30); 0 = nada fica quieto ao fechar. Sempre: no maximo CONN_BUDGET conexoes somando todos
//   os jobs, checkpoint (fsync) a cada 15 s com o app fechado, e pausas curtas na conferencia SHA-256 e nos lacos.
// - Diario em <dir>/bgdl.log (girado para .old acima de 1 MiB), com fsync nas linhas importantes para sobreviver a
//   um travamento: inicio (e se a sessao anterior terminou limpa), abrir/fechar do app, modo quieto, pulso a cada
//   60 s enquanto ha trabalho, inicio/fim de job, sinais fatais e a saida limpa.
//
// Compila para o PS5 (prospero-clang, __PROSPERO__) e para Linux (testes: variaveis BGDL_* abaixo).
#ifndef __PROSPERO__
#define _GNU_SOURCE
#endif
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include <curl/curl.h>
#include <openssl/evp.h>

#define BG_VERSION "1.0.0"
#define BG_PROCESS "jobe-bgdl.elf"
#define BG_TITLE "PPSA99471"
#define DEFAULT_PORT 34200
#define MAX_JOBS 64
// MODIFIED (glibren.8): 64 conexoes por job no maximo (era 32), so quando o jogador escolhe o numero no celular
// (POST /api/jobs/<id>/connections). O numero que o app manda continua limitado a AUTO_CONNS, como antes.
#define MAX_CONNS 64
#define AUTO_CONNS 32
#define MAX_WORKERS 4 // downloads simultaneos: ate 4 jobs, cada um na sua thread e com seu Engine (POST /config)
#define MAX_RANGES 65536
#define DEFAULT_RANGE (32ull * 1024 * 1024) // o padrao do motor nativo (network.hpp)
#define RENEW_AGE_S 9000                      // 2h30: os links do TorBox valem 3 h
#define MAX_RENEWALS 6
#define LOG_LIMIT (1024 * 1024)
#define SAFE_INTEGER 9007199254740991ULL
#define BG_BUILD "glibren-fechar"
#define CONN_BUDGET 32           // conexoes somando todos os jobs (cada job tem no minimo 2)
#define MANUAL_BUDGET 64         // glibren.8: a soma quando algum job baixando tem o numero escolhido no celular
#define CHECKPOINT_MS 5000       // checkpoint (fsync da parcial) com o app aberto
#define CHECKPOINT_AWAY_MS 15000 // com o app fechado: menos fsync no disco que o sistema esta usando
#define HEARTBEAT_MS 60000       // "pulso" no diario enquanto ha trabalho

#ifdef __PROSPERO__
#include <sys/syscall.h>
typedef struct {
  char reserved[45];
  char message[3075];
} NotifyRequest;
int sceKernelSendNotificationRequest(int, NotifyRequest*, size_t, int);
// weak: o payload carrega mesmo num firmware sem estas funcoes (a chamada vira NULL e e pulada).
int sceKernelSetProcessName(const char*) __attribute__((weak));
int sceSystemServicePowerTick(void) __attribute__((weak));
int sceLncUtilGetAppId(const char*) __attribute__((weak));
#define SO_NBIO_PS5 0x1200
#endif

// Copia texto cortando no limite (no lugar de snprintf "%s", que o gcc acusa de truncar com -Werror).
static void copy_text(char* out, size_t cap, const char* text) {
  size_t n = strnlen(text, cap - 1);
  memcpy(out, text, n);
  out[n] = 0;
}

// ---- Configuracao ---------------------------------------------------------------------------------------

static char g_dir[512];
static int g_port = DEFAULT_PORT;
static char g_token[65];
static char g_cainfo[512];
static char g_torbox_base[256] = "https://api.torbox.app/v1/api";
static volatile sig_atomic_t g_stop, g_wake;
static int g_lock_fd = -1;

static const char* env_or(const char* name, const char* fallback) {
#ifdef __PROSPERO__
  (void)name;
  return fallback;
#else
  const char* value = getenv(name);
  return value && *value ? value : fallback;
#endif
}

// ---- Diario ---------------------------------------------------------------------------------------------

static pthread_mutex_t g_log_lock = PTHREAD_MUTEX_INITIALIZER;
static char g_log_path[600];

// Uma linha no diario. `critical`: fsync na hora (a linha sobrevive a um travamento do console); as outras fazem
// fsync no maximo a cada 2 s, para um diario cheio de falhas de rede nao virar uma rajada de fsync.
static int64_t g_log_synced_ms;
static int64_t log_mono_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static void log_line(int critical, const char* fmt, va_list args) {
  if (!g_log_path[0]) return;
  char line[1200];
  time_t now = time(NULL);
  struct tm tm;
  localtime_r(&now, &tm);
  size_t n = strftime(line, sizeof line, "%Y-%m-%d %H:%M:%S ", &tm);
  vsnprintf(line + n, sizeof line - n - 2, fmt, args);
  strcat(line, "\n");
  pthread_mutex_lock(&g_log_lock);
  struct stat st;
  if (!stat(g_log_path, &st) && st.st_size > LOG_LIMIT) {
    char old[620];
    snprintf(old, sizeof old, "%s.old", g_log_path);
    rename(g_log_path, old);
  }
  int fd = open(g_log_path, O_WRONLY | O_APPEND | O_CREAT, 0600);
  if (fd >= 0) {
    size_t size = strlen(line);
    const char* p = line;
    while (size) {
      ssize_t w = write(fd, p, size);
      if (w < 0 && errno == EINTR) continue;
      if (w <= 0) break;
      p += w;
      size -= (size_t)w;
    }
    const int64_t mono = log_mono_ms();
    if (critical || mono - g_log_synced_ms >= 2000) {
      fsync(fd);
      g_log_synced_ms = mono;
    }
    close(fd);
  }
  pthread_mutex_unlock(&g_log_lock);
}
static void logf_(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
static void logf_(const char* fmt, ...) {
  va_list args;
  va_start(args, fmt);
  log_line(0, fmt, args);
  va_end(args);
}
// Linha importante: gravada no disco na hora (fsync).
static void logk_(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
static void logk_(const char* fmt, ...) {
  va_list args;
  va_start(args, fmt);
  log_line(1, fmt, args);
  va_end(args);
}

// A ultima linha do diario de uma sessao que terminou limpa.
#define CLEAN_EXIT_MARK "parado (saida limpa)"

// Ao iniciar: a sessao anterior terminou limpa? Sem a marca na ultima linha, o processo morreu (SIGKILL, travamento
// do console, falta de energia...): a ultima linha diz onde estava. Lida antes de este processo escrever no diario.
static char g_previous_last[320];
static int g_previous_seen;
static void read_previous_session(void) {
  int fd = open(g_log_path, O_RDONLY);
  if (fd < 0) return;
  struct stat st;
  if (fstat(fd, &st) || st.st_size <= 0) { close(fd); return; }
  char tail[512];
  off_t from = st.st_size > (off_t)sizeof tail - 1 ? st.st_size - (off_t)(sizeof tail - 1) : 0;
  ssize_t n = pread(fd, tail, sizeof tail - 1, from);
  close(fd);
  if (n <= 0) return;
  tail[n] = 0;
  while (n > 0 && (tail[n - 1] == '\n' || tail[n - 1] == '\r')) tail[--n] = 0;
  const char* last = strrchr(tail, '\n');
  copy_text(g_previous_last, sizeof g_previous_last, last ? last + 1 : tail);
  g_previous_seen = 1;
}
// `contended`: outra copia ainda segurava o lock (estava viva; nao e travamento).
static void report_previous_session(int contended) {
  if (!g_previous_seen) logk_("sessao anterior: nenhuma (diario novo)");
  else if (strstr(g_previous_last, CLEAN_EXIT_MARK)) logk_("sessao anterior: terminou limpa");
  else if (contended) logk_("sessao anterior: ainda rodava (substituida agora); ultima linha: %s", g_previous_last);
  else logk_("sessao anterior: NAO terminou limpa (morta, travamento do console ou energia); ultima linha: %s", g_previous_last);
}

// Sinal fatal: uma linha no diario so com funcoes seguras dentro de um tratador de sinal, e o sinal segue adiante.
static void write_text(int fd, const char* text) {
  size_t size = strlen(text);
  while (size) {
    ssize_t w = write(fd, text, size);
    if (w <= 0) return;
    text += w;
    size -= (size_t)w;
  }
}
static void on_fatal(int sig) {
  const char* name = sig == SIGSEGV ? "SIGSEGV" : sig == SIGBUS ? "SIGBUS" : sig == SIGILL ? "SIGILL" : sig == SIGFPE ? "SIGFPE" :
                     sig == SIGABRT ? "SIGABRT" : sig == SIGSYS ? "SIGSYS" : sig == SIGTRAP ? "SIGTRAP" : "sinal";
  if (g_log_path[0]) {
    int fd = open(g_log_path, O_WRONLY | O_APPEND | O_CREAT, 0600);
    if (fd >= 0) {
      char number[24];
      int i = (int)sizeof number - 1;
      number[i] = 0;
      unsigned long long t = (unsigned long long)time(NULL);
      do { number[--i] = (char)('0' + t % 10); t /= 10; } while (t && i > 0);
      write_text(fd, "(epoch ");
      write_text(fd, number + i);
      write_text(fd, ") FATAL: ");
      write_text(fd, name);
      write_text(fd, " no bg-downloader; o processo vai morrer\n");
      fsync(fd);
      close(fd);
    }
  }
  signal(sig, SIG_DFL);
  raise(sig);
}

// So o host de uma URL vai para o diario: links assinados levam tokens na query.
static void url_host(const char* url, char* out, size_t cap) {
  const char* start = strstr(url, "://");
  start = start ? start + 3 : url;
  size_t n = strcspn(start, "/?#");
  if (n >= cap) n = cap - 1;
  memcpy(out, start, n);
  out[n] = 0;
}

// ---- Plataforma -----------------------------------------------------------------------------------------

static void notify(const char* text) {
  logf_("notificacao: %s", text);
#ifdef __PROSPERO__
  NotifyRequest request;
  memset(&request, 0, sizeof request);
  snprintf(request.message, sizeof request.message, "%s", text);
  sceKernelSendNotificationRequest(0, &request, sizeof request, 0);
#else
  const char* path = getenv("BGDL_NOTIFY_FILE");
  if (path) {
    FILE* file = fopen(path, "a");
    if (file) { fprintf(file, "%s\n", text); fclose(file); }
  }
#endif
}

static void set_process_name(void) {
#ifdef __PROSPERO__
  if (sceKernelSetProcessName) sceKernelSetProcessName(BG_PROCESS);
  syscall(SYS_thr_set_name, -1, BG_PROCESS);
#endif
}

// Desligado por padrao ("powerTick" no config.json): nenhum payload de referencia chama o SystemService de fora de
// um app, e uma chamada do sistema nao validada pode travar o console. Ligado, o diario registra a resposta.
static volatile int g_power_tick;
static void power_tick(void) {
  if (!g_power_tick) return;
#ifdef __PROSPERO__
  static int last = 1;
  int result = sceSystemServicePowerTick ? sceSystemServicePowerTick() : -1;
  if (result != last) { logk_("sceSystemServicePowerTick = 0x%08x", (unsigned)result); last = result; }
#endif
}

// O app esta aberto? Enquanto estiver, ele mesmo publica a imagem (o fluxo dele confere o conteudo antes).
static int app_running(void) {
#ifdef __PROSPERO__
  return sceLncUtilGetAppId ? sceLncUtilGetAppId(BG_TITLE) >= 0 : 1;
#else
  const char* path = getenv("BGDL_APP_RUNNING");
  struct stat st;
  return path && !stat(path, &st);
#endif
}

static int current_ip(char* out, size_t cap) {
  struct ifaddrs* list;
  out[0] = 0;
  if (getifaddrs(&list)) return -1;
  for (struct ifaddrs* item = list; item; item = item->ifa_next) {
    if (!item->ifa_addr || item->ifa_addr->sa_family != AF_INET || !strncmp(item->ifa_name, "lo", 2)) continue;
    struct sockaddr_in* in = (struct sockaddr_in*)item->ifa_addr;
    inet_ntop(AF_INET, &in->sin_addr, out, (socklen_t)cap);
    if (strncmp(out, "0.", 2) && strncmp(out, "127.", 4)) break;
    out[0] = 0;
  }
  freeifaddrs(list);
  return 0;
}

static int spawn_thread(void* (*fn)(void*), void* arg, pthread_t* out) {
  pthread_attr_t attr;
  pthread_t thread;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, 1024 * 1024); // a pilha padrao do PS5 e pequena
  if (!out) pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  int result = pthread_create(out ? out : &thread, &attr, fn, arg);
  pthread_attr_destroy(&attr);
  return result;
}

static int64_t now_s(void) { return (int64_t)time(NULL); }
static int64_t mono_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void sleep_ms(int ms) {
  struct timespec ts = {ms / 1000, (long)(ms % 1000) * 1000000L};
  while (nanosleep(&ts, &ts) && errno == EINTR) {}
}

// ---- Arquivos -------------------------------------------------------------------------------------------

static int mkdir_p(const char* path) {
  char buffer[1024];
  snprintf(buffer, sizeof buffer, "%s", path);
  for (char* p = buffer + 1; *p; ++p) {
    if (*p != '/') continue;
    *p = 0;
    if (mkdir(buffer, 0755) && errno != EEXIST) return -1;
    *p = '/';
  }
  return mkdir(buffer, 0755) && errno != EEXIST ? -1 : 0;
}

static int write_all(int fd, const void* bytes, size_t size, uint64_t offset) {
  const char* data = bytes;
  while (size) {
    ssize_t n = pwrite(fd, data, size, (off_t)offset);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    data += n;
    size -= (size_t)n;
    offset += (uint64_t)n;
  }
  return 1;
}

static int read_all(int fd, void* bytes, size_t size) {
  char* data = bytes;
  while (size) {
    ssize_t n = read(fd, data, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    data += n;
    size -= (size_t)n;
  }
  return 1;
}

static int sync_parent(const char* path) {
  char parent[1024];
  snprintf(parent, sizeof parent, "%s", path);
  char* slash = strrchr(parent, '/');
  if (!slash) return 1;
  if (slash == parent) slash[1] = 0; else *slash = 0;
  int fd = open(parent, O_RDONLY | O_DIRECTORY);
  if (fd < 0) return 0;
  int result = fsync(fd), saved = errno;
  close(fd);
  return result == 0 || saved == EINVAL || saved == ENOTSUP;
}

// Grava `text` em `path` de forma atomica: tmp + fsync + rename + fsync da pasta.
static int save_atomic(const char* path, const char* text, size_t size, int mode) {
  char temporary[1100];
  snprintf(temporary, sizeof temporary, "%s.tmp", path);
  int fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, mode);
  if (fd < 0) return 0;
  int ok = write_all(fd, text, size, 0) && fsync(fd) == 0;
  if (close(fd)) ok = 0;
  if (ok) ok = rename(temporary, path) == 0 && sync_parent(path);
  if (!ok) unlink(temporary);
  return ok;
}

static char* read_text(const char* path, size_t limit, size_t* size) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) return NULL;
  struct stat st;
  if (fstat(fd, &st) || st.st_size < 0 || (size_t)st.st_size > limit) { close(fd); return NULL; }
  char* text = malloc((size_t)st.st_size + 1);
  if (!text || !read_all(fd, text, (size_t)st.st_size)) { free(text); close(fd); return NULL; }
  close(fd);
  text[st.st_size] = 0;
  if (size) *size = (size_t)st.st_size;
  return text;
}

// ---- SHA-256 --------------------------------------------------------------------------------------------

typedef struct { EVP_MD_CTX* ctx; int ok; } Hash;
static void hash_init(Hash* h) {
  h->ctx = EVP_MD_CTX_new();
  h->ok = h->ctx && EVP_DigestInit_ex(h->ctx, EVP_sha256(), NULL) == 1;
}
static void hash_add(Hash* h, const void* data, size_t size) {
  h->ok = h->ok && EVP_DigestUpdate(h->ctx, data, size) == 1;
}
static void hash_text0(Hash* h, const char* text) { // o valor seguido de um \0, como o motor nativo faz
  hash_add(h, text, strlen(text));
  hash_add(h, "", 1);
}
static int hash_finish(Hash* h, char out[65]) {
  unsigned char digest[32];
  unsigned size = 0;
  int ok = h->ok && EVP_DigestFinal_ex(h->ctx, digest, &size) == 1 && size == 32;
  EVP_MD_CTX_free(h->ctx);
  h->ctx = NULL;
  out[0] = 0;
  if (!ok) return 0;
  static const char digits[] = "0123456789abcdef";
  for (int i = 0; i < 32; ++i) { out[2 * i] = digits[digest[i] >> 4]; out[2 * i + 1] = digits[digest[i] & 15]; }
  out[64] = 0;
  return 1;
}

// ---- Texto/JSON -----------------------------------------------------------------------------------------

typedef struct { char* data; size_t size, cap; int failed; } Buf;
static void buf_add(Buf* b, const char* data, size_t size) {
  if (b->failed) return;
  if (b->size + size + 1 > b->cap) {
    size_t cap = b->cap ? b->cap : 1024;
    while (cap < b->size + size + 1) cap *= 2;
    char* next = realloc(b->data, cap);
    if (!next) { b->failed = 1; return; }
    b->data = next;
    b->cap = cap;
  }
  memcpy(b->data + b->size, data, size);
  b->size += size;
  b->data[b->size] = 0;
}
static void buf_str(Buf* b, const char* text) { buf_add(b, text, strlen(text)); }
static void buf_fmt(Buf* b, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
static void buf_fmt(Buf* b, const char* fmt, ...) {
  char line[512];
  va_list args;
  va_start(args, fmt);
  int n = vsnprintf(line, sizeof line, fmt, args);
  va_end(args);
  if (n > 0) buf_add(b, line, (size_t)n < sizeof line ? (size_t)n : sizeof line - 1);
}
static void buf_json(Buf* b, const char* text) {
  buf_add(b, "\"", 1);
  for (const unsigned char* p = (const unsigned char*)text; *p; ++p) {
    if (*p == '"' || *p == '\\') { char e[2] = {'\\', (char)*p}; buf_add(b, e, 2); }
    else if (*p < 0x20) buf_fmt(b, "\\u%04x", *p);
    else buf_add(b, (const char*)p, 1);
  }
  buf_add(b, "\"", 1);
}

// Leitor JSON minimo: objetos com texto, numeros, logicos, null e objetos/listas aninhados (estes pulados
// quando nao interessam).
typedef struct { const char* p; const char* end; int depth; } JP;
static void jp_ws(JP* j) { while (j->p < j->end && (*j->p == ' ' || *j->p == '\t' || *j->p == '\n' || *j->p == '\r')) ++j->p; }
static int jp_hex(const char* p, unsigned* out) {
  unsigned v = 0;
  for (int i = 0; i < 4; ++i) {
    char c = p[i];
    v <<= 4;
    if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
    else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
    else return 0;
  }
  *out = v;
  return 1;
}
// Le um texto JSON para `out` (NULL so pula). 0 se invalido ou maior que `cap`.
static int jp_string(JP* j, char* out, size_t cap) {
  jp_ws(j);
  if (j->p >= j->end || *j->p != '"') return 0;
  ++j->p;
  size_t n = 0;
  while (j->p < j->end && *j->p != '"') {
    unsigned c = (unsigned char)*j->p++;
    char utf[4];
    size_t len = 1;
    if (c < 0x20) return 0;
    if (c == '\\') {
      if (j->p >= j->end) return 0;
      char e = *j->p++;
      switch (e) {
        case '"': c = '"'; break;
        case '\\': c = '\\'; break;
        case '/': c = '/'; break;
        case 'b': c = '\b'; break;
        case 'f': c = '\f'; break;
        case 'n': c = '\n'; break;
        case 'r': c = '\r'; break;
        case 't': c = '\t'; break;
        case 'u': {
          unsigned cp;
          if (j->end - j->p < 4 || !jp_hex(j->p, &cp)) return 0;
          j->p += 4;
          if (cp >= 0xd800 && cp <= 0xdbff) {
            unsigned low;
            if (j->end - j->p < 6 || j->p[0] != '\\' || j->p[1] != 'u' || !jp_hex(j->p + 2, &low) || low < 0xdc00 || low > 0xdfff) return 0;
            j->p += 6;
            cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
          } else if (cp >= 0xdc00 && cp <= 0xdfff) return 0;
          if (!cp) return 0; // um \0 cortaria o texto
          if (cp < 0x80) { utf[0] = (char)cp; len = 1; }
          else if (cp < 0x800) { utf[0] = (char)(0xc0 | (cp >> 6)); utf[1] = (char)(0x80 | (cp & 63)); len = 2; }
          else if (cp < 0x10000) { utf[0] = (char)(0xe0 | (cp >> 12)); utf[1] = (char)(0x80 | ((cp >> 6) & 63)); utf[2] = (char)(0x80 | (cp & 63)); len = 3; }
          else { utf[0] = (char)(0xf0 | (cp >> 18)); utf[1] = (char)(0x80 | ((cp >> 12) & 63)); utf[2] = (char)(0x80 | ((cp >> 6) & 63)); utf[3] = (char)(0x80 | (cp & 63)); len = 4; }
          if (out) { if (n + len >= cap) return 0; memcpy(out + n, utf, len); }
          n += len;
          continue;
        }
        default: return 0;
      }
    }
    if (out) { if (n + 1 >= cap) return 0; out[n] = (char)c; }
    n += 1;
  }
  if (j->p >= j->end) return 0;
  ++j->p;
  if (out) out[n] = 0;
  return 1;
}
static int jp_number(JP* j, double* value, uint64_t* integer, int* is_integer) {
  jp_ws(j);
  const char* start = j->p;
  if (j->p < j->end && *j->p == '-') ++j->p;
  int digits = 0, frac = 0;
  while (j->p < j->end && isdigit((unsigned char)*j->p)) { ++j->p; ++digits; }
  if (j->p < j->end && (*j->p == '.' || *j->p == 'e' || *j->p == 'E')) {
    frac = 1;
    while (j->p < j->end && (isdigit((unsigned char)*j->p) || strchr(".eE+-", *j->p))) ++j->p;
  }
  if (!digits) return 0;
  char text[64];
  size_t n = (size_t)(j->p - start);
  if (n >= sizeof text) return 0;
  memcpy(text, start, n);
  text[n] = 0;
  *value = strtod(text, NULL);
  *is_integer = !frac && *start != '-';
  *integer = *is_integer ? strtoull(text, NULL, 10) : 0;
  return 1;
}
static int jp_skip(JP* j);
static int jp_literal(JP* j, const char* word) {
  size_t n = strlen(word);
  if ((size_t)(j->end - j->p) < n || strncmp(j->p, word, n)) return 0;
  j->p += n;
  return 1;
}
typedef int (*FieldFn)(JP* j, const char* key, void* ctx);
static int jp_object(JP* j, FieldFn field, void* ctx) {
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{' || ++j->depth > 16) return 0;
  ++j->p;
  jp_ws(j);
  if (j->p < j->end && *j->p == '}') { ++j->p; --j->depth; return 1; }
  for (;;) {
    char key[64];
    if (!jp_string(j, key, sizeof key)) return 0;
    jp_ws(j);
    if (j->p >= j->end || *j->p != ':') return 0;
    ++j->p;
    int handled = field ? field(j, key, ctx) : 0;
    if (handled < 0) return 0;
    if (!handled && !jp_skip(j)) return 0;
    jp_ws(j);
    if (j->p < j->end && *j->p == ',') { ++j->p; continue; }
    if (j->p < j->end && *j->p == '}') { ++j->p; --j->depth; return 1; }
    return 0;
  }
}
static int jp_skip(JP* j) {
  jp_ws(j);
  if (j->p >= j->end) return 0;
  char c = *j->p;
  if (c == '"') return jp_string(j, NULL, 0);
  if (c == '{') return jp_object(j, NULL, NULL);
  if (c == '[') {
    if (++j->depth > 16) return 0;
    ++j->p;
    jp_ws(j);
    if (j->p < j->end && *j->p == ']') { ++j->p; --j->depth; return 1; }
    for (;;) {
      if (!jp_skip(j)) return 0;
      jp_ws(j);
      if (j->p < j->end && *j->p == ',') { ++j->p; continue; }
      if (j->p < j->end && *j->p == ']') { ++j->p; --j->depth; return 1; }
      return 0;
    }
  }
  if (c == 't') return jp_literal(j, "true");
  if (c == 'f') return jp_literal(j, "false");
  if (c == 'n') return jp_literal(j, "null");
  double d; uint64_t u; int i;
  return jp_number(j, &d, &u, &i);
}
static int jp_bool(JP* j, int* out) {
  jp_ws(j);
  if (jp_literal(j, "true")) { *out = 1; return 1; }
  if (jp_literal(j, "false") || jp_literal(j, "null")) { *out = 0; return 1; }
  return 0;
}
static int jp_uint(JP* j, uint64_t* out) {
  jp_ws(j);
  if (jp_literal(j, "null")) { *out = 0; return 1; }
  double d; int integer;
  if (!jp_number(j, &d, out, &integer)) return 0;
  if (!integer) { if (d < 0 || d > (double)SAFE_INTEGER) return 0; *out = (uint64_t)d; }
  return *out <= SAFE_INTEGER;
}
static int jp_int64(JP* j, int64_t* out) {
  jp_ws(j);
  if (jp_literal(j, "null")) { *out = 0; return 1; }
  double d; uint64_t u; int integer;
  if (!jp_number(j, &d, &u, &integer)) return 0;
  *out = (int64_t)d;
  return 1;
}
// Texto ou null (null vira "").
static int jp_text(JP* j, char* out, size_t cap) {
  jp_ws(j);
  if (jp_literal(j, "null")) { out[0] = 0; return 1; }
  return jp_string(j, out, cap);
}
// Texto ou numero (ids do TorBox chegam como numero).
static int jp_id(JP* j, char* out, size_t cap) {
  jp_ws(j);
  if (j->p < j->end && (*j->p == '-' || isdigit((unsigned char)*j->p))) {
    double d; uint64_t u; int integer;
    if (!jp_number(j, &d, &u, &integer) || !integer) return 0;
    snprintf(out, cap, "%llu", (unsigned long long)u);
    return 1;
  }
  return jp_text(j, out, cap);
}

// glibren: leitura tolerante (a Biblioteca TorBox e os pedidos do celular): texto longo e cortado (sem partir um
// caractere UTF-8), numero vira texto, e um valor de outro tipo e pulado em vez de invalidar o arquivo todo.
static void lower_ascii(char* text) {
  for (; *text; ++text) *text = (char)tolower((unsigned char)*text);
}
static void copy_utf8(char* out, size_t cap, const char* text) {
  size_t n = strnlen(text, cap - 1);
  if (text[n]) while (n > 0 && ((unsigned char)text[n] & 0xc0) == 0x80) --n;
  memcpy(out, text, n);
  out[n] = 0;
}
static int lib_text(JP* j, char* out, size_t cap) {
  out[0] = 0;
  jp_ws(j);
  if (j->p >= j->end) return 0;
  if (*j->p == '"') {
    const char* start = j->p;
    if (jp_string(j, out, cap)) return 1;
    j->p = start;
    char* wide = malloc(8192);
    if (wide && jp_string(j, wide, 8192)) {
      copy_utf8(out, cap, wide);
      free(wide);
      return 1;
    }
    free(wide);
    j->p = start;
    out[0] = 0;
    return jp_string(j, NULL, 0);
  }
  if (*j->p == '-' || isdigit((unsigned char)*j->p)) {
    double d; uint64_t u; int integer;
    if (!jp_number(j, &d, &u, &integer)) return 0;
    if (integer) snprintf(out, cap, "%llu", (unsigned long long)u);
    return 1;
  }
  return jp_skip(j);
}
// Um numero >= 0 (ou um texto com ele); outro valor vale 0.
static int lib_uint(JP* j, uint64_t* out) {
  *out = 0;
  jp_ws(j);
  if (j->p < j->end && (*j->p == '-' || isdigit((unsigned char)*j->p))) {
    double d; uint64_t u; int integer;
    if (!jp_number(j, &d, &u, &integer)) return 0;
    *out = integer ? u : d > 0 && d < 1.8e19 ? (uint64_t)d : 0;
    return 1;
  }
  if (j->p < j->end && *j->p == '"') {
    char text[32];
    if (!lib_text(j, text, sizeof text)) return 0;
    *out = strtoull(text, NULL, 10);
    return 1;
  }
  return jp_skip(j);
}
// Uma lista JSON: `item` le cada elemento (1 ok, 0 para tudo). Outro valor no lugar da lista e pulado.
typedef int (*ItemFn)(JP* j, void* ctx);
static int jp_array(JP* j, ItemFn item, void* ctx) {
  jp_ws(j);
  if (j->p >= j->end) return 0;
  if (*j->p != '[') return jp_skip(j);
  if (++j->depth > 16) return 0;
  ++j->p;
  jp_ws(j);
  if (j->p < j->end && *j->p == ']') { ++j->p; --j->depth; return 1; }
  for (;;) {
    if (!item(j, ctx)) return 0;
    jp_ws(j);
    if (j->p < j->end && *j->p == ',') { ++j->p; continue; }
    if (j->p < j->end && *j->p == ']') { ++j->p; --j->depth; return 1; }
    return 0;
  }
}

// ---- Jobs -----------------------------------------------------------------------------------------------

enum { CTL_NONE, CTL_PAUSE, CTL_CANCEL, CTL_RELEASE, CTL_STOP };

typedef struct {
  char id[24];
  char url[8192];
  char destination[1024], storage_root[1024], publish_to[1024], published[1024];
  char name[256], sha256[65];
  char notify_done[300], notify_failed[300];
  uint64_t expected_bytes, range_bytes;
  unsigned connections;
  // glibren.8: as conexoes escolhidas no celular (1..64; 0 = as do app). Prevalece sobre `connections`, que o app
  // manda; o app nunca a muda (POST /jobs e /queue a zeram no corpo). Gravada em jobs.json ("connectionsSet").
  unsigned connections_set; // lida e mudada so com g_lock
  int reject_html;
  // Fonte: provider "torbox" | "alldebrid" | "direct" | ...; para o TorBox, kind/id/fileId/zip do pedido.
  char provider[16], kind[16], item_id[32], file_id[32];
  int zip;
  int64_t link_at, created, updated;
  char state[24];  // queued connecting downloading verifying paused completed failed cancelled needs-app
  char by[8];      // "remote": a ultima pausa ou cancelamento veio do celular (pagina da porta 34201)
  // A fila do app entregue com antecedencia (POST /queue): `ahead` baixa sozinho com o app fechado, na ordem `order`;
  // `placeholder` ("waiting-app") so mostra no celular um item que so o app sabe baixar (sem URL). `key`: o id do job
  // na fila do app. `followed`: o app abriu e acompanha este job (so na memoria).
  int ahead, placeholder, followed, order;
  char key[128]; // glibren.8: a chave da fila do app e "<jogo>/<release>" (era 40, so letras e digitos)
  // glibren: pedido da Biblioteca TorBox feito no celular (POST /api/library/add): um marcador que so o app tira
  // (forget, depois de por o jogo na fila dele). O jogo da lista (id), o torrent (hash), o arquivo escolhido ("" com
  // lib_whole = o torrent inteiro), o codigo e a plataforma. Gravado em jobs.json ("library").
  int requested, lib_whole;
  char lib_id[96], lib_hash[72], lib_file[256], lib_code[16], lib_platform[4];
  // De onde vem o arquivo (files[].via da lista): "torrent" (lib_hash = infohash), "webdl" (lib_hash = MD5 do link do
  // catalogo; lib_release = a fonte no app) ou "account" (item ja na conta: lib_item_kind/lib_item_id + lib_file_id).
  char lib_via[12], lib_release[96], lib_item_kind[12], lib_item_id[32], lib_file_id[32];
  char error[600];
  int awaiting_app, renewals;
  uint64_t written, total;
  double bytes_per_second;
  unsigned active_connections, retries;
  int64_t retry_at; // queued esperando a rede voltar
  volatile int ctl;
  int running;
} Job;

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_wake_downloader = PTHREAD_COND_INITIALIZER;
static Job* g_jobs[MAX_JOBS];
static int g_job_count;
static unsigned g_next_id;
// Quantos jobs baixam ao mesmo tempo (1 a MAX_WORKERS), escolhido no app e gravado em config.json; e quantos
// estao baixando agora. Diminuir nao para ninguem: so nao comeca outro ate ficar abaixo.
static int g_max_running = 1;
// glibren.8: quem escolheu g_max_running por ultimo: 1 = o celular (POST /api/config), 0 = o app. g_concurrency_stamp
// sobe a cada escolha no celular: o app adota o numero (uma vez por stamp) em vez de sobrescreve-lo. Em config.json.
static int g_concurrency_remote;
static unsigned g_concurrency_stamp;
static int g_running_count;
static int g_dirty;
// A pagina do celular (porta 34201): ligada por padrao; o PIN chega do app so como sal + SHA-256 (hex), e o texto
// da notificacao com o endereco ("{address}") no idioma do jogador. Tudo em config.json.
static volatile int g_monitor_on = 1;
static char g_pin_salt[65], g_pin_hash[65], g_monitor_text[300];
static int g_monitor_announced;
static void monitor_clear_sessions(void);
static int g_monitor_port_now(void);

// O app falou com o payload ha pouco (qualquer chamada com o token): enquanto fala, quem comeca os downloads e ele.
// Com o app fechado (ou suspenso: o JS para), os jobs entregues com antecedencia seguem sozinhos. Comeca "agora", para
// um payload recem-subido esperar o app mandar a fila antes de comecar o que ficou no jobs.json.
static int64_t g_last_app_ms;
static int64_t g_app_silence_ms = 15000;
// Modo quieto (glibren-fechar): ate g_quiet_until (mono_ms) nenhum job usa rede nem disco, nenhum comeca e nenhuma
// imagem e movida. Liga quando o app fecha (ou se cala), por g_quiet_ms (30 s no console; BGDL_QUIET_MS nos testes).
static volatile int64_t g_quiet_until;
static int64_t g_quiet_ms = 30000;
// glibren.5: a opcao "Pausa ao fechar o app" (POST /config "pauseOnCloseSeconds", 0 a 30 s): g_quiet_ms = s * 1000, e 0
// nao deixa nada quieto. Enquanto o app nao mandar o campo (g_pause_seconds < 0), vale g_quiet_close_ms (30 s no
// console; BGDL_QUIET_MS nos testes). g_quiet_from: quando o modo quieto atual comecou (para encurta-lo).
#define MAX_PAUSE_SECONDS 30
static int64_t g_quiet_close_ms = 30000;
static int g_pause_seconds = -1;
static volatile int64_t g_quiet_from;
// glibren.5: quando o app avisou que vai fechar (POST /bye). Nos BYE_GRACE_MS seguintes, outras chamadas dele (um poll
// que ja estava a caminho) nao contam como "o app esta falando".
#define BYE_GRACE_MS 5000
static volatile int64_t g_bye_ms = INT64_MIN / 2;
static int quiet_now(void) { return mono_ms() < g_quiet_until; }
// glibren.5: comeca o modo quieto agora, por g_quiet_ms.
static void start_quiet(int64_t mono) {
  g_quiet_from = mono;
  g_quiet_until = mono + g_quiet_ms;
}
static int app_away(void) { return mono_ms() - g_last_app_ms >= g_app_silence_ms; }
// Para testes: o espaco livre fingido (BGDL_FAKE_FREE_BYTES); 0 = o de verdade.
static uint64_t g_fake_free;

static int terminal(const char* state) {
  return !strcmp(state, "completed") || !strcmp(state, "failed") || !strcmp(state, "cancelled") || !strcmp(state, "needs-app");
}

// glibren.6: o link do TorBox leva a chave da conta (o token= dele e a chave da API, visto em 05/11/2026). O jobs.json
// guarda esse link sem o valor do token (e linkAt = 1, vencido): ao ler a fila de novo, o job pede outro link com a
// chave que o app entrega (POST /secret), como numa renovacao. Fica so o que vem depois de token= ate o & ou #.
static void tokenless(const char* url, char* out, size_t cap) {
  size_t n = 0;
  for (const char* p = url; *p && n + 1 < cap;) {
    if ((*p == '?' || *p == '&') && !strncasecmp(p + 1, "token=", 6)) {
      for (int k = 0; k < 7 && n + 1 < cap; ++k) out[n++] = p[k];
      p += 7;
      while (*p && *p != '&' && *p != '#') ++p;
      continue;
    }
    out[n++] = *p++;
  }
  out[n] = 0;
}

static void job_json_as(Buf* b, const Job* j, int for_disk) {
  const int hide = for_disk && !strcmp(j->provider, "torbox");
  char safe[sizeof j->url];
  if (hide) tokenless(j->url, safe, sizeof safe);
  buf_str(b, "{\"id\":"); buf_json(b, j->id);
  buf_str(b, ",\"state\":"); buf_json(b, j->state);
  buf_str(b, ",\"url\":"); buf_json(b, hide ? safe : j->url);
  buf_str(b, ",\"destination\":"); buf_json(b, j->destination);
  buf_str(b, ",\"storageRoot\":"); buf_json(b, j->storage_root);
  buf_str(b, ",\"publishTo\":"); buf_json(b, j->publish_to);
  buf_str(b, ",\"published\":"); buf_json(b, j->published);
  buf_str(b, ",\"name\":"); buf_json(b, j->name);
  buf_str(b, ",\"sha256\":"); buf_json(b, j->sha256);
  buf_str(b, ",\"notifyDone\":"); buf_json(b, j->notify_done);
  buf_str(b, ",\"notifyFailed\":"); buf_json(b, j->notify_failed);
  buf_str(b, ",\"error\":"); buf_json(b, j->error);
  buf_str(b, ",\"by\":"); buf_json(b, j->by);
  buf_str(b, ",\"key\":"); buf_json(b, j->key);
  buf_fmt(b, ",\"ahead\":%s,\"placeholder\":%s,\"followed\":%s,\"order\":%d", j->ahead ? "true" : "false", j->placeholder ? "true" : "false",
          j->followed ? "true" : "false", j->order);
  buf_fmt(b, ",\"expectedBytes\":%llu,\"rangeBytes\":%llu,\"connections\":%u,\"connectionsSet\":%u,\"rejectHtml\":%s",
          (unsigned long long)j->expected_bytes, (unsigned long long)j->range_bytes, j->connections, j->connections_set, j->reject_html ? "true" : "false");
  buf_str(b, ",\"source\":{\"provider\":"); buf_json(b, j->provider);
  buf_str(b, ",\"kind\":"); buf_json(b, j->kind);
  buf_str(b, ",\"id\":"); buf_json(b, j->item_id);
  buf_str(b, ",\"fileId\":"); buf_json(b, j->file_id);
  buf_fmt(b, ",\"zip\":%s}", j->zip ? "true" : "false");
  buf_fmt(b, ",\"linkAt\":%lld,\"created\":%lld,\"updated\":%lld,\"awaitingApp\":%s,\"renewals\":%d",
          (long long)(hide && j->link_at ? 1 : j->link_at), (long long)j->created, (long long)j->updated, j->awaiting_app ? "true" : "false", j->renewals);
  buf_fmt(b, ",\"written\":%llu,\"total\":%llu,\"bytesPerSecond\":%.0f,\"connectionsActive\":%u,\"retries\":%u,\"owner\":\"payload\"",
          (unsigned long long)j->written, (unsigned long long)j->total, j->bytes_per_second, j->active_connections, j->retries);
  if (j->requested) {
    buf_str(b, ",\"library\":{\"id\":"); buf_json(b, j->lib_id);
    buf_str(b, ",\"hash\":"); buf_json(b, j->lib_hash);
    buf_str(b, ",\"file\":"); buf_json(b, j->lib_file);
    buf_str(b, ",\"code\":"); buf_json(b, j->lib_code);
    buf_str(b, ",\"platform\":"); buf_json(b, j->lib_platform);
    buf_str(b, ",\"via\":"); buf_json(b, j->lib_via);
    buf_str(b, ",\"release\":"); buf_json(b, j->lib_release);
    buf_str(b, ",\"item\":{\"kind\":"); buf_json(b, j->lib_item_kind);
    buf_str(b, ",\"id\":"); buf_json(b, j->lib_item_id);
    buf_str(b, "},\"fileId\":"); buf_json(b, j->lib_file_id);
    buf_fmt(b, ",\"whole\":%s,\"size\":%llu}", j->lib_whole ? "true" : "false", (unsigned long long)j->total);
  }
  buf_str(b, "}");
}

// O job como a API local (127.0.0.1, com token de sessao) o mostra ao app: com o link inteiro.
static void job_json(Buf* b, const Job* j) { job_json_as(b, j, 0); }

static void save_jobs_locked(void) {
  Buf b = {0};
  buf_fmt(&b, "{\"version\":1,\"next\":%u,\"jobs\":[", g_next_id);
  for (int i = 0; i < g_job_count; ++i) {
    if (i) buf_str(&b, ",");
    job_json_as(&b, g_jobs[i], 1);
  }
  buf_str(&b, "]}\n");
  char path[600];
  snprintf(path, sizeof path, "%s/jobs.json", g_dir);
  if (b.failed || !save_atomic(path, b.data, b.size, 0600)) logf_("fila nao salva: %s", strerror(errno));
  free(b.data);
  g_dirty = 0;
}

static Job* find_job_locked(const char* id) {
  for (int i = 0; i < g_job_count; ++i) if (!strcmp(g_jobs[i]->id, id)) return g_jobs[i];
  return NULL;
}

// glibren.8: as conexoes escolhidas no celular para um item da fila do app (pela chave dele) que saiu da lista do
// payload: um marcador "waiting-app" some quando o app comeca o download (POST /jobs com a mesma chave chega depois),
// ou vira um job antecipado. O job novo com a chave herda o numero. So em memoria, as ultimas CARRY_MAX.
#define CARRY_MAX 16
static struct { char key[128]; unsigned connections; } g_carry[CARRY_MAX];
static int g_carry_next;
static void carry_remember_locked(const Job* j) {
  if (!j->connections_set || !j->key[0]) return;
  for (int i = 0; i < CARRY_MAX; ++i)
    if (!strcmp(g_carry[i].key, j->key)) { g_carry[i].connections = j->connections_set; return; }
  snprintf(g_carry[g_carry_next].key, sizeof g_carry[0].key, "%s", j->key);
  g_carry[g_carry_next].connections = j->connections_set;
  g_carry_next = (g_carry_next + 1) % CARRY_MAX;
}
static unsigned carried_connections_locked(const char* key, const Job* except) {
  if (!key[0]) return 0;
  for (int i = 0; i < g_job_count; ++i)
    if (g_jobs[i] != except && g_jobs[i]->connections_set && !strcmp(g_jobs[i]->key, key)) return g_jobs[i]->connections_set;
  for (int i = 0; i < CARRY_MAX; ++i) if (g_carry[i].key[0] && !strcmp(g_carry[i].key, key)) return g_carry[i].connections;
  return 0;
}

static void remove_job_locked(Job* j) {
  carry_remember_locked(j);
  for (int i = 0; i < g_job_count; ++i) {
    if (g_jobs[i] != j) continue;
    memmove(&g_jobs[i], &g_jobs[i + 1], sizeof(Job*) * (size_t)(g_job_count - i - 1));
    --g_job_count;
    free(j);
    return;
  }
}

typedef struct { Job* job; int source_ok; } JobParse;

static int source_field(JP* jp, const char* key, void* ctx) {
  Job* j = ctx;
  if (!strcmp(key, "provider") || !strcmp(key, "service")) {
    char value[16];
    if (!jp_text(jp, value, sizeof value)) return -1;
    if (value[0] && (!j->provider[0] || !strcmp(key, "service"))) snprintf(j->provider, sizeof j->provider, "%s", value);
    return 1;
  }
  if (!strcmp(key, "kind")) return jp_text(jp, j->kind, sizeof j->kind) ? 1 : -1;
  if (!strcmp(key, "id")) return jp_id(jp, j->item_id, sizeof j->item_id) ? 1 : -1;
  if (!strcmp(key, "fileId")) return jp_id(jp, j->file_id, sizeof j->file_id) ? 1 : -1;
  if (!strcmp(key, "zip")) return jp_bool(jp, &j->zip) ? 1 : -1;
  return 0;
}

static int library_item_field(JP* jp, const char* key, void* ctx) {
  Job* j = ctx;
  if (!strcmp(key, "kind")) return lib_text(jp, j->lib_item_kind, sizeof j->lib_item_kind) ? 1 : -1;
  if (!strcmp(key, "id")) return lib_text(jp, j->lib_item_id, sizeof j->lib_item_id) ? 1 : -1;
  return 0;
}
static int library_field(JP* jp, const char* key, void* ctx) {
  Job* j = ctx;
  if (!strcmp(key, "id")) return lib_text(jp, j->lib_id, sizeof j->lib_id) ? 1 : -1;
  if (!strcmp(key, "hash")) return lib_text(jp, j->lib_hash, sizeof j->lib_hash) ? 1 : -1;
  if (!strcmp(key, "file")) return lib_text(jp, j->lib_file, sizeof j->lib_file) ? 1 : -1;
  if (!strcmp(key, "code")) return lib_text(jp, j->lib_code, sizeof j->lib_code) ? 1 : -1;
  if (!strcmp(key, "platform")) return lib_text(jp, j->lib_platform, sizeof j->lib_platform) ? 1 : -1;
  if (!strcmp(key, "whole")) return jp_bool(jp, &j->lib_whole) ? 1 : -1;
  if (!strcmp(key, "via")) return lib_text(jp, j->lib_via, sizeof j->lib_via) ? 1 : -1;
  if (!strcmp(key, "release")) return lib_text(jp, j->lib_release, sizeof j->lib_release) ? 1 : -1;
  if (!strcmp(key, "fileId")) return lib_text(jp, j->lib_file_id, sizeof j->lib_file_id) ? 1 : -1;
  if (!strcmp(key, "item")) {
    jp_ws(jp);
    if (jp->p >= jp->end || *jp->p != '{') return jp_skip(jp) ? 1 : -1;
    return jp_object(jp, library_item_field, j) ? 1 : -1;
  }
  return 0;
}

static int job_field(JP* jp, const char* key, void* ctx) {
  Job* j = ((JobParse*)ctx)->job;
  uint64_t number;
#define TEXT(name, field) if (!strcmp(key, name)) return jp_text(jp, j->field, sizeof j->field) ? 1 : -1
  TEXT("id", id);
  TEXT("url", url);
  TEXT("destination", destination);
  TEXT("storageRoot", storage_root);
  TEXT("publishTo", publish_to);
  TEXT("published", published);
  TEXT("name", name);
  TEXT("sha256", sha256);
  TEXT("notifyDone", notify_done);
  TEXT("notifyFailed", notify_failed);
  TEXT("state", state);
  TEXT("error", error);
  TEXT("by", by);
  TEXT("key", key);
#undef TEXT
  if (!strcmp(key, "ahead")) return jp_bool(jp, &j->ahead) ? 1 : -1;
  if (!strcmp(key, "placeholder")) return jp_bool(jp, &j->placeholder) ? 1 : -1;
  if (!strcmp(key, "order")) { if (!jp_uint(jp, &number)) return -1; j->order = number > 100000 ? 100000 : (int)number; return 1; }
  if (!strcmp(key, "expectedBytes")) return jp_uint(jp, &j->expected_bytes) ? 1 : -1;
  if (!strcmp(key, "rangeBytes")) return jp_uint(jp, &j->range_bytes) ? 1 : -1;
  if (!strcmp(key, "connections")) { if (!jp_uint(jp, &number)) return -1; j->connections = number > 64 ? 64 : (unsigned)number; return 1; }
  if (!strcmp(key, "connectionsSet")) { if (!jp_uint(jp, &number)) return -1; j->connections_set = number > MAX_CONNS ? MAX_CONNS : (unsigned)number; return 1; }
  if (!strcmp(key, "rejectHtml")) return jp_bool(jp, &j->reject_html) ? 1 : -1;
  if (!strcmp(key, "awaitingApp")) return jp_bool(jp, &j->awaiting_app) ? 1 : -1;
  if (!strcmp(key, "renewals")) { if (!jp_uint(jp, &number)) return -1; j->renewals = (int)number; return 1; }
  if (!strcmp(key, "written")) return jp_uint(jp, &j->written) ? 1 : -1;
  if (!strcmp(key, "total")) return jp_uint(jp, &j->total) ? 1 : -1;
  if (!strcmp(key, "linkAt")) return jp_int64(jp, &j->link_at) ? 1 : -1;
  if (!strcmp(key, "created")) return jp_int64(jp, &j->created) ? 1 : -1;
  if (!strcmp(key, "updated")) return jp_int64(jp, &j->updated) ? 1 : -1;
  if (!strcmp(key, "source")) {
    jp_ws(jp);
    if (jp_literal(jp, "null")) return 1;
    return jp_object(jp, source_field, j) ? 1 : -1;
  }
  if (!strcmp(key, "library")) {
    jp_ws(jp);
    if (jp_literal(jp, "null")) return 1;
    j->requested = 1;
    return jp_object(jp, library_field, j) ? 1 : -1;
  }
  return 0;
}

static int safe_path(const char* path) {
  size_t n = strlen(path);
  return path[0] == '/' && n > 1 && n < 1000 && !strstr(path, "/../") && !strstr(path, "/./") &&
         strcmp(path + (n >= 3 ? n - 3 : 0), "/..") && !strchr(path, '\\') && path[n - 1] != '/';
}

static int safe_url(const char* url) {
  if (strncmp(url, "https://", 8) && strncmp(url, "http://", 7)) return 0;
  for (const unsigned char* p = (const unsigned char*)url; *p; ++p) if (*p <= ' ' || *p == 0x7f) return 0;
  return strlen(url) < 8000;
}

static int safe_token_text(const char* text) { // ids e chaves: letras, digitos, - e _
  for (const char* p = text; *p; ++p) if (!isalnum((unsigned char)*p) && *p != '-' && *p != '_') return 0;
  return 1;
}

// MODIFIED (glibren.8): a chave de um item da fila do app e o id do job dela, "<jogo>/<release>"
// (download-queue.js); safe_token_text recusava a "/" e o POST /queue inteiro voltava 400 ("item 0: key"), de modo
// que nada da fila chegava ao payload. A chave so e comparada e escrita escapada em JSON: basta texto visivel,
// sem aspas nem barra invertida.
static int queue_key_ok(const char* text) {
  if (!*text) return 0;
  for (const char* p = text; *p; ++p) if ((unsigned char)*p < 0x20 || *p == 0x7f || *p == '"' || *p == '\\') return 0;
  return 1;
}

static int is_hex64(const char* text) {
  if (strlen(text) != 64) return 0;
  for (const char* p = text; *p; ++p) if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) return 0;
  return 1;
}

// Valida um job (do corpo de POST /jobs ou de jobs.json). `error` recebe o motivo.
static int validate_job(Job* j, char* error, size_t cap) {
  // Um marcador "waiting-app": so nome, tamanho e ordem, nada para baixar.
  if (j->placeholder) {
    if (!j->key[0] || !queue_key_ok(j->key)) { snprintf(error, cap, "a waiting item needs its key"); return 0; }
    j->url[0] = j->destination[0] = j->storage_root[0] = j->publish_to[0] = 0;
    j->ahead = 0;
    if (j->requested && (!j->lib_id[0] || !(j->lib_hash[0] || j->lib_release[0] || j->lib_item_id[0]))) j->requested = 0;
    // MODIFIED (glibren.8): um marcador pausado (no app ou no celular) volta pausado ao reabrir o payload.
    // glibren: um pedido do celular que o app nao conseguiu por na fila continua "failed" (com o motivo).
    if (strcmp(j->state, "paused") && strcmp(j->state, "cancelled") && !(j->requested && !strcmp(j->state, "failed")))
      snprintf(j->state, sizeof j->state, "waiting-app");
    return 1;
  }
  j->requested = 0; // so marcadores
  if (j->key[0] && !queue_key_ok(j->key)) { snprintf(error, cap, "invalid key"); return 0; }
  if (!safe_url(j->url)) { snprintf(error, cap, "url must be an http(s) URL without spaces"); return 0; }
  if (!safe_path(j->destination)) { snprintf(error, cap, "destination must be an absolute file path"); return 0; }
  if (j->storage_root[0]) {
    size_t n = strlen(j->storage_root);
    if (!safe_path(j->storage_root) || strncmp(j->destination, j->storage_root, n) || j->destination[n] != '/') {
      snprintf(error, cap, "destination must be inside storageRoot"); return 0;
    }
  }
  if (j->publish_to[0] && (!safe_path(j->publish_to) || !strcmp(j->publish_to, j->destination))) {
    snprintf(error, cap, "publishTo must be another absolute file path"); return 0;
  }
  if (j->sha256[0]) {
    for (char* p = j->sha256; *p; ++p) *p = (char)tolower((unsigned char)*p);
    if (!is_hex64(j->sha256)) { snprintf(error, cap, "sha256 must be 64 hex digits"); return 0; }
  }
  if (!j->range_bytes) j->range_bytes = DEFAULT_RANGE;
  if (j->range_bytes < 1024 * 1024 || j->range_bytes > 256ull * 1024 * 1024) { snprintf(error, cap, "rangeBytes out of range"); return 0; }
  if (!j->connections) j->connections = 8;
  if (j->connections > 64) j->connections = 64;
  if (!safe_token_text(j->kind) || !safe_token_text(j->item_id) || !safe_token_text(j->file_id) || !safe_token_text(j->provider)) {
    snprintf(error, cap, "invalid source"); return 0;
  }
  if (!j->provider[0]) snprintf(j->provider, sizeof j->provider, "direct");
  return 1;
}

typedef struct { int ok; } LoadCtx;
static int load_jobs_field(JP* jp, const char* key, void* ctx) {
  (void)ctx;
  if (!strcmp(key, "next")) { uint64_t n; if (!jp_uint(jp, &n)) return -1; g_next_id = (unsigned)n; return 1; }
  if (strcmp(key, "jobs")) return 0;
  jp_ws(jp);
  if (jp->p >= jp->end || *jp->p != '[') return -1;
  ++jp->p;
  jp_ws(jp);
  if (jp->p < jp->end && *jp->p == ']') { ++jp->p; return 1; }
  for (;;) {
    Job* j = calloc(1, sizeof *j);
    if (!j) return -1;
    JobParse parse = {j, 0};
    if (!jp_object(jp, job_field, &parse)) { free(j); return -1; }
    char error[200];
    if (g_job_count < MAX_JOBS && j->id[0] && validate_job(j, error, sizeof error)) {
      // Um job que estava baixando quando o processo parou volta para a fila e continua.
      if (!strcmp(j->state, "connecting") || !strcmp(j->state, "downloading") || !strcmp(j->state, "verifying") || !j->state[0])
        snprintf(j->state, sizeof j->state, "queued");
      g_jobs[g_job_count++] = j;
    } else {
      free(j);
    }
    jp_ws(jp);
    if (jp->p < jp->end && *jp->p == ',') { ++jp->p; continue; }
    if (jp->p < jp->end && *jp->p == ']') { ++jp->p; return 1; }
    return -1;
  }
}

static void load_jobs(void) {
  char path[600];
  snprintf(path, sizeof path, "%s/jobs.json", g_dir);
  size_t size = 0;
  char* text = read_text(path, 8 * 1024 * 1024, &size);
  if (!text) return;
  JP jp = {text, text + size, 0};
  if (!jp_object(&jp, load_jobs_field, NULL)) logf_("jobs.json invalido; lido ate onde deu (%d job(s))", g_job_count);
  free(text);
  logf_("fila carregada: %d job(s)", g_job_count);
}

// ---- Chave do servico debrid (ponto isolado) -------------------------------------------------------------
//
// debrid_key(service, out, cap) -> 1 com a chave em `out`, 0 sem chave. Nunca registra a chave.
// Ordem:
//   1. a chave em memoria que o app entregou por POST /secret (so loopback + token; nunca gravada);
//   2. o debrid.json do app (hoje em texto puro: {"torbox":{"key":"..."},"alldebrid":{"key":"..."}}), lido dos
//      caminhos de key_files(): no PS5 a pasta do app fora do sandbox (/mnt/sandbox/PPSA99471_00N/download0/
//      JobeesLair/debrid.json, que so existe enquanto o sistema mantem o download0 do app montado); no Linux
//      $BGDL_KEYFILE.
// Para quando o debrid.json for cifrado: troque apenas read_key_file() pela decifragem (mesma assinatura);
// o resto do payload nao muda.
static pthread_mutex_t g_key_lock = PTHREAD_MUTEX_INITIALIZER;
static char g_memory_key[2][96]; // [0] torbox, [1] alldebrid

typedef struct { const char* service; char* out; size_t cap; int found; } KeyCtx;
static int key_inner(JP* jp, const char* key, void* ctx) {
  KeyCtx* k = ctx;
  if (strcmp(key, "key")) return 0;
  if (!jp_text(jp, k->out, k->cap)) return -1;
  k->found = k->out[0] != 0;
  return 1;
}
static int key_outer(JP* jp, const char* key, void* ctx) {
  KeyCtx* k = ctx;
  if (strcmp(key, k->service)) return 0;
  jp_ws(jp);
  if (jp->p < jp->end && *jp->p == '{') return jp_object(jp, key_inner, k) ? 1 : -1;
  return 0;
}
static int read_key_file(const char* path, const char* service, char* out, size_t cap) {
  size_t size = 0;
  char* text = read_text(path, 2 * 1024 * 1024, &size);
  if (!text) return 0;
  KeyCtx k = {service, out, cap, 0};
  JP jp = {text, text + size, 0};
  int ok = jp_object(&jp, key_outer, &k) && k.found && safe_token_text(out);
  memset(text, 0, size);
  free(text);
  if (!ok) out[0] = 0;
  return ok;
}
static int key_files(char paths[][256], int max) {
  int n = 0;
#ifdef __PROSPERO__
  for (int i = 0; i < 4 && n < max; ++i) snprintf(paths[n++], 256, "/mnt/sandbox/%s_%03d/download0/JobeesLair/debrid.json", BG_TITLE, i);
#else
  const char* path = getenv("BGDL_KEYFILE");
  if (path && n < max) snprintf(paths[n++], 256, "%s", path);
#endif
  return n;
}
static int debrid_key(const char* service, char* out, size_t cap) {
  int slot = !strcmp(service, "alldebrid") ? 1 : 0;
  pthread_mutex_lock(&g_key_lock);
  copy_text(out, cap, g_memory_key[slot]);
  pthread_mutex_unlock(&g_key_lock);
  if (out[0]) return 1;
  char paths[4][256];
  int count = key_files(paths, 4);
  for (int i = 0; i < count; ++i) if (read_key_file(paths[i], service, out, cap)) return 1;
  return 0;
}

// ---- Formato compartilhado com o motor nativo (ps5-react native/shared/network.cpp) ----------------------
//
// <destino>.part     o arquivo sendo baixado (offsets de 64 bits);
// <destino>.resume   Checkpoint (96 bytes: magia "P5RDL001", total, rangeBytes, contagem, identidade sha256 em
//                    hex + \0) seguido de um byte por faixa (0/1: faixa completa e com fsync feito);
// <destino>.complete CompletionReceipt (168 bytes): prova de que o arquivo publicado foi verificado.
// As structs abaixo repetem as do C++ campo a campo (mesmo ABI x86-64, mesmo preenchimento).
typedef struct {
  char magic[8];
  uint64_t total, range_bytes;
  uint32_t count;
  char identity[65];
} Checkpoint;
typedef struct {
  char magic[8];
  char identity[65], sha256[65];
  uint64_t total, device, inode;
} Receipt;
_Static_assert(sizeof(Checkpoint) == 96, "Checkpoint deve ter o layout do motor nativo");
_Static_assert(sizeof(Receipt) == 168, "CompletionReceipt deve ter o layout do motor nativo");
static const char CHECKPOINT_MAGIC[8] = {'P', '5', 'R', 'D', 'L', '0', '0', '1'};
static const char RECEIPT_MAGIC[8] = {'P', 'S', '5', 'D', 'O', 'N', 'E', '1'};

// ---- Motor de download ----------------------------------------------------------------------------------

typedef struct Engine Engine;
typedef struct {
  Engine* e;
  CURL* curl;
  struct curl_slist* headers;
  int index;          // faixa; -1 = sonda
  int probe;
  uint64_t begin, length, got;
  uint64_t probe_from, probe_length;
  long status;
  int content_range, length_known, redirected, glitch, denied;
  uint64_t cr_begin, cr_end, cr_total, content_length;
  unsigned retry_after;
  size_t header_bytes;
  char etag[512], last_modified[128], content_type[128], encoding[64];
  char html_prefix[65];
  size_t html_len;
  char error[300];
  char detail[CURL_ERROR_SIZE];
  char* sample;
  size_t sample_len;
  int in_use;
} Conn;

struct Engine {
  Job* job;
  CURLM* multi;
  int fd;
  dev_t root_dev;
  ino_t root_ino;
  int has_root;
  int64_t root_checked;
  // Do servidor (sonda)
  int ranged, known;
  uint64_t total;
  char etag[512], last_modified[128], location[8192];
  char identity[65], receipt_identity[65], verified[65];
  unsigned char* completed;
  uint32_t count;
  uint64_t committed;
  // Faixas
  unsigned char* inflight;
  unsigned char* attempts;
  int64_t* retry_at;
  Conn conns[MAX_CONNS];
  unsigned window, max_window, success_streak;
  unsigned share;  // glibren.8: a parte deste job na soma de conexoes (budget_share_locked)
  int64_t cap_at;  // quando o alvo e a parte foram relidos (mono_ms)
  int64_t last_checkpoint;
  int64_t last_tick, last_speed_at;
  uint64_t last_speed_bytes;
  unsigned epoch;
  char fail[600];
  int needs_renew;
};

static volatile unsigned g_epoch; // muda a cada volta do repouso / troca de IP

static void set_state(Job* j, const char* state) {
  pthread_mutex_lock(&g_lock);
  snprintf(j->state, sizeof j->state, "%s", state);
  j->updated = now_s();
  save_jobs_locked();
  pthread_mutex_unlock(&g_lock);
}

static void engine_fail(Engine* e, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
static void engine_fail(Engine* e, const char* fmt, ...) {
  if (e->fail[0]) return;
  va_list args;
  va_start(args, fmt);
  vsnprintf(e->fail, sizeof e->fail, fmt, args);
  va_end(args);
}

static const char* trim_value(char* text) {
  while (*text == ' ' || *text == '\t') ++text;
  size_t n = strlen(text);
  while (n && (text[n - 1] == ' ' || text[n - 1] == '\r' || text[n - 1] == '\n')) text[--n] = 0;
  return text;
}

static int decimal(const char* text, uint64_t* out) {
  if (!*text) return 0;
  uint64_t v = 0;
  for (const char* p = text; *p; ++p) {
    if (*p < '0' || *p > '9') return 0;
    if (v > (UINT64_MAX - 9) / 10) return 0;
    v = v * 10 + (uint64_t)(*p - '0');
  }
  *out = v;
  return 1;
}

static size_t on_header(char* data, size_t size, size_t count, void* opaque) {
  Conn* c = opaque;
  size_t length = size * count;
  if (length > 65536 - c->header_bytes) { snprintf(c->error, sizeof c->error, "response headers exceed 64 KiB"); return 0; }
  c->header_bytes += length;
  char line[8300];
  if (length >= sizeof line) return length;
  memcpy(line, data, length);
  line[length] = 0;
  if (!strncmp(line, "HTTP/", 5)) {
    c->etag[0] = c->last_modified[0] = c->encoding[0] = c->content_type[0] = 0;
    c->content_range = c->length_known = 0;
    char* space = strchr(line, ' ');
    if (space && strlen(space) >= 4) {
      char code[4] = {space[1], space[2], space[3], 0};
      uint64_t status;
      if (decimal(code, &status)) c->status = (long)status;
    }
    return length;
  }
  char* colon = strchr(line, ':');
  if (!colon) return length;
  *colon = 0;
  for (char* p = line; *p; ++p) *p = (char)tolower((unsigned char)*p);
  const char* value = trim_value(colon + 1);
  if (!strcmp(line, "content-type")) {
    snprintf(c->content_type, sizeof c->content_type, "%s", value);
    for (char* p = c->content_type; *p; ++p) *p = (char)tolower((unsigned char)*p);
  } else if (!strcmp(line, "etag")) snprintf(c->etag, sizeof c->etag, "%s", value);
  else if (!strcmp(line, "last-modified")) snprintf(c->last_modified, sizeof c->last_modified, "%s", value);
  else if (!strcmp(line, "content-encoding")) snprintf(c->encoding, sizeof c->encoding, "%s", value);
  else if (!strcmp(line, "content-length")) c->length_known = decimal(value, &c->content_length);
  else if (!strcmp(line, "retry-after")) { uint64_t s; if (decimal(value, &s)) c->retry_after = (unsigned)(s > 3600 ? 3600 : s); }
  else if (!strcmp(line, "content-range") && !strncmp(value, "bytes ", 6)) {
    char a[32], b[32], t[32];
    const char* dash = strchr(value, '-');
    const char* slash = strchr(value, '/');
    if (dash && slash && dash > value + 6 && dash < slash && (size_t)(dash - value - 6) < sizeof a &&
        (size_t)(slash - dash - 1) < sizeof b && strlen(slash + 1) < sizeof t) {
      memcpy(a, value + 6, (size_t)(dash - value - 6)); a[dash - value - 6] = 0;
      memcpy(b, dash + 1, (size_t)(slash - dash - 1)); b[slash - dash - 1] = 0;
      snprintf(t, sizeof t, "%s", slash + 1);
      c->content_range = decimal(a, &c->cr_begin) && decimal(b, &c->cr_end) && decimal(t, &c->cr_total) && c->cr_begin <= c->cr_end;
    }
  }
  return length;
}

static int is_html_type(const char* type) {
  return !strncmp(type, "text/html", 9) || !strncmp(type, "application/xhtml+xml", 21);
}

// A resposta e exatamente a faixa pedida, do mesmo arquivo? (valid_file_response do motor nativo)
static int valid_range_response(Conn* c) {
  Engine* e = c->e;
  if (c->encoding[0] && strcmp(c->encoding, "identity")) return 0;
  if (e->job->reject_html && is_html_type(c->content_type)) return 0;
  if (!e->ranged) return c->status == 200;
  return c->status == 206 && c->content_range && c->cr_begin == c->begin && c->cr_end == c->begin + c->length - 1 &&
         c->cr_total == e->total && (!e->etag[0] || !strcmp(c->etag, e->etag)) &&
         (!e->last_modified[0] || !strcmp(c->last_modified, e->last_modified));
}

static void classify_invalid(Conn* c) {
  Engine* e = c->e;
  if (c->encoding[0] && strcmp(c->encoding, "identity")) { snprintf(c->error, sizeof c->error, "server sent the file with Content-Encoding %s", c->encoding); return; }
  if (e->job->reject_html && is_html_type(c->content_type)) { snprintf(c->error, sizeof c->error, "provider returned a web page; browser verification required"); return; }
  int changed = (e->etag[0] && c->etag[0] && strcmp(c->etag, e->etag)) ||
                (e->last_modified[0] && c->last_modified[0] && strcmp(c->last_modified, e->last_modified)) ||
                (e->ranged && c->content_range && c->cr_total != e->total);
  long redirects = 0;
  curl_easy_getinfo(c->curl, CURLINFO_REDIRECT_COUNT, &redirects);
  c->glitch = !changed || redirects > 0;
  if (changed) snprintf(c->error, sizeof c->error, "server changed the resource (ETag, Last-Modified or size differ)");
  else if (c->status == 200) snprintf(c->error, sizeof c->error, "server ignored the byte range (HTTP 200)");
  else snprintf(c->error, sizeof c->error, "server returned an unexpected range response (HTTP %ld)", c->status);
}

static size_t on_body(char* data, size_t size, size_t count, void* opaque) {
  Conn* c = opaque;
  Engine* e = c->e;
  size_t length = size * count;
  if (c->probe) {
    if (c->status != 206) return 0; // corpo de erro/redirecionamento, ou Range ignorado: a sonda ja tem o que precisa
    if (length > c->probe_length - c->got) { snprintf(c->error, sizeof c->error, "invalid range probe body"); return 0; }
    if (c->sample) { memcpy(c->sample + c->sample_len, data, length); c->sample_len += length; }
    c->got += length;
    return length;
  }
  if (c->status == 401 || c->status == 403) { c->denied = 1; return 0; }
  if (c->status != 200 && c->status != 206) return 0;
  if (e->job->reject_html && c->html_len < 64 && c->begin == 0) {
    size_t take = length < 64 - c->html_len ? length : 64 - c->html_len;
    memcpy(c->html_prefix + c->html_len, data, take);
    c->html_len += take;
    c->html_prefix[c->html_len] = 0;
    char lower[65];
    size_t k = 0;
    for (size_t i = 0; i < c->html_len; ++i) lower[k++] = (char)tolower((unsigned char)c->html_prefix[i]);
    lower[k] = 0;
    const char* view = lower;
    while (*view == ' ' || *view == '\t' || *view == '\r' || *view == '\n') ++view;
    if (!strncmp(view, "<!doctype html", 14) || !strncmp(view, "<html", 5)) {
      snprintf(c->error, sizeof c->error, "provider returned a web page; browser verification required");
      return 0;
    }
  }
  if (!c->got && !valid_range_response(c)) { classify_invalid(c); return 0; }
  uint64_t limit = e->ranged ? c->length : (e->known ? e->total : SAFE_INTEGER);
  if (c->got > limit || length > limit - c->got) { snprintf(c->error, sizeof c->error, "response exceeds expected size"); return 0; }
  if (!write_all(e->fd, data, length, c->begin + c->got)) {
    snprintf(c->error, sizeof c->error, "write partial file: %s", strerror(errno));
    engine_fail(e, "write partial file: %s", strerror(errno));
    return 0;
  }
  c->got += length;
  return length;
}

static int on_socket(void* opaque, curl_socket_t fd, curlsocktype purpose) {
  (void)opaque; (void)purpose;
  int window = 2 * 1024 * 1024;
  setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &window, sizeof window);
#ifdef __PROSPERO__
  int enabled = 1;
  // SO_NBIO: sem ele, no PS5 o libcurl fica ~4x mais lento e pedidos terminados nao retornam.
  return setsockopt(fd, SOL_SOCKET, SO_NBIO_PS5, &enabled, sizeof enabled) == 0 ? CURL_SOCKOPT_OK : CURL_SOCKOPT_ERROR;
#else
  return CURL_SOCKOPT_OK;
#endif
}

static void configure_transport(CURL* curl, const char* url) {
  curl_easy_setopt(curl, CURLOPT_URL, url);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
#if LIBCURL_VERSION_NUM >= 0x075500
  curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "http,https");
  curl_easy_setopt(curl, CURLOPT_REDIR_PROTOCOLS_STR, !strncmp(url, "https:", 6) ? "https" : "http,https");
#endif
  curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(curl, CURLOPT_MAXREDIRS, 5L);
  curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, (long)CURL_HTTP_VERSION_1_1);
  curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L); // verificacao SEMPRE ligada
  curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
  if (g_cainfo[0]) curl_easy_setopt(curl, CURLOPT_CAINFO, g_cainfo);
  curl_easy_setopt(curl, CURLOPT_ACCEPT_ENCODING, "identity");
  curl_easy_setopt(curl, CURLOPT_USERAGENT, "JobeesLair/0.5.5 (PS5) bg-downloader/" BG_VERSION);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1L);
  curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, 30L);
  curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 1L);
  curl_easy_setopt(curl, CURLOPT_SOCKOPTFUNCTION, on_socket);
#ifdef __PROSPERO__
  curl_easy_setopt(curl, CURLOPT_IPRESOLVE, (long)CURL_IPRESOLVE_V4);
#endif
}

static void conn_reset(Conn* c) {
  c->status = 0; c->content_range = c->length_known = c->redirected = c->glitch = c->denied = 0;
  c->cr_begin = c->cr_end = c->cr_total = c->content_length = 0;
  c->retry_after = 0; c->header_bytes = 0; c->got = 0; c->html_len = 0;
  c->etag[0] = c->last_modified[0] = c->content_type[0] = c->encoding[0] = c->error[0] = c->detail[0] = 0;
  c->html_prefix[0] = 0;
  if (c->headers) { curl_slist_free_all(c->headers); c->headers = NULL; }
}

static int conn_configure(Conn* c) {
  Engine* e = c->e;
  conn_reset(c);
  curl_easy_reset(c->curl);
  c->redirected = !c->probe && e->location[0];
  const char* url = c->redirected ? e->location : e->job->url;
  configure_transport(c->curl, url);
  curl_easy_setopt(c->curl, CURLOPT_ERRORBUFFER, c->detail);
  const char* validator = e->etag[0] ? e->etag : e->last_modified;
  if (e->ranged && !c->probe && validator[0]) {
    char header[700];
    snprintf(header, sizeof header, "If-Range: %s", validator);
    c->headers = curl_slist_append(c->headers, header);
  }
  curl_easy_setopt(c->curl, CURLOPT_HTTPHEADER, c->headers);
  curl_easy_setopt(c->curl, CURLOPT_BUFFERSIZE, 64L * 1024);
  curl_easy_setopt(c->curl, CURLOPT_WRITEFUNCTION, on_body);
  curl_easy_setopt(c->curl, CURLOPT_WRITEDATA, c);
  curl_easy_setopt(c->curl, CURLOPT_HEADERFUNCTION, on_header);
  curl_easy_setopt(c->curl, CURLOPT_HEADERDATA, c);
  curl_easy_setopt(c->curl, CURLOPT_PRIVATE, c);
  char range[64];
  if (c->probe) {
    snprintf(range, sizeof range, "%llu-%llu", (unsigned long long)c->probe_from, (unsigned long long)(c->probe_from + c->probe_length - 1));
    curl_easy_setopt(c->curl, CURLOPT_RANGE, range);
  } else if (e->ranged) {
    snprintf(range, sizeof range, "%llu-%llu", (unsigned long long)c->begin, (unsigned long long)(c->begin + c->length - 1));
    curl_easy_setopt(c->curl, CURLOPT_RANGE, range);
  }
  return 1;
}

static int stopping(Engine* e) {
  return g_stop || e->job->ctl != CTL_NONE || e->fail[0];
}

// Roda uma sonda ate o fim (no mesmo multi, para reaproveitar a conexao).
static CURLcode perform_probe(Engine* e, Conn* c) {
  CURLcode result = CURLE_FAILED_INIT;
  if (curl_multi_add_handle(e->multi, c->curl) != CURLM_OK) return result;
  int done = 0;
  while (!done && !stopping(e)) {
    int running = 0;
    if (curl_multi_perform(e->multi, &running) != CURLM_OK) break;
    int left = 0;
    CURLMsg* message;
    while ((message = curl_multi_info_read(e->multi, &left))) {
      if (message->msg == CURLMSG_DONE && message->easy_handle == c->curl) { result = message->data.result; done = 1; }
    }
    if (!done) curl_multi_poll(e->multi, NULL, 0, 100, NULL);
  }
  curl_multi_remove_handle(e->multi, c->curl);
  return done ? result : CURLE_ABORTED_BY_CALLBACK;
}

static int congested(const Conn* c, CURLcode result) {
  if (c->error[0]) return 0;
  if (c->status == 408 || c->status == 429 || (c->status >= 500 && c->status <= 599)) return 1;
  switch (result) {
    case CURLE_RECV_ERROR: case CURLE_SEND_ERROR: case CURLE_OPERATION_TIMEDOUT: case CURLE_PARTIAL_FILE:
    case CURLE_COULDNT_CONNECT: case CURLE_GOT_NOTHING: case CURLE_SSL_CONNECT_ERROR: case CURLE_COULDNT_RESOLVE_HOST:
      return 1;
    default: return 0;
  }
}

static int retry_delay_ms(const Conn* c, unsigned attempt) {
  unsigned shift = attempt ? attempt - 1 : 0;
  if (shift > 6) shift = 6;
  unsigned base = 500u << shift;
  if (base > 30000) base = 30000;
  unsigned jittered = base / 2 + (unsigned)(rand() % (int)(base / 2 + 1));
  unsigned after = (c->retry_after > 60 ? 60 : c->retry_after) * 1000u;
  return (int)(after > jittered ? after : jittered);
}

static const char* describe(const Conn* c, CURLcode result, char* out, size_t cap) {
  if (c->error[0]) snprintf(out, cap, "%s", c->error);
  else if (c->status >= 400) snprintf(out, cap, "server answered HTTP %ld", c->status);
  else if (c->detail[0]) snprintf(out, cap, "%s (%s)", curl_easy_strerror(result), c->detail);
  else snprintf(out, cap, "%s", curl_easy_strerror(result));
  return out;
}

// ---- TorBox ---------------------------------------------------------------------------------------------

typedef struct { char* data; size_t size; } Body;
static size_t on_small_body(char* data, size_t size, size_t count, void* opaque) {
  Body* b = opaque;
  size_t length = size * count;
  if (b->size + length > 256 * 1024) return 0;
  char* next = realloc(b->data, b->size + length + 1);
  if (!next) return 0;
  b->data = next;
  memcpy(b->data + b->size, data, length);
  b->size += length;
  b->data[b->size] = 0;
  return length;
}

typedef struct { int success; char data[8192]; char code[64]; } TorBoxAnswer;
static int torbox_field(JP* jp, const char* key, void* ctx) {
  TorBoxAnswer* a = ctx;
  if (!strcmp(key, "success")) return jp_bool(jp, &a->success) ? 1 : -1;
  if (!strcmp(key, "error")) { jp_ws(jp); if (jp->p < jp->end && *jp->p == '"') return jp_string(jp, a->code, sizeof a->code) ? 1 : -1; return 0; }
  if (!strcmp(key, "data")) { jp_ws(jp); if (jp->p < jp->end && *jp->p == '"') return jp_string(jp, a->data, sizeof a->data) ? 1 : -1; return 0; }
  return 0;
}

enum { RENEW_OK, RENEW_NEEDS_APP, RENEW_RETRY, RENEW_FAILED };

// Pede ao TorBox um link novo para o mesmo arquivo (requestdl). A chave vai so na query desse pedido (e assim
// que a API do TorBox a aceita); a URL montada nunca vai para o diario nem para mensagens de erro.
static int renew_link(Job* j, char* why, size_t cap) {
  if (strcmp(j->provider, "torbox") || !j->item_id[0] || (!j->file_id[0] && !j->zip)) {
    snprintf(why, cap, "provider denied the file; link expired or browser verification required (HTTP 403)");
    return RENEW_NEEDS_APP;
  }
  char key[96];
  if (!debrid_key("torbox", key, sizeof key)) {
    snprintf(why, cap, "provider denied the file; link expired or browser verification required (HTTP 403)");
    logf_("job %s: link vencido e sem chave do TorBox; aguardando o app", j->id);
    return RENEW_NEEDS_APP;
  }
  char url[1024];
  if (!strcmp(j->kind, "torrent")) {
    if (j->zip) snprintf(url, sizeof url, "%s/torrents/requestdl?token=%s&torrent_id=%s&zip_link=true", g_torbox_base, key, j->item_id);
    else snprintf(url, sizeof url, "%s/torrents/requestdl?token=%s&torrent_id=%s&file_id=%s&zip_link=false", g_torbox_base, key, j->item_id, j->file_id);
  } else {
    snprintf(url, sizeof url, "%s/webdl/requestdl?token=%s&web_id=%s&file_id=%s&zip_link=false", g_torbox_base, key, j->item_id, j->file_id);
  }
  memset(key, 0, sizeof key);
  CURL* curl = curl_easy_init();
  if (!curl) { snprintf(why, cap, "out of memory"); return RENEW_RETRY; }
  Body body = {0};
  configure_transport(curl, url);
  memset(url, 0, sizeof url);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, on_small_body);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
  CURLcode result = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_cleanup(curl);
  TorBoxAnswer answer;
  memset(&answer, 0, sizeof answer);
  int parsed = 0;
  if (body.data) { JP jp = {body.data, body.data + body.size, 0}; parsed = jp_object(&jp, torbox_field, &answer); }
  free(body.data);
  if (result != CURLE_OK) {
    snprintf(why, cap, "TorBox didn't answer: %s", curl_easy_strerror(result));
    logf_("job %s: requestdl sem resposta (%s)", j->id, curl_easy_strerror(result));
    return RENEW_RETRY;
  }
  logf_("job %s: requestdl -> HTTP %ld %s", j->id, status, answer.success ? "ok" : answer.code);
  if (status == 429 || status >= 500 || !parsed) { snprintf(why, cap, "TorBox isn't answering right now (HTTP %ld)", status); return RENEW_RETRY; }
  // O link novo tem de ser https (como o app exige); http so quando a propria API de teste e http (Linux).
  int scheme_ok = !strncmp(answer.data, "https://", 8) || (!strncmp(g_torbox_base, "http://", 7) && !strncmp(answer.data, "http://", 7));
  if (!answer.success || !scheme_ok || !safe_url(answer.data)) {
    if (!strcmp(answer.code, "BAD_TOKEN") || !strcmp(answer.code, "NO_AUTH") || !strcmp(answer.code, "AUTH_ERROR")) {
      snprintf(why, cap, "TorBox didn't accept the API key. Check it in Settings.");
      return RENEW_NEEDS_APP;
    }
    snprintf(why, cap, "TorBox gave no download link (%s)", answer.code[0] ? answer.code : "no link");
    return RENEW_FAILED;
  }
  pthread_mutex_lock(&g_lock);
  snprintf(j->url, sizeof j->url, "%s", answer.data);
  j->link_at = now_s();
  j->renewals += 1;
  save_jobs_locked();
  pthread_mutex_unlock(&g_lock);
  char host[200];
  url_host(answer.data, host, sizeof host);
  logf_("job %s: link novo do TorBox (%s)", j->id, host);
  return RENEW_OK;
}

// ---- Etapas do download ---------------------------------------------------------------------------------

static void compute_identity(Engine* e) {
  Hash h;
  hash_init(&h);
  char validator[700], total[32];
  if (e->etag[0]) snprintf(validator, sizeof validator, "etag:%s", e->etag);
  else if (e->last_modified[0]) snprintf(validator, sizeof validator, "modified:%s", e->last_modified);
  else snprintf(validator, sizeof validator, "size");
  snprintf(total, sizeof total, "%llu", (unsigned long long)e->total);
  hash_text0(&h, validator);
  hash_text0(&h, e->job->sha256);
  hash_text0(&h, total);
  if (e->has_root) { // sem \0 no fim, como o C++
    char root[64];
    snprintf(root, sizeof root, "%llu:%llu", (unsigned long long)e->root_dev, (unsigned long long)e->root_ino);
    hash_add(&h, root, strlen(root));
  }
  hash_finish(&h, e->identity);
}

static void compute_receipt_identity(Engine* e) {
  Hash h;
  hash_init(&h);
  char text[64];
  hash_text0(&h, e->job->sha256);
  snprintf(text, sizeof text, "%llu", (unsigned long long)e->job->expected_bytes);
  hash_text0(&h, text);
  snprintf(text, sizeof text, "%llu", (unsigned long long)(e->has_root ? e->root_dev : 0));
  hash_text0(&h, text);
  snprintf(text, sizeof text, "%llu", (unsigned long long)(e->has_root ? e->root_ino : 0));
  hash_text0(&h, text);
  hash_finish(&h, e->receipt_identity);
}

static int storage_matches(Engine* e) {
  if (!e->has_root) return 1;
  int64_t now = mono_ms();
  if (e->root_checked && now - e->root_checked < 1000) return 1;
  e->root_checked = now;
  struct stat st;
  if (stat(e->job->storage_root, &st) || st.st_dev != e->root_dev || st.st_ino != e->root_ino) {
    engine_fail(e, "storage disconnected or changed; reconnect the original drive before resuming");
    return 0;
  }
  return 1;
}

static int write_checkpoint(Engine* e) {
  if (!e->ranged || e->fd < 0) return 1;
  if (fsync(e->fd)) { engine_fail(e, "sync partial file: %s", strerror(errno)); return 0; }
  size_t size = sizeof(Checkpoint) + e->count;
  char* data = calloc(1, size);
  if (!data) { engine_fail(e, "out of memory"); return 0; }
  Checkpoint* header = (Checkpoint*)data;
  memcpy(header->magic, CHECKPOINT_MAGIC, 8);
  header->total = e->total;
  header->range_bytes = e->job->range_bytes;
  header->count = e->count;
  memcpy(header->identity, e->identity, 65);
  memcpy(data + sizeof(Checkpoint), e->completed, e->count);
  char path[1100];
  snprintf(path, sizeof path, "%s.resume", e->job->destination);
  int ok = save_atomic(path, data, size, 0600);
  free(data);
  if (!ok) engine_fail(e, "save checkpoint: %s", strerror(errno));
  e->last_checkpoint = mono_ms();
  return ok;
}

// Recibo que deixa o app (recoverCompleted) aceitar o arquivo publicado sem baixar de novo.
static int save_receipt(Engine* e) {
  struct stat st;
  if (fstat(e->fd, &st)) { engine_fail(e, "inspect completed file: %s", strerror(errno)); return 0; }
  Receipt r;
  memset(&r, 0, sizeof r);
  memcpy(r.magic, RECEIPT_MAGIC, 8);
  memcpy(r.identity, e->receipt_identity, 64);
  memcpy(r.sha256, e->verified, strlen(e->verified) < 64 ? strlen(e->verified) : 64);
  r.total = e->total;
  r.device = (uint64_t)st.st_dev;
  r.inode = (uint64_t)st.st_ino;
  char path[1100];
  snprintf(path, sizeof path, "%s.complete", e->job->destination);
  if (!save_atomic(path, (const char*)&r, sizeof r, 0600)) { engine_fail(e, "save completion receipt: %s", strerror(errno)); return 0; }
  return 1;
}

// O destino ja existe: so vale com um recibo que bate (recover_file do motor nativo).
static int recover_existing(Engine* e) {
  char path[1100];
  snprintf(path, sizeof path, "%s.complete", e->job->destination);
  Receipt r;
  int meta = open(path, O_RDONLY);
  int valid = meta >= 0 && read_all(meta, &r, sizeof r) && !memcmp(r.magic, RECEIPT_MAGIC, 8) &&
              !memcmp(r.identity, e->receipt_identity, 65) && r.sha256[64] == 0;
  if (meta >= 0) close(meta);
  struct stat st;
  if (!valid || stat(e->job->destination, &st) || !S_ISREG(st.st_mode) || (uint64_t)st.st_size != r.total ||
      (uint64_t)st.st_dev != r.device || (uint64_t)st.st_ino != r.inode ||
      (e->job->sha256[0] && strcmp(e->job->sha256, r.sha256)) || (e->job->expected_bytes && r.total != e->job->expected_bytes)) {
    engine_fail(e, "existing destination has no matching completion receipt; preserve it and inspect it");
    return 0;
  }
  e->total = e->committed = r.total;
  return 1;
}

// Sonda: GET Range bytes=0-0. 206 + Content-Range: o servidor aceita faixas.
static int probe_source(Engine* e) {
  Conn* c = &e->conns[0];
  for (unsigned attempt = 1;; ++attempt) {
    c->probe = 1; c->probe_from = 0; c->probe_length = 1; c->sample = NULL; c->sample_len = 0;
    conn_configure(c);
    CURLcode result = perform_probe(e, c);
    if (stopping(e)) return 0;
    if (c->status == 401 || c->status == 403 || c->status == 410) { e->needs_renew = 1; return 0; }
    char text[400];
    if ((congested(c, result) || (result == CURLE_WRITE_ERROR && c->status >= 500)) && attempt < 6) {
      logf_("job %s: sonda tentativa %u falhou: %s", e->job->id, attempt, describe(c, result, text, sizeof text));
      int64_t until = mono_ms() + retry_delay_ms(c, attempt);
      while (mono_ms() < until && !stopping(e)) sleep_ms(100);
      continue;
    }
    if (c->status >= 400) { engine_fail(e, "range probe failed (HTTP %ld, %s)", c->status, curl_easy_strerror(result)); return 0; }
    if (e->job->reject_html && is_html_type(c->content_type)) { engine_fail(e, "provider returned a web page; browser verification required"); return 0; }
    if (c->status == 200 && result == CURLE_WRITE_ERROR && !c->error[0]) {
      e->known = c->length_known; e->total = c->content_length; e->ranged = 0;
    } else if (result == CURLE_OK && c->status == 206 && c->content_range && c->cr_begin == 0 && c->cr_end == 0 && c->got == 1) {
      e->known = 1; e->total = c->cr_total; e->ranged = 1;
      if (c->etag[0] && strncmp(c->etag, "W/", 2)) snprintf(e->etag, sizeof e->etag, "%s", c->etag);
      else snprintf(e->last_modified, sizeof e->last_modified, "%s", c->last_modified);
    } else if (result == CURLE_OK && c->status == 200 && c->length_known && c->content_length == 0) {
      e->known = 1; e->total = 0; e->ranged = 0;
    } else {
      if (attempt < 6 && congested(c, result)) continue;
      engine_fail(e, "%s", c->error[0] ? c->error : "range probe failed");
      if (!c->error[0]) snprintf(e->fail, sizeof e->fail, "range probe failed (HTTP %ld, %s)", c->status, curl_easy_strerror(result));
      return 0;
    }
    if (c->encoding[0] && strcmp(c->encoding, "identity")) { engine_fail(e, "unsupported content encoding or file size"); return 0; }
    if (e->total > SAFE_INTEGER) { engine_fail(e, "unsupported content encoding or file size"); return 0; }
    char* effective = NULL;
    e->location[0] = 0;
    if (curl_easy_getinfo(c->curl, CURLINFO_EFFECTIVE_URL, &effective) == CURLE_OK && effective && strcmp(effective, e->job->url))
      snprintf(e->location, sizeof e->location, "%s", effective);
    return 1;
  }
}

// Sem ETag forte: antes de continuar, rebaixa o fim da ultima faixa completa e compara com a parcial.
static int check_sample(Engine* e) {
  uint32_t last = e->count;
  while (last && !e->completed[last - 1]) --last;
  if (!last) return 1;
  uint64_t end = (uint64_t)last * e->job->range_bytes;
  if (end > e->total) end = e->total;
  uint64_t range_start = (uint64_t)(last - 1) * e->job->range_bytes;
  uint64_t length = end - range_start < 64 * 1024 ? end - range_start : 64 * 1024;
  Conn* c = &e->conns[0];
  char* sample = malloc(length);
  char* local = malloc(length);
  if (!sample || !local) { free(sample); free(local); engine_fail(e, "out of memory"); return 0; }
  c->probe = 1; c->probe_from = end - length; c->probe_length = length; c->sample = sample; c->sample_len = 0;
  conn_configure(c);
  CURLcode result = perform_probe(e, c);
  int fetched = result == CURLE_OK && c->status == 206 && c->content_range && c->cr_begin == end - length &&
                c->cr_end == end - 1 && c->cr_total == e->total && c->sample_len == length &&
                (!e->last_modified[0] || !strcmp(c->last_modified, e->last_modified));
  c->sample = NULL; c->probe_length = 1;
  int same = fetched && pread(e->fd, local, length, (off_t)(end - length)) == (ssize_t)length && !memcmp(local, sample, length);
  free(sample); free(local);
  if (stopping(e)) return 0;
  if (!fetched) { engine_fail(e, "could not re-read the partial file's tail from the server"); return 0; }
  if (!same) { engine_fail(e, "the server's file changed since this partial download; restart from zero"); return 0; }
  return 1;
}

// Abre a parcial: nova (O_EXCL) ou retomada com o checkpoint que bate (prepare do motor nativo).
static int open_partial(Engine* e) {
  Job* j = e->job;
  char partial[1100], meta_path[1100];
  snprintf(partial, sizeof partial, "%s.part", j->destination);
  snprintf(meta_path, sizeof meta_path, "%s.resume", j->destination);
  free(e->completed); e->completed = NULL;
  e->count = 0; e->committed = 0;
  if (e->ranged) {
    uint64_t count = (e->total + j->range_bytes - 1) / j->range_bytes;
    if (count > MAX_RANGES) { engine_fail(e, "too many ranges; increase rangeBytes (maximum 65536 ranges)"); return 0; }
    e->count = (uint32_t)count;
    e->completed = calloc(count ? count : 1, 1);
    if (!e->completed) { engine_fail(e, "out of memory"); return 0; }
    compute_identity(e);
  }
  struct stat st;
  e->fd = open(partial, O_RDWR | O_CREAT | O_EXCL, 0600);
  if (e->fd < 0 && errno == EEXIST && e->ranged) {
    e->fd = open(partial, O_RDWR);
    int meta = open(meta_path, O_RDONLY);
    Checkpoint saved;
    int valid = e->fd >= 0 && meta >= 0 && !fstat(e->fd, &st) && S_ISREG(st.st_mode) && st.st_size >= 0 &&
                (uint64_t)st.st_size <= e->total && read_all(meta, &saved, sizeof saved) &&
                !memcmp(saved.magic, CHECKPOINT_MAGIC, 8) && saved.total == e->total && saved.range_bytes == j->range_bytes &&
                saved.count == e->count && !memcmp(saved.identity, e->identity, 65) && read_all(meta, e->completed, e->count);
    if (meta >= 0) close(meta);
    for (uint32_t i = 0; valid && i < e->count; ++i) if (e->completed[i] > 1) valid = 0;
    if (!valid) { engine_fail(e, "partial file has no matching durable checkpoint; remove .part/.resume or choose another destination"); return 0; }
    for (uint32_t i = 0; i < e->count; ++i) {
      if (!e->completed[i]) continue;
      uint64_t begin = (uint64_t)i * j->range_bytes, end = begin + j->range_bytes;
      if (end > e->total) end = e->total;
      if (end > (uint64_t)st.st_size) { engine_fail(e, "partial file is shorter than its checkpoint"); return 0; }
      e->committed += end - begin;
    }
    logf_("job %s: retomando a parcial (%llu de %llu bytes)", j->id, (unsigned long long)e->committed, (unsigned long long)e->total);
    if (e->committed && !e->etag[0] && !check_sample(e)) return 0;
  } else if (e->fd < 0 && errno == EEXIST && !e->ranged && access(meta_path, F_OK) != 0) {
    // Servidor sem faixas: nao ha o que retomar (sem checkpoint), comeca do zero.
    e->fd = open(partial, O_RDWR | O_TRUNC);
  }
  if (e->fd < 0) { engine_fail(e, "open partial file (parent must exist; existing partial files require a valid checkpoint): %s", strerror(errno)); return 0; }
  if (fstat(e->fd, &st) || !S_ISREG(st.st_mode) || st.st_nlink != 1 || (e->has_root && st.st_dev != e->root_dev)) {
    engine_fail(e, "partial file must be a regular, unshared file on the selected storage"); return 0;
  }
  if (e->ranged && !write_checkpoint(e)) return 0; // posse e checkpoint vazio antes do primeiro byte
  return 1;
}

static void update_progress(Engine* e, int force) {
  int64_t now = mono_ms();
  if (!force && now - e->last_tick < 500) return;
  e->last_tick = now;
  uint64_t written = e->committed;
  unsigned active = 0;
  for (unsigned i = 0; i < MAX_CONNS; ++i) if (e->conns[i].in_use) { written += e->conns[i].got; ++active; }
  if (!e->last_speed_at) { e->last_speed_at = now; e->last_speed_bytes = written; }
  pthread_mutex_lock(&g_lock);
  Job* j = e->job;
  if (now - e->last_speed_at >= 2000) {
    double rate = (double)(written - (written >= e->last_speed_bytes ? e->last_speed_bytes : written)) * 1000.0 / (double)(now - e->last_speed_at);
    j->bytes_per_second = rate;
    e->last_speed_at = now;
    e->last_speed_bytes = written;
  }
  j->written = written;
  j->total = e->total;
  j->active_connections = active;
  g_dirty = 1;
  pthread_mutex_unlock(&g_lock);
}

static Conn* free_conn(Engine* e) {
  for (unsigned i = 0; i < MAX_CONNS; ++i) if (!e->conns[i].in_use) return &e->conns[i];
  return NULL;
}

static void drop_all(Engine* e) {
  for (unsigned i = 0; i < MAX_CONNS; ++i) {
    Conn* c = &e->conns[i];
    if (!c->in_use) continue;
    curl_multi_remove_handle(e->multi, c->curl);
    if (c->index >= 0) e->inflight[c->index] = 0;
    c->in_use = 0;
    c->got = 0;
  }
}

// glibren.8: o alvo de conexoes de um job (com g_lock): o numero escolhido no celular (ate MAX_CONNS) ou, sem ele, o
// que o app mandou, ate AUTO_CONNS (o teto de antes).
static unsigned job_target_locked(const Job* j) {
  if (j->connections_set) return j->connections_set < MAX_CONNS ? j->connections_set : MAX_CONNS;
  const unsigned app = j->connections ? j->connections : 1;
  return app < AUTO_CONNS ? app : AUTO_CONNS;
}

// Quantas conexoes este job pode abrir agora (com g_lock), somando todos os jobs que baixam: no maximo CONN_BUDGET
// (MANUAL_BUDGET quando algum tem o numero escolhido no celular). Ate 4 jobs x 32 conexoes TLS com 2 MiB de buffer
// cada era possivel antes. MODIFIED (glibren.8): a soma e repartida pelo alvo de cada um (quem pede menos que a parte
// igual deixa a sobra para os outros), no minimo 2 por job (ou o alvo, se for 1).
static unsigned budget_share_locked(const Job* me) {
  unsigned want[MAX_JOBS];
  int n = 0, manual = 0;
  for (int i = 0; i < g_job_count; ++i) {
    const Job* j = g_jobs[i];
    if (!j->running) continue;
    want[n++] = job_target_locked(j);
    if (j->connections_set) manual = 1;
  }
  const unsigned mine = job_target_locked(me);
  if (n < 2) return mine < (manual ? MANUAL_BUDGET : CONN_BUDGET) ? mine : (manual ? MANUAL_BUDGET : CONN_BUDGET);
  for (int i = 1; i < n; ++i) { // em ordem crescente
    const unsigned item = want[i];
    int k = i - 1;
    while (k >= 0 && want[k] > item) { want[k + 1] = want[k]; --k; }
    want[k + 1] = item;
  }
  unsigned left = manual ? MANUAL_BUDGET : CONN_BUDGET, level = MAX_CONNS;
  for (int i = 0; i < n; ++i) {
    if (want[i] * (unsigned)(n - i) <= left) { left -= want[i]; continue; }
    level = left / (unsigned)(n - i);
    break;
  }
  if (level < 2) level = 2;
  return mine < level ? mine : level;
}

// A janela AIMD, ate a parte deste job na soma (e->share, refeita a cada CAP_REFRESH_MS).
static unsigned connection_cap(const Engine* e) {
  return e->window < e->share ? e->window : e->share;
}

// glibren.8: o alvo e a parte deste job, relidos a cada CAP_REFRESH_MS (o celular muda o numero com o download
// rodando, e outro job pode comecar ou terminar). Alvo maior: a janela vai direto a ele (o jogador pediu mais; um
// 429/5xx ainda a corta pela metade). Menor: nao abre faixa nova ate as conexoes abertas ficarem abaixo dele; as que
// sobram terminam a faixa delas (nada se perde: o checkpoint so marca faixas inteiras).
#define CAP_REFRESH_MS 250
static void refresh_cap(Engine* e, int64_t now) {
  if (e->share && now - e->cap_at < CAP_REFRESH_MS) return;
  e->cap_at = now;
  Job* j = e->job;
  pthread_mutex_lock(&g_lock);
  const unsigned target = e->ranged ? job_target_locked(j) : 1;
  const unsigned share = budget_share_locked(j);
  const int manual = j->connections_set != 0;
  pthread_mutex_unlock(&g_lock);
  e->share = e->ranged ? (share ? share : 1) : 1;
  const unsigned before = e->max_window;
  if (target == before) return;
  e->max_window = target;
  e->success_streak = 0;
  if (!before) { e->window = target < 8 ? target : 8; return; } // inicio da transferencia: comeca com ate 8, como antes
  logf_("job %s: conexoes %u -> %u (%s)", j->id, before, target, manual ? "escolhido no celular" : "do app");
  if (target > before) e->window = target;
  else if (e->window > target) e->window = target;
}

// Baixa as faixas que faltam com varias conexoes (janela AIMD). 1 = todas completas.
static int transfer_ranges(Engine* e) {
  Job* j = e->job;
  free(e->inflight); free(e->attempts); free(e->retry_at);
  uint32_t count = e->ranged ? e->count : 1;
  e->inflight = calloc(count ? count : 1, 1);
  e->attempts = calloc(count ? count : 1, 1);
  e->retry_at = calloc(count ? count : 1, sizeof(int64_t));
  if (!e->inflight || !e->attempts || !e->retry_at) { engine_fail(e, "out of memory"); return 0; }
  // MODIFIED (glibren.8): o alvo vem de refresh_cap (o do celular ou o do app), relido durante a transferencia.
  e->max_window = 0;
  e->share = 0;
  refresh_cap(e, mono_ms());
  e->epoch = g_epoch;
  int64_t last_pass = mono_ms();
  time_t last_wall = time(NULL);
  int64_t grace_until = 0, last_tick = 0;
  if (!e->ranged) { // sem faixas: uma conexao, do zero
    if (ftruncate(e->fd, 0)) { engine_fail(e, "truncate partial file: %s", strerror(errno)); return 0; }
  }
  int was_quiet = 0;
  for (;;) {
    if (stopping(e) || !storage_matches(e)) { drop_all(e); return 0; }
    // Modo quieto (o app acabou de fechar): solta as conexoes, nao grava nada e espera. As faixas em andamento sao
    // refeitas depois (o checkpoint so marca faixas inteiras); ao voltar, a janela recomeca pequena.
    if (quiet_now()) {
      if (!was_quiet) {
        unsigned open_conns = 0;
        for (unsigned i = 0; i < MAX_CONNS; ++i) open_conns += e->conns[i].in_use;
        logf_("job %s: quieto (o app fechou); %u conexao(oes) soltas", j->id, open_conns);
        drop_all(e);
        pthread_mutex_lock(&g_lock); j->bytes_per_second = 0; j->active_connections = 0; pthread_mutex_unlock(&g_lock);
        was_quiet = 1;
      }
      sleep_ms(500);
      last_pass = mono_ms();
      last_wall = time(NULL);
      continue;
    }
    if (was_quiet) {
      was_quiet = 0;
      e->window = e->max_window < 2 ? e->max_window : 2;
      e->success_streak = 0;
      logf_("job %s: saiu do modo quieto; recomecando com %u conexao(oes)", j->id, e->window);
    }
    int64_t now = mono_ms();
    time_t wall = time(NULL);
    // Processo suspenso (repouso, ou outro app na frente): as conexoes que atravessaram a suspensao caem sem
    // contar tentativa, e o servidor e reaberto pelo monitor.
    if (now - last_pass > 10000 || wall - last_wall > 10 || wall < last_wall || e->epoch != g_epoch) {
      logf_("job %s: voltou de uma suspensao/troca de rede; reabrindo as conexoes", j->id);
      drop_all(e);
      e->epoch = g_epoch;
      grace_until = now + 60000;
      sleep_ms(2000);
      now = mono_ms();
      wall = time(NULL);
    }
    last_pass = now;
    last_wall = wall;
    if (now - last_tick >= 30000) { power_tick(); last_tick = now; }
    // TorBox: link perto de vencer -> renova entre as faixas.
    if (!strcmp(j->provider, "torbox") && j->link_at && now_s() - j->link_at > RENEW_AGE_S) { e->needs_renew = 1; drop_all(e); return 0; }
    // Dispara faixas ate encher a janela, sem passar da parte deste job em CONN_BUDGET (todos os jobs somados).
    unsigned active = 0;
    for (unsigned i = 0; i < MAX_CONNS; ++i) active += e->conns[i].in_use;
    refresh_cap(e, now);
    const unsigned cap = connection_cap(e);
    int pending = 0;
    for (uint32_t i = 0; i < count; ++i) {
      if (e->ranged && e->completed[i]) continue;
      if (!e->ranged && e->committed == e->total && e->known && e->total) continue;
      pending = 1;
      if (e->inflight[i] || active >= cap || e->retry_at[i] > now) continue;
      Conn* c = free_conn(e);
      if (!c) break;
      c->index = (int)i; c->probe = 0; c->sample = NULL;
      c->begin = e->ranged ? (uint64_t)i * j->range_bytes : 0;
      c->length = e->ranged ? (c->begin + j->range_bytes > e->total ? e->total - c->begin : j->range_bytes) : (e->known ? e->total : 0);
      conn_configure(c);
      if (curl_multi_add_handle(e->multi, c->curl) != CURLM_OK) { engine_fail(e, "could not schedule a range"); return 0; }
      c->in_use = 1;
      e->inflight[i] = 1;
      ++active;
    }
    if (!pending && !active) break;
    int running = 0;
    curl_multi_perform(e->multi, &running);
    int left = 0;
    CURLMsg* message;
    while ((message = curl_multi_info_read(e->multi, &left))) {
      if (message->msg != CURLMSG_DONE) continue;
      Conn* c = NULL;
      curl_easy_getinfo(message->easy_handle, CURLINFO_PRIVATE, (char**)&c);
      CURLcode result = message->data.result;
      curl_multi_remove_handle(e->multi, c->curl);
      c->in_use = 0;
      uint32_t i = (uint32_t)c->index;
      e->inflight[i] = 0;
      int complete = result == CURLE_OK && c->got == c->length && (e->ranged || !e->known || c->got == e->total);
      if (!e->ranged && result == CURLE_OK && !e->known) { e->total = c->got; e->known = 1; complete = 1; }
      if (complete) {
        if (e->ranged) e->completed[i] = 1;
        e->committed += c->got;
        c->got = 0;
        if (++e->success_streak >= e->window && e->window < e->max_window) { ++e->window; e->success_streak = 0; }
        continue;
      }
      c->got = 0;
      if (e->fail[0]) return 0;
      char text[400];
      describe(c, result, text, sizeof text);
      if (c->denied || c->status == 401 || c->status == 403) {
        if (c->redirected && e->location[0]) { e->location[0] = 0; continue; } // o link do no expirou: volta a URL original
        logf_("job %s: faixa %u negada (HTTP %ld); link vencido", j->id, i, c->status);
        e->needs_renew = 1;
        drop_all(e);
        return 0;
      }
      if (c->redirected && c->status >= 400 && (c->status < 500 || e->attempts[i] >= 1)) e->location[0] = 0;
      int cut = c->status < 400 && congested(c, result) && now < grace_until;
      unsigned limit = congested(c, result) ? 8 : c->glitch ? 3 : 0;
      if (!cut) e->attempts[i] += 1;
      logf_("job %s: faixa %u tentativa %u falhou: %s", j->id, i, e->attempts[i], text);
      if (!cut && e->attempts[i] >= limit) {
        if (congested(c, result) && (c->status == 0 || result == CURLE_COULDNT_RESOLVE_HOST || result == CURLE_COULDNT_CONNECT)) {
          // Sem rede (ou servidor fora do ar) por muito tempo: o job volta a fila e tenta mais tarde.
          engine_fail(e, "network: %s", text);
        } else {
          engine_fail(e, "%s", text);
        }
        drop_all(e);
        return 0;
      }
      if (c->status == 429 || c->status >= 500) { e->window = e->window > 1 ? e->window / 2 : 1; e->success_streak = 0; }
      e->retry_at[i] = now + retry_delay_ms(c, e->attempts[i] ? e->attempts[i] : 1);
      pthread_mutex_lock(&g_lock); j->retries += 1; pthread_mutex_unlock(&g_lock);
      if (!e->ranged) { e->committed = 0; if (ftruncate(e->fd, 0)) {} }
    }
    const int64_t every = app_away() ? CHECKPOINT_AWAY_MS : CHECKPOINT_MS;
    if (e->ranged && mono_ms() - e->last_checkpoint >= every && !write_checkpoint(e)) { drop_all(e); return 0; }
    update_progress(e, 0);
    curl_multi_poll(e->multi, NULL, 0, 100, NULL);
  }
  update_progress(e, 1);
  return 1;
}

static int verify_file(Engine* e) {
  if (!e->job->sha256[0]) return 1;
  set_state(e->job, "verifying");
  Hash h;
  hash_init(&h);
  size_t size = 1024 * 1024;
  char* buffer = malloc(size);
  if (!buffer) { engine_fail(e, "out of memory"); return 0; }
  logf_("job %s: conferindo SHA-256 (%llu bytes)", e->job->id, (unsigned long long)e->total);
  for (uint64_t offset = 0; offset < e->total;) {
    if (stopping(e)) { free(buffer); EVP_MD_CTX_free(h.ctx); return 0; }
    // Laco so de CPU e disco por minutos num arquivo grande: cede a vez a cada 8 MiB e para no modo quieto.
    if (offset && offset % (8u * 1024 * 1024) == 0) sleep_ms(2);
    while (quiet_now() && !stopping(e)) sleep_ms(500);
    size_t wanted = e->total - offset < size ? (size_t)(e->total - offset) : size;
    ssize_t n = pread(e->fd, buffer, wanted, (off_t)offset);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { free(buffer); EVP_MD_CTX_free(h.ctx); engine_fail(e, "read/hash verification failed"); return 0; }
    hash_add(&h, buffer, (size_t)n);
    offset += (uint64_t)n;
  }
  free(buffer);
  if (!hash_finish(&h, e->verified)) { engine_fail(e, "SHA-256 verification failed"); return 0; }
  if (strcmp(e->verified, e->job->sha256)) { engine_fail(e, "SHA-256 mismatch"); return 0; }
  return 1;
}

// Publica <destino>.part como <destino> sem sobrescrever (o exFAT nao tem hard link: reserva + rename).
static int publish_file(Engine* e) {
  Job* j = e->job;
  if (!save_receipt(e)) return 0;
  char partial[1100], meta[1100];
  snprintf(partial, sizeof partial, "%s.part", j->destination);
  snprintf(meta, sizeof meta, "%s.resume", j->destination);
  int reserved = open(j->destination, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (reserved < 0) { engine_fail(e, "reserve completed filename: %s", strerror(errno)); return 0; }
  close(reserved);
  if (rename(partial, j->destination)) {
    int saved = errno;
    unlink(j->destination);
    engine_fail(e, "publish completed file: %s", strerror(saved));
    return 0;
  }
  unlink(meta);
  if (!sync_parent(j->destination)) { engine_fail(e, "sync completed directory: %s", strerror(errno)); return 0; }
  return 1;
}

static int image_name(const char* path) {
  const char* dot = strrchr(path, '.');
  if (!dot) return 0;
  return !strcasecmp(dot, ".exfat") || !strcasecmp(dot, ".ffpkg") || !strcasecmp(dot, ".ffpfs") || !strcasecmp(dot, ".ffpfsc");
}

// Os primeiros bytes dizem compactado (um 7z salvo como .exfat): fica para o app extrair.
static int looks_archive(const char* path) {
  unsigned char head[8] = {0};
  int fd = open(path, O_RDONLY);
  if (fd < 0) return 0;
  ssize_t n = read(fd, head, sizeof head);
  close(fd);
  if (n < 4) return 0;
  return !memcmp(head, "7z\xbc\xaf\x27\x1c", 6) || !memcmp(head, "Rar!\x1a\x07", 6) || !memcmp(head, "PK\x03\x04", 4);
}

// Imagem pronta: vai para homebrew/ (o ShadowMount+ monta) se o app nao estiver aberto para fazer isso ele mesmo.
static void place_image(Job* j) {
  // Logo depois de o app fechar o ShadowMount+ esta soltando a imagem do app: nada aparece em homebrew/ agora.
  while (quiet_now() && !g_stop) sleep_ms(500);
  if (!j->publish_to[0] || !image_name(j->publish_to) || app_running() || looks_archive(j->destination)) { j->awaiting_app = 1; return; }
  struct stat st;
  if (!lstat(j->publish_to, &st)) { j->awaiting_app = 1; logf_("job %s: %s ja existe; fica para o app", j->id, j->publish_to); return; }
  char parent[1024];
  snprintf(parent, sizeof parent, "%s", j->publish_to);
  char* slash = strrchr(parent, '/');
  if (slash && slash != parent) { *slash = 0; mkdir_p(parent); }
  int reserved = open(j->publish_to, O_WRONLY | O_CREAT | O_EXCL, 0644);
  if (reserved < 0) { j->awaiting_app = 1; return; }
  close(reserved);
  if (rename(j->destination, j->publish_to)) { unlink(j->publish_to); j->awaiting_app = 1; logf_("job %s: imagem nao movida: %s", j->id, strerror(errno)); return; }
  char from[1100], to[1100];
  snprintf(from, sizeof from, "%s.complete", j->destination);
  snprintf(to, sizeof to, "%s.complete", j->publish_to);
  rename(from, to);
  sync_parent(j->publish_to);
  snprintf(j->published, sizeof j->published, "%s", j->publish_to);
  logf_("job %s: imagem publicada em %s", j->id, j->publish_to);
}

static void engine_free(Engine* e) {
  for (unsigned i = 0; i < MAX_CONNS; ++i) {
    if (e->conns[i].curl) { if (e->conns[i].in_use) curl_multi_remove_handle(e->multi, e->conns[i].curl); curl_easy_cleanup(e->conns[i].curl); }
    if (e->conns[i].headers) curl_slist_free_all(e->conns[i].headers);
  }
  if (e->multi) curl_multi_cleanup(e->multi);
  if (e->fd >= 0) close(e->fd);
  free(e->completed); free(e->inflight); free(e->attempts); free(e->retry_at);
}

static void finish(Job* j, const char* state, const char* error) {
  pthread_mutex_lock(&g_lock);
  snprintf(j->state, sizeof j->state, "%s", state);
  snprintf(j->error, sizeof j->error, "%s", error ? error : "");
  j->bytes_per_second = 0;
  j->active_connections = 0;
  j->updated = now_s();
  save_jobs_locked();
  pthread_mutex_unlock(&g_lock);
}

static void notify_job(Job* j, int ok) {
  char text[600];
  const char* custom = ok ? j->notify_done : j->notify_failed;
  if (custom[0]) snprintf(text, sizeof text, "%s", custom);
  else snprintf(text, sizeof text, ok ? "Jobee'sLair: %s downloaded" : "Jobee'sLair: %s download failed", j->name[0] ? j->name : "file");
  notify(text);
}

// Uma passada de um job. Volta quando terminou, falhou, foi pausado/liberado ou o processo vai parar.
// Sem o app nao ha a conta de espaco dele: um job entregue com antecedencia so comeca se o que falta (menos a parcial)
// couber no disco com 256 MiB de folga. Devolve 1 (e o motivo) quando nao cabe; tamanho desconhecido passa.
static int space_short(const Job* j, char* why, size_t cap) {
  const uint64_t size = j->expected_bytes ? j->expected_bytes : j->total;
  if (!size) return 0;
  char part[1100], dir[1024];
  snprintf(part, sizeof part, "%s.part", j->destination);
  struct stat st;
  const uint64_t have = stat(part, &st) ? 0 : (uint64_t)st.st_size;
  const uint64_t need = (size > have ? size - have : 0) + 256ull * 1024 * 1024;
  uint64_t free_bytes = g_fake_free;
  if (!free_bytes) {
    snprintf(dir, sizeof dir, "%s", j->storage_root[0] ? j->storage_root : j->destination);
    if (!j->storage_root[0]) { char* slash = strrchr(dir, '/'); if (slash && slash != dir) *slash = 0; }
    struct statvfs vfs;
    if (statvfs(dir, &vfs)) return 0;
    free_bytes = (uint64_t)vfs.f_bavail * (uint64_t)vfs.f_frsize;
  }
  if (free_bytes >= need) return 0;
  snprintf(why, cap, "Not enough space on the drive: it needs %.1f GB free and has %.1f GB. Free space and open Jobee'sLair.",
           (double)need / 1e9, (double)free_bytes / 1e9);
  return 1;
}

static void run_job(Job* j) {
  Engine engine;
  Engine* e = &engine;
  memset(e, 0, sizeof *e);
  e->job = j;
  e->fd = -1;
  char host[200];
  url_host(j->url, host, sizeof host);
  logk_("job %s: iniciando %s (%s) -> %s%s", j->id, j->name, host, j->destination, j->ahead && !j->followed ? " [fila antecipada, app fechado]" : "");
  set_state(j, "connecting");
  e->multi = curl_multi_init();
  for (unsigned i = 0; i < MAX_CONNS && e->multi; ++i) { e->conns[i].e = e; e->conns[i].curl = curl_easy_init(); if (!e->conns[i].curl) break; }
  if (!e->multi || !e->conns[MAX_CONNS - 1].curl) { engine_fail(e, "out of memory"); goto done; }
  if (j->storage_root[0]) {
    struct stat st;
    if (stat(j->storage_root, &st) || !S_ISDIR(st.st_mode)) { engine_fail(e, "cannot open original storage root"); goto done; }
    e->root_dev = st.st_dev; e->root_ino = st.st_ino; e->has_root = 1;
  }
  compute_receipt_identity(e);
  if (j->ahead && !j->followed) {
    char why[200];
    if (space_short(j, why, sizeof why)) { finish(j, "needs-app", why); notify_job(j, 0); logf_("job %s: %s", j->id, why); goto out; }
  }
  struct stat existing;
  if (!lstat(j->destination, &existing)) {
    if (recover_existing(e)) {
      e->fd = open(j->destination, O_RDONLY);
      pthread_mutex_lock(&g_lock); j->written = j->total = e->total; pthread_mutex_unlock(&g_lock);
      logf_("job %s: o destino ja estava pronto (recibo confere)", j->id);
      if (e->fd >= 0 && !verify_file(e)) goto done;
      place_image(j);
      finish(j, "completed", NULL);
      goto out;
    }
    goto done;
  }
  for (int renew_round = 0;; ++renew_round) {
    // Link do TorBox velho: renova antes de comecar.
    if (!strcmp(j->provider, "torbox") && j->link_at && now_s() - j->link_at > RENEW_AGE_S) e->needs_renew = 1;
    if (e->needs_renew) {
      e->needs_renew = 0;
      if (renew_round >= MAX_RENEWALS) { engine_fail(e, "provider denied the file; link expired or browser verification required (HTTP 403)"); goto done; }
      char why[400];
      int renewed = renew_link(j, why, sizeof why);
      if (renewed == RENEW_NEEDS_APP) { finish(j, "needs-app", why); notify_job(j, 0); goto out; }
      if (renewed == RENEW_RETRY) { engine_fail(e, "network: %s", why); goto done; }
      if (renewed == RENEW_FAILED) { engine_fail(e, "%s", why); goto done; }
      if (e->fd >= 0) { close(e->fd); e->fd = -1; }
    }
    if (e->fd < 0) {
      char saved_etag[512], saved_modified[128];
      uint64_t saved_total = e->total;
      int had = e->identity[0] != 0;
      copy_text(saved_etag, sizeof saved_etag, e->etag);
      copy_text(saved_modified, sizeof saved_modified, e->last_modified);
      e->etag[0] = e->last_modified[0] = 0;
      if (!probe_source(e)) { if (e->needs_renew) continue; goto done; }
      if (had && (saved_total != e->total || strcmp(saved_etag, e->etag) || strcmp(saved_modified, e->last_modified))) {
        engine_fail(e, "server changed the resource (ETag, Last-Modified or size differ)"); goto done;
      }
      if (j->expected_bytes && (!e->known || e->total != j->expected_bytes)) { engine_fail(e, "expectedBytes does not match the server file size"); goto done; }
      pthread_mutex_lock(&g_lock); j->total = e->total; pthread_mutex_unlock(&g_lock);
      if (!open_partial(e)) goto done;
    }
    set_state(j, "downloading");
    if (transfer_ranges(e)) break;
    if (e->needs_renew) { write_checkpoint(e); continue; }
    goto done;
  }
  if (!write_checkpoint(e)) goto done;
  if (fsync(e->fd)) { engine_fail(e, "sync partial file: %s", strerror(errno)); goto done; }
  if (e->known && e->total != e->committed) { engine_fail(e, "download ended before the whole file arrived"); goto done; }
  if (!verify_file(e) || !publish_file(e)) goto done;
  pthread_mutex_lock(&g_lock); j->written = j->total = e->total; pthread_mutex_unlock(&g_lock);
  place_image(j);
  logk_("job %s: concluido (%llu bytes)%s", j->id, (unsigned long long)e->total, j->awaiting_app ? "; aguardando o app" : "");
  finish(j, "completed", NULL);
  notify_job(j, 1);
  goto out;
done:
  if (e->fd >= 0 && e->ranged && e->completed && !e->fail[0]) write_checkpoint(e);
  else if (e->fd >= 0 && e->ranged && e->completed && e->fail[0] && strncmp(e->fail, "partial file", 12) && strncmp(e->fail, "existing destination", 20)) {
    char keep[600];
    copy_text(keep, sizeof keep, e->fail);
    e->fail[0] = 0;
    write_checkpoint(e); // guarda o que ja veio; a falha continua sendo a de antes
    copy_text(e->fail, sizeof e->fail, keep);
  }
  if (g_stop || j->ctl == CTL_STOP) { finish(j, "queued", NULL); logf_("job %s: parado com o processo; continua na proxima vez", j->id); }
  else if (j->ctl == CTL_PAUSE) { finish(j, "paused", NULL); logf_("job %s: pausado", j->id); }
  else if (j->ctl == CTL_CANCEL || j->ctl == CTL_RELEASE) { /* tratado por quem pediu (downloader_loop) */ }
  else if (!strncmp(e->fail, "network: ", 9)) {
    // Sem rede: tenta de novo em 30 s, sem desistir (o PS5 pode estar voltando do repouso).
    pthread_mutex_lock(&g_lock);
    snprintf(j->state, sizeof j->state, "queued");
    snprintf(j->error, sizeof j->error, "%s", e->fail + 9);
    j->retry_at = now_s() + 30;
    j->updated = now_s();
    save_jobs_locked();
    pthread_mutex_unlock(&g_lock);
    logf_("job %s: sem rede (%s); tenta de novo em 30 s", j->id, e->fail + 9);
  } else {
    logk_("job %s: falhou: %s", j->id, e->fail[0] ? e->fail : "?");
    finish(j, "failed", e->fail[0] ? e->fail : "download failed");
    notify_job(j, 0);
  }
out:
  engine_free(e);
}

static void remove_partials(const Job* j) {
  static const char* suffixes[] = {".part", ".resume", ".resume.tmp", ".complete.tmp"};
  char path[1100];
  for (size_t i = 0; i < sizeof suffixes / sizeof *suffixes; ++i) {
    snprintf(path, sizeof path, "%s%s", j->destination, suffixes[i]);
    unlink(path);
  }
}

// O primeiro job baixando, para /health e /jobs ("active"); NULL sem nenhum.
static Job* first_running_locked(void) {
  for (int i = 0; i < g_job_count; ++i) if (g_jobs[i]->running) return g_jobs[i];
  return NULL;
}

// Para todos os jobs baixando: o processo vai parar (cada um grava o checkpoint).
static void stop_running_locked(void) {
  for (int i = 0; i < g_job_count; ++i) if (g_jobs[i]->running) g_jobs[i]->ctl = CTL_STOP;
}

// Um trabalhador: ate MAX_WORKERS rodam este laco, e no maximo g_max_running deles baixam ao mesmo tempo.
static void* downloader_loop(void* arg) {
  (void)arg;
  pthread_mutex_lock(&g_lock);
  while (!g_stop) {
    Job* next = NULL;
    int64_t now = now_s(), soonest = 0;
    const int away = app_away();
    // Modo quieto (o app acabou de fechar): nenhum job comeca agora.
    for (int i = 0; !quiet_now() && i < g_job_count && g_running_count < g_max_running; ++i) {
      Job* j = g_jobs[i];
      // `running` ja vale antes do estado mudar (run_job o muda sem a trava): sem ele, dois trabalhadores pegariam o mesmo job.
      if (strcmp(j->state, "queued") || j->running || j->placeholder) continue;
      // Entregue com antecedencia: com o app aberto, so quando ele o comeca (follow); fechado, segue a fila sozinho.
      if (j->ahead && !j->followed && !away) continue;
      if (j->retry_at > now) { if (!soonest || j->retry_at < soonest) soonest = j->retry_at; continue; }
      const int rank = j->ahead && !j->followed ? j->order : 0, best = next ? (next->ahead && !next->followed ? next->order : 0) : 0;
      if (!next || rank < best) next = j;
    }
    if (!next) {
      struct timespec until;
      clock_gettime(CLOCK_REALTIME, &until);
      until.tv_sec += 1;
      pthread_cond_timedwait(&g_wake_downloader, &g_lock, &until);
      continue;
    }
    next->ctl = CTL_NONE;
    next->retry_at = 0;
    next->running = 1;
    next->error[0] = 0;
    ++g_running_count;
    pthread_mutex_unlock(&g_lock);
    run_job(next);
    pthread_mutex_lock(&g_lock);
    --g_running_count;
    next->running = 0;
    if (next->ctl == CTL_CANCEL) {
      remove_partials(next);
      snprintf(next->state, sizeof next->state, "cancelled");
      next->ctl = CTL_NONE;
      logf_("job %s: cancelado", next->id);
    } else if (next->ctl == CTL_RELEASE) {
      logf_("job %s: liberado para o app (parcial mantida)", next->id);
      remove_job_locked(next);
    } else {
      next->ctl = CTL_NONE;
    }
    save_jobs_locked();
    pthread_cond_broadcast(&g_wake_downloader);
  }
  stop_running_locked();
  pthread_mutex_unlock(&g_lock);
  return NULL;
}

// config.json: { "concurrency": n, "monitor": bool, "pinSalt": hex, "pinHash": hex, "monitorText": "...", "powerTick": bool,
// "pauseOnCloseSeconds": 0..30 }, para o payload voltar igual depois de reiniciar. POST /config aceita qualquer parte dele.
// "powerTick" (padrao false) liga sceSystemServicePowerTick a cada 30 s enquanto baixa: so para testar no console, separado.
// glibren.5: "pauseOnCloseSeconds" (inteiro de 0 a 30; sem o campo, como antes) e o tempo do modo quieto ao fechar o app.
typedef struct {
  uint64_t concurrency, pause_seconds;
  int found, has_concurrency, has_monitor, monitor, has_pin_salt, has_pin_hash, has_text, has_power, power, has_pause;
  char pin_salt[65], pin_hash[65], monitor_text[300];
  // glibren.8: so de config.json (from_disk): quem escolheu os downloads simultaneos e o stamp do celular.
  int from_disk, has_by;
  char by[8];
  uint64_t stamp;
} ConfigBody;
static int config_field(JP* jp, const char* key, void* ctx) {
  ConfigBody* c = ctx;
  if (!strcmp(key, "concurrency")) { c->found = c->has_concurrency = 1; return jp_uint(jp, &c->concurrency) ? 1 : -1; }
  if (!strcmp(key, "monitor")) { c->found = c->has_monitor = 1; return jp_bool(jp, &c->monitor) ? 1 : -1; }
  if (!strcmp(key, "pinSalt")) { c->found = c->has_pin_salt = 1; return jp_text(jp, c->pin_salt, sizeof c->pin_salt) ? 1 : -1; }
  if (!strcmp(key, "pinHash")) { c->found = c->has_pin_hash = 1; return jp_text(jp, c->pin_hash, sizeof c->pin_hash) ? 1 : -1; }
  if (!strcmp(key, "monitorText")) { c->found = c->has_text = 1; return jp_text(jp, c->monitor_text, sizeof c->monitor_text) ? 1 : -1; }
  if (!strcmp(key, "powerTick")) { c->found = c->has_power = 1; return jp_bool(jp, &c->power) ? 1 : -1; }
  if (c->from_disk && !strcmp(key, "concurrencyBy")) { c->has_by = 1; return jp_text(jp, c->by, sizeof c->by) ? 1 : -1; }
  if (c->from_disk && !strcmp(key, "concurrencyStamp")) return jp_uint(jp, &c->stamp) ? 1 : -1;
  if (!strcmp(key, "pauseOnCloseSeconds")) {
    // So um inteiro (nem null, nem fracao, nem negativo); o limite e conferido em config_valid.
    double d;
    int integer;
    c->found = c->has_pause = 1;
    jp_ws(jp);
    return jp_number(jp, &d, &c->pause_seconds, &integer) && integer ? 1 : -1;
  }
  return jp_skip(jp) ? 1 : -1;
}
// O que vale: concorrencia 1..MAX_WORKERS; o PIN vem inteiro (sal e hash, 64 hex cada) ou vazio (sem PIN).
static int config_valid(const ConfigBody* c) {
  if (!c->found) return 0;
  if (c->has_concurrency && (c->concurrency < 1 || c->concurrency > MAX_WORKERS)) return 0;
  if (c->has_pause && c->pause_seconds > MAX_PAUSE_SECONDS) return 0;
  if (c->has_pin_salt != c->has_pin_hash) return 0;
  if (c->has_pin_hash && !((is_hex64(c->pin_salt) && is_hex64(c->pin_hash)) || (!c->pin_salt[0] && !c->pin_hash[0]))) return 0;
  return 1;
}
// Aplica (com a trava); devolve 1 quando algo mudou. Um PIN novo desfaz as sessoes abertas no celular.
static int config_apply_locked(const ConfigBody* c) {
  int changed = 0;
  if (c->has_concurrency && g_max_running != (int)c->concurrency) {
    logf_("downloads simultaneos: %d -> %d", g_max_running, (int)c->concurrency);
    g_max_running = (int)c->concurrency;
    g_concurrency_remote = 0; // glibren.8: o app escolheu outro numero (o do celular ja adotado nao muda nada aqui)
    changed = 1;
  }
  if (c->from_disk) {
    g_concurrency_remote = c->has_by && !strcmp(c->by, "remote");
    g_concurrency_stamp = (unsigned)c->stamp;
  }
  if (c->has_monitor && g_monitor_on != (c->monitor ? 1 : 0)) {
    g_monitor_on = c->monitor ? 1 : 0;
    logf_("pagina do celular: %s", g_monitor_on ? "ligada" : "desligada");
    changed = 1;
  }
  if (c->has_pin_hash && strcmp(g_pin_hash, c->pin_hash)) {
    snprintf(g_pin_salt, sizeof g_pin_salt, "%s", c->pin_salt);
    snprintf(g_pin_hash, sizeof g_pin_hash, "%s", c->pin_hash);
    monitor_clear_sessions();
    logf_("pagina do celular: PIN %s", g_pin_hash[0] ? "definido" : "removido");
    changed = 1;
  }
  if (c->has_text && strcmp(g_monitor_text, c->monitor_text)) {
    snprintf(g_monitor_text, sizeof g_monitor_text, "%s", c->monitor_text);
    changed = 1;
  }
  if (c->has_power && g_power_tick != (c->power ? 1 : 0)) {
    g_power_tick = c->power ? 1 : 0;
    logk_("sceSystemServicePowerTick: %s", g_power_tick ? "LIGADO (teste)" : "desligado");
    changed = 1;
  }
  // glibren.5: o tempo da pausa ao fechar o app. 0 no meio de um modo quieto o termina na hora; um tempo menor o encurta
  // (contado de quando comecou); um maior vale so para o proximo.
  if (c->has_pause && (g_pause_seconds != (int)c->pause_seconds || g_quiet_ms != (int64_t)c->pause_seconds * 1000)) {
    const long long before = (long long)(g_quiet_ms / 1000);
    g_pause_seconds = (int)c->pause_seconds;
    g_quiet_ms = (int64_t)g_pause_seconds * 1000;
    const char* now_quiet = "";
    if (quiet_now()) {
      if (!g_quiet_ms) { g_quiet_until = 0; now_quiet = "; o modo quieto em andamento terminou agora"; }
      else if (g_quiet_from + g_quiet_ms < g_quiet_until) {
        g_quiet_until = g_quiet_from + g_quiet_ms;
        now_quiet = quiet_now() ? "; o modo quieto em andamento foi encurtado" : "; o modo quieto em andamento terminou agora";
      }
    }
    logk_("pausa ao fechar o app: %lld s -> %d s%s%s", before, g_pause_seconds, g_pause_seconds ? "" : " (desligada)", now_quiet);
    changed = 1;
  }
  return changed;
}
static void load_config(void) {
  char path[600];
  snprintf(path, sizeof path, "%s/config.json", g_dir);
  size_t size = 0;
  char* text = read_text(path, 8192, &size);
  if (!text) return;
  ConfigBody c;
  memset(&c, 0, sizeof c);
  c.from_disk = 1;
  JP jp = {text, text + size, 0};
  if (jp_object(&jp, config_field, &c) && config_valid(&c)) config_apply_locked(&c);
  free(text);
}
static void save_config_locked(void) {
  char path[600];
  snprintf(path, sizeof path, "%s/config.json", g_dir);
  Buf b = {0};
  buf_fmt(&b, "{\"concurrency\":%d,\"monitor\":%s,\"pinSalt\":", g_max_running, g_monitor_on ? "true" : "false");
  buf_json(&b, g_pin_salt);
  buf_str(&b, ",\"pinHash\":");
  buf_json(&b, g_pin_hash);
  buf_str(&b, ",\"monitorText\":");
  buf_json(&b, g_monitor_text);
  buf_fmt(&b, ",\"powerTick\":%s", g_power_tick ? "true" : "false");
  buf_fmt(&b, ",\"concurrencyBy\":\"%s\",\"concurrencyStamp\":%u", g_concurrency_remote ? "remote" : "app", g_concurrency_stamp);
  // glibren.5: so quando o app mandou o tempo (sem ele, vale o padrao de quem roda: 30 s, ou BGDL_QUIET_MS nos testes).
  if (g_pause_seconds >= 0) buf_fmt(&b, ",\"pauseOnCloseSeconds\":%d", g_pause_seconds);
  buf_str(&b, "}\n");
  if (b.failed || !b.data || !save_atomic(path, b.data, b.size, 0600)) logf_("config.json nao gravado: %s", strerror(errno));
  free(b.data);
}

// ---- Servidor HTTP (127.0.0.1) --------------------------------------------------------------------------

typedef struct {
  char method[8], path[1024]; // glibren: 1024 para a busca e os filtros da Biblioteca TorBox na URL
  char token[128];
  char session[48]; // X-Session: a sessao aberta pelo PIN na pagina do celular
  size_t content_length;
  char* body;
} Request;

static int send_all(int fd, const char* data, size_t size) {
  while (size) {
#ifdef MSG_NOSIGNAL
    ssize_t n = send(fd, data, size, MSG_NOSIGNAL);
#else
    ssize_t n = send(fd, data, size, 0);
#endif
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    data += n;
    size -= (size_t)n;
  }
  return 1;
}

static void respond(int fd, int status, const char* body) {
  const char* reason = status == 200 ? "OK" : status == 201 ? "Created" : status == 400 ? "Bad Request" : status == 401 ? "Unauthorized" :
                       status == 403 ? "Forbidden" : status == 404 ? "Not Found" : status == 409 ? "Conflict" : status == 413 ? "Payload Too Large" : "Error";
  char head[256];
  int n = snprintf(head, sizeof head, "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                   status, reason, strlen(body));
  send_all(fd, head, (size_t)n);
  send_all(fd, body, strlen(body));
}

static void respond_error(int fd, int status, const char* message) {
  Buf b = {0};
  buf_str(&b, "{\"error\":");
  buf_json(&b, message);
  buf_str(&b, "}");
  respond(fd, status, b.data ? b.data : "{}");
  free(b.data);
}

static int read_request(int fd, Request* r) {
  char head[16384];
  size_t used = 0;
  char* end = NULL;
  while (!end) {
    if (used + 1 >= sizeof head) return 413;
    ssize_t n = recv(fd, head + used, sizeof head - 1 - used, 0);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    used += (size_t)n;
    head[used] = 0;
    end = strstr(head, "\r\n\r\n");
  }
  size_t head_size = (size_t)(end - head) + 4;
  *end = 0;
  char* line_end = strstr(head, "\r\n");
  if (line_end) *line_end = 0;
  if (sscanf(head, "%7s %1023s", r->method, r->path) != 2) return 400;
  for (char* line = line_end ? line_end + 2 : NULL; line && *line;) {
    char* next = strstr(line, "\r\n");
    if (next) *next = 0;
    char* colon = strchr(line, ':');
    if (colon) {
      *colon = 0;
      const char* value = colon + 1;
      while (*value == ' ' || *value == '\t') ++value;
      if (!strcasecmp(line, "content-length")) { uint64_t n; if (!decimal(value, &n) || n > 64 * 1024) return 413; r->content_length = (size_t)n; }
      else if (!strcasecmp(line, "x-jobe-token")) snprintf(r->token, sizeof r->token, "%s", value);
      else if (!strcasecmp(line, "x-session")) snprintf(r->session, sizeof r->session, "%s", value);
      else if (!strcasecmp(line, "authorization") && !strncasecmp(value, "Bearer ", 7)) snprintf(r->token, sizeof r->token, "%s", value + 7);
    }
    line = next ? next + 2 : NULL;
  }
  r->body = calloc(1, r->content_length + 1);
  if (!r->body) return 500;
  size_t have = used - head_size;
  if (have > r->content_length) have = r->content_length;
  memcpy(r->body, head + head_size, have);
  while (have < r->content_length) {
    ssize_t n = recv(fd, r->body + have, r->content_length - have, 0);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    have += (size_t)n;
  }
  return 200;
}

static int token_ok(const char* given) {
  size_t a = strlen(given), b = strlen(g_token);
  unsigned diff = (unsigned)(a ^ b);
  for (size_t i = 0; i < b; ++i) diff |= (unsigned)(unsigned char)g_token[i] ^ (unsigned)(unsigned char)(i < a ? given[i] : 0);
  return b == 64 && diff == 0;
}

typedef struct { char service[16]; char key[96]; } SecretBody;
static int secret_field(JP* jp, const char* key, void* ctx) {
  SecretBody* s = ctx;
  if (!strcmp(key, "service")) return jp_text(jp, s->service, sizeof s->service) ? 1 : -1;
  if (!strcmp(key, "key")) return jp_text(jp, s->key, sizeof s->key) ? 1 : -1;
  return 0;
}

// "Acompanhe pelo celular em http://IP:34201", uma vez por processo, quando o primeiro download chega ao payload.
static void announce_monitor(void) {
  char text[300], ip[64];
  pthread_mutex_lock(&g_lock);
  const int due = g_monitor_on && !g_monitor_announced && g_monitor_text[0];
  snprintf(text, sizeof text, "%s", g_monitor_text);
  pthread_mutex_unlock(&g_lock);
  if (!due || current_ip(ip, sizeof ip) || !ip[0]) return;
  char address[96], out[720];
  snprintf(address, sizeof address, "http://%s:%d", ip, g_monitor_port_now());
  const char* mark = strstr(text, "{address}");
  if (mark) snprintf(out, sizeof out, "%.*s%s%s", (int)(mark - text), text, address, mark + 9);
  else snprintf(out, sizeof out, "%s %s", text, address);
  pthread_mutex_lock(&g_lock);
  g_monitor_announced = 1;
  pthread_mutex_unlock(&g_lock);
  notify(out);
}

static void handle_create(int fd, Request* r) {
  Job* j = calloc(1, sizeof *j);
  if (!j) { respond_error(fd, 500, "out of memory"); return; }
  JobParse parse = {j, 0};
  JP jp = {r->body, r->body + r->content_length, 0};
  char error[200];
  if (!jp_object(&jp, job_field, &parse)) { free(j); respond_error(fd, 400, "invalid JSON body"); return; }
  j->id[0] = 0; j->state[0] = 0; j->error[0] = 0; j->by[0] = 0; j->published[0] = 0; j->awaiting_app = 0; j->renewals = 0; j->written = j->total = 0;
  j->connections_set = 0; // glibren.8: so o celular escolhe (POST /api/jobs/<id>/connections, ou /jobs/<id>/connections)
  j->requested = 0;        // glibren: pedidos da Biblioteca TorBox so nascem no celular
  if (!validate_job(j, error, sizeof error)) { free(j); respond_error(fd, 400, error); return; }
  pthread_mutex_lock(&g_lock);
  for (int i = 0; i < g_job_count; ++i) {
    Job* other = g_jobs[i];
    if (strcmp(other->destination, j->destination) && strcmp(other->published, j->destination)) continue;
    if (!terminal(other->state)) { // nunca dois donos do mesmo arquivo
      Buf b = {0};
      buf_str(&b, "{\"error\":\"a job already owns this destination\",\"id\":");
      buf_json(&b, other->id);
      buf_str(&b, "}");
      pthread_mutex_unlock(&g_lock);
      respond(fd, 409, b.data ? b.data : "{}");
      free(b.data);
      free(j);
      return;
    }
    remove_job_locked(other); // um terminado com o mesmo destino da lugar ao novo
    --i;
  }
  if (g_job_count >= MAX_JOBS) { pthread_mutex_unlock(&g_lock); free(j); respond_error(fd, 409, "too many jobs"); return; }
  snprintf(j->id, sizeof j->id, "b%u", ++g_next_id);
  snprintf(j->state, sizeof j->state, "queued");
  j->created = j->updated = now_s();
  if (!j->link_at) j->link_at = now_s();
  else if (j->link_at > 100000000000LL) j->link_at /= 1000; // milissegundos do JS
  // glibren.8: o app comecou um item da fila dele (a chave): vale o numero de conexoes escolhido no celular para ele.
  j->connections_set = carried_connections_locked(j->key, NULL);
  if (j->connections_set) logf_("job %s: %u conexoes escolhidas no celular para o item da fila", j->id, j->connections_set);
  g_jobs[g_job_count++] = j;
  save_jobs_locked();
  pthread_cond_broadcast(&g_wake_downloader);
  Buf b = {0};
  buf_str(&b, "{\"id\":");
  buf_json(&b, j->id);
  buf_str(&b, ",\"job\":");
  job_json(&b, j);
  buf_str(&b, "}");
  pthread_mutex_unlock(&g_lock);
  char host[200];
  url_host(j->url, host, sizeof host);
  logf_("job %s criado: %s (%s, %s)", j->id, j->name, host, j->provider);
  respond(fd, 201, b.data ? b.data : "{}");
  free(b.data);
  announce_monitor();
}

// POST /queue {"items":[{"key","name","total","job"?:{...}}]}: a fila do app que ainda nao comecou, na ordem. Com
// "job" (link direto ou TorBox, que o payload baixa sozinho) o item vira um job antecipado; sem, um marcador
// "waiting-app" (so o app sabe baixa-lo). O que sumiu da lista sai: antecipado parado (a parcial fica), rodando sem o
// app acompanhar (para, gravando o checkpoint, e sai), marcador. Terminados ficam para o app conferir ao abrir.
// MODIFIED (glibren.8): "paused" (pausado no app) e "written" (o progresso dele) tambem vem: o pausado continua na
// fila entregue (Pausado na pagina do celular, com o progresso) em vez de sumir dela.
typedef struct { char key[128], name[256]; uint64_t total, written; Job* job; int has_job, paused; } QueueItem;
typedef struct { QueueItem* item; } QueueItemCtx;
static int queue_item_field(JP* jp, const char* key, void* ctx) {
  QueueItem* q = ((QueueItemCtx*)ctx)->item;
  if (!strcmp(key, "key")) return jp_text(jp, q->key, sizeof q->key) ? 1 : -1;
  if (!strcmp(key, "name")) return jp_text(jp, q->name, sizeof q->name) ? 1 : -1;
  if (!strcmp(key, "total")) return jp_uint(jp, &q->total) ? 1 : -1;
  if (!strcmp(key, "written")) return jp_uint(jp, &q->written) ? 1 : -1;
  if (!strcmp(key, "paused")) return jp_bool(jp, &q->paused) ? 1 : -1;
  if (!strcmp(key, "job")) {
    jp_ws(jp);
    if (jp_literal(jp, "null")) return 1;
    if (!q->job && !(q->job = calloc(1, sizeof *q->job))) return -1;
    JobParse parse = {q->job, 0};
    q->has_job = 1;
    return jp_object(jp, job_field, &parse) ? 1 : -1;
  }
  return jp_skip(jp) ? 1 : -1;
}
typedef struct { QueueItem* items; int count; } QueueBody;
static int queue_field(JP* jp, const char* key, void* ctx) {
  QueueBody* body = ctx;
  if (strcmp(key, "items")) return jp_skip(jp) ? 1 : -1;
  jp_ws(jp);
  if (jp->p >= jp->end || *jp->p != '[') return -1;
  ++jp->p;
  jp_ws(jp);
  if (jp->p < jp->end && *jp->p == ']') { ++jp->p; return 1; }
  for (;;) {
    if (body->count >= MAX_JOBS) return -1;
    QueueItemCtx item = {&body->items[body->count++]};
    if (!jp_object(jp, queue_item_field, &item)) return -1;
    jp_ws(jp);
    if (jp->p < jp->end && *jp->p == ',') { ++jp->p; jp_ws(jp); continue; }
    if (jp->p < jp->end && *jp->p == ']') { ++jp->p; return 1; }
    return -1;
  }
}
static Job* find_destination_locked(const char* destination) {
  for (int i = 0; i < g_job_count; ++i)
    if (!g_jobs[i]->placeholder && (!strcmp(g_jobs[i]->destination, destination) || !strcmp(g_jobs[i]->published, destination))) return g_jobs[i];
  return NULL;
}
static Job* find_placeholder_locked(const char* key) {
  for (int i = 0; i < g_job_count; ++i) if (g_jobs[i]->placeholder && !strcmp(g_jobs[i]->key, key)) return g_jobs[i];
  return NULL;
}
static void handle_queue(int fd, Request* r) {
  QueueBody body = {calloc(MAX_JOBS, sizeof(QueueItem)), 0};
  if (!body.items) { respond_error(fd, 500, "out of memory"); return; }
  JP jp = {r->body, r->body + r->content_length, 0};
  int ok = jp_object(&jp, queue_field, &body);
  char error[200] = "";
  for (int i = 0; ok && i < body.count; ++i) {
    QueueItem* q = &body.items[i];
    if (!q->key[0] || !queue_key_ok(q->key)) { snprintf(error, sizeof error, "item %d: key", i); ok = 0; break; }
    if (q->has_job) {
      Job* j = q->job;
      j->id[0] = j->state[0] = j->error[0] = j->by[0] = j->published[0] = 0;
      j->placeholder = 0;
      j->requested = 0;
      j->connections_set = 0; // glibren.8: so o celular escolhe
      snprintf(j->key, sizeof j->key, "%s", q->key);
      if (!j->name[0]) snprintf(j->name, sizeof j->name, "%s", q->name);
      if (!j->expected_bytes) j->expected_bytes = q->total;
      if (!validate_job(j, error, sizeof error)) ok = 0;
    }
  }
  if (!ok) {
    for (int i = 0; i < body.count; ++i) free(body.items[i].job);
    free(body.items);
    respond_error(fd, 400, error[0] ? error : "expected {items:[{key, name, total, job?}]}");
    return;
  }
  pthread_mutex_lock(&g_lock);
  int seen[MAX_JOBS] = {0}, created = 0, waiting = 0;
  for (int i = 0; i < body.count; ++i) {
    QueueItem* q = &body.items[i];
    Job* j = q->has_job ? find_destination_locked(q->job->destination) : find_placeholder_locked(q->key);
    if (!j && g_job_count < MAX_JOBS) {
      if (q->has_job) {
        j = q->job;
        q->job = NULL;
        j->ahead = 1;
        snprintf(j->id, sizeof j->id, "b%u", ++g_next_id);
        snprintf(j->state, sizeof j->state, "queued");
        j->created = j->updated = now_s();
        if (!j->link_at) j->link_at = now_s();
        else if (j->link_at > 100000000000LL) j->link_at /= 1000;
        j->connections_set = carried_connections_locked(q->key, NULL); // glibren.8: o marcador dele pode ter um numero
        ++created;
      } else {
        j = calloc(1, sizeof *j);
        if (!j) break;
        j->placeholder = 1;
        snprintf(j->key, sizeof j->key, "%s", q->key);
        snprintf(j->id, sizeof j->id, "b%u", ++g_next_id);
        snprintf(j->state, sizeof j->state, "waiting-app");
        j->created = now_s();
      }
      g_jobs[g_job_count++] = j;
    }
    if (!j) continue;
    if (j->placeholder) { snprintf(j->name, sizeof j->name, "%s", q->name); j->total = q->total; j->written = q->written; ++waiting; }
    if (j->ahead) snprintf(j->key, sizeof j->key, "%s", q->key);
    // MODIFIED (glibren.8): pausado no app fica pausado aqui (e nao some da pagina do celular); retomado no app volta a
    // fila. Um pedido do celular (by "remote") vale ate a fila do app concordar com ele (o app ja o repetiu): so entao
    // a marca sai. Rodando, ou acompanhado pelo app (follow), quem manda e o job.
    if (!j->running && !j->followed) {
      const int paused = !strcmp(j->state, "paused");
      const int waiting_state = !strcmp(j->state, j->placeholder ? "waiting-app" : "queued");
      if (!strcmp(j->by, "remote")) { if (paused == !!q->paused && (paused || waiting_state)) j->by[0] = 0; }
      else if (q->paused && waiting_state) snprintf(j->state, sizeof j->state, "paused");
      else if (!q->paused && paused) snprintf(j->state, sizeof j->state, "%s", j->placeholder ? "waiting-app" : "queued");
      if (!j->placeholder && !j->written && q->written) j->written = q->written;
    }
    j->order = i + 1;
    j->updated = now_s();
    for (int k = 0; k < g_job_count; ++k) if (g_jobs[k] == j) seen[k] = 1;
  }
  // O que nao veio na lista: marcadores e antecipados parados saem; um antecipado rodando sem o app para e sai.
  int removed = 0;
  for (int k = g_job_count - 1; k >= 0; --k) {
    Job* j = g_jobs[k];
    if (seen[k] || (!j->ahead && !j->placeholder) || j->followed || j->requested) continue;
    if (j->running) { j->ctl = CTL_RELEASE; ++removed; continue; }
    if (!j->placeholder && terminal(j->state)) continue;
    remove_job_locked(j);
    ++removed;
  }
  save_jobs_locked();
  pthread_cond_broadcast(&g_wake_downloader);
  char answer[160];
  snprintf(answer, sizeof answer, "{\"ok\":true,\"created\":%d,\"waiting\":%d,\"removed\":%d}", created, waiting, removed);
  pthread_mutex_unlock(&g_lock);
  for (int i = 0; i < body.count; ++i) free(body.items[i].job);
  free(body.items);
  if (created || removed) logf_("fila do app: %d itens (%d novos antecipados, %d aguardando o app, %d saiu)", body.count, created, waiting, removed);
  respond(fd, 200, answer);
}

// pause | resume | cancel | release | forget, com a trava. `remote`: pedido do celular (so pause/resume/cancel),
// que fica em j->by para o app nao desfazer a pausa. Devolve 200, 404 (acao desconhecida) ou 409 (forget de um
// job rodando); *removed: o job saiu da lista (e foi liberado).
static int job_action_locked(Job* j, const char* action, int remote, int* removed) {
  *removed = 0;
  const char* by = remote ? "remote" : "";
  // MODIFIED (glibren.8): um marcador (so o app baixa) tambem pausa, retoma (volta a "waiting-app": o app retoma) e
  // cancela pelo celular, so na marca: quem age e o app, que ve o "by" no GET /jobs. A retomada do celular tambem fica
  // marcada (by "remote"), para o app saber que tem de retomar um que ele tinha pausado.
  if (!strcmp(action, "pause")) {
    if (j->running) { j->ctl = CTL_PAUSE; snprintf(j->by, sizeof j->by, "%s", by); }
    else if (!strcmp(j->state, "queued") || (j->placeholder && !strcmp(j->state, "waiting-app"))) {
      snprintf(j->state, sizeof j->state, "paused"); snprintf(j->by, sizeof j->by, "%s", by);
    }
  } else if (!strcmp(action, "resume")) {
    if (!strcmp(j->state, "paused") || !strcmp(j->state, "failed") || !strcmp(j->state, "needs-app")) {
      snprintf(j->state, sizeof j->state, "%s", j->placeholder ? "waiting-app" : "queued");
      j->error[0] = 0;
      j->retry_at = 0;
      snprintf(j->by, sizeof j->by, "%s", by);
    } else if (j->running && j->ctl == CTL_PAUSE) { j->ctl = CTL_NONE; snprintf(j->by, sizeof j->by, "%s", by); }
  } else if (!strcmp(action, "cancel")) {
    if (j->requested && !j->running) { remove_job_locked(j); *removed = 1; } // glibren: pedido do celular: so sai
    else if (j->running) { j->ctl = CTL_CANCEL; snprintf(j->by, sizeof j->by, "%s", by); }
    else if (strcmp(j->state, "completed")) {
      if (!j->placeholder) remove_partials(j); // um marcador nao tem arquivo (destino vazio)
      snprintf(j->state, sizeof j->state, "cancelled"); snprintf(j->by, sizeof j->by, "%s", by);
    }
  } else if (remote) {
    return 404;
  } else if (!strcmp(action, "follow")) {
    j->followed = 1;
    pthread_cond_broadcast(&g_wake_downloader);
    return 200;
  } else if (!strcmp(action, "release")) {
    // Devolve o arquivo ao app: para (gravando o checkpoint) e esquece o job, mantendo .part/.resume.
    if (j->running) j->ctl = CTL_RELEASE;
    else { remove_job_locked(j); *removed = 1; }
  } else if (!strcmp(action, "park")) {
    // MODIFIED (glibren.8): a pausa no app (ou a do celular, repetida pelo app). Antes o app liberava o job (release) e
    // ele sumia da pagina do celular. Agora para (gravando o checkpoint) e fica "paused", de volta a fila entregue
    // (ahead, sem follow): a fila do app (POST /queue) o mantem enquanto estiver pausado la, ou o tira (a parcial
    // fica); retomado no celular, o app retoma; com o app fechado, o payload segue sozinho.
    if (j->placeholder) return 404;
    j->ahead = 1;
    j->followed = 0;
    j->by[0] = 0;
    if (j->running) j->ctl = CTL_PAUSE;
    else if (!strcmp(j->state, "queued")) snprintf(j->state, sizeof j->state, "paused");
  } else if (!strcmp(action, "forget")) {
    if (j->running) return 409;
    remove_job_locked(j);
    *removed = 1;
  } else {
    return 404;
  }
  if (!*removed) j->updated = now_s();
  save_jobs_locked();
  pthread_cond_broadcast(&g_wake_downloader);
  return 200;
}

// glibren.8: {"connections": N} no corpo: 1..64 escolhe o numero de conexoes do job; 0 (ou null) volta ao do app.
typedef struct { uint64_t connections; int found; } ConnectionsBody;
static int connections_field(JP* jp, const char* key, void* ctx) {
  ConnectionsBody* c = ctx;
  if (strcmp(key, "connections")) return jp_skip(jp) ? 1 : -1;
  c->found = 1;
  jp_ws(jp);
  if (jp_literal(jp, "null")) { c->connections = 0; return 1; }
  double d;
  int integer;
  return jp_number(jp, &d, &c->connections, &integer) && integer ? 1 : -1;
}
static int connections_body(const Request* r, unsigned* out) {
  ConnectionsBody c = {0, 0};
  JP jp = {r->body, r->body + r->content_length, 0};
  if (!jp_object(&jp, connections_field, &c) || !c.found || c.connections > 64) return 0;
  *out = (unsigned)c.connections;
  return 1;
}
// Muda o numero de conexoes de um job (com g_lock): baixando (o motor o rele em ate CAP_REFRESH_MS), na fila, pausado
// ou so um marcador "waiting-app" (vale quando o app o comecar). 0 se o job ja terminou.
static int set_connections_locked(Job* j, unsigned connections, const char* who) {
  if (!strcmp(j->state, "cancelled") || !strcmp(j->state, "completed")) return 0;
  if (j->connections_set != connections) {
    j->connections_set = connections;
    if (connections) logf_("%s: job %s com %u conexoes", who, j->id, connections);
    else logf_("%s: job %s volta as conexoes do app", who, j->id);
    j->updated = now_s();
    save_jobs_locked();
  }
  return 1;
}

static void handle_action(int fd, const char* id, const char* action) {
  pthread_mutex_lock(&g_lock);
  Job* j = find_job_locked(id);
  if (!j) { pthread_mutex_unlock(&g_lock); respond_error(fd, 404, "no such job"); return; }
  int removed = 0;
  const int status = job_action_locked(j, action, 0, &removed);
  if (status == 404) { pthread_mutex_unlock(&g_lock); respond_error(fd, 404, "unknown action"); return; }
  Buf b = {0};
  if (status == 409) buf_str(&b, "{\"error\":\"the job is running; release it first\"}");
  else if (!removed) { buf_str(&b, "{\"ok\":true,\"job\":"); job_json(&b, j); buf_str(&b, "}"); }
  else buf_str(&b, "{\"ok\":true,\"removed\":true}");
  pthread_mutex_unlock(&g_lock);
  respond(fd, status, b.data ? b.data : "{}");
  free(b.data);
}

typedef struct { char error[400]; } RefuseBody;
static int refuse_field(JP* jp, const char* key, void* ctx) {
  if (!strcmp(key, "error")) return lib_text(jp, ((RefuseBody*)ctx)->error, sizeof ((RefuseBody*)ctx)->error) ? 1 : -1;
  return 0;
}

static void route(int fd, Request* r) {
  if (!token_ok(r->token)) { respond_error(fd, 401, "missing or wrong token"); return; }
  // glibren.5: logo depois de um POST /bye, uma chamada atrasada do app nao o faz "voltar a falar".
  if (strcmp(r->path, "/bye") && mono_ms() - g_bye_ms >= BYE_GRACE_MS) g_last_app_ms = mono_ms();
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/health")) {
    char body[512], ip[64];
    current_ip(ip, sizeof ip);
    pthread_mutex_lock(&g_lock);
    const Job* active = first_running_locked();
    snprintf(body, sizeof body, "{\"ok\":true,\"version\":\"%s\",\"pid\":%d,\"active\":%s%s%s,\"jobs\":%d,\"running\":%d,\"concurrency\":%d,"
             "\"concurrencyBy\":\"%s\",\"concurrencyStamp\":%u,"
             "\"ip\":\"%s\",\"monitor\":%s,\"monitorPort\":%d,\"pinSet\":%s,\"pauseOnCloseSeconds\":%lld,\"quiet\":%s}",
             BG_VERSION, (int)getpid(), active ? "\"" : "", active ? active->id : "null", active ? "\"" : "", g_job_count,
             g_running_count, g_max_running, g_concurrency_remote ? "remote" : "app", g_concurrency_stamp, ip, g_monitor_on ? "true" : "false",
             g_monitor_port_now(), g_pin_hash[0] ? "true" : "false", (long long)(g_quiet_ms / 1000), quiet_now() ? "true" : "false");
    pthread_mutex_unlock(&g_lock);
    respond(fd, 200, body);
    return;
  }
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/jobs")) {
    Buf b = {0};
    pthread_mutex_lock(&g_lock);
    buf_str(&b, "{\"jobs\":[");
    for (int i = 0; i < g_job_count; ++i) { if (i) buf_str(&b, ","); job_json(&b, g_jobs[i]); }
    const Job* active = first_running_locked();
    buf_fmt(&b, "],\"active\":%s%s%s,\"concurrency\":%d,\"concurrencyBy\":\"%s\",\"concurrencyStamp\":%u}", active ? "\"" : "",
            active ? active->id : "null", active ? "\"" : "", g_max_running, g_concurrency_remote ? "remote" : "app", g_concurrency_stamp);
    pthread_mutex_unlock(&g_lock);
    respond(fd, 200, b.failed || !b.data ? "{\"jobs\":[]}" : b.data);
    free(b.data);
    return;
  }
  if (strcmp(r->method, "POST")) { respond_error(fd, 404, "not found"); return; }
  if (!strcmp(r->path, "/jobs")) { handle_create(fd, r); return; }
  if (!strcmp(r->path, "/queue")) { handle_queue(fd, r); return; }
  if (!strcmp(r->path, "/config")) {
    ConfigBody c;
    memset(&c, 0, sizeof c);
    JP jp = {r->body, r->body + r->content_length, 0};
    if (!jp_object(&jp, config_field, &c) || !config_valid(&c)) {
      respond_error(fd, 400, "expected {concurrency: 1..4, monitor, pinSalt + pinHash, monitorText, pauseOnCloseSeconds: 0..30}");
      return;
    }
    char body[256];
    pthread_mutex_lock(&g_lock);
    if (config_apply_locked(&c)) save_config_locked();
    snprintf(body, sizeof body, "{\"ok\":true,\"concurrency\":%d,\"concurrencyBy\":\"%s\",\"concurrencyStamp\":%u,\"monitor\":%s,\"pinSet\":%s,"
             "\"pauseOnCloseSeconds\":%lld}", g_max_running, g_concurrency_remote ? "remote" : "app", g_concurrency_stamp,
             g_monitor_on ? "true" : "false", g_pin_hash[0] ? "true" : "false", (long long)(g_quiet_ms / 1000));
    pthread_cond_broadcast(&g_wake_downloader);
    pthread_mutex_unlock(&g_lock);
    respond(fd, 200, body);
    return;
  }
  if (!strcmp(r->path, "/secret")) {
    SecretBody s;
    memset(&s, 0, sizeof s);
    JP jp = {r->body, r->body + r->content_length, 0};
    if (!jp_object(&jp, secret_field, &s) || (strcmp(s.service, "torbox") && strcmp(s.service, "alldebrid")) || !safe_token_text(s.key)) {
      memset(&s, 0, sizeof s);
      respond_error(fd, 400, "expected {service, key}");
      return;
    }
    pthread_mutex_lock(&g_key_lock);
    snprintf(g_memory_key[!strcmp(s.service, "alldebrid") ? 1 : 0], sizeof g_memory_key[0], "%s", s.key);
    pthread_mutex_unlock(&g_key_lock);
    memset(&s, 0, sizeof s);
    memset(r->body, 0, r->content_length);
    respond(fd, 200, "{\"ok\":true}");
    return;
  }
  // glibren.5: o app avisa que vai fechar (o botao "Sair"): conta como fechado ja, sem esperar g_app_silence_ms de
  // silencio (a fila antecipada segue sozinha), e aplica a pausa ao fechar conforme a opcao. Quando o sistema confirmar
  // o fechamento (sceLncUtilGetAppId), a pausa recomeca dali, o momento em que o PS5 desmonta o app.
  if (!strcmp(r->path, "/bye")) {
    const int64_t mono = mono_ms();
    const int64_t quiet_ms = g_quiet_ms;
    g_bye_ms = mono;
    g_last_app_ms = mono - g_app_silence_ms;
    if (quiet_ms > 0) {
      start_quiet(mono);
      logk_("app avisou que vai fechar (POST /bye): modo quieto por %lld s; %d job(s) baixando", (long long)(quiet_ms / 1000), g_running_count);
    } else {
      logk_("app avisou que vai fechar (POST /bye): sem pausa (pausa ao fechar: 0 s); %d job(s) baixando", g_running_count);
    }
    char body[96];
    snprintf(body, sizeof body, "{\"ok\":true,\"quietMs\":%lld}", (long long)quiet_ms);
    pthread_mutex_lock(&g_lock);
    pthread_cond_broadcast(&g_wake_downloader);
    pthread_mutex_unlock(&g_lock);
    respond(fd, 200, body);
    return;
  }
  if (!strcmp(r->path, "/quit")) { respond(fd, 200, "{\"ok\":true}"); g_stop = 1; pthread_cond_broadcast(&g_wake_downloader); return; }
  if (!strncmp(r->path, "/jobs/", 6)) {
    char id[32], action[16];
    const char* rest = r->path + 6;
    const char* slash = strchr(rest, '/');
    if (slash && (size_t)(slash - rest) < sizeof id && strlen(slash + 1) < sizeof action) {
      memcpy(id, rest, (size_t)(slash - rest));
      id[slash - rest] = 0;
      snprintf(action, sizeof action, "%s", slash + 1);
      // glibren.8: POST /jobs/<id>/connections {"connections": 0..64}, como o do celular (o mesmo override).
      if (!strcmp(action, "connections")) {
        unsigned connections;
        if (!connections_body(r, &connections)) { respond_error(fd, 400, "expected {connections: 0..64}"); return; }
        pthread_mutex_lock(&g_lock);
        Job* j = find_job_locked(id);
        const int ok = j && set_connections_locked(j, connections, "app");
        Buf b = {0};
        if (ok) { buf_str(&b, "{\"ok\":true,\"job\":"); job_json(&b, j); buf_str(&b, "}"); }
        pthread_mutex_unlock(&g_lock);
        if (!ok) respond_error(fd, 404, "no such job (or it has ended)");
        else respond(fd, 200, b.data ? b.data : "{}");
        free(b.data);
        return;
      }
      // glibren: o app nao conseguiu por na fila um pedido da Biblioteca TorBox: fica "failed" com o motivo (o celular
      // mostra; Retomar ou pedir de novo volta a "waiting-app").
      if (!strcmp(action, "refuse")) {
        RefuseBody refuse;
        memset(&refuse, 0, sizeof refuse);
        JP jp = {r->body, r->body + r->content_length, 0};
        if (r->content_length && !jp_object(&jp, refuse_field, &refuse)) { respond_error(fd, 400, "expected {error}"); return; }
        pthread_mutex_lock(&g_lock);
        Job* j = find_job_locked(id);
        const int ok = j && j->requested && !j->running;
        if (ok) {
          snprintf(j->state, sizeof j->state, "failed");
          copy_utf8(j->error, sizeof j->error, refuse.error[0] ? refuse.error : "Jobee'sLair could not queue it");
          j->by[0] = 0;
          j->updated = now_s();
          save_jobs_locked();
        }
        pthread_mutex_unlock(&g_lock);
        if (!ok) respond_error(fd, 404, "no such request");
        else respond(fd, 200, "{\"ok\":true}");
        return;
      }
      handle_action(fd, id, action);
      return;
    }
  }
  respond_error(fd, 404, "not found");
}

static void* serve_client(void* arg) {
  int fd = (int)(intptr_t)arg;
  struct timeval timeout = {5, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
#ifdef SO_NOSIGPIPE
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
  Request r;
  memset(&r, 0, sizeof r);
  int status = read_request(fd, &r);
  if (status == 200) route(fd, &r);
  else if (status) respond_error(fd, status, "bad request");
  if (r.body) { memset(r.body, 0, r.content_length); free(r.body); }
  // Fechamento "lingering": espera ate 2 s o cliente fechar, sem shutdown(SHUT_WR).
  struct timeval linger = {2, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &linger, sizeof linger);
  char drain[512];
  int64_t until = mono_ms() + 2000;
  while (mono_ms() < until && recv(fd, drain, sizeof drain, 0) > 0) {}
  close(fd);
  return NULL;
}

static volatile int g_reopen_server;

static int open_server(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)g_port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // so 127.0.0.1
  if (bind(fd, (struct sockaddr*)&address, sizeof address) || listen(fd, 16)) { close(fd); return -1; }
  return fd;
}

static void* server_loop(void* arg) {
  (void)arg;
  int server = -1, failures = 0;
  int64_t next_try = 0;
  while (!g_stop) {
    if (g_reopen_server && server >= 0) { close(server); server = -1; g_reopen_server = 0; next_try = mono_ms() + 2000; logf_("servidor: reabrindo depois do repouso/troca de rede"); }
    if (server < 0) {
      if (mono_ms() < next_try) { sleep_ms(200); continue; }
      server = open_server();
      if (server < 0) { logf_("servidor: porta %d indisponivel (%s); tenta de novo em 10 s", g_port, strerror(errno)); next_try = mono_ms() + 10000; continue; }
      logf_("servidor: ouvindo em 127.0.0.1:%d", g_port);
      failures = 0;
    }
    struct pollfd p = {server, POLLIN, 0};
    int ready = poll(&p, 1, 500);
    if (ready < 0 && errno != EINTR) sleep_ms(100); // poll que falha na hora nao vira laco ocupado
    if (ready <= 0) continue;
    int client = accept(server, NULL, NULL);
    if (client < 0) {
      if (errno == EINTR) continue;
      if (++failures >= 5) { close(server); server = -1; next_try = mono_ms() + 2000; } // acontece depois do repouso
      else sleep_ms(50);
      continue;
    }
    failures = 0;
    if (spawn_thread(serve_client, (void*)(intptr_t)client, NULL)) close(client);
  }
  if (server >= 0) close(server);
  return NULL;
}

// ---- Uma copia so, token ------------------------------------------------------------------------------

static void on_stop(int sig) { (void)sig; g_stop = 1; }
static void on_continue(int sig) { (void)sig; g_wake = 1; }

static int g_lock_contended;
static int take_lock(void) {
  char path[600];
  snprintf(path, sizeof path, "%s/bgdl.pid", g_dir);
  int fd = open(path, O_RDWR | O_CREAT, 0600);
  if (fd < 0) return -1;
  if (flock(fd, LOCK_EX | LOCK_NB)) {
    g_lock_contended = 1;
    char text[32] = {0};
    if (pread(fd, text, sizeof text - 1, 0) < 0) text[0] = 0;
    int old = atoi(text);
    if (old > 1 && old != getpid()) { logf_("copia antiga (pid %d): pedindo para sair (SIGTERM)", old); kill(old, SIGTERM); }
    int locked = 0;
    for (int i = 0; i < 150 && !locked; ++i) { sleep_ms(100); locked = !flock(fd, LOCK_EX | LOCK_NB); }
    if (!locked && old > 1) { logf_("copia antiga nao saiu; SIGKILL"); kill(old, SIGKILL); for (int i = 0; i < 30 && !locked; ++i) { sleep_ms(100); locked = !flock(fd, LOCK_EX | LOCK_NB); } }
    if (!locked) { close(fd); return -1; }
  }
  char text[32];
  int n = snprintf(text, sizeof text, "%d\n", (int)getpid());
  if (ftruncate(fd, 0) == 0) write_all(fd, text, (size_t)n, 0);
  fsync(fd);
  return fd;
}

static void random_bytes(unsigned char* out, size_t size) {
  int fd = open("/dev/urandom", O_RDONLY);
  size_t got = 0;
  if (fd >= 0) { if (read_all(fd, out, size)) got = size; close(fd); }
  if (got == size) return;
  // Reserva: mistura relogio, pid e enderecos com SHA-256.
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  Hash h;
  hash_init(&h);
  int64_t values[4] = {(int64_t)ts.tv_sec, (int64_t)ts.tv_nsec, (int64_t)getpid(), (int64_t)(intptr_t)&ts};
  hash_add(&h, values, sizeof values);
  char hex[65];
  hash_finish(&h, hex);
  for (size_t i = 0; i < size; ++i) out[i] = (unsigned char)(hex[i % 64] ^ (hex[(i * 7) % 64] << 1));
}

static void load_token(void) {
  char path[600];
  snprintf(path, sizeof path, "%s/token", g_dir);
  char* text = read_text(path, 256, NULL);
  if (text) {
    const char* value = trim_value(text);
    if (is_hex64(value)) { snprintf(g_token, sizeof g_token, "%s", value); free(text); return; }
    free(text);
  }
  unsigned char bytes[32];
  random_bytes(bytes, sizeof bytes);
  static const char digits[] = "0123456789abcdef";
  for (int i = 0; i < 32; ++i) { g_token[2 * i] = digits[bytes[i] >> 4]; g_token[2 * i + 1] = digits[bytes[i] & 15]; }
  g_token[64] = 0;
  if (!save_atomic(path, g_token, 64, 0600)) logf_("token nao gravado: %s", strerror(errno));
  chmod(path, 0600);
}

// ---- Pagina do celular (0.0.0.0:34201) ------------------------------------------------------------------
// A tela de downloads para o celular na rede de casa (app/native/bg_monitor.html, embutida em bg_monitor_html.h por
// tools/bg-monitor/embed.mjs). Ver nao pede nada; pausar, retomar e cancelar pedem uma sessao aberta com o PIN
// definido na Jobee'sLair (o app manda so sal + SHA-256). Nada de URL, chave, token ou caminho sai por aqui.
// Fecha cada conexao aos poucos (shutdown + espera o cliente): fechar logo depois de responder corta o fim da
// resposta no navegador do Android (ERR_CONTENT_LENGTH_MISMATCH).
#include "bg_monitor_html.h"

#define MONITOR_PORT 34201
#define MONITOR_CLIENTS 4
#define MONITOR_SESSIONS 16
#define MONITOR_PEERS 32
#define MONITOR_FREE_TRIES 5
#define MONITOR_MAX_BLOCK 900

static int g_monitor_port = MONITOR_PORT;
static int64_t g_session_seconds = 12 * 3600;
static volatile int g_reopen_monitor;
static pthread_mutex_t g_monitor_lock = PTHREAD_MUTEX_INITIALIZER;
static int g_monitor_clients;
typedef struct { char token[33]; int64_t expires; } Session;
static Session g_sessions[MONITOR_SESSIONS];
typedef struct { uint32_t ip; int failures; int64_t blocked_until, last; } Peer;
static Peer g_peers[MONITOR_PEERS];

static int g_monitor_port_now(void) { return g_monitor_port; }

static void monitor_clear_sessions(void) {
  pthread_mutex_lock(&g_monitor_lock);
  memset(g_sessions, 0, sizeof g_sessions);
  pthread_mutex_unlock(&g_monitor_lock);
}

static int same_text(const char* a, const char* b, size_t size) { // tempo constante
  unsigned diff = 0;
  for (size_t i = 0; i < size; ++i) diff |= (unsigned)(unsigned char)a[i] ^ (unsigned)(unsigned char)b[i];
  return diff == 0;
}

// 1 certo, 0 errado, -1 sem PIN definido.
static int pin_matches(const char* pin) {
  char salt[65], expected[65], got[65];
  pthread_mutex_lock(&g_lock);
  snprintf(salt, sizeof salt, "%s", g_pin_salt);
  snprintf(expected, sizeof expected, "%s", g_pin_hash);
  pthread_mutex_unlock(&g_lock);
  if (!is_hex64(expected) || !is_hex64(salt)) return -1;
  Hash h;
  hash_init(&h);
  hash_add(&h, salt, strlen(salt));
  hash_add(&h, ":", 1);
  hash_add(&h, pin, strlen(pin));
  if (!hash_finish(&h, got)) return 0;
  return same_text(got, expected, 64);
}

static void new_session(char out[33]) {
  unsigned char bytes[16];
  random_bytes(bytes, sizeof bytes);
  static const char digits[] = "0123456789abcdef";
  for (int i = 0; i < 16; ++i) { out[2 * i] = digits[bytes[i] >> 4]; out[2 * i + 1] = digits[bytes[i] & 15]; }
  out[32] = 0;
  const int64_t now = now_s();
  pthread_mutex_lock(&g_monitor_lock);
  int slot = 0;
  for (int i = 0; i < MONITOR_SESSIONS; ++i) {
    if (g_sessions[i].expires <= now) { slot = i; break; }
    if (g_sessions[i].expires < g_sessions[slot].expires) slot = i;
  }
  snprintf(g_sessions[slot].token, sizeof g_sessions[slot].token, "%s", out);
  g_sessions[slot].expires = now + g_session_seconds;
  pthread_mutex_unlock(&g_monitor_lock);
}

static int session_ok(const char* given) {
  if (strlen(given) != 32) return 0;
  const int64_t now = now_s();
  int ok = 0;
  pthread_mutex_lock(&g_monitor_lock);
  for (int i = 0; i < MONITOR_SESSIONS; ++i)
    if (g_sessions[i].expires > now && same_text(g_sessions[i].token, given, 32)) ok = 1;
  pthread_mutex_unlock(&g_monitor_lock);
  return ok;
}

// O registro de tentativas de um IP (com g_monitor_lock): um livre, ou o usado ha mais tempo.
static Peer* peer_of_locked(uint32_t ip) {
  Peer* oldest = &g_peers[0];
  for (int i = 0; i < MONITOR_PEERS; ++i) {
    if (g_peers[i].last && g_peers[i].ip == ip) return &g_peers[i];
    if (g_peers[i].last < oldest->last) oldest = &g_peers[i];
  }
  memset(oldest, 0, sizeof *oldest);
  oldest->ip = ip;
  return oldest;
}

// O erro de um job como a pagina pode mostrar: sem links nem caminhos.
static void public_error(const char* in, char* out, size_t cap) {
  size_t used = 0;
  out[0] = 0;
  for (const char* p = in; *p && used + 1 < cap;) {
    const size_t word = strcspn(p, " \t\r\n");
    int link = 0; // a palavra tem "://" (o PS5 nao tem memmem)
    for (size_t k = 0; k + 2 < word && !link; ++k) link = p[k] == ':' && p[k + 1] == '/' && p[k + 2] == '/';
    const int hidden = word > 0 && (*p == '/' || link);
    const char* piece = hidden ? "[...]" : p;
    size_t size = hidden ? 5 : word;
    if (used + size >= cap) size = cap - 1 - used;
    memcpy(out + used, piece, size);
    used += size;
    p += word;
    if (*p && used + 1 < cap) out[used++] = ' ';
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') ++p;
  }
  out[used] = 0;
}

static void monitor_status(Buf* b) {
  char error[600];
  pthread_mutex_lock(&g_lock);
  // Na ordem da fila: os que o app comecou primeiro, depois os entregues com antecedencia e os aguardando o app.
  const Job* sorted[MAX_JOBS];
  for (int i = 0; i < g_job_count; ++i) sorted[i] = g_jobs[i];
  for (int i = 1; i < g_job_count; ++i) {
    const Job* item = sorted[i];
    const int rank = item->ahead || item->placeholder ? item->order : 0;
    int k = i - 1;
    while (k >= 0 && (sorted[k]->ahead || sorted[k]->placeholder ? sorted[k]->order : 0) > rank) { sorted[k + 1] = sorted[k]; --k; }
    sorted[k + 1] = item;
  }
  buf_str(b, "{\"jobs\":[");
  int first = 1;
  for (int i = 0; i < g_job_count; ++i) {
    const Job* j = sorted[i];
    if (!strcmp(j->state, "cancelled")) continue;
    (void)i;
    if (!first) buf_str(b, ",");
    first = 0;
    public_error(j->error, error, sizeof error);
    buf_str(b, "{\"id\":"); buf_json(b, j->id);
    buf_str(b, ",\"name\":"); buf_json(b, j->name);
    buf_str(b, ",\"state\":"); buf_json(b, j->state);
    buf_str(b, ",\"by\":"); buf_json(b, j->by);
    buf_str(b, ",\"error\":"); buf_json(b, error);
    // glibren: through a debrid service: its name only (no item, link or key), for the page's "via TorBox".
    if (j->requested) buf_str(b, ",\"requested\":true,\"via\":\"TorBox\""); // glibren: pedido pela Biblioteca TorBox
    else if (!strcmp(j->provider, "torbox")) buf_str(b, ",\"via\":\"TorBox\"");
    else if (!strcmp(j->provider, "alldebrid")) buf_str(b, ",\"via\":\"AllDebrid\"");
    buf_fmt(b, ",\"written\":%llu,\"total\":%llu,\"bytesPerSecond\":%.0f,\"connectionsActive\":%u", (unsigned long long)j->written,
            (unsigned long long)(j->total ? j->total : j->expected_bytes), j->bytes_per_second, j->active_connections);
    // glibren.8: o alvo de conexoes (o escolhido no celular, ou o do app; 0 num "waiting-app" sem escolha: o app decide)
    // e se foi escolhido no celular.
    buf_fmt(b, ",\"connections\":%u,\"connectionsSet\":%s}", j->placeholder && !j->connections_set ? 0 : job_target_locked(j),
            j->connections_set ? "true" : "false");
  }
  buf_fmt(b, "],\"limit\":%d,\"maxLimit\":%d,\"maxConnections\":%d,\"limitSet\":%s,\"pinSet\":%s}", g_max_running, MAX_WORKERS, MAX_CONNS,
          g_concurrency_remote ? "true" : "false", g_pin_hash[0] ? "true" : "false");
  pthread_mutex_unlock(&g_lock);
}

static void monitor_send(int fd, int status, const char* type, const void* body, size_t size) {
  const char* reason = status == 200 ? "OK" : status == 400 ? "Bad Request" : status == 401 ? "Unauthorized" : status == 403 ? "Forbidden" :
                       status == 404 ? "Not Found" : status == 413 ? "Payload Too Large" : "Error";
  char head[512];
  const int html = !strncmp(type, "text/html", 9);
  int n = snprintf(head, sizeof head,
                   "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
                   "Referrer-Policy: no-referrer\r\n%sConnection: close\r\n\r\n",
                   status, reason, type, size,
                   html ? "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:\r\n" : "");
  if (send_all(fd, head, (size_t)n) && size) send_all(fd, body, size);
}
static void monitor_json(int fd, int status, const char* body) { monitor_send(fd, status, "application/json", body, strlen(body)); }

typedef struct { char pin[16]; } UnlockBody;
static int unlock_field(JP* jp, const char* key, void* ctx) {
  if (!strcmp(key, "pin")) return jp_text(jp, ((UnlockBody*)ctx)->pin, sizeof ((UnlockBody*)ctx)->pin) ? 1 : -1;
  return jp_skip(jp) ? 1 : -1;
}

static void monitor_unlock(int fd, Request* r, uint32_t ip) {
  UnlockBody u;
  memset(&u, 0, sizeof u);
  JP jp = {r->body, r->body + r->content_length, 0};
  size_t digits = strspn(u.pin, "0123456789");
  if (!jp_object(&jp, unlock_field, &u) || (digits = strspn(u.pin, "0123456789")) != strlen(u.pin) || digits < 4 || digits > 8) {
    memset(&u, 0, sizeof u);
    monitor_json(fd, 400, "{\"error\":\"pin\"}");
    return;
  }
  const int64_t now = now_s();
  pthread_mutex_lock(&g_monitor_lock);
  Peer* peer = peer_of_locked(ip);
  peer->last = now;
  const int64_t wait = peer->blocked_until - now;
  pthread_mutex_unlock(&g_monitor_lock);
  char body[96];
  if (wait > 0) {
    snprintf(body, sizeof body, "{\"retryIn\":%lld}", (long long)wait);
    monitor_json(fd, 403, body);
    memset(&u, 0, sizeof u);
    return;
  }
  const int match = pin_matches(u.pin);
  memset(&u, 0, sizeof u);
  if (match < 0) { monitor_json(fd, 403, "{\"noPin\":true,\"retryIn\":0}"); return; }
  pthread_mutex_lock(&g_monitor_lock);
  peer = peer_of_locked(ip);
  peer->last = now;
  int64_t block = 0;
  if (match) peer->failures = 0;
  else if (++peer->failures >= MONITOR_FREE_TRIES) {
    const int doubling = peer->failures - MONITOR_FREE_TRIES < 5 ? peer->failures - MONITOR_FREE_TRIES : 5;
    block = 30LL << doubling;
    if (block > MONITOR_MAX_BLOCK) block = MONITOR_MAX_BLOCK;
    peer->blocked_until = now + block;
  }
  const int failures = peer->failures;
  pthread_mutex_unlock(&g_monitor_lock);
  if (!match) {
    logf_("celular: PIN errado (%d seguidos)%s", failures, block ? "; bloqueado por um tempo" : "");
    snprintf(body, sizeof body, "{\"retryIn\":%lld}", (long long)block);
    monitor_json(fd, 403, body);
    return;
  }
  char token[33];
  new_session(token);
  logf_("celular: controles liberados");
  snprintf(body, sizeof body, "{\"session\":\"%s\"}", token);
  monitor_json(fd, 200, body);
}

static void monitor_action(int fd, Request* r) {
  char id[32], action[16];
  const char* rest = r->path + strlen("/api/jobs/");
  const char* slash = strchr(rest, '/');
  if (!slash || (size_t)(slash - rest) >= sizeof id || strlen(slash + 1) >= sizeof action) { monitor_json(fd, 404, "{\"error\":\"not found\"}"); return; }
  memcpy(id, rest, (size_t)(slash - rest));
  id[slash - rest] = 0;
  snprintf(action, sizeof action, "%s", slash + 1);
  const int connections_action = !strcmp(action, "connections");
  if (strcmp(action, "pause") && strcmp(action, "resume") && strcmp(action, "cancel") && !connections_action) { monitor_json(fd, 404, "{\"error\":\"not found\"}"); return; }
  if (!session_ok(r->session)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  // glibren.8: POST /api/jobs/<id>/connections {"connections": 1..64, ou 0/null = as do app}: vale ja para um job
  // baixando, e quando comecar para um na fila (inclusive um "waiting-app", que o app comeca depois).
  if (connections_action) {
    unsigned connections;
    if (!connections_body(r, &connections)) { monitor_json(fd, 400, "{\"error\":\"connections\"}"); return; }
    pthread_mutex_lock(&g_lock);
    Job* j = find_job_locked(id);
    const int ok = j && set_connections_locked(j, connections, "celular");
    char body[96];
    snprintf(body, sizeof body, "{\"ok\":true,\"connections\":%u,\"connectionsSet\":%s}", ok ? job_target_locked(j) : 0, connections ? "true" : "false");
    pthread_mutex_unlock(&g_lock);
    if (!ok) { monitor_json(fd, 404, "{\"error\":\"no such job\"}"); return; }
    monitor_json(fd, 200, body);
    return;
  }
  pthread_mutex_lock(&g_lock);
  Job* j = find_job_locked(id);
  int status = 404, removed = 0;
  // MODIFIED (glibren.8): os marcadores tambem (um pausado so do app aparece "Pausado" e tem Retomar/Cancelar).
  if (j && strcmp(j->state, "cancelled")) status = job_action_locked(j, action, 1, &removed);
  pthread_mutex_unlock(&g_lock);
  if (status != 200) { monitor_json(fd, 404, "{\"error\":\"no such job\"}"); return; }
  logf_("celular: job %s %s", id, action);
  monitor_json(fd, 200, "{\"ok\":true}");
}

// glibren.8: POST /api/config {"concurrency": 1..MAX_WORKERS} (com a sessao do PIN): downloads simultaneos escolhidos
// no celular. Vale na hora: mais = comeca o que esta na fila; menos = nenhum para no meio (os que baixam terminam, e
// outro so comeca quando houver menos que o numero), como no app. Fica em config.json, marcado como do celular: o
// app adota o numero ao falar com o payload (concurrencyBy/concurrencyStamp no /health e no /jobs).
typedef struct { uint64_t concurrency; int found; } RemoteConfig;
static int remote_config_field(JP* jp, const char* key, void* ctx) {
  RemoteConfig* c = ctx;
  if (strcmp(key, "concurrency")) return jp_skip(jp) ? 1 : -1;
  double d;
  int integer;
  c->found = 1;
  jp_ws(jp);
  return jp_number(jp, &d, &c->concurrency, &integer) && integer ? 1 : -1;
}
static void monitor_config(int fd, Request* r) {
  if (!session_ok(r->session)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  RemoteConfig c = {0, 0};
  JP jp = {r->body, r->body + r->content_length, 0};
  if (!jp_object(&jp, remote_config_field, &c) || !c.found || c.concurrency < 1 || c.concurrency > MAX_WORKERS) {
    monitor_json(fd, 400, "{\"error\":\"concurrency\"}");
    return;
  }
  char body[96];
  pthread_mutex_lock(&g_lock);
  if (g_max_running != (int)c.concurrency || !g_concurrency_remote) {
    logf_("celular: downloads simultaneos %d -> %d", g_max_running, (int)c.concurrency);
    g_max_running = (int)c.concurrency;
    g_concurrency_remote = 1;
    ++g_concurrency_stamp;
    save_config_locked();
  }
  snprintf(body, sizeof body, "{\"ok\":true,\"limit\":%d,\"limitSet\":true}", g_max_running);
  pthread_cond_broadcast(&g_wake_downloader);
  pthread_mutex_unlock(&g_lock);
  monitor_json(fd, 200, body);
}

// ---- glibren: desligar o PS5 / modo de repouso pela pagina do celular (e pelo APK Jobe Controle) ------------
// Para quando a TV falha e nao da para usar o menu de energia. As mesmas chamadas do menu (libSceSystemService, sem
// argumentos), as usadas pelo shsrv (comando suspend), pelo etaHEN e pelo ps5-homeassistant; NAO o syscall reboot(),
// que corta sem avisar o sistema. So com a sessao do PIN. A pagina recebe 200 antes: o main desliga POWER_DELAY_MS
// depois, gravando antes a fila (jobs.json) e o disco (sync). Downloads param e retomam da parcial na proxima vez.
#define POWER_DELAY_MS 2500
#ifdef __PROSPERO__
int sceSystemStateMgrTurnOff(void) __attribute__((weak));
int sceSystemStateMgrEnterStandby(void) __attribute__((weak));
#endif
static int g_power_action; // 0 nada, 1 desligar, 2 repouso (com g_monitor_lock)
static int64_t g_power_at;

static int power_call(int rest) {
#ifdef __PROSPERO__
  int (*fn)(void) = rest ? sceSystemStateMgrEnterStandby : sceSystemStateMgrTurnOff;
  return fn ? fn() : -1;
#else
  // Testes: nada de verdade; so anota num arquivo (BGDL_POWER_FILE) o que seria chamado.
  const char* path = getenv("BGDL_POWER_FILE");
  FILE* file = path ? fopen(path, "a") : NULL;
  if (file) { fprintf(file, "%s\n", rest ? "rest" : "off"); fclose(file); }
  return 0;
#endif
}

// Chamado pelo laco do main a cada 1 s.
static void power_check(void) {
  pthread_mutex_lock(&g_monitor_lock);
  const int action = g_power_action && mono_ms() >= g_power_at ? g_power_action : 0;
  pthread_mutex_unlock(&g_monitor_lock);
  if (!action) return;
  const char* what = action == 2 ? "modo de repouso" : "desligar";
  logk_("energia: %s (pedido pelo celular); gravando a fila e o disco", what);
  pthread_mutex_lock(&g_lock);
  save_jobs_locked();
  pthread_mutex_unlock(&g_lock);
  sync();
  notify(action == 2 ? "Jobee'sLair: modo de repouso pedido pelo celular" : "Jobee'sLair: desligando o PS5 (pedido pelo celular)");
  const int result = power_call(action == 2);
  logk_("energia: %s -> 0x%08x", what, (unsigned)result);
  if (result) notify("Jobee'sLair: o PS5 recusou o pedido de energia");
  pthread_mutex_lock(&g_monitor_lock);
  g_power_action = 0; // repouso: o processo segue vivo; um pedido novo vale depois de acordar
  pthread_mutex_unlock(&g_monitor_lock);
}

typedef struct { char action[8]; } PowerBody;
static int power_field(JP* jp, const char* key, void* ctx) {
  if (!strcmp(key, "action")) return jp_text(jp, ((PowerBody*)ctx)->action, sizeof ((PowerBody*)ctx)->action) ? 1 : -1;
  return jp_skip(jp) ? 1 : -1;
}

// POST /api/power {"action":"off"|"rest"} com X-Session.
static void monitor_power(int fd, Request* r) {
  if (!session_ok(r->session)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  PowerBody b;
  memset(&b, 0, sizeof b);
  JP jp = {r->body, r->body + r->content_length, 0};
  const int ok = r->body && jp_object(&jp, power_field, &b);
  const int action = !ok ? 0 : !strcmp(b.action, "off") ? 1 : !strcmp(b.action, "rest") ? 2 : 0;
  if (!action) { monitor_json(fd, 400, "{\"error\":\"action\"}"); return; }
  pthread_mutex_lock(&g_monitor_lock);
  const int busy = g_power_action != 0;
  if (!busy) { g_power_action = action; g_power_at = mono_ms() + POWER_DELAY_MS; }
  pthread_mutex_unlock(&g_monitor_lock);
  if (busy) { monitor_json(fd, 409, "{\"error\":\"busy\"}"); return; }
  logf_("celular: pedido de energia: %s", action == 2 ? "modo de repouso" : "desligar");
  monitor_json(fd, 200, "{\"ok\":true}");
}


// ---- glibren: Biblioteca TorBox na pagina do celular ----------------------------------------------------------
// A lista de jogos confirmados no TorBox que o app monta (Configuracoes da Jobee'sLair) e grava em
// /data/JobeesLair/torbox-lista.json (BGDL_LIBRARY nos testes):
//   {"version":1, "builtAt":"<ISO>", "games":[{"id", "title", "code", "platform":"ps5|ps4", "genres":[...], "sizeBytes",
//    "formats":[...], "hash", "files":[{"name", "size", "format"}], "cover"}]}
// Campos ausentes ou de outro tipo sao tolerados (um jogo sem id usa o hash; sem os dois, fica de fora; sem tamanho, a
// soma dos arquivos; sem formatos, os dos arquivos; sem plataforma, a do codigo PPSA/CUSA). Na memoria fica so um indice
// compacto (sem os nomes dos arquivos nem a capa), relido quando o arquivo muda; os arquivos de um jogo sao lidos do
// disco so quando pedidos.
//   GET  /api/library?q=&platform=ps5|ps4&format=exfat,pkg&genre=A,B&minSize=&maxSize=&sort=title|big|small&offset=&limit=
//        -> {ok, builtAt, partial, total, count, offset, limit, games:[{id, title, code, platform, sizeBytes, formats,
//            genres, files, queued}], facets:{platforms:{ps5, ps4, other}, sizes:{lt10, 10to30, 30to60, gt60, unknown},
//            formats:[{name, count}], genres:[{name, count}]}}
//        Tamanhos em bytes (minSize inclusivo, maxSize exclusivo; GiB nas faixas). As contagens de cada filtro valem com os
//        outros filtros aplicados. Sem sessao, como /api/status: nada de segredo sai (nem hash, nem caminho).
//        404 {"error":"no-library"} sem o arquivo; 500 {"error":"bad-library"} quando nada se aproveita dele.
//   GET  /api/library/game?id=  -> {ok, game:{...}, files:[{name, size, format, piece}], suggested:"<arquivo>"|""}
//        ("" = o torrent inteiro, como um zip).
//   POST /api/library/add {id, file?, whole?} (sessao do PIN) -> {ok, id, appOpen} | {ok, already, id}
//        Vira um marcador "waiting-app" pedido pelo celular (requested), que a fila do app (POST /queue) nao tira.
//        Quem baixa e o app: aberto (ou ao abrir) ele le os pedidos no GET /jobs ("library"), poe o jogo na fila dele pelo
//        TorBox (o mesmo caminho do "Procurar no TorBox", no disco padrao das Configuracoes) e tira o pedido (forget); se
//        nao der, POST /jobs/<id>/refuse {error} e o celular ve o motivo (Retomar pede de novo).
#define LIB_MAX_BYTES (64u * 1024 * 1024)
#define LIB_MAX_GAMES 50000
#define LIB_GENRES 64
#define LIB_FORMATS 32
#define LIB_FILES 256
#define LIB_PAGE 200
#define LIB_GIB (1024ull * 1024 * 1024)

typedef struct {
  char id[96], title[160], code[16], hash[72];
  uint64_t size, genres;
  uint32_t formats;
  uint8_t platform; // 0 nao sabido, 1 ps5, 2 ps4
  uint16_t files;
} LibGame;
// Um arquivo da lista: via "torrent" (hash = infohash), "webdl" (hash = MD5 do link; release = a fonte no app) ou
// "account" (item {kind, id} na conta TorBox, file = o id do arquivo); piece = parte de um arquivo dividido.
typedef struct {
  char name[256], format[16], via[12], hash[72], release[96], item_kind[12], item_id[32], file_id[32];
  uint64_t size;
  int piece;
} LibFile;
typedef struct {
  LibGame* games;
  int count, cap, partial, skipped;
  char built[40];
  char genres[LIB_GENRES][48];
  int genre_count;
  char formats[LIB_FORMATS][16];
  int format_count;
} LibIndex;
typedef struct {
  LibIndex* index;
  LibGame game;
  uint64_t files_size;
  uint32_t listed_formats, file_formats;
  const char* want; // so o jogo com este id, com os arquivos (files)
  LibFile* files;
  int file_count, found;
} LibParse;

static pthread_mutex_t g_lib_lock = PTHREAD_MUTEX_INITIALIZER; // antes de g_lock, nunca depois
static char g_lib_path[600];
static LibIndex* g_lib;
static int g_lib_state; // 0 nao lido, 1 lido, 2 sem o arquivo, 3 invalido
static int64_t g_lib_mtime, g_lib_checked;
static uint64_t g_lib_bytes;

// A ordem dos formatos (como o "Procurar no TorBox"): imagens primeiro (exFAT antes), depois pacotes, depois arquivos.
static const char* const LIB_RANK[] = {"exfat", "ffpkg", "ffpfsc", "ffpfs", "pkg", "fpkg", "rar", "7z", "zip", "tar"};
static int lib_rank(const char* format) {
  for (size_t i = 0; i < sizeof LIB_RANK / sizeof *LIB_RANK; ++i) if (!strcmp(format, LIB_RANK[i])) return (int)i;
  return 99;
}
static const char* base_name(const char* path) {
  const char* slash = strrchr(path, '/');
  return slash ? slash + 1 : path;
}
static void format_of_name(const char* name, char* out, size_t cap) {
  out[0] = 0;
  const char* dot = strrchr(base_name(name), '.');
  if (!dot) return;
  char ext[16];
  copy_text(ext, sizeof ext, dot + 1);
  lower_ascii(ext);
  if (lib_rank(ext) < 99) copy_text(out, cap, ext);
}
// Um pedaco de um arquivo dividido ("Jogo.part2.rar", "Jogo.rar.001", "Jogo.r01"): nao serve sozinho.
static int lib_piece(const char* name) {
  char low[256];
  copy_text(low, sizeof low, base_name(name));
  lower_ascii(low);
  const size_t n = strlen(low);
  if (n >= 4 && low[n - 4] == '.' && (low[n - 3] == 'r' || low[n - 3] == 'z') && isdigit((unsigned char)low[n - 2]) && isdigit((unsigned char)low[n - 1])) return 1;
  if (n >= 4 && low[n - 4] == '.' && isdigit((unsigned char)low[n - 3]) && isdigit((unsigned char)low[n - 2]) && isdigit((unsigned char)low[n - 1])) {
    static const char* const outer[] = {".rar", ".zip", ".7z", ".tar"};
    for (size_t i = 0; i < 4; ++i) {
      const size_t e = strlen(outer[i]);
      if (n >= 4 + e && !strncmp(low + n - 4 - e, outer[i], e)) return 1;
    }
  }
  const char* dot = strrchr(low, '.');
  if (dot && (!strcmp(dot, ".rar") || !strcmp(dot, ".zip") || !strcmp(dot, ".7z"))) {
    const char* p = dot;
    int digits = 0;
    while (p > low && isdigit((unsigned char)p[-1])) { --p; ++digits; }
    if (digits >= 1 && digits <= 4 && p - low >= 5 && !strncmp(p - 5, ".part", 5)) return 1;
  }
  return 0;
}
// O numero do nome na tabela (genero ou formato), criando-o se couber; -1 sem lugar ou sem nome.
static int lib_intern(char* table, size_t width, int* count, int max, const char* name) {
  if (!name[0]) return -1;
  for (int i = 0; i < *count; ++i) if (!strcasecmp(table + (size_t)i * width, name)) return i;
  if (*count >= max) return -1;
  copy_utf8(table + (size_t)*count * width, width, name);
  return (*count)++;
}
static int lib_genre_item(JP* j, void* ctx) {
  LibParse* p = ctx;
  char name[48];
  if (!lib_text(j, name, sizeof name)) return 0;
  const int slot = lib_intern(&p->index->genres[0][0], sizeof p->index->genres[0], &p->index->genre_count, LIB_GENRES, name);
  if (slot >= 0) p->game.genres |= 1ull << slot;
  return 1;
}
static int lib_format_item(JP* j, void* ctx) {
  LibParse* p = ctx;
  char name[16];
  if (!lib_text(j, name, sizeof name)) return 0;
  lower_ascii(name);
  if (name[0] == '.') memmove(name, name + 1, strlen(name));
  const int slot = lib_intern(&p->index->formats[0][0], sizeof p->index->formats[0], &p->index->format_count, LIB_FORMATS, name);
  if (slot >= 0) p->listed_formats |= 1u << slot;
  return 1;
}
// Uma lista, ou um valor so no lugar dela ("genres": "Acao").
static int lib_list(JP* j, ItemFn item, void* ctx) {
  jp_ws(j);
  if (j->p < j->end && *j->p == '"') return item(j, ctx);
  return jp_array(j, item, ctx);
}
static int lib_file_item_field(JP* jp, const char* key, void* ctx) {
  LibFile* f = ctx;
  if (!strcmp(key, "kind")) return lib_text(jp, f->item_kind, sizeof f->item_kind) ? 1 : -1;
  if (!strcmp(key, "id")) return lib_text(jp, f->item_id, sizeof f->item_id) ? 1 : -1;
  return 0;
}
static int lib_file_field(JP* jp, const char* key, void* ctx) {
  LibFile* f = ctx;
  if (!strcmp(key, "via")) { if (!lib_text(jp, f->via, sizeof f->via)) return -1; lower_ascii(f->via); return 1; }
  if (!strcmp(key, "hash")) { if (!lib_text(jp, f->hash, sizeof f->hash)) return -1; lower_ascii(f->hash); return 1; }
  if (!strcmp(key, "release")) return lib_text(jp, f->release, sizeof f->release) ? 1 : -1;
  if (!strcmp(key, "file")) return lib_text(jp, f->file_id, sizeof f->file_id) ? 1 : -1;
  if (!strcmp(key, "piece")) { jp_ws(jp); if (jp->p < jp->end && (*jp->p == 't' || *jp->p == 'f' || *jp->p == 'n')) return jp_bool(jp, &f->piece) ? 1 : -1; return jp_skip(jp) ? 1 : -1; }
  if (!strcmp(key, "item")) {
    jp_ws(jp);
    if (jp->p >= jp->end || *jp->p != '{') return jp_skip(jp) ? 1 : -1;
    return jp_object(jp, lib_file_item_field, f) ? 1 : -1;
  }
  if (!strcmp(key, "name")) return lib_text(jp, f->name, sizeof f->name) ? 1 : -1;
  if (!strcmp(key, "size")) return lib_uint(jp, &f->size) ? 1 : -1;
  if (!strcmp(key, "format")) return lib_text(jp, f->format, sizeof f->format) ? 1 : -1;
  return 0;
}
static int lib_file_item(JP* j, void* ctx) {
  LibParse* p = ctx;
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{') return jp_skip(j);
  LibFile f;
  memset(&f, 0, sizeof f);
  if (!jp_object(j, lib_file_field, &f)) return 0;
  lower_ascii(f.format);
  if (!f.format[0]) format_of_name(f.name, f.format, sizeof f.format);
  if (lib_piece(f.name)) f.piece = 1;
  // Sem "via": um infohash (40 hex) e de torrent; um item da conta, da conta.
  if (!f.via[0]) snprintf(f.via, sizeof f.via, "%s", f.item_id[0] ? "account" : strlen(f.hash) == 40 ? "torrent" : "");
  p->files_size += f.size;
  if (p->game.files < 65535) ++p->game.files;
  // So os formatos conhecidos (um .nfo ou .txt do lado do jogo nao vira filtro).
  if (lib_rank(f.format) < 99) {
    const int slot = lib_intern(&p->index->formats[0][0], sizeof p->index->formats[0], &p->index->format_count, LIB_FORMATS, f.format);
    if (slot >= 0) p->file_formats |= 1u << slot;
  }
  if (p->files && p->file_count < LIB_FILES) p->files[p->file_count++] = f;
  return 1;
}
static int lib_game_field(JP* jp, const char* key, void* ctx) {
  LibParse* p = ctx;
  LibGame* g = &p->game;
  if (!strcmp(key, "id")) return lib_text(jp, g->id, sizeof g->id) ? 1 : -1;
  if (!strcmp(key, "title")) return lib_text(jp, g->title, sizeof g->title) ? 1 : -1;
  if (!strcmp(key, "code")) {
    if (!lib_text(jp, g->code, sizeof g->code)) return -1;
    for (char* c = g->code; *c; ++c) *c = (char)toupper((unsigned char)*c);
    return 1;
  }
  if (!strcmp(key, "platform")) {
    char value[32];
    if (!lib_text(jp, value, sizeof value)) return -1;
    g->platform = strchr(value, '5') ? 1 : strchr(value, '4') ? 2 : 0;
    return 1;
  }
  if (!strcmp(key, "hash")) {
    if (!lib_text(jp, g->hash, sizeof g->hash)) return -1;
    lower_ascii(g->hash);
    return 1;
  }
  if (!strcmp(key, "sizeBytes")) return lib_uint(jp, &g->size) ? 1 : -1;
  if (!strcmp(key, "genres")) return lib_list(jp, lib_genre_item, p) ? 1 : -1;
  if (!strcmp(key, "formats")) return lib_list(jp, lib_format_item, p) ? 1 : -1;
  if (!strcmp(key, "files")) return jp_array(jp, lib_file_item, p) ? 1 : -1;
  return 0;
}
static int lib_game_item(JP* j, void* ctx) {
  LibParse* p = ctx;
  jp_ws(j);
  if (j->p >= j->end || *j->p != '{') { ++p->index->skipped; return jp_skip(j); }
  memset(&p->game, 0, sizeof p->game);
  p->files_size = 0;
  p->listed_formats = p->file_formats = 0;
  p->file_count = 0;
  if (!jp_object(j, lib_game_field, p)) return 0;
  LibGame* g = &p->game;
  if (!g->id[0]) snprintf(g->id, sizeof g->id, "%s", g->hash);
  if (!g->id[0]) { ++p->index->skipped; return 1; }
  if (!g->title[0]) snprintf(g->title, sizeof g->title, "%s", g->code[0] ? g->code : g->id);
  if (!g->platform) g->platform = !strncmp(g->code, "PPSA", 4) ? 1 : !strncmp(g->code, "CUSA", 4) ? 2 : 0;
  if (!g->size) g->size = p->files_size;
  g->formats = p->listed_formats ? p->listed_formats : p->file_formats;
  if (p->want) {
    if (strcmp(g->id, p->want)) return 1;
    p->found = 1;
    return 0; // achou: o resto do arquivo nao interessa
  }
  LibIndex* x = p->index;
  if (x->count >= LIB_MAX_GAMES) { x->partial = 1; return 0; }
  if (x->count == x->cap) {
    const int cap = x->cap ? x->cap * 2 : 256;
    LibGame* next = realloc(x->games, sizeof *next * (size_t)cap);
    if (!next) { x->partial = 1; return 0; }
    x->games = next;
    x->cap = cap;
  }
  x->games[x->count++] = *g;
  return 1;
}
static int lib_top_field(JP* jp, const char* key, void* ctx) {
  LibParse* p = ctx;
  if (!strcmp(key, "builtAt")) return lib_text(jp, p->index->built, sizeof p->index->built) ? 1 : -1;
  if (!strcmp(key, "games")) return jp_array(jp, lib_game_item, p) ? 1 : -1;
  return 0;
}
static LibIndex* lib_index_new(void) { return calloc(1, sizeof(LibIndex)); }
static void lib_index_free(LibIndex* x) {
  if (!x) return;
  free(x->games);
  free(x);
}
// Le o arquivo (com g_lib_lock): -> 1 lido (p->index; com p->want, p->found diz se achou), 2 sem o arquivo, 3 invalido.
static int lib_read(LibParse* p) {
  size_t size = 0;
  errno = 0;
  char* text = read_text(g_lib_path, LIB_MAX_BYTES, &size);
  if (!text) return errno == ENOENT ? 2 : 3;
  JP jp = {text, text + size, 0};
  const int whole = jp_object(&jp, lib_top_field, p);
  free(text);
  if (p->want) return 1;
  if (!whole) p->index->partial = 1;
  return whole || p->index->count ? 1 : 3;
}
static int lib_title_order(const void* a, const void* b) {
  const LibGame* x = a;
  const LibGame* y = b;
  const int c = strcasecmp(x->title, y->title);
  return c ? c : strcmp(x->id, y->id);
}
// O indice em dia (com g_lib_lock): relido quando o arquivo muda (olhado no maximo a cada 2 s). -> g_lib_state.
static int lib_refresh_locked(void) {
  const int64_t now = mono_ms();
  if (g_lib_state && now - g_lib_checked < 2000) return g_lib_state;
  g_lib_checked = now;
  struct stat st;
  if (stat(g_lib_path, &st)) {
    if (g_lib_state != 2) logf_("biblioteca TorBox: sem o arquivo da lista");
    lib_index_free(g_lib);
    g_lib = NULL;
    return g_lib_state = 2;
  }
  if ((g_lib_state == 1 || g_lib_state == 3) && (int64_t)st.st_mtime == g_lib_mtime && (uint64_t)st.st_size == g_lib_bytes) return g_lib_state;
  g_lib_mtime = (int64_t)st.st_mtime;
  g_lib_bytes = (uint64_t)st.st_size;
  LibParse p;
  memset(&p, 0, sizeof p);
  p.index = lib_index_new();
  if (!p.index) return g_lib_state ? g_lib_state : 3;
  const int64_t started = mono_ms();
  const int state = lib_read(&p);
  if (state != 1) {
    lib_index_free(p.index);
    lib_index_free(g_lib);
    g_lib = NULL;
    logf_("biblioteca TorBox: lista %s", state == 2 ? "sumiu" : "invalida (nenhum jogo lido)");
    return g_lib_state = state;
  }
  if (p.index->count > 1) qsort(p.index->games, (size_t)p.index->count, sizeof(LibGame), lib_title_order);
  lib_index_free(g_lib);
  g_lib = p.index;
  logf_("biblioteca TorBox: %d jogo(s) lido(s) em %lld ms (%llu KiB)%s%s", g_lib->count, (long long)(mono_ms() - started),
        (unsigned long long)(g_lib_bytes / 1024), g_lib->partial ? "; lista cortada ou com erro, lido ate onde deu" : "",
        g_lib->skipped ? "; alguns itens sem id pulados" : "");
  return g_lib_state = 1;
}

// ---- Consulta (filtros da URL) ----
typedef struct {
  char q[200], formats[256], genres[512];
  int platform;   // 0 todas, 1 ps5, 2 ps4
  int sort;       // 0 titulo, 1 maiores, 2 menores
  int offset, limit;
  uint64_t min, max; // max 0 = sem limite
  uint32_t format_mask;
  uint64_t genre_mask;
  int format_none, genre_none; // so nomes desconhecidos pedidos: nada casa
} LibQuery;
enum { LIB_DIM_PLATFORM = 1, LIB_DIM_FORMAT = 2, LIB_DIM_GENRE = 4, LIB_DIM_SIZE = 8 };

static int hex_digit(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }
static void url_decode(const char* in, size_t n, char* out, size_t cap) {
  size_t k = 0;
  for (size_t i = 0; i < n && k + 1 < cap; ++i) {
    char c = in[i];
    if (c == '+') c = ' ';
    else if (c == '%' && i + 2 < n && hex_digit(in[i + 1]) >= 0 && hex_digit(in[i + 2]) >= 0) {
      c = (char)(hex_digit(in[i + 1]) * 16 + hex_digit(in[i + 2]));
      i += 2;
    }
    if (c) out[k++] = c;
  }
  out[k] = 0;
}
static void lib_query_parse(const char* query, LibQuery* q) {
  memset(q, 0, sizeof *q);
  q->limit = 40;
  for (const char* p = query ? query : ""; *p;) {
    const size_t n = strcspn(p, "&");
    const char* eq = memchr(p, '=', n);
    const size_t key_size = eq ? (size_t)(eq - p) : n;
    char key[24], value[600];
    url_decode(p, key_size, key, sizeof key);
    if (eq) url_decode(eq + 1, n - key_size - 1, value, sizeof value);
    else value[0] = 0;
    if (!strcmp(key, "q")) { copy_utf8(q->q, sizeof q->q, value); lower_ascii(q->q); }
    else if (!strcmp(key, "platform")) { lower_ascii(value); q->platform = !strcmp(value, "ps5") ? 1 : !strcmp(value, "ps4") ? 2 : 0; }
    else if (!strcmp(key, "format")) copy_utf8(q->formats, sizeof q->formats, value);
    else if (!strcmp(key, "genre")) copy_utf8(q->genres, sizeof q->genres, value);
    else if (!strcmp(key, "minSize")) q->min = strtoull(value, NULL, 10);
    else if (!strcmp(key, "maxSize")) q->max = strtoull(value, NULL, 10);
    else if (!strcmp(key, "offset")) { const long v = strtol(value, NULL, 10); q->offset = v < 0 ? 0 : v > LIB_MAX_GAMES ? LIB_MAX_GAMES : (int)v; }
    else if (!strcmp(key, "limit")) { const long v = strtol(value, NULL, 10); q->limit = v < 1 ? 1 : v > LIB_PAGE ? LIB_PAGE : (int)v; }
    else if (!strcmp(key, "sort")) q->sort = !strcmp(value, "big") ? 1 : !strcmp(value, "small") ? 2 : 0;
    p += n;
    if (*p == '&') ++p;
  }
}
// Nomes separados por virgula -> mascara dos que o indice conhece; *none quando so vieram desconhecidos.
static uint64_t lib_names_mask(const char* list, const char* table, size_t width, int count, int* none) {
  uint64_t mask = 0;
  int asked = 0;
  *none = 0;
  for (const char* p = list; *p;) {
    const size_t n = strcspn(p, ",");
    char name[64];
    size_t start = 0, end = n;
    while (start < n && p[start] == ' ') ++start;
    while (end > start && p[end - 1] == ' ') --end;
    if (end > start && end - start < sizeof name) {
      memcpy(name, p + start, end - start);
      name[end - start] = 0;
      if (name[0] == '.') memmove(name, name + 1, strlen(name));
      asked = 1;
      for (int i = 0; i < count; ++i) if (!strcasecmp(table + (size_t)i * width, name)) mask |= 1ull << i;
    }
    p += n;
    if (*p == ',') ++p;
  }
  *none = asked && !mask;
  return mask;
}
// Cada palavra da busca no titulo, no codigo ou no id (so letras ASCII sem diferenca de caixa).
static int lib_text_match(const LibGame* g, const char* query) {
  char hay[300], word[64];
  snprintf(hay, sizeof hay, "%s %s %s", g->title, g->code, g->id);
  lower_ascii(hay);
  for (const char* p = query; *p;) {
    while (*p == ' ') ++p;
    const size_t n = strcspn(p, " ");
    if (!n) break;
    if (n < sizeof word) {
      memcpy(word, p, n);
      word[n] = 0;
      if (!strstr(hay, word)) return 0;
    }
    p += n;
  }
  return 1;
}
static int lib_match(const LibGame* g, const LibQuery* q, int skip) {
  if (!(skip & LIB_DIM_PLATFORM) && q->platform && g->platform != q->platform) return 0;
  if (!(skip & LIB_DIM_FORMAT) && (q->format_none || (q->format_mask && !(g->formats & q->format_mask)))) return 0;
  if (!(skip & LIB_DIM_GENRE) && (q->genre_none || (q->genre_mask && !(g->genres & q->genre_mask)))) return 0;
  if (!(skip & LIB_DIM_SIZE) && (q->min || q->max) && (!g->size || g->size < q->min || (q->max && g->size >= q->max))) return 0;
  return 1;
}
static int lib_size_bucket(uint64_t size) {
  if (!size) return 4;
  return size < 10 * LIB_GIB ? 0 : size < 30 * LIB_GIB ? 1 : size < 60 * LIB_GIB ? 2 : 3;
}
// Ja na fila (com g_lock): um pedido do celular deste jogo, ou um download nao terminado com o mesmo nome.
static int lib_queued_locked(const LibGame* g) {
  for (int i = 0; i < g_job_count; ++i) {
    const Job* j = g_jobs[i];
    if (!strcmp(j->state, "cancelled")) continue;
    if (j->requested) { if (!strcmp(j->lib_id, g->id)) return 1; continue; }
    if (!terminal(j->state) && !strcasecmp(j->name, g->title)) return 1;
  }
  return 0;
}
static void lib_names_json(Buf* b, const char* table, size_t width, int count, uint64_t mask) {
  int first = 1;
  buf_str(b, "[");
  for (int i = 0; i < count; ++i) {
    if (!(mask & (1ull << i))) continue;
    if (!first) buf_str(b, ",");
    first = 0;
    buf_json(b, table + (size_t)i * width);
  }
  buf_str(b, "]");
}
static void lib_game_json(Buf* b, const LibIndex* x, const LibGame* g, int queued) {
  buf_str(b, "{\"id\":"); buf_json(b, g->id);
  buf_str(b, ",\"title\":"); buf_json(b, g->title);
  buf_str(b, ",\"code\":"); buf_json(b, g->code);
  buf_fmt(b, ",\"platform\":\"%s\",\"sizeBytes\":%llu,\"files\":%u,\"queued\":%s,\"formats\":", g->platform == 1 ? "ps5" : g->platform == 2 ? "ps4" : "",
          (unsigned long long)g->size, (unsigned)g->files, queued ? "true" : "false");
  lib_names_json(b, &x->formats[0][0], sizeof x->formats[0], x->format_count, g->formats);
  buf_str(b, ",\"genres\":");
  lib_names_json(b, &x->genres[0][0], sizeof x->genres[0], x->genre_count, g->genres);
  buf_str(b, "}");
}
// Contagens de um filtro (formatos ou generos), da maior para a menor.
static void lib_facet_json(Buf* b, const char* table, size_t width, int count, const int* counts) {
  int order[64];
  for (int i = 0; i < count; ++i) {
    int k = i;
    while (k > 0 && counts[order[k - 1]] < counts[i]) { order[k] = order[k - 1]; --k; }
    order[k] = i;
  }
  buf_str(b, "[");
  for (int i = 0; i < count; ++i) {
    if (i) buf_str(b, ",");
    buf_str(b, "{\"name\":");
    buf_json(b, table + (size_t)order[i] * width);
    buf_fmt(b, ",\"count\":%d}", counts[order[i]]);
  }
  buf_str(b, "]");
}
typedef struct { uint64_t size; int index; } LibOrder;
static int lib_big_first(const void* a, const void* b) {
  const LibOrder* x = a;
  const LibOrder* y = b;
  return x->size != y->size ? (x->size < y->size ? 1 : -1) : x->index - y->index;
}
static int lib_small_first(const void* a, const void* b) {
  const LibOrder* x = a;
  const LibOrder* y = b;
  // Tamanho desconhecido (0) vai para o fim.
  const uint64_t sx = x->size ? x->size : UINT64_MAX, sy = y->size ? y->size : UINT64_MAX;
  return sx != sy ? (sx < sy ? -1 : 1) : x->index - y->index;
}

static void monitor_library(int fd, const char* query) {
  LibQuery* q = calloc(1, sizeof *q);
  if (!q) { monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
  lib_query_parse(query, q);
  pthread_mutex_lock(&g_lib_lock);
  const int state = lib_refresh_locked();
  if (state != 1 || !g_lib) {
    pthread_mutex_unlock(&g_lib_lock);
    free(q);
    if (state == 2) monitor_json(fd, 404, "{\"error\":\"no-library\"}");
    else monitor_json(fd, 500, "{\"error\":\"bad-library\"}");
    return;
  }
  const LibIndex* x = g_lib;
  q->format_mask = (uint32_t)lib_names_mask(q->formats, &x->formats[0][0], sizeof x->formats[0], x->format_count, &q->format_none);
  q->genre_mask = lib_names_mask(q->genres, &x->genres[0][0], sizeof x->genres[0], x->genre_count, &q->genre_none);
  LibOrder* matches = malloc(sizeof *matches * (size_t)(x->count + 1));
  if (!matches) { pthread_mutex_unlock(&g_lib_lock); free(q); monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
  int platforms[3] = {0}, sizes[5] = {0}, formats[LIB_FORMATS] = {0}, genres[LIB_GENRES] = {0}, count = 0;
  for (int i = 0; i < x->count; ++i) {
    const LibGame* g = &x->games[i];
    if (q->q[0] && !lib_text_match(g, q->q)) continue;
    if (lib_match(g, q, LIB_DIM_PLATFORM)) ++platforms[g->platform < 3 ? g->platform : 0];
    if (lib_match(g, q, LIB_DIM_SIZE)) ++sizes[lib_size_bucket(g->size)];
    if (lib_match(g, q, LIB_DIM_FORMAT)) for (int k = 0; k < x->format_count; ++k) if (g->formats & (1u << k)) ++formats[k];
    if (lib_match(g, q, LIB_DIM_GENRE)) for (int k = 0; k < x->genre_count; ++k) if (g->genres & (1ull << k)) ++genres[k];
    if (lib_match(g, q, 0)) { matches[count].size = g->size; matches[count].index = i; ++count; }
  }
  if (q->sort && count > 1) qsort(matches, (size_t)count, sizeof *matches, q->sort == 1 ? lib_big_first : lib_small_first);
  Buf b = {0};
  buf_str(&b, "{\"ok\":true,\"builtAt\":");
  buf_json(&b, x->built);
  buf_fmt(&b, ",\"partial\":%s,\"total\":%d,\"count\":%d,\"offset\":%d,\"limit\":%d,\"games\":[", x->partial ? "true" : "false", x->count, count,
          q->offset, q->limit);
  pthread_mutex_lock(&g_lock);
  for (int i = q->offset, shown = 0; i < count && shown < q->limit; ++i, ++shown) {
    if (shown) buf_str(&b, ",");
    const LibGame* g = &x->games[matches[i].index];
    lib_game_json(&b, x, g, lib_queued_locked(g));
  }
  pthread_mutex_unlock(&g_lock);
  buf_fmt(&b, "],\"facets\":{\"platforms\":{\"ps5\":%d,\"ps4\":%d,\"other\":%d},\"sizes\":{\"lt10\":%d,\"10to30\":%d,\"30to60\":%d,\"gt60\":%d,\"unknown\":%d},\"formats\":",
          platforms[1], platforms[2], platforms[0], sizes[0], sizes[1], sizes[2], sizes[3], sizes[4]);
  lib_facet_json(&b, &x->formats[0][0], sizeof x->formats[0], x->format_count, formats);
  buf_str(&b, ",\"genres\":");
  lib_facet_json(&b, &x->genres[0][0], sizeof x->genres[0], x->genre_count, genres);
  buf_str(&b, "}}");
  pthread_mutex_unlock(&g_lib_lock);
  free(matches);
  free(q);
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_send(fd, 200, "application/json", b.data, b.size);
  free(b.data);
}

// O jogo `id` com os arquivos, relido do arquivo. -> 1 achou, 0 nao achou, 2 sem o arquivo, 3 invalido.
static int lib_find(const char* id, LibParse* p) {
  memset(p, 0, sizeof *p);
  p->index = lib_index_new();
  p->files = calloc(LIB_FILES, sizeof(LibFile));
  p->want = id;
  if (!p->index || !p->files || !id[0]) return 3;
  pthread_mutex_lock(&g_lib_lock);
  const int state = lib_read(p);
  pthread_mutex_unlock(&g_lib_lock);
  return state != 1 ? state : p->found;
}
static void lib_find_free(LibParse* p) {
  lib_index_free(p->index);
  free(p->files);
}
// O hash de um torrent: 40 hex (ou 64, v2) ou 32 letras base32.
static int lib_hash_ok(const char* hash) {
  const size_t n = strlen(hash);
  if (n != 32 && n != 40 && n != 64) return 0;
  for (const char* p = hash; *p; ++p) if (!isalnum((unsigned char)*p)) return 0;
  return 1;
}
// Um arquivo que o app sabe pedir: torrent com infohash, webdl com a fonte do catalogo, ou item da conta com o arquivo.
static int lib_file_ok(const LibFile* f, const LibGame* g) {
  if (!strcmp(f->via, "account")) return f->item_id[0] && f->file_id[0];
  if (!strcmp(f->via, "webdl")) return f->release[0] != 0;
  if (!strcmp(f->via, "torrent") || !f->via[0]) return lib_hash_ok(f->hash[0] ? f->hash : g->hash);
  return 0;
}
// O torrent inteiro (como um zip): o primeiro arquivo de torrent (pelo infohash) ou de um torrent da conta; -1 sem.
static int lib_whole_source(const LibParse* p) {
  for (int i = 0; i < p->file_count; ++i) {
    const LibFile* f = &p->files[i];
    if ((!strcmp(f->via, "torrent") || !f->via[0]) && lib_hash_ok(f->hash[0] ? f->hash : p->game.hash)) return i;
    if (!strcmp(f->via, "account") && !strcmp(f->item_kind, "torrent") && f->item_id[0]) return i;
  }
  return p->file_count == 0 && lib_hash_ok(p->game.hash) ? LIB_FILES : -1; // sem arquivos: o hash do jogo
}
// O arquivo que "Baixar" pega sem escolha: o de melhor formato (exFAT primeiro, como o "Procurar no TorBox"), o maior no
// empate, nunca um pedaco de arquivo dividido. -1: o torrent inteiro (como um zip).
static int lib_suggest(const LibParse* p) {
  int best = -1;
  for (int i = 0; i < p->file_count; ++i) {
    const LibFile* f = &p->files[i];
    const int rank = lib_rank(f->format);
    if (rank >= 99 || f->piece || !lib_file_ok(f, &p->game)) continue;
    if (best < 0 || rank < lib_rank(p->files[best].format) || (rank == lib_rank(p->files[best].format) && f->size > p->files[best].size)) best = i;
  }
  if (best < 0 && p->file_count == 1 && !p->files[0].piece && lib_file_ok(&p->files[0], &p->game)) best = 0;
  return best;
}
static void monitor_library_game(int fd, const char* query) {
  char id[96] = "";
  for (const char* p = query ? query : ""; *p;) {
    const size_t n = strcspn(p, "&");
    if (n > 3 && !strncmp(p, "id=", 3)) url_decode(p + 3, n - 3, id, sizeof id);
    p += n;
    if (*p == '&') ++p;
  }
  LibParse p;
  const int found = lib_find(id, &p);
  if (found != 1) {
    lib_find_free(&p);
    monitor_json(fd, 404, found == 2 ? "{\"error\":\"no-library\"}" : "{\"error\":\"not-found\"}");
    return;
  }
  const int suggested = lib_suggest(&p);
  Buf b = {0};
  pthread_mutex_lock(&g_lock);
  const int queued = lib_queued_locked(&p.game);
  pthread_mutex_unlock(&g_lock);
  buf_str(&b, "{\"ok\":true,\"game\":");
  lib_game_json(&b, p.index, &p.game, queued);
  buf_str(&b, ",\"files\":[");
  for (int i = 0; i < p.file_count; ++i) {
    if (i) buf_str(&b, ",");
    buf_str(&b, "{\"name\":");
    buf_json(&b, p.files[i].name);
    buf_fmt(&b, ",\"size\":%llu,\"format\":", (unsigned long long)p.files[i].size);
    buf_json(&b, p.files[i].format);
    buf_str(&b, ",\"via\":");
    buf_json(&b, p.files[i].via);
    buf_fmt(&b, ",\"piece\":%s,\"ok\":%s}", p.files[i].piece ? "true" : "false", lib_file_ok(&p.files[i], &p.game) ? "true" : "false");
  }
  buf_fmt(&b, "],\"wholeOk\":%s,\"suggested\":", lib_whole_source(&p) >= 0 ? "true" : "false");
  buf_json(&b, suggested >= 0 ? p.files[suggested].name : "");
  buf_str(&b, "}");
  lib_find_free(&p);
  if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
  else monitor_send(fd, 200, "application/json", b.data, b.size);
  free(b.data);
}

typedef struct { char id[96], file[256]; int whole; } AddBody;
static int add_field(JP* jp, const char* key, void* ctx) {
  AddBody* a = ctx;
  if (!strcmp(key, "id")) return lib_text(jp, a->id, sizeof a->id) ? 1 : -1;
  if (!strcmp(key, "file")) return lib_text(jp, a->file, sizeof a->file) ? 1 : -1;
  if (!strcmp(key, "whole")) return jp_bool(jp, &a->whole) ? 1 : -1;
  return jp_skip(jp) ? 1 : -1;
}
// A fonte do pedido no job: o arquivo escolhido (ou, inteiro, o torrent do arquivo `from`; sem arquivo, o hash do jogo).
static void lib_request_source(Job* j, const LibGame* g, const LibFile* from, int whole) {
  j->lib_whole = whole;
  snprintf(j->lib_hash, sizeof j->lib_hash, "%s", from && from->hash[0] ? from->hash : g->hash);
  snprintf(j->lib_via, sizeof j->lib_via, "%s", from && from->via[0] ? from->via : "torrent");
  snprintf(j->lib_release, sizeof j->lib_release, "%s", from ? from->release : "");
  snprintf(j->lib_item_kind, sizeof j->lib_item_kind, "%s", from ? from->item_kind : "");
  snprintf(j->lib_item_id, sizeof j->lib_item_id, "%s", from ? from->item_id : "");
  snprintf(j->lib_file_id, sizeof j->lib_file_id, "%s", from && !whole ? from->file_id : "");
  copy_text(j->lib_file, sizeof j->lib_file, from && !whole ? from->name : "");
}
static void monitor_library_add(int fd, Request* r) {
  if (!session_ok(r->session)) { monitor_json(fd, 401, "{\"error\":\"pin\"}"); return; }
  AddBody a;
  memset(&a, 0, sizeof a);
  JP jp = {r->body, r->body + r->content_length, 0};
  if (!r->body || !jp_object(&jp, add_field, &a) || !a.id[0]) { monitor_json(fd, 400, "{\"error\":\"id\"}"); return; }
  LibParse p;
  const int found = lib_find(a.id, &p);
  if (found != 1) {
    lib_find_free(&p);
    monitor_json(fd, 404, found == 2 ? "{\"error\":\"no-library\"}" : "{\"error\":\"not-found\"}");
    return;
  }
  const LibGame* g = &p.game;
  int chosen = -1, whole = a.whole;
  if (!whole && a.file[0]) {
    for (int i = 0; i < p.file_count && chosen < 0; ++i) if (!strcmp(p.files[i].name, a.file)) chosen = i;
    if (chosen < 0) { lib_find_free(&p); monitor_json(fd, 400, "{\"error\":\"file\"}"); return; }
    // Uma parte de arquivo dividido so vale com as outras: o torrent inteiro.
    if (p.files[chosen].piece) { lib_find_free(&p); monitor_json(fd, 400, "{\"error\":\"piece\"}"); return; }
    if (!lib_file_ok(&p.files[chosen], g)) { lib_find_free(&p); monitor_json(fd, 400, "{\"error\":\"no-source\"}"); return; }
  } else if (!whole) {
    chosen = lib_suggest(&p);
    whole = chosen < 0;
  }
  // O torrent inteiro: de um arquivo de torrent (ou do hash do jogo, sem arquivos).
  const int source = whole ? lib_whole_source(&p) : chosen;
  if (source < 0) { lib_find_free(&p); monitor_json(fd, 400, "{\"error\":\"no-source\"}"); return; }
  const LibFile* from = source < p.file_count ? &p.files[source] : NULL;
  const uint64_t size = !whole && from && from->size ? from->size : g->size;
  char answer[160], id[24];
  pthread_mutex_lock(&g_lock);
  Job* same = NULL;
  for (int i = 0; i < g_job_count && !same; ++i) {
    Job* j = g_jobs[i];
    if (j->requested ? !strcmp(j->lib_id, g->id) : !terminal(j->state) && !strcasecmp(j->name, g->title)) same = j;
  }
  if (same && same->requested && !strcmp(same->state, "failed")) {
    // Pedido que o app nao conseguiu por na fila: tenta de novo (com o arquivo escolhido agora).
    snprintf(same->state, sizeof same->state, "waiting-app");
    same->error[0] = 0;
    lib_request_source(same, g, from, whole);
    same->total = size;
    same->updated = now_s();
    save_jobs_locked();
    same = NULL;
    snprintf(answer, sizeof answer, "{\"ok\":true,\"retried\":true,\"appOpen\":%s}", app_away() ? "false" : "true");
  } else if (same) {
    copy_text(id, sizeof id, same->id);
    snprintf(answer, sizeof answer, "{\"ok\":true,\"already\":true,\"id\":\"%s\"}", id);
  } else if (g_job_count >= MAX_JOBS) {
    pthread_mutex_unlock(&g_lock);
    lib_find_free(&p);
    monitor_json(fd, 409, "{\"error\":\"full\"}");
    return;
  } else {
    Job* j = calloc(1, sizeof *j);
    if (!j) { pthread_mutex_unlock(&g_lock); lib_find_free(&p); monitor_json(fd, 500, "{\"error\":\"out of memory\"}"); return; }
    Hash h;
    char digest[65];
    hash_init(&h);
    hash_text0(&h, g->id);
    if (!hash_finish(&h, digest)) snprintf(digest, sizeof digest, "%032x", g_next_id + 1);
    snprintf(j->key, sizeof j->key, "lib-%.24s", digest);
    j->placeholder = 1;
    j->requested = 1;
    snprintf(j->id, sizeof j->id, "b%u", ++g_next_id);
    snprintf(j->state, sizeof j->state, "waiting-app");
    copy_utf8(j->name, sizeof j->name, g->title);
    j->total = size;
    j->order = 100000; // depois da fila do app
    j->created = j->updated = now_s();
    snprintf(j->lib_id, sizeof j->lib_id, "%s", g->id);
    snprintf(j->lib_code, sizeof j->lib_code, "%s", g->code);
    snprintf(j->lib_platform, sizeof j->lib_platform, "%s", g->platform == 1 ? "ps5" : g->platform == 2 ? "ps4" : "");
    lib_request_source(j, g, from, whole);
    g_jobs[g_job_count++] = j;
    save_jobs_locked();
    pthread_cond_broadcast(&g_wake_downloader);
    copy_text(id, sizeof id, j->id);
    snprintf(answer, sizeof answer, "{\"ok\":true,\"id\":\"%s\",\"appOpen\":%s}", id, app_away() ? "false" : "true");
  }
  const int created = !strstr(answer, "already");
  const int away = app_away();
  pthread_mutex_unlock(&g_lock);
  if (created) {
    logf_("celular: pedido da Biblioteca TorBox: %s (%s)", g->title, whole ? "o torrent inteiro" : chosen >= 0 ? base_name(p.files[chosen].name) : "?");
    // Com o app fechado, o PS5 avisa que o pedido espera a Jobee'sLair abrir.
    if (away) {
      char text[400];
      snprintf(text, sizeof text, "Jobee'sLair: %.200s entrou na fila pelo celular. Abra a Jobee'sLair para baixar.", g->title);
      notify(text);
    }
  }
  lib_find_free(&p);
  monitor_json(fd, 200, answer);
}

static void monitor_route(int fd, Request* r, uint32_t ip) {
  char* query = strchr(r->path, '?');
  if (query) *query++ = 0;
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/library")) { monitor_library(fd, query); return; }
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/library/game")) { monitor_library_game(fd, query); return; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/library/add")) { monitor_library_add(fd, r); return; }
  if (!strcmp(r->method, "GET") && (!strcmp(r->path, "/") || !strcmp(r->path, "/index.html"))) {
    monitor_send(fd, 200, "text/html; charset=utf-8", BG_MONITOR_HTML, BG_MONITOR_HTML_SIZE);
    return;
  }
  if (!strcmp(r->method, "GET") && !strcmp(r->path, "/api/status")) {
    Buf b = {0};
    monitor_status(&b);
    if (b.failed || !b.data) monitor_json(fd, 500, "{\"error\":\"out of memory\"}");
    else monitor_send(fd, 200, "application/json", b.data, b.size);
    free(b.data);
    return;
  }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/unlock")) { monitor_unlock(fd, r, ip); return; }
  if (!strcmp(r->method, "POST") && !strncmp(r->path, "/api/jobs/", 10)) { monitor_action(fd, r); return; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/config")) { monitor_config(fd, r); return; }
  if (!strcmp(r->method, "POST") && !strcmp(r->path, "/api/power")) { monitor_power(fd, r); return; }
  monitor_json(fd, 404, "{\"error\":\"not found\"}");
}

// Fecha aos poucos: avisa o fim (SHUT_WR) e espera o navegador fechar (ate 2 s), para ele ler a resposta inteira.
static void close_gently(int fd) {
  shutdown(fd, SHUT_WR);
  struct timeval linger = {0, 200000};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &linger, sizeof linger);
  char drain[512];
  for (const int64_t until = mono_ms() + 2000; mono_ms() < until;) {
    ssize_t n = recv(fd, drain, sizeof drain, 0);
    if (n == 0) break;
    if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;
  }
  close(fd);
}

static void* serve_monitor(void* arg) {
  int fd = (int)(intptr_t)arg;
  struct timeval timeout = {5, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
#ifdef SO_NOSIGPIPE
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
  struct sockaddr_in peer;
  socklen_t peer_size = sizeof peer;
  uint32_t ip = 0;
  if (!getpeername(fd, (struct sockaddr*)&peer, &peer_size) && peer.sin_family == AF_INET) ip = peer.sin_addr.s_addr;
  Request r;
  memset(&r, 0, sizeof r);
  int status = read_request(fd, &r);
  if (status == 200) monitor_route(fd, &r, ip);
  else if (status) monitor_json(fd, status, "{\"error\":\"bad request\"}");
  if (r.body) { memset(r.body, 0, r.content_length); free(r.body); }
  close_gently(fd);
  pthread_mutex_lock(&g_monitor_lock);
  --g_monitor_clients;
  pthread_mutex_unlock(&g_monitor_lock);
  return NULL;
}

static int open_monitor(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)g_monitor_port);
  address.sin_addr.s_addr = htonl(INADDR_ANY); // a rede de casa
  if (bind(fd, (struct sockaddr*)&address, sizeof address) || listen(fd, 16)) { close(fd); return -1; }
  return fd;
}

// Liga e desliga a porta conforme a opcao; no maximo MONITOR_CLIENTS conexoes ao mesmo tempo (o resto e fechado).
static void* monitor_loop(void* arg) {
  (void)arg;
  int server = -1, failures = 0;
  int64_t next_try = 0;
  while (!g_stop) {
    if (server >= 0 && (!g_monitor_on || g_reopen_monitor)) {
      close(server);
      server = -1;
      if (g_reopen_monitor) next_try = mono_ms() + 2000;
      logf_("pagina do celular: porta %d fechada%s", g_monitor_port, g_monitor_on ? " (reabrindo)" : "");
    }
    g_reopen_monitor = 0;
    if (server < 0) {
      if (!g_monitor_on || mono_ms() < next_try) { sleep_ms(200); continue; }
      server = open_monitor();
      if (server < 0) { logf_("pagina do celular: porta %d indisponivel (%s); tenta de novo em 10 s", g_monitor_port, strerror(errno)); next_try = mono_ms() + 10000; continue; }
      logf_("pagina do celular: ouvindo em 0.0.0.0:%d", g_monitor_port);
      failures = 0;
    }
    struct pollfd p = {server, POLLIN, 0};
    const int ready = poll(&p, 1, 500);
    if (ready < 0 && errno != EINTR) sleep_ms(100); // poll que falha na hora nao vira laco ocupado
    if (ready <= 0) continue;
    int client = accept(server, NULL, NULL);
    if (client < 0) {
      if (errno == EINTR) continue;
      if (++failures >= 5) { close(server); server = -1; next_try = mono_ms() + 2000; }
      else sleep_ms(50);
      continue;
    }
    failures = 0;
    pthread_mutex_lock(&g_monitor_lock);
    const int room = g_monitor_clients < MONITOR_CLIENTS;
    if (room) ++g_monitor_clients;
    pthread_mutex_unlock(&g_monitor_lock);
    if (!room) { close(client); continue; }
    if (spawn_thread(serve_monitor, (void*)(intptr_t)client, NULL)) {
      close(client);
      pthread_mutex_lock(&g_monitor_lock);
      --g_monitor_clients;
      pthread_mutex_unlock(&g_monitor_lock);
    }
  }
  if (server >= 0) close(server);
  return NULL;
}

int main(void) {
  signal(SIGPIPE, SIG_IGN); // um cliente que fecha no meio nao derruba o processo
  signal(SIGHUP, SIG_IGN);
  signal(SIGTERM, on_stop);
  signal(SIGINT, on_stop);
  signal(SIGCONT, on_continue);
  // Sinais fatais: uma linha no diario antes de morrer (sem ela, um crash nao deixaria rastro).
  signal(SIGSEGV, on_fatal);
  signal(SIGBUS, on_fatal);
  signal(SIGILL, on_fatal);
  signal(SIGFPE, on_fatal);
  signal(SIGABRT, on_fatal);
  signal(SIGSYS, on_fatal);
  snprintf(g_dir, sizeof g_dir, "%s", env_or("BGDL_DIR", "/data/JobeesLair/bg"));
  // glibren: a Biblioteca TorBox que o app grava (Configuracoes); outro caminho so nos testes.
  snprintf(g_lib_path, sizeof g_lib_path, "%s", env_or("BGDL_LIBRARY", "/data/JobeesLair/torbox-lista.json"));
  g_port = atoi(env_or("BGDL_PORT", "34200"));
  if (g_port <= 0 || g_port > 65535) g_port = DEFAULT_PORT;
  g_monitor_port = atoi(env_or("BGDL_MONITOR_PORT", "34201"));
  if (g_monitor_port <= 0 || g_monitor_port > 65535) g_monitor_port = MONITOR_PORT;
  g_app_silence_ms = atoi(env_or("BGDL_APP_SILENCE_MS", "15000"));
  if (g_app_silence_ms <= 0) g_app_silence_ms = 15000;
  g_fake_free = strtoull(env_or("BGDL_FAKE_FREE_BYTES", "0"), NULL, 10);
  g_last_app_ms = mono_ms();
  g_session_seconds = atoi(env_or("BGDL_SESSION_SECONDS", "43200"));
  if (g_session_seconds <= 0) g_session_seconds = 12 * 3600;
#ifdef __PROSPERO__
  g_quiet_close_ms = 30000;
#else
  g_quiet_close_ms = atoi(env_or("BGDL_QUIET_MS", "0")); // nos testes, sem modo quieto a menos que pedido
  if (g_quiet_close_ms < 0) g_quiet_close_ms = 0;
#endif
  g_quiet_ms = g_quiet_close_ms; // glibren.5: a pausa padrao; o config.json (pauseOnCloseSeconds) pode muda-la
#ifdef __PROSPERO__
  snprintf(g_cainfo, sizeof g_cainfo, "/system/common/cert/CA_LIST.cer");
#else
  snprintf(g_cainfo, sizeof g_cainfo, "%s", env_or("BGDL_CAINFO", ""));
  snprintf(g_torbox_base, sizeof g_torbox_base, "%s", env_or("BGDL_TORBOX_BASE", g_torbox_base));
#endif
  if (mkdir_p(g_dir)) return 1;
  snprintf(g_log_path, sizeof g_log_path, "%s/bgdl.log", g_dir);
  set_process_name();
  read_previous_session();
  logk_("==== iniciando bg-downloader %s (%s), pid %d, pai %d", BG_VERSION, BG_BUILD, (int)getpid(), (int)getppid());
  g_lock_fd = take_lock();
  if (g_lock_fd < 0) { logk_("outra copia segura o lock; saindo"); printf("busy\n"); fflush(stdout); return 1; }
  report_previous_session(g_lock_contended);
  {
    int policy = 0;
    struct sched_param param;
    memset(&param, 0, sizeof param);
    const int got = pthread_getschedparam(pthread_self(), &policy, &param);
    // So registra: a classe e a prioridade que o loader deu ao processo (evidencia para decidir se precisa baixar).
    if (got == 0) logk_("agendamento da thread principal: politica %d, prioridade %d", policy, param.sched_priority);
    else logk_("agendamento da thread principal: indisponivel (%d)", got);
  }
  load_token();
  printf("ready\n");
  fflush(stdout);
#ifdef __PROSPERO__
  // O loader ligou a conexao do app ao stdout/stderr; o app desliga depois da resposta.
  int null_fd = open("/dev/null", O_WRONLY);
  if (null_fd >= 0) { dup2(null_fd, STDOUT_FILENO); dup2(null_fd, STDERR_FILENO); close(null_fd); }
#endif
  srand((unsigned)(time(NULL) ^ getpid()));
  if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) { logf_("curl_global_init falhou"); return 1; }
  struct stat st;
  if (g_cainfo[0] && stat(g_cainfo, &st)) logf_("aviso: lista de CAs %s indisponivel (%s)", g_cainfo, strerror(errno));
  pthread_mutex_lock(&g_lock);
  load_jobs();
  load_config();
  pthread_mutex_unlock(&g_lock);
  logk_("downloads simultaneos: %d; ate %d conexoes somadas; modo quieto ao fechar o app: %lld s; powerTick: %s; %d job(s) no jobs.json",
        g_max_running, CONN_BUDGET, (long long)(g_quiet_ms / 1000), g_power_tick ? "ligado" : "desligado", g_job_count);
  pthread_t server, monitor, workers[MAX_WORKERS];
  if (spawn_thread(server_loop, NULL, &server)) { logf_("threads nao criadas"); return 1; }
  const int monitor_started = !spawn_thread(monitor_loop, NULL, &monitor);
  if (!monitor_started) logf_("pagina do celular: thread nao criada");
  int started = 0;
  while (started < MAX_WORKERS && !spawn_thread(downloader_loop, NULL, &workers[started])) ++started;
  if (!started) { logf_("threads nao criadas"); return 1; }
  if (started < MAX_WORKERS) logf_("so %d trabalhadores criados", started);
  char ip[64] = "", last_ip[64] = "";
  current_ip(last_ip, sizeof last_ip);
  int64_t last_save = mono_ms();
  time_t last_wall = time(NULL);
  // O app aberto? (sceLncUtilGetAppId, a mesma consulta que o sandbox-sweeper faz em laco) e falando com o payload?
  int app_seen = app_running(), app_talking = 1, was_quiet = 0;
  int64_t last_close = INT64_MIN / 2, last_event = mono_ms(), last_beat = mono_ms();
  logk_("app %s ao iniciar", app_seen ? "aberto" : "fechado");
  while (!g_stop) {
    sleep_ms(1000);
    power_check(); // glibren: desligar/repouso pedido pela pagina do celular
    {
      const int64_t mono = mono_ms();
      const int running_now = app_running();
      if (running_now != app_seen) {
        app_seen = running_now;
        last_event = mono;
        if (!running_now) {
          last_close = mono;
          if (g_quiet_ms > 0) {
            start_quiet(mono);
            logk_("app FECHOU (sceLncUtilGetAppId): modo quieto por %lld s; %d job(s) baixando", (long long)(g_quiet_ms / 1000), g_running_count);
          } else {
            logk_("app FECHOU (sceLncUtilGetAppId): sem modo quieto (pausa ao fechar: 0 s); %d job(s) baixando", g_running_count);
          }
        } else {
          logk_("app abriu (sceLncUtilGetAppId)");
        }
      }
      const int talking = !app_away();
      if (talking != app_talking) {
        app_talking = talking;
        last_event = mono;
        if (!talking) {
          // Sem a consulta do sistema (ou ela falhou): o silencio tambem conta como fechar.
          // glibren.5: depois de um POST /bye, nao e silencio: o app disse que fechou (e a pausa ja foi aplicada la).
          const int said_bye = mono - g_bye_ms < g_app_silence_ms + BYE_GRACE_MS;
          const int quiet_too = !said_bye && g_quiet_ms > 0 && mono - last_close > 2 * g_quiet_ms;
          if (quiet_too) start_quiet(mono);
          if (said_bye) logk_("app fechando (POST /bye): a fila antecipada segue sozinha");
          else logk_("app calado ha %lld s: a fila antecipada segue sozinha%s", (long long)(g_app_silence_ms / 1000), quiet_too ? "; modo quieto pelo silencio" : "");
        } else {
          logk_("app voltou a falar com o payload");
        }
      }
      const int quiet = quiet_now();
      if (was_quiet && !quiet) logk_("modo quieto terminou: retomando devagar");
      was_quiet = quiet;
      // Pulso: a ultima linha antes de um travamento mostra o que o payload fazia.
      if (mono - last_beat >= HEARTBEAT_MS && (g_running_count > 0 || quiet || mono - last_event < 5 * 60000)) {
        last_beat = mono;
        unsigned conns = 0, queued = 0;
        double rate = 0;
        pthread_mutex_lock(&g_lock);
        const int running = g_running_count;
        for (int i = 0; i < g_job_count; ++i) {
          const Job* j = g_jobs[i];
          if (j->running) { conns += j->active_connections; rate += j->bytes_per_second; }
          else if (!strcmp(j->state, "queued")) ++queued;
        }
        pthread_mutex_unlock(&g_lock);
        logk_("pulso: app %s, falou ha %llds, %d baixando (%u conexoes, %.1f MB/s), %u na fila%s", app_seen ? "aberto" : "fechado",
              (long long)((mono - g_last_app_ms) / 1000), running, conns, rate / 1e6, queued, quiet ? ", QUIETO" : "");
      }
    }
    time_t wall = time(NULL);
    current_ip(ip, sizeof ip);
    int woke = g_wake || wall - last_wall > 10 || wall < last_wall;
    if (strcmp(ip, last_ip)) { logf_("rede: IP %s -> %s", last_ip[0] ? last_ip : "-", ip[0] ? ip : "-"); woke = 1; snprintf(last_ip, sizeof last_ip, "%s", ip); }
    if (woke) { g_wake = 0; ++g_epoch; g_reopen_server = 1; g_reopen_monitor = 1; logf_("acordou (SIGCONT/IP/relogio): reabrindo servidor e conexoes"); }
    last_wall = wall;
    if (mono_ms() - last_save >= 10000) {
      pthread_mutex_lock(&g_lock);
      if (g_dirty) save_jobs_locked();
      pthread_mutex_unlock(&g_lock);
      last_save = mono_ms();
    }
  }
  logk_("parando: gravando o checkpoint");
  pthread_mutex_lock(&g_lock);
  stop_running_locked();
  pthread_cond_broadcast(&g_wake_downloader);
  pthread_mutex_unlock(&g_lock);
  for (int i = 0; i < started; ++i) pthread_join(workers[i], NULL);
  pthread_join(server, NULL);
  if (monitor_started) pthread_join(monitor, NULL);
  pthread_mutex_lock(&g_lock);
  save_jobs_locked();
  pthread_mutex_unlock(&g_lock);
  curl_global_cleanup();
  logk_(CLEAN_EXIT_MARK);
  flock(g_lock_fd, LOCK_UN);
  close(g_lock_fd);
  return 0;
}
