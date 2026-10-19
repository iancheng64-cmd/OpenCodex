"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BindRelay = exports.OAUTH_DEFAULT_PORT = exports.BROWSER_USE_PORT = exports.COMPUTER_USE_PORT = void 0;
exports.readExposure = readExposure;
exports.writeExposure = writeExposure;
exports.resolveExposure = resolveExposure;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_net_1 = __importDefault(require("node:net"));
const node_os_1 = __importDefault(require("node:os"));
exports.COMPUTER_USE_PORT = 8932;
exports.BROWSER_USE_PORT = 8931;
exports.OAUTH_DEFAULT_PORT = 1455;
function readExposure(file) {
    let mode = "localhost";
    try {
        const parsed = JSON.parse(node_fs_1.default.readFileSync(file, "utf8"));
        if (parsed && ["tailscale", "lan", "all", "localhost"].includes(parsed.mode)) {
            mode = parsed.mode;
        }
    }
    catch {
        /* first run — fall through to the default */
    }
    return resolveExposure(mode);
}
function writeExposure(file, mode) {
    const state = resolveExposure(mode);
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
        node_fs_1.default.writeFileSync(file, JSON.stringify({ mode }, null, 2), "utf8");
    }
    catch {
        /* non-fatal: the mode still applies for this session */
    }
    return state;
}
function interfaceAddresses() {
    const found = [];
    for (const addrs of Object.values(node_os_1.default.networkInterfaces())) {
        for (const info of addrs || []) {
            if (info.family !== "IPv4" || info.internal)
                continue;
            const o = info.address.split(".").map(Number);
            const isTailscale = o[0] === 100 && o[1] >= 64 && o[1] <= 127;
            const isLan = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
            found.push({ address: info.address, kind: isTailscale ? "tailscale" : isLan ? "lan" : "other" });
        }
    }
    return found;
}
function resolveExposure(mode) {
    const addrs = interfaceAddresses();
    const tailscale = addrs.find((a) => a.kind === "tailscale");
    const lan = addrs.find((a) => a.kind === "lan");
    // Advertise host is what the remote agent is told to dial. Tailscale wins
    // whenever it exists: the address is stable and reachable off-LAN.
    const advertiseHost = tailscale?.address || lan?.address || "127.0.0.1";
    switch (mode) {
        case "localhost":
            return { mode, bindHost: "127.0.0.1", advertiseHost };
        case "all":
            return { mode, bindHost: "0.0.0.0", advertiseHost };
        case "lan":
            return lan
                ? { mode, bindHost: lan.address, advertiseHost }
                : { mode, bindHost: "127.0.0.1", advertiseHost, note: "找不到 LAN IPv4 位址，已退回 localhost。" };
        case "tailscale":
        default:
            return tailscale
                ? { mode: "tailscale", bindHost: tailscale.address, advertiseHost }
                : lan
                    ? { mode, bindHost: lan.address, advertiseHost, note: "Tailscale 未安裝，已改用 LAN 位址。" }
                    : { mode, bindHost: "127.0.0.1", advertiseHost, note: "找不到 Tailscale 或 LAN 位址，服務僅限本機。" };
    }
}
/**
 * Supergateway's Streamable HTTP server has no bind-address flag — it always
 * takes every interface. Rather than give that up, keep it on loopback and
 * front it with a byte-forwarder bound to exactly the address the user chose.
 * No HTTP parsing here, so session semantics pass through untouched.
 */
class BindRelay {
    bindHost;
    bindPort;
    upstreamPort;
    forceRelay;
    server;
    sockets = new Set();
    constructor(bindHost, bindPort, upstreamPort, forceRelay = false) {
        this.bindHost = bindHost;
        this.bindPort = bindPort;
        this.upstreamPort = upstreamPort;
        this.forceRelay = forceRelay;
    }
    start() {
        if (!this.forceRelay && (this.bindHost === "0.0.0.0" || this.bindHost === "127.0.0.1"))
            return Promise.resolve({ ok: true });
        return new Promise((resolve) => {
            const server = node_net_1.default.createServer((client) => {
                const upstream = node_net_1.default.connect(this.upstreamPort, "127.0.0.1");
                this.sockets.add(client);
                this.sockets.add(upstream);
                const drop = () => {
                    this.sockets.delete(client);
                    this.sockets.delete(upstream);
                    client.destroy();
                    upstream.destroy();
                };
                client.on("error", drop);
                upstream.on("error", drop);
                client.on("close", drop);
                upstream.on("close", drop);
                client.pipe(upstream).pipe(client);
            });
            server.on("error", (error) => resolve({ ok: false, reason: error.message }));
            server.listen(this.bindPort, this.bindHost, () => resolve({ ok: true }));
            this.server = server;
        });
    }
    /** The port actually bound — resolves the OS-assigned port when asked for 0. */
    get port() {
        const address = this.server?.address();
        return address && typeof address === "object" ? address.port : undefined;
    }
    stop() {
        for (const socket of this.sockets)
            socket.destroy();
        this.sockets.clear();
        this.server?.close();
        this.server = undefined;
    }
}
exports.BindRelay = BindRelay;
