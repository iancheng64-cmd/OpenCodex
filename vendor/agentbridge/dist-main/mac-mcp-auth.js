"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MacMcpOAuthProvider = void 0;
exports.stopMacMcpLogin = stopMacMcpLogin;
exports.beginMacMcpLogin = beginMacMcpLogin;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_http_1 = __importDefault(require("node:http"));
const node_crypto_1 = require("node:crypto");
const auth_js_1 = require("@modelcontextprotocol/sdk/client/auth.js");
/** App-owned credentials only. Never imports another client's OAuth store. */
class MacMcpOAuthProvider {
    file;
    serverUrl;
    codec;
    redirect;
    verifier = '';
    nonce = (0, node_crypto_1.randomUUID)();
    redirectUrl = 'http://127.0.0.1:41987/oauth/callback';
    key;
    constructor(file, serverUrl, codec, redirect) {
        this.file = file;
        this.serverUrl = serverUrl;
        this.codec = codec;
        this.redirect = redirect;
        this.key = (0, node_crypto_1.createHash)('sha256').update(serverUrl).digest('hex');
    }
    get clientMetadata() { return { client_name: 'AgentBridge Studio on this Mac', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
    state() { return this.nonce; }
    validState(value) { if (!value)
        return false; const a = Buffer.from(value), b = Buffer.from(this.nonce); return a.length === b.length && (0, node_crypto_1.timingSafeEqual)(a, b); }
    read() { try {
        const record = JSON.parse(node_fs_1.default.readFileSync(this.file, 'utf8'))[this.key];
        return record ? JSON.parse(this.codec.decrypt(record)) : {};
    }
    catch {
        return {};
    } }
    save(patch) { if (!this.codec.available())
        throw new Error('macOS 加密儲存不可用，未儲存 MCP 授權。'); let records = {}; try {
        records = JSON.parse(node_fs_1.default.readFileSync(this.file, 'utf8'));
    }
    catch { } records[this.key] = this.codec.encrypt(JSON.stringify({ ...this.read(), ...patch })); node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.file), { recursive: true, mode: 0o700 }); node_fs_1.default.writeFileSync(this.file + '.tmp', JSON.stringify(records), { mode: 0o600 }); node_fs_1.default.renameSync(this.file + '.tmp', this.file); node_fs_1.default.chmodSync(this.file, 0o600); }
    clientInformation() { return this.read().client; }
    saveClientInformation(client) { this.save({ client }); }
    tokens() { return this.read().tokens; }
    saveTokens(tokens) { this.save({ tokens }); }
    saveCodeVerifier(value) { this.verifier = value; }
    codeVerifier() { if (!this.verifier)
        throw new Error('MCP 登入工作階段已結束。'); return this.verifier; }
    async redirectToAuthorization(url) { if (!this.redirect)
        throw new Error('請在這台 Mac 的應用程式與外掛頁面登入 MCP。'); if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('MCP 授權網址無效。'); await this.redirect(url); }
    invalidateCredentials(scope) { if (scope === 'all' || scope === 'client')
        this.save({ client: undefined }); if (scope === 'all' || scope === 'tokens')
        this.save({ tokens: undefined }); if (scope === 'all' || scope === 'verifier')
        this.verifier = ''; }
}
exports.MacMcpOAuthProvider = MacMcpOAuthProvider;
let activeLogin;
function stopMacMcpLogin() { activeLogin?.close(); activeLogin = undefined; }
/** Opens the local user's browser. Consent/login remains with that user. */
async function beginMacMcpLogin(options) {
    if (activeLogin)
        throw new Error('已有 MCP 登入正在進行；請先完成或稍後重試。');
    if (!options.codec.available())
        throw new Error('macOS 加密儲存目前不可用。');
    let opened = false, finishing = false, timer;
    const provider = new MacMcpOAuthProvider(options.file, options.url, options.codec, async (url) => { await options.open(url.href); opened = true; });
    const server = node_http_1.default.createServer((req, res) => {
        void (async () => {
            const url = new URL(req.url || '/', 'http://127.0.0.1:41987');
            if (req.method !== 'GET' || url.pathname !== '/oauth/callback') {
                res.writeHead(404);
                res.end();
                return;
            }
            if (!provider.validState(url.searchParams.get('state'))) {
                res.writeHead(403);
                res.end('Invalid login state');
                return;
            }
            const code = url.searchParams.get('code');
            if (finishing || !code || url.searchParams.has('error')) {
                res.writeHead(400);
                res.end('Login was cancelled or already handled');
                if (!finishing)
                    close();
                return;
            }
            finishing = true;
            try {
                const result = await (0, auth_js_1.auth)(provider, { serverUrl: options.url, authorizationCode: code });
                if (result !== 'AUTHORIZED')
                    throw new Error('not authorized');
                res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" });
                res.end('<p>Mac MCP 登入完成。請回到 AgentBridge Studio，重新連接 Agent。</p>');
                options.notify('Mac MCP 登入完成，請重新連接 Agent 以載入工具。');
            }
            catch {
                res.writeHead(400);
                res.end('Login could not be completed. Return to AgentBridge Studio.');
                options.notify('Mac MCP 登入未完成，請重新嘗試。');
            }
            finally {
                close();
            }
        })();
    });
    const close = () => { clearTimeout(timer); server.close(); server.closeIdleConnections(); if (activeLogin?.close === close)
        activeLogin = undefined; };
    await new Promise((resolve, reject) => { server.once('error', () => reject(new Error('Mac MCP 登入通道目前無法啟動，請稍後再試。'))); server.listen(41987, '127.0.0.1', resolve); });
    activeLogin = { close };
    timer = setTimeout(() => { options.notify('Mac MCP 登入已逾時，可重新登入。'); close(); }, 300000);
    try {
        const result = await (0, auth_js_1.auth)(provider, { serverUrl: options.url });
        if (result === 'AUTHORIZED') {
            close();
            return { opened: false, authenticated: true };
        }
        if (!opened)
            throw new Error('not opened');
        return { opened: true, authenticated: false };
    }
    catch {
        close();
        throw new Error('無法啟動 Mac MCP 登入，請確認 MCP 服務支援 OAuth 並可連線。');
    }
}
