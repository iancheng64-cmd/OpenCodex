'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto'),cp=require('child_process');
const {cdp,rpc,wait}=require('./qa-client.cjs');
(async()=>{
 const report={version:'0.4.8',at:new Date().toISOString(),tests:[]},fixture=fs.mkdtempSync(path.join(__dirname,'../evidence/workspace-qa-'));
 const a=fs.realpathSync(fixture),b=path.join(a,'second'),repo=path.join(a,'repo');fs.mkdirSync(b);fs.mkdirSync(repo);
 const markers={a:'PROJECT-A-'+crypto.randomUUID(),b:'PROJECT-B-'+crypto.randomUUID()};
 fs.writeFileSync(path.join(a,'project-marker.txt'),markers.a);fs.writeFileSync(path.join(b,'project-marker.txt'),markers.b);
 const c=await cdp(),r=await rpc();let tid;
 const watchdog=setTimeout(()=>{console.error('Workspace e2e timeout');process.exit(1)},600000);
 try{
  assert((await c.evaluate('window.openCodexRuntime.status()')).connected);
  // Exercise the same Git worker used by the native renderer, then independently inspect disk.
  assert((await c.worker('git-init-repo',{cwd:repo})).success);
  cp.execFileSync('/usr/bin/git',['-C',repo,'config','user.name','OpenCodex QA']);
  cp.execFileSync('/usr/bin/git',['-C',repo,'config','user.email','qa@example.invalid']);
  fs.writeFileSync(path.join(repo,'fixture.txt'),'base\n');
  cp.execFileSync('/usr/bin/git',['-C',repo,'add','fixture.txt']);
  cp.execFileSync('/usr/bin/git',['-C',repo,'commit','-m','Isolated fixture']);
  const base=cp.execFileSync('/usr/bin/git',['-C',repo,'branch','--show-current'],{encoding:'utf8'}).trim();
  fs.writeFileSync(path.join(repo,'fixture.txt'),'changed\n');
  const status=await c.worker('status-summary',{cwd:repo,includeUntrackedFiles:true});assert.equal(status.type,'success');assert.equal(status.unstagedCount,1);report.gitStatus=status;
  const patch=await c.worker('review-patch',{cwd:repo,source:'unstaged',includeUntrackedFiles:true});report.gitPatch=patch;assert(JSON.stringify(patch).includes('+changed'));
  const branch=await c.worker('create-branch',{cwd:repo,branch:'qa-native',mode:'worktree',failIfExists:true});assert.equal(branch.status,'success');
  assert(cp.execFileSync('/usr/bin/git',['-C',repo,'branch','--list','qa-native'],{encoding:'utf8'}).includes('qa-native'));
  const checkout=await c.worker('checkout-branch',{cwd:repo,branch:'qa-native'});assert.equal(checkout.status,'success');
  assert.equal(cp.execFileSync('/usr/bin/git',['-C',repo,'branch','--show-current'],{encoding:'utf8'}).trim(),'qa-native');
  const wt=await c.worker('create-worktree',{cwd:repo,startingState:{type:'branch',branchName:base},upstreamRefreshMode:'never',localEnvironmentConfigPath:null,worktreesRoot:path.join(a,'worktrees'),useWorkspaceDir:true,setUpSyncedBranch:false,streamId:crypto.randomUUID()});
  assert(wt.worktreeWorkspaceRoot.startsWith(a+'/'));assert.equal(fs.readFileSync(path.join(wt.worktreeWorkspaceRoot,'fixture.txt'),'utf8'),'base\n');
  fs.writeFileSync(path.join(wt.worktreeWorkspaceRoot,'project-marker.txt'),'WORKTREE-'+crypto.randomUUID());
  report.worktree=wt;report.tests.push('native Git init, status, diff, branch creation and worktree creation verified against Mac filesystem');
  await r.call('initialize',{clientInfo:{name:'workspace-qa',version:'0.4.8'}});
  async function start(cwd){const t=(await r.call('thread/start',{cwd,permissions:':workspace'})).thread;assert.equal(t.cwd,cwd);return t.id;}
  async function shell(threadId,cwd){
   const from=r.events.length;await r.call('thread/shellCommand',{threadId,command:'/bin/pwd; /bin/cat project-marker.txt'});
   const done=await wait(()=>r.events.slice(from).find(e=>e.method==='turn/completed'&&e.params.threadId===threadId));assert.equal(done.params.turn.status,'completed');
   const item=r.events.slice(from).find(e=>e.method==='item/completed'&&e.params.item?.type==='commandExecution').params.item;assert.equal(item.exitCode,0);assert(item.aggregatedOutput.includes(cwd));assert(item.aggregatedOutput.includes(fs.readFileSync(path.join(cwd,'project-marker.txt'),'utf8')));
   return item.aggregatedOutput;
  }
  const ta=await start(a);report.threadA=ta;report.shellA=await shell(ta,a);
  const tb=await start(b);report.threadB=tb;report.shellB=await shell(tb,b);
  // No cwd argument: the resumed thread must restore its own workspace.
  const resumed=await r.call('thread/resume',{threadId:ta});assert.equal(resumed.thread.cwd,a);report.resumedShellA=await shell(ta,a);
  const from=r.events.length;
  const turn=await r.call('turn/start',{threadId:ta,effort:'low',input:[{type:'text',text:'OpenCodex 專案切換驗收。請從目前工具目錄找到描述為「Codex 原生 · node_repl」的 js 工具，實際讀取相對路徑 project-marker.txt（使用 Node fs）。只回覆該檔案內容；不要改用一般 node_repl、shell 或其他工具，不得使用絕對路徑或更改目錄。'}]});
  const complete=await wait(()=>r.events.slice(from).find(e=>e.method==='turn/completed'&&e.params.threadId===ta&&e.params.turn.id===turn.turn.id));assert.equal(complete.params.turn.status,'completed');
  const events=r.events.slice(from);report.nativeText=events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('');
  report.tools=events.filter(e=>e.method==='item/completed'&&e.params.item?.type==='mcpToolCall').map(e=>({tool:e.params.item.tool,status:e.params.item.status}));
  const prefix='mac_ext_'+crypto.createHash('sha256').update('opencodex-native:node_repl').digest('hex').slice(0,12)+'_js_';
  assert(report.nativeText.includes(markers.a));assert(report.tools.some(t=>t.tool.startsWith(prefix)&&t.status==='completed'));
  report.tests.push('two SSH projects restore distinct Mac shell cwd and native Node plugin cwd');
  const tw=await start(wt.worktreeWorkspaceRoot);report.threadWorktree=tw;report.worktreeShell=await shell(tw,wt.worktreeWorkspaceRoot);
  const owned=await c.worker('set-worktree-owner-thread',{worktree:wt.worktreeGitRoot,conversationId:tw});assert(owned.success);
  assert.equal((await c.worker('worktree-owner',{cwd:wt.worktreeWorkspaceRoot})).ownerThreadId,tw);
  const list=await r.call('thread/list',{cwd:a,limit:100});assert(list.data.some(t=>t.id===ta));assert(!list.data.some(t=>t.id===tb||t.id===tw));assert(list.data.every(t=>t.cwd===a));
  report.tests.push('native worktree ownership, SSH execution and project-filtered thread list');
  report.fixture=a;report.passed=true;
 }catch(e){report.passed=false;report.error=e.stack;process.exitCode=1;}
 finally{clearTimeout(watchdog);c.close();r.close();fs.writeFileSync(path.join(__dirname,'../evidence/native-workspace-e2e.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
})().catch(e=>{console.error(e.stack);process.exit(1)});
