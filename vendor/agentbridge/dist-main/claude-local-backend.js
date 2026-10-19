"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.releaseClaudeTask = exports.acquireClaudeTask = void 0;
exports.stopAllClaudeLocalRuntimes = stopAllClaudeLocalRuntimes;
exports.runClaudeBackgroundTurn = runClaudeBackgroundTurn;
exports.cancelClaudeBackgroundTurn = cancelClaudeBackgroundTurn;
exports.claudeComputerDiagnostics = claudeComputerDiagnostics;
exports.claudeToolHealth = claudeToolHealth;
exports.registerClaudeLocalBackend = registerClaudeLocalBackend;
const task_runtime_pool_1 = require("./task-runtime-pool");
const connection_network_1 = require("./connection-network");
const permission_policy_1 = require("./permission-policy");
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const runtime_backend_1 = require("./runtime-backend");
const remote_shell_1 = require("./remote-shell");
const claude_remote_launch_1 = require("./claude-remote-launch");
const loopback_forward_1 = require("./loopback-forward");
const claude_local_runtime_1 = require("./claude-local-runtime");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = require("node:crypto");
const claude_local_runtime_2 = require("./claude-local-runtime");
const local_tool_host_1 = require("./local-tool-host");
const runtime_attachments_1 = require("./runtime-attachments");
let taskPool;
const acquireClaudeTask = (rootId, taskId, requestId) => taskPool.acquire(rootId, taskId, requestId);
exports.acquireClaudeTask = acquireClaudeTask;
const releaseClaudeTask = (id, requestId) => taskPool.release(id, requestId);
exports.releaseClaudeTask = releaseClaudeTask;
const runtimes = new Map();
function get(id) { const runtime = runtimes.get(id); if (!runtime || runtime.closed)
    throw new Error("Claude 本機連線已中斷，請重新連線。"); return runtime; }
function emit(runtime, event) { runtime.deps.emit("claude:event", { runtimeId: runtime.cli.id, ...(runtime.cli.activeRequestId ? { requestId: runtime.cli.activeRequestId } : {}), ...event }); }
function snapshot(runtime) { const native = runtime.cli.status(); return { ...native, ...runtime.network, capabilities: { ...native.capabilities, localTools: native.capabilities.localTools && !!runtime.host?.status().ok }, ...(runtime.hostName ? { hostName: runtime.hostName, hostKey: runtime.hostKey } : {}), macTools: runtime.host?.status(), localToolNames: runtime.host?.listTools().map(t => t.name) || [], toolHostConnected: !!runtime.host?.status().ok }; }
function clearPending(runtime) { for (const [id, pending] of runtime.pending) {
    pending.dispose();
    pending.resolve({ allow: false });
    emit(runtime, { type: "requestClosed", approvalId: id });
} runtime.pending.clear(); }
function ask(runtime, input, name, signal) {
    if (runtime.closed || !runtime.cli.busy || signal?.aborted || runtime.backgroundTextOnly)
        return Promise.resolve({ allow: false });
    const isQuestion = name === "AskUserQuestion";
    if (!isQuestion && runtime.permissionMode === "full")
        return Promise.resolve({ allow: true });
    const approvalId = (0, node_crypto_1.randomUUID)();
    return new Promise(resolve => {
        const finish = (answer) => { const entry = runtime.pending.get(approvalId); if (!entry)
            return; runtime.pending.delete(approvalId); entry.dispose(); emit(runtime, { type: "requestClosed", approvalId }); resolve(answer); };
        const cancel = () => finish({ allow: false });
        const timer = setTimeout(cancel, 120_000);
        const questions = isQuestion && Array.isArray(input.questions) ? input.questions : undefined;
        runtime.pending.set(approvalId, { isQuestion, resolve: finish, input, questions, dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); } });
        signal?.addEventListener("abort", cancel, { once: true });
        emit(runtime, { type: isQuestion ? "userInput" : "approval", approvalId, executionLocation: "local", title: isQuestion ? "Claude 需要你的回答" : `允許 Claude 在這台 Mac 使用 ${name}？`,
            detail: JSON.stringify(input, null, 2).slice(0, 8000), ...(questions ? { questions: questions.map((q, index) => ({ id: String(index), question: q.question, header: q.header, options: q.options })) } : {}) });
    });
}
async function close(runtime, reason = "Claude 本機連線已關閉。") {
    if (runtime.closed)
        return;
    runtime.closed = true;
    runtimes.delete(runtime.cli.id);
    clearPending(runtime);
    await runtime.cli.stop();
    runtime.forward?.stop();
    runtime.conn?.end();
    await runtime.host?.stop();
    emit(runtime, { type: "closed", text: reason });
}
async function stopAllClaudeLocalRuntimes() { await Promise.all([...runtimes.values()].map(runtime => close(runtime))); }
async function runClaudeBackgroundTurn(input) {
    const runtime = get(input.runtimeId);
    const status = runtime.cli.status();
    if (!status.account?.authenticated)
        throw new Error("Claude Code 尚未登入。");
    if (runtime.cli.busy)
        throw new Error("Claude 正在處理其他工作，無法開始自動討論。");
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 120_000)
        throw new Error("自動討論提示內容無效。");
    runtime.backgroundTextOnly = true;
    try {
        return await runtime.cli.sendAndWait({
            requestId: input.requestId,
            prompt: input.prompt.trim(),
            conversationId: input.conversationId,
            model: input.model,
            effort: input.effort
        });
    }
    finally {
        runtime.backgroundTextOnly = false;
        clearPending(runtime);
        runtime.host?.cancelActive();
    }
}
async function cancelClaudeBackgroundTurn(runtimeId) {
    const runtime = runtimes.get(runtimeId);
    if (!runtime || runtime.closed || !runtime.backgroundTextOnly)
        return { cancelled: false };
    return runtime.cli.cancel(runtime.cli.activeRequestId);
}
async function claudeComputerDiagnostics(id) { return get(id).host?.computerDiagnostics(); }
async function claudeToolHealth(id) { return get(id).host?.toolHealth(); }
function registerClaudeLocalBackend(deps) {
    const pool = new task_runtime_pool_1.TaskRuntimePool(async (id) => { const runtime = runtimes.get(id); if (runtime)
        await close(runtime); });
    taskPool = pool;
    const emitEvent = deps.emit;
    deps = { ...deps, emit: (channel, payload) => { if (payload.type === 'done')
            pool.release(payload.runtimeId, payload.requestId); if (payload.type === 'closed')
            pool.forget(payload.runtimeId); emitEvent(channel, payload); } };
    electron_1.ipcMain.handle("claude:login", async (_event, input = {}) => {
        const executable = await (0, claude_local_runtime_1.findClaudeExecutable)(input.executable);
        const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
        const directory = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'agentbridge-claude-login-'));
        await promises_1.default.chmod(directory, 0o700);
        const file = node_path_1.default.join(directory, 'Claude 官方登入.command');
        const keys = Object.keys(process.env).filter(key => /^ANTHROPIC_[A-Z0-9_]+$|^CLAUDE_CODE_(?:OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)$/.test(key));
        const script = '#!/bin/zsh\n' + 'unset ' + [...new Set([...keys, 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'])].join(' ') + '\n' + quote(executable) + " --setting-sources '' auth login --claudeai\n" + "result=$?\nrm -f -- " + quote(file) + "\nrmdir -- " + quote(directory) + " 2>/dev/null\nexit $result\n";
        await promises_1.default.writeFile(file, script, { mode: 0o700 });
        const error = await electron_1.shell.openPath(file);
        if (error) {
            await promises_1.default.rm(directory, { recursive: true, force: true });
            throw new Error('無法開啟原生登入視窗。請在終端機執行 claude auth login --claudeai。');
        }
        return { opened: true };
    });
    const connectClaude = async (_event, input = {}) => {
        // A friend-host profile is mandatory for the remote path. Never fall back to the Mac CLI.
        const remote = input.location !== "local";
        let conn;
        let forward;
        let network;
        if (remote) {
            if (!deps.connectConfig)
                throw new Error("朋友 Runtime SSH 尚未就緒。");
            const connected = await (0, connection_network_1.connectNetwork)(input, () => (0, runtime_backend_1.connectTrustedRuntimeSsh)(input, deps.connectConfig), () => { if (!deps.connectRelay)
                throw new Error('Relay 尚未就緒。'); return deps.connectRelay(input); });
            network = { requiresReconnectKey: !!input.api?.apiKey, profileId: input.profile.id, relayUrl: input.profile.relayUrl, transport: connected.transport, networkDiagnostics: connected.diagnostics };
            if (connected.confirmation)
                return connected.confirmation;
            conn = connected.conn;
            try {
                input = { ...input, platform: connected.transport === 'https-relay' ? (conn.platform === 'win32' ? 'windows' : 'posix') : await (0, remote_shell_1.resolveRemotePlatform)(conn, input.platform) };
            }
            catch (error) {
                conn?.end();
                throw error;
            }
        }
        let cwd;
        try {
            cwd = await promises_1.default.realpath(input.localCwd || input.cwd || node_os_1.default.homedir());
            if (!(await promises_1.default.stat(cwd)).isDirectory())
                throw new Error("directory required");
        }
        catch {
            conn?.end();
            throw new Error("請選擇有效的 Mac 工作資料夾。");
        }
        if (!(await promises_1.default.stat(cwd)).isDirectory())
            throw new Error("請選擇 Mac 工作資料夾。");
        const permissionMode = ["ask", "project", "full"].includes(input.permissionMode) ? input.permissionMode : "ask";
        let runtime;
        let host;
        let endpoint;
        try {
            if (deps.libraryRoot)
                await promises_1.default.mkdir(deps.libraryRoot, { recursive: true });
            host = new local_tool_host_1.LocalToolHost({ stateDirectory: deps.stateDirectory, allowedRoots: [cwd], extensionServers: await deps.extensionServers?.(cwd), enableShell: remote, readOnlyRoots: deps.libraryRoot ? [deps.libraryRoot] : [], agentRole: "claude", ...(typeof deps.localTools === "function" ? deps.localTools() : deps.localTools),
                fullFilesystemAccess: permissionMode === "full",
                authorize: async (call) => {
                    if (!runtime || runtime.closed || !runtime.cli.busy || runtime.backgroundTextOnly)
                        return false;
                    if (call.category === "agent-bridge" || runtime.permissionMode === "full" || (runtime.permissionMode === "project" && call.category === "filesystem-read"))
                        return true;
                    return (await ask(runtime, call.arguments, call.name)).allow;
                } });
            endpoint = await host.start();
        }
        catch (error) {
            await host?.stop();
            conn?.end();
            throw new Error("Mac 工具通道啟動失敗；不會改在朋友電腦執行工作。");
        }
        if (conn) {
            try {
                forward = new loopback_forward_1.LoopbackForward(conn, endpoint.port);
                const port = await forward.start();
                endpoint = { ...endpoint, url: `http://127.0.0.1:${port}/mcp` };
            }
            catch (error) {
                await host?.stop();
                conn.end();
                throw error;
            }
        }
        const cli = new claude_local_runtime_2.ClaudeLocalRuntime({ cwd, executable: input.executable, authMode: input.authMode === "official" ? "official" : "api", api: input.api, permissionMode, model: input.model, effort: input.effort, autoCompactPercent: Number.isFinite(Number(input.autoCompactPercent)) ? Number(input.autoCompactPercent) : 70,
            additionalDirectories: !remote && deps.libraryRoot ? [deps.libraryRoot] : [],
            ...(conn ? { remote: { launch: (args, options) => (0, claude_remote_launch_1.launchRemoteClaude)(conn, { platform: input.platform, nodeExecutable: input.nodeExecutable, executable: input.executable, remoteCwd: input.remoteCwd, configDir: input.configDir, args, ...options }) } } : {}),
            ...(endpoint && host ? { mcp: { url: endpoint.url, token: endpoint.token, name: "agentbridge_mac" } } : {}),
            onPermission: (request) => {
                // Mac MCP requests receive a single approval at the host, including calls the CLI auto-approves.
                if (request.toolName.startsWith("mcp__agentbridge_mac__"))
                    return Promise.resolve({ allow: !!runtime && !runtime.closed && runtime.cli.busy && !request.signal.aborted });
                return runtime ? ask(runtime, request.input, request.toolName, request.signal) : Promise.resolve({ allow: false });
            },
            onEvent: event => {
                if (runtime && event.type === "done") {
                    clearPending(runtime);
                    runtime.host?.cancelActive();
                }
                if (!runtime?.backgroundTextOnly || event.type === "closed")
                    deps.emit("claude:event", event);
                if (runtime && event.type === "closed" && !runtime.closed)
                    void close(runtime, event.text);
            } });
        runtime = { cli, host, conn, forward, network, hostName: remote ? (input.profile.name || input.profile.host) : undefined, hostKey: remote ? `${input.profile.username}@${input.profile.host}:${input.profile.port || 22}|claude|${input.authMode}|${input.remoteCwd || ''}` + (input.configDir ? '|config:' + input.configDir : '') : undefined, pending: new Map(), permissionMode, cwd, closed: false, deps };
        conn?.on('error', (error) => { if (runtime && !runtime.closed)
            void close(runtime, /ERR_AUTH/.test(error.message) ? 'ERR_AUTH：Relay 授權已失效，請重新配對。' : '網路連線已中斷。'); });
        conn?.on("close", () => { if (runtime && !runtime.closed)
            void close(runtime, "朋友的 Claude 網路連線已中斷；未重送指令。"); });
        try {
            await cli.start();
            const catalog = await cli.extensions();
            if (remote && catalog.mcp.some((server) => server.name !== "agentbridge_mac"))
                throw new Error("Claude 載入了非 Mac 工具，已停止這次連線。");
            runtimes.set(cli.id, runtime);
            return snapshot(runtime);
        }
        catch (error) {
            await cli.stop();
            forward?.stop();
            conn?.end();
            await host?.stop();
            if (input.profile?.networkMode !== 'direct' && input.profile?.networkMode !== 'relay' && network?.transport === 'tailscale-ssh' && input.profile?.relayUrl && /timeout|timed out|handshake|中斷|結束/i.test(String(error)))
                return connectClaude(_event, { ...input, profile: { ...input.profile, networkMode: 'relay' } });
            throw error;
        }
    };
    electron_1.ipcMain.handle('claude:connect', async (event, input) => {
        const result = await connectClaude(event, input);
        if (result.runtimeId)
            pool.register(result, () => connectClaude(event, { ...input, permissionMode: runtimes.get(result.runtimeId)?.permissionMode || input.permissionMode }));
        if (result.runtimeId)
            event.sender?.once('destroyed', () => { void pool.disconnect(result.runtimeId); });
        return result;
    });
    electron_1.ipcMain.handle('claude:acquireTask', async (_event, input) => {
        const leased = await pool.acquire(input.runtimeId, input.taskId, input.requestId);
        return snapshot(get(leased.runtimeId));
    });
    electron_1.ipcMain.handle('claude:releaseTask', (_event, id, requestId) => { if (!runtimes.get(id)?.cli.busy)
        pool.release(id, requestId); });
    electron_1.ipcMain.handle('claude:permission', (_event, id, value) => {
        const runtime = get(id), mode = (0, permission_policy_1.permissionMode)(value);
        runtime.cli.setPermissionMode(mode);
        runtime.permissionMode = mode;
        runtime.host?.setFullFilesystemAccess(mode === 'full');
        if (runtime.permissionMode === 'full')
            for (const pending of [...runtime.pending.values()])
                if (!pending.isQuestion)
                    pending.resolve({ allow: runtime.cli.busy && !runtime.backgroundTextOnly });
        return snapshot(runtime);
    });
    electron_1.ipcMain.handle('claude:recoverTools', async (_event, id) => { const runtime = get(id); if (runtime.cli.busy)
        throw new Error('請先停止目前工作，再重新連接工具。'); await runtime.host?.recoverProxyTools(); return snapshot(runtime); });
    electron_1.ipcMain.handle('claude:quota', (_event, id) => get(id).cli.refreshQuota());
    electron_1.ipcMain.handle("claude:status", async (_event, id) => { const runtime = get(id); await runtime.cli.refreshAccount(); return snapshot(runtime); });
    electron_1.ipcMain.handle("claude:models", (_event, id) => get(id).cli.status().models);
    electron_1.ipcMain.handle("claude:extensions", async (_event, id) => {
        const runtime = get(id), native = await runtime.cli.extensions(), source = runtime.conn ? "remote" : "local";
        return { items: [...native.plugins.map((plugin) => ({ id: `local:claude:plugin:${plugin.name}`, name: plugin.name, kind: "plugin", agent: "claude", source, status: "loaded", enabled: true })), ...native.commands.map((command) => ({ id: `local:claude:skill:${command.name}`, name: command.name, kind: "skill", agent: "claude", source, status: "loaded", enabled: true, description: command.description })), ...native.mcp.map((server) => ({ id: `local:claude:mcp:${server.name}`, name: server.name, kind: "mcp", agent: "claude", source, status: server.status, enabled: true }))], warnings: runtime.conn ? ["朋友主機的原生 Skills／指令仍可使用。此分離模式停用朋友主機的 hooks 與原有 MCP；電腦、檔案與命令改用 Mac 通道。"] : [] };
    });
    electron_1.ipcMain.handle("claude:send", async (_event, input) => {
        const runtime = get(input.runtimeId);
        if (runtime.sendPending || runtime.cli.busy)
            throw new Error("Claude 還在處理上一則訊息。");
        runtime.sendPending = true;
        try {
            if (!runtime.cli.status().account.authenticated)
                await runtime.cli.refreshAccount();
            if (!runtime.cli.status().account.authenticated)
                throw new Error("Claude 原生登入尚未確認；朋友完成登入後可重新發送。");
            if (runtime.cli.busy)
                throw new Error("Claude 還在處理上一則訊息。");
            if (typeof input.prompt !== "string" || (!input.prompt.trim() && !input.attachments?.length))
                throw new Error("請輸入訊息或加入附件。");
            const ids = input.attachments || [];
            if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== "string"))
                throw new Error("附件識別碼無效。");
            if (ids.length && !deps.libraryEntries)
                throw new Error("檔案庫尚未就緒。");
            if (input.localCwd && await promises_1.default.realpath(input.localCwd) !== runtime.cwd)
                throw new Error("變更 Mac 工作目錄後請重新連線。");
            const attachments = ids.length ? await deps.libraryEntries(ids) : [];
            const blocks = await (0, runtime_attachments_1.runtimeInput)(input.prompt.trim() || "請查看並處理附加的檔案。", attachments);
            if (typeof input.customInstructions === "string" && input.customInstructions.trim()) {
                blocks.push({ type: "text", text: `使用者自訂指令（適用於本次對話）：\n${input.customInstructions.trim()}` });
            }
            // ponytail: cli.send takes an explicit subset — spreading the whole input would smuggle unknown IPC keys into the CLI args
            const content = blocks.map(block => {
                if (block.type === "text")
                    return { type: "text", text: block.text };
                const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/.exec(block.url);
                if (!match)
                    throw new Error("圖片附件格式無效。");
                return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
            });
            if (runtime.closed || runtime.cli.busy)
                throw new Error("Claude 已中斷或仍在處理上一則訊息。");
            return await runtime.cli.send({ prompt: input.prompt, requestId: input.requestId, conversationId: input.conversationId, model: input.model, effort: input.effort, autoCompactPercent: input.autoCompactPercent, content, systemPrompt: input.customInstructions });
        }
        finally {
            runtime.sendPending = false;
        }
    });
    electron_1.ipcMain.handle("claude:cancel", async (_event, id, requestId) => {
        const runtime = get(id);
        if (requestId && runtime.cli.activeRequestId !== requestId)
            return { cancelled: false };
        clearPending(runtime);
        runtime.host?.cancelActive();
        return runtime.cli.cancel(requestId);
    });
    electron_1.ipcMain.handle("claude:respond", (_event, input) => {
        const runtime = get(input.runtimeId);
        const pending = runtime.pending.get(input.approvalId);
        if (!pending || !["accept", "decline"].includes(input.decision))
            throw new Error("這個要求已結束或回應無效。");
        let updatedInput;
        if (input.decision === "accept" && pending.questions) {
            const answers = {};
            pending.questions.forEach((question, index) => {
                const values = input.answers?.[String(index)];
                if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== "string"))
                    throw new Error("請回答每一個問題。");
                answers[question.question] = values.join(", ");
            });
            updatedInput = { ...pending.input, answers };
        }
        pending.resolve({ allow: input.decision === "accept" && runtime.cli.busy && !runtime.closed, updatedInput });
        return { resolved: true };
    });
    electron_1.ipcMain.handle("claude:disconnect", async (_event, id) => { await pool.disconnect(id); const runtime = runtimes.get(id); if (runtime)
        await close(runtime); });
}
