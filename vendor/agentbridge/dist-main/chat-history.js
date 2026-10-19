"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatHistoryStore = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const validChat = (value) => value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200 && typeof value.title === 'string' && Array.isArray(value.messages);
/** Save only changed conversations. Atomic files avoid localStorage's small quota. */
class ChatHistoryStore {
    directory;
    pending = Promise.resolve();
    constructor(directory) {
        this.directory = directory;
    }
    file(id) { return node_path_1.default.join(this.directory, (0, node_crypto_1.createHash)('sha256').update(id).digest('hex') + '.json'); }
    async atomic(file, value) { const temporary = file + '.' + (0, node_crypto_1.randomUUID)() + '.tmp'; try {
        await promises_1.default.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
        await promises_1.default.rename(temporary, file);
    }
    finally {
        await promises_1.default.rm(temporary, { force: true });
    } }
    async readIndex() {
        let ids;
        try {
            ids = JSON.parse(await promises_1.default.readFile(node_path_1.default.join(this.directory, 'index.json'), 'utf8'));
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return null;
            throw new Error('對話索引無法讀取，原始檔案已保留。');
        }
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(ids).size !== ids.length)
            throw new Error('對話索引格式錯誤，原始檔案已保留。');
        return ids;
    }
    async read() {
        const ids = await this.readIndex();
        if (ids === null)
            return null;
        const chats = [];
        for (const id of ids) {
            const chat = JSON.parse(await promises_1.default.readFile(this.file(id), 'utf8'));
            if (!validChat(chat) || chat.id !== id)
                throw new Error('對話檔案格式錯誤，原始檔案已保留。');
            chats.push(chat);
        }
        return chats;
    }
    load() { return this.pending.then(() => this.read()); }
    save(input) {
        const run = async () => {
            if (!input || !Array.isArray(input.ids) || input.ids.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(input.ids).size !== input.ids.length || !Array.isArray(input.changes) || input.changes.some(chat => !validChat(chat) || !input.ids.includes(chat.id)))
                throw new Error('對話儲存格式錯誤。');
            const existing = await this.readIndex();
            const known = new Set(existing || []);
            for (const chat of input.changes)
                known.add(chat.id);
            if (input.ids.some(id => !known.has(id)))
                throw new Error('缺少對話內容，未覆寫原有索引。');
            const merging = input.removedIds !== undefined;
            if (merging && (!Array.isArray(input.removedIds) || input.removedIds.some(id => typeof id !== 'string' || !id || id.length > 200 || input.ids.includes(id))))
                throw new Error('對話刪除格式錯誤。');
            const removedIds = merging ? input.removedIds : (existing || []).filter(id => !input.ids.includes(id));
            const ids = merging ? [...input.ids, ...(existing || []).filter(id => !input.ids.includes(id) && !removedIds.includes(id))] : input.ids;
            const changes = [];
            for (const id of [...input.changes.map(chat => chat.id), ...removedIds]) {
                const current = existing?.includes(id) ? JSON.parse(await promises_1.default.readFile(this.file(id), 'utf8')) : undefined;
                const revision = Number(current?._revision) || 0;
                if (input.expectedRevisions && revision !== (input.expectedRevisions[id] || 0))
                    throw new Error('另一個視窗已更新這段對話，已保留其內容；請重新開啟對話後再操作。');
                const changed = input.changes.find(chat => chat.id === id);
                if (changed)
                    changes.push({ ...changed, _revision: revision + 1 });
            }
            await promises_1.default.mkdir(this.directory, { recursive: true, mode: 0o700 });
            for (const chat of changes)
                await this.atomic(this.file(chat.id), chat);
            await this.atomic(node_path_1.default.join(this.directory, 'index.json'), ids);
            for (const id of removedIds)
                await promises_1.default.rm(this.file(id), { force: true });
            return { saved: true, changes, removedIds };
        };
        const result = this.pending.then(run);
        this.pending = result.catch(() => { });
        return result;
    }
    idle() { return this.pending; }
}
exports.ChatHistoryStore = ChatHistoryStore;
