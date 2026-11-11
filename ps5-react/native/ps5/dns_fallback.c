/*
 * youtube-tv - Own name lookup for YouTube/Google hosts; see dns_fallback.h.
 * Copyright (C) 2026 PristMC
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Modified for Jobee'sLair (glibren-tube, 2026-11-11) from ytps5 src/platform/ps5/dns_fallback.c:
 * the query goes with sendto/recvfrom and the answer is awaited with poll() (as native/shared/lan.cpp does)
 * instead of connect/send/recv and SO_RCVTIMEO, and the
 * host tests (tools/test_dns_fallback.py) may point the servers and the port at a local stand-in.
 */

/* The host tests build with -std=c11: ask glibc for POSIX/BSD names too. */
#if defined(__linux__) && !defined(_DEFAULT_SOURCE)
#define _DEFAULT_SOURCE
#endif

#include "dns_fallback.h"

#include <arpa/inet.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

enum
{
    DNS_CACHE_SLOTS = 48,
    DNS_TTL_MIN = 60,     /* seconds: never ask again sooner */
    DNS_TTL_MAX = 3600,   /* seconds: never keep longer */
    DNS_TIMEOUT_MS = 2000 /* per server */
};

#ifdef DNS_FALLBACK_TEST_SERVER
static const char *const dns_servers[] = {DNS_FALLBACK_TEST_SERVER};
#else
static const char *const dns_servers[] = {"8.8.8.8", "1.1.1.1"};
#endif
#ifndef DNS_FALLBACK_PORT
#define DNS_FALLBACK_PORT 53
#endif

/* The YouTube/Google domains the app talks to (innertube, sign-in, pictures,
 * video). Nothing from Sony/PlayStation may ever be added here. */
static const char *const dns_domains[] = {
    "youtube.com", "youtu.be",        "googleapis.com",        "ytimg.com",
    "ggpht.com",   "googlevideo.com", "googleusercontent.com", "google.com",
    "gstatic.com",
};

int dns_fallback_allowed(const char *host)
{
    if (host == NULL)
        return 0;
    size_t length = strlen(host);
    if (length > 0 && host[length - 1] == '.')
        --length; /* "www.youtube.com." */
    if (length == 0 || length > 253)
        return 0;
    for (size_t i = 0; i < sizeof(dns_domains) / sizeof(dns_domains[0]); ++i)
    {
        const size_t domain = strlen(dns_domains[i]);
        if (length < domain || strncasecmp(host + length - domain, dns_domains[i], domain) != 0)
            continue;
        if (length == domain || host[length - domain - 1] == '.')
            return 1;
    }
    return 0;
}

int dns_fallback_blocked_answer(struct in_addr address)
{
    const uint32_t value = ntohl(address.s_addr);
    return value == 0 || (value >> 24) == 127;
}

size_t dns_fallback_build_query(const char *host, uint16_t id, uint8_t *out, size_t size)
{
    if (host == NULL || out == NULL || size < 18)
        return 0;
    size_t n = 0;
    const uint8_t header[12] = {(uint8_t)(id >> 8),
                                (uint8_t)id,
                                0x01,
                                0x00,
                                0x00,
                                0x01,
                                0x00,
                                0x00,
                                0x00,
                                0x00,
                                0x00,
                                0x00};
    memcpy(out, header, sizeof(header));
    n = sizeof(header);
    for (const char *p = host; *p != '\0';)
    {
        const size_t label = strcspn(p, ".");
        if (label == 0 || label > 63 || n + 1 + label + 5 > size)
            return 0;
        out[n++] = (uint8_t)label;
        memcpy(out + n, p, label);
        n += label;
        p += label;
        if (*p == '.')
            ++p;
    }
    if (n == sizeof(header))
        return 0;
    out[n++] = 0;
    out[n++] = 0;
    out[n++] = 1; /* type A */
    out[n++] = 0;
    out[n++] = 1; /* class IN */
    return n;
}

/* Past a (possibly compressed) name; 0 when it runs off the end. */
static size_t dns_skip_name(const uint8_t *data, size_t length, size_t at)
{
    for (int labels = 0; at < length && labels < 128; ++labels)
    {
        const uint8_t byte = data[at];
        if (byte == 0)
            return at + 1;
        if ((byte & 0xc0) == 0xc0)
            return at + 2 <= length ? at + 2 : 0;
        if ((byte & 0xc0) != 0)
            return 0;
        at += 1u + byte;
    }
    return 0;
}

int dns_fallback_parse_answer(const uint8_t *answer, size_t length, uint16_t id,
                              struct in_addr *address, uint32_t *ttl)
{
    if (answer == NULL || length < 12)
        return -1;
    if (((answer[0] << 8) | answer[1]) != id || (answer[2] & 0x80) == 0 || (answer[3] & 0x0f) != 0)
        return -1; /* other query, not an answer, or an error code */
    const unsigned questions = (unsigned)((answer[4] << 8) | answer[5]);
    const unsigned answers = (unsigned)((answer[6] << 8) | answer[7]);
    size_t at = 12;
    for (unsigned q = 0; q < questions; ++q)
    {
        at = dns_skip_name(answer, length, at);
        if (at == 0 || at + 4 > length)
            return -1;
        at += 4;
    }
    for (unsigned a = 0; a < answers; ++a)
    {
        at = dns_skip_name(answer, length, at);
        if (at == 0 || at + 10 > length)
            return -1;
        const unsigned type = (unsigned)((answer[at] << 8) | answer[at + 1]);
        const unsigned klass = (unsigned)((answer[at + 2] << 8) | answer[at + 3]);
        const uint32_t seconds = ((uint32_t)answer[at + 4] << 24) |
                                 ((uint32_t)answer[at + 5] << 16) |
                                 ((uint32_t)answer[at + 6] << 8) | answer[at + 7];
        const size_t data = (size_t)((answer[at + 8] << 8) | answer[at + 9]);
        at += 10;
        if (at + data > length)
            return -1;
        if (type == 1 && klass == 1 && data == 4)
        {
            struct in_addr found;
            memcpy(&found.s_addr, answer + at, 4);
            if (dns_fallback_blocked_answer(found))
                return -1;
            *address = found;
            *ttl = seconds;
            return 0;
        }
        at += data; /* CNAME and the like: the A record follows */
    }
    return -1;
}

static uint16_t dns_new_id(void)
{
    static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
    static uint32_t state;
    pthread_mutex_lock(&lock);
    if (state == 0)
    {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        state = (uint32_t)now.tv_nsec ^ (uint32_t)now.tv_sec * 2654435761u ^ (uint32_t)getpid();
        if (state == 0)
            state = 0x9e3779b9u;
    }
    state ^= state << 13; /* xorshift32 */
    state ^= state >> 17;
    state ^= state << 5;
    const uint16_t id = (uint16_t)(state ^ (state >> 16));
    pthread_mutex_unlock(&lock);
    return id;
}

int dns_fallback_query(const char *server, const char *host, int timeout_ms,
                       struct in_addr *address, uint32_t *ttl)
{
    uint8_t query[300];
    uint8_t answer[1500];
    const uint16_t id = dns_new_id();
    const size_t length = dns_fallback_build_query(host, id, query, sizeof(query));
    if (length == 0)
        return -1;
    struct sockaddr_in to;
    memset(&to, 0, sizeof(to));
    to.sin_family = AF_INET;
    to.sin_port = htons(DNS_FALLBACK_PORT);
    if (inet_pton(AF_INET, server, &to.sin_addr) != 1)
        return -1;
    const int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (fd < 0)
        return -1;
    int result = -1;
    /* sendto/recvfrom and poll, the calls native/shared/lan.cpp already makes from the title. */
    if (sendto(fd, query, length, 0, (const struct sockaddr *)&to, sizeof(to)) == (ssize_t)length)
    {
        /* A stray datagram (an old id) does not end the wait at once. */
        for (int tries = 0; tries < 3 && result != 0; ++tries)
        {
            struct pollfd ready = {fd, POLLIN, 0};
            if (poll(&ready, 1, timeout_ms) <= 0 || (ready.revents & POLLIN) == 0)
                break;
            struct sockaddr_in from;
            socklen_t from_size = sizeof(from);
            const ssize_t got = recvfrom(fd, answer, sizeof(answer), 0, (struct sockaddr *)&from, &from_size);
            if (got <= 0)
                break;
            if (from.sin_addr.s_addr != to.sin_addr.s_addr || from.sin_port != to.sin_port)
                continue; /* not from the server asked */
            result = dns_fallback_parse_answer(answer, (size_t)got, id, address, ttl);
        }
    }
    close(fd);
    return result;
}

/* ---- Cache --------------------------------------------------------------------------------- */

static pthread_mutex_t dns_lock = PTHREAD_MUTEX_INITIALIZER;
static struct
{
    char host[256];
    struct in_addr address;
    time_t expires;
} dns_cache[DNS_CACHE_SLOTS];

static time_t dns_now(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return now.tv_sec;
}

int dns_fallback_cached(const char *host, struct in_addr *address)
{
    int found = 0;
    const time_t now = dns_now();
    pthread_mutex_lock(&dns_lock);
    for (int i = 0; i < DNS_CACHE_SLOTS; ++i)
    {
        if (dns_cache[i].host[0] != '\0' && strcasecmp(dns_cache[i].host, host) == 0 &&
            dns_cache[i].expires > now)
        {
            *address = dns_cache[i].address;
            found = 1;
            break;
        }
    }
    pthread_mutex_unlock(&dns_lock);
    return found;
}

static void dns_remember(const char *host, struct in_addr address, uint32_t ttl)
{
    if (ttl < DNS_TTL_MIN)
        ttl = DNS_TTL_MIN;
    if (ttl > DNS_TTL_MAX)
        ttl = DNS_TTL_MAX;
    const time_t now = dns_now();
    pthread_mutex_lock(&dns_lock);
    int slot = -1;
    int oldest = 0;
    for (int i = 0; i < DNS_CACHE_SLOTS; ++i)
    {
        if (strcasecmp(dns_cache[i].host, host) == 0)
        {
            slot = i;
            break;
        }
        if (slot < 0 && dns_cache[i].host[0] == '\0')
            slot = i;
        if (dns_cache[i].expires < dns_cache[oldest].expires)
            oldest = i;
    }
    if (slot < 0)
        slot = oldest;
    snprintf(dns_cache[slot].host, sizeof(dns_cache[slot].host), "%s", host);
    dns_cache[slot].address = address;
    dns_cache[slot].expires = now + (time_t)ttl;
    pthread_mutex_unlock(&dns_lock);
}

int dns_fallback_resolve(const char *host, struct in_addr *address, const char **server)
{
    if (!dns_fallback_allowed(host))
        return -1;
    if (dns_fallback_cached(host, address))
    {
        if (server != NULL)
            *server = "cache";
        return 0;
    }
    for (size_t i = 0; i < sizeof(dns_servers) / sizeof(dns_servers[0]); ++i)
    {
        uint32_t ttl = 0;
        if (dns_fallback_query(dns_servers[i], host, DNS_TIMEOUT_MS, address, &ttl) == 0)
        {
            dns_remember(host, *address, ttl);
            if (server != NULL)
                *server = dns_servers[i];
            return 0;
        }
    }
    return -1;
}

/* ---- Log ----------------------------------------------------------------------------------- */

static dns_fallback_logger dns_logger;

void dns_fallback_set_logger(dns_fallback_logger logger)
{
    dns_logger = logger;
}

void dns_fallback_log(const char *format, ...)
{
    const dns_fallback_logger logger = dns_logger;
    if (logger == NULL)
        return;
    char text[320];
    va_list arguments;
    va_start(arguments, format);
    (void)vsnprintf(text, sizeof(text), format, arguments);
    va_end(arguments);
    logger(text);
}
