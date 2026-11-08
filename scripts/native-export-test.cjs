'use strict';
// Markdown export: whole messages, summarised tool work, safe filenames, no raw secrets.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {threadToMarkdown,writeMarkdown,safeName}=require('../src/native-export.cjs');
const tests=[];
const thread={id:'01a1aaaa-0000-7000-8000-000000000001',name:'匯出測試 / 斜線:冒號',model:'gpt-6.1-sol',reasoningEffort:'medium',cwd:'/tmp/project',createdAt:1793973842,updatedAt:1794110919,
 turns:[
  {id:'t1',status:'completed',startedAt:1793973855,items:[
   {type:'userMessage',content:[{type:'text',text:'\n# Files mentioned by the user:\n\n## notes.md: /tmp/notes.md\n\nsecret-looking preamble\n\n## My request:\n請整理待辦'}]},
   {type:'reasoning',summary:[{type:'summary_text',text:'先讀檔案'}]},
   {type:'agentMessage',phase:'commentary',text:'我先讀取檔案。'},
   {type:'commandExecution',command:['ls','-la'],exitCode:0,aggregatedOutput:'total 0\n```\ninner fence\n```\n'},
   {type:'mcpToolCall',server:'opencodex_mac',tool:'mac_fs_read',status:'completed',result:{content:[{type:'text',text:'x'.repeat(5000)}]}},
   {type:'fileChange',status:'completed',changes:[{kind:'update',path:'/tmp/project/a.txt'}]},
   {type:'agentMessage',phase:'final_answer',text:'整理完成。'}]},
  {id:'t2',status:'interrupted',items:[{type:'userMessage',content:[{type:'text',text:'第二個問題'}]},{type:'contextCompaction'}]}]};
const md=threadToMarkdown(thread,{host:'msi'});
assert.match(md,/^# 匯出測試 \/ 斜線:冒號\n/,'title from thread name');
assert.match(md,/- 主機：msi\n- 模型：gpt-6.1-sol（medium）/);
assert.equal((md.match(/^### 你$/gm)||[]).length,2);
assert.equal((md.match(/^### ChatGPT/gm)||[]).length,2);
assert.ok(!md.includes('secret-looking preamble')&&md.includes('請整理待辦'),'file preamble stripped, request kept');
assert.match(md,/<summary>指令：ls -la（結束碼 0）<\/summary>/);
assert.ok(md.includes('````\ntotal 0'),'longer fence when output contains ```');
assert.match(md,/已截斷，共 50\d\d 字/,'long tool results truncated');
assert.match(md,/\*\*檔案變更\*\*（completed）\n- update `\/tmp\/project\/a.txt`/);
assert.match(md,/<summary>思考摘要<\/summary>\n\n先讀檔案/);
assert.match(md,/## 回合 2（interrupted）/);
assert.ok(md.includes('_（上下文已壓縮）_'));
tests.push('markdown keeps messages whole and summarises tool work');
assert.equal(safeName('a/b:c*d?"e<f>g|h'),'a b c d e f g h');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-export-'));
const file=writeMarkdown(dir,thread,{host:'msi'});
assert.equal(path.basename(file),'匯出測試 斜線 冒號 · 01a1aaaa.md');
assert.equal(fs.readFileSync(file,'utf8'),md);
assert.equal((fs.statSync(file).mode&0o777),0o600);
fs.rmSync(dir,{recursive:true,force:true});
tests.push('files use a safe name with the thread id prefix and private permissions');
const report={version:'0.4.15',at:new Date().toISOString(),passed:true,tests};
fs.mkdirSync(path.join(__dirname,'../evidence'),{recursive:true});
fs.writeFileSync(path.join(__dirname,'../evidence/native-export-test.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
