# Servidor HTTP de teste para o bg-downloader: Range/If-Range/ETag, links com token que vencem (403),
# um TorBox falso (requestdl), arquivo virtual > 4 GB e limite de velocidade por conexao.
import hashlib, json, os, random, sys, threading, time, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = sys.argv[1]
PORT = int(sys.argv[2])
KEY = "TESTKEY-1234567890abcdef-0000"
BIG_SIZE = 4 * 1024**3 + 40 * 1024**2
BLOCK = random.Random(7).randbytes(1024 * 1024)
state = {"rate": 0, "tokens": set(), "served": {}, "requestdl": 0, "lock": threading.Lock(), "fail_ranges": 0}

def big_slice(start, end):  # [start, end)
    out = bytearray()
    pos = start
    while pos < end:
        off = pos % len(BLOCK)
        take = min(len(BLOCK) - off, end - pos)
        out += BLOCK[off:off + take]
        pos += take
    return bytes(out)

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def handle(self):
        try: super().handle()
        except (ConnectionResetError, BrokenPipeError): pass

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        parts = u.path.strip("/").split("/")
        if parts[0] == "admin":
            with state["lock"]:
                if parts[1] == "expire": state["tokens"].clear()
                if parts[1] == "rate": state["rate"] = int(q.get("bps", "0"))
                if parts[1] == "fail": state["fail_ranges"] = int(q.get("n", "0"))
                if parts[1] == "token": state["tokens"].add(q["t"])
                return self.send_json(200, {"served": state["served"], "requestdl": state["requestdl"], "rate": state["rate"]})
        if u.path.startswith("/v1/api/") and u.path.endswith("/requestdl"):
            state["requestdl"] += 1
            if q.get("token") != KEY: return self.send_json(403, {"success": False, "error": "BAD_TOKEN", "detail": "bad"})
            fid = q.get("file_id", "")
            tok = hashlib.sha1(os.urandom(8)).hexdigest()[:12]
            with state["lock"]: state["tokens"].add(tok)
            return self.send_json(200, {"success": True, "error": None, "data": f"http://127.0.0.1:{PORT}/t/{tok}/{fid}.bin"})
        mode = parts[0]
        if mode == "t":
            tok, name = parts[1], parts[2]
            if tok not in state["tokens"]:
                return self.send_json(403, {"error": "expired"})
        else:
            name = parts[1]
        if mode == "html":
            body = b"<!DOCTYPE html><html><body>check</body></html>"
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        if name == "big.bin":
            size = BIG_SIZE; etag = '"big-1"'; lm = "Mon, 01 Jan 2024 00:00:00 GMT"; path = None
        else:
            path = os.path.join(ROOT, name)
            if not os.path.isfile(path): return self.send_json(404, {"error": "nf"})
            size = os.path.getsize(path); etag = '"e-%d"' % size; lm = "Tue, 02 Jan 2024 00:00:00 GMT"
        if mode == "lm": etag = None
        rng = self.headers.get("Range")
        if_range = self.headers.get("If-Range")
        start, end = 0, size - 1
        partial = False
        if rng and rng.startswith("bytes=") and (not if_range or if_range in (etag, lm)):
            a, b = rng[6:].split("-")
            start = int(a); end = min(int(b) if b else size - 1, size - 1)
            partial = True
            with state["lock"]:
                if state["fail_ranges"] > 0 and start > 0:
                    state["fail_ranges"] -= 1
                    return self.send_json(503, {"error": "busy"})
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(length))
        if partial: self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if etag: self.send_header("ETag", etag)
        self.send_header("Last-Modified", lm)
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        pos = start
        f = open(path, "rb") if path else None
        try:
            if f: f.seek(start)
            while pos <= end:
                chunk = min(64 * 1024, end - pos + 1)
                data = f.read(chunk) if f else big_slice(pos, pos + chunk)
                self.wfile.write(data)
                with state["lock"]:
                    state["served"][name] = state["served"].get(name, 0) + len(data)
                    rate = state["rate"]
                pos += chunk
                if rate: time.sleep(chunk / rate)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            if f: f.close()

ThreadingHTTPServer.daemon_threads = True
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
