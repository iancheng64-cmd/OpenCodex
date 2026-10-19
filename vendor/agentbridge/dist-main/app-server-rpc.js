"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppServerRpc = void 0;
exports.powershellQuote = powershellQuote;
exports.appServerCommand = appServerCommand;
exports.chooseStdioFlag = chooseStdioFlag;
exports.accountSummary = accountSummary;
exports.accountUpdateSummary = accountUpdateSummary;
exports.modelSummary = modelSummary;
const node_events_1 = require("node:events");
/** Newline-delimited App Server JSON-RPC; no HTTP listener or credential transport. */
class AppServerRpc extends node_events_1.EventEmitter {
    transport;
    nextId = 0;
    decoder = new TextDecoder();
    buffer = "";
    closed = false;
    pending = new Map();
    get isClosed() { return this.closed; }
    constructor(transport) {
        super();
        this.transport = transport;
        transport.on("data", (chunk) => {
            try {
                this.consume(chunk);
            }
            catch (error) {
                this.shutdown(error instanceof Error ? error : new Error(String(error)));
            }
        });
        transport.on("error", (error) => this.shutdown(error));
        transport.on("close", () => this.shutdown(new Error("App Server 連線已關閉。")));
    }
    request(method, params = {}, timeoutMs = 30_000) {
        if (this.closed)
            return Promise.reject(new Error("App Server 未連線。"));
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`App Server ${method} 逾時。`)); }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.send({ id, method, params });
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }
    notify(method, params) { this.send({ method, ...(params === undefined ? {} : { params }) }); }
    respond(id, result) { this.send({ id, result }); }
    reject(id, message, code = -32601) { this.send({ id, error: { code, message } }); }
    send(value) {
        if (this.closed)
            throw new Error("App Server 未連線。");
        this.transport.write(JSON.stringify(value) + "\n");
    }
    consume(chunk) {
        this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
        if (this.buffer.length > 16 * 1024 * 1024)
            throw new Error("App Server 訊息超過解析上限。");
        let offset;
        while ((offset = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, offset).trim();
            this.buffer = this.buffer.slice(offset + 1);
            if (!line)
                continue;
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                throw new Error("App Server 傳回非 JSON 資料。請檢查啟動腳本沒有額外輸出。");
            }
            if (message === null || typeof message !== "object" || Array.isArray(message))
                throw new Error("App Server 訊息格式無效。");
            if (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number")
                throw new Error("App Server request id 格式無效。");
            if (typeof message.method === "string")
                this.emit(message.id === undefined ? "notification" : "request", message);
            else if (message.id !== undefined) {
                const pending = this.pending.get(message.id);
                if (!pending)
                    continue;
                clearTimeout(pending.timer);
                this.pending.delete(message.id);
                if (message.error)
                    pending.reject(Object.assign(new Error(typeof message.error.message === "string" ? message.error.message : "App Server RPC 失敗。"), { code: message.error.code, codexErrorInfo: message.error.data?.codexErrorInfo || message.error.codexErrorInfo }));
                else if (Object.prototype.hasOwnProperty.call(message, "result"))
                    pending.resolve(message.result);
                else
                    pending.reject(new Error("App Server 回覆缺少 result 或 error。"));
            }
        }
    }
    close() { this.shutdown(new Error("已中斷 App Server 連線。")); }
    shutdown(error) {
        if (this.closed)
            return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.emit("closed", error);
        this.transport.close?.();
    }
}
exports.AppServerRpc = AppServerRpc;
function powershellQuote(value) {
    if (/[\0\r\n]/.test(value))
        throw new Error("執行檔路徑包含無效字元。");
    return "'" + value.replace(/'/g, "''") + "'";
}
function appServerCommand(platform, executable, args, isolateExecutor = false) {
    if (!executable || executable.length > 4096 || /[\0\r\n]/.test(executable))
        throw new Error("請提供有效的 Codex 執行檔路徑。");
    if (platform === "windows") {
        const isolated = isolateExecutor ? "$bridgeHome=if($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path $env:USERPROFILE '.codex'}; if(Test-Path -LiteralPath (Join-Path $bridgeHome 'environments.toml')){throw 'AgentBridge requires no Runtime environments.toml override; rename it before connecting.'}; $env:CODEX_EXEC_SERVER_URL='none'; " : "";
        const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ${isolated}& ${[executable, ...args].map(powershellQuote).join(" ")}; exit $LASTEXITCODE`;
        return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
    }
    const quote = (value) => { if (value.includes("\0"))
        throw new Error("參數包含無效字元。"); return "'" + value.replace(/'/g, "'\\''") + "'"; };
    const isolated = isolateExecutor ? 'bridge_home="${CODEX_HOME:-$HOME/.codex}"; if [ -e "$bridge_home/environments.toml" ]; then echo "AgentBridge requires no Runtime environments.toml override; rename it before connecting." >&2; exit 78; fi; export CODEX_EXEC_SERVER_URL=none; ' : "";
    const nativePath = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
    // Desktop installs need not register a `codex` command in a non-interactive
    // SSH shell. Only discover alternatives for the default name; an explicit
    // path must never silently launch a different installation.
    const discover = executable === 'codex' ? 'bridge_codex=$(type -P codex); if [ ! -f "$bridge_codex" ] || [ ! -x "$bridge_codex" ]; then bridge_codex=""; for bridge_candidate in "$HOME/.local/share/agentbridge-codex-0.160.0/node_modules/.bin/codex" /Applications/Codex.app/Contents/Resources/codex "$HOME/Applications/Codex.app/Contents/Resources/codex" /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex "$HOME/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"; do if [ -f "$bridge_candidate" ] && [ -x "$bridge_candidate" ]; then bridge_codex="$bridge_candidate"; break; fi; done; fi; if [ -z "$bridge_codex" ]; then echo "找不到遠端 Codex 執行檔：已檢查 SSH PATH、獨立相容版本與 Codex／ChatGPT 桌面版。請填入朋友設備上的 Codex 完整執行檔路徑，或在該 SSH 帳號安裝 Codex CLI。" >&2; exit 127; fi; ' : '';
    const command = executable === 'codex' ? '"$bridge_codex"' : quote(executable);
    return `bash -lc ${quote(`${nativePath}${isolated}${discover}exec ${command} ${args.map(quote).join(" ")}`)}`;
}
function chooseStdioFlag(help) {
    if (/--stdio\b/.test(help))
        return "--stdio";
    if (/--listen\b/.test(help) && /stdio:\/\//.test(help))
        return "--listen";
    throw new Error("這個 Codex 版本沒有可驗證的 App Server stdio 支援，請在 Runtime 主機更新 Codex。");
}
function accountSummary(response) {
    const account = response?.account;
    return { authenticated: Boolean(account), type: typeof account?.type === "string" ? account.type : "none", ...(typeof account?.planType === "string" ? { planType: account.planType } : {}) };
}
function accountUpdateSummary(params) {
    // An account/updated notification uses authMode, including null on logout.
    // Never retain authenticated=true or a previous plan after account changes.
    return accountSummary({ account: typeof params?.authMode === "string" ? { type: params.authMode, planType: params.planType } : null });
}
function modelSummary(response) {
    return (Array.isArray(response?.data) ? response.data : []).filter((item) => item && typeof item.id === "string" && !item.hidden).map((item) => ({
        id: String(item.id), model: String(item.model || item.id), displayName: String(item.displayName || item.id),
        supportedReasoningEfforts: Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.filter((e) => e && typeof e.reasoningEffort === "string").map((e) => ({ reasoningEffort: e.reasoningEffort, description: typeof e.description === "string" ? e.description : "" })) : [],
        defaultReasoningEffort: item.defaultReasoningEffort || "medium", isDefault: item.isDefault === true
    }));
}
