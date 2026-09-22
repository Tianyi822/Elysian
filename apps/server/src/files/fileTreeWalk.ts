import type { Dirent, Stats } from 'node:fs'
import { VIRTUAL_FS_PREFIXES, childPathOf, matchPathPrefix } from './filesPaths.ts'

/*
 * 受限遍历原语：文件管理的大小求和、搜索、复制/压缩预检与递归 chmod 收集共用。
 * 全程 lstat、绝不跟随符号链接——链接既不展开目录（防循环）也不读目标内容
 * （防 /proc、/sys 陷阱）；深度与节点双上限防失控遍历。虚拟 FS 前缀目录按调用方
 * 要求剪枝（跳过）或报告（抛错，由服务层转成中文业务错误）。
 */

/** 遍历节点上限：size/预检/收集触顶报错，search 触顶静默截断。 */
export const WALK_MAX_NODES = 50000
/** 遍历深度上限：目录层次深于此即触顶（正常文件树远浅于此）。 */
export const WALK_MAX_DEPTH = 64

/** 规模触顶的标记错误：服务层捕获后按操作语境转成中文业务错误。 */
export class WalkLimitError extends Error {
  constructor(readonly kind: 'nodes' | 'depth') {
    super(`遍历规模超出上限（${kind}）`)
    this.name = 'WalkLimitError'
  }
}

/** 遇到虚拟 FS 前缀目录的报告错误（仅 reject 模式抛出；prune 模式静默跳过）。 */
export class WalkVirtualDirError extends Error {
  constructor(readonly hitPath: string) {
    super(`目录位于系统虚拟目录下：${hitPath}`)
    this.name = 'WalkVirtualDirError'
  }
}

/** 遍历依赖的最小形状：与 node:fs/promises 的 readdir({withFileTypes:true})/lstat 同构，测试注入内存 fake。 */
export type TreeWalkDeps = {
  readdir(path: string): Promise<readonly Dirent[]>
  lstat(path: string): Promise<Stats>
}

export type WalkEntry = {
  /** 条目绝对路径（由遍历逐层拼装，中间不含符号链接组件——lstat 不展开）。 */
  path: string
  name: string
  stats: Stats
}

export type WalkOptions = {
  /** 遇到虚拟 FS 前缀下的目录：prune 跳过整棵（size/search/chmod 收集）；reject 抛 WalkVirtualDirError（copy/compress 预检）。 */
  virtualDirs: 'prune' | 'reject'
  /** 规模触顶：throw 抛 WalkLimitError；stop 停止遍历并标记 truncated（search 的静默截断）。 */
  onLimit: 'throw' | 'stop'
  /** 额外剪枝（仅目录生效）：search 专属的 node_modules 段与工具缓存前缀。 */
  extraPrune?: (entryPath: string, entryName: string) => boolean
  /** 每个条目的回调（lstat 结果 + 绝对路径）；返回 false 提前结束整个遍历（search 的结果条数上限）。 */
  onEntry?: (entry: WalkEntry) => boolean | void
  /** 覆盖节点上限（测试缩小预算用）；缺省 WALK_MAX_NODES。 */
  maxNodes?: number
  /** 覆盖深度上限（测试缩小预算用）；缺省 WALK_MAX_DEPTH。 */
  maxDepth?: number
}

export type WalkOutcome = {
  /** 实际访问过的条目数（不含被剪枝的目录本身）。 */
  visited: number
  /** 是否因规模触顶提前停止（onLimit: 'stop' 时可能为 true）。 */
  truncated: boolean
}

/**
 * 从 startPath 起深度受限地遍历全部后代（迭代 DFS，起点本身不作为条目回调）。
 * 条目在列举瞬间消失（lstat ENOENT/ENOTDIR）则跳过，其余错误原样抛出。
 */
export async function walkFileTree(deps: TreeWalkDeps, startPath: string, options: WalkOptions): Promise<WalkOutcome> {
  const maxNodes = options.maxNodes ?? WALK_MAX_NODES
  const maxDepth = options.maxDepth ?? WALK_MAX_DEPTH
  let visited = 0
  let truncated = false

  /** 规模触顶：throw 模式抛 WalkLimitError；stop 模式标记截断（调用方随后结束遍历）。 */
  const hitLimit = (kind: 'nodes' | 'depth'): void => {
    if (options.onLimit === 'throw') throw new WalkLimitError(kind)
    truncated = true
  }

  // 栈元素记录「该目录的直接子项所在的深度」：起点的子项深度为 1。
  const stack: Array<{ dirPath: string; childDepth: number }> = [{ dirPath: startPath, childDepth: 1 }]
  while (stack.length > 0) {
    const { dirPath, childDepth } = stack.pop()!
    const dirents = await deps.readdir(dirPath)
    for (const dirent of dirents) {
      if (visited >= maxNodes) {
        hitLimit('nodes')
        return { visited, truncated }
      }
      const entryPath = childPathOf(dirPath, dirent.name)
      let stats: Stats
      try {
        stats = await deps.lstat(entryPath)
      } catch (error) {
        if (isMissingError(error)) continue
        throw error
      }
      visited += 1
      if (stats.isDirectory()) {
        // 虚拟 FS 与额外剪枝都只对目录生效：文件没有可展开的子树。
        if (matchPathPrefix(entryPath, VIRTUAL_FS_PREFIXES) !== null) {
          if (options.virtualDirs === 'reject') throw new WalkVirtualDirError(entryPath)
          continue
        }
        if (options.extraPrune?.(entryPath, dirent.name)) continue
        // 目录已到深度上限则无法继续下探：宁可如实触顶，不静默漏算。
        if (childDepth >= maxDepth) {
          hitLimit('depth')
          return { visited, truncated }
        }
        stack.push({ dirPath: entryPath, childDepth: childDepth + 1 })
      }
      if (options.onEntry?.({ path: entryPath, name: dirent.name, stats }) === false) {
        return { visited, truncated }
      }
    }
  }
  return { visited, truncated }
}

/** 目录全部后代的大小求和：文件与符号链接按 lstat 字节数累计（链接不跟随），目录不累计。 */
export async function sumDescendantSizes(deps: TreeWalkDeps, startPath: string): Promise<number> {
  let total = 0
  await walkFileTree(deps, startPath, {
    virtualDirs: 'prune',
    onLimit: 'throw',
    onEntry: ({ stats }) => {
      if (!stats.isDirectory()) total += stats.size
    },
  })
  return total
}

/** 收集目录的全部后代路径（递归 chmod 的收集段）：符号链接后代跳过，绝不改到链接目标上。 */
export async function collectDescendantPaths(deps: TreeWalkDeps, startPath: string): Promise<readonly string[]> {
  const paths: string[] = []
  await walkFileTree(deps, startPath, {
    virtualDirs: 'prune',
    onLimit: 'throw',
    onEntry: ({ path, stats }) => {
      if (!stats.isSymbolicLink()) paths.push(path)
    },
  })
  return paths
}

function isMissingError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  const code = String((error as { code?: unknown }).code)
  return code === 'ENOENT' || code === 'ENOTDIR'
}
