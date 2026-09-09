"""Exercise both optional cards through real MCP, only in a disposable smoke instance."""
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import yaml

home = Path(os.environ['HERMES_HOME'])
instance = json.loads((home / 'nora-instance.json').read_text())
root = Path(instance['installRoot'])
assert re.fullmatch(r'launcher-candidate-000000[A-Za-z0-9]{6}', root.parent.name), 'Never import fixtures into a user installation'
assert root.name == 'tavern' and home.resolve() == (root.parent / 'hermes').resolve(), 'Unexpected smoke instance layout'
assert Path(os.environ['NORA_TAVERN_HOME']).resolve() == root.parent.resolve(), 'Smoke root does not match the active instance'
config = yaml.safe_load((home / 'config.yaml').read_text())['mcp_servers']['nora']
samples = []
for story in ('suzhou-rain', 'xiamen-breeze'):
    result = subprocess.run([sys.executable, '-B', str(home / 'skills/creative/nora-cardforge/scripts/starter-story.py'),
                             '--story', story, '--request-id', 'smoke-request'], capture_output=True, text=True, check=True)
    samples.append(json.loads(result.stdout))
probe = '''
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const config = JSON.parse(process.argv[1]), samples = JSON.parse(process.argv[2]);
const client = new Client({ name: 'nora-sample-smoke', version: '1.0.0' });
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content.find(item => item.type === 'text').text);
};
try {
  await client.connect(new StdioClientTransport({ ...config, env: { ...process.env, ...config.env }, stderr: 'pipe' }));
  const before = await call('nora.world.list', {});
  assert.equal(JSON.stringify(before).includes('苏州雨巷'), false);
  assert.equal(JSON.stringify(before).includes('厦门海风'), false);
  for (const sample of samples) {
    const args = { filePath: sample.filePath, idempotencyKey: sample.idempotencyKey, confirm: true };
    const created = await call('nora.world.import', args);
    let operation;
    for (let attempt = 0; attempt < 100; attempt++) {
      operation = await call('nora.operation.get', { operationId: created.operation.operation_id });
      if (operation.operation.status === 'COMPLETED') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(operation.operation.status, 'COMPLETED');
    const inspected = await call('nora.world.inspect', { worldId: operation.operation.world_id });
    assert.ok(JSON.stringify(inspected).includes(sample.name), JSON.stringify(inspected));
    const retry = await call('nora.world.import', args);
    assert.equal(retry.operation.world_id, operation.operation.world_id);
  }
  console.log('PASS: both optional Chinese samples imported via MCP, read back and idempotent');
} finally { await client.close(); }
'''
subprocess.run([config['command'], '--input-type=module', '-e', probe, json.dumps(config), json.dumps(samples)],
               cwd=root / 'apps/nora-mcp', check=True, timeout=90)
