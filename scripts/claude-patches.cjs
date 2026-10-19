'use strict';
// Expose only the existing backend registry and verified tool identity to our adapter.
function once(code,before,after){if(code.includes(after)&&code.indexOf(after)===code.lastIndexOf(after))return code;if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))throw Error('Unrecognized Claude backend boundary: '+before.slice(0,80));return code.replace(before,after);}
function patchClaudeBackend(code){
 code=once(code,'const runtimes = new Map();','const runtimes = new Map();\nexports.openCodexClaudeRuntimes = runtimes;');
 code=once(code,'transport: connected.transport, networkDiagnostics: connected.diagnostics','transport: connected.transport, hostFingerprint: connected.fingerprint, networkDiagnostics: connected.diagnostics');
 code=once(code,'{ isQuestion, resolve: finish, input, questions, dispose:', '{ isQuestion, toolName: name, resolve: finish, input, questions, dispose:');
 code=once(code,'readOnlyRoots: deps.libraryRoot ? [deps.libraryRoot] : []','readOnlyRoots: [...(deps.libraryRoot ? [deps.libraryRoot] : []), ...(deps.readOnlyExtensionRoots || [])]');
 return code;
}
module.exports={patchClaudeBackend};
