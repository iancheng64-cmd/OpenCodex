'use strict';
// Terminal rendering and prompts. No third-party dependencies.
const readline=require('node:readline');
const tty=process.stdout.isTTY&&!process.env.NO_COLOR;
const c=(code,s)=>tty?'\x1b['+code+'m'+s+'\x1b[0m':String(s);
const color={dim:s=>c('2',s),bold:s=>c('1',s),red:s=>c('31',s),green:s=>c('32',s),yellow:s=>c('33',s),blue:s=>c('34',s),magenta:s=>c('35',s),cyan:s=>c('36',s),gray:s=>c('90',s)};
let streamed='',streaming=false;
// When a full-screen TUI is active it receives every output and prompt instead of stdout/readline.
let sink=null;
function setSink(value){sink=value;}
const out=s=>process.stdout.write(s);
function startStream(){if(sink)return sink.startStream?.();streamed='';streaming=true;}
function stream(text){
 if(sink)return sink.stream(text);
 // Providers emit cumulative text; print only the new suffix. If the text was rewritten, reprint from a new line.
 if(!streaming)startStream();
 if(text.startsWith(streamed)){out(text.slice(streamed.length));}
 else{out('\n'+color.dim('[內容已修正]')+'\n'+text);}
 streamed=text;
}
function endStream(){if(sink)return sink.endStream();if(streaming&&streamed&&!streamed.endsWith('\n'))out('\n');streaming=false;streamed='';}
function line(s=''){if(sink)return sink.print(s);if(streaming&&streamed&&!streamed.endsWith('\n')){out('\n');streamed+='\n';}out(s+'\n');}
function info(s){line(color.gray('· '+s));}
function warn(s){line(color.yellow('! '+s));}
function error(s){line(color.red('✗ '+s));}
function ok(s){line(color.green('✓ '+s));}
function tool(e){
 if(sink)return sink.tool(e);
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
 if(sink)return sink.inputBox({prompt:strip(prompt)}).then(v=>v===null?'':v);
 interface_();out(prompt);
 if(queue.length){const l=queue.shift();if(!process.stdin.isTTY)out(l+'\n');return Promise.resolve(l);}
 if(closed)return Promise.resolve(null);
 return new Promise(resolve=>{waiter=resolve;});
}
async function secret(prompt){
 if(sink)return (await sink.inputBox({prompt:strip(prompt),secret:true}))||'';
 const r=interface_();const output=r.output;const write=output.write.bind(output);
 out(prompt);
 output.write=(s,...rest)=>{if(typeof s==='string'&&!s.includes('\n'))return true;return write(s,...rest);};
 try{if(queue.length)return queue.shift();if(closed)return null;return await new Promise(resolve=>{waiter=resolve;});}finally{output.write=write;out('\n');}
}
// Approval prompt used by every provider. Returns 'accept' | 'acceptForSession' | 'decline'.
// Generic chooser: TUI overlay, or a numbered list on plain terminals. items: [{label, description, value}].
async function select({title,items,hint}){
 if(!items.length)return null;
 if(sink)return sink.select({title,items,hint});
 line(color.bold(title));
 items.forEach((it,i)=>line('  '+(i+1)+') '+it.label+(it.description?color.dim('  '+it.description):'')));
 const a=(await question(color.cyan('  選擇編號（Enter 取消）› '))).trim();const n=Number(a);
 return Number.isInteger(n)&&n>=1&&n<=items.length?items[n-1].value:null;
}
async function approve({title,detail,allowSession=true}){
 if(sink){
  const lines=detail?String(detail).split('\n').slice(0,20):[];
  const items=[{label:'允許',description:'(y)',value:'accept'},...(allowSession?[{label:'允許，此工作階段不再詢問',description:'(a)',value:'acceptForSession'}]:[]),{label:'拒絕',description:'(n)',value:'decline'}];
  const r=await sink.select({title:title+(lines.length?'\n'+lines.map(l=>color.dim(l)).join('\n'):''),items,hotkeys:{y:'accept',a:allowSession?'acceptForSession':'accept',n:'decline'},hint:'y 允許 · a 本工作階段都允許 · n 拒絕'});
  return r||'decline';
 }
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
 const answers={};
 if(sink){
  for(const q of questions||[]){
   const options=(q.options||[]).map((o,i)=>typeof o==='string'?{label:o,value:o}:{label:o.label||o.value||String(i+1),value:o.value??o.label,description:o.description});
   let chosen=null;
   if(options.length)chosen=await sink.select({title:(q.header?'['+q.header+'] ':'')+q.question,items:[...options,{label:'其他（自行輸入）',value:'\u0000other'}]});
   if(chosen===null||chosen==='\u0000other')chosen=await sink.inputBox({prompt:(q.header?'['+q.header+'] ':'')+q.question});
   answers[q.id]={answers:[chosen??'']};
  }
  return answers;
 }
 endStream();
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
const strip=s=>String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
module.exports={color,line,info,warn,error,ok,tool,table,stream,startStream,endStream,question,secret,approve,ask,select,setSink,closeInterface,interface:interface_,tty};
