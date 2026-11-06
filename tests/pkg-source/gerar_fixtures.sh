#!/bin/bash
# Gera os pacotes de teste do leitor de .pkg (tests/pkg-source/*.pkg) com o construtor aberto de FPKG do ps5upload
# (vendorizado no ps5-dump-forge, GPL-3) e confere cada um com o leitor do proprio ps5-dump-forge.
# Uso (Linux/WSL, com Rust): gerar_fixtures.sh <pasta_saida> [<clone do ps5-dump-forge>]
#   - o clone e compilado aqui (cargo build da CLI e de um exemplo "mkpkg" no crate vendor/ps5upload-fpkg);
#   - saida: <pasta>/*.pkg e <pasta>/*.sha256 (sha256 de cada arquivo extraido pelo ps5-dump-forge).
set -e
OUT=${1:?pasta de saida}
FORGE=${2:-$HOME/ps5-dump-forge}
export PATH="$HOME/.cargo/bin:$PATH"
[ -d "$FORGE" ] || git clone --depth 1 https://github.com/quer3q/ps5-dump-forge "$FORGE"
mkdir -p "$FORGE/vendor/ps5upload-fpkg/examples"
cat > "$FORGE/vendor/ps5upload-fpkg/examples/mkpkg.rs" <<'RS'
// mkpkg <pasta> <saida_dir> [nome]: modo e nivel pelo ambiente (PS5UPLOAD_FPKG_IMAGE_MODE=native,
// PS5UPLOAD_FPKG_LEVEL=fast|balanced|stored, PS5UPLOAD_FPKG_KRAKEN=0). Data e seed fixos (pacote reproduzivel).
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mut req = ps5upload_fpkg::build::BuildRequest::new(&a[1], &a[2]);
    if let Some(n) = a.get(3) { req.file_name = Some(n.clone()); }
    req.time = Some((1_700_000_000, 0));
    req.seed = Some(*b"0123456789abcdef");
    match ps5upload_fpkg::build::build(&req, &mut |m| eprintln!("{m}")) {
        Ok(r) => println!("{} {}", r.path.display(), r.size),
        Err(e) => { eprintln!("ERRO: {e}"); std::process::exit(1) }
    }
}
RS
[ -f "$FORGE/rust-toolchain.toml" ] && mv "$FORGE/rust-toolchain.toml" "$FORGE/rust-toolchain.toml.off"
(cd "$FORGE" && cargo build --release -q -p ps5-dump-forge-cli && cd vendor/ps5upload-fpkg && cargo build --release -q --example mkpkg)
MK=$FORGE/target/release/examples/mkpkg
CLI=$FORGE/target/release/ps5-dump-forge

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
python3 -I - "$TMP" <<'PY'
import os, sys, random, json
root = sys.argv[1]
rng = random.Random(7)
def put(base, path, data):
    full = os.path.join(root, base, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'wb') as f: f.write(data)
rb = lambda n: bytes(rng.getrandbits(8) for _ in range(n))
cid = 'UP9999-PPSA99999_00-GLIBRENPKGSRC001'
param = {'contentId': cid, 'titleId': 'PPSA99999', 'contentVersion': '01.000.000', 'applicationCategoryType': 0,
         'applicationDrmType': 'standard', 'localizedParameters': {'defaultLanguage': 'en-US', 'en-US': {'titleName': 'Glibren Teste'}}}
J = 'jogo'
put(J, 'eboot.bin', bytes(i % 251 for i in range(70000)))
put(J, 'sce_sys/param.json', json.dumps(param, indent=2).encode())
put(J, 'sce_sys/icon0.png', rb(2048))
put(J, 'sce_sys/pic0.png', rb(1024))
put(J, 'sce_sys/snd0.at9', rb(3000))
put(J, 'sce_sys/trophy2/trophy00.ucp', rb(500))
put(J, 'sce_sys/nptitle.dat', rb(64))
# arquivo de ~3 MB que mistura texto (LZ), aleatorio (cru), zeros (esparso/LZ) e registros (literais delta)
big = bytearray()
k = 0
while len(big) < 3 * 1024 * 1024 + 12345:
    kind = k % 4
    if kind == 0: big += b''.join(b'%d lorem ipsum dolor sit amet %d\n' % (i, i * 7) for i in range(k * 1000, k * 1000 + 2500))
    elif kind == 1: big += rb(90000)
    elif kind == 2: big += bytes(200000)
    else:
        for i in range(20000): big += (i * 3).to_bytes(4, 'little') + (1000 + i // 7).to_bytes(4, 'little') + bytes([i % 5, 0x40, 0, 0])
    k += 1
put(J, 'data/big.bin', bytes(big[:3 * 1024 * 1024 + 12345]))
put(J, 'data/zero.bin', b'')
put(J, 'data/um.bin', b'x')
put(J, 'data/b128k.bin', rb(128 * 1024))
put(J, 'data/b128k1.bin', rb(128 * 1024 + 1))
put(J, 'data/b256k.bin', bytes(i * 31 % 256 for i in range(256 * 1024)))
put(J, 'data/nested/deep/leaf.txt', b'leaf\n')
put(J, 'data/ünïcöde.txt', 'unicode ção\n'.encode())
for i in range(40): put(J, 'data/many/f%02d.bin' % i, rb(10 + i * 37))
os.makedirs(os.path.join(root, J, 'data/empty'))
os.makedirs(os.path.join(root, J, 'emptytop/inner'))
# DLC: sem eboot, param.json sem categoria (o construtor marca 0x21)
D = 'dlc'
put(D, 'sce_sys/param.json', json.dumps({'contentId': 'UP9999-PPSA99999_00-GLIBRENDLC000001', 'titleId': 'PPSA99999'}).encode())
put(D, 'data/dlc.bin', rb(5000) + bytes(100000))
# mini: arvore pequena para os pacotes sem compressao (stored e plano), que ficam do tamanho do jogo
M = 'mini'
put(M, 'eboot.bin', bytes(i % 7 for i in range(5000)))
put(M, 'sce_sys/param.json', json.dumps(dict(param, contentId='UP9999-PPSA99999_00-GLIBRENPKGMINI01')).encode())
put(M, 'data/a.txt', b''.join(b'%d mini\n' % i for i in range(20000)))
put(M, 'data/sub/b.bin', rb(70000) + bytes(200000))
PY

mkdir -p "$OUT"
build() { # nome pasta [VAR=valor...]
  local name=$1 src=$2; shift 2
  env "$@" "$MK" "$TMP/$src" "$OUT" "$name" >/dev/null 2>"$TMP/$name.log" || { cat "$TMP/$name.log"; exit 1; }
}
build jogo_fast jogo PS5UPLOAD_FPKG_LEVEL=fast
build jogo_balanced jogo PS5UPLOAD_FPKG_LEVEL=balanced
build mini_stored mini PS5UPLOAD_FPKG_LEVEL=stored
build jogo_native jogo PS5UPLOAD_FPKG_LEVEL=fast PS5UPLOAD_FPKG_IMAGE_MODE=native
build dlc dlc PS5UPLOAD_FPKG_LEVEL=fast
build mini_flat mini PS5UPLOAD_FPKG_KRAKEN=0

# referencia: o leitor do ps5-dump-forge extrai cada pacote; sha256 de cada arquivo
for p in jogo_fast jogo_balanced jogo_native dlc mini_stored; do
  rm -rf "$TMP/x"
  "$CLI" convert "$OUT/$p.pkg" --to folder -o "$TMP/x" >/dev/null
  (cd "$TMP/x" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | while read -r f; do
    printf '%s %s %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c %s "$f")" "$f"; done) > "$OUT/$p.sha256"
done
# fonte original (para conferir que o pacote guarda o que entrou)
(cd "$TMP/jogo" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | while read -r f; do
  printf '%s %s %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c %s "$f")" "$f"; done) > "$OUT/jogo_fonte.sha256"
ls -la "$OUT"
