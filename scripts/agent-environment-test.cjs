'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AgentEnvironment,installCoreTools,runtimeInstructions,frontmatter,terms}=require('../src/agent-environment.cjs');
const tests=[];async function test(name,fn){await fn();tests.push(name);}
const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ocx-agent-env-'))),appRoot=path.join(home,'app');
const skill=(root,dir,body)=>{const target=path.join(home,root,dir);fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'SKILL.md'),body);return target;};
const meta=(name,description)=>`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody of ${name}.\n`;
(async()=>{
 try{
  const project=path.join(home,'work/repo');fs.mkdirSync(project,{recursive:true});
  skill('.codex/skills','pdf-tools',meta('pdf-tools','Create and edit PDF documents'));
  skill('.codex/skills/.system','skill-creator',meta('skill-creator','Create new skills'));
  skill('.agents/skills','pdf-tools',meta('pdf-tools','A shadowed duplicate that must lose'));
  skill('.agents/skills','browser-qa',meta('browser-qa','Drive a browser for QA testing'));
  const reference=skill('.claude/skills','apple-design',meta('apple-design','Apple 風格介面設計與動態規範'));
  fs.mkdirSync(path.join(reference,'references'));fs.writeFileSync(path.join(reference,'references/motion.md'),'motion');
  skill('.hermes/skills/creative','slides',`---\nname: slides\ndescription: >-\n  Build slide decks\n  from an outline\n---\n`);
  skill('.config/opencode/skills','no-frontmatter','# Title\n\nExplains a task without metadata.\n');
  skill('.codex/plugins/cache/openai/spreadsheets/1.0/skills','spreadsheets',meta('spreadsheets','Read and write spreadsheets'));
  skill('.agents/skills/node_modules/pkg','hidden-dep',meta('hidden-dep','must never be listed'));
  skill('.agents/skills/.cache','hidden-cache',meta('hidden-cache','must never be listed'));
  skill('.agents/skills/browser-qa/references','bundled-example',meta('bundled-example','material inside a skill is not a skill'));
  skill('.agents/skills/collection/skills','nested-one',meta('nested-one','A skill nested in a collection'));
  skill('work/repo/.agents/skills','pdf-tools',meta('pdf-tools','Project version wins'));
  fs.symlinkSync(path.join(home,'.agents/skills'),path.join(home,'.agents/skills/loop'));
  const environment=new AgentEnvironment({home,appRoot,codexHome:path.join(home,'codex-home')});
  await test('frontmatter reads plain, quoted and block values',()=>{
   assert.deepEqual(frontmatter('---\nname: "a"\ndescription: |\n  one\n  two\nother: x\n---\n'),{name:'a',description:'one two'});
   assert.deepEqual(frontmatter('# no frontmatter'),{});
  });
  await test('search terms split scripts and form Chinese bigrams',()=>assert.deepEqual(terms('PDF 轉換工具'),['pdf','轉換','換工','工具']));
  await test('all agent roots are indexed and dependencies are skipped',async()=>{
   const catalog=await environment.catalog();
   assert.deepEqual(catalog.skills.map(s=>s.name).sort(),['apple-design','browser-qa','nested-one','no-frontmatter','pdf-tools','skill-creator','slides','spreadsheets']);
   assert.deepEqual(catalog.counts,{codex:2,agents:2,claude:1,hermes:1,opencode:1,'codex-plugin':1});
   assert.equal(catalog.byName.get('slides').description,'Build slide decks from an outline');
   assert.equal(catalog.byName.get('no-frontmatter').description,'Explains a task without metadata.');
   assert.equal(catalog.byName.get('spreadsheets').source,'codex-plugin:spreadsheets');
  });
  await test('a project skill wins over a global skill of the same name',async()=>{
   assert.equal((await environment.catalog()).byName.get('pdf-tools').source,'codex');
   const scoped=await environment.catalog(project);
   assert.equal(scoped.byName.get('pdf-tools').description,'Project version wins');assert.equal(scoped.byName.get('pdf-tools').source,'project');
  });
  await test('search ranks the name first, finds Chinese and honors the limit',async()=>{
   const found=await environment.searchSkills({query:'pdf documents'});
   assert.equal(found.results[0].name,'pdf-tools');assert.equal(found.total,8);
   assert.equal((await environment.searchSkills({query:'介面設計'})).results[0].name,'apple-design');
   assert.equal((await environment.searchSkills({query:'skills create slide deck read',limit:1})).results.length,1);
   await assert.rejects(environment.searchSkills({query:'  '}),/關鍵字/);
  });
  await test('view returns the instructions and files, and only for indexed skills',async()=>{
   const viewed=await environment.viewSkill({name:'APPLE-design'});
   assert.match(viewed.content,/Body of apple-design/);assert.deepEqual(viewed.files,['references/motion.md']);assert.equal(viewed.directory,reference);
   assert.equal((await environment.viewSkill({file:path.join(reference,'SKILL.md')})).name,'apple-design');
   await assert.rejects(environment.viewSkill({file:'/etc/passwd'}),/找不到/);
   await assert.rejects(environment.viewSkill({name:'apple-desig'}),/apple-design/);
  });
  await test('memory adds, replaces, removes and stays private',async()=>{
   assert.deepEqual((await environment.memoryRead()).memory.entries,[]);
   assert.equal((await environment.memoryWrite({action:'add',text:'Prefers Traditional Chinese'})).status,'saved');
   assert.equal((await environment.memoryWrite({action:'add',text:'Prefers Traditional Chinese'})).status,'unchanged');
   await environment.memoryWrite({action:'add',target:'user',text:'Lives in Taiwan'});
   await environment.memoryWrite({action:'add',text:'Builds OpenCodex'});
   await environment.memoryWrite({action:'replace',match:'OpenCodex',text:'Builds OpenCodex 0.4.13'});
   let state=await environment.memoryRead();
   assert.deepEqual(state.memory.entries,['Prefers Traditional Chinese','Builds OpenCodex 0.4.13']);assert.deepEqual(state.user.entries,['Lives in Taiwan']);
   await environment.memoryWrite({action:'remove',match:'Traditional'});
   state=await environment.memoryRead();assert.deepEqual(state.memory.entries,['Builds OpenCodex 0.4.13']);
   assert.equal(fs.statSync(path.join(environment.memoryDir,'MEMORY.md')).mode&0o777,0o600);
   assert.deepEqual(fs.readdirSync(environment.memoryDir).sort(),['MEMORY.md','USER.md']);
  });
  await test('memory refuses secrets, ambiguity, separators and overflow',async()=>{
   for(const text of ['api_key=abcdef123456','token: abcdefgh','sk-abcdefghijklmnopqrstuvwxyz','-----BEGIN RSA PRIVATE KEY-----'])await assert.rejects(environment.memoryWrite({action:'add',text}),/不可儲存/);
   await assert.rejects(environment.memoryWrite({action:'add',text:'a§b'}),/§/);
   await assert.rejects(environment.memoryWrite({action:'add',target:'other',text:'x'}),/target/);
   await assert.rejects(environment.memoryWrite({action:'remove',match:'not there'}),/找不到/);
   await environment.memoryWrite({action:'add',text:'Builds tools'});
   await assert.rejects(environment.memoryWrite({action:'remove',match:'Builds'}),/多筆/);
   await environment.memoryWrite({action:'remove',match:'Builds tools'});
   for(let i=0;i<3;i++)await environment.memoryWrite({action:'add',text:String(i).repeat(1500)});
   await assert.rejects(environment.memoryWrite({action:'add',text:'9'.repeat(1500)}),/上限/);
  });
  await test('concurrent memory writes all apply',async()=>{
   const other=new AgentEnvironment({home,appRoot:path.join(home,'app2')});
   await Promise.all(Array.from({length:12},(_,i)=>other.memoryWrite({action:'add',target:'user',text:'fact '+i})));
   assert.equal((await other.memoryRead()).user.entries.length,12);
  });
  await test('session search finds both roles and ignores tool output',async()=>{
   const dir=path.join(appRoot,'native-history');fs.mkdirSync(dir,{recursive:true});
   fs.writeFileSync(path.join(dir,'a.json'),JSON.stringify({version:1,result:{thread:{id:'t1',name:'修復登入',cwd:'/p',updatedAt:5,turns:[{items:[{type:'userMessage',content:[{type:'text',text:'幫我修復 keychain 登入錯誤'}]},{type:'mcpToolCall',arguments:{text:'keychain 登入 secret-output'}},{type:'agentMessage',text:'已修復 keychain 授權問題'}]}]}}}));
   fs.writeFileSync(path.join(dir,'b.json'),JSON.stringify({result:{thread:{id:'t2',turns:[{items:[{type:'agentMessage',text:'unrelated work'}]}]}}}));
   fs.writeFileSync(path.join(dir,'broken.json'),'{not json keychain');
   const found=await environment.searchSessions({query:'keychain 登入'});
   assert.equal(found.scannedConversations,3);assert.equal(found.results[0].threadId,'t1');assert.equal(found.results[0].title,'修復登入');
   assert(found.results.every(r=>!r.snippet.includes('secret-output')));assert(found.results.some(r=>r.role==='user'));
   assert.equal((await environment.searchSessions({query:'zzz-none'})).matched,0);
   assert.equal((await new AgentEnvironment({home,appRoot:path.join(home,'none')}).searchSessions({query:'x1'})).matched,0);
  });
  await test('core tools join the real tool host catalogue once, with MCP results',async()=>{
   const {AgentCoreTools}=require('../vendor/agentbridge/dist-main/agent-core-tools.js'),original=AgentCoreTools.prototype.entries;
   try{
    installCoreTools(AgentCoreTools,environment);installCoreTools(AgentCoreTools,environment);
    const entries=new AgentCoreTools({cwd:project,stateDirectory:home,guard:async v=>v,capabilities:()=>({})}).entries();
    for(const name of ['mac_task_plan','mac_skill_search','mac_skill_view','mac_memory_read','mac_memory_write','mac_session_search'])assert(entries.has(name),name);
    assert.equal(entries.get('mac_memory_write').category,'filesystem-write');assert.equal(entries.get('mac_skill_search').category,'agent-bridge');
    const search=await entries.get('mac_skill_search').invoke({query:'pdf'});
    const value=JSON.parse(search.content[0].text);assert.equal(value.results[0].source,'project');
   }finally{AgentCoreTools.prototype.entries=original;}
  });
  await test('instructions present OpenCodex as standalone and carry the workspace',async()=>{
   fs.mkdirSync(path.join(home,'.codex/memories'),{recursive:true});
   fs.writeFileSync(path.join(home,'.codex/AGENTS.md'),'使用繁體中文回覆。');fs.writeFileSync(path.join(home,'.codex/memories/MEMORY.md'),'old');
   await environment.memoryWrite({action:'add',target:'user',text:'Name: 懿恩'});
   const text=await runtimeInstructions({environment,cwd:project,tools:['mac_fs_read','mac_skill_search','mac_ext_abc_tool_1234'],extensions:[{name:'playwright',status:'connected'},{name:'glif',status:'failed'}]});
   assert.match(text,/^You are the assistant in OpenCodex/);assert.match(text,/does not use or need any other application/);
   assert.equal(text.match(/AgentBridge/g).length,1);assert.match(text,/Never tell the user to open, install or reconnect another app such as AgentBridge Studio/);
   assert.match(text,/"SSH 連線" panel/);assert.match(text,/8 skills are indexed/);assert.match(text,/project 1/);
   assert.match(text,/Name: 懿恩/);assert.match(text,/使用繁體中文回覆/);assert.match(text,/\.codex\/memories\/MEMORY\.md/);
   assert.match(text,/mac_skill_search/);assert.match(text,/plus 1 extension tools named mac_ext_\*/);assert.match(text,/Connected extensions: playwright/);assert.match(text,/glif（failed）/);
   assert.match(text,new RegExp('working directory is "'+project));
  });
  await test('a rescan serves the previous catalog and a slow scan does not delay instructions',async()=>{
   const fresh=new AgentEnvironment({home,appRoot,ttlMs:0});
   const first=await fresh.catalog();let release;
   fresh.scan=()=>new Promise(resolve=>{release=resolve;});
   assert.equal(await fresh.catalog(),first);
   const started=Date.now(),text=await runtimeInstructions({environment:Object.assign(new AgentEnvironment({home,appRoot}),{scan:()=>new Promise(()=>{})}),cwd:'/tmp'});
   assert(Date.now()-started<4000);assert.match(text,/every installed skill is searchable/);
   release(first);
  });
  await test('a missing or unreadable workspace never blocks a conversation',async()=>{
   const empty=new AgentEnvironment({home:path.join(home,'nobody'),appRoot:path.join(home,'nobody-app')});
   const text=await runtimeInstructions({environment:empty,cwd:'/tmp'});
   assert.match(text,/0 skills are indexed/);assert.doesNotMatch(text,/global instructions/);
  });
  console.log(JSON.stringify({passed:tests.length,tests},null,2));
 }finally{fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
