'use strict';
// This process owns the job group but cannot launch the user's command until
// the supervising app has recorded its PID. Worker death closes fd 3.
const fs=require('node:fs'),{spawn}=require('node:child_process');
let frame=Buffer.alloc(0),launched=false;
const control=fs.createReadStream(null,{fd:3,autoClose:true});
const timer=setTimeout(()=>process.exit(1),15000);
function fail(){if(!launched)process.exit(1);}
control.on('error',fail);control.on('end',fail);
control.on('data',chunk=>{
 if(launched)return;
 frame=Buffer.concat([frame,chunk]);
 if(frame.length>512*1024){fail();return;}
 const newline=frame.indexOf(10);if(newline<0)return;
 try{
  const request=JSON.parse(frame.subarray(0,newline).toString('utf8'));
  if(typeof request.command!=='string'||!Array.isArray(request.args)||request.args.some(arg=>typeof arg!=='string'))throw Error('Invalid launch');
  launched=true;clearTimeout(timer);control.destroy();
  const child=spawn(request.command,request.args,{cwd:process.cwd(),env:process.env,stdio:'inherit',detached:false});
  child.once('error',()=>process.exit(1));
  child.once('exit',(code,signal)=>{process.exitCode=code===null?1:code;});
 }catch{process.exit(1);}
});
