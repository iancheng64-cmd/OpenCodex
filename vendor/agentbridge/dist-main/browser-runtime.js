"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.browserExecutable = browserExecutable;
exports.browserRuntimeArgs = browserRuntimeArgs;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/** Public packages carry a version-matched browser; never download on first launch. */
function browserExecutable(root) {
    const manifest = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(root, 'browser-runtime.json'), 'utf8'));
    const relative = manifest.executable;
    if (typeof relative !== 'string' || node_path_1.default.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
        throw new Error('內建瀏覽器資訊無效，請重新下載完整的 AgentBridge 安裝檔。');
    }
    const file = node_path_1.default.resolve(root, relative);
    const realRoot = node_fs_1.default.realpathSync(root);
    const realFile = node_fs_1.default.realpathSync(file);
    if (!realFile.startsWith(realRoot + node_path_1.default.sep))
        throw new Error('內建瀏覽器路徑超出安裝範圍。');
    node_fs_1.default.accessSync(file, node_fs_1.default.constants.X_OK);
    if (!node_fs_1.default.statSync(file).isFile())
        throw new Error('內建瀏覽器執行檔遺失，請重新下載完整安裝檔。');
    return file;
}
function browserRuntimeArgs(root) {
    return ['--browser', 'chrome', '--executable-path', browserExecutable(root)];
}
