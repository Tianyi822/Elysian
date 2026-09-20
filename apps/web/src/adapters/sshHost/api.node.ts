import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile, rename, chmod, mkdir, rm } from 'node:fs/promises'
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
 */

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

function createHostDeps(): SshHostDeps {
  return {
    runSshKeygen: (args) => execToStdout('ssh-keygen', args),
    runSshd: (args) => execToStdout('/usr/sbin/sshd', args),
    runService: (action) => execToStdout('service', ['ssh', action]),
    runChpasswd: runChpasswdViaStdin,
    runGetent: (args) => execToStdout('getent', args),
    readText: (path) => readFile(path, 'utf8'),
    writeText: (path, content) => writeFile(path, content, 'utf8'),
    async exists(path) {
      return existsSync(path)
    },
    rename: (from, to) => rename(from, to),
    chmod: (path, mode) => chmod(path, mode),
    // fs 的 mkdir 会返回创建的首个目录路径，这里只关心完成与否。
    async mkdir(path) {
      await mkdir(path, { recursive: true })
    },
    remove: (path) => rm(path, { force: true }),
    nowIso: () => new Date().toISOString(),
    paths: DEFAULT_SSH_PATHS,
  }
}

/** 挂载到 /api/security/ssh 的 connect 中间件。 */
export function createSecuritySshMiddleware(): Connect.NextHandleFunction {
  const available = isDockerEnv() && existsSync('/.dockerenv')
  if (!available) {
    return createSshApiHandler({ available: false })
  }

  const service = createSshService(createHostDeps())
  // 密钥生成的工作目录启动即建好：请求路径上少一次可失败的副作用。
  try {
    mkdirSync(DEFAULT_SSH_PATHS.keygenWorkspace, { recursive: true })
  } catch (error) {
    console.error('[elysian] SSH 密钥工作目录创建失败：', error instanceof Error ? error.message : error)
  }

  const handler = createSshApiHandler({ available: true, service })
  return (req, res: ServerResponse) => handler(req, res)
}
