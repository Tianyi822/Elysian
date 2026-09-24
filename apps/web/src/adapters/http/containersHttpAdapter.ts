import type {
  Container,
  ContainerImage,
  ContainerStatus,
  EnvPair,
  PortMapping,
  PortProtocol,
  RestartPolicy,
} from '@elysian/contracts'
import { CONTAINER_STATUSES, RESTART_POLICIES } from '@elysian/contracts'
import type { ContainerAdapter, ContainerHostPolicy } from '../../contracts/adapters'

const NOT_CONNECTED = async (): Promise<never> => {
  throw new Error('容器管理的该操作尚未接入')
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

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error('容器管理请求网络失败')
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body) =>
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : null,
      )
      .catch(() => null)
    throw new Error(detail ?? `容器管理请求失败：HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('容器管理响应不是有效 JSON')
  }
}

/** Docker 运行时的容器只读 adapter：list、listImages 与 createPolicy 走 /api/docker。 */
export function createHttpContainersAdapter(baseUrl = '/api/docker'): ContainerAdapter {
  return {
    async list() {
      return parseContainerListResponse(await requestJson(`${baseUrl}/containers`))
    },

    async listImages() {
      return parseContainerImageListResponse(await requestJson(`${baseUrl}/images`))
    },

    async createPolicy() {
      return parseContainerPolicyResponse(await requestJson(`${baseUrl}/policy`))
    },

    execMockCommand: NOT_CONNECTED,
    requestAction: NOT_CONNECTED,
    create: NOT_CONNECTED,
    removeImage: NOT_CONNECTED,
    pullImage: NOT_CONNECTED,
  }
}
