import crypto from 'node:crypto';
import fs from 'node:fs';
import { scopeKey } from '../public/scripts/nora-story-ledger/history.js';

const runtimes = new Map();
const conflict = code => Object.assign(new Error(code), { code, status: 409 });

/** Single-service ownership, not a heartbeat-based guess that a page is idle.
 * Expiration fences late callers; an already admitted write must settle before
 * another owner enters. Restarts deliberately invalidate all browser tokens. */
export function createChatSessionOperations({ now = Date.now, leaseMs = 120000 } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('Positive lease duration required.');
    const sessions = new Map();
    const listeners = new Set();
    const notify = () => { for (const listener of listeners) listener(); };
    function keyOf(scope) {
        if (![scope?.worldId, scope?.sessionId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(value))) throw conflict('NORA_CHAT_OPERATION_INVALID');
        return scopeKey(scope);
    }
    function current(key) {
        const entry = sessions.get(key);
        if (entry && !entry.writes && (entry.ended || entry.expiresAt <= now())) {
            sessions.delete(key);
            queueMicrotask(notify);
            return null;
        }
        return entry;
    }
    function admit(scope, kind, expiresAt) {
        const key = keyOf(scope);
        if (current(key)) throw conflict('NORA_CHAT_OPERATION_BUSY');
        for (const candidate of sessions.keys()) current(candidate);
        if (sessions.size >= 64) throw conflict('NORA_CHAT_OPERATION_LIMIT');
        const entry = { token: crypto.randomUUID(), kind, expiresAt, writes: 0, ended: false };
        sessions.set(key, entry);
        return { key, entry };
    }
    function verify(scope, token) {
        const entry = current(keyOf(scope));
        if (!token || !entry || entry.token !== token || entry.ended || entry.expiresAt <= now()) throw conflict('NORA_CHAT_OPERATION_STALE');
        return entry;
    }
    async function write(scope, token, operation) {
        const key = keyOf(scope);
        let entry = current(key);
        if (token) entry = verify(scope, token);
        else if (entry && entry.kind !== 'save') throw conflict('NORA_CHAT_OPERATION_BUSY');
        else if (!entry) {
            ({ entry } = admit(scope, 'save', Infinity));
            entry.ended = true;
        }
        entry.writes++;
        try { return await operation(); } finally { entry.writes--; current(key); }
    }
    async function exclusive(scope, kind, operation) {
        const { key, entry } = admit(scope, kind, Infinity);
        entry.writes++;
        try { return await operation(); } finally { entry.writes--; entry.ended = true; current(key); }
    }
    return Object.freeze({
        begin(scope, kind) {
            if (!['generation', 'mvu'].includes(kind)) throw conflict('NORA_CHAT_OPERATION_INVALID');
            const { entry } = admit(scope, kind, now() + leaseMs);
            notify();
            return { token: entry.token, expiresAt: entry.expiresAt };
        },
        renew(scope, token) {
            const entry = verify(scope, token);
            entry.expiresAt = now() + leaseMs;
            return { expiresAt: entry.expiresAt };
        },
        end(scope, token) {
            const key = keyOf(scope), entry = current(key);
            if (!token || !entry || entry.token !== token) return false;
            entry.ended = true;
            current(key);
            return true;
        },
        write,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        hasGeneration() {
            for (const key of sessions.keys()) current(key);
            return [...sessions.values()].some(entry => !entry.ended && ['generation', 'mvu'].includes(entry.kind));
        },
        restore: (scope, operation) => exclusive(scope, 'restore', operation),
        removeWorld(world, operation) {
            const scopes = world.sessions.items.map(item => ({ worldId: world.world_id, sessionId: item.session_id }));
            const acquire = index => index === scopes.length ? operation()
                : exclusive(scopes[index], 'delete', () => acquire(index + 1));
            return acquire(0);
        },
    });
}

export function chatSessionOperations(directories) {
    const root = fs.realpathSync(directories.root);
    if (!runtimes.has(root)) runtimes.set(root, createChatSessionOperations());
    return runtimes.get(root);
}
