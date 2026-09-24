import type { TerminalIdentity, TerminalsHostDeps, TerminalsService } from '../terminals/terminalsService.ts'
import { createTerminalsService } from '../terminals/terminalsService.ts'
import { createTerminalWsEvents, type TerminalWsEvents } from '../terminals/terminalConnection.ts'
import {
  cleanupScriptPid,
  createExecPty,
  createLazyExecPty,
  probeShell,
  readStdoutText,
  shellSpecFor,
  type ExecRunner,
} from './dockerExec.ts'

export const DOCKER_EXEC_MAX_SESSIONS = 5

/** 断开清理 exec 的等待上限：脚本自身约一秒（两轮信号间 sleep 1），引擎挂起时放弃并断开。 */
const DOCKER_EXEC_CLEANUP_TIMEOUT_MS = 10_000

/**
 * 按容器驻留的 service 在无活跃会话且无人再连接时的回收阈值：与终端会话空闲超时
 * 同一量级。事件 hub 与 SSE 各有上限，这张按容器驻留的 service 表以同一量级的空闲
 * 阈值回收；没有它，services Map 会随真机容器数量无界增长。
 */
export const DOCKER_EXEC_SERVICE_IDLE_MS = 30 * 60 * 1000

export type DockerExecSessionsOptions = {
  createExecRunner: (containerId: string) => ExecRunner
  identityForContainer: (containerId: string) => TerminalIdentity
  listDir: (containerId: string, path: string) => Promise<readonly string[]>
  listCommands: (containerId: string) => Promise<readonly string[]>
  now?: () => number
}

export type DockerExecSessions = {
  createWsEvents(containerId: string): TerminalWsEvents
  activeCount(): number
  /** 当前驻留 service 的容器数（含无活跃会话、尚未到回收阈值的）。 */
  managedCount(): number
}

function createHostDepsForContainer(
  containerId: string,
  options: DockerExecSessionsOptions,
): TerminalsHostDeps {
  const now = options.now ?? (() => Date.now())
  return {
    available: true,
    identity: () => options.identityForContainer(containerId),
    spawnPtyShell: () =>
      createLazyExecPty(async () => {
        const exec = options.createExecRunner(containerId)
        const kind = await probeShell(exec)
        if (kind === 'none') {
          throw new Error('该容器内没有可用的 shell')
        }
        const spec = shellSpecFor(kind, true)
        const interactive = options.createExecRunner(containerId)
        return createExecPty(interactive, spec)
      }),
    listDir: (path) => options.listDir(containerId, path),
    listCommands: () => options.listCommands(containerId),
    /** exec 出的 shell 不随 hijack 断开退出：按 READY 哨兵捕获的 pid 跑断开清理脚本。 */
    disposeShell: (shellPid) => {
      if (shellPid === null) return
      let cmd: readonly string[]
      try {
        cmd = cleanupScriptPid(shellPid)
      } catch {
        return
      }
      const session = options.createExecRunner(containerId).run(cmd, false)
      // 排空输出等脚本跑完（脚本自身无输出）；引擎挂起时到点放弃并断开 hijack。
      const drained = readStdoutText(session.stdout).then(
        () => undefined,
        () => undefined,
      )
      const deadline = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DOCKER_EXEC_CLEANUP_TIMEOUT_MS)
        timer.unref?.()
      })
      void Promise.race([drained, deadline]).then(() => session.close())
    },
    now,
  }
}

/**
 * 容器 exec 终端会话：与本机终端分开计数，上限 {@link DOCKER_EXEC_MAX_SESSIONS}。
 * 每个 WebSocket 连接在路由层绑定 containerId 后，用 {@link createWsEvents} 生成升级处理器。
 */
export function createDockerExecSessions(options: DockerExecSessionsOptions): DockerExecSessions {
  const services = new Map<string, TerminalsService>()
  const lastUsedAt = new Map<string, number>()
  const now = options.now ?? (() => Date.now())

  /** 惰性清扫：无活跃会话且距最后一次连接尝试超过阈值才回收，活跃中的容器绝不清。 */
  function sweep(nowMs: number): void {
    for (const [containerId, service] of services) {
      if (service.activeCount() > 0) continue
      const lastUsed = lastUsedAt.get(containerId)
      if (lastUsed === undefined) continue
      if (nowMs - lastUsed < DOCKER_EXEC_SERVICE_IDLE_MS) continue
      services.delete(containerId)
      lastUsedAt.delete(containerId)
    }
  }

  function serviceFor(containerId: string): TerminalsService {
    let service = services.get(containerId)
    if (!service) {
      service = createTerminalsService(createHostDepsForContainer(containerId, options))
      services.set(containerId, service)
    }
    return service
  }

  function totalActive(): number {
    let total = 0
    for (const svc of services.values()) {
      total += svc.activeCount()
    }
    return total
  }

  return {
    createWsEvents(containerId: string) {
      sweep(now())
      lastUsedAt.set(containerId, now())
      const service = serviceFor(containerId)
      const wrapped: TerminalsService = {
        tryOpen(events) {
          if (totalActive() >= DOCKER_EXEC_MAX_SESSIONS) {
            return null
          }
          return service.tryOpen(events)
        },
        activeCount: () => service.activeCount(),
      }
      return createTerminalWsEvents(wrapped)
    },
    activeCount() {
      sweep(now())
      let total = 0
      for (const service of services.values()) {
        total += service.activeCount()
      }
      return total
    },
    managedCount() {
      sweep(now())
      return services.size
    },
  }
}
