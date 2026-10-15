"""Probe the real sealed initializer offline, in a fresh managed interpreter.

No model credentials, network calls or dependency installation are permitted.
The client seam is replaced only inside this short-lived acceptance process.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace


def check(home):
    home = home.resolve()
    agent = home / 'hermes-agent'
    expected = {
        'agent/agent_init.py': 'c70a887f700a98276e76b60f987399af3fc3a994ef860c6788f14550fb2b9a52',
        'agent/bedrock_adapter.py': 'a12f92b7837209bf8f2189f6d74d9f204d016169c8474c472e97fde8b124d7d1',
    }
    for relative, digest in expected.items():
        assert hashlib.sha256((agent / relative).read_bytes()).hexdigest() == digest, relative + ' source differs'
    os.environ.update(HERMES_HOME=str(home), NORA_HERMES_HOME=str(home))
    sys.path.insert(0, str(agent))
    attempts = []

    def offline(event, args):
        if event in {'socket.connect', 'socket.getaddrinfo', 'subprocess.Popen', 'os.system'}:
            attempts.append(event)
            raise RuntimeError('Cold initialization must not perform network or subprocess work: ' + event)

    # Load lazy_deps before installing the audit hook: its module initialization
    # may inspect the local platform, but the initializer under test may not.
    from tools import lazy_deps
    installs = []
    lazy_deps.ensure = lambda feature, **kwargs: installs.append(feature)
    from agent import agent_init
    assert 'agent.bedrock_adapter' not in sys.modules, 'A cold interpreter is required'
    sys.addaudithook(offline)
    agent_init._explicit_client_kwargs = lambda *args: {'api_key': 'offline-check', 'base_url': 'https://api.deepseek.com'}
    agent_init._apply_openai_header_policy = lambda *args: None
    instance = SimpleNamespace(provider='deepseek', base_url='https://api.deepseek.com',
        quiet_mode=True, model='deepseek-v4-flash', api_mode='chat_completions',
        _create_openai_client=lambda *args, **kwargs: object())
    agent_init._init_openai_client(instance, 'offline-check', 'https://api.deepseek.com', None, 10)
    assert instance.client is not None, 'No client was constructed'
    assert installs == [], 'Unrelated provider installation requested: ' + repr(installs)
    assert attempts == [], 'Offline initialization attempted external work: ' + repr(attempts)
    return {'ok': True, 'hermesVersion': '0.21.1', 'provider': instance.provider,
        'scope': 'real-sealed-initializer-offline-client-seam', 'sources': expected,
        'installRequests': installs, 'externalAttempts': attempts}


if __name__ == '__main__':
    result = check(Path(sys.argv[1]))
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))
