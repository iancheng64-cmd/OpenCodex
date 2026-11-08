'use strict';
// Unit tests for the rollout mirror and cross-host continuation helpers (no engine needed).
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib'),crypto=require('node:crypto');
const R=require('../src/native-rollouts.cjs');
const results={};let failures=0;
async function test(name,fn){try{await fn();results[name]='ok';}catch(error){failures++;results[name]='FAIL: '+(error.stack||error.message);}}
const ID='11111111-2222-7333-8444-555555555555',P='profile-a';
const rolloutText=[JSON.stringify({timestamp:'2026-11-08T01:02:03.000Z',type:'session_meta',payload:{id:ID,session_id:ID,timestamp:'2026-11-08T01:02:03.000Z',cwd:'/tmp/p',originator:'t',cli_version:'0.160.0',source:'vscode'}}),JSON.stringify({timestamp:'2026-11-08T01:02:04.000Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'hi'}]}})].join('\n')+'\n';
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ocx-rollouts-'));
 try{
  await test('store roundtrip keeps bytes, meta and basename',async()=>{
   const store=new R.NativeRollouts(dir);
   assert.equal(store.has(ID,P),false);
   const meta=store.set(ID,P,Buffer.from(rolloutText),{remotePath:'/home/u/.codex/sessions/2026/11/08/rollout-2026-11-08T01-02-03-'+ID+'.jsonl',updatedAt:1762563724});
   assert.equal(meta.basename,'rollout-2026-11-08T01-02-03-'+ID+'.jsonl');
   assert.equal(store.has(ID,P),true);assert.equal(store.has(ID,'other'),false);
   const got=store.get(ID,P);assert.equal(got.data.toString(),rolloutText);assert.equal(got.meta.updatedAt,1762563724);
   assert.ok(fs.existsSync(path.join(dir,crypto.createHash('sha256').update(JSON.stringify([P,ID])).digest('hex')+'.jsonl.gz')));
   store.delete(ID,P);assert.equal(store.has(ID,P),false);
  });
  await test('store rejects foreign or malformed rollouts',async()=>{
   const store=new R.NativeRollouts(dir);
   assert.throws(()=>store.set(ID,P,Buffer.from('not json\n'),{remotePath:'/x/rollout-2026-11-08T01-02-03-'+ID+'.jsonl'}),/session_meta/);
   assert.throws(()=>store.set('other-id',P,Buffer.from(rolloutText),{remotePath:'/x/rollout-2026-11-08T01-02-03-'+ID+'.jsonl'}),/不屬於此對話/);
   assert.throws(()=>store.set(ID,P,Buffer.alloc(R.MAX_BYTES+1,1),{remotePath:'/x/a.jsonl'}),/MB/);
   // A compressed rollout cannot be inspected; it is stored as-is and flagged.
   const meta=store.set(ID,P,zlib.gzipSync('zzz'),{remotePath:'/x/rollout-2026-11-08T01-02-03-'+ID+'.jsonl.zst',compressed:true});
   assert.equal(meta.compressed,true);store.delete(ID,P);
  });
  await test('sessions path follows the engine layout from the file name date',async()=>{
   const name=R.basenameFor({id:ID,createdAt:1762563723});
   assert.equal(name,'rollout-2025-11-08T01-02-03-'+ID+'.jsonl');
   assert.equal(R.basenameFor({id:ID,createdAt:1762563723000}),name);
   assert.equal(R.sessionsPath('/home/u/.codex',name),'/home/u/.codex/sessions/2025/11/08/'+name);
   assert.throws(()=>R.sessionsPath('relative',name),/絕對路徑/);
   assert.throws(()=>R.sessionsPath('/h','../etc/passwd'),/無法辨識/);
  });
  await test('synthesized legacy rollout pairs model items with display events for each turn',async()=>{
   const thread={id:ID,sessionId:'sess',createdAt:1762563723,updatedAt:1762563800,cwd:'/tmp/p',originator:'OpenCodex',cliVersion:'0.160.0',modelProvider:'openai',turns:[
    {id:'t1',startedAt:1762563724,completedAt:1762563730,status:'completed',items:[{type:'userMessage',id:'u1',content:[{type:'text',text:'first'}]},{type:'reasoning',id:'r1',summary:['thinking'],content:[]},{type:'commandExecution',id:'c1',command:'ls',aggregatedOutput:'a\nb',exitCode:0,status:'completed'},{type:'agentMessage',id:'a1',text:'done'}]},
    {id:'t2',startedAt:1762563740,completedAt:1762563750,status:'completed',items:[{type:'subAgentActivity',id:'s1'}]},
    {id:'t3',startedAt:1762563760,completedAt:1762563770,status:'completed',items:[{type:'userMessage',id:'u2',content:[{type:'text',text:'second'}]},{type:'fileChange',id:'f1',status:'completed',changes:[{path:'a.txt',kind:'update',diff:'@@ -1 +1 @@\n-a\n+b'}]},{type:'mcpToolCall',id:'m1',server:'srv',tool:'tool',arguments:{q:1},result:{ok:true}},{type:'webSearch',id:'w1',query:'x'},{type:'agentMessage',id:'a2',text:'ok'}]}]};
   const lines=R.synthesize(thread).toString().trimEnd().split('\n').map(l=>JSON.parse(l));
   assert.equal(lines[0].type,'session_meta');assert.equal(lines[0].payload.id,ID);assert.equal(lines[0].payload.history_mode,'legacy');assert.equal(lines[0].payload.session_id,'sess');
   const kinds=lines.map(l=>l.type+':'+(l.payload.type||''));
   assert.deepEqual(kinds.slice(1,9),['response_item:message','event_msg:user_message','response_item:reasoning','event_msg:agent_reasoning','response_item:function_call','response_item:function_call_output','response_item:message','event_msg:agent_message']);
   const users=lines.filter(l=>l.payload?.type==='user_message');assert.deepEqual(users.map(u=>u.payload.message),['first','second']);
   assert.deepEqual(lines.filter(l=>l.payload?.type==='agent_message').map(u=>u.payload.message),['done','ok']);
   assert.equal(lines.find(l=>l.payload?.type==='agent_reasoning').payload.text,'thinking');
   assert.ok(!lines.some(l=>l.payload?.type==='turn_complete'));
   assert.ok(lines.some(l=>l.payload?.type==='custom_tool_call'&&l.payload.name==='apply_patch'&&l.payload.input.includes('*** Update File: a.txt')));
   assert.ok(lines.some(l=>l.payload?.type==='function_call'&&l.payload.name==='mcp__srv__tool'));
   assert.ok(lines.some(l=>l.payload?.type==='web_search_call'));
   assert.ok(R.sessionMeta(R.synthesize(thread)));
   assert.throws(()=>R.synthesize({id:ID,turns:[]}),/沒有可合成/);
  });
  // A fake host behind an ssh2-like exec(): the few shell commands the module uses act on a file map.
  function fakeHost(){
   const {EventEmitter}=require('node:events');const files=new Map(),commands=[];
   const conn={files,commands,exec(command,_opts,cb){
    commands.push(command);const stream=new EventEmitter();stream.stderr=new EventEmitter();
    const finish=(code,stdout='')=>setImmediate(()=>{if(stdout.length)stream.emit('data',Buffer.isBuffer(stdout)?stdout:Buffer.from(stdout));stream.emit('close',code,null);});
    const unq=s=>s.replace(/^'|'$/g,'').replace(/'\\''/g,"'");
    let m;
    stream.end=data=>{
     if((m=/^stat -f %z ('(?:[^']|'\\'')*')/.exec(command))){const f=files.get(unq(m[1]));return finish(f?0:1,f?String(f.length)+'\n':'');}
     if((m=/^cat ('(?:[^']|'\\'')*')$/.exec(command))){const f=files.get(unq(m[1]));return f?finish(0,f):(stream.stderr.emit('data',Buffer.from('cat: missing')),finish(1));}
     if((m=/^mkdir -p ('(?:[^']|'\\'')*') && cat > ('(?:[^']|'\\'')*') && mv -f \2 ('(?:[^']|'\\'')*')$/.exec(command))){files.set(unq(m[3]),Buffer.from(data));return finish(0);}
     if(command.includes('CODEX_HOME'))return finish(0,'Last login banner\n/srv/home/.codex\n');
     stream.stderr.emit('data',Buffer.from('unexpected '+command));finish(127);
    };
    setImmediate(()=>cb(null,stream));
   }};
   return conn;
  }
  await test('upload writes through a temp file over ssh and verifies the size',async()=>{
   const conn=fakeHost();const big=Buffer.alloc(3*1024*1024+123,7);
   const r=await R.upload(conn,"/h/.codex/sessions/2026/11/08/it's a.jsonl",big);
   assert.equal(r.bytes,big.length);assert.equal(conn.files.get("/h/.codex/sessions/2026/11/08/it's a.jsonl").equals(big),true);
   assert.ok(conn.commands[0].startsWith("mkdir -p '/h/.codex/sessions/2026/11/08' && cat > '/h/.codex/sessions/2026/11/08/it'\\''s a.jsonl.tmp'"));
   assert.equal(conn.commands.length,2);
  });
  await test('download reads the file, falls back to .zst, and codex home comes from paths or the shell',async()=>{
   const conn=fakeHost();conn.files.set('/x/r.jsonl.zst',Buffer.from('zst-bytes'));
   const z=await R.download(conn,'/x/r.jsonl');assert.equal(z.compressed,true);assert.equal(z.remotePath,'/x/r.jsonl.zst');assert.equal(z.data.toString(),'zst-bytes');
   conn.files.set('/x/r.jsonl',Buffer.from(rolloutText));
   const p=await R.download(conn,'/x/r.jsonl');assert.equal(p.compressed,false);assert.equal(p.data.toString(),rolloutText);
   await assert.rejects(R.download(conn,'/x/none.jsonl'),/找不到/);
   assert.equal(R.codexHomeFromPaths([null,'/alt/.codex/sessions/2026/11/08/rollout-x.jsonl']),'/alt/.codex');
   assert.equal(R.codexHomeFromPaths(['relative/sessions/x']),null);
   assert.equal(await R.remoteCodexHomeViaShell(conn),'/srv/home/.codex');
   await assert.rejects(R.sshExec({},'true'),/無法執行指令/);
  });
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 const passed=Object.values(results).filter(v=>v==='ok').length,total=Object.keys(results).length;
 console.log(JSON.stringify({passed:failures===0,summary:passed+'/'+total,results},null,1));
 process.exit(failures?1:0);
})();
