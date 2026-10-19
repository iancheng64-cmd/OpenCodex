"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RelayStore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const relay_connection_1 = require("./relay-connection");
class RelayStore {
    file;
    codec;
    constructor(file, codec) {
        this.file = file;
        this.codec = codec;
    }
    read() { try {
        return JSON.parse(node_fs_1.default.readFileSync(this.file, 'utf8'));
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return {};
        throw new Error('Relay 設備資料無法讀取，未覆寫既有資料。');
    } }
    write(value) { node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.file), { recursive: true, mode: 0o700 }); node_fs_1.default.writeFileSync(this.file + '.tmp', JSON.stringify(value), { mode: 0o600 }); node_fs_1.default.renameSync(this.file + '.tmp', this.file); }
    async pair(profileId, url, code) {
        if (!profileId || !this.codec.available())
            throw new Error('macOS 安全儲存目前不可用，未儲存配對。');
        const baseUrl = (0, relay_connection_1.relayUrl)(url), result = await (0, relay_connection_1.relayRequest)(baseUrl, '/pair', { code });
        if (typeof result.runtimeId !== 'string' || typeof result.deviceId !== 'string' || typeof result.credential !== 'string' || result.credential.length < 40)
            throw new Error('Relay 配對回應無效。');
        const encrypted = this.codec.encrypt(JSON.stringify({ baseUrl, ...result }));
        this.write({ ...this.read(), [profileId]: { baseUrl, runtimeId: result.runtimeId, deviceId: result.deviceId, encrypted } });
        return { paired: true, runtimeId: result.runtimeId, deviceId: result.deviceId };
    }
    credential(profileId, url) {
        const saved = this.read()[profileId];
        if (!saved || saved.baseUrl !== (0, relay_connection_1.relayUrl)(url))
            throw new Error('ERR_AUTH：此設備尚未配對 Relay，請先輸入一次性配對碼。');
        if (!this.codec.available())
            throw new Error('安全儲存目前不可用，未讀取 Relay 授權。');
        let result;
        try {
            result = JSON.parse(this.codec.decrypt(saved.encrypted));
        }
        catch {
            throw new Error('ERR_AUTH：macOS 無法讀取 Relay 授權，請處理系統提示後重試。');
        }
        if (result.baseUrl !== saved.baseUrl || result.runtimeId !== saved.runtimeId || result.deviceId !== saved.deviceId)
            throw new Error('ERR_AUTH：Relay 設備資料不一致。');
        return result;
    }
    async connect(input) { const c = new relay_connection_1.RelayConnection(this.credential(input.profile.id, input.profile.relayUrl)); await c.connect(); return c.asRuntimeClient(); }
    forget(id) { const value = this.read(); delete value[id]; this.write(value); }
    async health(id, url) { const start = Date.now(), credential = this.credential(id, url); await (0, relay_connection_1.relayRequest)(credential.baseUrl, '/session', { runtimeId: credential.runtimeId, deviceId: credential.deviceId, credential: credential.credential }); return { stage: 'HTTPS 與設備驗證', status: 'ok', latencyMs: Date.now() - start }; }
}
exports.RelayStore = RelayStore;
