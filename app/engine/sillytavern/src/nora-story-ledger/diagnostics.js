import { createUserLogWriter } from '../nora-log-writer.js';

const writer = createUserLogWriter({ name: 'ledger-diagnostics' });
const fields = ['taskId', 'worldId', 'sessionId', 'startTurn', 'endTurn', 'coveredTurns', 'attempt',
    'phase', 'code', 'elapsedMs', 'inputTokens', 'outputLimit', 'capacity', 'safetyTokens', 'tokenCountSource',
    'status', 'finishReason', 'outputChars', 'completionTokens'];

export function ledgerDiagnostic(event, details) {
    const result = { at: Date.now(), event };
    for (const key of fields) {
        const value = details[key];
        if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
        else if (typeof value === 'string' && /^[A-Za-z0-9:_-]{1,192}$/.test(value)) result[key] = value;
    }
    return result;
}

export function reportLedger(directories, event, details) {
    const entry = ledgerDiagnostic(event, details);
    console.info('[Story Ledger]', entry);
    void writer.append(directories, entry).catch(() => console.warn('[Story Ledger] diagnostic-write-failed'));
}
