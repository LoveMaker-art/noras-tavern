import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { NoraControlPlane } from '../dist/nora-control-plane.js';
import { NoraRequestError } from '../dist/errors.js';
import { loadConfig } from '../dist/config.js';
import { assertInstance, allowedTool } from '../dist/tool-policy.js';
import { StControlPlane } from '../dist/st/control-plane.js';

test('configuration fails closed without data root or with a remote URL; operator is explicit', () => {
    const before = { ...process.env };
    try {
        delete process.env.NORA_MCP_STATE_ROOT;
        assert.throws(loadConfig, /STATE_ROOT/);
        process.env.NORA_MCP_STATE_ROOT = '/tmp/fixture-state';
        delete process.env.NORA_MCP_MODE;
        assert.equal(loadConfig().mode, 'read-only');
        process.env.NORA_MCP_BASE_URL = 'https://remote.example';
        assert.throws(loadConfig, /loopback/);
    } finally { process.env = before; }
});

test('world mutation keeps caller idempotency and uncertain outcomes carry the query ID', async () => {
    const calls = []; const key = 'fixed-request';
    const plane = new NoraControlPlane({}, { post: async (...args) => { calls.push(args); return { operation: { status: 'COMPLETED' } }; } });
    await plane.createWorld({ name: 'Fixture', idempotencyKey: key });
    await plane.createWorld({ name: 'Fixture', idempotencyKey: key });
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0][1].idempotency_key, key);
    plane.http.post = async () => { throw new NoraRequestError('timeout', 'NORA_REQUEST_TIMEOUT', null, 'unknown'); };
    await assert.rejects(plane.importLibrary('fixture.png', key), error => error.details.operationId === 'operation:' + createHash('sha256').update(key).digest('hex').slice(0, 32) && error.details.nextTool === 'nora.operation.get');
});

test('ledger reads use inspect; edits use the Nora atomic endpoint and do not return whole chat', async () => {
    const calls = [];
    const plane = new NoraControlPlane({}, { post: async (...args) => { calls.push(args); return { chat: ['private-whole-chat'], ledger: {} }; } });
    const scope = { worldId: 'world', sessionId: 'session' };
    await plane.ledgerInspect({ ...scope, limit: 0 });
    const result = await plane.editSession({ ...scope, messageId: 1, text: 'edit', expectedSignature: 'sig' });
    assert.equal(calls[0][0], '/api/nora-story-ledger/inspect');
    assert.equal(calls[1][0], '/api/nora-story-ledger/edit');
    assert.equal(calls[1][1].expectedSignature, 'sig');
    assert.equal(result.frontendApplied, false); assert.equal(result.chat, undefined);
    assert.equal(allowedTool('st.chat.message.edit', 'operator'), false);
    assert.equal(allowedTool('nora.capability.settle', 'operator'), false);
});

test('imports stay inside explicit upload root, including symlinks; instance mismatch blocks writes', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nora-mcp-control-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const uploads = path.join(root, 'uploads'); await fs.mkdir(uploads);
    await fs.writeFile(path.join(root, 'outside.json'), '{}');
    await fs.symlink(path.join(root, 'outside.json'), path.join(uploads, 'link.json'));
    await fs.writeFile(path.join(uploads, 'card.json'), '{}');
    let sent = null;
    const plane = new NoraControlPlane({ uploadRoot: uploads }, { post: async (route, body) => { sent = { route, body }; return {}; } });
    await assert.rejects(plane.importWorld({ filePath: path.join(uploads, 'link.json'), idempotencyKey: 'a' }), { code: 'NORA_IMPORT_PATH_DENIED' });
    assert.equal(sent, null);
    await plane.importWorld({ filePath: path.join(uploads, 'card.json'), idempotencyKey: 'b' });
    assert.equal(sent.body.get('avatar').name, 'card.json'); assert.equal(sent.body.get('idempotency_key'), 'b');
    await assert.rejects(assertInstance({ userDataRoot: root }, { get: async () => ({ userDataRoot: uploads }) }), { code: 'NORA_INSTANCE_MISMATCH' });
    await assertInstance({ userDataRoot: root }, { get: async () => ({ userDataRoot: root }) });
});

test('ST registries do not expose raw extension credentials or disguise transport failure as empty configuration', async () => {
    const plane = new StControlPlane({}, { get: async () => [{ name: 'example' }] });
    plane.settings = async () => ({ extension_settings: {
        example: { api_key: 'fixture-secret', enabled: true },
        mvu_settings: { '额外模型解析配置': { '模型名称': 'fixture', 'api密钥': 'fixture-secret' } },
    } });
    const registry = await plane.extensionRegistry();
    assert.equal(registry.extensions[0].hasConfig, true);
    assert.equal(registry.extensions[0].config, undefined);
    assert.equal(JSON.stringify(registry).includes('fixture-secret'), false);
    assert.equal(JSON.stringify(await plane.getMvuSettings()).includes('fixture-secret'), false);
    plane.settings = async () => { throw new NoraRequestError('offline', 'NORA_TRANSPORT_FAILED'); };
    await assert.rejects(plane.extensionRegistry(), { code: 'NORA_TRANSPORT_FAILED' });
    await assert.rejects(plane.regexRegistry(), { code: 'NORA_TRANSPORT_FAILED' });
});
