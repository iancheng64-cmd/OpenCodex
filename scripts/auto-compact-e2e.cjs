'use strict';
// Real pinned engine and a mock Responses provider: shows the guessed window compacting far too early,
// and that without it the engine still compacts near the real limit. No external model or network.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),Module=require('node:module');
const {spawn}=require('node:child_process'),EventEmitter=require('node:events'),crypto=require('node:crypto');
const {AppServerRpc}=require('../vendor/agentbridge/dist-main/app-server-rpc');
const {autoCompactWindow}=require('./runtime-patches.cjs');
const root=path.resolve(__dirname,'..'),res=path.join(root,'build/OpenCodex.app/Contents/Resources');
const binary=process.env.OPENCODEX_FIXTURE_ENGINE||path.join(res,'agentbridge/codex/bin/codex');
const policyFile=path.join(root,'vendor/agentbridge/dist-main/runtime-policy.js');
const compile=code=>{const m=new Module(policyFile,module);m.filename=policyFile;m.paths=[];m._compile(code,policyFile);return m.exports;};
const source=fs.readFileSync(policyFile,'utf8'),guessed=compile(source),fixed=compile(autoCompactWindow(source));
const compactKeys=config=>Object.fromEntries(Object.entries(config).filter(([k])=>k.startsWith('model_auto_compact')));
const report={at:new Date().toISOString(),fixtureOnly:true,externalModel:false,cases:{},errors:[]};
let usage=2;
function send(res,input){
 const item={id:'msg_'+crypto.randomUUID(),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'FIXTURE',annotations:[]}]};
 const response={id:'resp_'+crypto.randomUUID(),object:'response',created_at:Math.floor(Date.now()/1000),model:input.model,status:'completed',output:[item],usage:{input_tokens:usage-1,output_tokens:1,total_tokens:usage}};
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
 let seq=0;const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:seq++,...data})+'\n\n');
 const part=item.content[0];
 emit('response.created',{response:{...response,status:'in_progress',output:[]}});
 emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress'}});
 emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
 emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:part.text});
 emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:part.text});
 emit('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part});
 emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response});res.end();
}
const text=value=>[{type:'text',text:value,text_elements:[]}];
async function main(){
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-compact-e2e-')));
 const model=http.createServer((req,res)=>{
  if(req.method!=='POST'||!req.url.startsWith('/v1/responses')){res.writeHead(404);return res.end();}
  let body='';req.on('data',d=>{body+=d;});req.on('end',()=>{try{send(res,JSON.parse(body));}catch(e){report.errors.push(e.stack);res.writeHead(500);res.end();}});
 });
 await new Promise((resolve,reject)=>{model.on('error',reject);model.listen(0,'127.0.0.1',resolve);});
 const codexHome=path.join(temp,'home'),cwd=path.join(temp,'cwd');for(const d of [codexHome,cwd])fs.mkdirSync(d);
 fs.writeFileSync(path.join(codexHome,'config.toml'),['model="gpt-6-astra"','model_provider="fixture"','[model_providers.fixture]','name="Isolated protocol fixture"',`base_url="http://127.0.0.1:${model.address().port}/v1"`,'wire_api="responses"','env_key="OPENCODEX_FIXTURE_KEY"',''].join('\n'));
 const env={PATH:process.env.PATH,HOME:temp,TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',CODEX_HOME:codexHome,OPENCODEX_FIXTURE_KEY:'fixture-only'};
 const child=spawn(binary,['app-server','--listen','stdio://'],{cwd,env,stdio:['pipe','pipe','pipe']});
 const transport=new EventEmitter();transport.write=s=>child.stdin.write(s);transport.close=()=>child.kill('SIGTERM');
 child.stdout.on('data',d=>transport.emit('data',d));child.stderr.resume();child.on('close',()=>transport.emit('close'));
 const rpc=new AppServerRpc(transport);rpc.on('request',m=>rpc.reject(m.id,'Unexpected request in isolated fixture'));
 const seen=[];rpc.on('notification',m=>seen.push(m));
 const closed=new Promise(r=>child.once('close',r));
 try{
  await rpc.request('initialize',{clientInfo:{name:'opencodex-compact-fixture',version:'1'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
  const engineConfig=(await rpc.request('config/read',{includeLayers:false})).config;
  assert.equal(engineConfig.model_context_window??null,null);
  // Two turns: the first reports how full the context is, the second shows whether the engine compacts.
  async function scenario(name,overrides,reported){
   usage=2;seen.length=0;
   const threadId=(await rpc.request('thread/start',{cwd,config:overrides})).thread.id;
   const turn=async value=>{
    const id=(await rpc.request('turn/start',{threadId,input:text(value)})).turn.id,end=Date.now()+30000;
    while(!seen.some(m=>m.method==='turn/completed'&&m.params.turn.id===id)){if(Date.now()>end)throw Error('Timed out: '+name);await new Promise(r=>setTimeout(r,25));}
   };
   usage=reported;await turn('first');usage=2;await turn('second');
   const compactions=seen.filter(m=>m.method==='item/completed'&&m.params.item?.type==='contextCompaction').length;
   const window=seen.filter(m=>m.method==='thread/tokenUsage/updated').at(-1)?.params?.tokenUsage?.modelContextWindow??null;
   report.cases[name]={overrides,reported,compactions,window};
   return {compactions,window};
  }
  const before=compactKeys(guessed.macThreadConfig(engineConfig,null,70)),after=compactKeys(fixed.macThreadConfig(engineConfig,null,70));
  assert.deepEqual(before,{model_auto_compact_token_limit:89600,model_auto_compact_token_limit_scope:'total'});
  assert.deepEqual(after,{});
  assert.deepEqual(compactKeys(fixed.macThreadConfig({model_context_window:200000},null,70)),{model_auto_compact_token_limit:140000,model_auto_compact_token_limit_scope:'total'});
  const reproduced=await scenario('guessed window at 100k',before,100000);
  assert.ok(reproduced.compactions>0,'the guessed limit should compact at 100k');
  const quiet=await scenario('engine threshold at 100k',after,100000);
  assert.equal(quiet.compactions,0,'the engine should not compact at 100k');
  assert.ok(quiet.window>100000,'the fixture model needs a window above the old limit');
  const near=await scenario('engine threshold near the window',after,quiet.window);
  assert.ok(near.compactions>0,'the engine must still compact near its window');
  if(fs.existsSync(path.join(res,'agentbridge/app/dist-main/runtime-policy.js'))){
   const shipped=require(path.join(res,'agentbridge/app/dist-main/runtime-policy.js'));
   report.shipped=compactKeys(shipped.macThreadConfig(engineConfig,null,70));
   assert.deepEqual(report.shipped,{},'the build must carry the fix');
  }
  report.passed=true;
 }finally{
  child.kill('SIGKILL');await closed;try{rpc.close();}catch{}
  await new Promise(r=>model.close(r));fs.rmSync(temp,{recursive:true,force:true});
 }
 fs.mkdirSync(path.join(root,'evidence'),{recursive:true});
 fs.writeFileSync(path.join(root,'evidence/auto-compact-e2e.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report.cases));
}
main().catch(e=>{console.error(e.stack);process.exit(1);});
