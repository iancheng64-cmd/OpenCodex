'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {cdp}=require('./qa-client.cjs'),root=path.resolve(__dirname,'..');
(async()=>{
 const c=await cdp();
 try{
  const data=await c.evaluate('(async()=>({status:await window.openCodexRuntime.status(),canSubmit:window.openCodexRuntime.canSubmit()}))()'),s=data.status;
  assert.equal(s.version,'0.4.8');assert.equal(s.connected,true);assert.equal(s.toolsReady,true);assert.equal(s.connectionStage,'ready');assert.equal(s.diagnostic,null);assert.equal(data.canSubmit,true);
  const report={at:new Date().toISOString(),version:s.version,asarSHA256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar'))).digest('hex'),connected:s.connected,toolsReady:s.toolsReady,connectionStage:s.connectionStage,tools:s.tools,diagnostic:s.diagnostic,canSubmit:data.canSubmit,passed:true};
  fs.writeFileSync(path.join(root,'evidence/native-connection-live.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{c.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
