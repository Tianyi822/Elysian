import type { FileEntry } from '@elysian/contracts'
import { isValidFileName } from '@elysian/contracts'

/*
 * 文件管理演示数据集：一台运维主机的目录树手工种子，修改时间相对固定基准日生成，
 * 测试与组件断言不依赖当前时钟。深路径（docker containers 的长 id）留给顶栏
 * 前段省略做演示；/tmp 留空，空态有真实来源。
 *
 * 树是可变的：右键菜单的复制、粘贴、移动、重命名与压缩都改这份内存数据，
 * 「重置演示数据」经 resetFilesData 重建，变更不伪装成持久事实。
 */

type MockFileNode = { kind: 'file'; sizeBytes: number; modifiedAt: string; mode?: string; owner?: string }
type MockDirectoryNode = {
  kind: 'directory'
  modifiedAt: string
  mode?: string
  owner?: string
  children: Record<string, MockNode>
}
type MockNode = MockFileNode | MockDirectoryNode

/** 演示数据集的固定基准年份；日期写在每个条目上，如 mt('09-12 16:40')。 */
const BASE_YEAR = 2026

function mt(dayTime: string): string {
  return `${BASE_YEAR}-${dayTime.replace(' ', 'T')}:00+08:00`
}

function file(
  sizeBytes: number,
  modifiedAt: string,
  overrides: { mode?: string; owner?: string } = {},
): MockFileNode {
  return { kind: 'file', sizeBytes, modifiedAt: mt(modifiedAt), ...overrides }
}

function dir(
  modifiedAt: string,
  children: Record<string, MockNode> = {},
  overrides: { mode?: string; owner?: string } = {},
): MockDirectoryNode {
  return { kind: 'directory', modifiedAt: mt(modifiedAt), ...overrides, children }
}

/** 两台演示容器的 id：长得像真实 Docker id，深路径演示全靠它。 */
const CONTAINER_A = '3f9c2a8e1b7d4e5f8a6b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f'
const CONTAINER_B = 'a8d1e4f7c2b96035a7e8f1c4b0d2963e5a7c8f1b4d6e9a2c5f8b3d7e1a4c6f9b2'

function buildFileTree(): MockDirectoryNode {
  return dir('07-02 11:04', {
    bin: dir('05-14 09:00', {}, { mode: '555' }),
    boot: dir('09-01 10:12', {
      grub: dir('08-22 15:31', {
        'grub.cfg': file(5124, '08-22 15:31', { mode: '600' }),
      }),
    }),
    etc: dir('09-12 16:40', {
      cron: dir('09-10 04:00'),
      nginx: dir('09-12 16:40', {
        'conf.d': dir('09-12 16:38', {
          'elysian.conf': file(1834, '09-12 16:38'),
          'gzip.conf': file(457, '05-30 11:02'),
        }),
        'sites-enabled': dir('09-12 16:39', {
          'elysian.conf': file(2260, '09-12 16:39'),
        }),
        'fastcgi_params': file(1067, '05-30 11:02'),
        'mime.types': file(5231, '05-30 11:02'),
        'nginx.conf': file(1478, '09-12 16:40', { mode: '644' }),
      }),
      ssh: dir('09-08 09:41', {
        'sshd_config': file(3402, '09-08 09:41', { mode: '600' }),
      }),
      systemd: dir('09-11 14:05', {
        system: dir('09-11 14:05', {
          'docker.service': file(1274, '09-11 14:05'),
          'elysian-web.service': file(386, '09-03 10:27'),
        }),
      }),
      'crontab': file(812, '09-10 04:00'),
      'fstab': file(641, '07-02 11:04'),
      'hostname': file(13, '07-02 11:04'),
      'hosts': file(226, '07-02 11:04'),
      'resolv.conf': file(92, '09-11 14:05'),
    }),
    home: dir('09-08 09:20', {
      deploy: dir(
        '09-08 09:20',
        {
          '.ssh': dir(
            '09-06 17:12',
            {
              'authorized_keys': file(394, '09-06 17:12', { mode: '600', owner: 'deploy' }),
              'known_hosts': file(1842, '09-06 17:12', { owner: 'deploy' }),
            },
            { mode: '700', owner: 'deploy' },
          ),
          '.bashrc': file(3771, '05-20 10:15', { owner: 'deploy' }),
          'deploy.sh': file(4820, '09-08 09:20', { mode: '755', owner: 'deploy' }),
        },
        { owner: 'deploy' },
      ),
      monitor: dir(
        '08-15 13:44',
        {
          'collect-metrics.sh': file(6114, '08-15 13:44', { mode: '755', owner: 'monitor' }),
        },
        { owner: 'monitor' },
      ),
    }),
    opt: dir('09-03 10:30', {
      elysian: dir('09-03 10:30', {
        config: dir('09-03 10:30', {
          'elysian.json': file(2418, '09-03 10:30', { mode: '600' }),
        }),
      }),
    }),
    root: dir('07-02 11:04', {}, { mode: '700' }),
    srv: dir('07-02 11:04'),
    tmp: dir('09-16 08:00'),
    usr: dir('05-14 09:00', {
      bin: dir('05-14 09:00', {}, { mode: '555' }),
      lib: dir('05-14 09:00'),
      local: dir('08-01 16:22', {
        bin: dir('08-01 16:22'),
      }),
      share: dir('05-14 09:00'),
    }),
    var: dir('09-16 07:35', {
      cache: dir('09-14 22:10'),
      lib: dir('09-11 14:20', {
        docker: dir('09-11 14:20', {
          containers: dir('09-11 14:20', {
            [CONTAINER_A]: dir('09-11 14:20', {
              [`${CONTAINER_A}-json.log`]: file(4821_340, '09-16 07:12'),
              'hostconfig.json': file(3954, '09-11 14:20'),
            }),
            [CONTAINER_B]: dir('09-09 18:47', {
              [`${CONTAINER_B}-json.log`]: file(1240_882, '09-16 06:58'),
              'hostconfig.json': file(3716, '09-09 18:47'),
            }),
          }),
          overlays2: dir('09-16 07:00'),
          volumes: dir('09-03 10:31'),
        }),
        mysql: dir('09-10 03:00'),
      }),
      log: dir('09-16 07:35', {
        journal: dir('09-16 06:25'),
        nginx: dir('09-16 07:35', {
          'access.log': file(8241_067, '09-16 07:35'),
          'error.log': file(153_204, '09-16 07:30'),
        }),
        'auth.log': file(219_530, '09-16 07:12', { mode: '640' }),
        'kern.log': file(86_014, '09-16 06:40'),
        'syslog': file(1840_921, '09-16 07:35', { mode: '640' }),
      }),
    }),
  })
}

let FILE_TREE = buildFileTree()

/** 重建目录树：「重置演示数据」把右键菜单产生的所有变更一并还原。 */
export function resetFilesData(): void {
  FILE_TREE = buildFileTree()
}

/**
 * 沿段走到节点；任何一段缺失都按「不存在」处理。目录列举与大小统计共用这一条走法。
 */
function findNode(nodePath: string): MockNode {
  const segments = nodePath.split('/').filter((segment) => segment.length > 0)
  let node: MockNode = FILE_TREE
  for (const segment of segments) {
    if (node.kind !== 'directory') throw new Error(`目录不存在：${nodePath}`)
    const next: MockNode | undefined = node.children[segment]
    if (!next) throw new Error(`目录不存在：${nodePath}`)
    node = next
  }
  return node
}

function findDirectory(dirPath: string): MockDirectoryNode {
  const node = findNode(dirPath)
  if (node.kind !== 'directory') throw new Error(`目录不存在：${dirPath}`)
  return node
}

function leafName(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? ''
}

function parentDirPath(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  segments.pop()
  return `/${segments.join('/')}`
}

function toEntry(name: string, node: MockNode): FileEntry {
  return {
    name,
    kind: node.kind,
    mode: node.mode ?? (node.kind === 'directory' ? '755' : '644'),
    owner: node.owner ?? 'root',
    sizeBytes: node.kind === 'file' ? node.sizeBytes : undefined,
    modifiedAt: node.modifiedAt,
  }
}

/** 目标重名时按 macOS 惯例派生「 副本」后缀，副本再撞车就往下编号。 */
function uniqueName(target: MockDirectoryNode, name: string): string {
  if (!target.children[name]) return name
  let candidate = `${name} 副本`
  let counter = 2
  while (target.children[candidate]) {
    candidate = `${name} 副本 ${counter}`
    counter += 1
  }
  return candidate
}

function cloneNode(node: MockNode): MockNode {
  if (node.kind === 'file') return { ...node }
  const children: Record<string, MockNode> = {}
  for (const [name, child] of Object.entries(node.children)) {
    children[name] = cloneNode(child)
  }
  return { ...node, children }
}

/** 列出一个目录的直接子项（演示）；顺序不保证，排序由界面决定。权限与所有者缺省按真实主机惯例：目录 755、文件 644，归属 root。 */
export function listMockDirectory(dirPath: string): readonly FileEntry[] {
  const node = findDirectory(dirPath)
  return Object.entries(node.children).map(([name, child]) => toEntry(name, child))
}

/** 递归求一个路径的总大小（字节，演示）：文件是自身大小，目录是全部后代的和。 */
export function measureMockDirectory(nodePath: string): number {
  return measureMockNode(findNode(nodePath))
}

function measureMockNode(node: MockNode): number {
  if (node.kind === 'file') return node.sizeBytes
  return Object.values(node.children).reduce((sum, child) => sum + measureMockNode(child), 0)
}

/** 复制一个条目到目标目录（演示）：深拷贝整棵子树，目标重名自动加后缀。 */
export function copyMockEntry(srcPath: string, destDirPath: string): FileEntry {
  if (srcPath === '/') throw new Error('根目录不能复制')
  const src = findNode(srcPath)
  const dest = findDirectory(destDirPath)
  const destName = uniqueName(dest, leafName(srcPath))
  dest.children[destName] = cloneNode(src)
  return toEntry(destName, dest.children[destName])
}

/** 移动一个条目到目标目录（演示）：不能移回原目录，也不能把目录移进它自己内部。 */
export function moveMockEntry(srcPath: string, destDirPath: string): FileEntry {
  if (srcPath === '/') throw new Error('根目录不能移动')
  if (destDirPath === srcPath || destDirPath.startsWith(`${srcPath}/`)) {
    throw new Error('不能把目录移动到它自己内部')
  }
  const src = findNode(srcPath)
  const dest = findDirectory(destDirPath)
  const leaf = leafName(srcPath)
  const srcParent = findDirectory(parentDirPath(srcPath))
  if (parentDirPath(srcPath) === destDirPath) throw new Error('目标目录与源目录相同')
  const destName = uniqueName(dest, leaf)
  delete srcParent.children[leaf]
  dest.children[destName] = src
  return toEntry(destName, src)
}

/** 重命名一个条目（演示）：名称非法或与同级重名即报错，名字没变时原样返回。 */
export function renameMockEntry(path: string, newName: string): FileEntry {
  const trimmed = newName.trim()
  if (!isValidFileName(trimmed)) throw new Error(`无效的名称：${newName}`)
  if (path === '/') throw new Error('根目录不能重命名')
  const parent = findDirectory(parentDirPath(path))
  const leaf = leafName(path)
  const node = parent.children[leaf]
  if (!node) throw new Error(`条目不存在：${path}`)
  if (trimmed === leaf) return toEntry(leaf, node)
  if (parent.children[trimmed]) throw new Error(`同名条目已存在：${trimmed}`)
  delete parent.children[leaf]
  parent.children[trimmed] = node
  return toEntry(trimmed, node)
}

/** 压缩一个条目为同级的「名称.tar.gz」（演示）：大小取内容总和，演示时钟固定。 */
export function compressMockEntry(path: string): FileEntry {
  if (path === '/') throw new Error('根目录不能压缩')
  const parent = findDirectory(parentDirPath(path))
  const leaf = leafName(path)
  const node = findNode(path)
  const archiveName = `${leaf}.tar.gz`
  if (parent.children[archiveName]) throw new Error(`同名压缩包已存在：${archiveName}`)
  const archive: MockFileNode = {
    kind: 'file',
    sizeBytes: measureMockNode(node),
    modifiedAt: mt('09-16 12:00'),
  }
  parent.children[archiveName] = archive
  return toEntry(archiveName, archive)
}
