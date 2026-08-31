"""Real Node/MCP clean-upgrade rehearsal. Creates and removes only a temp fixture."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile

OPS = Path(__file__).resolve().parents[1]
REPOSITORY = OPS.parent
sys.path.insert(0, str(OPS / 'updater'))
from bundle import digest, extract_bundle, read_bundle
from update import module_at
from isolated_update import IsolatedUpdater, MARKER


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', required=True, type=Path)
    parser.add_argument('--old-ref', required=True, help='Explicit existing historical Node commit')
    args = parser.parse_args()
    old_commit = subprocess.check_output(['git', 'rev-parse', '--verify', args.old_ref + '^{commit}'], cwd=REPOSITORY, text=True).strip()
    manifest_hash = digest((args.release_dir / 'release-manifest.json').read_bytes())
    manifest = read_bundle(args.release_dir, manifest_hash, candidate=True)
    with tempfile.TemporaryDirectory(prefix='tavern-clean-release-qa-') as temporary:
        root = Path(temporary).resolve()
        home = root / 'hermes'
        home.mkdir()
        (home / MARKER).write_text(json.dumps({'schema': 1, 'home': str(home), 'purpose': 'isolated-update-test'}))
        os.environ.update(HERMES_HOME=str(home), TAVERN_PERSONALITY_FILE=str(home / 'SOUL.md'))
        for key in ('TAVERN_APP_DIR', 'TAVERN_STATE_DIR', 'TAVERN_DATA_ROOT'):
            os.environ.pop(key, None)
        stage = root / 'bundle'
        extract_bundle(args.release_dir, stage, manifest)
        historical = root / 'historical'
        historical.mkdir()
        archive = subprocess.check_output(['git', 'archive', '--format=tar', old_commit, 'app'], cwd=REPOSITORY)
        subprocess.run(['tar', '-x', '-C', str(historical)], input=archive, check=True)
        (home / 'apps').mkdir()
        shutil.copytree(historical / 'app', home / 'apps/tavern-runtime')
        shutil.copytree(stage / 'nora-mcp', home / 'apps/nora-mcp')
        (home / 'AGENTS.md').write_text('# Isolated owner\nPreserve personal instructions.\n')
        (home / 'config.yaml').write_text('model: {provider: qa-no-real-model}\n')
        old_module = module_at('clean_qa_old_runtime', home / 'apps/tavern-runtime/native_lifecycle.py')
        contract = old_module.RuntimeContract.from_dict(json.loads((home / 'apps/tavern-runtime/native-runtime.json').read_text()))
        old = old_module.NativeRuntime(home, home / 'apps/tavern-runtime', home / 'tavern-state', contract)
        old.install()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        updater = IsolatedUpdater(home, port=port)
        try:
            started = old.start(port=port)
            assert started['health']['ok']
            old.stop_run('production')
            # Populate a genuine historical v1 schema after stopping its sole writer.
            fixture = (OPS / 'tests/fixtures/node-v1.mjs').as_uri()
            script = f"import {{createLegacyState}} from {json.dumps(fixture)}; await createLegacyState(process.argv[1],process.argv[2]);"
            subprocess.run(['node', '--input-type=module', '-e', script, str(home / 'tavern-state'), str(REPOSITORY)], check=True)
            cfg = old.config_path.read_bytes() + b'\n# preserve operator configuration\n'
            old.config_path.write_bytes(cfg)
            chat = home / 'tavern-state/native/default-user/chats/legacy/story.jsonl'
            original_chat = chat.read_bytes()
            original_profile = (home / 'tavern-state/story_profile.json').read_bytes()
            old_version = (home / 'apps/tavern-runtime/.tavern-release-version').read_text().strip()
            extra = home / 'apps/tavern-runtime/obsolete-from-old-release.py'
            extra.write_text('# keep only in recovery, never in active code\n')
            review = updater.review(args.release_dir, manifest_hash, candidate=True)
            installed = updater.apply(review['transaction'], review['planDigest'])
            assert installed['status'] == 'isolated-installed'
            assert not extra.exists()
            assert list((Path(review['transaction']) / 'backup').rglob(extra.name))
            assert original_chat.split(b'\n', 1)[1] == chat.read_bytes().split(b'\n', 1)[1]
            assert (home / 'tavern-state/story_profile.json').read_bytes() == original_profile
            assert old.config_path.read_bytes() == cfg
            migration = json.loads((Path(review['transaction']) / 'migration.json').read_text())
            assert migration['users'][0]['after'] == 1
            assert migration['modelsCalled'] == 0
            assert installed['verification']['httpWorldSnapshots'] == ['world:legacy-fixture']
            updater.rollback(review['transaction'], review['planDigest'])
            assert chat.read_bytes() == original_chat
            assert extra.exists()
            assert old.config_path.read_bytes() == cfg
            assert (home / 'apps/tavern-runtime/.tavern-release-version').read_text().strip() == old_version
            assert updater.lifecycle.runtime().health(port)['ok']
            print(json.dumps({'oldCommit': old_commit, 'oldVersion': old_version, 'newVersions': manifest['versions'],
                              'historicalNodeUpgrade': True, 'fullStateRollback': True, 'modelCalls': 0,
                              'migratedWorlds': migration, 'newMcp': installed['verification']['newMcpProcess'],
                              'httpWorldSnapshots': installed['verification']['httpWorldSnapshots'],
                              'livewareDeployment': False, 'port': port}, indent=2))
        finally:
            updater.lifecycle.stop()


if __name__ == '__main__':
    main()
