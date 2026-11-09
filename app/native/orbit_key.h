// glibren.20: a chave do catalogo publico do Orbit Store (catalogue-v8.enc), copiada de backend/catalog_key.h do
// fonte GPL-3 do Orbit Store 1.8.5 (https://github.com/saawant12/orbit-store-ps5, release v1.8.5, source bundle).
// O proprio Orbit a descreve como "scraping resistance key, id 1. Not a secret or signing key": vai em todo app dele.
// Se o Orbit trocar de chave (o envelope tem um id de chave), a decifragem falha e a lista avisa que parou.
#ifndef ORBIT_KEY_H
#define ORBIT_KEY_H
static const unsigned char orbit_key[32] = {0x21, 0x43, 0x26, 0x3b, 0x71, 0x6b, 0x06, 0xec, 0x56, 0x5d, 0x04, 0x7a, 0x8c, 0x37, 0x0d, 0xa7, 0xe5, 0xd9, 0x69, 0x09, 0x75, 0x74, 0x8e, 0x83, 0x6e, 0xd9, 0x2c, 0x66, 0x43, 0x41, 0xf6, 0xac};
#endif
