'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {ComposioConnection,URL}=require('../src/composio.cjs');
function fixture(){
 let tokens,notify,starts=0,stops=0,resolve,fail=false,changed=0;
 class Provider{tokens(){return tokens;}}
 class Client{
  constructor(spec){assert.equal(spec.url,URL);assert.deepEqual(spec.headers,{});assert(spec.authProvider instanceof Provider);}
  async start(){starts++;if(fail)throw Error('sensitive upstream response');return new Promise(r=>resolve=r);}
  async stop(){stops++;}
 }
 const connection=new ComposioConnection({root:'/tmp/test-composio',codec:{},auth:{MacMcpOAuthProvider:Provider,
  async beginMacMcpLogin(p){notify=p.notify;return {authenticated:false};},stopMacMcpLogin(){notify=null;}},
  Client,open:()=>{},onChange:()=>changed++});
 return {connection,setTokens:t=>tokens=t,complete:()=>notify('ok'),release:()=>resolve(['tool1','tool2']),
  fail:()=>fail=true,stats:()=>({starts,stops,changed})};
}
test('only app-owned authenticated provider is published; no token in UI state',()=>{
 const f=fixture();assert.deepEqual(f.connection.specs(),[]);f.setTokens({access_token:'secret-token'});
 assert.equal(f.connection.specs().length,1);assert(!JSON.stringify(f.connection.state()).includes('secret-token'));
 assert.equal(f.connection.file,'/tmp/test-composio/mac-mcp-auth.json');
});
test('concurrent tool checks share one connection and close it',async()=>{
 const f=fixture();f.setTokens({access_token:'secret-token'});const a=f.connection.check(),b=f.connection.check();
 assert.equal(f.stats().starts,1);f.release();assert.equal((await a).toolCount,2);await b;assert.equal(f.stats().stops,1);
});
test('verification failures are visible without exposing upstream secrets',async()=>{
 const f=fixture();f.setTokens({access_token:'secret-token'});f.fail();const s=await f.connection.check();
 assert.equal(s.toolCount,null);assert(s.error);assert(!JSON.stringify(s).includes('sensitive'));assert.equal(f.stats().stops,1);
});
test('OAuth completion triggers real tool verification',async()=>{
 const f=fixture();assert.equal((await f.connection.login()).pending,true);
 await assert.rejects(f.connection.login(),/正在進行/);
 f.setTokens({access_token:'secret-token'});f.complete();assert.equal(f.connection.state().pending,false);
 f.release();await f.connection.check();assert.equal(f.connection.state().toolCount,2);
});
