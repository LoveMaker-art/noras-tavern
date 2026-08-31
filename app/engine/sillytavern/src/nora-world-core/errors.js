export class NoraWorldCoreError extends Error {
    constructor(code, message, { retryable = false, details = {}, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'NoraWorldCoreError';
        this.code = code;
        this.retryable = Boolean(retryable);
        this.details = { ...details };
    }
}

export function serializeWorldCoreError(error) {
    return {
        code: String(error?.code || 'NORA_WORLD_UNKNOWN'),
        message: String(error?.message || 'Unknown World Core error'),
        retryable: Boolean(error?.retryable),
    };
}

export function asWorldCoreError(error, code, message, options = {}) {
    if (error instanceof NoraWorldCoreError) return error;
    return new NoraWorldCoreError(code, message, { ...options, cause: error });
}
