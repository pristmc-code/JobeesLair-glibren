/*
 * youtube-tv - Own name lookup for YouTube/Google hosts.
 * Copyright (C) 2026 PristMC
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Some DNS servers used on jailbroken consoles answer 0.0.0.0 for YouTube's
 * hosts on purpose (so the official app cannot update). The app keeps the
 * console's DNS for everything else and, only for the YouTube/Google hosts it
 * talks to, asks a public DNS (8.8.8.8, then 1.1.1.1) itself: one plain UDP
 * query for an A record, short timeout, cached for the answer's TTL.
 * The name stays the same everywhere else (TLS SNI, Host header, certificate
 * check): only the address the socket connects to changes.
 *
 * Never used for Sony/PlayStation hosts: dns_fallback_allowed() is the list.
 * Plain POSIX sockets, so the same file builds and runs on a PC for tests.
 *
 * Copied for Jobee'sLair (glibren-tube, 2026-11-11) from ytps5 src/platform/ps5/dns_fallback.h; used by
 * native/ps5/dns_getaddrinfo.c (the --wrap=getaddrinfo of the PS5 build) for FFmpeg's and libcurl's lookups.
 */

#ifndef YOUTUBE_TV_DNS_FALLBACK_H
#define YOUTUBE_TV_DNS_FALLBACK_H

#include <netinet/in.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C"
{
#endif

    /* 1 when `host` is one of the YouTube/Google hosts the app may resolve
     * itself (the name or a subdomain of youtube.com, youtu.be,
     * googleapis.com, ytimg.com, ggpht.com, googlevideo.com,
     * googleusercontent.com, google.com, gstatic.com). 0 otherwise. */
    int dns_fallback_allowed(const char *host);

    /* 1 when a system answer means "blocked": 0.0.0.0, 127.x.x.x. */
    int dns_fallback_blocked_answer(struct in_addr address);

    /* Builds a DNS query (A, IN, recursion desired) for `host` into `out`.
     * Returns its length, or 0 when the name does not fit. */
    size_t dns_fallback_build_query(const char *host, uint16_t id, uint8_t *out, size_t size);

    /* Reads the first usable A record of an answer to query `id`. 0 on success
     * (address and ttl filled), -1 when the answer is malformed, an error,
     * has no A record or the record is 0.0.0.0. */
    int dns_fallback_parse_answer(const uint8_t *answer, size_t length, uint16_t id,
                                  struct in_addr *address, uint32_t *ttl);

    /* One UDP query to `server` (dotted IPv4). 0 on success. */
    int dns_fallback_query(const char *server, const char *host, int timeout_ms,
                           struct in_addr *address, uint32_t *ttl);

    /* Cached lookup through 8.8.8.8, then 1.1.1.1. 0 on success; `server`
     * (optional) receives the server that answered, "cache" when cached. */
    int dns_fallback_resolve(const char *host, struct in_addr *address, const char **server);

    /* 1 (and the cached address) when `host` was already found blocked by the
     * console's DNS and has a fresh public answer: the system lookup can be
     * skipped. */
    int dns_fallback_cached(const char *host, struct in_addr *address);

    /* Where the "dns: ..." lines go (the app passes its yt.log writer).
     * NULL keeps the lookup silent. */
    typedef void (*dns_fallback_logger)(const char *text);
    void dns_fallback_set_logger(dns_fallback_logger logger);
    void dns_fallback_log(const char *format, ...) __attribute__((format(printf, 1, 2)));

#ifdef __cplusplus
}
#endif

#endif /* YOUTUBE_TV_DNS_FALLBACK_H */
