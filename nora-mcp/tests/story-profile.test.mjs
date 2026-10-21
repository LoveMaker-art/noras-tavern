import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NoraControlPlane } from '../dist/nora-control-plane.js';
import { createToolRegistrar } from '../dist/tool-policy.js';

test('explicit Nora reflection uses the manual endpoint with model deadline and never enables automatic reflection', async () => {
    const calls = [];
    const plane = new NoraControlPlane({ modelTimeoutMs: 360000 }, { post: async (...args) => { calls.push(args); return { ok: true, extraction_complete: true }; } });
    await plane.storyCheckpoint('world', true);
    assert.deepEqual(calls, [['/api/nora-story-profile/reflect', { world_id: 'world' }, { timeoutMs: 360000 }]]);
    assert.equal(calls.some(([route]) => route.endsWith('/settings') || route.endsWith('/checkpoint')), false);
});

test('manual reflection still rejects missing confirmation before making any request', async () => {
    const calls = [];
    const plane = new NoraControlPlane({ modelTimeoutMs: 360000 }, { post: async (...args) => calls.push(args) });
    await assert.rejects(plane.storyCheckpoint('world'), /requires confirm/);
    assert.deepEqual(calls, []);
});

test('MCP model-call permission remains required independently of write confirmation', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-mcp-profile-policy-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = [];
    const http = { get: async route => { calls.push(['GET', route]); return { userDataRoot: root }; },
        post: async (...args) => { calls.push(['POST', ...args]); return { ok: true }; } };
    const config = { mode: 'operator', userDataRoot: root, modelTimeoutMs: 360000 };
    const plane = new NoraControlPlane(config, http);
    let invoke;
    const register = createToolRegistrar({ registerTool: (_name, _definition, handler) => { invoke = handler; } }, config, http);
    register('nora.story.checkpoint', 'Manual reflection', {}, async args => ({ content: [{ type: 'text', text: JSON.stringify(await plane.storyCheckpoint(args.worldId, args.confirm)) }] }));
    const denied = await invoke({ worldId: 'world', confirm: true });
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).code, 'NORA_MODEL_CALL_NOT_AUTHORIZED');
    assert.deepEqual(calls, []);
    const accepted = await invoke({ worldId: 'world', confirm: true, allowModelCall: true });
    assert.notEqual(accepted.isError, true);
    assert.equal(calls[1][1], '/api/nora-story-profile/reflect');
});

test('checkpoint status remains read-only and preserves encoded world identity', async () => {
    const calls = [];
    const plane = new NoraControlPlane({}, { get: async (...args) => calls.push(args) });
    await plane.storyCheckpointStatus('world/with space');
    assert.deepEqual(calls, [['/api/nora-story-profile/checkpoint/world%2Fwith%20space']]);
});

test('retry is sent only for an explicit new potentially paid retry request', async () => {
    const calls = [];
    const plane = new NoraControlPlane({ modelTimeoutMs: 360000 }, { post: async (...args) => calls.push(args) });
    await plane.storyCheckpoint('world', true, true);
    assert.deepEqual(calls, [['/api/nora-story-profile/reflect', { world_id: 'world', retry: true }, { timeoutMs: 360000 }]]);
});
