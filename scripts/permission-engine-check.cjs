'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{EventEmitter}=require('node:events');
const {AppServerRpc}=require('../vendor/agentbridge/dist-main/app-server-rpc.js');
// A protocol handshake in an owned empty home; no account, model or MCP server.
async function checkPermissionEngine(binary){
 binary=path.resolve(binary);
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-engine-check-')));
 fs.writeFileSync(path.join(home,'owned-fixture'),'OpenCodex permission engine handshake\n');
 const child=spawn(binary,['app-server','--listen','stdio://'],{cwd:home,
  env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8'},stdio:'pipe'});
 const transport=new EventEmitter();
 transport.write=data=>child.stdin.write(data);transport.close=()=>child.kill('SIGTERM');
 const rpc=new AppServerRpc(transport);
 child.stdout.on('data',data=>transport.emit('data',data));child.stderr.resume();
 child.stdin.on('error',error=>transport.emit('error',error));
 child.on('error',error=>transport.emit('error',error));child.on('close',()=>transport.emit('close'));
 rpc.on('request',message=>rpc.reject(message.id,'No operations authorized in a package check'));
 try{
  const result=await rpc.request('initialize',{clientInfo:{name:'opencodex-package-check',version:'1'},capabilities:{experimentalApi:true}},15000);
  for(const capability of ['OpenCodexPermissions/1','OpenCodexGuardian/1'])
   if(!String(result.userAgent||'').split(/\s+/).includes(capability))throw Error('Packaged engine lacks '+capability);
  return {binarySHA256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),userAgent:result.userAgent};
 }finally{
  rpc.close();child.kill('SIGTERM');
  if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{
   const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},1000);
   child.once('close',()=>{clearTimeout(timer);resolve();});
  });
 }
}
module.exports={checkPermissionEngine};
if(require.main===module)checkPermissionEngine(process.argv[2]).then(report=>console.log(JSON.stringify(report)),error=>{console.error(error.stack);process.exitCode=1;});
