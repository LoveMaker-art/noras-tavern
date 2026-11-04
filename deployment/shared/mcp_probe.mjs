// A read-only install acceptance probe. Configuration arrives through stdin.
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(pathToFileURL(path.join(process.cwd(), 'package.json')));
let client;
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 256 * 1024) throw new Error('probe input exceeds limit');
  }
  const config = JSON.parse(input);
  if (!config || typeof config.command !== 'string' || !Array.isArray(config.args)
      || !config.env || typeof config.env !== 'object' || Array.isArray(config.env)) {
    throw new Error('invalid probe configuration');
  }
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
  client = new Client({ name: 'nora-install-check', version: '1.0.0' });
  const env = { ...process.env, ...config.env };
  const transport = new StdioClientTransport({ ...config, env, stderr: 'pipe' });
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some(tool => tool.name === 'nora.world.list')) throw new Error('missing world tool');

  // Listing worlds initializes the story writer and can quarantine data.
  // Verify the live HTTP instance using the status route, which only reports
  // the instance binding and does not initialize world storage.
  const origin = new URL(env.NORA_MCP_BASE_URL);
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname)
      || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
      || !path.isAbsolute(env.NORA_MCP_STATE_ROOT || '')) throw new Error('invalid instance binding');
  const nativeRoot = env.NORA_MCP_NATIVE_DATA_ROOT || path.join(env.NORA_MCP_STATE_ROOT, 'native');
  const expectedRoot = env.NORA_MCP_USER_DATA_ROOT || path.join(nativeRoot, 'default-user');
  const configuredTimeout = Number(env.NORA_MCP_TIMEOUT_MS);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(60_000, Math.ceil(configuredTimeout)) : 30_000;
  const response = await fetch(new URL('/api/nora-worlds-v2/status', origin), {
    headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error('instance status failed');
  const status = await response.json();
  if (status.enabled !== true || status.schema !== 2 || typeof status.userDataRoot !== 'string'
      || !path.isAbsolute(status.userDataRoot)
      || await realpath(status.userDataRoot) !== await realpath(expectedRoot)) throw new Error('instance binding differs');
} catch {
  // Responses and configuration must never enter command logs or diagnostics.
  console.error('MCP read probe failed.');
  process.exitCode = 1;
} finally {
  if (client) {
    try { await client.close(); }
    catch { console.error('MCP read probe cleanup failed.'); process.exitCode = 1; }
  }
}
