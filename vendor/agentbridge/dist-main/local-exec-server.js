"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalExecServer = void 0;
exports.parseExecutorListener = parseExecutorListener;
const node_fs_1 = __importDefault(require("node:fs"));
const loopback_forward_1 = require("./loopback-forward");
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_url_1 = require("node:url");
function parseExecutorListener(output) {
    const match = /^ws:\/\/127\.0\.0\.1:(\d+)\s*$/m.exec(output);
    const port = match ? Number(match[1]) : 0;
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}
/** Direct executor transport is deliberately distinct from complete model-tool routing.
 * A successful environment/info is not permission to enable ordinary model turns.
 */
class LocalExecServer {
    installation;
    onClosed;
    currentEnvironmentId = `agentbridge-mac-${(0, node_crypto_1.randomUUID)()}`;
    get environmentId() { return this.currentEnvironmentId; }
    registrations = new Map();
    token = (0, node_crypto_1.randomBytes)(32).toString("base64url");
    child;
    localPort;
    cwd;
    forward;
    constructor(installation, onClosed) {
        this.installation = installation;
        this.onClosed = onClosed;
    }
    get isRunning() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }
    get localUrl() { if (!this.localPort)
        throw new Error("Mac Executor 尚未啟動。"); return `ws://127.0.0.1:${this.localPort}`; }
    async start(cwd, environment = process.env) {
        if (this.child)
            throw new Error("Mac Executor 已啟動。");
        this.cwd = await node_fs_1.default.promises.realpath(cwd);
        if (!(await node_fs_1.default.promises.stat(this.cwd)).isDirectory())
            throw new Error("Mac 工作目錄不存在。");
        // Only a hash appears in the process argv; the bearer token stays in memory.
        const digest = (0, node_crypto_1.createHash)("sha256").update(this.token).digest("hex");
        return new Promise((resolve, reject) => {
            const child = (0, node_child_process_1.spawn)(this.installation.codexExecutable, ["exec-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", "--ws-token-sha256", digest], { cwd: this.cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
            this.child = child;
            let output = "", stderr = "", ready = false;
            const timer = setTimeout(() => { reject(new Error("Mac Executor 啟動逾時。")); this.stop(); }, 12000);
            child.stdout.on("data", chunk => {
                output = (output + chunk.toString()).slice(-32000);
                const port = parseExecutorListener(output);
                if (!ready && port) {
                    ready = true;
                    clearTimeout(timer);
                    this.localPort = port;
                    resolve(this.localUrl);
                }
            });
            child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
            child.on("error", error => { clearTimeout(timer); reject(error); });
            child.on("close", () => {
                clearTimeout(timer);
                if (!ready)
                    reject(new Error(stderr.trim() || "Mac Executor 無法啟動。"));
                if (this.child === child) {
                    this.child = undefined;
                    this.onClosed("Mac Executor 已結束，工具通道已中斷。");
                }
            });
        });
    }
    async reverseForward(conn) {
        if (!this.localPort)
            throw new Error("Mac Executor 尚未啟動。");
        if (this.forward)
            throw new Error("Mac Executor 通道已建立。");
        this.forward = new loopback_forward_1.LoopbackForward(conn, this.localPort);
        return `ws://127.0.0.1:${await this.forward.start()}`;
    }
    async register(rpc, execServerUrl, environmentId = this.environmentId) {
        if (!/^agentbridge-mac-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(environmentId))
            throw new Error("Mac 執行環境識別碼無效。");
        if (!this.isRunning || !this.cwd)
            throw new Error("Mac Executor 尚未啟動。");
        const url = new URL(execServerUrl);
        if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
            throw new Error("Executor 僅允許 SSH loopback 通道。");
        const registered = this.registrations.get(environmentId);
        if (registered?.rpc !== rpc || registered.url !== execServerUrl)
            await rpc.request("environment/add", { environmentId, execServerUrl, authBearerToken: this.token, connectTimeoutMs: 8000 }, 12000);
        const info = await rpc.request("environment/info", { environmentId }, 12000);
        if (!this.isRunning)
            throw new Error("Mac Executor 在驗證期間已結束。");
        // The canonical executor cwd must be the specific Mac directory used at startup.
        if (info.cwd !== (0, node_url_1.pathToFileURL)(this.cwd).href || typeof info.shell?.name !== "string" || typeof info.shell?.path !== "string" || !info.shell.path.startsWith("/"))
            throw new Error("Executor 回報的工作目錄或 shell 不符合此 Mac，拒絕使用。");
        this.registrations.set(environmentId, { rpc, url: execServerUrl });
        this.currentEnvironmentId = environmentId;
        return { environmentId, cwd: info.cwd, shell: { name: info.shell.name, path: info.shell.path } };
    }
    stop() {
        this.registrations.clear();
        this.forward?.stop();
        this.forward = undefined;
        this.localPort = undefined;
        const child = this.child;
        this.child = undefined;
        if (child) {
            child.kill("SIGTERM");
            setTimeout(() => { if (child.exitCode === null)
                child.kill("SIGKILL"); }, 1000).unref();
        }
    }
}
exports.LocalExecServer = LocalExecServer;
