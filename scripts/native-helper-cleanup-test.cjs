'use strict';
const assert=require('node:assert/strict');
const {ownedHelpers,closeOwnedHelpers}=require('../src/native-helper-cleanup.cjs');
const root='/profiles/OpenCodex',exe=root+'/codex-official/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService';
const rows=[{pid:10,ppid:1,command:'/App/main'},{pid:11,ppid:10,command:exe},{pid:12,ppid:1,command:exe},{pid:13,ppid:10,command:'/profiles/OpenCodexOther/Contents/MacOS/SkyComputerUseService'},{pid:14,ppid:10,command:'/unrelated/tool'},{pid:15,ppid:14,command:exe}];
(async()=>{
 assert.deepEqual(ownedHelpers(rows,root,10).map(r=>r.pid),[11,15]);
 const signals=[];let reads=0;
 await closeOwnedHelpers(root,{ownerPid:10,list:()=>++reads===1?rows:rows.filter(r=>r.pid!==11),kill:(pid,s)=>signals.push([pid,s]),pause:async()=>{}});
 assert.deepEqual(signals,[[11,'SIGTERM'],[15,'SIGTERM'],[15,'SIGKILL']]);
 const reused=[];reads=0;
 await closeOwnedHelpers(root,{ownerPid:10,list:()=>++reads===1?rows:[{pid:11,ppid:1,command:exe}],kill:(pid,s)=>reused.push([pid,s]),pause:async()=>{}});
 assert(reused.every(([,s])=>s==='SIGTERM'));
 console.log('PASS owned helper descendants, graceful exit, bounded escalation, unrelated instances and PID ownership');
})().catch(e=>{console.error(e);process.exitCode=1});
