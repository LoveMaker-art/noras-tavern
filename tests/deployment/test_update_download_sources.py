import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch
from contextlib import redirect_stdout, redirect_stderr
from .test_standalone_release_sources import DEFAULT as LEGACY_SOURCES, module_at

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('download_bootstrap', ROOT / 'ops/updater/bootstrap.py')
BOOTSTRAP = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BOOTSTRAP)
LEGACY_BOOTSTRAP = module_at('ops/updater/bootstrap.py', LEGACY_SOURCES)
GH = 'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.3/a.tar.gz'
SF = 'https://downloads.sourceforge.net/project/nora-tavern/v2.4.3/a.tar.gz'
JH = 'https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/v2.4.3/a.tar.gz'
API = 'https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest'
JH_CHANNEL = 'https://jihulab.com/LoveMaker-art/nora-tavern/-/raw/main/channels/stable.json'
SF_CHANNEL = 'https://downloads.sourceforge.net/project/nora-tavern/channels/stable.json'


class Response(io.BytesIO):
    def __init__(self, body, url):
        super().__init__(body)
        self.url = url
    def geturl(self):
        return self.url


class DownloadSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name) / 'asset'
        self.body = b'verified payload'
        self.sha = hashlib.sha256(self.body).hexdigest()

    def test_forbidden_and_midstream_failure_switch_same_file_without_concatenating(self):
        class Interrupted(Response):
            def read(self, size=-1):
                if self.tell():
                    raise urllib.error.URLError('connection lost')
                return super().read(3)
        for module, sources in [(BOOTSTRAP, [JH, GH, SF]), (LEGACY_BOOTSTRAP, [GH, SF])]:
            self.assertEqual(module.source_candidates(GH), sources)
            for fail in ['403', 'interrupted']:
                urls = []
                def open_source(url, **kwargs):
                    self.assertIn(url, sources)
                    urls.append(url)
                    if url in sources[:-1]:
                        if fail == 'interrupted' and url == sources[0]:
                            return Interrupted(b'wrong partial bytes', url)
                        raise urllib.error.HTTPError(url, 403, 'Forbidden', {}, None)
                    return Response(self.body, url)
                with self.subTest(primary=sources[0], fail=fail), patch.object(module, 'open_source', side_effect=open_source):
                    module.download(GH, self.target, expected_sha256=self.sha, expected_size=len(self.body))
                    self.assertEqual(self.target.read_bytes(), self.body)
                    self.assertEqual(urls, sources)
                    self.assertEqual(list(self.target.parent.glob('*.part')), [])

    def test_hash_failure_does_not_switch_or_replace_existing_verified_file(self):
        for module, source in [(BOOTSTRAP, JH), (LEGACY_BOOTSTRAP, GH)]:
            self.target.write_bytes(b'keep existing')
            with self.subTest(source=source), patch.object(module, 'open_source', return_value=Response(b'x'*len(self.body), source)) as fetch:
                with self.assertRaisesRegex(RuntimeError, '校验'):
                    module.download(GH, self.target, expected_sha256=self.sha, expected_size=len(self.body))
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(fetch.call_args.args[0], source)
            self.assertEqual(self.target.read_bytes(), b'keep existing')
            self.assertEqual(list(self.target.parent.glob('*.part')), [])

    def test_latest_release_falls_back_to_catalogue_and_freezes_exact_tag(self):
        release = {'tag_name': 'v2.4.3', 'draft': False, 'prerelease': False, 'assets': [{
            'name': 'a.tar.gz', 'state': 'uploaded', 'size': len(self.body), 'digest': 'sha256:'+self.sha,
            'browser_download_url': GH}]}
        urls = []
        def open_source(url, **kwargs):
            self.assertIn(url, [API, SF_CHANNEL])
            urls.append(url)
            if url == API:
                raise urllib.error.HTTPError(url, 429, 'Rate limited', {}, None)
            return Response(json.dumps(release).encode(), url)
        with patch.object(LEGACY_BOOTSTRAP, 'open_source', side_effect=open_source):
            selected = LEGACY_BOOTSTRAP.select_release()
        self.assertEqual(selected['tag_name'], 'v2.4.3')
        self.assertEqual(urls, [API, SF_CHANNEL])

    def test_current_default_queries_jihulab_and_downloads_the_fixed_tag_and_digest(self):
        release = {'tag_name': 'v2.4.3', 'draft': False, 'prerelease': False, 'assets': [{
            'name': 'a.tar.gz', 'state': 'uploaded', 'size': len(self.body), 'digest': 'sha256:'+self.sha,
            'browser_download_url': GH}]}
        fixed = 'https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/v2.4.3/release.json'
        routes = {JH_CHANNEL: json.dumps(release).encode(), fixed: json.dumps(release).encode(), JH: self.body}
        urls = []
        def open_source(url, **kwargs):
            self.assertIn(url, routes)
            urls.append(url)
            return Response(routes[url], url)
        self.assertEqual(BOOTSTRAP.RELEASE_SOURCES['primary'], 'jihulab')
        with patch.object(BOOTSTRAP, 'open_source', side_effect=open_source):
            selected = BOOTSTRAP.select_release()
            pinned = BOOTSTRAP.select_release(selected['tag_name'])
            BOOTSTRAP.download_asset(pinned, 'a.tar.gz', self.target, expected_sha256=self.sha)
        self.assertEqual(selected['tag_name'], 'v2.4.3')
        self.assertEqual(pinned['tag_name'], 'v2.4.3')
        self.assertEqual(pinned['asset_index']['a.tar.gz']['digest'], 'sha256:'+self.sha)
        self.assertEqual(urls, [JH_CHANNEL, fixed, JH])
        self.assertEqual(self.target.read_bytes(), self.body)

    def test_current_default_rejects_changed_physical_identity_without_switching(self):
        for response_url in [JH.replace('/378185/', '/378186/'), JH.replace('/v2.4.3/', '/v2.4.4/'),
                             JH.replace('a.tar.gz', 'b.tar.gz'), 'https://evil.example/a.tar.gz', GH]:
            self.target.write_bytes(b'keep existing')
            with self.subTest(response_url=response_url), patch.object(BOOTSTRAP, 'open_source',
                    return_value=Response(self.body, response_url)) as fetch:
                with self.assertRaisesRegex(RuntimeError, '来源'):
                    BOOTSTRAP.download(GH, self.target, expected_sha256=self.sha, expected_size=len(self.body))
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(fetch.call_args.args[0], JH)
            self.assertEqual(self.target.read_bytes(), b'keep existing')
            self.assertEqual(list(self.target.parent.glob('*.part')), [])

    def test_current_default_rejects_changed_fixed_catalogue_tag_without_switching(self):
        wrong_release = {'tag_name': 'v2.4.4', 'draft': False, 'prerelease': False, 'assets': []}
        fixed = 'https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/v2.4.3/release.json'
        with patch.object(BOOTSTRAP, 'open_source', return_value=Response(json.dumps(wrong_release).encode(), fixed)) as fetch:
            with self.assertRaisesRegex(RuntimeError, '身份'):
                BOOTSTRAP.select_release('v2.4.3')
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(fetch.call_args.args[0], fixed)

    def test_sourceforge_redirect_cannot_contact_untrusted_host_or_change_file(self):
        handler = BOOTSTRAP.ReleaseRedirect()
        for destination in ['https://evil.example/a.tar.gz', SF.replace('a.tar.gz', 'b.tar.gz'), SF.replace('https:', 'http:')]:
            with self.subTest(destination=destination), self.assertRaisesRegex(RuntimeError, '来源'):
                handler.redirect_request(BOOTSTRAP.urllib.request.Request(SF), None, 302, 'Found', {}, destination)

    def test_initial_shell_loader_freezes_tag_and_checks_both_downloaded_files_before_execution(self):
        shell = (ROOT / 'ops/updater/install.sh').read_text()
        code = shell.split('TARGET=$("$PY" -B - "$WORK" "$@" <<\'PY\'\n', 1)[1].split('\nPY\n', 1)[0]
        bootstrap = b'print("isolated bootstrap fixture")\n'
        manifest = json.dumps({'scope':'tavern-updater-bootstrap','sha256':hashlib.sha256(bootstrap).hexdigest(),'commit':'a'*40}).encode()
        files = {'bootstrap-manifest.json':manifest,'tavern-updater-bootstrap.py':bootstrap}
        release = {'tag_name':'v2.4.3','draft':False,'prerelease':False,'assets':[
            {'name':name,'state':'uploaded','size':len(body),'digest':'sha256:'+hashlib.sha256(body).hexdigest(),
             'browser_download_url':f'https://github.com/{BOOTSTRAP.REPO}/releases/download/v2.4.3/{name}'} for name,body in files.items()]}
        routes = {JH_CHANNEL: json.dumps(release).encode()}
        for asset in release['assets']:
            for source in BOOTSTRAP.source_candidates(asset['browser_download_url']):
                routes[source] = files[asset['name']]
        urls=[]
        test = self
        class Opener:
            def open(self, request, **kwargs):
                url=request.full_url;urls.append(url)
                test.assertIn(url, routes)
                return Response(routes[url],url)
        with patch.object(BOOTSTRAP.sys,'argv',['loader',str(self.target.parent)]), \
                patch.object(BOOTSTRAP.urllib.request,'build_opener',return_value=Opener()), \
                redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()):
            exec(compile(code,'install.sh loader','exec'),{})
        self.assertEqual(output.getvalue().strip(),'v2.4.3 '+'a'*40)
        self.assertEqual((self.target.parent/'tavern-updater-bootstrap.py').read_bytes(),bootstrap)
        self.assertEqual(urls, [JH_CHANNEL,
            'https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/v2.4.3/bootstrap-manifest.json',
            'https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/v2.4.3/tavern-updater-bootstrap.py'])
        self.assertTrue(all('/v2.4.3/' in url for url in urls if url.endswith('.py')))
        self.assertIn('--tag "$TAG"',shell)


if __name__ == '__main__':
    unittest.main()
