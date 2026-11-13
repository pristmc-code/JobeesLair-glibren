// Fase 3 (prototipo): um servidor HTTP minimo (127.0.0.1, um pedido por vez, so GET) comum as duas opcoes, para medir
// as duas do mesmo jeito. Nao e o servidor do payload (o bg_downloader.c ja tem o dele); so serve /api/catalog aqui.
#ifndef FASE3_HTTP_H
#define FASE3_HTTP_H
#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

// RSS agora e o pico (VmHWM) do processo, em KiB.
static void f3_rss(long* rss_kb, long* hwm_kb) {
  *rss_kb = *hwm_kb = -1;
  FILE* f = fopen("/proc/self/status", "r");
  if (!f) return;
  char line[256];
  while (fgets(line, sizeof line, f)) {
    if (!strncmp(line, "VmRSS:", 6)) *rss_kb = atol(line + 6);
    if (!strncmp(line, "VmHWM:", 6)) *hwm_kb = atol(line + 6);
  }
  fclose(f);
}
static double f3_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }

// O tratador devolve o corpo (malloc) e o tamanho; NULL = 404. "/quit" encerra.
typedef char* (*F3Handler)(const char* path, const char* query, size_t* length);
static int f3_serve(int port, F3Handler handle) {
  // Como os payloads de teste da .49: sai junto com quem o subiu (nada de servidor orfao segurando a porta).
  prctl(PR_SET_PDEATHSIG, SIGTERM);
  if (getppid() == 1) return 1;
  int s = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons((uint16_t)port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(s, (struct sockaddr*)&a, sizeof a) || listen(s, 16)) { perror("bind"); return 1; }
  printf("LISTEN %d\n", port);
  fflush(stdout);
  for (;;) {
    int c = accept(s, NULL, NULL);
    if (c < 0) continue;
    char req[16384];
    size_t n = 0;
    while (n < sizeof req - 1) {
      ssize_t r = recv(c, req + n, sizeof req - 1 - n, 0);
      if (r <= 0) break;
      n += (size_t)r;
      req[n] = 0;
      if (strstr(req, "\r\n\r\n")) break;
    }
    req[n] = 0;
    char* sp = strchr(req, ' ');
    char* target = sp ? sp + 1 : req;
    char* end = strchr(target, ' ');
    if (end) *end = 0;
    char* query = strchr(target, '?');
    if (query) *query++ = 0;
    const int quit = !strcmp(target, "/quit");
    size_t length = 0;
    const double t0 = f3_ms();
    char* body = quit ? strdup("{\"ok\":true}") : handle(target, query ? query : "", &length);
    if (quit) length = strlen(body);
    const double took = f3_ms() - t0; // so o tratador (o nucleo), sem a rede
    char head[256];
    int h = snprintf(head, sizeof head, "HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nX-Took-Ms: %.3f\r\nConnection: close\r\n\r\n",
                     body ? "200 OK" : "404 Not Found", body ? length : 2, took);
    send(c, head, (size_t)h, 0);
    if (body) { for (size_t off = 0; off < length;) { ssize_t w = send(c, body + off, length - off, 0); if (w <= 0) break; off += (size_t)w; } }
    else send(c, "{}", 2, 0);
    free(body);
    close(c);
    if (quit) break;
  }
  close(s);
  return 0;
}
#endif
