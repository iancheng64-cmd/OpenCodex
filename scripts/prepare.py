"""Prepare independent local app from user-installed, version-pinned applications."""
from pathlib import Path
import hashlib, subprocess
root=Path(__file__).resolve().parent.parent
sources={
 Path('/Applications/ChatGPT.app/Contents/Resources/app.asar'):'2f231a64e6dd30111bcd09e03c149cd06c8679b25914842772423251c4608ded',
 Path('/Applications/AgentBridge Studio.app/Contents/Resources/app.asar'):'1142c1e1036bbc1bb02957ee2d11d0c9fdbdceb84978167e34915a9087489cf5',
}
for p,h in sources.items():
 if not p.is_file() or hashlib.file_digest(p.open('rb'),'sha256').hexdigest()!=h:
  raise SystemExit('Installed baseline differs: '+str(p))
app=root/'build/OpenCodex.app'
if app.exists():
 raise SystemExit('Existing build retained. Use build.cjs and identity.py for incremental builds.')
app.parent.mkdir(parents=True,exist_ok=True)
subprocess.run(['ditto','/Applications/ChatGPT.app',str(app)],check=True)
subprocess.run(['ditto','/Applications/AgentBridge Studio.app/Contents/Resources',str(app/'Contents/Resources/agentbridge')],check=True)
print('Independent baseline copied; original applications unchanged.')
