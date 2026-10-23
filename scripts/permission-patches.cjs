'use strict';
// Patch only the pinned backend; repeat builds must not duplicate lifecycle work.
function replace(source,before,after){
 if(source.includes(after))return source;
 if(!source.includes(before)||source.indexOf(before)!==source.lastIndexOf(before))throw Error('Permission runtime patch anchor changed: '+before.slice(0,100));
 return source.replace(before,after);
}
function backend(source){
 source=replace(source,'        let rpc;\n        try {','        let rpc;\n        let runtime;\n        try {');
 source=replace(source,'            let runtime;\n            const id = (0, node_crypto_1.randomUUID)();','            // Shared with connection failure cleanup.\n            const id = (0, node_crypto_1.randomUUID)();');
 source=replace(source,'await deps.extensionServers(localCwd)','await deps.extensionServers(localCwd, input.permissionMode || "project")');
 source=replace(source,'permissionMode: ["ask", "full"].includes(input.permissionMode || "") ? input.permissionMode : "project"','permissionMode: deps.nativePermissionMode ? deps.nativePermissionMode(input.permissionMode || "project") : (["ask", "full"].includes(input.permissionMode || "") ? input.permissionMode : "project")');
 source=replace(source,'await deps.extensions(runtime.localCwd)','await deps.extensions(runtime.localCwd, runtime)');
 source=replace(source,'            return current.snapshot;',`            if (deps.initializeNativePermissions) {
                if (current.toolHost) await deps.initializeNativePermissions(current);
                else if (current.permissionMode.startsWith('custom:')) throw Error('Mac 工具宿主未就緒，無法套用自訂權限。');
                if (current.closed) throw Error('權限初始化期間連線已中斷。');
                current.snapshot.macTools = current.toolHost?.status();
                current.snapshot.permissionMode = current.permissionMode;
            }
            return current.snapshot;`);
 source=replace(source,'        catch (error) {\n            rpc?.close();','        catch (error) {\n            if (runtime) { try { await deps.closeNativePermissions?.(runtime); } catch (cleanupError) { deps.emit("runtime:event", {runtimeId:runtime.id,type:"diagnostic",message:"權限清理失敗："+cleanupError.message}); } }\n            rpc?.close();');
 source=replace(source,'    runtime.closed = true;\n    runtimes.delete(runtime.id);',`    runtime.closed = true;
    void Promise.resolve(deps.closeNativePermissions?.(runtime)).catch(error => deps.emit("runtime:event", {runtimeId:runtime.id,type:"diagnostic",message:"權限清理失敗："+error.message}));
    runtimes.delete(runtime.id);`);
 source=replace(source,"electron_1.ipcMain.handle('runtime:permission', (_event, id, value) => {","electron_1.ipcMain.handle('runtime:permission', async (_event, id, value) => {");
 source=replace(source,'const runtime = getRuntime(id), mode = (0, permission_policy_1.permissionMode)(value);','const runtime = getRuntime(id), mode = deps.nativePermissionMode ? deps.nativePermissionMode(value) : (0, permission_policy_1.permissionMode)(value);\n        await deps.selectNativePermissions?.(runtime, mode);');
 source=replace(source,'        const runtime = getRuntime(input.runtimeId);\n        if (!runtime.snapshot.capabilities.localTools)',`        const runtime = getRuntime(input.runtimeId);
        if (runtime.permissionMode.startsWith('custom:') || runtime.openCodexPermissionChanging || runtime.openCodexPermissionFailed)
            throw Error('自訂權限需使用原生對話流程，或重新選擇權限以恢復工具。');
        if (!runtime.snapshot.capabilities.localTools)`);
 return source;
}
module.exports={backend};
