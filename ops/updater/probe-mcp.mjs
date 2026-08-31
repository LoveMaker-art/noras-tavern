import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2]);
const { READ_TOOLS } = await import(pathToFileURL(path.join(root, 'dist/tool-policy.js')));
const { Client } = await import(pathToFileURL(path.join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(path.join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
const client = new Client({ name: 'release-readonly-probe', version: '2' });
try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/server.js')], env: process.env, stderr: 'pipe' }));
    const { tools } = await client.listTools();
    const expected = [...READ_TOOLS].sort();
    if (JSON.stringify(tools.map(tool => tool.name).sort()) !== JSON.stringify(expected)
        || tools.some(tool => tool.annotations?.readOnlyHint !== true)) {
        throw new Error('MCP read-only discovery mismatch');
    }
    console.log(JSON.stringify({ server: client.getServerVersion(), readOnlyTools: tools.length }));
} finally {
    await client.close();
}
