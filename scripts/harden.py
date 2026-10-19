from pathlib import Path
root=Path(__file__).resolve().parent.parent
def patch(f,a,b):
 p=root/f;s=p.read_text();assert s.count(a)==1,(f,a[:90],s.count(a));p.write_text(s.replace(a,b))
patch('src/bootstrap.cjs',"let localReady;","let localReady;const localTurns=new Set();")
patch('src/bootstrap.cjs',"localRpc.on('notification',m=>{if(settings.mode!=='bridge')for(const ws of clients)send(ws,m);});","localRpc.on('notification',m=>{if(m.method==='turn/started')localTurns.add(m.params.threadId);if(m.method==='turn/completed')localTurns.delete(m.params.threadId);if(settings.mode!=='bridge')for(const ws of clients)send(ws,m);});")
patch('src/bootstrap.cjs',"if(method==='initialize')return runtime.openCodexInitialized;","if(method==='initialize')return readyLocal();")
patch('src/bootstrap.cjs',"if(runtime?.run)throw Error('請先停止工作，再切換模式。');","if(runtime?.run||localTurns.size)throw Error('請先停止工作，再切換模式。');")
patch('src/bootstrap.cjs',"const url=new URL(input.baseUrl);if(url.protocol","const url=new URL(input.baseUrl);if(url.username||url.password||url.search||url.hash)throw Error('API 網址不可包含密碼、查詢參數或片段。');if(!input.apiKey&&!fs.existsSync(path.join(root,'api-key.bin')))throw Error('請輸入 API Key。');if(url.protocol")
patch('src/bootstrap.cjs',"settings.mode=input.mode;save();app.relaunch();app.quit();return true;","settings.mode=input.mode;save();app.relaunch({execPath:path.join(process.resourcesPath,'../MacOS/OpenCodex')});app.quit();return true;")
patch('src/bootstrap.cjs',"if(method==='thread/list'||method==='thread/loaded/list'){\n  const result=await runtime.rpc.request(method,params||{});\n  return {...result,data:(result.data||[]).filter(t=>known[typeof t==='string'?t:t.id]?.profile===runtime.snapshot.profileId),nextCursor:null};\n }","""if(method==='thread/list'||method==='thread/loaded/list'){
  let result,cursor=params?.cursor,data=[],pages=0;
  do{result=await runtime.rpc.request(method,{...params,...(cursor?{cursor}:{})});
   data.push(...(result.data||[]).filter(t=>known[typeof t==='string'?t:t.id]?.profile===runtime.snapshot.profileId));
   cursor=result.nextCursor;
  }while(method==='thread/list'&&cursor&&data.length<(params?.limit||25)&&++pages<20);
  return {...result,data,nextCursor:cursor||null};
 }""")
patch('scripts/build.cjs',"changes['.vite/build/bootstrap-CooIJpZm.js']=boot;","""// This fork must never relocate, overwrite or update the user's official app.
boot=replace(boot,'if(u!==`darwin`||!s)return!1;if(y())','return!1;if(u!==`darwin`||!s)return!1;if(y())');
boot=replace(boot,'function rr(e){switch(e){','function rr(e){return `io.opencodex.desktop`;switch(e){');
changes['.vite/build/bootstrap-CooIJpZm.js']=boot;""")
print('Isolation, local-path handshake, pagination and busy guards patched.')
