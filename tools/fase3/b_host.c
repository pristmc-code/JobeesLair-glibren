// Fase 3 (prototipo B): o host em C do nucleo QuickJS sem tela (como o tube-service: QuickJS-ng, sem os modulos std/os).
// Da ao JS (globalThis.__host) o FileSystem (ler com deslocamento, gravar/anexar, stat, mkdir, rename, remover), o
// relogio, o log e a memoria; avalia o bundle (tools/fase3/b-entry.js com o state/ do app) e serve /api/catalog chamando
// globalThis.__catalogRequest. Motor: QuickJS-ng 0.15.0 (o do ps5-react), das fontes de /root/forks/qjs-peak (com o
// contador de pico js_peak_size).
// Uso: b_catalog <porta> <bundle.js> <pasta app/> <raiz de /data> [limite do heap em MiB]
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include "quickjs.h"
#include "fase3_http.h"

extern size_t js_peak_size;
static char g_app[1024], g_data[1024];
static JSRuntime* g_rt;
static JSContext* g_ctx;
static JSValue g_request;
static double g_build_ms, g_eval_ms;
static long g_rss0, g_hwm0, g_rss1, g_hwm1;
static size_t g_heap_built, g_limit;

static void real_path(const char* path, char* out, size_t cap) {
  if (!strncmp(path, "/app0/", 6)) snprintf(out, cap, "%s/%s", g_app, path + 6);
  else snprintf(out, cap, "%s%s", g_data, path);
}
static void mkdir_p(const char* dir) {
  char tmp[2048];
  snprintf(tmp, sizeof tmp, "%s", dir);
  for (char* p = tmp + 1; *p; ++p) if (*p == '/') { *p = 0; mkdir(tmp, 0755); *p = '/'; }
  mkdir(tmp, 0755);
}
static JSValue h_read(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv) {
  (void)self;
  const char* path = JS_ToCString(ctx, argv[0]);
  if (!path) return JS_EXCEPTION;
  char file[2048];
  real_path(path, file, sizeof file);
  JS_FreeCString(ctx, path);
  FILE* f = fopen(file, "rb");
  if (!f) return JS_NULL;
  int64_t offset = 0, length = -1;
  if (argc >= 3 && !JS_IsUndefined(argv[1])) { JS_ToInt64(ctx, &offset, argv[1]); JS_ToInt64(ctx, &length, argv[2]); }
  if (length < 0) { fseek(f, 0, SEEK_END); length = ftell(f) - offset; }
  fseek(f, (long)offset, SEEK_SET);
  char* data = malloc((size_t)length + 1);
  size_t got = data ? fread(data, 1, (size_t)length, f) : 0;
  fclose(f);
  if (!data) return JS_ThrowOutOfMemory(ctx);
  JSValue text = JS_NewStringLen(ctx, data, got);
  free(data);
  return text;
}
static JSValue h_write(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv) {
  (void)self; (void)argc;
  const char* path = JS_ToCString(ctx, argv[0]);
  size_t n;
  const char* text = JS_ToCStringLen(ctx, &n, argv[1]);
  const int append = JS_ToBool(ctx, argv[2]);
  char file[2048];
  real_path(path, file, sizeof file);
  char dir[2048];
  snprintf(dir, sizeof dir, "%s", file);
  char* slash = strrchr(dir, '/');
  if (slash) { *slash = 0; mkdir_p(dir); }
  FILE* f = fopen(file, append ? "ab" : "wb");
  int ok = f && fwrite(text, 1, n, f) == n;
  if (f) fclose(f);
  JS_FreeCString(ctx, path);
  JS_FreeCString(ctx, text);
  return JS_NewBool(ctx, ok);
}
static JSValue h_stat(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv) {
  (void)self; (void)argc;
  const char* path = JS_ToCString(ctx, argv[0]);
  char file[2048];
  real_path(path, file, sizeof file);
  JS_FreeCString(ctx, path);
  struct stat st;
  if (stat(file, &st)) return JS_NULL;
  JSValue o = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, o, "size", JS_NewInt64(ctx, st.st_size));
  JS_SetPropertyStr(ctx, o, "modified", JS_NewFloat64(ctx, st.st_mtim.tv_sec * 1e3 + st.st_mtim.tv_nsec / 1e6));
  JS_SetPropertyStr(ctx, o, "dir", JS_NewBool(ctx, S_ISDIR(st.st_mode)));
  return o;
}
static JSValue h_path_op(JSContext* ctx, int argc, JSValueConst* argv, int op) {
  const char* a = JS_ToCString(ctx, argv[0]);
  char fa[2048], fb[2048];
  real_path(a, fa, sizeof fa);
  JS_FreeCString(ctx, a);
  int ok = 0;
  if (op == 0) { mkdir_p(fa); ok = 1; }
  else if (op == 1) ok = !remove(fa);
  else if (argc > 1) {
    const char* b = JS_ToCString(ctx, argv[1]);
    real_path(b, fb, sizeof fb);
    JS_FreeCString(ctx, b);
    ok = !rename(fa, fb);
  }
  return JS_NewBool(ctx, ok);
}
static JSValue h_mkdir(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv) { (void)self; return h_path_op(ctx, argc, argv, 0); }
static JSValue h_remove(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv) { (void)self; return h_path_op(ctx, argc, argv, 1); }
static JSValue h_rename(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv) { (void)self; return h_path_op(ctx, argc, argv, 2); }
static JSValue h_log(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv) {
  (void)self; (void)argc;
  const char* text = JS_ToCString(ctx, argv[0]);
  if (text) fprintf(stderr, "[core] %s\n", text);
  JS_FreeCString(ctx, text);
  return JS_UNDEFINED;
}
static JSValue h_now(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv) { (void)self; (void)argc; (void)argv; return JS_NewFloat64(ctx, f3_ms()); }
static JSValue h_mem(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv) {
  (void)self; (void)argc; (void)argv;
  JSMemoryUsage m;
  JS_ComputeMemoryUsage(g_rt, &m);
  JSValue a = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, a, 0, JS_NewInt64(ctx, m.malloc_size));
  JS_SetPropertyUint32(ctx, a, 1, JS_NewInt64(ctx, (int64_t)js_peak_size));
  JS_SetPropertyUint32(ctx, a, 2, JS_NewInt64(ctx, (int64_t)g_limit));
  return a;
}
static void report(JSContext* ctx) {
  JSValue e = JS_GetException(ctx);
  const char* text = JS_ToCString(ctx, e);
  JSValue stack = JS_GetPropertyStr(ctx, e, "stack");
  const char* trace = JS_ToCString(ctx, stack);
  fprintf(stderr, "JS: %s\n%s\n", text ? text : "?", trace ? trace : "");
  JS_FreeCString(ctx, text); JS_FreeCString(ctx, trace);
  JS_FreeValue(ctx, stack); JS_FreeValue(ctx, e);
}
static size_t heap_now(void) { JSMemoryUsage m; JS_ComputeMemoryUsage(g_rt, &m); return (size_t)m.malloc_size; }

static char* handler(const char* path, const char* query, size_t* length) {
  if (!strcmp(path, "/stats")) {
    long rss, hwm;
    f3_rss(&rss, &hwm);
    char* out = malloc(512);
    *length = (size_t)snprintf(out, 512, "{\"core\":\"B (QuickJS)\",\"buildMs\":%.1f,\"evalMs\":%.1f,\"rssStartKb\":%ld,\"rssBuiltKb\":%ld,\"hwmBuiltKb\":%ld,"
                               "\"rssNowKb\":%ld,\"hwmNowKb\":%ld,\"heapBuiltKb\":%zu,\"heapNowKb\":%zu,\"heapPeakKb\":%zu}",
                               g_build_ms, g_eval_ms, g_rss0, g_rss1, g_hwm1, rss, hwm, g_heap_built / 1024, heap_now() / 1024, js_peak_size / 1024);
    return out;
  }
  JSValue argv[2] = {JS_NewString(g_ctx, path), JS_NewString(g_ctx, query)};
  JSValue r = JS_Call(g_ctx, g_request, JS_UNDEFINED, 2, argv);
  JS_FreeValue(g_ctx, argv[0]);
  JS_FreeValue(g_ctx, argv[1]);
  char* out = NULL;
  if (JS_IsException(r)) report(g_ctx);
  else if (JS_IsString(r)) {
    size_t n;
    const char* text = JS_ToCStringLen(g_ctx, &n, r);
    out = malloc(n + 1);
    memcpy(out, text, n + 1);
    *length = n;
    JS_FreeCString(g_ctx, text);
  }
  JS_FreeValue(g_ctx, r);
  return out;
}

int main(int argc, char** argv) {
  if (argc < 5) { fprintf(stderr, "uso: %s porta bundle.js app/ raiz-data [heap-MiB]\n", argv[0]); return 2; }
  f3_rss(&g_rss0, &g_hwm0);
  snprintf(g_app, sizeof g_app, "%s", argv[3]);
  snprintf(g_data, sizeof g_data, "%s", argv[4]);
  g_limit = (size_t)(argc > 5 ? atoi(argv[5]) : 256) << 20;
  const double started = f3_ms();
  FILE* f = fopen(argv[2], "rb");
  if (!f) { perror(argv[2]); return 1; }
  fseek(f, 0, SEEK_END);
  long size = ftell(f);
  fseek(f, 0, SEEK_SET);
  char* source = malloc((size_t)size + 1);
  if (fread(source, 1, (size_t)size, f) != (size_t)size) return 1;
  source[size] = 0;
  fclose(f);
  g_rt = JS_NewRuntime();
  JS_SetMemoryLimit(g_rt, g_limit);
  JS_SetMaxStackSize(g_rt, 4u << 20);
  g_ctx = JS_NewContext(g_rt);
  JSValue global = JS_GetGlobalObject(g_ctx), host = JS_NewObject(g_ctx);
  JS_SetPropertyStr(g_ctx, host, "readFile", JS_NewCFunction(g_ctx, h_read, "readFile", 3));
  JS_SetPropertyStr(g_ctx, host, "writeFile", JS_NewCFunction(g_ctx, h_write, "writeFile", 3));
  JS_SetPropertyStr(g_ctx, host, "stat", JS_NewCFunction(g_ctx, h_stat, "stat", 1));
  JS_SetPropertyStr(g_ctx, host, "mkdir", JS_NewCFunction(g_ctx, h_mkdir, "mkdir", 1));
  JS_SetPropertyStr(g_ctx, host, "remove", JS_NewCFunction(g_ctx, h_remove, "remove", 1));
  JS_SetPropertyStr(g_ctx, host, "rename", JS_NewCFunction(g_ctx, h_rename, "rename", 2));
  JS_SetPropertyStr(g_ctx, host, "log", JS_NewCFunction(g_ctx, h_log, "log", 1));
  JS_SetPropertyStr(g_ctx, host, "now", JS_NewCFunction(g_ctx, h_now, "now", 0));
  JS_SetPropertyStr(g_ctx, host, "mem", JS_NewCFunction(g_ctx, h_mem, "mem", 0));
  JS_SetPropertyStr(g_ctx, global, "__host", host);
  const double eval0 = f3_ms();
  JSValue r = JS_Eval(g_ctx, source, (size_t)size, "b.bundle.js", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(r)) { report(g_ctx); return 1; }
  JS_FreeValue(g_ctx, r);
  for (JSContext* job; JS_ExecutePendingJob(g_rt, &job) > 0;) {}
  free(source);
  g_request = JS_GetPropertyStr(g_ctx, global, "__catalogRequest");
  JS_FreeValue(g_ctx, global);
  if (!JS_IsFunction(g_ctx, g_request)) { fprintf(stderr, "o bundle nao e o nucleo\n"); return 1; }
  g_eval_ms = f3_ms() - eval0;
  g_build_ms = f3_ms() - started;
  g_heap_built = heap_now();
  f3_rss(&g_rss1, &g_hwm1);
  printf("BUILT ms=%.1f eval=%.1f rss0=%ld rss=%ld hwm=%ld heap=%zuK peak=%zuK\n", g_build_ms, g_eval_ms, g_rss0, g_rss1, g_hwm1, g_heap_built / 1024, js_peak_size / 1024);
  fflush(stdout);
  return f3_serve(atoi(argv[1]), handler);
}
