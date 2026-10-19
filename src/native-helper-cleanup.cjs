'use strict';
const cp=require('node:child_process'),path=require('node:path');
function snapshot(){
 return cp.execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8',timeout:2000,maxBuffer:4*1024*1024})
 .split('\n').map(line=>{const m=line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);return m?{pid:Number(m[1]),ppid:Number(m[2]),command:m[3]}:null;}).filter(Boolean);
}
function ownedHelpers(rows,root,ownerPid){
 const descendants=new Set([ownerPid]);let changed=true;
 while(changed){changed=false;for(const row of rows)if(descendants.has(row.ppid)&&!descendants.has(row.pid)){descendants.add(row.pid);changed=true;}}
 const prefix=path.resolve(root)+path.sep;
 return rows.filter(row=>row.pid!==ownerPid&&descendants.has(row.pid)&&row.command.startsWith(prefix)&&row.command.endsWith('/Contents/MacOS/SkyComputerUseService'));
}
async function closeOwnedHelpers(root,{ownerPid=process.pid,list=snapshot,kill=process.kill,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 const owned=ownedHelpers(list(),root,ownerPid);
 const signal=(pid,name)=>{try{kill(pid,name);}catch(e){if(e.code!=='ESRCH')throw e;}};
 for(const row of owned)signal(row.pid,'SIGTERM');
 if(!owned.length)return 0;
 await pause(350);
 // Only escalate the same process still belonging to this app, never an orphan from another instance.
 const remaining=ownedHelpers(list(),root,ownerPid);
 for(const row of remaining)if(owned.some(old=>old.pid===row.pid&&old.command===row.command))signal(row.pid,'SIGKILL');
 return owned.length;
}
module.exports={ownedHelpers,closeOwnedHelpers};
