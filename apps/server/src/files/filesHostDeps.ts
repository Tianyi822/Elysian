import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { resolveAvailability } from '../shared/availability.ts'
import { chownNoFollow, chmodNoFollow } from '../shared/noFollowFs.ts'
import { runGetentViaExecFile } from '../users/usersHostDeps.ts'
import type { FilesAppDeps } from './filesRoutes.ts'
import { createFilesService, type FilesHostDeps } from './filesService'

const execFileAsync = promisify(execFile)

/*
 * 真实文件管理的 Node 侧接线（cp/mv/tar + fs 原语 + getent）。
 * 硬边界：只有 ELYSIAN_DOCKER=1 且当前进程真的运行在容器内（/.dockerenv 存在）才可用；
 * 否则产出的装配 available=false，路由整片 503，绝不落到宿主机执行——宿主机上绝不
 * 执行 cp/mv/tar/chmod/chown，也绝不 readdir 宿主文件系统。判定逻辑归一在
 * shared/availability 的 resolveAvailability 里（安全四片同一判据），测试据此锚定
 * 硬边界，不依赖宿主机状态。
 */

/** 容器硬边界的判定：环境变量声明 Docker 编排，且 /.dockerenv 证明进程真的在容器内（shared/availability 的 re-export，签名与语义不变）。 */
export { resolveAvailability as resolveFilesAvailability } from '../shared/availability.ts'

export type FilesHostDepsOptions = {
  /** 注入环境变量：缺省用 process.env。 */
  env?: NodeJS.ProcessEnv
  /** 注入 /.dockerenv 探测结果：缺省真实探测宿主机文件系统（只读探测）。 */
  dockerenvExists?: boolean
  /** 注入服务依赖：可用分支的测试用 fake 驱动，不在宿主机执行任何命令。 */
  deps?: FilesHostDeps
}

/** 子进程失败 → 中文错误：优先带 stderr 详情，没有时回退错误消息本身；命令上下文由服务层拼装。 */
function commandFailure(error: unknown): Error {
  const detail =
    error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '').trim()
      : ''
  return new Error(detail || (error instanceof Error ? error.message : String(error)))
}

function execToStdout(file: string, args: readonly string[]): Promise<string> {
  return execFileAsync(file, [...args]).then(
    ({ stdout }) => stdout,
    (error: unknown) => {
      throw commandFailure(error)
    },
  )
}

function createHostDeps(): FilesHostDeps {
  return {
    // withFileTypes：直接子项的名字与种类一次拿到，条目视图仍逐项 stat/lstat 组装。
    readdir: (path) => readdir(path, { withFileTypes: true }),
    lstat: (path) => lstat(path),
    stat: (path) => stat(path),
    realpath: (path) => realpath(path),
    renamePath: (from, to) => rename(from, to),
    // 暂存目录：非递归 mkdir 对已存在的名字（含符号链接）抛 EEXIST，抢占是原子的。
    mkdir: (path, mode) => mkdir(path, { mode }),
    // 清理：recursive + force 幂等；node 的 rm 对符号链接只摘链接本身（不跟随）。
    rmPath: (path) => rm(path, { recursive: true, force: true }),
    runCp: (args) => execToStdout('cp', args),
    runMv: (args) => execToStdout('mv', args),
    runTar: (args) => execToStdout('tar', args),
    runGetent: (args) => runGetentViaExecFile(execFileAsync, args),
    chmodNoFollow,
    chownNoFollow,
    homeDir: () => homedir(),
  }
}

/** 文件管理路由的装配入参（形状定义在 filesRoutes，接线层产出同形对象）。 */
export type { FilesAppDeps } from './filesRoutes.ts'

/** 文件管理片的真实装配：探测容器边界并产出 { available, service } 交给路由工厂挂载。 */
export function createFilesHostDeps(options: FilesHostDepsOptions = {}): FilesAppDeps {
  const available = resolveAvailability(
    options.env ?? process.env,
    options.dockerenvExists ?? existsSync('/.dockerenv'),
  )
  if (!available) {
    return { available: false }
  }

  // 注入了 deps 即测试路径：不在宿主机执行任何命令。
  return { available: true, service: createFilesService(options.deps ?? createHostDeps()) }
}
