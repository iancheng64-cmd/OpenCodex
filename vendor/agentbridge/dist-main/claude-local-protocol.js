"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaudeLocalProtocol = void 0;
const node_events_1 = require("node:events");
const node_crypto_1 = require("node:crypto");
const node_string_decoder_1 = require("node:string_decoder");
/** Native Claude Code stream-json control channel. Credentials never traverse this class. */
class ClaudeLocalProtocol extends node_events_1.EventEmitter {
    transport;
    buffer = "";
    decoder = new node_string_decoder_1.StringDecoder("utf8");
    pending = new Map();
    closed = false;
    constructor(transport) {
        super();
        this.transport = transport;
        transport.on("data", (chunk) => this.push(chunk));
        transport.on("close", () => this.close(new Error("Claude Code 本機程序已結束。")));
        transport.on("error", () => this.close(new Error("Claude Code 本機通訊失敗。")));
    }
    request(subtype, params = {}, timeoutMs = 20_000) {
        if (this.closed)
            return Promise.reject(new Error("Claude Code 通道已關閉。"));
        const id = (0, node_crypto_1.randomUUID)();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Claude Code ${subtype} 回應逾時。`)); }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.write({ type: "control_request", request_id: id, request: { subtype, ...params } });
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }
    respond(id, response) {
        this.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
    }
    reject(id, error = "Client does not support this request") {
        this.write({ type: "control_response", response: { subtype: "error", request_id: id, error } });
    }
    user(content, sessionId) {
        this.write({ type: "user", uuid: (0, node_crypto_1.randomUUID)(), session_id: sessionId || "", parent_tool_use_id: null, message: { role: "user", content } });
    }
    write(message) { if (this.closed)
        throw new Error("Claude Code 通道已關閉。"); this.transport.write(JSON.stringify(message) + "\n"); }
    push(chunk) {
        if (this.closed)
            return;
        this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
        if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) {
            this.close(new Error("Claude Code 單筆回應超過 32 MiB。"));
            return;
        }
        for (;;) {
            const newline = this.buffer.indexOf("\n");
            if (newline < 0)
                break;
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (!line.trim())
                continue;
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                this.close(new Error("Claude Code 傳回無效的 JSON 協定。"));
                return;
            }
            if (message.type === "control_response") {
                const reply = message.response;
                const pending = this.pending.get(reply?.request_id);
                if (!pending)
                    continue;
                clearTimeout(pending.timer);
                this.pending.delete(reply.request_id);
                reply.subtype === "success" ? pending.resolve(reply.response || {}) : pending.reject(new Error(typeof reply.error === "string" ? reply.error.slice(0, 1000) : "Claude Code 控制要求失敗。"));
            }
            else if (message.type === "control_request")
                this.emit("request", message);
            else
                this.emit("message", message);
        }
    }
    close(reason = new Error("Claude Code 通道已關閉。")) {
        if (this.closed)
            return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(reason);
        }
        this.pending.clear();
        this.emit("closed", reason);
    }
}
exports.ClaudeLocalProtocol = ClaudeLocalProtocol;
