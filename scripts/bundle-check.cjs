'use strict';
// Every program the app launches must still run. A signed nested bundle edited afterwards
// still passes the outer signature check; macOS then kills it, possibly only after a reboot,
// and the native startup reports that as unreachable organization settings.
const cp=require('node:child_process'),path=require('node:path');
const PROGRAMS=['codex-cli/CodexCLI.app/Contents/MacOS/codex','agentbridge/codex/bin/codex','opencodex-permission-engine'];
function verify(resources){
 const result=cp.spawnSync('codesign',['--verify','--strict',path.join(resources,'codex-cli/CodexCLI.app')],{encoding:'utf8'});
 if(result.status!==0)throw Error('Bundled CLI signature is broken: '+result.stderr.trim());
 return PROGRAMS.map(program=>{
  const run=cp.spawnSync(path.join(resources,program),['--version'],{encoding:'utf8',timeout:20000});
  if(run.status!==0)throw Error('Bundled program does not run: '+program+' ('+(run.signal||run.status)+')');
  return {program,version:run.stdout.trim()};
 });
}
module.exports={verify};
if(require.main===module)console.log(JSON.stringify(verify(process.argv[2]||'/Applications/OpenCodex.app/Contents/Resources'),null,2));
