from pathlib import Path
r=Path(__file__).resolve().parent.parent
p=r/'src/bootstrap.cjs'
s=p.read_text()
a=s.index('function importBridgeSettings(){')
b=s.index('async function connectBridge()',a)
s=s[:a]+"""function importBridgeSettings(){
 const original=path.join(app.getPath('appData'),'agentbridge-studio');
 for(const n of ['runtime-known-hosts.json','runtime-trusted-hosts.json','trusted-hosts.json','computer-provider.json','exposure.json']){
  const src=path.join(original,n);if(fs.existsSync(src)&&!fs.existsSync(path.join(root,n)))fs.copyFileSync(src,path.join(root,n));
 }
 const src=path.join(original,'profiles.json'),dest=path.join(root,'profiles.json');
 if(!fs.existsSync(src))return;
 const originalProfiles=JSON.parse(fs.readFileSync(src,'utf8'));
 const profiles=fs.existsSync(dest)?JSON.parse(fs.readFileSync(dest,'utf8')):originalProfiles.map(({encryptedPassword,...p})=>p);
 const needs=profiles.filter(p=>!p.encryptedPassword&&p.savePassword&&originalProfiles.some(o=>o.id===p.id&&o.host===p.host&&o.username===p.username&&o.encryptedPassword));
 if(needs.length){
  let key;
  try{
   let secret;for(const name of ['agentbridge-studio Safe Storage','AgentBridge Studio Safe Storage']){
    try{secret=cp.execFileSync('/usr/bin/security',['find-generic-password','-s',name,'-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();break;}catch{}
   }
   if(!secret)throw Error('Source credential key unavailable');
   key=crypto.pbkdf2Sync(secret,'saltysalt',1003,16,'sha1');
   if(!safeStorage.isEncryptionAvailable())throw Error('OpenCodex Keychain unavailable');
   for(const profile of needs){
    const source=originalProfiles.find(p=>p.id===profile.id),b=Buffer.from(source.encryptedPassword,'base64');
    if(b.subarray(0,3).toString()!=='v10')continue;
    const d=crypto.createDecipheriv('aes-128-cbc',key,Buffer.alloc(16,32));
    const plain=Buffer.concat([d.update(b.subarray(3)),d.final()]);
    profile.encryptedPassword=safeStorage.encryptString(plain.toString()).toString('base64');plain.fill(0);
   }
  }catch{audit('credential-import',{result:'credential-unavailable'});}
  finally{key?.fill(0);}
 }
 fs.writeFileSync(dest,JSON.stringify(profiles,null,2),{mode:0o600});
}
""" +s[b:]
s=s.replace("if(params?.threadId&&!known[params.threadId])","if(params?.threadId&&known[params.threadId]?.profile!==runtime.snapshot.profileId)")
s=s.replace("const result=await backend.openCodexRequest(runtime,bridge.runtimeDependencies,method,params);","""if(method==='thread/resume'){
   const previous=known[params.threadId]?.environmentId;
   if(previous&&previous!==runtime.executor.environmentId){
    const environment=await runtime.executor.register(runtime.rpc,runtime.executorUrl,previous);
    runtime.snapshot.executorEnvironment=environment;
    if(runtime.mcp)runtime.mcp.environmentId=environment.environmentId;
   }
  }
  const result=await backend.openCodexRequest(runtime,bridge.runtimeDependencies,method,params);""")
p.write_text(s)
p=r/'src/bridge-adapter.cjs';s=p.read_text().replace('  runtime.run=run;','  runtime.run=run;\n  try{').replace('  try{\n   const result=await runtime.rpc.request(method,p,60000);run.turnId=result.turn.id;','   const result=await runtime.rpc.request(method,p,60000);run.turnId=result.turn.id;');p.write_text(s)
p=r/'scripts/build.cjs';s=p.read_text().replace(".replaceAll('process.env.CODEX_HOME','process.env.OPENCODEX_EXTENSION_HOME'));}",".replaceAll('process.env.CODEX_HOME','process.env.OPENCODEX_EXTENSION_HOME').replaceAll('os.environ.get(\"CODEX_HOME\")','os.environ.get(\"OPENCODEX_EXTENSION_HOME\")'));}")
p.write_text(s)
