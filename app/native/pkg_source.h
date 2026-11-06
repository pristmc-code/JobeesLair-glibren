// glibren.12: le os arquivos de um jogo de dentro de um .pkg (FPKG de PS5) para gravar direto num .exfat, sem extrair
// para o disco antes. Contrato comum (scratchpad/conv_contrato.md): nao mudar sem combinar.
#ifndef PKG_SOURCE_H
#define PKG_SOURCE_H
#include "exfat_writer.h"

typedef struct pkgsrc pkgsrc;

enum { PKGSRC_GAME = 1, PKGSRC_PATCH = 2, PKGSRC_DLC = 3, PKGSRC_OTHER = 4 };

// Abre e confere o pacote (cabecalho, PFS de fora e de dentro). NULL em erro (mensagem em err): pacote cifrado de
// verdade (retail), corrompido ou formato nao suportado.
pkgsrc* pkgsrc_open(const char* pkg_path, char* err, size_t errcap);
// Os arquivos e pastas do jogo como ficam instalados (eboot.bin, sce_sys/param.json, ...), em *out (o pkgsrc e dono;
// valido ate pkgsrc_close). 0 = ok.
int pkgsrc_entries(pkgsrc* p, const exw_entry** out, size_t* count, char* err, size_t errcap);
// exw_read_fn: ctx = o pkgsrc*. Descomprime (PFSC) em fluxo quando for o caso.
long long pkgsrc_read(void* ctx, const exw_entry* e, uint64_t offset, void* buf, size_t len);
const char* pkgsrc_title_id(const pkgsrc* p);   // ex.: "PPSA01234" (vazio se nao achou)
const char* pkgsrc_content_id(const pkgsrc* p); // ex.: "UP0000-PPSA01234_00-..." (vazio se nao achou)
int pkgsrc_kind(const pkgsrc* p);               // PKGSRC_*
void pkgsrc_close(pkgsrc* p);
#endif
