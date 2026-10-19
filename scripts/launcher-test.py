from pathlib import Path
import tempfile, subprocess, os, json, datetime
root=Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='opencodex-launcher-test-') as directory:
 base=Path(directory); app=base/'app'; app.mkdir(); home=base/'home'; home.mkdir()
 settings=home/'Library/Application Support/OpenCodex/opencodex.json'; settings.parent.mkdir(parents=True)
 launcher=app/'OpenCodex'; engine=app/'ChatGPT'
 subprocess.run(['clang','-Werror','-O2','-x','objective-c','-framework','Foundation',str(root/'src/launcher.c'),'-o',str(launcher)],check=True)
 engine.write_text('#!/bin/sh\nprintf \'%s\\n\' "$@"\n'); engine.chmod(0o700)
 tests=[]
 cases=[('Claude',{'mode':'ssh','sshAgent':'claude'},True),('Codex',{'mode':'ssh','sshAgent':'codex'},False),('official',{'mode':'official','sshAgent':'claude'},False),('custom',{'mode':'custom','sshAgent':'claude'},False),('invalid',[],False)]
 for name, config, isolated in cases:
  settings.write_text(json.dumps(config)); expected=settings.parent/('native-claude-ui' if isolated else '')
  result=subprocess.check_output([str(launcher),'--user-data-dir=/unexpected','--opencodex-test'],env={**os.environ,'HOME':str(home)},text=True).splitlines()
  assert result==['--user-data-dir='+str(expected),'--opencodex-test'], (name,result)
  tests.append(name+' launcher routes the profile and preserves arguments')
 settings.write_text('{broken')
 assert subprocess.check_output([str(launcher)],env={**os.environ,'HOME':str(home)},text=True).strip()=='--user-data-dir='+str(settings.parent)
 tests.append('malformed settings use independent OpenCodex profile')
 report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'passed':True,'tests':tests}
 (root/'evidence/launcher-unit.json').write_text(json.dumps(report,indent=2)+'\n'); print(json.dumps(report))
