import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio MCP → shared HTTP → actual World Core/ledger routes, isolated instance', async t => {
    assert.ok(process.env.NORA_TAVERN_SOURCE, 'Set NORA_TAVERN_SOURCE to the Tavern engine directory');
    const engine = path.resolve(process.env.NORA_TAVERN_SOURCE);
    const serverFile = fileURLToPath(new URL('../../dist/server.js', import.meta.url));
    const importEngine = file => import(pathToFileURL(path.join(engine, file)).href);
    const express = createRequire(path.join(engine, 'package.json'))('express');
    const beforeCwd = process.cwd(); process.chdir(engine);
    t.after(() => process.chdir(beforeCwd));
    const { setConfigFilePath } = await importEngine('src/util.js');
    setConfigFilePath(path.join(engine, 'default/config.yaml'));
    const { createNoraWorldCore } = await importEngine('src/nora-world-core/index.js');
    const { createNoraWorldsV2Router } = await importEngine('src/endpoints/nora-worlds-v2.js');
    const { router: ledgerRouter } = await importEngine('src/endpoints/nora-story-ledger.js');
    const { router: controlsRouter } = await importEngine('src/endpoints/nora-controls.js');
    const { createRuntimeControls } = await importEngine('public/scripts/nora-controls/runtime.js');
    const { startControlClient } = await importEngine('public/scripts/nora-controls/client.js');
    const { createStMvuSettingsAdapter } = await importEngine('public/scripts/nora-adapters/st-mvu-settings-adapter.js');
    const { createWorldCoreRuntime } = await importEngine('public/scripts/nora-worlds/world-core-runtime.js');
    const { createWorldCoreClient } = await importEngine('public/scripts/nora-worlds/world-core-client.js');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nora-mcp-e2e-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directories = { root };
    for (const name of ['characters', 'chats', 'worlds', 'backgrounds', 'uploads']) {
        directories[name] = path.join(root, name); await fs.mkdir(directories[name]);
    }
    // This fixture substitutes card materialization, not World Core or ledger logic.
    // No configured provider and only two rounds: no external model can be called.
    const core = createNoraWorldCore({ root: path.join(root, 'nora-world-core'), materializer: {
        materialize: async (_command, ids) => {
            const avatar = ids.worldId.replace(':', '-') + '.png';
            const chatId = ids.sessionId.replace(':', '-');
            const header = { chat_metadata: { nora_world: { id: ids.worldId }, nora_session: { id: ids.sessionId } } };
            const messages = Array.from({ length: 4 }, (_, i) => ({ name: i % 2 ? 'Story' : 'User', is_user: i % 2 === 0, mes: `fixture ${i}`, send_date: i }));
            const directory = path.join(directories.chats, avatar.slice(0, -4));
            await fs.mkdir(directory);
            await fs.writeFile(path.join(directory, chatId + '.jsonl'), [header, ...messages].map(x => JSON.stringify(x)).join('\n'));
            return { runtimeCard: { engine: 'sillytavern', binding: { avatar }, ownership: 'owned' },
                defaultSession: { engine: 'sillytavern', binding: { chat_id: chatId }, openingState: 'empty' }, knowledge: [], declaredCapabilities: [] };
        },
    } });
    const app = express(); app.use(express.json());
    let advertisedRoot = root;
    let csrfRejections = 0;
    app.get('/csrf-token', (_req, res) => res.cookie('session', 'fixture').json({ token: 'fixture-token' }));
    app.use((req, res, next) => {
        if (req.method !== 'GET' && (req.headers['x-csrf-token'] !== 'fixture-token' || !req.headers.cookie?.includes('session=fixture'))) {
            csrfRejections++; return res.status(403).send('Invalid CSRF token');
        }
        req.user = { directories, profile: { handle: 'fixture' } }; next();
    });
    app.get('/api/nora-worlds-v2/status', (_req, res) => res.json({ enabled: true, schema: 2, userDataRoot: advertisedRoot }));
    const multer = createRequire(path.join(engine, 'package.json'))('multer');
    app.use('/api/nora-worlds-v2/backgrounds/import', multer({ dest: directories.uploads }).single('avatar'));
    app.use('/api/nora-worlds-v2', createNoraWorldsV2Router({ resolveCore: () => core }));
    app.use('/api/nora-story-ledger', ledgerRouter);
    app.use('/api/nora-controls', controlsRouter);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const client = new Client({ name: 'isolated-tavern-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverFile], env: {
        ...process.env, NORA_MCP_STATE_ROOT: root, NORA_MCP_USER_DATA_ROOT: root,
        NORA_MCP_PROJECT_ROOT: path.resolve(engine, '../..'), NORA_MCP_ST_ROOT: engine,
        NORA_MCP_MODE: 'operator', NORA_MCP_BASE_URL: base,
        NORA_MCP_UPLOAD_ROOT: directories.uploads,
    }, stderr: 'pipe' }));
    t.after(() => client.close());
    const call = async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args });
        return { ...result, data: JSON.parse(result.content[0].text) };
    };
    const key = 'integration:create-once';
    const created = await call('nora.world.create', { name: 'MCP fixture', idempotencyKey: key, confirm: true });
    assert.equal(created.isError, false, JSON.stringify(created.data));
    let operation = created.data.operation;
    for (let attempt = 0; operation.status !== 'COMPLETED' && attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        operation = (await call('nora.operation.get', { operationId: operation.operation_id })).data.operation;
    }
    assert.equal(operation.status, 'COMPLETED');
    const repeated = await call('nora.world.create', { name: 'MCP fixture', idempotencyKey: key, confirm: true });
    assert.equal(repeated.data.operation.operation_id, operation.operation_id);
    const listed = await call('nora.world.list');
    assert.equal(listed.data.worlds.length, 1, 'same key cannot duplicate the World');
    const world = await core.getWorld(operation.world_id);
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const before = await call('nora.session.read', { ...scope, limit: 4 });
    assert.equal(before.isError, false, JSON.stringify(before.data));
    assert.equal(before.data.totalTurns, 2);
    assert.equal(before.data.messages.length, 4);
    assert.equal(before.data.running, false);
    const edit = { ...scope, messageId: 2, text: '  edited second turn\n', expectedSignature: before.data.expectedSignature, confirm: true, allowModelCall: true };
    const unauthorized = await call('nora.ledger.configure', { ...scope, enabled: true, confirm: true });
    assert.equal(unauthorized.data.code, 'NORA_MODEL_CALL_NOT_AUTHORIZED');
    const edited = await call('nora.session.edit', edit);
    assert.equal(edited.isError, false, JSON.stringify(edited.data));
    assert.equal(edited.data.frontendApplied, false);
    assert.equal(edited.data.saved, true);
    const after = await call('nora.session.read', scope);
    assert.equal(after.data.messages.length, 3, 'following assistant reply is removed');
    assert.equal(after.data.messages.at(-1).text, edit.text);
    const stale = await call('nora.session.edit', edit);
    assert.equal(stale.isError, true);
    assert.equal(stale.data.code, 'NORA_LEDGER_EDIT_STALE');
    const context = { chatMetadata: { nora_world: { id: scope.worldId }, nora_session: { id: scope.sessionId } }, extensionSettings: { mvu_settings: {} }, saveSettingsStrict: async () => {} };
    const headers = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-token', Cookie: 'session=fixture' });
    const localFetch = (route, options) => fetch(base + route, options);
    context.getRequestHeaders = headers;
    context.characterId = 0; context.characters = [{ avatar: world.runtime_card.binding.avatar }];
    const worlds = createWorldCoreRuntime({ read: () => ({ characters: context.characters, metadata: context.chatMetadata }),
        savePersona: async persona => { context.persona = persona; } }, {
        client: createWorldCoreClient(headers, { fetchImpl: localFetch, pendingStore: null }),
    });
    await worlds.refresh();
    const mvuRuntime = { getMvuData: () => ({ stat_data: {}, schema: {} }), reloadSettings() {} };
    const mvu = createStMvuSettingsAdapter(() => context, { readMvuRuntime: () => mvuRuntime });
    const { createStoryActionDispatcher } = await importEngine('../../native-extensions/nora-ui/story-action-dispatcher.js');
    const dispatcher = createStoryActionDispatcher({ messages: { isGenerating: () => false }, getSessionKey: () => scope.sessionId });
    const controls = createRuntimeControls({ getContext: () => context, story: { worlds, mvu, messages: { isGenerating: () => false } },
        fetcher: localFetch, dispatch: () => dispatcher, assertIdle: () => {} });
    const page = startControlClient({ controls, headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-token', Cookie: 'session=fixture' }),
        fetcher: (route, options) => fetch(base + route, options), pause: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))) });
    t.after(() => page.stop());
    const until = async read => {
        const deadline = Date.now() + 3000;
        for (;;) { const result = await read(); if (result) return result; if (Date.now() > deadline) throw new Error('Control result timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    await until(async () => (await call('nora.control.clients')).data.clients?.find(item => item.clientId === page.clientId));
    const target = { clientId: page.clientId, ...scope };
    const catalog = await call('nora.control.catalog');
    assert.equal(catalog.data.actions['mvu.enabled'].model, true);
    assert.equal(catalog.data.actions['world.inspect'].readOnly, true);
    assert.equal(catalog.data.actions['models.select'].readOnly, false);
    assert.equal(catalog.data.actions['worldbook.update-entry'].fields.expectedRevision, 'string');
    const inspectJob = await call('nora.control.read', { ...target, action: 'world.inspect', params: {}, idempotencyKey: 'panel:inspect' });
    const inspected = await until(async () => { const value = await call('nora.control.operation', { operationId: inspectJob.data.id }); return value.data.status === 'completed' ? value.data.result : null; });
    const personaJob = await call('nora.control.execute', { ...target, action: 'world.update',
        params: { patch: { persona: { name: 'Player via MCP' } }, expectedRevision: inspected.revision }, confirm: true, idempotencyKey: 'panel:persona' });
    const personaSaved = await until(async () => { const value = await call('nora.control.operation', { operationId: personaJob.data.id }); return value.data.status === 'completed' ? value.data.result : null; });
    assert.equal(personaSaved.saved, true);
    assert.equal(personaSaved.runtimeApplied, true);
    assert.equal(context.persona.name, 'Player via MCP');
    assert.equal((await core.prepareOpen(scope.worldId)).persona.name, 'Player via MCP');
    // New visual controls exercise the same real broker/World storage. No browser/visual claim.
    assert.equal(catalog.data.actions['theme.inspect'].readOnly, true);
    const themeRead = await call('nora.control.read', { ...target, action: 'theme.inspect', params: {}, idempotencyKey: 'theme:inspect' });
    const themeBefore = await until(async () => { const value = await call('nora.control.operation', { operationId: themeRead.data.id }); return value.data.status === 'completed' ? value.data.result : null; });
    const themeApply = await call('nora.control.execute', { ...target, action: 'theme.apply', confirm: true, idempotencyKey: 'theme:apply',
        params: { ui: { theme: { font: 'classic', text: '#ddd' } }, expectedRevision: themeBefore.revision } });
    const themeSaved = await until(async () => { const value = await call('nora.control.operation', { operationId: themeApply.data.id }); return value.data.status === 'completed' ? value.data.result : null; });
    assert.equal(themeSaved.saved, true);
    assert.equal(themeSaved.renderer.ready, false, 'this fixture has no real UI');
    assert.equal(worlds.list()[0].ui.theme.font, 'classic');
    assert.equal((await core.prepareOpen(scope.worldId)).persona.name, 'Player via MCP');
    const themeClear = await call('nora.control.execute', { ...target, action: 'theme.clear', confirm: true, idempotencyKey: 'theme:clear', params: { expectedRevision: themeSaved.revision } });
    await until(async () => (await call('nora.control.operation', { operationId: themeClear.data.id })).data.status === 'completed');
    assert.deepEqual((await core.prepareOpen(scope.worldId)).ui.theme, {});
    const imageFile = path.join(directories.uploads, 'background.png');
    await fs.writeFile(imageFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64'));
    const image = await call('nora.background.import', { filePath: imageFile, confirm: true });
    assert.equal(image.isError, false, JSON.stringify(image.data));
    const imageAgain = await call('nora.background.import', { filePath: imageFile, confirm: true });
    assert.equal(imageAgain.data.url, image.data.url);
    assert.equal((await fs.readdir(directories.backgrounds)).length, 1);
    const request = { ...target, action: 'mvu.enabled', params: { enabled: false }, idempotencyKey: 'integration:mvu-disable', confirm: true, allowModelCall: true };
    const submitted = await call('nora.control.execute', request);
    assert.equal(submitted.isError, false, JSON.stringify(submitted.data));
    const completed = await until(async () => { const value = await call('nora.control.operation', { operationId: submitted.data.id }); return value.data.status === 'completed' ? value.data : null; });
    assert.equal(completed.result.saved, true);
    assert.equal(context.extensionSettings.mvu_settings['更新方式'], '随AI输出');
    const replay = await call('nora.control.execute', request);
    assert.equal(replay.data.id, submitted.data.id);
    assert.equal(replay.data.status, 'completed');
    const refused = await call('nora.control.read', { ...target, action: 'mvu.enabled', params: { enabled: true }, idempotencyKey: 'read-cannot-mutate' });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.code, 'NORA_CONTROL_WRITE_DENIED');
    page.stop();
    advertisedRoot = directories.characters;
    const mismatch = await call('nora.session.read', scope);
    assert.equal(mismatch.data.code, 'NORA_INSTANCE_MISMATCH');
    assert.equal(csrfRejections, 0, 'cold writes carry correct token AND cookie, no redundant rejection round-trip');
});
