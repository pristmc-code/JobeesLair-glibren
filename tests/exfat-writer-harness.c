// Copyright (C) 2026 JVK3R and Jobee'sLair contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Harness de teste do app/native/exfat_writer.c (tests/exfat-writer.test.mjs). Compila no PC com
//   cc -std=gnu11 -O2 -Wall -Wextra -Werror -I app/native -o harness tests/exfat-writer-harness.c
// e responde uma linha JSON por comando:
//   plan <pasta> [rotulo]                       plano da imagem de uma pasta
//   write <pasta> <imagem> [rotulo] [cancelar]  grava (cancelar = bytes de dados depois dos quais o progresso cancela)
//   verify <pasta> <imagem> <amostra>           confere a imagem contra a pasta (0, 1 ou 2)
//   planlist [rotulo]                           plano de uma lista lida da entrada ("F <tamanho> <caminho>" ou
//                                               "D <caminho>", uma por linha)
//   synth <imagem> [rotulo]                     grava e confere (amostra 2) uma lista da entrada com conteudo gerado
//                                               (sem disco na fonte: bom para milhares de arquivos)
#include "exfat_writer.c"

#include <time.h>

static void json_str(const char* s) {
  putchar('"');
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') printf("\\%c", c);
    else if (c < 0x20) printf("\\u%04x", c);
    else putchar(c);
  }
  putchar('"');
}

static void print_plan(int rc, const exw_plan* p, const char* err) {
  printf("{\"rc\":%d,\"err\":", rc);
  json_str(err);
  printf(",\"image\":%llu,\"data\":%llu,\"cluster\":%u,\"files\":%u,\"dirs\":%u}\n",
         (unsigned long long)p->image_bytes, (unsigned long long)p->data_bytes, p->cluster_bytes, p->files, p->dirs);
}

typedef struct {
  uint64_t cancel_at;
  uint64_t calls, last, total;
  int backwards;
} prog_t;

static int on_progress(void* ctx, uint64_t done, uint64_t total) {
  prog_t* p = ctx;
  p->calls++;
  if (done < p->last) p->backwards = 1;
  p->last = done;
  p->total = total;
  return p->cancel_at && done >= p->cancel_at;
}

static double now_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

// Conteudo gerado: depende do caminho e do offset (sem disco).
static uint8_t synth_byte(uint32_t seed, uint64_t off) {
  uint64_t x = (off + 1) * 0x9E3779B97F4A7C15ull ^ seed;
  x ^= x >> 29;
  return (uint8_t)(x ^ (x >> 17));
}

static long long synth_read(void* ctx, const exw_entry* e, uint64_t offset, void* buf, size_t len) {
  (void)ctx;
  if (offset > e->size) return -1;
  if (len > e->size - offset) len = (size_t)(e->size - offset);
  uint32_t seed = (uint32_t)(uintptr_t)e->user;
  uint8_t* b = buf;
  for (size_t i = 0; i < len; i++) b[i] = synth_byte(seed, offset + i);
  return (long long)len;
}

static int read_list(exw_entry** out, size_t* count) {
  size_t cap = 256, n = 0;
  exw_entry* v = malloc(cap * sizeof *v);
  char line[8192];
  while (fgets(line, sizeof line, stdin)) {
    size_t l = strlen(line);
    while (l && (line[l - 1] == '\n' || line[l - 1] == '\r')) line[--l] = 0;
    if (!l) continue;
    if (n == cap) v = realloc(v, (cap *= 2) * sizeof *v);
    exw_entry* e = &v[n];
    memset(e, 0, sizeof *e);
    if (line[0] == 'D' && line[1] == ' ') {
      e->is_dir = 1;
      e->path = strdup(line + 2);
    } else if (line[0] == 'F' && line[1] == ' ') {
      char* end;
      e->size = strtoull(line + 2, &end, 10);
      e->path = strdup(end + 1);
    } else {
      continue;
    }
    e->user = (void*)(uintptr_t)exw_fnv(0x811C9DC5u, e->path, strlen(e->path));
    n++;
  }
  *out = v;
  *count = n;
  return 0;
}

int main(int argc, char** argv) {
  char err[1024] = "";
  exw_plan plan;
  memset(&plan, 0, sizeof plan);
  if (argc < 2) return 2;
  const char* cmd = argv[1];
  if (strcmp(cmd, "plan") == 0 && argc >= 3) {
    exw_entry* e = NULL;
    size_t n = 0;
    int rc = exw_list_dir(argv[2], &e, &n, err, sizeof err);
    if (rc == 0) rc = exw_plan_image(e, n, argc > 3 ? argv[3] : "", &plan, err, sizeof err);
    print_plan(rc, &plan, err);
    exw_free_entries(e, n);
    return 0;
  }
  if (strcmp(cmd, "write") == 0 && argc >= 4) {
    exw_entry* e = NULL;
    size_t n = 0;
    prog_t p;
    memset(&p, 0, sizeof p);
    if (argc > 5) p.cancel_at = strtoull(argv[5], NULL, 10);
    int rc = exw_list_dir(argv[2], &e, &n, err, sizeof err);
    if (rc == 0) rc = exw_plan_image(e, n, argc > 4 ? argv[4] : "", &plan, err, sizeof err);
    double t0 = now_s(), t1 = t0;
    if (rc == 0) {
      rc = exw_write(argv[3], e, n, argc > 4 ? argv[4] : "", exw_read_dir_file, argv[2], on_progress, &p, err, sizeof err);
      t1 = now_s();
    }
    printf("{\"rc\":%d,\"err\":", rc);
    json_str(err);
    printf(",\"image\":%llu,\"data\":%llu,\"files\":%u,\"dirs\":%u,\"calls\":%llu,\"last\":%llu,\"total\":%llu,"
           "\"backwards\":%d,\"seconds\":%.3f}\n",
           (unsigned long long)plan.image_bytes, (unsigned long long)plan.data_bytes, plan.files, plan.dirs,
           (unsigned long long)p.calls, (unsigned long long)p.last, (unsigned long long)p.total, p.backwards, t1 - t0);
    exw_free_entries(e, n);
    return 0;
  }
  if (strcmp(cmd, "verify") == 0 && argc >= 5) {
    exw_entry* e = NULL;
    size_t n = 0;
    int rc = exw_list_dir(argv[2], &e, &n, err, sizeof err);
    double t0 = now_s();
    if (rc == 0) rc = exw_verify(argv[3], e, n, exw_read_dir_file, argv[2], atoi(argv[4]), err, sizeof err);
    printf("{\"rc\":%d,\"err\":", rc);
    json_str(err);
    printf(",\"seconds\":%.3f}\n", now_s() - t0);
    exw_free_entries(e, n);
    return 0;
  }
  if (strcmp(cmd, "planlist") == 0) {
    exw_entry* e;
    size_t n;
    read_list(&e, &n);
    int rc = exw_plan_image(e, n, argc > 2 ? argv[2] : "", &plan, err, sizeof err);
    print_plan(rc, &plan, err);
    exw_free_entries(e, n);
    return 0;
  }
  if (strcmp(cmd, "synth") == 0 && argc >= 3) {
    exw_entry* e;
    size_t n;
    read_list(&e, &n);
    prog_t p;
    memset(&p, 0, sizeof p);
    int rc = exw_plan_image(e, n, argc > 3 ? argv[3] : "", &plan, err, sizeof err);
    if (rc == 0) rc = exw_write(argv[2], e, n, argc > 3 ? argv[3] : "", synth_read, NULL, on_progress, &p, err, sizeof err);
    int vr = 1;
    if (rc == 0) vr = exw_verify(argv[2], e, n, synth_read, NULL, 2, err, sizeof err);
    printf("{\"rc\":%d,\"verify\":%d,\"err\":", rc, vr);
    json_str(err);
    printf(",\"image\":%llu,\"files\":%u,\"dirs\":%u}\n", (unsigned long long)plan.image_bytes, plan.files, plan.dirs);
    exw_free_entries(e, n);
    return 0;
  }
  fprintf(stderr, "uso: veja o comentario no topo\n");
  return 2;
}
