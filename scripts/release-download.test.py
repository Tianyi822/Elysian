#!/usr/bin/env python3
"""不访问网络的发布包校验契约测试。"""
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_download', Path(__file__).with_name('release-download.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
COMMIT = 'a' * 40


def archive(change=None):
    binary = b'\x7fELF\x02\x01' + bytes(12) + (62).to_bytes(2, 'little')
    digest = hashlib.sha256(binary).hexdigest()
    manifest = dict(schema='elysian-release/v1', repository=release.REPO,
                    commit=COMMIT, os='linux', arch='amd64',
                    files={'elysian': digest, 'platform-helper': digest})
    files = {'elysian': binary, 'platform-helper': binary, 'release.json': json.dumps(manifest).encode()}
    for script in release.SCRIPTS:
        files['scripts/' + script] = b'fixture'
        manifest['files']['scripts/' + script] = hashlib.sha256(b'fixture').hexdigest()
    files['release.json'] = json.dumps(manifest).encode()
    if change:
        change(files)
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as bundle:
        for name, content in files.items():
            entry = tarfile.TarInfo('elysian-linux-amd64/' + name)
            entry.size = len(content)
            bundle.addfile(entry, io.BytesIO(content))
    return output.getvalue()


class DownloadTest(unittest.TestCase):
    def download(self, content, change=None, requested=COMMIT):
        url = f'https://github.com/{release.REPO}/releases/download/build-{COMMIT}/elysian-linux-amd64.tar.gz'
        asset = dict(name='elysian-linux-amd64.tar.gz', browser_download_url=url,
                     state='uploaded', size=len(content), digest='sha256:' + hashlib.sha256(content).hexdigest())
        if change:
            change(asset)
        requests = []

        def get(target):
            requests.append(target)
            if target == url:
                return io.BytesIO(content)
            if '/releases/tags/' in target:
                return io.BytesIO(json.dumps(dict(tag_name='build-' + COMMIT, draft=False, assets=[asset])).encode())
            if '/commits/' in target:
                return io.BytesIO(json.dumps(dict(sha=COMMIT)).encode())
            return io.BytesIO(json.dumps(dict(default_branch='main')).encode())

        with tempfile.TemporaryDirectory() as temporary, patch.object(release, 'get', get):
            output = Path(temporary) / 'bundle'
            output.mkdir()
            unrelated = Path(temporary) / 'unrelated'
            unrelated.write_bytes(b'keep')
            (Path(temporary) / 'elysian-linux-amd64.tar.gz.download').symlink_to(unrelated)
            self.assertEqual(release.download(output, 'amd64', requested), COMMIT)
            self.assertEqual(release.verify(output, 'amd64', COMMIT), COMMIT)
            self.assertEqual(unrelated.read_bytes(), b'keep')
        return requests

    def test_download_pins_default_branch_and_verifies(self):
        requests = self.download(archive(), requested='')
        self.assertEqual(len(requests), 4)
        self.assertIn('/releases/tags/build-' + COMMIT, requests[2])

    def test_rejects_metadata_and_content_corruption(self):
        for key, value in [('digest', 'sha256:' + '0' * 64), ('size', 1),
                           ('browser_download_url', 'https://example.com/evil'), ('state', 'new')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.download(archive(), lambda asset: asset.update({key: value}))
        for name, body in [('elysian', b'corrupt'), ('release.json', b'{}'),
                           ('../escape', b'escape'), ('release.json', b' ' * 65537)]:
            with self.subTest(name=name), self.assertRaises((ValueError, tarfile.ReadError)):
                self.download(archive(lambda files: files.update({name: body})))
        with self.assertRaises(tarfile.ReadError):
            self.download(b'<html>not an archive</html>')

    def test_rejects_wrong_arch_commit_and_symlink_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = directory / 'release.json'
            manifest.write_text(json.dumps(dict(schema='elysian-release/v1', repository=release.REPO,
                                               commit=COMMIT, os='linux', arch='amd64', files={})))
            for arch, commit in [('arm64', COMMIT), ('amd64', 'b' * 40)]:
                with self.assertRaises(ValueError):
                    release.verify(directory, arch, commit)
            manifest.rename(directory / 'real.json')
            manifest.symlink_to(directory / 'real.json')
            with self.assertRaises(ValueError):
                release.verify(directory, 'amd64', COMMIT)

    def test_metadata_is_bounded(self):
        with patch.object(release, 'get', lambda _: io.BytesIO(b' ' * ((2 << 20) + 1))):
            with self.assertRaises(ValueError):
                release.metadata('https://api.github.com/')


if __name__ == '__main__':
    unittest.main()
