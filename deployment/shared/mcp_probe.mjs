// A read-only install acceptance probe. Configuration arrives through stdin.
import { createRequire } from 'node:module';
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
  const transport = new StdioClientTransport({ ...config, env: { ...process.env, ...config.env }, stderr: 'pipe' });
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some(tool => tool.name === 'nora.world.list')) throw new Error('missing world tool');
  const result = await client.callTool({ name: 'nora.world.list', arguments: {} });
  if (result.isError) throw new Error('instance read failed');
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
