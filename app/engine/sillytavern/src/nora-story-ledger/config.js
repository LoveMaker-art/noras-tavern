export const LEDGER_DEFAULTS = Object.freeze({ contextLimitOverride: null, outputTokenLimit: 2048, timeoutSeconds: 300 });

export function ledgerConfig(value = {}) {
    const result = { ...LEDGER_DEFAULTS, ...value };
    for (const [key, min, max] of [['contextLimitOverride', 512, 2000000], ['outputTokenLimit', 128, 16384], ['timeoutSeconds', 60, 1800]]) {
        if (key === 'contextLimitOverride' && result[key] === null) continue;
        if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max) {
            throw Object.assign(new Error(`Invalid ledger setting: ${key}`), { code: 'NORA_LEDGER_CONFIGURATION_INVALID', status: 400 });
        }
    }
    return result;
}
