// Fase 3 (tests/catalog-text.test.mjs): o texto do catalogo do payload (bg_catalog.c) para conferir com o JS. Le uma linha
// por vez da entrada e escreve [toLowerCase, NFC, NFD, fold da busca] em JSON, uma linha por linha lida.
#define main bgdl_main
#include "../app/native/bg_downloader.c"
#undef main

int main(void) {
  static char line[65536];
  while (fgets(line, sizeof line, stdin)) {
    size_t n = strlen(line);
    if (n && line[n - 1] == '\n') line[--n] = 0;
    char* low = ct_lower_plain(line);
    char* nfc = ct_normalize(line, 1);
    char* nfd = ct_normalize(line, 0);
    char* fold = ct_fold(line);
    Buf b = {0};
    buf_str(&b, "["); buf_json(&b, low); buf_str(&b, ","); buf_json(&b, nfc); buf_str(&b, ","); buf_json(&b, nfd); buf_str(&b, ","); buf_json(&b, fold); buf_str(&b, "]\n");
    fputs(b.data, stdout);
    free(b.data); free(low); free(nfc); free(nfd); ct_free(fold);
  }
  (void)bgdl_main;
  return 0;
}
