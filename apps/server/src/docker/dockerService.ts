import type { Container, ContainerImage } from '@elysian/contracts'
import { InvalidRequestError } from '../shared/errors.ts'
import type { DockerTransport } from './dockerTransport.ts'
import { mapContainer, mapImage } from './dockerMappers.ts'

const API_PREFIX = '/v1.41'
const LIST_MAX = 500
const INSPECT_CONCURRENCY = 8
const LIST_TIMEOUT_MS = 10_000
const JSON_MAX_BYTES = 32 * 1024 * 1024
const LIST_TIMEOUT_MESSAGE = 'Docker 列表请求超时'
const ACTION_TIMEOUT_MS = 30_000
const ACTION_BUSY_MESSAGE = '该容器正在执行其他操作'
const ACTION_PAUSED_MESSAGE = '容器已暂停，面板暂不支持恢复'
const ACTION_SELF_MESSAGE = '不能对面板所在的容器执行该操作'
const CONTAINER_NOT_FOUND_MESSAGE = '容器不存在'

export type DockerReadService = {
  listContainers(): Promise<readonly Container[]>
  listImages(): Promise<readonly ContainerImage[]>
  policy(): Promise<{ mountRoot: string; reservedPorts: readonly number[] }>
  action(id: string, action: 'start' | 'stop' | 'restart'): Promise<Container>
}

export type DockerServiceOptions = {
  mountRoot: string
  reservedPorts: readonly number[]
  selfContainerId?: string | null
  onRestarting?: (containerId: string) => void | Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireId(summary: unknown, label: string): string {
  if (!isRecord(summary) || typeof summary.Id !== 'string' || summary.Id.length === 0) {
    throw new Error(`${label}摘要缺少 Id`)
  }
  return summary.Id
}

function assertListLimit(count: number, label: string): void {
  if (count > LIST_MAX) {
    throw new Error(`${label}数量超过上限 ${LIST_MAX}`)
  }
}

function encodeEngineId(id: string): string {
  return encodeURIComponent(id)
}

type ListDeadline = {
  remainingMs(): number
  race<T>(promise: Promise<T>): Promise<T>
}

function createListDeadline(timeoutMs: number): ListDeadline {
  const deadlineAt = Date.now() + timeoutMs
  return {
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    race<T>(promise: Promise<T>): Promise<T> {
      const left = deadlineAt - Date.now()
      if (left <= 0) {
        return Promise.reject(new Error(LIST_TIMEOUT_MESSAGE))
      }
      return new Promise<T>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error(LIST_TIMEOUT_MESSAGE))
        }, left)
        promise.then(
          (value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(value)
          },
          (error: unknown) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    },
  }
}

function isPausedInspect(inspect: unknown): boolean {
  if (!isRecord(inspect)) {
    return false
  }
  const state = inspect.State
  if (!isRecord(state) || typeof state.Status !== 'string') {
    return false
  }
  return state.Status === 'paused'
}

function isSelfContainerTarget(id: string, selfContainerId: string | null | undefined): boolean {
  if (selfContainerId === null || selfContainerId === undefined || selfContainerId.length === 0) {
    return false
  }
  if (id === selfContainerId) {
    return true
  }
  return selfContainerId.startsWith(id)
}

async function dockerRequest(
  transport: DockerTransport,
  input: { method: string; path: string; timeoutMs: number },
): Promise<{ status: number; json: unknown }> {
  return transport.request({
    method: input.method,
    path: input.path,
    timeoutMs: input.timeoutMs,
    maxBytes: JSON_MAX_BYTES,
  })
}

async function inspectContainer(
  transport: DockerTransport,
  id: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await dockerRequest(transport, {
    method: 'GET',
    path: `${API_PREFIX}/containers/${encodeEngineId(id)}/json`,
    timeoutMs,
  })
  if (response.status === 404) {
    throw new InvalidRequestError(404, CONTAINER_NOT_FOUND_MESSAGE)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`获取容器详情失败（HTTP ${response.status}）`)
  }
  return response.json
}

async function dockerGet(
  transport: DockerTransport,
  path: string,
  deadline: ListDeadline,
): Promise<{ status: number; json: unknown }> {
  const timeoutMs = deadline.remainingMs()
  if (timeoutMs <= 0) {
    throw new Error(LIST_TIMEOUT_MESSAGE)
  }
  return transport.request({
    method: 'GET',
    path,
    timeoutMs,
    maxBytes: JSON_MAX_BYTES,
  })
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return []
  }

  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) {
        return
      }
      results[index] = await fn(items[index]!, index)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

async function listWithInspect<TSummary, TResult>(
  transport: DockerTransport,
  listPath: string,
  inspectPath: (id: string) => string,
  label: string,
  mapItem: (summary: TSummary, inspect: unknown) => TResult,
): Promise<readonly TResult[]> {
  const deadline = createListDeadline(LIST_TIMEOUT_MS)

  return deadline.race((async () => {
    const listResponse = await dockerGet(transport, listPath, deadline)
    if (listResponse.status < 200 || listResponse.status >= 300) {
      throw new Error(`获取${label}列表失败（HTTP ${listResponse.status}）`)
    }
    if (!Array.isArray(listResponse.json)) {
      throw new Error(`${label}列表格式无效`)
    }
    const summaries = listResponse.json as TSummary[]
    assertListLimit(summaries.length, label)

    return mapWithConcurrency(summaries, INSPECT_CONCURRENCY, async (summary) => {
      const id = requireId(summary, label)
      const inspectResponse = await dockerGet(transport, inspectPath(id), deadline)
      if (inspectResponse.status < 200 || inspectResponse.status >= 300) {
        throw new Error(`获取${label}详情失败（HTTP ${inspectResponse.status}）`)
      }
      return mapItem(summary, inspectResponse.json)
    })
  })())
}

const actionLocks = new Map<string, Promise<void>>()

export function createDockerReadService(
  transport: DockerTransport,
  options: DockerServiceOptions,
): DockerReadService {
  const selfContainerId = options.selfContainerId ?? null

  async function runAction(id: string, action: 'start' | 'stop' | 'restart'): Promise<Container> {
    if (actionLocks.has(id)) {
      throw new InvalidRequestError(409, ACTION_BUSY_MESSAGE)
    }

    let releaseLock!: () => void
    const lock = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    actionLocks.set(id, lock)

    try {
      if (
        (action === 'stop' || action === 'restart') &&
        isSelfContainerTarget(id, selfContainerId)
      ) {
        throw new InvalidRequestError(400, ACTION_SELF_MESSAGE)
      }

      const preInspect = await inspectContainer(transport, id, ACTION_TIMEOUT_MS)
      if (isPausedInspect(preInspect)) {
        throw new InvalidRequestError(409, ACTION_PAUSED_MESSAGE)
      }

      if (action === 'restart') {
        await options.onRestarting?.(id)
      }

      const actionPath =
        action === 'stop'
          ? `${API_PREFIX}/containers/${encodeEngineId(id)}/stop?t=10`
          : `${API_PREFIX}/containers/${encodeEngineId(id)}/${action}`
      const actionResponse = await dockerRequest(transport, {
        method: 'POST',
        path: actionPath,
        timeoutMs: ACTION_TIMEOUT_MS,
      })
      if (actionResponse.status === 404) {
        throw new InvalidRequestError(404, CONTAINER_NOT_FOUND_MESSAGE)
      }
      if (
        actionResponse.status !== 200 &&
        actionResponse.status !== 204 &&
        actionResponse.status !== 304
      ) {
        throw new Error(`容器${action}失败（HTTP ${actionResponse.status}）`)
      }

      const postInspect = await inspectContainer(transport, id, ACTION_TIMEOUT_MS)
      return mapContainer(postInspect)
    } finally {
      actionLocks.delete(id)
      releaseLock()
    }
  }

  return {
    async listContainers() {
      return listWithInspect(
        transport,
        `${API_PREFIX}/containers/json?all=1`,
        (id) => `${API_PREFIX}/containers/${encodeEngineId(id)}/json`,
        '容器',
        (_summary, inspect) => mapContainer(inspect),
      )
    },
    async listImages() {
      return listWithInspect(
        transport,
        `${API_PREFIX}/images/json`,
        (id) => `${API_PREFIX}/images/${encodeEngineId(id)}/json`,
        '镜像',
        (summary, inspect) => mapImage(summary, inspect),
      )
    },
    async policy() {
      return { mountRoot: options.mountRoot, reservedPorts: options.reservedPorts }
    },
    action(id, action) {
      return runAction(id, action)
    },
  }
}
