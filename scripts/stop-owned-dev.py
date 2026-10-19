import os,signal,subprocess,time,sys
prefix='/Users/ian/Projects/OpenCodex/build/OpenCodex.app/'
prefixes=(prefix,'/Applications/OpenCodex.app/') if '--include-installed' in sys.argv else (prefix,)
rows=subprocess.check_output(['ps','-axo','pid=,comm='],text=True).splitlines()
owned_data=os.path.expanduser('~/Library/Application Support/OpenCodex/')
pids=[int(x.split(None,1)[0]) for x in rows if len(x.split(None,1))==2 and (x.split(None,1)[1].startswith(prefixes) or (x.split(None,1)[1].startswith(owned_data) and x.split(None,1)[1].endswith('/Contents/MacOS/SkyComputerUseService')))]
for pid in pids:
 try: os.kill(pid,signal.SIGTERM)
 except ProcessLookupError: pass
time.sleep(2)
print('Stopped owned development app processes:',len(pids))
