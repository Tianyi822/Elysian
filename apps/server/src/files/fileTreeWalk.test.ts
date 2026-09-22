import { describe, expect, it } from 'vitest'
import type { Dirent, Stats } from 'node:fs'
import {
  WALK_MAX_NODES,
  WalkLimitError,
  WalkVirtualDirError,
  collectDescendantPaths,
  sumDescendantSizes,
  walkFileTree,
  type TreeWalkDeps,
} from './fileTreeWalk'

/*
 * 受限遍历原语的行为测试：内存树 fake（readdir/lstat），不碰真实文件系统。
 * 覆盖深度/节点上限、虚拟 FS 与额外剪枝、报告语义（reject 抛错、prune 跳过）、
 * 大小求和口径（符号链接按链接字节、目录不累计）与收集段跳过符号链接。 */

type FakeNode = {
  kind: 'file' | 'dir' | 'link'
  size: number
  target?: string
  children?: Map<string, FakeNode>
}

function file(size: number): FakeNode {
  return { kind: 'file', size }
}

function dir(children: Record<string, FakeNode> = {}): FakeNode {
  return { kind: 'dir', size: 0, children: new Map(Object.entries(children)) }
}

function link(target: string): FakeNode {
  return { kind: 'link', size: target.length }
}

function fakeStats(node: FakeNode): Stats {
  return {
    isDirectory: () => node.kind === 'dir',
    isSymbolicLink: () => node.kind === 'link',
    isFile: () => node.kind === 'file',
    size: node.size,
    mode: node.kind === 'dir' ? 0o755 : 0o644,
    uid: 0,
    mtime: new Date('2026-09-22T08:00:00Z'),
  } as unknown as Stats
}

function fakeDirent(name: string, node: FakeNode): Dirent {
  return { name, isDirectory: () => node.kind === 'dir' } as unknown as Dirent
}

/** 内存树 fake：路径以 `/` 起、逐段查找；符号链接仅 lstat 可见，本 fake 不解析其指向（遍历不跟随）。 */
function createFakeDeps(root: FakeNode): TreeWalkDeps & { lstatCalls: string[] } {
  const lstatCalls: string[] = []
  return {
    lstatCalls,
    async readdir(path) {
      const node = findNode(root, path)
      if (!node) throw fakeError('ENOENT')
      if (node.kind !== 'dir') throw fakeError('ENOTDIR')
      return [...node.children!.entries()].map(([name, child]) => fakeDirent(name, child))
    },
    async lstat(path) {
      lstatCalls.push(path)
      const node = findNode(root, path)
      if (!node) throw fakeError('ENOENT')
      return fakeStats(node)
    },
  }
}

function findNode(root: FakeNode, path: string): FakeNode | null {
  let node: FakeNode = root
  for (const segment of path.split('/').filter(Boolean)) {
    if (node.kind !== 'dir') return null
    const next = node.children!.get(segment)
    if (!next) return null
    node = next
  }
  return node
}

function fakeError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

/** 种子树：/var/log 有文件与符号链接，/proc 有伪文件，/srv/app/node_modules 有依赖树，/root/.bun 有缓存。 */
function seedTree(): FakeNode {
  return dir({
    var: dir({
      log: dir({
        syslog: file(100),
        'auth.log': file(40),
        archive: dir({ 'old.log': file(10) }),
        current: link('/var/log/syslog'),
      }),
    }),
    proc: dir({ cpuinfo: file(0), uptime: file(0) }),
    srv: dir({
      app: dir({
        'index.ts': file(5),
        node_modules: dir({ pkg: dir({ 'index.js': file(20) }) }),
      }),
    }),
    root: dir({ '.bun': dir({ 'cache.bin': file(30) }) }),
  })
}

describe('walkFileTree', () => {
  it('遍历全部后代（含嵌套），起点本身不作为条目回调', async () => {
    const deps = createFakeDeps(seedTree())
    const seen: string[] = []
    const outcome = await walkFileTree(deps, '/var', { virtualDirs: 'prune', onLimit: 'throw', onEntry: ({ path }) => void seen.push(path) })
    expect([...seen].sort()).toEqual(
      ['/var/log', '/var/log/syslog', '/var/log/auth.log', '/var/log/archive', '/var/log/archive/old.log', '/var/log/current'].sort(),
    )
    expect(outcome).toEqual({ visited: 6, truncated: false })
  })

  it('节点上限触顶：throw 模式抛 WalkLimitError，stop 模式标记截断', async () => {
    const throwing = createFakeDeps(seedTree())
    await expect(
      walkFileTree(throwing, '/var/log', { virtualDirs: 'prune', onLimit: 'throw', maxNodes: 2 }),
    ).rejects.toThrow(WalkLimitError)

    const stopping = createFakeDeps(seedTree())
    const outcome = await walkFileTree(stopping, '/var/log', { virtualDirs: 'prune', onLimit: 'stop', maxNodes: 2 })
    expect(outcome.visited).toBe(2)
    expect(outcome.truncated).toBe(true)
  })

  it('深度上限触顶：目录已到深度上限即无法下探，同样按模式抛错或截断', async () => {
    const throwing = createFakeDeps(seedTree())
    await expect(
      walkFileTree(throwing, '/var', { virtualDirs: 'prune', onLimit: 'throw', maxDepth: 2 }),
    ).rejects.toThrow(WalkLimitError)

    const stopping = createFakeDeps(seedTree())
    const outcome = await walkFileTree(stopping, '/var', { virtualDirs: 'prune', onLimit: 'stop', maxDepth: 2 })
    expect(outcome.truncated).toBe(true)
  })

  it('虚拟 FS 前缀：prune 模式整树跳过，reject 模式抛 WalkVirtualDirError 报告命中路径', async () => {
    const pruning = createFakeDeps(seedTree())
    const seen: string[] = []
    await walkFileTree(pruning, '/', { virtualDirs: 'prune', onLimit: 'throw', onEntry: ({ path }) => void seen.push(path) })
    expect(seen.some((path) => path.startsWith('/proc'))).toBe(false)

    const rejecting = createFakeDeps(seedTree())
    let caught: WalkVirtualDirError | null = null
    try {
      await walkFileTree(rejecting, '/', { virtualDirs: 'reject', onLimit: 'throw' })
    } catch (error) {
      caught = error as WalkVirtualDirError
    }
    expect(caught).toBeInstanceOf(WalkVirtualDirError)
    expect(caught!.hitPath).toBe('/proc')
  })

  it('额外剪枝只对目录生效：node_modules 段与工具缓存前缀整树跳过', async () => {
    const deps = createFakeDeps(seedTree())
    const seen: string[] = []
    await walkFileTree(deps, '/', {
      virtualDirs: 'prune',
      onLimit: 'stop',
      extraPrune: (path, name) => name === 'node_modules' || path.startsWith('/root/.bun'),
      onEntry: ({ path }) => void seen.push(path),
    })
    expect(seen.some((path) => path.includes('node_modules'))).toBe(false)
    expect(seen.some((path) => path.startsWith('/root/.bun'))).toBe(false)
    expect(seen).toContain('/srv/app/index.ts')
  })

  it('onEntry 返回 false 提前结束整个遍历', async () => {
    const deps = createFakeDeps(seedTree())
    const seen: string[] = []
    const outcome = await walkFileTree(deps, '/var/log', {
      virtualDirs: 'prune',
      onLimit: 'throw',
      onEntry: ({ path }) => {
        seen.push(path)
        return seen.length < 2
      },
    })
    expect(seen.length).toBe(2)
    expect(outcome.truncated).toBe(false)
  })

  it('列举瞬间消失的条目（lstat ENOENT）被跳过，不炸整次遍历', async () => {
    const deps = createFakeDeps(seedTree())
    const originalLstat = deps.lstat.bind(deps)
    deps.lstat = async (path) => {
      if (path === '/var/log/auth.log') throw fakeError('ENOENT')
      return originalLstat(path)
    }
    const seen: string[] = []
    await walkFileTree(deps, '/var/log', { virtualDirs: 'prune', onLimit: 'throw', onEntry: ({ path }) => void seen.push(path) })
    expect(seen).not.toContain('/var/log/auth.log')
    expect(seen).toContain('/var/log/syslog')
  })
})

describe('sumDescendantSizes', () => {
  it('文件累加 lstat.size，符号链接按链接字节计（不跟随），目录不累计', async () => {
    const deps = createFakeDeps(seedTree())
    // /var/log：syslog 100 + auth.log 40 + archive/old.log 10 + current（链接，长度 = 目标路径长度）
    await expect(sumDescendantSizes(deps, '/var/log')).resolves.toBe(100 + 40 + 10 + '/var/log/syslog'.length)
  })

  it('虚拟 FS 前缀整树剪枝后不计入；node_modules 有意不剪（求和要真实规模）', async () => {
    const deps = createFakeDeps(seedTree())
    // /var/log 全部 + /srv/app（含 node_modules/pkg/index.js 的 20）+ /root/.bun 的 30；/proc 剪掉。
    await expect(sumDescendantSizes(deps, '/')).resolves.toBe(100 + 40 + 10 + '/var/log/syslog'.length + 5 + 20 + 30)
  })

  it('规模触顶抛 WalkLimitError（服务层据此报中文）', async () => {
    const deps = createFakeDeps(seedTree())
    await expect(sumDescendantSizes(deps, '/var/log/archive')).resolves.toBe(10)
    const huge = dir(Object.fromEntries(Array.from({ length: WALK_MAX_NODES + 1 }, (_, i) => [`f${i}`, file(1)])))
    const bigDeps = createFakeDeps(dir({ big: huge }))
    await expect(sumDescendantSizes(bigDeps, '/big')).rejects.toThrow(WalkLimitError)
  })
})

describe('collectDescendantPaths', () => {
  it('收集全部非符号链接后代，符号链接后代跳过', async () => {
    const deps = createFakeDeps(seedTree())
    await expect(collectDescendantPaths(deps, '/var/log')).resolves.toEqual([
      '/var/log/syslog',
      '/var/log/auth.log',
      '/var/log/archive',
      '/var/log/archive/old.log',
    ])
  })
})
