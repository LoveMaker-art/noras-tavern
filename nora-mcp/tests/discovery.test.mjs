import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { READ_TOOLS, WRITE_TOOLS } from '../dist/tool-policy.js';

test('server source declares exactly the supported MCP tool surface', async () => {
    const source = await fs.readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
    const declared = [...source.matchAll(/server\.tool\(\s*["']([^"']+)["']/g)].map(match => match[1]).sort();
    const supported = [...READ_TOOLS, ...WRITE_TOOLS].sort();
    assert.deepEqual(declared, supported);
});

for (const mode of ['read-only', 'operator']) test('actual stdio discovery enforces ' + mode, async () => {
    const client = new Client({ name: 'policy-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/server.js'],
        env: { ...process.env, NORA_MCP_STATE_ROOT: '/tmp/mcp-discovery-unused', NORA_MCP_MODE: mode }, stderr: 'pipe' });
    await client.connect(transport);
    try {
        const { tools } = await client.listTools();
        const expected = [...READ_TOOLS, ...(mode === 'operator' ? WRITE_TOOLS : [])].sort();
        assert.deepEqual(tools.map(x => x.name).sort(), expected);
        assert.ok(tools.every(x => x.annotations && x.annotations.readOnlyHint === READ_TOOLS.has(x.name)));
        const denied = await client.callTool({ name: 'st.dev.run', arguments: { confirm: true, command: 'sh', args: ['-c', 'exit 99'] } });
        assert.equal(denied.isError, true);
        const map = await client.callTool({ name: 'nora.control_map', arguments: {} });
        assert.equal(JSON.parse(map.content[0].text).frontendExecution, 'available-when-target-page-connected');
    } finally { await client.close(); }
});
