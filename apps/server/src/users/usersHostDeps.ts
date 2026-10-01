import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { promisify } from 'node:util'
import { resolveAvailability } from '../shared/availability.ts'
import type { UsersAppDeps } from './usersRoutes.ts'
import { createUsersService, type UsersHostDeps } from './usersService'
import { runChpasswdViaStdin, type ChpasswdChildLike } from '../shared/chpasswd.ts'

const execFileAsync = promisify(execFile)

/*
 * 真实用户管理的 Node 侧接线（getent/useradd/usermod/userdel/gpasswd/chpasswd）。
 * 硬边界：只有 ELYSIAN_DOCKER=1 且当前进程真的运行在容器内（/.dockerenv 存在）才可用；
 * 否则产出的装配 available=false，路由整片 503，绝不落到宿主机执行——宿主机上绝不执行
 * useradd/usermod/userdel/gpasswd/chpasswd 这类系统修改命令。判定逻辑归一在
 * shared/availability 的 resolveAvailability 里（安全三片同一判据），测试据此锚定硬边界，
 * 不依赖宿主机状态。
 */

/** 容器硬边界的判定：环境变量声明 Docker 编排，且 /.dockerenv 证明进程真的在容器内（shared/availability 的 re-export，签名与语义不变）。 */
export { resolveAvailability as resolveUsersAvailability } from '../shared/availability.ts'

export type UsersHostDepsOptions = {
  /** 注入环境变量：缺省用 process.env。 */
  env?: NodeJS.ProcessEnv
  /** 注入 /.dockerenv 探测结果：缺省真实探测宿主机文件系统（只读探测）。 */
  dockerenvExists?: boolean
  /** 注入服务依赖：可用分支的测试用 fake 驱动，不在宿主机执行任何命令。 */
  deps?: UsersHostDeps
}

/** execFile 的最小形状：runGetentViaExecFile 注入 fake exec 用，宿主机不执行任何命令。 */
export type ExecFileLike = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

/** chpasswd 管道读端的最小形状（re-export 供测试注入）。 */
export type { ChpasswdChildLike, SpawnChpasswdLike } from '../shared/chpasswd.ts'

/**
 * getent 的退出码语义适配：`getent passwd <不存在账号>` 以退出码 2 结束且无输出
 * （getent(1)：2 = 所查键在数据库中不存在）——这是「查无结果」的正常语义，
 * 归一为空输出让上层按「无此账号」处理；其余退出码（如 1 的库不存在）才是执行失败。
 * 服务层的查重、保护边界与删除回读都依赖这一点，缺了它创建链路恒失败。
 */
/** 子进程失败 → 中文错误：优先带 stderr 详情，没有时回退错误消息本身；命令上下文由服务层拼装。 */
function commandFailure(error: unknown): Error {
  const detail =
    error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '').trim()
      : ''
  return new Error(detail || (error instanceof Error ? error.message : String(error)))
}

export function runGetentViaExecFile(exec: ExecFileLike, args: readonly string[]): Promise<string> {
  return exec('getent', [...args]).then(
    ({ stdout }) => stdout,
    (error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 2) {
        return ''
      }
      throw commandFailure(error)
    },
  )
}

function execToStdout(file: string, args: readonly string[]): Promise<string> {
  return execFileAsync(file, [...args]).then(
    ({ stdout }) => stdout,
    (error: unknown) => {
      throw commandFailure(error)
    },
  )
}

/** 真实 spawn 接线：stdio 三路 pipe，供 runChpasswdViaStdin 在宿主路径使用。 */
function spawnChpasswdPipe(command: string, args: readonly string[]): ChpasswdChildLike {
  return spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
}

function createHostDeps(): UsersHostDeps {
  return {
    runGetent: (args) => runGetentViaExecFile(execFileAsync, args),
    runUseradd: (args) => execToStdout('useradd', args),
    runUsermod: (args) => execToStdout('usermod', args),
    runUserdel: (args) => execToStdout('userdel', args),
    runGpasswd: (args) => execToStdout('gpasswd', args),
    runChpasswd: (input) => runChpasswdViaStdin(spawnChpasswdPipe, input),
    readText: (path) => readFile(path, 'utf8'),
    async exists(path) {
      return existsSync(path)
    },
    remove: (path) => unlink(path),
    nowIso: () => new Date().toISOString(),
  }
}

/** 用户管理路由的装配入参（形状定义在 usersRoutes，接线层产出同形对象）。 */
export type { UsersAppDeps } from './usersRoutes.ts'

/** 用户管理片的真实装配：探测容器边界并产出 { available, service } 交给路由工厂挂载。 */
export function createUsersHostDeps(options: UsersHostDepsOptions = {}): UsersAppDeps {
  const available = resolveAvailability(
    options.env ?? process.env,
    options.dockerenvExists ?? existsSync('/.dockerenv'),
  )
  if (!available) {
    return { available: false }
  }

  // 注入了 deps 即测试路径：不在宿主机执行任何命令。
  return { available: true, service: createUsersService(options.deps ?? createHostDeps()) }
}
