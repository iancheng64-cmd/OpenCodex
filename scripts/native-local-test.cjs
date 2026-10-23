'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
(async()=>{
 const root=path.join(os.homedir(),'Library/Application Support/OpenCodex'),endpoint=JSON.parse(fs.readFileSync(path.join(root,'test-endpoint.json')));
 const ws=new WebSocket(endpoint.url),pending=new Map(),events=[];let seq=0;
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 ws.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}else events.push(m);};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('Timeout '+method))},12000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const out={version:'0.4.10',at:new Date().toISOString(),tests:[]};
 try{
  const init=await call('initialize',{clientInfo:{name:'opencodex-native-local-test',version:'0.4.10'},capabilities:{experimentalApi:true}});
  assert(init.codexHome.startsWith(root+'/'));out.tests.push('isolated native app-server');
  const skills=await call('skills/list',{cwds:[os.homedir()],forceReload:true});out.skills=skills.data.reduce((n,x)=>n+x.skills.length,0);out.skillErrors=skills.data.reduce((n,x)=>n+x.errors.length,0);assert(out.skills>0);out.tests.push('native skills discovery');
  const plugins=await call('plugin/list',{cwds:[os.homedir()],marketplaceKinds:['local'],forceRefetch:false});out.localPluginCatalog=Object.keys(plugins);out.tests.push('local plugin discovery');
  const config=await call('config/read',{includeLayers:true});assert(config.config);out.tests.push('native config and layers');
  await call('experimentalFeature/list',{});out.tests.push('local feature flags');
  const sentinel=path.join(__dirname,'../evidence/executor-sentinel.txt'),read=await call('fs/readFile',{path:sentinel});assert.equal(Buffer.from(read.dataBase64,'base64').toString(),fs.readFileSync(sentinel,'utf8'));out.tests.push('Mac native file read');
  const exec=await call('command/exec',{command:['/bin/pwd'],cwd:os.homedir(),timeoutMs:5000});assert.equal(exec.exitCode,0);assert.equal(exec.stdout.trim(),os.homedir());out.tests.push('Mac native command cwd');
  const handle='opencodex-native-local-test-'+Date.now();
  await call('process/spawn',{command:['/usr/bin/printf','OPENCODEX-NATIVE-PROCESS-VERIFIED'],cwd:os.homedir(),processHandle:handle,streamStdoutStderr:false,timeoutMs:5000});
  for(let i=0;i<50&&!events.some(e=>e.method==='process/exited'&&e.params.processHandle===handle);i++)await new Promise(r=>setTimeout(r,100));
  const exited=events.find(e=>e.method==='process/exited'&&e.params.processHandle===handle);assert(exited);assert.equal(exited.params.exitCode,0);
  const output=exited.params.stdout||exited.params.stdoutBase64||'';assert(output.includes('OPENCODEX-NATIVE-PROCESS-VERIFIED')||Buffer.from(output,'base64').toString().includes('OPENCODEX-NATIVE-PROCESS-VERIFIED'));out.tests.push('Mac process exit and output notifications');
  const listed=await call('thread/list',{limit:10}),searched=await call('thread/search',{searchTerm:'verification',limit:10});assert(Array.isArray(listed.data)&&Array.isArray(searched.data));out.tests.push('offline thread lists and search');
  await assert.rejects(call('thread/start',{}),/SSH|連線|connect/i);out.tests.push('offline submission cannot run on unintended local runtime');
  out.passed=true;fs.writeFileSync(path.join(__dirname,'../evidence/native-local-test.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out));
 }finally{ws.close()}
})().catch(e=>{console.error(e.stack);process.exit(1)}).finally(()=>process.exit(process.exitCode||0));
