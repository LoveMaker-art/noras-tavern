"""Exercise optional cards through real MCP in a retained disposable product fixture."""
import argparse
import json
import os
import re
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlparse
import yaml


def reserved_directory():
    if sys.platform == 'darwin':
        return Path.home() / 'Library/NoraTavern-Tests'
    if sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA') or Path.home() / 'AppData/Local')
        return base / 'NoraTavern-Tests'
    raise ValueError('The manual product fixture requires macOS or Windows')


def physical(value, *, directory=False):
    path = Path(value)
    if (not path.is_absolute() or path.is_symlink() or path.resolve(strict=True) != path
            or not (path.is_dir() if directory else path.is_file())):
        raise ValueError('Fixture paths must be existing physical absolute paths')
    return path


def verify_fixture(fixture_root, environ):
    root = physical(fixture_root, directory=True)
    reserved = physical(reserved_directory(), directory=True)
    if root.parent != reserved or not re.fullmatch(r'products-smoke-[A-Za-z0-9]{6}', root.name):
        raise ValueError('Only a retained product fixture under NoraTavern-Tests may import samples')
    home, tavern = physical(root / 'hermes', directory=True), physical(root / 'tavern', directory=True)
    if (environ.get('HERMES_HOME') != str(home) or environ.get('NORA_TAVERN_HOME') != str(root)
            or environ.get('TAVERN_DATA_ROOT', str(tavern)) != str(tavern)):
        raise ValueError('The environment does not name this exact disposable instance')
    instance = json.loads(physical(home / 'nora-instance.json').read_text(encoding='utf-8'))
    if (instance.get('schema') != 1 or instance.get('noraHome') != str(root)
            or instance.get('hermesHome') != str(home) or instance.get('installRoot') != str(tavern)
            or type(instance.get('port')) is not int or not 1024 <= instance['port'] <= 65535):
        raise ValueError('The Nora instance does not match the disposable root and port')
    report = json.loads(physical(root / 'harness-result.json').read_text(encoding='utf-8'))
    if (report.get('schema') != 'nora-launcher-products-smoke/1' or report.get('outcome') != 'passed'
            or report.get('root') != str(root) or type(report.get('port')) is not int
            or report['port'] != instance['port'] or report.get('retained') is not True):
        raise ValueError('A successful retained product smoke report must bind this instance')
    config = yaml.safe_load(physical(home / 'config.yaml').read_text(encoding='utf-8'))['mcp_servers']['nora']
    binding = config['env']
    state = physical(tavern / 'tavern-state', directory=True)
    url = urlparse(binding['NORA_MCP_BASE_URL'])
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or url.port != instance['port']
            or url.username is not None or url.password is not None or url.path not in ('', '/')
            or url.query or url.fragment or binding.get('NORA_MCP_STATE_ROOT') != str(state)):
        raise ValueError('MCP must bind this fixture state and its recorded local port')
    # These optional bindings can redirect writes even when STATE_ROOT is correct.
    paths = {'NORA_MCP_NATIVE_DATA_ROOT': state / 'native',
             'NORA_MCP_USER_DATA_ROOT': state / 'native/default-user',
             'NORA_MCP_CONFIG_PATH': state / 'native-runtime/config.yaml',
             'NORA_MCP_UPLOAD_ROOT': state / 'imports'}
    for key, expected in paths.items():
        if key in binding and binding[key] != str(expected):
            raise ValueError(f'MCP {key} escapes the disposable instance')
        if expected.exists() or expected.is_symlink():
            physical(expected, directory=key != 'NORA_MCP_CONFIG_PATH')
    command = physical(config['command'])
    entry = physical(tavern / 'apps/nora-mcp/dist/server.js')
    if not command.is_relative_to(home) or config.get('args') != [str(entry)]:
        raise ValueError('MCP must execute the disposable instance bundled Node and server')
    return home, tavern, config


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


def main(argv=None, environ=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture-root', required=True, help='Physical retained products-smoke-XXXXXX directory under NoraTavern-Tests')
    args = parser.parse_args(argv)
    environ = os.environ if environ is None else environ
    # Admission completes before any sample staging, subprocess or MCP request.
    home, root, config = verify_fixture(args.fixture_root, environ)
    samples = []
    for story in ('suzhou-rain', 'xiamen-breeze'):
        result = subprocess.run([sys.executable, '-B', str(home / 'skills/creative/nora-cardforge/scripts/starter-story.py'),
                                 '--story', story, '--request-id', 'smoke-request'], capture_output=True, text=True, check=True)
        samples.append(json.loads(result.stdout))
    subprocess.run([config['command'], '--input-type=module', '-e', probe, json.dumps(config), json.dumps(samples)],
                   cwd=root / 'apps/nora-mcp', check=True, timeout=90)


if __name__ == '__main__':
    main()
