// Copyright (C) 2026 half144 and PS5 React contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Additional attribution term: see LICENSE-ATTRIBUTION.
//
// Replaces the app's own disk image, which the app cannot do: it runs from that image, and nothing of it
// runs after it closes. Like relauncher.elf, the engine sends this program to the payload loader
// (127.0.0.1:9021) and it outlives the app (SelfUpdate.arm in runtime/js/native.js).
//
// Request lines: "UPD1", the title ID, the control directory. Answers "ready" once the request is read,
// or "armed" when another updater already waits (one listens on 127.0.0.1:UPDATER_LOCK_PORT); nothing after.
//
// Once the title has closed, it reads <control>/apply.txt, which the app wrote:
//   UPD1, then version=, target= (the installed .exfat), staged= (the checked new image, on the same
//   filesystem), size= (its bytes) and relaunch= (1: open the app again now; 0: the gamer opens it).
// Then:
//   1. It waits until ShadowMount+ (127.0.0.1:10101) has released the image (it does when a game closes),
//      asking it to unmount the title if it keeps it; an image still mounted, or no answer, changes nothing.
//   2. It renames the installed image to <target>.previous and the staged one to <target>, and asks
//      ShadowMount+ to scan (it notices the new size and time).
//   3. Once the title opens again it waits for <control>/booted.txt to name the new version, which the
//      new build writes as it starts. A build that closes before that, or never opens when relaunched,
//      is put back in staging and <target>.previous is restored.
// What it did goes to <control>/result.txt ("outcome=applied|rolledback|refused", "version=", "reason="),
// and every step to <control>/updater.log. A missing apply.txt when the title closes means the update was
// withdrawn: nothing is done.
//
// glibren.15: reabrir o app depois da troca ("Restart to apply"). Antes era uma tentativa so, 1 s depois do
// pedido de scan, e no console dava "nao foi possivel iniciar o jogo ou app": o ShadowMount+ ainda estava
// largando a execucao anterior (ele recusa o lancamento com EBUSY enquanto finaliza a saida do titulo, ate
// ~10 s, ou enquanto o scan mexe na imagem trocada). Agora (relaunch_if):
//   a. espera o titulo ficar pronto: games/info do ShadowMount+ com o registro do titulo apontando para a
//      imagem, installed e source_available, e a camada /system_ex/app ja solta (mounted: false), duas
//      leituras seguidas, a cada POLL_MS, por ate READY_WAIT_MS. Sem resposta (ShadowMount+ antigo, rota
//      desconhecida) ou com a camada sempre montada (links persistentes), tenta abrir mesmo assim no fim do
//      prazo; com o registro sempre errado (nunca montou), nao tenta: avisa o jogador;
//   b. ate LAUNCH_TRIES tentativas, com intervalo crescente (RETRY_MS); uma tentativa so conta como certa
//      quando o titulo aparece rodando em LAUNCH_CONFIRM_MS; cada uma vai para o updater.log com o codigo;
//   c. se nao abrir, uma notificacao pede para abrir o Jobee'sLair pela tela inicial (o texto vem do app em
//      apply.txt "notice=", no idioma dele; sem ele, ingles + portugues), e a volta para a versao anterior
//      por "nao abriu" so acontece depois de MANUAL_OPEN_WAIT_MS sem o jogador abrir.
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#define LOCK_PORT 34199
#define SHADOWMOUNT_PORT 10101
// How long ShadowMount+ may take to release the image once the title closed, then after an unmount.
#define RELEASE_WAIT_MS 30000
#define UNMOUNT_WAIT_MS 15000
// How long a relaunched build may take to open, then to report that it started, before it counts as broken.
#define OPEN_WAIT_MS 60000
#define BOOT_WAIT_MS 600000
#define POLL_MS 500
#define SETTLE_MS 1000
#define REPLY_MAX (1024 * 1024)
// glibren.15: a reabertura (relaunch_if). Depois do scan, quanto esperar antes de confiar no games/info; ate
// quando esperar o titulo pronto; quantas tentativas, quanto cada uma espera o app aparecer e as pausas entre
// elas; e, sem reabrir, quanto esperar o jogador abrir antes de voltar a versao anterior.
#define SCAN_SETTLE_MS 2000
#define READY_WAIT_MS 45000
#define READY_STABLE 2
#define LAUNCH_TRIES 4
#define LAUNCH_CONFIRM_MS 10000
static const int RETRY_MS[LAUNCH_TRIES - 1] = {3000, 6000, 12000};
#define MANUAL_OPEN_WAIT_MS 600000
#define NOTICE_MAX 600
#define DEFAULT_NOTICE "Jobee'sLair: open it from the home screen to finish the update. / " \
                       "Abra o Jobee'sLair pela tela inicial para concluir a atualização."

#ifdef UPDATER_HOST_TEST
// tools/test_updater.py runs this on the desktop: the title "runs" while <control>/test-running exists,
// a launch creates it and counts itself in <control>/test-launches, and the ports and waits come from the
// environment.
static const char* g_control_for_test;
static int env_int(const char* name, int fallback) {
  const char* value = getenv(name);
  return value && *value ? atoi(value) : fallback;
}
static int scaled(int ms) { return ms / env_int("UPDATER_TIME_SCALE", 1) + 1; }
static int lock_port(void) { return env_int("UPDATER_LOCK_PORT", LOCK_PORT); }
static int shadowmount_port(void) { return env_int("UPDATER_SM_PORT", SHADOWMOUNT_PORT); }
static int test_path(char* out, size_t size, const char* name) {
  return snprintf(out, size, "%s/%s", g_control_for_test, name) < (int)size;
}
static int title_running(const char* title) {
  (void)title;
  char path[1024];
  struct stat st;
  return test_path(path, sizeof path, "test-running") && stat(path, &st) == 0;
}
static int launch_title(const char* title) {
  (void)title;
  char path[1024];
  if (!test_path(path, sizeof path, "test-launches")) return -1;
  FILE* file = fopen(path, "a");
  if (file) { fputs("launch\n", file); fclose(file); }
  // glibren.15: <control>/test-fail-launches com N: as N primeiras tentativas falham como o console recusa
  // ("nao foi possivel iniciar"), com um codigo de erro.
  int launches = 0, failing = 0;
  if (test_path(path, sizeof path, "test-launches") && (file = fopen(path, "r"))) {
    for (int c; (c = fgetc(file)) != EOF;) launches += c == '\n';
    fclose(file);
  }
  if (test_path(path, sizeof path, "test-fail-launches") && (file = fopen(path, "r"))) {
    if (fscanf(file, "%d", &failing) != 1) failing = 0;
    fclose(file);
  }
  if (launches <= failing) return (int)0x80940005u;
  // <control>/test-no-start: the launched build never opens.
  if (test_path(path, sizeof path, "test-no-start") && access(path, F_OK) == 0) return 0;
  if (!test_path(path, sizeof path, "test-running")) return -1;
  file = fopen(path, "w");
  if (file) fclose(file);
  return 0;
}
// glibren.15: a notificacao vai para <control>/test-notices, uma por linha.
static void notify_gamer(const char* text) {
  char path[1024];
  if (!test_path(path, sizeof path, "test-notices")) return;
  FILE* file = fopen(path, "a");
  if (file) { fprintf(file, "%s\n", text); fclose(file); }
}
#else
typedef struct {
  uint32_t size, user_id, app_opt;
  uint64_t crash_report;
  uint32_t check_flag;
} LncAppParam;

int sceUserServiceInitialize(void*);
int sceUserServiceGetForegroundUser(int*);
int sceLncUtilGetAppId(const char* title_id);
int sceLncUtilLaunchApp(const char* title_id, const char** argv, LncAppParam* param);

static int scaled(int ms) { return ms; }
static int lock_port(void) { return LOCK_PORT; }
static int shadowmount_port(void) { return SHADOWMOUNT_PORT; }
static int title_running(const char* title) { return sceLncUtilGetAppId(title) >= 0; }
// 0 when the console took the launch; otherwise its (negative) error code, for the log.
static int launch_title(const char* title) {
  sceUserServiceInitialize(NULL);
  LncAppParam param = {sizeof param, 0, 0, 0, 0};
  sceUserServiceGetForegroundUser((int*)&param.user_id);
  int code = sceLncUtilLaunchApp(title, NULL, &param);
  return code < 0 ? code : 0;
}
// glibren.15: a notificacao do sistema (a mesma do bg-downloader).
typedef struct {
  char reserved[45];
  char message[3075];
} NotifyRequest;
int sceKernelSendNotificationRequest(int, NotifyRequest*, size_t, int);
static void notify_gamer(const char* text) {
  NotifyRequest request;
  memset(&request, 0, sizeof request);
  snprintf(request.message, sizeof request.message, "%s", text);
  sceKernelSendNotificationRequest(0, &request, sizeof request, 0);
}
#endif

static void sleep_ms(int ms) { usleep((useconds_t)scaled(ms) * 1000u); }

static char g_title[16], g_control[1024];

static int control_path(char* out, size_t size, const char* name) {
  return snprintf(out, size, "%s/%s", g_control, name) < (int)size;
}

__attribute__((format(printf, 1, 2))) static void note(const char* format, ...) {
  char path[1100], line[1600];
  if (!control_path(path, sizeof path, "updater.log")) return;
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof line, format, args);
  va_end(args);
  FILE* file = fopen(path, "a");
  if (!file) return;
  fprintf(file, "[%ld] %s\n", (long)time(NULL), line);
  fclose(file);
}

static void say(const char* line) {
  size_t size = strlen(line);
  while (size) {
    ssize_t count = write(STDOUT_FILENO, line, size);
    if (count <= 0) return;
    line += count;
    size -= (size_t)count;
  }
}

static int read_line(int fd, char* line, size_t capacity) {
  size_t length = 0;
  for (;;) {
    char byte;
    if (read(fd, &byte, 1) != 1) return 0;
    if (byte == '\n') { line[length] = 0; return 1; }
    if (length + 1 >= capacity) return 0;
    line[length++] = byte;
  }
}

static int valid_title(const char* id) {
  if (strlen(id) != 9) return 0;
  for (int i = 0; i < 4; ++i) if (id[i] < 'A' || id[i] > 'Z') return 0;
  for (int i = 4; i < 9; ++i) if (id[i] < '0' || id[i] > '9') return 0;
  return 1;
}

// An absolute path without "..", line breaks or quotes (it goes into JSON as it is).
static int valid_path(const char* path) {
  if (path[0] != '/' || strstr(path, "/../") || strstr(path, "\"") || strstr(path, "\\")) return 0;
  size_t length = strlen(path);
  return length > 1 && length < 900 && !(length >= 3 && !strcmp(path + length - 3, "/.."));
}

static int ends_with(const char* text, const char* suffix) {
  size_t a = strlen(text), b = strlen(suffix);
  return a >= b && !strcmp(text + a - b, suffix);
}

static int exists(const char* path) {
  struct stat st;
  return stat(path, &st) == 0;
}

// Writes a small file whole: to <path>.tmp, synced, then renamed over the path.
static int write_file(const char* path, const char* text) {
  char temporary[1100];
  if (snprintf(temporary, sizeof temporary, "%s.tmp", path) >= (int)sizeof temporary) return -1;
  int fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0666);
  if (fd < 0) return -1;
  size_t size = strlen(text);
  int ok = write(fd, text, size) == (ssize_t)size && fsync(fd) == 0;
  close(fd);
  if (!ok || rename(temporary, path) != 0) { unlink(temporary); return -1; }
  return 0;
}

static void result(const char* outcome, const char* version, const char* reason) {
  char path[1100], text[1400];
  if (!control_path(path, sizeof path, "result.txt")) return;
  snprintf(text, sizeof text, "outcome=%s\nversion=%s\nreason=%s\n", outcome, version, reason);
  if (write_file(path, text) != 0) note("could not write result.txt: %s", strerror(errno));
  note("result: %s %s%s%s", outcome, version, *reason ? ": " : "", reason);
}

// Syncs the directory holding `path`, so a rename in it survives a power cut.
static void sync_parent(const char* path) {
  char parent[1024];
  snprintf(parent, sizeof parent, "%s", path);
  char* slash = strrchr(parent, '/');
  if (!slash) return;
  *(slash == parent ? slash + 1 : slash) = 0;
  int fd = open(parent, O_RDONLY | O_DIRECTORY);
  if (fd < 0) return;
  fsync(fd);
  close(fd);
}

// ---- ShadowMount+'s HTTP/JSON API: one POST per connection (docs/api.md upstream) ----

// The reply body of POST /api/v1/<route>, NUL-terminated in a malloc'd buffer; NULL when ShadowMount+
// cannot be reached, answers something that is not HTTP, or more than REPLY_MAX bytes. *status gets the
// HTTP status.
static char* shadow_post(const char* route, const char* body, int* status) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return NULL;
  struct timeval timeout = {10, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)shadowmount_port());
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (struct sockaddr*)&address, sizeof address) != 0) { close(fd); return NULL; }
  char request[1600];
  int length = snprintf(request, sizeof request,
                        "POST /api/v1/%s HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
                        "Content-Length: %zu\r\nConnection: close\r\n\r\n%s", route, strlen(body), body);
  if (length <= 0 || length >= (int)sizeof request || send(fd, request, (size_t)length, 0) != length) { close(fd); return NULL; }
  size_t capacity = 64 * 1024, used = 0;
  char* reply = malloc(capacity + 1);
  if (!reply) { close(fd); return NULL; }
  for (;;) {
    if (used == capacity) {
      if (capacity >= REPLY_MAX) { free(reply); close(fd); return NULL; }
      capacity *= 2;
      char* grown = realloc(reply, capacity + 1);
      if (!grown) { free(reply); close(fd); return NULL; }
      reply = grown;
    }
    ssize_t count = recv(fd, reply + used, capacity - used, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { free(reply); close(fd); return NULL; }
    if (count == 0) break;
    used += (size_t)count;
  }
  close(fd);
  reply[used] = 0;
  int code = 0;
  char* headers_end = strstr(reply, "\r\n\r\n");
  if (strncmp(reply, "HTTP/1.", 7) || sscanf(reply + 8, " %d", &code) != 1 || !headers_end) { free(reply); return NULL; }
  *status = code;
  memmove(reply, headers_end + 4, used - (size_t)(headers_end + 4 - reply) + 1);
  return reply;
}

// Removes the JSON escape of "/" ("\/"), so paths compare as written.
static void unescape_slashes(char* text) {
  char* out = text;
  for (char* in = text; *in; ++in) {
    if (in[0] == '\\' && in[1] == '/') continue;
    *out++ = *in;
  }
  *out = 0;
}

// The value after a JSON key at `at` (which points at its opening quote): past the key, the colon and any
// spaces around it; NULL when `at` is not a key.
static const char* value_after(const char* at, const char* key) {
  size_t length = strlen(key);
  if (at[0] != '"' || strncmp(at + 1, key, length) || at[length + 1] != '"') return NULL;
  at += length + 2;
  while (*at == ' ' || *at == '\t' || *at == '\r' || *at == '\n') ++at;
  if (*at++ != ':') return NULL;
  while (*at == ' ' || *at == '\t' || *at == '\r' || *at == '\n') ++at;
  return at;
}

// Whether the flat object between `start` and `end` has `key` set to true.
static int flag_set(const char* start, const char* end, const char* key) {
  for (const char* at = start; at < end; ++at) {
    const char* value = value_after(at, key);
    if (value && value < end && !strncmp(value, "true", 4)) return 1;
  }
  return 0;
}

// Whether ShadowMount+ has `image` mounted: 1 yes, 0 no (or it does not know the image), -1 no answer.
// Image items are flat objects with "path" and "mounted" among their fields.
static int image_mounted(const char* image) {
  int status = 0;
  char* reply = shadow_post("images", "{}", &status);
  if (!reply) return -1;
  if (status != 200 || !strchr(reply, '{')) { free(reply); return -1; }
  unescape_slashes(reply);
  size_t length = strlen(image);
  int mounted = 0;
  for (const char* at = strstr(reply, "\"path\""); at; at = strstr(at + 1, "\"path\"")) {
    const char* value = value_after(at, "path");
    if (!value || *value != '"' || strncmp(value + 1, image, length) || value[length + 1] != '"') continue;
    const char* start = at;
    while (start > reply && *start != '{') --start;
    const char* end = strchr(value, '}');
    if (!end) break;
    if (flag_set(start, end, "mounted")) mounted = 1;
  }
  free(reply);
  return mounted;
}

static void shadow_ask(const char* route, const char* body) {
  int status = 0;
  char* reply = shadow_post(route, body, &status);
  note("ShadowMount+ %s: %s", route, reply ? (status == 200 ? "accepted" : "refused") : "no answer");
  free(reply);
}

// Waits until ShadowMount+ no longer has `image` mounted; asks it to unmount the title once if it keeps
// it. 0 once released; otherwise the reason it is not.
static const char* wait_released(const char* image) {
  int state = -1;
  for (int waited = 0; waited < RELEASE_WAIT_MS; waited += POLL_MS) {
    if ((state = image_mounted(image)) == 0) return NULL;
    sleep_ms(POLL_MS);
  }
  if (state == -1) return "ShadowMount+ did not answer, so the image could not be checked";
  char body[64];
  snprintf(body, sizeof body, "{\"title_id\":\"%s\"}", g_title);
  shadow_ask("games/unmount", body);
  for (int waited = 0; waited < UNMOUNT_WAIT_MS; waited += POLL_MS) {
    if ((state = image_mounted(image)) == 0) return NULL;
    sleep_ms(POLL_MS);
  }
  return state == -1 ? "ShadowMount+ did not answer, so the image could not be checked"
                     : "ShadowMount+ keeps the image mounted (persistent image mounts?)";
}

// glibren.15: o valor de `key` no objeto de fora de `json` (os objetos de dentro, como o "content" do
// games/info, tem chaves de mesmo nome); NULL quando nao tem.
static const char* top_value(const char* json, const char* key) {
  int depth = 0, in_string = 0, expect_key = 0;
  for (const char* at = json; *at; ++at) {
    if (in_string) {
      if (*at == '\\' && at[1]) ++at;
      else if (*at == '"') in_string = 0;
      continue;
    }
    if (*at == '"') {
      if (depth == 1 && expect_key) {
        const char* value = value_after(at, key);
        if (value) return value;
        expect_key = 0;
      }
      in_string = 1;
    } else if (*at == '{' || *at == '[') {
      ++depth;
      expect_key = depth == 1 && *at == '{';
    } else if (*at == '}' || *at == ']') {
      --depth;
      expect_key = 0;
    } else if (*at == ',' && depth == 1) {
      expect_key = 1;
    }
  }
  return NULL;
}

static int top_true(const char* json, const char* key) {
  const char* value = top_value(json, key);
  return value && !strncmp(value, "true", 4);
}

static int top_false(const char* json, const char* key) {
  const char* value = top_value(json, key);
  return value && !strncmp(value, "false", 5);
}

// O que o ShadowMount+ diz do titulo agora (games/info).
typedef enum {
  TITLE_UNKNOWN,   // sem resposta, ou resposta que nao e o registro (rota que ele nao tem, titulo sumido no scan)
  TITLE_MISSING,   // o registro existe mas nao serve: outra imagem, nao instalado, arquivos inacessiveis
  TITLE_HELD,      // registrado, mas a camada /system_ex/app da execucao anterior ainda esta montada
  TITLE_READY,
} TitleState;

static const char* title_state_name(TitleState state) {
  switch (state) {
    case TITLE_MISSING: return "not registered from the image yet";
    case TITLE_HELD: return "still held from the last run";
    case TITLE_READY: return "ready";
    default: return "no answer";
  }
}

static TitleState title_state(const char* image) {
  char body[64];
  snprintf(body, sizeof body, "{\"title_id\":\"%s\"}", g_title);
  int status = 0;
  char* reply = shadow_post("games/info", body, &status);
  if (!reply) return TITLE_UNKNOWN;
  if (status != 200 || !strchr(reply, '{')) { free(reply); return TITLE_UNKNOWN; }
  unescape_slashes(reply);
  const char* path = top_value(reply, "path");
  size_t length = strlen(image);
  int same = path && *path == '"' && !strncmp(path + 1, image, length) && path[length + 1] == '"';
  TitleState state = TITLE_MISSING;
  if (same && top_true(reply, "installed") && !top_false(reply, "source_available") && !top_false(reply, "managed"))
    state = top_true(reply, "mounted") ? TITLE_HELD : TITLE_READY;
  free(reply);
  return state;
}

// Espera o titulo pronto para abrir: READY_STABLE leituras "pronto" seguidas, ate READY_WAIT_MS. Devolve o
// ultimo estado lido (TITLE_READY quando ficou pronto). Registra cada mudanca no updater.log.
static TitleState wait_ready(const char* image) {
  TitleState state = TITLE_UNKNOWN;
  int streak = 0, logged = -1;
  for (int waited = 0;; waited += POLL_MS) {
    state = title_state(image);
    if ((int)state != logged) {
      note("ShadowMount+ on the app: %s (after %d ms)", title_state_name(state), waited);
      logged = (int)state;
    }
    streak = state == TITLE_READY ? streak + 1 : 0;
    if (streak >= READY_STABLE) return TITLE_READY;
    if (waited >= READY_WAIT_MS) return state;
    sleep_ms(POLL_MS);
  }
}

// ---- the request ----

typedef struct {
  char version[64], target[1024], staged[1024], previous[1100];
  long long size;
  int relaunch;
  // glibren.15: o aviso para abrir o app a mao, no idioma do app ("notice=", opcional).
  char notice[NOTICE_MAX];
} Apply;

static int value_of(const char* line, const char* key, char* out, size_t size) {
  size_t length = strlen(key);
  if (strncmp(line, key, length) || line[length] != '=') return 0;
  return snprintf(out, size, "%s", line + length + 1) < (int)size;
}

// 1 when apply.txt is there and well formed; 0 when it is gone (withdrawn); -1 when it is not usable.
static int read_apply(Apply* apply) {
  char path[1100];
  if (!control_path(path, sizeof path, "apply.txt")) return -1;
  int fd = open(path, O_RDONLY);
  if (fd < 0) return errno == ENOENT ? 0 : -1;
  memset(apply, 0, sizeof *apply);
  apply->size = -1;
  char line[1100], number[32] = "", relaunch[8] = "";
  int ok = read_line(fd, line, sizeof line) && !strcmp(line, "UPD1");
  while (ok && read_line(fd, line, sizeof line)) {
    value_of(line, "version", apply->version, sizeof apply->version);
    value_of(line, "target", apply->target, sizeof apply->target);
    value_of(line, "staged", apply->staged, sizeof apply->staged);
    value_of(line, "size", number, sizeof number);
    value_of(line, "relaunch", relaunch, sizeof relaunch);
    if (!value_of(line, "notice", apply->notice, sizeof apply->notice) && !strncmp(line, "notice=", 7)) *apply->notice = 0;
  }
  // Sem caracteres de controle no texto da notificacao.
  for (char* at = apply->notice; *at; ++at)
    if ((unsigned char)*at < 0x20 || *at == 0x7f) *at = ' ';
  close(fd);
  if (!ok) return -1;
  apply->size = *number ? atoll(number) : -1;
  apply->relaunch = !strcmp(relaunch, "1");
  snprintf(apply->previous, sizeof apply->previous, "%s.previous", apply->target);
  return *apply->version && valid_path(apply->target) && valid_path(apply->staged) && apply->size > 0 &&
         ends_with(apply->target, ".exfat") && !ends_with(apply->staged, ".exfat") ? 1 : -1;
}

static void forget_apply(void) {
  char path[1100];
  if (control_path(path, sizeof path, "apply.txt")) unlink(path);
}

// Why the staged image cannot replace the target, or NULL when it can: both there, the staged one of the
// size the app checked, and both on one filesystem (so the swap is two renames, never a copy).
static const char* unusable(const Apply* apply) {
  struct stat staged, target, folder;
  if (stat(apply->staged, &staged) != 0) return "the staged image is gone";
  if (!S_ISREG(staged.st_mode) || (long long)staged.st_size != apply->size) return "the staged image is not the size that was checked";
  if (stat(apply->target, &target) != 0 || !S_ISREG(target.st_mode)) return "the installed image is not where ShadowMount+ said";
  char parent[1024];
  snprintf(parent, sizeof parent, "%s", apply->target);
  *strrchr(parent, '/') = 0;
  if (stat(*parent ? parent : "/", &folder) != 0 || folder.st_dev != staged.st_dev) return "the staged image is on another drive";
  return NULL;
}

static int booted_as(const char* version) {
  char path[1100], text[80] = "";
  if (!control_path(path, sizeof path, "booted.txt")) return 0;
  int fd = open(path, O_RDONLY);
  if (fd < 0) return 0;
  ssize_t count = read(fd, text, sizeof text - 1);
  close(fd);
  if (count <= 0) return 0;
  text[count] = 0;
  text[strcspn(text, "\r\n")] = 0;
  return !strcmp(text, version);
}

// glibren.15: nao deu para reabrir: o jogador abre pela tela inicial.
static void tell_gamer(const Apply* apply) {
  const char* text = *apply->notice ? apply->notice : DEFAULT_NOTICE;
  note("asked the gamer to open the app: %s", text);
  notify_gamer(text);
}

// Opens the app again when apply.txt asked for it. 1 once it runs; 0 when it was not asked to, or gave up
// (glibren.15: then the gamer is told to open it). Waits for ShadowMount+ to have the title ready, then
// tries up to LAUNCH_TRIES times.
static int relaunch_if(const Apply* apply) {
  if (!apply->relaunch) return 0;
  sleep_ms(SETTLE_MS);
  if (title_running(g_title)) {
    note("the app is already open");
    return 1;
  }
  sleep_ms(SCAN_SETTLE_MS);
  TitleState state = wait_ready(apply->target);
  if (state == TITLE_MISSING) {
    note("ShadowMount+ did not have the app ready in %d s: not opening it", READY_WAIT_MS / 1000);
    tell_gamer(apply);
    return 0;
  }
  if (state != TITLE_READY) note("opening it anyway (ShadowMount+: %s)", title_state_name(state));
  for (int attempt = 1; attempt <= LAUNCH_TRIES; ++attempt) {
    if (title_running(g_title)) {
      note("the app is open");
      return 1;
    }
    int code = launch_title(g_title);
    if (code == 0) {
      for (int waited = 0;; waited += POLL_MS) {
        if (title_running(g_title)) {
          note("opened the app again (attempt %d of %d)", attempt, LAUNCH_TRIES);
          return 1;
        }
        if (waited >= LAUNCH_CONFIRM_MS) break;
        sleep_ms(POLL_MS);
      }
      note("attempt %d of %d: the console took the launch but the app did not open in %d s", attempt, LAUNCH_TRIES,
           LAUNCH_CONFIRM_MS / 1000);
    } else {
      note("attempt %d of %d: could not open the app (error 0x%08x)", attempt, LAUNCH_TRIES, (unsigned)code);
    }
    if (attempt < LAUNCH_TRIES) {
      note("trying again in %d ms", RETRY_MS[attempt - 1]);
      sleep_ms(RETRY_MS[attempt - 1]);
    }
  }
  note("could not open the app again after %d attempts", LAUNCH_TRIES);
  tell_gamer(apply);
  return 0;
}

// Puts the old image back: the new one goes back to staging, so a later try needs no download.
static void roll_back(const Apply* apply, const char* why) {
  note("rolling back: %s", why);
  const char* busy = wait_released(apply->target);
  if (busy) {
    result("failed", apply->version, busy);
    return;
  }
  if (rename(apply->target, apply->staged) != 0 || rename(apply->previous, apply->target) != 0) {
    char reason[300];
    snprintf(reason, sizeof reason, "%s; putting the old image back failed: %s", why, strerror(errno));
    result("failed", apply->version, reason);
    return;
  }
  sync_parent(apply->target);
  shadow_ask("scan", "{}");
  result("rolledback", apply->version, why);
  relaunch_if(apply);
}

static int update(void) {
  note("armed for %s", g_title);
  // 0. The app closes.
  while (title_running(g_title)) {
    char path[1100];
    if (control_path(path, sizeof path, "apply.txt") && !exists(path)) {
      note("the update was withdrawn while the app ran");
      return 0;
    }
    sleep_ms(POLL_MS);
  }
  sleep_ms(SETTLE_MS);
  Apply apply;
  int request = read_apply(&apply);
  if (request == 0) {
    note("the app closed and there is nothing to apply");
    return 0;
  }
  forget_apply();
  if (request < 0) {
    result("refused", "", "apply.txt is not a request this updater understands");
    return 1;
  }
  note("applying %s: %s -> %s", apply.version, apply.staged, apply.target);
  const char* problem = unusable(&apply);
  // 1. ShadowMount+ releases the image.
  if (!problem) problem = wait_released(apply.target);
  if (problem) {
    result("refused", apply.version, problem);
    relaunch_if(&apply);
    return 1;
  }
  // 2. The swap.
  unlink(apply.previous);
  if (rename(apply.target, apply.previous) != 0) {
    char reason[200];
    snprintf(reason, sizeof reason, "the installed image could not be renamed: %s", strerror(errno));
    result("refused", apply.version, reason);
    relaunch_if(&apply);
    return 1;
  }
  if (rename(apply.staged, apply.target) != 0) {
    char reason[200];
    snprintf(reason, sizeof reason, "the new image could not be put in place: %s", strerror(errno));
    rename(apply.previous, apply.target);
    sync_parent(apply.target);
    result("refused", apply.version, reason);
    relaunch_if(&apply);
    return 1;
  }
  sync_parent(apply.target);
  note("swapped in %s", apply.version);
  shadow_ask("scan", "{}");
  char booted[1100];
  if (control_path(booted, sizeof booted, "booted.txt")) unlink(booted);
  result("swapped", apply.version, "");
  // 3. The new build reports that it started.
  // glibren.15: reaberto, o app ja roda; sem conseguir reabrir, o jogador foi avisado e tem
  // MANUAL_OPEN_WAIT_MS para abrir antes de a troca contar como "nao abriu" e voltar.
  int opened = relaunch_if(&apply);
  int waited = 0;
  while (!title_running(g_title)) {
    if (apply.relaunch && waited >= (opened ? OPEN_WAIT_MS : MANUAL_OPEN_WAIT_MS)) {
      roll_back(&apply, "the new version did not open");
      return 1;
    }
    sleep_ms(POLL_MS);
    waited += POLL_MS;
  }
  for (waited = 0; waited < BOOT_WAIT_MS; waited += POLL_MS) {
    if (booted_as(apply.version)) {
      unlink(apply.previous);
      result("applied", apply.version, "");
      return 0;
    }
    if (!title_running(g_title)) {
      roll_back(&apply, "the new version closed before it finished starting");
      return 1;
    }
    sleep_ms(POLL_MS);
  }
  // Still open, never said so: the old image stays as <target>.previous for a manual return.
  result("applied", apply.version, "the new version did not confirm that it started");
  return 0;
}

int main(void) {
  // The app's end of the connection goes away with it.
  signal(SIGPIPE, SIG_IGN);
  char magic[8];
  if (!read_line(STDIN_FILENO, magic, sizeof magic) || strcmp(magic, "UPD1") ||
      !read_line(STDIN_FILENO, g_title, sizeof g_title) || !valid_title(g_title) ||
      !read_line(STDIN_FILENO, g_control, sizeof g_control) || !valid_path(g_control))
    return 1;
#ifdef UPDATER_HOST_TEST
  g_control_for_test = g_control;
#endif
  // One updater waits at a time: the first to listen on the lock port.
  int lock = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)lock_port());
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (lock < 0 || bind(lock, (struct sockaddr*)&address, sizeof address) != 0 || listen(lock, 1) != 0) {
    say("armed\n");
    return 0;
  }
  say("ready\n");
  return update();
}
