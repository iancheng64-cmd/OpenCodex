"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.remoteLaunchError = remoteLaunchError;
exports.captureRemote = captureRemote;
exports.resolveRemotePlatform = resolveRemotePlatform;
const node_string_decoder_1 = require("node:string_decoder");
function remoteLaunchError(platform, message) {
    if (platform === 'posix' && /(?:bash:\s*(?:command not found|not found)|(?:^|\s)['"]?bash['"]?\s+(?:is not recognized|not found)|^['"]bash['"]\s+\uFFFD|(?:cannot|failed to|unable to) (?:find|execute|spawn).*?\bbash\b)/i.test(message)) {
        return new Error('主機無法執行 bash。請將「主機系統」改為自動辨識；Windows 設備也可選擇 Windows。macOS／Linux 請確認已安裝 bash。');
    }
    if (message.includes('\uFFFD'))
        return new Error('遠端啟動失敗，主機回傳的文字編碼無法辨識。請使用自動辨識主機系統，並確認執行檔可由 SSH 執行。');
    return new Error(message || '無法啟動遠端 Runtime，請確認主機系統與執行檔路徑。');
}
function captureRemote(conn, command, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        let stream, output = '', stderr = '', settled = false;
        const outDecoder = new node_string_decoder_1.StringDecoder('utf8'), errDecoder = new node_string_decoder_1.StringDecoder('utf8');
        const finish = (error) => { if (settled)
            return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(output); };
        const timer = setTimeout(() => { finish(new Error('遠端預檢逾時，請確認主機在線且執行檔可由 SSH 執行。')); stream?.close(); }, timeoutMs);
        conn.exec(command, { pty: false }, (error, channel) => {
            if (settled) {
                channel?.close();
                return;
            }
            if (error) {
                finish(error);
                return;
            }
            stream = channel;
            channel.on('data', (chunk) => { output = (output + outDecoder.write(chunk)).slice(-64000); });
            channel.stderr.on('data', (chunk) => { stderr = (stderr + errDecoder.write(chunk)).slice(-2000); });
            channel.on('error', (error) => finish(error));
            channel.on('close', (code) => { output += outDecoder.end(); stderr += errDecoder.end(); finish(code === 0 ? undefined : new Error(stderr.trim() || '遠端命令無法執行。')); });
            channel.end();
        });
    });
}
/** Call only after SSH host identity verification and authentication succeed. */
async function resolveRemotePlatform(conn, platform) {
    if (platform === 'windows' || platform === 'posix')
        return platform;
    try {
        if (/^(Darwin|Linux|FreeBSD|OpenBSD|NetBSD|SunOS)\b/m.test(await captureRemote(conn, 'uname -s', 8000)))
            return 'posix';
    }
    catch { }
    const script = "$ErrorActionPreference='Stop'; if([Environment]::OSVersion.Platform -eq 'Win32NT'){[Console]::WriteLine('AGENTBRIDGE_WINDOWS')}else{exit 1}";
    const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
    try {
        if ((await captureRemote(conn, command, 8000)).trim() === 'AGENTBRIDGE_WINDOWS')
            return 'windows';
    }
    catch { }
    throw new Error('無法自動辨識這台設備的主機系統。請選擇 Windows 或 macOS／Linux／WSL 後重新連線。');
}
