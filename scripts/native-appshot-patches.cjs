'use strict';
// Fallback for appshot capture when Apple Event -10000 / worker failure occurs.
// Uses Swift + CoreGraphics to find target window ID and screencapture to capture PNG.

const FALLBACK_FN = `function openCodexFallbackAppshot(a,bundleId,record,sendUpdate){
 try{
  const cp=require("node:child_process"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
  const swiftCode=\`import Cocoa
import CoreGraphics
let b=CommandLine.arguments[1]
let apps=NSRunningApplication.runningApplications(withBundleIdentifier:b)
guard let p=apps.first?.processIdentifier else { exit(1) }
let opts:CGWindowListOption=[.optionOnScreenOnly,.excludeDesktopElements]
guard let list=CGWindowListCopyWindowInfo(opts,kCGNullWindowID) as? [[String:Any]] else { exit(2) }
for w in list {
 if let pid=w[kCGWindowOwnerPID as String] as? Int32, pid==p,
    let lyr=w[kCGWindowLayer as String] as? Int, lyr==0,
    let bounds=w[kCGWindowBounds as String] as? [String:Any],
    let wth=bounds["Width"] as? Double, wth>50,
    let ht=bounds["Height"] as? Double, ht>50,
    let num=w[kCGWindowNumber as String] as? Int {
  print(num); exit(0)
 }
}
exit(3)
\`;
  let winNum="";
  try{
   winNum=cp.execFileSync("/usr/bin/swift",["-e",swiftCode,bundleId],{encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:4000}).trim();
  }catch(_){}
  if(!winNum)return null;
  const tmpPng=path.join(os.tmpdir(),"ocx-appshot-"+Date.now()+"-"+Math.random().toString(36).slice(2)+".png");
  try{
   cp.execFileSync("/usr/sbin/screencapture",["-x","-l",winNum,tmpPng],{stdio:"ignore",timeout:4000});
   if(!fs.existsSync(tmpPng))return null;
   const buf=fs.readFileSync(tmpPng);
   try{fs.unlinkSync(tmpPng);}catch(_){}
   if(buf.length<100)return null;
   const dataUrl="data:image/png;base64,"+buf.toString("base64");
   clearTimeout(record.timeoutId);
   sendUpdate(a,{type:"metadata",app:{bundleIdentifier:bundleId}});
   sendUpdate(a,{type:"screenshot",screenshotDataURL:dataUrl,screenshotPath:null,transitionSnapshotDataURL:null});
   sendUpdate(a,{type:"completed",transitionSnapshotDataURL:null});
   return {result:"started",animationDuration:null,transitionSnapshotHeight:null,transitionSpringDampingFraction:null,transitionSpringResponse:null,permissionGrantState:"both_granted"};
  }catch(_){
   try{fs.unlinkSync(tmpPng);}catch(_){}
   return null;
  }
 }catch(_){return null;}
}
`;

function capture(code) {
 if (code.includes('openCodexFallbackAppshot')) return code;

 const a1 = 'function qme({animationTarget:e,bundleIdentifier:t,';
 const a2 = 'let p=async()=>{if(!Pw.has(a))return null;';
 const a3 = 'let n=i.Sn(e),r=n==null?`start_request_failed`:`start_request_failed:${n.source}:${n.code}`;';

 if (!code.includes(a1) || code.indexOf(a1) !== code.lastIndexOf(a1))
  throw Error('qme function anchor missing in main bundle');
 if (!code.includes(a2) || code.indexOf(a2) !== code.lastIndexOf(a2))
  throw Error('qme p() anchor missing in main bundle');
 if (!code.includes(a3) || code.indexOf(a3) !== code.lastIndexOf(a3))
  throw Error('qme catch anchor missing in main bundle');

 code = code.replace(a1, FALLBACK_FN + a1);
 code = code.replace(a2, 'const _openCodexTargetBundle=t;' + a2);
 code = code.replace(a3, 'let _fb=openCodexFallbackAppshot(a,_openCodexTargetBundle,t,Iw);if(_fb!=null)return _fb;' + a3);

 return code;
}

module.exports = { capture };
