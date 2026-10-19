"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAgentOrchestrator = registerAgentOrchestrator;
const electron_1 = require("electron");
const node_crypto_1 = require("node:crypto");
const agent_relay_1 = require("./agent-relay");
const runtime_backend_1 = require("./runtime-backend");
const claude_local_backend_1 = require("./claude-local-backend");
const runs = new Map();
const MAX_ROUNDS = 8;
const MAX_TOPIC_CHARS = 20_000;
const MAX_CONTEXT_CHARS = 28_000;
const peerOf = (agent) => agent === "codex" ? "claude" : "codex";
const label = (agent) => agent === "codex" ? "Codex" : "Claude";
function text(value, name, max) {
    if (typeof value !== "string")
        throw new Error(`${name} 格式無效。`);
    const normalized = value.trim();
    if (!normalized || normalized.length > max)
        throw new Error(`${name} 長度必須介於 1 到 ${max} 個字元。`);
    return normalized;
}
function optionalText(value, name, max = 200) {
    if (value === undefined || value === null || value === "")
        return undefined;
    return text(value, name, max);
}
function clip(value, max = MAX_CONTEXT_CHARS) {
    if (value.length <= max)
        return value;
    const head = Math.floor(max * 0.65);
    const tail = max - head;
    return value.slice(0, head) + "\n\n[中間內容因上下文限制省略]\n\n" + value.slice(-tail);
}
function checkCancelled(run) {
    if (run.cancelled)
        throw new Error("AUTO_DISCUSSION_CANCELLED");
}
function emit(deps, run, payload) {
    deps.emit("orchestrator:event", { runId: run.id, conversationId: run.relayConversationId, ...payload });
}
async function turn(run, agent, prompt) {
    checkCancelled(run);
    run.activeAgent = agent;
    const requestId = (0, node_crypto_1.randomUUID)();
    if (agent === "codex") {
        const result = await (0, runtime_backend_1.runCodexBackgroundTurn)({
            runtimeId: run.input.codexRuntimeId,
            requestId,
            prompt,
            conversationId: run.codexConversationId,
            model: run.input.codexModel,
            effort: run.input.codexEffort
        });
        run.codexConversationId = result.conversationId;
        return result.text;
    }
    const result = await (0, claude_local_backend_1.runClaudeBackgroundTurn)({
        runtimeId: run.input.claudeRuntimeId,
        requestId,
        prompt,
        conversationId: run.claudeConversationId,
        model: run.input.claudeModel,
        effort: run.input.claudeEffort
    });
    run.claudeConversationId = result.conversationId;
    return result.text;
}
function openingPrompt(run, agent, round) {
    return [
        `You are ${label(agent)} in an automatic cross-model discussion with ${label(peerOf(agent))}.`,
        `User topic: ${run.input.topic}`,
        `Exchange ${round} of ${run.input.rounds}.`,
        "Give your own substantive analysis first. Identify assumptions, trade-offs, failure modes, and concrete implementation implications where relevant.",
        "Do not use tools, browse, execute commands, inspect files, or ask the user questions. This is a text-only reasoning discussion.",
        "Do not merely agree. State where another strong model might reasonably disagree.",
        "Keep the response focused so the peer can critique it in the next turn."
    ].join("\n\n");
}
function replyPrompt(run, agent, peerText, round) {
    return [
        `Continue the cross-model discussion on this user topic: ${run.input.topic}`,
        `Exchange ${round} of ${run.input.rounds}. The latest message from ${label(peerOf(agent))} is below:`,
        "----- peer message -----",
        clip(peerText),
        "----- end peer message -----",
        `Respond as ${label(agent)}. Critique the peer's strongest claims, correct errors, preserve good ideas, and advance the discussion toward a more robust answer.`,
        "Do not use tools or ask the user questions. Return text only."
    ].join("\n\n");
}
function synthesisPrompt(run, lead, peerText) {
    return [
        `The automatic ${label(lead)} ↔ ${label(peerOf(lead))} discussion is complete.`,
        `Original user topic: ${run.input.topic}`,
        `The peer's final position is:`,
        "----- peer final position -----",
        clip(peerText),
        "----- end peer final position -----",
        "Using the full discussion context already present in this conversation, produce the final synthesis for the user.",
        "Separate: (1) points of agreement, (2) meaningful disagreements or uncertainty, (3) the integrated conclusion / implementation plan.",
        "Do not claim consensus where there was none. Do not use tools. Return only the final user-facing synthesis."
    ].join("\n\n");
}
async function execute(run, deps) {
    const lead = run.input.leadAgent;
    const peer = peerOf(lead);
    let lastByLead = "";
    let lastByPeer = "";
    try {
        const leases = await Promise.allSettled([
            (0, runtime_backend_1.acquireCodexTask)(run.input.codexRuntimeId, run.id, run.id),
            (0, claude_local_backend_1.acquireClaudeTask)(run.input.claudeRuntimeId, run.id, run.id)
        ]);
        if (leases[0].status === 'fulfilled') {
            run.leasedCodex = leases[0].value.runtimeId;
            run.input.codexRuntimeId = leases[0].value.runtimeId;
        }
        if (leases[1].status === 'fulfilled') {
            run.leasedClaude = leases[1].value.runtimeId;
            run.input.claudeRuntimeId = leases[1].value.runtimeId;
        }
        for (const lease of leases)
            if (lease.status === 'rejected')
                throw lease.reason;
        checkCancelled(run);
        emit(deps, run, { type: "started", topic: run.input.topic, rounds: run.input.rounds, leadAgent: lead, modelCalls: run.input.rounds * 2 + 1 });
        for (let round = 1; round <= run.input.rounds; round++) {
            checkCancelled(run);
            emit(deps, run, { type: "activity", round, agent: lead, text: `${label(lead)} 正在進行第 ${round} 輪分析…` });
            lastByLead = await turn(run, lead, round === 1 ? openingPrompt(run, lead, round) : replyPrompt(run, lead, lastByPeer, round));
            checkCancelled(run);
            agent_relay_1.agentRelayHub.send(lead, run.relayConversationId, lastByLead);
            emit(deps, run, { type: "turn", round, agent: lead, text: lastByLead });
            emit(deps, run, { type: "activity", round, agent: peer, text: `${label(peer)} 正在回應第 ${round} 輪…` });
            lastByPeer = await turn(run, peer, replyPrompt(run, peer, lastByLead, round));
            checkCancelled(run);
            agent_relay_1.agentRelayHub.send(peer, run.relayConversationId, lastByPeer);
            emit(deps, run, { type: "turn", round, agent: peer, text: lastByPeer });
        }
        checkCancelled(run);
        emit(deps, run, { type: "activity", round: run.input.rounds + 1, agent: lead, text: `${label(lead)} 正在整理雙方結論…` });
        const final = await turn(run, lead, synthesisPrompt(run, lead, lastByPeer));
        checkCancelled(run);
        emit(deps, run, { type: "final", agent: lead, text: final });
        agent_relay_1.agentRelayHub.close(lead, run.relayConversationId);
        emit(deps, run, { type: "done", status: "completed", final });
    }
    catch (error) {
        const cancelled = run.cancelled || (error instanceof Error && error.message === "AUTO_DISCUSSION_CANCELLED");
        if (!cancelled)
            emit(deps, run, { type: "error", text: error instanceof Error ? error.message : String(error) });
        try {
            agent_relay_1.agentRelayHub.close(run.input.leadAgent, run.relayConversationId);
        }
        catch { }
        emit(deps, run, { type: "done", status: cancelled ? "cancelled" : "error" });
    }
    finally {
        run.activeAgent = undefined;
        if (run.leasedCodex)
            (0, runtime_backend_1.releaseCodexTask)(run.leasedCodex, run.id);
        if (run.leasedClaude)
            (0, claude_local_backend_1.releaseClaudeTask)(run.leasedClaude, run.id);
        runs.delete(run.id);
    }
}
function registerAgentOrchestrator(deps) {
    electron_1.ipcMain.handle("orchestrator:start", (_event, raw) => {
        const topic = text(raw?.topic, "討論主題", MAX_TOPIC_CHARS);
        const codexRuntimeId = text(raw?.codexRuntimeId, "Codex Runtime ID", 128);
        const claudeRuntimeId = text(raw?.claudeRuntimeId, "Claude Runtime ID", 128);
        const rounds = raw.rounds === undefined ? 3 : raw.rounds;
        if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS)
            throw new Error(`討論輪數必須介於 1 到 ${MAX_ROUNDS} 輪。`);
        const leadAgent = raw.leadAgent === "claude" ? "claude" : "codex";
        const id = raw.requestId ? text(raw.requestId, 'Request ID', 128) : (0, node_crypto_1.randomUUID)();
        if (runs.has(id))
            throw new Error('這個討論已在執行。');
        const relay = agent_relay_1.agentRelayHub.create(leadAgent, topic.slice(0, 500));
        const run = {
            id,
            relayConversationId: relay.conversationId,
            cancelled: false,
            input: {
                codexRuntimeId,
                claudeRuntimeId,
                topic,
                rounds,
                leadAgent,
                codexModel: optionalText(raw.codexModel, "Codex 模型"),
                claudeModel: optionalText(raw.claudeModel, "Claude 模型"),
                codexEffort: optionalText(raw.codexEffort, "Codex 思考強度", 40),
                claudeEffort: optionalText(raw.claudeEffort, "Claude 思考強度", 40)
            }
        };
        runs.set(id, run);
        setImmediate(() => { void execute(run, deps); });
        return { runId: id, conversationId: run.relayConversationId, rounds, modelCalls: rounds * 2 + 1 };
    });
    electron_1.ipcMain.handle("orchestrator:cancel", async (_event, runId) => {
        const run = runs.get(runId);
        if (!run)
            return { cancelled: false };
        run.cancelled = true;
        if (run.activeAgent === "codex")
            await (0, runtime_backend_1.cancelCodexBackgroundTurn)(run.input.codexRuntimeId);
        if (run.activeAgent === "claude")
            await (0, claude_local_backend_1.cancelClaudeBackgroundTurn)(run.input.claudeRuntimeId);
        return { cancelled: true };
    });
    electron_1.ipcMain.handle("orchestrator:status", (_event, runId) => {
        if (runId) {
            const run = runs.get(runId);
            return run ? { runId: run.id, conversationId: run.relayConversationId, activeAgent: run.activeAgent, cancelled: run.cancelled, topic: run.input.topic, rounds: run.input.rounds } : null;
        }
        return [...runs.values()].map(run => ({ runId: run.id, conversationId: run.relayConversationId, activeAgent: run.activeAgent, cancelled: run.cancelled, topic: run.input.topic, rounds: run.input.rounds }));
    });
}
