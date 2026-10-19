"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalCodeModeHost = void 0;
exports.captureExecutable = captureExecutable;
exports.parseCodexVersion = parseCodexVersion;
exports.findHostInstallation = findHostInstallation;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const node_net_1 = __importDefault(require("node:net"));
const node_child_process_1 = require("node:child_process");
function captureExecutable(executable, args, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Codex 執行檔檢查逾時。")); }, timeoutMs);
        child.stdout.on("data", chunk => { out = (out + chunk.toString()).slice(-32000); });
        child.stderr.on("data", chunk => { err = (err + chunk.toString()).slice(-2000); });
        child.on("error", error => { clearTimeout(timer); reject(error); });
        child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || "Codex 執行檔檢查失敗。")); });
    });
}
function parseCodexVersion(value) { return /codex-cli\s+([^\s]+)/.exec(value)?.[1] || ""; }
async function findHostInstallation(remoteVersion, resourcesPath, override) {
    const candidates = [
        override,
        resourcesPath ? node_path_1.default.join(resourcesPath, "codex", "bin", "codex-code-mode-host") : undefined,
        node_path_1.default.resolve(__dirname, "..", "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex-code-mode-host"),
        resourcesPath ? node_path_1.default.join(resourcesPath, "code-mode", "codex-code-mode-host") : undefined,
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex-code-mode-host",
        node_path_1.default.join(node_os_1.default.homedir(), ".hermes/node/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex-code-mode-host"),
        ...((process.env.PATH || "").split(node_path_1.default.delimiter).map(dir => node_path_1.default.join(dir, "codex-code-mode-host")))
    ].filter((item) => Boolean(item));
    const found = [];
    for (const executable of [...new Set(candidates)]) {
        const codexExecutable = node_path_1.default.join(node_path_1.default.dirname(executable), "codex");
        if (!node_fs_1.default.existsSync(executable) || !node_fs_1.default.existsSync(codexExecutable))
            continue;
        try {
            const version = parseCodexVersion(await captureExecutable(codexExecutable, ["--version"]));
            found.push(version);
            if (version !== remoteVersion)
                continue;
            const help = await captureExecutable(executable, ["--help"]);
            if (!help.includes("grpc://IP:PORT"))
                continue;
            return { executable, codexExecutable, version };
        }
        catch { /* Try another complete installation; never mix host and CLI bundles. */ }
    }
    throw new Error(`找不到與 Runtime ${remoteVersion} 相同版本的 Mac 工具執行器（本機已找到：${found.filter(Boolean).join("、") || "無"}）。請更新 AgentBridge App，或安裝相同版本的完整 Codex CLI 套件。`);
}
class LocalCodeModeHost {
    installation;
    onClosed;
    child;
    sockets = new Set();
    remotePort;
    localPort;
    connection;
    forwardingHandler;
    constructor(installation, onClosed) {
        this.installation = installation;
        this.onClosed = onClosed;
    }
    get isRunning() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }
    async start(cwd) {
        const realCwd = await node_fs_1.default.promises.realpath(cwd);
        if (!(await node_fs_1.default.promises.stat(realCwd)).isDirectory())
            throw new Error("Mac 工作目錄不存在。");
        return new Promise((resolve, reject) => {
            const child = (0, node_child_process_1.spawn)(this.installation.executable, ["--listen", "grpc://127.0.0.1:0"], { cwd: realCwd, stdio: ["pipe", "pipe", "pipe"] });
            this.child = child;
            let output = "", stderr = "", resolved = false;
            const timer = setTimeout(() => { reject(new Error("Mac Code Mode Host 啟動逾時。")); this.stop(); }, 12000);
            child.stdout.on("data", (chunk) => {
                output = (output + chunk.toString("utf8")).slice(-32000);
                const match = /^http:\/\/127\.0\.0\.1:(\d+)\s*$/m.exec(output);
                if (!resolved && match && Number(match[1]) > 0 && Number(match[1]) <= 65535) {
                    resolved = true;
                    clearTimeout(timer);
                    this.localPort = Number(match[1]);
                    resolve(this.localPort);
                }
            });
            child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
            child.on("error", error => { clearTimeout(timer); reject(error); });
            child.on("close", () => {
                clearTimeout(timer);
                if (!resolved)
                    reject(new Error(stderr.trim() || "Mac Code Mode Host 無法啟動。"));
                if (this.child === child) {
                    this.child = undefined;
                    this.onClosed("Mac Code Mode Host 已結束，工具通道已中斷。");
                }
            });
        });
    }
    async reverseForward(conn) {
        if (!this.localPort)
            throw new Error("Mac Code Mode Host 尚未啟動。");
        this.connection = conn;
        this.forwardingHandler = (info, accept, reject) => {
            if (info.destPort !== this.remotePort || !["127.0.0.1", "localhost"].includes(info.destIP)) {
                reject();
                return;
            }
            const channel = accept();
            const socket = node_net_1.default.connect({ host: "127.0.0.1", port: this.localPort });
            this.sockets.add(socket);
            socket.on("connect", () => socket.pipe(channel).pipe(socket));
            socket.on("error", () => channel.destroy());
            channel.on("error", () => socket.destroy());
            channel.on("close", () => socket.destroy());
            socket.on("close", () => { this.sockets.delete(socket); channel.destroy(); });
        };
        conn.on("tcp connection", this.forwardingHandler);
        this.remotePort = await new Promise((resolve, reject) => conn.forwardIn("127.0.0.1", 0, (error, port) => error ? reject(error) : port > 0 && port <= 65535 ? resolve(port) : reject(new Error("SSH 沒有分配有效的反向通道連接埠。"))));
        return `http://127.0.0.1:${this.remotePort}`;
    }
    stop() {
        if (this.forwardingHandler)
            this.connection?.removeListener("tcp connection", this.forwardingHandler);
        if (this.remotePort) {
            try {
                this.connection?.unforwardIn("127.0.0.1", this.remotePort, () => { });
            }
            catch { }
        }
        this.forwardingHandler = undefined;
        this.connection = undefined;
        this.remotePort = undefined;
        this.localPort = undefined;
        for (const socket of this.sockets)
            socket.destroy();
        this.sockets.clear();
        const child = this.child;
        this.child = undefined;
        if (child) {
            child.kill("SIGTERM");
            setTimeout(() => { if (child.exitCode === null)
                child.kill("SIGKILL"); }, 1000).unref();
        }
    }
}
exports.LocalCodeModeHost = LocalCodeModeHost;
