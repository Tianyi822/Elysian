import type { TerminalIdentity, TerminalsHostDeps, TerminalsService } from '../terminals/terminalsService.ts'
import { createTerminalsService } from '../terminals/terminalsService.ts'
import { createTerminalWsEvents, type TerminalWsEvents } from '../terminals/terminalConnection.ts'
import {
  createExecPty,
  createLazyExecPty,
  probeShell,
  shellSpecFor,
  type ExecRunner,
} from './dockerExec.ts'

export const DOCKER_EXEC_MAX_SESSIONS = 5

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
    now,
  }
}

/**
 * 容器 exec 终端会话：与本机终端分开计数，上限 {@link DOCKER_EXEC_MAX_SESSIONS}。
 * 每个 WebSocket 连接在路由层绑定 containerId 后，用 {@link createWsEvents} 生成升级处理器。
 */
export function createDockerExecSessions(options: DockerExecSessionsOptions): DockerExecSessions {
  const services = new Map<string, TerminalsService>()

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
      let total = 0
      for (const service of services.values()) {
        total += service.activeCount()
      }
      return total
    },
  }
}
