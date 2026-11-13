// Fase 8 (ps5/ESTUDO-jobe-como-payload.md): a JOBE WEB COMPLETA, esqueleto (incluido em bg_downloader.c, depois de
// bg_teste.c). Uma pagina NOVA, em /app, que convive com a pagina do celular ("/", bg_monitor.html) sem substitui-la:
// loja em grade de capas (lista virtual, paginas do /api/store), ficha com "Baixar" (/api/store/add), downloads ao vivo
// (/api/status e /api/jobs/<id>/<acao>), Biblioteca/Homebrew/Configuracoes como "em breve"; layouts de celular em pe e
// deitado, PC e TV (navegador do PS5) e navegacao por controle (Gamepad API) e teclado.
// A pagina (bg_app.html, embutida em bg_app_html.h por tools/bg-monitor/embed.mjs) sai sem sessao, como "/" (nao traz
// dado nenhum); ela so usa as rotas que ja existem, entao a protecao e a mesma da pagina do celular: Host conferido (J6,
// monitor_host_ok, para TODO pedido desta porta) e a sessao do PIN nas acoes (X-Session).
// Pareamento por aparelho (outra branch): o ponto de integracao e o objeto Auth da pagina (bg_app.html); aqui nada muda
// enquanto as rotas forem as de sempre.
//
//   GET  /app, /app/, /app/index.html   a pagina (text/html; a CSP de monitor_send: scripts e estilos so inline,
//                                       dados so deste payload, imagens data: e https:)
#include "bg_app_html.h"

// Pagina do celular. 1 = tratou.
static int app_monitor_route(int fd, Request* r) {
  if (strcmp(r->path, "/app") && strcmp(r->path, "/app/") && strcmp(r->path, "/app/index.html")) return 0;
  if (strcmp(r->method, "GET")) { monitor_json(fd, 404, "{\"error\":\"not found\"}"); return 1; }
  monitor_send(fd, 200, "text/html; charset=utf-8", BG_APP_HTML, BG_APP_HTML_SIZE);
  return 1;
}
