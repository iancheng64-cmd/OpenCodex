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
// Native "steer" for Claude turns: a user message written into the running Claude Code
// process is consumed at its next tool boundary. One not consumed before the result
// becomes Claude Code's next turn, so the run stays open briefly and reports that turn
// as the same OpenCodex turn.
function patchClaudeRuntime(code){
 code=once(code,'    async sendAndWait(input) {',
  '    steer(content) {\n        const run = this.run;\n        if (!run || run.cancelled || !this.protocol || this.stopped)\n            throw new Error("no active turn to steer");\n        this.protocol.user(content, this.sessionId);\n        run.steers = (run.steers || 0) + 1;\n        return { requestId: run.requestId };\n    }\n    async sendAndWait(input) {');
 code=once(code,'        if (event.parent_tool_use_id)\n            return; // Nested-agent text does not overwrite the main reply.',
  '        if (run.steerGrace && (event.type === "assistant" || event.type === "stream_event" || (event.type === "system" && event.subtype === "init"))) {\n            clearTimeout(run.steerGrace);\n            run.steerGrace = undefined;\n        }\n        if (event.parent_tool_use_id)\n            return; // Nested-agent text does not overwrite the main reply.');
 code=once(code,'            if (!this.cancelling)\n                this.finish(run.cancelled ? "cancelled" : event.is_error ? "error" : "completed");\n        }\n    }\n    finish(status) {\n        const run = this.run;\n        if (!run)\n            return;\n',
  '            if (this.cancelling)\n                return;\n            const status = run.cancelled ? "cancelled" : event.is_error ? "error" : "completed";\n            if (run.steers > 0 && status === "completed") {\n                run.steers = 0;\n                run.steerGrace = setTimeout(() => { run.steerGrace = undefined; if (this.run === run) this.finish("completed"); }, 2500);\n                return;\n            }\n            this.finish(status);\n        }\n    }\n    finish(status) {\n        const run = this.run;\n        if (!run)\n            return;\n        clearTimeout(run.steerGrace);\n        run.steerGrace = undefined;\n');
 return code;
}

function patchClaudeAuthProbe(code){
 code=once(code,'        return { accountKey:',`        // A locked/restricted Keychain is not evidence that the user signed out.
        // Discard secret stdout at the child-process boundary; return metadata only.
        if (!value.loggedIn && process.platform === 'darwin') {
            const path = require('node:path'), home = env.HOME || require('node:os').homedir();
            const config = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
            if (path.resolve(config) === path.join(home, '.claude')) {
                const options = { env, cwd, timeout: 5000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] };
                const item = cp.spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], options);
                if (item.status === 0) {
                    const access = cp.spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], options);
                    if (access.status === 36 || /User interaction is not allowed/i.test(access.stderr || ''))
                        return { authenticated: false, verified: false, type: 'claude-code', authMethod: 'keychain', apiProvider: 'unknown', authProblem: 'credential-unavailable',
                            error: 'Claude 登入憑證存在，但 SSH 無法讀取鑰匙圈。請在伺服器桌面解鎖登入鑰匙圈，並檢查 Claude Code 的存取授權，再按更新。' };
                }
            }
        }
        return { accountKey:`);
 code=once(code, "authenticated: value.loggedIn, verified: true,", "authenticated: value.loggedIn, verified: true, authProblem: null, error: null,");
 code=once(code, "authenticated: false, verified: false, type: 'claude-code', authMethod: 'unavailable'", "authenticated: false, verified: false, authProblem: null, error: '無法確認 Claude CLI 登入狀態，請重試更新。', type: 'claude-code', authMethod: 'unavailable'");
 return code;
}

module.exports={patchClaudeBackend,patchClaudeRuntime,patchClaudeAuthProbe};
