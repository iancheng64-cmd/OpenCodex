'use strict';
// Expose only the existing backend registry and verified tool identity to our adapter.
function once(code,before,after,previous){if(code.includes(after)&&code.indexOf(after)===code.lastIndexOf(after))return code;if(previous&&code.includes(previous)&&code.indexOf(previous)===code.lastIndexOf(previous))return code.replace(previous,after);if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))throw Error('Unrecognized Claude backend boundary: '+before.slice(0,80));return code.replace(before,after);}
function patchClaudeBackend(code){
 code=once(code,'const runtimes = new Map();','const runtimes = new Map();\nexports.openCodexClaudeRuntimes = runtimes;');
 code=once(code,'transport: connected.transport, networkDiagnostics: connected.diagnostics','transport: connected.transport, hostFingerprint: connected.fingerprint, networkDiagnostics: connected.diagnostics');
 code=once(code,'{ isQuestion, resolve: finish, input, questions, dispose:', '{ isQuestion, toolName: name, resolve: finish, input, questions, dispose:');
 code=once(code,'readOnlyRoots: deps.libraryRoot ? [deps.libraryRoot] : []','readOnlyRoots: [...(deps.libraryRoot ? [deps.libraryRoot] : []), ...(deps.readOnlyExtensionRoots || [])]');
 code=once(code,'if (runtime.closed || !runtime.cli.busy || signal?.aborted || runtime.backgroundTextOnly)','if (runtime.closed || (!runtime.cli.busy && !(runtime.peerBusyCount > 0)) || signal?.aborted || runtime.backgroundTextOnly)');
 code=once(code,'if (!runtime || runtime.closed || !runtime.cli.busy || runtime.backgroundTextOnly)','if (!runtime || runtime.closed || (!runtime.cli.busy && !(runtime.peerBusyCount > 0)) || runtime.backgroundTextOnly)');
 code=once(code,'return Promise.resolve({ allow: !!runtime && !runtime.closed && runtime.cli.busy && !request.signal.aborted });','return Promise.resolve({ allow: !!runtime && !runtime.closed && (runtime.cli.busy || runtime.peerBusyCount > 0) && !request.signal.aborted });');
 code=once(code,'pending: new Map(), permissionMode, cwd, closed: false, deps };','pending: new Map(), permissionMode, cwd, closed: false, deps, peerBusyCount: 0, createPeerCli: () => { const peerCli = new claude_local_runtime_2.ClaudeLocalRuntime({ cwd: runtime.cwd, executable: input.executable, authMode: input.authMode === "official" ? "official" : "api", api: input.api, permissionMode: runtime.permissionMode, model: input.model, effort: input.effort, autoCompactPercent: Number.isFinite(Number(input.autoCompactPercent)) ? Number(input.autoCompactPercent) : 70, additionalDirectories: !remote && deps.libraryRoot ? [deps.libraryRoot] : [], ...(conn ? { remote: { launch: (args, options) => (0, claude_remote_launch_1.launchRemoteClaude)(conn, { platform: input.platform, nodeExecutable: input.nodeExecutable, executable: input.executable, remoteCwd: input.remoteCwd, configDir: input.configDir, args, ...options }) } } : {}), ...(endpoint && host ? { mcp: { url: endpoint.url, token: endpoint.token, name: "opencodex_mac" } } : {}), onPermission: (request) => request.toolName.startsWith("mcp__opencodex_mac__") ? Promise.resolve({ allow: !!runtime && !runtime.closed && (peerCli.busy || runtime.cli.busy || runtime.peerBusyCount > 0) && !request.signal.aborted }) : (runtime ? ask(Object.assign(Object.create(runtime), { cli: peerCli }), request.input, request.toolName, request.signal) : Promise.resolve({ allow: false })), onEvent: event => { if (!runtime?.backgroundTextOnly || event.type === "closed") deps.emit("claude:event", Object.assign({}, event, { runtimeId: peerCli.id, ...(peerCli.activeRequestId ? { requestId: peerCli.activeRequestId } : {}) })); } }); return peerCli; } };','pending: new Map(), permissionMode, cwd, closed: false, deps, peerBusyCount: 0, createPeerCli: () => new claude_local_runtime_2.ClaudeLocalRuntime({ cwd: runtime.cwd, executable: input.executable, authMode: input.authMode === "official" ? "official" : "api", api: input.api, permissionMode: runtime.permissionMode, model: input.model, effort: input.effort, autoCompactPercent: Number.isFinite(Number(input.autoCompactPercent)) ? Number(input.autoCompactPercent) : 70, additionalDirectories: !remote && deps.libraryRoot ? [deps.libraryRoot] : [], ...(conn ? { remote: { launch: (args, options) => (0, claude_remote_launch_1.launchRemoteClaude)(conn, { platform: input.platform, nodeExecutable: input.nodeExecutable, executable: input.executable, remoteCwd: input.remoteCwd, configDir: input.configDir, args, ...options }) } } : {}), ...(endpoint && host ? { mcp: { url: endpoint.url, token: endpoint.token, name: "opencodex_mac" } } : {}), onPermission: (request) => request.toolName.startsWith("mcp__opencodex_mac__") ? Promise.resolve({ allow: !!runtime && !runtime.closed && (runtime.cli.busy || runtime.peerBusyCount > 0) && !request.signal.aborted }) : (runtime ? ask(runtime, request.input, request.toolName, request.signal) : Promise.resolve({ allow: false })), onEvent: event => { if (!runtime?.backgroundTextOnly || event.type === "closed") deps.emit("claude:event", event); } }) };');
 code=once(code,'pending.resolve({ allow: input.decision === "accept" && runtime.cli.busy && !runtime.closed, updatedInput });','pending.resolve({ allow: input.decision === "accept" && (runtime.cli.busy || runtime.peerBusyCount > 0) && !runtime.closed, updatedInput });');
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
 code=once(code,`    let stdout = '';
    try {
        stdout = cp.execFileSync(executable, [...args, 'auth', 'status', '--json'], { encoding: 'utf8', env, cwd, timeout: 15000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    }
    catch (e) {
        stdout = typeof e.stdout === 'string' ? e.stdout : '';
    }`,`    let stdout = '';
    const options = { encoding: 'utf8', env, cwd, timeout: 15000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
    try {
        stdout = cp.execFileSync(executable, [...args, 'auth', 'status', '--json'], options);
    }
    catch (e) {
        stdout = typeof e.stdout === 'string' ? e.stdout : '';
        const diagnostic = String(e.stderr || '') + stdout;
        if (/unknown|unrecognized|unexpected|unsupported|not recognized/i.test(diagnostic) && diagnostic.includes('--json')) {
            try { stdout = cp.execFileSync(executable, [...args, 'auth', 'status'], options); }
            catch (fallback) { stdout = typeof fallback.stdout === 'string' ? fallback.stdout : ''; }
        }
    }`);

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

// The usage reader runs on the Claude host (serialized into the remote bootstrap), so the
// inserted code stays self-contained and ASCII-only. Legacy window keys can be null while
// `limits` still lists the active weekly and model-scoped allowances.
function patchClaudeUsageReader(code){
 return once(code,"                    resolve(Object.keys(windows).length ? { ok: true, windows, checkedAt: Date.now() } : fail('USAGE_RESPONSE'));",
  "                    for (const l of Array.isArray(raw.limits) ? raw.limits : []) {\n                        const pct = l?.percent, minutes = l?.group === 'weekly' ? 10080 : l?.group === 'session' ? 300 : null, reset = typeof l?.resets_at === 'string' ? l.resets_at : null;\n                        if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100)\n                            continue;\n                        const model = typeof l.scope?.model?.display_name === 'string' ? l.scope.model.display_name.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40) : '';\n                        if (model)\n                            windows['scoped:' + String(l.kind).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) + ':' + model] = { utilization: pct, resets_at: reset, model, minutes };\n                        else if (!l.scope && minutes === 10080 && !windows.seven_day)\n                            windows.seven_day = { utilization: pct, resets_at: reset };\n                        else if (!l.scope && minutes === 300 && !windows.five_hour)\n                            windows.five_hour = { utilization: pct, resets_at: reset };\n                    }\n                    resolve(Object.keys(windows).length ? { ok: true, windows, checkedAt: Date.now() } : fail('USAGE_RESPONSE'));");
}
// Name model-scoped allowances from the reader's sanitized fields instead of the raw key.
function patchRuntimeUsage(code){
 return once(code,"windows.push({ id, name: claudeWindowMeta[id]?.name || id, usedPercent: used, remainingPercent: 100 - used, resetsAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null, windowDurationMins: claudeWindowMeta[id]?.minutes ?? null });",
  "const minutes = claudeWindowMeta[id]?.minutes ?? finite(value.minutes), model = typeof value.model === 'string' ? value.model.slice(0, 40) : '';\n        windows.push({ id, name: claudeWindowMeta[id]?.name || (model ? (minutes === 10080 ? '每週' : minutes === 300 ? '5 小時' : '額度') + ' · ' + model + ' 專屬額度' : id), model: model || null, usedPercent: used, remainingPercent: 100 - used, resetsAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null, windowDurationMins: minutes });");
}

// The 30-second sidebar poll kept a rate-limited usage endpoint throttled. Back off per outcome.
function patchClaudeQuotaBackoff(code){
 return once(code,"        if (Date.now() - this.quotaChecked < 60000 && this.quota?.status === 'available')\n            return this.quota;",
  "        if (this.quotaChecked && Date.now() - this.quotaChecked < (this.quota?.status === 'available' ? 120000 : this.quota?.code === 'USAGE_RATE_LIMIT' ? 300000 : 60000))\n            return this.quota;");
}

module.exports={patchClaudeBackend,patchClaudeRuntime,patchClaudeAuthProbe,patchClaudeUsageReader,patchRuntimeUsage,patchClaudeQuotaBackoff};
