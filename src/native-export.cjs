'use strict';
// Markdown export of a Codex thread (live thread/read result or the offline native-history cache).
// Messages are kept whole; tool work is summarised so the file stays readable and never dumps secrets
// such as environment variables or raw tool arguments.
const fs=require('node:fs'),path=require('node:path');
const when=s=>{const n=Number(s);if(!n)return '';const d=new Date(n>1e12?n:n*1000);return d.toLocaleString('zh-TW',{hour12:false});};
const text=item=>Array.isArray(item?.content)?item.content.map(c=>c?.type==='text'?c.text:c?.type==='image'||c?.type==='localImage'?'（圖片）':'').join('\n'):typeof item?.text==='string'?item.text:'';
const clip=(s,n)=>{s=String(s??'');return s.length>n?s.slice(0,n)+'\n…（已截斷，共 '+s.length+' 字）':s;};
const fence=(body,lang='')=>{const ticks=/```/.test(body)?'````':'```';return ticks+lang+'\n'+body+'\n'+ticks;};
function toolBlock(item){
 switch(item.type){
  case 'commandExecution':{const cmd=Array.isArray(item.command)?item.command.join(' '):item.command||'';const out=clip(item.aggregatedOutput||'',4000);return '<details><summary>指令：'+clip(cmd,200).replace(/\n/g,' ')+(item.exitCode!=null?'（結束碼 '+item.exitCode+'）':'')+'</summary>\n\n'+fence(out)+'\n\n</details>';}
  case 'mcpToolCall':return '<details><summary>工具：'+(item.server?item.server+' · ':'')+(item.tool||'')+(item.status?'（'+item.status+'）':'')+'</summary>\n\n'+fence(clip(typeof item.result==='string'?item.result:JSON.stringify(item.result?.content??item.result??item.error??'',null,1),3000))+'\n\n</details>';
  case 'fileChange':{const files=(item.changes||[]).map(c=>'- '+(c.kind||'')+' `'+(c.path||'')+'`').join('\n');return '**檔案變更**'+(item.status?'（'+item.status+'）':'')+'\n'+files;}
  case 'webSearch':return '**網路搜尋**：'+clip(item.query||'',200);
  case 'imageView':return '**檢視圖片**：`'+(item.path||'')+'`';
  case 'contextCompaction':return '_（上下文已壓縮）_';
  case 'subAgentActivity':case 'collabAgentToolCall':return '_（子代理活動：'+clip(item.summary||item.tool||item.type,120)+'）_';
  case 'reasoning':{const s=(item.summary||[]).map(x=>typeof x==='string'?x:x?.text||'').filter(Boolean).join('\n');return s?'<details><summary>思考摘要</summary>\n\n'+clip(s,2000)+'\n\n</details>':'';}
  default:return '';
 }
}
function threadToMarkdown(thread,{host='',includeReasoning=true}={}){
 const out=[];
 const title=(thread.name||thread.preview||'未命名對話').replace(/\s+/g,' ').trim();
 out.push('# '+title,'');
 const meta=[];
 if(host)meta.push('主機：'+host);if(thread.model)meta.push('模型：'+thread.model+(thread.reasoningEffort?'（'+thread.reasoningEffort+'）':''));
 if(thread.cwd)meta.push('工作資料夾：`'+thread.cwd+'`');if(thread.createdAt)meta.push('建立：'+when(thread.createdAt));if(thread.updatedAt)meta.push('更新：'+when(thread.updatedAt));
 meta.push('對話識別碼：`'+thread.id+'`');
 out.push(meta.map(m=>'- '+m).join('\n'),'');
 (thread.turns||[]).forEach((turn,index)=>{
  const items=turn.items||[];
  out.push('## 回合 '+(index+1)+(turn.startedAt?' · '+when(turn.startedAt):'')+(turn.status&&turn.status!=='completed'?'（'+turn.status+'）':''),'');
  for(const item of items){
   if(item.type==='userMessage'){const t=text(item).replace(/^\s*# Files mentioned by the user:[\s\S]*?## My request:\s*/,'').trim();out.push('### 你','',t||'（無文字）','');}
   else if(item.type==='agentMessage'){const t=text(item).trim();if(t)out.push('### ChatGPT'+(item.phase&&item.phase!=='final_answer'?'（'+item.phase+'）':''),'',t,'');}
   else if(item.type==='reasoning'&&!includeReasoning)continue;
   else{const b=toolBlock(item);if(b)out.push(b,'');}
  }
 });
 return out.join('\n').replace(/\n{3,}/g,'\n\n');
}
const safeName=s=>String(s||'對話').replace(/[\\/:*?"<>|\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim().slice(0,80)||'對話';
function writeMarkdown(dir,thread,options={}){
 fs.mkdirSync(dir,{recursive:true});
 const base=safeName(thread.name||thread.preview)+' · '+String(thread.id).slice(0,8);
 let file=path.join(dir,base+'.md');
 const body=threadToMarkdown(thread,options);
 fs.writeFileSync(file,body,{mode:0o600});
 return file;
}
module.exports={threadToMarkdown,writeMarkdown,safeName};
