"""Real headless component qualification in disposable Linux instances.

Uses published core bytes and an explicitly supplied installed Hermes program.
No external model, account, existing home or existing service is used. Failed
instances and logs are retained; every admitted Tavern is stopped on exit.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request


def read(file):
    return json.loads(Path(file).read_text(encoding='utf-8'))


def digest(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load(file, name):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def checked_release(directory):
    sums = dict((parts[1], parts[0]) for line in (directory/'SHA256SUMS').read_text().splitlines()
                if len(parts := line.split()) == 2)
    manifest = read(directory/'release-manifest.json')
    assert manifest['schema'] == 'tavern-release/v2'
    assert re.fullmatch('[a-f0-9]{40}', manifest['commit'])
    for key in ('app', 'ops', 'nora-mcp'):
        assert key in manifest['archives']
    assert digest(directory/'release-manifest.json') == sums['release-manifest.json']
    for name in ('nora-tavern-first-install-bootstrap.py', 'tavern-updater-bootstrap.py'):
        assert digest(directory/name) == sums[name]
    for item in manifest['archives'].values():
        assert Path(item['name']).name == item['name']
        assert digest(directory/item['name']) == item['sha256'] == sums[item['name']]
    assert manifest['candidate'] is False and manifest['dirty'] is False
    return manifest


class Scenario:
    def __init__(self, scratch, name, hermes_source, deadline):
        self.deadline = deadline
        self.root = scratch/name
        self.root.mkdir(mode=0o700)
        self.home, self.program, self.data = (self.root/name for name in ('agent', 'programs', 'stories'))
        self.home.mkdir()
        (self.root/'home').mkdir()
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0))
            self.port = server.getsockname()[1]
        self.env = {'PATH': str(Path(sys.executable).parent)+os.pathsep+os.defpath,
                    'HOME': str(self.root/'home'), 'HERMES_HOME': str(self.home),
                    'HERMES_INSTALL_DIR': str(hermes_source), 'NORA_HERMES_HOME': str(self.home),
                    'NORA_TAVERN_HOME': str(self.home), 'TAVERN_DATA_ROOT': str(self.program),
                    'TAVERN_STATE_DIR': str(self.data), 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1',
                    'XDG_CACHE_HOME': str(scratch/'cache'), 'npm_config_cache': str(scratch/'npm-cache'),
                    'npm_config_logs_dir': str(self.root/'npm-logs')}
        # The runtime is selected explicitly; only its bin directory is added.
        node = shutil.which('node')
        if not node:
            raise RuntimeError('A real Node runtime is required')
        self.env['PATH'] = str(Path(node).parent)+os.pathsep+self.env['PATH']
        self.report = {'scenario': name, 'root': str(self.root), 'port': self.port, 'outcome': 'failed', 'commands': []}
        config = {'model': {'provider': 'custom', 'default': 'synthetic-no-call'},
                  'qualification_keep': {'story': 'preserve-private-fixture'},
                  'nora_tavern': {'installRoot': str(self.program), 'stateRoot': str(self.data),
                                 'hermesInstallDir': str(hermes_source), 'python': sys.executable, 'port': self.port}}
        # JSON is valid YAML. No inherited Key or production configuration.
        (self.home/'config.yaml').write_text(json.dumps(config))
        (self.home/'.env').write_text('OPENAI_API_KEY=synthetic-no-network-key\n')

    def command(self, label, args, timeout=600, *, cleanup=False):
        if not cleanup:
            timeout = min(timeout, self.deadline-time.monotonic()-90)
            if timeout <= 0:
                raise RuntimeError('Shared fixture deadline exhausted before starting another actor')
        started = time.monotonic()
        with (self.root/(label+'.log')).open('w') as log:
            child = subprocess.Popen([sys.executable, '-I', '-B', *map(str, args)], env=self.env,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                import psutil
                parent = psutil.Process(child.pid)
                owned = [(item, item.create_time()) for item in [*parent.children(recursive=True), parent]]
                for item, birth in owned:
                    try:
                        if item.create_time() == birth:
                            item.kill()
                    except psutil.NoSuchProcess:
                        pass
                _, alive = psutil.wait_procs([item for item, _ in owned], timeout=10)
                child.wait(timeout=10)
                if alive:
                    raise RuntimeError('Fixture command timed out and child closure remains unconfirmed')
                raise RuntimeError(f'{label} exceeded its {timeout}s fixture deadline; owned children closed')
        self.report['commands'].append({'name': label, 'returncode': code,
                                       'elapsedSeconds': round(time.monotonic()-started, 3)})
        if code:
            raise RuntimeError(f'{label} exited {code}; see {label}.log')

    def npm_installs(self):
        return sum('verbose title npm ci' in file.read_text(errors='replace')
                   for file in (self.root/'npm-logs').glob('*debug*.log'))

    def bind_materialized_baseline(self, source, release):
        # Source installation intentionally records "local-source". Qualify a
        # materialized release separately: every declared installed program
        # byte must match before the existing receipt producer may bind it.
        program = """import hashlib,importlib.util,json,pathlib,sys
source,root,release,proof=map(pathlib.Path,sys.argv[1:])
manifest=json.loads((release/'release-manifest.json').read_text());count=0
for name,wanted in manifest['artifacts'].items():
 parts=name.split('/',1);folder={'app':'tavern-runtime','ops':'tavern-ops','nora-mcp':'nora-mcp'}.get(parts[0])
 if folder:
  file=root/'apps'/folder/parts[1]
  assert file.is_file() and not file.is_symlink(),name
  assert hashlib.sha256(file.read_bytes()).hexdigest()==wanted,name
  count+=1
assert count>0
spec=importlib.util.spec_from_file_location('qualified_baseline_installer',source/'ops/installer/first_install.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.write_install_receipt(root,manifest)
proof.write_text(json.dumps({'commit':manifest['commit'],'verifiedProgramFiles':count,'method':'verified-materialized-release; not packaged-first-install'}))
"""
        proof = self.root/'baseline-program-proof.json'
        self.command('bind-verified-baseline', ['-c', program, source, self.program, release, proof])
        self.report['baselineMaterialization'] = read(proof)

    def lifecycle(self, action, *, cleanup=False):
        self.command(action, [self.program/'apps/tavern-runtime/native_lifecycle.py', action,
                             *(['--port', self.port] if action in ('start', 'status') else [])], timeout=90, cleanup=cleanup)

    def get(self, route):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}'+route, timeout=15) as response:
            assert response.status == 200
            return json.load(response)

    def seed(self):
        self.get('/api/nora-boot/bootstrap?lang=zh-cn')
        self.lifecycle('stop')
        user = self.data/'native/default-user'
        world_file = next((user/'nora-world-core/worlds').glob('*.json'))
        world = read(world_file)
        session = next(item for item in world['sessions']['items'] if item['session_id'] == world['sessions']['default_session_id'])
        self.world_id = world['world_id']
        self.chat = user/'chats'/Path(session['binding']['avatar']).stem/(session['binding']['chat_id']+'.jsonl')
        messages = [json.loads(line) for line in self.chat.read_text().splitlines() if line]
        messages[-1]['mes'] = 'QUALIFICATION_KEEP_CHAT_AND_SWIPES'
        if messages[-1].get('swipes'):
            messages[-1]['swipes'][messages[-1].get('swipe_id', 0)] = messages[-1]['mes']
        self.chat.write_text('\n'.join(json.dumps(item, ensure_ascii=False) for item in messages)+'\n')
        memory = self.home/'memories'
        memory.mkdir(exist_ok=True)
        for name in ('USER.md', 'MEMORY.md'):
            (memory/name).write_text('Private synthetic preference retained.\n')
        settings = read(user/'settings.json')
        settings['username'] = 'qualification-user'
        (user/'settings.json').write_text(json.dumps(settings))
        self.protected = [world_file, self.chat, self.home/'.env', *memory.glob('*.md'),
                          *(user/'characters').glob('*.png')]
        self.before = {str(file.relative_to(self.root)): digest(file) for file in self.protected}
        (self.root/'protected-before.json').write_text(json.dumps(self.before, indent=2)+'\n')

    def verify(self, target, *, updated=True):
        installed = read(self.program/'tavern-updates/installed.json')
        assert installed['version'] == target['versions']['tavern']
        assert installed['commit'] == target['commit']
        if updated:
            assert read(self.program/'tavern-updates/transaction.json')['status'] == 'committed'
        assert self.before == {str(file.relative_to(self.root)): digest(file) for file in self.protected}
        self.verify_user_configuration()
        self.lifecycle('start')
        assert self.world_id in json.dumps(self.get('/api/nora-worlds-v2/worlds'))
        snapshot = self.get('/api/nora-worlds-v2/worlds/'+self.world_id+'/snapshot')
        assert 'QUALIFICATION_KEEP_CHAT_AND_SWIPES' in json.dumps(snapshot)
        self.report.update(installedCommit=installed['commit'], installedVersion=installed['version'],
                           userData='retained', worldAndChatRead='verified', protectedFiles=self.before)

    def verify_after_failure(self):
        if not hasattr(self, 'before'):
            return
        assert self.before == {str(file.relative_to(self.root)): digest(file) for file in self.protected}
        self.verify_user_configuration()
        self.lifecycle('start')
        snapshot = self.get('/api/nora-worlds-v2/worlds/'+self.world_id+'/snapshot')
        assert 'QUALIFICATION_KEEP_CHAT_AND_SWIPES' in json.dumps(snapshot)
        self.report.update(failureUserData='retained', failureWorldAndChatRead='verified',
                           failureInstalledVersion=read(self.program/'tavern-updates/installed.json')['version'],
                           protectedFiles=self.before)

    def verify_user_configuration(self):
        import yaml
        config = yaml.safe_load((self.home/'config.yaml').read_text())
        assert config['qualification_keep'] == {'story': 'preserve-private-fixture'}
        assert config['model'] == {'provider': 'custom', 'default': 'synthetic-no-call'}
        assert read(self.data/'native/default-user/settings.json')['username'] == 'qualification-user'

    def close(self):
        lifecycle = self.program/'apps/tavern-runtime/native_lifecycle.py'
        try:
            if lifecycle.is_file():
                self.lifecycle('stop', cleanup=True)
            with socket.socket() as client:
                assert client.connect_ex(('127.0.0.1', self.port)) != 0, 'Fixture port remains open'
            import psutil
            excluded = {os.getpid(), *(item.pid for item in psutil.Process().parents())}
            active = []
            for item in psutil.process_iter(['pid', 'cmdline', 'cwd', 'uids']):
                if item.pid in excluded or not item.info['uids'] or item.info['uids'].real != os.getuid():
                    continue
                values = [*(item.info['cmdline'] or []), item.info['cwd'] or '']
                if any(str(self.root)+os.sep in value or str(self.root) == value for value in values):
                    active.append(item.pid)
            self.report['activeOwnedProcesses'] = active
            assert not active, 'Fixture maintenance handles remain active; preserve the instance'
            self.report['executorHandles'] = 'verified-closed'
            self.report['stop'] = 'confirmed'
        except Exception as error:
            self.report.update(outcome='failed', stop='unconfirmed', cleanupError=str(error))
        (self.root/'harness-result.json').write_text(json.dumps(self.report, indent=2)+'\n')


def main():
    harness_source_sha256 = digest(Path(__file__))
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('baseline', 'target', 'scratch', 'hermes-source'):
        parser.add_argument('--'+name, type=Path, required=True)
    parser.add_argument('--scenario', choices=('fresh', 'running', 'stopped', 'dependency-rebuild'), action='append')
    args = parser.parse_args()
    for name in ('baseline', 'target', 'scratch', 'hermes_source'):
        setattr(args, name, getattr(args, name).resolve())
    if sys.platform != 'linux':
        parser.error('Run actual headless qualification on Linux; another OS is not a pass')
    assert (args.hermes_source/'hermes_cli').is_dir(), 'Explicit installed Hermes source required'
    assert not args.scratch.is_relative_to(args.hermes_source) and not args.hermes_source.is_relative_to(args.scratch)
    assert not args.scratch.exists(), 'Use a new scratch directory; prior evidence is immutable'
    args.scratch.mkdir(mode=0o700, parents=True)
    baseline, target = checked_release(args.baseline), checked_release(args.target)
    assert baseline['commit'] != target['commit']
    bootstrap = load(args.baseline/'nora-tavern-first-install-bootstrap.py', 'qualified_cloud_bootstrap')
    runner = bootstrap.extract_ops_runner(args.baseline, args.scratch/'baseline-runner')
    bundle = load(runner.parent.parent/'updater/bundle.py', 'qualified_cloud_bundle')
    source = args.scratch/'baseline-source'
    bundle.extract_bundle(args.baseline, source, baseline)
    report = {'schema': 'nora-cloud-component-acceptance/1', 'platform': sys.platform,
              'baselineCommit': baseline['commit'], 'targetCommit': target['commit'],
              'python': sys.version.split()[0], 'harnessSourceSha256': harness_source_sha256,
              'scenarios': [], 'outcome': 'failed'}
    names = args.scenario or ('fresh', 'running', 'stopped', 'dependency-rebuild')
    assert len(set(names)) == len(names), 'Duplicate scenario would overwrite evidence'
    blocked = False
    deadline = time.monotonic()+1200
    for name in names:
        if blocked:
            report['scenarios'].append({'scenario': name, 'outcome': 'not-executed', 'reason': 'Common update admission failed before a transaction started'})
            continue
        fixture = Scenario(args.scratch, name, args.hermes_source, deadline)
        try:
            if name == 'fresh':
                fixture.command('install-target', [args.target/'nora-tavern-first-install-bootstrap.py', '--release-dir', args.target,
                                '--hermes-home', fixture.home, '--install-root', fixture.program, '--port', fixture.port,
                                '--skip-liveware', '--apply', '--confirm'])
                fixture.seed()
                fixture.verify(target, updated=False)
                # Fresh installation uses the install journal, not an update journal.
                fixture.report['freshInstalled'] = 'verified-target-installation'
            else:
                fixture.command('install-source-baseline', [source/'ops/installer/first_install.py', '--source-root', source,
                                '--hermes-home', fixture.home, '--install-root', fixture.program, '--port', fixture.port,
                                '--skip-liveware', '--apply', '--confirm'])
                fixture.seed()
                fixture.bind_materialized_baseline(source, args.baseline)
                if name != 'stopped':
                    fixture.lifecycle('start')
                if name == 'dependency-rebuild':
                    fixture.lifecycle('stop')
                    for folder in (fixture.program/'apps/tavern-runtime/engine/sillytavern/node_modules',
                                   fixture.program/'apps/nora-mcp/node_modules'):
                        assert folder.resolve().is_relative_to(fixture.root)
                        if folder.is_symlink():
                            folder.unlink()
                        elif folder.exists():
                            shutil.rmtree(folder)
                    (fixture.data/'native-runtime/dependencies.json').unlink(missing_ok=True)
                before_npm = fixture.npm_installs()
                fixture.command('update', [args.target/'tavern-updater-bootstrap.py', '--release-dir', args.target,
                                '--hermes-home', fixture.home, '--install-root', fixture.program, '--apply', '--confirm'])
                with socket.socket() as client:
                    running = client.connect_ex(('127.0.0.1', fixture.port)) == 0
                assert running == (name == 'running'), 'Update changed the initial service state'
                npm_calls = fixture.npm_installs()-before_npm
                fixture.report['npmCiDuringUpdate'] = npm_calls
                if name == 'dependency-rebuild':
                    assert npm_calls > 0, 'Missing dependencies did not exercise a real npm ci'
                fixture.report['initialDeployment'] = 'verified-materialized-published-source'
                fixture.verify(target)
            fixture.report['outcome'] = 'passed'
        except Exception as error:
            fixture.report['error'] = str(error)
            try:
                fixture.verify_after_failure()
            except Exception as audit:
                fixture.report['failureVerificationError'] = str(audit)
            log = fixture.root/'update.log'
            if log.is_file():
                events = []
                for line in log.read_text(errors='replace').splitlines():
                    try:
                        value = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(value, dict) and value.get('code'):
                        events.append(value)
                if events:
                    fixture.report['errorCode'] = events[-1]['code']
                if not (fixture.program/'tavern-updates/transaction.json').exists():
                    blocked = True
                    fixture.report['updateTransaction'] = 'not-started'
        finally:
            fixture.close()
        report['scenarios'].append(fixture.report)
        print(json.dumps({'scenario': name, 'outcome': fixture.report['outcome'], 'stop': fixture.report['stop']}), flush=True)
    report['outcome'] = 'passed' if all(item['outcome'] == 'passed' for item in report['scenarios']) else 'failed'
    (args.scratch/'cloud-acceptance.json').write_text(json.dumps(report, indent=2)+'\n')
    return 0 if report['outcome'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
