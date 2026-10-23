'use strict';
// Only app-owned OAuth tokens; never read another application's credential store.
const path=require('node:path');
const URL='https://connect.composio.dev/mcp';
class ComposioConnection{
 constructor({root,codec,auth,Client,open,onChange=()=>{}}){
  Object.assign(this,{codec,auth,Client,open,onChange});this.file=path.join(root,'mac-mcp-auth.json');
  this.error=null;this.pending=false;this.toolCount=null;this.checking=null;
 }
 provider(){return new this.auth.MacMcpOAuthProvider(this.file,URL,this.codec);}
 state(){return {authenticated:!!this.provider().tokens(),pending:this.pending,toolCount:this.toolCount,error:this.error,url:URL};}
 specs(){return this.provider().tokens()?[{id:'opencodex:composio',name:'composio',transport:'http',url:URL,headers:{},authProvider:this.provider(),startupTimeoutMs:20000,toolTimeoutMs:120000}]:[];}
 async check(){
  if(this.checking)return this.checking;
  this.checking=(async()=>{
   const spec=this.specs()[0];if(!spec)return this.state();
   const client=new this.Client(spec);
   try{const tools=await client.start();this.toolCount=tools.length;this.error=null;}
   catch{this.toolCount=null;this.error='無法取得 Composio 工具，請檢查網路或重新登入。';}
   finally{await client.stop().catch(()=>{});this.onChange();}
   return this.state();
  })();
  try{return await this.checking;}finally{this.checking=null;}
 }
 async login(){
  if(this.pending)throw Error('Composio 登入正在進行，請在瀏覽器完成。');
  this.pending=true;this.error=null;this.onChange();
  try{
   const result=await this.auth.beginMacMcpLogin({file:this.file,url:URL,codec:this.codec,open:this.open,
    notify:message=>{this.pending=false;if(this.provider().tokens()){void this.check();}else this.error=message;this.onChange();}});
   if(result.authenticated){this.pending=false;await this.check();}
   this.onChange();return this.state();
  }catch(error){this.pending=false;this.error=error.message;this.onChange();throw error;}
 }
 close(){if(this.pending)this.auth.stopMacMcpLogin();this.pending=false;}
}
module.exports={ComposioConnection,URL};
