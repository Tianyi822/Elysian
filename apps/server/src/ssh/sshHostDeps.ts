import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, readdir, writeFile, rename, chmod, chown, mkdir, open, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { ServerResponse } from 'node:http'
import type { Connect } from 'vite'
import { isDockerEnv } from '../hostMetrics/isDockerEnv.ts'
import { DEFAULT_SSH_PATHS, createSshService, type SshHostDeps } from './sshService'
import { createSshApiHandler } from './api'

const execFileAsync = promisify(execFile)

/*
 * 真实 SSH 管理中间件的 Node 侧接线。硬边界：只有 ELSYIAN_DOCKER=1 且当前进程
 * 真的运行在容器内（/.dockerenv 存在）才可用；否则一律 503，绝不落到宿主机执行。
 * 判定逻辑收在 resolveSshAvailability 纯函数里，测试据此锚定硬边界，不依赖宿主机状态。
 */

/** 容器硬边界的判定：环境变量声明 Docker 编排，且 /.dockerenv 证明进程真的在容器内。 */
export function resolveSshAvailability(env: NodeJS.ProcessEnv, dockerenvExists: boolean): boolean {
  return isDockerEnv(env) && dockerenvExists
}

export type SecuritySshMiddlewareOptions = {
  /** 注入环境变量：缺省用 process.env。 */
  env?: NodeJS.ProcessEnv
  /** 注入 /.dockerenv 探测结果：缺省真实探测宿主机文件系统（只读探测）。 */
  dockerenvExists?: boolean
  /** 注入服务依赖：可用分支的测试用 fake 驱动，不在宿主机执行任何命令。 */
  deps?: SshHostDeps
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

/** pidfile 与进程身份核实的注入面：测试用内存实现驱动，不在宿主机读真实路径。 */
export type SshdPidProbe = {
  /** pidfile 全文；读不到（未在跑）返回 null。 */
  readPidFile(): Promise<string | null>
  /** /proc/<pid>/comm 的内容；读不到返回 null。 */
  readProcComm(pid: number): Promise<string | null>
}

/**
 * 解析并核实 sshd 主进程 pid：pidfile 读不出、pid 非法，或 /proc/<pid>/comm 不是
 * sshd（进程已退出、pid 被无关进程复用）都返回 null——信号只发给核实过身份的
 * sshd，杜绝按陈旧 pidfile 误杀无关进程。
 */
export async function resolveVerifiedSshdPid(probe: SshdPidProbe): Promise<number | null> {
  const text = await probe.readPidFile()
  if (text === null) return null
  const pid = Number.parseInt(text.trim(), 10)
  if (!Number.isInteger(pid)) return null
  const comm = await probe.readProcComm(pid)
  return comm !== null && comm.trim() === 'sshd' ? pid : null
}

/** 容器内真实探针：pidfile 与 /proc/<pid>/comm 都按只读探测，读不到返回 null。 */
function createPidProbe(): SshdPidProbe {
  return {
    readPidFile: () => readFile(DEFAULT_SSH_PATHS.sshdPidFile, 'utf8').catch(() => null),
    readProcComm: (pid) => readFile(`/proc/${pid}/comm`, 'utf8').catch(() => null),
  }
}

/**
 * 只读文件末段（最多 maxBytes 字节）：登录日志按尾读取，大文件不整读进堆。
 * 从文件中部起读（发生截断）时丢弃不完整的首行——截断可能恰好落在一条完整
 * 消息的中间，不丢会凭空多出一条无时间戳的记录。独立导出以便对真实文件语义做测试。
 */
export async function readTextTailFromFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline < 0 ? '' : text.slice(firstNewline + 1)
    }
    return text
  } finally {
    await handle.close()
  }
}

/** 向核实过身份的 sshd 主进程发信号；pid 不在时静默返回（调用方决定这是幂等还是无需重载）。 */
function signalSshd(pid: number, signal: 'SIGTERM' | 'SIGHUP'): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`向 sshd（pid ${pid}）发送 ${signal} 失败：${detail}`)
  }
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

function createHostDeps(): SshHostDeps {
  return {
    runSshKeygen: (args) => execToStdout('ssh-keygen', args),
    runSshd: (args) => execToStdout('/usr/sbin/sshd', args),
    async startSshd() {
      // 带 -E 启动：sshd 自行 daemonize 并写 pidfile，日志持续落到面板读取的文件。
      await execToStdout('/usr/sbin/sshd', ['-E', DEFAULT_SSH_PATHS.sshdLog])
    },
    async stopSshd() {
      // pid 复用防线：TERM 只发给核实过身份（/proc/<pid>/comm 为 sshd）的进程；
      // pidfile 陈旧或 pid 被复用时按未在跑处理，幂等成功。
      const pid = await resolveVerifiedSshdPid(createPidProbe())
      if (pid === null) return
      signalSshd(pid, 'SIGTERM')
    },
    async reloadSshd() {
      // SIGHUP 同样只发核实过身份的进程；pid 不在时静默返回（无需重载）。
      const pid = await resolveVerifiedSshdPid(createPidProbe())
      if (pid === null) return
      // SIGHUP：sshd 重读配置并 re-exec 自身，-E 等启动参数原样保留。
      signalSshd(pid, 'SIGHUP')
    },
    runChpasswd: runChpasswdViaStdin,
    runGetent: (args) => execToStdout('getent', args),
    delay: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
    readText: (path) => readFile(path, 'utf8'),
    readTextTail: readTextTailFromFile,
    // 目录不存在（未建 sshd_config.d）时按空处理：Include 通配展开据此得到零个文件。
    readDir: (path) => readdir(path).catch(() => []),
    writeText: (path, content) => writeFile(path, content, 'utf8'),
    async exists(path) {
      return existsSync(path)
    },
    rename: (from, to) => rename(from, to),
    chmod: (path, mode) => chmod(path, mode),
    chown: (path, uid, gid) => chown(path, uid, gid),
    // fs 的 mkdir 会返回创建的首个目录路径，这里只关心完成与否。
    async mkdir(path) {
      await mkdir(path, { recursive: true })
    },
    remove: (path) => rm(path, { force: true }),
    nowIso: () => new Date().toISOString(),
    paths: DEFAULT_SSH_PATHS,
  }
}

/** 真实依赖 + 启动即建密钥工作目录：请求路径上少一次可失败的副作用。 */
function createRealDepsWithWorkspace(): SshHostDeps {
  const deps = createHostDeps()
  try {
    mkdirSync(DEFAULT_SSH_PATHS.keygenWorkspace, { recursive: true })
  } catch (error) {
    console.error('[elysian] SSH 密钥工作目录创建失败：', error instanceof Error ? error.message : error)
  }
  return deps
}

/** 挂载到 /api/security/ssh 的 connect 中间件。 */
export function createSecuritySshMiddleware(
  options: SecuritySshMiddlewareOptions = {},
): Connect.NextHandleFunction {
  const available = resolveSshAvailability(
    options.env ?? process.env,
    options.dockerenvExists ?? existsSync('/.dockerenv'),
  )
  if (!available) {
    return createSshApiHandler({ available: false })
  }

  // 注入了 deps 即测试路径：不建真实工作目录、不触达宿主机文件系统。
  const service = createSshService(options.deps ?? createRealDepsWithWorkspace())
  const handler = createSshApiHandler({ available: true, service })
  return (req, res: ServerResponse) => handler(req, res)
}
