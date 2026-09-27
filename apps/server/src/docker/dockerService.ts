import type { Container, ContainerImage, ImagePullProgress } from '@elysian/contracts'
import { parseImageReference } from '@elysian/contracts'
import { InvalidRequestError, invalidRequest } from '../shared/errors.ts'
import type { DockerTransport } from './dockerTransport.ts'
import { buildCreateSpec } from './createSpec.ts'
import { mapContainer, mapImage } from './dockerMappers.ts'
import { createPullProgressDecoder, readPullProgress } from './dockerStreams.ts'
import { validateRegistry, validateRegistryTarget, type RegistryResolver } from './registryPolicy.ts'
import {
  IMAGE_SEARCH_LIMIT, listRegistryTags, requestDockerHubToken, requestRegistryCatalog,
  requestRegistryTags, searchCatalog, type CatalogFetcher, type TagsFetcher,
} from './dockerImageSearch.ts'
import { isSelfContainerInspect } from './selfContainer.ts'

const API_PREFIX = '/v1.41'
const LIST_MAX = 500
const INSPECT_CONCURRENCY = 8
const LIST_TIMEOUT_MS = 10_000
const JSON_MAX_BYTES = 32 * 1024 * 1024
const LIST_TIMEOUT_MESSAGE = 'Docker 列表请求超时'
const ACTION_TIMEOUT_MS = 30_000
const PULL_TIMEOUT_MS = 15 * 60 * 1000
const PULL_PROGRESS_MAX_BYTES = 64 * 1024 * 1024
const REGISTRY_RESOLVE_TIMEOUT_MS = 3_000
const ACTION_BUSY_MESSAGE = '该容器正在执行其他操作'
const PULL_BUSY_MESSAGE = '已有镜像正在拉取'
const PULL_AUTH_MESSAGE = '不支持私有仓库认证'
const REGISTRY_REFERENCE_CONFLICT_MESSAGE = '镜像源与引用中的仓库地址请只填一处'
const IMAGE_IN_USE_MESSAGE = '镜像仍被容器引用，删除失败'
const IMAGE_NOT_FOUND_MESSAGE = '镜像不存在，删除失败'
const ACTION_PAUSED_MESSAGE = '容器已暂停，面板暂不支持恢复'
const ACTION_SELF_MESSAGE = '不能对面板所在的容器执行该操作'
const CONTAINER_NOT_FOUND_MESSAGE = '容器不存在'
const CONTAINER_RUNNING_REMOVE_MESSAGE = '容器正在运行，请先停止再删除'

export type DockerReadService = {
  listContainers(): Promise<readonly Container[]>
  listImages(): Promise<readonly ContainerImage[]>
  searchImages(term: string, registry?: string): Promise<{ names: readonly string[]; searchable: boolean }>
  imageTags(name: string, registry?: string): Promise<{ tags: readonly string[]; searchable: boolean }>
  policy(): Promise<{ mountRoot: string; reservedPorts: readonly number[] }>
  action(id: string, action: 'start' | 'stop' | 'restart'): Promise<Container>
  create(body: unknown): Promise<Container>
  pull(body: unknown, signal: AbortSignal, onProgress?: (progress: ImagePullProgress) => void | Promise<void>): Promise<ContainerImage>
  removeContainer(id: string): Promise<void>
  removeImage(id: string): Promise<void>
}

export type DockerServiceOptions = {
  mountRoot: string
  reservedPorts: readonly number[]
  selfContainerId?: string | null
  onRestarting?: (containerId: string) => void | Promise<void>
  mkdir: (path: string, mode: number) => Promise<void>
  realpath: (path: string) => Promise<string>
  resolveRegistry?: RegistryResolver
  fetchCatalog?: CatalogFetcher
  fetchTags?: TagsFetcher
  fetchHubToken?: (repository: string) => Promise<string>
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

async function dockerRequest(
  transport: DockerTransport,
  input: { method: string; path: string; timeoutMs: number; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  return transport.request({
    method: input.method,
    path: input.path,
    body: input.body,
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

let createTail: Promise<unknown> = Promise.resolve()
let pullInFlight = false

/** 测试专用：清空创建串行队列，避免用例间泄漏未完成的 create。 */
export function resetDockerCreateQueue(): void {
  createTail = Promise.resolve()
}

/** 测试专用：复位拉取单飞锁。 */
export function resetDockerPullLock(): void {
  pullInFlight = false
}

function serializeCreate<T>(critical: () => Promise<T>): Promise<T> {
  const run = createTail.then(critical, critical)
  createTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function engineErrorMessage(json: unknown, fallback: string): string {
  if (isRecord(json) && typeof json.message === 'string' && json.message.length > 0) {
    return json.message
  }
  return fallback
}

function requireCreateId(json: unknown): string {
  if (!isRecord(json) || typeof json.Id !== 'string' || json.Id.length === 0) {
    throw new Error('创建容器响应缺少 Id')
  }
  return json.Id
}

function normalizeImageId(id: string): string {
  return id.startsWith('sha256:') ? id.slice('sha256:'.length) : id
}

function embeddedRegistryHost(imageName: string): string | null {
  const firstSegment = imageName.split('/')[0] ?? imageName
  if (
    firstSegment === 'localhost' ||
    firstSegment.includes('.') ||
    firstSegment.includes(':')
  ) {
    return firstSegment
  }
  return null
}

function buildRegistryFromImage(registryHost: string, name: string, tag: string): string {
  const imagePath = name.includes('/') ? name : `library/${name}`
  return `${registryHost}/${imagePath}:${tag}`
}

async function resolveWithTimeout(
  resolve: RegistryResolver,
  hostname: string,
  timeoutMs: number,
): Promise<readonly string[]> {
  return new Promise<readonly string[]>((resolveAddresses, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('镜像源无法解析为公网地址'))
    }, timeoutMs)
    resolve(hostname)
      .then((addresses) => {
        clearTimeout(timer)
        resolveAddresses(addresses)
      })
      .catch(() => {
        clearTimeout(timer)
        reject(new Error('镜像源无法解析为公网地址'))
      })
  })
}

function wrapRegistryResolver(resolve: RegistryResolver): RegistryResolver {
  return (hostname) => resolveWithTimeout(resolve, hostname, REGISTRY_RESOLVE_TIMEOUT_MS)
}

async function assertRegistryAllowed(raw: string, resolve: RegistryResolver): Promise<string> {
  try {
    return await validateRegistry(raw, wrapRegistryResolver(resolve))
  } catch (error) {
    if (error instanceof Error) {
      throw invalidRequest(error.message)
    }
    throw invalidRequest('镜像源主机名不合法')
  }
}

function parsePullBody(body: unknown): { name: string; tag: string; registry?: string } {
  if (!isRecord(body)) {
    throw invalidRequest('请求体必须是 JSON 对象')
  }
  if (body.auth !== undefined || body.password !== undefined) {
    throw invalidRequest(PULL_AUTH_MESSAGE)
  }
  const nameRaw = body.name
  const tagRaw = body.tag
  if (typeof nameRaw !== 'string' || typeof tagRaw !== 'string') {
    throw invalidRequest('请提供镜像名称与标签')
  }
  const parsed = parseImageReference(`${nameRaw.trim()}:${tagRaw.trim()}`)
  if (!parsed.ok) {
    throw invalidRequest(parsed.error)
  }
  const registry =
    body.registry === undefined
      ? undefined
      : typeof body.registry === 'string'
        ? body.registry.trim()
        : null
  if (registry === null) {
    throw invalidRequest('镜像源格式无效')
  }
  if (registry !== undefined && registry.length === 0) {
    throw invalidRequest('镜像源不能为空')
  }
  return { ...parsed.reference, registry }
}

async function imageExistsByTag(
  transport: DockerTransport,
  name: string,
  tag: string,
): Promise<boolean> {
  const images = await listWithInspect(
    transport,
    `${API_PREFIX}/images/json`,
    (id) => `${API_PREFIX}/images/${encodeEngineId(id)}/json`,
    '镜像',
    (summary, inspect) => mapImage(summary, inspect),
  )
  return images.some((image) => image.name === name && image.tag === tag)
}

async function inspectImageById(transport: DockerTransport, id: string): Promise<unknown> {
  const engineId = id.includes(':') ? id : normalizeImageId(id)
  const response = await dockerRequest(transport, {
    method: 'GET',
    path: `${API_PREFIX}/images/${encodeEngineId(engineId)}/json`,
    timeoutMs: ACTION_TIMEOUT_MS,
  })
  if (response.status === 404) {
    throw new InvalidRequestError(404, IMAGE_NOT_FOUND_MESSAGE)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`获取镜像详情失败（HTTP ${response.status}）`)
  }
  return response.json
}

async function deleteImageRef(
  transport: DockerTransport,
  ref: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const response = await dockerRequest(transport, {
    method: 'DELETE',
    path: `${API_PREFIX}/images/${encodeEngineId(ref)}?force=false`,
    timeoutMs: ACTION_TIMEOUT_MS,
  })
  if (response.status === 200 || response.status === 204) {
    return { ok: true }
  }
  return {
    ok: false,
    message: engineErrorMessage(response.json, `HTTP ${response.status}`),
  }
}

async function tagImageRef(
  transport: DockerTransport,
  sourceRef: string,
  repo: string,
  tag: string,
): Promise<void> {
  const response = await dockerRequest(transport, {
    method: 'POST',
    path: `${API_PREFIX}/images/${encodeEngineId(sourceRef)}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
    timeoutMs: ACTION_TIMEOUT_MS,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `镜像打标签失败（HTTP ${response.status}）：${engineErrorMessage(response.json, '未知错误')}`,
    )
  }
}

/**
 * 统计引用目标镜像的容器数。真实引擎的 /containers/json 摘要里 Image 是引用名
 * （如 `busybox:1.37`），只有标签被删后才呈 sha256 形——直接拿它跟 64 位镜像 ID
 * 比对必然漏判，引擎侧的 409 保护会被降级成删除失败的 400。因此逐容器 inspect，
 * 以详情里 Image 字段（容器实际运行镜像的完整 ID）为准。
 */
async function countContainerImageReferences(
  transport: DockerTransport,
  imageId: string,
): Promise<number> {
  const response = await dockerRequest(transport, {
    method: 'GET',
    path: `${API_PREFIX}/containers/json?all=1`,
    timeoutMs: ACTION_TIMEOUT_MS,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`获取容器列表失败（HTTP ${response.status}）`)
  }
  if (!Array.isArray(response.json)) {
    throw new Error('容器列表格式无效')
  }
  const ids: string[] = []
  for (const summary of response.json) {
    ids.push(requireId(summary, '容器'))
  }
  const target = normalizeImageId(imageId)
  const inspects = await mapWithConcurrency(ids, INSPECT_CONCURRENCY, async (id) => {
    try {
      return await inspectContainer(transport, id, ACTION_TIMEOUT_MS)
    } catch (error) {
      // 列表与详情之间容器被移除：它不可能再引用镜像，跳过而不是让删除失败。
      if (error instanceof InvalidRequestError && error.status === 404) {
        return null
      }
      throw error
    }
  })
  let count = 0
  for (const inspect of inspects) {
    if (!isRecord(inspect) || typeof inspect.Image !== 'string') continue
    if (normalizeImageId(inspect.Image) === target) {
      count += 1
    }
  }
  return count
}

export function createDockerReadService(
  transport: DockerTransport,
  options: DockerServiceOptions,
): DockerReadService {
  const selfContainerId = options.selfContainerId ?? null
  const resolveRegistry =
    options.resolveRegistry ??
    (async () => {
      throw new Error('镜像源无法解析为公网地址')
    })

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
      // 自我保护以 inspect 解析出的完整 Id 为准：容器名、前缀等寻址形态解析后
      // 都归一到同一 Id，按名寻址不再绕过守卫。
      const preInspect = await inspectContainer(transport, id, ACTION_TIMEOUT_MS)
      if (
        (action === 'stop' || action === 'restart') &&
        isSelfContainerInspect(preInspect, selfContainerId)
      ) {
        throw new InvalidRequestError(400, ACTION_SELF_MESSAGE)
      }
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

  /** 删除容器：inspect 解析后先过自我保护，不带 force——引擎对运行中容器返回 409。 */
  async function runRemove(id: string): Promise<void> {
    if (actionLocks.has(id)) {
      throw new InvalidRequestError(409, ACTION_BUSY_MESSAGE)
    }

    let releaseLock!: () => void
    const lock = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    actionLocks.set(id, lock)

    try {
      const inspect = await inspectContainer(transport, id, ACTION_TIMEOUT_MS)
      if (isSelfContainerInspect(inspect, selfContainerId)) {
        throw new InvalidRequestError(400, ACTION_SELF_MESSAGE)
      }
      const targetId = requireId(inspect, '容器')
      const response = await dockerRequest(transport, {
        method: 'DELETE',
        path: `${API_PREFIX}/containers/${encodeEngineId(targetId)}`,
        timeoutMs: ACTION_TIMEOUT_MS,
      })
      if (response.status === 404) {
        throw new InvalidRequestError(404, CONTAINER_NOT_FOUND_MESSAGE)
      }
      if (response.status === 409) {
        throw new InvalidRequestError(409, CONTAINER_RUNNING_REMOVE_MESSAGE)
      }
      if (response.status !== 200 && response.status !== 204) {
        throw new Error(
          `容器删除失败（HTTP ${response.status}）：${engineErrorMessage(response.json, '未知错误')}`,
        )
      }
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
    async searchImages(rawTerm, registry) {
      const term = rawTerm.trim().toLowerCase()
      if (term.length < 2 || term.length > 64 || !/^[a-z0-9][a-z0-9._/-]*$/.test(term)) {
        throw invalidRequest('镜像搜索词格式无效')
      }
      if (registry && registry.trim() && registry.trim() !== 'https://registry-1.docker.io') {
        let target
        try {
          target = await validateRegistryTarget(registry, wrapRegistryResolver(resolveRegistry))
        } catch (error) {
          throw invalidRequest(error instanceof Error ? error.message : '镜像源地址无效')
        }
        return searchCatalog(target, term, options.fetchCatalog ?? requestRegistryCatalog)
      }
      const response = await transport.request({
        method: 'GET',
        path: `${API_PREFIX}/images/search?term=${encodeURIComponent(term)}&limit=${IMAGE_SEARCH_LIMIT}`,
        timeoutMs: 4_000,
        maxBytes: 128 * 1024,
      })
      if (response.status < 200 || response.status >= 300 || !Array.isArray(response.json)) {
        throw new Error(`搜索官方镜像失败（HTTP ${response.status}）`)
      }
      const names = response.json
        .map((entry: unknown) => isRecord(entry) ? entry.name : undefined)
        .filter((name: unknown): name is string => typeof name === 'string' && /^[a-z0-9][a-z0-9._/-]*$/.test(name))
      return { names: [...new Set(names)].slice(0, IMAGE_SEARCH_LIMIT), searchable: true }
    },
    async imageTags(rawName, registry) {
      const name = rawName.trim().toLowerCase()
      if (name.length === 0 || name.length > 128 ||
        !name.split('/').every((part) => /^[a-z0-9][a-z0-9._-]*$/.test(part))) {
        throw invalidRequest('镜像仓库名格式无效')
      }
      const fetchTags = options.fetchTags ?? requestRegistryTags
      if (registry?.trim() && registry.trim() !== 'https://registry-1.docker.io') {
        let target
        try {
          target = await validateRegistryTarget(registry, wrapRegistryResolver(resolveRegistry))
        } catch (error) {
          throw invalidRequest(error instanceof Error ? error.message : '镜像源地址无效')
        }
        return listRegistryTags(target, name, fetchTags)
      }
      const repository = name.includes('/') ? name : `library/${name}`
      const token = await (options.fetchHubToken ?? requestDockerHubToken)(repository)
      return listRegistryTags({ host: 'registry-1.docker.io' }, repository, fetchTags, token)
    },
    async policy() {
      return { mountRoot: options.mountRoot, reservedPorts: options.reservedPorts }
    },
    action(id, action) {
      return runAction(id, action)
    },
    removeContainer(id) {
      return runRemove(id)
    },
    create(body) {
      return serializeCreate(async () => {
        const [containers, images] = await Promise.all([
          listWithInspect(
            transport,
            `${API_PREFIX}/containers/json?all=1`,
            (id) => `${API_PREFIX}/containers/${encodeEngineId(id)}/json`,
            '容器',
            (_summary, inspect) => mapContainer(inspect),
          ),
          listWithInspect(
            transport,
            `${API_PREFIX}/images/json`,
            (id) => `${API_PREFIX}/images/${encodeEngineId(id)}/json`,
            '镜像',
            (summary, inspect) => mapImage(summary, inspect),
          ),
        ])

        const spec = await buildCreateSpec({
          body,
          images: images.map((image) => ({ id: image.id, name: image.name })),
          containers: containers.map((container) => ({
            name: container.name,
            ports: container.ports.map((port) => ({
              hostPort: port.hostPort,
              protocol: port.protocol,
              ...(port.hostIp !== undefined ? { hostIp: port.hostIp } : {}),
            })),
          })),
          mountRoot: options.mountRoot,
          reservedPorts: options.reservedPorts,
          realpath: options.realpath,
        })

        for (const dir of spec.mkdirPaths) {
          await options.mkdir(dir, 0o755)
        }

        const createResponse = await dockerRequest(transport, {
          method: 'POST',
          path: `${API_PREFIX}/containers/create?name=${encodeURIComponent(spec.name)}`,
          body: spec.createBody,
          timeoutMs: ACTION_TIMEOUT_MS,
        })
        if (createResponse.status < 200 || createResponse.status >= 300) {
          throw new Error(
            `创建容器失败（HTTP ${createResponse.status}）：${engineErrorMessage(createResponse.json, '未知错误')}`,
          )
        }

        const containerId = requireCreateId(createResponse.json)

        const startResponse = await dockerRequest(transport, {
          method: 'POST',
          path: `${API_PREFIX}/containers/${encodeEngineId(containerId)}/start`,
          timeoutMs: ACTION_TIMEOUT_MS,
        })
        if (
          startResponse.status !== 200 &&
          startResponse.status !== 204 &&
          startResponse.status !== 304
        ) {
          const reason = engineErrorMessage(
            startResponse.json,
            `HTTP ${startResponse.status}`,
          )
          const deleteResponse = await dockerRequest(transport, {
            method: 'DELETE',
            path: `${API_PREFIX}/containers/${encodeEngineId(containerId)}`,
            timeoutMs: ACTION_TIMEOUT_MS,
          })
          const deleted =
            deleteResponse.status === 200 ||
            deleteResponse.status === 204 ||
            deleteResponse.status === 404
          let message = `容器启动失败，已撤销创建：${reason}`
          if (!deleted) {
            message += `且撤销失败，容器 ID 为 ${containerId}`
          }
          throw new InvalidRequestError(400, message)
        }

        const inspect = await inspectContainer(transport, containerId, ACTION_TIMEOUT_MS)
        return mapContainer(inspect)
      })
    },
    async pull(body, signal, onProgress) {
      if (pullInFlight) {
        throw new InvalidRequestError(409, PULL_BUSY_MESSAGE)
      }
      pullInFlight = true
      try {
        const input = parsePullBody(body)
        const embeddedHost = embeddedRegistryHost(input.name)
        if (embeddedHost !== null && input.registry !== undefined) {
          throw invalidRequest(REGISTRY_REFERENCE_CONFLICT_MESSAGE)
        }

        if (await imageExistsByTag(transport, input.name, input.tag)) {
          throw invalidRequest(`镜像已存在：${input.name}:${input.tag}`)
        }

        let fromImage = `${input.name}:${input.tag}`
        let registryPullRef: string | null = null

        if (input.registry !== undefined) {
          const registryHost = await assertRegistryAllowed(input.registry, resolveRegistry)
          fromImage = buildRegistryFromImage(registryHost, input.name, input.tag)
          registryPullRef = fromImage
        } else if (embeddedHost !== null) {
          await assertRegistryAllowed(embeddedHost, resolveRegistry)
        }

        const pullCreate = transport.pullCreate
        if (!pullCreate) {
          throw new Error('Docker 传输层不支持镜像拉取')
        }

        const pullPath = `${API_PREFIX}/images/create?fromImage=${encodeURIComponent(fromImage)}`
        const progressDecoder = onProgress ? createPullProgressDecoder(onProgress) : undefined
        const pullResponse = await pullCreate({
          path: pullPath,
          timeoutMs: PULL_TIMEOUT_MS,
          maxBytes: PULL_PROGRESS_MAX_BYTES,
          signal,
          ...(progressDecoder ? { onChunk: progressDecoder.feed } : {}),
        })
        if (pullResponse.status !== 200) {
          throw new Error(`拉取镜像失败（HTTP ${pullResponse.status}）`)
        }
        const progress = readPullProgress(pullResponse.chunks)
        if (!progress.ok) {
          throw invalidRequest(progress.error)
        }
        await progressDecoder?.finish()

        if (registryPullRef !== null) {
          await tagImageRef(transport, registryPullRef, input.name, input.tag)
          const untag = await deleteImageRef(transport, registryPullRef)
          if (!untag.ok) {
            throw invalidRequest(`拉取后清理镜像源标签失败：${untag.message}`)
          }
        }

        const images = await listWithInspect(
          transport,
          `${API_PREFIX}/images/json`,
          (id) => `${API_PREFIX}/images/${encodeEngineId(id)}/json`,
          '镜像',
          (summary, inspect) => mapImage(summary, inspect),
        )
        const pulled = images.find((image) => image.name === input.name && image.tag === input.tag)
        if (!pulled) {
          throw new Error('拉取完成但未找到本地镜像')
        }
        return pulled
      } finally {
        pullInFlight = false
      }
    },
    async removeImage(id) {
      const normalizedId = normalizeImageId(id.trim())
      if (normalizedId.length === 0) {
        throw invalidRequest('镜像 ID 不能为空')
      }

      const refs = await countContainerImageReferences(transport, normalizedId)
      if (refs > 0) {
        throw new InvalidRequestError(409, IMAGE_IN_USE_MESSAGE)
      }

      const inspect = await inspectImageById(transport, normalizedId)
      const repoTagsRaw = isRecord(inspect) ? inspect.RepoTags : undefined
      const repoTags: string[] = []
      if (Array.isArray(repoTagsRaw)) {
        for (const tag of repoTagsRaw) {
          if (typeof tag === 'string' && tag.length > 0) {
            repoTags.push(tag)
          }
        }
      }

      if (repoTags.length === 0) {
        const result = await deleteImageRef(transport, normalizedId)
        if (!result.ok) {
          throw invalidRequest(`删除镜像失败：${result.message}`)
        }
        return
      }

      const sorted = [...repoTags].sort((a, b) => a.localeCompare(b))
      const removed: string[] = []
      for (const tag of sorted) {
        const result = await deleteImageRef(transport, tag)
        if (!result.ok) {
          const removedHint =
            removed.length > 0 ? `已移除 ${removed[0]}，` : ''
          throw invalidRequest(`${removedHint}删除 ${tag} 失败：${result.message}`)
        }
        removed.push(tag)
      }
    },
  }
}
