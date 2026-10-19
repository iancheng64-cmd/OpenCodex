'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),readline=require('node:readline');
const {NativeTools}=require('../src/native-tools.cjs');
const root=path.resolve(__dirname,'..');
const {AppServerRpc}=require('../vendor/agentbridge/dist-main/app-server-rpc.js');
const owner=new NativeTools({binary:'/Applications/OpenCodex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',cwd:root,env:{...process.env,CODEX_HOME:path.join(os.homedir(),'Library/Application Support/OpenCodex/codex-official')},onRequest:(m,rpc)=>{console.log(JSON.stringify({nativeRequest:m.method,params:m.params}));rpc.reject(m.id,'Diagnostic host has no approval UI');return true;},AppServerRpc});
(async()=>{
 const spec=(await owner.specs()).find(s=>s.id==='opencodex-native:cua_repl');
 if(!spec)throw Error('Native Computer Use plugin unavailable');
 const client=spec.createClient();await client.start();
 console.log('READY');
 for await(const line of readline.createInterface({input:process.stdin})){
  if(line==='exit')break;
  try{
   const args=JSON.parse(line);
   const result=await client.call('js',args);
   const text=(result.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
   fs.appendFileSync(path.join(root,'evidence/native-cua-session.log'),JSON.stringify({at:new Date().toISOString(),args,result:{isError:!!result.isError,text}})+'\n');
   console.log(JSON.stringify({isError:!!result.isError,text}));
  }catch(e){console.log(JSON.stringify({error:e.message}));}
 }
 owner.close();
})().catch(e=>{console.error(e.stack);owner.close();process.exitCode=1;});
