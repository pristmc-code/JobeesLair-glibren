// Driver do motor nativo do ps5-react (native/shared/network.cpp) para os testes de compatibilidade:
// native_dl URL DESTINO RAIZ [pararDepoisDeBytes] [sha256] [expectedBytes]
// Sai 0 = completed, 2 = cancelled (parado de proposito), 1 = failed.
#include "network.hpp"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>

int main(int argc, char** argv) {
  if (argc < 4) { std::fprintf(stderr, "uso: native_dl URL DEST ROOT [stopAfter] [sha256] [expected]\n"); return 64; }
  std::uint64_t stop_after = argc > 4 ? std::strtoull(argv[4], nullptr, 10) : 0;
  if (!network::start()) { std::fprintf(stderr, "network::start falhou\n"); return 1; }
  network::Request r;
  r.url = argv[1]; r.destination = argv[2]; r.storage_root = argv[3];
  r.range_bytes = 16 * 1024 * 1024; r.connections = 8; r.recover_completed = true; r.reject_html = true;
  if (argc > 5 && argv[5][0] && std::string(argv[5]) != "-") r.sha256 = argv[5];
  if (argc > 6) r.expected_bytes = std::strtoull(argv[6], nullptr, 10);
  std::string error;
  auto id = network::enqueue(r, error);
  if (!id) { std::fprintf(stderr, "enqueue: %s\n", error.c_str()); return 1; }
  bool cancelled = false;
  for (;;) {
    for (const auto& s : network::poll()) {
      if (s.id != id) continue;
      if (stop_after && !cancelled && s.written >= stop_after) { network::cancel(id); cancelled = true; }
      if (s.state == "completed" || s.state == "failed" || s.state == "cancelled") {
        std::printf("%s written=%llu total=%llu error=%s\n", s.state.c_str(), (unsigned long long)s.written, (unsigned long long)s.total, s.error.c_str());
        network::stop();
        return s.state == "completed" ? 0 : s.state == "cancelled" ? 2 : 1;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
}
