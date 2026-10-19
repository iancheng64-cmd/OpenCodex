"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RelayConnection = void 0;
exports.relayUrl = relayUrl;
exports.relayRequest = relayRequest;
const node_events_1 = require("node:events");
const node_stream_1 = require("node:stream");
const node_https_1 = __importDefault(require("node:https"));
const node_crypto_1 = require("node:crypto");
const ws_1 = __importDefault(require("ws"));
function relayUrl(value) {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' || u.port && u.port !== '443')
        throw new Error('Relay 必須是標準 HTTPS 網址（443），不可包含帳密、查詢參數或路徑。');
    return u.origin;
}
function relayRequest(base, route, body, token, ca) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body), url = new URL(route, base);
        const req = node_https_1.default.request(url, { method: data ? 'POST' : 'GET', ca, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, res => {
            let text = '', bytes = 0;
            res.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) {
                res.destroy();
                reject(new Error('ERR_RELAY_PROTOCOL'));
                return;
            } text += chunk; });
            res.on('error', () => reject(new Error('ERR_RELAY_HTTPS')));
            res.on('end', () => { if (res.statusCode === 401 || res.statusCode === 403) {
                reject(new Error('ERR_AUTH：Relay 配對或設備授權無效，請重新配對。'));
                return;
            } if (res.statusCode !== 200) {
                reject(new Error('ERR_RELAY_HTTPS：Relay 未回傳成功回應。'));
                return;
            } try {
                resolve(JSON.parse(text));
            }
            catch {
                reject(new Error('ERR_RELAY_PROTOCOL'));
            } });
        });
        req.setTimeout(10000, () => req.destroy(new Error('ERR_RELAY_TIMEOUT')));
        req.on('error', (e) => reject(new Error(e.code === 'ENOTFOUND' ? 'ERR_RELAY_DNS：無法解析 Relay 網址。' : /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(e.code || '') ? 'ERR_RELAY_TLS：HTTPS 憑證驗證失敗。' : 'ERR_RELAY_HTTPS：無法聯絡 Relay。')));
        req.end(data);
    });
}
class RelayChannel extends node_stream_1.Duplex {
    id;
    conn;
    stderr = new node_stream_1.PassThrough();
    constructor(id, conn) {
        super({ autoDestroy: false });
        this.id = id;
        this.conn = conn;
        this.on('error', () => { });
        this.stderr.on('error', () => { });
    }
    _read() { }
    _write(chunk, _encoding, done) { try {
        for (let i = 0; i < chunk.length; i += 65536)
            this.conn.send({ op: 'data', id: this.id, data: chunk.subarray(i, i + 65536).toString('base64') });
        done();
    }
    catch {
        done(new Error('ERR_RELAY_CLOSED'));
    } }
    _final(done) { try {
        this.conn.send({ op: 'end', id: this.id });
    }
    catch { } done(); }
    _destroy(_error, done) { try {
        this.conn.send({ op: 'close', id: this.id });
    }
    catch { } this.stderr.destroy(); done(); }
    close() { this.destroy(); }
    signal(_name) { this.destroy(); }
}
/** A command/stream/loopback adapter for the existing Runtime clients. No SSH
 * protocol or SSH authentication runs on this path, despite the legacy types. */
class RelayConnection extends node_events_1.EventEmitter {
    credential;
    testCa;
    transport = 'https-relay';
    platform = '';
    latencyMs = 0;
    ws;
    closed = false;
    heartbeat;
    renew;
    channels = new Map();
    pending = new Map();
    constructor(credential, testCa) {
        super();
        this.credential = credential;
        this.testCa = testCa;
        this.on('error', () => { });
    }
    asRuntimeClient() { return this; }
    async session() { return relayRequest(this.credential.baseUrl, '/session', { runtimeId: this.credential.runtimeId, deviceId: this.credential.deviceId, credential: this.credential.credential }, undefined, this.testCa); }
    async connect() {
        const started = Date.now(), session = await this.session();
        if (session.runtimeId !== this.credential.runtimeId)
            throw new Error('ERR_RELAY_IDENTITY：Runtime 身分不符合已配對設備。');
        await new Promise((resolve, reject) => {
            let ready = false;
            const ws = new ws_1.default(this.credential.baseUrl.replace(/^https:/, 'wss:') + '/runtime', { headers: { Authorization: 'Bearer ' + session.token }, ca: this.testCa, handshakeTimeout: 10000, maxPayload: 256 * 1024, perMessageDeflate: false });
            this.ws = ws;
            const timeout = setTimeout(() => { if (!ready) {
                this.end();
                reject(new Error('ERR_RELAY_WS_HANDSHAKE：Relay 握手逾時。'));
            } }, 10000);
            ws.on('message', data => { try {
                const message = JSON.parse(data.toString());
                if (!ready) {
                    if (message.op !== 'hello' || message.protocol !== 1 || message.runtimeId !== this.credential.runtimeId)
                        throw new Error('identity');
                    ready = true;
                    clearTimeout(timeout);
                    this.platform = message.platform;
                    this.latencyMs = Date.now() - started;
                    resolve();
                    return;
                }
                this.receive(message);
            }
            catch {
                this.end();
                reject(new Error('ERR_RELAY_PROTOCOL：Relay 回應無效。'));
            } });
            ws.on('error', () => { clearTimeout(timeout); if (!ready)
                reject(new Error('ERR_RELAY_WS_HANDSHAKE：無法建立安全 WebSocket。')); this.finish(); });
            ws.on('close', (code) => { if (code === 4401)
                this.emit('error', new Error('ERR_AUTH：Relay 授權已失效。')); clearTimeout(timeout); if (!ready)
                reject(new Error(code === 4401 ? 'ERR_AUTH' : 'ERR_RELAY_WS_HANDSHAKE')); this.finish(); });
        });
        this.heartbeat = setInterval(() => { void this.request({ op: 'ping' }).catch(() => this.end()); }, 20000);
        this.renew = setInterval(() => { void this.session().then(s => this.request({ op: 'renew', token: s.token })).catch(error => { this.emit('error', error); this.end(); }); }, 240000);
        return this;
    }
    send(message) { if (this.closed || this.ws?.readyState !== ws_1.default.OPEN)
        throw new Error('ERR_RELAY_CLOSED'); if (this.ws.bufferedAmount > 8 * 1024 * 1024) {
        this.end();
        throw new Error('ERR_RELAY_BACKPRESSURE');
    } this.ws.send(JSON.stringify(message)); }
    request(message) { const id = message.id || (0, node_crypto_1.randomUUID)(); return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('ERR_RELAY_TIMEOUT')); }, 10000); this.pending.set(id, { resolve, reject, timer }); try {
        this.send({ ...message, id });
    }
    catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
    } }); }
    receive(m) {
        if (m.op === 'reply') {
            const p = this.pending.get(m.id);
            if (p) {
                clearTimeout(p.timer);
                this.pending.delete(m.id);
                m.error ? p.reject(new Error(m.error)) : p.resolve(m);
            }
            return;
        }
        if (m.op === 'incoming') {
            const channel = new RelayChannel(m.id, this);
            this.channels.set(m.id, channel);
            if (!this.listenerCount('tcp connection')) {
                channel.destroy();
                return;
            }
            this.emit('tcp connection', { destIP: '127.0.0.1', destPort: m.port }, () => { this.send({ op: 'accept', id: m.id }); return channel; }, () => channel.destroy());
            return;
        }
        const c = this.channels.get(m.id);
        if (!c)
            return;
        if (m.op === 'data')
            c.push(Buffer.from(m.data, 'base64'));
        else if (m.op === 'stderr')
            c.stderr.write(Buffer.from(m.data, 'base64'));
        else if (m.op === 'channel.close') {
            this.channels.delete(m.id);
            c.stderr.end();
            c.push(null);
            setImmediate(() => c.emit('close', m.code));
        }
        else if (m.op === 'channel.error')
            c.destroy(new Error('ERR_RELAY_CHANNEL'));
    }
    exec(command, _options, callback) { const id = (0, node_crypto_1.randomUUID)(), c = new RelayChannel(id, this); this.channels.set(id, c); void this.request({ op: 'exec', id, command }).then(() => callback(null, c), error => { this.channels.delete(id); c.destroy(); callback(error); }); }
    forwardIn(host, port, callback) { void this.request({ op: 'forward', host, port }).then(reply => callback(null, reply.port), e => callback(e, 0)); }
    unforwardIn(_host, port, callback) { void this.request({ op: 'unforward', port }).then(callback, callback); }
    end() { if (this.closed)
        return; this.ws?.terminate(); this.finish(); }
    destroy() { this.end(); }
    finish() { if (this.closed)
        return; this.closed = true; clearInterval(this.heartbeat); clearInterval(this.renew); for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('ERR_RELAY_CLOSED'));
    } this.pending.clear(); for (const c of this.channels.values()) {
        c.stderr.end();
        c.push(null);
        c.emit('close', null);
    } this.channels.clear(); this.emit('close'); }
}
exports.RelayConnection = RelayConnection;
