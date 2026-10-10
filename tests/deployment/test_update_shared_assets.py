import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('shared_asset_bootstrap', ROOT / 'ops/updater/bootstrap.py')
BOOTSTRAP = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BOOTSTRAP)


class Response(io.BytesIO):
    def __init__(self, body, url):
        super().__init__(body)
        self.url = url
    def geturl(self):
        return self.url


class SharedAssetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name) / 'component.tar.gz'
        self.tag, self.baseline, self.commit = 'v2.4.6', 'v2.4.5', 'b'*40
        self.payload = b'verified old component'
        self.sha = hashlib.sha256(self.payload).hexdigest()
        self.index = {'schema': 'nora-release-assets/1', 'repository': BOOTSTRAP.REPO, 'tag': self.tag,
                      'commit': self.commit, 'minimumLauncherVersion': '2.1.2', 'assets': [
                          {'name': 'component.tar.gz', 'asset_release_tag': self.baseline,
                           'sha256': self.sha, 'size': len(self.payload)}]}
        self.current = {'tavern-updater-bootstrap.py': b'print("isolated bootstrap fixture")\n'}
        self.current['bootstrap-manifest.json'] = json.dumps({'scope': 'tavern-updater-bootstrap',
            'sha256': hashlib.sha256(self.current['tavern-updater-bootstrap.py']).hexdigest(), 'commit': self.commit}).encode()
        self.requests = []
        self.reseal()

    def gh(self, name, tag=None):
        return f'https://github.com/{BOOTSTRAP.REPO}/releases/download/{tag or self.tag}/{name}'

    def reseal(self):
        self.current['release-assets.json'] = (json.dumps(self.index)+'\n').encode()
        self.release = {'tag_name': self.tag, 'draft': False, 'prerelease': False, 'assets': [
            {'name': name, 'state': 'uploaded', 'size': len(body), 'digest': 'sha256:'+hashlib.sha256(body).hexdigest(),
             'browser_download_url': self.gh(name)} for name, body in self.current.items()]}

    def fetch(self, url, **kwargs):
        self.requests.append(url)
        if url.startswith('https://api.github.com/') or url.endswith('/release.json') or url.endswith('/stable.json'):
            return Response(json.dumps(self.release).encode(), url)
        name = url.rsplit('/', 1)[1]
        return Response(self.payload if f'/{self.baseline}/' in url else self.current[name], url)

    def test_verified_current_index_expands_old_tag_and_sourceforge_fetch_uses_same_identity(self):
        def fetch(url, **kwargs):
            if url == self.gh('component.tar.gz', self.baseline):
                self.requests.append(url)
                raise urllib.error.HTTPError(url, 403, 'Forbidden', {}, None)
            return self.fetch(url, **kwargs)
        with patch.object(BOOTSTRAP, 'open_source', side_effect=fetch):
            selected = BOOTSTRAP.select_release()
            BOOTSTRAP.download_asset(selected, 'component.tar.gz', self.target, expected_sha256=self.sha)
        self.assertEqual(selected['tag_name'], self.tag)
        self.assertEqual(selected['shared_assets']['commit'], self.commit)
        self.assertEqual(self.target.read_bytes(), self.payload)
        self.assertEqual(self.requests[-2:], [self.gh('component.tar.gz', self.baseline),
            BOOTSTRAP.SOURCEFORGE+self.baseline+'/component.tar.gz'])

    def test_legacy_stays_current_tag_strict_and_shared_index_does_not_enable_an_old_client_minimum(self):
        self.release['assets'] = [{'name': 'component.tar.gz', 'state': 'uploaded', 'size': len(self.payload),
            'digest': 'sha256:'+self.sha, 'browser_download_url': self.gh('component.tar.gz', self.baseline)}]
        with patch.object(BOOTSTRAP, 'open_source', side_effect=self.fetch):
            with self.assertRaisesRegex(RuntimeError, '身份'):
                BOOTSTRAP.select_release()
        self.index['minimumLauncherVersion'] = '2.1.1'
        self.reseal()
        with patch.object(BOOTSTRAP, 'open_source', side_effect=self.fetch):
            with self.assertRaisesRegex(RuntimeError, '门槛'):
                BOOTSTRAP.select_release()

    def test_hash_size_identity_collisions_and_arbitrary_urls_fail_before_payload_download(self):
        original_index = copy.deepcopy(self.index)
        changes = [lambda index: index.update(repository='other/repo'),
                   lambda index: index['assets'][0].update(asset_release_tag=self.tag),
                   lambda index: index['assets'][0].update(asset_release_tag='v2.4.7'),
                   lambda index: index['assets'][0].update(asset_release_tag='v2.4.5-beta.1'),
                   lambda index: index['assets'][0].update(size=True),
                   lambda index: index['assets'][0].update(sha256='invalid'),
                   lambda index: index['assets'][0].update(name='tavern-updater-bootstrap.py'),
                   lambda index: index['assets'][0].update(name='darwin-arm64-release-manifest.json'),
                   lambda index: index['assets'][0].update(name='darwin-arm64-SHA256SUMS'),
                   lambda index: index['assets'][0].update(name='darwin-arm64-first-install-manifest.json'),
                   lambda index: index['assets'][0].update(name='darwin-arm64-nora-tavern-first-install-bootstrap.py'),
                   lambda index: index['assets'][0].update(name='darwin-arm64-tavern-updater-bootstrap.py'),
                   lambda index: index['assets'][0].update(name='Nora-Tavern-Launcher-2.1.2-win32-x64-update.zip'),
                   lambda index: index['assets'][0].update(name='first-install-manifest.json'),
                   lambda index: index['assets'][0].update(url='https://evil.example/asset'),
                   lambda index: index['assets'].append(copy.deepcopy(index['assets'][0]))]
        for change in changes:
            with self.subTest(change=change):
                self.index = copy.deepcopy(original_index)
                change(self.index)
                self.reseal()
                self.requests.clear()
                with patch.object(BOOTSTRAP, 'open_source', side_effect=self.fetch):
                    with self.assertRaises(RuntimeError):
                        BOOTSTRAP.select_release()
                self.assertTrue(all(not url.endswith('/component.tar.gz') for url in self.requests))
        self.index = original_index
        self.reseal()
        self.current['release-assets.json'] += b' '
        with patch.object(BOOTSTRAP, 'open_source', side_effect=self.fetch):
            with self.assertRaisesRegex(RuntimeError, '校验信息'):
                BOOTSTRAP.select_release()

    def test_shared_manifest_must_match_target_commit_minimum_and_expected_component_hash(self):
        with patch.object(BOOTSTRAP, 'open_source', side_effect=self.fetch):
            selected = BOOTSTRAP.select_release()
        manifest = {'commit': self.commit, 'versions': {'tavern': self.tag[1:]},
                    'bootstrap': {'minimumLauncherVersion': '2.1.2'},
                    'modules': {'changed': {'name': 'component.tar.gz', 'sha256': self.sha, 'size': len(self.payload)}}}
        BOOTSTRAP.validate_shared_manifest(selected, manifest)
        for changed in [{**manifest, 'commit': 'c'*40},
                        {**manifest, 'bootstrap': {'minimumLauncherVersion': '2.1.1'}},
                        {**manifest, 'modules': {'changed': {'name': 'component.tar.gz', 'sha256': 'c'*64}}}]:
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, '共享资产'):
                BOOTSTRAP.validate_shared_manifest(selected, changed)
        self.target.write_bytes(b'keep existing verified data')
        with patch.object(BOOTSTRAP, 'open_source', return_value=Response(b'x'*len(self.payload), self.gh('component.tar.gz', self.baseline))) as fetch:
            with self.assertRaisesRegex(RuntimeError, '校验'):
                BOOTSTRAP.download_asset(selected, 'component.tar.gz', self.target, expected_sha256=self.sha)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(self.target.read_bytes(), b'keep existing verified data')

    def test_initial_shell_loader_keeps_current_tag_code_and_leaves_shared_index_to_verified_bootstrap(self):
        shell = (ROOT / 'ops/updater/install.sh').read_text()
        code = shell.split('TARGET=$("$PY" -B - "$WORK" "$@" <<\'PY\'\n', 1)[1].split('\nPY\n', 1)[0]
        owner = self
        class Opener:
            def open(self, request, **kwargs):
                return owner.fetch(request.full_url, **kwargs)
        with patch.object(BOOTSTRAP.sys, 'argv', ['loader', self.temp.name]), \
                patch.object(BOOTSTRAP.urllib.request, 'build_opener', return_value=Opener()), \
                redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()):
            exec(compile(code, 'install.sh loader', 'exec'), {})
        self.assertEqual(output.getvalue().strip(), self.tag+' '+self.commit)
        self.assertNotIn(self.gh('release-assets.json'), self.requests)
        for name in ['bootstrap-manifest.json', 'tavern-updater-bootstrap.py']:
            self.assertEqual((Path(self.temp.name)/name).read_bytes(), self.current[name])
            self.assertIn(self.gh(name), self.requests)

    def test_catalogue_and_index_redirects_cannot_change_repository_or_host(self):
        api = f'https://api.github.com/repos/{BOOTSTRAP.REPO}/releases/latest'
        for original, destination in [(api, 'https://evil.example/release.json'),
                (api, api.replace(BOOTSTRAP.REPO, 'other/repository')),
                (self.gh('release-assets.json'), 'https://evil.example/release-assets.json'),
                (self.gh('release-assets.json'), self.gh('release-assets.json', self.baseline))]:
            with self.subTest(destination=destination), self.assertRaisesRegex(RuntimeError, '受信任来源'):
                BOOTSTRAP.ReleaseRedirect().redirect_request(BOOTSTRAP.urllib.request.Request(original), None, 302, 'Found', {}, destination)
        BOOTSTRAP.validate_source('https://objects.githubusercontent.com/release/fixture?signature=fixture',
                                 self.gh('component.tar.gz', self.baseline))


if __name__ == '__main__':
    unittest.main()
