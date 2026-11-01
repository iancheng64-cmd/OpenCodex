'use strict';
// Codex-CLI-style inline terminal UI: history scrolls above, a live viewport
// (status, overlays, composer, hints) is redrawn in place at the bottom.
const ESC='\x1b';
const ansiRe=/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const strip=s=>String(s).replace(ansiRe,'');
function cw(ch){const c=ch.codePointAt(0);if(c<0x20||(c>=0x7f&&c<0xa0))return 0;if(c>=0x300&&c<=0x36f)return 0;if(c>=0x1100&&(c<=0x115f||c===0x2329||c===0x232a||(c>=0x2e80&&c<=0xa4cf&&c!==0x303f)||(c>=0xac00&&c<=0xd7a3)||(c>=0xf900&&c<=0xfaff)||(c>=0xfe30&&c<=0xfe6f)||(c>=0xff00&&c<=0xff60)||(c>=0xffe0&&c<=0xffe6)||(c>=0x1f300&&c<=0x1faff)||(c>=0x20000&&c<=0x3fffd)))return 2;return 1;}
function width(s){let w=0;for(const ch of strip(s))w+=cw(ch);return w;}
// ANSI-aware truncation to a display width.
function fit(s,max){let w=0,out='';const str=String(s);for(let i=0;i<str.length;){const m=/^(\x1b\[[0-9;?]*[A-Za-z])/.exec(str.slice(i));if(m){out+=m[1];i+=m[1].length;continue;}const ch=String.fromCodePoint(str.codePointAt(i));const c=cw(ch);if(w+c>max){out+=ESC+'[0m';return out;}out+=ch;w+=c;i+=ch.length;}return out;}
function pad(s,max){const w=width(s);return w>=max?fit(s,max):s+' '.repeat(max-w);}
function wrapPlain(text,max){const rows=[];for(const para of String(text).split('\n')){let row='',w=0;for(const ch of para){const c=cw(ch);if(w+c>max){rows.push(row);row='';w=0;}row+=ch;w+=c;}rows.push(row);}return rows;}
const SPIN=['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const COMMANDS=[
 ['model','選擇模型與思考強度（可跨供應商接續同一對話）'],['ssh','管理或切換 SSH 主機'],['effort','設定思考強度'],['permission','設定在 Mac 上不需確認的操作'],
 ['status','顯示目前工作階段設定'],['quota','查看各供應商剩餘額度'],['models','列出已連線供應商的模型'],['new','開始新的工作階段'],['resume','接續先前的工作階段（開啟選單）'],['sessions','列出可接續的工作階段'],
 ['cwd','顯示 Mac 工作目錄'],['stop','中止目前回合'],['help','顯示說明'],['exit','離開 OpenCodex'],
];
class Tui{
 constructor({color,title,onSubmit,onInterrupt,onExit,commands=COMMANDS,hint}){
  Object.assign(this,{color,title,onSubmit,onInterrupt,onExit,commands,hintFn:hint});
  this.out=process.stdout;this.pending=[];this.rowsDrawn=0;this.cursorRow=0;
  this.composer={text:'',cursor:0,history:[],index:-1,draft:''};
  this.overlay=null;this.popupIndex=0;this.working=null;this.live={text:'',committed:0,committedLines:0,inCode:false};this.tools=new Map();this.queue=[];
  this.paste=null;this.spinner=0;this.timer=null;this.closed=false;this.ctrlC=0;this.lastKeyAt=0;this.busy=false;this.scheduled=false;
 }
 get cols(){return Math.max(40,this.out.columns||80);}
 get rows(){return Math.max(10,this.out.rows||24);}
 start(){
  process.stdin.setEncoding('utf8');process.stdin.setRawMode(true);process.stdin.resume();
  process.stdin.on('data',d=>this.input(d));
  this.out.on('resize',()=>{this.rowsDrawn=Math.min(this.rowsDrawn,this.rows-1);this.render();});
  this.out.write(ESC+'[?2004h'+ESC+']0;'+(this.title||'OpenCodex')+'\x07');
  this.render();
 }
 stop(){if(this.closed)return;this.closed=true;clearInterval(this.timer);this.timer=null;try{process.stdin.setRawMode(false);}catch{}process.stdin.pause();this.flushHistoryOnly();this.out.write(ESC+'[?2004l'+ESC+'[?25h\n');}
 flushHistoryOnly(){const h=this.pending.join('\n');this.pending=[];this.out.write('\r'+(this.cursorRow?ESC+'['+this.cursorRow+'A':'')+ESC+'[J'+(h?h+'\n':''));this.rowsDrawn=0;this.cursorRow=0;}
 // ---------- history ----------
 print(text=''){for(const l of String(text).split('\n'))this.pending.push(l);this.schedule();}
 user(text){this.print('');for(const [i,l] of String(text).split('\n').entries())this.print(this.color.bold(this.color.cyan(i?'  ':'› '))+this.color.bold(l));}
 md(line){
  const c=this.color;
  if(/^\s*```/.test(line)){this.live.inCode=!this.live.inCode;return c.dim(line);}
  if(this.live.inCode)return c.dim('  '+line);
  let s=line.replace(/^(#{1,6})\s+(.*)$/,(m,h,t)=>c.bold(t));
  s=s.replace(/\*\*([^*]+)\*\*/g,(m,t)=>c.bold(t)).replace(/`([^`]+)`/g,(m,t)=>c.cyan(t)).replace(/^(\s*)[-*]\s+/,(m,sp)=>sp+'• ');
  return s;
 }
 assistantLine(line,first){return (first?this.color.green('• '):'  ')+this.md(line);}
 // Cumulative streamed text: commit complete lines as they appear; keep the tail live.
 stream(text){
  if(!text.startsWith(this.live.text.slice(0,this.live.committed))){this.live={text:'',committed:0,committedLines:0,inCode:false};}
  this.live.text=text;
  const lines=text.split('\n');
  while(this.live.committedLines<lines.length-1){const l=lines[this.live.committedLines];this.pending.push(this.assistantLine(l,this.live.committedLines===0));this.live.committedLines++;this.live.committed=lines.slice(0,this.live.committedLines).join('\n').length+1;}
  this.schedule();
 }
 endStream(){const lines=this.live.text.split('\n');const tail=lines.slice(this.live.committedLines).join('\n');if(tail.trim()||this.live.committedLines===0&&tail)this.pending.push(this.assistantLine(tail,this.live.committedLines===0));this.live={text:'',committed:0,committedLines:0,inCode:false};this.schedule();}
 tool(e){
  const c=this.color;const title=String(e.title||e.tool||'tool').split('\n')[0];
  if(e.status==='running'){this.tools.set(e.itemId||title,{title,args:e.text&&e.text!=='{}'?String(e.text):''});this.schedule();return;}
  const rec=this.tools.get(e.itemId||title);this.tools.delete(e.itemId||title);
  const ok=e.status==='completed';const verb=/^[a-z_]+$/i.test(title)?'呼叫 ':'執行 ';
  this.pending.push(c.green('• ')+(ok?'':c.red('失敗 '))+verb+c.bold(fit(title,this.cols-12))+(rec?.args?c.dim(' '+fit(rec.args.replace(/\s+/g,' '),Math.max(10,this.cols-width(title)-16))):''));
  const out=String(e.text||'').trim();
  if(out){const lines=out.split('\n');const show=lines.slice(0,Math.min(lines.length,ok?6:12));for(const [i,l] of show.entries())this.pending.push(c.dim('  '+(i===0?'└ ':'  ')+fit(l,this.cols-6)));if(lines.length>show.length)this.pending.push(c.dim('    … 還有 '+(lines.length-show.length)+' 行'));}
  this.schedule();
 }
 // ---------- state ----------
 setWorking(label){if(label){this.working={label,since:Date.now()};if(!this.timer)this.timer=setInterval(()=>{this.spinner++;this.render();},120);}else{this.working=null;this.tools.clear();clearInterval(this.timer);this.timer=null;}this.schedule();}
 // ---------- overlays ----------
 select({title,items,hint,hotkeys={}}){return new Promise(resolve=>{this.overlay={type:'select',title,items,index:Math.max(0,items.findIndex(i=>i.selected)),hint,hotkeys,resolve};this.render();});}
 inputBox({prompt,secret=false,value=''}){return new Promise(resolve=>{this.overlay={type:'input',prompt,secret,text:value,cursor:value.length,resolve};this.render();});}
 closeOverlay(result){const o=this.overlay;this.overlay=null;this.render();o?.resolve(result);}
 // ---------- key handling ----------
 input(data){
  if(this.closed)return;
  let s=String(data);
  if(this.paste!==null){const end=s.indexOf(ESC+'[201~');if(end<0){this.paste+=s;return;}this.paste+=s.slice(0,end);const text=this.paste.replace(/\r\n?/g,'\n');this.paste=null;this.insert(text);s=s.slice(end+6);if(!s)return;}
  const startPaste=s.indexOf(ESC+'[200~');
  if(startPaste>=0){const before=s.slice(0,startPaste);if(before)this.input(before);this.paste='';this.input(s.slice(startPaste+6));return;}
  // Split escape sequences from text.
  const keys=[];let i=0;
  while(i<s.length){
   if(s[i]===ESC){const m=/^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z]|.)?/.exec(s.slice(i));if(m&&m[0].length>1){keys.push(m[0]);i+=m[0].length;}else{keys.push(ESC);i+=1;}continue;}
   if(s.charCodeAt(i)<0x20||s[i]==='\x7f'){keys.push(s[i]);i++;continue;}
   let j=i;while(j<s.length&&s.charCodeAt(j)>=0x20&&s[j]!=='\x7f'&&s[j]!==ESC)j++;keys.push(s.slice(i,j));i=j;
  }
  for(const k of keys)this.key(k);
 }
 key(k){
  if(k!=='\x03')this.ctrlC=0;
  if(this.overlay)return this.overlayKey(k);
  const c=this.composer;const popup=this.popup();
  switch(k){
   case '\r':case '\n':{
    if(popup.length&&!/\s/.test(c.text)){const cmd=popup[this.popupIndex];c.text='/'+cmd[0]+' ';c.cursor=c.text.length;}
    const text=c.text.trim();if(!text)return;
    c.history.push(c.text);c.index=-1;c.draft='';c.text='';c.cursor=0;this.popupIndex=0;this.render();
    void this.onSubmit(text);return;
   }
   case '\x03':{if(this.working){void this.onInterrupt();return;}if(c.text){c.text='';c.cursor=0;this.render();return;}this.ctrlC++;if(this.ctrlC>=2){void this.onExit();return;}this.print(this.color.dim('再按一次 Ctrl+C 離開（或輸入 /exit）'));return;}
   case '\x04':if(!c.text){void this.onExit();}return;
   case ESC:if(this.working){void this.onInterrupt();}else if(popup.length){c.text='';c.cursor=0;this.render();}return;
   case '\x7f':case '\b':if(c.cursor>0){const prev=[...c.text.slice(0,c.cursor)].pop();c.text=c.text.slice(0,c.cursor-prev.length)+c.text.slice(c.cursor);c.cursor-=prev.length;}this.popupIndex=0;this.render();return;
   case ESC+'[3~':if(c.cursor<c.text.length){const next=String.fromCodePoint(c.text.codePointAt(c.cursor));c.text=c.text.slice(0,c.cursor)+c.text.slice(c.cursor+next.length);}this.render();return;
   case ESC+'[D':case ESC+'OD':if(c.cursor>0)c.cursor-=[...c.text.slice(0,c.cursor)].pop().length;this.render();return;
   case ESC+'[C':case ESC+'OC':if(c.cursor<c.text.length)c.cursor+=String.fromCodePoint(c.text.codePointAt(c.cursor)).length;this.render();return;
   case ESC+'[H':case ESC+'[1~':case '\x01':c.cursor=0;this.render();return;
   case ESC+'[F':case ESC+'[4~':case '\x05':c.cursor=c.text.length;this.render();return;
   case ESC+'[A':case ESC+'OA':if(popup.length){this.popupIndex=(this.popupIndex-1+popup.length)%popup.length;this.render();return;}if(c.history.length){if(c.index===-1){c.draft=c.text;c.index=c.history.length-1;}else if(c.index>0)c.index--;c.text=c.history[c.index];c.cursor=c.text.length;this.render();}return;
   case ESC+'[B':case ESC+'OB':if(popup.length){this.popupIndex=(this.popupIndex+1)%popup.length;this.render();return;}if(c.index!==-1){c.index++;if(c.index>=c.history.length){c.index=-1;c.text=c.draft;}else c.text=c.history[c.index];c.cursor=c.text.length;this.render();}return;
   case '\t':if(popup.length){c.text='/'+popup[this.popupIndex][0]+' ';c.cursor=c.text.length;this.render();}return;
   case '\x15':c.text=c.text.slice(c.cursor);c.cursor=0;this.render();return;
   case '\x0b':c.text=c.text.slice(0,c.cursor);this.render();return;
   case '\x17':{const before=c.text.slice(0,c.cursor).replace(/\S+\s*$/,'');c.text=before+c.text.slice(c.cursor);c.cursor=before.length;this.render();return;}
   case '\x0c':this.out.write(ESC+'[2J'+ESC+'[H');this.rowsDrawn=0;this.cursorRow=0;this.render();return;
   case '\x0a':return;
   default:if(k.length&&k.charCodeAt(0)>=0x20)this.insert(k);
  }
 }
 insert(text){const c=this.composer;c.text=c.text.slice(0,c.cursor)+text+c.text.slice(c.cursor);c.cursor+=text.length;this.popupIndex=0;this.render();}
 overlayKey(k){
  const o=this.overlay;
  if(o.type==='select'){
   const n=o.items.length;
   if(k===ESC+'[A'||k===ESC+'OA'){o.index=(o.index-1+n)%n;this.render();return;}
   if(k===ESC+'[B'||k===ESC+'OB'){o.index=(o.index+1)%n;this.render();return;}
   if(k==='\r'||k==='\n'){this.closeOverlay(o.items[o.index]?.value);return;}
   if(k===ESC||k==='\x03'){this.closeOverlay(null);return;}
   const num=Number(k);if(Number.isInteger(num)&&num>=1&&num<=n){this.closeOverlay(o.items[num-1].value);return;}
   const hot=o.hotkeys[k.toLowerCase?.()];if(hot!==undefined){this.closeOverlay(hot);return;}
   return;
  }
  if(o.type==='input'){
   if(k==='\r'||k==='\n'){this.closeOverlay(o.text);return;}
   if(k===ESC||k==='\x03'){this.closeOverlay(null);return;}
   if(k==='\x7f'||k==='\b'){if(o.cursor>0){const prev=[...o.text.slice(0,o.cursor)].pop();o.text=o.text.slice(0,o.cursor-prev.length)+o.text.slice(o.cursor);o.cursor-=prev.length;}this.render();return;}
   if(k===ESC+'[D'){if(o.cursor>0)o.cursor-=[...o.text.slice(0,o.cursor)].pop().length;this.render();return;}
   if(k===ESC+'[C'){if(o.cursor<o.text.length)o.cursor+=String.fromCodePoint(o.text.codePointAt(o.cursor)).length;this.render();return;}
   if(k==='\x15'){o.text='';o.cursor=0;this.render();return;}
   if(k.length&&k.charCodeAt(0)>=0x20&&k[0]!==ESC){o.text=o.text.slice(0,o.cursor)+k+o.text.slice(o.cursor);o.cursor+=k.length;this.render();}
  }
 }
 popup(){const t=this.composer.text;if(!t.startsWith('/')||/\s/.test(t))return [];const q=t.slice(1).toLowerCase();return this.commands.filter(([n])=>n.startsWith(q));}
 // ---------- rendering ----------
 schedule(){if(this.scheduled)return;this.scheduled=true;setImmediate(()=>{this.scheduled=false;this.render();});}
 render(){
  if(this.closed)return;
  const c=this.color,W=this.cols,lines=[];let cursor=null;
  // Live tool activity and working status.
  for(const t of this.tools.values())lines.push(fit(c.dim('• 正在')+(/^[a-z_]+$/i.test(t.title)?'呼叫 ':'執行 ')+c.bold(t.title)+(t.args?c.dim(' '+t.args.replace(/\s+/g,' ')):''),W-1));
  const tail=this.live.text.split('\n').slice(this.live.committedLines).join('\n');
  if(tail){const rows=wrapPlain(tail,W-3);for(const [i,r] of rows.slice(-4).entries())lines.push((this.live.committedLines===0&&i===0&&rows.length<=4?c.green('• '):'  ')+r);}
  if(this.working){const secs=Math.floor((Date.now()-this.working.since)/1000);lines.push(c.magenta(SPIN[this.spinner%SPIN.length]+' ')+c.bold(this.working.label)+c.dim(' ('+secs+'s • Esc 中止)'));}
  if(this.queue.length)lines.push(c.dim('  已排隊 '+this.queue.length+' 則訊息，將於此回合結束後送出'));
  if(this.overlay){
   const o=this.overlay,inner=Math.min(W-2,100);const box=[];
   const line=s=>box.push(c.dim('│ ')+pad(s,inner-4)+c.dim(' │'));
   if(o.type==='select'){
    for(const [i,t] of String(o.title).split('\n').entries())line(i?fit(t,inner-4):c.bold(t));line('');
    const visible=Math.max(3,this.rows-10);let start=Math.max(0,Math.min(o.index-Math.floor(visible/2),o.items.length-visible));if(start<0)start=0;
    for(const [i,item] of o.items.slice(start,start+visible).entries()){const idx=start+i;const sel=idx===o.index;line((sel?c.cyan('› '):'  ')+(sel?c.bold(String(idx+1)+'. '+item.label):String(idx+1)+'. '+item.label)+(item.description?c.dim('  '+item.description):''));}
    if(o.items.length>visible)line(c.dim('  … 共 '+o.items.length+' 項，↑↓ 捲動'));
    line('');line(c.dim(o.hint||'↑↓ 選擇 · Enter 確認 · Esc 取消'));
   }else{
    line(c.bold(o.prompt));line('');
    const shown=o.secret?'•'.repeat([...o.text].length):o.text;line(c.cyan('› ')+shown);line('');line(c.dim('Enter 確認 · Esc 取消'));
   }
   lines.push(c.dim('╭'+'─'.repeat(inner-2)+'╮'));lines.push(...box);lines.push(c.dim('╰'+'─'.repeat(inner-2)+'╯'));
   if(o.type==='input'){cursor={row:lines.length-1-3,col:4+width(o.secret?'•'.repeat([...o.text.slice(0,o.cursor)].length):o.text.slice(0,o.cursor))};}
  }
  // Composer.
  lines.push(c.dim('─'.repeat(W-1)));
  const comp=this.composer,avail=W-3;
  if(!comp.text&&!this.overlay){lines.push(c.bold('› ')+c.dim(this.working?'輸入訊息將排隊，Esc 中止目前回合':'要 OpenCodex 做什麼？'));cursor=cursor||{row:lines.length-1,col:2};}
  else{
   const rows=[];let row='',w=0,cursorPos=null;const chars=[...comp.text];let offset=0;
   for(const ch of chars){if(offset===comp.cursor)cursorPos={row:rows.length,col:w};const cwid=cw(ch);if(w+cwid>avail||ch==='\n'){rows.push(row);row='';w=0;if(ch==='\n'){offset+=ch.length;if(offset===comp.cursor)cursorPos={row:rows.length,col:0};continue;}}row+=ch;w+=cwid;offset+=ch.length;}
   rows.push(row);if(!cursorPos)cursorPos={row:rows.length-1,col:w};
   const maxRows=Math.max(1,this.rows-lines.length-3);const first=Math.max(0,Math.min(cursorPos.row-maxRows+1,rows.length-maxRows));
   const base=lines.length;
   for(const [i,r] of rows.slice(first,first+maxRows).entries())lines.push((i===0&&first===0?c.bold('› '):'  ')+r);
   if(!this.overlay)cursor={row:base+(cursorPos.row-first),col:2+cursorPos.col};
  }
  const popup=this.overlay?[]:this.popup();
  if(popup.length){for(const [i,[name,desc]] of popup.slice(0,8).entries())lines.push((i===this.popupIndex?c.cyan('  › '):'    ')+pad(c.bold('/'+name),18)+c.dim(fit(desc,W-24)));}
  const left=c.dim(popup.length?'↑↓ 選擇 · Enter 執行 · Tab 補完':'/ 指令 · Ctrl+C 離開');const right=c.dim(this.hintFn?this.hintFn():'');
  lines.push(fit(pad(left,Math.max(0,W-1-width(right)))+right,W-1));
  // Flush: move to viewport top, clear, print pending history, then the viewport.
  const maxLines=this.rows-1;const shown=lines.slice(-maxLines);const dropped=lines.length-shown.length;if(cursor){cursor.row-=dropped;if(cursor.row<0)cursor=null;}
  const history=this.pending.join('\n');this.pending=[];
  let buf='\r'+(this.cursorRow>0?ESC+'['+this.cursorRow+'A':'')+ESC+'[J';
  if(history)buf+=history+'\n';
  buf+=shown.map(l=>fit(l,W-1)).join('\n');
  const rowsDrawn=shown.length;const target=cursor?Math.min(cursor.row,rowsDrawn-1):rowsDrawn-1;
  const up=rowsDrawn-1-target;buf+=(up>0?ESC+'['+up+'A':'')+'\r'+(cursor&&cursor.col>0?ESC+'['+cursor.col+'C':'')+ESC+'[?25'+(cursor?'h':'l');
  this.out.write(buf);this.rowsDrawn=rowsDrawn;this.cursorRow=target;
 }
}
module.exports={Tui,COMMANDS,width,fit,pad};
