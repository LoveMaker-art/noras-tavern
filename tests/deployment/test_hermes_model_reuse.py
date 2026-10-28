"""Installed Hermes config/request integration in disposable, loopback-only homes."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
PRELUDE = r'''
import json, os, socket, threading
from contextlib import ExitStack
import httpx
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import hermes_models as models
from hermes_cli.config import load_config, save_config
home = Path(os.environ['HERMES_HOME'])
requests = []
failure = False
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_GET(self):
        requests.append({'path': self.path, 'headers': dict(self.headers)})
        payload = json.dumps({'data': [{'id': 'fixture-catalog-model'}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        requests.append({'path': self.path, 'headers': dict(self.headers), 'body': body})
        if failure:
            payload = json.dumps({'error': {'message': 'fixture refusal', 'type': 'invalid_request_error'}}).encode()
            self.send_response(400)
            content_type = 'application/json'
        elif self.path.endswith('/messages'):
            events = [
                ('message_start', {'type': 'message_start', 'message': {'id': 'msg-fixture', 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}}),
                ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'NORA_OK'}}),
                ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}}),
                ('message_stop', {'type': 'message_stop'})]
            payload = ''.join('event: '+kind+'\ndata: '+json.dumps(value)+'\n\n' for kind, value in events).encode()
            self.send_response(200)
            content_type = 'text/event-stream'
        elif self.path.endswith('/responses'):
            item = {'id': 'msg-fixture', 'type': 'message', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': 'NORA_OK', 'annotations': []}]}
            events = [
                ('response.output_item.done', {'type': 'response.output_item.done', 'output_index': 0, 'item': item}),
                ('response.completed', {'type': 'response.completed', 'response': {'id': 'resp-fixture', 'object': 'response', 'status': 'completed', 'model': body['model'], 'output': [item], 'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}})]
            payload = ''.join('event: '+kind+'\ndata: '+json.dumps(value)+'\n\n' for kind, value in events).encode()
            self.send_response(200)
            content_type = 'text/event-stream'
        else:
            payload = json.dumps({'id': 'chat-fixture', 'object': 'chat.completion', 'model': body['model'], 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'NORA_OK'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}).encode()
            self.send_response(200)
            content_type = 'application/json'
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base = 'http://127.0.0.1:'+str(server.server_port)+'/v1'
config = {'model': {'provider': 'custom', 'default': 'old-model', 'base_url': base, 'api_key': 'fixture-old-key'},
          'mcp_servers': {'nora': {'command': 'preserve'}}, 'fallback_providers': [{'provider': 'openrouter', 'model': 'must-not-run'}],
          'platforms': {'clawchat': {'enabled': True}}}
save_config(config)
(home / 'SOUL.md').write_text('preserve persona')
(home / 'USER.md').write_text('preserve preferences')
(home / 'world-chat-sentinel').write_text('preserve user data')
original_connect = socket.socket.connect
def connect(sock, address):
    if not (isinstance(address, tuple) and address[0] in {'127.0.0.1', '::1', 'localhost'} and address[1] == server.server_port):
        raise AssertionError('non-loopback network forbidden')
    return original_connect(sock, address)
original_send = httpx.Client.send
def send(client, request, *args, **kwargs):
    # Check the logical URL as well: local proxies can forward external targets.
    if request.url.host not in {'127.0.0.1', '::1', 'localhost'} or request.url.port != server.server_port:
        raise AssertionError('non-fixture HTTP target forbidden')
    return original_send(client, request, *args, **kwargs)
network_guard = ExitStack()
network_guard.enter_context(patch.object(socket.socket, 'connect', connect))
network_guard.enter_context(patch.object(httpx.Client, 'send', send))
'''


@unittest.skipUnless(os.environ.get('NORA_TEST_HERMES'), 'Read-only installed Hermes source required')
class InstalledHermesModelReuseTests(unittest.TestCase):
    def run_case(self, body):
        source = Path(os.environ['NORA_TEST_HERMES']).resolve()
        script = PRELUDE + '\ntry:\n' + textwrap.indent(textwrap.dedent(body), '    ') + r'''
    assert (home / 'SOUL.md').read_text() == 'preserve persona'
    assert (home / 'USER.md').read_text() == 'preserve preferences'
    assert (home / 'world-chat-sentinel').read_text() == 'preserve user data'
    print('isolated Hermes assertion passed')
finally:
    network_guard.close()
    server.shutdown()
    server.server_close()
'''
        with tempfile.TemporaryDirectory(prefix='nora-hermes-reuse-') as temporary:
            env = {'PATH': os.environ.get('PATH', ''), 'HOME': temporary, 'USERPROFILE': temporary,
                   'NO_PROXY': '*', 'no_proxy': '*',
                   'HERMES_HOME': temporary, 'XDG_CACHE_HOME': str(Path(temporary) / 'cache'),
                   'PYTHONPATH': os.pathsep.join((str(source), str(ROOT / 'ops/installer'))),
                   'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1'}
            result = subprocess.run([sys.executable, '-B', '-c', script], cwd=source, env=env,
                                    capture_output=True, text=True, timeout=35)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn('isolated Hermes assertion passed', result.stdout)

    def test_catalog_reuses_native_providers_and_auth_modes(self):
        self.run_case('''
            catalog = models.catalog()
            by_id = {item['id']: item for item in catalog['providers']}
            assert 'opencode-go' in by_id
            assert 'oauth' in by_id['anthropic']['authModes']
            assert 'oauth' in by_id['openai-codex']['authModes']
            assert by_id['custom']['authModes'] == ['key', 'none']
            assert not requests
        ''')

    def test_native_provider_catalog_uses_selected_endpoint_without_saving_it(self):
        self.run_case('''
            before = (home / 'config.yaml').read_bytes()
            result = models.models('deepseek', 'fixture-catalog-key', base, 'key')
            assert 'fixture-catalog-model' in result['models'], result
            assert requests and requests[0]['path'] == '/v1/models', requests
            assert requests[0]['headers']['Authorization'] == 'Bearer fixture-catalog-key'
            assert (home / 'config.yaml').read_bytes() == before
            assert not (home / '.env').exists()
        ''')

    def test_opencode_go_saves_native_identity_and_model_specific_modes(self):
        self.run_case('''
            for model, mode in [('glm-5', 'chat_completions'), ('minimax-m2.7', 'anthropic_messages'), ('gpt-5.4', 'codex_responses')]:
                selection = models.normalize('opencode-go', model, base, 'key')
                result = models.save(selection, 'fixture-opencode-key')
                assert result['provider'] == 'opencode-go', result
                assert result['apiMode'] == mode, result
                current = load_config()
                assert current['model']['provider'] == 'opencode-go'
                assert current['mcp_servers'] == config['mcp_servers']
                assert current['fallback_providers'] == config['fallback_providers']
            assert not requests
        ''')

    def test_ordinary_custom_call_does_not_change_active_model_or_auth(self):
        self.run_case('''
            before = (home / 'config.yaml').read_bytes()
            auth_before = (home / 'auth.json').read_bytes() if (home / 'auth.json').exists() else None
            result = models.test(models.normalize('custom', 'fixture-model', base, 'key'), 'fixture-new-key')
            assert result['ok'] and result['fallbackUsed'] is False
            assert len(requests) == 1, requests
            assert requests[0]['path'] == '/v1/chat/completions'
            assert requests[0]['body']['model'] == 'fixture-model'
            assert (home / 'config.yaml').read_bytes() == before
            assert ((home / 'auth.json').read_bytes() if (home / 'auth.json').exists() else None) == auth_before
        ''')

    def test_opencode_go_chat_call_has_native_session_and_client_identification(self):
        self.run_case('''
            selection = models.normalize('opencode-go', 'glm-5', base, 'key')
            before = (home / 'config.yaml').read_bytes()
            result = models.test(selection, 'fixture-opencode-key')
            assert result['ok']
            assert requests[0]['path'] == '/v1/chat/completions'
            headers = {key.lower(): value for key, value in requests[0]['headers'].items()}
            assert headers.get('x-opencode-session'), headers
            assert 'hermes' in headers.get('user-agent', '').lower(), headers
            assert (home / 'config.yaml').read_bytes() == before
        ''')

    def test_opencode_go_anthropic_call_uses_native_streaming_adapter(self):
        self.run_case('''
            selection = models.normalize('opencode-go', 'minimax-m2.7', base, 'key')
            result = models.test(selection, 'fixture-opencode-key')
            assert result['ok']
            assert requests[0]['path'] == '/v1/messages', requests
            assert requests[0]['body']['stream'] is True
            headers = {key.lower(): value for key, value in requests[0]['headers'].items()}
            assert headers.get('x-opencode-session'), headers
        ''')

    def test_native_anthropic_validation_uses_selected_endpoint_before_save(self):
        self.run_case('''
            before = (home / 'config.yaml').read_bytes()
            endpoint = base.removesuffix('/v1')
            selection = models.normalize('anthropic', 'claude-sonnet-4-6', endpoint, 'key')
            result = models.test(selection, 'fixture-anthropic-key')
            assert result['ok']
            assert len(requests) == 1 and requests[0]['path'] == '/v1/messages', requests
            assert requests[0]['body']['model'] == 'claude-sonnet-4-6'
            assert (home / 'config.yaml').read_bytes() == before
        ''')

    def test_opencode_go_responses_call_uses_native_streaming_adapter(self):
        self.run_case('''
            selection = models.normalize('opencode-go', 'gpt-5.4', base, 'key')
            result = models.test(selection, 'fixture-opencode-key')
            assert result['ok']
            assert requests[0]['path'] == '/v1/responses', requests
            assert requests[0]['body']['stream'] is True
            headers = {key.lower(): value for key, value in requests[0]['headers'].items()}
            assert headers.get('x-opencode-session'), headers
        ''')

    def test_old_managed_custom_preserves_provider_headers_and_uses_them_on_test(self):
        self.run_case('''
            config['providers'] = {models.OWNED_CUSTOM: {'name': 'Nora Launcher', 'base_url': base,
                'api_key': 'fixture-old-key', 'default_model': 'old-model', 'nora_launcher_managed': 1,
                'api_mode': 'chat_completions', 'transport': 'openai_chat',
                'extra_headers': {'X-Nora-Fixture': 'preserve-header'}, 'extra_body': {'fixture_option': 'preserve-body'},
                'request_overrides': {'max_tokens': 24}}}
            save_config(config)
            selection = models.normalize('custom', 'fixture-model', base, 'key')
            saved = models.save(selection, 'fixture-new-key')
            entry = load_config()['providers'][models.OWNED_CUSTOM]
            assert entry['extra_headers'] == {'X-Nora-Fixture': 'preserve-header'}
            assert entry['request_overrides'] == {'max_tokens': 24}
            result = models.test(selection, 'fixture-new-key')
            assert result['ok']
            headers = {key.lower(): value for key, value in requests[0]['headers'].items()}
            assert headers.get('x-nora-fixture') == 'preserve-header', headers
            assert requests[0]['body']['fixture_option'] == 'preserve-body'
        ''')

    def test_named_provider_rotation_does_not_change_another_entry_on_same_url(self):
        self.run_case('''
            config['providers'] = {
                'my-relay': {'name': 'My Relay', 'base_url': base, 'api_key': 'fixture-my-old-key', 'extra_headers': {'X-Nora-Fixture': 'my-header'}},
                'other-relay': {'name': 'Other Relay', 'base_url': base, 'api_key': 'fixture-other-key', 'extra_headers': {'X-Nora-Fixture': 'other-header'}}}
            save_config(config)
            before_other = load_config()['providers']['other-relay']
            selection = models.normalize('my-relay', 'fixture-model', base, 'key')
            assert selection['provider'] == 'my-relay', selection
            result = models.save(selection, 'fixture-new-key')
            assert result['provider'] == 'my-relay'
            assert load_config()['providers']['other-relay'] == before_other
            models.test(selection, 'fixture-new-key')
            headers = {key.lower(): value for key, value in requests[0]['headers'].items()}
            assert headers['authorization'] == 'Bearer fixture-new-key', headers
            assert headers['x-nora-fixture'] == 'my-header', headers
        ''')

    def test_legacy_custom_env_pointer_is_kept_when_rotating_key(self):
        self.run_case('''
            from hermes_cli.credential_lifecycle import save_provider_env_credential
            save_provider_env_credential('FIXTURE_RELAY_KEY', 'fixture-old-key')
            config['custom_providers'] = [{'name': 'Old Relay', 'base_url': base, 'key_env': 'FIXTURE_RELAY_KEY', 'model': 'old-model', 'extra_headers': {'X-Nora-Fixture': 'legacy'}}]
            save_config(config)
            selection = models.normalize('custom:old-relay', 'fixture-model', base, 'key')
            models.save(selection, 'fixture-new-key')
            current = load_config()
            assert current['model']['key_env'] == 'FIXTURE_RELAY_KEY', current['model']
            assert 'api_key' not in current['model']
            assert current['custom_providers'][0]['key_env'] == 'FIXTURE_RELAY_KEY'
            assert 'api_key' not in current['custom_providers'][0]
            models.test(selection, 'fixture-new-key')
            headers = {key.lower(): value for key, value in requests[0]['headers'].items()}
            assert headers['authorization'] == 'Bearer fixture-new-key', headers
            assert headers['x-nora-fixture'] == 'legacy', headers
        ''')

    def test_native_keyless_provider_uses_native_placeholder_and_no_new_key(self):
        self.run_case('''
            selection = models.normalize('opencode-free', 'fixture-free-model', base, 'none')
            runtime = models.resolve_candidate(selection)
            assert runtime['api_key'] != models.NO_AUTH_KEY
            result = models.save(selection)
            assert result['provider'] == 'opencode-free'
            assert not (home / '.env').exists()
        ''')

    def test_newstyle_named_local_provider_can_select_no_auth(self):
        self.run_case('''
            config['providers'] = {'local-relay': {'name': 'Local Relay', 'base_url': base}}
            save_config(config)
            selection = models.normalize('local-relay', 'fixture-local-model', base, 'none')
            result = models.save(selection)
            assert result['provider'] == 'local-relay'
            assert result['authMode'] == 'none'
            assert load_config()['model']['provider'] == 'local-relay'
            assert not (home / '.env').exists()
            models.test(selection)
            assert requests[0]['body']['model'] == 'fixture-local-model'
        ''')

    def test_http_client_endpoint_mismatch_is_closed_before_any_request(self):
        self.run_case('''
            import agent.auxiliary_client as auxiliary
            from types import SimpleNamespace
            closed = []
            wrong = SimpleNamespace(base_url='https://unselected.example/v1', close=lambda: closed.append(True))
            with patch.object(auxiliary, 'resolve_provider_client', return_value=(wrong, 'fixture-model')):
                try:
                    models.test(models.normalize('custom', 'fixture-model', base, 'key'), 'fixture-key')
                except ValueError as error:
                    assert '未发送验证请求' in str(error)
                else:
                    raise AssertionError('unselected endpoint was accepted')
            assert closed == [True]
            assert not requests
        ''')

    def test_native_command_credential_is_used_without_persisting_its_output(self):
        self.run_case('''
            import shlex, sys
            command = shlex.quote(sys.executable) + ' -c ' + shlex.quote("print('fixture-command-key')")
            config['providers'] = {'command-relay': {'name': 'Command Relay', 'base_url': base,
                'key_cmd': command, 'default_model': 'fixture-model', 'extra_headers': {'X-Nora-Fixture': 'command'}}}
            save_config(config)
            before = (home / 'config.yaml').read_bytes()
            selection = models.normalize('command-relay', 'fixture-model', base, 'key')
            result = models.test(selection)
            assert result['ok']
            headers = {key.lower(): value for key, value in requests[0]['headers'].items()}
            assert headers['authorization'] == 'Bearer fixture-command-key', headers
            assert headers['x-nora-fixture'] == 'command', headers
            assert (home / 'config.yaml').read_bytes() == before
            assert not (home / '.env').exists()
        ''')

    def test_all_three_native_transport_clients_are_closed_and_context_restored(self):
        self.run_case('''
            import agent.auxiliary_client as auxiliary
            from agent.portal_tags import get_conversation_context, set_conversation_context, reset_conversation_context
            original = auxiliary.resolve_provider_client
            closed = []
            def tracked(*args, **kwargs):
                client, model = original(*args, **kwargs)
                old_close = client.close
                def close():
                    closed.append(model)
                    old_close()
                client.close = close
                return client, model
            context = set_conversation_context('fixture-existing-conversation')
            try:
                with patch.object(auxiliary, 'resolve_provider_client', tracked):
                    for name in ['glm-5', 'minimax-m2.7', 'gpt-5.4']:
                        models.test(models.normalize('opencode-go', name, base, 'key'), 'fixture-key')
                        assert get_conversation_context() == 'fixture-existing-conversation'
                assert closed == ['glm-5', 'minimax-m2.7', 'gpt-5.4'], closed
            finally:
                reset_conversation_context(context)
        ''')

    def test_verification_failure_does_not_invoke_fallback_or_change_model(self):
        self.run_case('''
            failure = True
            before = (home / 'config.yaml').read_bytes()
            try:
                models.test(models.normalize('custom', 'fixture-model', base, 'key'), 'fixture-new-key')
            except Exception:
                pass
            else:
                raise AssertionError('refused response was reported as successful')
            assert requests and all(item['body']['model'] == 'fixture-model' for item in requests), requests
            assert all(item['path'] == '/v1/chat/completions' for item in requests)
            assert (home / 'config.yaml').read_bytes() == before
        ''')


if __name__ == '__main__':
    unittest.main()
