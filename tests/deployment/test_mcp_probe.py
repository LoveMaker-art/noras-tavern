from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
from threading import Thread
import unittest

if __package__:
    from .launcher_test_environment import resolve_node
else:
    from launcher_test_environment import resolve_node

PROBE = Path(__file__).resolve().parents[1] / 'installer/mcp_probe.mjs'
NODE = resolve_node()


@unittest.skipUnless(NODE, 'requires NORA_TEST_NODE or a local Node executable')
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
  async listTools() {
    if (this.config.env.PROBE_FAIL) throw Error('PRIVATE_RESPONSE');
    return {tools: [{name: 'nora.world.list'}]};
  }
  async callTool() { throw Error('Maintenance must not invoke a world tool'); }
  async close() { require('node:fs').writeFileSync(process.env.PROBE_CLOSE_PATH, 'closed'); }
};
''')
        (package / 'stdio.js').write_text('exports.StdioClientTransport = class { constructor(config) {this.config=config;} };')
        state = directory / 'state'
        (state / 'native/default-user').mkdir(parents=True)
        return {'command': 'fixture-server', 'args': ['read-fixture'], 'env': {
            'PRIVATE_KEY': 'PRIVATE_VALUE', 'NORA_MCP_STATE_ROOT': str(state)}}

    @contextmanager
    def instance(self, value, root):
        requests = []

        class StatusHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                data = json.dumps({'enabled': True, 'schema': 2, 'userDataRoot': str(root)}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_):
                pass

        with ThreadingHTTPServer(('127.0.0.1', 0), StatusHandler) as server:
            value['env']['NORA_MCP_BASE_URL'] = f'http://127.0.0.1:{server.server_port}'
            worker = Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01})
            worker.start()
            try:
                yield requests
            finally:
                server.shutdown()
                worker.join(timeout=5)

    def run_probe(self, directory, value):
        return subprocess.run([NODE, str(PROBE)], cwd=directory,
            env={**os.environ, 'PROBE_CLOSE_PATH': str(directory / 'closed')},
            input=value if isinstance(value, str) else json.dumps(value), text=True, capture_output=True, timeout=15)

    def test_actual_owned_probe_binds_the_instance_without_calling_world_storage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); value = self.fixture(root)
            with self.instance(value, root / 'state/native/default-user') as requests:
                result = self.run_probe(root, value)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / 'closed').read_text(), 'closed')
            self.assertEqual(result.stdout + result.stderr, '')
            self.assertEqual(requests, ['/api/nora-worlds-v2/status'])
            self.assertEqual(list((root / 'state/native/default-user').iterdir()), [])

    def test_rejects_a_healthy_listener_for_another_instance(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); value = self.fixture(root)
            other = root / 'other'
            other.mkdir()
            with self.instance(value, other) as requests:
                result = self.run_probe(root, value)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(requests, ['/api/nora-worlds-v2/status'])
            self.assertEqual(result.stderr.strip(), 'MCP read probe failed.')
            self.assertNotIn(str(other), result.stdout + result.stderr)

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
