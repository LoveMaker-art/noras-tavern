import { scopeKey, scopeOf } from './history.js';

export async function withRegenerationRollback(getContext, generate, render) {
    const rollback = regenerationRollback(getContext);
    const restoreReply = async failure => {
        if (!rollback(failure)) return;
        try { await render(); } catch (error) { console.warn('[Chat] Could not render the preserved reply:', error); }
    };
    try {
        const result = await generate();
        if (result === undefined) await restoreReply();
        return result;
    } catch (error) {
        await restoreReply(error);
        throw error;
    }
}

/** Preserve the pre-generation reply in memory independently of disk backups.
 * Never roll back a different World, an edited prefix or appended messages. */
export function regenerationRollback(getContext) {
    const context = getContext(), scope = scopeOf(context.chatMetadata);
    const messages = context.chat, count = messages.length, last = messages.at(-1);
    if (!scope || !last || last.is_user) return () => false;
    const original = structuredClone(last);
    const prefix = JSON.stringify(context.chat.slice(0, -1));
    return failure => {
        if (failure?.phase === 'save') return false;
        const current = getContext();
        if (scopeKey(scopeOf(current.chatMetadata)) !== scopeKey(scope)
            || current.chat !== messages || current.chat.length < count - 1 || current.chat.length > count
            || JSON.stringify(current.chat.slice(0, count - 1)) !== prefix
            || current.chat.length === count && current.chat.at(-1)?.is_user) return false;
        if (current.chat.length === count && JSON.stringify(current.chat.at(-1)) === JSON.stringify(original)) return false;
        current.chat.splice(count - 1, current.chat.length - count + 1, structuredClone(original));
        return true;
    };
}
