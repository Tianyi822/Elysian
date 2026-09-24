import {
  autoContainerName,
  parseShellWords,
  RESTART_POLICIES,
  type ContainerCreateInput,
  type EnvPair,
  type PortMapping,
  type PortProtocol,
  type RestartPolicy,
  type VolumeMount,
} from '@elysian/contracts'
import { InvalidRequestError, invalidRequest } from '../shared/errors.ts'

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_KEY_MAX = 128
const ENV_VALUE_MAX_BYTES = 4096
const MAX_PORTS = 32
const MAX_ENV = 64
const MAX_MOUNTS = 16
const PORT_MIN = 1
const PORT_MAX = 65535
const ALLOWED_HOST_IPS = new Set(['127.0.0.1', '0.0.0.0'])
const UNSAFE_PATH_CHARS = /[\u0000-\u001F\u007F-\u009F]/
const SYMLINK_MOUNT_MESSAGE = '挂载路径经过符号链接，已拒绝'

export type BuildCreateSpecInput = {
  body: unknown
  images: readonly { id: string; name: string }[]
  containers: readonly {
    name: string
    ports: readonly { hostPort: number; protocol: string; hostIp?: string }[]
  }[]
  mountRoot: string
  reservedPorts: readonly number[]
  realpath: (path: string) => Promise<string>
}

export type BuildCreateSpecResult = {
  name: string
  createBody: Record<string, unknown>
  mkdirPaths: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function conflictError(status: number, message: string): InvalidRequestError {
  return new InvalidRequestError(status, message)
}

function normalizeImageId(raw: string): string {
  const trimmed = raw.trim()
  const hex = trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed
  if (!/^[a-f0-9]{64}$/i.test(hex)) {
    throw invalidRequest('镜像 ID 无效')
  }
  return hex.toLowerCase()
}

function normalizeMountRoot(mountRoot: string): string {
  return normalizeAbsolutePath(mountRoot, '挂载根')
}

function normalizeAbsolutePath(input: string, label: string): string {
  const reject = (): never => {
    throw invalidRequest(`无效的${label}：${input}`)
  }
  if (!input.startsWith('/')) reject()
  if (UNSAFE_PATH_CHARS.test(input)) reject()
  const segments = input.split('/').filter((segment) => segment.length > 0)
  for (const segment of segments) {
    if (segment === '..' || segment === '.') reject()
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

function parentDirOf(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  segments.pop()
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

function isENOENT(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === 'ENOENT'
  )
}

function effectiveHostIp(hostIp?: string): string {
  if (hostIp === undefined || hostIp === '') return '127.0.0.1'
  return hostIp
}

function hostIpsOverlap(a: string, b: string): boolean {
  return a === b || a === '0.0.0.0' || b === '0.0.0.0'
}

function parseRestartPolicy(value: unknown): RestartPolicy {
  if (typeof value !== 'string' || !(RESTART_POLICIES as readonly string[]).includes(value)) {
    throw invalidRequest('重启策略无效')
  }
  return value as RestartPolicy
}

function parsePortProtocol(value: unknown): PortProtocol {
  if (value === 'tcp' || value === undefined) return 'tcp'
  if (value === 'udp') return 'udp'
  throw invalidRequest('端口协议无效')
}

function parsePortNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidRequest(`${label}须为整数`)
  }
  if (value < PORT_MIN || value > PORT_MAX) {
    throw invalidRequest(`${label}须为 1-65535 的整数`)
  }
  return value
}

function parsePorts(raw: unknown): PortMapping[] {
  if (!Array.isArray(raw)) throw invalidRequest('ports 须为数组')
  if (raw.length > MAX_PORTS) throw invalidRequest(`端口映射不能超过 ${MAX_PORTS} 条`)
  return raw.map((row, index) => {
    if (!isRecord(row)) throw invalidRequest(`ports[${index}] 无效`)
    const hostIpRaw = row.hostIp
    let hostIp: string | undefined
    if (hostIpRaw !== undefined) {
      if (typeof hostIpRaw !== 'string') throw invalidRequest(`ports[${index}].hostIp 无效`)
      hostIp = hostIpRaw
      if (!ALLOWED_HOST_IPS.has(hostIp)) {
        throw invalidRequest('hostIp 只允许 127.0.0.1 或 0.0.0.0')
      }
    }
    return {
      containerPort: parsePortNumber(row.containerPort, '容器端口'),
      hostPort: parsePortNumber(row.hostPort, '宿主端口'),
      protocol: parsePortProtocol(row.protocol),
      ...(hostIp !== undefined ? { hostIp } : {}),
    }
  })
}

function assertEnvValue(value: string): void {
  if (value.length > ENV_VALUE_MAX_BYTES) {
    throw invalidRequest('环境变量值过长')
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) {
    throw invalidRequest('环境变量值不能包含换行或控制字符')
  }
}

function parseEnv(raw: unknown): EnvPair[] {
  if (!Array.isArray(raw)) throw invalidRequest('env 须为数组')
  if (raw.length > MAX_ENV) throw invalidRequest(`环境变量不能超过 ${MAX_ENV} 个`)
  const seen = new Set<string>()
  const env: EnvPair[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const row = raw[index]
    if (!isRecord(row)) throw invalidRequest(`env[${index}] 无效`)
    if (typeof row.key !== 'string') throw invalidRequest(`env[${index}].key 无效`)
    const key = row.key
    if (!ENV_KEY_PATTERN.test(key) || key.length > ENV_KEY_MAX) {
      throw invalidRequest('环境变量名无效')
    }
    if (seen.has(key)) throw invalidRequest('环境变量名重复')
    seen.add(key)
    if (row.value === null) {
      env.push({ key, value: null })
      continue
    }
    if (typeof row.value !== 'string') throw invalidRequest(`env[${index}].value 无效`)
    assertEnvValue(row.value)
    env.push({ key, value: row.value })
  }
  return env
}

function parseVolumes(raw: unknown): VolumeMount[] {
  if (!Array.isArray(raw)) throw invalidRequest('volumes 须为数组')
  if (raw.length > MAX_MOUNTS) throw invalidRequest(`挂载不能超过 ${MAX_MOUNTS} 个`)
  const volumes: VolumeMount[] = []
  const seenContainerPaths = new Set<string>()
  for (let index = 0; index < raw.length; index += 1) {
    const row = raw[index]
    if (!isRecord(row)) throw invalidRequest(`volumes[${index}] 无效`)
    if (typeof row.hostPath !== 'string' || typeof row.containerPath !== 'string') {
      throw invalidRequest(`volumes[${index}] 无效`)
    }
    const containerPath = normalizeAbsolutePath(row.containerPath, '容器内挂载路径')
    if (containerPath === '/') {
      throw invalidRequest('容器内挂载路径不能为根目录')
    }
    if (seenContainerPaths.has(containerPath)) {
      throw invalidRequest('容器内挂载路径重复')
    }
    seenContainerPaths.add(containerPath)
    volumes.push({
      hostPath: row.hostPath,
      containerPath,
      kind: 'bind',
    })
  }
  return volumes
}

function parseCreateInput(body: unknown): ContainerCreateInput {
  if (!isRecord(body)) throw invalidRequest('请求体无效')
  if (typeof body.imageId !== 'string' || !body.imageId.trim()) {
    throw invalidRequest('请选择镜像')
  }
  const nameRaw = body.name
  let name: string | undefined
  if (nameRaw !== undefined) {
    if (typeof nameRaw !== 'string') throw invalidRequest('名称无效')
    const trimmed = nameRaw.trim()
    if (trimmed) name = trimmed
  }
  return {
    ...(name !== undefined ? { name } : {}),
    imageId: body.imageId,
    ports: parsePorts(body.ports ?? []),
    env: parseEnv(body.env ?? []),
    volumes: parseVolumes(body.volumes ?? []),
    ...(typeof body.command === 'string' && body.command.trim()
      ? { command: body.command }
      : {}),
    restartPolicy: parseRestartPolicy(body.restartPolicy ?? 'no'),
  }
}

function assertResolvedUnderMountRoot(resolved: string, mountRoot: string): void {
  const root = normalizeMountRoot(mountRoot)
  const normalized = normalizeAbsolutePath(resolved, '挂载路径')
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw invalidRequest('挂载路径超出允许范围')
  }
}

async function resolveBindSource(
  hostPath: string,
  mountRoot: string,
  realpath: (path: string) => Promise<string>,
): Promise<{ source: string; mkdirPaths: string[] }> {
  const root = normalizeMountRoot(mountRoot)
  const normalized = normalizeAbsolutePath(hostPath, '宿主机挂载路径')
  if (normalized === root) {
    throw invalidRequest('不能将挂载根目录挂载进容器')
  }
  if (!normalized.startsWith(`${root}/`)) {
    throw invalidRequest(`绑定挂载路径须位于 ${root} 之下`)
  }

  let ancestor = normalized
  let resolvedAncestor: string | null = null
  while (true) {
    try {
      resolvedAncestor = await realpath(ancestor)
      break
    } catch (error) {
      if (error instanceof InvalidRequestError) throw error
      if (isENOENT(error)) {
        if (ancestor === root) {
          resolvedAncestor = await realpath(root)
          break
        }
        ancestor = parentDirOf(ancestor)
        continue
      }
      throw error
    }
  }
  assertResolvedUnderMountRoot(resolvedAncestor, root)

  const mkdirPaths: string[] = []
  if (ancestor !== normalized) {
    const segments = normalized.slice(root.length + 1).split('/')
    let current = root
    for (const segment of segments) {
      current = `${current}/${segment}`
      mkdirPaths.push(current)
    }
  }

  return { source: normalized, mkdirPaths }
}

function assertPortAvailable(
  port: PortMapping,
  reservedPorts: readonly number[],
  containers: BuildCreateSpecInput['containers'],
  pending: readonly PortMapping[],
): void {
  if (reservedPorts.includes(port.hostPort)) {
    throw invalidRequest(`宿主端口为面板保留：${port.hostPort}`)
  }
  const hostIp = effectiveHostIp(port.hostIp)
  const matches = (entry: { hostPort: number; protocol: string; hostIp?: string }) =>
    entry.hostPort === port.hostPort &&
    entry.protocol === port.protocol &&
    hostIpsOverlap(hostIp, effectiveHostIp(entry.hostIp))

  if (containers.some((container) => container.ports.some(matches))) {
    throw invalidRequest(`宿主端口已被占用：${port.hostPort}/${port.protocol}`)
  }
  const duplicates = pending.filter(
    (other) =>
      other !== port &&
      other.hostPort === port.hostPort &&
      other.protocol === port.protocol &&
      hostIpsOverlap(hostIp, effectiveHostIp(other.hostIp)),
  )
  if (duplicates.length > 0) {
    throw invalidRequest(`宿主端口已被占用：${port.hostPort}/${port.protocol}`)
  }
}

function buildPortBindings(ports: readonly PortMapping[]): Record<string, unknown> | undefined {
  if (ports.length === 0) return undefined
  const bindings: Record<string, unknown> = {}
  for (const port of ports) {
    const key = `${port.containerPort}/${port.protocol}`
    const entry = {
      HostPort: String(port.hostPort),
      HostIp: effectiveHostIp(port.hostIp),
    }
    const existing = bindings[key]
    if (Array.isArray(existing)) {
      existing.push(entry)
    } else if (existing === undefined) {
      bindings[key] = [entry]
    } else {
      bindings[key] = [existing, entry]
    }
  }
  return bindings
}

function buildMounts(
  volumes: readonly VolumeMount[],
  resolved: readonly { source: string; containerPath: string }[],
): unknown[] | undefined {
  if (volumes.length === 0) return undefined
  return resolved.map((mount, index) => ({
    Type: 'bind',
    Source: mount.source,
    Target: volumes[index]!.containerPath,
  }))
}

function buildRestartPolicy(policy: RestartPolicy): Record<string, unknown> {
  if (policy === 'on-failure') {
    return { Name: 'on-failure', MaximumRetryCount: 0 }
  }
  return { Name: policy }
}

export async function buildCreateSpec(input: BuildCreateSpecInput): Promise<BuildCreateSpecResult> {
  const createInput = parseCreateInput(input.body)
  const imageHex = normalizeImageId(createInput.imageId)
  const image = input.images.find((row) => normalizeImageId(row.id) === imageHex)
  if (!image) {
    throw invalidRequest('镜像不存在，无法创建容器')
  }

  let name = createInput.name?.trim() ?? ''
  if (name) {
    if (!NAME_PATTERN.test(name)) {
      throw invalidRequest('名称须以字母或数字开头，仅含字母、数字、下划线、点与连字符')
    }
    if (input.containers.some((container) => container.name === name)) {
      throw conflictError(409, `容器名称已存在：${name}`)
    }
  } else {
    name = autoContainerName(input.containers, image.name)
    if (input.containers.some((container) => container.name === name)) {
      throw conflictError(409, `容器名称已存在：${name}`)
    }
  }

  const pendingPorts: PortMapping[] = []
  for (const port of createInput.ports) {
    assertPortAvailable(port, input.reservedPorts, input.containers, pendingPorts)
    pendingPorts.push(port)
  }

  let cmd: string[] | undefined
  if (createInput.command) {
    const parsed = parseShellWords(createInput.command)
    if (!parsed.ok) throw invalidRequest(parsed.error)
    if (parsed.args.length > 0) cmd = parsed.args
  }

  const envStrings =
    createInput.env.length > 0
      ? createInput.env.map((pair) => `${pair.key}=${pair.value ?? ''}`)
      : undefined

  const resolvedMounts: { source: string; containerPath: string }[] = []
  const mkdirPaths: string[] = []
  for (const volume of createInput.volumes) {
    const resolved = await resolveBindSource(volume.hostPath, input.mountRoot, input.realpath)
    resolvedMounts.push({ source: resolved.source, containerPath: volume.containerPath })
    for (const dir of resolved.mkdirPaths) {
      if (!mkdirPaths.includes(dir)) mkdirPaths.push(dir)
    }
  }

  const hostConfig: Record<string, unknown> = {
    RestartPolicy: buildRestartPolicy(createInput.restartPolicy),
  }
  const portBindings = buildPortBindings(createInput.ports)
  if (portBindings) hostConfig.PortBindings = portBindings
  const mounts = buildMounts(createInput.volumes, resolvedMounts)
  if (mounts) hostConfig.Mounts = mounts

  const createBody: Record<string, unknown> = {
    Image: imageHex,
    Labels: { 'elysian.managed': 'true' },
    HostConfig: hostConfig,
  }
  if (cmd) createBody.Cmd = cmd
  if (envStrings) createBody.Env = envStrings

  return { name, createBody, mkdirPaths }
}

export { SYMLINK_MOUNT_MESSAGE }
