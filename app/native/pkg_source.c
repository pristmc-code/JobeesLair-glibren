// PROVISORIO (wt-converter): sera substituido pelo de wt-exfatw/wt-pkgsrc
//
// Versao minima da API de pkg_source.h, so para os testes do fluxo de conversao no PC. NAO le .pkg de verdade: um
// pacote real e recusado ("formato nao suportado"); os testes usam um pacote falso em texto:
//   FAKEPKG1\n<title id>\n<content id>\n<kind 1..4>\n<quantidade>\n  e depois, por entrada, "D 0 <caminho>\n" ou
//   "F <tamanho> <caminho>\n" seguido dos bytes.
#include "pkg_source.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct pkgsrc {
  FILE* f;
  char title_id[16], content_id[64];
  int kind;
  exw_entry* entries;
  uint64_t* offsets;
  size_t count;
};

static int pkgsrc_line(FILE* f, char* out, size_t cap) {
  if (!fgets(out, (int)cap, f)) return -1;
  size_t n = strlen(out);
  if (!n || out[n - 1] != '\n') return -1;
  out[n - 1] = 0;
  return 0;
}

pkgsrc* pkgsrc_open(const char* pkg_path, char* err, size_t errcap) {
  FILE* f = fopen(pkg_path, "rb");
  if (!f) { snprintf(err, errcap, "pacote nao abre: %s", strerror(errno)); return NULL; }
  char line[1400];
  if (pkgsrc_line(f, line, sizeof line) || strcmp(line, "FAKEPKG1")) {
    fclose(f);
    snprintf(err, errcap, "formato nao suportado (pkg_source provisorio: so o pacote falso dos testes)");
    return NULL;
  }
  pkgsrc* p = calloc(1, sizeof *p);
  if (!p) { fclose(f); snprintf(err, errcap, "sem memoria"); return NULL; }
  p->f = f;
  int bad = pkgsrc_line(f, p->title_id, sizeof p->title_id) || pkgsrc_line(f, p->content_id, sizeof p->content_id) || pkgsrc_line(f, line, sizeof line);
  p->kind = bad ? 0 : atoi(line);
  bad = bad || pkgsrc_line(f, line, sizeof line);
  p->count = bad ? 0 : (size_t)strtoull(line, NULL, 10);
  if (!bad && p->count < 100000) {
    p->entries = calloc(p->count ? p->count : 1, sizeof *p->entries);
    p->offsets = calloc(p->count ? p->count : 1, sizeof *p->offsets);
    bad = !p->entries || !p->offsets;
  } else {
    bad = 1;
  }
  for (size_t i = 0; !bad && i < p->count; ++i) {
    char type = 0;
    unsigned long long size = 0;
    int used = 0;
    if (pkgsrc_line(f, line, sizeof line) || sscanf(line, "%c %llu %n", &type, &size, &used) < 2 || !used) { bad = 1; break; }
    p->entries[i].path = strdup(line + used);
    p->entries[i].size = size;
    p->entries[i].is_dir = type == 'D';
    p->offsets[i] = (uint64_t)ftello(f);
    if (!p->entries[i].path || (type == 'F' && fseeko(f, (off_t)size, SEEK_CUR))) bad = 1;
  }
  if (bad) {
    snprintf(err, errcap, "pacote falso corrompido");
    pkgsrc_close(p);
    return NULL;
  }
  return p;
}

int pkgsrc_entries(pkgsrc* p, const exw_entry** out, size_t* count, char* err, size_t errcap) {
  (void)err;
  (void)errcap;
  *out = p->entries;
  *count = p->count;
  return 0;
}

long long pkgsrc_read(void* ctx, const exw_entry* e, uint64_t offset, void* buf, size_t len) {
  pkgsrc* p = ctx;
  const size_t index = (size_t)(e - p->entries);
  if (index >= p->count || offset > e->size) return -1;
  if (len > e->size - offset) len = (size_t)(e->size - offset);
  if (fseeko(p->f, (off_t)(p->offsets[index] + offset), SEEK_SET)) return -1;
  return (long long)fread(buf, 1, len, p->f);
}

const char* pkgsrc_title_id(const pkgsrc* p) { return p->title_id; }
const char* pkgsrc_content_id(const pkgsrc* p) { return p->content_id; }
int pkgsrc_kind(const pkgsrc* p) { return p->kind; }

void pkgsrc_close(pkgsrc* p) {
  if (!p) return;
  for (size_t i = 0; p->entries && i < p->count; ++i) free((char*)p->entries[i].path);
  free(p->entries);
  free(p->offsets);
  if (p->f) fclose(p->f);
  free(p);
}
