'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict');
const {NativeHooksBinding}=require('../src/native-hooks-relay.cjs');
const root=path.resolve(__dirname,'..'),stateFile=path.join(root,'build/hooks-product-state.json');
const home=path.join(os.homedir(),'Library/Application Support/OpenCodex/codex-official'),config=path.join(home,'config.toml'),hookFile=path.join(home,'hooks.json');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
(async()=>{
 if(process.argv.includes('--restore')){
  const s=JSON.parse(fs.readFileSync(stateFile));
  assert.equal(sha(fs.readFileSync(config)),s.fixtureConfigSHA256,'Config changed during fixture; preserve and inspect before restoring');
  assert.equal(sha(fs.readFileSync(hookFile)),s.fixtureHooksSHA256,'Hooks changed during fixture');
  fs.writeFileSync(config,fs.readFileSync(s.backup),{mode:0o600});fs.unlinkSync(hookFile);
  assert.equal(sha(fs.readFileSync(config)),s.originalSHA256);
  s.restoredAt=new Date().toISOString();fs.writeFileSync(stateFile,JSON.stringify(s,null,2),{mode:0o600});
  console.log(JSON.stringify({restored:true,originalSHA256:s.originalSHA256}));return;
 }
 if(fs.existsSync(stateFile)){const old=JSON.parse(fs.readFileSync(stateFile));assert(old.restoredAt,'Prior Hooks fixture is still active');}
 assert(!fs.existsSync(hookFile),'Existing Hooks require a merge; do not overwrite');
 const original=fs.readFileSync(config),toml=require('../build/OpenCodex.app/Contents/Resources/agentbridge/app/node_modules/smol-toml');
 const parsed=toml.parse(original.toString());assert(!parsed.features&&!parsed.hooks,'Expected no preexisting feature/hook sections');
 const fixture=fs.realpathSync(fs.mkdtempSync(path.join(root,'evidence/hooks-product-qa-'))),cwd=path.join(fixture,'project');
 fs.mkdirSync(cwd);const script=path.join(fixture,'hook.cjs'),token='HOOK_CONTEXT_'+crypto.randomUUID().replaceAll('-',''),denyFile=path.join(cwd,'hook-denied-marker.txt');
 fs.writeFileSync(script,[
 "'use strict';const fs=require('fs'),path=require('path'),{spawn}=require('child_process');",
 "const base="+JSON.stringify(fixture)+",p=JSON.parse(fs.readFileSync(0,'utf8'));",
 "fs.appendFileSync(path.join(base,'calls.jsonl'),JSON.stringify(p)+'\\n');",
 "if(p.prompt==='OPENCODEX_HOOK_QA_SLOW'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});fs.writeFileSync(path.join(base,'pids.json'),JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);}",
 "else{let out={};if(p.prompt==='OPENCODEX_HOOK_QA_BLOCK')out={decision:'block',reason:'OPENCODEX_HOOK_QA_BLOCKED'};",
 "if(p.prompt?.includes('OPENCODEX_HOOK_QA_CONTEXT'))out={hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'The verification token is "+token+". Reply with exactly this token, without tool calls.'}};",
 "if(p.hook_event_name==='PreToolUse'&&JSON.stringify(p.tool_input).includes('hook-denied-marker.txt'))out={hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'OPENCODEX_HOOK_QA_DENIED'}};",
 "process.stdout.write(JSON.stringify(out));}"
 ].join('\n'));
 const command='/usr/bin/env ELECTRON_RUN_AS_NODE=1 '+[process.execPath,script].map(q).join(' ');
 const hooks={};for(const event of ['UserPromptSubmit','PreToolUse','PostToolUse','SessionStart','Stop','Interrupt'])hooks[event]=[{hooks:[{type:'command',command,timeout:event==='Interrupt'?2:60}]}];
 const privateDir=path.join(root,'build/qa-private');fs.mkdirSync(privateDir,{recursive:true,mode:0o700});
 const backup=path.join(privateDir,'hooks-config-'+crypto.randomUUID()+'.toml');fs.writeFileSync(backup,original,{mode:0o600});
 const s={at:new Date().toISOString(),fixture,cwd,token,denyFile,backup,originalSHA256:sha(original)};
 fs.writeFileSync(stateFile,JSON.stringify(s,null,2),{mode:0o600});
 fs.writeFileSync(hookFile,JSON.stringify({hooks},null,2)+'\n',{mode:0o600});
 fs.writeFileSync(config,original.toString()+'\n[features]\nhooks = true\n',{mode:0o600});
 const b=new NativeHooksBinding({binary:path.join(root,'build/OpenCodex.app/Contents/Resources/opencodex-hooks-helper'),cwd,codexHome:home,threadId:crypto.randomUUID(),nonce:crypto.randomUUID(),events:[],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 let inventory;try{inventory=await b.ready;}finally{await b.close();}
 assert.equal(inventory.hooks.length,6);assert(inventory.hooks.every(h=>h.trustStatus==='untrusted'));
 const trust=inventory.hooks.map(h=>'\n[hooks.state.'+JSON.stringify(h.key)+']\nenabled = true\ntrusted_hash = '+JSON.stringify(h.currentHash)+'\n').join('');
 fs.appendFileSync(config,trust);
 s.fixtureConfigSHA256=sha(fs.readFileSync(config));s.fixtureHooksSHA256=sha(fs.readFileSync(hookFile));
 fs.writeFileSync(stateFile,JSON.stringify(s,null,2),{mode:0o600});
 console.log(JSON.stringify({prepared:true,fixture,cwd,hooks:inventory.hooks.map(h=>({event:h.eventName,key:h.key})),configBackupSHA256:s.originalSHA256}));
})().catch(e=>{console.error(e.stack);process.exitCode=1});
