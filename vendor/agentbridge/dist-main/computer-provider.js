"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComputerProviderStore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/** Only two explicit providers; never interpret a saved command as a shell or silently fall back. */
class ComputerProviderStore {
    file;
    bundled;
    home;
    selected;
    constructor(file, bundled, home) {
        this.file = file;
        this.bundled = bundled;
        this.home = home;
        this.selected = 'bundled';
        try {
            const value = JSON.parse(node_fs_1.default.readFileSync(file, 'utf8'));
            if (value.provider !== 'bundled' && value.provider !== 'open-computer-use')
                throw new Error('Invalid provider');
            this.selected = value.provider;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw new Error('電腦工具來源設定損壞；未啟動替代來源。');
        }
    }
    external() { return node_path_1.default.join(this.home, '.hermes/node/lib/node_modules/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse'); }
    executable(file) { try {
        node_fs_1.default.accessSync(file, node_fs_1.default.constants.X_OK);
        return node_fs_1.default.statSync(file).isFile();
    }
    catch {
        return false;
    } }
    status() { return { provider: this.selected, label: this.selected === 'bundled' ? '內建 Computer Use' : 'Open Computer Use（既有安裝）', externalAvailable: this.executable(this.external()), command: this.selected === 'bundled' ? this.bundled : this.external() }; }
    command() { const command = this.selected === 'bundled' ? this.bundled : this.external(); if (!this.executable(command))
        throw new Error('所選電腦工具執行檔不存在或不能執行；請明確選擇另一個來源。'); return { command, args: this.selected === 'bundled' ? [] : ['mcp'], computerProvider: this.selected }; }
    select(value) { if (value !== 'bundled' && value !== 'open-computer-use')
        throw new Error('電腦工具來源無效。'); const command = value === 'bundled' ? this.bundled : this.external(); if (!this.executable(command))
        throw new Error('所選電腦工具尚未安裝或不能執行。'); node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.file), { recursive: true }); node_fs_1.default.writeFileSync(this.file, JSON.stringify({ provider: value }, null, 2), { mode: 0o600 }); this.selected = value; return this.status(); }
}
exports.ComputerProviderStore = ComputerProviderStore;
