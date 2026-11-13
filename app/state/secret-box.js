// A small authenticated cipher for short secrets kept on disk (the debrid API keys in debrid.json), in plain JavaScript:
// the runtime gives the app no crypto API. SHA-256 (FIPS 180-4) and HMAC-SHA-256 (RFC 2104); the cipher is
// HMAC-SHA-256 in counter mode as a keystream, the box authenticated with HMAC-SHA-256 (encrypt-then-MAC), each key
// derived from the one secret by HMAC with its own label.
//
// What it is for: a copy of the data folder (a backup, a shared screenshot of the file, a folder sent for help) does
// not carry a usable key, because the secret it is sealed with is kept in another place. What it is not: protection
// from anyone with full access to the console, who can read the secret as well as the app does.
//
// A box is "v1.<nonce hex>.<cipher hex>.<mac hex>". open() returns null for anything it cannot vouch for.

var K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

/** UTF-8 bytes of `text` (no TextEncoder in the runtime). */
function utf8(text) {
  const bytes = [];
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | code >> 6, 0x80 | code & 63);
    else if (code < 0x10000) bytes.push(0xe0 | code >> 12, 0x80 | code >> 6 & 63, 0x80 | code & 63);
    else bytes.push(0xf0 | code >> 18, 0x80 | code >> 12 & 63, 0x80 | code >> 6 & 63, 0x80 | code & 63);
  }
  return bytes;
}

/** The text of UTF-8 `bytes`, or null when they are not valid UTF-8. */
function fromUtf8(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; ) {
    const first = bytes[i];
    const length = first < 0x80 ? 1 : first >> 5 === 6 ? 2 : first >> 4 === 14 ? 3 : first >> 3 === 30 ? 4 : 0;
    if (!length || i + length > bytes.length) return null;
    let code = length === 1 ? first : first & (0xff >> (length + 1));
    for (let j = 1; j < length; j++) {
      if (bytes[i + j] >> 6 !== 2) return null;
      code = code << 6 | bytes[i + j] & 63;
    }
    text += String.fromCodePoint(code);
    i += length;
  }
  return text;
}

var hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
function fromHex(text) {
  if (typeof text !== "string" || text.length % 2 || /[^0-9a-f]/i.test(text)) return null;
  const bytes = [];
  for (let i = 0; i < text.length; i += 2) bytes.push(parseInt(text.slice(i, i + 2), 16));
  return bytes;
}

/** SHA-256 of a byte array, as 32 bytes. */
function sha256(bytes) {
  const length = bytes.length;
  const padded = [...bytes, 0x80];
  while (padded.length % 64 !== 56) padded.push(0);
  const high = Math.floor(length / 0x20000000), low = length * 8 >>> 0;
  padded.push(high >>> 24 & 255, high >>> 16 & 255, high >>> 8 & 255, high & 255, low >>> 24, low >>> 16 & 255, low >>> 8 & 255, low & 255);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  const rotr = (x, n) => x >>> n | x << 32 - n;
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = (padded[block + i * 4] << 24 | padded[block + i * 4 + 1] << 16 | padded[block + i * 4 + 2] << 8 | padded[block + i * 4 + 3]) >>> 0;
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (e & f ^ ~e & g) + K[i] + w[i] >>> 0;
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) >>> 0;
      k = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    [a, b, c, d, e, f, g, k].forEach((value, i) => {
      h[i] = h[i] + value >>> 0;
    });
  }
  return h.flatMap((value) => [value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255]);
}

/** HMAC-SHA-256 of `bytes` under `key` (byte arrays), as 32 bytes. */
function hmac(key, bytes) {
  const block = key.length > 64 ? sha256(key) : [...key];
  while (block.length < 64) block.push(0);
  return sha256([...block.map((byte) => byte ^ 0x5c), ...sha256([...block.map((byte) => byte ^ 0x36), ...bytes])]);
}

var keysOf = (secret) => {
  const root = utf8(secret);
  return { cipher: hmac(root, utf8("JobeesLair secret box v1: cipher")), mac: hmac(root, utf8("JobeesLair secret box v1: mac")) };
};
function keystream(key, nonce, length) {
  const stream = [];
  for (let counter = 0; stream.length < length; counter++) stream.push(...hmac(key, [...nonce, counter >>> 24, counter >>> 16 & 255, counter >>> 8 & 255, counter & 255]));
  return stream;
}

/**
 * `text` sealed with `secret` (a string: what the keys are derived from). `entropy` is any fresh random text; its hash
 * (with the time) is the box's nonce, so the same key sealed twice gives two different boxes.
 */
function seal(text, secret, entropy = "") {
  if (!secret) throw new Error("No secret to seal with.");
  const keys = keysOf(secret);
  const nonce = sha256(utf8(`${entropy}|${Date.now()}|${Math.random()}`)).slice(0, 16);
  const plain = utf8(text);
  const stream = keystream(keys.cipher, nonce, plain.length);
  const cipher = plain.map((byte, i) => byte ^ stream[i]);
  const mac = hmac(keys.mac, [...utf8("v1"), ...nonce, ...cipher]);
  return `v1.${hex(nonce)}.${hex(cipher)}.${hex(mac)}`;
}

/** The text in `box` when it was sealed with `secret` and not changed since, else null. */
function open(box, secret) {
  if (!secret || typeof box !== "string") return null;
  const [version, ...parts] = box.split(".");
  if (version !== "v1" || parts.length !== 3) return null;
  const [nonce, cipher, mac] = parts.map(fromHex);
  if (!nonce || nonce.length !== 16 || !cipher || !mac || mac.length !== 32) return null;
  const keys = keysOf(secret);
  const expected = hmac(keys.mac, [...utf8("v1"), ...nonce, ...cipher]);
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= expected[i] ^ mac[i];
  if (difference) return null;
  const stream = keystream(keys.cipher, nonce, cipher.length);
  return fromUtf8(cipher.map((byte, i) => byte ^ stream[i]));
}

/** 64 hex characters derived from `entropy` (random text) and the moment: a new secret. */
var newSecret = (entropy) => hex(sha256(utf8(`${entropy}|${Date.now()}|${Math.random()}|${Math.random()}`)));

export { fromUtf8, hex, hmac, newSecret, open, seal, sha256, utf8 };
