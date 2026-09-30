import { scopeKey } from './history.js';

const stale = () => Object.assign(new Error('聊天操作的占用已失效，请重新加载当前世界后重试。'), { code: 'NORA_CHAT_OPERATION_STALE' });

/** A page owns one renewable token per active Session. Nested MVU joins its
 * generation; release happens after all awaited work, not GENERATION_ENDED. */
export function createChatActivityClient({ current, request, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const entries = new Map();
    function assertLive(entry) {
        if (entry.error || !entry.token) throw entry.error || stale();
    }
    function heartbeat(key, entry) {
        entry.timer = setTimer(async () => {
            if (entries.get(key) !== entry || !entry.refs) return;
            try { await request('renew', { ...entry.scope, token: entry.token }); } catch { if (entry.refs) entry.error = stale(); }
            if (entries.get(key) === entry && entry.refs && !entry.error) heartbeat(key, entry);
        }, 20000);
    }
    async function run(kind, operation) {
        const { scope, revision } = current();
        if (!scope) return operation();
        const key = scopeKey(scope);
        let entry = entries.get(key);
        if (entry?.closing) {
            await entry.closing;
            if (scopeKey(current().scope) !== key) throw stale();
            return run(kind, operation);
        }
        if (!entry) {
            entry = { scope, refs: 0, token: null, error: null, timer: null };
            entries.set(key, entry);
            entry.ready = Promise.resolve().then(async () => {
                const result = await request('begin', { ...scope, kind, baseRevision: revision });
                if (typeof result?.token !== 'string' || !result.token) throw stale();
                entry.token = result.token;
                heartbeat(key, entry);
            });
        }
        entry.refs++;
        try {
            await entry.ready;
            assertLive(entry);
            if (scopeKey(current().scope) !== key) throw stale();
            const result = await operation();
            assertLive(entry);
            if (scopeKey(current().scope) !== key) throw stale();
            return result;
        } finally {
            if (--entry.refs === 0) {
                clearTimer(entry.timer);
                entry.closing = Promise.resolve().then(async () => {
                    if (entry.token) {
                        try { await request('end', { ...scope, token: entry.token }); } catch { /* The server keeps the lease until expiry; never falsify a confirmed save. */ }
                    }
                    if (entries.get(key) === entry) entries.delete(key);
                });
                await entry.closing;
            }
        }
    }
    return Object.freeze({ run, tokenFor(scope) {
        const entry = entries.get(scopeKey(scope));
        if (!entry) return null;
        if (entry.closing) throw stale();
        assertLive(entry);
        return entry.token;
    } });
}

export function pageChatActivity(current, headers) {
    const key = Symbol.for('nora.chat.activity');
    return globalThis[key] ??= createChatActivityClient({ current, request: async (action, data) => {
        const response = await fetch(`/api/chats/operation/${action}`, { method: 'POST', headers: headers(),
            body: JSON.stringify(data), signal: AbortSignal.timeout(15000) });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error('当前聊天正由其他页面操作或版本已变化，请刷新后重试。'), { code: result.code || 'NORA_CHAT_OPERATION_FAILED' });
        return result;
    } });
}
