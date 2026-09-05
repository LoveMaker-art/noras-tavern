import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TRACE_ID_LENGTH = 100;
const MAX_STRING_LENGTH = 200;
const MAX_RESOURCES = 100;
const MAX_SERIES_ITEMS = 120;
const SAFE_TRACE_ID = /^[A-Za-z0-9:._-]+$/;
const METRIC_SCALARS = new Set([
    'instrumentationVersion',
    'sessionId',
    'startedAt',
    'startedEpoch',
    'capturedAt',
    'readyAt',
    'shellReadyAt',
    'criticalExtensionsReadyAt',
    'extensionsReadyAt',
]);

function finiteNumber(value) {
    return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : undefined;
}

function boundedString(value, maxLength = MAX_STRING_LENGTH) {
    return typeof value === 'string' ? value.slice(0, maxLength) : undefined;
}

function normalizeResourceName(value) {
    const raw = String(value || '');
    if (/^(?:data|blob):/i.test(raw)) return '[inline-resource]';
    try {
        const url = new URL(raw, 'http://nora.invalid');
        return url.pathname.slice(0, MAX_STRING_LENGTH) || '/';
    } catch {
        return raw.split(/[?#]/, 1)[0].slice(0, MAX_STRING_LENGTH);
    }
}

function sanitizeScalarRecord(value, { resource = false } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) continue;
        if (key === 'name' && resource) {
            result.name = normalizeResourceName(raw);
        } else if (typeof raw === 'string') {
            result[key] = raw.slice(0, MAX_STRING_LENGTH);
        } else if (typeof raw === 'number' && Number.isFinite(raw)) {
            result[key] = Math.round(raw * 10) / 10;
        } else if (typeof raw === 'boolean') {
            result[key] = raw;
        }
    }
    return result;
}

function sanitizeSeries(value, limit, options) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, limit).map(item => sanitizeScalarRecord(item, options)).filter(Boolean);
}

function sanitizeNavigation(value) {
    return sanitizeScalarRecord(value);
}

export function normalizeTraceId(value) {
    const traceId = String(value || '').trim();
    if (!traceId || traceId.length > MAX_TRACE_ID_LENGTH || !SAFE_TRACE_ID.test(traceId)) return '';
    return traceId;
}

export function normalizeClientMetricPayload(payload, {
    user = 'unknown',
    receivedAt = new Date().toISOString(),
} = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const source = payload.metrics && typeof payload.metrics === 'object' && !Array.isArray(payload.metrics)
        ? payload.metrics
        : {};
    const traceId = normalizeTraceId(source.sessionId || payload.traceId);
    if (!traceId) return null;
    const metrics = {};
    for (const key of METRIC_SCALARS) {
        const value = source[key];
        if (typeof value === 'number') metrics[key] = finiteNumber(value);
        else if (typeof value === 'string') metrics[key] = boundedString(value);
    }
    metrics.sessionId = traceId;
    metrics.navigation = sanitizeNavigation(source.navigation);
    metrics.client = sanitizeScalarRecord(source.client);
    metrics.steps = sanitizeSeries(source.steps, MAX_SERIES_ITEMS);
    metrics.extensions = sanitizeSeries(source.extensions, MAX_SERIES_ITEMS);
    metrics.extensionBatches = sanitizeSeries(source.extensionBatches, MAX_SERIES_ITEMS);
    metrics.milestones = sanitizeSeries(source.milestones, MAX_SERIES_ITEMS);
    metrics.longTasks = sanitizeSeries(source.longTasks, MAX_SERIES_ITEMS);
    metrics.resourceEvents = sanitizeSeries(source.resourceEvents, MAX_SERIES_ITEMS);
    metrics.resources = sanitizeSeries(source.resources, MAX_RESOURCES, { resource: true });
    return {
        schemaVersion: SCHEMA_VERSION,
        kind: 'client-summary',
        receivedAt,
        user: boundedString(user, 80) || 'unknown',
        phase: boundedString(payload.phase, 64) || 'unknown',
        traceId,
        release: boundedString(payload.release, 100) || '',
        metrics,
    };
}

function telemetryPaths(directories) {
    const root = directories?.root;
    if (!root || typeof root !== 'string') throw new Error('Nora telemetry requires a user data root.');
    const directory = path.join(root, 'nora-telemetry');
    return {
        directory,
        active: path.join(directory, 'performance.ndjson'),
        rotated: path.join(directory, 'performance.1.ndjson'),
    };
}

export function createNoraTelemetryWriter({ maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
    const queues = new Map();

    async function write(directories, event) {
        const paths = telemetryPaths(directories);
        const line = `${JSON.stringify(event)}\n`;
        await fs.mkdir(paths.directory, { recursive: true });
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
        await fs.appendFile(paths.active, line, 'utf8');
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
    });
}

export const noraTelemetryWriter = createNoraTelemetryWriter();

export function createNoraTraceMiddleware({ writer = noraTelemetryWriter } = {}) {
    return function noraTraceMiddleware(request, response, next) {
        const traceId = normalizeTraceId(request.get?.('x-nora-trace-id'));
        if (!traceId) return next();
        const startedAt = performance.now();
        let responseBytes = 0;
        const originalWrite = response.write.bind(response);
        const originalEnd = response.end.bind(response);
        response.write = function tracedWrite(chunk, ...args) {
            if (chunk) responseBytes += Buffer.byteLength(chunk);
            return originalWrite(chunk, ...args);
        };
        response.end = function tracedEnd(chunk, ...args) {
            if (chunk) responseBytes += Buffer.byteLength(chunk);
            if (!response.headersSent) {
                const existing = String(response.getHeader('Server-Timing') || '').trim();
                const total = `nora_total;dur=${(performance.now() - startedAt).toFixed(1)}`;
                response.setHeader('Server-Timing', existing ? `${existing}, ${total}` : total);
            }
            return originalEnd(chunk, ...args);
        };
        response.once('finish', () => {
            const event = {
                schemaVersion: SCHEMA_VERSION,
                kind: 'server-span',
                receivedAt: new Date().toISOString(),
                user: boundedString(request.user?.profile?.handle, 80) || 'unknown',
                traceId,
                method: boundedString(request.method, 12) || '',
                path: normalizeResourceName(request.originalUrl || request.url),
                status: response.statusCode,
                durationMs: finiteNumber(performance.now() - startedAt),
                responseBytes,
            };
            void writer.append(request.user?.directories, event)
                .catch(error => console.warn('[Nora telemetry] Could not persist server span:', error.message));
        });
        return next();
    };
}
