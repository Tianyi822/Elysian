import { InvalidRequestError } from '../shared/errors.ts'
import type { DockerTransport } from './dockerTransport.ts'

const API_PREFIX = '/v1.41'
const INSPECT_TIMEOUT_MS = 10_000
const CONTAINER_NOT_FOUND_MESSAGE = '容器不存在'
export const TERMINAL_NOT_RUNNING_MESSAGE = '只有运行中的容器可以打开终端'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function encodeEngineId(id: string): string {
  return encodeURIComponent(id)
}

function containerRunningStatus(inspect: unknown): string | null {
  if (!isRecord(inspect)) return null
  const state = inspect.State
  if (!isRecord(state) || typeof state.Status !== 'string') return null
  return state.Status
}

async function inspectContainer(transport: DockerTransport, id: string): Promise<unknown> {
  const response = await transport.request({
    method: 'GET',
    path: `${API_PREFIX}/containers/${encodeEngineId(id)}/json`,
    timeoutMs: INSPECT_TIMEOUT_MS,
    maxBytes: 32 * 1024 * 1024,
  })
  if (response.status === 404) {
    throw new InvalidRequestError(404, CONTAINER_NOT_FOUND_MESSAGE)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`获取容器详情失败（HTTP ${response.status}）`)
  }
  return response.json
}

/** 容器终端升级前的业务校验：包括面板自身在内，运行中的容器均可连接。 */
export async function assertContainerTerminalAllowed(
  transport: DockerTransport,
  id: string,
): Promise<void> {
  const inspect = await inspectContainer(transport, id)
  const status = containerRunningStatus(inspect)
  if (status !== 'running') {
    throw new InvalidRequestError(409, TERMINAL_NOT_RUNNING_MESSAGE)
  }
}
