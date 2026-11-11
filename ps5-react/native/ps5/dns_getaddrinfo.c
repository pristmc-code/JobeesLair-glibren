/*
 * Jobee'sLair (glibren-tube, 2026-11-11): getaddrinfo with a public-DNS fallback for YouTube/Google hosts.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Some DNS servers used on jailbroken consoles answer 0.0.0.0 for YouTube's hosts on purpose (so the
 * official app cannot update). The PS5 build links with --wrap=getaddrinfo (tools/build_ps5.py, apps with
 * "networking": true), so every lookup the app makes (FFmpeg's http/tls for <Video>, libcurl for Http and
 * images) comes here first:
 *   - a name outside dns_fallback_allowed() (Sony/PlayStation hosts above all), a numeric address or a
 *     family other than IPv4 goes straight to the console's resolver (__real_getaddrinfo, netdb.c), as before;
 *   - an allowed name already found blocked, with a fresh public answer cached, is answered from the cache;
 *   - otherwise the console's resolver is asked; when it fails or answers 0.0.0.0, 127.x or ::, the name is
 *     looked up at 8.8.8.8, then 1.1.1.1 (dns_fallback.c: UDP 53, one A record, cached for its TTL).
 * The name itself is untouched everywhere else (TLS SNI, Host header, certificate check): only the address
 * the socket connects to changes.
 * The entry is built as netdb.c builds its own (one calloc: the addrinfo followed by its sockaddr_in), so
 * the same freeaddrinfo releases it.
 */
#if defined(__linux__) && !defined(_DEFAULT_SOURCE)
#define _DEFAULT_SOURCE
#endif

#include "dns_fallback.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

int __real_getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **result);

/* 1 when the console's answer is a blocked one: an IPv4 0.0.0.0 or 127.x, or the IPv6 :: (any entry). */
int dns_getaddrinfo_blocked(const struct addrinfo *entry)
{
    if (entry == NULL)
        return 1;
    for (; entry != NULL; entry = entry->ai_next)
    {
        if (entry->ai_addr == NULL)
            continue;
        if (entry->ai_family == AF_INET && entry->ai_addrlen >= (socklen_t)sizeof(struct sockaddr_in))
        {
            if (dns_fallback_blocked_answer(((const struct sockaddr_in *)entry->ai_addr)->sin_addr))
                return 1;
        }
        else if (entry->ai_family == AF_INET6 && entry->ai_addrlen >= (socklen_t)sizeof(struct sockaddr_in6))
        {
            static const unsigned char any[16] = {0};
            if (memcmp(&((const struct sockaddr_in6 *)entry->ai_addr)->sin6_addr, any, sizeof(any)) == 0)
                return 1;
        }
    }
    return 0;
}

static int entry_for(struct in_addr address, const char *service, const struct addrinfo *hints, struct addrinfo **result)
{
    unsigned long port = 0;
    if (service != NULL)
    {
        char *end = NULL;
        errno = 0;
        port = strtoul(service, &end, 10);
        if (service[0] < '0' || service[0] > '9' || *end != '\0' || errno != 0 || port > 65535)
            return EAI_SERVICE;
    }
    struct addrinfo *entry = calloc(1, sizeof(struct addrinfo) + sizeof(struct sockaddr_in));
    if (entry == NULL)
        return EAI_MEMORY;
    struct sockaddr_in *in = (struct sockaddr_in *)(entry + 1);
#ifndef __linux__
    in->sin_len = sizeof(*in);
#endif
    in->sin_family = AF_INET;
    in->sin_port = htons((uint16_t)port);
    in->sin_addr = address;
    entry->ai_family = AF_INET;
    entry->ai_socktype = hints != NULL && hints->ai_socktype != 0 ? hints->ai_socktype : SOCK_STREAM;
    entry->ai_protocol = hints != NULL ? hints->ai_protocol : 0;
    entry->ai_addrlen = sizeof(*in);
    entry->ai_addr = (struct sockaddr *)in;
    *result = entry;
    return 0;
}

int __wrap_getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **result)
{
    const int family = hints != NULL ? hints->ai_family : AF_UNSPEC;
    struct in_addr numeric;
    if (node == NULL || result == NULL || !dns_fallback_allowed(node) || (family != AF_UNSPEC && family != AF_INET) ||
        (hints != NULL && (hints->ai_flags & AI_NUMERICHOST) != 0) || inet_pton(AF_INET, node, &numeric) == 1)
        return __real_getaddrinfo(node, service, hints, result);
    struct in_addr address;
    if (dns_fallback_cached(node, &address))
        return entry_for(address, service, hints, result);
    const int system = __real_getaddrinfo(node, service, hints, result);
    if (system == 0 && !dns_getaddrinfo_blocked(*result))
        return 0;
    if (system == 0)
    {
        freeaddrinfo(*result);
        *result = NULL;
    }
    const char *server = NULL;
    if (dns_fallback_resolve(node, &address, &server) == 0)
    {
        dns_fallback_log("dns: %s blocked by the console's DNS (%d); %s answered", node, system, server ? server : "?");
        return entry_for(address, service, hints, result);
    }
    dns_fallback_log("dns: %s blocked by the console's DNS (%d) and the public lookup failed", node, system);
    return system != 0 ? system : EAI_NONAME;
}
