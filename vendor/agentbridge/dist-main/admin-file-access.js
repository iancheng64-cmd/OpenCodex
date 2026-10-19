"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminReadScript = adminReadScript;
exports.administratorRead = administratorRead;
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const appleString = (value) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
function adminReadScript(action, target, executable = process.execPath) {
    if (!['list', 'stat', 'read'].includes(action) || !node_path_1.default.isAbsolute(target) || target.includes('\0'))
        throw new Error('Administrator read request is invalid');
    const encoded = Buffer.from(target).toString('base64');
    // A clean environment blocks NODE_OPTIONS and other user-level injection into root.
    const command = ['/usr/bin/env', '-i', 'ELECTRON_RUN_AS_NODE=1', quote(executable), quote(node_path_1.default.join(__dirname, 'admin-file-worker.js')), quote(action), quote(encoded)].join(' ');
    return 'do shell script ' + appleString(command) + ' with administrator privileges';
}
let pending = false;
async function administratorRead(action, target, signal) {
    if (process.platform !== 'darwin')
        throw new Error('Administrator reads require macOS');
    if (pending)
        throw new Error('Administrator authorization is already pending');
    if (signal?.aborted)
        throw new Error('Request cancelled');
    const script = adminReadScript(action, target);
    pending = true;
    try {
        const output = await new Promise((resolve, reject) => (0, node_child_process_1.execFile)('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', signal, timeout: 110000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => { if (error) {
            reject(new Error(signal?.aborted ? 'Request cancelled' : 'Administrator authorization cancelled or unsuccessful'));
            return;
        } resolve(stdout); }));
        if (signal?.aborted)
            throw new Error('Request cancelled');
        const response = JSON.parse(output);
        if (response.error)
            throw new Error(response.error === 'EPERM' ? 'macOS privacy or system protection denied access; Full Disk Access is separate from root' : response.error === 'EACCES' ? 'Administrator read denied by filesystem permissions' : response.error === 'ENOENT' ? 'Administrator path does not exist' : 'Administrator file read failed');
        return response.result;
    }
    finally {
        pending = false;
    }
}
