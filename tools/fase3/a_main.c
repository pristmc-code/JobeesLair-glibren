// Fase 3 (prototipo A): o nucleo em C (app/native/bg_catalog.c) dentro do payload de verdade (bg_downloader.c inteiro,
// sem o main dele), servindo /api/catalog pelo servidor minimo de tools/fase3/fase3_http.h.
// Uso: a_catalog <porta> <index.json> <formats.js> <ratings.js> <firmware-baixo 0|1> <feed>...  (live.jlx, orbit-store.json)
#define main bgdl_main
#include "../../app/native/bg_downloader.c"
#undef main
#include "../../app/native/bg_catalog.c"
#include "fase3_http.h"

static long g_rss0, g_hwm0, g_rss1, g_hwm1;
static char* handler(const char* path, const char* query, size_t* length) {
  Buf out = {0};
  if (!strcmp(path, "/api/catalog")) ct_page(query, &out);
  else if (!strcmp(path, "/api/catalog/options")) ct_options(&out);
  else if (!strcmp(path, "/stats")) {
    long rss, hwm;
    f3_rss(&rss, &hwm);
    buf_fmt(&out, "{\"core\":\"A (C)\",\"buildMs\":%.1f,\"rssStartKb\":%ld,\"rssBuiltKb\":%ld,\"hwmBuiltKb\":%ld,\"rssNowKb\":%ld,\"hwmNowKb\":%ld,\"listed\":%d,\"entries\":%d}",
            g_ct.build_ms, g_rss0, g_rss1, g_hwm1, rss, hwm, g_ct.nlisted, g_ct.count);
  } else return NULL;
  *length = out.size;
  return out.data;
}
int main(int argc, char** argv) {
  if (argc < 7) { fprintf(stderr, "uso: %s porta index formats ratings firmware-baixo feed...\n", argv[0]); return 2; }
  f3_rss(&g_rss0, &g_hwm0);
  CtPaths paths = {argv[2], argv[3], argv[4], {0}, 0, atoi(argv[5])};
  for (int i = 6; i < argc && paths.nfeeds < 8; ++i) paths.feeds[paths.nfeeds++] = argv[i];
  if (!ct_build(&paths)) { fprintf(stderr, "a montagem falhou\n"); return 1; }
  f3_rss(&g_rss1, &g_hwm1);
  printf("BUILT listed=%d entries=%d ms=%.1f rss0=%ld rss=%ld hwm=%ld nfc=%d\n", g_ct.nlisted, g_ct.count, g_ct.build_ms, g_rss0, g_rss1, g_hwm1, g_ct.nfc_risk);
  fflush(stdout);
  (void)bgdl_main;
  return f3_serve(atoi(argv[1]), handler);
}
