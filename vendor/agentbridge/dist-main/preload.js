"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("agentBridge", {
    history: {
        onChanged: (callback) => { const handler = (_event, value) => callback(value); electron_1.ipcRenderer.on('history:changed', handler); return () => electron_1.ipcRenderer.removeListener('history:changed', handler); },
        loadDrafts: () => electron_1.ipcRenderer.invoke('history:loadDrafts'), saveDrafts: (input) => electron_1.ipcRenderer.invoke('history:saveDrafts', input),
        load: () => electron_1.ipcRenderer.invoke('history:load'), save: (input) => electron_1.ipcRenderer.invoke('history:save', input),
        flushed: (id, ok) => electron_1.ipcRenderer.send('history:flushed', id, ok),
        onFlush: (callback) => { const handler = (_event, id) => callback(id); electron_1.ipcRenderer.on('history:flush', handler); return () => electron_1.ipcRenderer.removeListener('history:flush', handler); }
    },
    network: {
        pair: (input) => electron_1.ipcRenderer.invoke('network:pair', input),
        diagnose: (input) => electron_1.ipcRenderer.invoke('network:diagnose', input),
        files: (input) => electron_1.ipcRenderer.invoke('network:files', input),
        transfer: (input) => electron_1.ipcRenderer.invoke('network:transfer', input),
        cancelTransfer: (id) => electron_1.ipcRenderer.invoke('network:cancelTransfer', id),
        terminal: (input) => electron_1.ipcRenderer.invoke('network:terminal', input),
        terminalWrite: (id, text) => electron_1.ipcRenderer.invoke('network:terminalWrite', id, text),
        terminalClose: (id) => electron_1.ipcRenderer.invoke('network:terminalClose', id),
        onEvent: (callback) => { const handler = (_event, value) => callback(value); electron_1.ipcRenderer.on('network:event', handler); return () => electron_1.ipcRenderer.removeListener('network:event', handler); }
    },
    runtime: {
        acquireTask: (input) => electron_1.ipcRenderer.invoke('runtime:acquireTask', input),
        releaseTask: (runtimeId, requestId) => electron_1.ipcRenderer.invoke('runtime:releaseTask', runtimeId, requestId),
        connect: (input) => electron_1.ipcRenderer.invoke("runtime:connect", input),
        disconnect: (runtimeId) => electron_1.ipcRenderer.invoke("runtime:disconnect", runtimeId),
        permission: (runtimeId, mode) => electron_1.ipcRenderer.invoke("runtime:permission", runtimeId, mode),
        recoverTools: (runtimeId) => electron_1.ipcRenderer.invoke("runtime:recoverTools", runtimeId),
        status: (runtimeId) => electron_1.ipcRenderer.invoke("runtime:status", runtimeId),
        models: (runtimeId) => electron_1.ipcRenderer.invoke("runtime:models", runtimeId),
        extensions: (runtimeId) => electron_1.ipcRenderer.invoke("runtime:extensions", runtimeId),
        usage: (runtimeId) => electron_1.ipcRenderer.invoke("runtime:usage", runtimeId),
        send: (input) => electron_1.ipcRenderer.invoke("runtime:send", input),
        cancel: (runtimeId, requestId) => electron_1.ipcRenderer.invoke("runtime:cancel", runtimeId, requestId),
        respond: (input) => electron_1.ipcRenderer.invoke("runtime:respond", input),
        chooseLocalDirectory: () => electron_1.ipcRenderer.invoke("runtime:chooseLocalDirectory"),
        onEvent: (callback) => {
            const handler = (_event, payload) => callback(payload);
            electron_1.ipcRenderer.on("runtime:event", handler);
            return () => electron_1.ipcRenderer.removeListener("runtime:event", handler);
        }
    },
    claude: {
        acquireTask: (input) => electron_1.ipcRenderer.invoke('claude:acquireTask', input),
        releaseTask: (runtimeId, requestId) => electron_1.ipcRenderer.invoke('claude:releaseTask', runtimeId, requestId),
        quota: (id) => electron_1.ipcRenderer.invoke("claude:quota", id),
        login: (input) => electron_1.ipcRenderer.invoke("claude:login", input),
        connect: (input) => electron_1.ipcRenderer.invoke("claude:connect", input),
        disconnect: (runtimeId) => electron_1.ipcRenderer.invoke("claude:disconnect", runtimeId),
        permission: (runtimeId, mode) => electron_1.ipcRenderer.invoke("claude:permission", runtimeId, mode),
        recoverTools: (runtimeId) => electron_1.ipcRenderer.invoke("claude:recoverTools", runtimeId),
        status: (runtimeId) => electron_1.ipcRenderer.invoke("claude:status", runtimeId),
        models: (runtimeId) => electron_1.ipcRenderer.invoke("claude:models", runtimeId),
        extensions: (runtimeId) => electron_1.ipcRenderer.invoke("claude:extensions", runtimeId),
        send: (input) => electron_1.ipcRenderer.invoke("claude:send", input),
        cancel: (runtimeId, requestId) => electron_1.ipcRenderer.invoke("claude:cancel", runtimeId, requestId),
        respond: (input) => electron_1.ipcRenderer.invoke("claude:respond", input),
        onEvent: (callback) => {
            const handler = (_event, payload) => callback(payload);
            electron_1.ipcRenderer.on("claude:event", handler);
            return () => electron_1.ipcRenderer.removeListener("claude:event", handler);
        }
    },
    orchestrator: {
        start: (input) => electron_1.ipcRenderer.invoke("orchestrator:start", input),
        cancel: (runId) => electron_1.ipcRenderer.invoke("orchestrator:cancel", runId),
        status: (runId) => electron_1.ipcRenderer.invoke("orchestrator:status", runId),
        onEvent: (callback) => {
            const handler = (_event, payload) => callback(payload);
            electron_1.ipcRenderer.on("orchestrator:event", handler);
            return () => electron_1.ipcRenderer.removeListener("orchestrator:event", handler);
        }
    },
    chat: {
        send: (input) => electron_1.ipcRenderer.invoke("chat:send", input),
        cancel: (requestId) => electron_1.ipcRenderer.invoke("chat:cancel", requestId),
        onEvent: (callback) => {
            const handler = (_event, payload) => callback(payload);
            electron_1.ipcRenderer.on("chat:event", handler);
            return () => electron_1.ipcRenderer.removeListener("chat:event", handler);
        }
    },
    library: {
        list: () => electron_1.ipcRenderer.invoke("library:list"),
        choose: () => electron_1.ipcRenderer.invoke("library:choose"),
        addPaths: (paths) => electron_1.ipcRenderer.invoke("library:addPaths", paths),
        addImage: (dataUrl) => electron_1.ipcRenderer.invoke("library:addImage", { dataUrl }),
        preview: (id) => electron_1.ipcRenderer.invoke("library:preview", id),
        remove: (id) => electron_1.ipcRenderer.invoke("library:remove", id),
        upload: (sessionId, ids, remoteDir) => electron_1.ipcRenderer.invoke("library:upload", sessionId, ids, remoteDir)
    },
    extensions: { list: (sessionId) => electron_1.ipcRenderer.invoke("extensions:list", sessionId), loginMcp: (id) => electron_1.ipcRenderer.invoke('extensions:loginMcp', id) },
    profiles: {
        list: () => electron_1.ipcRenderer.invoke("profiles:list"),
        save: (profile) => electron_1.ipcRenderer.invoke("profiles:save", profile),
        delete: (id) => electron_1.ipcRenderer.invoke("profiles:delete", id)
    },
    ssh: {
        onClosed: (callback) => {
            const handler = (_event, payload) => callback(payload);
            electron_1.ipcRenderer.on("ssh:closed", handler);
            return () => electron_1.ipcRenderer.removeListener("ssh:closed", handler);
        },
        connect: (payload) => electron_1.ipcRenderer.invoke("ssh:connect", payload),
        disconnect: (sessionId) => electron_1.ipcRenderer.invoke("ssh:disconnect", sessionId),
        exec: (sessionId, command) => electron_1.ipcRenderer.invoke("ssh:exec", sessionId, command)
    },
    terminal: {
        start: (sessionId, initialCommand) => electron_1.ipcRenderer.invoke("terminal:start", sessionId, initialCommand),
        input: (sessionId, data) => electron_1.ipcRenderer.invoke("terminal:input", sessionId, data),
        resize: (sessionId, cols, rows) => electron_1.ipcRenderer.invoke("terminal:resize", sessionId, cols, rows),
        onData: (callback) => {
            const handler = (_event, payload) => callback(payload);
            electron_1.ipcRenderer.on("terminal:data", handler);
            return () => electron_1.ipcRenderer.removeListener("terminal:data", handler);
        },
        onClosed: (callback) => {
            const handler = (_event, payload) => callback(payload);
            electron_1.ipcRenderer.on("terminal:closed", handler);
            return () => electron_1.ipcRenderer.removeListener("terminal:closed", handler);
        }
    },
    oauth: {
        forward: (sessionId, port) => electron_1.ipcRenderer.invoke("oauth:forward", sessionId, port),
        list: (sessionId) => electron_1.ipcRenderer.invoke("oauth:forwards", sessionId),
        close: (sessionId, port) => electron_1.ipcRenderer.invoke("oauth:close", sessionId, port)
    },
    exposure: {
        get: () => electron_1.ipcRenderer.invoke("exposure:get"),
        set: (mode) => electron_1.ipcRenderer.invoke("exposure:set", mode)
    },
    files: {
        list: (sessionId, remotePath) => electron_1.ipcRenderer.invoke("files:list", sessionId, remotePath),
        upload: (sessionId, remoteDir) => electron_1.ipcRenderer.invoke("files:upload", sessionId, remoteDir),
        uploadFolder: (sessionId, remoteDir) => electron_1.ipcRenderer.invoke("files:uploadFolder", sessionId, remoteDir),
        uploadPaths: (sessionId, remoteDir, localPaths) => electron_1.ipcRenderer.invoke("files:uploadPaths", sessionId, remoteDir, localPaths),
        download: (sessionId, remotePath) => electron_1.ipcRenderer.invoke("files:download", sessionId, remotePath),
        transfers: (sessionId) => electron_1.ipcRenderer.invoke("files:transfers", sessionId),
        transferControl: (transferId, action) => electron_1.ipcRenderer.invoke("files:transferControl", transferId, action),
        pathForFile: (file) => electron_1.webUtils.getPathForFile(file),
        onTransfer: (callback) => {
            const handler = (_event, payload) => callback(payload);
            electron_1.ipcRenderer.on("transfer:event", handler);
            return () => electron_1.ipcRenderer.removeListener("transfer:event", handler);
        },
        onTransferRemoved: (callback) => {
            const handler = (_event, payload) => callback(payload);
            electron_1.ipcRenderer.on("transfer:removed", handler);
            return () => electron_1.ipcRenderer.removeListener("transfer:removed", handler);
        }
    },
    dialogs: { chooseKey: () => electron_1.ipcRenderer.invoke("dialog:chooseKey") },
    local: {
        computerProvider: () => electron_1.ipcRenderer.invoke("local:computerProvider"),
        selectComputerProvider: (provider) => electron_1.ipcRenderer.invoke("local:selectComputerProvider", provider),
        network: () => electron_1.ipcRenderer.invoke("local:network"),
        doctor: (target) => electron_1.ipcRenderer.invoke("local:doctor", target),
        toolHealth: (target) => electron_1.ipcRenderer.invoke("local:toolHealth", target),
        permissionDiagnostics: () => electron_1.ipcRenderer.invoke("local:permissionDiagnostics"),
        requestPermissions: () => electron_1.ipcRenderer.invoke("local:requestPermissions"),
        stopToolHealth: () => electron_1.ipcRenderer.invoke("local:stopToolHealth"),
        installEngines: () => electron_1.ipcRenderer.invoke("local:installEngines")
    },
    services: {
        start: (name) => electron_1.ipcRenderer.invoke("service:start", name),
        stop: (name) => electron_1.ipcRenderer.invoke("service:stop", name),
        status: () => electron_1.ipcRenderer.invoke("service:status"),
        health: (name) => electron_1.ipcRenderer.invoke("service:health", name),
        onEvent: (callback) => {
            const handler = (_event, payload) => callback(payload);
            electron_1.ipcRenderer.on("service:event", handler);
            return () => electron_1.ipcRenderer.removeListener("service:event", handler);
        }
    },
    remote: {
        configureMcp: (sessionId, host) => electron_1.ipcRenderer.invoke("remote:configureMcp", sessionId, host),
        extensions: (sessionId) => electron_1.ipcRenderer.invoke("remote:extensions", sessionId)
    },
    system: {
        openExternal: (url) => electron_1.ipcRenderer.invoke("system:openExternal", url),
        reveal: (targetPath) => electron_1.ipcRenderer.invoke("system:reveal", targetPath),
        openWindow: () => electron_1.ipcRenderer.invoke("system:openWindow"),
        notify: (text) => electron_1.ipcRenderer.invoke("system:notify", text)
    },
    onToast: (callback) => {
        const handler = (_event, payload) => callback(payload);
        electron_1.ipcRenderer.on("toast", handler);
        return () => electron_1.ipcRenderer.removeListener("toast", handler);
    }
});
