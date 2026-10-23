'use strict';
// Real native hooks library, isolated configuration and owned child processes. No model/API calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const assert=require('node:assert/strict'),readline=require('node:readline');
const root=path.resolve(__dirname,'..'),binary=process.env.OPENCODEX_HOOKS_HELPER||path.join(root,'build/hooks-target/debug/opencodex-hooks-helper');
const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-hooks-helper-')));
const home=path.join(temp,'home'),codexHome=path.join(home,'.codex'),cwd=path.join(temp,'project');
for(const p of [codexHome,cwd])fs.mkdirSync(p,{recursive:true});
const fixture=path.join(temp,'hook.cjs'),log=path.join(temp,'calls.jsonl'),pidFile=path.join(temp,'pids.json');
fs.writeFileSync(fixture,"const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');\nconst [mode,root]=process.argv.slice(2),p=JSON.parse(fs.readFileSync(0,'utf8'));\nfs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify(p)+'\\n');\nlet out={};\nif(mode==='background'||p.prompt==='SLOW'){\n const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});\n fs.writeFileSync(path.join(root,'pids.json'),JSON.stringify([process.pid,child.pid]));\n setInterval(()=>{},1000);\n}else{\n if(p.prompt==='BLOCK')out={decision:'block',reason:'FIXTURE BLOCK'};\n if(p.prompt==='CONTEXT')out={hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'FIXTURE CONTEXT'}};\n if(mode==='rewrite')out={hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'rewritten'}}};\n if(mode==='denyTool')out={hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'FIXTURE DENY'}};\n if(mode==='allowPermission'||mode==='denyPermission')out={hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:mode==='allowPermission'?'allow':'deny',message:'FIXTURE DENY'}}};\n process.stdout.write(JSON.stringify(out));\n}");
const report={timestamp:new Date().toISOString(),fixtureOnly:true,productHooksEnabled:false,binarySha256:createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),checks:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){const v=fn();if(v)return v;await delay(25);}throw Error('timeout: '+label);}
function quote(s){return "'"+s.replaceAll("'","'\\''")+"'";}
const command=mode=>[process.execPath,fixture,mode,temp].map(quote).join(' ');
const handler=mode=>({type:'command',command:command(mode),timeout:30});
const field=name=>'$'+'{'+name+'}';
const hooks={UserPromptSubmit:[{hooks:[handler('prompt')]}],
 PreToolUse:[{matcher:'rewrite|deny',hooks:[handler('rewrite')]},{matcher:'deny',hooks:[handler('denyTool')]},
 {matcher:'mcp_fixture',hooks:[{type:'mcp_tool',server:'fixture',tool:'hook',timeout:10,input:{session_id:field('session_id'),turn_id:field('turn_id'),cwd:field('cwd'),tool_input:field('tool_input')}}]}],
 PermissionRequest:[{hooks:[handler('allowPermission'),handler('denyPermission')]}]};
const other=['PostToolUse','PreCompact','PostCompact','SessionStart','SubagentStart','SubagentStop','Stop','Interrupt','SessionEnd'];
for(const event of other)hooks[event]=[{hooks:[handler('ordinary')]}];
function writeHooks(){fs.writeFileSync(path.join(codexHome,'hooks.json'),JSON.stringify({hooks},null,2));}
function writeTrust(inventory){fs.writeFileSync(path.join(codexHome,'config.toml'),'[features]\nhooks = true\n'+inventory.hooks.map(h=>'\n[hooks.state.'+JSON.stringify(h.key)+']\nenabled = true\ntrusted_hash = '+JSON.stringify(h.currentHash)+'\n').join(''));}
writeHooks();fs.writeFileSync(path.join(codexHome,'config.toml'),'[features]\nhooks = true\n');
const clients=[];
class Client{
 constructor(){
  this.p=spawn(binary,[],{cwd,env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:home,CODEX_HOME:codexHome,TMPDIR:temp,LANG:'en_US.UTF-8',ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']});
  this.pending=new Map;this.notifications=[];this.serial=0;this.stderr='';
  this.p.stderr.on('data',b=>{this.stderr=(this.stderr+b).slice(-10000);});
  readline.createInterface({input:this.p.stdout}).on('line',s=>{
   const m=JSON.parse(s);
   if(m.id!=null){const v=this.pending.get(m.id);if(!v)return;this.pending.delete(m.id);clearTimeout(v.timer);m.error?v.reject(Error(m.error.message)):v.resolve(m.result);}
   else this.notifications.push(m);
  });
  this.exit=new Promise(resolve=>this.p.on('close',(code,signal)=>{this.closed=true;for(const v of this.pending.values()){clearTimeout(v.timer);v.reject(Error('helper closed '+code+' '+signal));}this.pending.clear();resolve({code,signal});}));
  this.p.stdin.on('error',()=>{});
  clients.push(this);
 }
 call(method,params={},id='request-'+(++this.serial)){
  const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('RPC timeout '+method));},15000);this.pending.set(id,{resolve,reject,timer});this.p.stdin.write(JSON.stringify({id,method,params})+'\n');});
  result.catch(()=>{}); // Cleanup may cancel a request before its test awaits it.
  result.id=id;return result;
 }
 async init(identity={threadId}){return this.call('init',{...identity,cwd,codexHome});}
 async close(){if(this.closed)return;await this.call('shutdown');assert.equal((await this.exit).code,0);}
}
const threadId=randomUUID(),turnId='fixture-'+randomUUID();
const base={threadId,cwd,turnId,model:'fixture-model',permissionMode:'default'};
const exec=(c,event,extra={})=>c.call('execute',{...base,event,...extra});
const tool={toolName:'rewrite',toolUseId:'tool-1',toolInput:{command:'original'}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const lines=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
async function check(name,fn){try{const detail=await fn();report.checks.push({name,passed:true,...(detail?{detail}: {})});process.stdout.write('PASS '+name+'\n');}catch(e){report.checks.push({name,passed:false,error:e.stack});throw e;}}
async function nextMcp(c,start){return until(()=>c.notifications.slice(start).find(m=>m.method==='hooks/mcp'),'MCP callback');}
// The fixture writes this file while the check already polls; a half-written file is not a failure.
async function pids(){return until(()=>{if(!fs.existsSync(pidFile))return null;try{return JSON.parse(fs.readFileSync(pidFile,'utf8'));}catch{return null;}},'hook children');}

(async()=>{
 let c=new Client,inventory=await c.init();
 await check('all 12 native event types inventoried without implicit trust',()=>{
  assert.equal(inventory.featureEnabled,true);assert.equal(inventory.hooks.length,15,JSON.stringify(inventory));assert.ok(inventory.hooks.every(h=>h.trustStatus==='untrusted'),JSON.stringify(inventory.hooks.map(h=>h.trustStatus)));
 });
 await check('untrusted hook does not run',async()=>{const r=await exec(c,'UserPromptSubmit',{prompt:'BLOCK'});assert.equal(r.should_stop,false);assert.equal(lines().length,0);});
 await check('thread and canonical workspace ownership enforced',async()=>{
  await assert.rejects(exec(c,'UserPromptSubmit',{prompt:'BLOCK',threadId:randomUUID()}),/ownership mismatch/);
  await assert.rejects(exec(c,'UserPromptSubmit',{prompt:'BLOCK',cwd:home}),/ownership mismatch/);
 });
 writeTrust(inventory);inventory=await c.call('reload');
 await check('explicit fixture hashes unlock only native trusted hooks',()=>assert.ok(inventory.hooks.every(h=>h.trustStatus==='trusted'),JSON.stringify(inventory)));
 await check('prompt blocking and context preserve native IDs',async()=>{
  const blocked=await exec(c,'UserPromptSubmit',{prompt:'BLOCK'});assert.equal(blocked.should_stop,true,JSON.stringify({blocked,inputs:lines()}));assert.match(blocked.stop_reason,/FIXTURE BLOCK/);
  const context=await exec(c,'UserPromptSubmit',{prompt:'CONTEXT'});assert.ok(JSON.stringify(context.additional_contexts).includes('FIXTURE CONTEXT'));
  const input=lines().find(p=>p.prompt==='BLOCK');assert.equal(input.session_id,threadId);assert.equal(input.turn_id,turnId);assert.equal(input.cwd,cwd);
 });
 await check('synchronous completions reach the native UI once with real turn identity',async()=>{
  const start=c.notifications.length;
  const result=await exec(c,'UserPromptSubmit',{prompt:'CONTEXT'});
  const completed=c.notifications.slice(start).filter(m=>m.method==='hooks/completed').map(m=>m.params);
  assert.deepEqual(completed,result.hook_events);assert(completed.length>0);
  assert(completed.every(e=>e.turn_id===turnId));
 });
 await check('PreToolUse rewrite applies but deny wins',async()=>{
  const r=await exec(c,'PreToolUse',tool);assert.deepEqual(r.updated_input,{command:'rewritten'});assert.equal(r.should_block,false);
  const d=await exec(c,'PreToolUse',{...tool,toolName:'deny'});assert.equal(d.should_block,true);assert.equal(d.updated_input,null);
 });
 await check('PermissionRequest denial wins over simultaneous allow',async()=>{const r=await exec(c,'PermissionRequest',tool);assert.equal(r.decision.behavior,'deny');});
 await check('remaining native lifecycle event adapters execute',async()=>{
  for(const event of other){const r=await exec(c,event,{...tool,toolResponse:{ok:true},trigger:'manual',source:'resume',agentId:randomUUID(),agentType:'fixture',stopHookActive:false,lastAssistantMessage:'fixture done'});assert.ok(r.hook_events.length>0,event+': '+JSON.stringify(r));}
 });
 await check('MCP callback retains structured input and real ownership',async()=>{
  const start=c.notifications.length,work=exec(c,'PreToolUse',{...tool,toolName:'mcp_fixture'});
  const {params:p}=await nextMcp(c,start);
  assert.equal(p.threadId,threadId);assert.equal(p.metadata.threadId,threadId);assert.equal(p.arguments.session_id,threadId);assert.equal(p.arguments.turn_id,turnId);assert.deepEqual(p.arguments.tool_input,tool.toolInput);
  await c.call('mcp/response',{callbackId:p.id,output:JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'mcp-rewritten'}}})});
  assert.deepEqual((await work).updated_input,{command:'mcp-rewritten'});
 });
 await check('child command and MCP Hooks retain the root session with actual child routing',async()=>{
  const childId=randomUUID(),child=new Client;
  await child.init({threadId:childId,sessionId:threadId});
  const subagent={agentId:childId,agentType:'default'},childTurn='child-'+randomUUID();
  const start=lines().length;
  await exec(child,'UserPromptSubmit',{threadId:childId,sessionId:'ignored-untrusted-value',turnId:childTurn,subagent,prompt:'CONTEXT'});
  const input=lines().slice(start).find(p=>p.prompt==='CONTEXT');
  assert.equal(input.session_id,threadId);assert.equal(input.agent_id,childId);assert.equal(input.turn_id,childTurn);
  const n=child.notifications.length,work=exec(child,'PreToolUse',{...tool,threadId:childId,turnId:childTurn,subagent,toolName:'mcp_fixture'});
  const {params:p}=await nextMcp(child,n);
  assert.equal(p.threadId,childId);assert.equal(p.metadata.threadId,childId);assert.equal(p.arguments.session_id,threadId);assert.equal(p.arguments.turn_id,childTurn);
  await child.call('mcp/response',{callbackId:p.id,output:'{}'});await work;await child.close();
 });
 await check('MCP cancellation is scoped and late replies are rejected',async()=>{
  const start=c.notifications.length,work=exec(c,'PreToolUse',{...tool,toolName:'mcp_fixture'}),settled=work.then(value=>({value}),error=>({error}));
  const {params:p}=await nextMcp(c,start);
  assert.equal((await c.call('cancel',{executionId:'another-request'})).cancelled,false);
  assert.equal((await c.call('cancel',{executionId:work.id})).cancelled,true);
  assert.match((await settled).error.message,/cancelled/);
  await until(()=>c.notifications.slice(start).find(m=>m.method==='hooks/mcpCancelled'&&m.params.id===p.id),'MCP cancel notification');
  await assert.rejects(c.call('mcp/response',{callbackId:p.id,output:'{}'}),/unknown or expired/);
 });
 await check('empty MCP output is a valid native response',async()=>{
  const start=c.notifications.length,work=exec(c,'PreToolUse',{...tool,toolName:'mcp_fixture'});
  const {params:p}=await nextMcp(c,start);
  await c.call('mcp/response',{callbackId:p.id,output:''});await work;
 });
 await check('cancel removes command descendants and next execution recovers',async()=>{
  const work=exec(c,'UserPromptSubmit',{prompt:'SLOW'}),settled=work.catch(e=>e);
  const owned=await pids();assert.ok(owned.every(alive));assert.equal((await c.call('cancel',{executionId:work.id})).cancelled,true);assert.match((await settled).message,/cancelled/);
  await until(()=>owned.every(pid=>!alive(pid)),'cancel child cleanup');fs.unlinkSync(pidFile);
  assert.equal((await exec(c,'UserPromptSubmit',{prompt:'BLOCK'})).should_stop,true);
 });
 await check('changed command invalidates prior trusted hash',async()=>{
  const before=inventory.hooks.find(h=>h.handler.command===command('prompt'));assert.ok(before);
  hooks.UserPromptSubmit[0].hooks[0].command+=' # fixture changed';writeHooks();inventory=await c.call('reload');
  const after=inventory.hooks.find(h=>h.key===before.key);assert.ok(after);assert.notEqual(after.currentHash,before.currentHash);assert.equal(after.trustStatus,'modified');
  const n=lines().length;assert.equal((await exec(c,'UserPromptSubmit',{prompt:'BLOCK'})).should_stop,false);assert.equal(lines().length,n);
 });
 await c.close();
 await check('stdin EOF cancels foreground command and descendants',async()=>{
  writeTrust(inventory);c=new Client;await c.init();const work=exec(c,'UserPromptSubmit',{prompt:'SLOW'}).catch(e=>e);
  const owned=await pids();c.p.stdin.end();assert.equal((await c.exit).code,0);await work;
  await until(()=>owned.every(pid=>!alive(pid)),'EOF child cleanup');fs.unlinkSync(pidFile);
 });
 await check('shutdown joins native asynchronous hooks and descendants',async()=>{
  hooks.UserPromptSubmit[0].hooks[0]={...handler('background'),async:true};writeHooks();
  c=new Client;inventory=await c.init();writeTrust(inventory);await c.call('reload');
  await exec(c,'UserPromptSubmit',{prompt:'BACKGROUND'});const owned=await pids();assert.ok(owned.every(alive));await c.close();
  await until(()=>owned.every(pid=>!alive(pid)),'background child cleanup');fs.unlinkSync(pidFile);
 });
 report.passed=true;
})().catch(e=>{report.passed=false;report.error=e.stack;process.exitCode=1;process.stderr.write(e.stack+'\n');}).finally(async()=>{
 for(const c of clients){if(!c.closed){c.p.stdin.end();await Promise.race([c.exit,delay(2000)]);if(!c.closed){report.passed=false;report.forcedCleanup=true;c.p.kill('SIGKILL');await c.exit;}}}
 if(fs.existsSync(pidFile)){const owned=JSON.parse(fs.readFileSync(pidFile,'utf8'));if(owned.some(alive)){report.passed=false;report.orphanedFixturePids=owned.filter(alive);for(const pid of report.orphanedFixturePids)process.kill(pid,'SIGKILL');}}
 report.stderr=clients.map(c=>c.stderr).filter(Boolean);
 fs.writeFileSync(path.join(root,'evidence/native-hooks-helper-check.json'),JSON.stringify(report,null,2)+'\n');
 fs.rmSync(temp,{recursive:true,force:true});
 if(!report.passed)process.exitCode=1;
});
