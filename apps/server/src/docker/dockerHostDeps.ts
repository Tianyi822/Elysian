import { lookup } from 'node:dns/promises'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { hostname } from 'node:os'
import { PANEL_PORT } from '@elysian/contracts'
import { resolveAvailability } from '../shared/availability.ts'
import { SERVER_PORT } from '../shared/ports.ts'
import { assertEngineApi, createDockerTransport, type DockerTransport } from './dockerTransport.ts'
import { createDockerEventsHub } from './dockerEventsHub.ts'
import { createDockerReadService } from './dockerService.ts'
import { resolveSelfContainerId } from './selfContainer.ts'
import { createDockerExecSessions } from './dockerExecSessions.ts'
import { createContainerExecRunner } from './dockerExecRunner.ts'
import type { DockerAppDeps } from './dockerRoutes.ts'

/*
 * 容器管理真实接线：容器硬边界与 Engine API 版本探测，再构造只读 service。
 * 不可用时在 assertEngineApi 之前返回，测试注入 env/dockerenvExists 时不碰真实 socket。
 */

export type DockerHostDepsOptions = {
  env?: NodeJS.ProcessEnv
  dockerenvExists?: boolean
  transport?: DockerTransport
  readCgroup?: () => string
  /** 测试注入：默认读 os.hostname()，供 hostname 通道识别面板自身容器。 */
  readHostname?: () => string
}

export type { DockerAppDeps } from './dockerRoutes.ts'

function createRegistryResolver() {
  return async (hostname: string) => {
    const results = await lookup(hostname, { all: true, verbatim: true })
    return results.map((entry) => entry.address)
  }
}

function resolveMountRoot(env: NodeJS.ProcessEnv): string {
  const value = env.ELYSIAN_DOCKER_MOUNT_ROOT
  return typeof value === 'string' && value.length > 0 ? value : '/srv'
}

function resolveSocketPath(env: NodeJS.ProcessEnv): string {
  const value = env.ELYSIAN_DOCKER_SOCKET
  return typeof value === 'string' && value.length > 0 ? value : '/var/run/docker.sock'
}

const RESERVED_PORTS: readonly number[] = [22, PANEL_PORT, SERVER_PORT]

function readCgroupText(): string {
  try {
    const boot = readFileSync('/proc/1/cgroup', 'utf8')
    const self = readFileSync('/proc/self/cgroup', 'utf8')
    return `${boot}\n${self}`
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function listContainerIds(transport: DockerTransport): Promise<string[]> {
  try {
    const response = await transport.request({
      method: 'GET',
      path: '/v1.41/containers/json?all=1',
      timeoutMs: 10_000,
      maxBytes: 32 * 1024 * 1024,
    })
    if (response.status < 200 || response.status >= 300 || !Array.isArray(response.json)) {
      return []
    }
    const ids: string[] = []
    for (const entry of response.json) {
      if (isRecord(entry) && typeof entry.Id === 'string' && entry.Id.length > 0) {
        ids.push(entry.Id)
      }
    }
    return ids
  } catch {
    return []
  }
}

/** 容器管理片的真实装配：探测边界、socket 与 API 版本，产出路由工厂入参。 */
export async function createDockerHostDeps(options: DockerHostDepsOptions = {}): Promise<DockerAppDeps> {
  const env = options.env ?? process.env
  const available = resolveAvailability(env, options.dockerenvExists ?? existsSync('/.dockerenv'))
  if (!available) {
    return { available: false, socketReady: false }
  }

  const transport =
    options.transport ?? createDockerTransport({ socketPath: resolveSocketPath(env) })
  const mountRoot = resolveMountRoot(env)

  try {
    await assertEngineApi(transport)
  } catch (error) {
    return {
      available: true,
      socketReady: false,
      socketUnavailableReason:
        error instanceof Error && error.message.length > 0
          ? error.message
          : 'Docker socket 连接失败',
    }
  }

  const readCgroup = options.readCgroup ?? readCgroupText
  const readHostname = options.readHostname ?? (() => hostname())
  const cgroupText = readCgroup()
  const containerIds = await listContainerIds(transport)
  const selfContainerId = resolveSelfContainerId(cgroupText, containerIds, readHostname())

  const eventsHub = createDockerEventsHub({
    transport,
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
  })

  const service = createDockerReadService(transport, {
    mountRoot,
    reservedPorts: RESERVED_PORTS,
    selfContainerId,
    onRestarting: (containerId) => {
      eventsHub.notifyRestarting(containerId)
    },
    mkdir: async (path, mode) => {
      await mkdir(path, { mode })
    },
    realpath: (path) => realpath(path),
    resolveRegistry: createRegistryResolver(),
  })

  const socketPath = resolveSocketPath(env)
  const dockerExecSessions = createDockerExecSessions({
    createExecRunner: (containerId) => createContainerExecRunner(socketPath, containerId),
    identityForContainer: (containerId) => ({
      user: 'root',
      hostLabel: containerId.slice(0, 13),
      homeDir: '/',
    }),
    listDir: async () => [],
    listCommands: async () => [],
  })

  return {
    available: true,
    socketReady: true,
    service,
    eventsHub,
    transport,
    selfContainerId,
    dockerExecSessions,
  }
}
