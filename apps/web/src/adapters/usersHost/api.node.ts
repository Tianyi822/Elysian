import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { ServerResponse } from 'node:http'
import type { Connect } from 'vite'
import { isDockerEnv } from '../hostMetrics/isDockerEnv.ts'
import { createUsersService, type UsersHostDeps } from './usersService'
import { createUsersApiHandler } from './api'

const execFileAsync = promisify(execFile)

/*
 * 真实用户管理中间件的 Node 侧接线。硬边界：只有 ELSYIAN_DOCKER=1 且当前进程
 * 真的运行在容器内（/.dockerenv 存在）才可用；否则一律 503，绝不落到宿主机执行——
 * 宿主机上绝不执行 useradd/usermod/userdel/gpasswd/chpasswd 这类系统修改命令。
 * 判定逻辑收在 resolveUsersAvailability 纯函数里，测试据此锚定硬边界，不依赖宿主机状态。
 */

/** 容器硬边界的判定：环境变量声明 Docker 编排，且 /.dockerenv 证明进程真的在容器内。 */
export function resolveUsersAvailability(env: NodeJS.ProcessEnv, dockerenvExists: boolean): boolean {
  return isDockerEnv(env) && dockerenvExists
}

export type SecurityUsersMiddlewareOptions = {
  /** 注入环境变量：缺省用 process.env。 */
  env?: NodeJS.ProcessEnv
  /** 注入 /.dockerenv 探测结果：缺省真实探测宿主机文件系统（只读探测）。 */
  dockerenvExists?: boolean
  /** 注入服务依赖：可用分支的测试用 fake 驱动，不在宿主机执行任何命令。 */
  deps?: UsersHostDeps
}

/** execFile 的最小形状：runGetentViaExecFile 注入 fake exec 用，宿主机不执行任何命令。 */
export type ExecFileLike = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

/** chpasswd 管道读端的最小形状：数据经 data 事件送达（真实流是 Readable，fake 是 EventEmitter）。 */
type ChpasswdPipeReader = {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
}

/** chpasswd 管道写端（stdin）的最小形状：可写可关，写失败（EPIPE 等）经 error 事件送达。 */
type ChpasswdStdinPipe = {
  on(event: 'error', listener: (error: Error) => void): unknown
  write(chunk: string): unknown
  end(): unknown
}

/**
 * chpasswd 子进程的最小形状：三路管道与 error/close 生命周期。stdio 全 pipe 时流端
 * 非空，类型上仍允许 null（对应 stdio 配成 inherit 等情形），建立失败走中文 reject。
 */
export type ChpasswdChildLike = {
  stdin: ChpasswdStdinPipe | null
  stdout: ChpasswdPipeReader | null
  stderr: ChpasswdPipeReader | null
  on(event: 'error' | 'close', listener: (arg: Error | number | null) => void): unknown
}

/** spawn 的最小形状：runChpasswdViaStdin 注入 fake spawn 用，测试不 spawn 任何真实进程。 */
export type SpawnChpasswdLike = (command: string, args: readonly string[]) => ChpasswdChildLike

/** 子进程失败 → 中文错误：优先带 stderr 详情，没有时回退错误消息本身；命令上下文由服务层拼装。 */
function commandFailure(error: unknown): Error {
  const detail =
    error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '').trim()
      : ''
  return new Error(detail || (error instanceof Error ? error.message : String(error)))
}

/**
 * getent 的退出码语义适配：`getent passwd <不存在账号>` 以退出码 2 结束且无输出
 * （getent(1)：2 = 所查键在数据库中不存在）——这是「查无结果」的正常语义，
 * 归一为空输出让上层按「无此账号」处理；其余退出码（如 1 的库不存在）才是执行失败。
 * 服务层的查重、保护边界与删除回读都依赖这一点，缺了它创建链路恒失败。
 */
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

/**
 * chpasswd 凭据只走 stdin：spawn 后把 `账号:密码` 写进标准输入，密码不进命令行。
 * stdin 挂 error 监听：chpasswd 在读 stdin 前退出时，后续写入以 EPIPE 报错——
 * 不接住这个流错误，它会成为未处理异常直接打崩 dev server。
 */
export function runChpasswdViaStdin(spawnChpasswd: SpawnChpasswdLike, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnChpasswd('chpasswd', [])
    let stderr = ''
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve('')
      else reject(new Error(stderr.trim() || `chpasswd 退出码 ${code ?? 'unknown'}`))
    })
    const { stdin, stdout, stderr: stderrPipe } = child
    if (stdin === null || stdout === null || stderrPipe === null) {
      reject(new Error('chpasswd 子进程的标准管道未建立'))
      return
    }
    stdout.on('data', () => undefined)
    stderrPipe.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    stdin.on('error', reject)
    stdin.write(input)
    stdin.end()
  })
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
    nowIso: () => new Date().toISOString(),
  }
}

/** 挂载到 /api/security/users 的 connect 中间件。 */
export function createSecurityUsersMiddleware(
  options: SecurityUsersMiddlewareOptions = {},
): Connect.NextHandleFunction {
  const available = resolveUsersAvailability(
    options.env ?? process.env,
    options.dockerenvExists ?? existsSync('/.dockerenv'),
  )
  if (!available) {
    return createUsersApiHandler({ available: false })
  }

  // 注入了 deps 即测试路径：不在宿主机执行任何命令。
  const service = createUsersService(options.deps ?? createHostDeps())
  const handler = createUsersApiHandler({ available: true, service })
  return (req, res: ServerResponse) => handler(req, res)
}
