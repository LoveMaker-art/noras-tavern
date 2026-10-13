"""Exercise release routing through the downloaded entry points, without installing."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import ssl
import sys
import tempfile
import types
import unittest
import urllib.error
from contextlib import redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
DEFAULT = {"schema": 1, "primary": "github", "mirrors": [{"id": "sourceforge", "provider": "sourceforge",
    "baseUrl": "https://downloads.sourceforge.net/project/nora-tavern/"}]}
DOMESTIC = {"schema": 1, "primary": "domestic", "mirrors": [{"id": "domestic",
    "baseUrl": "https://sealed.example/nora/"}, DEFAULT["mirrors"][0]]}
JIHULAB = {"schema": 1, "primary": "jihulab", "mirrors": [{"id": "jihulab", "provider": "jihulab",
    "baseUrl": "https://jihulab.com/api/v4/projects/123/packages/generic/nora-tavern/",
    "channelBaseUrl": "https://jihulab.com/fixture/nora/-/raw/release-channels/"}, DEFAULT["mirrors"][0]]}
BLOCK = re.compile(r"# BEGIN BUILD-OWNED RELEASE SOURCES\n.*?\n# END BUILD-OWNED RELEASE SOURCES", re.S)
TAG = "v2.4.3"
REPO = "LoveMaker-art/noras-tavern"
COMMIT = "a" * 40


def configure(code, config):
    replacement = "# BEGIN BUILD-OWNED RELEASE SOURCES\nRELEASE_SOURCES = json.loads(" + repr(json.dumps(config)) + ")\n# END BUILD-OWNED RELEASE SOURCES"
    updated, count = BLOCK.subn(lambda _: replacement, code)
    if count != 1:
        raise AssertionError("Each standalone entry must contain one build-owned sources block")
    return updated


class Response(io.BytesIO):
    def __init__(self, body, url):
        super().__init__(body)
        self.url = url
    def geturl(self):
        return self.url


def module_at(relative, config=None):
    file = ROOT / relative
    module = types.ModuleType("standalone_release_test")
    module.__file__ = str(file)
    code = file.read_text()
    exec(compile(configure(code, config) if config else code, str(file), "exec"), module.__dict__)
    return module


def loader_code(entry, config):
    text = (ROOT / entry).read_text()
    if entry.endswith('.ps1'):
        code = text.split("$Loader = @'\n", 1)[1].split("\n'@", 1)[0]
    else:
        code = text.split('TARGET=$("$PY" -B - "$WORK" "$@" <<\'PY\'\n', 1)[1].split("\nPY\n", 1)[0]
    return configure(code, config)


class StandaloneReleaseSources(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.payload = b"verified standalone payload"
        self.sha = hashlib.sha256(self.payload).hexdigest()

    def catalogue(self, files):
        return {"tag_name": TAG, "draft": False, "prerelease": False, "assets": [
            {"name": name, "state": "uploaded", "size": len(body), "digest": "sha256:" + hashlib.sha256(body).hexdigest(),
             "browser_download_url": f"https://github.com/{REPO}/releases/download/{TAG}/{name}"}
            for name, body in files.items()]}

    def test_bootstraps_query_and_download_domestic_first_with_same_tag_identity(self):
        for entry in ["ops/installer/bootstrap.py", "ops/updater/bootstrap.py"]:
            module = module_at(entry, DOMESTIC)
            release = self.catalogue({"a.tar.gz": self.payload})
            requests = []
            def fetch(url, **kwargs):
                requests.append(url)
                return Response(json.dumps(release).encode() if url.endswith("stable.json") else self.payload, url)
            target = self.directory / "asset"
            with self.subTest(entry=entry), patch.object(module, "open_source", side_effect=fetch):
                selected = module.select_release()
                module.download_asset(selected, "a.tar.gz", target, expected_sha256=self.sha)
            self.assertEqual(requests, ["https://sealed.example/nora/channels/stable.json",
                f"https://sealed.example/nora/releases/{TAG}/a.tar.gz"])
            self.assertEqual(target.read_bytes(), self.payload)

    def test_bootstraps_keep_legacy_fallback_after_domestic_network_failures(self):
        for entry in ["ops/installer/bootstrap.py", "ops/updater/bootstrap.py"]:
            module = module_at(entry, JIHULAB)
            requested = []
            def fetch(url, **kwargs):
                requested.append(url)
                if not url.startswith("https://github.com/"):
                    raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)
                return Response(self.payload, url)
            url = f"https://github.com/{REPO}/releases/download/{TAG}/a.tar.gz"
            with self.subTest(entry=entry), patch.object(module, "open_source", side_effect=fetch):
                module.download(url, self.directory / "asset", expected_sha256=self.sha, expected_size=len(self.payload))
            self.assertEqual(requested, [JIHULAB["mirrors"][0]["baseUrl"] + TAG + "/a.tar.gz", url])
            module.validate_source(DEFAULT['mirrors'][0]['baseUrl'].replace('downloads.sourceforge.net',
                'zenlayer.dl.sourceforge.net')+TAG+'/a.tar.gz?via=mirror', DEFAULT['mirrors'][0]['baseUrl']+TAG+'/a.tar.gz')

    def test_bootstraps_do_not_hide_domestic_hash_or_certificate_failures(self):
        for entry in ['ops/installer/bootstrap.py', 'ops/updater/bootstrap.py']:
            module = module_at(entry, JIHULAB)
            target = self.directory / 'asset'
            target.write_bytes(b'previous verified bytes')
            url = f'https://github.com/{REPO}/releases/download/{TAG}/a.tar.gz'
            source = JIHULAB['mirrors'][0]['baseUrl'] + TAG + '/a.tar.gz'
            for failure in ['hash', 'certificate']:
                response = Response(b'x' * len(self.payload), source)
                error = urllib.error.URLError(ssl.SSLCertVerificationError('invalid certificate'))
                with self.subTest(entry=entry, failure=failure), patch.object(module, 'open_source',
                        side_effect=error if failure == 'certificate' else None, return_value=response) as fetch:
                    with self.assertRaises(Exception):
                        module.download(url, target, expected_sha256=self.sha, expected_size=len(self.payload))
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual(target.read_bytes(), b'previous verified bytes')

    def test_initial_loaders_freeze_release_and_verify_both_bytes_before_execution(self):
        for entry in ["ops/installer/install.sh", "ops/updater/install.sh", "ops/installer/install.ps1"]:
            code = loader_code(entry, DOMESTIC)
            first = "installer" in entry
            name = "nora-tavern-first-install-bootstrap.py" if first else "tavern-updater-bootstrap.py"
            manifest_name = "first-install-manifest.json" if first else "bootstrap-manifest.json"
            scope = "nora-tavern-first-install-bootstrap" if first else "tavern-updater-bootstrap"
            bootstrap = b"raise AssertionError('loader must not execute bootstrap')\n"
            files = {name: bootstrap, manifest_name: json.dumps({"scope": scope, "commit": COMMIT,
                "sha256": hashlib.sha256(bootstrap).hexdigest()}).encode()}
            catalogue = self.catalogue(files)
            requests = []
            class Opener:
                def open(self, request, **kwargs):
                    url = request.full_url
                    requests.append(url)
                    return Response(json.dumps(catalogue).encode() if url.endswith("stable.json") else files[url.rsplit("/", 1)[1]], url)
            with self.subTest(entry=entry), patch.object(sys, "argv", ["loader", self.temp.name]), \
                    patch("urllib.request.build_opener", return_value=Opener()), redirect_stdout(io.StringIO()) as output:
                exec(compile(code, entry + " loader", "exec"), {})
            self.assertEqual(output.getvalue().strip(), TAG + " " + COMMIT)
            self.assertEqual((self.directory / name).read_bytes(), bootstrap)
            self.assertEqual(requests[0], "https://sealed.example/nora/channels/stable.json")
            self.assertTrue(all(f"/releases/{TAG}/" in url for url in requests[1:]))

    def test_loader_hash_and_redirect_failures_do_not_fall_back_or_execute_downloaded_code(self):
        for entry in ['ops/installer/install.sh', 'ops/updater/install.sh', 'ops/installer/install.ps1']:
            first = 'installer' in entry
            name = 'nora-tavern-first-install-bootstrap.py' if first else 'tavern-updater-bootstrap.py'
            manifest_name = 'first-install-manifest.json' if first else 'bootstrap-manifest.json'
            scope = 'nora-tavern-first-install-bootstrap' if first else 'tavern-updater-bootstrap'
            files = {name: self.payload, manifest_name: json.dumps({'scope': scope, 'commit': COMMIT, 'sha256': self.sha}).encode()}
            catalogue = self.catalogue(files)
            for failure in ['hash', 'redirect', 'certificate']:
                requests = []
                class Opener:
                    def open(self, request, **kwargs):
                        url = request.full_url
                        requests.append(url)
                        if failure == 'certificate':
                            raise urllib.error.URLError(ssl.SSLCertVerificationError('invalid certificate'))
                        if url.endswith('stable.json'):
                            return Response(json.dumps(catalogue).encode(), url)
                        body = files[url.rsplit('/', 1)[1]]
                        if url.endswith(name):
                            return Response(b'x' * len(body) if failure == 'hash' else body,
                                'https://evil.example/'+name if failure == 'redirect' else url)
                        return Response(body, url)
                with self.subTest(entry=entry, failure=failure), patch.object(sys, 'argv', ['loader', self.temp.name]), \
                        patch('urllib.request.build_opener', return_value=Opener()), redirect_stdout(io.StringIO()) as output:
                    with self.assertRaises(Exception):
                        exec(compile(loader_code(entry, DOMESTIC), entry+' loader', 'exec'), {})
                self.assertEqual(output.getvalue(), '')
                self.assertEqual(len(requests), 1 if failure == 'certificate' else 3)
                self.assertTrue(all(url.startswith('https://sealed.example/') for url in requests))

    def test_first_loaders_keep_historical_no_digest_catalogues_and_verify_manifest_sha(self):
        name = 'nora-tavern-first-install-bootstrap.py'
        files = {name: self.payload, 'first-install-manifest.json': json.dumps({
            'scope': 'nora-tavern-first-install-bootstrap', 'commit': COMMIT, 'sha256': self.sha}).encode()}
        catalogue = self.catalogue(files)
        for asset in catalogue['assets']:
            asset.pop('digest')
        for entry in ['ops/installer/install.sh', 'ops/installer/install.ps1']:
            for tampered in (False, True):
                requests = []
                class Opener:
                    def open(self, request, **kwargs):
                        url = request.full_url
                        requests.append(url)
                        if url.endswith('stable.json'):
                            return Response(json.dumps(catalogue).encode(), url)
                        body = files[url.rsplit('/', 1)[1]]
                        return Response(b'x'*len(body) if tampered and url.endswith(name) else body, url)
                with self.subTest(entry=entry, tampered=tampered), patch.object(sys, 'argv', ['loader', self.temp.name]), \
                        patch('urllib.request.build_opener', return_value=Opener()), redirect_stdout(io.StringIO()) as output:
                    if tampered:
                        with self.assertRaisesRegex(SystemExit, 'checksum'):
                            exec(compile(loader_code(entry, DOMESTIC), entry+' loader', 'exec'), {})
                    else:
                        exec(compile(loader_code(entry, DOMESTIC), entry+' loader', 'exec'), {})
                        self.assertEqual(output.getvalue().strip(), TAG+' '+COMMIT)
                self.assertEqual(len(requests), 3)

    def test_checker_uses_domestic_channel_and_preserves_beta_format(self):
        with patch.dict(os.environ, {"HERMES_HOME": self.temp.name}, clear=True):
            checker = module_at("ops/scripts/nora-tavern-update-check.py", JIHULAB)
        with patch.object(checker, "query_release", return_value={"tag_name": TAG, "body": "sealed summary"}) as query:
            self.assertEqual(checker.latest_release(), (TAG[1:], "sealed summary"))
        self.assertEqual(query.call_args.args[0], JIHULAB["mirrors"][0]["channelBaseUrl"] + "channels/stable.json")
        home = self.directory / 'hermes'
        home.mkdir()
        (home/'nora-instance.json').write_text(json.dumps({'schema': 1, 'releaseChannel': 'beta',
            'noraHome': self.temp.name, 'hermesHome': str(home), 'installRoot': str(self.directory/'tavern'), 'port': 8799}))
        with patch.dict(os.environ, {'HERMES_HOME': str(home)}, clear=True):
            checker = module_at('ops/scripts/nora-tavern-update-check.py', JIHULAB)
        releases = [{'tag_name': 'v2.4.3-beta.1', 'draft': False, 'prerelease': True},
            {'tag_name': 'v2.4.3-beta.2', 'draft': False, 'prerelease': True}]
        with patch.object(checker, 'query_release', return_value=releases) as query:
            self.assertEqual(checker.latest_release()[0], '2.4.3-beta.2')
        self.assertEqual(query.call_args.args[0], JIHULAB['mirrors'][0]['channelBaseUrl']+'channels/beta.json')

    def test_checker_keeps_explicit_local_file_override_and_rejects_online_override(self):
        local = (self.directory/'release.json').as_uri()
        with patch.dict(os.environ, {'HERMES_HOME': self.temp.name, 'TAVERN_RELEASE_API_URL': local}, clear=True):
            checker = module_at('ops/scripts/nora-tavern-update-check.py', JIHULAB)
        self.assertEqual(checker.RELEASE_URLS, (local,))
        with patch.dict(os.environ, {'HERMES_HOME': self.temp.name, 'TAVERN_RELEASE_API_URL': 'https://evil.example/release.json'}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'file://'):
                module_at('ops/scripts/nora-tavern-update-check.py', JIHULAB)

    def test_build_owned_provider_redirects_never_contact_other_hosts_or_paths(self):
        for entry in ["ops/installer/bootstrap.py", "ops/updater/bootstrap.py"]:
            module = module_at(entry, JIHULAB)
            source = JIHULAB["mirrors"][0]["baseUrl"] + TAG + "/a.tar.gz"
            for target in [source.replace("jihulab.com", "evil.example"), source.replace(TAG, "v2.4.2"), source + "?token=external"]:
                with self.subTest(entry=entry, target=target), self.assertRaisesRegex(RuntimeError, "受信任"):
                    module.ReleaseRedirect().redirect_request(module.urllib.request.Request(source), None, 302, "", {}, target)


if __name__ == "__main__":
    unittest.main()
