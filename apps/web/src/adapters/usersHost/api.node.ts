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

function execToStdout(file: string, args: readonly string[]): Promise<string> {
  return execFileAsync(file, [...args]).then(
    ({ stdout }) => stdout,
    (error: unknown) => {
      const detail =
        error && typeof error === 'object' && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '').trim()
          : ''
      throw new Error(detail || (error instanceof Error ? error.message : String(error)))
    },
  )
}

/** chpasswd 凭据只走 stdin：spawn 后把 `账号:密码` 写进标准输入，密码不进命令行。 */
function runChpasswdViaStdin(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('chpasswd', [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.on('data', () => undefined)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve('')
      else reject(new Error(stderr.trim() || `chpasswd 退出码 ${code ?? 'unknown'}`))
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

function createHostDeps(): UsersHostDeps {
  return {
    runGetent: (args) => execToStdout('getent', args),
    runUseradd: (args) => execToStdout('useradd', args),
    runUsermod: (args) => execToStdout('usermod', args),
    runUserdel: (args) => execToStdout('userdel', args),
    runGpasswd: (args) => execToStdout('gpasswd', args),
    runChpasswd: runChpasswdViaStdin,
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
