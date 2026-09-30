import crypto from 'node:crypto';
import path from 'node:path';
import { scopeKey } from '../../public/scripts/nora-story-ledger/history.js';

export function ledgerStatePath(userRoot, scope) {
    const filename = `${crypto.createHash('sha256').update(scopeKey(scope)).digest('hex')}.json`;
    return path.join(userRoot, 'nora-story-ledger', filename);
}

/** The chat's atomic restore receipt is authoritative. A crash before any
 * later ledger write still invalidates active, pending and imported memories. */
export function ledgerAfterRestore(state, metadata) {
    const receipt = metadata?.nora_restore;
    if (!receipt?.id || receipt.id === state?.restoreId) return state;
    return { version: 1, enabled: receipt.ledgerEnabled !== false, restoreId: receipt.id,
        waitForHistory: receipt.historySignature, active: null, pending: null, imported: null, lastError: null };
}
