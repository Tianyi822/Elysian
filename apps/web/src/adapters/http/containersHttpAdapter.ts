import { withRequestDeadline } from './requestDeadline'
import type {
  Container,
  ContainerAction,
  ContainerApp,
  ContainerAppFile,
  ContainerBuildLogs,
  ContainerBuildPlan,
  ContainerBuildResult,
  ContainerBuildServicePlan,
  ContainerBuildState,
  ContainerBuildTask,
  ContainerCreateInput,
  ComposeCheckResult,
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
import { fetchWithSession, reportUnauthorized } from './unauthorized'
import type { EventSourceFactory, EventSourceLike } from '../sse/eventsAdapter'
import { parseElysianEvent, SseFrameParser } from '../sse/parse'

/** 工作区上传/编辑的时限：长请求用自己的时限，不套 60 秒普通写超时（AGENTS.md 时限约定）。 */
const APP_UPLOAD_TIMEOUT = 180_000

const CONTAINER_STREAM_EVENT_NAMES = [
  'container/sample',
  'container/updated',
  'container/created',
  'container/removed',
  'container/resync',
] as const

/** SSE 注释行 `: status connecting` 的载荷；服务端 Engine 断流而 HTTP 仍开着时写入，触发 connecting。 */
export const CONTAINER_SSE_STATUS_CONNECTING = 'status connecting'
export const CONTAINER_SSE_STATUS_LIVE = 'status live'

type ContainerLiveStatus = 'live' | 'connecting'

function parseStatusComment(line: string): ContainerLiveStatus | undefined {
  if (!line.startsWith(':')) return undefined
  const comment = line.slice(1).trimStart()
  if (comment === CONTAINER_SSE_STATUS_CONNECTING) return 'connecting'
  if (comment === CONTAINER_SSE_STATUS_LIVE) return 'live'
  return undefined
}

export type ContainerEventSourceLike = EventSourceLike & {
  registerStatusCommentHandler?(handler: (status: ContainerLiveStatus) => void): () => void
}

function defaultEventSourceFactory(): EventSourceFactory | undefined {
  // 原生 EventSource 不暴露注释帧；直接用 fetch 读取 Engine 状态，避免额外创建一条未关闭的连接。
  if (typeof fetch !== 'undefined') return createFetchContainerEventSource
  if (typeof EventSource === 'undefined') return undefined
  return (url) => new EventSource(url) as unknown as ContainerEventSourceLike
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

/** fetch 实现的容器事件源，读取断开与恢复注释帧；导出供重连与 401 终止语义测试。 */
export function createFetchContainerEventSource(url: string): ContainerEventSourceLike {
  const listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()
  const statusHandlers = new Set<(status: ContainerLiveStatus) => void>()
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
      statusHandlers.clear()
      source.onopen = null
      source.onerror = null
    },
    registerStatusCommentHandler(handler) {
      statusHandlers.add(handler)
      return () => {
        statusHandlers.delete(handler)
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
          const response = await fetchWithSession(url, {
            signal,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          })
          if (response.status === 401) {
            // 未登录：上报后按既有失败路径触发一次 onerror（容器页 live 状态如实显示断开），
            // 再置 closed 终止循环——未登录前的退避重连毫无意义，徒增请求；
            // 重新登录后用户重新进入页面自然重连。
            reportUnauthorized(response)
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

              const status = parseStatusComment(line)
              if (status !== undefined) {
                for (const handler of statusHandlers) {
                  handler(status)
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

    source.registerStatusCommentHandler?.((status) => {
      if (opened) handlers.onStatus(status)
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

/** 工作区与 compose 自检的响应解析：字段缺失或类型不符一律中文报错，不猜默认值。 */
function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function asString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message)
  return value
}

function parseContainerAppFile(value: unknown): ContainerAppFile {
  const row = asRecord(value, '工作区文件响应无效')
  if (typeof row.size !== 'number' || typeof row.text !== 'boolean') throw new Error('工作区文件响应无效')
  return {
    path: asString(row.path, '工作区文件响应无效'),
    size: row.size,
    modifiedAt: asString(row.modifiedAt, '工作区文件响应无效'),
    text: row.text,
  }
}

function parseContainerApp(value: unknown): ContainerApp {
  const row = asRecord(value, '容器工作区响应无效')
  // 兼容尚未重启的 Go 服务：空切片曾编码为 null，统一还原为空文件清单。
  const files = row.files === null ? [] : row.files
  if (!Array.isArray(files)) throw new Error('容器工作区响应无效')
  return {
    slug: asString(row.slug, '容器工作区响应无效'),
    displayName: asString(row.displayName, '容器工作区响应无效'),
    createdAt: asString(row.createdAt, '容器工作区响应无效'),
    directory: asString(row.directory, '容器工作区响应无效'),
    files: files.map(parseContainerAppFile),
  }
}

function parseComposeCheck(value: unknown): ComposeCheckResult {
  const row = asRecord(value, 'compose 自检响应无效')
  if (!Array.isArray(row.references) || !Array.isArray(row.undetermined)) throw new Error('compose 自检响应无效')
  return {
    composePath: asString(row.composePath, 'compose 自检响应无效'),
    composeDir: asString(row.composeDir, 'compose 自检响应无效'),
    references: row.references.map((item) => {
      const reference = asRecord(item, 'compose 自检响应无效')
      if (typeof reference.exists !== 'boolean' || typeof reference.line !== 'number') throw new Error('compose 自检响应无效')
      const kind = asString(reference.kind, 'compose 自检响应无效')
      if (kind !== 'volume' && kind !== 'env_file') throw new Error('compose 自检引用类型无效')
      return {
        raw: asString(reference.raw, 'compose 自检响应无效'),
        kind,
        line: reference.line,
        path: asString(reference.path, 'compose 自检响应无效'),
        scope: asString(reference.scope, 'compose 自检响应无效'),
        exists: reference.exists,
      }
    }),
    undetermined: row.undetermined.map((item) => asString(item, 'compose 自检响应无效')),
    // 判定范围说明缺失即视为响应无效：界面必须把它显示出来，不能让人误当全量解析。
    coverage: asString(row.coverage, 'compose 自检响应缺少判定范围说明'),
  }
}

const CONTAINER_BUILD_STATES = ['queued', 'building', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const

function asBuildState(value: unknown): ContainerBuildState {
  if (typeof value !== 'string' || !CONTAINER_BUILD_STATES.includes(value as ContainerBuildState)) {
    throw new Error('构建任务状态响应无效')
  }
  return value as ContainerBuildState
}

function asStringArray(value: unknown, message: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(message)
  return value
}

/** 构建结果条目：目标、仓库、tag、镜像 ID 与逐字错误原文。 */
function parseContainerBuildResult(value: unknown): ContainerBuildResult {
  const row = asRecord(value, '构建结果响应无效')
  if (row.state !== 'succeeded' && row.state !== 'failed') throw new Error('构建结果状态响应无效')
  return {
    target: asString(row.target, '构建结果响应无效'),
    repository: asString(row.repository, '构建结果响应无效'),
    tag: asString(row.tag, '构建结果响应无效'),
    imageId: asString(row.imageId, '构建结果响应无效'),
    state: row.state,
    error: asString(row.error, '构建结果响应无效'),
  }
}

/** 构建任务对象：持久化与响应同形，input 为原样存档的提交请求体。 */
export function parseContainerBuildTask(value: unknown): ContainerBuildTask {
  const row = asRecord(value, '构建任务响应无效')
  if (!Array.isArray(row.results)) throw new Error('构建任务响应无效')
  const mode = asString(row.mode, '构建任务响应无效')
  if (mode !== 'dockerfile' && mode !== 'compose') throw new Error('构建任务模式响应无效')
  return {
    id: asString(row.id, '构建任务响应无效'),
    slug: asString(row.slug, '构建任务响应无效'),
    mode,
    requestId: asString(row.requestId, '构建任务响应无效'),
    state: asBuildState(row.state),
    stage: asString(row.stage, '构建任务响应无效'),
    createdAt: asString(row.createdAt, '构建任务响应无效'),
    updatedAt: asString(row.updatedAt, '构建任务响应无效'),
    input: asRecord(row.input, '构建任务响应无效') as ContainerBuildTask['input'],
    results: row.results.map(parseContainerBuildResult),
    error: asString(row.error, '构建任务响应无效'),
  }
}

/** compose 模式预览里的单个服务条目。 */
function parseContainerBuildServicePlan(value: unknown): ContainerBuildServicePlan {
  const row = asRecord(value, '构建服务预览响应无效')
  if (typeof row.hasBuild !== 'boolean' || typeof row.contextFiles !== 'number' || typeof row.contextBytes !== 'number' || typeof row.repositoryOccupied !== 'boolean') {
    throw new Error('构建服务预览响应无效')
  }
  return {
    service: asString(row.service, '构建服务预览响应无效'),
    hasBuild: row.hasBuild,
    target: asString(row.target, '构建服务预览响应无效'),
    dockerfile: asString(row.dockerfile, '构建服务预览响应无效'),
    context: asString(row.context, '构建服务预览响应无效'),
    imageRepository: asString(row.imageRepository, '构建服务预览响应无效'),
    contextFiles: row.contextFiles,
    contextBytes: row.contextBytes,
    imageNameInCompose: asString(row.imageNameInCompose, '构建服务预览响应无效'),
    repositoryOccupied: row.repositoryOccupied,
    warnings: asStringArray(row.warnings, '构建服务预览响应无效'),
  }
}

/** 构建预览：dockerfile 与 compose 两形态按 mode 分派，字段与后端 JSON 逐字对齐。 */
export function parseContainerBuildPlan(value: unknown): ContainerBuildPlan {
  const row = asRecord(value, '构建预览响应无效')
  const mode = asString(row.mode, '构建预览响应无效')
  const slug = asString(row.slug, '构建预览响应无效')
  const warnings = asStringArray(row.warnings, '构建预览响应无效')
  if (mode === 'dockerfile') {
    if (typeof row.repositoryOccupied !== 'boolean' || typeof row.contextFiles !== 'number' || typeof row.contextBytes !== 'number') {
      throw new Error('构建预览响应无效')
    }
    return {
      mode,
      slug,
      target: asString(row.target, '构建预览响应无效'),
      dockerfile: asString(row.dockerfile, '构建预览响应无效'),
      context: asString(row.context, '构建预览响应无效'),
      imageRepository: asString(row.imageRepository, '构建预览响应无效'),
      contextFiles: row.contextFiles,
      contextBytes: row.contextBytes,
      repositoryOccupied: row.repositoryOccupied,
      warnings,
    }
  }
  if (mode === 'compose') {
    if (!Array.isArray(row.services)) throw new Error('构建预览响应无效')
    return {
      mode,
      slug,
      compose: asString(row.compose, '构建预览响应无效'),
      services: row.services.map(parseContainerBuildServicePlan),
      warnings,
    }
  }
  throw new Error('构建预览模式响应无效')
}

/** 构建日志分页响应：与网站部署日志同形状。 */
export function parseContainerBuildLogs(value: unknown): ContainerBuildLogs {
  const row = asRecord(value, '构建日志响应无效')
  if (typeof row.next !== 'number' || typeof row.total !== 'number') throw new Error('构建日志响应无效')
  return {
    lines: asStringArray(row.lines, '构建日志响应无效'),
    next: row.next,
    total: row.total,
  }
}

/**
 * 工作区端点挂在独立片 /api/container-apps 下（Go 侧 shared.ContainerAppsMount），
 * 不在 /api/docker 里：容器引擎访问与应用文件是两件事，各自有守卫与体积上限。
 */
export const CONTAINER_APPS_BASE_URL = '/api/container-apps'

function appPath(slug: string, sub: string, path?: string): string {
  const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`
  return `${CONTAINER_APPS_BASE_URL}/${encodeURIComponent(slug)}${sub}${query}`
}

/**
 * 工作区子路径（不带 ?path=）：appPath 第三参只会拼 ?path=，构建日志要的是 ?offset=，
 * 构建预览/提交则完全不带查询串，所以这里给一个只拼路径的变体，查询串由调用方自带。
 */
function appSub(slug: string, sub: string): string {
  return `${CONTAINER_APPS_BASE_URL}/${encodeURIComponent(slug)}${sub}`
}

function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  return withRequestDeadline(init, (bounded) => readJson(url, bounded))
}

async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetchWithSession(url, init)
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

function requestNoContent(url: string, init?: RequestInit): Promise<void> {
  return withRequestDeadline(init, (bounded) => readNoContent(url, bounded))
}

async function readNoContent(url: string, init?: RequestInit): Promise<void> {
  let response: Response
  try {
    response = await fetchWithSession(url, init)
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
    /**
     * 容器工作区（挂 /api/container-apps）。上传与编辑走各自时限：
     * 配置文件虽小，但一次 32 MiB 的上传不该被 60 秒写超时掐断成结果未确认。
     */
    async listApps() {
      const body = asRecord(await requestJson(CONTAINER_APPS_BASE_URL), '容器工作区响应无效')
      if (!Array.isArray(body.apps)) throw new Error('容器工作区响应无效')
      return body.apps.map(parseContainerApp)
    },

    async createApp(input) {
      return parseContainerApp(
        await requestJson(CONTAINER_APPS_BASE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    },

    async removeApp(slug) {
      await requestNoContent(appPath(slug, '/'), { method: 'DELETE' })
    },

    async uploadAppFile(slug, path, file) {
      return parseContainerAppFile(
        await withRequestDeadline(
          {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: file,
          },
          (bounded) => readJson(appPath(slug, '/files', path), bounded),
          APP_UPLOAD_TIMEOUT,
        ),
      )
    },

    async removeAppFile(slug, path) {
      await requestNoContent(appPath(slug, '/files', path), { method: 'DELETE' })
    },

    async readAppContent(slug, path) {
      const body = asRecord(
        await requestJson(appPath(slug, '/content', path)),
        '工作区文件内容响应无效',
      )
      return {
        path: asString(body.path, '工作区文件内容响应无效'),
        content: asString(body.content, '工作区文件内容响应无效'),
        file: parseContainerAppFile(body.file),
      }
    },

    async writeAppContent(slug, path, content) {
      return parseContainerAppFile(
        await withRequestDeadline(
          {
            method: 'PUT',
            headers: { 'content-type': 'text/plain' },
            body: content,
          },
          (bounded) => readJson(appPath(slug, '/content', path), bounded),
          APP_UPLOAD_TIMEOUT,
        ),
      )
    },

    async checkCompose(slug, path) {
      return parseComposeCheck(await requestJson(appPath(slug, '/compose-check', path)))
    },

    /**
     * 镜像构建六个端点同样挂 /api/container-apps 之下（后端 shared.ContainerAppsMount
     * 不新增挂载片，vite 代理表不动）。提交与查询都是快请求，不引入专用超时；
     * 构建本身是 202 异步任务，进度靠 listAppBuilds 轮询与分页日志。
     */
    async previewAppBuild(slug, input) {
      return parseContainerBuildPlan(
        await requestJson(appSub(slug, '/builds/preview'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    },

    async submitAppBuild(slug, input) {
      return parseContainerBuildTask(
        await requestJson(appSub(slug, '/builds'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
    },

    async listAppBuilds(slug) {
      const body = asRecord(await requestJson(appSub(slug, '/builds')), '构建任务列表响应无效')
      if (!Array.isArray(body.builds)) throw new Error('构建任务列表响应无效')
      return body.builds.map(parseContainerBuildTask)
    },

    async getAppBuild(slug, taskId) {
      return parseContainerBuildTask(await requestJson(appSub(slug, `/builds/${encodeURIComponent(taskId)}`)))
    },

    async getAppBuildLogs(slug, taskId, offset) {
      const params = new URLSearchParams({ offset: String(offset) })
      return parseContainerBuildLogs(
        await requestJson(`${appSub(slug, `/builds/${encodeURIComponent(taskId)}/logs`)}?${params}`),
      )
    },

    async cancelAppBuild(slug, taskId) {
      await requestNoContent(appSub(slug, `/builds/${encodeURIComponent(taskId)}/cancel`), { method: 'POST' })
    },

    async removeImage(imageId) {
      await requestNoContent(`${baseUrl}/images/${encodeURIComponent(imageId)}`, {
        method: 'DELETE',
      })
    },

    async pullImage(input, onProgress) {
      let response: Response
      try {
        response = await fetchWithSession(`${baseUrl}/images/pull/stream`, {
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
