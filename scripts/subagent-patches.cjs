'use strict';
// Fail closed when the pinned vendor baseline changes. All edits are idempotent.
function replace(source,before,after){
 if(source.includes(after))return source;
 if(!source.includes(before)||source.indexOf(before)!==source.lastIndexOf(before))throw Error('Scoped runtime patch anchor changed: '+before.slice(0,100));
 return source.replace(before,after);
}
function host(source){
 source=replace(source,'const reason = failure.message;','const reason = failure.message;\n            const customReason = this.openCodexPermissionDispatch?.errorMessage(failure);');
 source=replace(source,"const detail = code === 'EACCES' ?","const detail = customReason || (code === 'EACCES' ?");
 source=replace(source,': safe;\n            result({ ...textResult(detail)',': safe);\n            result({ ...textResult(detail)');
 source=replace(source,'return entry.invoke(call.arguments, controller.signal);','return this.openCodexInvokeTool(entry, call.arguments, controller.signal);');
 source=replace(source,'capabilities: () => ({ ...this.status(), tools: this.listTools().map(tool => ({ name: tool.name, description: tool.description })) })','getRun: () => this.openCodexCurrentRun?.(), capabilities: () => ({ ...this.status(), tools: this.listTools().map(tool => ({ name: tool.name, description: tool.description })) })');
 source=replace(source,'    async stop() {',`    openCodexInvokeTool(entry,args,signal) {
        const invoke=()=>entry.invoke(args,signal),name=entry.tool.name;
        const client=this.extensionClients.get(entry.extensionId||args?.serverId);
        return this.openCodexPermissionDispatch ?
            this.openCodexPermissionDispatch.tool({entry,name,args,signal,client,invoke}) : invoke();
    }
    cancelRun(run) {
        if (!run?.requestId) return;
        this.core?.cancel(run.requestId);
        for (const controller of this.active)
            if (controller.openCodexRun === run) controller.abort();
    }
    async stop() {`);
 source=replace(source,'this.options.onActivity?.({ name: call.name, category: call.category, status });','this.options.onActivity?.({ name: call.name, category: call.category, status, ...(controller.openCodexRun ? {requestId:controller.openCodexRun.requestId,threadId:controller.openCodexRun.threadId,turnId:controller.openCodexRun.turnId} : {}) });');
 if(!source.includes('const call = { signal: controller.signal, metadata: params._meta,')){
  source=replace(source,'const call = { name: entry.tool.name, arguments: (params.arguments || {}),','const call = { signal: controller.signal, name: entry.tool.name, arguments: (params.arguments || {}),');
  source=replace(source,'const call = { signal: controller.signal, name: entry.tool.name,','const call = { signal: controller.signal, metadata: params._meta, name: entry.tool.name,');
 }
 source=replace(source,'const value = await Promise.race([work(), cancelled]);',`const execute = async () => {
                if (!this.openCodexResolveRun) return work();
                const run = await this.openCodexResolveRun(params._meta, controller.signal);
                controller.openCodexRun = run;
                if (controller.signal.aborted || run.cancelled) throw new Error("Request cancelled");
                return this.openCodexWithRun(run, work);
            };
            const value = await Promise.race([execute(), cancelled]);`);
 return source;
}
// The Hook endpoint is authenticated by LocalToolHost.handle before this route.
// It stays outside tools/list and returns native blocking output on transport
// failures: an MCP isError would make the engine ignore a failed Hook.
function hooksHost(source){
 return replace(source,'        const entry = typeof params.name === "string" ? this.entries.get(params.name) : undefined;',`        if (params.name === "opencodex_native_hook") {
            const block = () => {
                const event = params.arguments?.event, reason = "Mac native Hooks relay did not complete";
                const output = ["PreToolUse","PermissionRequest"].includes(event) ? {} : {continue:false,stopReason:reason};
                // These events reject continue:false before parsing their deny
                // decision. Emit only the native event-specific blocking fields.
                if (event === "PreToolUse") output.hookSpecificOutput = {hookEventName:event,permissionDecision:"deny",permissionDecisionReason:reason};
                if (event === "PermissionRequest") output.hookSpecificOutput = {hookEventName:event,decision:{behavior:"deny",message:reason}};
                if (event === "PostToolUse") Object.assign(output,{decision:"block",reason});
                result({content:[{type:"text",text:JSON.stringify(output)}]});
            };
            if (!object(params.arguments) || !this.openCodexHooksRelay || this.active.size >= 16) { block(); return; }
            const generation = this.generation, controller = new AbortController();
            this.active.add(controller);
            const timeout = setTimeout(() => controller.abort(), params.arguments.event === "Interrupt" ? 3500 : 650000);
            const disconnected = () => { if (!res.writableEnded) controller.abort(); };
            res.on("close", disconnected);
            let abort;
            try {
                const cancelled = new Promise((_,reject) => { abort = () => reject(new Error("Hook cancelled")); controller.signal.addEventListener("abort",abort,{once:true}); });
                const output = await Promise.race([this.openCodexHooksRelay({
                    arguments:params.arguments,metadata:params._meta,signal:controller.signal,
                    claim:run => { if (controller.signal.aborted || generation !== this.generation) throw new Error("Hook cancelled"); controller.openCodexRun=run; }
                }),cancelled]);
                if (controller.signal.aborted || generation !== this.generation) throw new Error("Hook cancelled");
                if (!object(output)) throw new Error("Invalid native Hooks output");
                result({content:[{type:"text",text:JSON.stringify(output)}]});
            } catch { block(); }
            finally { clearTimeout(timeout); res.off("close",disconnected); if(abort)controller.signal.removeEventListener("abort",abort);this.active.delete(controller); }
            return;
        }
        const entry = typeof params.name === "string" ? this.entries.get(params.name) : undefined;`);
}
function core(source){
 source=replace(source,"    cancel() { for (const job of this.jobs.values())\n        if (job.state === 'running')","    cancel(requestId) { for (const job of this.jobs.values())\n        if (job.state === 'running' && (requestId === undefined || job.ownerRequestId === requestId))");
 source=replace(source,"const job = { id, child, pid: child.pid, state: 'running',","const job = { id, ownerRequestId: this.config.getRun?.()?.requestId, child, pid: child.pid, state: 'running',");
 source=replace(source,"const get = (value) => { const job = this.jobs.get(text(value, 80)); if (!job)","const get = (value) => { const job = this.jobs.get(text(value, 80)); if (!job || job.ownerRequestId !== this.config.getRun?.()?.requestId)");
 return source;
}
function backend(source){
 source=replace(source,'        run.turnId = params.turn?.id;','        if (!run.nativeReview) run.turnId = params.turn?.id;');
 source=replace(source,'async function authorizeMacTool(runtime, deps, call) {','async function authorizeMacTool(runtime, deps, call) {\n    if (runtime?.openCodexSubagents) return runtime.openCodexSubagents.authorize(call);');
 source=replace(source,'function routeServerRequest(runtime, deps, request) {','function routeServerRequest(runtime, deps, request) {\n    if (runtime.openCodexSubagents?.serverRequest(request)) return;');
 source=replace(source,'function routeNotification(runtime, deps, message) {','function routeNotification(runtime, deps, message) {\n    runtime.openCodexSubagents?.notification(message);');
 source=replace(source,'    runtime.closed = true;','    runtime.openCodexSubagents?.close();\n    runtime.closed = true;');
 if(!source.includes('const managedCancellation = run.openCodex && runtime.openCodexSubagents;'))source=replace(source,'        run.cancelled = true;\n        runtime.toolHost?.cancelActive();','        if (run.openCodex && runtime.openCodexSubagents) await runtime.openCodexSubagents.cancel(run.threadId, run.turnId);\n        run.cancelled = true;\n        runtime.toolHost?.cancelActive();');
 // The coordinator already interrupts the root (including review IDs). Avoid
 // sending a second interrupt after the remote thread has been unloaded, and
 // always arm local cancellation cleanup even if the remote request fails.
 source=replace(source,'        if (run.openCodex && runtime.openCodexSubagents) await runtime.openCodexSubagents.cancel(run.threadId, run.turnId);','        const managedCancellation = run.openCodex && runtime.openCodexSubagents;');
 // Managed cancellation must establish the one-shot Interrupt Hook lease
 // before marking the root cancelled. Its scoped cleanup also preserves the
 // host generation needed by that lease and never cancels unrelated work.
 source=replace(source,'        const managedCancellation = run.openCodex && runtime.openCodexSubagents;\n        run.cancelled = true;\n        runtime.toolHost?.cancelActive();','        const managedCancellation = run.openCodex && runtime.openCodexSubagents;\n        if (!managedCancellation) {\n            run.cancelled = true;\n            runtime.toolHost?.cancelActive();\n        }');
 source=replace(source,'        if (run.threadId && run.turnId)\n            await runtime.rpc.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });\n        else if (!run.turnStarting) {',`        try {
        if (managedCancellation) await managedCancellation.cancel(run.threadId, run.turnId);
        if (run.threadId && run.turnId) {
            if (!managedCancellation) await runtime.rpc.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
        } else if (!run.turnStarting) {`);
 source=replace(source,'        // A turn in flight is normally released by the turn/completed notification.','        } finally {\n        // A turn in flight is normally released by the turn/completed notification.');
 source=replace(source,'        return { cancelled: true };\n    });\n    electron_1.ipcMain.handle("runtime:respond"','        } // cancellation cleanup guard\n        return { cancelled: true };\n    });\n    electron_1.ipcMain.handle("runtime:respond"');
 source=replace(source,'Boolean(runtime.run && !runtime.run.cancelled)','Boolean(pending.openCodexRun ? runtime.openCodexSubagents?.isActive(pending.openCodexRun) : runtime.run && !runtime.run.cancelled)');
 return source;
}
// HTTP tool calls can wait for approval or long-running work. The default
// inline executor would block every other thread and Hook on that connection.
function executor(source){
 return replace(source,'["exec-server", "--listen",','["exec-server", "--concurrent-requests", "32", "--listen",');
}
module.exports={host,hooksHost,core,backend,executor};
