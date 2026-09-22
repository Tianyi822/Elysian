import { describe, expect, it } from 'vitest'
import type { Dirent, Stats } from 'node:fs'
import { WALK_MAX_NODES } from './fileTreeWalk.ts'
import { createFilesService, type FilesHostDeps } from './filesService'

/*
 * 文件管理服务编排的行为测试：全部宿主访问走有状态 fake（内存文件树 + 命令账本），
 * 不执行任何真实命令、不碰真实文件系统。fake 严格对齐真实命令语义——cp -a 不解除
 * 引用（拷贝链接本身）、mv -T 拒绝目标已存在、tar 校验 `-czf/-C/--` 形状、
 * chmodNoFollow/chownNoFollow 对符号链接抛 ELOOP——编排一旦用错命令形状，测试立刻红。
 * 校验顺序与中文文案逐字对齐 web 侧 mock（apps/web/src/adapters/mock/filesData.ts）。
 */

const MTIME = new Date('2026-09-16T07:35:00Z')
/** 链接指向对象的时间戳：与 MTIME 不同，用于区分「按其指向呈现」与「按链接自身呈现」。 */
const TARGET_MTIME = new Date('2026-09-10T03:04:05Z')

type FakeNode = {
  kind: 'file' | 'dir' | 'link'
  size: number
  mode: number
  uid: number
  gid: number
  mtime: Date
  target?: string
  children?: Map<string, FakeNode>
}

function file(size: number, overrides: { mode?: number; uid?: number; mtime?: Date } = {}): FakeNode {
  return { kind: 'file', size, mode: overrides.mode ?? 0o644, uid: overrides.uid ?? 0, gid: 0, mtime: overrides.mtime ?? MTIME }
}

function dir(children: Record<string, FakeNode> = {}, overrides: { mode?: number; uid?: number; mtime?: Date } = {}): FakeNode {
  return { kind: 'dir', size: 0, mode: overrides.mode ?? 0o755, uid: overrides.uid ?? 0, gid: 0, mtime: overrides.mtime ?? MTIME, children: new Map(Object.entries(children)) }
}

function link(target: string): FakeNode {
  return { kind: 'link', size: target.length, mode: 0o777, uid: 0, gid: 0, mtime: MTIME, target }
}

function fakeError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function fakeStats(node: FakeNode): Stats {
  return {
    isDirectory: () => node.kind === 'dir',
    isSymbolicLink: () => node.kind === 'link',
    isFile: () => node.kind === 'file',
    size: node.size,
    mode: node.mode,
    uid: node.uid,
    gid: node.gid,
    mtime: node.mtime,
  } as unknown as Stats
}

/** 容器形态的种子树：覆盖 mock 的演示场景 + 写禁区两侧 + 符号链接 + 搜索剪枝对象。 */
function seedContainerTree(): FakeNode {
  return dir({
    etc: dir({
      nginx: dir({
        'nginx.conf': file(1478),
        'conf.d': dir({ 'elysian.conf': file(1834) }),
      }),
      ssh: dir({ sshd_config: file(3402, { mode: 0o600 }) }),
    }),
    var: dir({
      log: dir({
        syslog: file(219_530, { mode: 0o640 }),
        'auth.log': file(200),
        foreign: file(50, { uid: 12_345 }),
        nginx: dir({ 'access.log': file(8241) }),
        current: link('/var/log/nothere'),
      }),
      www: dir({ 'index.html': file(512), 'style.css': file(128) }),
      lib: dir({ elysian: dir({ data: dir({ 'metrics.sqlite': file(4096) }) }) }),
    }),
    tmp: dir({}),
    root: dir({
      '.ssh': dir({ authorized_keys: file(394, { mode: 0o600 }) }),
      '.Elysian': dir({ data: dir({ 'metrics.sqlite': file(2048) }) }),
      '.bun': dir({ 'cache.bin': file(30) }),
      'keys-link': link('/root/.ssh'),
    }),
    app: dir({ src: dir({ 'index.ts': file(5) }) }),
    srv: dir({
      app: dir({
        'index.ts': file(7),
        node_modules: dir({ pkg: dir({ 'index.js': file(20) }) }),
      }),
      'deploy.sh': file(11),
    }),
    proc: dir({ cpuinfo: file(0) }),
    work: dir({
      'report.txt': file(15, { mode: 0o600, uid: 33, mtime: TARGET_MTIME }),
      // 活链接：按指向呈现（mode 600 / www-data / 15 字节 / 目标时间戳），不是链接自身的 777 / root / 路径字节数。
      'report-link': link('/work/report.txt'),
      // 断链：回退 lstat 按链接自身呈现（与 list 的降级同款）。
      'dangling-link': link('/work/nothere'),
      // 指向自身父目录的活链接：遍历若跟随就会成环，lstat 口径必须不展开它。
      loop: link('/work'),
      // 相对目标的链接：在 /work 下解析为 /work/rel.txt；换个目录复制过去就会断链（真实 cp 保留相对目标）
      'rel.txt': file(7, { mode: 0o644 }),
      'rel-link.txt': link('rel.txt'),
    }),
    home: dir({
      deploy: dir({
        '.ssh': dir({ authorized_keys: file(394, { uid: 1000 }) }),
        'deploy.sh': file(4820, { mode: 0o755, uid: 1000 }),
      }),
    }),
  })
}

type FakeFilesHost = {
  deps: FilesHostDeps
  commands: { command: string; args: readonly string[] }[]
  chmodCalls: { path: string; mode: number }[]
  chownCalls: { path: string; uid: number; gid: number }[]
  renames: { from: string; to: string }[]
  nodeAt(path: string, followFinal?: boolean): FakeNode | null
}

function createFakeFilesHost(root: FakeNode = seedContainerTree()): FakeFilesHost {
  const commands: { command: string; args: readonly string[] }[] = []
  const chmodCalls: { path: string; mode: number }[] = []
  const chownCalls: { path: string; uid: number; gid: number }[] = []
  const renames: { from: string; to: string }[] = []
  const passwd = new Map<string, { uid: number; gid: number }>([
    ['root', { uid: 0, gid: 0 }],
    ['deploy', { uid: 1000, gid: 1000 }],
    ['www-data', { uid: 33, gid: 33 }],
  ])

  const segments = (path: string): string[] => path.split('/').filter(Boolean)
  const parentPath = (path: string): string => {
    const segs = segments(path)
    segs.pop()
    return segs.length === 0 ? '/' : `/${segs.join('/')}`
  }
  const leafOf = (path: string): string => segments(path).pop() ?? ''

  /** 相对链接目标的拼接归一化：以 parentPath 为基准消化 `.` 与 `..`（对齐内核语义）。 */
  function joinPaths(parentPath: string, target: string): string {
    const out: string[] = []
    for (const part of [...segments(parentPath), ...target.split('/')]) {
      if (part === '' || part === '.') continue
      if (part === '..') out.pop()
      else out.push(part)
    }
    return out.length === 0 ? '/' : `/${out.join('/')}`
  }

  /** 路径解析：中间组件的符号链接一律跟随，最终组件按 followFinal（lstat 语义则不跟随）。 */
  function resolve(path: string, followFinal: boolean, hops = 0): FakeNode | null {
    const segs = segments(path)
    let current: FakeNode | null = root
    // 已走过的规范路径段：相对链接目标以链接所在目录为基准解析（真实符号链接语义）。
    const resolved: string[] = []
    for (let index = 0; index < segs.length; index++) {
      const isFinal = index === segs.length - 1
      if (current!.kind !== 'dir') return null
      const next: FakeNode | null = current!.children!.get(segs[index]!) ?? null
      if (next === null) return null
      if (next.kind === 'link' && (!isFinal || followFinal)) {
        if (hops >= 10) throw fakeError('ELOOP')
        const parentPath = resolved.length === 0 ? '/' : `/${resolved.join('/')}`
        const targetPath = next.target!.startsWith('/') ? next.target! : joinPaths(parentPath, next.target!)
        return resolve([...segments(targetPath), ...segs.slice(index + 1)].join('/') || '/', followFinal, hops + 1)
      }
      resolved.push(segs[index]!)
      current = next
    }
    return current
  }

  /** realpath：解析全部符号链接后的规范路径，断链与缺失抛 ENOENT（对齐 node 语义）。 */
  function realpathOf(path: string, hops = 0): string {
    if (hops > 10) throw fakeError('ELOOP')
    const segs = segments(path)
    let current = root
    for (let index = 0; index < segs.length; index++) {
      if (current.kind !== 'dir') throw fakeError('ENOENT')
      const next = current.children!.get(segs[index]!)
      if (!next) throw fakeError('ENOENT')
      if (next.kind === 'link') {
        const resolvedDir = segs.slice(0, index)
        const targetPath = next.target!.startsWith('/')
          ? next.target!
          : joinPaths(resolvedDir.length === 0 ? '/' : `/${resolvedDir.join('/')}`, next.target!)
        const targetCanonical = realpathOf(targetPath, hops + 1)
        const rest = segs.slice(index + 1)
        return realpathOf([...segments(targetCanonical), ...rest].join('/') || '/', hops + 1)
      }
      current = next
    }
    return segs.length === 0 ? '/' : `/${segs.join('/')}`
  }

  function cloneNode(node: FakeNode): FakeNode {
    if (node.kind !== 'dir') return { ...node }
    const children = new Map<string, FakeNode>()
    for (const [name, child] of node.children!) children.set(name, cloneNode(child))
    return { ...node, children }
  }

  function sumTree(node: FakeNode): number {
    if (node.kind !== 'dir') return node.size
    let total = 0
    for (const child of node.children!.values()) total += sumTree(child)
    return total
  }

  const deps: FilesHostDeps = {
    async readdir(path) {
      const node = resolve(path, true)
      if (!node) throw fakeError('ENOENT')
      if (node.kind !== 'dir') throw fakeError('ENOTDIR')
      return [...node.children!.keys()].map((name) => ({ name } as unknown as Dirent))
    },
    async lstat(path) {
      const node = resolve(path, false)
      if (!node) throw fakeError('ENOENT')
      return fakeStats(node)
    },
    async stat(path) {
      const node = resolve(path, true)
      if (!node) throw fakeError('ENOENT')
      return fakeStats(node)
    },
    async realpath(path) {
      return realpathOf(path)
    },
    async renamePath(from, to) {
      renames.push({ from, to })
      const node = resolve(from, false)
      const fromParent = resolve(parentPath(from), true)
      const toParent = resolve(parentPath(to), true)
      if (!node || !fromParent || !toParent || fromParent.kind !== 'dir' || toParent.kind !== 'dir') {
        throw fakeError('ENOENT')
      }
      const toLeaf = leafOf(to)
      const existing = toParent.children!.get(toLeaf)
      // rename(2)：newpath 是符号链接时替换链接本身（不跟随，测试实测确认）；
      // 目录不能被非目录覆盖（ENOTDIR），非空目录不能被覆盖（ENOTEMPTY）。
      if (node.kind === 'dir' && existing && existing.kind !== 'dir') throw fakeError('ENOTDIR')
      if (node.kind !== 'dir' && existing?.kind === 'dir') throw fakeError('EISDIR')
      if (existing?.kind === 'dir' && existing.children!.size > 0) throw fakeError('ENOTEMPTY')
      fromParent.children!.delete(leafOf(from))
      toParent.children!.set(toLeaf, node)
    },
    async mkdir(path, mode) {
      const parent = resolve(parentPath(path), true)
      if (!parent || parent.kind !== 'dir') throw fakeError('ENOENT')
      if (parent.children!.has(leafOf(path))) throw fakeError('EEXIST')
      parent.children!.set(leafOf(path), dir({}, { mode }))
    },
    async rmPath(path) {
      const parent = resolve(parentPath(path), true)
      if (!parent || parent.kind !== 'dir') return
      // node 的 rm 与 rm(1) 同款：符号链接只摘链接本身，目录递归删除。
      parent.children!.delete(leafOf(path))
    },
    async runCp(args) {
      commands.push({ command: 'cp', args })
      if (args.length !== 3 || args[0] !== '-a') throw new Error(`cp: 不支持的参数形状 ${args.join(' ')}`)
      const [, src, dest] = args as readonly [string, string, string]
      const node = resolve(src, false)
      const destParent = resolve(parentPath(dest), true)
      if (!node || !destParent || destParent.kind !== 'dir') throw fakeError('ENOENT')
      const leaf = leafOf(dest)
      const existing = destParent.children!.get(leaf)
      const size = node.kind === 'dir' ? sumTree(node) : node.size
      // 目标侧语义对齐 GNU cp（coreutils 9.4 实测）：目标名是符号链接时跟随——
      // 指向已存在的普通文件即写穿（链接保留、被指向文件的内容被改写），
      // 指向目录则拷进该目录，断链直接拒绝（`not writing through dangling symlink`）。
      if (existing?.kind === 'link') {
        const target = resolve(existing.target!, true)
        if (target?.kind === 'file') {
          target.size = size
          target.mode = node.mode
          return ''
        }
        if (target?.kind === 'dir') {
          if (target.children!.has(leafOf(src))) throw new Error(`cp: 目标已存在 ${dest}/${leafOf(src)}`)
          target.children!.set(leafOf(src), cloneNode(node))
          return ''
        }
        throw new Error(`cp: not writing through dangling symlink ${dest}`)
      }
      if (existing?.kind === 'dir') {
        if (existing.children!.has(leafOf(src))) throw new Error(`cp: 目标已存在 ${dest}/${leafOf(src)}`)
        existing.children!.set(leafOf(src), cloneNode(node))
        return ''
      }
      destParent.children!.set(leaf, cloneNode(node))
      return ''
    },
    async runMv(args) {
      commands.push({ command: 'mv', args })
      if (args.length !== 3 || args[0] !== '-T') throw new Error(`mv: 不支持的参数形状 ${args.join(' ')}`)
      const [, src, dest] = args as readonly [string, string, string]
      const node = resolve(src, false)
      const srcParent = resolve(parentPath(src), true)
      const destParent = resolve(parentPath(dest), true)
      if (!node || !srcParent || !destParent || srcParent.kind !== 'dir' || destParent.kind !== 'dir') {
        throw fakeError('ENOENT')
      }
      if (destParent.children!.has(leafOf(dest))) throw new Error(`mv: 目标已存在 ${dest}`)
      srcParent.children!.delete(leafOf(src))
      destParent.children!.set(leafOf(dest), node)
      return ''
    },
    async runTar(args) {
      commands.push({ command: 'tar', args })
      if (args.length !== 6 || args[0] !== '-czf' || args[2] !== '-C' || args[4] !== '--') {
        throw new Error(`tar: 不支持的参数形状 ${args.join(' ')}`)
      }
      const [, archive, , baseDir, , name] = args as readonly [string, string, string, string, string, string]
      const source = resolve(baseDir === '/' ? `/${name}` : `${baseDir}/${name}`, false)
      const archiveParent = resolve(parentPath(archive), true)
      if (!source || !archiveParent || archiveParent.kind !== 'dir') throw fakeError('ENOENT')
      const leaf = leafOf(archive)
      const existing = archiveParent.children!.get(leaf)
      const size = source.kind === 'dir' ? sumTree(source) : source.size
      // 目标侧语义对齐 GNU tar（1.35 实测）：以 O_CREAT|O_TRUNC 打开归档路径，
      // 该名是符号链接时写穿到链接目标（断链则在链接指向处创建文件），链接本身保留。
      if (existing?.kind === 'link') {
        const target = resolve(existing.target!, true)
        if (target?.kind === 'file') {
          target.size = size
          target.mode = 0o644
          return ''
        }
        if (target) throw new Error(`tar: 不能写入目录 ${archive}`)
        const targetParent = resolve(parentPath(existing.target!), true)
        if (!targetParent || targetParent.kind !== 'dir') throw fakeError('ENOENT')
        targetParent.children!.set(leafOf(existing.target!), file(size, { mode: 0o644 }))
        return ''
      }
      if (existing?.kind === 'dir') throw new Error(`tar: 不能写入目录 ${archive}`)
      archiveParent.children!.set(leaf, file(size, { mode: 0o644 }))
      return ''
    },
    async runGetent(args) {
      commands.push({ command: 'getent', args })
      if (args[0] !== 'passwd') throw new Error(`getent: 不支持的数据库 ${args[0] ?? ''}`)
      const lines = [...passwd.entries()]
        .map(([name, ids]) => `${name}:x:${ids.uid}:${ids.gid}::/home/${name}:/bin/bash`)
        .sort()
      if (args[1] === undefined) return `${lines.join('\n')}\n`
      const matched = lines.filter((line) => line.startsWith(`${args[1]}:`))
      return matched.length > 0 ? `${matched.join('\n')}\n` : ''
    },
    async chmodNoFollow(path, mode) {
      chmodCalls.push({ path, mode })
      const node = resolve(path, false)
      if (!node) throw fakeError('ENOENT')
      if (node.kind === 'link') throw fakeError('ELOOP')
      node.mode = mode
    },
    async chownNoFollow(path, uid, gid) {
      chownCalls.push({ path, uid, gid })
      const node = resolve(path, false)
      if (!node) throw fakeError('ENOENT')
      if (node.kind === 'link') throw fakeError('ELOOP')
      node.uid = uid
      node.gid = gid
    },
    homeDir: () => '/root',
    nowIso: () => '2026-09-22T08:00:00.000Z',
  }

  return { deps, commands, chmodCalls, chownCalls, renames, nodeAt: (path, followFinal = true) => resolve(path, followFinal) }
}

function createService(host: FakeFilesHost = createFakeFilesHost()) {
  return { host, service: createFilesService(host.deps) }
}

/**
 * 造一个 /root/.ssh 空缺的宿主：父目录 /root 放行、派生出的名字恰好补齐禁区路径的场景，
 * 只在这条禁区路径空缺时可构造（它已存在时 deriveUniqueName 会换成副本名）。
 */
function createHostWithoutRootSsh(): FakeFilesHost {
  const root = seedContainerTree()
  root.children!.get('root')!.children!.delete('.ssh')
  return createFakeFilesHost(root)
}

/** 写命令账本（不含 getent 只读反查）：断言「零命令」时用它。 */
function writeCommands(host: FakeFilesHost): readonly { command: string; args: readonly string[] }[] {
  return host.commands.filter((entry) => entry.command !== 'getent')
}

/** 超预算目录：WALK_MAX_NODES + 1 个文件，任何受限遍历都触顶。 */
function createHugeHost(): FakeFilesHost {
  const children: Record<string, FakeNode> = {}
  for (let index = 0; index <= WALK_MAX_NODES; index += 1) children[`f${index}`] = file(1)
  return createFakeFilesHost(dir({ big: dir(children), tmp: dir({}) }))
}

/** 路径的父目录与叶名（与 fake 的路径解析同口径）。 */
function parentPathOf(path: string): string {
  const segments = path.split('/').filter(Boolean)
  segments.pop()
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

function leafOfPath(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? ''
}

/**
 * 在 fake 树里把某个名字抢注成符号链接（模拟容器内敌对进程），target 为绝对路径。
 * 前提：父目录已存在。
 */
function plantSymlink(host: FakeFilesHost, path: string, target: string): void {
  const parent = host.nodeAt(parentPathOf(path), true)
  if (!parent?.children) throw new Error(`plantSymlink: 父目录不存在（${path}）`)
  parent.children.set(leafOfPath(path), link(target))
}

/**
 * 抢注时机一：占用检查（第一次 readdir）返回之后立刻抢注——目标名在
 * 「检查未占用」与「命令执行」之间的窗口里被换成符号链接。
 * 返回「抢注是否真的发生」的探针，用例据此断言窗口确被触发（避免空转绿灯）。
 */
function plantSymlinkAfterFirstReaddir(host: FakeFilesHost, path: string, target: string): () => boolean {
  const originalReaddir = host.deps.readdir
  let planted = false
  host.deps.readdir = async (dirPath: string) => {
    const entries = await originalReaddir(dirPath)
    if (!planted) {
      planted = true
      plantSymlink(host, path, target)
    }
    return entries
  }
  return () => planted
}

/**
 * 抢注时机二：发布前的 lstat 复核之后才抢注（最坏窗口）——安全性不得依赖复核本身，
 * 复核与 rename(2) 之间的抢注仍不许写穿。同样返回抢注探针。
 */
function plantSymlinkAfterLstat(host: FakeFilesHost, path: string, target: string): () => boolean {
  const originalLstat = host.deps.lstat
  let planted = false
  host.deps.lstat = async (candidate: string) => {
    try {
      return await originalLstat(candidate)
    } finally {
      if (!planted && candidate === path) {
        planted = true
        plantSymlink(host, path, target)
      }
    }
  }
  return () => planted
}

/** fake 目录的直接子项名（断言暂存目录已清理用）。 */
function childNamesOf(host: FakeFilesHost, path: string): readonly string[] {
  return [...(host.nodeAt(path, true)?.children?.keys() ?? [])]
}

describe('list', () => {
  it('返回直接子项：目录无 sizeBytes、文件有；owner 经 getent 解析、查不到用 uid 呈现', async () => {
    const { service } = createService()
    const entries = await service.list('/var/log')
    const byName = new Map(entries.map((entry) => [entry.name, entry]))
    expect(byName.get('syslog')).toMatchObject({ kind: 'file', sizeBytes: 219_530, mode: '640', owner: 'root' })
    expect(byName.get('nginx')).toMatchObject({ kind: 'directory', owner: 'root', mode: '755' })
    expect(byName.get('nginx')!.sizeBytes).toBeUndefined()
    expect(byName.get('foreign')!.owner).toBe('12345')
    expect(byName.get('current')!.modifiedAt).toBe(MTIME.toISOString())
  })

  it('断链符号链接回退 lstat 按文件呈现（大小是链接本身字节数）', async () => {
    const { service } = createService()
    const entries = await service.list('/var/log')
    expect(entries.find((entry) => entry.name === 'current')).toMatchObject({ kind: 'file', sizeBytes: '/var/log/nothere'.length })
  })

  it('目录不存在与路径是文件同文案；路径先归一化', async () => {
    const { service } = createService()
    await expect(service.list('/nope')).rejects.toThrow('目录不存在：/nope')
    await expect(service.list('/etc/nginx/nginx.conf')).rejects.toThrow('目录不存在：/etc/nginx/nginx.conf')
    await expect(service.list('/var//log/')).resolves.toBeDefined()
  })

  it('相对路径与 `.` 段在判据层拒绝（原样入参进文案）', async () => {
    const { service } = createService()
    await expect(service.list('var/log')).rejects.toThrow('无效的文件路径：var/log')
    await expect(service.list('/var/./log')).rejects.toThrow('无效的文件路径：/var/./log')
  })

  it('超过 10000 条截断', async () => {
    const children: Record<string, FakeNode> = {}
    for (let index = 0; index < 10_001; index += 1) children[`e${index}`] = file(1)
    const { service } = createService(createFakeFilesHost(dir({ many: dir(children) })))
    await expect(service.list('/many')).resolves.toHaveLength(10_000)
  })
})

describe('size', () => {
  it('文件是自身大小；目录是全部后代之和（符号链接按链接字节计，目录不累计）', async () => {
    const { service } = createService()
    await expect(service.size('/var/log/syslog')).resolves.toBe(219_530)
    await expect(service.size('/var/log')).resolves.toBe(219_530 + 200 + 50 + 8241 + '/var/log/nothere'.length)
    await expect(service.size('/etc/nginx')).resolves.toBe(1478 + 1834)
  })

  it('起点不存在报中文（不会把 ENOENT 冒成 500）', async () => {
    const { service } = createService()
    await expect(service.size('/nope')).rejects.toThrow('目录不存在：/nope')
  })

  it('超预算如实报错：目录规模超出统计上限', async () => {
    const { service } = createService(createHugeHost())
    await expect(service.size('/big')).rejects.toThrow(`目录规模超出统计上限（${WALK_MAX_NODES} 个条目），请缩小统计范围`)
  })
})

describe('copyEntry', () => {
  it('cp -a 数组传参深拷贝，回读返回新条目；重名依次派生「 副本」「 副本 2」', async () => {
    const { host, service } = createService()
    const first = await service.copyEntry('/etc/nginx/nginx.conf', '/tmp')
    expect(first).toMatchObject({ name: 'nginx.conf', kind: 'file', sizeBytes: 1478 })
    expect(host.nodeAt('/tmp/nginx.conf')!.kind).toBe('file')

    const second = await service.copyEntry('/etc/nginx/nginx.conf', '/tmp')
    expect(second.name).toBe('nginx.conf 副本')

    const third = await service.copyEntry('/etc/nginx/nginx.conf', '/tmp')
    expect(third.name).toBe('nginx.conf 副本 2')
    // cp -a 保留权限位：回读的 mode 与源一致。
    expect(host.nodeAt('/tmp/nginx.conf')!.mode).toBe(0o644)

    // 命令形状：cp 一律只写独占创建的私有暂存目录，最终名由 rename(2) 发布
    const copies = writeCommands(host).filter((entry) => entry.command === 'cp')
    expect(copies).toHaveLength(3)
    for (const entry of copies) {
      expect(entry.args[0]).toBe('-a')
      expect(entry.args[1]).toBe('/etc/nginx/nginx.conf')
      expect(entry.args[2]).toMatch(/^\/tmp\/\.elysian-staging-[0-9a-f]{16}\/\.payload$/)
    }
    expect(host.renames).toEqual([
      { from: copies[0]!.args[2], to: '/tmp/nginx.conf' },
      { from: copies[1]!.args[2], to: '/tmp/nginx.conf 副本' },
      { from: copies[2]!.args[2], to: '/tmp/nginx.conf 副本 2' },
    ])
    // 暂存目录不留在目标目录里
    expect(childNamesOf(host, '/tmp').filter((name) => name.startsWith('.elysian-staging-'))).toEqual([])
  })

  it('复制符号链接：回读与 list 同口径——活链接按指向呈现，复制后断链的按链接自身呈现', async () => {
    const { host, service } = createService()

    // 活链接：cp -a 拷贝链接本身，回读按指向呈现（600 / www-data / 15 字节 / 目标时间戳）
    const liveCopy = await service.copyEntry('/work/report-link', '/tmp')
    expect(liveCopy).toEqual({
      name: 'report-link',
      kind: 'file',
      mode: '600',
      owner: 'www-data',
      sizeBytes: 15,
      modifiedAt: TARGET_MTIME.toISOString(),
    })
    expect(host.nodeAt('/tmp/report-link', false)!.kind).toBe('link')

    // 相对目标链接（→ rel.txt）复制到 /etc 后断链（cp -a 保留相对目标文本）：
    // 复制本身已成功，回读必须按链接自身呈现，而不是抛「读取条目状态失败」
    const danglingCopy = await service.copyEntry('/work/rel-link.txt', '/etc')
    expect(danglingCopy).toEqual({
      name: 'rel-link.txt',
      kind: 'file',
      mode: '777',
      owner: 'root',
      sizeBytes: 'rel.txt'.length,
      modifiedAt: MTIME.toISOString(),
    })
    expect(host.nodeAt('/etc/rel-link.txt', false)!.kind).toBe('link')
  })

  it('校验顺序与文案逐字对齐 mock：根目录、源不存在、目标目录不存在或路径是文件', async () => {
    const { host, service } = createService()
    await expect(service.copyEntry('/', '/tmp')).rejects.toThrow('根目录不能复制')
    await expect(service.copyEntry('/nope', '/tmp')).rejects.toThrow('目录不存在：/nope')
    await expect(service.copyEntry('/etc/nginx/nginx.conf', '/nope')).rejects.toThrow('目录不存在：/nope')
    await expect(service.copyEntry('/etc/nginx/nginx.conf', '/var/www/index.html')).rejects.toThrow('目录不存在：/var/www/index.html')
    expect(writeCommands(host)).toEqual([])
  })

  it('目标在源目录内部（含相等）拒绝且零命令；源是 /proc 拒绝', async () => {
    const { host, service } = createService()
    await expect(service.copyEntry('/etc', '/etc/nginx')).rejects.toThrow('不能把目录复制到它自己内部')
    await expect(service.copyEntry('/etc', '/etc')).rejects.toThrow('不能把目录复制到它自己内部')
    await expect(service.copyEntry('/proc', '/tmp')).rejects.toThrow('拒绝操作系统虚拟目录：/proc')
    expect(writeCommands(host)).toEqual([])
  })

  it('目标目录落写禁区（含经符号链接换链到 /root/.ssh）拒绝且零命令', async () => {
    const { host, service } = createService()
    await expect(service.copyEntry('/var/www/index.html', '/root/.Elysian/data')).rejects.toThrow('拒绝操作受保护路径：/root/.Elysian/data')
    // 字符串上是 /var/www/link-to-keys，realpath 后是 /root/.ssh——第二道检查命中。
    await expect(service.copyEntry('/var/www/index.html', '/root/keys-link')).rejects.toThrow('拒绝操作受保护路径：/root/.ssh')
    expect(writeCommands(host)).toEqual([])
  })

  it('派生目标完整路径落写禁区：源名恰好补齐禁区路径时拒绝且零命令', async () => {
    const host = createHostWithoutRootSsh()
    const { service } = createService(host)
    // 目标目录 /root 放行，但派生出的 /root/.ssh 正是禁区路径本身——不许在保护区内造条目
    await expect(service.copyEntry('/home/deploy/.ssh', '/root')).rejects.toThrow('拒绝操作受保护路径：/root/.ssh')
    expect(writeCommands(host)).toEqual([])
    expect(host.nodeAt('/root/.ssh')).toBe(null)
  })

  it('预检超预算拒绝且零命令', async () => {
    const { host, service } = createService(createHugeHost())
    await expect(service.copyEntry('/big', '/tmp')).rejects.toThrow(`目录规模超出操作上限（${WALK_MAX_NODES} 个条目）`)
    expect(writeCommands(host)).toEqual([])
  })

  it('文件的目标名在占用检查之后被抢注为符号链接：cp 不写穿禁区文件，按占用法则派副本名发布', async () => {
    const { host, service } = createService()
    const planted = plantSymlinkAfterFirstReaddir(host, '/tmp/nginx.conf', '/root/.ssh/authorized_keys')

    const copied = await service.copyEntry('/etc/nginx/nginx.conf', '/tmp')

    expect(planted()).toBe(true)
    // 抢注的名字按「已占用」处理（lstat 不跟随）：产物落在派生出的副本名上
    expect(copied.name).toBe('nginx.conf 副本')
    expect(copied.sizeBytes).toBe(1478)
    expect(host.nodeAt('/tmp/nginx.conf', false)!.kind).toBe('link')
    // 禁区文件零改写：写穿会把大小与权限位改成源文件的
    expect(host.nodeAt('/root/.ssh/authorized_keys')!.size).toBe(394)
    expect(host.nodeAt('/root/.ssh/authorized_keys')!.mode).toBe(0o600)
    // cp 只写私有暂存目录（0700），最终名由 rename(2) 发布
    const cp = writeCommands(host).find((entry) => entry.command === 'cp')!
    expect(cp.args[0]).toBe('-a')
    expect(cp.args[2]).toMatch(/^\/tmp\/\.elysian-staging-[0-9a-f]+\/\.payload$/)
    expect(host.renames).toEqual([{ from: cp.args[2], to: '/tmp/nginx.conf 副本' }])
    expect(childNamesOf(host, '/tmp').filter((name) => name.startsWith('.elysian-staging-'))).toEqual([])
  })

  it('目录的目标名在占用检查之后被抢注：目录产物同样不写穿，派生副本名发布', async () => {
    const { host, service } = createService()
    const planted = plantSymlinkAfterFirstReaddir(host, '/tmp/nginx', '/root/.ssh/authorized_keys')

    const copied = await service.copyEntry('/etc/nginx', '/tmp')

    expect(planted()).toBe(true)
    expect(copied).toMatchObject({ name: 'nginx 副本', kind: 'directory' })
    expect(host.nodeAt('/tmp/nginx 副本/nginx.conf')!.size).toBe(1478)
    expect(host.nodeAt('/tmp/nginx', false)!.kind).toBe('link')
    expect(host.nodeAt('/root/.ssh/authorized_keys')!.size).toBe(394)
    expect(host.nodeAt('/root/.ssh/authorized_keys')!.mode).toBe(0o600)
  })

  it('复核之后才被抢注（最坏窗口）：文件产物的 rename 替换链接本身，仍不写穿', async () => {
    const { host, service } = createService()
    const planted = plantSymlinkAfterLstat(host, '/tmp/nginx.conf', '/root/.ssh/authorized_keys')

    const copied = await service.copyEntry('/etc/nginx/nginx.conf', '/tmp')

    expect(planted()).toBe(true)
    expect(copied).toMatchObject({ name: 'nginx.conf', sizeBytes: 1478 })
    // 抢注的链接被替换成产物本身（rename 不跟随最终组件），禁区文件保持原值
    expect(host.nodeAt('/tmp/nginx.conf', false)!.kind).toBe('file')
    expect(host.nodeAt('/root/.ssh/authorized_keys')!.size).toBe(394)
    expect(host.nodeAt('/root/.ssh/authorized_keys')!.mode).toBe(0o600)
  })

  it('复核之后才被抢注（最坏窗口）：目录产物以 ENOTDIR 失败后换副本名重试，仍不写穿', async () => {
    const { host, service } = createService()
    const planted = plantSymlinkAfterLstat(host, '/tmp/nginx', '/root/.ssh/authorized_keys')

    const copied = await service.copyEntry('/etc/nginx', '/tmp')

    expect(planted()).toBe(true)
    // rename(2) 不允许「目录覆盖非目录」：抢注的链接让首次发布失败，换副本名后成功
    expect(copied.name).toBe('nginx 副本')
    expect(host.nodeAt('/tmp/nginx 副本/nginx.conf')!.size).toBe(1478)
    expect(host.nodeAt('/root/.ssh/authorized_keys')!.size).toBe(394)
  })
})

describe('moveEntry', () => {
  it('mv -T 数组传参，重名同样派生副本名，回读返回新位置条目', async () => {
    const { host, service } = createService()
    const moved = await service.moveEntry('/var/www/index.html', '/tmp')
    expect(moved).toMatchObject({ name: 'index.html', kind: 'file', sizeBytes: 512 })
    expect(writeCommands(host)).toEqual([{ command: 'mv', args: ['-T', '/var/www/index.html', '/tmp/index.html'] }])
    expect(host.nodeAt('/var/www/index.html')).toBeNull()
    expect(host.nodeAt('/tmp/index.html')!.size).toBe(512)

    await service.moveEntry('/var/www/style.css', '/tmp')
    expect(host.nodeAt('/tmp/style.css')).not.toBeNull()
    await service.moveEntry('/home/deploy/deploy.sh', '/tmp')
    // 目标重名同样派生副本名：/tmp 已有 deploy.sh，再移入同名条目。
    const again = await service.moveEntry('/srv/deploy.sh', '/tmp')
    expect(again.name).toBe('deploy.sh 副本')
  })

  it('校验顺序与文案逐字对齐 mock：根目录、移进自身、源不存在、目标不存在、目标与源目录相同', async () => {
    const { host, service } = createService()
    await expect(service.moveEntry('/', '/tmp')).rejects.toThrow('根目录不能移动')
    await expect(service.moveEntry('/etc', '/etc/nginx')).rejects.toThrow('不能把目录移动到它自己内部')
    await expect(service.moveEntry('/etc', '/etc')).rejects.toThrow('不能把目录移动到它自己内部')
    await expect(service.moveEntry('/nope', '/tmp')).rejects.toThrow('目录不存在：/nope')
    await expect(service.moveEntry('/var/www/index.html', '/nope')).rejects.toThrow('目录不存在：/nope')
    await expect(service.moveEntry('/var/www/index.html', '/var/www')).rejects.toThrow('目标目录与源目录相同')
    expect(writeCommands(host)).toEqual([])
  })

  it('源在卷真身 /var/lib/elysian、目标落 /root/.bun 都拒绝且零命令', async () => {
    const { host, service } = createService()
    await expect(service.moveEntry('/var/lib/elysian/data/metrics.sqlite', '/tmp')).rejects.toThrow(
      '拒绝操作受保护路径：/var/lib/elysian/data/metrics.sqlite',
    )
    await expect(service.moveEntry('/var/www/index.html', '/root/.bun')).rejects.toThrow('拒绝操作受保护路径：/root/.bun')
    expect(writeCommands(host)).toEqual([])
  })

  it('源是符号链接且指向 /root/.ssh（换链绕过尝试）：realpath 复核命中，零命令', async () => {
    const { host, service } = createService()
    await expect(service.moveEntry('/root/keys-link', '/tmp')).rejects.toThrow('拒绝操作受保护路径：/root/.ssh')
    expect(writeCommands(host)).toEqual([])
  })

  it('派生目标完整路径落写禁区：源名恰好补齐禁区路径时拒绝且零命令', async () => {
    const host = createHostWithoutRootSsh()
    const { service } = createService(host)
    await expect(service.moveEntry('/home/deploy/.ssh', '/root')).rejects.toThrow('拒绝操作受保护路径：/root/.ssh')
    expect(writeCommands(host)).toEqual([])
    expect(host.nodeAt('/root/.ssh')).toBe(null)
  })
})

describe('renameEntry', () => {
  it('非法名称逐字对齐 mock（原样入参进文案）；根目录与父目录、条目不存在依次检查', async () => {
    const { host, service } = createService()
    for (const bad of ['', ' ', 'a/b', '.', '..']) {
      await expect(service.renameEntry('/var/www/index.html', bad)).rejects.toThrow(`无效的名称：${bad}`)
    }
    await expect(service.renameEntry('/', 'x')).rejects.toThrow('根目录不能重命名')
    await expect(service.renameEntry('/nope/x', 'y')).rejects.toThrow('目录不存在：/nope')
    await expect(service.renameEntry('/var/www/nothere', 'y')).rejects.toThrow('条目不存在：/var/www/nothere')
    expect(host.renames).toEqual([])
  })

  it('名字没变（含 trim 后相同）不执行任何命令，原样回读返回', async () => {
    const { host, service } = createService()
    const unchanged = await service.renameEntry('/var/www/index.html', 'index.html')
    expect(unchanged).toMatchObject({ name: 'index.html', sizeBytes: 512 })
    await expect(service.renameEntry('/var/www/index.html', '  index.html ')).resolves.toMatchObject({ name: 'index.html' })
    expect(host.renames).toEqual([])
  })

  it('名字没变时的回读与 list 同口径：符号链接按指向呈现，不是链接自身的 777', async () => {
    const { service } = createService()
    await expect(service.renameEntry('/work/report-link', 'report-link')).resolves.toEqual({
      name: 'report-link',
      kind: 'file',
      mode: '600',
      owner: 'www-data',
      sizeBytes: 15,
      modifiedAt: TARGET_MTIME.toISOString(),
    })
  })

  it('同级重名报错；成功改名走注入的 renamePath 并回读（名字取 trim 后的值）', async () => {
    const { host, service } = createService()
    await expect(service.renameEntry('/var/www/index.html', 'style.css')).rejects.toThrow('同名条目已存在：style.css')
    const renamed = await service.renameEntry('/var/www/index.html', ' home.html ')
    expect(renamed.name).toBe('home.html')
    expect(host.renames).toEqual([{ from: '/var/www/index.html', to: '/var/www/home.html' }])
    expect(host.nodeAt('/var/www/home.html')!.size).toBe(512)
  })

  it('源落写禁区拒绝且零重命名', async () => {
    const { host, service } = createService()
    await expect(service.renameEntry('/root/.ssh/authorized_keys', 'x')).rejects.toThrow('拒绝操作受保护路径：/root/.ssh/authorized_keys')
    expect(host.renames).toEqual([])
  })

  it('目标名恰好补齐禁区路径时拒绝且零重命名', async () => {
    const host = createHostWithoutRootSsh()
    const { service } = createService(host)
    host.nodeAt('/root')!.children!.set('old.name', file(10))
    await expect(service.renameEntry('/root/old.name', '.ssh')).rejects.toThrow('拒绝操作受保护路径：/root/.ssh')
    expect(host.renames).toEqual([])
    expect(host.nodeAt('/root/.ssh')).toBe(null)
  })
})

describe('compressEntry', () => {
  it('tar 数组传参（`--` 分隔防名字当选项），回读返回压缩包条目；同名压缩包已存在报错', async () => {
    const { host, service } = createService()
    const archive = await service.compressEntry('/etc/nginx')
    expect(archive).toMatchObject({ name: 'nginx.tar.gz', kind: 'file' })
    // tar 只写私有暂存目录，`--` 分隔与 -C 语义不变；最终名由 rename(2) 发布
    const tar = writeCommands(host).find((entry) => entry.command === 'tar')!
    expect(tar.args[0]).toBe('-czf')
    expect(tar.args[1]).toMatch(/^\/etc\/\.elysian-staging-[0-9a-f]{16}\/\.payload$/)
    expect(tar.args.slice(2)).toEqual(['-C', '/etc', '--', 'nginx'])
    expect(host.renames).toEqual([{ from: tar.args[1], to: '/etc/nginx.tar.gz' }])
    expect(host.nodeAt('/etc/nginx.tar.gz')!.kind).toBe('file')
    expect(childNamesOf(host, '/etc').filter((name) => name.startsWith('.elysian-staging-'))).toEqual([])
    await expect(service.compressEntry('/etc/nginx')).rejects.toThrow('同名压缩包已存在：nginx.tar.gz')
  })

  it('校验顺序与文案逐字对齐 mock：根目录、父目录不存在、源不存在', async () => {
    const { host, service } = createService()
    await expect(service.compressEntry('/')).rejects.toThrow('根目录不能压缩')
    await expect(service.compressEntry('/nope/x')).rejects.toThrow('目录不存在：/nope')
    await expect(service.compressEntry('/var/www/nothere')).rejects.toThrow('目录不存在：/var/www/nothere')
    expect(writeCommands(host)).toEqual([])
  })

  it('源落写禁区与预检超预算都拒绝且零命令', async () => {
    const { host, service } = createService()
    await expect(service.compressEntry('/root/.bun')).rejects.toThrow('拒绝操作受保护路径：/root/.bun')
    const huge = createService(createHugeHost())
    await expect(huge.service.compressEntry('/big')).rejects.toThrow(`目录规模超出操作上限（${WALK_MAX_NODES} 个条目）`)
    expect(writeCommands(host)).toEqual([])
    expect(writeCommands(huge.host)).toEqual([])
  })

  it('压缩包名在预检窗口被抢注为符号链接：tar 不写穿禁区文件，按 mock 语义报同名已存在', async () => {
    const { host, service } = createService()
    const planted = plantSymlinkAfterFirstReaddir(host, '/etc/nginx.tar.gz', '/root/.ssh/authorized_keys')

    await expect(service.compressEntry('/etc/nginx')).rejects.toThrow('同名压缩包已存在：nginx.tar.gz')

    expect(planted()).toBe(true)
    // tar 只写私有暂存目录；发布复核发现名字已被抢注，按 mock 文案报出而不是替换或写穿
    expect(host.nodeAt('/etc/nginx.tar.gz', false)!.kind).toBe('link')
    expect(host.nodeAt('/root/.ssh/authorized_keys')!.size).toBe(394)
    expect(host.nodeAt('/root/.ssh/authorized_keys')!.mode).toBe(0o600)
    const tar = writeCommands(host).find((entry) => entry.command === 'tar')!
    expect(tar.args[1]).toMatch(/^\/etc\/\.elysian-staging-[0-9a-f]+\/\.payload$/)
    expect(childNamesOf(host, '/etc').filter((name) => name.startsWith('.elysian-staging-'))).toEqual([])
  })
})

describe('chmod', () => {
  it('校验顺序与文案逐字对齐 mock：根目录、权限位、空所有者、路径不存在、递归非目录', async () => {
    const { host, service } = createService()
    await expect(service.chmod('/', { mode: '755', owner: 'root', recursive: false })).rejects.toThrow('根目录不能改权限')
    await expect(service.chmod('/etc/nginx', { mode: '888', owner: 'root', recursive: false })).rejects.toThrow('无效的权限位：888')
    await expect(service.chmod('/etc/nginx', { mode: '755', owner: '  ', recursive: false })).rejects.toThrow('所有者不能为空')
    await expect(service.chmod('/nope/x', { mode: '755', owner: 'root', recursive: false })).rejects.toThrow('目录不存在：/nope/x')
    await expect(service.chmod('/etc/nginx/nginx.conf', { mode: '755', owner: 'root', recursive: true })).rejects.toThrow(
      '只有目录可以连同子目录一起改权限',
    )
    expect(host.chmodCalls).toEqual([])
  })

  it('owner 名与账号反查：非法名与查无账号的中文错误', async () => {
    const { host, service } = createService()
    await expect(service.chmod('/etc/nginx', { mode: '755', owner: 'Bad Name', recursive: false })).rejects.toThrow('无效的所有者名：Bad Name')
    await expect(service.chmod('/etc/nginx', { mode: '755', owner: 'ghost', recursive: false })).rejects.toThrow('未找到系统账号：ghost')
    expect(host.chmodCalls).toEqual([])
  })

  it('非递归：chmodNoFollow + chownNoFollow 落到条目本身，后代不动', async () => {
    const { host, service } = createService()
    await service.chmod('/etc/nginx/nginx.conf', { mode: '600', owner: 'deploy', recursive: false })
    expect(host.chmodCalls).toEqual([{ path: '/etc/nginx/nginx.conf', mode: 0o600 }])
    expect(host.chownCalls).toEqual([{ path: '/etc/nginx/nginx.conf', uid: 1000, gid: 1000 }])
    expect(host.nodeAt('/etc/nginx/nginx.conf')!.mode).toBe(0o600)
    expect(host.nodeAt('/etc/nginx/conf.d')!.mode).toBe(0o755)
  })

  it('最终组件是符号链接：显式中文拒绝，绝不改到链接目标上', async () => {
    const { host, service } = createService()
    await expect(service.chmod('/var/log/current', { mode: '644', owner: 'root', recursive: false })).rejects.toThrow(
      '不能对符号链接执行该操作：/var/log/current',
    )
    expect(host.chmodCalls).toEqual([])
  })

  it('递归：收集段先于执行段，后代全部改到，符号链接后代跳过', async () => {
    const { host, service } = createService()
    await service.chmod('/var/log', { mode: '750', owner: 'www-data', recursive: true })
    expect(new Set(host.chmodCalls.map((call) => call.path))).toEqual(
      new Set(['/var/log', '/var/log/syslog', '/var/log/auth.log', '/var/log/foreign', '/var/log/nginx', '/var/log/nginx/access.log']),
    )
    // 符号链接后代不在收集列表：fake 的 chmodNoFollow 对链接抛 ELOOP，进了列表这里就会红。
    expect(host.chmodCalls.some((call) => call.path === '/var/log/current')).toBe(false)
    expect(host.nodeAt('/var/log/current', false)!.mode).toBe(0o777)
    expect(host.nodeAt('/var/log/nginx/access.log')!.uid).toBe(33)
  })

  it('chmod -R /root：收集列表含保护区后代，整体拒绝且命令账本为零', async () => {
    const { host, service } = createService()
    await expect(service.chmod('/root', { mode: '755', owner: 'root', recursive: true })).rejects.toThrow(
      '拒绝操作受保护路径：/root/.ssh',
    )
    expect(host.chmodCalls).toEqual([])
    expect(host.chownCalls).toEqual([])
  })

  it('直接点名的禁区路径同样拒绝（/app、/root/.Elysian、/proc）', async () => {
    const { host, service } = createService()
    for (const path of ['/app', '/root/.Elysian/data', '/proc/cpuinfo']) {
      await expect(service.chmod(path, { mode: '755', owner: 'root', recursive: false })).rejects.toThrow('拒绝操作受保护路径：')
    }
    expect(host.chmodCalls).toEqual([])
  })

  it('递归收集超预算：在收集段拒绝，不留半改状态', async () => {
    const { host, service } = createService(createHugeHost())
    await expect(service.chmod('/big', { mode: '755', owner: 'root', recursive: true })).rejects.toThrow(
      `目录规模超出操作上限（${WALK_MAX_NODES} 个条目）`,
    )
    expect(host.chmodCalls).toEqual([])
  })
})

describe('search', () => {
  it('空关键词（含纯空白）返回空数组', async () => {
    const { service } = createService()
    await expect(service.search('')).resolves.toEqual([])
    await expect(service.search('   ')).resolves.toEqual([])
  })

  it('契约口径：去全部空白+小写，名称与完整路径任一命中；结果带绝对 path 与条目字段', async () => {
    const { service } = createService()
    const byName = await service.search('syslog')
    expect(byName.map((result) => result.path)).toEqual(['/var/log/syslog'])
    expect(byName[0]).toMatchObject({ name: 'syslog', kind: 'file', owner: 'root', path: '/var/log/syslog' })

    const spaced = await service.search(' SYS log ')
    expect(spaced.map((result) => result.path)).toEqual(['/var/log/syslog'])

    // 路径命中：elysian.conf 的名字不含 nginx，但所在路径含；/var/log/nginx 同理由路径命中。
    const byPath = await service.search('nginx')
    expect(byPath.map((result) => result.path).sort()).toEqual(
      [
        '/etc/nginx',
        '/etc/nginx/conf.d',
        '/etc/nginx/conf.d/elysian.conf',
        '/etc/nginx/nginx.conf',
        '/var/log/nginx',
        '/var/log/nginx/access.log',
      ].sort(),
    )
  })

  it('剪枝清单：/proc、node_modules 段与 /root/.bun 整树跳过，预算留给系统文件', async () => {
    const { service } = createService()
    await expect(service.search('cpuinfo')).resolves.toEqual([])
    await expect(service.search('index.js')).resolves.toEqual([])
    await expect(service.search('cache.bin')).resolves.toEqual([])
    // 同名不剪的对照：node_modules 之外的 index.ts 正常命中。
    await expect(service.search('index.ts')).resolves.toHaveLength(2)
  })

  it('owner 解析与 list 同款（一次 getent 建映射）', async () => {
    const { service } = createService()
    const results = await service.search('deploy.sh')
    expect(results[0]!.owner).toBe('deploy')
  })

  it('结果超过 1000 条时触顶截断', async () => {
    const children: Record<string, FakeNode> = {}
    for (let index = 0; index < 1001; index += 1) children[`hit${index}`] = file(1)
    const { service } = createService(createFakeFilesHost(dir({ many: dir(children) })))
    await expect(service.search('hit')).resolves.toHaveLength(1000)
  })

  it('命中符号链接按指向呈现（契约口径）：活链接取指向的字段，断链才回退链接自身', async () => {
    const { service } = createService()

    // 活链接 report-link → report.txt：mode 600 / www-data / 15 字节 / 目标时间戳
    // （链接自身是 777 / root / 路径字节数 / 链接时间戳，两者在四个字段上都不同）
    await expect(service.search('report-link')).resolves.toEqual([
      {
        name: 'report-link',
        kind: 'file',
        mode: '600',
        owner: 'www-data',
        sizeBytes: 15,
        modifiedAt: TARGET_MTIME.toISOString(),
        path: '/work/report-link',
      },
    ])

    // 断链：回退 lstat 按链接自身呈现，与 list 的降级同款
    await expect(service.search('dangling-link')).resolves.toEqual([
      {
        name: 'dangling-link',
        kind: 'file',
        mode: '777',
        owner: 'root',
        sizeBytes: '/work/nothere'.length,
        modifiedAt: MTIME.toISOString(),
        path: '/work/dangling-link',
      },
    ])
  })

  it('同一路径在 list 与 search 里的条目字段逐字一致（呈现口径只有一份）', async () => {
    const { service } = createService()
    const listed = await service.list('/work')
    const found = await service.search('work')
    expect(listed.length).toBeGreaterThan(0)
    for (const entry of listed) {
      expect(found.find((result) => result.path === `/work/${entry.name}`)).toEqual({
        ...entry,
        path: `/work/${entry.name}`,
      })
    }
  })

  it('遍历不展开指向祖先目录的活链接：搜索在环上收敛而不是无限下探', async () => {
    const { service } = createService()
    // work/loop → /work：遍历若跟随链接就会成环；命中路径里不再出现 work/loop/... 的重复展开
    const results = await service.search('work')
    expect(results.map((result) => result.path).sort()).toEqual(
      ['/work', '/work/dangling-link', '/work/loop', '/work/rel-link.txt', '/work/rel.txt', '/work/report-link', '/work/report.txt'].sort(),
    )
  })
})
