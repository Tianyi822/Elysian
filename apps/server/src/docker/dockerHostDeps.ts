import { existsSync } from 'node:fs'
import { PANEL_PORT } from '@elysian/contracts'
import { resolveAvailability } from '../shared/availability.ts'
import { SERVER_PORT } from '../shared/ports.ts'
import { assertEngineApi, createDockerTransport, type DockerTransport } from './dockerTransport.ts'
import { createDockerReadService } from './dockerService.ts'
import type { DockerAppDeps } from './dockerRoutes.ts'

/*
 * 容器管理真实接线：容器硬边界与 Engine API 版本探测，再构造只读 service。
 * 不可用时在 assertEngineApi 之前返回，测试注入 env/dockerenvExists 时不碰真实 socket。
 */

export type DockerHostDepsOptions = {
  env?: NodeJS.ProcessEnv
  dockerenvExists?: boolean
  transport?: DockerTransport
}

export type { DockerAppDeps } from './dockerRoutes.ts'

function resolveMountRoot(env: NodeJS.ProcessEnv): string {
  const value = env.ELYSIAN_DOCKER_MOUNT_ROOT
  return typeof value === 'string' && value.length > 0 ? value : '/srv'
}

function resolveSocketPath(env: NodeJS.ProcessEnv): string {
  const value = env.ELYSIAN_DOCKER_SOCKET
  return typeof value === 'string' && value.length > 0 ? value : '/var/run/docker.sock'
}

const RESERVED_PORTS: readonly number[] = [22, PANEL_PORT, SERVER_PORT]

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
  } catch {
    return { available: true, socketReady: false }
  }

  const service = createDockerReadService(transport, {
    mountRoot,
    reservedPorts: RESERVED_PORTS,
  })
  return { available: true, socketReady: true, service }
}
