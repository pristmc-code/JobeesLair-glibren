// Fase 3 (prototipo): o motor QuickJS-ng sozinho (um runtime que avalia um texto), so para medir o tamanho do motor.
#include <stdio.h>
#include "quickjs.h"
int main(int argc, char** argv) {
  JSRuntime* rt = JS_NewRuntime();
  JSContext* ctx = JS_NewContext(rt);
  JSValue r = JS_Eval(ctx, argc > 1 ? argv[1] : "1", 1, "x", JS_EVAL_TYPE_GLOBAL);
  JS_FreeValue(ctx, r);
  JS_FreeContext(ctx);
  JS_FreeRuntime(rt);
  return 0;
}
