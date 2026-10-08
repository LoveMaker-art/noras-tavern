import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

PROBE = Path(__file__).resolve().parents[1] / 'installer/mcp_probe.mjs'


@unittest.skipUnless(shutil.which('node'), 'requires local Node')
class McpProbeTests(unittest.TestCase):
    def fixture(self, directory):
        package = directory / 'node_modules/@modelcontextprotocol/sdk'
        package.mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'name': '@modelcontextprotocol/sdk', 'exports': {
            './client/index.js': './client.js', './client/stdio.js': './stdio.js'}}))
        (package / 'client.js').write_text('''
exports.Client = class {
  async connect(transport) {
    if (transport.config.command !== 'fixture-server' || transport.config.args.length !== 1) throw Error('bad input');
    this.config = transport.config;
  }
  async listTools() { return {tools: [{name: 'nora.world.list'}]}; }
  async callTool(request) {
    if (request.name !== 'nora.world.list' || Object.keys(request.arguments).length) throw Error('not read only');
    if (this.config.env.PROBE_FAIL) throw Error('PRIVATE_RESPONSE');
    return {content: []};
  }
  async close() { require('node:fs').writeFileSync(process.env.PROBE_CLOSE_PATH, 'closed'); }
};
''')
        (package / 'stdio.js').write_text('exports.StdioClientTransport = class { constructor(config) {this.config=config;} };')
        return {'command': 'fixture-server', 'args': ['read-fixture'], 'env': {'PRIVATE_KEY': 'PRIVATE_VALUE'}}

    def run_probe(self, directory, value):
        return subprocess.run([shutil.which('node'), str(PROBE)], cwd=directory,
            env={**os.environ, 'PROBE_CLOSE_PATH': str(directory / 'closed')},
            input=value if isinstance(value, str) else json.dumps(value), text=True, capture_output=True, timeout=15)

    def test_actual_owned_probe_resolves_install_dependencies_and_performs_only_world_read(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); result = self.run_probe(root, self.fixture(root))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / 'closed').read_text(), 'closed')
            self.assertEqual(result.stdout + result.stderr, '')

    def test_private_configuration_and_response_never_enter_output_even_when_probe_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); value = self.fixture(root); value['env']['PROBE_FAIL'] = True
            result = self.run_probe(root, value)
            self.assertEqual(result.returncode, 1); self.assertEqual((root / 'closed').read_text(), 'closed')
            self.assertEqual(result.stderr.strip(), 'MCP read probe failed.')
            self.assertNotIn('PRIVATE_', result.stdout + result.stderr)

    def test_invalid_or_oversized_stdin_is_rejected_with_a_fixed_summary(self):
        for value in ('PRIVATE_CONFIG not valid JSON', 'PRIVATE_BODY' * 30000):
            with self.subTest(size=len(value)), tempfile.TemporaryDirectory() as temporary:
                result = self.run_probe(Path(temporary), value)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr.strip(), 'MCP read probe failed.')
                self.assertNotIn('PRIVATE_', result.stdout + result.stderr)


if __name__ == '__main__': unittest.main()
