import { randomBytes } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import type { ContainerImage, WebsiteRuntimeKind } from '@elysian/contracts'
import { websiteDefaultDeployCommand } from '@elysian/contracts'
import { InvalidRequestError, invalidRequest } from '../shared/errors.ts'
import type { DockerTransport } from '../docker/dockerTransport.ts'
import { isSelfContainerInspect } from '../docker/selfContainer.ts'

/*
 * 网站域的 Engine API 操作层（经 docker 域 DockerTransport，API 前缀 /v1.41）：
 * 建容器（官方镜像、bind 站点目录、127.0.0.1 同号端口、标签身份）、启停、inspect、
 * 日志读取（帧头剥离）、五重核对删除与站点目录的 realpath 防护。容器名服务端生成
 * （elysian-site- + 随机 hex，不掺用户输入——项目名可含中文，不能进容器名）。
 */

const API = '/v1.41'
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const LOG_TAIL_LINES = 200
const LOG_MAX_BYTES = 1024 * 1024
const SITE_CONTAINER_NAME_PATTERN = /^elysian-site-[0-9a-f]{12}$/
/** 站点容器内的挂载点：站点目录 bind 的唯一目标。 */
const SITE_APP_TARGET = '/app'

export type WebsiteContainerCreateInput = {
  imageRef: string
  kind: WebsiteRuntimeKind
  version: string
  projectId: string
  port: number
  bindSource: string
}

export type WebsiteContainerIdentity = {
  containerId: string
  containerName: string
  projectId: string
  kind: WebsiteRuntimeKind
  version: string
  imageRef: string
  rootDir: string
  selfContainerId?: string
}

export type WebsiteDockerFsDeps = {
  mkdir?: (path: string, mode: number) => Promise<void>
  realpath?: (path: string) => Promise<string>
  rm?: (path: string) => Promise<void>
}

export type WebsiteDocker = {
  ensureImage(ref: string): Promise<void>
  ensureSiteDir(name: string, mountRoot: string): Promise<string>
  newContainerName(): string
  create(input: WebsiteContainerCreateInput & { containerName: string }): Promise<{ containerId: string }>
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
  inspect(id: string): Promise<Record<string, unknown>>
  logs(id: string): Promise<readonly string[]>
  removeManaged(identity: WebsiteContainerIdentity): Promise<'removed' | 'missing'>
  removeCreated(containerId: string): Promise<void>
  removeSiteDir(rootDir: string, mountRoot: string): Promise<void>
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function engineErrorMessage(json: unknown, fallback: string): string {
  const message = obj(json).message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

function assertValidContainerId(id: string): void {
  if (!/^[a-f0-9]{64}$/i.test(id)) throw invalidRequest('容器 ID 无效')
}

/** 容器名正则核对（五重核对第一环）。 */
export function isValidSiteContainerName(name: string): boolean {
  return SITE_CONTAINER_NAME_PATTERN.test(name)
}

/**
 * 站点容器启动命令的 argv 形：由契约的 websiteDefaultDeployCommand（显示字符串的
 * 单一事实来源）推导——node 的脚本参数含空格，不能按空白切分，按已知包裹形状剥出。
 */
export function websiteContainerCmd(kind: WebsiteRuntimeKind, port: number): string[] {
  const command = websiteDefaultDeployCommand(kind, port)
  if (command === null) return []
  if (kind === 'node') {
    const prefix = 'node -e \''
    return ['node', '-e', command.slice(prefix.length, command.length - 1)]
  }
  return command.split(' ')
}

/** 挂载根归一化：必须是绝对路径、无结尾斜杠、不含路径穿越段（对齐 createSpec 口径）。 */
function normalizeMountRoot(mountRoot: string): string {
  const trimmed = mountRoot.trim()
  if (!trimmed.startsWith('/') || trimmed.includes('..') || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw invalidRequest(`无效的挂载根：${mountRoot}`)
  }
  const segments = trimmed.split('/').filter((segment) => segment.length > 0)
  return `/${segments.join('/')}`
}

function wwwrootBase(mountRoot: string): string {
  return `${normalizeMountRoot(mountRoot)}/wwwroot`
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * 非 tty 容器日志流的帧头剥离：Docker 以 8 字节复用帧头
 * `[streamType,0,0,0,sizeBigEndian4]` 切分 stdout/stderr 帧，帧内载荷可跨任意字节
 * （含换行），必须按长度切分拼接。形状不符时整段按 UTF-8 文本兜底解码（防御性，
 * 不让一条畸形日志拖垮整个读取）。
 */
export function stripContainerLogFrames(bytes: Uint8Array): string {
  const parts: Uint8Array[] = []
  let offset = 0
  while (offset + 8 <= bytes.length) {
    const b0 = bytes[offset + 4]!
    const b1 = bytes[offset + 5]!
    const b2 = bytes[offset + 6]!
    const b3 = bytes[offset + 7]!
    const size = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3
    if (size < 0 || offset + 8 + size > bytes.length) break
    parts.push(bytes.subarray(offset + 8, offset + 8 + size))
    offset += 8 + size
  }
  if (offset !== bytes.length) parts.push(bytes.subarray(offset))
  return Buffer.concat(parts.map((part) => Buffer.from(part))).toString('utf8')
}

export function createWebsiteDocker(
  transport: DockerTransport,
  listImages: () => Promise<readonly ContainerImage[]>,
  fs: WebsiteDockerFsDeps = {},
): WebsiteDocker {
  const doMkdir = fs.mkdir ?? (async (path, mode) => {
    // recursive：挂载根/wwwroot 可能尚未建立；站点目录是路径的最后一段。
    await mkdir(path, { recursive: true, mode })
  })
  const doRealpath = fs.realpath ?? ((path) => realpath(path))
  const doRm = fs.rm ?? (async (path) => {
    await rm(path, { recursive: true, force: false })
  })

  async function request(method: string, path: string, body?: unknown) {
    return transport.request({ method, path, body, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES })
  }

  async function inspect(id: string): Promise<Record<string, unknown>> {
    assertValidContainerId(id)
    const response = await request('GET', `${API}/containers/${encodeURIComponent(id)}/json`)
    if (response.status === 404) throw new InvalidRequestError(404, '站点容器已不存在')
    if (response.status !== 200) throw new Error('读取站点容器失败')
    const info = obj(response.json)
    if (info.Id !== id) throw new Error('容器身份核对失败')
    return info
  }

  async function ensureImage(ref: string): Promise<void> {
    if (typeof ref !== 'string' || ref.length === 0) throw invalidRequest('镜像引用无效')
    const images = await listImages()
    const present = images.some((image) => {
      const primary = `${image.name}:${image.tag}`
      if (primary === ref) return true
      return (image.otherTags ?? []).some((candidate) => candidate === ref)
    })
    if (!present) throw new InvalidRequestError(409, `指定版本的运行时镜像尚未拉取：${ref}`)
  }

  /** mkdir 站点目录并 realpath 复核仍在归一化 `<mountRoot>/wwwroot` 之下（防符号链接逃逸）。 */
  async function ensureSiteDir(name: string, mountRoot: string): Promise<string> {
    const base = wwwrootBase(mountRoot)
    const dir = `${base}/${name}`
    await doMkdir(dir, 0o755)
    const resolved = await doRealpath(dir)
    if (resolved !== base && !resolved.startsWith(`${base}/`)) {
      throw invalidRequest('站点目录经过符号链接，已拒绝')
    }
    return dir
  }

  function newContainerName(): string {
    return `elysian-site-${randomBytes(6).toString('hex')}`
  }

  async function create(input: WebsiteContainerCreateInput & { containerName: string }) {
    if (!isValidSiteContainerName(input.containerName)) throw invalidRequest('容器名称无效')
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw invalidRequest('端口需为 1-65535 的整数')
    if (typeof input.bindSource !== 'string' || !input.bindSource.startsWith('/')) throw invalidRequest('站点目录无效')
    const portKey = `${input.port}/tcp`
    const createBody = {
      Image: input.imageRef,
      Cmd: websiteContainerCmd(input.kind, input.port),
      Labels: {
        'elysian.managed': 'true',
        'elysian.website': 'true',
        'elysian.website.project': input.projectId,
        'elysian.website.kind': input.kind,
        'elysian.website.version': input.version,
      },
      HostConfig: {
        Binds: [`${input.bindSource}:${SITE_APP_TARGET}`],
        PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: String(input.port) }] },
        RestartPolicy: { Name: 'unless-stopped' },
      },
      ExposedPorts: { [portKey]: {} },
    }
    const created = await request('POST', `${API}/containers/create?name=${encodeURIComponent(input.containerName)}`, createBody)
    const containerId = obj(created.json).Id
    if (created.status !== 201 || typeof containerId !== 'string') {
      throw new Error(`创建站点容器失败：${engineErrorMessage(created.json, `HTTP ${created.status}`)}`)
    }
    return { containerId }
  }

  async function start(id: string): Promise<void> {
    const response = await request('POST', `${API}/containers/${encodeURIComponent(id)}/start`)
    if (response.status === 404) throw new InvalidRequestError(404, '站点容器已不存在')
    if (response.status !== 204 && response.status !== 304 && response.status !== 200) {
      throw new Error(`启动站点容器失败：${engineErrorMessage(response.json, `HTTP ${response.status}`)}`)
    }
  }

  async function stop(id: string): Promise<void> {
    const response = await request('POST', `${API}/containers/${encodeURIComponent(id)}/stop?t=10`)
    if (response.status === 404) throw new InvalidRequestError(404, '站点容器已不存在')
    if (response.status !== 204 && response.status !== 304 && response.status !== 200) {
      throw new Error(`停止站点容器失败：${engineErrorMessage(response.json, `HTTP ${response.status}`)}`)
    }
  }

  async function logs(id: string): Promise<readonly string[]> {
    if (!transport.pullCreate) throw new Error('读取容器日志失败')
    const response = await transport.pullCreate({
      method: 'GET',
      path: `${API}/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${LOG_TAIL_LINES}`,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: LOG_MAX_BYTES,
    })
    if (response.status !== 200) throw new Error('读取容器日志失败')
    const text = stripContainerLogFrames(Buffer.concat(response.chunks.map((chunk) => Buffer.from(chunk))))
    return text.split('\n').filter((line) => line.length > 0)
  }

  /**
   * 五重核对删除：容器名正则 → 标签四项（managed/website/project/kind/version）→
   * 镜像引用等于登记值 → Mounts 含该 bind（Source 与登记 rootDir 一致）→ stop 后
   * remove（v=false）。任何一环失败抛「站点容器身份核对失败」，不删；容器已被外部
   * 删除（inspect 404）返回 missing，调用方跳过容器步骤照常清理目录与登记。
   */
  async function removeManaged(identity: WebsiteContainerIdentity): Promise<'removed' | 'missing'> {
    let info: Record<string, unknown>
    try {
      info = await inspect(identity.containerId)
    } catch (error) {
      if (error instanceof InvalidRequestError && error.status === 404) return 'missing'
      throw error
    }
    // 面板自保先于一切核对：网站容器按定义不会是面板自身，双保险对齐 docker 域先例。
    if (isSelfContainerInspect(info, identity.selfContainerId)) {
      throw new InvalidRequestError(403, '不能删除面板自身容器')
    }
    const rawName = typeof info.Name === 'string' ? info.Name.replace(/^\//, '') : ''
    const labels = obj(obj(info.Config).Labels)
    const mounts = Array.isArray(info.Mounts) ? info.Mounts : []
    const bindMounted = mounts.some((mount: unknown) => {
      const row = obj(mount)
      return row.Type === 'bind' && row.Source === identity.rootDir && row.Destination === SITE_APP_TARGET
    })
    const nameOk = rawName === identity.containerName && isValidSiteContainerName(rawName)
    const labelsOk = labels['elysian.managed'] === 'true' && labels['elysian.website'] === 'true' &&
      labels['elysian.website.project'] === identity.projectId &&
      labels['elysian.website.kind'] === identity.kind &&
      labels['elysian.website.version'] === identity.version
    const imageOk = String(obj(info.Config).Image ?? '') === identity.imageRef
    if (!nameOk || !labelsOk || !imageOk || !bindMounted) {
      throw new InvalidRequestError(409, '站点容器身份核对失败')
    }
    if (obj(info.State).Running) {
      const stopped = await request('POST', `${API}/containers/${encodeURIComponent(identity.containerId)}/stop?t=10`)
      if (stopped.status !== 204 && stopped.status !== 304 && stopped.status !== 200) {
        throw new Error(`停止站点容器失败：${engineErrorMessage(stopped.json, `HTTP ${stopped.status}`)}`)
      }
    }
    const removed = await request('DELETE', `${API}/containers/${encodeURIComponent(identity.containerId)}?v=false`)
    if (removed.status !== 204) {
      throw new Error(`删除站点容器失败：${engineErrorMessage(removed.json, `HTTP ${removed.status}`)}`)
    }
    return 'removed'
  }

  /** 撤销刚创建的容器（启动失败的回滚路径）：按 ID 直删，不做身份核对。 */
  async function removeCreated(containerId: string): Promise<void> {
    assertValidContainerId(containerId)
    const response = await request('DELETE', `${API}/containers/${encodeURIComponent(containerId)}?v=false`)
    if (response.status !== 204 && response.status !== 404) {
      throw new Error(`删除站点容器失败：${engineErrorMessage(response.json, `HTTP ${response.status}`)}`)
    }
  }

  /** realpath 复核仍在归一化 `<mountRoot>/wwwroot` 之下后递归删除站点目录；目录已被外部删除视为已清理。 */
  async function removeSiteDir(rootDir: string, mountRoot: string): Promise<void> {
    const base = wwwrootBase(mountRoot)
    if (rootDir === base || !rootDir.startsWith(`${base}/`)) throw invalidRequest('站点目录无效')
    let resolved: string
    try {
      resolved = await doRealpath(rootDir)
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
    if (resolved !== base && !resolved.startsWith(`${base}/`)) {
      throw invalidRequest('站点目录经过符号链接，已拒绝')
    }
    try {
      await doRm(rootDir)
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
  }

  return {
    ensureImage, ensureSiteDir, newContainerName, create, start, stop, inspect,
    logs, removeManaged, removeCreated, removeSiteDir,
  }
}
