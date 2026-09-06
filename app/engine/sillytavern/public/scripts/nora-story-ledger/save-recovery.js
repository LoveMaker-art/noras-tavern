function isLedgerRejection(error) {
    return typeof error?.code === 'string' && error.code.startsWith('NORA_LEDGER_');
}

/**
 * Creates a target-aware recovery boundary for rejected legacy chat saves.
 * The server remains authoritative: a rejected in-memory mutation is discarded
 * by reloading the same chat, while navigation to another chat is left alone.
 *
 * @param {{currentTarget: () => string|null, reload: () => Promise<void>}} dependencies Recovery dependencies.
 */
export function createLedgerSaveRecovery({ currentTarget, reload }) {
    const recoveries = new Map();
    const recoveredTargets = new Set();

    return async function recoverLedgerSave(error, target) {
        if (!isLedgerRejection(error) || !target || currentTarget() !== target) return false;
        if (recoveredTargets.has(target)) return false;
        if (!recoveries.has(target)) {
            const recovery = Promise.resolve()
                .then(async () => {
                    // Navigation can complete while this recovery is waiting for
                    // the current microtask. Never reload a newly selected World.
                    if (currentTarget() !== target) return false;
                    await reload();
                    if (currentTarget() !== target) return false;
                    recoveredTargets.add(target);
                    return true;
                })
                .finally(() => recoveries.delete(target));
            recoveries.set(target, recovery);
        }
        return await recoveries.get(target);
    };
}
