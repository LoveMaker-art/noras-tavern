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
import { StInspectionPlane } from '../dist/st/inspection-plane.js';

test('large preset edits use the normal conditional edit route; exports create distinct private artifacts', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nora-mcp-files-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const edits = { prompts: [{ operation: 'update', id: 'main', patch: { content: 'a'.repeat(300000) } }] };
    const file = path.join(root, 'edits.json'); await fs.writeFile(file, JSON.stringify(edits));
    const calls = [];
    const plane = new NoraControlPlane({ stateRoot: root, uploadRoot: root }, {
        post: async (route, body) => { calls.push([route, body]); return { name: 'Preset', revision: 'next', saved: true, storedPreset: { prompts: [] } }; },
        download: async () => Buffer.from('PNG fixture'),
    });
    const result = await plane.editPresetFile({ filePath: file, name: 'Preset', expectedRevision: 'before' });
    assert.equal(calls[0][0], '/api/presets/nora-save');
    assert.deepEqual(calls[0][1].edits, edits);
    assert.equal(calls[0][1].expectedRevision, 'before');
    assert.equal(result.storedPreset, undefined);
    const first = await plane.exportFile({ kind: 'card', target: 'card.png', format: 'png' });
    const second = await plane.exportFile({ kind: 'preset', target: 'Preset', format: 'json' });
    assert.notEqual(first.path, second.path);
    const exportedStat = await fs.stat(first.path);
    assert.equal(exportedStat.isFile(), true);
    if (process.platform !== 'win32') assert.equal(exportedStat.mode & 0o777, 0o600);
    assert.equal(await fs.readFile(first.path, 'utf8'), 'PNG fixture');
    assert.deepEqual(JSON.parse(await fs.readFile(second.path, 'utf8')), { prompts: [] });
    assert.equal(first.sha256, createHash('sha256').update('PNG fixture').digest('hex'));
    await assert.rejects(plane.exportFile({ kind: 'preset', target: 'Preset', format: 'png' }), { code: 'NORA_EXPORT_FORMAT_INVALID' });
    await fs.rename(path.join(root, 'exports'), path.join(root, 'actual'));
    await fs.symlink(path.join(root, 'actual'), path.join(root, 'exports'));
    await assert.rejects(plane.exportFile({ kind: 'card', target: 'card.png', format: 'png' }), { code: 'NORA_EXPORT_PATH_DENIED' });
    for (const name of ['nora.library.manage_card', 'nora.preset.edit_file', 'nora.export']) {
        assert.equal(allowedTool(name, 'read-only'), false);
        assert.equal(allowedTool(name, 'operator'), true);
    }
});

test('worldbook export uses strict source lookup and never writes an empty fallback for a missing label', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nora-book-export-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const book = { name: 'Display label', entries: { 0: { content: 'Library opens at nine.' } } };
    const plane = new NoraControlPlane({ stateRoot: root }, { post: async (route, body) => {
        assert.equal(route, '/api/nora-worlds-v2/library/worldbooks/read');
        assert.equal(body.source.kind, 'book');
        if (body.source.name !== 'library-id') throw new NoraRequestError('Missing source', 'NORA_WORLD_INVALID');
        return { book };
    } });
    await assert.rejects(plane.exportFile({ kind: 'worldbook', target: 'Display label', format: 'json' }), { code: 'NORA_WORLD_INVALID' });
    assert.deepEqual(await fs.readdir(root), []);
    const result = await plane.exportFile({ kind: 'worldbook', target: 'library-id', format: 'json' });
    assert.deepEqual(JSON.parse(await fs.readFile(result.path, 'utf8')), book);
});

test('MVU history exposes diagnostic metadata, not error prose or model output', async () => {
    let route;
    const plane = new NoraControlPlane({}, { get: async value => {
        route = value;
        return { events: [{ receivedAt: '2026-09-29T00:00:00Z', code: 'MVU_UPDATE_FAILED',
            stage: 'validation', identity: 'world:1', chatId: 'chat-1', persisted: false,
            summary: 'private dialogue and secret', fallbackReason: 'private response',
            validationErrors: [{ reason: 'private field value' }], apiKey: 'fixture-secret' }] };
    } });
    const result = await plane.mvuDiagnostics(1000);
    assert.equal(route, '/api/nora-mvu-diagnostics/recent?limit=100');
    assert.equal(result.events[0].code, 'MVU_UPDATE_FAILED');
    assert.equal(result.events[0].validationErrorCount, 1);
    assert.equal(result.rawTextOmitted, true);
    assert.equal(/private|fixture-secret/.test(JSON.stringify(result)), false);
    assert.equal(allowedTool('nora.mvu.diagnostics', 'read-only'), true);
    plane.http.get = async () => { throw new NoraRequestError('offline', 'NORA_TRANSPORT_FAILED'); };
    await assert.rejects(plane.mvuDiagnostics(), { code: 'NORA_TRANSPORT_FAILED' });
});

test('parity tools use authoritative library endpoints and preserve independent MVU limits', async () => {
    const calls = [];
    const plane = new NoraControlPlane({}, { get: async (...args) => calls.push(args), post: async (...args) => calls.push(args) });
    await plane.libraryList('card');
    await plane.libraryDelete({ id: 'a'.repeat(64), revision: 'r1', confirm: true });
    await plane.libraryDelete({ source: { kind: 'book', name: 'Lore' }, revision: 'r2', confirm: true });
    await plane.configureMvuModel({ model: 'new', context: 90000, maxTokens: 9000, confirm: true });
    await plane.restartWorld({ worldId: 'a/b', name: 'Restart', expectedRevision: 3, idempotencyKey: 'restart-1' });
    assert.equal(calls[0][0], '/api/nora-worlds-v2/library/cards');
    assert.deepEqual(calls[1], ['/api/nora-worlds-v2/library/profiles/delete', { id: 'a'.repeat(64), revision: 'r1' }]);
    assert.equal(calls[2][0], '/api/nora-worlds-v2/library/worldbooks/delete');
    assert.equal(calls[3][1].context, 90000);
    assert.equal(calls[3][1].max_tokens, 9000);
    assert.equal(calls[3][1].base_url, undefined);
    assert.equal(calls[4][0], '/api/nora-worlds-v2/worlds/a%2Fb/restarts');
    assert.equal(calls[4][1].expected_revision, 3);
    await assert.rejects(plane.libraryDelete({ revision: 'r', confirm: true }), { code: 'NORA_LIBRARY_TARGET_INVALID' });
    for (const name of ['nora.library.delete', 'nora.library.import_card', 'nora.world.restart']) {
        assert.equal(allowedTool(name, 'read-only'), false);
        assert.equal(allowedTool(name, 'operator'), true);
    }
});

test('library tools share UI storage endpoints without creating or applying worlds', async () => {
    const calls = [];
    const plane = new NoraControlPlane({}, { get: async (...args) => calls.push(['GET', ...args]), post: async (...args) => calls.push(['POST', ...args]) });
    const profile = { kind: 'character', name: 'Reusable', data: { name: 'Alice', description: 'Profile' } };
    await plane.libraryList('character');
    await plane.librarySave(profile);
    await plane.libraryRead({ id: 'a'.repeat(64) });
    await plane.librarySave({ kind: 'worldbook', name: 'Lore', data: { entries: {} } });
    assert.deepEqual(calls.map(call => call[1]), ['/api/nora-worlds-v2/library/profiles?kind=character', '/api/nora-worlds-v2/library/profiles/save',
        '/api/nora-worlds-v2/library/profiles/read', '/api/nora-worlds-v2/library/worldbooks/import']);
    assert.deepEqual(calls[1][2], profile);
    assert.equal(allowedTool('nora.library.save', 'read-only'), false);
    assert.equal(allowedTool('nora.library.save', 'operator'), true);
    assert.equal(allowedTool('nora.library.read', 'read-only'), true);
});

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

test('World deletion forwards the confirmed preview token through the shared HTTP operation', async () => {
    const calls = [], token = 'a'.repeat(64);
    const plane = new NoraControlPlane({}, {
        get: async route => { calls.push(['GET', route]); return { token }; },
        delete: async (route, body) => { calls.push(['DELETE', route, body]); return { operation: { status: 'COMPLETED' } }; },
    });
    assert.equal(allowedTool('nora.world.delete_preview', 'read-only'), true);
    assert.equal(allowedTool('nora.world.delete', 'read-only'), false);
    assert.equal((await plane.previewWorldDeletion('world:test')).token, token);
    await assert.rejects(plane.deleteWorld('world:test', 'delete-one', false, token));
    await plane.deleteWorld('world:test', 'delete-one', true, token);
    assert.deepEqual(calls, [
        ['GET', '/api/nora-worlds-v2/worlds/world%3Atest/delete-preview'],
        ['DELETE', '/api/nora-worlds-v2/worlds/world%3Atest', { expected_plan: token, idempotency_key: 'delete-one' }],
    ]);
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
    await plane.importLibraryCard(path.join(uploads, 'card.json'));
    assert.equal(sent.route, '/api/nora-worlds-v2/library/cards/import');
    assert.equal(sent.body.get('idempotency_key'), null);
    await assert.rejects(plane.importLibraryCard(path.join(uploads, 'link.json')), { code: 'NORA_IMPORT_PATH_DENIED' });
    await assert.rejects(assertInstance({ userDataRoot: root }, { get: async () => ({ userDataRoot: uploads }) }), { code: 'NORA_INSTANCE_MISMATCH' });
    await assertInstance({ userDataRoot: root }, { get: async () => ({ userDataRoot: root }) });
});

test('ST registries do not expose raw extension credentials or disguise transport failure as empty configuration', async () => {
    const plane = new StInspectionPlane({}, { get: async () => [{ name: 'example' }] });
    plane.settings = async () => ({ extension_settings: {
        example: { api_key: 'fixture-secret', enabled: true },
        mvu_settings: { '额外模型解析配置': { '模型名称': 'fixture', 'api密钥': 'fixture-secret' } },
    } });
    const registry = await plane.extensionRegistry();
    assert.equal(registry.extensions[0].hasConfig, true);
    assert.equal(registry.extensions[0].config, undefined);
    assert.equal(registry.controlTool, 'nora.control.execute');
    assert.deepEqual(registry.controlActions, ['plugins.enabled', 'plugins.configure', 'plugins.install', 'plugins.update', 'plugins.uninstall']);
    assert.equal(registry.inventoryKind, 'discovered-modules');
    assert.equal(registry.liveLibraryAction, 'plugins.list');
    assert.match(registry.lifecyclePolicy, /editable\/protected/);
    assert.equal(JSON.stringify(registry).includes('fixture-secret'), false);
    assert.equal(JSON.stringify(await plane.getMvuSettings()).includes('fixture-secret'), false);
    plane.settings = async () => { throw new NoraRequestError('offline', 'NORA_TRANSPORT_FAILED'); };
    await assert.rejects(plane.extensionRegistry(), { code: 'NORA_TRANSPORT_FAILED' });
    await assert.rejects(plane.regexRegistry(), { code: 'NORA_TRANSPORT_FAILED' });
});

test('ST discovery responses point to the single Nora mutation plane and never advertise removed tools', async () => {
    const plane = new StInspectionPlane({}, {
        post: async route => route === '/api/worldinfo/list' ? [] : { entries: {} },
    });
    const list = await plane.listWorldbooks();
    const book = await plane.inspectWorldbook('fixture');
    assert.equal(list.mutationTool, 'nora.control.execute');
    assert.equal(book.mutationTool, 'nora.control.execute');
    assert.equal(list.createTool, undefined);
    assert.equal(list.deleteTool, undefined);
    assert.equal(book.entryTool, undefined);
});
