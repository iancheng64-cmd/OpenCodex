'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {patchClaudeAuthProbe}=require('./claude-patches.cjs');
const original=fs.readFileSync(path.join(__dirname,'../vendor/agentbridge/dist-main/claude-auth-probe.js'),'utf8');
const patched=patchClaudeAuthProbe(original);
assert.equal(patchClaudeAuthProbe(patched),patched);
assert.throws(()=>patchClaudeAuthProbe(original.replace('        return { accountKey:','        return { changedKey:')));
function probe({loggedIn=false,platform='darwin',config,item=0,access=36,stdout,throws=false,legacy=false}={}){
 const calls=[],authCalls=[],context={exports:{},process:{platform},require:name=>name==='node:child_process'?{
  execFileSync:(exe,args)=>{authCalls.push(args);if(legacy&&args.includes('--json'))throw {stderr:'error: unknown option --json'};const value=stdout??JSON.stringify({loggedIn,authMethod:loggedIn?'oauth_token':'none'});
   if(throws)throw {stdout:value};return value;},
  spawnSync:(exe,args,opts)=>{calls.push({exe,args,opts});return {status:args.includes('-w')?access:item,stderr:access===36?'User interaction is not allowed.':''};}
 }:require(name)};
 vm.runInNewContext(patched,context);
 // Remote bootstrap serializes only this function; no module closure may be required.
 const remote={exports:{},require:context.require,process:context.process};
 vm.runInNewContext('exports.read = '+context.exports.readNativeClaudeAuthStatus.toString(),remote);
 const account=remote.exports.read('claude',[],{HOME:'/fixture',...(config?{CLAUDE_CONFIG_DIR:config}:{})},'/fixture');
 return {account,calls,authCalls};
}
let p=probe({loggedIn:true});
assert.equal(p.account.authenticated,true);assert.equal(p.calls.length,0);assert.equal(p.account.authProblem,null);
p=probe({throws:true});assert.equal(p.account.verified,false);assert.equal(p.account.authProblem,'credential-unavailable');
assert.equal(p.calls.length,2);for(const c of p.calls){assert.equal(c.opts.stdio[1],'ignore');assert.equal(c.exe,'/usr/bin/security');}
p=probe({item:44});assert.equal(p.account.verified,true);assert.equal(p.account.authenticated,false);assert.equal(p.calls.length,1);
p=probe({access:0});assert.equal(p.account.verified,true);assert.equal(p.account.authProblem,null);
for(const options of [{platform:'linux'},{config:'/custom/claude'}]){p=probe(options);assert.equal(p.calls.length,0);}
p=probe({stdout:'not json'});assert.equal(p.account.verified,false);assert.equal(p.account.authProblem,null);
p=probe({legacy:true,loggedIn:true});assert.equal(p.account.authenticated,true);assert.equal(p.authCalls.length,2);assert(!p.authCalls[1].includes('--json'));
p=probe({legacy:true,stdout:'Logged in'});assert.equal(p.account.verified,false);
assert.equal(probe({stdout:'invalid json'}).authCalls.length,1);
const recovered={...probe().account,...probe({loggedIn:true}).account};assert.equal(recovered.authProblem,null);assert.equal(recovered.error,null);
console.log('PASS Claude SSH authentication: credential denial, missing login, custom directory, serialization, recovery and secret-output disposal');
