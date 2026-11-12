#!/usr/bin/env python3
"""Gitee single formal releases; immutable attachments and explicit legacy migration."""
import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

spec = importlib.util.spec_from_file_location('release_download', Path(__file__).with_name('release-download.py'))
download = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download)
REPO = download.GITEE_REPO
API = 'https://gitee.com/api/v5/repos/' + REPO
MAX_FILE = 100000000
MAX_TOTAL = 1000000000


class Publisher:
    def __init__(self, token):
        if not token:
            raise ValueError('缺少安全环境变量 ELYSIAN_GITEE_TOKEN')
        self.token = token

    def request(self, path, fields=None, file=None, method=None):
        # GET metadata is public. Tokens occur only in request bodies, never URLs or logs.
        body, headers = None, {'User-Agent': 'Elysian-release-publisher', 'Accept': 'application/json'}
        if fields is not None or file is not None:
            fields = dict(fields or {}, access_token=self.token)
            if file:
                boundary = 'elysian-' + os.urandom(24).hex()
                parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode() for key, value in fields.items()]
                parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode(), file.read_bytes(), f'\r\n--{boundary}--\r\n'.encode()])
                body = b''.join(parts)
                headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary
            else:
                body = urllib.parse.urlencode(fields).encode()
                headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8'
        req = urllib.request.Request(API + path, data=body, headers=headers, method=method)
        # Mutation redirects must not forward credentials to another host.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args):
                raise ValueError('Gitee 发布 API 不允许重定向')
        try:
            with urllib.request.build_opener(NoRedirect()).open(req, timeout=600 if file else 60) as response:
                result = response.read((4 << 20) + 1)
                if len(result) > 4 << 20:
                    raise ValueError('Gitee 发布响应过大')
                return json.loads(result) if result.strip() else None
        except urllib.error.HTTPError as error:
            if error.code == 404 and req.get_method() == 'GET':
                return None
            raise ValueError(f'Gitee 发布请求失败：HTTP {error.code}；保留已上传内容，可重跑核实') from None

    def pages(self, path):
        for page in range(1, 101):
            rows = self.request(f'{path}{"&" if "?" in path else "?"}per_page=100&page={page}')
            if not isinstance(rows, list):
                raise ValueError('Gitee 列表响应无效')
            yield from rows
            if len(rows) < 100:
                return
        raise ValueError('Gitee 列表超出查询范围')

    def tag(self, tag, commit, create=False):
        for row in self.pages('/tags'):
            if row['name'] == tag:
                if row.get('commit', {}).get('sha') != commit:
                    raise ValueError('Gitee 现有标签指向其他提交，拒绝修改')
                return
        if not create:
            raise ValueError('触发标签尚未同步到 Gitee')
        self.request('/tags', {'tag_name': tag, 'refs': commit})
        self.tag(tag, commit)

    def release(self, tag, commit, prerelease, notes):
        path = '/releases/tags/' + urllib.parse.quote(tag, safe='')
        existing = self.request(path)
        if existing is None:
            self.request('/releases', dict(tag_name=tag, target_commitish=commit, name=tag,
                                          body=notes, prerelease=str(prerelease).lower()))
            existing = self.request(path)
        if not existing or existing.get('tag_name') != tag or existing.get('prerelease') is not prerelease:
            raise ValueError('Gitee 现有 Release 身份不符，拒绝覆盖')
        self.tag(tag, commit)
        return existing

    def attachments(self, release):
        rows = list(self.pages(f"/releases/{release['id']}/attach_files"))
        result = {row['name']: row for row in rows}
        if len(rows) != len(result):
            raise ValueError('Gitee Release 存在重名附件，拒绝继续')
        return result

    def upload(self, release, file):
        if not 0 < file.stat().st_size <= MAX_FILE:
            raise ValueError('附件超出 Gitee 单文件 100 MB 限额')
        self.request(f"/releases/{release['id']}/attach_files", file=file)

    def update_notes(self, release, notes):
        if release.get('body') != notes:
            self.request(f"/releases/{release['id']}", dict(tag_name=release['tag_name'],
                         name=release['tag_name'], body=notes, prerelease='false'), method='PATCH')
        current = self.request('/releases/tags/' + urllib.parse.quote(release['tag_name'], safe=''))
        if not current or current.get('id') != release['id'] or current.get('prerelease') is not False or current.get('body') != notes:
            raise ValueError('Gitee 正式版说明更新结果未确认，保留预览发行版')

    def remove_preview(self, release, commit):
        # Explicit migration only; ordinary publishing never deletes releases or tags.
        current = self.request('/releases/tags/' + release['tag_name'])
        if current is None:
            return
        if current.get('id') != release['id'] or current.get('prerelease') is not True or current.get('tag_name') != 'build-' + commit:
            raise ValueError('Gitee 预览发行版身份已变化，拒绝删除')
        self.tag(current['tag_name'], commit)
        self.request(f"/releases/{current['id']}", {}, method='DELETE')

    def quota(self, needed):
        used = 0
        for release in self.pages('/releases'):
            used += sum(row['size'] for row in self.attachments(release).values())
        if used + needed > MAX_TOTAL:
            raise ValueError('Gitee 已知 Release 附件将超过仓库 1 GB 限额；保留历史，请人工处理额度')


def fetch_attachment(asset, expected_url, destination):
    if asset.get('browser_download_url') != expected_url or type(asset.get('size')) is not int or not 0 < asset['size'] <= MAX_FILE:
        raise ValueError('Gitee 已有附件地址或大小无效')
    digest = hashlib.sha256()
    count = 0
    with download.get(expected_url) as response, destination.open('xb') as output:
        while chunk := response.read(1 << 20):
            count += len(chunk)
            if count > asset['size']:
                raise ValueError('Gitee 已有附件超出登记大小')
            digest.update(chunk)
            output.write(chunk)
    if count != asset['size']:
        raise ValueError('Gitee 已有附件下载不完整')
    return digest.hexdigest()


def validate_archive(file, arch, commit):
    # Reuse the exact installer verifier, including archive path and ELF checks.
    import tarfile
    with tempfile.TemporaryDirectory(prefix='elysian-publish-verify-') as temporary:
        output = Path(temporary)
        total = 0
        with tarfile.open(file, 'r|gz') as bundle:
            for number, member in enumerate(bundle, 1):
                parts = Path(member.name).parts
                total += member.size
                if number > 5000 or total > 1024**3 or member.size < 0 or member.name.startswith('/') or '\\' in member.name or '..' in parts or not parts or parts[0] != f'elysian-linux-{arch}' or not (member.isfile() or member.isdir()):
                    raise ValueError('已有附件包含非法归档内容')
                target = output.joinpath(*parts[1:])
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif len(parts) > 1:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with target.open('xb') as dest, bundle.extractfile(member) as src:
                        import shutil
                        shutil.copyfileobj(src, dest)
        download.verify(output, arch, commit)


def release_notes(tag, commit):
    base = f'https://gitee.com/{REPO}/releases/download/{urllib.parse.quote(tag, safe="")}/'
    links = '\n'.join(f'- [{arch} 安装包]({base}elysian-linux-{arch}.tar.gz) · [SHA256]({base}elysian-linux-{arch}.tar.gz.sha256)' for arch in ['amd64', 'arm64'])
    return f'Linux amd64 / arm64 预编译安装包。提交：{commit}\n\n{links}'


def verify_release(release, commit, publisher, destination):
    """Read back every public byte, including the original index, without credentials."""
    tag = release['tag_name']
    base = f'https://gitee.com/{REPO}/releases/download/{urllib.parse.quote(tag, safe="")}/'
    assets = publisher.attachments(release)
    for arch in ['amd64', 'arm64']:
        _, asset = download.gitee_release_asset(arch, commit, tag, release['prerelease'])
        file = destination / asset['name']
        digest = fetch_attachment(asset, base + file.name, file)
        if 'sha256:' + digest != asset['digest']:
            raise ValueError('Gitee 已发布安装包 SHA256 校验失败')
        validate_archive(file, arch, commit)
        checksum = destination / (file.name + '.sha256')
        fetch_attachment(assets[checksum.name], base + checksum.name, checksum)
        if checksum.read_bytes() != f'{digest}  {file.name}\n'.encode():
            raise ValueError('Gitee 已发布校验文件与安装包不一致')
    marker = destination / 'release-index.json'
    fetch_attachment(assets[marker.name], base + marker.name, marker)


def publish(output, commit, tag, publisher):
    if not re.fullmatch(r'[a-f0-9]{40}', commit) or not tag.startswith('v'):
        raise ValueError('发布必须绑定完整 SHA 和 v* 标签')
    publisher.tag(tag, commit)
    base = f'https://gitee.com/{REPO}/releases/download/{urllib.parse.quote(tag, safe="")}/'
    existing = publisher.request('/releases/tags/' + urllib.parse.quote(tag, safe=''))
    if existing and existing.get('prerelease') is not False:
        raise ValueError('Gitee 现有 Release 身份不符，拒绝覆盖')
    existing_assets = publisher.attachments(existing) if existing else {}
    if 'release-index.json' in existing_assets:
        # A completed immutable release is authoritative, not the new build's BuildTime.
        release = existing
    else:
        for arch in ['amd64', 'arm64']:
            file = output / f'elysian-linux-{arch}.tar.gz'
            if not 0 < file.stat().st_size <= MAX_FILE:
                raise ValueError('安装包超出 Gitee 单文件 100 MB 限额')
            validate_archive(file, arch, commit)
        # Reserve conservatively before creating any public release.
        needed = 65536  # bounded readiness index; existing immutable bytes need no second reservation
        for arch in ['amd64', 'arm64']:
            name = f'elysian-linux-{arch}.tar.gz'
            if name not in existing_assets:
                needed += (output / name).stat().st_size
            if name + '.sha256' not in existing_assets:
                needed += 1024
        publisher.quota(needed)
        release = publisher.release(tag, commit, False, f'Linux amd64 / arm64 预编译安装包。提交：{commit}。release-index.json 上传完成后才可安装。')
        assets = publisher.attachments(release)
        index = dict(schema=download.INDEX_SCHEMA, repository=download.REPO, commit=commit, os='linux', artifacts={})
        with tempfile.TemporaryDirectory(prefix='elysian-gitee-publish-') as temporary:
            for arch in ['amd64', 'arm64']:
                name = f'elysian-linux-{arch}.tar.gz'
                file = output / name
                if name in assets:
                    file = Path(temporary) / name
                    digest = fetch_attachment(assets[name], base + name, file)
                    validate_archive(file, arch, commit)
                else:
                    digest = hashlib.sha256(file.read_bytes()).hexdigest()
                    publisher.upload(release, file)
                checksum = Path(temporary) / (name + '.sha256')
                checksum.write_text(f'{digest}  {name}\n')
                if checksum.name in assets:
                    remote = Path(temporary) / (checksum.name + '.remote')
                    fetch_attachment(assets[checksum.name], base + checksum.name, remote)
                    if remote.read_bytes() != checksum.read_bytes():
                        raise ValueError('已有校验文件与固定提交包不同，拒绝覆盖')
                else:
                    publisher.upload(release, checksum)
                index['artifacts'][arch] = dict(name=name, size=file.stat().st_size, sha256=digest)
            marker = Path(temporary) / 'release-index.json'
            marker.write_text(json.dumps(index, ensure_ascii=False, sort_keys=True) + '\n')
            publisher.upload(release, marker)
    with tempfile.TemporaryDirectory(prefix='elysian-gitee-readback-') as temporary:
        verify_release(release, commit, publisher, Path(temporary))
    publisher.update_notes(release, release_notes(tag, commit))
    print(f'Gitee 发布已核验：{tag} / {commit}')


if __name__ == '__main__':
    try:
        output, commit, tag = sys.argv[1:]
        publish(Path(output), commit, tag, Publisher(os.environ.get('ELYSIAN_GITEE_TOKEN', '')))
    except Exception as error:
        # Never echo an HTTP request, body or credential-bearing exception.
        if isinstance(error, (ValueError, OSError)) and not isinstance(error, urllib.error.URLError):
            print(str(error), file=sys.stderr)
        else:
            print('Gitee 发布结果未确认；保留现场，重跑会先核验已有产物', file=sys.stderr)
        sys.exit(1)
