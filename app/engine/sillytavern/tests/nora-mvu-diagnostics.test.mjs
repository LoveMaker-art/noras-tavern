import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createMvuDiagnosticStore,
    normalizeMvuDiagnostic,
} from '../src/nora-mvu-diagnostics.js';
import { reportMvuDiagnostic } from '../../../native-extensions/nora-mvu/diagnostics-reporter.js';

test('MVU diagnostics preserve actionable evidence while redacting credentials and bounding content', () => {
    const event = normalizeMvuDiagnostic({
        kind: 'mvu-update-failed',
        identity: 'session:test',
        chatId: 'chat:test',
        occurredAt: 1788318000000,
        code: 'MVU_COMMAND_VALIDATION_FAILED',
        stage: 'validation',
        summary: `Authorization: Bearer secret-token api_key=top-secret ${'x'.repeat(2000)}`,
        commandCount: 2,
        attempt: 2,
        durationMs: 8331.49,
        validationErrors: [
            { commandType: '_.set', reason: 'path gender expected enum token=private' },
        ],
    }, { user: 'default-user', receivedAt: '2026-09-02T00:00:00.000Z' });

    assert.equal(event.kind, 'mvu-update-failed');
    assert.equal(event.code, 'MVU_COMMAND_VALIDATION_FAILED');
    assert.equal(event.stage, 'validation');
    assert.equal(event.commandCount, 2);
    assert.equal(event.durationMs, 8331.5);
    assert.match(event.summary, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(event), /secret-token|top-secret|private/);
    assert.ok(event.summary.length <= 800);
    assert.deepEqual(event.validationErrors, [{ commandType: '_.set', reason: 'path gender expected enum token=[redacted]' }]);
    assert.equal(normalizeMvuDiagnostic({ code: 'MVU_UPDATE_FAILED' }).attempt, null);
});

test('MVU diagnostic store persists bounded NDJSON and returns newest events first', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-mvu-diagnostics-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = createMvuDiagnosticStore({ maxFileBytes: 700 });
    const directories = { root };
    const base = normalizeMvuDiagnostic({
        kind: 'mvu-update-failed', identity: 'session:a', code: 'MVU_NO_UPDATE_COMMAND',
        stage: 'validation', summary: 'No command.', occurredAt: 1,
    });

    await store.append(directories, base);
    await store.append(directories, { ...base, identity: 'session:b', occurredAt: 2 });
    const recent = await store.recent(directories, 10);

    assert.equal(recent[0].identity, 'session:b');
    assert.equal(recent[1].identity, 'session:a');
    const text = await fs.readFile(path.join(root, 'nora-telemetry', 'mvu-diagnostics.ndjson'), 'utf8');
    assert.equal(text.trim().split('\n').length, 2);
});

test('browser reporter posts the current chat identity without exposing unrelated settings', async () => {
    const requests = [];
    const result = await reportMvuDiagnostic({ code: 'MVU_REQUEST_FAILED', summary: 'upstream unavailable' }, {
        getContext: () => ({
            chatId: 'chat:active',
            extensionSettings: { mvu_settings: { api_key: 'must-not-leak' } },
            getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' }),
        }),
        fetcher: async (url, options) => {
            requests.push({ url, options, body: JSON.parse(options.body) });
            return { ok: true, status: 204 };
        },
    });

    assert.equal(result, true);
    assert.equal(requests[0].url, '/api/nora-mvu-diagnostics/report');
    assert.equal(requests[0].body.chatId, 'chat:active');
    assert.equal(JSON.stringify(requests[0].body).includes('must-not-leak'), false);
});
