// glibren-tube-update: verificacao Ed25519 (RFC 8032) e SHA-512 (FIPS 180-4) em JS puro, so o que o app precisa para
// conferir o manifesto assinado de uma atualizacao do tube-service (state/tube-update.js). So VERIFICA: a chave
// privada nunca passa pelo app. O runtime nao tem ArrayBuffer/Uint8Array (ps5-react docs/NATIVE-API.md), entao bytes
// sao arrays comuns de numeros 0..255; os numeros grandes sao BigInt (QuickJS-NG). Dados publicos: nada aqui precisa
// ser de tempo constante. Testado contra o node:crypto em tests/tube-update.test.mjs.

  // ---- SHA-512 ----
  var MASK = (1n << 64n) - 1n;
  var K = [
    "428a2f98d728ae22", "7137449123ef65cd", "b5c0fbcfec4d3b2f", "e9b5dba58189dbbc", "3956c25bf348b538", "59f111f1b605d019", "923f82a4af194f9b", "ab1c5ed5da6d8118",
    "d807aa98a3030242", "12835b0145706fbe", "243185be4ee4b28c", "550c7dc3d5ffb4e2", "72be5d74f27b896f", "80deb1fe3b1696b1", "9bdc06a725c71235", "c19bf174cf692694",
    "e49b69c19ef14ad2", "efbe4786384f25e3", "0fc19dc68b8cd5b5", "240ca1cc77ac9c65", "2de92c6f592b0275", "4a7484aa6ea6e483", "5cb0a9dcbd41fbd4", "76f988da831153b5",
    "983e5152ee66dfab", "a831c66d2db43210", "b00327c898fb213f", "bf597fc7beef0ee4", "c6e00bf33da88fc2", "d5a79147930aa725", "06ca6351e003826f", "142929670a0e6e70",
    "27b70a8546d22ffc", "2e1b21385c26c926", "4d2c6dfc5ac42aed", "53380d139d95b3df", "650a73548baf63de", "766a0abb3c77b2a8", "81c2c92e47edaee6", "92722c851482353b",
    "a2bfe8a14cf10364", "a81a664bbc423001", "c24b8b70d0f89791", "c76c51a30654be30", "d192e819d6ef5218", "d69906245565a910", "f40e35855771202a", "106aa07032bbd1b8",
    "19a4c116b8d2d0c8", "1e376c085141ab53", "2748774cdf8eeb99", "34b0bcb5e19b48a8", "391c0cb3c5c95a63", "4ed8aa4ae3418acb", "5b9cca4f7763e373", "682e6ff3d6b2b8a3",
    "748f82ee5defb2fc", "78a5636f43172f60", "84c87814a1f0ab72", "8cc702081a6439ec", "90befffa23631e28", "a4506cebde82bde9", "bef9a3f7b2c67915", "c67178f2e372532b",
    "ca273eceea26619c", "d186b8c721c0c207", "eada7dd6cde0eb1e", "f57d4f7fee6ed178", "06f067aa72176fba", "0a637dc5a2c898a6", "113f9804bef90dae", "1b710b35131c471b",
    "28db77f523047d84", "32caab7b40c72493", "3c9ebe0a15c9bebc", "431d67c49c100d4c", "4cc5d4becb3e42b6", "597f299cfc657e2a", "5fcb6fab3ad6faec", "6c44198c4a475817"
  ].map((hex) => BigInt(`0x${hex}`));
  var IV = ["6a09e667f3bcc908", "bb67ae8584caa73b", "3c6ef372fe94f82b", "a54ff53a5f1d36f1", "510e527fade682d1", "9b05688c2b3e6c1f", "1f83d9abfb41bd6b", "5be0cd19137e2179"].map((hex) => BigInt(`0x${hex}`));
  var rotr = (x, n) => (x >> n | x << 64n - n) & MASK;

  /** SHA-512 de `bytes` (array de 0..255): array de 64 bytes. */
  function sha512(bytes) {
    const length = bytes.length;
    const padded = bytes.slice();
    padded.push(128);
    while (padded.length % 128 !== 112) padded.push(0);
    const bits = BigInt(length) * 8n;
    for (let i = 15; i >= 0; i--) padded.push(Number(bits >> BigInt(i * 8) & 255n));
    const h = IV.slice();
    const w = new Array(80);
    for (let offset = 0; offset < padded.length; offset += 128) {
      for (let i = 0; i < 16; i++) {
        let word = 0n;
        for (let j = 0; j < 8; j++) word = word << 8n | BigInt(padded[offset + i * 8 + j]);
        w[i] = word;
      }
      for (let i = 16; i < 80; i++) {
        const s0 = rotr(w[i - 15], 1n) ^ rotr(w[i - 15], 8n) ^ w[i - 15] >> 7n;
        const s1 = rotr(w[i - 2], 19n) ^ rotr(w[i - 2], 61n) ^ w[i - 2] >> 6n;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 & MASK;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 80; i++) {
        const t1 = hh + (rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n)) + (e & f ^ ~e & MASK & g) + K[i] + w[i] & MASK;
        const t2 = (rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n)) + (a & b ^ a & c ^ b & c) & MASK;
        hh = g;
        g = f;
        f = e;
        e = d + t1 & MASK;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 & MASK;
      }
      [a, b, c, d, e, f, g, hh].forEach((value, i) => {
        h[i] = h[i] + value & MASK;
      });
    }
    const out = [];
    for (const word of h) for (let i = 7; i >= 0; i--) out.push(Number(word >> BigInt(i * 8) & 255n));
    return out;
  }

  // ---- Ed25519 (so verificar) ----
  var P = (1n << 255n) - 19n;
  var L = (1n << 252n) + 27742317777372353535851937790883648493n;
  var mod = (a, m = P) => {
    const r = a % m;
    return r >= 0n ? r : r + m;
  };
  function pow(base, exponent, m = P) {
    let result = 1n;
    base = mod(base, m);
    while (exponent > 0n) {
      if (exponent & 1n) result = result * base % m;
      base = base * base % m;
      exponent >>= 1n;
    }
    return result;
  }
  var inv = (a) => pow(a, P - 2n);
  var D = mod(-121665n * inv(121666n));
  var SQRT_M1 = pow(2n, (P - 1n) / 4n);
  // Pontos em coordenadas estendidas (X, Y, Z, T), x = X/Z, y = Y/Z, xy = T/Z.
  var BASE = (() => {
    const y = mod(4n * inv(5n));
    const x = recoverX(y, 0);
    return [x, y, 1n, mod(x * y)];
  })();
  var ZERO = [0n, 1n, 1n, 0n];
  function add([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) {
    const a = mod((Y1 - X1) * (Y2 - X2));
    const b = mod((Y1 + X1) * (Y2 + X2));
    const c = mod(2n * T1 * T2 * D);
    const d = mod(2n * Z1 * Z2);
    const e = b - a, f = d - c, g = d + c, h = b + a;
    return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
  }
  function multiply(point, scalar) {
    let result = ZERO;
    let addend = point;
    while (scalar > 0n) {
      if (scalar & 1n) result = add(result, addend);
      addend = add(addend, addend);
      scalar >>= 1n;
    }
    return result;
  }
  function recoverX(y, sign) {
    if (y >= P) return null;
    const x2 = mod((y * y - 1n) * inv(D * y * y + 1n));
    if (x2 === 0n) return sign ? null : 0n;
    let x = pow(x2, (P + 3n) / 8n);
    if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_M1);
    if (mod(x * x - x2) !== 0n) return null;
    if (Number(x & 1n) !== sign) x = P - x;
    return x;
  }
  var littleEndian = (bytes) => {
    let value = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) value = value << 8n | BigInt(bytes[i]);
    return value;
  };
  function decodePoint(bytes) {
    if (bytes.length !== 32) return null;
    const copy = bytes.slice();
    const sign = copy[31] >> 7;
    copy[31] &= 127;
    const y = littleEndian(copy);
    const x = recoverX(y, sign);
    return x === null ? null : [x, y, 1n, mod(x * y)];
  }
  function encodePoint([X, Y, Z]) {
    const zi = inv(Z);
    const x = mod(X * zi), y = mod(Y * zi);
    const out = [];
    let value = y;
    for (let i = 0; i < 32; i++) {
      out.push(Number(value & 255n));
      value >>= 8n;
    }
    out[31] |= Number(x & 1n) << 7;
    return out;
  }

  /** Bytes de um texto hexadecimal (par de digitos por byte), ou null. */
  function fromHex(hex) {
    if (typeof hex !== "string" || hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
    const out = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }
  /** Os bytes de um texto so ASCII (o manifesto assinado e ASCII); null com qualquer outro caractere. */
  function asciiBytes(text) {
    const out = [];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 127) return null;
      out.push(code);
    }
    return out;
  }

  /** Se `signature` (64 bytes) e a assinatura Ed25519 de `message` (bytes) pela chave `publicKey` (32 bytes). */
  function verify(signature, message, publicKey) {
    try {
      if (!Array.isArray(signature) || signature.length !== 64 || !Array.isArray(publicKey) || publicKey.length !== 32) return false;
      const A = decodePoint(publicKey);
      const R = decodePoint(signature.slice(0, 32));
      if (!A || !R) return false;
      const s = littleEndian(signature.slice(32));
      if (s >= L) return false;
      const h = mod(littleEndian(sha512([...signature.slice(0, 32), ...publicKey, ...message])), L);
      // [s]B = R + [h]A, comparado pelas codificacoes (como o RFC 8032 5.1.7, sem o cofator).
      const left = encodePoint(multiply(BASE, s));
      const right = encodePoint(add(R, multiply(A, h)));
      return left.every((byte, i) => byte === right[i]);
    } catch {
      return false;
    }
  }

export { asciiBytes, fromHex, sha512, verify };
