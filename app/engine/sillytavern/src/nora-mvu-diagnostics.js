import fs from 'node:fs/promises';
import { createUserLogWriter, userLogPaths } from './nora-log-writer.js';

const SCHEMA_VERSION = 1;
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
        kind: payload.persisted === true && (payload.kind === 'mvu-update-partial' ||
            (payload.kind === 'mvu-update-unverified' && payload.protocol === 'legacy')) ? payload.kind : 'mvu-update-failed',
        receivedAt,
        occurredAt: finiteNumber(payload.occurredAt),
        user: redact(user, 80) || 'unknown',
        identity: identifier(payload.identity),
        chatId: identifier(payload.chatId),
        code: SAFE_CODE.test(code) ? code : 'MVU_UPDATE_FAILED',
        stage: SAFE_STAGE.test(stage) ? stage : 'update',
        summary: redact(payload.summary || 'MVU update failed.', 800),
        commandCount: finiteNumber(payload.commandCount),
        acceptedCount: finiteNumber(payload.acceptedCount),
        persisted: typeof payload.persisted === 'boolean' ? payload.persisted : null,
        protocol: redact(payload.protocol, 40),
        mode: redact(payload.mode, 40),
        fallbackReason: redact(payload.fallbackReason, 200),
        validationErrors: validationErrors(payload.validationErrors),
        attempt: finiteNumber(payload.attempt),
        durationMs: finiteNumber(payload.durationMs),
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

export function createMvuDiagnosticStore({ maxFileBytes } = {}) {
    const writer = createUserLogWriter({ name: 'mvu-diagnostics', maxFileBytes });

    return Object.freeze({
        append: writer.append,
        async recent(directories, limit = 20) {
            const paths = userLogPaths(directories, 'mvu-diagnostics');
            const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
            const [rotated, active] = await Promise.all([readLines(paths.rotated), readLines(paths.active)]);
            return [...rotated, ...active].slice(-boundedLimit).reverse().flatMap((line) => {
                try { return [JSON.parse(line)]; } catch { return []; }
            });
        },
    });
}

export const mvuDiagnosticStore = createMvuDiagnosticStore();
