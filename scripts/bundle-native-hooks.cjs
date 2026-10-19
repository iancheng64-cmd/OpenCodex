'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
function bundleNativeHooks(resources){
 const root=path.resolve(__dirname,'..'),binary=path.join(root,'build/hooks-target/debug/opencodex-hooks-helper');
 const destination=path.join(resources,'opencodex-hooks-helper');
 if(!fs.statSync(binary).isFile())throw Error('Build the native Hooks helper before packaging.');
 const kind=cp.execFileSync('/usr/bin/file',['-b',binary],{encoding:'utf8'});
 if(!kind.includes('Mach-O 64-bit executable arm64'))throw Error('Unexpected Hooks helper architecture: '+kind.trim());
 fs.copyFileSync(binary,destination);fs.chmodSync(destination,0o755);
 cp.execFileSync('/usr/bin/strip',['-x',destination]);
 const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
 const report={at:new Date().toISOString(),source:'native/hooks-helper',binarySHA256:sha(binary),copiedSHA256:sha(destination),requiresSigning:true};
 fs.writeFileSync(path.join(root,'evidence/hooks-bundle.json'),JSON.stringify(report,null,2)+'\n');
 return report;
}
module.exports={bundleNativeHooks};
