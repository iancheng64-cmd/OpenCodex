'use strict';
// Private stdio worker. The parent launches it inside the native permission sandbox.
// Tool arguments never select a profile, alter the launcher, or elevate permissions.
function start({abRoot,resourcesPath}){
 const path=require('node:path');
 if(resourcesPath)process.resourcesPath=resourcesPath;
 const {LocalToolHost}=require(path.join(abRoot,'dist-main/local-tool-host.js'));
 const {AgentCoreTools}=require(path.join(abRoot,'dist-main/agent-core-tools.js'));
 const cwd=process.cwd(),controllers=new Map(),observed=new Set();
 const host=new LocalToolHost({allowedRoots:[cwd],fullFilesystemAccess:true,
  administratorRead:async()=>{throw Error('Administrator access is unavailable in a custom sandbox');}});
 host.roots=[cwd];host.registerFilesystem();
 const {spawn}=require('node:child_process');
 const registrations=new Map(),launches=new WeakMap();
 const core=new AgentCoreTools({cwd,guard:(...args)=>host.guard(...args),capabilities:()=>({}),
  spawnProcess(command,args,options){
   const child=spawn(process.execPath,[path.join(__dirname,'native-permissions-process-gate.cjs')],{...options,stdio:['pipe','pipe','pipe','pipe']});
   child.stdio[3].on('error',()=>{});launches.set(child,{command,args});return child;
  },
  async onProcessStarted(job){
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{registrations.delete(job.id);reject(Error('Process registration timed out'));},10000);
    registrations.set(job.id,{pid:job.pid,resolve:()=>{clearTimeout(timer);resolve();},reject:error=>{clearTimeout(timer);reject(error);}});
    jobs();
   });
   if(closing)throw Error('Sandbox worker is closing');
   const launch=launches.get(job.child);launches.delete(job.child);
   await new Promise((resolve,reject)=>job.child.stdio[3].end(JSON.stringify(launch)+'\n',error=>error?reject(error):resolve()));
  }
 });
 const entries=new Map([...host.entries,...core.entries()]);
 const names=[...entries.keys()].filter(n=>n.startsWith('mac_fs_')||n.startsWith('mac_process_'));
 const allowed=new Set(names);
 // This private method is intentionally omitted from the model tool inventory.
 const inputMethod='opencodex/input/read';
 const {readInput}=require('./native-permissions-input.cjs');
 allowed.add(inputMethod);
 let closing=false,buffer=Buffer.alloc(0);
 const emit=value=>{if(!process.stdout.destroyed)process.stdout.write(JSON.stringify(value)+'\n');};
 function jobs(){
  for(const [id,job]of core.jobs){
   if(observed.has(id)||!Number.isInteger(job.pid)||job.pid<=1)continue;
   observed.add(id);emit({event:'process/started',id,pid:job.pid});
   let ended=false;
   const end=()=>{if(!ended){ended=true;emit({event:'process/ended',id,pid:job.pid});}};
   job.child.once('close',end);
   if(job.child.exitCode!==null||job.child.signalCode)end();
  }
 }
 function close(){
  if(closing)return;closing=true;process.stdin.pause();
  for(const controller of controllers.values())controller.abort();
  for(const registration of registrations.values())registration.reject(Error('Sandbox worker closed'));
  registrations.clear();jobs();core.cancel();
  const deadline=setTimeout(()=>{core.cancel();process.exit(0);},1000);
  const children=[...core.jobs.values()].map(job=>job.child.exitCode!==null||job.child.signalCode
   ?Promise.resolve():new Promise(resolve=>job.child.once('close',resolve)));
  Promise.allSettled(children).then(()=>{clearTimeout(deadline);process.exit(0);});
 }
 function receive(line){
  let message;
  try{message=JSON.parse(line.toString('utf8'));}catch{close();return;}
  if(message?.event==='process/registered'){
   const registration=registrations.get(message.id);
   if(!registration||registration.pid!==message.pid){close();return;}
   registrations.delete(message.id);registration.resolve();return;
  }
  const {id,name,args={}}=message||{};
  if(typeof id!=='string'||!id||id.length>80||controllers.has(id)){close();return;}
  if(closing)return;
  if(controllers.size>=16||!allowed.has(name)||!args||typeof args!=='object'||Array.isArray(args)||args.administrator===true){
   emit({id,error:{message:'Tool unavailable in sandbox worker'}});return;
  }
  const controller=new AbortController();controllers.set(id,controller);
  void (async()=>{
   try{
    const result=name===inputMethod?await readInput(args,controller.signal):await entries.get(name).invoke(args,controller.signal);jobs();
    if(!closing)emit({id,result});
   }catch(error){if(!closing)emit({id,error:{message:error.message,code:error.code}});}
   finally{controllers.delete(id);}
  })();
 }
 process.stdin.on('data',chunk=>{
  if(closing)return;
  buffer=Buffer.concat([buffer,chunk]);
  for(;;){
   const end=buffer.indexOf(10);
   if(end<0){if(buffer.length>1048576)close();return;}
   if(end>1048576){close();return;}
   const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
   receive(line);if(closing)return;
  }
 });
 process.stdin.on('end',close);process.stdin.on('error',close);
 process.stdout.on('error',close);process.on('SIGTERM',close);process.on('SIGINT',close);
 process.on('uncaughtException',close);process.on('unhandledRejection',close);
 emit({ready:true,cwd,tools:names});
}
if(require.main===module){
 try{start(JSON.parse(process.argv[2]));}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
module.exports={start};
