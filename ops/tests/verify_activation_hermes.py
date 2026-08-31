"""Exercise real Hermes plugin, reload and session APIs in a temporary home.

Uses the real local Nora stdio MCP. ClawChat transport/owner identity and the
cosmetic session-info footer are simulated; reload/reset use real Hermes code.
No gateway listener, model call, real message or restart is made.
Run with a Hermes-compatible Python environment and --hermes-source.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile


async def verify(home, source, repo):
    # Hermes treats an unavailable SDK as zero tools. Surface the dependency
    # cause before testing activation, rather than misdiagnosing the bridge.
    from mcp import ClientSession, StdioServerParameters  # noqa: F401
    import yaml
    sys.path.insert(0, str(repo / 'ops/updater'))
    from activation import Activation, digest, source_from_env, write
    from update import plan_digest
    ops = home / 'apps/tavern-ops'
    shutil.copytree(repo / 'ops/updater', ops / 'updater', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(repo / 'ops/updater/hermes-plugin', home / 'plugins/tavern-update-activation')
    shutil.copytree(repo / 'ops/skills', home / 'skills')
    mcp = home / 'apps/nora-mcp'
    shutil.copytree(repo / 'nora-mcp/dist', mcp / 'dist')
    shutil.copy2(repo / 'nora-mcp/package.json', mcp / 'package.json')
    (mcp / 'node_modules').symlink_to(repo / 'nora-mcp/node_modules', target_is_directory=True)
    (home / 'AGENTS.md').write_text('# Activation fixture\nNEW_TAVERN_CONTEXT\n')
    config = {'terminal': {'cwd': str(home)}, 'plugins': {'enabled': ['tavern-update-activation']}, 'mcp_servers': {'nora': {
        'command': shutil.which('node'), 'args': [str(mcp / 'dist/server.js')],
        'env': {'NORA_MCP_STATE_ROOT': str(home / 'tavern-state'), 'NORA_MCP_MODE': 'read-only',
                'NORA_MCP_BASE_URL': 'http://127.0.0.1:1'}, 'timeout': 30}}}
    (home / 'config.yaml').write_text(yaml.safe_dump(config))
    sys.path.insert(0, str(source))
    from gateway.platform_registry import platform_registry, PlatformEntry
    from gateway.config import Platform
    from gateway.platforms.base import SendResult, MessageEvent
    from gateway.session import SessionSource
    from gateway.run import GatewayRunner
    from hermes_cli.plugins import PluginManager, PluginManifest
    from gateway.session_context import set_session_vars
    from tools.mcp_tool import shutdown_mcp_servers
    from agent.prompt_builder import build_context_files_prompt

    class Transport:
        sent = []
        def _owner_user_id(self):
            return 'fixture-owner'
        async def send(self, chat_id, text, **_kwargs):
            self.sent.append(text)
            return SendResult(success=True, message_id='out-' + str(len(self.sent)))

    transport = Transport()
    platform_registry.register(PlatformEntry(name='clawchat', label='isolated transport',
        adapter_factory=lambda config: transport, check_fn=lambda: True))
    platform = Platform('clawchat')
    gateway = GatewayRunner()
    gateway._gateway_loop = asyncio.get_running_loop()
    gateway.adapters[platform] = transport
    # /new's cosmetic model footer otherwise performs an unrelated catalog fetch.
    gateway._format_session_info = lambda: 'isolated session metadata'
    # Transport authorization is simulated; production adapter adds its real owner gate.
    gateway._is_user_authorized = lambda origin: origin.user_id == 'fixture-owner'
    origin = SessionSource(platform=platform, chat_id='fixture-chat', user_id='fixture-owner', chat_type='dm')
    old = gateway.session_store.get_or_create_session(origin)
    gateway.session_store.append_to_transcript(old.session_id, {'role': 'user', 'content': 'preserve old history'})
    gateway.session_store.append_to_transcript(old.session_id, {'role': 'assistant', 'content': 'old answer'})
    key = gateway._session_key_for_source(origin)
    env = {'HERMES_SESSION_PLATFORM': 'clawchat', 'HERMES_SESSION_CHAT_ID': origin.chat_id,
           'HERMES_SESSION_USER_ID': origin.user_id, 'HERMES_SESSION_KEY': key,
           'HERMES_SESSION_ID': old.session_id, 'HERMES_SESSION_MESSAGE_ID': 'request'}
    manager = PluginManager()
    manager._load_plugin(PluginManifest(name='tavern-update-activation',
        path=str(home / 'plugins/tavern-update-activation'), key='tavern-update-activation', source='user'))
    assert (home / 'tavern-updates-v2/activation-gateway.json').exists(), 'Real Hermes loader did not register bridge'
    # Match the same records emitted by apply, without mutating a live installation.
    files = {'home/AGENTS.md': digest(home / 'AGENTS.md')}
    for file in (ops / 'updater/activation').glob('*.py'):
        files['ops/updater/activation/' + file.name] = digest(file)
    mcp_version = json.loads((mcp / 'package.json').read_text())['version']
    plan = {'home': str(home), 'files': files, 'manifestSha256': 'a' * 64, 'versions': {'mcp': mcp_version}}
    transaction = home / 'tavern-updates-v2/review-fixture'
    write(transaction / 'plan.json', plan)
    write(transaction / 'receipt.json', {'status': 'installed-awaiting-hermes-reload'})
    write(home / 'tavern-updates-v2/installed.json', {'transaction': transaction.name,
          'planDigest': plan_digest(plan), 'manifestSha256': plan['manifestSha256'], 'files': files})
    state = Activation(home)
    state.request(source_from_env(env))
    # Cross the same registered hook surface as a successful terminal tool call.
    set_session_vars(platform='clawchat', chat_id=origin.chat_id, user_id=origin.user_id,
                     session_key=key, session_id=old.session_id, message_id='request')
    manager.invoke_hook('post_tool_call', tool_name='terminal', result='queued')
    for _ in range(100):
        await asyncio.sleep(.05)
        if state.status()['status'] == 'awaiting-confirmation':
            break
    assert state.status()['status'] == 'awaiting-confirmation', state.status()
    event = MessageEvent(source=origin, text='确定', message_id='owner-confirmation')
    responses = manager.invoke_hook('pre_gateway_dispatch', event=event, gateway=gateway,
                                    session_store=gateway.session_store)
    assert any(r.get('action') == 'skip' for r in responses if isinstance(r, dict)), responses
    try:
        for _ in range(1200):
            await asyncio.sleep(.1)
            result = state.status()
            if result['status'] in ('active', 'failed'):
                break
        assert result['status'] == 'active' and result['notified'], result
        assert 'preserve old history' in json.dumps(gateway.session_store.load_transcript(old.session_id))
        fresh = gateway.session_store.get_or_create_session(origin)
        assert fresh.session_id != old.session_id
        assert 'NEW_TAVERN_CONTEXT' in build_context_files_prompt(cwd=str(home), skip_soul=True)
        print(json.dumps({'result': 'passed', 'realHermesPluginLoader': True, 'realHermesReloadAndReset': True,
                          'realNoraMcp': result['verification'], 'oldHistoryPreserved': True,
                          'freshContextReadable': True, 'clawChatTransport': 'simulated',
                          'sessionInfoFooter': 'simulated (no provider metadata lookup)',
                          'modelCalls': 0, 'gatewayRestarts': 0}, ensure_ascii=False, indent=2))
    finally:
        await asyncio.to_thread(shutdown_mcp_servers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hermes-source', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix='tavern-real-hermes-activation-') as temporary:
        home = Path(temporary).resolve()
        # Keep only executable discovery; no account credentials or live config.
        path = os.environ.get('PATH', '')
        os.environ.clear()
        os.environ.update(PATH=path, HERMES_HOME=str(home), HERMES_SKIP_UPDATE_CHECK='1')
        asyncio.run(verify(home, args.hermes_source, repo))


if __name__ == '__main__':
    main()
