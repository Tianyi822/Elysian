#!/usr/bin/env python3
"""显式合并旧 Gitee 双发行版；核验正式附件后才移除对应预览发行版。"""
import base64
import importlib.util
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
from pathlib import Path

spec = importlib.util.spec_from_file_location('publish_gitee', Path(__file__).with_name('publish-gitee.py'))
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


def verify_downloader():
    address = f'https://gitee.com/api/v5/repos/{publish.REPO}/contents/scripts/release-download.py?ref=main'
    metadata = publish.download.metadata(address)
    if metadata.get('encoding') != 'base64':
        raise ValueError('Gitee main 下载器内容编码无效，拒绝迁移')
    remote = base64.b64decode(''.join(metadata.get('content', '').split()), validate=True)
    if remote != Path(__file__).with_name('release-download.py').read_bytes():
        raise ValueError('Gitee main 尚未部署同版本下载器，拒绝迁移')


def migrate(tag, commit, publisher):
    if not tag.startswith('v') or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('迁移必须绑定正式 v* 标签和完整 SHA')
    publisher.tag(tag, commit)
    source_tag = 'build-' + commit
    source = publisher.request('/releases/tags/' + source_tag)
    target = publisher.request('/releases/tags/' + urllib.parse.quote(tag, safe=''))
    if not target or target.get('prerelease') is not False:
        raise ValueError('待迁移正式发行版不存在或身份不符')
    with tempfile.TemporaryDirectory(prefix='elysian-gitee-migrate-') as temporary:
        root = Path(temporary)
        if source is None:
            publish.verify_release(target, commit, publisher, root)
            publisher.update_notes(target, publish.release_notes(tag, commit))
            return
        publisher.tag(source_tag, commit)
        if source.get('tag_name') != source_tag or source.get('prerelease') is not True or source.get('id') == target.get('id'):
            raise ValueError('待迁移预览发行版身份不符')
        source_dir, target_dir = root / 'source', root / 'target'
        source_dir.mkdir()
        target_dir.mkdir()
        publish.verify_release(source, commit, publisher, source_dir)
        names = {file.name for file in source_dir.iterdir()}
        if set(publisher.attachments(source)) != names:
            raise ValueError('预览发行版存在额外附件，保留并拒绝删除')
        existing = publisher.attachments(target)
        if set(existing) - names:
            raise ValueError('正式发行版存在额外附件，保留并拒绝迁移')
        publisher.quota(sum(file.stat().st_size for file in source_dir.iterdir() if file.name not in existing))
        base = f'https://gitee.com/{publish.REPO}/releases/download/{urllib.parse.quote(tag, safe="")}/'
        # The original marker is copied last, never regenerated or re-serialized.
        for name in sorted(names - {'release-index.json'}) + ['release-index.json']:
            file = source_dir / name
            if name in existing:
                remote = root / ('existing-' + name)
                publish.fetch_attachment(existing[name], base + name, remote)
                if remote.read_bytes() != file.read_bytes():
                    raise ValueError('正式版已有附件与预览版不同，保留两者并拒绝覆盖')
            else:
                publisher.upload(target, file)
        publish.verify_release(target, commit, publisher, target_dir)
        if any((target_dir / name).read_bytes() != (source_dir / name).read_bytes() for name in names):
            raise ValueError('正式版附件未保持原字节，保留预览发行版')
        publisher.update_notes(target, publish.release_notes(tag, commit))
        publisher.remove_preview(source, commit)
        if publisher.request('/releases/tags/' + source_tag) is not None:
            raise ValueError('预览发行版删除结果未确认，请重跑核实')


if __name__ == '__main__':
    try:
        tag, commit = sys.argv[1:]
        # Do not break the public bootstrap before its new downloader is deployed.
        verify_downloader()
        migrate(tag, commit, publish.Publisher(os.environ.get('ELYSIAN_GITEE_TOKEN', '')))
        print(f'Gitee 单正式发行版已核验：{tag} / {commit}')
    except Exception as error:
        if isinstance(error, (ValueError, OSError)) and not isinstance(error, urllib.error.URLError):
            print(str(error), file=sys.stderr)
        else:
            print('Gitee 迁移结果未确认；保留现有附件，重跑先回读核验', file=sys.stderr)
        sys.exit(1)
