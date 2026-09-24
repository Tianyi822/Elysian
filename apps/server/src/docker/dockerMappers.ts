import {
  isSensitiveEnvKey,
  type Container,
  type ContainerImage,
  type ContainerStatus,
  type EnvPair,
  type PortMapping,
  type PortProtocol,
  type RestartPolicy,
  type VolumeMount,
} from '@elysian/contracts'

const RESTART_POLICIES: readonly RestartPolicy[] = [
  'no',
  'always',
  'on-failure',
  'unless-stopped',
]

const PULLED_AT_EPOCH = Date.parse('1980-01-01T00:00:00.000Z')

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw new Error(message)
  }
  return value
}

function stripSha256Prefix(id: string): string {
  return id.startsWith('sha256:') ? id.slice('sha256:'.length) : id
}

function mapEngineStatus(status: string): ContainerStatus {
  if (status === 'running' || status === 'restarting' || status === 'paused') {
    return status
  }
  return 'stopped'
}

function isZeroDockerTime(value: string): boolean {
  return value.startsWith('0001-01-01')
}

function shellQuoteToken(token: string): string {
  if (!/[\s'"]/.test(token)) {
    return token
  }
  return `'${token.replace(/'/g, `'\\''`)}'`
}

function buildCommand(path: string, args: readonly string[]): string {
  const parts = [path, ...args].filter((part) => part.length > 0)
  if (parts.length === 0) {
    return ''
  }
  return parts.map(shellQuoteToken).join(' ')
}

function parseEnvLine(line: string): { key: string; value: string } {
  const eq = line.indexOf('=')
  if (eq <= 0) {
    throw new Error('容器详情格式无效：环境变量行格式错误')
  }
  return { key: line.slice(0, eq), value: line.slice(eq + 1) }
}

function parsePortKey(key: string): { containerPort: number; protocol: PortProtocol } {
  const slash = key.lastIndexOf('/')
  if (slash <= 0) {
    throw new Error('容器详情格式无效：端口绑定键格式错误')
  }
  const portPart = key.slice(0, slash)
  const protocolPart = key.slice(slash + 1)
  if (protocolPart !== 'tcp' && protocolPart !== 'udp') {
    throw new Error('容器详情格式无效：端口协议无效')
  }
  const containerPort = Number(portPart)
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
    throw new Error('容器详情格式无效：容器端口无效')
  }
  return { containerPort, protocol: protocolPart }
}

type RawPortBind = {
  hostIp: string
  hostPort: number
  containerPort: number
  protocol: PortProtocol
}

function mapPortBindings(bindings: Record<string, unknown>): PortMapping[] {
  const raw: RawPortBind[] = []
  for (const [key, value] of Object.entries(bindings)) {
    const { containerPort, protocol } = parsePortKey(key)
    if (!Array.isArray(value)) {
      continue
    }
    for (const entry of value) {
      if (!isRecord(entry)) {
        continue
      }
      const hostPortStr = entry.HostPort
      if (hostPortStr === undefined || hostPortStr === null || hostPortStr === '') {
        continue
      }
      const hostPort = Number(hostPortStr)
      if (!Number.isInteger(hostPort)) {
        throw new Error('容器详情格式无效：宿主端口无效')
      }
      const hostIp = typeof entry.HostIp === 'string' ? entry.HostIp : ''
      raw.push({ hostIp, hostPort, containerPort, protocol })
    }
  }

  const groups = new Map<string, RawPortBind[]>()
  for (const bind of raw) {
    const groupKey = `${bind.containerPort}/${bind.protocol}`
    const list = groups.get(groupKey) ?? []
    list.push(bind)
    groups.set(groupKey, list)
  }

  const result: PortMapping[] = []
  for (const group of groups.values()) {
    const hasV4 = group.some((b) => b.hostIp === '0.0.0.0')
    const hasV6 = group.some((b) => b.hostIp === '::')
    if (hasV4 && hasV6) {
      const sample = group.find((b) => b.hostIp === '0.0.0.0') ?? group[0]!
      result.push({
        containerPort: sample.containerPort,
        hostPort: sample.hostPort,
        protocol: sample.protocol,
        hostIp: '0.0.0.0',
      })
      continue
    }
    for (const bind of group) {
      const mapping: PortMapping = {
        containerPort: bind.containerPort,
        hostPort: bind.hostPort,
        protocol: bind.protocol,
      }
      if (bind.hostIp) {
        mapping.hostIp = bind.hostIp
      }
      result.push(mapping)
    }
  }

  return result
}

function mapMounts(mounts: unknown): VolumeMount[] {
  if (!Array.isArray(mounts)) {
    throw new Error('容器详情格式无效：Mounts 必须是数组')
  }
  return mounts.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('容器详情格式无效：挂载项格式错误')
    }
    const type = requireString(entry.Type, '容器详情格式无效：挂载类型无效')
    const destination = requireString(
      entry.Destination,
      '容器详情格式无效：挂载目标路径无效',
    )
    if (type === 'bind') {
      const source = requireString(entry.Source, '容器详情格式无效：bind 挂载源无效')
      return { hostPath: source, containerPath: destination, kind: 'bind' }
    }
    if (type === 'volume') {
      const name = requireString(entry.Name, '容器详情格式无效：卷名无效')
      return { hostPath: name, containerPath: destination, kind: 'volume' }
    }
    if (type === 'tmpfs') {
      return { hostPath: '', containerPath: destination, kind: 'tmpfs' }
    }
    throw new Error('容器详情格式无效：未知挂载类型')
  })
}

function mapRestartPolicy(name: unknown): RestartPolicy {
  if (typeof name !== 'string') {
    return 'no'
  }
  return RESTART_POLICIES.includes(name as RestartPolicy) ? (name as RestartPolicy) : 'no'
}

function resolveStartedAt(
  status: ContainerStatus,
  startedAt: unknown,
): string | undefined {
  if (status !== 'running' && status !== 'restarting' && status !== 'paused') {
    return undefined
  }
  if (typeof startedAt !== 'string' || isZeroDockerTime(startedAt)) {
    return undefined
  }
  return startedAt
}

export function mapContainer(inspect: unknown): Container {
  if (!isRecord(inspect)) {
    throw new Error('容器详情格式无效：根对象必须是对象')
  }

  const id = stripSha256Prefix(
    requireString(inspect.Id, '容器详情格式无效：缺少 Id'),
  )
  const nameRaw = requireString(inspect.Name, '容器详情格式无效：缺少 Name')
  const name = nameRaw.startsWith('/') ? nameRaw.slice(1) : nameRaw

  if (!isRecord(inspect.State)) {
    throw new Error('容器详情格式无效：缺少 State')
  }
  const engineStatus = requireString(
    inspect.State.Status,
    '容器详情格式无效：缺少 State.Status',
  )
  const status = mapEngineStatus(engineStatus)
  const startedAt = resolveStartedAt(status, inspect.State.StartedAt)

  const createdAt = requireString(inspect.Created, '容器详情格式无效：缺少 Created')

  if (!isRecord(inspect.Config)) {
    throw new Error('容器详情格式无效：缺少 Config')
  }
  const imageRef =
    typeof inspect.Config.Image === 'string' ? inspect.Config.Image : undefined

  const envLines = inspect.Config.Env
  const env: EnvPair[] = []
  if (envLines !== undefined) {
    if (!Array.isArray(envLines)) {
      throw new Error('容器详情格式无效：Config.Env 必须是数组')
    }
    for (const line of envLines) {
      if (typeof line !== 'string') {
        throw new Error('容器详情格式无效：环境变量行必须是字符串')
      }
      const { key, value } = parseEnvLine(line)
      env.push({
        key,
        value: isSensitiveEnvKey(key) ? null : value,
      })
    }
  }

  if (!isRecord(inspect.HostConfig)) {
    throw new Error('容器详情格式无效：缺少 HostConfig')
  }
  const portBindings = isRecord(inspect.HostConfig.PortBindings)
    ? inspect.HostConfig.PortBindings
    : {}
  const ports = mapPortBindings(portBindings)

  const restartPolicy = mapRestartPolicy(
    isRecord(inspect.HostConfig.RestartPolicy)
      ? inspect.HostConfig.RestartPolicy.Name
      : undefined,
  )

  const path =
    typeof inspect.Path === 'string' ? inspect.Path : ''
  const args = Array.isArray(inspect.Args)
    ? inspect.Args.filter((arg): arg is string => typeof arg === 'string')
    : []
  const command = buildCommand(path, args)

  const volumes = mapMounts(inspect.Mounts)

  const imageId = stripSha256Prefix(
    requireString(inspect.Image, '容器详情格式无效：缺少 Image'),
  )

  const container: Container = {
    id,
    name,
    status,
    imageId,
    ports,
    createdAt,
    command,
    env,
    volumes,
    restartPolicy,
  }
  if (imageRef !== undefined) {
    container.imageRef = imageRef
  }
  if (startedAt !== undefined) {
    container.startedAt = startedAt
  }
  return container
}

function parseRepoTag(repoTag: string): { name: string; tag: string } {
  const colon = repoTag.lastIndexOf(':')
  if (colon <= 0) {
    return { name: repoTag, tag: '<none>' }
  }
  const name = repoTag.slice(0, colon)
  const tag = repoTag.slice(colon + 1)
  if (tag === '') {
    return { name: repoTag, tag: '<none>' }
  }
  return { name, tag }
}

function resolveDigest(inspect: Record<string, unknown>, idWithoutPrefix: string): string {
  const digests = inspect.RepoDigests
  if (Array.isArray(digests) && digests.length > 0) {
    const first = digests[0]
    if (typeof first === 'string' && first.length > 0) {
      return first
    }
  }
  const shortId = idWithoutPrefix.slice(0, 12)
  return `sha256:${shortId}`
}

function resolvePulledAt(created: unknown): string | null {
  if (typeof created !== 'string' || isZeroDockerTime(created)) {
    return null
  }
  const ms = Date.parse(created)
  if (!Number.isFinite(ms) || ms < PULLED_AT_EPOCH) {
    return null
  }
  return created
}

export function mapImage(summary: unknown, inspect: unknown): ContainerImage {
  if (!isRecord(summary)) {
    throw new Error('镜像详情格式无效：摘要必须是对象')
  }
  if (!isRecord(inspect)) {
    throw new Error('镜像详情格式无效：详情必须是对象')
  }

  const idFromInspect = inspect.Id
  const idFromSummary = summary.Id
  const rawId =
    typeof idFromInspect === 'string'
      ? idFromInspect
      : typeof idFromSummary === 'string'
        ? idFromSummary
        : null
  if (rawId === null) {
    throw new Error('镜像详情格式无效：缺少 Id')
  }
  const id = stripSha256Prefix(rawId)

  const sizeRaw = inspect.Size
  if (typeof sizeRaw !== 'number' || !Number.isFinite(sizeRaw)) {
    throw new Error('镜像详情格式无效：Size 无效')
  }
  const sizeMb = Math.round(sizeRaw / 1_000_000)

  const pulledAt = resolvePulledAt(inspect.Created)

  const repoTagsRaw = inspect.RepoTags
  const repoTags: string[] = []
  if (repoTagsRaw !== undefined) {
    if (!Array.isArray(repoTagsRaw)) {
      throw new Error('镜像详情格式无效：RepoTags 必须是数组')
    }
    for (const tag of repoTagsRaw) {
      if (typeof tag !== 'string') {
        throw new Error('镜像详情格式无效：RepoTags 项必须是字符串')
      }
      repoTags.push(tag)
    }
  }

  const digest = resolveDigest(inspect, id)

  if (repoTags.length === 0) {
    return {
      id,
      name: '<none>',
      tag: '<none>',
      digest,
      sizeMb,
      pulledAt,
    }
  }

  const sorted = [...repoTags].sort((a, b) => a.localeCompare(b))
  const primary = parseRepoTag(sorted[0]!)
  const otherTags = sorted.slice(1)

  const image: ContainerImage = {
    id,
    name: primary.name,
    tag: primary.tag,
    digest,
    sizeMb,
    pulledAt,
  }
  if (otherTags.length > 0) {
    image.otherTags = otherTags
  }
  return image
}
