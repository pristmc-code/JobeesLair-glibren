// Copyright (C) 2026 half144 and PS5 React contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Additional attribution term: see LICENSE-ATTRIBUTION.
// Download lanes (network::set_concurrency): <origin> <directory> <lanes> <files> [request]
// downloads <files> copies of <origin>/slow-lanes side by side and, with "request", asks <origin>/json while they run.
// Prints one JSON line: the lanes in use, the most files seen downloading at once, and each task's end.
#include "network.hpp"
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <map>
#include <string>
#include <thread>

int main(int argc, char** argv) {
  if (argc < 5 || !network::start()) return 2;
  const std::string origin = argv[1], directory = argv[2];
  const unsigned lanes = network::set_concurrency(static_cast<unsigned>(std::atoi(argv[3])));
  const unsigned files = static_cast<unsigned>(std::atoi(argv[4]));
  const bool ask = argc > 5 && std::string(argv[5]) == "request";
  std::map<std::uint32_t, std::string> names;
  std::string error;
  for (unsigned i = 0; i < files; ++i) {
    network::Request request;
    request.url = origin + "/slow-lanes";
    request.destination = directory + "/lane" + std::to_string(i);
    request.connections = 2; request.range_bytes = 1024*1024; request.adaptive = false;
    const auto id = network::enqueue(std::move(request), error);
    if (!id) { std::cerr << error << '\n'; network::stop(); return 4; }
    names[id] = "file" + std::to_string(i);
  }
  if (ask) {
    network::Request request;
    request.url = origin + "/json";
    const auto id = network::enqueue(std::move(request), error);
    if (!id) { std::cerr << error << '\n'; network::stop(); return 4; }
    names[id] = "request";
  }
  unsigned most = 0;
  std::map<std::string, std::string> ends;
  std::map<std::string, long long> at;
  const auto started = std::chrono::steady_clock::now();
  while (ends.size() < names.size()) {
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count();
    if (elapsed > 60000) { for (const auto& item : names) network::cancel(item.first); }
    unsigned downloading = 0;
    for (const auto& result : network::poll()) {
      const std::string& name = names[result.id];
      if (result.state == "downloading" && name != "request") ++downloading;
      if ((result.state == "completed" || result.state == "failed" || result.state == "cancelled") && !ends.count(name)) {
        ends[name] = result.state; at[name] = elapsed;
      }
    }
    most = std::max(most, downloading);
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  std::cout << "{\"lanes\":" << lanes << ",\"most\":" << most;
  for (const auto& [name, state] : ends) std::cout << ",\"" << name << "\":[\"" << state << "\"," << at[name] << "]";
  std::cout << "}\n";
  network::stop();
  return 0;
}
