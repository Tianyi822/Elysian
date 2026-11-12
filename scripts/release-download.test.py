#!/usr/bin/env python3
"""不访问网络的发布包校验契约测试。"""
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_download', Path(__file__).with_name('release-download.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
COMMIT = 'a' * 40


def archive(change=None, arch="amd64"):
    binary = b'\x7fELF\x02\x01' + bytes(12) + ({'amd64': 62, 'arm64': 183}[arch]).to_bytes(2, 'little')
    digest = hashlib.sha256(binary).hexdigest()
    manifest = dict(schema='elysian-release/v1', repository=release.REPO,
                    commit=COMMIT, os='linux', arch=arch,
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
            entry = tarfile.TarInfo(f'elysian-linux-{arch}/' + name)
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
            if '/releases?per_page=' in target:
                return io.BytesIO(json.dumps([
                    dict(tag_name='build-' + 'b' * 40, draft=True),
                    dict(tag_name='v0.0.1', draft=False),
                    dict(tag_name='build-' + COMMIT, draft=False),
                ]).encode())
            raise AssertionError('意外的请求：' + target)

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

    def test_download_defaults_to_latest_published_build(self):
        # 默认目标取最新已发布的 build-<SHA>：跳过草稿与非 build 标签（仅 v* 标签触发构建）。
        requests = self.download(archive(), requested='')
        self.assertEqual(len(requests), 3)
        self.assertIn('/releases?per_page=', requests[0])
        self.assertIn('/releases/tags/build-' + COMMIT, requests[1])

    def test_download_rejects_when_no_published_build(self):
        def get(target):
            if '/releases?per_page=' in target:
                return io.BytesIO(json.dumps([dict(tag_name='v0.0.1', draft=False)]).encode())
            raise AssertionError('意外的请求：' + target)
        with tempfile.TemporaryDirectory() as temporary, patch.object(release, 'get', get):
            with self.assertRaises(ValueError):
                release.download(Path(temporary) / 'bundle', 'amd64', '')

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


class GiteeDownloadTest(unittest.TestCase):
    def fixture(self, change=None):
        body = archive()
        base = f'https://gitee.com/{release.GITEE_REPO}/releases/download/build-{COMMIT}/'
        index = dict(schema=release.INDEX_SCHEMA, repository=release.REPO, commit=COMMIT, os='linux', artifacts={})
        assets = []
        for arch in ['amd64', 'arm64']:
            name = f'elysian-linux-{arch}.tar.gz'
            index['artifacts'][arch] = dict(name=name, size=len(body), sha256=hashlib.sha256(body).hexdigest())
            assets.extend([dict(name=name, size=len(body), browser_download_url=base+name),
                           dict(name=name+'.sha256', size=93, browser_download_url=base+name+'.sha256')])
        if change:
            change(index, assets)
        marker = json.dumps(index).encode()
        assets.append(dict(name='release-index.json', size=len(marker), browser_download_url=base+'release-index.json'))
        requests = []
        def get(url):
            requests.append(url)
            self.assertNotIn('github', url)
            if url == base+'release-index.json':
                return io.BytesIO(marker)
            if url == base+'elysian-linux-amd64.tar.gz':
                return io.BytesIO(body)
            if '/releases/tags/' in url:
                result = dict(id=1, tag_name='build-'+COMMIT, prerelease=True)
            elif '/attach_files?' in url:
                result = assets
            elif '/releases?' in url:
                result = [dict(tag_name='v1.0.0'), dict(tag_name='build-'+COMMIT)]
            elif '/tags?' in url:
                result = [dict(name='build-'+COMMIT, commit=dict(sha=COMMIT))]
            else:
                raise AssertionError(url)
            return io.BytesIO(json.dumps(result).encode())
        return get, requests

    def test_gitee_default_and_explicit_commit_never_contact_github(self):
        for requested in ['', COMMIT]:
            get, requests = self.fixture()
            with tempfile.TemporaryDirectory() as temp, patch.object(release, 'get', get):
                output = Path(temp)/'bundle'
                self.assertEqual(release.download(output, 'amd64', requested, 'gitee'), COMMIT)
            self.assertTrue(requests[-1].endswith('.tar.gz'))

    def test_gitee_rejects_index_identity_digest_and_incomplete_architectures(self):
        for change in [lambda i, a: i.update(commit='b'*40),
                       lambda i, a: i['artifacts']['amd64'].update(sha256='0'*64),
                       lambda i, a: a.pop(2),
                       lambda i, a: a[0].update(browser_download_url='https://example.com/package')]:
            get, _ = self.fixture(change)
            with tempfile.TemporaryDirectory() as temp, patch.object(release, 'get', get), self.assertRaises(ValueError):
                release.download(Path(temp)/'bundle', 'amd64', COMMIT, 'gitee')

    def test_gitee_rejects_foreign_and_insecure_redirects(self):
        handler = release.GiteeRedirect()
        request = urllib.request.Request('https://gitee.com/attachment')
        for url in ['http://gitee.com/a', 'https://example.com/a', 'https://gitee.com.evil/a', 'https://gitee.com:444/a']:
            with self.assertRaises(ValueError):
                handler.redirect_request(request, None, 302, '', {}, url)


if __name__ == '__main__':
    unittest.main()
