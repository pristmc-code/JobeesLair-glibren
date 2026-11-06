// glibren.12: cria uma imagem .exfat com um jogo na raiz, no formato que o ShadowMount+ monta. Contrato comum aos
// worktrees wt-exfatw / wt-pkgsrc / wt-converter (scratchpad/conv_contrato.md): nao mudar sem combinar.
#ifndef EXFAT_WRITER_H
#define EXFAT_WRITER_H
#include <stddef.h>
#include <stdint.h>

typedef struct exw_entry {
  const char* path;   // relativo a raiz da imagem, separado por '/', sem '/' no inicio nem no fim (ex.: "sce_sys/param.json")
  uint64_t size;      // bytes (0 para pasta)
  int is_dir;         // 1 = pasta (pastas pais que faltarem sao criadas sozinhas)
  void* user;         // livre para quem le (ex.: indice no pkg)
} exw_entry;

// Le `len` bytes da entrada `e` a partir de `offset` para `buf`. Devolve quantos bytes leu (== len, salvo no fim do
// arquivo) ou < 0 em erro. Chamado em ordem crescente de offset por arquivo, um arquivo por vez.
typedef long long (*exw_read_fn)(void* ctx, const exw_entry* e, uint64_t offset, void* buf, size_t len);
// Progresso: bytes de dados ja gravados de `total`. Devolver != 0 cancela (exw_write devolve -2).
typedef int (*exw_progress_fn)(void* ctx, uint64_t done, uint64_t total);

typedef struct exw_plan {
  uint64_t image_bytes;    // tamanho final do arquivo .exfat
  uint64_t data_bytes;     // soma dos arquivos
  uint32_t cluster_bytes;  // tamanho do cluster escolhido
  uint32_t files, dirs;
} exw_plan;

// Calcula o tamanho da imagem (regras do mkexfat do ShadowMount+: cluster, folga, alinhamento). 0 = ok; < 0 erro
// (mensagem em err).
int exw_plan_image(const exw_entry* entries, size_t count, const char* label, exw_plan* out, char* err, size_t errcap);

// Grava a imagem em `image_path` (o chamador usa um nome .part e renomeia depois de conferir). O arquivo e criado
// (ou truncado) e escrito do comeco ao fim. 0 = ok; -1 erro (err); -2 cancelado pelo progresso. Em erro ou cancelamento
// o arquivo parcial fica para o chamador apagar.
int exw_write(const char* image_path, const exw_entry* entries, size_t count, const char* label,
              exw_read_fn read, void* read_ctx, exw_progress_fn progress, void* progress_ctx, char* err, size_t errcap);

// Fonte "pasta": lista recursivamente `root` (arquivos e pastas; links simbolicos recusados) em *out (alocado; liberar
// com exw_free_entries). 0 = ok; < 0 erro.
int exw_list_dir(const char* root, exw_entry** out, size_t* count, char* err, size_t errcap);
void exw_free_entries(exw_entry* entries, size_t count);
// exw_read_fn para a fonte "pasta" (ctx = a string `root` passada a exw_list_dir).
long long exw_read_dir_file(void* ctx, const exw_entry* e, uint64_t offset, void* buf, size_t len);

// Conferencia depois de gravar: abre a imagem, percorre a arvore e compara nomes/tamanhos com `entries` e, se
// `sample` != 0, compara o conteudo de uma amostra (inicio/fim de cada arquivo + alguns blocos) com a fonte; sample
// == 2 compara tudo. 0 = igual; < 0 diferente/erro (err).
int exw_verify(const char* image_path, const exw_entry* entries, size_t count, exw_read_fn read, void* read_ctx,
               int sample, char* err, size_t errcap);
#endif
