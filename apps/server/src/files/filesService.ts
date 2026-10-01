import { randomBytes } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import type { FileEntry, FileSearchResult } from '@elysian/contracts'
import {
  isValidFileName,
  isValidFileMode,
  isValidHostUserName,
  matchesFilePath,
  normalizeFileSearch,
} from '@elysian/contracts'
import { invalidRequest } from '../shared/errors.ts'
import { parseGetentPasswd, type PasswdRecord } from '../users/parseSystemUsers.ts'
import {
  SEARCH_PRUNE_DIR_NAMES,
  VIRTUAL_FS_PREFIXES,
  childPathOf,
  forbiddenWritePrefixes,
  leafNameOf,
  matchPathPrefix,
  normalizeServerFilePath,
  parentDirOf,
  searchExtraPrunePrefixes,
} from './filesPaths.ts'
import {
  WALK_MAX_NODES,
  WalkLimitError,
  WalkVirtualDirError,
  collectDescendantPaths,
  sumDescendantSizes,
  walkFileTree,
  type TreeWalkDeps,
} from './fileTreeWalk.ts'

/*
 * 文件管理的服务编排：把界面动作翻译成容器内 cp/mv/tar 的真实执行与 fs 原语调用。
 * 校验顺序与中文错误文案逐字对齐 web 侧 mock（apps/web/src/adapters/mock/filesData.ts）；
 * 全部宿主访问经 deps 注入，编排逻辑在 Vitest 里用有状态 fake（内存文件树 + 命令账本）
 * 驱动，不执行任何真实命令。
 *
 * 安全红线：
 * - 所有命令经注入的 execFile 数组传参执行，绝不拼 shell 字符串；路径与文件名即使
 *   含空格、引号、`--` 也只是单个 argv 元素（控制字符已被路径判据拒绝，双保险）。
 * - 写操作不跟随最终组件符号链接：chmod/chown 走 shared/noFollowFs 的句柄原语，
 *   最终组件是符号链接时显式抛中文错误；mv -T 与 rename 走 rename(2)，天然不跟随。
 * - cp 与 tar 只在源侧不跟随：GNU 语义里目标名上的符号链接是跟随的（coreutils 9.4
 *   与 tar 1.35 实测都会写穿到链接目标），所以复制与压缩的产物一律先落进 mkdir
 *   独占创建的私有暂存目录（0700、名字带随机段），再用 rename(2) 发布到最终名——
 *   目标名被抢注为符号链接时，产物只会替换链接本身或让发布失败，绝不写穿到链接目标。
 * - 写禁区双道检查：归一化字符串前缀之外再做一次 realpath 复核，中间组件符号链接
 *   （如 /tmp/x → /root/.ssh）解析后清单依然命中；清单同时收录面板资产的字符串名
 *   与卷挂真身（/root/.Elysian 与 /var/lib/elysian）。
 * - 锚点防换链（TOCTOU）：复制/移动/重命名/压缩四个写入口在复核时捕获目标目录的
 *   realpath 锚点，命令执行前复验锚点不变、执行后核验产物落点仍在锚点内。锚点复验
 *   与 mv/cp/tar 子进程 spawn 之间仍有毫秒级窗口，竞态赢家的写穿由执行后落点校验
 *   清理，但被覆盖的保护区原文件内容不可恢复——损害从「凭据接管」降为「保护区文件
 *   被删或被覆盖后清理、fail closed、可 resetpwd 恢复」，不承诺绝对防写穿。
 * - 递归 chmod 分三段：入口 realpath 复核 → 受限遍历收集（超限在收集段拒绝，不留
 *   半改状态）→ 收集列表逐项过写禁区判定后才执行，chmod -R /root 砸不穿保护区。
 * - 读遍历全程 lstat 不跟随符号链接（防循环与 /proc、/sys、/dev 陷阱），深度与
 *   节点双上限；写命令前先做同款预检，预检遇虚拟 FS 前缀直接拒绝。
 * - 每次写操作完成后回读真实条目（stat 推导视图），绝不返回命令拼出来的乐观值。
 */

/** 列举条数上限：超出截断（顺序本不保证，截断不破坏契约）。 */
export const LIST_MAX_ENTRIES = 10000
/** 搜索结果条数上限：触顶即停止遍历返回已命中部分。 */
export const SEARCH_MAX_RESULTS = 1000

/**
 * 暂存目录名前缀：随机段不可预测，目标目录里的抢注者无法提前占住这个名字。
 * 代价是复制/压缩期间它会短暂出现在目标目录的列举里（结束后立即清理）；
 * 同文件系统是 rename(2) 发布的前提，因此暂存只能落在目标目录内。
 */
const STAGING_DIR_PREFIX = '.elysian-staging-'
/**
 * 暂存产物名：固定值。cp/tar 的目标侧符号链接是跟随的（见文件头安全红线），
 * 产物因此先写进私有暂存目录；万一暂存目录本身被换链，被写出的也是这个固定名字，
 * 不由抢注者指定成 authorized_keys 之类的敏感名。
 */
const STAGED_ARTIFACT_NAME = '.payload'
/** 暂存目录创建尝试次数：随机名撞车极罕见，仅作防御性上限。 */
const STAGING_CREATE_ATTEMPTS = 16
/** 发布重试上限：目标名被抢注时按 mock 的占用法则换名重试，反复被抢则如实报错。 */
const PUBLISH_ATTEMPTS = 4

/**
 * 权限变更输入：与 web 侧 contracts 的 FilePermissionInput 结构一致（该接口尚未上提
 * @elysian/contracts，server 侧先以同形类型对齐，靠结构化类型保持兼容）。
 */
export type FilePermissionInput = {
  mode: string
  owner: string
  /** 只对目录有意义：连同全部后代一起改。 */
  recursive: boolean
}

/** 宿主访问的最小注入形状：node:fs/promises 同构原语 + execFile 命令出口，测试注入内存 fake。 */
export type FilesHostDeps = TreeWalkDeps & {
  /** 跟随符号链接的 stat：读操作按指向呈现（契约口径）。 */
  stat(path: string): Promise<Stats>
  /** 解析全部符号链接后的绝对路径：写禁区复核用。 */
  realpath(path: string): Promise<string>
  /** node fs.rename：同目录改名永不跨设备，rename(2) 天然不跟随最终组件符号链接。 */
  renamePath(from: string, to: string): Promise<void>
  /** node fs.mkdir（非递归，已存在即抛 EEXIST）：私有暂存目录的原子抢占。 */
  mkdir(path: string, mode: number): Promise<void>
  /** node fs.rm（接线层固定 recursive + force）：暂存目录与残留产物清理；对符号链接只摘链接本身。 */
  rmPath(path: string): Promise<void>
  runCp(args: readonly string[]): Promise<string>
  runMv(args: readonly string[]): Promise<string>
  runTar(args: readonly string[]): Promise<string>
  /** getent 出口（退出码 2 归一空输出的语义由接线层提供）：owner 反查与 uid→名字映射。 */
  runGetent(args: readonly string[]): Promise<string>
  /** 不跟随最终组件符号链接的权限原语（shared/noFollowFs）：权限与属主绝不落到链接目标上。 */
  chmodNoFollow(path: string, mode: number): Promise<void>
  chownNoFollow(path: string, uid: number, gid: number): Promise<void>
  /** 写禁区与剪枝清单的 `/root` 前缀来源（真实接线传 os.homedir()，测试注入 /root）。 */
  homeDir(): string
}

/** 规模上限的中文文案前缀：统计（size）与操作（复制/压缩/chmod 收集）两个语境。 */
const SIZE_LIMIT_MESSAGE = `目录规模超出统计上限（${WALK_MAX_NODES} 个条目），请缩小统计范围`
const OPERATION_LIMIT_MESSAGE = `目录规模超出操作上限（${WALK_MAX_NODES} 个条目）`

function commandError(command: string, args: readonly string[], error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`${command} 执行失败（${[command, ...args].join(' ')}）：${detail}`)
}

/** node fs 错误的 code 读取（ENOENT/ENOTDIR/ELOOP 等），无 code 返回 undefined。 */
function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

/** 路径不存在（ENOENT）或中间组件不是目录（ENOTDIR）：mock 的 findNode 对两者同报「目录不存在」。 */
function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 符号链接环（ELOOP）：跟随语义的 stat/realpath 在环上抛它，lstat 不跟随、不受影响。 */
function isLinkLoopError(error: unknown): boolean {
  return errorCode(error) === 'ELOOP'
}

/** 非缺失类 fs 错误的中文上下文包装：errno 细节保留在冒号后，绝不裸冒英文 500。 */
function fsErrorInChinese(context: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`${context}：${detail}`)
}

export function createFilesService(deps: FilesHostDeps) {
  /** 写禁区与 search 剪枝清单在装配时按注入的 homeDir 建好，操作内不再重复解析。 */
  const forbiddenPrefixes = forbiddenWritePrefixes(deps.homeDir())
  const searchPrunePrefixes = searchExtraPrunePrefixes(deps.homeDir())

  function directoryMissing(path: string): Error {
    return invalidRequest(`目录不存在：${path}`)
  }

  /** stat 一个必须存在的路径；不存在或中间组件不是目录统一报「目录不存在：<原文>」，其余错误带中文上下文上抛。 */
  async function statExisting(path: string, label: string): Promise<Stats> {
    return deps.stat(path).catch((error: unknown) => {
      if (isMissingPathError(error)) throw directoryMissing(label)
      throw fsErrorInChinese(`读取路径状态失败（${label}）`, error)
    })
  }

  /** stat 一个必须存在且是目录的路径；路径是文件同样报「目录不存在」（mock 的 findDirectory 同款）。 */
  async function statDirectory(path: string, label: string): Promise<Stats> {
    const stats = await statExisting(path, label)
    if (!stats.isDirectory()) throw directoryMissing(label)
    return stats
  }

  /** 不跟随符号链接的 lstat：不存在（ENOENT 或中间组件不是目录）返回 null。 */
  async function lstatOrNull(path: string): Promise<Stats | null> {
    try {
      return await deps.lstat(path)
    } catch (error) {
      if (isMissingPathError(error)) return null
      throw error
    }
  }

  /** 名字占用判定（lstat 口径）：断链符号链接也算占用——它挡着这个名字。 */
  async function nameExists(path: string): Promise<boolean> {
    return (await lstatOrNull(path)) !== null
  }

  /** 条目视图组装：kind 只有两值（socket/fifo/设备按文件呈现），mode 取三位八进制，owner 解析不出名字时用 uid。 */
  function entryOf(name: string, stats: Stats, uidNames: ReadonlyMap<number, string>): FileEntry {
    const isDirectory = stats.isDirectory()
    return {
      name,
      kind: isDirectory ? 'directory' : 'file',
      mode: (stats.mode & 0o777).toString(8).padStart(3, '0'),
      owner: uidNames.get(stats.uid) ?? String(stats.uid),
      sizeBytes: isDirectory ? undefined : stats.size,
      modifiedAt: stats.mtime.toISOString(),
    }
  }

  /** 一次全量 getent passwd 建 uid→名字映射：list 与 search 的 owner 呈现共用。 */
  async function uidNameMap(): Promise<ReadonlyMap<number, string>> {
    const args = ['passwd'] as const
    const output = await deps.runGetent(args).catch((error: unknown) => {
      throw commandError('getent', args, error)
    })
    const map = new Map<number, string>()
    for (const record of parseGetentPasswd(output)) {
      if (!map.has(record.uid)) map.set(record.uid, record.name)
    }
    return map
  }

  /** owner 反查：getent passwd <名> 解析 uid/gid，查无报「未找到系统账号」（与 users 片一致）。 */
  async function findPasswdRecord(name: string): Promise<PasswdRecord> {
    const args = ['passwd', name] as const
    const output = await deps.runGetent(args).catch((error: unknown) => {
      throw commandError('getent', args, error)
    })
    const record = parseGetentPasswd(output)[0]
    if (!record) throw invalidRequest(`未找到系统账号：${name}`)
    return record
  }

  /**
   * realpath 复核的取值：断链符号链接（ENOENT）无法解析，返回 null 保留字符串判定结果继续
   * ——后续的符号链接检查或命令自身会给出中文错误，不让英文 ENOENT 冒成 500。
   */
  async function resolvedOrNull(path: string): Promise<string | null> {
    try {
      return await deps.realpath(path)
    } catch (error) {
      if (isMissingPathError(error)) return null
      throw fsErrorInChinese(`解析真实路径失败（${path}）`, error)
    }
  }

  /**
   * 写禁区判定（两道）：归一化路径前缀 + realpath 复核，命中任一即拒绝。放行时返回
   * realpath 复核的取值作为目录锚点——判定内部本就要做这次 realpath，零新增系统调用，
   * 调用方可拿它做命令执行前后的「锚点防换链」复验（见 assertDirAnchorUnchanged）。
   */
  async function assertNotForbiddenWrite(path: string): Promise<string | null> {
    if (matchPathPrefix(path, forbiddenPrefixes) !== null) {
      throw invalidRequest(`拒绝操作受保护路径：${path}`)
    }
    const resolved = await resolvedOrNull(path)
    if (resolved !== null && matchPathPrefix(resolved, forbiddenPrefixes) !== null) {
      throw invalidRequest(`拒绝操作受保护路径：${resolved}`)
    }
    return resolved
  }

  /**
   * 目录锚点复验：resolvedOrNull 取值与锚点捕获时严格相等（含双 null）才放行。锚点
   * 捕获与命令执行之间目标目录被整体换成符号链接（如 /tmp → /root/.ssh）时，后续
   * cp/mv/tar 会经链接把产物落进保护区，这里在命令执行前拒绝。抛普通 Error（500
   * 口径）：目录被换链不是客户端的请求错误，不伪装成 invalidRequest。
   */
  async function assertDirAnchorUnchanged(dirPath: string, anchor: string | null): Promise<void> {
    const resolved = await resolvedOrNull(dirPath)
    if (resolved !== anchor) {
      throw new Error(`目标目录在操作期间被替换，已中止：${dirPath}`)
    }
  }

  /**
   * 执行后落点校验：产物必须仍在锚点目录内。先 lstat：产物消失直接中止；产物本身是
   * 符号链接时不做 realpath 包含判定（realpath 会跟随产物自身的链接——活链接解析到
   * 锚点外误判写穿、断链回 null 后再 startsWith 会崩，而产物自身是否为链接与写穿
   * 无关），改验父目录锚点复验，中间组件换链由它抓住。非符号链接产物 realpath 不在
   * 锚点之下（含解析失败）时，先尽力清理产物（node rm 对符号链接只摘链接本身，无
   * 穿透风险）再中止；anchor 为 null 时只做父目录锚点复验（复核时断链的路径命令
   * 自身会先失败，到不了这里，防御性收口）。
   */
  async function verifyArtifactWithinAnchor(artifactPath: string, anchorDirPath: string, anchor: string | null): Promise<void> {
    const stats = await lstatOrNull(artifactPath)
    if (stats === null) {
      throw new Error(`产物落点异常，已清理并中止：${artifactPath}`)
    }
    if (stats.isSymbolicLink() || anchor === null) {
      await assertDirAnchorUnchanged(anchorDirPath, anchor)
      return
    }
    const resolved = await resolvedOrNull(artifactPath)
    if (!resolved?.startsWith(`${anchor}/`)) {
      await deps.rmPath(artifactPath).catch(() => {})
      throw new Error(`产物落点异常，已清理并中止：${artifactPath}`)
    }
  }

  /**
   * 派生落点的窄版禁区：只做字符串前缀判定，不做 realpath 复核。派生出的目标名是本次
   * 操作即将创建的最终组件——它若已被抢注为符号链接，rename(2) 只替换链接本身、不跟随，
   * 按占用法则换名即可（那正是抢注用例断言的语义）；而父目录的 realpath 复核已由各入口
   * 的完整判定覆盖。这里挡的是「名字恰好补齐一条禁区路径」——在保护区内造出新条目。
   */
  function assertNotForbiddenTargetPath(target: string): void {
    if (matchPathPrefix(target, forbiddenPrefixes) !== null) {
      throw invalidRequest(`拒绝操作受保护路径：${target}`)
    }
  }

  /** 复制源的窄版禁区：只拦虚拟 FS 前缀（cp -a /proc 会真的遍历伪文件）。 */
  async function assertNotVirtualSource(path: string): Promise<void> {
    if (matchPathPrefix(path, VIRTUAL_FS_PREFIXES) !== null) {
      throw invalidRequest(`拒绝操作系统虚拟目录：${path}`)
    }
    const resolved = await resolvedOrNull(path)
    if (resolved !== null && matchPathPrefix(resolved, VIRTUAL_FS_PREFIXES) !== null) {
      throw invalidRequest(`拒绝操作系统虚拟目录：${path}`)
    }
  }

  /** 目标目录在源目录内部（含相等）：字符串判断 + realpath 复核（中间组件符号链接会绕过字符串判断）。 */
  async function assertDestNotInsideSource(src: string, destDir: string, action: '复制' | '移动'): Promise<void> {
    const inside = (target: string, source: string): boolean => target === source || target.startsWith(`${source}/`)
    if (inside(destDir, src)) throw invalidRequest(`不能把目录${action}到它自己内部`)
    const [resolvedSrc, resolvedDest] = await Promise.all([resolvedOrNull(src), resolvedOrNull(destDir)])
    if (resolvedSrc !== null && resolvedDest !== null && inside(resolvedDest, resolvedSrc)) {
      throw invalidRequest(`不能把目录${action}到它自己内部`)
    }
  }

  /** 目标重名时派生「 副本」后缀，副本再撞车往下编号（mock 同算法）。 */
  async function deriveUniqueName(destDir: string, name: string): Promise<string> {
    const taken = new Set((await deps.readdir(destDir)).map((dirent) => dirent.name))
    if (!taken.has(name)) return name
    let candidate = `${name} 副本`
    let counter = 2
    while (taken.has(candidate)) {
      candidate = `${name} 副本 ${counter}`
      counter += 1
    }
    return candidate
  }

  /** 复制/压缩的预检：与 size 同款受限遍历，遇虚拟 FS 前缀报告拒绝（cp/tar 无排除能力），超限拒绝。 */
  async function precheckSourceTree(src: string, action: '复制' | '压缩'): Promise<void> {
    try {
      await walkFileTree(deps, src, { virtualDirs: 'reject', onLimit: 'throw' })
    } catch (error) {
      if (error instanceof WalkVirtualDirError) {
        throw invalidRequest(`目录包含系统虚拟目录（/proc、/sys、/dev），无法${action}`)
      }
      if (error instanceof WalkLimitError) throw invalidRequest(OPERATION_LIMIT_MESSAGE)
      throw error
    }
  }

  /**
   * 私有暂存目录：mkdir 独占创建（名字已被占用即换随机名重试，绝不复用别人占住的名字），
   * 权限 0700。cp/tar 的产物先写在这里，最终名由发布时的 rename(2) 落位。
   * 调用点放在预检之后：预检可能遍历上万条，越晚建目录，「目标名被抢注」的窗口越小。
   */
  async function createStagingDir(destDir: string): Promise<string> {
    for (let attempt = 0; attempt < STAGING_CREATE_ATTEMPTS; attempt += 1) {
      const candidate = childPathOf(destDir, `${STAGING_DIR_PREFIX}${randomBytes(8).toString('hex')}`)
      try {
        await deps.mkdir(candidate, 0o700)
        return candidate
      } catch (error) {
        if (errorCode(error) === 'EEXIST') continue
        throw new Error(`无法创建暂存目录（${candidate}）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`无法在目标目录创建暂存目录：${destDir}`)
  }

  /**
   * 暂存目录复核：仍是我们创建的那个目录（不是被换成符号链接的名字）才允许发布。
   * lstat 判定之外再做一次 realpath 过写禁区——锚点复验之后才被换链的暂存目录名，
   * 解析后落进保护区的在这里拦下（防复验后才换链的第二道）。
   */
  async function assertStagingIntact(stagingDir: string): Promise<void> {
    const stats = await deps.lstat(stagingDir).catch((error: unknown) => {
      throw new Error(`暂存目录不可用（${stagingDir}）：${error instanceof Error ? error.message : String(error)}`)
    })
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`暂存目录被抢占，已放弃发布：${stagingDir}`)
    }
    const resolved = await resolvedOrNull(stagingDir)
    if (resolved !== null && matchPathPrefix(resolved, forbiddenPrefixes) !== null) {
      throw new Error(`暂存目录被抢占，已放弃发布：${stagingDir}`)
    }
  }

  /**
   * 复制产物的发布：最终名被占用（lstat 不跟随，断链符号链接也算占用）时按 mock 的
   * 占用法则换「副本」名重试。落位一律用 rename(2)：目标名即使在复核之后被换成
   * 符号链接，rename 也只替换链接本身、不跟随它（目录产物会以 ENOTDIR 失败，随后换名重试）。
   */
  async function publishCopyArtifact(staged: string, destDir: string, baseName: string): Promise<{ name: string; path: string }> {
    let name = baseName
    let lastError: unknown = null
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
      const destChild = childPathOf(destDir, name)
      if ((await lstatOrNull(destChild)) === null) {
        try {
          await deps.renamePath(staged, destChild)
          return { name, path: destChild }
        } catch (error) {
          lastError = error
        }
      }
      name = await deriveUniqueName(destDir, baseName)
    }
    throw new Error(
      `发布复制产物失败（已换名重试 ${PUBLISH_ATTEMPTS} 次，目标名可能被抢占）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  }

  /** 压缩包的发布：最终名被抢占即按 mock 语义报「同名压缩包已存在」，不换名也不写穿。 */
  async function publishArchive(staged: string, archivePath: string, archiveName: string): Promise<void> {
    if (await nameExists(archivePath)) throw invalidRequest(`同名压缩包已存在：${archiveName}`)
    try {
      await deps.renamePath(staged, archivePath)
    } catch (error) {
      // 复核与 rename 之间被抢占：名字确已被占用一律按 mock 文案报出，其余失败原样上抛
      if ((await lstatOrNull(archivePath)) !== null) throw invalidRequest(`同名压缩包已存在：${archiveName}`)
      throw error
    }
  }

  /**
   * 写后回读：返回条目来自 fs 的真实状态，绝不返回命令拼出来的乐观值。
   * 呈现与 list/search 共用 statListedEntry：符号链接按指向呈现，断链（如相对目标的
   * 链接被复制到别处）回退 lstat 按链接自身呈现而不是报读取失败；条目确实消失才报错。
   */
  async function readEntry(path: string, name: string, uidNames: ReadonlyMap<number, string>): Promise<FileEntry> {
    // 错误消息由 statListedEntry 统一产出（中文上下文），这里不再包一层。
    const stats = await statListedEntry(path)
    if (stats === null) throw new Error(`读取条目状态失败（${path}）：条目已消失`)
    return entryOf(name, stats, uidNames)
  }

  /** 列举的单个条目 stat：「按指向呈现」不可得（断链 ENOENT/ENOTDIR、链接环 ELOOP）回退 lstat 按链接自身呈现——一个环不炸整个列举；列举瞬间消失返回 null，其余错误带中文上下文上抛。 */
  async function statListedEntry(path: string): Promise<Stats | null> {
    try {
      return await deps.stat(path)
    } catch (error) {
      if (!isMissingPathError(error) && !isLinkLoopError(error)) {
        throw fsErrorInChinese(`读取条目状态失败（${path}）`, error)
      }
    }
    try {
      return await deps.lstat(path)
    } catch (error) {
      if (isMissingPathError(error)) return null
      throw fsErrorInChinese(`读取条目状态失败（${path}）`, error)
    }
  }

  return {
    /** 列出目录的直接子项：断链符号链接回退 lstat 按文件呈现；顺序不保证；超上限截断。 */
    async list(dirPath: string): Promise<readonly FileEntry[]> {
      const normalized = normalizeServerFilePath(dirPath)
      await statDirectory(normalized, dirPath)
      const dirents = await deps.readdir(normalized)
      const uidNames = await uidNameMap()
      const entries: FileEntry[] = []
      for (const dirent of dirents) {
        if (entries.length >= LIST_MAX_ENTRIES) break
        const stats = await statListedEntry(childPathOf(normalized, dirent.name))
        if (stats === null) continue
        entries.push(entryOf(dirent.name, stats, uidNames))
      }
      return entries
    },

    /** 递归统计大小：文件是自身大小，目录是全部后代之和（lstat 口径，符号链接按链接字节计）。 */
    async size(nodePath: string): Promise<number> {
      const normalized = normalizeServerFilePath(nodePath)
      const stats = await statExisting(normalized, nodePath)
      // 别名起点（符号链接指向 /proc 等）与直指同样拒绝：遍历起点不经前缀剪枝，
      // 别名的子项路径不匹配虚拟前缀，会真实遍历伪文件内容。
      await assertNotVirtualSource(normalized)
      if (!stats.isDirectory()) return stats.size
      try {
        return await sumDescendantSizes(deps, normalized)
      } catch (error) {
        if (error instanceof WalkLimitError) throw invalidRequest(SIZE_LIMIT_MESSAGE)
        throw error
      }
    },

    /** 深拷贝进目标目录：cp -a 保留权限/属主/时间戳，目标重名自动派生副本名。 */
    async copyEntry(srcPath: string, destDirPath: string): Promise<FileEntry> {
      const src = normalizeServerFilePath(srcPath)
      const destDir = normalizeServerFilePath(destDirPath)
      if (src === '/') throw invalidRequest('根目录不能复制')
      const srcStats = await statExisting(src, srcPath)
      await statDirectory(destDir, destDirPath)
      await assertNotVirtualSource(src)
      const srcIsDirectory = srcStats.isDirectory()
      if (srcIsDirectory) await assertDestNotInsideSource(src, destDir, '复制')
      const destDirAnchor = await assertNotForbiddenWrite(destDir)
      const newName = await deriveUniqueName(destDir, leafNameOf(src))
      // 目标目录放行不代表派生出的目标名放行：源名恰好补齐一条禁区路径时（往 /root 落一个
      // 名为 .ssh 的条目），条目的完整路径已进保护区，与其余判据一样先于任何命令拒绝。
      assertNotForbiddenTargetPath(childPathOf(destDir, newName))
      if (srcIsDirectory) await precheckSourceTree(src, '复制')
      const stagingDir = await createStagingDir(destDir)
      try {
        const staged = childPathOf(stagingDir, STAGED_ARTIFACT_NAME)
        // 锚点防换链：mkdir 前目标目录被换链会使暂存落进保护区，cp 执行前先拒。
        await assertDirAnchorUnchanged(destDir, destDirAnchor)
        const args = ['-a', src, staged] as const
        await deps.runCp(args).catch((error: unknown) => {
          throw commandError('cp', args, error)
        })
        await assertStagingIntact(stagingDir)
        // rename 发布是穿透点：发布前再验一次锚点，发布后核验产物落点仍在锚点内。
        await assertDirAnchorUnchanged(destDir, destDirAnchor)
        const published = await publishCopyArtifact(staged, destDir, newName)
        await verifyArtifactWithinAnchor(published.path, destDir, destDirAnchor)
        return readEntry(published.path, published.name, await uidNameMap())
      } finally {
        // 暂存目录与残留产物一并清理（尽力而为，不掩盖原始错误）
        await deps.rmPath(stagingDir).catch(() => {})
      }
    },

    /** 移动进目标目录：mv -T 封死「目标意外是目录时把源挪进去」；重名同样派生副本名。 */
    async moveEntry(srcPath: string, destDirPath: string): Promise<FileEntry> {
      const src = normalizeServerFilePath(srcPath)
      const destDir = normalizeServerFilePath(destDirPath)
      if (src === '/') throw invalidRequest('根目录不能移动')
      const inside = (target: string, source: string): boolean => target === source || target.startsWith(`${source}/`)
      if (inside(destDir, src)) throw invalidRequest('不能把目录移动到它自己内部')
      const srcStats = await statExisting(src, srcPath)
      await statDirectory(destDir, destDirPath)
      if (parentDirOf(src) === destDir) throw invalidRequest('目标目录与源目录相同')
      // 源的移动自带删除语义，与复制的只读源不同：源与目标都查完整写禁区。
      await assertNotForbiddenWrite(src)
      const destDirAnchor = await assertNotForbiddenWrite(destDir)
      if (srcStats.isDirectory()) await assertDestNotInsideSource(src, destDir, '移动')
      const newName = await deriveUniqueName(destDir, leafNameOf(src))
      const destChild = childPathOf(destDir, newName)
      // 同复制：目标目录放行不代表派生出的目标名放行（源名恰好补齐禁区路径）。
      assertNotForbiddenTargetPath(destChild)
      // 锚点防换链：mv 执行前复验目标目录、执行后核验产物落点仍在锚点内。
      await assertDirAnchorUnchanged(destDir, destDirAnchor)
      const args = ['-T', src, destChild] as const
      await deps.runMv(args).catch((error: unknown) => {
        throw commandError('mv', args, error)
      })
      await verifyArtifactWithinAnchor(destChild, destDir, destDirAnchor)
      return readEntry(destChild, newName, await uidNameMap())
    },

    /** 重命名：名称非法或同级重名报错；名字没变不执行任何命令，原样回读返回。 */
    async renameEntry(path: string, newName: string): Promise<FileEntry> {
      const trimmed = newName.trim()
      if (!isValidFileName(trimmed)) throw invalidRequest(`无效的名称：${newName}`)
      const normalized = normalizeServerFilePath(path)
      if (normalized === '/') throw invalidRequest('根目录不能重命名')
      const parent = parentDirOf(normalized)
      await statDirectory(parent, parent)
      const leaf = leafNameOf(normalized)
      // 存在性走 lstat：断链符号链接也算存在（rename(2) 搬的正是链接名本身）。
      if ((await lstatOrNull(normalized)) === null) throw invalidRequest(`条目不存在：${path}`)
      if (trimmed === leaf) {
        // 名字没变：呈现与 list/search 同口径（符号链接按指向呈现，断链才回退链接自身）。
        const stats = await statListedEntry(normalized)
        if (stats === null) throw invalidRequest(`条目不存在：${path}`)
        return entryOf(leaf, stats, await uidNameMap())
      }
      const siblings = new Set((await deps.readdir(parent)).map((dirent: Dirent) => dirent.name))
      if (siblings.has(trimmed)) throw invalidRequest(`同名条目已存在：${trimmed}`)
      await assertNotForbiddenWrite(normalized)
      // 父目录此前只有 statDirectory（stat 跟随符号链接，拦不住换链）：这里补完整写
      // 禁区判定并捕获锚点，顺带堵住父目录静态换链而条目 realpath 因 ENOENT 回 null 的漏判。
      const parentAnchor = await assertNotForbiddenWrite(parent)
      const target = childPathOf(parent, trimmed)
      // 目标名可能恰好补齐一条禁区路径（父目录放行、名字补齐），按同一道判定拒绝。
      assertNotForbiddenTargetPath(target)
      // 锚点防换链：rename 执行前复验父目录、执行后核验产物落点仍在锚点内。
      await assertDirAnchorUnchanged(parent, parentAnchor)
      await deps.renamePath(normalized, target).catch((error: unknown) => {
        throw new Error(`重命名失败（${normalized} → ${target}）：${error instanceof Error ? error.message : String(error)}`)
      })
      await verifyArtifactWithinAnchor(target, parent, parentAnchor)
      return readEntry(target, trimmed, await uidNameMap())
    },

    /** 压缩成同级的「名称.tar.gz」：tar 打包符号链接成员本身、不跟随。 */
    async compressEntry(path: string): Promise<FileEntry> {
      const normalized = normalizeServerFilePath(path)
      if (normalized === '/') throw invalidRequest('根目录不能压缩')
      const parent = parentDirOf(normalized)
      await statDirectory(parent, parent)
      const leaf = leafNameOf(normalized)
      const stats = await statExisting(normalized, path)
      const archiveName = `${leaf}.tar.gz`
      const archivePath = childPathOf(parent, archiveName)
      if (await nameExists(archivePath)) throw invalidRequest(`同名压缩包已存在：${archiveName}`)
      await assertNotForbiddenWrite(normalized)
      const parentAnchor = await assertNotForbiddenWrite(parent)
      // 产物名恒为 `<名>.tar.gz`，今天不可能等于清单里的任何前缀；仍过同一道判定，
      // 让「派生落点全部先于命令过写禁区判定」这条规律完整可审，清单扩张时不留缺口。
      assertNotForbiddenTargetPath(archivePath)
      if (stats.isDirectory()) await precheckSourceTree(normalized, '压缩')
      const stagingDir = await createStagingDir(parent)
      try {
        const staged = childPathOf(stagingDir, STAGED_ARTIFACT_NAME)
        const args = ['-czf', staged, '-C', parent, '--', leaf] as const
        // 锚点防换链：tar 执行前与发布前各复验一次父目录，发布后核验产物落点。
        await assertDirAnchorUnchanged(parent, parentAnchor)
        await deps.runTar(args).catch((error: unknown) => {
          throw commandError('tar', args, error)
        })
        await assertStagingIntact(stagingDir)
        await assertDirAnchorUnchanged(parent, parentAnchor)
        await publishArchive(staged, archivePath, archiveName)
        await verifyArtifactWithinAnchor(archivePath, parent, parentAnchor)
        return readEntry(archivePath, archiveName, await uidNameMap())
      } finally {
        await deps.rmPath(stagingDir).catch(() => {})
      }
    },

    /** 改权限与属主：非递归两个原语直落；递归三段（复核 → 收集 → 过滤后执行），绝不半改。 */
    async chmod(path: string, input: FilePermissionInput): Promise<void> {
      const normalized = normalizeServerFilePath(path)
      if (normalized === '/') throw invalidRequest('根目录不能改权限')
      if (!isValidFileMode(input.mode)) throw invalidRequest(`无效的权限位：${input.mode}`)
      const ownerName = input.owner.trim()
      if (!ownerName) throw invalidRequest('所有者不能为空')
      const stats = await deps.lstat(normalized).catch((error: unknown) => {
        if (isMissingPathError(error)) throw invalidRequest(`目录不存在：${path}`)
        throw error
      })
      if (input.recursive && !stats.isDirectory()) throw invalidRequest('只有目录可以连同子目录一起改权限')
      if (!isValidHostUserName(ownerName)) throw invalidRequest(`无效的所有者名：${ownerName}`)
      const owner = await findPasswdRecord(ownerName)
      await assertNotForbiddenWrite(normalized)
      // 最终组件是符号链接：改链接指向对象 = 借链接越权；改链接本身的权限位在 Linux 上无意义。
      if (stats.isSymbolicLink()) throw invalidRequest(`不能对符号链接执行该操作：${path}`)

      const modeBits = Number.parseInt(input.mode, 8)
      const applyTo = async (target: string): Promise<void> => {
        await deps.chmodNoFollow(target, modeBits).catch((error: unknown) => {
          throw new Error(`修改权限失败（${target}）：${error instanceof Error ? error.message : String(error)}`)
        })
        await deps.chownNoFollow(target, owner.uid, owner.gid).catch((error: unknown) => {
          throw new Error(`修改属主失败（${target}）：${error instanceof Error ? error.message : String(error)}`)
        })
      }

      if (!input.recursive) {
        await applyTo(normalized)
        return
      }
      // 收集段：受限遍历收集非符号链接后代，超限在这里拒绝——零条命令已执行，不留半改状态。
      let descendants: readonly string[]
      try {
        descendants = await collectDescendantPaths(deps, normalized)
      } catch (error) {
        if (error instanceof WalkLimitError) throw invalidRequest(OPERATION_LIMIT_MESSAGE)
        throw error
      }
      // 过滤段：入口复核只挡直接点名的路径，chmod -R /root 的收集列表里会出现 /root/.ssh、
      // /root/.bun 等保护区后代——不过滤就从上往下砸穿保护。收集路径由 lstat 遍历构造、
      // 不含符号链接中间组件，字符串前缀判定即可靠。
      for (const target of descendants) {
        if (matchPathPrefix(target, forbiddenPrefixes) !== null) {
          throw invalidRequest(`拒绝操作受保护路径：${target}`)
        }
      }
      await applyTo(normalized)
      for (const target of descendants) await applyTo(target)
    },

    /**
     * 全树搜索：契约 matchesFilePath 口径（去全部空白+小写，名称或完整路径任一命中）。
     * 遍历全程 lstat 不跟随（防循环与 /proc、/sys 陷阱），命中条目的呈现与 list 同口径：
     * 逐条补一次跟随 stat（契约「符号链接按其指向呈现，不单列一类」），断链才回退 lstat
     * ——与 list 共用 statListedEntry，两个读路径的条目字段不会各说各话。
     */
    async search(keyword: string): Promise<readonly FileSearchResult[]> {
      if (!normalizeFileSearch(keyword)) return []
      const uidNames = await uidNameMap()
      const matched: Array<{ path: string; name: string }> = []
      await walkFileTree(deps, '/', {
        virtualDirs: 'prune',
        // 触顶即静默截断：报错替代截断会让 `/` 下搜常见词必然失败，搜索整体不可用，两害取其轻。
        onLimit: 'stop',
        extraPrune: (entryPath, entryName) =>
          SEARCH_PRUNE_DIR_NAMES.includes(entryName) || matchPathPrefix(entryPath, searchPrunePrefixes) !== null,
        onEntry: ({ path, name }) => {
          if (matchesFilePath(keyword, name, path)) matched.push({ path, name })
          return matched.length < SEARCH_MAX_RESULTS
        },
      })
      const results: FileSearchResult[] = []
      for (const entry of matched) {
        const stats = await statListedEntry(entry.path)
        if (stats === null) continue
        results.push({ ...entryOf(entry.name, stats, uidNames), path: entry.path })
      }
      return results
    },
  }
}
