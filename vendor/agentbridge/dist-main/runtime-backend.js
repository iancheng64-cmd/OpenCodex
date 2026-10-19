"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.releaseCodexTask = exports.acquireCodexTask = void 0;
exports.hostFingerprint = hostFingerprint;
exports.stopAllRuntimes = stopAllRuntimes;
exports.localToolCapability = localToolCapability;
exports.connectTrustedRuntimeSsh = connectTrustedRuntimeSsh;
exports.codexToolHealth = codexToolHealth;
exports.codexComputerDiagnostics = codexComputerDiagnostics;
exports.runCodexBackgroundTurn = runCodexBackgroundTurn;
exports.cancelCodexBackgroundTurn = cancelCodexBackgroundTurn;
exports.registerRuntimeBackend = registerRuntimeBackend;
const task_runtime_pool_1 = require("./task-runtime-pool");
const connection_network_1 = require("./connection-network");
const runtime_errors_1 = require("./runtime-errors");
const runtime_usage_1 = require("./runtime-usage");
const permission_policy_1 = require("./permission-policy");
const remote_shell_1 = require("./remote-shell");
const electron_1 = require("electron");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = require("node:crypto");
const ssh2_1 = require("ssh2");
const app_server_rpc_1 = require("./app-server-rpc");
const local_code_mode_host_1 = require("./local-code-mode-host");
const local_exec_server_1 = require("./local-exec-server");
const local_tool_host_1 = require("./local-tool-host");
const runtime_policy_1 = require("./runtime-policy");
const runtime_attachments_1 = require("./runtime-attachments");
const runtime_extensions_1 = require("./runtime-extensions");
let taskPool;
const acquireCodexTask = (rootId, taskId, requestId) => taskPool.acquire(rootId, taskId, requestId);
exports.acquireCodexTask = acquireCodexTask;
const releaseCodexTask = (id, requestId) => taskPool.release(id, requestId);
exports.releaseCodexTask = releaseCodexTask;
const runtimes = new Map();
const usageByThread = new Map();
const quotaByRuntime = new Map();
async function readRuntimeQuota(runtime) {
    const { id, quotaEpoch: epoch, quotaRevision: revision } = runtime, sequence = ++runtime.quotaRequest;
    const unavailable = (error) => ({ ...(0, runtime_usage_1.rateLimitSummary)(null), error });
    if (!runtime.snapshot.account.authenticated)
        return unavailable('此 Runtime 帳戶尚未登入，無法讀取剩餘用量。');
    try {
        const raw = await runtime.rpc.request('account/rateLimits/read', {}, 15000);
        if (runtime.closed || epoch !== runtime.quotaEpoch)
            return { ...unavailable('登入狀態已變更，請重新更新帳戶剩餘用量。'), resetBaseline: true };
        if (sequence !== runtime.quotaRequest || revision !== runtime.quotaRevision)
            return quotaByRuntime.get(id) || unavailable('剩餘用量正在更新，請稍後再試。');
        const quota = (0, runtime_usage_1.rateLimitSummary)(raw);
        quotaByRuntime.set(id, quota);
        return quota.available ? quota : { ...quota, error: '此 Runtime 未提供可顯示的帳戶額度視窗。' };
    }
    catch {
        if (runtime.closed || epoch !== runtime.quotaEpoch)
            return { ...unavailable('登入狀態已變更，請重新更新帳戶剩餘用量。'), resetBaseline: true };
        if (sequence !== runtime.quotaRequest || revision !== runtime.quotaRevision)
            return quotaByRuntime.get(id) || unavailable('剩餘用量正在更新，請稍後再試。');
        return { ...unavailable('Runtime 暫時無法讀取剩餘用量；請按更新重試。'), ...(quotaByRuntime.get(id)?.available ? { lastKnown: quotaByRuntime.get(id) } : {}) };
    }
}
function trustedHostsPath() { return node_path_1.default.join(electron_1.app.getPath("userData"), "runtime-known-hosts.json"); }
function readTrustedHosts() { try {
    return JSON.parse(node_fs_1.default.readFileSync(trustedHostsPath(), "utf8"));
}
catch {
    return {};
} }
function trustHost(key, fingerprint) {
    const file = trustedHostsPath();
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    node_fs_1.default.writeFileSync(file + ".tmp", JSON.stringify({ ...readTrustedHosts(), [key]: fingerprint }, null, 2), { mode: 0o600 });
    node_fs_1.default.renameSync(file + ".tmp", file);
}
function hostFingerprint(key) { return "SHA256:" + (0, node_crypto_1.createHash)("sha256").update(key).digest("base64").replace(/=+$/, ""); }
async function listModels(rpc) {
    const data = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
        const response = await rpc.request("model/list", { ...(cursor ? { cursor } : {}) });
        data.push(...(Array.isArray(response.data) ? response.data : []));
        if (!response.nextCursor || response.nextCursor === cursor)
            break;
        cursor = response.nextCursor;
    }
    return (0, app_server_rpc_1.modelSummary)({ data });
}
function execChannel(conn, command) {
    return new Promise((resolve, reject) => conn.exec(command, { pty: false }, (error, stream) => error ? reject(error) : resolve(stream)));
}
function closeRuntime(runtime, deps, reason = "Runtime 已中斷連線。") {
    if (runtime.closed)
        return;
    runtime.closed = true;
    runtimes.delete(runtime.id);
    quotaByRuntime.delete(runtime.id);
    for (const key of usageByThread.keys())
        if (key.startsWith(runtime.id + ":"))
            usageByThread.delete(key);
    for (const pending of runtime.requests.values()) {
        clearTimeout(pending.timer);
        pending.localResolve?.(false);
    }
    for (const approvalId of runtime.requests.keys())
        deps.emit("runtime:event", { runtimeId: runtime.id, type: "requestClosed", approvalId });
    runtime.requests.clear();
    if (runtime.run) {
        if (runtime.run.backgroundTextOnly)
            runtime.run.completion?.reject(new Error(reason));
        else
            deps.emit("runtime:event", { runtimeId: runtime.id, requestId: runtime.run.requestId, type: "done", status: "error", text: reason });
    }
    runtime.run = undefined;
    void node_fs_1.default.promises.rm(runtime.manifestPath, { force: true }).catch(() => { });
    runtime.rpc.close();
    runtime.host?.stop();
    runtime.executor?.stop();
    runtime.toolForward?.stop();
    void runtime.toolHost?.stop();
    runtime.conn.end();
    deps.emit("runtime:event", { runtimeId: runtime.id, type: "closed", text: reason });
}
function stopAllRuntimes(deps) { for (const runtime of runtimes.values())
    closeRuntime(runtime, deps); }
function emitForRun(runtime, deps, event) {
    if (runtime.run?.backgroundTextOnly)
        return;
    deps.emit("runtime:event", { runtimeId: runtime.id, ...(runtime.run ? { requestId: runtime.run.requestId } : {}), ...event });
}
/** Code Mode Host alone is insufficient. Only the version-matched, authenticated executor
 * enables chat; each turn separately verifies the Mac-only MCP inventory and environment binding. */
function localToolCapability(hasCodeModeHost, hasExecutor = false, hasMacTools = false) {
    return {
        localTools: hasExecutor,
        fileShell: hasExecutor,
        macMcp: hasMacTools,
        reason: hasExecutor
            ? "命令與檔案工具使用此 Mac Executor；可用的 Mac 擴充工具依連線狀態顯示。"
            : hasCodeModeHost
                ? "Mac Code Mode Host 已連線，但它不會接管 Runtime 主機的命令與檔案工具；請兩端使用相同且已驗證的 Codex 版本。"
                : "尚無已驗證的 Mac 工具執行通道；請兩端使用相同且已驗證的 Codex 版本並重新連線。"
    };
}
function authorizeMacTool(runtime, deps, call) {
    if (!runtime || runtime.closed || !runtime.run || runtime.run.cancelled)
        return Promise.resolve(false);
    if (runtime.run.backgroundTextOnly)
        return Promise.resolve(false);
    if (call.category === "agent-bridge" || runtime.permissionMode === "full" || (runtime.permissionMode === "project" && call.category === "filesystem-read"))
        return Promise.resolve(true);
    const active = runtime;
    const approvalId = (0, node_crypto_1.randomUUID)();
    return new Promise(resolve => {
        const timer = setTimeout(() => { active.requests.delete(approvalId); emitForRun(active, deps, { type: "requestClosed", approvalId }); resolve(false); }, 120000);
        active.requests.set(approvalId, { request: { id: approvalId, method: "local/tool", params: call }, requestId: active.run.requestId, localResolve: resolve, timer });
        emitForRun(active, deps, { type: "approval", approvalId, executionLocation: "local", title: `允許在這台 Mac 使用 ${call.name}？`, detail: JSON.stringify(call.arguments, null, 2).slice(0, 8000) });
    });
}
async function refreshMacExtensions(runtime, deps) {
    const catalog = deps.extensions ? (0, runtime_extensions_1.localExtensionCatalog)(await deps.extensions(runtime.localCwd)) : { items: [], warnings: ["Mac 擴充目錄尚未提供；仍可使用已連線的工具。"] };
    await (0, runtime_extensions_1.writeExtensionManifest)(runtime.manifestPath, catalog);
    runtime.extensionCatalog = catalog;
    return { ...catalog, toolHost: runtime.toolHost?.status(), executionLocation: "local", runtimeVersion: runtime.snapshot.runtimeVersion };
}
async function verifyThreadMcp(runtime, threadId, expectedConfig) {
    const inventory = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
        const result = await runtime.rpc.request("mcpServerStatus/list", { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result.data))
            throw new Error("Runtime 未提供有效的 MCP 工具清單。");
        inventory.push(...result.data);
        if (!result.nextCursor) {
            try {
                (0, runtime_policy_1.validateMacMcpInventory)(inventory, runtime.mcp?.name);
            }
            catch (error) {
                // Only capability metadata, never endpoints, headers, auth or tool arguments.
                node_fs_1.default.writeFileSync(node_path_1.default.join(electron_1.app.getPath("userData"), "runtime-isolation-diagnostic.json"), JSON.stringify({
                    version: runtime.snapshot.runtimeVersion, expected: Object.entries(expectedConfig?.mcp_servers || {}).map(([name, value]) => ({ name, enabled: value.enabled })),
                    inventory: inventory.map(item => ({ name: item.name, status: item.runtimeStatus, toolCount: Object.keys(item.tools || {}).length, resourceCount: item.resources?.length || 0, templateCount: item.resourceTemplates?.length || 0 }))
                }, null, 2), { mode: 0o600 });
                throw error;
            }
            return;
        }
        if (result.nextCursor === cursor)
            break;
        cursor = result.nextCursor;
    }
    throw new Error("Runtime MCP 工具清單無法完整驗證。");
}
function routeNotification(runtime, deps, message) {
    const params = message.params || {};
    const run = runtime.run;
    if (message.method === "account/updated") {
        // Do not forward identity fields or bearer tokens to the renderer.
        runtime.snapshot.account = (0, app_server_rpc_1.accountUpdateSummary)(params);
        runtime.quotaEpoch++;
        runtime.quotaRevision++;
        quotaByRuntime.delete(runtime.id);
        for (const key of usageByThread.keys())
            if (key.startsWith(runtime.id + ":"))
                usageByThread.delete(key);
        deps.emit("runtime:event", { runtimeId: runtime.id, type: "quota", quota: { ...(0, runtime_usage_1.rateLimitSummary)(null), error: "登入狀態已變更，請重新更新帳號額度。", resetBaseline: true } });
        emitForRun(runtime, deps, { type: "status", snapshot: runtime.snapshot });
        return;
    }
    if (message.method === "account/rateLimits/updated") {
        if (!runtime.snapshot.account.authenticated)
            return;
        runtime.quotaRevision++;
        const value = (0, runtime_usage_1.mergeRateLimitSummary)(quotaByRuntime.get(runtime.id), params);
        quotaByRuntime.set(runtime.id, value);
        deps.emit("runtime:event", { runtimeId: runtime.id, type: "quota", quota: value });
        // A rolling event is not a full multi-bucket/account snapshot.
        const epoch = runtime.quotaEpoch;
        void readRuntimeQuota(runtime).then(quota => { if (!runtime.closed && epoch === runtime.quotaEpoch)
            deps.emit("runtime:event", { runtimeId: runtime.id, type: "quota", quota }); });
        return;
    }
    if (message.method === "serverRequest/resolved") {
        for (const [id, pending] of runtime.requests)
            if (pending.request.id === params.requestId) {
                runtime.requests.delete(id);
                emitForRun(runtime, deps, { type: "requestClosed", approvalId: id });
            }
        return;
    }
    if (message.method === "thread/compacted") {
        deps.emit("runtime:event", { runtimeId: runtime.id, type: "activity", text: "Codex 對話上下文已完成自動壓縮" });
        return;
    }
    if (!run)
        return;
    if (params.threadId && run.threadId && params.threadId !== run.threadId)
        return;
    const eventTurnId = params.turnId || params.turn?.id;
    if (eventTurnId && run.turnId && eventTurnId !== run.turnId)
        return;
    if (message.method === "thread/tokenUsage/updated") {
        if (!run.acceptUsage || !run.threadId || params.threadId !== run.threadId)
            return;
        const total = (0, runtime_usage_1.tokenCount)(params.tokenUsage?.total);
        const key = runtime.id + ":" + params.threadId;
        usageByThread.set(key, total);
        const modelContextWindow = Number(params.tokenUsage?.modelContextWindow) || 0;
        if (modelContextWindow > 0)
            runtime.threadContextWindows.set(params.threadId, modelContextWindow);
        const lastUsage = (0, runtime_usage_1.tokenCount)(params.tokenUsage?.last);
        const activeContextTokens = ((lastUsage.inputTokens || 0) + (lastUsage.cachedInputTokens || 0)) || (total.inputTokens || 0);
        if (activeContextTokens > 0)
            runtime.threadContextTokens.set(params.threadId, activeContextTokens);
        const usage = run.usageComplete ? (0, runtime_usage_1.tokenDelta)(total, run.usageBaseline) : { ...lastUsage, totalTokens: null };
        emitForRun(runtime, deps, { type: "usage", turnId: params.turnId, usage: { ...usage, source: run.usageComplete ? "codex-thread-delta" : "codex-last-request", complete: run.usageComplete === true } });
        return;
    }
    if (message.method === "turn/started") {
        run.turnId = params.turn?.id;
        run.acceptUsage = true;
        emitForRun(runtime, deps, { type: "activity", text: "Codex 正在思考" });
    }
    else if (message.method === "item/agentMessage/delta") {
        const id = params.itemId || "assistant";
        run.messages.set(id, (run.messages.get(id) || "") + (params.delta || ""));
        emitForRun(runtime, deps, { type: "message", text: [...run.messages.values()].join("\n\n") });
    }
    else if (message.method === "item/completed" && params.item?.type === "agentMessage") {
        run.messages.set(params.item.id, params.item.text || "");
        emitForRun(runtime, deps, { type: "message", text: [...run.messages.values()].join("\n\n") });
    }
    else if (["item/started", "item/completed"].includes(message.method) && ["commandExecution", "fileChange", "mcpToolCall"].includes(params.item?.type)) {
        const item = params.item;
        const isEnd = message.method === "item/completed";
        const content = Array.isArray(item.result?.content) ? item.result.content : [];
        const screenshot = content.find((block) => block?.type === "image" && typeof block.data === "string" && block.data.length < 8 * 1024 * 1024 && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType));
        const resultText = content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").slice(-16000);
        emitForRun(runtime, deps, { type: "tool", itemId: item.id, tool: item.tool || item.type, title: item.command || item.tool || (item.type === "fileChange" ? "修改 Mac 檔案" : "使用 Mac 工具"), text: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.slice(-16000) : resultText || undefined, ...(screenshot ? { image: `data:${screenshot.mimeType};base64,${screenshot.data}` } : {}), status: isEnd ? (item.status === "failed" || item.error || item.result?.isError ? "error" : "completed") : "running", executionLocation: "local", durationMs: item.durationMs });
    }
    else if (message.method === "item/started") {
        const names = { commandExecution: "正在執行命令", fileChange: "正在修改檔案", mcpToolCall: "正在使用工具", webSearch: "正在搜尋", reasoning: "正在思考" };
        if (names[params.item?.type])
            emitForRun(runtime, deps, { type: "activity", text: names[params.item.type] });
    }
    else if (message.method === "error") {
        const err = params.error || params;
        if (params.willRetry === true) {
            emitForRun(runtime, deps, { type: 'activity', text: '原生 Runtime 正在重試連線，已保留收到的內容。' });
            return;
        }
        const failure = (0, runtime_errors_1.runtimeFailure)(err);
        run.backgroundError = failure.text;
        emitForRun(runtime, deps, { type: "error", ...failure });
    }
    else if (message.method === "turn/completed") {
        const turn = params.turn || {};
        const rawError = turn.error || params.error;
        const failed = turn.status === "failed" || turn.status === "error";
        const failure = rawError || failed ? (0, runtime_errors_1.runtimeFailure)(rawError || turn.statusDetails?.message || turn.failureReason) : undefined;
        const errorText = failure?.text;
        if (errorText) {
            run.backgroundError = errorText;
            emitForRun(runtime, deps, { type: "error", ...failure });
            if (failure?.category === 'quota' || failure?.category === 'rate-limit')
                void readRuntimeQuota(runtime).then(quota => { if (!runtime.closed)
                    deps.emit('runtime:event', { runtimeId: runtime.id, type: 'quota', quota }); });
        }
        for (const [id, pending] of runtime.requests)
            if (pending.requestId === run.requestId) {
                clearTimeout(pending.timer);
                pending.localResolve?.(false);
                runtime.requests.delete(id);
                emitForRun(runtime, deps, { type: "requestClosed", approvalId: id });
            }
        runtime.toolHost?.cancelActive();
        const status = run.cancelled || turn.status === "interrupted" ? "cancelled" : turn.status === "failed" || turn.status === "error" || run.backgroundError ? "error" : "completed";
        const result = { requestId: run.requestId, conversationId: run.threadId, text: [...run.messages.values()].filter(Boolean).join("\n\n"), status };
        emitForRun(runtime, deps, { type: "done", status, conversationId: run.threadId, text: run.backgroundError, error: run.backgroundError });
        const currentThreadId = run.threadId;
        runtime.run = undefined;
        run.completion?.resolve(result);
        if (status === "completed" && currentThreadId && !runtime.compactingThreads.has(currentThreadId)) {
            const compactPct = runtime.autoCompactPercent || 70;
            const windowTokens = runtime.threadContextWindows.get(currentThreadId) || 128000;
            const currentTokens = runtime.threadContextTokens.get(currentThreadId) || 0;
            if (windowTokens > 0 && currentTokens >= Math.round(windowTokens * (compactPct / 100))) {
                runtime.compactingThreads.add(currentThreadId);
                setImmediate(async () => {
                    try {
                        deps.emit("runtime:event", { runtimeId: runtime.id, type: "activity", text: `上下文用量達 ${Math.round((currentTokens / windowTokens) * 100)}%，正在自動壓縮對話` });
                        await runtime.rpc.request("thread/compact/start", { threadId: currentThreadId });
                        deps.emit("runtime:event", { runtimeId: runtime.id, type: "activity", text: "Codex 對話上下文已完成自動壓縮" });
                    }
                    catch {
                    }
                    finally {
                        runtime.compactingThreads.delete(currentThreadId);
                    }
                });
            }
        }
    }
}
function routeServerRequest(runtime, deps, request) {
    const p = request.params || {};
    if (request.method === "account/chatgptAuthTokens/refresh" || request.method === "attestation/generate") {
        runtime.rpc.reject(request.id, "Account credentials remain managed on the Runtime host.");
        return;
    }
    if (request.method === "currentTime/read") {
        runtime.rpc.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        return;
    }
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput"].includes(request.method)) {
        node_fs_1.default.writeFileSync(node_path_1.default.join(electron_1.app.getPath("userData"), "runtime-request-diagnostic.json"), JSON.stringify({ method: request.method, keys: Object.keys(p), serverName: p.serverName, mode: p.mode, schemaType: p.requestedSchema?.type, properties: Object.entries(p.requestedSchema?.properties || {}).map(([name, value]) => ({ name, type: value.type, choiceNames: (value.enum || []).filter((choice) => ["approve", "decline", "accept", "reject", "yes", "no", "approve_for_session"].includes(String(choice))) })) }, null, 2), { mode: 0o600 });
        runtime.rpc.reject(request.id, "This client has no verified local executor for the requested capability.");
        return;
    }
    if (!runtime.run || runtime.run.cancelled || (p.threadId && p.threadId !== runtime.run.threadId) || (p.turnId && runtime.run.turnId && p.turnId !== runtime.run.turnId)) {
        runtime.rpc.reject(request.id, "The request does not belong to an active client turn.");
        return;
    }
    if (runtime.run.backgroundTextOnly) {
        runtime.rpc.reject(request.id, "Cross-model discussion turns are text-only; tools and interactive prompts are disabled.", -32000);
        return;
    }
    if (request.method === "item/commandExecution/requestApproval" && p.environmentId !== runtime.executor?.environmentId) {
        runtime.rpc.reject(request.id, "Command approval is not bound to the Mac executor.");
        return;
    }
    if (runtime.permissionMode === 'full' && request.method !== 'item/tool/requestUserInput') {
        if (!runtime.executor?.isRunning) {
            runtime.rpc.reject(request.id, 'Mac Executor 尚未就緒。');
            return;
        }
        runtime.rpc.respond(request.id, { decision: 'accept' });
        return;
    }
    const approvalId = (0, node_crypto_1.randomUUID)();
    runtime.requests.set(approvalId, { request, requestId: runtime.run.requestId });
    const isQuestion = request.method === "item/tool/requestUserInput";
    emitForRun(runtime, deps, { type: isQuestion ? "userInput" : "approval", approvalId,
        executionLocation: "local", title: isQuestion ? "Codex 需要你的回答" : request.method.includes("fileChange") ? "允許修改 Mac 檔案？" : "允許在 Mac 執行命令？",
        detail: isQuestion ? "" : [p.command, p.cwd ? `工作目錄：${p.cwd}` : "", p.reason].filter(Boolean).join("\n"),
        ...(isQuestion ? { questions: (Array.isArray(p.questions) ? p.questions : []).map((q) => ({ id: q.id, header: q.header, question: q.question, isOther: q.isOther, isSecret: q.isSecret, options: q.options || [] })) } : {}) });
}
async function connectTrustedRuntimeSsh(input, connectConfig) {
    if (!input?.profile || typeof input.profile.host !== "string" || !input.profile.host.trim())
        throw new Error("請提供有效的朋友 Runtime 主機。");
    if (!["auto", "windows", "posix"].includes(input.platform))
        throw new Error("請選擇 Runtime 作業系統。");
    const conn = new ssh2_1.Client(), config = connectConfig(input), key = `${String(input.profile.host).toLowerCase()}:${input.profile.port || 22}`;
    conn.on("error", () => { });
    const previous = readTrustedHosts()[key];
    let confirmation, observed = "";
    config.hostVerifier = (raw) => { observed = hostFingerprint(raw); if (observed === previous || observed === input.trustedFingerprint)
        return true; confirmation = { status: "host-confirmation", hostFingerprint: observed, previousFingerprint: previous, hostChanged: !!previous }; return false; };
    try {
        await new Promise((resolve, reject) => { conn.once("ready", resolve); conn.once("error", reject); conn.connect(config); });
    }
    catch (error) {
        try {
            conn.end();
            conn.destroy();
        }
        catch { }
        if (confirmation)
            return { confirmation };
        throw error;
    }
    trustHost(key, observed);
    return { conn, key, fingerprint: observed };
}
function diagnosticRuntime(id) { const runtime = runtimes.get(id); if (!runtime || runtime.closed)
    throw new Error('Codex Runtime 尚未連線。'); return runtime; }
async function codexToolHealth(id) { return diagnosticRuntime(id).toolHost?.toolHealth(); }
async function codexComputerDiagnostics(id, prompt = false) {
    const runtime = id ? diagnosticRuntime(id) : [...runtimes.values()].find(value => !value.closed && value.toolHost?.status().computer.startsWith('connected'));
    return runtime?.toolHost ? runtime.toolHost.computerDiagnostics(prompt) : undefined;
}
async function runCodexBackgroundTurn(input) {
    const runtime = runtimes.get(input.runtimeId);
    if (!runtime || runtime.closed)
        throw new Error("Codex Runtime 尚未連線。");
    if (!runtime.executor?.isRunning || !runtime.snapshot.executorEnvironment)
        throw new Error("Codex Mac Executor 尚未就緒。");
    if (runtime.snapshot.account.type !== "chatgpt" || !runtime.snapshot.account.authenticated)
        throw new Error("Codex Runtime 尚未登入 ChatGPT。");
    if (runtime.run)
        throw new Error("Codex 正在處理其他工作，無法開始自動討論。");
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 120_000)
        throw new Error("自動討論提示內容無效。");
    const run = {
        requestId: input.requestId || (0, node_crypto_1.randomUUID)(),
        cancelled: false,
        messages: new Map(),
        backgroundTextOnly: true
    };
    const completion = new Promise((resolve, reject) => { run.completion = { resolve, reject }; });
    runtime.run = run;
    try {
        const configuration = await runtime.rpc.request("config/read", { includeLayers: false });
        const config = (0, runtime_policy_1.macThreadConfig)(configuration.config, runtime.mcp);
        const developerInstructions = [
            (0, runtime_extensions_1.macRuntimeInstructions)(runtime.localCwd, runtime.manifestPath, runtime.toolHost?.status().tools || [], runtime.extensionCatalog),
            "You are participating in a cross-model discussion inside AgentBridge Studio.",
            "This turn is TEXT-ONLY. Do not call tools, run commands, read files, browse, or ask the user interactive questions.",
            "Respond directly to the discussion prompt with substantive reasoning. Keep the answer focused enough for another model to critique."
        ].join("\n\n");
        const thread = await runtime.rpc.request(input.conversationId ? "thread/resume" : "thread/start", {
            ...(input.conversationId ? { threadId: input.conversationId } : {}),
            developerInstructions,
            model: input.model || undefined,
            ...(!input.conversationId ? { environments: [{ environmentId: runtime.executor.environmentId, cwd: runtime.localCwd }] } : {}),
            config,
            approvalPolicy: "untrusted",
            sandbox: "read-only"
        });
        if (runtime.closed || runtime.run !== run)
            throw new Error("Codex 討論回合已中斷。");
        const threadId = thread?.thread?.id;
        if (typeof threadId !== "string" || !threadId)
            throw new Error("Codex Runtime 未回傳有效的討論 Thread ID。");
        run.threadId = threadId;
        await verifyThreadMcp(runtime, threadId);
        if (runtime.closed || runtime.run !== run)
            throw new Error("Codex 討論回合已中斷。");
        const result = await runtime.rpc.request("turn/start", {
            threadId: run.threadId,
            environments: [{ environmentId: runtime.executor.environmentId, cwd: runtime.localCwd }],
            input: [{ type: "text", text: input.prompt.trim() }],
            model: input.model || undefined,
            effort: input.effort || undefined
        });
        run.turnId = result.turn.id;
    }
    catch (error) {
        if (runtime.run === run)
            runtime.run = undefined;
        run.completion?.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const result = await completion;
    if (result.status !== "completed")
        throw new Error(run.backgroundError || (result.status === "cancelled" ? "Codex 討論回合已取消。" : "Codex 討論回合失敗。"));
    if (!result.text.trim())
        throw new Error("Codex 討論回合沒有回傳文字。");
    return result;
}
async function cancelCodexBackgroundTurn(runtimeId) {
    const runtime = runtimes.get(runtimeId);
    const run = runtime?.run;
    if (!runtime || !run?.backgroundTextOnly)
        return { cancelled: false };
    run.cancelled = true;
    runtime.toolHost?.cancelActive();
    if (run.threadId && run.turnId) {
        try {
            await runtime.rpc.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
        }
        catch { }
    }
    // The background turn's promise only resolves on turn/completed. A runtime that
    // never reports it would keep the orchestrator awaiting forever.
    const pending = run.completion;
    if (pending && runtime.run === run) {
        runtime.run = undefined;
        queueMicrotask(() => pending.resolve({ requestId: run.requestId, conversationId: run.threadId, text: [...run.messages.values()].filter(Boolean).join("\n\n"), status: "cancelled" }));
    }
    return { cancelled: true };
}
function registerRuntimeBackend(deps) {
    const pool = new task_runtime_pool_1.TaskRuntimePool(id => { const runtime = runtimes.get(id); if (runtime)
        closeRuntime(runtime, deps); });
    taskPool = pool;
    const emit = deps.emit;
    deps = { ...deps, emit: (channel, payload) => { if (payload.type === 'done')
            pool.release(payload.runtimeId, payload.requestId); if (payload.type === 'closed')
            pool.forget(payload.runtimeId); emit(channel, payload); } };
    const getRuntime = (id) => { const runtime = runtimes.get(id); if (!runtime || runtime.closed)
        throw new Error("請先連線至 Codex Runtime。"); return runtime; };
    electron_1.ipcMain.handle("runtime:chooseLocalDirectory", async () => {
        const options = { title: "選擇這台 Mac 的工作資料夾", properties: ["openDirectory", "createDirectory"] };
        const window = deps.window();
        const chosen = window ? await electron_1.dialog.showOpenDialog(window, options) : await electron_1.dialog.showOpenDialog(options);
        return chosen.canceled ? null : chosen.filePaths[0] || null;
    });
    const connectRuntime = async (_event, input) => {
        if (!["auto", "windows", "posix"].includes(input.platform))
            throw new Error("請選擇 Runtime 作業系統。");
        const connected = await (0, connection_network_1.connectNetwork)(input, () => connectTrustedRuntimeSsh(input, deps.connectConfig), () => { if (!deps.connectRelay)
            throw new Error('Relay 尚未就緒。'); return deps.connectRelay(input); });
        if (connected.confirmation)
            return connected.confirmation;
        const conn = connected.conn, key = connected.key, observed = connected.fingerprint;
        const executable = input.executable?.trim() || "codex";
        let host;
        let executor;
        let executorUrl;
        let toolHost;
        let toolForward;
        let mcp;
        let initializationFailure = "";
        let rpc;
        try {
            const platform = connected.transport === 'https-relay' ? (conn.platform === 'win32' ? 'windows' : 'posix') : await (0, remote_shell_1.resolveRemotePlatform)(conn, input.platform);
            const preflight = async (args) => {
                try {
                    return await (0, remote_shell_1.captureRemote)(conn, (0, app_server_rpc_1.appServerCommand)(platform, executable, args));
                }
                catch (error) {
                    throw (0, remote_shell_1.remoteLaunchError)(platform, error instanceof Error ? error.message : String(error));
                }
            };
            const version = (0, local_code_mode_host_1.parseCodexVersion)(await preflight(["--version"]));
            if (!version)
                throw new Error("無法識別遠端 Codex CLI 版本。");
            const help = await preflight(["app-server", "--help"]);
            const flag = (0, app_server_rpc_1.chooseStdioFlag)(help);
            let hostUrl;
            let hostWarning = "";
            const localCwd = await node_fs_1.default.promises.realpath(input.localCwd || node_os_1.default.homedir());
            if (!(await node_fs_1.default.promises.stat(localCwd)).isDirectory())
                throw new Error("Mac 工作目錄必須是資料夾。");
            let runtime;
            const id = (0, node_crypto_1.randomUUID)();
            const manifestRoot = node_path_1.default.join(electron_1.app.getPath("userData"), "runtime-extensions");
            await node_fs_1.default.promises.mkdir(manifestRoot, { recursive: true, mode: 0o700 });
            const extensionRoots = [];
            for (const root of deps.readOnlyExtensionRoots || []) {
                if (!node_path_1.default.isAbsolute(root))
                    continue;
                try {
                    if ((await node_fs_1.default.promises.stat(root)).isDirectory())
                        extensionRoots.push(await node_fs_1.default.promises.realpath(root));
                }
                catch { }
            }
            if (!(0, runtime_policy_1.isVerifiedExecutorVersion)(version)) {
                hostWarning = `Runtime ${version} 尚未完成 Mac 工具路由驗證；目前支援 ${runtime_policy_1.VERIFIED_EXECUTOR_VERSIONS.join("、")}。`;
            }
            else if (help.includes("--code-mode-host")) {
                try {
                    const installation = await (0, local_code_mode_host_1.findHostInstallation)(version, process.resourcesPath, input.localHostExecutable);
                    // Never substitute a JS-only Code Mode host when the matching executor is unavailable.
                    executor = new local_exec_server_1.LocalExecServer(installation, reason => { if (runtime)
                        closeRuntime(runtime, deps, reason); });
                    await executor.start(localCwd);
                    executorUrl = await executor.reverseForward(conn);
                }
                catch (error) {
                    host?.stop();
                    executor?.stop();
                    executor = undefined;
                    executorUrl = undefined;
                    host = undefined;
                    hostWarning = error instanceof Error ? error.message : String(error);
                }
            }
            if (executorUrl) {
                try {
                    if (deps.libraryRoot)
                        await node_fs_1.default.promises.mkdir(deps.libraryRoot, { recursive: true });
                    const extensionServers = deps.extensionServers ? await deps.extensionServers(localCwd) : [];
                    toolHost = new local_tool_host_1.LocalToolHost({ stateDirectory: deps.stateDirectory, extensionServers, allowedRoots: [localCwd], readOnlyRoots: [...(deps.libraryRoot ? [deps.libraryRoot] : []), manifestRoot, ...extensionRoots], agentRole: "codex", ...(typeof deps.localTools === "function" ? deps.localTools() : deps.localTools),
                        fullFilesystemAccess: input.permissionMode === "full", authorize: call => authorizeMacTool(runtime, deps, call) });
                    const local = await toolHost.start();
                    // The registered Mac executor forwards HTTP through the existing SSH channel.
                    mcp = { name: `agentbridge_mac_${(0, node_crypto_1.randomUUID)().replaceAll("-", "")}`, url: local.url, token: local.token, environmentId: executor.environmentId };
                }
                catch (error) {
                    await toolHost?.stop();
                    toolHost = undefined;
                    toolForward?.stop();
                    toolForward = undefined;
                    mcp = undefined;
                    hostWarning = "Mac 擴充工具尚未連線；仍可使用命令與檔案工具。";
                }
            }
            const args = ["app-server", ...(flag === "--stdio" ? ["--stdio"] : ["--listen", "stdio://"]), ...(hostUrl ? ["--code-mode-host", hostUrl] : []), ...(0, runtime_policy_1.isolatedRuntimeArgs)()];
            const channel = await execChannel(conn, (0, app_server_rpc_1.appServerCommand)(platform, executable, args, Boolean(executorUrl)));
            rpc = new app_server_rpc_1.AppServerRpc(channel);
            channel.stderr.on("data", (chunk) => {
                if (chunk.toString().includes("AgentBridge requires no Runtime environments.toml override"))
                    initializationFailure = "Runtime 主機已有 environments.toml，會覆蓋 Mac 專用執行設定。請先在 Runtime 主機停用該環境設定後重新連線；App 沒有讀取或修改它。";
            });
            const activeRpc = rpc;
            rpc.on("request", (request) => {
                if (runtime)
                    routeServerRequest(runtime, deps, request);
                else if (request.method === "currentTime/read")
                    activeRpc.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
                else
                    activeRpc.reject(request.id, "The client is still initializing; credentials remain managed by the Runtime host.");
            });
            // Managed ChatGPT authentication stays in this remote process. No login RPC or auth file is read.
            const initialized = await rpc.request("initialize", { clientInfo: { name: "agentbridge_studio", title: "AgentBridge Studio", version: electron_1.app.getVersion() }, capabilities: { experimentalApi: true, requestAttestation: false } });
            rpc.notify("initialized");
            let executorEnvironment;
            if (executor && executorUrl) {
                try {
                    executorEnvironment = await executor.register(rpc, executorUrl);
                }
                catch (error) {
                    executor.stop();
                    executor = undefined;
                    hostWarning = error instanceof Error ? error.message : String(error);
                }
            }
            const [account, modelResponse] = await Promise.all([rpc.request("account/read", { refreshToken: false }), listModels(rpc)]);
            if (rpc.isClosed)
                throw new Error("Runtime 在初始化期間已中斷連線。");
            if (executorEnvironment && !executor?.isRunning)
                throw new Error("Mac Executor 在初始化期間已結束。");
            if (hostUrl && !host?.isRunning)
                throw new Error("Mac Code Mode Host 在初始化期間已結束。");
            runtime = { id, conn, rpc, host, executor, executorUrl, toolHost, toolForward, mcp, quotaEpoch: 0, quotaRevision: 0, quotaRequest: 0, manifestPath: node_path_1.default.join(manifestRoot, `${id}.json`), extensionCatalog: { items: [], warnings: [] }, permissionMode: ["ask", "full"].includes(input.permissionMode || "") ? input.permissionMode : "project", requests: new Map(), closed: false, localCwd,
                autoCompactPercent: input.autoCompactPercent || 70, threadContextWindows: new Map(), threadContextTokens: new Map(), compactingThreads: new Set(), snapshot: {
                    runtimeId: id, status: "connected", toolExecution: executorEnvironment ? "local-executor" : "unavailable", account: (0, app_server_rpc_1.accountSummary)(account), models: modelResponse,
                    capabilities: { ...localToolCapability(Boolean(hostUrl), Boolean(executorEnvironment), Boolean(mcp)), ...(!executorEnvironment && hostWarning ? { reason: hostWarning } : {}) }, runtimeVersion: version, codeModeHostConnected: Boolean(hostUrl), localHostVersion: host?.installation.version,
                    macTools: toolHost?.status(), permissionMode: input.permissionMode || "project", executorConnected: Boolean(executorEnvironment), executorVersion: executor?.installation.version, executorEnvironment,
                    runtimePlatform: initialized.platformOs || platform, connectionPlatform: platform, hostName: input.profile.name || input.profile.host, hostKey: key,
                    profileId: input.profile.id, relayUrl: input.profile.relayUrl, transport: connected.transport, networkDiagnostics: connected.diagnostics, hostFingerprint: observed, ...(hostWarning ? { diagnostic: hostWarning } : {})
                } };
            const current = runtime;
            runtimes.set(id, current);
            rpc.on("notification", message => routeNotification(current, deps, message));
            rpc.on("closed", error => closeRuntime(current, deps, error.message));
            conn.on('error', (error) => closeRuntime(current, deps, /ERR_AUTH/.test(error.message) ? 'ERR_AUTH：Relay 授權已失效，請重新配對。' : '網路連線發生錯誤，Runtime 已關閉。'));
            conn.on("close", () => closeRuntime(current, deps, "網路已中斷，Runtime 與 Mac 工具通道已關閉；未重送指令。"));
            return current.snapshot;
        }
        catch (error) {
            rpc?.close();
            host?.stop();
            executor?.stop();
            toolForward?.stop();
            await toolHost?.stop();
            conn.end();
            if (input.profile.networkMode !== 'direct' && input.profile.networkMode !== 'relay' && connected.transport === 'tailscale-ssh' && input.profile.relayUrl && /timeout|timed out|中斷|結束|handshake/i.test(String(initializationFailure || error)))
                return connectRuntime(_event, { ...input, profile: { ...input.profile, networkMode: 'relay' } });
            if (initializationFailure)
                throw new Error(initializationFailure);
            throw error;
        }
    };
    electron_1.ipcMain.handle("runtime:connect", async (event, input) => {
        const result = await connectRuntime(event, input);
        if (result.runtimeId)
            pool.register(result, () => connectRuntime(event, { ...input, permissionMode: runtimes.get(result.runtimeId)?.permissionMode || input.permissionMode }));
        if (result.runtimeId)
            event.sender?.once('destroyed', () => { void pool.disconnect(result.runtimeId); });
        return result;
    });
    electron_1.ipcMain.handle('runtime:acquireTask', async (_event, input) => {
        const leased = await pool.acquire(input.runtimeId, input.taskId, input.requestId);
        return getRuntime(leased.runtimeId).snapshot;
    });
    electron_1.ipcMain.handle('runtime:releaseTask', (_event, id, requestId) => { if (!runtimes.get(id)?.run)
        pool.release(id, requestId); });
    electron_1.ipcMain.handle("runtime:disconnect", async (_event, id) => { await pool.disconnect(id); const runtime = runtimes.get(id); if (runtime)
        closeRuntime(runtime, deps); });
    electron_1.ipcMain.handle('runtime:permission', (_event, id, value) => {
        const runtime = getRuntime(id), mode = (0, permission_policy_1.permissionMode)(value);
        if (runtime.run && runtime.permissionMode === 'full' && mode !== 'full')
            throw new Error('請先停止目前工作，再降低操作權限。');
        runtime.permissionMode = mode;
        runtime.toolHost?.setFullFilesystemAccess(mode === 'full');
        runtime.snapshot.permissionMode = runtime.permissionMode;
        runtime.snapshot.macTools = runtime.toolHost?.status();
        if (runtime.permissionMode === 'full')
            for (const [key, pending] of runtime.requests) {
                if (pending.request.method === 'item/tool/requestUserInput')
                    continue;
                if (pending.localResolve) {
                    clearTimeout(pending.timer);
                    pending.localResolve(Boolean(runtime.run && !runtime.run.cancelled && !runtime.run.backgroundTextOnly));
                }
                else if (runtime.executor?.isRunning && runtime.run && !runtime.run.cancelled && !runtime.run.backgroundTextOnly && (pending.request.method !== 'item/commandExecution/requestApproval' || pending.request.params?.environmentId === runtime.executor.environmentId))
                    runtime.rpc.respond(pending.request.id, { decision: 'accept' });
                else
                    runtime.rpc.reject(pending.request.id, '此操作不屬於可用的 Mac 執行環境。');
                runtime.requests.delete(key);
                emitForRun(runtime, deps, { type: 'requestClosed', approvalId: key });
            }
        return runtime.snapshot;
    });
    electron_1.ipcMain.handle('runtime:recoverTools', async (_event, id) => {
        const runtime = getRuntime(id);
        if (runtime.run)
            throw new Error('請先停止目前工作，再重新連接電腦與瀏覽器工具。');
        await runtime.toolHost?.recoverProxyTools();
        runtime.snapshot.macTools = runtime.toolHost?.status();
        return runtime.snapshot;
    });
    electron_1.ipcMain.handle("runtime:status", async (_event, id) => {
        const runtime = getRuntime(id);
        const [account, models] = await Promise.all([runtime.rpc.request("account/read", { refreshToken: false }), listModels(runtime.rpc)]);
        runtime.snapshot.account = (0, app_server_rpc_1.accountSummary)(account);
        runtime.snapshot.models = models;
        runtime.snapshot.macTools = runtime.toolHost?.status();
        return runtime.snapshot;
    });
    electron_1.ipcMain.handle("runtime:extensions", async (_event, id) => refreshMacExtensions(getRuntime(id), deps));
    electron_1.ipcMain.handle("runtime:usage", async (_event, id) => {
        return readRuntimeQuota(getRuntime(id));
    });
    electron_1.ipcMain.handle("runtime:models", async (_event, id) => {
        const runtime = getRuntime(id);
        runtime.snapshot.models = await listModels(runtime.rpc);
        return runtime.snapshot.models;
    });
    electron_1.ipcMain.handle("runtime:send", async (_event, input) => {
        const runtime = getRuntime(input.runtimeId);
        if (!runtime.snapshot.capabilities.localTools)
            throw new Error(runtime.snapshot.capabilities.reason);
        if (!runtime.executor?.isRunning || !runtime.snapshot.executorEnvironment)
            throw new Error("Mac Executor 尚未就緒；禁止回退到 Runtime 主機執行工具。");
        if (runtime.snapshot.account.type !== "chatgpt" || !runtime.snapshot.account.authenticated)
            throw new Error("請由 Runtime 擁有者在自己的電腦登入 ChatGPT 帳號。");
        if (runtime.run)
            throw new Error("這個 Runtime 仍在處理上一則訊息。");
        if (typeof input.prompt !== "string" || (!input.prompt.trim() && !input.attachments?.length))
            throw new Error("請輸入訊息或加入附件。");
        const attachmentIds = input.attachments || [];
        if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== "string") || attachmentIds.length > 20)
            throw new Error("附件識別碼無效。");
        if (attachmentIds.length && !deps.libraryEntries)
            throw new Error("檔案庫尚未就緒。");
        const attachments = attachmentIds.length ? await deps.libraryEntries(attachmentIds) : [];
        const turnInput = await (0, runtime_attachments_1.runtimeInput)(input.prompt.trim() || "請查看並處理附加的檔案。", attachments);
        if (typeof input.customInstructions === "string" && input.customInstructions.trim()) {
            turnInput.push({ type: "text", text: `使用者自訂指令（適用於本次對話）：\n${input.customInstructions.trim()}`, text_elements: [] });
        }
        const localCwd = await node_fs_1.default.promises.realpath(input.localCwd || runtime.localCwd);
        if (!(await node_fs_1.default.promises.stat(localCwd)).isDirectory())
            throw new Error("Mac 工作目錄必須是資料夾。");
        if (localCwd !== runtime.localCwd)
            throw new Error("變更 Mac 工作目錄後請重新連線，以同步檔案工具權限。");
        // A second send may have entered while filesystem validation was pending.
        if (runtime.closed || runtime.run)
            throw new Error("Runtime 已中斷或仍在處理上一則訊息。");
        if (typeof input.autoCompactPercent === "number")
            runtime.autoCompactPercent = input.autoCompactPercent;
        const run = { requestId: input.requestId || (0, node_crypto_1.randomUUID)(), cancelled: false, messages: new Map() };
        runtime.run = run;
        setImmediate(async () => {
            try {
                await refreshMacExtensions(runtime, deps);
                if (runtime.closed || runtime.run !== run)
                    return;
                if (run.cancelled) {
                    emitForRun(runtime, deps, { type: "done", status: "cancelled" });
                    runtime.run = undefined;
                    return;
                }
                if (input.conversationId && input.executorEnvironmentId && runtime.executor && runtime.executorUrl && input.executorEnvironmentId !== runtime.executor.environmentId) {
                    const environment = await runtime.executor.register(runtime.rpc, runtime.executorUrl, input.executorEnvironmentId);
                    runtime.snapshot.executorEnvironment = environment;
                    if (runtime.mcp)
                        runtime.mcp.environmentId = environment.environmentId;
                    emitForRun(runtime, deps, { type: "status", snapshot: runtime.snapshot });
                }
                const configuration = await runtime.rpc.request("config/read", { includeLayers: false });
                if (runtime.closed || runtime.run !== run)
                    return;
                if (run.cancelled) {
                    emitForRun(runtime, deps, { type: "done", status: "cancelled" });
                    runtime.run = undefined;
                    return;
                }
                const config = (0, runtime_policy_1.macThreadConfig)(configuration.config, runtime.mcp, runtime.autoCompactPercent);
                const thread = await runtime.rpc.request(input.conversationId ? "thread/resume" : "thread/start", {
                    ...(input.conversationId ? { threadId: input.conversationId } : {}), developerInstructions: (0, runtime_extensions_1.macRuntimeInstructions)(localCwd, runtime.manifestPath, runtime.toolHost?.status().tools || [], runtime.extensionCatalog), model: input.model || undefined,
                    ...(runtime.executor ? (!input.conversationId ? { environments: [{ environmentId: runtime.executor.environmentId, cwd: localCwd }] } : {}) : { cwd: localCwd }), config, ...(0, permission_policy_1.codexPermissionPolicy)(runtime.permissionMode)
                });
                if (runtime.closed || runtime.run !== run)
                    return;
                run.threadId = thread.thread.id;
                run.usageBaseline = usageByThread.get(runtime.id + ":" + run.threadId);
                run.usageComplete = !!run.usageBaseline || !input.conversationId;
                if (!run.usageBaseline && !input.conversationId)
                    run.usageBaseline = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
                try {
                    await verifyThreadMcp(runtime, run.threadId, config);
                }
                catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    emitForRun(runtime, deps, { type: "error", text: reason });
                    closeRuntime(runtime, deps, reason);
                    return;
                }
                if (runtime.closed || runtime.run !== run)
                    return;
                emitForRun(runtime, deps, { type: "session", conversationId: run.threadId, executorEnvironmentId: runtime.executor?.environmentId });
                if (run.cancelled) {
                    emitForRun(runtime, deps, { type: "done", status: "cancelled" });
                    runtime.run = undefined;
                    return;
                }
                run.turnStarting = true;
                const result = await runtime.rpc.request("turn/start", { threadId: run.threadId, environments: [{ environmentId: runtime.executor.environmentId, cwd: localCwd }], input: turnInput, model: input.model || undefined, effort: input.effort || undefined });
                if (runtime.closed || runtime.run !== run)
                    return;
                run.turnId = result.turn.id;
                run.acceptUsage = true;
                if (run.cancelled)
                    await runtime.rpc.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
            }
            catch (error) {
                if (runtime.closed || runtime.run !== run)
                    return;
                const failure = (0, runtime_errors_1.runtimeFailure)(error);
                // Recovery is offered only when resume failed before any model turn began.
                if (input.conversationId && !run.threadId && failure.category === 'session-missing')
                    emitForRun(runtime, deps, { type: 'sessionUnavailable', conversationId: input.conversationId });
                emitForRun(runtime, deps, { type: "error", ...failure });
                emitForRun(runtime, deps, { type: "done", status: "error", text: failure.text });
                runtime.run = undefined;
            }
        });
        return { requestId: run.requestId };
    });
    electron_1.ipcMain.handle("runtime:cancel", async (_event, id, requestId) => {
        const runtime = getRuntime(id);
        const run = runtime.run;
        if (!run || run.requestId !== requestId)
            return { cancelled: false };
        run.cancelled = true;
        runtime.toolHost?.cancelActive();
        for (const [id, pending] of runtime.requests)
            if (pending.requestId === run.requestId) {
                clearTimeout(pending.timer);
                if (pending.localResolve)
                    pending.localResolve(false);
                else
                    runtime.rpc.reject(pending.request.id, "The client cancelled this turn.", -32000);
                runtime.requests.delete(id);
                emitForRun(runtime, deps, { type: "requestClosed", approvalId: id });
            }
        if (run.threadId && run.turnId)
            await runtime.rpc.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
        else if (!run.turnStarting) {
            emitForRun(runtime, deps, { type: "done", status: "cancelled", conversationId: run.threadId });
            if (runtime.run === run)
                runtime.run = undefined;
            run.completion?.resolve({ requestId: run.requestId, conversationId: run.threadId, text: [...run.messages.values()].join("\n\n"), status: "cancelled" });
        }
        // A turn in flight is normally released by the turn/completed notification.
        // Guard against a runtime that never reports it, or the composer stays locked.
        if ((run.turnId || run.turnStarting) && runtime.run === run) {
            setTimeout(() => {
                if (runtime.run !== run || !run.cancelled)
                    return;
                emitForRun(runtime, deps, { type: "done", status: "cancelled", conversationId: run.threadId });
                runtime.run = undefined;
                run.completion?.resolve({ requestId: run.requestId, conversationId: run.threadId, text: [...run.messages.values()].join("\n\n"), status: "cancelled" });
            }, 5000).unref();
        }
        return { cancelled: true };
    });
    electron_1.ipcMain.handle("runtime:respond", (_event, input) => {
        const runtime = getRuntime(input.runtimeId);
        const pending = runtime.requests.get(input.approvalId);
        if (!pending)
            throw new Error("這個要求已結束或不屬於目前連線。");
        if (!["accept", "decline"].includes(input.decision))
            throw new Error("無效的回應。");
        const request = pending.request;
        if (pending.localResolve) {
            clearTimeout(pending.timer);
            pending.localResolve(input.decision === "accept" && Boolean(runtime.run && !runtime.run.cancelled));
            runtime.requests.delete(input.approvalId);
            emitForRun(runtime, deps, { type: "requestClosed", approvalId: input.approvalId });
            return { resolved: true };
        }
        if (request.method === "item/tool/requestUserInput") {
            const answers = {};
            for (const question of request.params.questions || []) {
                const values = input.decision === "accept" ? input.answers?.[question.id] : [];
                if (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
                    throw new Error("請回答每一個問題。");
                answers[question.id] = { answers: values };
            }
            runtime.rpc.respond(request.id, { answers });
        }
        else {
            if (!runtime.executor?.isRunning || !runtime.run || runtime.run.cancelled)
                throw new Error("Mac 執行器或對話已停止。");
            if (request.method === "item/commandExecution/requestApproval" && request.params?.environmentId !== runtime.executor.environmentId)
                throw new Error("此要求不屬於 Mac 執行環境。");
            runtime.rpc.respond(request.id, { decision: input.decision });
        }
        runtime.requests.delete(input.approvalId);
        emitForRun(runtime, deps, { type: "requestClosed", approvalId: input.approvalId });
        return { resolved: true };
    });
}
