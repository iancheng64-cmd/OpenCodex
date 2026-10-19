"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentRelayHub = exports.AgentRelayHub = void 0;
const node_crypto_1 = require("node:crypto");
const MAX_SESSIONS = 64;
const MAX_MESSAGES_PER_SESSION = 400;
const MAX_MESSAGE_CHARS = 32_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const peerOf = (role) => role === "codex" ? "claude" : "codex";
function stringArg(value, name, max = MAX_MESSAGE_CHARS) {
    if (typeof value !== "string")
        throw new Error(`${name} must be a string`);
    const text = value.trim();
    if (!text || text.length > max)
        throw new Error(`${name} must contain 1-${max} characters`);
    return text;
}
function intArg(value, fallback, min, max) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < min || value > max)
        throw new Error(`Expected an integer between ${min} and ${max}`);
    return value;
}
/**
 * Process-local relay shared by the Codex and Claude LocalToolHost instances.
 * It does not invoke either model by itself; it gives both MCP clients a bounded
 * mailbox + long-poll transport so the models can exchange turns directly.
 */
class AgentRelayHub {
    sessions = new Map();
    presence = new Map([["codex", 0], ["claude", 0]]);
    waiters = new Map();
    attach(role) {
        this.presence.set(role, (this.presence.get(role) || 0) + 1);
        let detached = false;
        return () => {
            if (detached)
                return;
            detached = true;
            this.presence.set(role, Math.max(0, (this.presence.get(role) || 0) - 1));
        };
    }
    status(role) {
        this.prune();
        return {
            role,
            peer: peerOf(role),
            peerConnected: (this.presence.get(peerOf(role)) || 0) > 0,
            activeSessions: this.list(role)
        };
    }
    create(role, topic) {
        this.prune();
        if (this.sessions.size >= MAX_SESSIONS)
            this.dropOldestClosedOrIdle();
        if (this.sessions.size >= MAX_SESSIONS)
            throw new Error("Too many active agent relay sessions");
        const normalizedTopic = topic === undefined ? undefined : stringArg(topic, "topic", 500);
        const now = Date.now();
        const session = {
            id: (0, node_crypto_1.randomUUID)(),
            ...(normalizedTopic ? { topic: normalizedTopic } : {}),
            createdAt: now,
            updatedAt: now,
            nextSeq: 1,
            messages: []
        };
        this.sessions.set(session.id, session);
        return {
            conversationId: session.id,
            role,
            peer: peerOf(role),
            topic: session.topic,
            peerConnected: (this.presence.get(peerOf(role)) || 0) > 0,
            instructions: "Send a message with agentbridge_peer_send. The peer can discover it with agentbridge_peer_status, then read or wait for replies."
        };
    }
    list(role) {
        const peer = peerOf(role);
        return [...this.sessions.values()]
            .filter(session => !session.closedAt)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 20)
            .map(session => ({
            conversationId: session.id,
            topic: session.topic,
            updatedAt: session.updatedAt,
            messageCount: session.messages.length,
            latestSeq: session.messages.at(-1)?.seq || 0,
            inboundCount: session.messages.filter(message => message.sender === peer).length
        }));
    }
    send(role, conversationId, message) {
        const session = this.get(conversationId);
        if (session.closedAt)
            throw new Error("Agent relay session is closed");
        const text = stringArg(message, "message");
        const item = {
            id: (0, node_crypto_1.randomUUID)(),
            seq: session.nextSeq++,
            sender: role,
            recipient: peerOf(role),
            text,
            createdAt: Date.now()
        };
        session.messages.push(item);
        if (session.messages.length > MAX_MESSAGES_PER_SESSION)
            session.messages.splice(0, session.messages.length - MAX_MESSAGES_PER_SESSION);
        session.updatedAt = item.createdAt;
        this.wake(session.id);
        return {
            conversationId: session.id,
            deliveredTo: item.recipient,
            seq: item.seq,
            messageId: item.id,
            peerConnected: (this.presence.get(item.recipient) || 0) > 0
        };
    }
    read(role, conversationId, afterSeq, limit) {
        const session = this.get(conversationId);
        const after = intArg(afterSeq, 0, 0, Number.MAX_SAFE_INTEGER);
        const count = intArg(limit, 50, 1, 100);
        const inbound = session.messages.filter(message => message.recipient === role && message.seq > after).slice(0, count);
        return {
            conversationId: session.id,
            role,
            peer: peerOf(role),
            closed: Boolean(session.closedAt),
            messages: inbound,
            cursor: session.messages.at(-1)?.seq || after,
            hasMore: session.messages.some(message => message.recipient === role && message.seq > (inbound.at(-1)?.seq ?? after))
        };
    }
    transcript(role, conversationId, limit) {
        const session = this.get(conversationId);
        const count = intArg(limit, 100, 1, 400);
        return {
            conversationId: session.id,
            role,
            peer: peerOf(role),
            topic: session.topic,
            closed: Boolean(session.closedAt),
            messages: session.messages.slice(-count)
        };
    }
    async wait(role, conversationId, afterSeq, timeoutMs, signal) {
        const session = this.get(conversationId);
        const after = intArg(afterSeq, 0, 0, Number.MAX_SAFE_INTEGER);
        const timeout = intArg(timeoutMs, 30_000, 100, 55_000);
        const immediate = this.read(role, session.id, after, 100);
        if (immediate.messages.length || immediate.closed)
            return { ...immediate, timedOut: false };
        if (signal?.aborted)
            throw new Error("Request cancelled");
        await new Promise((resolve, reject) => {
            let settled = false;
            const listeners = this.waiters.get(session.id) || new Set();
            this.waiters.set(session.id, listeners);
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                listeners.delete(finish);
                if (!listeners.size)
                    this.waiters.delete(session.id);
                resolve();
            };
            const abort = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                listeners.delete(finish);
                if (!listeners.size)
                    this.waiters.delete(session.id);
                reject(new Error("Request cancelled"));
            };
            const timer = setTimeout(finish, timeout);
            listeners.add(finish);
            signal?.addEventListener("abort", abort, { once: true });
        });
        const result = this.read(role, session.id, after, 100);
        return { ...result, timedOut: result.messages.length === 0 && !result.closed };
    }
    close(role, conversationId) {
        const session = this.get(conversationId);
        if (!session.closedAt) {
            session.closedAt = Date.now();
            session.updatedAt = session.closedAt;
            this.wake(session.id);
        }
        return { conversationId: session.id, closed: true, closedBy: role };
    }
    get(value) {
        const id = stringArg(value, "conversation_id", 128);
        const session = this.sessions.get(id);
        if (!session)
            throw new Error("Unknown agent relay session");
        return session;
    }
    wake(id) {
        for (const resolve of [...(this.waiters.get(id) || [])])
            resolve();
    }
    prune() {
        const cutoff = Date.now() - SESSION_TTL_MS;
        for (const [id, session] of this.sessions) {
            if (session.updatedAt < cutoff) {
                this.sessions.delete(id);
                this.wake(id);
            }
        }
    }
    dropOldestClosedOrIdle() {
        const candidates = [...this.sessions.values()].sort((a, b) => {
            const aClosed = a.closedAt ? 0 : 1;
            const bClosed = b.closedAt ? 0 : 1;
            return aClosed - bClosed || a.updatedAt - b.updatedAt;
        });
        const oldest = candidates[0];
        if (oldest) {
            this.sessions.delete(oldest.id);
            this.wake(oldest.id);
        }
    }
}
exports.AgentRelayHub = AgentRelayHub;
exports.agentRelayHub = new AgentRelayHub();
