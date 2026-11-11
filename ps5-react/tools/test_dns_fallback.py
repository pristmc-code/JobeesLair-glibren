# Jobee'sLair (glibren-tube, 2026-11-11). SPDX-License-Identifier: GPL-3.0-or-later
"""The PS5 build's getaddrinfo wrap (native/ps5/dns_getaddrinfo.c + dns_fallback.c) on the desktop.

Which names may be looked up at a public DNS (YouTube/Google only; never Sony/PlayStation), and the wrap's choices
against a stand-in console resolver (__real_getaddrinfo in the harness below) and a stand-in public DNS on
127.0.0.1 (the servers and port are compiled in for the test). Run: python3 tools/test_dns_fallback.py"""
import socket, struct, subprocess, sys, tempfile, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT  # noqa: E402

PUBLIC_ANSWER = "142.250.79.110"

HARNESS = r'''
#define _DEFAULT_SOURCE
#include "dns_fallback.h"
#include <arpa/inet.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

int dns_getaddrinfo_blocked(const struct addrinfo *entry);
int __wrap_getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **result);
static int real_calls;

/* The console's resolver: "blocked*" and Sony names answer 0.0.0.0, "loop*" 127.0.0.1, "fail*" fails, others 1.2.3.4. */
int __real_getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **result)
{
    ++real_calls;
    *result = NULL;
    const char *dot = strchr(node, '.');
    const size_t first = dot ? (size_t)(dot - node) : strlen(node);
    const char *answer = "1.2.3.4";
    if (!strncmp(node, "fail", 4)) return EAI_NONAME;
    if (!strncmp(node, "blocked", 4) || strstr(node, "playstation") || strstr(node, "sony")) answer = "0.0.0.0";
    if (!strncmp(node, "loop", 4)) answer = "127.0.0.1";
    (void)first;
    struct addrinfo *entry = calloc(1, sizeof(struct addrinfo) + sizeof(struct sockaddr_in));
    struct sockaddr_in *in = (struct sockaddr_in *)(entry + 1);
    in->sin_family = AF_INET;
    in->sin_port = htons(service ? (unsigned short)atoi(service) : 0);
    inet_pton(AF_INET, answer, &in->sin_addr);
    entry->ai_family = AF_INET;
    entry->ai_socktype = hints && hints->ai_socktype ? hints->ai_socktype : SOCK_STREAM;
    entry->ai_addrlen = sizeof(*in);
    entry->ai_addr = (struct sockaddr *)in;
    *result = entry;
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 3 && !strcmp(argv[1], "allowed")) { printf("%d\n", dns_fallback_allowed(argv[2])); return 0; }
    if (argc >= 3 && !strcmp(argv[1], "lookup")) {
        for (int i = 2; i < argc; ++i) {
            struct addrinfo hints; memset(&hints, 0, sizeof hints);
            hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
            struct addrinfo *found = NULL;
            const int before = real_calls;
            const int status = __wrap_getaddrinfo(argv[i], "443", &hints, &found);
            char text[64] = "-";
            unsigned port = 0;
            if (status == 0 && found) {
                const struct sockaddr_in *in = (const struct sockaddr_in *)found->ai_addr;
                inet_ntop(AF_INET, &in->sin_addr, text, sizeof text);
                port = ntohs(in->sin_port);
            }
            printf("%s %d %s %u %d\n", argv[i], status == 0 ? 0 : 1, text, port, real_calls - before);
            if (found) freeaddrinfo(found);
        }
        return 0;
    }
    return 2;
}
'''


class PublicDns:
    """A UDP DNS stand-in: every A question gets PUBLIC_ANSWER; the names asked are kept."""
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.asked = []
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            data, peer = self.sock.recvfrom(1500)
            at, labels = 12, []
            while data[at]:
                labels.append(data[at + 1:at + 1 + data[at]].decode())
                at += 1 + data[at]
            question = data[12:at + 5]
            self.asked.append(".".join(labels))
            header = data[:2] + b"\x81\x80" + struct.pack(">HHHH", 1, 1, 0, 0)
            answer = b"\xc0\x0c" + struct.pack(">HHIH", 1, 1, 300, 4) + socket.inet_aton(PUBLIC_ANSWER)
            self.sock.sendto(header + question + answer, peer)


def main():
    dns = PublicDns()
    native = ROOT / "native/ps5"
    with tempfile.TemporaryDirectory(prefix="ps5-react-dns-") as tmp:
        harness = Path(tmp) / "harness.c"
        harness.write_text(HARNESS)
        binary = Path(tmp) / "dns"
        for compiler in ("gcc", "clang"):
            subprocess.run([compiler, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-I", str(native),
                            '-DDNS_FALLBACK_TEST_SERVER="127.0.0.1"', f"-DDNS_FALLBACK_PORT={dns.port}",
                            str(native / "dns_fallback.c"), str(native / "dns_getaddrinfo.c"), str(harness),
                            "-lpthread", "-o", str(binary)], check=True)
        run = lambda *args: subprocess.run([str(binary), *args], capture_output=True, text=True, check=True).stdout

        allowed = ["youtube.com", "www.youtube.com", "WWW.YOUTUBE.COM", "www.youtube.com.", "m.youtube.com", "youtu.be",
                   "rr3---sn-oxu8pnpvo-ua8z.googlevideo.com", "i.ytimg.com", "yt3.ggpht.com", "www.google.com",
                   "youtubei.googleapis.com", "fonts.gstatic.com", "lh3.googleusercontent.com", "google.com"]
        refused = ["playstation.com", "www.playstation.com", "np.playstation.net", "ps5.np.playstation.net",
                   "sonyentertainmentnetwork.com", "auth.api.sonyentertainmentnetwork.com", "update.playstation.net",
                   "youtube.com.playstation.net", "googlevideo.com.sony.net", "notyoutube.com", "evilgooglevideo.com",
                   "youtube.co", "example.com", "127.0.0.1", "", "com", "sponsor.ajay.app"]
        for host in allowed:
            assert run("allowed", host).strip() == "1", f"{host} should be allowed"
        for host in refused:
            assert run("allowed", host).strip() == "0", f"{host!r} must never reach a public DNS"

        lines = {line.split()[0]: line.split()[1:] for line in run(
            "lookup", "www.youtube.com", "blocked.googlevideo.com", "blocked.googlevideo.com", "loop.ytimg.com",
            "fail.ytimg.com", "blocked.playstation.net", "fail.playstation.com", "203.0.113.9").splitlines()}
        # A good system answer is kept; nothing goes to the public DNS.
        assert lines["www.youtube.com"] == ["0", "1.2.3.4", "443", "1"], lines["www.youtube.com"]
        # 0.0.0.0, 127.x or a failure for an allowed name: the public answer, with the port of the service asked.
        assert lines["loop.ytimg.com"] == ["0", PUBLIC_ANSWER, "443", "1"], lines["loop.ytimg.com"]
        assert lines["fail.ytimg.com"] == ["0", PUBLIC_ANSWER, "443", "1"], lines["fail.ytimg.com"]
        # Sony/PlayStation: the console's answer as it is (0.0.0.0, or the failure), never the public DNS.
        assert lines["blocked.playstation.net"] == ["0", "0.0.0.0", "443", "1"], lines["blocked.playstation.net"]
        assert lines["fail.playstation.com"] == ["1", "-", "0", "1"], lines["fail.playstation.com"]
        assert lines["203.0.113.9"] == ["0", "1.2.3.4", "443", "1"], "a numeric address goes to the system as before"
        out = run("lookup", "blocked.googlevideo.com", "blocked.googlevideo.com").splitlines()
        assert out[0].split()[1:] == ["0", PUBLIC_ANSWER, "443", "1"], out
        # Found blocked once: the cached public answer, without asking the console again.
        assert out[1].split()[1:] == ["0", PUBLIC_ANSWER, "443", "0"], out
        assert not any("playstation" in name or "sony" in name for name in dns.asked), dns.asked
        assert "www.youtube.com" not in dns.asked, dns.asked
        assert {"loop.ytimg.com", "fail.ytimg.com", "blocked.googlevideo.com"} <= set(dns.asked), dns.asked
    print("PASS: DNS fallback only for YouTube/Google names, never Sony/PlayStation; blocked answers replaced, cached")


if __name__ == "__main__":
    main()
