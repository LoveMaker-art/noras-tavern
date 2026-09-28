import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Explicit paths reuse the installed MCP/engine dependencies without adding any
// runtime dependencies or another MCP client to the shipped authoring commands.
test('CardForge → real stdio MCP → real World Core/ST import, isolated storage', async t => {
  assert.ok(process.env.NORA_TAVERN_SOURCE && process.env.NORA_MCP_SOURCE, 'Set NORA_TAVERN_SOURCE and NORA_MCP_SOURCE');
  const engine = path.resolve(process.env.NORA_TAVERN_SOURCE);
  const mcp = path.resolve(process.env.NORA_MCP_SOURCE);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cardforge-mcp-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const beforeCwd = process.cwd();
  process.chdir(engine);
  t.after(() => process.chdir(beforeCwd));
  const requireMcp = createRequire(path.join(mcp, 'package.json'));
  const { Client } = await import(pathToFileURL(requireMcp.resolve('@modelcontextprotocol/sdk/client/index.js')));
  const { StdioClientTransport } = await import(pathToFileURL(requireMcp.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
  const requireEngine = createRequire(path.join(engine, 'package.json'));
  const express = requireEngine('express');
  const multer = requireEngine('multer');
  const engineImport = file => import(pathToFileURL(path.join(engine, file)));
  const { setConfigFilePath } = await engineImport('src/util.js');
  setConfigFilePath(path.join(engine, 'default/config.yaml'));
  const { createNoraWorldCore } = await engineImport('src/nora-world-core/index.js');
  const { createStBackendMaterializer } = await engineImport('src/nora-world-core/st-backend-materializer.js');
  const { createStCardCodec } = await engineImport('src/nora-world-core/st-card-codec.js');
  const { createNoraWorldsV2Router } = await engineImport('src/endpoints/nora-worlds-v2.js');
  const directories = { root };
  for (const name of ['characters', 'chats', 'worlds', 'uploads']) {
    directories[name] = path.join(root, name);
    await fs.mkdir(directories[name]);
  }
  const coreRoot = path.join(root, 'nora-world-core');
  const materializer = createStBackendMaterializer({ directories, stagingRoot: path.join(coreRoot, 'staging'), cardCodec: createStCardCodec({ serverRoot: engine }) });
  const core = createNoraWorldCore({ root: coreRoot, materializer });
  const app = express(); app.use(express.json());
  app.get('/csrf-token', (_req, res) => res.cookie('session', 'cardforge-test').json({ token: 'cardforge-fixture' }));
  let importRequests = 0;
  app.use((req, res, next) => {
    if (req.method !== 'GET' && (req.headers['x-csrf-token'] !== 'cardforge-fixture' || !req.headers.cookie?.includes('session=cardforge-test'))) return res.status(403).send('Invalid CSRF token');
    req.user = { directories, profile: { handle: 'cardforge-test' } }; next();
  });
  app.use('/api/nora-worlds-v2/imports', (_req, _res, next) => { importRequests++; next(); }, multer({ dest: directories.uploads }).single('avatar'));
  app.use('/api/nora-worlds-v2', createNoraWorldsV2Router({ resolveCore: () => core }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = new Client({ name: 'cardforge-integration', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(mcp, 'dist/server.js')], env: {
    ...process.env, NORA_MCP_MODE: 'operator', NORA_MCP_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NORA_MCP_STATE_ROOT: root, NORA_MCP_USER_DATA_ROOT: root, NORA_MCP_NATIVE_DATA_ROOT: root,
    NORA_MCP_PROJECT_ROOT: path.resolve(engine, '../..'), NORA_MCP_ST_ROOT: engine,
    NORA_MCP_UPLOAD_ROOT: directories.uploads,
  }, stderr: 'pipe' });
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    let data;
    try { data = JSON.parse(text); }
    catch { assert.equal(result.isError, true, text); data = { message: text }; }
    return { ...result, data };
  };
  const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.join(skill, 'scripts/nora-cardforge.js'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const project = path.join(root, 'authored-project');
  cli('ingest', '--input', path.join(skill, 'fixtures/empty-v2.json'), '--project', project);
  await fs.copyFile(path.join(skill, 'fixtures/mvu-vars.json'), path.join(project, 'features/mvu.json'));
  await fs.copyFile(path.join(skill, 'fixtures/statusbar.html'), path.join(project, 'features/statusbar.html'));
  const source = path.join(project, 'source/passthrough.json');
  const raw = JSON.parse(await fs.readFile(source, 'utf8'));
  raw.data.extensions.vendor_fixture = { keep: ['complex-card'] };
  await fs.writeFile(source, JSON.stringify(raw));
  const firstBuild = cli('build', '--project', project);
  assert.equal(firstBuild.manifest.quality.passed, true);
  const args = ['prepare-import', '--project', project, '--upload-root', directories.uploads, '--idempotency-key', 'integration:cardforge:json'];
  const preview = cli(...args, '--dry-run');
  assert.equal(preview.mcpCall.ready, false);
  assert.equal((await call('nora.world.list')).data.worlds.length, 0);
  const prepared = cli(...args);
  assert.equal(importRequests, 0, 'preparation must not touch Tavern');
  assert.equal(prepared.worldChanged, false);
  assert.equal((await call('nora.world.list')).data.worlds.length, 0);
  const unauthorized = await call(prepared.mcpCall.tool, prepared.mcpCall.arguments);
  assert.equal(unauthorized.isError, true, 'missing user confirmation cannot import');
  assert.equal(importRequests, 0);
  const importAndWait = async report => {
    const created = await call(report.mcpCall.tool, { ...report.mcpCall.arguments, confirm: true });
    assert.equal(created.isError, false, JSON.stringify(created.data));
    let operation = created.data.operation;
    for (let i = 0; operation.status !== 'COMPLETED' && operation.status !== 'FAILED' && i < 200; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      operation = (await call('nora.operation.get', { operationId: operation.operation_id })).data.operation;
    }
    assert.equal(operation.status, 'COMPLETED', JSON.stringify(operation.error));
    assert.equal(operation.operation_id, report.recovery.operationId);
    return (await call('nora.world.inspect', { worldId: operation.world_id })).data.world;
  };
  const world = await importAndWait(prepared);
  assert.equal(world.name, prepared.card.name);
  for (const capability of ['mvu', 'regex', 'tavern_helper']) assert.ok(world.capabilities.declared.includes(capability));
  assert.ok(world.knowledge.length > 0);
  const { read } = await engineImport('src/character-card-parser.js');
  const storedCard = JSON.parse(read(await fs.readFile(path.join(directories.characters, world.runtime_card.binding.avatar))));
  assert.deepEqual(storedCard.data.extensions.vendor_fixture, raw.data.extensions.vendor_fixture);
  const session = world.sessions.items[0];
  const chat = await fs.readFile(path.join(directories.chats, path.parse(world.runtime_card.binding.avatar).name, `${session.binding.chat_id}.jsonl`), 'utf8');
  assert.equal(JSON.parse(chat.split('\n')[0]).chat_metadata.nora_world.id, world.world_id);
  const retried = await importAndWait(prepared);
  assert.equal(retried.world_id, world.world_id);
  assert.equal((await call('nora.world.list')).data.worlds.length, 1);
  await fs.writeFile(path.join(project, 'assets/cover.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  cli('build', '--project', project);
  const png = cli('prepare-import', '--project', project, '--upload-root', directories.uploads, '--idempotency-key', 'integration:cardforge:png');
  assert.ok(png.stagedPath.endsWith('.png'));
  const second = await importAndWait(png);
  assert.notEqual(second.world_id, world.world_id);
  const reopened = createNoraWorldCore({ root: coreRoot, materializer });
  assert.equal((await reopened.listWorlds()).length, 2, 'both imports persist after reopening World Core');
  assert.equal((await reopened.prepareOpen(world.world_id)).world_id, world.world_id);
  t.diagnostic('Verified JSON/dual-metadata PNG import, complex-card persistence, confirmation gate, retry idempotency and read-back. No browser execution or model calls.');
});
