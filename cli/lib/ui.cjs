'use strict';
// Terminal rendering and prompts. No third-party dependencies.
const readline=require('node:readline');
const tty=process.stdout.isTTY&&!process.env.NO_COLOR;
const c=(code,s)=>tty?'\x1b['+code+'m'+s+'\x1b[0m':String(s);
const color={dim:s=>c('2',s),bold:s=>c('1',s),red:s=>c('31',s),green:s=>c('32',s),yellow:s=>c('33',s),blue:s=>c('34',s),magenta:s=>c('35',s),cyan:s=>c('36',s),gray:s=>c('90',s)};
let streamed='',streaming=false;
const out=s=>process.stdout.write(s);
function startStream(){streamed='';streaming=true;}
function stream(text){
 // Providers emit cumulative text; print only the new suffix. If the text was rewritten, reprint from a new line.
 if(!streaming)startStream();
 if(text.startsWith(streamed)){out(text.slice(streamed.length));}
 else{out('\n'+color.dim('[內容已修正]')+'\n'+text);}
 streamed=text;
}
function endStream(){if(streaming&&streamed&&!streamed.endsWith('\n'))out('\n');streaming=false;streamed='';}
function line(s=''){if(streaming&&streamed&&!streamed.endsWith('\n')){out('\n');streamed+='\n';}out(s+'\n');}
function info(s){line(color.gray('· '+s));}
function warn(s){line(color.yellow('! '+s));}
function error(s){line(color.red('✗ '+s));}
function ok(s){line(color.green('✓ '+s));}
function tool(e){
 const status=e.status==='running'?color.cyan('▶'):e.status==='completed'?color.green('✓'):color.red('✗');
 const title=String(e.title||e.tool||'tool').split('\n')[0].slice(0,120);
 let detail='';
 if(e.status!=='running'&&e.text){const t=String(e.text).trim();if(t)detail=color.dim(' → '+t.replace(/\s+/g,' ').slice(0,160));}
 else if(e.status==='running'&&e.text&&e.text!=='{}'){detail=color.dim(' '+String(e.text).replace(/\s+/g,' ').slice(0,120));}
 line(status+' '+color.bold(title)+detail);
}
function table(rows){const w=rows.reduce((m,r)=>r.map((v,i)=>Math.max(m[i]||0,String(v).length)),[]);for(const r of rows)line(r.map((v,i)=>String(v).padEnd(w[i])).join('  '));}
// Lines typed (or piped) while no prompt is waiting are queued, never dropped.
let rl=null,closed=false,waiter=null;const queue=[];
function interface_(){
 if(!rl){
  rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:!!process.stdin.isTTY});
  rl.on('line',l=>{if(waiter){const w=waiter;waiter=null;w(l);}else queue.push(l);});
  rl.on('close',()=>{rl=null;closed=true;if(waiter){const w=waiter;waiter=null;w(null);}});
 }
 return rl;
}
function closeInterface(){if(rl){rl.close();rl=null;}}
function question(prompt){
 interface_();out(prompt);
 if(queue.length){const l=queue.shift();if(!process.stdin.isTTY)out(l+'\n');return Promise.resolve(l);}
 if(closed)return Promise.resolve(null);
 return new Promise(resolve=>{waiter=resolve;});
}
async function secret(prompt){
 const r=interface_();const output=r.output;const write=output.write.bind(output);
 out(prompt);
 output.write=(s,...rest)=>{if(typeof s==='string'&&!s.includes('\n'))return true;return write(s,...rest);};
 try{if(queue.length)return queue.shift();if(closed)return null;return await new Promise(resolve=>{waiter=resolve;});}finally{output.write=write;out('\n');}
}
// Approval prompt used by every provider. Returns 'accept' | 'acceptForSession' | 'decline'.
async function approve({title,detail,allowSession=true}){
 endStream();
 line(color.yellow('⚠ '+title));
 if(detail)for(const l of String(detail).split('\n').slice(0,40))line(color.dim('  '+l));
 const hint=allowSession?'[y]允許 / [a]此工作階段都允許 / [n]拒絕':'[y]允許 / [n]拒絕';
 for(;;){
  const a=(await question(color.yellow('  '+hint+' › '))).trim().toLowerCase();
  if(['y','yes','是'].includes(a))return 'accept';
  if(allowSession&&['a','all','always'].includes(a))return 'acceptForSession';
  if(['n','no','否',''].includes(a))return 'decline';
 }
}
async function ask(questions){
 endStream();const answers={};
 for(const q of questions||[]){
  line(color.yellow('? '+(q.header?'['+q.header+'] ':'')+q.question));
  const options=(q.options||[]).map((o,i)=>typeof o==='string'?{label:o,value:o}:{label:o.label||o.value||String(i+1),value:o.value??o.label});
  options.forEach((o,i)=>line(color.dim('  '+(i+1)+') '+o.label)));
  const a=(await question(color.yellow('  回答（數字或文字）› '))).trim();
  const n=Number(a);const chosen=Number.isInteger(n)&&n>=1&&n<=options.length?options[n-1].value:a;
  answers[q.id]={answers:[chosen]};
 }
 return answers;
}
module.exports={color,line,info,warn,error,ok,tool,table,stream,startStream,endStream,question,secret,approve,ask,closeInterface,interface:interface_,tty};
