"""Real Python-data -> Node-process rehearsal, using only a disposable fixture.

No old Python server is started: its main() schedules billable backlog work.
The tested source state is offline and rollback restores that offline state.
"""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.request

OPS = Path(__file__).resolve().parents[1]
REPOSITORY = OPS.parent
sys.path.insert(0, str(OPS / 'updater'))
from bundle import digest, extract_bundle, read_bundle
from isolated_update import IsolatedUpdater, MARKER
import tree_transaction as trees


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', required=True, type=Path)
    parser.add_argument('--old-ref', required=True, help='Reviewed original Python commit, not a Node data schema')
    parser.add_argument('--fail-after-start', action='store_true', help='Inject one verification failure after real Node startup to test automatic recovery')
    args = parser.parse_args()
    old_commit = subprocess.check_output(['git', 'rev-parse', '--verify', args.old_ref + '^{commit}'], cwd=REPOSITORY, text=True).strip()
    manifest_hash = digest((args.release_dir / 'release-manifest.json').read_bytes())
    manifest = read_bundle(args.release_dir, manifest_hash, candidate=True)
    with tempfile.TemporaryDirectory(prefix='tavern-python-release-qa-') as temporary:
        home = Path(temporary).resolve() / 'hermes'
        home.mkdir()
        (home / MARKER).write_text(json.dumps({'schema': 1, 'home': str(home), 'purpose': 'isolated-update-test'}))
        os.environ.update(HERMES_HOME=str(home), HERMES_CONFIG_PATH=str(home / 'config.yaml'),
                          TAVERN_PERSONALITY_FILE=str(home / 'SOUL.md'), PYTHONDONTWRITEBYTECODE='1',
                          TAVERN_HERMES_MEMORIES_DIR=str(home / 'memories'), TAVERN_HERMES_STATE_DB=str(home / 'state.db'))
        for key in ('TAVERN_APP_DIR', 'TAVERN_STATE_DIR', 'TAVERN_DATA_ROOT', 'TAVERN_MODEL_KEY',
                    'DEEPSEEK_API_KEY', 'TAVERN_MODEL_BASE', 'TAVERN_MODEL'):
            os.environ.pop(key, None)
        stage = home.parent / 'bundle'
        extract_bundle(args.release_dir, stage, manifest)
        historical = home.parent / 'historical'
        historical.mkdir()
        archive = subprocess.check_output(['git', 'archive', '--format=tar', old_commit, 'app'], cwd=REPOSITORY)
        subprocess.run(['tar', '-x', '-C', str(historical)], input=archive, check=True)
        old_app = home / 'apps/tavern-runtime'
        old_app.parent.mkdir()
        shutil.copytree(historical / 'app', old_app)
        assert (old_app / 'backend/server.py').is_file() and not (old_app / 'native-runtime.json').exists(), 'Expected original Python source'
        (home / 'AGENTS.md').write_text('# Isolated owner\nKeep my instructions.\n')
        (home / 'config.yaml').write_text('model: {provider: qa-no-real-model}\n')
        (home / 'SOUL.md').write_text('Isolated QA identity\n')
        fixture = json.loads(subprocess.check_output([sys.executable, str(OPS / 'tests/fixtures/create-python-fixture.py'),
                                                     str(old_app / 'backend')], text=True))
        state = home / 'tavern-state'
        for namespace in ('cards', 'worldbooks', 'productions'):
            directory = state / namespace
            directory.mkdir(parents=True)
            for item in fixture[namespace]:
                (directory / (item['id'] + '.json')).write_text(json.dumps(item, ensure_ascii=False))
        seed = home / 'seed-actor.md'
        seed.write_text('# 故事主理人\n\n## 对你的了解\n- 喜欢航海故事\n')
        script = "import sys,json; sys.path.insert(0,sys.argv[1]); import story_profile as p; p.ensure_profile(sys.argv[2],sys.argv[3]); p.sync_story_states(sys.argv[2],sys.argv[3],json.loads(sys.argv[4]))"
        subprocess.run([sys.executable, '-c', script, str(old_app / 'backend'), str(state), str(seed),
                        json.dumps(fixture['productions'], ensure_ascii=False)], check=True)
        before = {name: trees.fingerprint(home / name, state=name == 'tavern-state')
                  for name in ('apps/tavern-runtime', 'tavern-state', 'memories', 'config.yaml', 'AGENTS.md')}
        original_profile = json.loads((state / 'story_profile.json').read_text())
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        updater = IsolatedUpdater(home, port=port)
        started = False
        try:
            review = updater.review(args.release_dir, manifest_hash, candidate=True)
            if args.fail_after_start:
                def fail_verification(_transaction):
                    raise RuntimeError('fixture failure after real Node startup')
                updater.lifecycle.verify = fail_verification
                try:
                    updater.apply(review['transaction'], review['planDigest'])
                    raise AssertionError('Injected failure was ignored')
                except RuntimeError as error:
                    if str(error) != 'fixture failure after real Node startup':
                        raise
                for name, expected in before.items():
                    assert trees.fingerprint(home / name, state=name == 'tavern-state') == expected, 'Automatic rollback mismatch: ' + name
                with socket.socket() as probe:
                    assert probe.connect_ex(('127.0.0.1', port)) != 0
                print(json.dumps({'oldCommit': old_commit, 'newSourceDigest': manifest['sourceDigest'],
                                  'automaticFailureRollback': True, 'pythonRestoredOffline': True,
                                  'modelsCalled': 0, 'livewareDeployment': False}))
                return
            installed = updater.apply(review['transaction'], review['planDigest'])
            started = True
            assert installed['status'] == 'isolated-installed'
            assert not (old_app / 'backend/server.py').exists(), 'Old Python executable remains active'
            assert (Path(review['transaction']) / 'backup/trees/0/backend/server.py').exists()
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            def get(route):
                with opener.open(f'http://127.0.0.1:{port}' + route, timeout=20) as response:
                    return json.load(response)
            get('/csrf-token')
            snapshot = get('/api/nora-worlds-v2/worlds/prod_fixture/snapshot')['snapshot']
            assert [m['mes'] for m in snapshot['chat']['messages']] == [m['text'] for m in fixture['productions'][0]['story']]
            assert snapshot['plan']['story_context']['characters'][0]['persistent_status']['physical_condition'] == '左臂受伤'
            assert len(snapshot['plan']['story_context']['characters']) == 2
            assert len(snapshot['worldbooks']) == 1
            profile = get('/api/nora-story-profile/card')
            assert profile['career']['roles'] == 2 and profile['career']['turns'] == 16
            preserved = json.loads((state / 'story_profile.json').read_text())
            for field in ('preferences', 'recent_timeline', 'shared_story_memory'):
                assert preserved[field] == original_profile[field], 'Profile content changed: ' + field
            migration = json.loads((Path(review['transaction']) / 'migration.json').read_text())
            assert migration['pythonMigration'] and migration['modelsCalled'] == 0
            updater.rollback(review['transaction'], review['planDigest'])
            started = False
            for name, expected in before.items():
                assert trees.fingerprint(home / name, state=name == 'tavern-state') == expected, 'Rollback mismatch: ' + name
            with socket.socket() as probe:
                assert probe.connect_ex(('127.0.0.1', port)) != 0, 'Rollback unexpectedly started a service'
            print(json.dumps({'oldCommit': old_commit, 'newSourceDigest': manifest['sourceDigest'],
                'pythonToNode': True, 'worlds': 2, 'messages': 32, 'independentCharacters': 2,
                'profileContentPreserved': True, 'fullStateRollback': True, 'pythonRestoredOffline': True,
                'newMcp': installed['verification']['newMcpProcess'], 'modelsCalled': 0,
                'livewareDeployment': False, 'port': port}, ensure_ascii=False, indent=2))
        finally:
            if started or (old_app / 'native-runtime.json').exists():
                updater.lifecycle.stop()


if __name__ == '__main__':
    main()
