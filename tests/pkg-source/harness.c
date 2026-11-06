// Harness de teste do leitor de .pkg (app/native/pkg_source.c), compilado no PC pelo tests/pkg-source.test.mjs:
//   harness list <pkg>             title id, content id, tipo, se e cifrado (AES-XTS) e a arvore (D caminho / F tamanho caminho)
//   harness sha <pkg> [pedaco]     sha256 de cada arquivo lido em fluxo (offset crescente); MB/s no stderr
//   harness rand <pkg> <semente>   leituras em offsets aleatorios comparadas com a leitura em sequencia
//   harness selftest               vetores de SHA3/HMAC/XTS das referencias abertas
// Erro: mensagem no stderr ("ERRO: ...") e saida 2 (abrir) ou 3 (ler).
#define _GNU_SOURCE
#include "../../app/native/pkg_source.c"

#include <time.h>

static double now_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + ts.tv_nsec / 1e9;
}

static void hex(const uint8_t* b, size_t n, char* out) {
  for(size_t i = 0; i < n; i++) sprintf(out + 2 * i, "%02x", b[i]);
}

static pkgsrc* open_or_die(const char* path, const exw_entry** ents, size_t* n) {
  char err[512];
  pkgsrc* p = pkgsrc_open(path, err, sizeof err);
  if(!p) {
    fprintf(stderr, "ERRO: %s\n", err);
    exit(2);
  }
  if(ents && pkgsrc_entries(p, ents, n, err, sizeof err)) {
    fprintf(stderr, "ERRO: %s\n", err);
    pkgsrc_close(p);
    exit(2);
  }
  return p;
}

static int cmd_list(const char* path) {
  char err[512];
  pkgsrc* p = pkgsrc_open(path, err, sizeof err);
  if(!p) {
    fprintf(stderr, "ERRO: %s\n", err);
    return 2;
  }
  printf("TID %s\nCID %s\nKIND %d\nNATIVE %d\n", pkgsrc_title_id(p), pkgsrc_content_id(p), pkgsrc_kind(p), p->native);
  const exw_entry* e;
  size_t n;
  if(pkgsrc_entries(p, &e, &n, err, sizeof err)) {
    fprintf(stderr, "ERRO: %s\n", err);
    pkgsrc_close(p);
    return 2;
  }
  for(size_t i = 0; i < n; i++) {
    if(e[i].is_dir) printf("D %s\n", e[i].path);
    else printf("F %llu %s\n", (unsigned long long)e[i].size, e[i].path);
  }
  pkgsrc_close(p);
  return 0;
}

static int cmd_sha(const char* path, size_t chunk) {
  const exw_entry* e;
  size_t n;
  double t0 = now_s();
  pkgsrc* p = open_or_die(path, &e, &n);
  double t1 = now_s();
  uint8_t* buf = malloc(chunk);
  uint64_t total = 0;
  for(size_t i = 0; i < n; i++) {
    if(e[i].is_dir) continue;
    EVP_MD_CTX* md = EVP_MD_CTX_new();
    EVP_DigestInit_ex(md, EVP_sha256(), NULL);
    uint64_t off = 0;
    while(off < e[i].size) {
      long long r = pkgsrc_read(p, &e[i], off, buf, chunk);
      if(r <= 0) {
        fprintf(stderr, "ERRO: %s: %s\n", e[i].path, p->lasterr[0] ? p->lasterr : "leitura curta");
        return 3;
      }
      EVP_DigestUpdate(md, buf, (size_t)r);
      off += (uint64_t)r;
    }
    if(pkgsrc_read(p, &e[i], off, buf, chunk) != 0) {
      fprintf(stderr, "ERRO: %s: leu depois do fim\n", e[i].path);
      return 3;
    }
    uint8_t d[32];
    unsigned dl;
    EVP_DigestFinal_ex(md, d, &dl);
    EVP_MD_CTX_free(md);
    char h[65];
    hex(d, 32, h);
    printf("%s %llu %s\n", h, (unsigned long long)e[i].size, e[i].path);
    total += e[i].size;
  }
  double t2 = now_s();
  fprintf(stderr, "abrir %.3f s; leitura %.1f MB em %.3f s = %.1f MB/s\n", t1 - t0, total / 1e6, t2 - t1,
          t2 > t1 ? total / 1e6 / (t2 - t1) : 0.0);
  free(buf);
  pkgsrc_close(p);
  return 0;
}

static uint64_t rng_state;
static uint64_t rnd(void) {
  rng_state ^= rng_state >> 12;
  rng_state ^= rng_state << 25;
  rng_state ^= rng_state >> 27;
  return rng_state * 0x2545F4914F6CDD1DULL;
}

static int cmd_rand(const char* path, uint64_t seed) {
  const exw_entry* e;
  size_t n;
  pkgsrc* p = open_or_die(path, &e, &n);
  rng_state = seed * 0x9E3779B97F4A7C15ULL | 1;
  size_t checks = 0;
  for(size_t i = 0; i < n; i++) {
    if(e[i].is_dir || e[i].size == 0 || e[i].size > (64u << 20)) continue;
    size_t sz = (size_t)e[i].size;
    uint8_t* all = malloc(sz);
    uint8_t* part = malloc(sz + 16);
    if(pkgsrc_read(p, &e[i], 0, all, sz) != (long long)sz) {
      fprintf(stderr, "ERRO: %s: %s\n", e[i].path, p->lasterr);
      return 3;
    }
    for(int k = 0; k < 50; k++) {
      uint64_t off = rnd() % sz;
      size_t len = (size_t)(rnd() % (sz - off + 16)) + 1;
      long long want = (long long)(len < sz - off ? len : sz - off);
      long long r = pkgsrc_read(p, &e[i], off, part, len);
      if(r != want || memcmp(part, all + off, (size_t)r)) {
        fprintf(stderr, "ERRO: %s: leitura aleatoria em %llu+%zu diferente\n", e[i].path, (unsigned long long)off, len);
        return 3;
      }
      checks++;
    }
    free(all);
    free(part);
  }
  printf("ok %zu leituras\n", checks);
  pkgsrc_close(p);
  return 0;
}

static int expect_hex(const char* what, const uint8_t* got, size_t n, const char* want) {
  char h[129];
  hex(got, n, h);
  if(strcmp(h, want)) {
    fprintf(stderr, "ERRO: %s: %s (esperado %s)\n", what, h, want);
    return 1;
  }
  return 0;
}

static int cmd_selftest(void) {
  int bad = 0;
  uint8_t ek[32], kd[16], kt[16];
  // crypto.rs key_derivation_matches_real_package (pacote real de DLC)
  pkgsrc_pfs_key("EP7579-PPSA17599_00-EXP33DLC10000PS5", 1, ek);
  bad |= expect_hex("ekpfs", ek, 32, "6f2545336d611af09f15be54263809f1e2f0bc0062335e637463a9e7bee39b73");
  const uint8_t seed[16] = {0x3a, 0xce, 0x52, 0x0f, 0x1d, 0xdb, 0xd3, 0xcb, 0x8a, 0xcb, 0xc4, 0x54, 0x3f, 0x95, 0xfb, 0xa6};
  pkgsrc_xts_keys(ek, seed, kd, kt);
  bad |= expect_hex("tweak", kt, 16, "04c9c2c17ea72b2be706be8ae56c9bff");
  bad |= expect_hex("data", kd, 16, "66cb5805c75c915a157f8ab9ccb80cab");
  // xts.rs full_block_data_and_signed_sectors: cifra com o OpenSSL e decifra com o leitor
  uint8_t key[32];
  for(int i = 0; i < 16; i++) {
    key[i] = (uint8_t)i;
    key[16 + i] = (uint8_t)(16 + i);
  }
  uint8_t* plain = malloc(PKGSRC_BLK);
  uint8_t* enc = malloc(PKGSRC_BLK);
  uint8_t* dec = malloc(PKGSRC_BLK);
  for(uint32_t i = 0; i < PKGSRC_BLK; i++) plain[i] = (uint8_t)(i * 7);
  uint64_t sectors[2] = {5, PKGSRC_SIGNED_SECTOR | 5};
  const char* first[2] = {"7cd15324d71af9c318a1a7cd1cdf33e4", "20e0ed830c5b7fa7536743e0f93b91fb"};
  const char* digs[2] = {"4b08520fde76f492d305b9bf740a294a0ccd64cbbd3e2783aebdd06c9353c483",
                         "e4b131dcb9d6fadb69de4ff7b0737f3f519ec6e57b5119c2a3148b53f2e54d42"};
  pkgsrc fake;
  memset(&fake, 0, sizeof fake);
  fake.xts = EVP_CIPHER_CTX_new();
  EVP_DecryptInit_ex(fake.xts, EVP_aes_128_xts(), NULL, key, NULL);
  for(int s = 0; s < 2; s++) {
    uint8_t iv[16] = {0};
    for(int i = 0; i < 8; i++) iv[i] = (uint8_t)(sectors[s] >> (8 * i));
    EVP_CIPHER_CTX* c = EVP_CIPHER_CTX_new();
    int n = 0;
    EVP_EncryptInit_ex(c, EVP_aes_128_xts(), NULL, key, iv);
    EVP_EncryptUpdate(c, enc, &n, plain, (int)PKGSRC_BLK);
    EVP_CIPHER_CTX_free(c);
    bad |= expect_hex("xts 16", enc, 16, first[s]);
    uint8_t d[32];
    pkgsrc_sha3(enc, PKGSRC_BLK, d);
    bad |= expect_hex("xts sha3", d, 32, digs[s]);
    pkgsrc_xts_decrypt(&fake, sectors[s], enc, dec);
    if(memcmp(dec, plain, PKGSRC_BLK)) {
      fprintf(stderr, "ERRO: xts decifra errado\n");
      bad = 1;
    }
  }
  EVP_CIPHER_CTX_free(fake.xts);
  free(plain);
  free(enc);
  free(dec);
  printf(bad ? "FALHOU\n" : "ok\n");
  return bad;
}

int main(int argc, char** argv) {
  if(argc >= 2 && !strcmp(argv[1], "selftest")) return cmd_selftest();
  if(argc >= 3 && !strcmp(argv[1], "list")) return cmd_list(argv[2]);
  if(argc >= 3 && !strcmp(argv[1], "sha")) return cmd_sha(argv[2], argc >= 4 ? (size_t)strtoull(argv[3], NULL, 10) : (4u << 20));
  if(argc >= 4 && !strcmp(argv[1], "rand")) return cmd_rand(argv[2], strtoull(argv[3], NULL, 10));
  fprintf(stderr, "uso: harness list|sha|rand|selftest <pkg> ...\n");
  return 1;
}
