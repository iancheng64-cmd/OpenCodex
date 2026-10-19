"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRelayServices = registerRelayServices;
const node_string_decoder_1 = require("node:string_decoder");
const electron_1 = require("electron");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_https_1 = __importDefault(require("node:https"));
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:stream/promises");
const node_stream_1 = require("node:stream");
const relay_connection_1 = require("./relay-connection");
function registerRelayServices(store, emit) {
    const transfers = new Map(), terminals = new Map();
    electron_1.ipcMain.handle('network:pair', (_e, input) => store.pair(input.profileId, input.url, input.code));
    electron_1.ipcMain.handle('network:diagnose', async (_e, input) => { const started = Date.now(); const conn = await store.connect({ profile: { id: input.profileId, relayUrl: input.url } }); conn.end(); return { stage: 'HTTPS、設備驗證與 WSS', status: 'ok', durationMs: Date.now() - started }; });
    electron_1.ipcMain.handle('network:files', async (_e, input) => { const c = store.credential(input.profileId, input.url), s = await (0, relay_connection_1.relayRequest)(c.baseUrl, '/session', { ...c }); return (0, relay_connection_1.relayRequest)(c.baseUrl, '/files?path=' + encodeURIComponent(input.path || ''), undefined, s.token); });
    electron_1.ipcMain.handle('network:cancelTransfer', (_e, id) => { transfers.get(id)?.abort(); return { cancelled: true }; });
    electron_1.ipcMain.handle('network:transfer', async (_e, input) => {
        if (!['upload', 'download'].includes(input.direction))
            throw Error('傳輸方向無效。');
        const c = store.credential(input.profileId, input.url), s = await (0, relay_connection_1.relayRequest)(c.baseUrl, '/session', { ...c });
        const chosen = input.direction === 'upload' ? await electron_1.dialog.showOpenDialog({ properties: ['openFile'] }) : await electron_1.dialog.showSaveDialog({ defaultPath: node_path_1.default.basename(input.path) });
        if (chosen.canceled)
            return { cancelled: true };
        const file = input.direction === 'upload' ? chosen.filePaths[0] : chosen.filePath;
        const size = input.direction === 'upload' ? node_fs_1.default.statSync(file).size : undefined;
        if (size !== undefined && size > 64 * 1024 * 1024)
            throw Error('單檔上限為 64 MiB。');
        const id = typeof input.id === 'string' ? input.id : (0, node_crypto_1.randomUUID)(), controller = new AbortController();
        if (transfers.has(id))
            throw Error('傳輸已在進行。');
        transfers.set(id, controller);
        const relative = input.direction === 'upload' ? [input.path || '', node_path_1.default.basename(file)].filter(Boolean).join('/') : input.path;
        const temporary = file + '.agentbridge-' + (0, node_crypto_1.randomUUID)();
        let bytes = 0;
        const meter = new node_stream_1.Transform({ transform(chunk, _enc, done) { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) {
                done(Error('檔案超過上限'));
                return;
            } emit('network:event', { type: 'transfer', id, bytes, total: size }); done(null, chunk); } });
        try {
            await new Promise((resolve, reject) => {
                const req = node_https_1.default.request(new URL('/file?path=' + encodeURIComponent(relative), c.baseUrl), { method: input.direction === 'upload' ? 'PUT' : 'GET', signal: controller.signal, headers: { Authorization: 'Bearer ' + s.token, ...(size !== undefined ? { 'Content-Length': size } : {}) } }, res => {
                    if (res.statusCode !== (input.direction === 'upload' ? 201 : 200)) {
                        res.resume();
                        reject(Error('檔案傳輸未成功；請確認路徑、設備授權與檔案上限。'));
                        return;
                    }
                    if (input.direction === 'download') {
                        const length = Number(res.headers['content-length']);
                        if (!Number.isInteger(length) || length < 0 || length > 64 * 1024 * 1024) {
                            res.destroy();
                            reject(Error('檔案大小無效。'));
                            return;
                        }
                        void (0, promises_1.pipeline)(res, meter, node_fs_1.default.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: controller.signal }).then(() => { if (bytes !== length)
                            throw Error('檔案未完整傳輸'); node_fs_1.default.renameSync(temporary, file); resolve(); }).catch(reject);
                    }
                    else {
                        res.resume();
                        res.on('end', resolve);
                        res.on('error', reject);
                    }
                });
                req.setTimeout(30000, () => req.destroy(Error('傳輸逾時')));
                req.on('error', reject);
                if (input.direction === 'upload')
                    void (0, promises_1.pipeline)(node_fs_1.default.createReadStream(file), meter, req, { signal: controller.signal }).catch(reject);
                else
                    req.end();
            });
            return { saved: true, bytes };
        }
        finally {
            transfers.delete(id);
            if (input.direction === 'download')
                node_fs_1.default.rmSync(temporary, { force: true });
        }
    });
    electron_1.ipcMain.handle('network:terminal', async (_e, input) => {
        const id = (0, node_crypto_1.randomUUID)(), conn = await store.connect({ profile: { id: input.profileId, relayUrl: input.url } });
        try {
            const channel = await new Promise((resolve, reject) => conn.exec(conn.platform === 'win32' ? 'powershell.exe -NoLogo -NoProfile' : '/bin/bash -i', {}, (error, stream) => error ? reject(error) : resolve(stream)));
            terminals.set(id, { conn, channel });
            const stdout = new node_string_decoder_1.StringDecoder('utf8'), stderr = new node_string_decoder_1.StringDecoder('utf8');
            channel.on('data', (data) => emit('network:event', { type: 'terminal', id, text: stdout.write(data) }));
            channel.stderr.on('data', (data) => emit('network:event', { type: 'terminal', id, text: stderr.write(data) }));
            channel.on('close', () => { const text = stdout.end() + stderr.end(); if (text)
                emit('network:event', { type: 'terminal', id, text }); terminals.delete(id); conn.end(); emit('network:event', { type: 'terminalClosed', id }); });
            return { id };
        }
        catch (e) {
            conn.end();
            throw e;
        }
    });
    electron_1.ipcMain.handle('network:terminalWrite', (_e, id, text) => { if (typeof text !== 'string' || text.length > 65536)
        throw Error('輸入過長'); terminals.get(id)?.channel.write(text); });
    electron_1.ipcMain.handle('network:terminalClose', (_e, id) => { const t = terminals.get(id); terminals.delete(id); t?.conn.end(); });
    electron_1.app.whenReady().then(() => { electron_1.powerMonitor.on('resume', () => emit('network:event', { type: 'resume' })); });
    electron_1.app.on('before-quit', () => { for (const c of transfers.values())
        c.abort(); for (const t of terminals.values())
        t.conn.end(); });
}
