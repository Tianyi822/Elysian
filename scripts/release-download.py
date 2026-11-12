#!/usr/bin/env python3
"""安装器的 GitHub／Gitee 预编译下载与严格解包；不执行包内代码。"""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import tarfile
import tempfile
import time
import urllib.request
import urllib.parse
from pathlib import Path

REPO = 'Tianyi822/Elysian'
GITEE_REPO = 'Chentyit/Elysian'
INDEX_SCHEMA = 'elysian-release-index/v1'
LIMIT = 256 * 1024 * 1024
SCRIPTS = ['install.sh', 'install-release.sh', 'uninstall.sh', 'tui.sh', 'platform-lifecycle.sh',
           'docker-apt.sh', 'install-platform.mjs', 'release-download.py', 'README-deploy.md']
class GitHubRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, url):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname not in {'github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}:
            raise ValueError('GitHub 安装包重定向地址不允许')
        return super().redirect_request(req, fp, code, msg, headers, url)
class GiteeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, url):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.netloc not in {'gitee.com', 'foruda.gitee.com'} or parsed.username:
            raise ValueError('Gitee 安装包重定向地址不允许')
        return super().redirect_request(req, fp, code, msg, headers, url)
OPENER = urllib.request.build_opener(GitHubRedirect())
GITEE_OPENER = urllib.request.build_opener(GiteeRedirect())
def get(url):
    opener = GITEE_OPENER if urllib.parse.urlsplit(url).hostname == 'gitee.com' else OPENER
    return opener.open(urllib.request.Request(url, headers={'User-Agent': 'Elysian-installer', 'Accept': 'application/json' if opener is GITEE_OPENER else 'application/vnd.github+json'}), timeout=60)
def metadata(url):
    with get(url) as response:
        data = response.read((2 << 20) + 1)
    if len(data) > 2 << 20:
        raise ValueError('发布元数据过大')
    return json.loads(data)

def github_asset(arch, requested):
    if requested and not re.fullmatch(r'[a-f0-9]{40}', requested):
        raise ValueError('ELYSIAN_COMMIT 必须是完整的 40 位提交 SHA')
    if requested:
        commit = requested
    else:
        # 仅 v* 标签触发构建：默认安装目标取最新已发布的 build-<SHA> 预发布（最新打标签
        # 的提交），跳过草稿与非 build 标签；未打标签的提交没有可安装产物。
        releases = metadata(f'https://api.github.com/repos/{REPO}/releases?per_page=30')
        if not isinstance(releases, list):
            raise ValueError('GitHub 发布列表无效')
        commit = next((entry['tag_name'][6:] for entry in releases
                       if isinstance(entry, dict) and not entry.get('draft')
                       and re.fullmatch(r'build-[a-f0-9]{40}', entry.get('tag_name') or '')), '')
        if not commit:
            raise ValueError('暂无已发布的预编译安装包；请先推送 v* 标签触发构建')
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('GitHub 返回的提交无效')
    tag = 'build-' + commit
    release = metadata(f'https://api.github.com/repos/{REPO}/releases/tags/{tag}')
    if release.get('draft') or release.get('tag_name') != tag:
        raise ValueError('GitHub 预编译版本尚未发布')
    name = f'elysian-linux-{arch}.tar.gz'
    asset = next((a for a in release.get('assets', []) if a['name'] == name), None)
    url = f'https://github.com/{REPO}/releases/download/{tag}/{name}'
    if not asset or asset.get('browser_download_url') != url or asset.get('state') != 'uploaded' or not 0 < asset.get('size', 0) <= LIMIT or not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest', '')):
        raise ValueError('预编译安装包尚未就绪，或 GitHub 文件摘要无效；请等待 Actions 完成后重试')
    return commit, asset

def gitee_releases():
    for page in range(1, 101):
        rows = metadata(f'https://gitee.com/api/v5/repos/{GITEE_REPO}/releases?direction=desc&per_page=100&page={page}')
        if not isinstance(rows, list):
            raise ValueError('Gitee 发布列表无效')
        yield from rows
        if len(rows) < 100:
            return
    raise ValueError('Gitee 发布列表超出查询范围')

def gitee_tag_commit(tag):
    for page in range(1, 101):
        rows = metadata(f'https://gitee.com/api/v5/repos/{GITEE_REPO}/tags?per_page=100&page={page}')
        if not isinstance(rows, list):
            raise ValueError('Gitee 标签列表无效')
        for row in rows:
            if row.get('name') == tag:
                sha = row.get('commit', {}).get('sha', '')
                if not re.fullmatch(r'[a-f0-9]{40}', sha):
                    raise ValueError('Gitee 标签提交无效')
                return sha
        if len(rows) < 100:
            break
    raise ValueError('Gitee 发版标签不存在或超出查询范围')

class GiteeNotReady(ValueError):
    pass

def gitee_asset(arch, requested):
    if requested and not re.fullmatch(r'[a-f0-9]{40}', requested):
        raise ValueError('ELYSIAN_COMMIT 必须是完整的 40 位提交 SHA')
    for row in gitee_releases():
        tag = row.get('tag_name') or ''
        if not tag.startswith('v') or row.get('prerelease') is not False:
            continue
        commit = gitee_tag_commit(tag)
        if requested and commit != requested:
            continue
        try:
            return gitee_release_asset(arch, commit, tag)
        except GiteeNotReady:
            continue
    raise GiteeNotReady('暂无匹配且已就绪的 Gitee 正式安装包；请等待 v* 标签流水线完成')


def gitee_release_asset(arch, commit, tag, prerelease=False):
    # Migration may explicitly verify the old preview, but installers only select v* releases.
    encoded_tag = urllib.parse.quote(tag, safe='')
    base = f'https://gitee.com/{GITEE_REPO}/releases/download/{encoded_tag}/'
    release = metadata(f'https://gitee.com/api/v5/repos/{GITEE_REPO}/releases/tags/{encoded_tag}')
    if release.get('tag_name') != tag or release.get('prerelease') is not prerelease or type(release.get('id')) is not int or release['id'] <= 0:
        raise ValueError('Gitee 发布信息无效')
    rows = metadata(f"https://gitee.com/api/v5/repos/{GITEE_REPO}/releases/{release['id']}/attach_files?per_page=100")
    if not isinstance(rows, list):
        raise ValueError('Gitee 附件列表无效')
    assets = {}
    for row in rows:
        name = row.get('name')
        if name in assets:
            raise ValueError('Gitee 附件重名')
        assets[name] = row
    if 'release-index.json' not in assets:
        raise GiteeNotReady('Gitee 安装包尚未就绪，请等待流水线完成后重试')
    marker = assets['release-index.json']
    if marker.get('browser_download_url') != base + 'release-index.json' or type(marker.get('size')) is not int or not 0 < marker['size'] <= 64 << 10:
        raise ValueError('Gitee 发布索引地址或大小无效')
    with get(marker['browser_download_url']) as response:
        body = response.read((64 << 10) + 1)
    if len(body) != marker['size'] or len(body) > 64 << 10:
        raise ValueError('Gitee 发布索引大小无效')
    index = json.loads(body)
    if index.get('schema') != INDEX_SCHEMA or index.get('repository') != REPO or index.get('commit') != commit or index.get('os') != 'linux' or set(index.get('artifacts', {})) != {'amd64', 'arm64'}:
        raise ValueError('Gitee 发布索引身份无效')
    for target in ['amd64', 'arm64']:
        item = index['artifacts'][target]
        name = f'elysian-linux-{target}.tar.gz'
        asset, checksum = assets.get(name), assets.get(name + '.sha256')
        if not asset or not checksum:
            raise GiteeNotReady('Gitee 双架构附件不完整')
        if item.get('name') != name or type(item.get('size')) is not int or not 0 < item['size'] <= 100000000 or not re.fullmatch(r'[a-f0-9]{64}', item.get('sha256', '')) or asset.get('size') != item['size'] or asset.get('browser_download_url') != base + name or checksum.get('browser_download_url') != base + name + '.sha256' or type(checksum.get('size')) is not int or not 0 < checksum['size'] <= 1024:
            raise ValueError('Gitee 安装包地址、大小或摘要无效')
    if gitee_tag_commit(tag) != commit:
        raise ValueError('Gitee 发版标签与提交不一致')
    item = index['artifacts'][arch]
    return commit, dict(assets[item['name']], digest='sha256:' + item['sha256'])

def download(output, arch, requested, source=None):
    source = source or os.environ.get('ELYSIAN_RELEASE_SOURCE', 'github')
    if source not in {'github', 'gitee'}:
        raise ValueError('ELYSIAN_RELEASE_SOURCE 只能为 github 或 gitee')
    commit, asset = (gitee_asset if source == 'gitee' else github_asset)(arch, requested)
    url = asset['browser_download_url']
    descriptor, archive_name = tempfile.mkstemp(prefix='elysian-release-', suffix='.tar.gz', dir=output.parent)
    archive = Path(archive_name)
    try:
        deadline = time.monotonic() + 600
        digest = hashlib.sha256()
        count = 0
        with os.fdopen(descriptor, 'wb') as target, get(url) as response:
            while chunk := response.read(1024 * 1024):
                if time.monotonic() > deadline:
                    raise ValueError('预编译安装包下载超时')
                count += len(chunk)
                if count > asset['size']:
                    raise ValueError('预编译安装包超出登记大小')
                digest.update(chunk)
                target.write(chunk)
        if count != asset['size'] or 'sha256:' + digest.hexdigest() != asset['digest']:
            raise ValueError('预编译安装包 SHA256 或大小校验失败')
        with tarfile.open(archive, 'r|gz') as bundle:
            total = 0
            for number, member in enumerate(bundle, 1):
                if number > 5000 or time.monotonic() > deadline:
                    raise ValueError('安装包文件过多或解包超时')
                parts = Path(member.name).parts
                total += member.size
                if member.name.startswith('/') or '\\' in member.name or '..' in parts or not parts or parts[0] != f'elysian-linux-{arch}' or not (member.isfile() or member.isdir()) or member.size < 0 or total > 1024**3:
                    raise ValueError('安装包包含非法路径、链接或超限内容')
                relative = Path(*parts[1:])
                target = output / relative
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif relative != Path('.'):
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.extractfile(member) as src, target.open('xb') as dest:
                        shutil.copyfileobj(src, dest)
        verify(output, arch, commit)
    finally:
        archive.unlink(missing_ok=True)
    return commit

def verify(directory, arch, commit=''):
    manifest_file = directory / 'release.json'
    info = manifest_file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > 64 << 10:
        raise ValueError('安装包缺少有效发布清单')
    manifest = json.loads(manifest_file.read_text())
    sha = manifest.get('commit', '')
    if manifest.get('schema') != 'elysian-release/v1' or manifest.get('repository') != REPO or manifest.get('os') != 'linux' or manifest.get('arch') != arch or not re.fullmatch(r'[a-f0-9]{40}', sha) or (commit and sha != commit):
        raise ValueError('安装包提交、平台或架构与目标不一致')
    for name in ['elysian', 'platform-helper'] + ['scripts/' + script for script in SCRIPTS]:
        file = directory / name
        digest = hashlib.sha256()
        if file.is_symlink() or not file.is_file():
            raise ValueError('安装包文件无效：' + name)
        with file.open('rb') as content:
            for chunk in iter(lambda: content.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != manifest['files'].get(name):
            raise ValueError('安装包文件校验失败：' + name)
        if name.startswith('scripts/'):
            continue
        with file.open('rb') as content:
            header = content.read(20)
        if len(header) < 20 or header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != {'amd64': 62, 'arm64': 183}[arch]:
            raise ValueError('安装包不是对应架构的 Linux ELF：' + name)
    return sha

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['download', 'verify'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('arch', choices=['amd64', 'arm64'])
    parser.add_argument('commit', nargs='?', default='')
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    print(download(args.directory, args.arch, args.commit) if args.operation == 'download' else verify(args.directory, args.arch, args.commit))
if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit('预编译安装包准备失败：' + str(error))
