'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
function bundlePermissionEngine(resources){
 const root=path.resolve(__dirname,'..'),binary=path.join(root,'build/hooks-target/debug/codex');
 const destination=path.join(resources,'opencodex-permission-engine');
 const kind=cp.execFileSync('/usr/bin/file',['-b',binary],{encoding:'utf8'});
 if(!kind.includes('Mach-O 64-bit executable arm64'))throw Error('Unexpected permission engine architecture: '+kind.trim());
 const capability=JSON.parse(cp.execFileSync(process.execPath,[path.join(__dirname,'permission-engine-check.cjs'),binary],{encoding:'utf8',timeout:20000}));
 const source=path.join(root,'research/codex-0.160.0');
 const notice=path.join(resources,'opencodex-permission-engine.LICENSE');
 fs.copyFileSync(path.join(source,'LICENSE'),notice);
 fs.copyFileSync(binary,destination);fs.chmodSync(destination,0o755);
 cp.execFileSync('/usr/bin/strip',['-x',destination]);
 const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const report={at:new Date().toISOString(),source:'research/codex-0.160.0',...capability,
  cargoLockSHA256:sha(path.join(source,'codex-rs/Cargo.lock')),copiedSHA256:sha(destination),requiresSigning:true};
 fs.writeFileSync(path.join(root,'evidence/permission-engine-bundle.json'),JSON.stringify(report,null,2)+'\n');
 return report;
}
module.exports={bundlePermissionEngine};
