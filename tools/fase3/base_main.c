// Fase 3 (prototipo): o payload SEM o nucleo A, com o mesmo main renomeado e o mesmo servidor minimo, so para medir quanto
// o bg_catalog.c soma ao binario (tamanho de a_catalog - bgdl_base).
#define main bgdl_main
#include "../../app/native/bg_downloader.c"
#undef main
#include "fase3_http.h"
static char* handler(const char* path, const char* query, size_t* length) { (void)path; (void)query; (void)length; return NULL; }
int main(int argc, char** argv) { (void)bgdl_main; return argc > 1 ? f3_serve(atoi(argv[1]), handler) : 0; }
