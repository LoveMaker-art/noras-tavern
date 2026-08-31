import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scopeKey } from '../../public/scripts/nora-story-ledger/history.js';

export function ledgerStatePath(userRoot, scope) {
    const filename = `${crypto.createHash('sha256').update(scopeKey(scope)).digest('hex')}.json`;
    return path.join(userRoot, 'nora-story-ledger', filename);
}

// Invoked only by the existing World-owned Session deletion operation.
export function removeSessionLedger(userRoot, scope) {
    const filePath = ledgerStatePath(userRoot, scope);
    try { fs.unlinkSync(filePath); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
