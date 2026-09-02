import fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_VALIDATION_ERRORS = 12;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const SAFE_STAGE = /^[a-z][a-z0-9_-]{0,79}$/;

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
}

function redact(value, maxLength) {
    return String(value ?? '')
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/\b(api[-_ ]?key|authorization|token|secret)(\s*[:=]\s*)([^\s,;]+)/gi, '$1$2[redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .slice(0, maxLength);
}

function identifier(value) {
    return redact(value, 160).replace(/[^A-Za-z0-9:._-]/g, '_');
}

function validationErrors(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_VALIDATION_ERRORS).map(item => ({
        commandType: redact(item?.commandType || item?.command || 'unknown', 80),
        reason: redact(item?.reason || item?.content || 'validation failed', 400),
    }));
}

export function normalizeMvuDiagnostic(payload, {
    user = 'unknown',
    receivedAt = new Date().toISOString(),
} = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const code = String(payload.code || 'MVU_UPDATE_FAILED');
    const stage = String(payload.stage || 'update');
    return {
        schemaVersion: SCHEMA_VERSION,
        kind: 'mvu-update-failed',
        receivedAt,
        occurredAt: finiteNumber(payload.occurredAt),
        user: redact(user, 80) || 'unknown',
        identity: identifier(payload.identity),
        chatId: identifier(payload.chatId),
        code: SAFE_CODE.test(code) ? code : 'MVU_UPDATE_FAILED',
        stage: SAFE_STAGE.test(stage) ? stage : 'update',
        summary: redact(payload.summary || 'MVU update failed.', 800),
        commandCount: finiteNumber(payload.commandCount),
        validationErrors: validationErrors(payload.validationErrors),
        attempt: finiteNumber(payload.attempt),
        durationMs: finiteNumber(payload.durationMs),
    };
}

function pathsFor(directories) {
    const root = directories?.root;
    if (!root || typeof root !== 'string') throw new Error('MVU diagnostics require a user data root.');
    const directory = path.join(root, 'nora-telemetry');
    return {
        directory,
        active: path.join(directory, 'mvu-diagnostics.ndjson'),
        rotated: path.join(directory, 'mvu-diagnostics.1.ndjson'),
    };
}

async function readLines(filePath) {
    try {
        return (await fs.readFile(filePath, 'utf8')).split('\n').filter(Boolean);
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

export function createMvuDiagnosticStore({ maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
    const queues = new Map();

    async function write(directories, event) {
        const paths = pathsFor(directories);
        const line = `${JSON.stringify(event)}\n`;
        await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
        let currentSize = 0;
        try {
            currentSize = (await fs.stat(paths.active)).size;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        if (currentSize > 0 && currentSize + Buffer.byteLength(line, 'utf8') > maxFileBytes) {
            await fs.rm(paths.rotated, { force: true });
            await fs.rename(paths.active, paths.rotated);
        }
        await fs.appendFile(paths.active, line, { encoding: 'utf8', mode: 0o600 });
    }

    return Object.freeze({
        append(directories, event) {
            const key = directories?.root || '';
            const previous = queues.get(key) || Promise.resolve();
            const pending = previous.catch(() => {}).then(() => write(directories, event));
            queues.set(key, pending);
            void pending.finally(() => {
                if (queues.get(key) === pending) queues.delete(key);
            }).catch(() => {});
            return pending;
        },
        async recent(directories, limit = 20) {
            const paths = pathsFor(directories);
            const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
            const [rotated, active] = await Promise.all([readLines(paths.rotated), readLines(paths.active)]);
            return [...rotated, ...active].slice(-boundedLimit).reverse().flatMap((line) => {
                try { return [JSON.parse(line)]; } catch { return []; }
            });
        },
    });
}

export const mvuDiagnosticStore = createMvuDiagnosticStore();
