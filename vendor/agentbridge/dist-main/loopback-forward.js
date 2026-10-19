"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoopbackForward = void 0;
const node_net_1 = __importDefault(require("node:net"));
const routers = new WeakMap();
/** One dispatcher per SSH connection prevents unrelated forward listeners rejecting each other. */
class LoopbackForward {
    conn;
    localPort;
    remotePort;
    sockets = new Set();
    constructor(conn, localPort) {
        this.conn = conn;
        this.localPort = localPort;
        if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)
            throw new Error("無效的本機通道連接埠。");
    }
    async start() {
        if (this.remotePort)
            throw new Error("SSH 通道已建立。");
        let router = routers.get(this.conn);
        if (!router) {
            const routes = new Map();
            const handler = (info, accept, reject) => {
                const route = info.destIP === "127.0.0.1" ? routes.get(info.destPort) : undefined;
                if (route)
                    route.accept(accept);
                else
                    reject();
            };
            router = { routes, handler };
            routers.set(this.conn, router);
            this.conn.on("tcp connection", handler);
        }
        try {
            const port = await new Promise((resolve, reject) => this.conn.forwardIn("127.0.0.1", 0, (error, port) => error ? reject(error) : port > 0 && port <= 65535 ? resolve(port) : reject(new Error("SSH 沒有分配有效的通道連接埠。"))));
            this.remotePort = port;
            router.routes.set(port, this);
            return port;
        }
        catch (error) {
            if (!router.routes.size) {
                this.conn.removeListener("tcp connection", router.handler);
                routers.delete(this.conn);
            }
            throw error;
        }
    }
    accept(accept) {
        const channel = accept();
        const socket = node_net_1.default.connect({ host: "127.0.0.1", port: this.localPort });
        this.sockets.add(socket);
        socket.on("connect", () => socket.pipe(channel).pipe(socket));
        socket.on("error", () => channel.destroy());
        channel.on("error", () => socket.destroy());
        channel.on("close", () => socket.destroy());
        socket.on("close", () => { this.sockets.delete(socket); channel.destroy(); });
    }
    stop() {
        const router = routers.get(this.conn);
        if (this.remotePort) {
            router?.routes.delete(this.remotePort);
            try {
                this.conn.unforwardIn("127.0.0.1", this.remotePort, () => { });
            }
            catch { }
            this.remotePort = undefined;
        }
        if (router && !router.routes.size) {
            this.conn.removeListener("tcp connection", router.handler);
            routers.delete(this.conn);
        }
        for (const socket of this.sockets)
            socket.destroy();
        this.sockets.clear();
    }
}
exports.LoopbackForward = LoopbackForward;
