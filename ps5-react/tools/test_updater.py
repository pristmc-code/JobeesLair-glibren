# Copyright (C) 2026 half144 and PS5 React contributors
# SPDX-License-Identifier: GPL-3.0-or-later
# Additional attribution term: see LICENSE-ATTRIBUTION.
"""updater.elf (native/ps5/payloads/updater.c) on the desktop, against a stand-in for ShadowMount+'s API."""
import http.server,json,os,socket,subprocess,sys,tempfile,threading,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from common import ROOT  # noqa: E402

TITLE="PPSA99058"

class ShadowMount:
 """POST /api/v1/images answers each image's `mounted` from `mounted(path)`; every route is recorded."""
 def __init__(self):
  # Compact or spaced JSON ("key": value): the updater must read both.
  self.routes=[];self.mounted=lambda path:False;self.compact=True;owner=self
  class Handler(http.server.BaseHTTPRequestHandler):
   def log_message(self,*_):pass
   def do_POST(self):
    body=self.rfile.read(int(self.headers.get("Content-Length","0")))
    route=self.path.removeprefix("/api/v1/");owner.routes.append((route,json.loads(body or b"{}")))
    if route=="images":
     # Paths escaped as some JSON writers do ("\/"), which the updater must read as written.
     items=[{"path":path,"mount_point":"/mnt/sandbox/x","mounted":owner.mounted(path)} for path in owner.images]
     reply=json.dumps({"status":0,"count":len(items),"images":items},separators=(",",":") if owner.compact else None).replace("/","\\/")
    elif route=="games/info":
     # glibren.15: the title's record, from `info()` (None: 404, as ShadowMount+ answers an unknown title). The
     # nested "content" carries keys of the same names, which the updater must not read as the record's.
     record=owner.info()
     if record is None:
      data=json.dumps({"status":2,"error":"No such file or directory"}).encode();self.send_response(404)
      self.send_header("Content-Length",str(len(data)));self.end_headers();self.wfile.write(data);return
     reply=json.dumps({"content":{"path":"/elsewhere","installed":True,"mounted":False},**record,"status":0},separators=(",",":") if owner.compact else None).replace("/","\\/")
    else:reply=json.dumps({"status":0})
    data=reply.encode();self.send_response(200);self.send_header("Content-Type","application/json")
    self.send_header("Content-Length",str(len(data)));self.end_headers();self.wfile.write(data)
  self.server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler);self.port=self.server.server_address[1];self.images=[]
  self.info=self.ready
  threading.Thread(target=self.server.serve_forever,daemon=True).start()
 def ready(self):
  """The record of a title ready to open: registered from the installed image, its last run released."""
  return {"title_id":TITLE,"path":self.images[0] if self.images else "","installed":True,"managed":True,"mounted":False,"source_available":True}
 def asked(self,route):return [body for name,body in self.routes if name==route]
 def stop(self):self.server.shutdown();self.server.server_close()

def free_port():
 with socket.socket() as probe:
  probe.bind(("127.0.0.1",0));return probe.getsockname()[1]

def wait_for(test,seconds=20):
 end=time.time()+seconds
 while time.time()<end:
  if test():return True
  time.sleep(0.02)
 return False

def main():
 with tempfile.TemporaryDirectory(prefix="ps5-react-updater-") as tmp:
  root=Path(tmp);binary=root/"updater"
  # Both compilers must take it; the binary that runs is the last, with any UPDATER_CFLAGS (a sanitizer, say).
  for compiler in ("gcc","clang"):
   subprocess.run([compiler,"-std=gnu11","-O2","-Wall","-Wextra","-Werror","-DUPDATER_HOST_TEST",*os.environ.get("UPDATER_CFLAGS","").split(),str(ROOT/"native/ps5/payloads/updater.c"),"-o",str(binary)],check=True)
  shadow=ShadowMount();lock=free_port()
  env={**os.environ,"UPDATER_TIME_SCALE":"50","UPDATER_SM_PORT":str(shadow.port),"UPDATER_LOCK_PORT":str(lock)}
  def scene(name,relaunch=True,size=None,old=b"old image",new=b"new image v2",notice=None):
   """A console: the installed image, a staged one beside it, the app running and asking for the update."""
   base=root/name;control=base/"JobeesLair/update";homebrew=base/"homebrew";staging=base/"JobeesLair/update_staging/0.2.1"
   for folder in (control,homebrew,staging):folder.mkdir(parents=True)
   target=homebrew/"JobeesLair.exfat";staged=staging/"JobeesLair.exfat.staged"
   target.write_bytes(old);staged.write_bytes(new);(control/"test-running").touch()
   extra=f"notice={notice}\n" if notice else ""
   (control/"apply.txt").write_text(f"UPD1\nversion=0.2.1-beta.1\ntarget={target}\nstaged={staged}\nsize={size or len(new)}\nrelaunch={int(relaunch)}\n{extra}",encoding="utf-8")
   shadow.images=[str(target)];shadow.routes.clear();shadow.info=shadow.ready
   return control,target,staged
  notices=lambda control:(control/"test-notices").read_text(encoding="utf-8").splitlines() if (control/"test-notices").exists() else []
  log=lambda control:(control/"updater.log").read_text(encoding="utf-8")
  def arm(control):
   process=subprocess.Popen([str(binary)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,env=env)
   process.stdin.write(f"UPD1\n{TITLE}\n{control}\n".encode());process.stdin.flush()
   return process,process.stdout.readline().decode()
  def outcome(control):
   path=control/"result.txt"
   return dict(line.split("=",1) for line in path.read_text().splitlines()) if path.exists() else {}
  def finished(process):
   process.wait(timeout=30);return process.returncode
  launches=lambda control:len((control/"test-launches").read_text().splitlines()) if (control/"test-launches").exists() else 0

  # The update, relaunched: the image is held a moment after the app closes, then swapped in; the new build
  # says it started, so the old image goes.
  control,target,staged=scene("applied")
  held=[3];shadow.mounted=lambda path:held.__setitem__(0,held[0]-1) or held[0]>0
  process,answer=arm(control)
  assert answer=="ready\n",answer
  # One waits at a time: a second answers "armed" and leaves it to the first.
  second,answer=arm(control)
  assert answer=="armed\n" and finished(second)==0,answer
  time.sleep(0.2)
  assert target.read_bytes()==b"old image" and staged.exists(),"nothing changes while the app runs"
  (control/"test-running").unlink()
  assert wait_for(lambda:outcome(control).get("outcome")=="swapped"),outcome(control)
  assert target.read_bytes()==b"new image v2" and not staged.exists() and Path(f"{target}.previous").read_bytes()==b"old image"
  assert not (control/"apply.txt").exists() and shadow.asked("scan")==[{}]
  assert wait_for(lambda:launches(control)==1)
  (control/"booted.txt").write_text("0.2.1-beta.1\n")
  assert finished(process)==0 and outcome(control)=={"outcome":"applied","version":"0.2.1-beta.1","reason":""},outcome(control)
  assert not Path(f"{target}.previous").exists() and shadow.asked("games/unmount")==[]

  # The new build closes before it says it started: the old one comes back, the new one goes back to
  # staging, and the app opens again (as the old version).
  control,target,staged=scene("crashed");shadow.mounted=lambda path:False;shadow.compact=False
  process,_=arm(control);(control/"test-running").unlink()
  assert wait_for(lambda:launches(control)==1)
  (control/"test-running").unlink()
  assert finished(process)==1 and outcome(control)["outcome"]=="rolledback",outcome(control)
  assert outcome(control)["reason"]=="the new version closed before it finished starting"
  assert target.read_bytes()==b"old image" and staged.read_bytes()==b"new image v2" and not Path(f"{target}.previous").exists()
  assert launches(control)==2 and len(shadow.asked("scan"))==2

  # Relaunched, the new build never opens: rolled back the same way.
  control,target,staged=scene("no-start");(control/"test-no-start").touch()
  process,_=arm(control);(control/"test-running").unlink()
  assert finished(process)==1 and outcome(control)["reason"]=="the new version did not open",outcome(control)
  assert target.read_bytes()==b"old image" and staged.read_bytes()==b"new image v2"

  # ShadowMount+ keeps the image mounted even after it is asked to unmount the title: nothing is touched,
  # and the old version opens again.
  control,target,staged=scene("persistent");shadow.mounted=lambda path:True
  process,_=arm(control);(control/"test-running").unlink()
  assert finished(process)==1 and outcome(control)["outcome"]=="refused",outcome(control)
  assert "keeps the image mounted" in outcome(control)["reason"] and shadow.asked("games/unmount")==[{"title_id":TITLE}]
  assert target.read_bytes()==b"old image" and staged.read_bytes()==b"new image v2" and launches(control)==1

  # A staged image that is not the size the app checked is refused.
  control,target,staged=scene("short",size=999);shadow.mounted=lambda path:False
  process,_=arm(control);(control/"test-running").unlink()
  assert finished(process)==1 and outcome(control)["reason"]=="the staged image is not the size that was checked"
  assert target.read_bytes()==b"old image"

  # Withdrawn while the app ran (apply.txt deleted): the updater leaves.
  control,target,staged=scene("withdrawn")
  process,_=arm(control);(control/"apply.txt").unlink()
  assert finished(process)==0 and not (control/"result.txt").exists() and target.read_bytes()==b"old image"

  # Not relaunched (installed when the app is next closed): swapped once it closes; the gamer opens it later
  # and it confirms.
  control,target,staged=scene("on-close",relaunch=False)
  process,_=arm(control);(control/"test-running").unlink()
  assert wait_for(lambda:outcome(control).get("outcome")=="swapped")
  time.sleep(0.3)
  assert launches(control)==0 and process.poll() is None,"it waits for the gamer to open it"
  (control/"test-running").touch();(control/"booted.txt").write_text("0.2.1-beta.1")
  assert finished(process)==0 and outcome(control)["outcome"]=="applied" and target.read_bytes()==b"new image v2"

  # glibren.15: right after the swap ShadowMount+ is still busy with the title (its record gone during the
  # scan, then the last run's /system_ex/app layer still up): the updater waits until it reads ready twice in
  # a row, and only then opens the app.
  control,target,staged=scene("not-ready")
  calls=[0]
  def settling():
   calls[0]+=1
   if calls[0]<=6:return None
   if calls[0]<=12:return {**shadow.ready(),"mounted":True}
   return shadow.ready()
  shadow.info=settling
  process,_=arm(control);(control/"test-running").unlink()
  assert wait_for(lambda:launches(control)==1)
  assert calls[0]>=14,f"opened after {calls[0]} reads of games/info"
  (control/"booted.txt").write_text("0.2.1-beta.1")
  assert finished(process)==0 and outcome(control)["outcome"]=="applied",outcome(control)
  assert all(f"ShadowMount+ on the app: {state}" in log(control) for state in ("no answer","still held from the last run","ready")),log(control)
  assert notices(control)==[] and launches(control)==1

  # The console refuses the first two launches ("cannot start the app"): tried again, with the error codes in
  # the log, and the third opens it.
  control,target,staged=scene("launch-retry");(control/"test-fail-launches").write_text("2")
  process,_=arm(control);(control/"test-running").unlink()
  assert wait_for(lambda:launches(control)==3),launches(control)
  (control/"booted.txt").write_text("0.2.1-beta.1")
  assert finished(process)==0 and outcome(control)["outcome"]=="applied",outcome(control)
  text=log(control)
  assert "attempt 1 of 4: could not open the app (error 0x80940005)" in text and "attempt 2 of 4: could not open" in text,text
  assert "before the first attempt" in text and "trying again in 5000 ms" in text and "trying again in 10000 ms" in text and "opened the app again (attempt 3 of 4)" in text,text
  assert notices(control)==[]

  # ShadowMount+ never has the title from the new image: no launch at all (each would show the console's
  # error); the gamer is told, in the app's language, to open it. The swap stays while they do.
  control,target,staged=scene("never-ready",notice="Abra o Jobee'sLair pela tela inicial para concluir a atualização.")
  shadow.info=lambda:{**shadow.ready(),"installed":False}
  process,_=arm(control);(control/"test-running").unlink()
  assert wait_for(lambda:notices(control)!=[])
  assert notices(control)==["Abra o Jobee'sLair pela tela inicial para concluir a atualização."] and launches(control)==0
  time.sleep(0.5)
  assert process.poll() is None and target.read_bytes()==b"new image v2","it waits for the gamer, without rolling back"
  (control/"test-running").touch();(control/"booted.txt").write_text("0.2.1-beta.1")
  assert finished(process)==0 and outcome(control)["outcome"]=="applied"
  assert "not opening it" in log(control)

  # Every launch refused: four tries, then the notice (English and Portuguese when the app sent none); the
  # update is kept while the gamer opens it by hand.
  control,target,staged=scene("launch-gives-up");(control/"test-fail-launches").write_text("99")
  process,_=arm(control);(control/"test-running").unlink()
  assert wait_for(lambda:notices(control)!=[])
  assert launches(control)==4 and len(notices(control))==1 and "Abra o Jobee'sLair pela tela inicial" in notices(control)[0],notices(control)
  assert "could not open the app again after 4 attempts" in log(control)
  time.sleep(0.5)
  assert process.poll() is None and target.read_bytes()==b"new image v2"
  (control/"test-running").touch();(control/"booted.txt").write_text("0.2.1-beta.1")
  assert finished(process)==0 and outcome(control)["outcome"]=="applied" and launches(control)==4

  # ShadowMount+ not answering: the image cannot be checked, so nothing is touched.
  shadow.stop()
  control,target,staged=scene("no-shadowmount")
  process,_=arm(control);(control/"test-running").unlink()
  assert finished(process)==1 and outcome(control)["reason"]=="ShadowMount+ did not answer, so the image could not be checked"
  assert target.read_bytes()==b"old image" and staged.exists()
 print("PASS: updater payload; waits for the app to close, swap after release, scan, relaunch, boot confirmation, rollback, "
       "persistent mounts, size checks, withdrawal, install on close, one updater at a time, "
       "relaunch waits for ShadowMount+, retries and the open-it-yourself notice")

if __name__=="__main__":
 main()
