"""Exercise the downloadable standalone bootstrap without running an installer."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('first_shared_bootstrap', ROOT / 'ops/installer/bootstrap.py')
FIRST = importlib.util.module_from_spec(spec)
spec.loader.exec_module(FIRST)
SHA = lambda body: hashlib.sha256(body).hexdigest()


class Response(io.BytesIO):
    def __init__(self, body, url):
        super().__init__(body)
        self.url = url
    def geturl(self):
        return self.url


class FirstInstallSharedAssets(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.tag, self.old, self.commit = 'v2.4.6', 'v2.4.5', 'b'*40
        self.payloads = {name: (name+' original sealed bytes').encode() for name in FIRST.ASSETS[2:]}
        self.manifest = {'schema': 'tavern-release/v2', 'candidate': False, 'commit': self.commit,
            'versions': {'tavern': self.tag[1:]}, 'bootstrap': {'minimumLauncherVersion': '2.1.2'},
            'archives': {name: {'name': name, 'sha256': SHA(body), 'size': len(body)} for name, body in self.payloads.items()}}
        self.index = {'schema': 'nora-release-assets/1', 'repository': FIRST.REPO, 'tag': self.tag,
            'commit': self.commit, 'minimumLauncherVersion': '2.1.2', 'assets': [
                {'name': name, 'asset_release_tag': self.old, 'size': len(body), 'sha256': SHA(body)}
                for name, body in self.payloads.items()]}
        self.requests = []
        self.reseal()

    def url(self, name, tag=None):
        return f'https://github.com/{FIRST.REPO}/releases/download/{tag or self.tag}/{name}'

    def reseal(self, shared=True):
        self.physical = {'release-manifest.json': json.dumps(self.manifest).encode()}
        self.physical['SHA256SUMS'] = ''.join(f'{SHA(body)}  {name}\n' for name, body in
            {**self.physical, **self.payloads}.items()).encode()
        if shared:
            self.physical['release-assets.json'] = (json.dumps(self.index)+'\n').encode()
        else:
            self.physical.update(self.payloads)
        self.release = {'tag_name': self.tag, 'draft': False, 'prerelease': False, 'assets': [
            {'name': name, 'state': 'uploaded', 'size': len(body), 'digest': 'sha256:'+SHA(body),
             'browser_download_url': self.url(name)} for name, body in self.physical.items()]}

    def fetch(self, url, **kwargs):
        self.requests.append(url)
        if url.startswith('https://api.github.com/') or url.endswith('/release.json'):
            return Response(json.dumps(self.release).encode(), url)
        name = url.rsplit('/', 1)[1]
        body = self.payloads[name] if f'/{self.old}/' in url else self.physical[name]
        return Response(body, url)

    def test_shared_first_install_uses_old_bytes_and_current_metadata_without_executing_install(self):
        with patch.object(FIRST, 'open_source', side_effect=self.fetch):
            selected = FIRST.download_release(self.directory)
        self.assertEqual(selected['tag_name'], self.tag)
        self.assertEqual(FIRST.verify_release(self.directory), SHA(self.physical['release-manifest.json']))
        for name, body in self.payloads.items():
            self.assertEqual((self.directory/name).read_bytes(), body)
            self.assertIn(self.url(name, self.old), self.requests)
        self.assertTrue(all('/latest/download/' not in url for url in self.requests))

    def test_legacy_first_install_keeps_current_tag_and_accepts_historical_catalogue_without_digests(self):
        self.reseal(shared=False)
        for asset in self.release['assets']:
            asset.pop('digest')
        with patch.object(FIRST, 'open_source', side_effect=self.fetch):
            selected = FIRST.download_release(self.directory, self.tag)
        self.assertNotIn('shared_assets', selected)
        FIRST.verify_release(self.directory)
        self.assertEqual(self.requests[0], f'https://api.github.com/repos/{FIRST.REPO}/releases/tags/{self.tag}')
        self.assertTrue(all(f'/{self.old}/' not in url for url in self.requests))

    def test_sourceforge_fetch_reuses_the_same_old_tag_and_same_verified_bytes(self):
        name = FIRST.ASSETS[2]
        def fetch(url, **kwargs):
            if url == self.url(name, self.old):
                self.requests.append(url)
                raise urllib.error.HTTPError(url, 403, 'Forbidden', {}, None)
            return self.fetch(url, **kwargs)
        with patch.object(FIRST, 'open_source', side_effect=fetch):
            FIRST.download_release(self.directory)
        self.assertIn(FIRST.SOURCEFORGE+self.old+'/'+name, self.requests)
        self.assertEqual((self.directory/name).read_bytes(), self.payloads[name])
        with self.assertRaisesRegex(RuntimeError, '受信任'):
            FIRST.validate_source(FIRST.SOURCEFORGE+self.tag+'/'+name, FIRST.SOURCEFORGE+self.old+'/'+name)

    def test_consumed_refs_need_original_manifest_commit_hash_and_size_before_payloads(self):
        original = copy.deepcopy(self.manifest)
        name = FIRST.ASSETS[2]
        mutations = [lambda: self.manifest.update(commit='c'*40),
            lambda: self.manifest['bootstrap'].update(minimumLauncherVersion='2.1.1'),
            lambda: self.manifest['archives'][name].pop('size'),
            lambda: self.manifest['archives'][name].update(size=len(self.payloads[name])+1),
            lambda: self.manifest['archives'][name].update(sha256='c'*64)]
        for mutate in mutations:
            self.manifest = copy.deepcopy(original)
            mutate()
            self.reseal()
            self.requests.clear()
            with patch.object(FIRST, 'open_source', side_effect=self.fetch), self.assertRaises(RuntimeError):
                FIRST.download_release(self.directory)
            self.assertTrue(all(not url.endswith('.tar.gz') for url in self.requests))

    def test_invalid_index_or_bytes_cannot_switch_source_or_replace_existing_target(self):
        original = copy.deepcopy(self.index)
        for changes in [{'asset_release_tag': self.tag}, {'name': 'darwin-arm64-release-manifest.json'},
                        {'name': 'darwin-arm64-SHA256SUMS'},
                        {'name': 'darwin-arm64-first-install-manifest.json'},
                        {'name': 'darwin-arm64-nora-tavern-first-install-bootstrap.py'},
                        {'name': 'darwin-arm64-tavern-updater-bootstrap.py'},
                        {'name': 'Nora-Tavern-Launcher-2.1.2-win32-x64-update.zip'},
                        {'name': 'install-nora-tavern.sh'}, {'url': 'https://evil.example/asset'}]:
            self.index = copy.deepcopy(original)
            self.index['assets'][0].update(changes)
            self.reseal()
            self.requests.clear()
            with patch.object(FIRST, 'open_source', side_effect=self.fetch), self.assertRaises(RuntimeError):
                FIRST.download_release(self.directory)
            self.assertEqual(len(self.requests), 2)
        self.index = original
        self.reseal()
        with patch.object(FIRST, 'open_source', side_effect=self.fetch):
            selected = FIRST.select_release()
        name = FIRST.ASSETS[2]
        existing = self.directory/name
        existing.write_bytes(b'keep previous verified file')
        with patch.object(FIRST, 'open_source', return_value=Response(b'x'*len(self.payloads[name]), self.url(name,self.old))) as fetch:
            with self.assertRaisesRegex(RuntimeError, '哈希校验'):
                FIRST.download_asset(selected, name, existing, expected_sha256=SHA(self.payloads[name]))
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(existing.read_bytes(), b'keep previous verified file')

    def test_api_and_asset_redirects_cannot_introduce_an_arbitrary_trusted_source(self):
        api = f'https://api.github.com/repos/{FIRST.REPO}/releases/latest'
        for original, destination in [(api, 'https://evil.example/release.json'),
                (api, api.replace(FIRST.REPO, 'other/repository')),
                (self.url('release-assets.json'), 'https://evil.example/release-assets.json'),
                (self.url('release-assets.json'), self.url('release-assets.json', self.old))]:
            with self.subTest(destination=destination), self.assertRaisesRegex(RuntimeError, '受信任来源'):
                FIRST.ReleaseRedirect().redirect_request(FIRST.urllib.request.Request(original), None, 302, 'Found', {}, destination)
        FIRST.validate_source('https://release-assets.githubusercontent.com/github-production-release-asset/fixture?signature=fixture',
                              self.url(FIRST.ASSETS[2], self.old))


if __name__ == '__main__':
    unittest.main()
