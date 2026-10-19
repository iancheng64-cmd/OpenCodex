'use strict';
const fs=require('node:fs'),path=require('node:path');
exports.validateProfile=function(input){
 if(!input||typeof input!=='object')throw Error('無效的主機設定。');
 const p={...input};
 for(const key of ['id','name','host','username']){if(typeof p[key]!=='string'||!p[key].trim()||/[\x00-\x1f\x7f]/.test(p[key])||p[key].length>256)throw Error('請填寫有效的主機名稱、位址與使用者。');p[key]=p[key].trim();}
 p.port=Number(p.port??22);if(!Number.isInteger(p.port)||p.port<1||p.port>65535)throw Error('SSH 連接埠必須介於 1 到 65535。');
 if(!['password','key','agent'].includes(p.authType))throw Error('無效的認證方式。');
 if(!['auto','windows','posix'].includes(p.runtimePlatform||'auto'))throw Error('無效的遠端平台。');
 if(p.authType==='key'&&(!p.keyPath||!path.isAbsolute(p.keyPath)))throw Error('私鑰路徑必須是完整路徑。');
 p.networkMode='direct';delete p.relayUrl;return p;
};
exports.validateCwd=function(cwd){if(typeof cwd!=='string'||!path.isAbsolute(cwd)||!fs.statSync(cwd).isDirectory())throw Error('請選擇有效的本機工作資料夾。');return cwd;};
