#!/usr/bin/env python3
"""Offline Gitee publish/retry/quota tests. No credentials or network."""
import importlib.util
import io
import json
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


publish = module('publish_gitee', 'publish-gitee.py')
fixtures = module('download_fixtures', 'release-download.test.py')
COMMIT = fixtures.COMMIT


class FakePublisher(publish.Publisher):
    def __init__(self):
        super().__init__('fixture-never-sent')
        self.tags = {'v1.0.0': COMMIT}
        self.releases = {}
        self.files = {}
        self.uploads = 0
        self.fail_after = None

    def request(self, path, fields=None, file=None):
        path = urllib.parse.urlsplit(path).path
        if path == '/tags':
            if fields:
                self.tags[fields['tag_name']] = fields['refs']
                return {}
            return [dict(name=k, commit=dict(sha=v)) for k, v in self.tags.items()]
        if path.startswith('/releases/tags/'):
            return self.releases.get(urllib.parse.unquote(path.split('/tags/')[1]))
        if path == '/releases':
            if fields:
                release = dict(fields, id=len(self.releases)+1, prerelease=fields['prerelease'] == 'true')
                self.releases[fields['tag_name']] = release
                return release
            return list(reversed(list(self.releases.values())))
        if path.endswith('/attach_files'):
            release = next(r for r in self.releases.values() if r['id'] == int(path.split('/')[2]))
            base = f"https://gitee.com/{publish.REPO}/releases/download/{release['tag_name']}/"
            if file:
                if self.fail_after is not None and self.uploads >= self.fail_after:
                    raise ValueError('fixture upload failure')
                if base + file.name in self.files:
                    raise AssertionError('attempted to overwrite an attachment')
                self.files[base + file.name] = file.read_bytes()
                self.uploads += 1
            return [dict(id=i+1, name=url[len(base):], size=len(body), browser_download_url=url)
                    for i, (url, body) in enumerate(self.files.items()) if url.startswith(base)]
        raise AssertionError(path)

    def get(self, url):
        if url in self.files:
            return io.BytesIO(self.files[url])
        prefix = 'https://gitee.com/api/v5/repos/' + publish.REPO
        if url.startswith(prefix):
            return io.BytesIO(json.dumps(self.request(url[len(prefix):])).encode())
        raise AssertionError(url)


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        for arch in ['amd64', 'arm64']:
            body = fixtures.archive(arch=arch)
            (self.output / f'elysian-linux-{arch}.tar.gz').write_bytes(body)
        self.publisher = FakePublisher()
        self.patch = patch.object(publish.download, 'get', self.publisher.get)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def run_publish(self):
        publish.publish(self.output, COMMIT, 'v1.0.0', self.publisher)

    def test_success_and_completed_rerun_never_overwrite(self):
        self.run_publish()
        self.assertEqual(self.publisher.uploads, 5)
        snapshot = dict(self.publisher.files)
        self.run_publish()
        self.assertEqual(self.publisher.files, snapshot)
        self.assertEqual(self.publisher.uploads, 5)
        self.assertIn('elysian-linux-arm64.tar.gz', self.publisher.releases['v1.0.0']['body'])
        self.assertFalse(any('/v1.0.0/' in url for url in snapshot))

    def test_transport_keeps_credentials_in_body_and_uploads_multipart(self):
        requests = []
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                return io.BytesIO(b'{}')
        publisher = publish.Publisher('fixture-secret')
        with patch.object(publish.urllib.request, 'build_opener', lambda *args: Opener()):
            publisher.request('/tags', dict(tag_name='build-'+COMMIT, refs=COMMIT))
            publisher.request('/releases/1/attach_files', file=self.output/'elysian-linux-amd64.tar.gz')
        self.assertEqual(urllib.parse.parse_qs(requests[0].data.decode())['access_token'], ['fixture-secret'])
        self.assertTrue(requests[1].get_header('Content-type').startswith('multipart/form-data; boundary='))
        self.assertIn(b'name="file"; filename="elysian-linux-amd64.tar.gz"', requests[1].data)
        self.assertTrue(all('fixture-secret' not in request.full_url for request in requests))

    def test_interrupted_upload_reuses_verified_existing_bytes(self):
        self.publisher.fail_after = 2
        with self.assertRaises(ValueError):
            self.run_publish()
        snapshot = dict(self.publisher.files)
        self.assertFalse(any(url.endswith('release-index.json') for url in snapshot))
        self.publisher.fail_after = None
        self.run_publish()
        for url, body in snapshot.items():
            self.assertEqual(self.publisher.files[url], body)
        self.assertEqual(self.publisher.uploads, 5)

    def test_foreign_tag_and_quota_refused_before_release_creation(self):
        self.publisher.tags['v1.0.0'] = 'b' * 40
        with self.assertRaises(ValueError):
            self.run_publish()
        self.assertEqual(self.publisher.releases, {})
        self.publisher.tags['v1.0.0'] = COMMIT
        with patch.object(publish, 'MAX_TOTAL', 1), self.assertRaises(ValueError):
            self.run_publish()
        self.assertEqual(self.publisher.releases, {})

    def test_resume_quota_reserves_only_missing_files(self):
        self.publisher.fail_after = 2
        with self.assertRaises(ValueError):
            self.run_publish()
        used = sum(map(len, self.publisher.files.values()))
        remaining = (self.output/'elysian-linux-arm64.tar.gz').stat().st_size + 1024 + 65536
        self.publisher.fail_after = None
        with patch.object(publish, 'MAX_TOTAL', used + remaining):
            self.run_publish()
        self.assertEqual(self.publisher.uploads, 5)

    def test_corrupt_partial_release_is_retained_without_marker(self):
        self.publisher.fail_after = 2
        with self.assertRaises(ValueError):
            self.run_publish()
        url = next(url for url in self.publisher.files if url.endswith('.sha256'))
        self.publisher.files[url] = b'corrupt'
        self.publisher.fail_after = None
        with self.assertRaises(ValueError):
            self.run_publish()
        self.assertEqual(self.publisher.files[url], b'corrupt')
        self.assertFalse(any(url.endswith('release-index.json') for url in self.publisher.files))


if __name__ == '__main__':
    unittest.main()
