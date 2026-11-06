// Copyright (C) 2026 JVK3R and Jobee'sLair contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// exfat_writer.c (glibren.12): cria uma imagem .exfat com o jogo na raiz, no formato que o ShadowMount+ monta.
// Contrato em exfat_writer.h. Entra no bg_downloader.c por "unity build" (#include "exfat_writer.c"): tudo aqui e
// `static` ou tem o prefixo exw_.
//
// Regras do ShadowMount+ (drakmor/ShadowMountPlus 1.7: mkexfat.sh, README e include/sm_mount_defs.h):
// - setor de 512 bytes e cluster FIXO de 64 KiB: o caminho rapido LVD/BFS ("sdimg", tipo 5) so junta pedidos de
//   exatamente 64 KiB alinhados a 64 KiB no arquivo da imagem; cluster menor perde desempenho;
// - o jogo fica na RAIZ da imagem (sce_sys/param.json direto na raiz, sem pasta a mais);
// - tamanho da imagem (mkexfat.sh): dados arredondados ao cluster + FAT (4 B por cluster) + bitmap (1 bit por
//   cluster) + 256 B por arquivo/pasta (pastas contam a raiz, como `find -type d`) + 32 MiB fixos; + folga de 0,5%
//   limitada a 64..512 MiB; nunca menos que (bytes dos arquivos + 64 MiB); arredondado para cima a 1 MiB.
//   A folga fica livre (image_rw= pode gravar nela).
//
// Layout, portado do ps5-dump-forge (quer3q, GPL-3, crates/ps5-dump-forge-exfat/src/lib.rs, que porta o
// exfat_writer.py do MkPFS): tudo e calculado antes do primeiro byte, e a imagem sai do comeco ao fim, sem voltar:
//   setores 0..11    regiao de boot principal (boot sector, 8 setores estendidos, OEM, reservado, checksum)
//   setores 12..23   copia da regiao de boot
//   setor 128..      FAT (comeca em 64 KiB e ocupa clusters inteiros: o heap fica alinhado a 64 KiB no arquivo)
//   cluster 2..      bitmap de alocacao, tabela up-case, raiz e a arvore em pre-ordem (a pasta, depois o que ha nela)
//   fim              clusters livres (a folga): o arquivo e estendido com ftruncate (esparso onde o disco deixa)
// Cada arquivo e cada pasta e UMA faixa contigua (NoFatChain) e a FAT tambem tem a cadeia explicita (um driver que
// ignore a flag le os mesmos bytes). Bitmap, up-case e raiz nao tem a flag e usam a cadeia.
//
// Spec exFAT (Microsoft): checksum da regiao de boot, SetChecksum, NameHash pela tabela up-case do volume, tabela
// up-case recomendada (comprimida: 5836 bytes, checksum 0xE619D30D, a mesma do mkfs.exfat e do Windows).
//
// Nomes: UTF-8 valido -> UTF-16, 1..255 unidades; sem controles (< 0x20), sem " * / : < > ? \ |, sem U+FFFD, sem
// "." e "..". Dois nomes iguais sem diferenciar maiusculas (pela tabela up-case) na mesma pasta sao recusados.
// Limitacao: nao confere a normalizacao Unicode (NFC); o nome vai como veio. Profundidade: sem limite no escritor;
// exw_list_dir desce ate EXW_LIST_DEPTH niveis.
//
// exw_verify le a imagem com um leitor proprio (adaptado do fmt_exfat.c do glibren-payload), sem usar o layout do
// escritor: confere a regiao de boot (as duas copias), le a tabela up-case do proprio volume (e usa ela no NameHash),
// SetChecksum, a faixa/cadeia de cada arquivo contra o bitmap (sem cluster repetido nem marcado sem dono) e compara
// a arvore e o conteudo com a fonte.
#if !defined(__PROSPERO__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif
#include "exfat_writer.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define EXW_SECTOR 512ull
#define EXW_SECTOR_SHIFT 9
#define EXW_SPC_SHIFT 7                    // 2^7 setores de 512 = cluster de 64 KiB
#define EXW_SPC 128ull
#define EXW_CLUSTER 65536ull
#define EXW_FAT_OFFSET 128ull              // setores: a FAT comeca em 64 KiB
#define EXW_BOOT_BYTES (12 * 512)
#define EXW_MAX_CLUSTERS 0xFFFFFFF5ull     // spec: ClusterCount <= 2^32 - 11
#define EXW_MAX_DIR (256ull << 20)         // spec: uma pasta tem no maximo 256 MiB
#define EXW_MAX_FILE (1ull << 46)          // 64 TiB: so para as contas nunca estourarem
#define EXW_MAX_NAME 255
#define EXW_IO_BUF ((size_t)4 << 20)       // buffer de escrita (e de leitura da fonte)
#define EXW_CMP_BUF ((size_t)1 << 20)      // bloco da conferencia
#define EXW_EOC 0xFFFFFFFFu
#define EXW_NONE 0xFFFFFFFFu
#define EXW_MIB (1ull << 20)
#define EXW_UPCASE_BYTES 5836
#define EXW_LIST_DEPTH 64
#define EXW_PATH_CAP 4096
#define EXW_SYNC_EVERY (256ull << 20)     // fsync a cada 256 MiB gravados

// Fora do console, depois de gravar (com fsync) ou ler um trecho grande, avisa o kernel que essas paginas nao voltam
// a ser usadas: um jogo de 100 GB nao enche o cache de disco (no WSL2 o cache cheio derruba a VM inteira). No PS5 o
// posix_fadvise existe na libc do SDK, mas nunca foi testado no console: fica so o fsync periodico.
#if !defined(__PROSPERO__) && defined(POSIX_FADV_DONTNEED)
#define EXW_DONTNEED(fd, off, len) ((void)posix_fadvise((fd), (off_t)(off), (off_t)(len), POSIX_FADV_DONTNEED))
#else
#define EXW_DONTNEED(fd, off, len) ((void)(fd), (void)(off), (void)(len))
#endif

// Tabela up-case recomendada pela spec (secao 7.2.5.1), comprimida: 0xFFFF, n = n caracteres que nao mudam.
// Gerada do upcase_table.rs do ps5-dump-forge (que vem do _exfat_upcase.py do MkPFS); conferida pelo checksum.
static const uint16_t exw_upcase_packed[2918] = {
  0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008, 0x0009, 0x000A, 0x000B,
  0x000C, 0x000D, 0x000E, 0x000F, 0x0010, 0x0011, 0x0012, 0x0013, 0x0014, 0x0015, 0x0016, 0x0017,
  0x0018, 0x0019, 0x001A, 0x001B, 0x001C, 0x001D, 0x001E, 0x001F, 0x0020, 0x0021, 0x0022, 0x0023,
  0x0024, 0x0025, 0x0026, 0x0027, 0x0028, 0x0029, 0x002A, 0x002B, 0x002C, 0x002D, 0x002E, 0x002F,
  0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037, 0x0038, 0x0039, 0x003A, 0x003B,
  0x003C, 0x003D, 0x003E, 0x003F, 0x0040, 0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0047,
  0x0048, 0x0049, 0x004A, 0x004B, 0x004C, 0x004D, 0x004E, 0x004F, 0x0050, 0x0051, 0x0052, 0x0053,
  0x0054, 0x0055, 0x0056, 0x0057, 0x0058, 0x0059, 0x005A, 0x005B, 0x005C, 0x005D, 0x005E, 0x005F,
  0x0060, 0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0047, 0x0048, 0x0049, 0x004A, 0x004B,
  0x004C, 0x004D, 0x004E, 0x004F, 0x0050, 0x0051, 0x0052, 0x0053, 0x0054, 0x0055, 0x0056, 0x0057,
  0x0058, 0x0059, 0x005A, 0x007B, 0x007C, 0x007D, 0x007E, 0x007F, 0x0080, 0x0081, 0x0082, 0x0083,
  0x0084, 0x0085, 0x0086, 0x0087, 0x0088, 0x0089, 0x008A, 0x008B, 0x008C, 0x008D, 0x008E, 0x008F,
  0x0090, 0x0091, 0x0092, 0x0093, 0x0094, 0x0095, 0x0096, 0x0097, 0x0098, 0x0099, 0x009A, 0x009B,
  0x009C, 0x009D, 0x009E, 0x009F, 0x00A0, 0x00A1, 0x00A2, 0x00A3, 0x00A4, 0x00A5, 0x00A6, 0x00A7,
  0x00A8, 0x00A9, 0x00AA, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x00AF, 0x00B0, 0x00B1, 0x00B2, 0x00B3,
  0x00B4, 0x00B5, 0x00B6, 0x00B7, 0x00B8, 0x00B9, 0x00BA, 0x00BB, 0x00BC, 0x00BD, 0x00BE, 0x00BF,
  0x00C0, 0x00C1, 0x00C2, 0x00C3, 0x00C4, 0x00C5, 0x00C6, 0x00C7, 0x00C8, 0x00C9, 0x00CA, 0x00CB,
  0x00CC, 0x00CD, 0x00CE, 0x00CF, 0x00D0, 0x00D1, 0x00D2, 0x00D3, 0x00D4, 0x00D5, 0x00D6, 0x00D7,
  0x00D8, 0x00D9, 0x00DA, 0x00DB, 0x00DC, 0x00DD, 0x00DE, 0x00DF, 0x00C0, 0x00C1, 0x00C2, 0x00C3,
  0x00C4, 0x00C5, 0x00C6, 0x00C7, 0x00C8, 0x00C9, 0x00CA, 0x00CB, 0x00CC, 0x00CD, 0x00CE, 0x00CF,
  0x00D0, 0x00D1, 0x00D2, 0x00D3, 0x00D4, 0x00D5, 0x00D6, 0x00F7, 0x00D8, 0x00D9, 0x00DA, 0x00DB,
  0x00DC, 0x00DD, 0x00DE, 0x0178, 0x0100, 0x0100, 0x0102, 0x0102, 0x0104, 0x0104, 0x0106, 0x0106,
  0x0108, 0x0108, 0x010A, 0x010A, 0x010C, 0x010C, 0x010E, 0x010E, 0x0110, 0x0110, 0x0112, 0x0112,
  0x0114, 0x0114, 0x0116, 0x0116, 0x0118, 0x0118, 0x011A, 0x011A, 0x011C, 0x011C, 0x011E, 0x011E,
  0x0120, 0x0120, 0x0122, 0x0122, 0x0124, 0x0124, 0x0126, 0x0126, 0x0128, 0x0128, 0x012A, 0x012A,
  0x012C, 0x012C, 0x012E, 0x012E, 0x0130, 0x0131, 0x0132, 0x0132, 0x0134, 0x0134, 0x0136, 0x0136,
  0x0138, 0x0139, 0x0139, 0x013B, 0x013B, 0x013D, 0x013D, 0x013F, 0x013F, 0x0141, 0x0141, 0x0143,
  0x0143, 0x0145, 0x0145, 0x0147, 0x0147, 0x0149, 0x014A, 0x014A, 0x014C, 0x014C, 0x014E, 0x014E,
  0x0150, 0x0150, 0x0152, 0x0152, 0x0154, 0x0154, 0x0156, 0x0156, 0x0158, 0x0158, 0x015A, 0x015A,
  0x015C, 0x015C, 0x015E, 0x015E, 0x0160, 0x0160, 0x0162, 0x0162, 0x0164, 0x0164, 0x0166, 0x0166,
  0x0168, 0x0168, 0x016A, 0x016A, 0x016C, 0x016C, 0x016E, 0x016E, 0x0170, 0x0170, 0x0172, 0x0172,
  0x0174, 0x0174, 0x0176, 0x0176, 0x0178, 0x0179, 0x0179, 0x017B, 0x017B, 0x017D, 0x017D, 0x017F,
  0x0243, 0x0181, 0x0182, 0x0182, 0x0184, 0x0184, 0x0186, 0x0187, 0x0187, 0x0189, 0x018A, 0x018B,
  0x018B, 0x018D, 0x018E, 0x018F, 0x0190, 0x0191, 0x0191, 0x0193, 0x0194, 0x01F6, 0x0196, 0x0197,
  0x0198, 0x0198, 0x023D, 0x019B, 0x019C, 0x019D, 0x0220, 0x019F, 0x01A0, 0x01A0, 0x01A2, 0x01A2,
  0x01A4, 0x01A4, 0x01A6, 0x01A7, 0x01A7, 0x01A9, 0x01AA, 0x01AB, 0x01AC, 0x01AC, 0x01AE, 0x01AF,
  0x01AF, 0x01B1, 0x01B2, 0x01B3, 0x01B3, 0x01B5, 0x01B5, 0x01B7, 0x01B8, 0x01B8, 0x01BA, 0x01BB,
  0x01BC, 0x01BC, 0x01BE, 0x01F7, 0x01C0, 0x01C1, 0x01C2, 0x01C3, 0x01C4, 0x01C5, 0x01C4, 0x01C7,
  0x01C8, 0x01C7, 0x01CA, 0x01CB, 0x01CA, 0x01CD, 0x01CD, 0x01CF, 0x01CF, 0x01D1, 0x01D1, 0x01D3,
  0x01D3, 0x01D5, 0x01D5, 0x01D7, 0x01D7, 0x01D9, 0x01D9, 0x01DB, 0x01DB, 0x018E, 0x01DE, 0x01DE,
  0x01E0, 0x01E0, 0x01E2, 0x01E2, 0x01E4, 0x01E4, 0x01E6, 0x01E6, 0x01E8, 0x01E8, 0x01EA, 0x01EA,
  0x01EC, 0x01EC, 0x01EE, 0x01EE, 0x01F0, 0x01F1, 0x01F2, 0x01F1, 0x01F4, 0x01F4, 0x01F6, 0x01F7,
  0x01F8, 0x01F8, 0x01FA, 0x01FA, 0x01FC, 0x01FC, 0x01FE, 0x01FE, 0x0200, 0x0200, 0x0202, 0x0202,
  0x0204, 0x0204, 0x0206, 0x0206, 0x0208, 0x0208, 0x020A, 0x020A, 0x020C, 0x020C, 0x020E, 0x020E,
  0x0210, 0x0210, 0x0212, 0x0212, 0x0214, 0x0214, 0x0216, 0x0216, 0x0218, 0x0218, 0x021A, 0x021A,
  0x021C, 0x021C, 0x021E, 0x021E, 0x0220, 0x0221, 0x0222, 0x0222, 0x0224, 0x0224, 0x0226, 0x0226,
  0x0228, 0x0228, 0x022A, 0x022A, 0x022C, 0x022C, 0x022E, 0x022E, 0x0230, 0x0230, 0x0232, 0x0232,
  0x0234, 0x0235, 0x0236, 0x0237, 0x0238, 0x0239, 0x2C65, 0x023B, 0x023B, 0x023D, 0x2C66, 0x023F,
  0x0240, 0x0241, 0x0241, 0x0243, 0x0244, 0x0245, 0x0246, 0x0246, 0x0248, 0x0248, 0x024A, 0x024A,
  0x024C, 0x024C, 0x024E, 0x024E, 0x0250, 0x0251, 0x0252, 0x0181, 0x0186, 0x0255, 0x0189, 0x018A,
  0x0258, 0x018F, 0x025A, 0x0190, 0x025C, 0x025D, 0x025E, 0x025F, 0x0193, 0x0261, 0x0262, 0x0194,
  0x0264, 0x0265, 0x0266, 0x0267, 0x0197, 0x0196, 0x026A, 0x2C62, 0x026C, 0x026D, 0x026E, 0x019C,
  0x0270, 0x0271, 0x019D, 0x0273, 0x0274, 0x019F, 0x0276, 0x0277, 0x0278, 0x0279, 0x027A, 0x027B,
  0x027C, 0x2C64, 0x027E, 0x027F, 0x01A6, 0x0281, 0x0282, 0x01A9, 0x0284, 0x0285, 0x0286, 0x0287,
  0x01AE, 0x0244, 0x01B1, 0x01B2, 0x0245, 0x028D, 0x028E, 0x028F, 0x0290, 0x0291, 0x01B7, 0x0293,
  0x0294, 0x0295, 0x0296, 0x0297, 0x0298, 0x0299, 0x029A, 0x029B, 0x029C, 0x029D, 0x029E, 0x029F,
  0x02A0, 0x02A1, 0x02A2, 0x02A3, 0x02A4, 0x02A5, 0x02A6, 0x02A7, 0x02A8, 0x02A9, 0x02AA, 0x02AB,
  0x02AC, 0x02AD, 0x02AE, 0x02AF, 0x02B0, 0x02B1, 0x02B2, 0x02B3, 0x02B4, 0x02B5, 0x02B6, 0x02B7,
  0x02B8, 0x02B9, 0x02BA, 0x02BB, 0x02BC, 0x02BD, 0x02BE, 0x02BF, 0x02C0, 0x02C1, 0x02C2, 0x02C3,
  0x02C4, 0x02C5, 0x02C6, 0x02C7, 0x02C8, 0x02C9, 0x02CA, 0x02CB, 0x02CC, 0x02CD, 0x02CE, 0x02CF,
  0x02D0, 0x02D1, 0x02D2, 0x02D3, 0x02D4, 0x02D5, 0x02D6, 0x02D7, 0x02D8, 0x02D9, 0x02DA, 0x02DB,
  0x02DC, 0x02DD, 0x02DE, 0x02DF, 0x02E0, 0x02E1, 0x02E2, 0x02E3, 0x02E4, 0x02E5, 0x02E6, 0x02E7,
  0x02E8, 0x02E9, 0x02EA, 0x02EB, 0x02EC, 0x02ED, 0x02EE, 0x02EF, 0x02F0, 0x02F1, 0x02F2, 0x02F3,
  0x02F4, 0x02F5, 0x02F6, 0x02F7, 0x02F8, 0x02F9, 0x02FA, 0x02FB, 0x02FC, 0x02FD, 0x02FE, 0x02FF,
  0x0300, 0x0301, 0x0302, 0x0303, 0x0304, 0x0305, 0x0306, 0x0307, 0x0308, 0x0309, 0x030A, 0x030B,
  0x030C, 0x030D, 0x030E, 0x030F, 0x0310, 0x0311, 0x0312, 0x0313, 0x0314, 0x0315, 0x0316, 0x0317,
  0x0318, 0x0319, 0x031A, 0x031B, 0x031C, 0x031D, 0x031E, 0x031F, 0x0320, 0x0321, 0x0322, 0x0323,
  0x0324, 0x0325, 0x0326, 0x0327, 0x0328, 0x0329, 0x032A, 0x032B, 0x032C, 0x032D, 0x032E, 0x032F,
  0x0330, 0x0331, 0x0332, 0x0333, 0x0334, 0x0335, 0x0336, 0x0337, 0x0338, 0x0339, 0x033A, 0x033B,
  0x033C, 0x033D, 0x033E, 0x033F, 0x0340, 0x0341, 0x0342, 0x0343, 0x0344, 0x0345, 0x0346, 0x0347,
  0x0348, 0x0349, 0x034A, 0x034B, 0x034C, 0x034D, 0x034E, 0x034F, 0x0350, 0x0351, 0x0352, 0x0353,
  0x0354, 0x0355, 0x0356, 0x0357, 0x0358, 0x0359, 0x035A, 0x035B, 0x035C, 0x035D, 0x035E, 0x035F,
  0x0360, 0x0361, 0x0362, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036A, 0x036B,
  0x036C, 0x036D, 0x036E, 0x036F, 0x0370, 0x0371, 0x0372, 0x0373, 0x0374, 0x0375, 0x0376, 0x0377,
  0x0378, 0x0379, 0x037A, 0x03FD, 0x03FE, 0x03FF, 0x037E, 0x037F, 0x0380, 0x0381, 0x0382, 0x0383,
  0x0384, 0x0385, 0x0386, 0x0387, 0x0388, 0x0389, 0x038A, 0x038B, 0x038C, 0x038D, 0x038E, 0x038F,
  0x0390, 0x0391, 0x0392, 0x0393, 0x0394, 0x0395, 0x0396, 0x0397, 0x0398, 0x0399, 0x039A, 0x039B,
  0x039C, 0x039D, 0x039E, 0x039F, 0x03A0, 0x03A1, 0x03A2, 0x03A3, 0x03A4, 0x03A5, 0x03A6, 0x03A7,
  0x03A8, 0x03A9, 0x03AA, 0x03AB, 0x0386, 0x0388, 0x0389, 0x038A, 0x03B0, 0x0391, 0x0392, 0x0393,
  0x0394, 0x0395, 0x0396, 0x0397, 0x0398, 0x0399, 0x039A, 0x039B, 0x039C, 0x039D, 0x039E, 0x039F,
  0x03A0, 0x03A1, 0x03A3, 0x03A3, 0x03A4, 0x03A5, 0x03A6, 0x03A7, 0x03A8, 0x03A9, 0x03AA, 0x03AB,
  0x038C, 0x038E, 0x038F, 0x03CF, 0x03D0, 0x03D1, 0x03D2, 0x03D3, 0x03D4, 0x03D5, 0x03D6, 0x03D7,
  0x03D8, 0x03D8, 0x03DA, 0x03DA, 0x03DC, 0x03DC, 0x03DE, 0x03DE, 0x03E0, 0x03E0, 0x03E2, 0x03E2,
  0x03E4, 0x03E4, 0x03E6, 0x03E6, 0x03E8, 0x03E8, 0x03EA, 0x03EA, 0x03EC, 0x03EC, 0x03EE, 0x03EE,
  0x03F0, 0x03F1, 0x03F9, 0x03F3, 0x03F4, 0x03F5, 0x03F6, 0x03F7, 0x03F7, 0x03F9, 0x03FA, 0x03FA,
  0x03FC, 0x03FD, 0x03FE, 0x03FF, 0x0400, 0x0401, 0x0402, 0x0403, 0x0404, 0x0405, 0x0406, 0x0407,
  0x0408, 0x0409, 0x040A, 0x040B, 0x040C, 0x040D, 0x040E, 0x040F, 0x0410, 0x0411, 0x0412, 0x0413,
  0x0414, 0x0415, 0x0416, 0x0417, 0x0418, 0x0419, 0x041A, 0x041B, 0x041C, 0x041D, 0x041E, 0x041F,
  0x0420, 0x0421, 0x0422, 0x0423, 0x0424, 0x0425, 0x0426, 0x0427, 0x0428, 0x0429, 0x042A, 0x042B,
  0x042C, 0x042D, 0x042E, 0x042F, 0x0410, 0x0411, 0x0412, 0x0413, 0x0414, 0x0415, 0x0416, 0x0417,
  0x0418, 0x0419, 0x041A, 0x041B, 0x041C, 0x041D, 0x041E, 0x041F, 0x0420, 0x0421, 0x0422, 0x0423,
  0x0424, 0x0425, 0x0426, 0x0427, 0x0428, 0x0429, 0x042A, 0x042B, 0x042C, 0x042D, 0x042E, 0x042F,
  0x0400, 0x0401, 0x0402, 0x0403, 0x0404, 0x0405, 0x0406, 0x0407, 0x0408, 0x0409, 0x040A, 0x040B,
  0x040C, 0x040D, 0x040E, 0x040F, 0x0460, 0x0460, 0x0462, 0x0462, 0x0464, 0x0464, 0x0466, 0x0466,
  0x0468, 0x0468, 0x046A, 0x046A, 0x046C, 0x046C, 0x046E, 0x046E, 0x0470, 0x0470, 0x0472, 0x0472,
  0x0474, 0x0474, 0x0476, 0x0476, 0x0478, 0x0478, 0x047A, 0x047A, 0x047C, 0x047C, 0x047E, 0x047E,
  0x0480, 0x0480, 0x0482, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0488, 0x0489, 0x048A, 0x048A,
  0x048C, 0x048C, 0x048E, 0x048E, 0x0490, 0x0490, 0x0492, 0x0492, 0x0494, 0x0494, 0x0496, 0x0496,
  0x0498, 0x0498, 0x049A, 0x049A, 0x049C, 0x049C, 0x049E, 0x049E, 0x04A0, 0x04A0, 0x04A2, 0x04A2,
  0x04A4, 0x04A4, 0x04A6, 0x04A6, 0x04A8, 0x04A8, 0x04AA, 0x04AA, 0x04AC, 0x04AC, 0x04AE, 0x04AE,
  0x04B0, 0x04B0, 0x04B2, 0x04B2, 0x04B4, 0x04B4, 0x04B6, 0x04B6, 0x04B8, 0x04B8, 0x04BA, 0x04BA,
  0x04BC, 0x04BC, 0x04BE, 0x04BE, 0x04C0, 0x04C1, 0x04C1, 0x04C3, 0x04C3, 0x04C5, 0x04C5, 0x04C7,
  0x04C7, 0x04C9, 0x04C9, 0x04CB, 0x04CB, 0x04CD, 0x04CD, 0x04C0, 0x04D0, 0x04D0, 0x04D2, 0x04D2,
  0x04D4, 0x04D4, 0x04D6, 0x04D6, 0x04D8, 0x04D8, 0x04DA, 0x04DA, 0x04DC, 0x04DC, 0x04DE, 0x04DE,
  0x04E0, 0x04E0, 0x04E2, 0x04E2, 0x04E4, 0x04E4, 0x04E6, 0x04E6, 0x04E8, 0x04E8, 0x04EA, 0x04EA,
  0x04EC, 0x04EC, 0x04EE, 0x04EE, 0x04F0, 0x04F0, 0x04F2, 0x04F2, 0x04F4, 0x04F4, 0x04F6, 0x04F6,
  0x04F8, 0x04F8, 0x04FA, 0x04FA, 0x04FC, 0x04FC, 0x04FE, 0x04FE, 0x0500, 0x0500, 0x0502, 0x0502,
  0x0504, 0x0504, 0x0506, 0x0506, 0x0508, 0x0508, 0x050A, 0x050A, 0x050C, 0x050C, 0x050E, 0x050E,
  0x0510, 0x0510, 0x0512, 0x0512, 0x0514, 0x0515, 0x0516, 0x0517, 0x0518, 0x0519, 0x051A, 0x051B,
  0x051C, 0x051D, 0x051E, 0x051F, 0x0520, 0x0521, 0x0522, 0x0523, 0x0524, 0x0525, 0x0526, 0x0527,
  0x0528, 0x0529, 0x052A, 0x052B, 0x052C, 0x052D, 0x052E, 0x052F, 0x0530, 0x0531, 0x0532, 0x0533,
  0x0534, 0x0535, 0x0536, 0x0537, 0x0538, 0x0539, 0x053A, 0x053B, 0x053C, 0x053D, 0x053E, 0x053F,
  0x0540, 0x0541, 0x0542, 0x0543, 0x0544, 0x0545, 0x0546, 0x0547, 0x0548, 0x0549, 0x054A, 0x054B,
  0x054C, 0x054D, 0x054E, 0x054F, 0x0550, 0x0551, 0x0552, 0x0553, 0x0554, 0x0555, 0x0556, 0x0557,
  0x0558, 0x0559, 0x055A, 0x055B, 0x055C, 0x055D, 0x055E, 0x055F, 0x0560, 0x0531, 0x0532, 0x0533,
  0x0534, 0x0535, 0x0536, 0x0537, 0x0538, 0x0539, 0x053A, 0x053B, 0x053C, 0x053D, 0x053E, 0x053F,
  0x0540, 0x0541, 0x0542, 0x0543, 0x0544, 0x0545, 0x0546, 0x0547, 0x0548, 0x0549, 0x054A, 0x054B,
  0x054C, 0x054D, 0x054E, 0x054F, 0x0550, 0x0551, 0x0552, 0x0553, 0x0554, 0x0555, 0x0556, 0xFFFF,
  0x17F6, 0x2C63, 0x1D7E, 0x1D7F, 0x1D80, 0x1D81, 0x1D82, 0x1D83, 0x1D84, 0x1D85, 0x1D86, 0x1D87,
  0x1D88, 0x1D89, 0x1D8A, 0x1D8B, 0x1D8C, 0x1D8D, 0x1D8E, 0x1D8F, 0x1D90, 0x1D91, 0x1D92, 0x1D93,
  0x1D94, 0x1D95, 0x1D96, 0x1D97, 0x1D98, 0x1D99, 0x1D9A, 0x1D9B, 0x1D9C, 0x1D9D, 0x1D9E, 0x1D9F,
  0x1DA0, 0x1DA1, 0x1DA2, 0x1DA3, 0x1DA4, 0x1DA5, 0x1DA6, 0x1DA7, 0x1DA8, 0x1DA9, 0x1DAA, 0x1DAB,
  0x1DAC, 0x1DAD, 0x1DAE, 0x1DAF, 0x1DB0, 0x1DB1, 0x1DB2, 0x1DB3, 0x1DB4, 0x1DB5, 0x1DB6, 0x1DB7,
  0x1DB8, 0x1DB9, 0x1DBA, 0x1DBB, 0x1DBC, 0x1DBD, 0x1DBE, 0x1DBF, 0x1DC0, 0x1DC1, 0x1DC2, 0x1DC3,
  0x1DC4, 0x1DC5, 0x1DC6, 0x1DC7, 0x1DC8, 0x1DC9, 0x1DCA, 0x1DCB, 0x1DCC, 0x1DCD, 0x1DCE, 0x1DCF,
  0x1DD0, 0x1DD1, 0x1DD2, 0x1DD3, 0x1DD4, 0x1DD5, 0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9, 0x1DDA, 0x1DDB,
  0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF, 0x1DE0, 0x1DE1, 0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DE7,
  0x1DE8, 0x1DE9, 0x1DEA, 0x1DEB, 0x1DEC, 0x1DED, 0x1DEE, 0x1DEF, 0x1DF0, 0x1DF1, 0x1DF2, 0x1DF3,
  0x1DF4, 0x1DF5, 0x1DF6, 0x1DF7, 0x1DF8, 0x1DF9, 0x1DFA, 0x1DFB, 0x1DFC, 0x1DFD, 0x1DFE, 0x1DFF,
  0x1E00, 0x1E00, 0x1E02, 0x1E02, 0x1E04, 0x1E04, 0x1E06, 0x1E06, 0x1E08, 0x1E08, 0x1E0A, 0x1E0A,
  0x1E0C, 0x1E0C, 0x1E0E, 0x1E0E, 0x1E10, 0x1E10, 0x1E12, 0x1E12, 0x1E14, 0x1E14, 0x1E16, 0x1E16,
  0x1E18, 0x1E18, 0x1E1A, 0x1E1A, 0x1E1C, 0x1E1C, 0x1E1E, 0x1E1E, 0x1E20, 0x1E20, 0x1E22, 0x1E22,
  0x1E24, 0x1E24, 0x1E26, 0x1E26, 0x1E28, 0x1E28, 0x1E2A, 0x1E2A, 0x1E2C, 0x1E2C, 0x1E2E, 0x1E2E,
  0x1E30, 0x1E30, 0x1E32, 0x1E32, 0x1E34, 0x1E34, 0x1E36, 0x1E36, 0x1E38, 0x1E38, 0x1E3A, 0x1E3A,
  0x1E3C, 0x1E3C, 0x1E3E, 0x1E3E, 0x1E40, 0x1E40, 0x1E42, 0x1E42, 0x1E44, 0x1E44, 0x1E46, 0x1E46,
  0x1E48, 0x1E48, 0x1E4A, 0x1E4A, 0x1E4C, 0x1E4C, 0x1E4E, 0x1E4E, 0x1E50, 0x1E50, 0x1E52, 0x1E52,
  0x1E54, 0x1E54, 0x1E56, 0x1E56, 0x1E58, 0x1E58, 0x1E5A, 0x1E5A, 0x1E5C, 0x1E5C, 0x1E5E, 0x1E5E,
  0x1E60, 0x1E60, 0x1E62, 0x1E62, 0x1E64, 0x1E64, 0x1E66, 0x1E66, 0x1E68, 0x1E68, 0x1E6A, 0x1E6A,
  0x1E6C, 0x1E6C, 0x1E6E, 0x1E6E, 0x1E70, 0x1E70, 0x1E72, 0x1E72, 0x1E74, 0x1E74, 0x1E76, 0x1E76,
  0x1E78, 0x1E78, 0x1E7A, 0x1E7A, 0x1E7C, 0x1E7C, 0x1E7E, 0x1E7E, 0x1E80, 0x1E80, 0x1E82, 0x1E82,
  0x1E84, 0x1E84, 0x1E86, 0x1E86, 0x1E88, 0x1E88, 0x1E8A, 0x1E8A, 0x1E8C, 0x1E8C, 0x1E8E, 0x1E8E,
  0x1E90, 0x1E90, 0x1E92, 0x1E92, 0x1E94, 0x1E94, 0x1E96, 0x1E97, 0x1E98, 0x1E99, 0x1E9A, 0x1E9B,
  0x1E9C, 0x1E9D, 0x1E9E, 0x1E9F, 0x1EA0, 0x1EA0, 0x1EA2, 0x1EA2, 0x1EA4, 0x1EA4, 0x1EA6, 0x1EA6,
  0x1EA8, 0x1EA8, 0x1EAA, 0x1EAA, 0x1EAC, 0x1EAC, 0x1EAE, 0x1EAE, 0x1EB0, 0x1EB0, 0x1EB2, 0x1EB2,
  0x1EB4, 0x1EB4, 0x1EB6, 0x1EB6, 0x1EB8, 0x1EB8, 0x1EBA, 0x1EBA, 0x1EBC, 0x1EBC, 0x1EBE, 0x1EBE,
  0x1EC0, 0x1EC0, 0x1EC2, 0x1EC2, 0x1EC4, 0x1EC4, 0x1EC6, 0x1EC6, 0x1EC8, 0x1EC8, 0x1ECA, 0x1ECA,
  0x1ECC, 0x1ECC, 0x1ECE, 0x1ECE, 0x1ED0, 0x1ED0, 0x1ED2, 0x1ED2, 0x1ED4, 0x1ED4, 0x1ED6, 0x1ED6,
  0x1ED8, 0x1ED8, 0x1EDA, 0x1EDA, 0x1EDC, 0x1EDC, 0x1EDE, 0x1EDE, 0x1EE0, 0x1EE0, 0x1EE2, 0x1EE2,
  0x1EE4, 0x1EE4, 0x1EE6, 0x1EE6, 0x1EE8, 0x1EE8, 0x1EEA, 0x1EEA, 0x1EEC, 0x1EEC, 0x1EEE, 0x1EEE,
  0x1EF0, 0x1EF0, 0x1EF2, 0x1EF2, 0x1EF4, 0x1EF4, 0x1EF6, 0x1EF6, 0x1EF8, 0x1EF8, 0x1EFA, 0x1EFB,
  0x1EFC, 0x1EFD, 0x1EFE, 0x1EFF, 0x1F08, 0x1F09, 0x1F0A, 0x1F0B, 0x1F0C, 0x1F0D, 0x1F0E, 0x1F0F,
  0x1F08, 0x1F09, 0x1F0A, 0x1F0B, 0x1F0C, 0x1F0D, 0x1F0E, 0x1F0F, 0x1F18, 0x1F19, 0x1F1A, 0x1F1B,
  0x1F1C, 0x1F1D, 0x1F16, 0x1F17, 0x1F18, 0x1F19, 0x1F1A, 0x1F1B, 0x1F1C, 0x1F1D, 0x1F1E, 0x1F1F,
  0x1F28, 0x1F29, 0x1F2A, 0x1F2B, 0x1F2C, 0x1F2D, 0x1F2E, 0x1F2F, 0x1F28, 0x1F29, 0x1F2A, 0x1F2B,
  0x1F2C, 0x1F2D, 0x1F2E, 0x1F2F, 0x1F38, 0x1F39, 0x1F3A, 0x1F3B, 0x1F3C, 0x1F3D, 0x1F3E, 0x1F3F,
  0x1F38, 0x1F39, 0x1F3A, 0x1F3B, 0x1F3C, 0x1F3D, 0x1F3E, 0x1F3F, 0x1F48, 0x1F49, 0x1F4A, 0x1F4B,
  0x1F4C, 0x1F4D, 0x1F46, 0x1F47, 0x1F48, 0x1F49, 0x1F4A, 0x1F4B, 0x1F4C, 0x1F4D, 0x1F4E, 0x1F4F,
  0x1F50, 0x1F59, 0x1F52, 0x1F5B, 0x1F54, 0x1F5D, 0x1F56, 0x1F5F, 0x1F58, 0x1F59, 0x1F5A, 0x1F5B,
  0x1F5C, 0x1F5D, 0x1F5E, 0x1F5F, 0x1F68, 0x1F69, 0x1F6A, 0x1F6B, 0x1F6C, 0x1F6D, 0x1F6E, 0x1F6F,
  0x1F68, 0x1F69, 0x1F6A, 0x1F6B, 0x1F6C, 0x1F6D, 0x1F6E, 0x1F6F, 0x1FBA, 0x1FBB, 0x1FC8, 0x1FC9,
  0x1FCA, 0x1FCB, 0x1FDA, 0x1FDB, 0x1FF8, 0x1FF9, 0x1FEA, 0x1FEB, 0x1FFA, 0x1FFB, 0x1F7E, 0x1F7F,
  0x1F88, 0x1F89, 0x1F8A, 0x1F8B, 0x1F8C, 0x1F8D, 0x1F8E, 0x1F8F, 0x1F88, 0x1F89, 0x1F8A, 0x1F8B,
  0x1F8C, 0x1F8D, 0x1F8E, 0x1F8F, 0x1F98, 0x1F99, 0x1F9A, 0x1F9B, 0x1F9C, 0x1F9D, 0x1F9E, 0x1F9F,
  0x1F98, 0x1F99, 0x1F9A, 0x1F9B, 0x1F9C, 0x1F9D, 0x1F9E, 0x1F9F, 0x1FA8, 0x1FA9, 0x1FAA, 0x1FAB,
  0x1FAC, 0x1FAD, 0x1FAE, 0x1FAF, 0x1FA8, 0x1FA9, 0x1FAA, 0x1FAB, 0x1FAC, 0x1FAD, 0x1FAE, 0x1FAF,
  0x1FB8, 0x1FB9, 0x1FB2, 0x1FBC, 0x1FB4, 0x1FB5, 0x1FB6, 0x1FB7, 0x1FB8, 0x1FB9, 0x1FBA, 0x1FBB,
  0x1FBC, 0x1FBD, 0x1FBE, 0x1FBF, 0x1FC0, 0x1FC1, 0x1FC2, 0x1FC3, 0x1FC4, 0x1FC5, 0x1FC6, 0x1FC7,
  0x1FC8, 0x1FC9, 0x1FCA, 0x1FCB, 0x1FC3, 0x1FCD, 0x1FCE, 0x1FCF, 0x1FD8, 0x1FD9, 0x1FD2, 0x1FD3,
  0x1FD4, 0x1FD5, 0x1FD6, 0x1FD7, 0x1FD8, 0x1FD9, 0x1FDA, 0x1FDB, 0x1FDC, 0x1FDD, 0x1FDE, 0x1FDF,
  0x1FE8, 0x1FE9, 0x1FE2, 0x1FE3, 0x1FE4, 0x1FEC, 0x1FE6, 0x1FE7, 0x1FE8, 0x1FE9, 0x1FEA, 0x1FEB,
  0x1FEC, 0x1FED, 0x1FEE, 0x1FEF, 0x1FF0, 0x1FF1, 0x1FF2, 0x1FF3, 0x1FF4, 0x1FF5, 0x1FF6, 0x1FF7,
  0x1FF8, 0x1FF9, 0x1FFA, 0x1FFB, 0x1FF3, 0x1FFD, 0x1FFE, 0x1FFF, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2016, 0x2017, 0x2018, 0x2019, 0x201A, 0x201B,
  0x201C, 0x201D, 0x201E, 0x201F, 0x2020, 0x2021, 0x2022, 0x2023, 0x2024, 0x2025, 0x2026, 0x2027,
  0x2028, 0x2029, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x202F, 0x2030, 0x2031, 0x2032, 0x2033,
  0x2034, 0x2035, 0x2036, 0x2037, 0x2038, 0x2039, 0x203A, 0x203B, 0x203C, 0x203D, 0x203E, 0x203F,
  0x2040, 0x2041, 0x2042, 0x2043, 0x2044, 0x2045, 0x2046, 0x2047, 0x2048, 0x2049, 0x204A, 0x204B,
  0x204C, 0x204D, 0x204E, 0x204F, 0x2050, 0x2051, 0x2052, 0x2053, 0x2054, 0x2055, 0x2056, 0x2057,
  0x2058, 0x2059, 0x205A, 0x205B, 0x205C, 0x205D, 0x205E, 0x205F, 0x2060, 0x2061, 0x2062, 0x2063,
  0x2064, 0x2065, 0x2066, 0x2067, 0x2068, 0x2069, 0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F,
  0x2070, 0x2071, 0x2072, 0x2073, 0x2074, 0x2075, 0x2076, 0x2077, 0x2078, 0x2079, 0x207A, 0x207B,
  0x207C, 0x207D, 0x207E, 0x207F, 0x2080, 0x2081, 0x2082, 0x2083, 0x2084, 0x2085, 0x2086, 0x2087,
  0x2088, 0x2089, 0x208A, 0x208B, 0x208C, 0x208D, 0x208E, 0x208F, 0x2090, 0x2091, 0x2092, 0x2093,
  0x2094, 0x2095, 0x2096, 0x2097, 0x2098, 0x2099, 0x209A, 0x209B, 0x209C, 0x209D, 0x209E, 0x209F,
  0x20A0, 0x20A1, 0x20A2, 0x20A3, 0x20A4, 0x20A5, 0x20A6, 0x20A7, 0x20A8, 0x20A9, 0x20AA, 0x20AB,
  0x20AC, 0x20AD, 0x20AE, 0x20AF, 0x20B0, 0x20B1, 0x20B2, 0x20B3, 0x20B4, 0x20B5, 0x20B6, 0x20B7,
  0x20B8, 0x20B9, 0x20BA, 0x20BB, 0x20BC, 0x20BD, 0x20BE, 0x20BF, 0x20C0, 0x20C1, 0x20C2, 0x20C3,
  0x20C4, 0x20C5, 0x20C6, 0x20C7, 0x20C8, 0x20C9, 0x20CA, 0x20CB, 0x20CC, 0x20CD, 0x20CE, 0x20CF,
  0x20D0, 0x20D1, 0x20D2, 0x20D3, 0x20D4, 0x20D5, 0x20D6, 0x20D7, 0x20D8, 0x20D9, 0x20DA, 0x20DB,
  0x20DC, 0x20DD, 0x20DE, 0x20DF, 0x20E0, 0x20E1, 0x20E2, 0x20E3, 0x20E4, 0x20E5, 0x20E6, 0x20E7,
  0x20E8, 0x20E9, 0x20EA, 0x20EB, 0x20EC, 0x20ED, 0x20EE, 0x20EF, 0x20F0, 0x20F1, 0x20F2, 0x20F3,
  0x20F4, 0x20F5, 0x20F6, 0x20F7, 0x20F8, 0x20F9, 0x20FA, 0x20FB, 0x20FC, 0x20FD, 0x20FE, 0x20FF,
  0x2100, 0x2101, 0x2102, 0x2103, 0x2104, 0x2105, 0x2106, 0x2107, 0x2108, 0x2109, 0x210A, 0x210B,
  0x210C, 0x210D, 0x210E, 0x210F, 0x2110, 0x2111, 0x2112, 0x2113, 0x2114, 0x2115, 0x2116, 0x2117,
  0x2118, 0x2119, 0x211A, 0x211B, 0x211C, 0x211D, 0x211E, 0x211F, 0x2120, 0x2121, 0x2122, 0x2123,
  0x2124, 0x2125, 0x2126, 0x2127, 0x2128, 0x2129, 0x212A, 0x212B, 0x212C, 0x212D, 0x212E, 0x212F,
  0x2130, 0x2131, 0x2132, 0x2133, 0x2134, 0x2135, 0x2136, 0x2137, 0x2138, 0x2139, 0x213A, 0x213B,
  0x213C, 0x213D, 0x213E, 0x213F, 0x2140, 0x2141, 0x2142, 0x2143, 0x2144, 0x2145, 0x2146, 0x2147,
  0x2148, 0x2149, 0x214A, 0x214B, 0x214C, 0x214D, 0x2132, 0x214F, 0x2150, 0x2151, 0x2152, 0x2153,
  0x2154, 0x2155, 0x2156, 0x2157, 0x2158, 0x2159, 0x215A, 0x215B, 0x215C, 0x215D, 0x215E, 0x215F,
  0x2160, 0x2161, 0x2162, 0x2163, 0x2164, 0x2165, 0x2166, 0x2167, 0x2168, 0x2169, 0x216A, 0x216B,
  0x216C, 0x216D, 0x216E, 0x216F, 0x2160, 0x2161, 0x2162, 0x2163, 0x2164, 0x2165, 0x2166, 0x2167,
  0x2168, 0x2169, 0x216A, 0x216B, 0x216C, 0x216D, 0x216E, 0x216F, 0x2180, 0x2181, 0x2182, 0x2183,
  0x2183, 0xFFFF, 0x034B, 0x24B6, 0x24B7, 0x24B8, 0x24B9, 0x24BA, 0x24BB, 0x24BC, 0x24BD, 0x24BE,
  0x24BF, 0x24C0, 0x24C1, 0x24C2, 0x24C3, 0x24C4, 0x24C5, 0x24C6, 0x24C7, 0x24C8, 0x24C9, 0x24CA,
  0x24CB, 0x24CC, 0x24CD, 0x24CE, 0x24CF, 0xFFFF, 0x0746, 0x2C00, 0x2C01, 0x2C02, 0x2C03, 0x2C04,
  0x2C05, 0x2C06, 0x2C07, 0x2C08, 0x2C09, 0x2C0A, 0x2C0B, 0x2C0C, 0x2C0D, 0x2C0E, 0x2C0F, 0x2C10,
  0x2C11, 0x2C12, 0x2C13, 0x2C14, 0x2C15, 0x2C16, 0x2C17, 0x2C18, 0x2C19, 0x2C1A, 0x2C1B, 0x2C1C,
  0x2C1D, 0x2C1E, 0x2C1F, 0x2C20, 0x2C21, 0x2C22, 0x2C23, 0x2C24, 0x2C25, 0x2C26, 0x2C27, 0x2C28,
  0x2C29, 0x2C2A, 0x2C2B, 0x2C2C, 0x2C2D, 0x2C2E, 0x2C5F, 0x2C60, 0x2C60, 0x2C62, 0x2C63, 0x2C64,
  0x2C65, 0x2C66, 0x2C67, 0x2C67, 0x2C69, 0x2C69, 0x2C6B, 0x2C6B, 0x2C6D, 0x2C6E, 0x2C6F, 0x2C70,
  0x2C71, 0x2C72, 0x2C73, 0x2C74, 0x2C75, 0x2C75, 0x2C77, 0x2C78, 0x2C79, 0x2C7A, 0x2C7B, 0x2C7C,
  0x2C7D, 0x2C7E, 0x2C7F, 0x2C80, 0x2C80, 0x2C82, 0x2C82, 0x2C84, 0x2C84, 0x2C86, 0x2C86, 0x2C88,
  0x2C88, 0x2C8A, 0x2C8A, 0x2C8C, 0x2C8C, 0x2C8E, 0x2C8E, 0x2C90, 0x2C90, 0x2C92, 0x2C92, 0x2C94,
  0x2C94, 0x2C96, 0x2C96, 0x2C98, 0x2C98, 0x2C9A, 0x2C9A, 0x2C9C, 0x2C9C, 0x2C9E, 0x2C9E, 0x2CA0,
  0x2CA0, 0x2CA2, 0x2CA2, 0x2CA4, 0x2CA4, 0x2CA6, 0x2CA6, 0x2CA8, 0x2CA8, 0x2CAA, 0x2CAA, 0x2CAC,
  0x2CAC, 0x2CAE, 0x2CAE, 0x2CB0, 0x2CB0, 0x2CB2, 0x2CB2, 0x2CB4, 0x2CB4, 0x2CB6, 0x2CB6, 0x2CB8,
  0x2CB8, 0x2CBA, 0x2CBA, 0x2CBC, 0x2CBC, 0x2CBE, 0x2CBE, 0x2CC0, 0x2CC0, 0x2CC2, 0x2CC2, 0x2CC4,
  0x2CC4, 0x2CC6, 0x2CC6, 0x2CC8, 0x2CC8, 0x2CCA, 0x2CCA, 0x2CCC, 0x2CCC, 0x2CCE, 0x2CCE, 0x2CD0,
  0x2CD0, 0x2CD2, 0x2CD2, 0x2CD4, 0x2CD4, 0x2CD6, 0x2CD6, 0x2CD8, 0x2CD8, 0x2CDA, 0x2CDA, 0x2CDC,
  0x2CDC, 0x2CDE, 0x2CDE, 0x2CE0, 0x2CE0, 0x2CE2, 0x2CE2, 0x2CE4, 0x2CE5, 0x2CE6, 0x2CE7, 0x2CE8,
  0x2CE9, 0x2CEA, 0x2CEB, 0x2CEC, 0x2CED, 0x2CEE, 0x2CEF, 0x2CF0, 0x2CF1, 0x2CF2, 0x2CF3, 0x2CF4,
  0x2CF5, 0x2CF6, 0x2CF7, 0x2CF8, 0x2CF9, 0x2CFA, 0x2CFB, 0x2CFC, 0x2CFD, 0x2CFE, 0x2CFF, 0x10A0,
  0x10A1, 0x10A2, 0x10A3, 0x10A4, 0x10A5, 0x10A6, 0x10A7, 0x10A8, 0x10A9, 0x10AA, 0x10AB, 0x10AC,
  0x10AD, 0x10AE, 0x10AF, 0x10B0, 0x10B1, 0x10B2, 0x10B3, 0x10B4, 0x10B5, 0x10B6, 0x10B7, 0x10B8,
  0x10B9, 0x10BA, 0x10BB, 0x10BC, 0x10BD, 0x10BE, 0x10BF, 0x10C0, 0x10C1, 0x10C2, 0x10C3, 0x10C4,
  0x10C5, 0xFFFF, 0xD21B, 0xFF21, 0xFF22, 0xFF23, 0xFF24, 0xFF25, 0xFF26, 0xFF27, 0xFF28, 0xFF29,
  0xFF2A, 0xFF2B, 0xFF2C, 0xFF2D, 0xFF2E, 0xFF2F, 0xFF30, 0xFF31, 0xFF32, 0xFF33, 0xFF34, 0xFF35,
  0xFF36, 0xFF37, 0xFF38, 0xFF39, 0xFF3A, 0xFF5B, 0xFF5C, 0xFF5D, 0xFF5E, 0xFF5F, 0xFF60, 0xFF61,
  0xFF62, 0xFF63, 0xFF64, 0xFF65, 0xFF66, 0xFF67, 0xFF68, 0xFF69, 0xFF6A, 0xFF6B, 0xFF6C, 0xFF6D,
  0xFF6E, 0xFF6F, 0xFF70, 0xFF71, 0xFF72, 0xFF73, 0xFF74, 0xFF75, 0xFF76, 0xFF77, 0xFF78, 0xFF79,
  0xFF7A, 0xFF7B, 0xFF7C, 0xFF7D, 0xFF7E, 0xFF7F, 0xFF80, 0xFF81, 0xFF82, 0xFF83, 0xFF84, 0xFF85,
  0xFF86, 0xFF87, 0xFF88, 0xFF89, 0xFF8A, 0xFF8B, 0xFF8C, 0xFF8D, 0xFF8E, 0xFF8F, 0xFF90, 0xFF91,
  0xFF92, 0xFF93, 0xFF94, 0xFF95, 0xFF96, 0xFF97, 0xFF98, 0xFF99, 0xFF9A, 0xFF9B, 0xFF9C, 0xFF9D,
  0xFF9E, 0xFF9F, 0xFFA0, 0xFFA1, 0xFFA2, 0xFFA3, 0xFFA4, 0xFFA5, 0xFFA6, 0xFFA7, 0xFFA8, 0xFFA9,
  0xFFAA, 0xFFAB, 0xFFAC, 0xFFAD, 0xFFAE, 0xFFAF, 0xFFB0, 0xFFB1, 0xFFB2, 0xFFB3, 0xFFB4, 0xFFB5,
  0xFFB6, 0xFFB7, 0xFFB8, 0xFFB9, 0xFFBA, 0xFFBB, 0xFFBC, 0xFFBD, 0xFFBE, 0xFFBF, 0xFFC0, 0xFFC1,
  0xFFC2, 0xFFC3, 0xFFC4, 0xFFC5, 0xFFC6, 0xFFC7, 0xFFC8, 0xFFC9, 0xFFCA, 0xFFCB, 0xFFCC, 0xFFCD,
  0xFFCE, 0xFFCF, 0xFFD0, 0xFFD1, 0xFFD2, 0xFFD3, 0xFFD4, 0xFFD5, 0xFFD6, 0xFFD7, 0xFFD8, 0xFFD9,
  0xFFDA, 0xFFDB, 0xFFDC, 0xFFDD, 0xFFDE, 0xFFDF, 0xFFE0, 0xFFE1, 0xFFE2, 0xFFE3, 0xFFE4, 0xFFE5,
  0xFFE6, 0xFFE7, 0xFFE8, 0xFFE9, 0xFFEA, 0xFFEB, 0xFFEC, 0xFFED, 0xFFEE, 0xFFEF, 0xFFF0, 0xFFF1,
  0xFFF2, 0xFFF3, 0xFFF4, 0xFFF5, 0xFFF6, 0xFFF7, 0xFFF8, 0xFFF9, 0xFFFA, 0xFFFB, 0xFFFC, 0xFFFD,
  0xFFFE, 0xFFFF,
};

__attribute__((format(printf, 3, 4))) static int exw_fail(char* err, size_t cap, const char* fmt, ...) {
  if (err && cap) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, cap, fmt, ap);
    va_end(ap);
  }
  return -1;
}

static void exw_put16(uint8_t* p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
}
static void exw_put32(uint8_t* p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i));
}
static void exw_put64(uint8_t* p, uint64_t v) {
  for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (8 * i));
}
static uint16_t exw_le16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t exw_le32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint64_t exw_le64(const uint8_t* p) { return (uint64_t)exw_le32(p) | ((uint64_t)exw_le32(p + 4) << 32); }

static uint64_t exw_div_up(uint64_t a, uint64_t b) { return a / b + (a % b != 0); }

// Soma com verificacao de estouro. 0 = ok.
static int exw_add(uint64_t* acc, uint64_t v) {
  if (*acc > UINT64_MAX - v) return -1;
  *acc += v;
  return 0;
}

// --- checksums da spec ---

// BootChecksum (3.4): setores 0..10, sem VolumeFlags (106, 107) e PercentInUse (112).
static uint32_t exw_boot_checksum(const uint8_t* r, size_t bps) {
  uint32_t sum = 0;
  for (size_t i = 0; i < 11 * bps; i++) {
    if (i == 106 || i == 107 || i == 112) continue;
    sum = ((sum >> 1) | (sum << 31)) + r[i];
  }
  return sum;
}

// SetChecksum (6.3.3): todos os bytes do conjunto menos o proprio campo (bytes 2 e 3).
static uint16_t exw_set_checksum(const uint8_t* s, size_t n) {
  uint16_t sum = 0;
  for (size_t i = 0; i < n; i++) {
    if (i == 2 || i == 3) continue;
    sum = (uint16_t)(((sum >> 1) | (sum << 15)) + s[i]);
  }
  return sum;
}

// TableChecksum (7.2.2): sobre os bytes gravados da tabela.
static uint32_t exw_table_checksum(const uint8_t* b, size_t n) {
  uint32_t sum = 0;
  for (size_t i = 0; i < n; i++) sum = ((sum >> 1) | (sum << 31)) + b[i];
  return sum;
}

// NameHash (7.6.4): sobre os bytes (LE) do nome ja passado pela tabela up-case.
static uint16_t exw_name_hash(const uint16_t* up, const uint16_t* name, size_t n) {
  uint16_t hash = 0;
  for (size_t i = 0; i < n; i++) {
    uint16_t u = up[name[i]];
    hash = (uint16_t)(((hash >> 1) | (hash << 15)) + (u & 0xFF));
    hash = (uint16_t)(((hash >> 1) | (hash << 15)) + (u >> 8));
  }
  return hash;
}

// Tabela up-case gravada (comprimida ou nao) -> uma entrada por unidade UTF-16 (65536). NULL sem memoria.
static uint16_t* exw_upcase_expand(const uint8_t* bytes, size_t n) {
  uint16_t* t = malloc(65536 * sizeof *t);
  if (!t) return NULL;
  for (uint32_t i = 0; i < 65536; i++) t[i] = (uint16_t)i;
  size_t units = n / 2;
  uint32_t at = 0;
  for (size_t i = 0; i < units && at < 65536;) {
    uint16_t u = exw_le16(bytes + 2 * i);
    if (u == 0xFFFF && i + 1 < units) {
      at += exw_le16(bytes + 2 * (i + 1));
      i += 2;
    } else {
      t[at++] = u;
      i++;
    }
  }
  return t;
}

// Um nome (UTF-8, n bytes) -> UTF-16 em out (ate cap unidades), com as regras do exFAT. Devolve a quantidade de
// unidades ou -1 (motivo em *why). Com allow_empty, "" vale (rotulo do volume).
static int exw_name_to_u16(const char* s, size_t n, uint16_t* out, size_t cap, int allow_empty, const char** why) {
  size_t k = 0;
  if (n == 0 && !allow_empty) {
    *why = "nome vazio";
    return -1;
  }
  if ((n == 1 && s[0] == '.') || (n == 2 && s[0] == '.' && s[1] == '.')) {
    *why = "nome reservado (. ou ..)";
    return -1;
  }
  for (size_t i = 0; i < n;) {
    uint8_t c = (uint8_t)s[i];
    uint32_t cp, min;
    int extra;
    if (c < 0x80) { cp = c; extra = 0; min = 0; }
    else if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; extra = 1; min = 0x80; }
    else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; extra = 2; min = 0x800; }
    else if ((c & 0xF8) == 0xF0) { cp = c & 0x07; extra = 3; min = 0x10000; }
    else { *why = "UTF-8 invalido"; return -1; }
    if (i + 1 + (size_t)extra > n) { *why = "UTF-8 invalido"; return -1; }
    for (int j = 1; j <= extra; j++) {
      uint8_t b = (uint8_t)s[i + (size_t)j];
      if ((b & 0xC0) != 0x80) { *why = "UTF-8 invalido"; return -1; }
      cp = (cp << 6) | (b & 0x3F);
    }
    i += 1 + (size_t)extra;
    if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) { *why = "UTF-8 invalido"; return -1; }
    if (cp < 0x20 || cp == '"' || cp == '*' || cp == '/' || cp == ':' || cp == '<' || cp == '>' || cp == '?' ||
        cp == '\\' || cp == '|') {
      *why = "caractere proibido no exFAT (controle ou \" * / : < > ? \\ |)";
      return -1;
    }
    if (cp == 0xFFFD) { *why = "tem U+FFFD (nome ja estragado na origem)"; return -1; }
    if (cp >= 0x10000) {
      if (k + 2 > cap) { *why = "nome longo demais (UTF-16)"; return -1; }
      cp -= 0x10000;
      out[k++] = (uint16_t)(0xD800 + (cp >> 10));
      out[k++] = (uint16_t)(0xDC00 + (cp & 0x3FF));
    } else {
      if (k + 1 > cap) { *why = "nome longo demais (UTF-16)"; return -1; }
      out[k++] = (uint16_t)cp;
    }
  }
  return (int)k;
}

// ============================== planejamento (layout) ==============================

typedef struct {
  const char* path;        // caminho completo (aponta para entries[].path; a raiz usa "")
  uint32_t path_len;       // bytes do caminho ate este no
  uint32_t parent, first_child, next_sibling;
  uint32_t u16_off;        // nome em UTF-16 no pool
  uint16_t u16_len, hash;
  uint8_t is_dir;
  uint32_t first_cluster, clusters;  // first_cluster 0 = nada alocado (arquivo vazio)
  uint64_t size;
  const exw_entry* entry;  // NULL para pasta criada sozinha
} exw_node;

typedef struct {
  const exw_entry* entries;
  size_t count;
  exw_node* nodes;
  uint32_t n;
  uint16_t* u16;
  size_t u16_n;
  uint32_t* tab;           // caminho -> no (enderecamento aberto)
  uint32_t tab_mask;
  uint16_t* up;            // tabela up-case expandida
  uint8_t up_bytes[EXW_UPCASE_BYTES];
  uint32_t* order;         // nos com clusters, na ordem do heap
  uint32_t norder;
  uint16_t label[11];
  int label_len;
  uint64_t image_bytes, data_bytes;
  uint32_t files, dirs;    // dirs sem a raiz
  uint64_t fat_sectors, heap_sector, cluster_count, used_clusters, bitmap_clusters, upcase_cluster;
  uint32_t serial;
} exw_layout;

static void exw_layout_free(exw_layout* L) {
  free(L->nodes);
  free(L->u16);
  free(L->tab);
  free(L->up);
  free(L->order);
  memset(L, 0, sizeof *L);
}

static uint32_t exw_fnv(uint32_t h, const void* p, size_t n) {
  const uint8_t* b = p;
  for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 0x01000193u;
  return h;
}

static uint32_t* exw_slot(exw_layout* L, const char* p, size_t n) {
  uint32_t h = exw_fnv(0x811C9DC5u, p, n) & L->tab_mask;
  for (;;) {
    uint32_t* s = &L->tab[h];
    if (*s == EXW_NONE) return s;
    const exw_node* nd = &L->nodes[*s];
    if (nd->path_len == n && memcmp(nd->path, p, n) == 0) return s;
    h = (h + 1) & L->tab_mask;
  }
}

// Ordem dos irmaos: por pasta pai, depois pelo nome passado pela tabela up-case (iguais = colisao).
static int exw_node_cmp(const exw_layout* L, uint32_t a, uint32_t b) {
  const exw_node* x = &L->nodes[a];
  const exw_node* y = &L->nodes[b];
  if (x->parent != y->parent) return x->parent < y->parent ? -1 : 1;
  size_t n = x->u16_len < y->u16_len ? x->u16_len : y->u16_len;
  for (size_t i = 0; i < n; i++) {
    uint16_t ua = L->up[L->u16[x->u16_off + i]], ub = L->up[L->u16[y->u16_off + i]];
    if (ua != ub) return ua < ub ? -1 : 1;
  }
  return (x->u16_len > y->u16_len) - (x->u16_len < y->u16_len);
}

// Merge sort de baixo para cima (estavel, sem recursao, com contexto).
static void exw_sort_nodes(const exw_layout* L, uint32_t* v, uint32_t* tmp, uint32_t n) {
  for (uint32_t w = 1; w < n; w *= 2) {
    for (uint32_t lo = 0; lo < n; lo += 2 * w) {
      uint32_t mid = lo + w < n ? lo + w : n, hi = lo + 2 * w < n ? lo + 2 * w : n;
      uint32_t i = lo, j = mid, k = lo;
      while (i < mid && j < hi) tmp[k++] = exw_node_cmp(L, v[j], v[i]) < 0 ? v[j++] : v[i++];
      while (i < mid) tmp[k++] = v[i++];
      while (j < hi) tmp[k++] = v[j++];
    }
    memcpy(v, tmp, (size_t)n * sizeof *v);
    if (w > n / 2) break;
  }
}

// Proximo no em pre-ordem (pasta, depois o que ha nela), ou EXW_NONE no fim.
static uint32_t exw_next_preorder(const exw_layout* L, uint32_t cur) {
  if (L->nodes[cur].is_dir && L->nodes[cur].first_child != EXW_NONE) return L->nodes[cur].first_child;
  while (cur != 0 && L->nodes[cur].next_sibling == EXW_NONE) cur = L->nodes[cur].parent;
  return cur == 0 ? EXW_NONE : L->nodes[cur].next_sibling;
}

// Entradas de 32 bytes de uma pasta: (raiz: rotulo, bitmap, up-case) + conjunto de cada filho + 1 livre (marca o
// fim mesmo com o ultimo cluster cheio).
static uint64_t exw_dir_entries(const exw_layout* L, uint32_t d) {
  uint64_t n = (d == 0 ? 3 : 0) + 1;
  for (uint32_t c = L->nodes[d].first_child; c != EXW_NONE; c = L->nodes[c].next_sibling)
    n += 2 + exw_div_up(L->nodes[c].u16_len, 15);
  return n;
}

// Monta o layout inteiro (nomes, arvore, ordem, tamanhos e clusters). 0 = ok; -1 erro (err).
static int exw_build(exw_layout* L, const exw_entry* entries, size_t count, const char* label, char* err,
                     size_t errcap) {
  memset(L, 0, sizeof *L);
  L->entries = entries;
  L->count = count;
  if (!entries && count) return exw_fail(err, errcap, "lista de entradas vazia");

  const char* why = NULL;
  size_t lab_n = label ? strlen(label) : 0;
  int lab = exw_name_to_u16(label ? label : "", lab_n, L->label, 11, 1, &why);
  if (lab < 0) return exw_fail(err, errcap, "rotulo do volume invalido (%s; ate 11 caracteres)", why);
  L->label_len = lab;

  // limites: um no por parte de cada caminho (mais a raiz); o pool UTF-16 cabe nos bytes dos caminhos
  uint64_t bound = 1, bytes = 0;
  for (size_t i = 0; i < count; i++) {
    if (!entries[i].path) return exw_fail(err, errcap, "entrada %zu sem caminho", i);
    const char* p = entries[i].path;
    size_t len = strlen(p);
    bytes += len;
    bound++;
    for (size_t j = 0; j < len; j++) bound += p[j] == '/';
  }
  if (bound > 0x3FFFFFFFull) return exw_fail(err, errcap, "entradas demais");
  uint32_t tab_cap = 16;
  while (tab_cap < bound * 2) tab_cap *= 2;
  L->nodes = calloc((size_t)bound, sizeof *L->nodes);
  L->u16 = malloc((size_t)(bytes + 1) * sizeof *L->u16);
  L->tab = malloc((size_t)tab_cap * sizeof *L->tab);
  L->order = malloc((size_t)bound * sizeof *L->order);
  for (size_t i = 0; i < EXW_UPCASE_BYTES / 2; i++) exw_put16(L->up_bytes + 2 * i, exw_upcase_packed[i]);
  L->up = exw_upcase_expand(L->up_bytes, EXW_UPCASE_BYTES);
  if (!L->nodes || !L->u16 || !L->tab || !L->order || !L->up) {
    exw_layout_free(L);
    return exw_fail(err, errcap, "sem memoria para o plano da imagem");
  }
  memset(L->tab, 0xFF, (size_t)tab_cap * sizeof *L->tab);
  L->tab_mask = tab_cap - 1;

  exw_node* root = &L->nodes[0];
  root->path = "";
  root->parent = root->first_child = root->next_sibling = EXW_NONE;
  root->is_dir = 1;
  L->n = 1;

  for (size_t i = 0; i < count; i++) {
    const exw_entry* e = &entries[i];
    const char* p = e->path;
    size_t len = strlen(p);
    if (len == 0 || p[0] == '/' || p[len - 1] == '/') {
      exw_layout_free(L);
      return exw_fail(err, errcap, "caminho invalido: \"%s\" (relativo, sem '/' no inicio nem no fim)", p);
    }
    if (!e->is_dir && e->size > EXW_MAX_FILE) {
      exw_layout_free(L);
      return exw_fail(err, errcap, "%s: arquivo grande demais", p);
    }
    uint32_t parent = 0;
    for (size_t start = 0; start <= len;) {
      size_t end = start;
      while (end < len && p[end] != '/') end++;
      int last = end == len;
      int want_dir = !last || e->is_dir;
      uint32_t* slot = exw_slot(L, p, end);
      if (*slot != EXW_NONE) {
        exw_node* nd = &L->nodes[*slot];
        if (nd->is_dir && want_dir) {
          if (last) nd->entry = e;
          parent = *slot;
          start = end + 1;
          continue;
        }
        int same = nd->is_dir == (uint8_t)want_dir;
        exw_layout_free(L);
        return exw_fail(err, errcap, "%.*s: %s", (int)end, p,
                        same ? "listado duas vezes" : "e arquivo e pasta ao mesmo tempo");
      }
      int u = exw_name_to_u16(p + start, end - start, L->u16 + L->u16_n, EXW_MAX_NAME, 0, &why);
      if (u < 0) {
        exw_layout_free(L);
        return exw_fail(err, errcap, "nome invalido no exFAT (%s): %.*s", why, (int)end, p);
      }
      uint32_t id = L->n++;
      exw_node* nd = &L->nodes[id];
      nd->path = p;
      nd->path_len = (uint32_t)end;
      nd->parent = parent;
      nd->first_child = nd->next_sibling = EXW_NONE;
      nd->u16_off = (uint32_t)L->u16_n;
      nd->u16_len = (uint16_t)u;
      L->u16_n += (size_t)u;
      nd->is_dir = (uint8_t)want_dir;
      nd->size = want_dir ? 0 : e->size;
      nd->entry = last ? e : NULL;
      *slot = id;
      parent = id;
      start = end + 1;
    }
  }

  // irmaos em ordem; nomes iguais sem diferenciar maiusculas sao recusados
  uint32_t m = L->n - 1;
  if (m > 0) {
    uint32_t* v = malloc((size_t)m * sizeof *v);
    uint32_t* tmp = malloc((size_t)m * sizeof *tmp);
    if (!v || !tmp) {
      free(v);
      free(tmp);
      exw_layout_free(L);
      return exw_fail(err, errcap, "sem memoria para o plano da imagem");
    }
    for (uint32_t i = 0; i < m; i++) v[i] = i + 1;
    exw_sort_nodes(L, v, tmp, m);
    for (uint32_t i = 0; i < m; i++) {
      exw_node* nd = &L->nodes[v[i]];
      if (i > 0 && L->nodes[v[i - 1]].parent == nd->parent) {
        if (exw_node_cmp(L, v[i - 1], v[i]) == 0) {
          const exw_node* o = &L->nodes[v[i - 1]];
          int r = exw_fail(err, errcap, "%.*s e %.*s tem o mesmo nome no exFAT (nao diferencia maiusculas)",
                           (int)o->path_len, o->path, (int)nd->path_len, nd->path);
          free(v);
          free(tmp);
          exw_layout_free(L);
          return r;
        }
        L->nodes[v[i - 1]].next_sibling = v[i];
      } else {
        L->nodes[nd->parent].first_child = v[i];
      }
    }
    free(v);
    free(tmp);
  }
  for (uint32_t i = 1; i < L->n; i++)
    L->nodes[i].hash = exw_name_hash(L->up, L->u16 + L->nodes[i].u16_off, L->nodes[i].u16_len);

  // ordem do heap e clusters de cada no
  uint64_t content = 1;   // a tabela up-case: 5836 bytes, um cluster
  uint64_t data_clusters = 0;
  for (uint32_t c = 0; c != EXW_NONE; c = exw_next_preorder(L, c)) {
    exw_node* nd = &L->nodes[c];
    uint64_t cl;
    if (nd->is_dir) {
      uint64_t b = exw_dir_entries(L, c) * 32;
      if (b > EXW_MAX_DIR) {
        int r = exw_fail(err, errcap, "a pasta /%.*s tem entradas demais (mais de 256 MiB)", (int)nd->path_len,
                         nd->path);
        exw_layout_free(L);
        return r;
      }
      cl = exw_div_up(b, EXW_CLUSTER);
      if (c != 0) L->dirs++;
    } else {
      cl = exw_div_up(nd->size, EXW_CLUSTER);
      L->files++;
      if (exw_add(&L->data_bytes, nd->size) || exw_add(&data_clusters, cl)) {
        exw_layout_free(L);
        return exw_fail(err, errcap, "o jogo e grande demais para uma imagem exFAT");
      }
    }
    if (cl > EXW_MAX_CLUSTERS || exw_add(&content, cl) || content > EXW_MAX_CLUSTERS) {
      exw_layout_free(L);
      return exw_fail(err, errcap, "o jogo e grande demais para uma imagem exFAT com cluster de 64 KiB");
    }
    nd->clusters = (uint32_t)cl;
    if (cl) L->order[L->norder++] = c;
  }

  // tamanho como o mkexfat.sh do ShadowMount+
  uint64_t alloc = data_clusters * EXW_CLUSTER;
  uint64_t total = alloc + data_clusters * 4 + (data_clusters + 7) / 8 + ((uint64_t)L->files + L->dirs + 1) * 256 +
                   32 * EXW_MIB;
  uint64_t spare = total / 200;
  if (spare < 64 * EXW_MIB) spare = 64 * EXW_MIB;
  if (spare > 512 * EXW_MIB) spare = 512 * EXW_MIB;
  total += spare;
  if (total < L->data_bytes + 64 * EXW_MIB) total = L->data_bytes + 64 * EXW_MIB;
  total = exw_div_up(total, EXW_MIB) * EXW_MIB;

  // volume com exatamente esse tamanho (ou o menor que caiba tudo, se nao couber)
  uint64_t image = total;
  for (;;) {
    uint64_t img_cl = image / EXW_CLUSTER;
    if (img_cl > EXW_MAX_CLUSTERS + 64) {
      exw_layout_free(L);
      return exw_fail(err, errcap, "o jogo e grande demais para uma imagem exFAT com cluster de 64 KiB");
    }
    uint64_t fat = exw_div_up(exw_div_up((img_cl + 2) * 4, EXW_SECTOR), EXW_SPC) * EXW_SPC;
    uint64_t heap = EXW_FAT_OFFSET + fat;
    if (image > heap * EXW_SECTOR) {
      uint64_t clusters = (image - heap * EXW_SECTOR) / EXW_CLUSTER;
      uint64_t bitmap = exw_div_up(exw_div_up(clusters, 8), EXW_CLUSTER);
      if (clusters <= EXW_MAX_CLUSTERS && clusters >= bitmap + content) {
        L->fat_sectors = fat;
        L->heap_sector = heap;
        L->cluster_count = clusters;
        L->bitmap_clusters = bitmap;
        L->used_clusters = bitmap + content;
        L->image_bytes = image;
        break;
      }
    }
    image += EXW_CLUSTER;
  }
  L->upcase_cluster = 2 + L->bitmap_clusters;
  uint64_t next = L->upcase_cluster + 1;
  for (uint32_t i = 0; i < L->norder; i++) {
    exw_node* nd = &L->nodes[L->order[i]];
    nd->first_cluster = (uint32_t)next;
    next += nd->clusters;
  }

  // numero de serie a partir da lista (mesma arvore = mesmo numero)
  uint32_t h = 0x811C9DC5u;
  for (size_t i = 0; i < count; i++) {
    h = exw_fnv(h, entries[i].path, strlen(entries[i].path) + 1);
    uint8_t sz[8];
    exw_put64(sz, entries[i].is_dir ? UINT64_MAX : entries[i].size);
    h = exw_fnv(h, sz, sizeof sz);
  }
  h = exw_fnv(h, L->label, (size_t)L->label_len * 2);
  uint8_t im[8];
  exw_put64(im, L->image_bytes);
  L->serial = exw_fnv(h, im, sizeof im);
  return 0;
}

int exw_plan_image(const exw_entry* entries, size_t count, const char* label, exw_plan* out, char* err,
                   size_t errcap) {
  exw_layout L;
  if (exw_build(&L, entries, count, label, err, errcap)) return -1;
  if (out) {
    out->image_bytes = L.image_bytes;
    out->data_bytes = L.data_bytes;
    out->cluster_bytes = (uint32_t)EXW_CLUSTER;
    out->files = L.files;
    out->dirs = L.dirs;
  }
  exw_layout_free(&L);
  return 0;
}

// ============================== escrita ==============================

typedef struct {
  int fd;
  uint8_t* buf;
  size_t fill;
  uint64_t base;   // posicao no arquivo de buf[0]
  uint64_t synced; // ate onde ja houve fsync
} exw_out;

static uint64_t exw_out_pos(const exw_out* o) { return o->base + o->fill; }

static int exw_out_flush(exw_out* o) {
  size_t done = 0;
  while (done < o->fill) {
    ssize_t w = pwrite(o->fd, o->buf + done, o->fill - done, (off_t)(o->base + done));
    if (w < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (w == 0) {
      errno = EIO;
      return -1;
    }
    done += (size_t)w;
  }
  o->base += o->fill;
  o->fill = 0;
  if (o->base - o->synced >= EXW_SYNC_EVERY) {
    if (fsync(o->fd) != 0) return -1;
    EXW_DONTNEED(o->fd, o->synced, o->base - o->synced);
    o->synced = o->base;
  }
  return 0;
}

static int exw_out_write(exw_out* o, const void* data, size_t n) {
  const uint8_t* d = data;
  while (n > 0) {
    if (o->fill == EXW_IO_BUF && exw_out_flush(o)) return -1;
    size_t k = EXW_IO_BUF - o->fill;
    if (k > n) k = n;
    memcpy(o->buf + o->fill, d, k);
    o->fill += k;
    d += k;
    n -= k;
  }
  return 0;
}

static int exw_out_u32(exw_out* o, uint32_t v) {
  if (o->fill + 4 > EXW_IO_BUF && exw_out_flush(o)) return -1;
  exw_put32(o->buf + o->fill, v);
  o->fill += 4;
  return 0;
}

// Zeros ate `end`. -1 erro de escrita; -3 se ja passou de `end` (erro interno do plano).
static int exw_out_zeros_to(exw_out* o, uint64_t end) {
  if (exw_out_pos(o) > end) return -3;
  while (exw_out_pos(o) < end) {
    if (o->fill == EXW_IO_BUF && exw_out_flush(o)) return -1;
    uint64_t k = EXW_IO_BUF - o->fill;
    if (k > end - exw_out_pos(o)) k = end - exw_out_pos(o);
    memset(o->buf + o->fill, 0, (size_t)k);
    o->fill += (size_t)k;
  }
  return 0;
}

static uint64_t exw_cluster_off(const exw_layout* L, uint64_t cluster) {
  return L->heap_sector * EXW_SECTOR + (cluster - 2) * EXW_CLUSTER;
}

// Data/hora atual (UTC) no formato de timestamp do exFAT.
static uint32_t exw_timestamp(void) {
  const uint32_t fixed = (uint32_t)((2024 - 1980) << 25) | (1u << 21) | (1u << 16);
  time_t t = time(NULL);
  if (t < (time_t)315532800) return fixed;   // antes de 1980
  int64_t days = (int64_t)t / 86400, secs = (int64_t)t % 86400;
  // dias -> data civil (algoritmo de H. Hinnant)
  int64_t z = days + 719468;
  int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  int64_t doe = z - era * 146097;
  int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t y = yoe + era * 400;
  int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  int64_t mp = (5 * doy + 2) / 153;
  int64_t d = doy - (153 * mp + 2) / 5 + 1;
  int64_t mo = mp < 10 ? mp + 3 : mp - 9;
  if (mo <= 2) y++;
  if (y < 1980 || y > 2107) return fixed;
  return (uint32_t)((y - 1980) << 25) | (uint32_t)(mo << 21) | (uint32_t)(d << 16) |
         (uint32_t)((secs / 3600) << 11) | (uint32_t)(((secs / 60) % 60) << 5) | (uint32_t)((secs % 60) / 2);
}

// Conjunto File + Stream + FileName de um no, com SetChecksum. Devolve os bytes (ate 19 * 32).
static size_t exw_entry_set(const exw_layout* L, const exw_node* nd, uint32_t ts, uint8_t* set) {
  size_t names = exw_div_up(nd->u16_len, 15);
  size_t n = 32 * (2 + names);
  memset(set, 0, n);
  set[0] = 0x85;
  set[1] = (uint8_t)(1 + names);   // SecondaryCount
  exw_put16(set + 4, nd->is_dir ? 0x10 : 0x20);
  exw_put32(set + 8, ts);    // criado
  exw_put32(set + 12, ts);   // modificado
  exw_put32(set + 16, ts);   // acessado
  set[22] = set[23] = set[24] = 0x80;   // UtcOffset valido, 0 (hora em UTC)
  uint8_t* s = set + 32;
  s[0] = 0xC0;
  s[1] = nd->first_cluster ? 0x03 : 0x01;   // AllocationPossible (+ NoFatChain quando tem clusters)
  s[3] = (uint8_t)nd->u16_len;
  exw_put16(s + 4, nd->hash);
  uint64_t dl = nd->is_dir ? (uint64_t)nd->clusters * EXW_CLUSTER : nd->size;
  exw_put64(s + 8, dl);      // ValidDataLength: todo byte e gravado
  exw_put32(s + 20, nd->first_cluster);
  exw_put64(s + 24, dl);
  for (size_t i = 0; i < nd->u16_len; i++) {
    uint8_t* e = set + 32 * (2 + i / 15);
    e[0] = 0xC1;
    exw_put16(e + 2 + 2 * (i % 15), L->u16[nd->u16_off + i]);
  }
  exw_put16(set + 2, exw_set_checksum(set, n));
  return n;
}

static int exw_write_dir(const exw_layout* L, exw_out* o, uint32_t d, uint32_t ts) {
  if (d == 0) {
    uint8_t e[32];
    memset(e, 0, sizeof e);
    e[0] = 0x83;   // rotulo do volume
    e[1] = (uint8_t)L->label_len;
    for (int i = 0; i < L->label_len; i++) exw_put16(e + 2 + 2 * i, L->label[i]);
    if (exw_out_write(o, e, 32)) return -1;
    memset(e, 0, sizeof e);
    e[0] = 0x81;   // bitmap de alocacao (o unico: uma FAT so)
    exw_put32(e + 20, 2);
    exw_put64(e + 24, exw_div_up(L->cluster_count, 8));
    if (exw_out_write(o, e, 32)) return -1;
    memset(e, 0, sizeof e);
    e[0] = 0x82;   // tabela up-case
    exw_put32(e + 4, exw_table_checksum(L->up_bytes, EXW_UPCASE_BYTES));
    exw_put32(e + 20, (uint32_t)L->upcase_cluster);
    exw_put64(e + 24, EXW_UPCASE_BYTES);
    if (exw_out_write(o, e, 32)) return -1;
  }
  uint8_t set[19 * 32];
  for (uint32_t c = L->nodes[d].first_child; c != EXW_NONE; c = L->nodes[c].next_sibling) {
    size_t n = exw_entry_set(L, &L->nodes[c], ts, set);
    if (exw_out_write(o, set, n)) return -1;
  }
  return 0;
}

// Escreve a imagem inteira em o. 0 = ok; -1 erro (err); -2 cancelado.
static int exw_emit(const exw_layout* L, exw_out* o, exw_read_fn read, void* read_ctx, exw_progress_fn progress,
                    void* progress_ctx, char* err, size_t errcap) {
  const char* werr = "erro gravando a imagem: %s";
  // regiao de boot (montada no proprio buffer, que esta vazio)
  uint8_t* r = o->buf;
  memset(r, 0, EXW_BOOT_BYTES);
  r[0] = 0xEB;
  r[1] = 0x76;
  r[2] = 0x90;
  memcpy(r + 3, "EXFAT   ", 8);
  exw_put64(r + 72, L->image_bytes / EXW_SECTOR);   // VolumeLength (PartitionOffset 0: imagem crua)
  exw_put32(r + 80, (uint32_t)EXW_FAT_OFFSET);
  exw_put32(r + 84, (uint32_t)L->fat_sectors);
  exw_put32(r + 88, (uint32_t)L->heap_sector);
  exw_put32(r + 92, (uint32_t)L->cluster_count);
  exw_put32(r + 96, L->nodes[0].first_cluster);
  exw_put32(r + 100, L->serial);
  exw_put16(r + 104, 0x0100);   // revisao 1.00
  exw_put16(r + 106, 0);        // VolumeFlags: limpo, primeira FAT
  r[108] = EXW_SECTOR_SHIFT;
  r[109] = EXW_SPC_SHIFT;
  r[110] = 1;      // NumberOfFats
  r[111] = 0x80;   // DriveSelect
  r[112] = (uint8_t)(L->used_clusters * 100 / L->cluster_count);
  memset(r + 120, 0xF4, 390);   // BootCode sem codigo: HLT
  r[510] = 0x55;
  r[511] = 0xAA;
  for (int s = 1; s <= 8; s++) exw_put32(r + 512 * s + 508, 0xAA550000u);   // setores estendidos
  uint32_t sum = exw_boot_checksum(r, 512);
  for (int i = 0; i < 128; i++) exw_put32(r + 11 * 512 + 4 * i, sum);
  memcpy(r + EXW_BOOT_BYTES, r, EXW_BOOT_BYTES);   // copia de seguranca
  o->fill = 2 * EXW_BOOT_BYTES;
  if (exw_out_zeros_to(o, EXW_FAT_OFFSET * EXW_SECTOR)) return exw_fail(err, errcap, werr, strerror(errno));

  // FAT: midia, reservado e uma cadeia por faixa
  if (exw_out_u32(o, 0xFFFFFFF8u) || exw_out_u32(o, EXW_EOC)) return exw_fail(err, errcap, werr, strerror(errno));
  for (int64_t run = -2; run < (int64_t)L->norder; run++) {
    uint64_t first, cnt;
    if (run == -2) { first = 2; cnt = L->bitmap_clusters; }
    else if (run == -1) { first = L->upcase_cluster; cnt = 1; }
    else { first = L->nodes[L->order[run]].first_cluster; cnt = L->nodes[L->order[run]].clusters; }
    for (uint64_t c = first; c < first + cnt; c++)
      if (exw_out_u32(o, c + 1 == first + cnt ? EXW_EOC : (uint32_t)(c + 1)))
        return exw_fail(err, errcap, werr, strerror(errno));
  }
  if (exw_out_zeros_to(o, L->heap_sector * EXW_SECTOR)) return exw_fail(err, errcap, werr, strerror(errno));

  // bitmap: os clusters usados estao todos no comeco do heap
  {
    uint64_t full = L->used_clusters / 8;
    while (full > 0) {
      if (o->fill == EXW_IO_BUF && exw_out_flush(o)) return exw_fail(err, errcap, werr, strerror(errno));
      uint64_t k = EXW_IO_BUF - o->fill;
      if (k > full) k = full;
      memset(o->buf + o->fill, 0xFF, (size_t)k);
      o->fill += (size_t)k;
      full -= k;
    }
    uint8_t part = (uint8_t)((1u << (L->used_clusters % 8)) - 1);
    if (L->used_clusters % 8 && exw_out_write(o, &part, 1)) return exw_fail(err, errcap, werr, strerror(errno));
    if (exw_out_zeros_to(o, exw_cluster_off(L, L->upcase_cluster)))
      return exw_fail(err, errcap, werr, strerror(errno));
  }
  if (exw_out_write(o, L->up_bytes, EXW_UPCASE_BYTES) || exw_out_zeros_to(o, exw_cluster_off(L, L->upcase_cluster + 1)))
    return exw_fail(err, errcap, werr, strerror(errno));

  uint32_t ts = exw_timestamp();
  uint64_t done = 0, total = L->data_bytes;
  if (progress && progress(progress_ctx, 0, total)) return -2;
  for (uint32_t i = 0; i < L->norder; i++) {
    const exw_node* nd = &L->nodes[L->order[i]];
    if (exw_out_pos(o) != exw_cluster_off(L, nd->first_cluster))
      return exw_fail(err, errcap, "erro interno: posicao %llu, o plano diz %llu",
                      (unsigned long long)exw_out_pos(o), (unsigned long long)exw_cluster_off(L, nd->first_cluster));
    if (nd->is_dir) {
      if (exw_write_dir(L, o, L->order[i], ts)) return exw_fail(err, errcap, werr, strerror(errno));
    } else {
      if (!read) return exw_fail(err, errcap, "sem funcao de leitura da fonte");
      for (uint64_t at = 0; at < nd->size;) {
        if (o->fill == EXW_IO_BUF && exw_out_flush(o)) return exw_fail(err, errcap, werr, strerror(errno));
        uint64_t want = EXW_IO_BUF - o->fill;
        if (want > nd->size - at) want = nd->size - at;
        long long got = read(read_ctx, nd->entry, at, o->buf + o->fill, (size_t)want);
        if (got < 0) return exw_fail(err, errcap, "erro lendo %s da fonte (offset %llu)", nd->entry->path,
                                     (unsigned long long)at);
        if (got == 0 || (uint64_t)got > want)
          return exw_fail(err, errcap, "%s mudou na fonte: leu %lld bytes em %llu de %llu", nd->entry->path, got,
                          (unsigned long long)at, (unsigned long long)nd->size);
        o->fill += (size_t)got;
        at += (uint64_t)got;
        done += (uint64_t)got;
        if (progress && progress(progress_ctx, done, total)) return -2;
      }
    }
    int z = exw_out_zeros_to(o, exw_cluster_off(L, (uint64_t)nd->first_cluster + nd->clusters));
    if (z == -3) return exw_fail(err, errcap, "erro interno: %.*s passou do espaco planejado", (int)nd->path_len,
                                 nd->path);
    if (z) return exw_fail(err, errcap, werr, strerror(errno));
  }
  if (exw_out_pos(o) != exw_cluster_off(L, 2 + L->used_clusters))
    return exw_fail(err, errcap, "erro interno: fim dos dados em %llu, o plano diz %llu",
                    (unsigned long long)exw_out_pos(o), (unsigned long long)exw_cluster_off(L, 2 + L->used_clusters));
  if (exw_out_flush(o)) return exw_fail(err, errcap, werr, strerror(errno));
  return 0;
}

int exw_write(const char* image_path, const exw_entry* entries, size_t count, const char* label, exw_read_fn read,
              void* read_ctx, exw_progress_fn progress, void* progress_ctx, char* err, size_t errcap) {
  if (err && errcap) err[0] = 0;
  if (!image_path || !*image_path) return exw_fail(err, errcap, "caminho da imagem vazio");
  exw_layout L;
  if (exw_build(&L, entries, count, label, err, errcap)) return -1;
  exw_out o;
  memset(&o, 0, sizeof o);
  o.buf = malloc(EXW_IO_BUF);
  if (!o.buf) {
    exw_layout_free(&L);
    return exw_fail(err, errcap, "sem memoria para o buffer de escrita");
  }
  o.fd = open(image_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (o.fd < 0) {
    int e = errno;
    free(o.buf);
    exw_layout_free(&L);
    return exw_fail(err, errcap, "nao abriu %s: %s", image_path, strerror(e));
  }
  int rc = exw_emit(&L, &o, read, read_ctx, progress, progress_ctx, err, errcap);
  if (rc == 0) {
    // a folga no fim: so estende o arquivo (zeros; esparso onde o sistema de arquivos deixa)
    if (ftruncate(o.fd, (off_t)L.image_bytes) != 0) rc = exw_fail(err, errcap, "nao estendeu a imagem: %s", strerror(errno));
    else if (fsync(o.fd) != 0) rc = exw_fail(err, errcap, "fsync da imagem falhou: %s", strerror(errno));
  }
  if (close(o.fd) != 0 && rc == 0) rc = exw_fail(err, errcap, "erro fechando a imagem: %s", strerror(errno));
  free(o.buf);
  exw_layout_free(&L);
  return rc;
}

// ============================== fonte "pasta" ==============================

typedef struct {
  exw_entry* v;
  size_t n, cap;
  char* path;        // caminho completo da pasta atual
  size_t root_len;   // bytes da raiz em path
} exw_lister;

static int exw_list_add(exw_lister* ls, const char* rel, uint64_t size, int is_dir) {
  if (ls->n == ls->cap) {
    size_t nc = ls->cap ? ls->cap * 2 : 256;
    exw_entry* nv = realloc(ls->v, nc * sizeof *nv);
    if (!nv) return -1;
    ls->v = nv;
    ls->cap = nc;
  }
  char* p = strdup(rel);
  if (!p) return -1;
  exw_entry* e = &ls->v[ls->n++];
  e->path = p;
  e->size = is_dir ? 0 : size;
  e->is_dir = is_dir;
  e->user = NULL;
  return 0;
}

static int exw_list_rec(exw_lister* ls, size_t len, int depth, char* err, size_t errcap) {
  DIR* d = opendir(ls->path);
  if (!d) return exw_fail(err, errcap, "nao abriu a pasta %s: %s", ls->path, strerror(errno));
  int rc = 0;
  struct dirent* de;
  while (rc == 0 && (de = readdir(d)) != NULL) {
    const char* name = de->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
    size_t nl = strlen(name);
    if (len + 1 + nl + 1 > EXW_PATH_CAP) {
      rc = exw_fail(err, errcap, "caminho longo demais em %s", ls->path);
      break;
    }
    ls->path[len] = '/';
    memcpy(ls->path + len + 1, name, nl + 1);
    struct stat st;
    if (lstat(ls->path, &st) != 0) {
      rc = exw_fail(err, errcap, "%s: %s", ls->path, strerror(errno));
    } else if (S_ISLNK(st.st_mode)) {
      rc = exw_fail(err, errcap, "link simbolico recusado: %s", ls->path + ls->root_len + 1);
    } else if (S_ISDIR(st.st_mode)) {
      if (depth >= EXW_LIST_DEPTH) rc = exw_fail(err, errcap, "pastas aninhadas demais em %s", ls->path);
      else if (exw_list_add(ls, ls->path + ls->root_len + 1, 0, 1)) rc = exw_fail(err, errcap, "sem memoria");
      else rc = exw_list_rec(ls, len + 1 + nl, depth + 1, err, errcap);
    } else if (S_ISREG(st.st_mode)) {
      if (exw_list_add(ls, ls->path + ls->root_len + 1, (uint64_t)st.st_size, 0)) rc = exw_fail(err, errcap, "sem memoria");
    } else {
      rc = exw_fail(err, errcap, "tipo de arquivo nao suportado: %s", ls->path + ls->root_len + 1);
    }
    ls->path[len] = 0;
  }
  closedir(d);
  return rc;
}

void exw_free_entries(exw_entry* entries, size_t count) {
  if (!entries) return;
  for (size_t i = 0; i < count; i++) free((void*)entries[i].path);
  free(entries);
}

int exw_list_dir(const char* root, exw_entry** out, size_t* count, char* err, size_t errcap) {
  if (!root || !out || !count) return exw_fail(err, errcap, "parametros invalidos");
  *out = NULL;
  *count = 0;
  exw_lister ls;
  memset(&ls, 0, sizeof ls);
  size_t rl = strlen(root);
  while (rl > 0 && root[rl - 1] == '/') rl--;
  if (rl + 2 > EXW_PATH_CAP) return exw_fail(err, errcap, "caminho longo demais");
  ls.path = malloc(EXW_PATH_CAP);
  if (!ls.path) return exw_fail(err, errcap, "sem memoria");
  memcpy(ls.path, root, rl);
  ls.path[rl] = 0;
  ls.root_len = rl;
  struct stat st;
  int rc;
  if (stat(rl ? ls.path : "/", &st) != 0 || !S_ISDIR(st.st_mode))
    rc = exw_fail(err, errcap, "%s nao e uma pasta", root);
  else if (rl == 0)
    rc = exw_fail(err, errcap, "a raiz do sistema nao pode ser a fonte");
  else
    rc = exw_list_rec(&ls, rl, 0, err, errcap);
  free(ls.path);
  if (rc) {
    exw_free_entries(ls.v, ls.n);
    return -1;
  }
  *out = ls.v;
  *count = ls.n;
  return 0;
}

long long exw_read_dir_file(void* ctx, const exw_entry* e, uint64_t offset, void* buf, size_t len) {
  const char* root = ctx;
  if (!root || !e || !e->path) return -1;
  char p[EXW_PATH_CAP];
  int k = snprintf(p, sizeof p, "%s/%s", root, e->path);
  if (k < 0 || (size_t)k >= sizeof p) return -1;
  int fd = open(p, O_RDONLY);
  if (fd < 0) return -1;
  size_t got = 0;
  while (got < len) {
    ssize_t r = pread(fd, (char*)buf + got, len - got, (off_t)(offset + got));
    if (r < 0) {
      if (errno == EINTR) continue;
      close(fd);
      return -1;
    }
    if (r == 0) break;
    got += (size_t)r;
  }
  if (got >= EXW_CLUSTER) EXW_DONTNEED(fd, offset, got);
  close(fd);
  return (long long)got;
}

// ============================== conferencia (leitor independente) ==============================

typedef struct {
  int fd;
  uint64_t img_size;
  uint32_t bps_shift, cl_shift;
  uint64_t cl_bytes, fat_off, fat_bytes, heap_off;
  uint32_t n_cl, root;
  uint8_t fat_cache[4096];
  uint64_t fat_cache_at;
  size_t fat_cache_n;
  uint16_t* up;
  uint8_t* bitmap;   // bitmap de alocacao do volume
  uint8_t* seen;     // clusters ja encontrados na arvore
  uint64_t bitmap_bytes;
  char* err;
  size_t errcap;
} exw_vol;

typedef struct {
  char* path;
  uint64_t size, valid;
  uint32_t first;
  uint8_t contig, is_dir;
  const exw_entry* entry;
} exw_item;

typedef struct {
  exw_item* v;
  size_t n, cap;
} exw_items;

typedef struct {
  uint32_t cur;
  int contig, to_eoc, end;
  uint64_t len, pos, steps;
} exw_stream;

static int exw_vread(exw_vol* v, uint64_t off, void* buf, size_t n) {
  if (off > v->img_size || n > v->img_size - off) return -1;
  size_t got = 0;
  while (got < n) {
    ssize_t r = pread(v->fd, (char*)buf + got, n - got, (off_t)(off + got));
    if (r < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (r == 0) return -1;
    got += (size_t)r;
  }
  if (n >= EXW_CLUSTER) EXW_DONTNEED(v->fd, off, n);
  return 0;
}

static int exw_cl_ok(const exw_vol* v, uint32_t c) { return c >= 2 && (uint64_t)c <= (uint64_t)v->n_cl + 1; }

static int exw_fat_next(exw_vol* v, uint32_t c, uint32_t* next) {
  uint64_t rel = (uint64_t)c * 4;
  if (rel + 4 > v->fat_bytes) return -1;
  uint64_t blk = rel & ~(uint64_t)4095;
  if (!v->fat_cache_n || v->fat_cache_at != blk) {
    uint64_t n = v->fat_bytes - blk;
    if (n > 4096) n = 4096;
    v->fat_cache_n = 0;
    if (exw_vread(v, v->fat_off + blk, v->fat_cache, (size_t)n)) return -1;
    v->fat_cache_at = blk;
    v->fat_cache_n = (size_t)n;
  }
  *next = exw_le32(v->fat_cache + (rel - blk));
  return 0;
}

static void exw_stream_init(exw_stream* f, uint32_t first, int contig, uint64_t len, int to_eoc) {
  memset(f, 0, sizeof *f);
  f->cur = first;
  f->contig = contig;
  f->len = len;
  f->to_eoc = to_eoc;
}

// Passa para o proximo cluster da faixa/cadeia. 0 = ok, 1 = fim da cadeia (to_eoc), -1 erro.
static int exw_stream_step(exw_vol* v, exw_stream* f) {
  if (++f->steps > v->n_cl) return -1;   // cadeia circular
  uint32_t next;
  if (f->contig) {
    next = f->cur + 1;
  } else {
    if (exw_fat_next(v, f->cur, &next)) return -1;
    if (next == EXW_EOC) {
      if (!f->to_eoc) return -1;   // cadeia menor que o tamanho
      f->end = 1;
      return 1;
    }
  }
  if (!exw_cl_ok(v, next)) return -1;
  f->cur = next;
  return 0;
}

// Le ate n bytes na sequencia. *got < n so no fim. 0 = ok.
static int exw_stream_read(exw_vol* v, exw_stream* f, uint8_t* buf, size_t n, size_t* got) {
  *got = 0;
  while (n > 0 && f->pos < f->len && !f->end) {
    if (!exw_cl_ok(v, f->cur)) return -1;
    uint64_t in = f->pos & (v->cl_bytes - 1);
    uint64_t part = v->cl_bytes - in;
    if (part > n) part = n;
    if (part > f->len - f->pos) part = f->len - f->pos;
    if (exw_vread(v, v->heap_off + ((uint64_t)(f->cur - 2) << v->cl_shift) + in, buf, (size_t)part)) return -1;
    buf += part;
    n -= (size_t)part;
    *got += (size_t)part;
    f->pos += part;
    if ((f->pos & (v->cl_bytes - 1)) == 0 && f->pos < f->len && exw_stream_step(v, f) < 0) return -1;
  }
  return 0;
}

// Avanca ate `to` (so para frente). 0 = ok.
static int exw_stream_seek(exw_vol* v, exw_stream* f, uint64_t to) {
  if (to < f->pos || to > f->len) return -1;
  while ((f->pos >> v->cl_shift) < (to >> v->cl_shift)) {
    f->pos = ((f->pos >> v->cl_shift) + 1) << v->cl_shift;
    if (f->pos < f->len && exw_stream_step(v, f) != 0) return -1;
  }
  f->pos = to;
  return 0;
}

// Marca os clusters de uma faixa/cadeia como encontrados (e confere com o bitmap). count = 0: ate o fim da cadeia.
static int exw_claim(exw_vol* v, uint32_t first, int contig, uint64_t count, const char* what) {
  uint32_t c = first;
  for (uint64_t i = 0;; i++) {
    if (!exw_cl_ok(v, c)) return exw_fail(v->err, v->errcap, "%s: cluster %u fora do volume", what, c);
    uint64_t k = (uint64_t)c - 2;
    if (v->seen[k / 8] & (1u << (k % 8)))
      return exw_fail(v->err, v->errcap, "%s: cluster %u usado duas vezes", what, c);
    if (!(v->bitmap[k / 8] & (1u << (k % 8))))
      return exw_fail(v->err, v->errcap, "%s: cluster %u livre no bitmap", what, c);
    v->seen[k / 8] |= (uint8_t)(1u << (k % 8));
    if (count && i + 1 == count) {
      if (!contig) {
        uint32_t next;
        if (exw_fat_next(v, c, &next) || next != EXW_EOC)
          return exw_fail(v->err, v->errcap, "%s: cadeia da FAT maior que o tamanho", what);
      }
      return 0;
    }
    if (i > v->n_cl) return exw_fail(v->err, v->errcap, "%s: cadeia circular", what);
    uint32_t next;
    if (contig) {
      next = c + 1;
    } else {
      if (exw_fat_next(v, c, &next)) return exw_fail(v->err, v->errcap, "%s: erro lendo a FAT", what);
      if (next == EXW_EOC) {
        if (count) return exw_fail(v->err, v->errcap, "%s: cadeia da FAT menor que o tamanho", what);
        return 0;
      }
    }
    c = next;
  }
}

// Le uma tabela do volume (bitmap ou up-case: seguem a FAT) inteira para a memoria.
static uint8_t* exw_load_chain(exw_vol* v, uint32_t first, uint64_t len) {
  uint8_t* b = malloc(len ? (size_t)len : 1);
  if (!b) return NULL;
  exw_stream f;
  exw_stream_init(&f, first, 0, len, 0);
  size_t got;
  if (exw_stream_read(v, &f, b, (size_t)len, &got) || got != len) {
    free(b);
    return NULL;
  }
  return b;
}

static int exw_items_add(exw_items* it, exw_item* x) {
  if (it->n == it->cap) {
    size_t nc = it->cap ? it->cap * 2 : 256;
    exw_item* nv = realloc(it->v, nc * sizeof *nv);
    if (!nv) return -1;
    it->v = nv;
    it->cap = nc;
  }
  it->v[it->n++] = *x;
  return 0;
}

static void exw_items_free(exw_items* it) {
  for (size_t i = 0; i < it->n; i++) free(it->v[i].path);
  free(it->v);
  memset(it, 0, sizeof *it);
}

// UTF-16 -> UTF-8 (para montar o caminho). -1 se tiver surrogate solto.
static int exw_u16_to_utf8(const uint16_t* s, size_t n, char* out, size_t cap) {
  size_t k = 0;
  for (size_t i = 0; i < n; i++) {
    uint32_t cp = s[i];
    if (cp >= 0xD800 && cp <= 0xDBFF) {
      if (i + 1 >= n || s[i + 1] < 0xDC00 || s[i + 1] > 0xDFFF) return -1;
      cp = 0x10000 + ((cp - 0xD800) << 10) + (s[i + 1] - 0xDC00);
      i++;
    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
      return -1;
    }
    uint8_t b[4];
    size_t m;
    if (cp < 0x80) { b[0] = (uint8_t)cp; m = 1; }
    else if (cp < 0x800) { b[0] = (uint8_t)(0xC0 | (cp >> 6)); b[1] = (uint8_t)(0x80 | (cp & 0x3F)); m = 2; }
    else if (cp < 0x10000) {
      b[0] = (uint8_t)(0xE0 | (cp >> 12)); b[1] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F));
      b[2] = (uint8_t)(0x80 | (cp & 0x3F)); m = 3;
    } else {
      b[0] = (uint8_t)(0xF0 | (cp >> 18)); b[1] = (uint8_t)(0x80 | ((cp >> 12) & 0x3F));
      b[2] = (uint8_t)(0x80 | ((cp >> 6) & 0x3F)); b[3] = (uint8_t)(0x80 | (cp & 0x3F)); m = 4;
    }
    if (k + m + 1 > cap) return -1;
    memcpy(out + k, b, m);
    k += m;
  }
  out[k] = 0;
  return (int)k;
}

// Interpreta um conjunto File completo da pasta `dir` e acrescenta em it.
static int exw_take_set(exw_vol* v, exw_items* it, const char* dir, const uint8_t* set, int qtd) {
  if (exw_set_checksum(set, (size_t)qtd * 32) != exw_le16(set + 2))
    return exw_fail(v->err, v->errcap, "SetChecksum errado em /%s", dir);
  const uint8_t* s = set + 32;
  if (s[0] != 0xC0) return exw_fail(v->err, v->errcap, "conjunto sem Stream Extension em /%s", dir);
  size_t nl = s[3];
  if (nl == 0 || (int)exw_div_up(nl, 15) > qtd - 2) return exw_fail(v->err, v->errcap, "nome com tamanho invalido em /%s", dir);
  uint16_t name[255];
  for (size_t i = 0; i < nl; i++) {
    const uint8_t* e = set + 32 * (2 + i / 15);
    if (e[0] != 0xC1) return exw_fail(v->err, v->errcap, "entrada de nome faltando em /%s", dir);
    name[i] = exw_le16(e + 2 + 2 * (i % 15));
    if (name[i] < 0x20 || name[i] == '/') return exw_fail(v->err, v->errcap, "caractere invalido num nome em /%s", dir);
  }
  if (exw_name_hash(v->up, name, nl) != exw_le16(s + 4)) return exw_fail(v->err, v->errcap, "NameHash errado em /%s", dir);
  char u8[255 * 3 + 1];
  if (exw_u16_to_utf8(name, nl, u8, sizeof u8) < 0) return exw_fail(v->err, v->errcap, "nome UTF-16 invalido em /%s", dir);
  size_t dl = strlen(dir), ul = strlen(u8);
  exw_item x;
  memset(&x, 0, sizeof x);
  x.path = malloc(dl + 1 + ul + 1);
  if (!x.path) return exw_fail(v->err, v->errcap, "sem memoria");
  if (dl) {
    memcpy(x.path, dir, dl);
    x.path[dl] = '/';
    memcpy(x.path + dl + 1, u8, ul + 1);
  } else {
    memcpy(x.path, u8, ul + 1);
  }
  x.is_dir = (exw_le16(set + 4) & 0x10) != 0;
  x.contig = (s[1] & 2) != 0;
  x.valid = exw_le64(s + 8);
  x.first = exw_le32(s + 20);
  x.size = exw_le64(s + 24);
  if (!(s[1] & 1)) x.size = x.valid = 0;
  int rc = 0;
  if (x.valid > x.size) rc = exw_fail(v->err, v->errcap, "%s: ValidDataLength maior que o tamanho", x.path);
  else if (x.is_dir && (x.size == 0 || x.size > EXW_MAX_DIR || (x.size & (v->cl_bytes - 1))))
    rc = exw_fail(v->err, v->errcap, "%s: pasta com tamanho invalido", x.path);
  else if (x.size > 0) rc = exw_claim(v, x.first, x.contig, exw_div_up(x.size, v->cl_bytes), x.path);
  if (rc == 0 && exw_items_add(it, &x)) rc = exw_fail(v->err, v->errcap, "sem memoria");
  if (rc) free(x.path);
  return rc;
}

// Percorre as entradas de uma pasta. Na raiz, guarda as do bitmap e da up-case em t (se t != NULL) e pula os nomes.
typedef struct {
  uint32_t bm_first, up_first, up_sum;
  uint64_t bm_len, up_len;
  int bm_n, up_n;
} exw_tables;

static int exw_scan_dir(exw_vol* v, exw_items* it, const char* dir, exw_stream* f, int is_root, exw_tables* t) {
  uint8_t* blk = malloc(4096);
  if (!blk) return exw_fail(v->err, v->errcap, "sem memoria");
  uint8_t set[19 * 32];
  int have = 0, want = 0, rc = 0;
  size_t n = 0, i = 0;
  for (;;) {
    if (i + 32 > n) {
      if (exw_stream_read(v, f, blk, 4096, &n)) { rc = exw_fail(v->err, v->errcap, "erro lendo a pasta /%s", dir); break; }
      i = 0;
      if (n < 32) break;
    }
    const uint8_t* e = blk + i;
    i += 32;
    uint8_t type = e[0];
    if (type == 0x00) break;
    if (want) {
      if (type >= 0xC0) {
        memcpy(set + 32 * have, e, 32);
        if (++have == want) {
          want = 0;
          if (!t && (rc = exw_take_set(v, it, dir, set, have)) != 0) break;
        }
        continue;
      }
      rc = exw_fail(v->err, v->errcap, "conjunto de entradas incompleto em /%s", dir);
      break;
    }
    if (!(type & 0x80)) continue;   // apagada
    if (type == 0x85) {
      if (e[1] < 2 || e[1] > 18) { rc = exw_fail(v->err, v->errcap, "SecondaryCount invalido em /%s", dir); break; }
      memcpy(set, e, 32);
      have = 1;
      want = 1 + e[1];
    } else if (is_root && type == 0x81) {
      if (t) { t->bm_n++; t->bm_first = exw_le32(e + 20); t->bm_len = exw_le64(e + 24); }
    } else if (is_root && type == 0x82) {
      if (t) { t->up_n++; t->up_sum = exw_le32(e + 4); t->up_first = exw_le32(e + 20); t->up_len = exw_le64(e + 24); }
    } else if (is_root && (type == 0x83 || type == 0xA0)) {
      // rotulo / GUID do volume
    } else if ((type & 0x20) == 0) {
      rc = exw_fail(v->err, v->errcap, "entrada critica desconhecida 0x%02X em /%s", type, dir);
      break;
    }
  }
  if (rc == 0 && want) rc = exw_fail(v->err, v->errcap, "conjunto de entradas incompleto no fim de /%s", dir);
  free(blk);
  return rc;
}

static void exw_vol_close(exw_vol* v) {
  if (v->fd >= 0) close(v->fd);
  free(v->up);
  free(v->bitmap);
  free(v->seen);
  v->fd = -1;
  v->up = NULL;
  v->bitmap = v->seen = NULL;
}

static int exw_vol_open(exw_vol* v, const char* image_path) {
  struct stat st;
  v->fd = open(image_path, O_RDONLY);
  if (v->fd < 0) return exw_fail(v->err, v->errcap, "nao abriu %s: %s", image_path, strerror(errno));
  if (fstat(v->fd, &st) != 0) return exw_fail(v->err, v->errcap, "fstat: %s", strerror(errno));
  v->img_size = (uint64_t)st.st_size;
  uint8_t bs[512];
  if (exw_vread(v, 0, bs, sizeof bs)) return exw_fail(v->err, v->errcap, "imagem curta demais");
  if (memcmp(bs + 3, "EXFAT   ", 8) != 0 || bs[510] != 0x55 || bs[511] != 0xAA)
    return exw_fail(v->err, v->errcap, "nao e um volume exFAT");
  v->bps_shift = bs[108];
  uint32_t spc = bs[109];
  if (v->bps_shift < 9 || v->bps_shift > 12 || spc > 25 - v->bps_shift || bs[110] < 1 || bs[110] > 2)
    return exw_fail(v->err, v->errcap, "boot sector com geometria invalida");
  size_t bps = (size_t)1 << v->bps_shift;
  uint8_t* reg = malloc(24 * bps);
  if (!reg) return exw_fail(v->err, v->errcap, "sem memoria");
  if (exw_vread(v, 0, reg, 24 * bps)) {
    free(reg);
    return exw_fail(v->err, v->errcap, "imagem curta demais");
  }
  for (int copy = 0; copy < 2; copy++) {
    const uint8_t* r = reg + (size_t)copy * 12 * bps;
    uint32_t sum = exw_boot_checksum(r, bps);
    for (size_t k = 0; k < bps / 4; k++)
      if (exw_le32(r + 11 * bps + 4 * k) != sum) {
        free(reg);
        return exw_fail(v->err, v->errcap, "checksum da regiao de boot %s errado", copy ? "de copia" : "principal");
      }
  }
  free(reg);
  uint64_t vol_len = exw_le64(bs + 72), fat_off = exw_le32(bs + 80), fat_len = exw_le32(bs + 84);
  uint64_t heap = exw_le32(bs + 88);
  v->n_cl = exw_le32(bs + 92);
  v->root = exw_le32(bs + 96);
  v->cl_shift = v->bps_shift + spc;
  v->cl_bytes = (uint64_t)1 << v->cl_shift;
  if (exw_le16(bs + 106) & 1 && bs[110] == 2) fat_off += fat_len;   // ActiveFat = segunda
  v->fat_off = fat_off << v->bps_shift;
  v->fat_bytes = fat_len << v->bps_shift;
  v->heap_off = heap << v->bps_shift;
  if (v->n_cl == 0 || v->n_cl > EXW_MAX_CLUSTERS || fat_off < 24 || v->fat_bytes < ((uint64_t)v->n_cl + 2) * 4 ||
      heap < fat_off + fat_len || (vol_len << v->bps_shift) > v->img_size ||
      v->heap_off + ((uint64_t)v->n_cl << v->cl_shift) > (vol_len << v->bps_shift) || !exw_cl_ok(v, v->root))
    return exw_fail(v->err, v->errcap, "boot sector com tamanhos inconsistentes");

  // tabelas citadas na raiz
  exw_tables t;
  memset(&t, 0, sizeof t);
  exw_stream f;
  exw_stream_init(&f, v->root, 0, EXW_MAX_DIR, 1);
  if (exw_scan_dir(v, NULL, "", &f, 1, &t)) return -1;
  if (t.bm_n != 1 || t.up_n != 1) return exw_fail(v->err, v->errcap, "raiz sem bitmap ou sem tabela up-case");
  v->bitmap_bytes = exw_div_up(v->n_cl, 8);
  if (t.bm_len < v->bitmap_bytes || t.bm_len > (64ull << 20) || t.up_len < 2 || t.up_len > 131072 * 2)
    return exw_fail(v->err, v->errcap, "bitmap ou tabela up-case com tamanho invalido");
  v->bitmap = exw_load_chain(v, t.bm_first, t.bm_len);
  uint8_t* upb = exw_load_chain(v, t.up_first, t.up_len);
  v->seen = calloc((size_t)v->bitmap_bytes, 1);
  if (!v->bitmap || !upb || !v->seen) {
    free(upb);
    return exw_fail(v->err, v->errcap, "nao leu o bitmap ou a tabela up-case");
  }
  if (exw_table_checksum(upb, (size_t)t.up_len) != t.up_sum) {
    free(upb);
    return exw_fail(v->err, v->errcap, "checksum da tabela up-case errado");
  }
  v->up = exw_upcase_expand(upb, (size_t)t.up_len);
  free(upb);
  if (!v->up) return exw_fail(v->err, v->errcap, "sem memoria");
  if (exw_claim(v, t.bm_first, 0, exw_div_up(t.bm_len, v->cl_bytes), "bitmap") ||
      exw_claim(v, t.up_first, 0, exw_div_up(t.up_len, v->cl_bytes), "tabela up-case") ||
      exw_claim(v, v->root, 0, 0, "raiz"))
    return -1;
  return 0;
}

// Percorre a arvore inteira (a lista cresce enquanto e percorrida: cada pasta achada e lida depois).
static int exw_vol_walk(exw_vol* v, exw_items* it) {
  exw_stream f;
  exw_stream_init(&f, v->root, 0, EXW_MAX_DIR, 1);
  if (exw_scan_dir(v, it, "", &f, 1, NULL)) return -1;
  for (size_t i = 0; i < it->n; i++) {
    if (!it->v[i].is_dir) continue;
    exw_item d = it->v[i];   // copia: a lista pode mudar de lugar
    exw_stream_init(&f, d.first, d.contig, d.valid, 0);
    if (exw_scan_dir(v, it, d.path, &f, 0, NULL)) return -1;
  }
  // nenhum cluster marcado no bitmap sem dono
  uint64_t lost = 0;
  for (uint64_t k = 0; k < v->n_cl; k++)
    if ((v->bitmap[k / 8] & (1u << (k % 8))) && !(v->seen[k / 8] & (1u << (k % 8)))) lost++;
  if (lost) return exw_fail(v->err, v->errcap, "%llu cluster(s) marcados no bitmap sem dono", (unsigned long long)lost);
  return 0;
}

static int exw_item_cmp(const void* a, const void* b) {
  return strcmp(((const exw_item*)a)->path, ((const exw_item*)b)->path);
}

// Le `len` bytes da fonte (repetindo leituras curtas). 0 = ok.
static int exw_src_full(exw_read_fn read, void* ctx, const exw_entry* e, uint64_t off, uint8_t* buf, size_t len) {
  size_t got = 0;
  while (got < len) {
    long long r = read(ctx, e, off + got, buf + got, len - got);
    if (r <= 0 || (size_t)r > len - got) return -1;
    got += (size_t)r;
  }
  return 0;
}

static int exw_cmp_file(exw_vol* v, const exw_item* x, exw_read_fn read, void* ctx, int sample, uint8_t* a,
                        uint8_t* b) {
  uint64_t size = x->size;
  uint64_t offs[8];
  int n = 0;
  int all = sample == 2 || size <= 8 * EXW_CMP_BUF;
  if (!all) {
    // comeco, 6 blocos espalhados (alinhados a 64 KiB) e o fim, em ordem crescente
    offs[n++] = 0;
    for (int k = 1; k <= 6; k++) offs[n++] = (size / 7 * (uint64_t)k) & ~(EXW_CLUSTER - 1);
    offs[n++] = size - EXW_CMP_BUF;
  }
  exw_stream f;
  exw_stream_init(&f, x->first, x->contig, x->valid, 0);
  uint64_t prev_end = 0;
  for (int i = 0; all ? prev_end < size : i < n; i++) {
    uint64_t off = all ? prev_end : offs[i];
    if (off < prev_end) off = prev_end;
    if (off >= size) break;
    size_t len = (size_t)(size - off < EXW_CMP_BUF ? size - off : EXW_CMP_BUF);
    // imagem: ate ValidDataLength vem do disco, depois e zero
    size_t from_disk = 0;
    if (off < x->valid) {
      from_disk = (size_t)(x->valid - off < len ? x->valid - off : len);
      size_t got;
      if (exw_stream_seek(v, &f, off) || exw_stream_read(v, &f, a, from_disk, &got) || got != from_disk)
        return exw_fail(v->err, v->errcap, "erro lendo %s na imagem (offset %llu)", x->path, (unsigned long long)off);
    }
    memset(a + from_disk, 0, len - from_disk);
    if (exw_src_full(read, ctx, x->entry, off, b, len))
      return exw_fail(v->err, v->errcap, "erro lendo %s na fonte (offset %llu)", x->path, (unsigned long long)off);
    if (memcmp(a, b, len) != 0) {
      size_t k = 0;
      while (a[k] == b[k]) k++;
      return exw_fail(v->err, v->errcap, "conteudo diferente em %s (offset %llu)", x->path,
                      (unsigned long long)(off + k));
    }
    prev_end = off + len;
  }
  return 0;
}

// A lista esperada: cada entrada mais as pastas pais (sem repetir).
static int exw_expected(const exw_entry* entries, size_t count, exw_items* ex, char* err, size_t errcap) {
  for (size_t i = 0; i < count; i++) {
    const char* p = entries[i].path;
    if (!p) return exw_fail(err, errcap, "entrada sem caminho");
    size_t len = strlen(p);
    for (size_t j = 0; j <= len; j++) {
      if (j < len && p[j] != '/') continue;
      exw_item x;
      memset(&x, 0, sizeof x);
      x.path = malloc(j + 1);
      if (!x.path) return exw_fail(err, errcap, "sem memoria");
      memcpy(x.path, p, j);
      x.path[j] = 0;
      x.is_dir = j < len || entries[i].is_dir;
      x.size = x.is_dir ? 0 : entries[i].size;
      x.entry = j == len ? &entries[i] : NULL;
      if (exw_items_add(ex, &x)) {
        free(x.path);
        return exw_fail(err, errcap, "sem memoria");
      }
    }
  }
  if (ex->n) qsort(ex->v, ex->n, sizeof *ex->v, exw_item_cmp);
  size_t w = 0;
  for (size_t i = 0; i < ex->n; i++) {
    if (w > 0 && strcmp(ex->v[w - 1].path, ex->v[i].path) == 0) {
      if (!ex->v[w - 1].is_dir || !ex->v[i].is_dir) return exw_fail(err, errcap, "%s repetido na lista", ex->v[i].path);
      free(ex->v[i].path);
      continue;
    }
    ex->v[w++] = ex->v[i];
  }
  ex->n = w;
  return 0;
}

int exw_verify(const char* image_path, const exw_entry* entries, size_t count, exw_read_fn read, void* read_ctx,
               int sample, char* err, size_t errcap) {
  if (err && errcap) err[0] = 0;
  exw_vol v;
  memset(&v, 0, sizeof v);
  v.fd = -1;
  v.err = err;
  v.errcap = errcap;
  exw_items got, ex;
  memset(&got, 0, sizeof got);
  memset(&ex, 0, sizeof ex);
  uint8_t *a = NULL, *b = NULL;
  int rc = exw_vol_open(&v, image_path);
  if (rc == 0) rc = exw_vol_walk(&v, &got);
  if (rc == 0) rc = exw_expected(entries, count, &ex, err, errcap);
  if (rc == 0) {
    if (got.n) qsort(got.v, got.n, sizeof *got.v, exw_item_cmp);
    size_t i = 0, j = 0;
    while (rc == 0 && (i < got.n || j < ex.n)) {
      int c = i == got.n ? 1 : j == ex.n ? -1 : strcmp(got.v[i].path, ex.v[j].path);
      if (c < 0) rc = exw_fail(err, errcap, "sobra na imagem: %s", got.v[i].path);
      else if (c > 0) rc = exw_fail(err, errcap, "falta na imagem: %s", ex.v[j].path);
      else if (got.v[i].is_dir != ex.v[j].is_dir) rc = exw_fail(err, errcap, "%s: pasta/arquivo trocado", ex.v[j].path);
      else if (!got.v[i].is_dir && got.v[i].size != ex.v[j].size)
        rc = exw_fail(err, errcap, "%s: tamanho %llu na imagem, %llu na fonte", ex.v[j].path,
                      (unsigned long long)got.v[i].size, (unsigned long long)ex.v[j].size);
      else got.v[i].entry = ex.v[j].entry;
      i++;
      j++;
    }
  }
  if (rc == 0 && sample) {
    if (!read) rc = exw_fail(err, errcap, "sem funcao de leitura da fonte");
    a = malloc(EXW_CMP_BUF);
    b = malloc(EXW_CMP_BUF);
    if (rc == 0 && (!a || !b)) rc = exw_fail(err, errcap, "sem memoria");
    for (size_t i = 0; rc == 0 && i < got.n; i++)
      if (!got.v[i].is_dir && got.v[i].size > 0) rc = exw_cmp_file(&v, &got.v[i], read, read_ctx, sample, a, b);
  }
  free(a);
  free(b);
  exw_items_free(&got);
  exw_items_free(&ex);
  exw_vol_close(&v);
  return rc ? -1 : 0;
}
