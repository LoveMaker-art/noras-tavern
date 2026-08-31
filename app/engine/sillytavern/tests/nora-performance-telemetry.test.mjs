import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createNoraTelemetryWriter,
    normalizeClientMetricPayload,
    normalizeTraceId,
} from '../src/nora-performance-telemetry.js';

test('normalizes client telemetry into a bounded privacy-safe event', () => {
    const payload = {
        phase: 'nora-usable',
        metrics: {
            sessionId: 'trace-123',
            capturedAt: 6_200,
            resources: Array.from({ length: 180 }, (_, index) => ({
                name: index === 0
                    ? 'data:text/javascript;base64,secret-payload'
                    : `https://example.test/api/chats/get?token=secret-${index}`,
                duration: index,
                transferSize: 100,
                decodedBodySize: 200,
                source: 'network',
            })),
            milestones: Array.from({ length: 200 }, (_, index) => ({ name: `step-${index}`, at: index })),
            accidentalSecret: 'must-not-be-persisted',
        },
    };

    const event = normalizeClientMetricPayload(payload, {
        user: 'default-user',
        receivedAt: '2026-08-30T00:00:00.000Z',
    });

    assert.equal(event.kind, 'client-summary');
    assert.equal(event.traceId, 'trace-123');
    assert.equal(event.metrics.resources.length, 100);
    assert.equal(event.metrics.resources[0].name, '[inline-resource]');
    assert.equal(event.metrics.resources[1].name, '/api/chats/get');
    assert.equal(event.metrics.milestones.length, 120);
    assert.equal('accidentalSecret' in event.metrics, false);
    assert.ok(Buffer.byteLength(JSON.stringify(event), 'utf8') < 96 * 1024);
});

test('accepts only bounded trace identifiers', () => {
    assert.equal(normalizeTraceId(' boot:abc-123 '), 'boot:abc-123');
    assert.equal(normalizeTraceId('has spaces'), '');
    assert.equal(normalizeTraceId('x'.repeat(101)), '');
});

test('writes structured NDJSON and rotates before exceeding the configured file budget', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-telemetry-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const writer = createNoraTelemetryWriter({ maxFileBytes: 220 });
    const directories = { root };
    const event = {
        schemaVersion: 1,
        kind: 'server-span',
        receivedAt: '2026-08-30T00:00:00.000Z',
        traceId: 'trace-123',
        method: 'GET',
        path: '/api/nora-worlds-v2',
        status: 200,
        durationMs: 12.4,
    };

    await writer.append(directories, event);
    await writer.append(directories, { ...event, traceId: 'trace-456' });

    const telemetryDirectory = path.join(root, 'nora-telemetry');
    const active = await fs.readFile(path.join(telemetryDirectory, 'performance.ndjson'), 'utf8');
    const rotated = await fs.readFile(path.join(telemetryDirectory, 'performance.1.ndjson'), 'utf8');
    assert.equal(JSON.parse(active.trim()).traceId, 'trace-456');
    assert.equal(JSON.parse(rotated.trim()).traceId, 'trace-123');
});
