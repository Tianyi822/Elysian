import type {
  Container,
  ContainerAction,
  ContainerCreateInput,
  ContainerImage,
  ImagePullProgress,
  ContainerStatus,
  EnvPair,
  PortMapping,
  PortProtocol,
  RestartPolicy,
} from '@elysian/contracts'
import { CONTAINER_STATUSES, RESTART_POLICIES } from '@elysian/contracts'
import type { Unsubscribe } from '@elysian/contracts'
import type { ContainerAdapter, ContainerHostPolicy } from '../../contracts/adapters'
import { createContainerTerminalWsAdapter } from './containerTerminalWsAdapter'
import { reportUnauthorized, reportUnauthorizedStatus } from './unauthorized'
import type { EventSourceFactory, EventSourceLike } from '../sse/eventsAdapter'
import { parseElysianEvent, SseFrameParser } from '../sse/parse'

const CONTAINER_STREAM_EVENT_NAMES = [
  'container/sample',
  'container/updated',
  'container/created',
  'container/removed',
  'container/resync',
] as const

/** SSE 注释行 `: status connecting` 的载荷；服务端 Engine 断流而 HTTP 仍开着时写入，触发 connecting。 */
export const CONTAINER_SSE_STATUS_CONNECTING = 'status connecting'

function isConnectingStatusComment(line: string): boolean {
  if (!line.startsWith(':')) return false
  return line.slice(1).trimStart() === CONTAINER_SSE_STATUS_CONNECTING
}

export type ContainerEventSourceLike = EventSourceLike & {
  registerConnectingCommentHandler?(handler: () => void): () => void
}

function defaultEventSourceFactory(): EventSourceFactory | undefined {
  if (typeof EventSource === 'undefined') return undefined
  return (url) => {
    const native = new EventSource(url) as unknown as ContainerEventSourceLike
    if (typeof native.registerConnectingCommentHandler === 'function') {
      return native
    }
    if (typeof fetch !== 'undefined') {
      return createFetchContainerEventSource(url)
    }
    return native
  }
}

const FETCH_SSE_INITIAL_BACKOFF_MS = 1_000
const FETCH_SSE_MAX_BACKOFF_MS = 30_000

function delayMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => resolve(), ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

/** fetch 实现的容器事件源（EventSource 不可用时兜底；导出供 401 终止语义直接测试）。 */
export function createFetchContainerEventSource(url: string): ContainerEventSourceLike {
  const listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()
  const connectingHandlers = new Set<() => void>()
  let closed = false
  let lastEventId: string | undefined
  let backoffMs = FETCH_SSE_INITIAL_BACKOFF_MS
  let streamAbort: AbortController | null = null

  const source: ContainerEventSourceLike = {
    onopen: null,
    onerror: null,
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    close() {
      closed = true
      streamAbort?.abort()
      listeners.clear()
      connectingHandlers.clear()
      source.onopen = null
      source.onerror = null
    },
    registerConnectingCommentHandler(handler) {
      connectingHandlers.add(handler)
      return () => {
        connectingHandlers.delete(handler)
      }
    },
  }

  void (async () => {
    while (!closed) {
      streamAbort = new AbortController()
      const signal = streamAbort.signal
      let streamHadOpened = false
      try {
        const result = await (async (): Promise<'complete' | 'failed'> => {
          const headers: Record<string, string> = {}
          if (lastEventId !== undefined) {
            headers['Last-Event-ID'] = lastEventId
          }
          const response = await fetch(url, {
            signal,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          })
          if (response.status === 401) {
            // 未登录：上报后按既有失败路径触发一次 onerror（容器页 live 状态如实显示断开），
            // 再置 closed 终止循环——未登录前的退避重连毫无意义，徒增请求；
            // 重新登录后用户重新进入页面自然重连。
            reportUnauthorizedStatus(response.status)
            source.onerror?.(new Event('error'))
            closed = true
            return 'failed'
          }
          if (!response.ok || !response.body) {
            return 'failed'
          }
          source.onopen?.(new Event('open'))
          streamHadOpened = true
          backoffMs = FETCH_SSE_INITIAL_BACKOFF_MS

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          const parser = new SseFrameParser()

          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            for (;;) {
              const match = /\r\n|\n|\r/.exec(buffer)
              if (!match) break
              const line = buffer.slice(0, match.index)
              buffer = buffer.slice(match.index + match[0].length)

              if (isConnectingStatusComment(line)) {
                for (const handler of connectingHandlers) {
                  handler()
                }
                continue
              }

              for (const frame of parser.push(`${line}\n`)) {
                if (parser.lastEventId !== undefined) {
                  lastEventId = parser.lastEventId
                }
                for (const listener of listeners.get(frame.event) ?? []) {
                  listener({ data: frame.data } as MessageEvent<string>)
                }
              }
            }
          }

          if (parser.lastEventId !== undefined) {
            lastEventId = parser.lastEventId
          }
          return 'complete'
        })()

        if (closed) break
        if (result === 'failed' || result === 'complete') {
          source.onerror?.(new Event('error'))
        }
      } catch (error) {
        if (closed || (error instanceof DOMException && error.name === 'AbortError')) {
          break
        }
        if (streamHadOpened) {
          source.onerror?.(new Event('error'))
        }
      }

      if (closed) break

      try {
        await delayMs(backoffMs, signal)
      } catch {
        break
      }
      backoffMs = Math.min(backoffMs * 2, FETCH_SSE_MAX_BACKOFF_MS)
    }
  })()

  return source
}

function wireConnectingComment(
  source: ContainerEventSourceLike,
  onConnecting: () => void,
): void {
  source.registerConnectingCommentHandler?.(onConnecting)
}

/** Docker 容器 SSE：订阅 /api/docker/events，解析失败帧丢弃。 */
export function createContainerWatchLive(
  options: {
    baseUrl?: string
    createEventSource?: EventSourceFactory
  } = {},
): ContainerAdapter['watchLive'] {
  const baseUrl = options.baseUrl ?? '/api/docker'
  const factory = options.createEventSource ?? defaultEventSourceFactory()

  return (handlers): Unsubscribe => {
    if (!factory) {
      handlers.onStatus('live')
      return () => {}
    }

    const source = factory(`${baseUrl}/events`) as ContainerEventSourceLike
    let opened = false
    handlers.onStatus('connecting')

    for (const name of CONTAINER_STREAM_EVENT_NAMES) {
      source.addEventListener(name, (message: MessageEvent<string>) => {
        const event = parseElysianEvent(message.data)
        if (event) handlers.onEvent(event)
      })
    }

    source.onopen = () => {
      opened = true
      handlers.onStatus('live')
    }

    source.onerror = () => {
      if (opened) handlers.onStatus('connecting')
    }

    wireConnectingComment(source, () => {
      if (opened) handlers.onStatus('connecting')
    })

    return () => {
      source.close()
    }
  }
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(message)
  }
  return value as Record<string, unknown>
}

function parsePortMapping(value: unknown): PortMapping {
  const row = asObject(value, '容器端口映射响应无效')
  const containerPort = row.containerPort
  const hostPort = row.hostPort
  const protocol = row.protocol
  if (
    typeof containerPort !== 'number' ||
    !Number.isInteger(containerPort) ||
    typeof hostPort !== 'number' ||
    !Number.isInteger(hostPort)
  ) {
    throw new Error('容器端口映射响应无效')
  }
  if (protocol !== 'tcp' && protocol !== 'udp') {
    throw new Error('容器端口协议响应无效')
  }
  const hostIp = row.hostIp
  if (hostIp !== undefined && typeof hostIp !== 'string') {
    throw new Error('容器端口绑定地址响应无效')
  }
  return {
    containerPort,
    hostPort,
    protocol: protocol as PortProtocol,
    ...(hostIp !== undefined ? { hostIp } : {}),
  }
}

function parseEnvPair(value: unknown): EnvPair {
  const row = asObject(value, '容器环境变量响应无效')
  if (typeof row.key !== 'string') {
    throw new Error('容器环境变量响应无效')
  }
  const envValue = row.value
  if (typeof envValue !== 'string' && envValue !== null) {
    throw new Error('容器环境变量响应无效')
  }
  return { key: row.key, value: envValue }
}

function parseVolumeMount(value: unknown): Container['volumes'][number] {
  const row = asObject(value, '容器挂载卷响应无效')
  if (typeof row.hostPath !== 'string' || typeof row.containerPath !== 'string') {
    throw new Error('容器挂载卷响应无效')
  }
  const kind = row.kind
  if (kind !== undefined && kind !== 'bind' && kind !== 'volume' && kind !== 'tmpfs') {
    throw new Error('容器挂载卷类型响应无效')
  }
  return {
    hostPath: row.hostPath,
    containerPath: row.containerPath,
    ...(kind !== undefined ? { kind } : {}),
  }
}

/** 校验单个容器条目：字段逐条收窄，不直接把未校验对象断言成 Container。 */
export function parseContainer(value: unknown): Container {
  const row = asObject(value, '容器列表响应无效')
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.imageId !== 'string') {
    throw new Error('容器列表响应无效')
  }
  const status = row.status
  if (typeof status !== 'string' || !CONTAINER_STATUSES.includes(status as ContainerStatus)) {
    throw new Error('容器状态响应无效')
  }
  if (typeof row.createdAt !== 'string' || typeof row.command !== 'string') {
    throw new Error('容器列表响应无效')
  }
  const restartPolicy = row.restartPolicy
  if (
    typeof restartPolicy !== 'string' ||
    !RESTART_POLICIES.includes(restartPolicy as RestartPolicy)
  ) {
    throw new Error('容器重启策略响应无效')
  }
  if (!Array.isArray(row.ports) || !Array.isArray(row.env) || !Array.isArray(row.volumes)) {
    throw new Error('容器列表响应无效')
  }
  const imageRef = row.imageRef
  if (imageRef !== undefined && typeof imageRef !== 'string') {
    throw new Error('容器镜像引用响应无效')
  }
  const startedAt = row.startedAt
  if (startedAt !== undefined && typeof startedAt !== 'string') {
    throw new Error('容器启动时间响应无效')
  }
  return {
    id: row.id,
    name: row.name,
    status: status as ContainerStatus,
    imageId: row.imageId,
    ...(imageRef !== undefined ? { imageRef } : {}),
    ports: row.ports.map((port) => parsePortMapping(port)),
    createdAt: row.createdAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    command: row.command,
    env: row.env.map((pair) => parseEnvPair(pair)),
    volumes: row.volumes.map((volume) => parseVolumeMount(volume)),
    restartPolicy: restartPolicy as RestartPolicy,
  }
}

export function parseContainerListResponse(body: unknown): readonly Container[] {
  const containers = asObject(body, '容器列表响应无效').containers
  if (!Array.isArray(containers)) {
    throw new Error('容器列表响应无效')
  }
  return containers.map((entry) => parseContainer(entry))
}

function parseContainerImage(value: unknown): ContainerImage {
  const row = asObject(value, '镜像列表响应无效')
  if (
    typeof row.id !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.tag !== 'string' ||
    typeof row.digest !== 'string' ||
    typeof row.sizeMb !== 'number'
  ) {
    throw new Error('镜像列表响应无效')
  }
  const pulledAt = row.pulledAt
  if (typeof pulledAt !== 'string' && pulledAt !== null) {
    throw new Error('镜像拉取时间响应无效')
  }
  const otherTags = row.otherTags
  if (otherTags !== undefined) {
    if (!Array.isArray(otherTags) || otherTags.some((tag) => typeof tag !== 'string')) {
      throw new Error('镜像附加标签响应无效')
    }
  }
  return {
    id: row.id,
    name: row.name,
    tag: row.tag,
    digest: row.digest,
    sizeMb: row.sizeMb,
    pulledAt,
    ...(otherTags !== undefined ? { otherTags } : {}),
  }
}

export function parseContainerImageListResponse(body: unknown): readonly ContainerImage[] {
  const images = asObject(body, '镜像列表响应无效').images
  if (!Array.isArray(images)) {
    throw new Error('镜像列表响应无效')
  }
  return images.map((entry) => parseContainerImage(entry))
}

export function parseContainerPolicyResponse(body: unknown): ContainerHostPolicy {
  const row = asObject(body, '容器策略响应无效')
  if (typeof row.mountRoot !== 'string') {
    throw new Error('容器策略响应无效')
  }
  const reservedPorts = row.reservedPorts
  if (
    !Array.isArray(reservedPorts) ||
    reservedPorts.some((port) => typeof port !== 'number' || !Number.isInteger(port))
  ) {
    throw new Error('容器策略响应无效')
  }
  return { mountRoot: row.mountRoot, reservedPorts }
}

async function readErrorDetail(response: Response): Promise<string | null> {
  return response
    .json()
    .then((body) =>
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : null,
    )
    .catch(() => null)
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error('容器管理请求网络失败')
  }
  if (!response.ok) {
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    const detail = await readErrorDetail(response)
    throw new Error(detail ?? `容器管理请求失败：HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('容器管理响应不是有效 JSON')
  }
}

async function requestNoContent(url: string, init?: RequestInit): Promise<void> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error('容器管理请求网络失败')
  }
  if (!response.ok) {
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    const detail = await readErrorDetail(response)
    throw new Error(detail ?? `容器管理请求失败：HTTP ${response.status}`)
  }
}

async function readImagePullStream(response: Response, onProgress?: (progress: ImagePullProgress) => void): Promise<ContainerImage> {
  if (!response.body) throw new Error('镜像拉取未返回进度流')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let image: ContainerImage | undefined
  let complete = false

  const consume = (line: string) => {
    if (!line.trim()) return
    let frame: unknown
    try { frame = JSON.parse(line) } catch { throw new Error('镜像拉取进度格式无效') }
    if (!frame || typeof frame !== 'object' || !('type' in frame)) throw new Error('镜像拉取进度格式无效')
    if (frame.type === 'error') {
      throw new Error('error' in frame && typeof frame.error === 'string' ? frame.error : '镜像拉取失败')
    }
    if (frame.type === 'result' && 'image' in frame) {
      image = parseContainerImage(frame.image)
      return
    }
    if (frame.type === 'progress' && 'progress' in frame && frame.progress && typeof frame.progress === 'object') {
      const value = frame.progress as Partial<ImagePullProgress>
      if (value.phase !== 'preparing' && value.phase !== 'downloading' && value.phase !== 'extracting' && value.phase !== 'finalizing') {
        throw new Error('镜像拉取进度格式无效')
      }
      onProgress?.({
        phase: value.phase,
        ...(typeof value.layerId === 'string' ? { layerId: value.layerId } : {}),
        ...(typeof value.currentBytes === 'number' && typeof value.totalBytes === 'number' &&
          Number.isFinite(value.currentBytes) && Number.isFinite(value.totalBytes) && value.totalBytes > 0
          ? { currentBytes: Math.max(0, Math.min(value.currentBytes, value.totalBytes)), totalBytes: value.totalBytes } : {}),
      })
      return
    }
    throw new Error('镜像拉取进度格式无效')
  }

  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>
      try { result = await reader.read() } catch { throw new Error('镜像拉取连接中断') }
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.length > 128 * 1024) throw new Error('镜像拉取进度行过大')
        consume(line)
      }
      if (buffer.length > 128 * 1024) throw new Error('镜像拉取进度行过大')
    }
    buffer += decoder.decode()
    if (buffer) consume(buffer)
    if (!image) throw new Error('镜像拉取连接提前结束')
    complete = true
    return image
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Docker 运行时的容器只读 adapter：list、listImages 与 createPolicy 走 /api/docker。 */
export function createHttpContainersAdapter(
  baseUrl = '/api/docker',
  options: { createEventSource?: EventSourceFactory } = {},
): ContainerAdapter {
  const watchLive = createContainerWatchLive({ baseUrl, ...options })
  const terminal = createContainerTerminalWsAdapter()
  return {
    async list() {
      return parseContainerListResponse(await requestJson(`${baseUrl}/containers`))
    },

    async listImages() {
      return parseContainerImageListResponse(await requestJson(`${baseUrl}/images`))
    },

    async searchImageNames(term, registry, signal) {
      const params = new URLSearchParams({ term })
      if (registry?.trim()) params.set('registry', registry.trim())
      const result = await requestJson(`${baseUrl}/images/search?${params}`, { signal })
      if (!result || typeof result !== 'object' || !('names' in result) || !Array.isArray(result.names) ||
        !result.names.every((name) => typeof name === 'string') || !('searchable' in result) || typeof result.searchable !== 'boolean') {
        throw new Error('镜像搜索响应格式无效')
      }
      return { names: result.names as string[], searchable: result.searchable }
    },

    async imageTags(name, registry, signal) {
      const params = new URLSearchParams({ name })
      if (registry?.trim()) params.set('registry', registry.trim())
      const result = await requestJson(`${baseUrl}/images/tags?${params}`, { signal })
      if (!result || typeof result !== 'object' || !('tags' in result) || !Array.isArray(result.tags) ||
        !result.tags.every((tag) => typeof tag === 'string') || !('searchable' in result) || typeof result.searchable !== 'boolean') {
        throw new Error('镜像版本响应格式无效')
      }
      return { tags: result.tags as string[], searchable: result.searchable }
    },

    async createPolicy() {
      return parseContainerPolicyResponse(await requestJson(`${baseUrl}/policy`))
    },

    connectTerminal: terminal.connectTerminal,
    sendTerminalInput: terminal.sendTerminalInput,
    interruptTerminal: terminal.interruptTerminal,
    completeTerminal: terminal.completeTerminal,
    disconnectTerminal: terminal.disconnectTerminal,
    cancelTerminalConnect: terminal.cancelTerminalConnect,

    async requestAction(containerId, action: ContainerAction) {
      return parseContainer(
        await requestJson(
          `${baseUrl}/containers/${encodeURIComponent(containerId)}/${action}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
    },

    async create(input: ContainerCreateInput) {
      return parseContainer(
        await requestJson(`${baseUrl}/containers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    },
    async removeImage(imageId) {
      await requestNoContent(`${baseUrl}/images/${encodeURIComponent(imageId)}`, {
        method: 'DELETE',
      })
    },

    async pullImage(input, onProgress) {
      let response: Response
      try {
        response = await fetch(`${baseUrl}/images/pull/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
          body: JSON.stringify(input),
        })
      } catch {
        throw new Error('容器管理请求网络失败')
      }
      if (!response.ok) {
        // 401 先上报再抛中文错误，不进流读取（未登录时拉流没有意义）。
        if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
        const detail = await readErrorDetail(response)
        throw new Error(detail ?? `镜像拉取请求失败：HTTP ${response.status}`)
      }
      return readImagePullStream(response, onProgress)
    },
    watchLive,
  }
}
