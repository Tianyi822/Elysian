import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { promisify } from 'node:util'
import { resolveAvailability } from '../shared/availability.ts'
import type { TerminalsAppDeps } from './terminalsRoutes.ts'
import {
  createTerminalsService,
  HOST_SHELL_SESSION_SPEC,
  type PtyProcess,
  type TerminalsHostDeps,
} from './terminalsService.ts'

export type { PtyProcess } from './terminalsService.ts'

const execFileAsync = promisify(execFile)

/*
 * 终端片的真实接线（容器内）：Bun.spawn 以 script(util-linux) 管道驱动真实 bash、
 * env 白名单、SIGKILL 清理、readdir 文件表与 compgen 命令表（进程级缓存）。
 * 硬边界：只有 ELYSIAN_DOCKER=1 且当前进程真的运行在容器内（/.dockerenv 存在）才
 * 可用；否则产出的装配 available=false，路由整片 503，宿主机上绝不 spawn PTY。
 * Bun.spawn 只在容器分支动态 import（'bun' 模块不进 vitest 的 node 运行时模块图，
 * 与防火墙片动态加载 bun:sqlite 同一纪律）。
 */

/** 容器硬边界的判定（shared/availability 的 re-export，签名与语义不变）。 */
export { resolveAvailability as resolveTerminalsAvailability } from '../shared/availability.ts'

/** 终端路由装配入参的注入选项：环境变量与 /.dockerenv 探测可注入（锚定双闸门），deps 可注入 fake。 */
export type TerminalsHostDepsOptions = {
  env?: NodeJS.ProcessEnv
  dockerenvExists?: boolean
  deps?: TerminalsHostDeps
}

/** compgen 命令表的进程级缓存：成功缓存、失败降级空数组并允许下次重试。 */
let cachedCommands: Promise<readonly string[]> | null = null

function listCommandsCached(): Promise<readonly string[]> {
  cachedCommands ??= execFileAsync('bash', ['-c', 'compgen -A command | sort -u']).then(
    ({ stdout }) =>
      stdout
        .split('\n')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    () => {
      cachedCommands = null
      return []
    },
  )
  return cachedCommands
}

/** script 管道 → PtyProcess：stdin 原样写入（write + flush），SIGKILL 幂等并等待退出码。 */
function toPtyProcess(proc: import('bun').BunSpawnProcess): PtyProcess {
  let killSignalled = false
  return {
    write: (text) => {
      proc.stdin.write(text)
    },
    flush: () => {
      proc.stdin.flush()
    },
    stdout: proc.stdout,
    exited: proc.exited,
    kill: async () => {
      // script 持有 pty master：SIGKILL 令内核向 pty 会话发 SIGHUP，级联清理整棵
      // 进程树（实测零孤儿）；对已退出进程的重复 kill 忽略。
      if (!killSignalled) {
        killSignalled = true
        try {
          proc.kill(9)
        } catch {
          // 进程已退出：忽略。
        }
      }
      return proc.exited
    },
  }
}

/** 身份解析：os.userInfo() 为主；Bun 在无 passwd 查询结果时给占位 'unknown'，回退按 uid 推导（0 → root）。 */
function resolveIdentity(): { user: string; hostLabel: string; homeDir: string } {
  const info = userInfo()
  let user = info.username
  if (user === 'unknown' || user === '') {
    user = typeof process.getuid === 'function' && process.getuid() === 0 ? 'root' : String(info.uid)
  }
  return { user, hostLabel: hostname(), homeDir: homedir() }
}

function createRealHostDeps(spawn: typeof import('bun').spawn): TerminalsHostDeps {
  return {
    available: true,
    identity: () => resolveIdentity(),
    spawnPtyShell: (opts) =>
      toPtyProcess(
        spawn(['script', '-qfc', '/bin/bash --noediting', '/dev/null'], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          env: opts.env,
          cwd: opts.cwd,
        }),
      ),
    listDir: async (path) => {
      const names = await readdir(path)
      return [...names].sort()
    },
    listCommands: () => listCommandsCached(),
    now: () => Date.now(),
  }
}

/**
 * 终端片的真实装配：探测容器边界并产出 { available, service } 交给路由工厂挂载。
 * 异步工厂（Bun.spawn 经容器分支动态加载）；注入 deps 即测试路径，不 spawn 任何进程。
 */
export async function createTerminalsHostDeps(options: TerminalsHostDepsOptions = {}): Promise<TerminalsAppDeps> {
  const available = resolveAvailability(
    options.env ?? process.env,
    options.dockerenvExists ?? existsSync('/.dockerenv'),
  )
  if (!available) {
    return { available: false }
  }
  if (options.deps) {
    return { available: true, service: createTerminalsService(options.deps, HOST_SHELL_SESSION_SPEC) }
  }
  const { spawn } = await import('bun')
  return {
    available: true,
    service: createTerminalsService(createRealHostDeps(spawn), HOST_SHELL_SESSION_SPEC),
  }
}
