"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectionError = connectionError;
exports.retryDelay = retryDelay;
exports.probeTcp = probeTcp;
exports.connectNetwork = connectNetwork;
const node_net_1 = __importDefault(require("node:net"));
function connectionError(error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/ERR_AUTH|authentication methods failed|Password is required/i.test(text))
        return { code: 'ERR_AUTH', message: 'SSH 帳號或驗證方式未通過；請核對帳號、帳戶密碼或金鑰。' };
    if (/host.*verif|fingerprint|IDENTITY/i.test(text))
        return { code: 'ERR_HOST_IDENTITY', message: '主機身分需要核對。' };
    if (/ENOTFOUND|ERR_RELAY_DNS/.test(text))
        return { code: 'ERR_RELAY_DNS', message: '無法解析主機名稱。' };
    if (/TLS|CERT/.test(text))
        return { code: 'ERR_RELAY_TLS', message: '安全憑證驗證失敗。' };
    if (/RELAY_HTTPS|RELAY_TIMEOUT/.test(text))
        return { code: 'ERR_RELAY_HTTPS', message: 'HTTPS 無法連線；請確認 Gateway、公開網址與代理服務。' };
    if (/WS_HANDSHAKE/.test(text))
        return { code: 'ERR_RELAY_WS_HANDSHAKE', message: '安全 WebSocket 無法建立。' };
    return { code: 'ERR_CONNECT_TIMEOUT', message: '無法建立連線，請確認主機在線及網路允許此連線。' };
}
function retryDelay(attempt, random = Math.random) { return Math.min(15000, Math.round(Math.min(15000, 1000 * 2 ** Math.min(attempt, 4)) * (0.9 + 0.2 * random()))); }
async function probeTcp(host, port, timeout = 4000) {
    await new Promise((resolve, reject) => { const s = node_net_1.default.createConnection({ host, port }); const timer = setTimeout(() => s.destroy(new Error('ERR_SSH_TIMEOUT')), timeout); s.once('connect', () => { clearTimeout(timer); s.destroy(); resolve(); }); s.once('error', e => { clearTimeout(timer); s.destroy(); reject(e); }); });
}
async function connectNetwork(input, direct, relay) {
    const mode = input.profile?.networkMode || 'auto';
    if (!['auto', 'direct', 'relay'].includes(mode))
        throw new Error('連線模式無效。');
    const diagnostics = [];
    if (mode !== 'relay') {
        const start = Date.now();
        try {
            const result = await direct();
            if (result.confirmation)
                return result;
            diagnostics.push({ transport: 'tailscale-ssh', stage: 'SSH', status: 'ok', durationMs: Date.now() - start });
            return { ...result, transport: 'tailscale-ssh', diagnostics };
        }
        catch (e) {
            const failure = connectionError(e);
            diagnostics.push({ transport: 'tailscale-ssh', stage: 'SSH', status: 'failed', durationMs: Date.now() - start, code: failure.code });
            if (failure.code === 'ERR_HOST_IDENTITY')
                throw new Error(failure.code + '：' + failure.message);
            if (mode === 'direct' || !input.profile?.relayUrl)
                throw new Error(failure.code + '：' + failure.message);
        }
    }
    const start = Date.now();
    try {
        const conn = await relay();
        diagnostics.push({ transport: 'https-relay', stage: 'HTTPS/WSS', status: 'ok', durationMs: Date.now() - start });
        return { conn, key: 'relay:' + input.profile.relayUrl + '|' + input.profile.id, transport: 'https-relay', diagnostics };
    }
    catch (e) {
        const failure = connectionError(e);
        throw new Error('Direct：' + (diagnostics[0]?.code || '未使用') + '；Relay：' + failure.code + '。' + (failure.code === 'ERR_AUTH' ? '配對授權未通過，請重新配對。' : failure.message));
    }
}
