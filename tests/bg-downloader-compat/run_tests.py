# Testes do bg-downloader (build Linux) contra um servidor HTTP local e contra o motor nativo do ps5-react.
import hashlib, json, os, shutil, signal, struct, subprocess, sys, time, urllib.request, urllib.error

T = os.environ.get("BGTEST_DIR", "/tmp/bg-downloader-compat")
BIN = f"{T}/bgdl-linux"
NATIVE = f"{T}/native_dl"
RUN = f"{T}/run"
SRV_PORT = 18080
API_PORT = 34211
SRV = f"http://127.0.0.1:{SRV_PORT}"
KEY = "TESTKEY-1234567890abcdef-0000"
MiB = 1024 * 1024
results = []

def sh(*a, **k): return subprocess.run(a, capture_output=True, text=True, **k)

def reset():
    shutil.rmtree(RUN, ignore_errors=True)
    os.makedirs(f"{RUN}/state"); os.makedirs(f"{RUN}/disk/downloads/images"); os.makedirs(f"{RUN}/disk/homebrew")
    admin("rate", bps=0); admin("fail", n=0)

def admin(what, **q):
    query = "&".join(f"{k}={v}" for k, v in q.items())
    with urllib.request.urlopen(f"{SRV}/admin/{what}?{query}") as r: return json.loads(r.read())

def env(extra=None):
    e = dict(os.environ, BGDL_DIR=f"{RUN}/state", BGDL_PORT=str(API_PORT), BGDL_TORBOX_BASE=f"{SRV}/v1/api",
             BGDL_NOTIFY_FILE=f"{RUN}/notify.txt")
    e.update(extra or {})
    return e

def start(extra=None):
    p = subprocess.Popen([BIN], env=env(extra), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    line = p.stdout.readline().strip()
    for _ in range(100):
        try:
            if api("GET", "/health")[0] == 200: return p
        except Exception: pass
        time.sleep(0.05)
    raise RuntimeError(f"payload nao subiu ({line})")

def token(): return open(f"{RUN}/state/token").read().strip()

def api(method, path, body=None, tok=None):
    req = urllib.request.Request(f"http://127.0.0.1:{API_PORT}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None))
    t = token() if tok is None else tok
    if t: req.add_header("X-Jobe-Token", t)
    if body is not None: req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

def job(jid):
    for j in api("GET", "/jobs")[1]["jobs"]:
        if j["id"] == jid: return j
    return None

def wait(jid, states, timeout=60, cond=None):
    end = time.time() + timeout
    while time.time() < end:
        try: j = job(jid)
        except urllib.error.URLError: time.sleep(0.2); continue
        if j and (j["state"] in states) and (not cond or cond(j)): return j
        time.sleep(0.1)
    raise AssertionError(f"job {jid} nao chegou a {states}: {job(jid)}")

def stop(p, sig=signal.SIGTERM):
    p.send_signal(sig)
    try: p.wait(timeout=20)
    except subprocess.TimeoutExpired: p.kill(); p.wait()

def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(4 * MiB), b""): h.update(chunk)
    return h.hexdigest()

def create(name, dest, **extra):
    body = {"url": f"{SRV}/f/{name}", "destination": dest, "storageRoot": f"{RUN}/disk", "name": name,
            "rangeBytes": 16 * MiB, "connections": 8, "rejectHtml": True}
    body.update(extra)
    return api("POST", "/jobs", body)

def missing_bytes(dest, total, rb=16 * MiB):
    bitmap = open(dest + ".resume", "rb").read()[96:]
    return sum(min(rb, total - i * rb) for i, v in enumerate(bitmap) if not v)

def test(fn):
    name = fn.__name__
    try:
        reset()
        fn()
        results.append((name, "OK", ""))
        print(f"OK    {name}", flush=True)
    except Exception as e:
        results.append((name, "FALHOU", repr(e)))
        print(f"FALHOU {name}: {e!r}", flush=True)
    finally:
        sh("pkill", "-9", "-f", BIN)
        time.sleep(0.2)

# ---------------------------------------------------------------------------------------------------------

def t01_token_obrigatorio():
    p = start()
    assert api("GET", "/health", tok="")[0] == 401
    assert api("GET", "/jobs", tok="0" * 64)[0] == 401
    assert api("POST", "/jobs", {"url": "x"}, tok="abc")[0] == 401
    s, h = api("GET", "/health")
    assert s == 200 and h["version"], h
    assert oct(os.stat(f"{RUN}/state/token").st_mode & 0o777) == "0o600"
    out = sh("ss", "-ltnp").stdout
    assert f"127.0.0.1:{API_PORT}" in out and f"0.0.0.0:{API_PORT}" not in out, "deve ouvir so em 127.0.0.1"
    stop(p)

def t02_uma_copia_so():
    a = start()
    b = start()
    a.wait(timeout=20)
    assert a.returncode is not None, "a copia antiga deveria ter saido"
    pid = int(open(f"{RUN}/state/bgdl.pid").read())
    assert pid == b.pid, (pid, b.pid)
    assert api("GET", "/health")[1]["pid"] == b.pid
    stop(b)

def t03_download_multiconexao_sha_ok():
    p = start()
    dest = f"{RUN}/disk/downloads/a.bin"
    s, r = create("data100.bin", dest, sha256=sha(f"{T}/srv/data100.bin"), expectedBytes=os.path.getsize(f"{T}/srv/data100.bin"))
    assert s == 201, r
    j = wait(r["id"], ["completed", "failed"], 60)
    assert j["state"] == "completed", j
    assert sha(dest) == sha(f"{T}/srv/data100.bin")
    assert os.path.exists(dest + ".complete") and not os.path.exists(dest + ".resume") and not os.path.exists(dest + ".part")
    assert "downloaded" in open(f"{RUN}/notify.txt").read()
    stop(p)

def t04_retomada_apos_kill9_e_fila_sobrevive():
    admin("rate", bps=3 * MiB)
    p = start()
    dest = f"{RUN}/disk/downloads/b.bin"
    s, r = create("data100.bin", dest, sha256=sha(f"{T}/srv/data100.bin"), connections=2)
    jid = r["id"]
    wait(jid, ["downloading"], 20, cond=lambda j: j["written"] > 40 * MiB)
    time.sleep(6)  # passa um checkpoint (a cada 5 s)
    p.kill(); p.wait()
    served_before = admin("rate", bps=0)["served"].get("data100.bin", 0)
    resume = open(dest + ".resume", "rb").read()
    done = sum(resume[96:])
    assert done >= 1, "o checkpoint deveria ter faixas completas"
    p = start()
    j = wait(jid, ["completed", "failed"], 60)
    assert j["state"] == "completed", j
    assert sha(dest) == sha(f"{T}/srv/data100.bin")
    served = admin("rate", bps=0)["served"]["data100.bin"]
    total = os.path.getsize(dest)
    assert served - served_before < total - done * 16 * MiB + 16 * MiB * 8, ("baixou de novo demais", served, served_before)
    stop(p)

def t05_sha_errado_recusado():
    p = start()
    dest = f"{RUN}/disk/downloads/c.bin"
    s, r = create("data100.bin", dest, sha256="0" * 64)
    j = wait(r["id"], ["completed", "failed"], 60)
    assert j["state"] == "failed" and "SHA-256 mismatch" in j["error"], j
    assert not os.path.exists(dest), "nao pode publicar arquivo com sha errado"
    assert "failed" in open(f"{RUN}/notify.txt").read()
    stop(p)

def t06_link_vencido_torbox_renova_com_parcial():
    keyfile = f"{RUN}/debrid.json"
    json.dump({"torbox": {"key": KEY}}, open(keyfile, "w"))
    admin("token", t="first")
    admin("rate", bps=4 * MiB)
    p = start({"BGDL_KEYFILE": keyfile})
    start_served = admin("rate", bps=4 * MiB)["served"].get("data100.bin", 0)
    dest = f"{RUN}/disk/downloads/d.bin"
    s, r = api("POST", "/jobs", {"url": f"{SRV}/t/first/data100.bin", "destination": dest, "storageRoot": f"{RUN}/disk", "name": "d",
                                 "rangeBytes": 16 * MiB, "connections": 4, "sha256": sha(f"{T}/srv/data100.bin"),
                                 "source": {"provider": "torbox", "kind": "webdl", "id": 123, "fileId": "data100"}})
    assert s == 201, r
    jid = r["id"]
    wait(jid, ["downloading"], 20, cond=lambda j: j["written"] > 30 * MiB)
    before = admin("expire")["served"]["data100.bin"]
    admin("rate", bps=0)
    j = wait(jid, ["completed", "failed", "needs-app"], 60)
    assert j["state"] == "completed", j
    assert j["renewals"] >= 1 and "/t/" in j["url"] and "first" not in j["url"], j
    assert sha(dest) == sha(f"{T}/srv/data100.bin")
    served = admin("rate", bps=0)["served"]["data100.bin"] - start_served
    assert served < 100 * MiB + 16 * MiB * 4, ("a parcial deveria ser aproveitada", served)
    log = open(f"{RUN}/state/bgdl.log").read()
    assert KEY not in log, "a chave nunca pode ir para o diario"
    assert KEY not in open(f"{RUN}/state/jobs.json").read()
    stop(p)

def t07_chave_por_post_secret_e_sem_chave_aguarda_app():
    admin("token", t="old2")
    p = start()
    dest = f"{RUN}/disk/downloads/e.bin"
    admin("expire")
    s, r = api("POST", "/jobs", {"url": f"{SRV}/t/old2/data10.bin", "destination": dest, "storageRoot": f"{RUN}/disk", "name": "e",
                                 "source": {"provider": "torbox", "kind": "webdl", "id": "9", "fileId": "data10"}})
    j = wait(r["id"], ["completed", "failed", "needs-app"], 30)
    assert j["state"] == "needs-app", j
    assert api("POST", "/secret", {"service": "torbox", "key": KEY})[0] == 200
    api("POST", f"/jobs/{r['id']}/resume")
    j = wait(r["id"], ["completed", "failed"], 30)
    assert j["state"] == "completed", j
    assert sha(dest) == sha(f"{T}/srv/data10.bin")
    assert KEY not in open(f"{RUN}/state/bgdl.log").read() and KEY not in open(f"{RUN}/state/jobs.json").read()
    stop(p)

def t08_arquivo_maior_que_4GB_esparso():
    total = 4 * 1024**3 + 40 * MiB
    rb = 16 * MiB
    count = (total + rb - 1) // rb
    done = 257
    root = f"{RUN}/disk"
    dest = f"{root}/downloads/big.bin"
    st = os.stat(root)
    h = hashlib.sha256()
    for v in [b'etag:"big-1"', b"", str(total).encode()]: h.update(v + b"\0")
    h.update(f"{st.st_dev}:{st.st_ino}".encode())
    ident = h.hexdigest().encode()
    header = b"P5RDL001" + struct.pack("<QQI", total, rb, count) + ident + b"\0" + b"\0" * 3
    assert len(header) == 96
    with open(dest + ".part", "wb") as f: f.truncate(done * rb)  # esparso: nada gravado de fato
    open(dest + ".resume", "wb").write(header + bytes([1] * done + [0] * (count - done)))
    big_before = admin("rate", bps=0)["served"].get("big.bin", 0)
    p = start()
    s, r = api("POST", "/jobs", {"url": f"{SRV}/f/big.bin", "destination": dest, "storageRoot": root, "name": "big",
                                 "rangeBytes": rb, "expectedBytes": total})
    j = wait(r["id"], ["completed", "failed"], 120)
    assert j["state"] == "completed", j
    assert os.path.getsize(dest) == total
    served = admin("rate", bps=0)["served"]["big.bin"] - big_before
    assert served == total - done * rb + 1, ("so as faixas depois de 4 GB (+1 byte da sonda)", served)
    import random
    block = random.Random(7).randbytes(MiB)
    with open(dest, "rb") as f:
        f.seek(done * rb)
        tail = f.read()
    pos = done * rb
    for i in range(0, len(tail), MiB):
        off = (pos + i) % MiB
        exp = (block[off:] + block[:off])[:min(MiB, len(tail) - i)]
        assert tail[i:i + len(exp)] == exp, f"bytes errados em {pos + i}"
    stop(p)
    # o motor nativo aceita o recibo do payload (recoverCompleted) sem baixar nada
    out = sh(NATIVE, f"{SRV}/f/big.bin", dest, root, "0", "-", str(total))
    assert out.returncode == 0 and "completed" in out.stdout, out.stdout + out.stderr
    assert admin("rate", bps=0)["served"]["big.bin"] - big_before == served, "o nativo nao deveria baixar nada"

def t09_app_comeca_payload_termina():
    admin("rate", bps=6 * MiB)
    dest = f"{RUN}/disk/downloads/f.bin"
    out = sh(NATIVE, f"{SRV}/f/data100.bin", dest, f"{RUN}/disk", str(45 * MiB), sha(f"{T}/srv/data100.bin"))
    assert out.returncode == 2, out.stdout + out.stderr
    assert os.path.exists(dest + ".part") and os.path.exists(dest + ".resume")
    done = sum(open(dest + ".resume", "rb").read()[96:])
    assert done >= 1, "o nativo deveria ter faixas completas no checkpoint"
    before = admin("rate", bps=0)["served"]["data100.bin"]
    missing = missing_bytes(dest, 100 * MiB)
    p = start()
    s, r = create("data100.bin", dest, sha256=sha(f"{T}/srv/data100.bin"))
    j = wait(r["id"], ["completed", "failed"], 60)
    assert j["state"] == "completed", j
    assert sha(dest) == sha(f"{T}/srv/data100.bin")
    after = admin("rate", bps=0)["served"]["data100.bin"]
    assert after - before == missing + 1, ("o payload devia baixar so as faixas que faltam (+1 da sonda)", after - before, missing)
    stop(p)

def t10_payload_comeca_app_termina():
    admin("rate", bps=3 * MiB)
    p = start()
    dest = f"{RUN}/disk/downloads/g.bin"
    s, r = create("data100.bin", dest, sha256=sha(f"{T}/srv/data100.bin"), connections=2)
    wait(r["id"], ["downloading"], 30, cond=lambda j: j["written"] > 36 * MiB)
    time.sleep(5.5)
    s, rr = api("POST", f"/jobs/{r['id']}/release")
    assert s == 200, rr
    for _ in range(100):
        if job(r["id"]) is None: break
        time.sleep(0.1)
    assert job(r["id"]) is None, "release deve tirar o job do payload"
    done = sum(open(dest + ".resume", "rb").read()[96:])
    assert done >= 1
    before = admin("rate", bps=0)["served"]["data100.bin"]
    missing = missing_bytes(dest, 100 * MiB)
    out = sh(NATIVE, f"{SRV}/f/data100.bin", dest, f"{RUN}/disk", "0", sha(f"{T}/srv/data100.bin"))
    assert out.returncode == 0, out.stdout + out.stderr
    assert sha(dest) == sha(f"{T}/srv/data100.bin")
    after = admin("rate", bps=0)["served"]["data100.bin"]
    # o nativo divide faixas entre conexoes ociosas (corta conexoes e descarta bytes): uma folga de 8 MiB
    assert after - before <= missing + 8 * MiB + 1, ("o app devia aproveitar a parcial do payload", after - before, missing)
    stop(p)

def t11_imagem_vai_para_homebrew_so_com_app_fechado():
    flag = f"{RUN}/app-running"
    p = start({"BGDL_APP_RUNNING": flag})
    dest = f"{RUN}/disk/downloads/images/Game.exfat"
    s, r = api("POST", "/jobs", {"url": f"{SRV}/f/data10.bin", "destination": dest, "storageRoot": f"{RUN}/disk", "name": "Game",
                                 "publishTo": f"{RUN}/disk/homebrew/Game.exfat"})
    j = wait(r["id"], ["completed", "failed"], 30)
    assert j["state"] == "completed" and j["published"] == f"{RUN}/disk/homebrew/Game.exfat", j
    assert os.path.exists(f"{RUN}/disk/homebrew/Game.exfat") and os.path.exists(f"{RUN}/disk/homebrew/Game.exfat.complete")
    assert not os.path.exists(dest)
    # com o app aberto, o arquivo fica para o app
    open(flag, "w").close()
    dest2 = f"{RUN}/disk/downloads/images/Two.exfat"
    s, r = api("POST", "/jobs", {"url": f"{SRV}/f/data10.bin", "destination": dest2, "storageRoot": f"{RUN}/disk", "name": "Two",
                                 "publishTo": f"{RUN}/disk/homebrew/Two.exfat"})
    j = wait(r["id"], ["completed", "failed"], 30)
    assert j["state"] == "completed" and j["awaitingApp"] and not j["published"], j
    assert os.path.exists(dest2) and not os.path.exists(f"{RUN}/disk/homebrew/Two.exfat")
    # o motor nativo, como o app ao abrir, reconhece o arquivo publicado pelo payload
    out = sh(NATIVE, f"{SRV}/f/data10.bin", f"{RUN}/disk/homebrew/Game.exfat", f"{RUN}/disk")
    assert out.returncode == 0, out.stdout + out.stderr
    stop(p)

def t12_sem_etag_last_modified_retoma_com_amostra():
    admin("rate", bps=4 * MiB)
    p = start()
    dest = f"{RUN}/disk/downloads/h.bin"
    s, r = api("POST", "/jobs", {"url": f"{SRV}/lm/data100.bin", "destination": dest, "storageRoot": f"{RUN}/disk", "name": "h",
                                 "rangeBytes": 16 * MiB, "sha256": sha(f"{T}/srv/data100.bin")})
    wait(r["id"], ["downloading"], 20, cond=lambda j: j["written"] > 40 * MiB)
    time.sleep(5.5)
    p.kill(); p.wait()
    admin("rate", bps=0)
    p = start()
    j = wait(r["id"], ["completed", "failed"], 60)
    assert j["state"] == "completed", j
    assert sha(dest) == sha(f"{T}/srv/data100.bin")
    stop(p)

def t13_reject_html_pause_resume_cancel_409():
    p = start()
    s, r = api("POST", "/jobs", {"url": f"{SRV}/html/x.bin", "destination": f"{RUN}/disk/downloads/x.bin", "storageRoot": f"{RUN}/disk", "rejectHtml": True})
    j = wait(r["id"], ["failed", "completed"], 20)
    assert j["state"] == "failed" and "web page" in j["error"], j
    admin("rate", bps=2 * MiB)
    dest = f"{RUN}/disk/downloads/y.bin"
    s, r = create("data100.bin", dest)
    jid = r["id"]
    s, dup = create("data100.bin", dest)
    assert s == 409 and dup["id"] == jid, (s, dup)
    wait(jid, ["downloading"], 20, cond=lambda j: j["written"] > 5 * MiB)
    api("POST", f"/jobs/{jid}/pause")
    wait(jid, ["paused"], 20)
    assert os.path.exists(dest + ".part") and os.path.exists(dest + ".resume")
    api("POST", f"/jobs/{jid}/resume")
    wait(jid, ["downloading"], 20)
    api("POST", f"/jobs/{jid}/cancel")
    wait(jid, ["cancelled"], 20)
    assert not os.path.exists(dest + ".part") and not os.path.exists(dest + ".resume")
    assert api("POST", "/jobs", {"url": "file:///etc/passwd", "destination": "/tmp/x"})[0] == 400
    assert api("POST", "/jobs", {"url": f"{SRV}/f/a", "destination": "/tmp/../etc/x"})[0] == 400
    assert api("POST", "/jobs", "nao e json")[0] == 400
    stop(p)

def t14_sigterm_grava_checkpoint_e_continua():
    admin("rate", bps=4 * MiB)
    p = start()
    dest = f"{RUN}/disk/downloads/i.bin"
    s, r = create("data100.bin", dest, sha256=sha(f"{T}/srv/data100.bin"))
    wait(r["id"], ["downloading"], 20, cond=lambda j: j["written"] > 20 * MiB)
    stop(p)  # SIGTERM: checkpoint gravado na saida
    assert json.load(open(f"{RUN}/state/jobs.json"))["jobs"][0]["state"] == "queued"
    admin("rate", bps=0)
    p = start()
    j = wait(r["id"], ["completed", "failed"], 60)
    assert j["state"] == "completed", j
    assert sha(dest) == sha(f"{T}/srv/data100.bin")
    stop(p)

def t15_falhas_503_tentadas_de_novo():
    admin("fail", n=5)
    p = start()
    dest = f"{RUN}/disk/downloads/k.bin"
    s, r = create("data100.bin", dest, sha256=sha(f"{T}/srv/data100.bin"))
    j = wait(r["id"], ["completed", "failed"], 90)
    assert j["state"] == "completed" and j["retries"] >= 1, j
    stop(p)

def t16_link_velho_renovado_antes_de_comecar():
    keyfile = f"{RUN}/debrid.json"
    json.dump({"torbox": {"key": KEY}}, open(keyfile, "w"))
    admin("token", t="aged")
    before = admin("rate", bps=0)["requestdl"]
    p = start({"BGDL_KEYFILE": keyfile})
    dest = f"{RUN}/disk/downloads/l.bin"
    old_ms = int((time.time() - 3 * 3600) * 1000)
    s, r = api("POST", "/jobs", {"url": f"{SRV}/t/aged/data10.bin", "destination": dest, "storageRoot": f"{RUN}/disk", "name": "l",
                                 "linkAt": old_ms, "source": {"provider": "torbox", "kind": "webdl", "id": 5, "fileId": "data10"}})
    j = wait(r["id"], ["completed", "failed", "needs-app"], 30)
    assert j["state"] == "completed" and j["renewals"] == 1 and "aged" not in j["url"], j
    assert admin("rate", bps=0)["requestdl"] == before + 1
    stop(p)

def t17_sigcont_no_meio_reabre_e_termina():
    admin("rate", bps=4 * MiB)
    p = start()
    dest = f"{RUN}/disk/downloads/m.bin"
    s, r = create("data100.bin", dest, sha256=sha(f"{T}/srv/data100.bin"), connections=4)
    wait(r["id"], ["downloading"], 20, cond=lambda j: j["written"] > 10 * MiB)
    p.send_signal(signal.SIGCONT)
    time.sleep(1.5)
    admin("rate", bps=0)
    j = wait(r["id"], ["completed", "failed"], 60)
    assert j["state"] == "completed", j
    assert sha(dest) == sha(f"{T}/srv/data100.bin")
    log = open(f"{RUN}/state/bgdl.log").read()
    assert "acordou" in log and "reabrindo" in log, log[-800:]
    time.sleep(2.5)
    assert api("GET", "/health")[0] == 200, "o servidor deve voltar depois de reaberto"
    stop(p)

def t18_downloads_simultaneos_config():
    p = start()
    assert api("GET", "/health")[1]["concurrency"] == 1, "padrao: um por vez"
    admin("rate", bps=2 * MiB)
    full = f"{T}/srv/data100.bin"
    ids, dests = [], []
    for i in range(3):
        dest = f"{RUN}/disk/downloads/s{i}.bin"
        s, r = create("data100.bin", dest, sha256=sha(full), connections=2)
        assert s == 201, r
        ids.append(r["id"]); dests.append(dest)
    wait(ids[0], ["downloading"], 20)
    time.sleep(1)
    assert api("GET", "/health")[1]["running"] == 1 and job(ids[1])["state"] == "queued", api("GET", "/jobs")
    assert api("POST", "/config", {"concurrency": 0})[0] == 400
    assert api("POST", "/config", {"concurrency": 5})[0] == 400
    assert api("POST", "/config", {"other": 2})[0] == 400
    s, c = api("POST", "/config", {"concurrency": 3})
    assert s == 200 and c["concurrency"] == 3, c
    for jid in ids: wait(jid, ["downloading"], 20)
    assert api("GET", "/health")[1]["running"] == 3
    # Diminuir nao para ninguem: os tres continuam, so nao comeca outro.
    assert api("POST", "/config", {"concurrency": 1})[1]["concurrency"] == 1
    time.sleep(1.5)
    assert api("GET", "/health")[1]["running"] == 3, api("GET", "/jobs")
    saved = json.load(open(f"{RUN}/state/config.json"))
    assert saved["concurrency"] == 1 and saved["monitor"] is True and saved["pinHash"] == "", saved  # e a pagina do celular (padrao)
    api("POST", "/config", {"concurrency": 2})
    stop(p)
    # O numero volta com o payload; os jobs parados com o processo continuam, dois de cada vez.
    p = start()
    assert api("GET", "/health")[1]["concurrency"] == 2
    wait(ids[0], ["downloading"], 20)
    time.sleep(1)
    assert api("GET", "/health")[1]["running"] == 2, api("GET", "/jobs")
    admin("rate", bps=0)
    for jid, dest in zip(ids, dests):
        j = wait(jid, ["completed", "failed"], 90)
        assert j["state"] == "completed", j
        assert sha(dest) == sha(full)
    stop(p)

# glibren.5: a opcao "Pausa ao fechar o app" (POST /config "pauseOnCloseSeconds", 0 a 30 s) e o aviso do botao "Sair" (POST /bye).
QUIET_ENV = {"BGDL_QUIET_MS": "3000", "BGDL_APP_SILENCE_MS": "600000"}

def health(): return api("GET", "/health")[1]

def log_text(): return open(f"{RUN}/state/bgdl.log").read()

def queued_item(name, dest):
    return {"key": "k-" + "".join(ch for ch in name if ch.isalnum()), "name": name, "total": os.path.getsize(f"{T}/srv/{name}"),
            "job": {"url": f"{SRV}/f/{name}", "destination": dest, "storageRoot": f"{RUN}/disk", "connections": 2}}

def t19_pausa_ao_fechar_tempo():
    flag = f"{RUN}/app-running"
    open(flag, "w").close()
    env = dict(QUIET_ENV, BGDL_APP_RUNNING=flag)
    p = start(env)
    h = health()
    assert h["pauseOnCloseSeconds"] == 3 and h["quiet"] is False, ("sem o campo: BGDL_QUIET_MS (3 s)", h)
    for bad in [31, -1, 2.5, "10", None, True]:
        assert api("POST", "/config", {"pauseOnCloseSeconds": bad})[0] == 400, bad
    assert "pauseOnCloseSeconds" not in json.load(open(f"{RUN}/state/config.json")) if os.path.exists(f"{RUN}/state/config.json") else True
    # 0: fechar o app nao deixa nada quieto.
    s, c = api("POST", "/config", {"pauseOnCloseSeconds": 0})
    assert s == 200 and c["pauseOnCloseSeconds"] == 0, c
    assert json.load(open(f"{RUN}/state/config.json"))["pauseOnCloseSeconds"] == 0
    os.remove(flag); time.sleep(1.8)
    assert health()["quiet"] is False, "0 s: sem modo quieto ao fechar"
    assert "app FECHOU (sceLncUtilGetAppId): sem modo quieto (pausa ao fechar: 0 s)" in log_text(), log_text()[-800:]
    # Config sem o campo nao muda o tempo.
    assert api("POST", "/config", {"concurrency": 1})[1]["pauseOnCloseSeconds"] == 0
    # 10 s: fechar deixa quieto; trocar para 5 s no meio encurta (contado de quando comecou), nao recomeca.
    assert api("POST", "/config", {"pauseOnCloseSeconds": 10})[1]["pauseOnCloseSeconds"] == 10
    open(flag, "w").close(); time.sleep(1.8)
    os.remove(flag); closed = time.time(); time.sleep(1.8)
    assert health()["quiet"] is True, "10 s: quieto depois de fechar"
    assert api("POST", "/config", {"pauseOnCloseSeconds": 5})[1]["pauseOnCloseSeconds"] == 5
    assert health()["quiet"] is True, "5 s ainda nao passaram"
    time.sleep(max(0, closed + 6.5 - time.time()))
    assert health()["quiet"] is False, "encurtado para 5 s (com 10 s ainda estaria quieto)"
    # 0 no meio do modo quieto: termina na hora.
    api("POST", "/config", {"pauseOnCloseSeconds": 10})
    open(flag, "w").close(); time.sleep(1.8)
    os.remove(flag); time.sleep(1.8)
    assert health()["quiet"] is True
    api("POST", "/config", {"pauseOnCloseSeconds": 0})
    assert health()["quiet"] is False, "0 termina o modo quieto em andamento"
    log = log_text()
    for line in ["pausa ao fechar o app: 3 s -> 0 s (desligada)", "pausa ao fechar o app: 0 s -> 10 s",
                 "app FECHOU (sceLncUtilGetAppId): modo quieto por 10 s", "pausa ao fechar o app: 10 s -> 5 s; o modo quieto em andamento foi encurtado",
                 "pausa ao fechar o app: 10 s -> 0 s (desligada); o modo quieto em andamento terminou agora"]:
        assert line in log, (line, log[-2000:])
    # O tempo volta com o payload (config.json).
    stop(p)
    p = start(env)
    assert health()["pauseOnCloseSeconds"] == 0
    assert "modo quieto ao fechar o app: 0 s" in log_text()
    stop(p)

def t20_bye_com_pausa():
    p = start(QUIET_ENV)
    assert api("POST", "/bye", tok="")[0] == 401, "token obrigatorio"
    assert api("POST", "/config", {"pauseOnCloseSeconds": 3})[1]["pauseOnCloseSeconds"] == 3
    dest = f"{RUN}/disk/downloads/bye1.bin"
    s, r = api("POST", "/queue", {"items": [queued_item("data10.bin", dest)]})
    assert s == 200, r
    time.sleep(1.5)
    jobs = api("GET", "/jobs")[1]["jobs"]
    assert len(jobs) == 1 and jobs[0]["state"] == "queued", ("com o app falando, a fila antecipada espera", jobs)
    s, b = api("POST", "/bye")
    assert s == 200 and b["quietMs"] == 3000, b
    assert health()["quiet"] is True, "a pausa comeca no /bye, com o tempo atual"
    time.sleep(1.5)
    assert api("GET", "/jobs")[1]["jobs"][0]["state"] == "queued", "quieto: nada comeca"
    j = wait(jobs[0]["id"], ["completed", "failed"], 30)
    assert j["state"] == "completed", j
    assert sha(dest) == sha(f"{T}/srv/data10.bin")
    time.sleep(1.2)  # o fim do modo quieto e registrado no laco principal, a cada 1 s
    log = log_text()
    for line in ["app avisou que vai fechar (POST /bye): modo quieto por 3 s", "app fechando (POST /bye): a fila antecipada segue sozinha",
                 "modo quieto terminou"]:
        assert line in log, (line, log[-1500:])
    assert "modo quieto pelo silencio" not in log, "o /bye nao e silencio"
    stop(p)

def t21_bye_sem_pausa_comeca_na_hora():
    p = start(QUIET_ENV)
    assert api("POST", "/config", {"pauseOnCloseSeconds": 0})[0] == 200
    dest = f"{RUN}/disk/downloads/bye2.bin"
    s, r = api("POST", "/queue", {"items": [queued_item("data10.bin", dest)]})
    assert s == 200, r
    time.sleep(1.2)
    jid = api("GET", "/jobs")[1]["jobs"][0]["id"]
    s, b = api("POST", "/bye")
    assert s == 200 and b["quietMs"] == 0, b
    assert health()["quiet"] is False
    # Sem esperar os 15 s de silencio (aqui 600 s) nem a pausa: comeca em ~1 s.
    j = wait(jid, ["downloading", "completed", "failed"], 4)
    assert j["state"] != "failed", j
    j = wait(jid, ["completed", "failed"], 30)
    assert j["state"] == "completed", j
    assert "app avisou que vai fechar (POST /bye): sem pausa (pausa ao fechar: 0 s)" in log_text()
    stop(p)

if __name__ == "__main__":
    only = sys.argv[1:]
    for fn in [v for k, v in sorted(globals().items()) if k.startswith("t") and k[1:3].isdigit()]:
        if not only or any(o in fn.__name__ for o in only): test(fn)
    print("\nRESUMO")
    for name, status, why in results: print(f"{status:7} {name} {why}")
    sys.exit(0 if all(s == "OK" for _, s, _ in results) else 1)
