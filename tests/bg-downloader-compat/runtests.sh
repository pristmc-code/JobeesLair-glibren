#!/bin/bash
# Compatibilidade do payload bg-downloader (build Linux) com o motor nativo do ps5-react.
# Precisa de clang-18, libcurl e OpenSSL (dev). Uso: tests/bg-downloader-compat/runtests.sh [teste...]
# Pasta de trabalho: $BGTEST_DIR (padrao /tmp/bg-downloader-compat).
D=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$D/../.." && pwd)
T=${BGTEST_DIR:-/tmp/bg-downloader-compat}
export BGTEST_DIR=$T
mkdir -p $T
clang-18 -std=gnu11 -O2 -g -Wall -Wextra -Werror -o $T/bgdl-linux $R/app/native/bg_downloader.c -lcurl -lcrypto -larchive -lpthread || exit 1
for f in test_server.py run_tests.py native_dl.cpp; do cp $D/$f $T/$f; done
cd $T
if [ ! -x native_dl ] || [ native_dl.cpp -nt native_dl ]; then
  N=$R/ps5-react/native
  clang++-18 -std=c++20 -O2 -I$N/shared $N/shared/network.cpp $N/desktop/network_platform.cpp native_dl.cpp -lcurl -lcrypto -lpthread -o native_dl 2>&1 | tail -20
fi
mkdir -p srv
[ -f srv/data100.bin ] || head -c 104857600 /dev/urandom > srv/data100.bin
[ -f srv/data10.bin ] || head -c 10485760 /dev/urandom > srv/data10.bin
pkill -f test_server.py; sleep 0.3
python3 test_server.py $T/srv 18080 & SP=$!
sleep 1
python3 run_tests.py "$@"
R=$?
kill $SP
exit $R
