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

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('download_bootstrap', ROOT / 'ops/updater/bootstrap.py')
BOOTSTRAP = importlib.util.module_from_spec(spec)
spec.loader.exec_module(BOOTSTRAP)
GH = 'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.3/a.tar.gz'
SF = 'https://downloads.sourceforge.net/project/nora-tavern/v2.4.3/a.tar.gz'


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
        for fail in ['403', 'interrupted']:
            urls = []
            def open_source(url, **kwargs):
                urls.append(url)
                if url == GH:
                    if fail == '403':
                        raise urllib.error.HTTPError(url, 403, 'Forbidden', {}, None)
                    return Interrupted(b'wrong partial bytes', url)
                return Response(self.body, url)
            with self.subTest(fail=fail), patch.object(BOOTSTRAP, 'open_source', side_effect=open_source):
                BOOTSTRAP.download(GH, self.target, expected_sha256=self.sha, expected_size=len(self.body))
                self.assertEqual(self.target.read_bytes(), self.body)
                self.assertEqual(urls, [GH, SF])
                self.assertEqual(list(self.target.parent.glob('*.part')), [])

    def test_hash_failure_does_not_switch_or_replace_existing_verified_file(self):
        self.target.write_bytes(b'keep existing')
        with patch.object(BOOTSTRAP, 'open_source', return_value=Response(b'x'*len(self.body), GH)) as fetch:
            with self.assertRaisesRegex(RuntimeError, '校验'):
                BOOTSTRAP.download(GH, self.target, expected_sha256=self.sha, expected_size=len(self.body))
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(self.target.read_bytes(), b'keep existing')

    def test_latest_release_falls_back_to_catalogue_and_freezes_exact_tag(self):
        release = {'tag_name': 'v2.4.3', 'draft': False, 'prerelease': False, 'assets': [{
            'name': 'a.tar.gz', 'state': 'uploaded', 'size': len(self.body), 'digest': 'sha256:'+self.sha,
            'browser_download_url': GH}]}
        urls = []
        def open_source(url, **kwargs):
            urls.append(url)
            if url.startswith('https://api.github.com/'):
                raise urllib.error.HTTPError(url, 429, 'Rate limited', {}, None)
            return Response(json.dumps(release).encode(), url)
        with patch.object(BOOTSTRAP, 'open_source', side_effect=open_source):
            selected = BOOTSTRAP.select_release()
        self.assertEqual(selected['tag_name'], 'v2.4.3')
        self.assertEqual(urls[-1], 'https://downloads.sourceforge.net/project/nora-tavern/channels/stable.json')

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
        urls=[]
        class Opener:
            def open(self, request, **kwargs):
                url=request.full_url;urls.append(url)
                if 'github.com' in url:
                    raise urllib.error.HTTPError(url,403,'Forbidden',{},None)
                return Response(json.dumps(release).encode() if url.endswith('stable.json') else files[url.rsplit('/',1)[1]],url)
        with patch.object(BOOTSTRAP.sys,'argv',['loader',str(self.target.parent)]), \
                patch.object(BOOTSTRAP.urllib.request,'build_opener',return_value=Opener()), \
                redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()):
            exec(compile(code,'install.sh loader','exec'),{})
        self.assertEqual(output.getvalue().strip(),'v2.4.3 '+'a'*40)
        self.assertEqual((self.target.parent/'tavern-updater-bootstrap.py').read_bytes(),bootstrap)
        self.assertTrue(all('/v2.4.3/' in url for url in urls if url.endswith('.py')))
        self.assertIn('--tag "$TAG"',shell)


if __name__ == '__main__':
    unittest.main()
