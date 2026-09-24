import { InvalidRequestError } from '../shared/errors.ts'
import type { DockerTransport } from './dockerTransport.ts'
import { isSelfContainerInspect } from './selfContainer.ts'

const API_PREFIX = '/v1.41'
const INSPECT_TIMEOUT_MS = 10_000
const CONTAINER_NOT_FOUND_MESSAGE = '容器不存在'
const ACTION_SELF_MESSAGE = '不能对面板所在的容器执行该操作'
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

/** 容器终端升级前五项检查中的业务校验（同源与整片 503 由路由前置处理）。 */
export async function assertContainerTerminalAllowed(
  transport: DockerTransport,
  id: string,
  selfContainerId: string | null | undefined,
): Promise<void> {
  const inspect = await inspectContainer(transport, id)
  // 自我保护以 inspect 解析出的完整 Id 为准：容器名、前缀等寻址形态解析后都归一到
  // 同一 Id，按名寻址不再绕过守卫。
  if (isSelfContainerInspect(inspect, selfContainerId)) {
    throw new InvalidRequestError(400, ACTION_SELF_MESSAGE)
  }
  const status = containerRunningStatus(inspect)
  if (status !== 'running') {
    throw new InvalidRequestError(409, TERMINAL_NOT_RUNNING_MESSAGE)
  }
}
