import { createHash, randomUUID } from 'node:crypto'
import { PANEL_PORT, type ContainerImage, type DatabaseEngine } from '@elysian/contracts'
import { SERVER_PORT } from '../shared/ports.ts'
import { InvalidRequestError, invalidRequest } from '../shared/errors.ts'
import type { DockerTransport } from '../docker/dockerTransport.ts'

const API = '/v1.41'
export const DB_PRIVATE_NETWORK = 'elysian-db-local'
export const DB_SHARED_NETWORK = 'elysian-db-shared'
const REPOSITORY: Record<Exclude<DatabaseEngine, 'SQLite'>, string> = {
  MySQL: 'mysql',
  MariaDB: 'mariadb',
  Redis: 'redis',
}
const PORT: Record<Exclude<DatabaseEngine, 'SQLite'>, number> = {
  MySQL: 3306,
  MariaDB: 3306,
  Redis: 6379,
}

export type DatabaseDocker = {
  inspect(id: string): Promise<Record<string, unknown>>
  assertEngine(id: string, engine: Exclude<DatabaseEngine, 'SQLite'>, versionTag: string): Promise<Record<string, unknown>>
  address(id: string, network?: string): Promise<{ host: string; port: number }>
  attach(id: string, network: string): Promise<void>
  detach(id: string, network: string): Promise<void>
  create(input: {
    engine: Exclude<DatabaseEngine, 'SQLite'>
    versionTag: string
    imageId: string
    containerName: string
    accessScope: 'localhost' | 'container-network' | 'any-host'
    hostPort?: number
    bootstrapPassword: string
    ordinaryUser: { username: string; password: string }
  }): Promise<{ containerId: string; volumeName: string; started: boolean }>
  removeManaged(containerId: string, volumeName: string, engine: Exclude<DatabaseEngine, 'SQLite'>, versionTag: string): Promise<void>
  memory(id: string): Promise<{ usedGb: number; totalGb: number } | undefined>
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function imageRef(inspect: Record<string, unknown>): string {
  return String(obj(inspect.Config).Image ?? '')
}

export function validDatabaseVersion(tag: string): boolean {
  return /^\d+(?:\.\d+){0,2}(?:[-.][A-Za-z0-9]+)*$/.test(tag) && !/latest/i.test(tag)
}

export function imageMatches(engine: Exclude<DatabaseEngine, 'SQLite'>, name: string): boolean {
  return name === REPOSITORY[engine] || name === `library/${REPOSITORY[engine]}` ||
    name === `docker.io/library/${REPOSITORY[engine]}`
}

export function databaseImageHasTag(image: ContainerImage, engine: Exclude<DatabaseEngine, 'SQLite'>, tag: string): boolean {
  if (imageMatches(engine, image.name) && image.tag === tag) return true
  return (image.otherTags ?? []).some((ref) => {
    const colon = ref.lastIndexOf(':')
    return colon > 0 && ref.slice(colon + 1) === tag && imageMatches(engine, ref.slice(0, colon))
  })
}

export function createDatabaseDocker(
  transport: DockerTransport,
  listImages: () => Promise<readonly ContainerImage[]>,
): DatabaseDocker {
  async function request(method: string, path: string, body?: unknown) {
    return transport.request({ method, path, body, timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 })
  }

  async function inspect(id: string): Promise<Record<string, unknown>> {
    if (!/^[a-f0-9]{64}$/i.test(id)) throw invalidRequest('容器 ID 无效')
    const response = await request('GET', `${API}/containers/${encodeURIComponent(id)}/json`)
    if (response.status === 404) throw new InvalidRequestError(404, '数据库容器已不存在')
    if (response.status !== 200) throw new Error('读取数据库容器失败')
    const info = obj(response.json)
    if (info.Id !== id) throw new Error('容器身份核对失败')
    return info
  }

  async function assertEngine(id: string, engine: Exclude<DatabaseEngine, 'SQLite'>, versionTag: string) {
    if (!validDatabaseVersion(versionTag)) throw invalidRequest('必须指定明确数据库版本，不能使用 latest')
    const info = await inspect(id)
    if (!obj(info.State).Running) throw new InvalidRequestError(409, '数据库容器未运行')
    const ref = imageRef(info)
    const index = ref.lastIndexOf(':')
    const name = index >= 0 ? ref.slice(0, index) : ref
    const tag = index >= 0 ? ref.slice(index + 1) : ''
    const exactRef = imageMatches(engine, name) && tag === versionTag
    const imageId = String(info.Image ?? '').replace(/^sha256:/, '')
    const matchedImage = (await listImages()).some((image) => image.id.replace(/^sha256:/, '') === imageId && databaseImageHasTag(image, engine, versionTag))
    if (!matchedImage || (ref && !exactRef && !/^(?:sha256:)?[a-f0-9]{64}$/i.test(ref))) {
      throw new InvalidRequestError(409, '容器镜像与所选引擎或版本不一致')
    }
    return info
  }

  async function attach(id: string, network: string): Promise<void> {
    if (network !== DB_PRIVATE_NETWORK && network !== DB_SHARED_NETWORK) throw invalidRequest('数据库网络无效')
    const info = await inspect(id)
    if (obj(obj(info.NetworkSettings).Networks)[network]) return
    const response = await request('POST', `${API}/networks/${encodeURIComponent(network)}/connect`, { Container: id })
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
      throw new InvalidRequestError(409, '无法将数据库容器接入面板网络')
    }
  }

  async function detach(id: string, network: string): Promise<void> {
    if (network !== DB_PRIVATE_NETWORK && network !== DB_SHARED_NETWORK) throw invalidRequest('数据库网络无效')
    let info: Record<string, unknown>
    try {
      info = await inspect(id)
    } catch (error) {
      // 容器已被外部删除时视为已离网：移除登记（forget）不被卡死，其余错误照常抛出。
      if (error instanceof InvalidRequestError && error.status === 404) return
      throw error
    }
    if (!obj(obj(info.NetworkSettings).Networks)[network]) return
    const response = await request('POST', `${API}/networks/${encodeURIComponent(network)}/disconnect`, { Container: id })
    if (response.status < 200 || response.status >= 300) {
      throw new InvalidRequestError(409, '无法将数据库容器移出面板网络')
    }
  }

  async function address(id: string, network?: string) {
    const info = await inspect(id)
    if (!obj(info.State).Running) throw new InvalidRequestError(409, '数据库容器未运行')
    const networks = obj(obj(info.NetworkSettings).Networks)
    const selected = network ?? (networks[DB_PRIVATE_NETWORK] ? DB_PRIVATE_NETWORK : DB_SHARED_NETWORK)
    const ip = obj(networks[selected]).IPAddress
    if (typeof ip !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
      throw new InvalidRequestError(409, '数据库容器尚未接入面板网络')
    }
    return { host: ip, port: 0 }
  }

  async function create(input: Parameters<DatabaseDocker['create']>[0]) {
    const { engine, versionTag, imageId, containerName, accessScope, hostPort } = input
    if (!validDatabaseVersion(versionTag)) throw invalidRequest('必须指定明确数据库版本')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(containerName)) throw invalidRequest('容器名称无效')
    if (!/^[a-f0-9]{64}$/i.test(imageId.replace(/^sha256:/, ''))) throw invalidRequest('镜像 ID 无效')
    if (accessScope === 'any-host' && (!Number.isInteger(hostPort) || hostPort! < 1 || hostPort! > 65535)) {
      throw invalidRequest('任意主机访问必须指定有效宿主端口')
    }
    if (hostPort && [22, PANEL_PORT, SERVER_PORT].includes(hostPort)) throw invalidRequest('宿主端口被面板保留')
    const image = (await listImages()).find((item) => item.id === imageId)
    if (!image || !databaseImageHasTag(image, engine, versionTag)) {
      throw new InvalidRequestError(409, '指定版本的数据库镜像尚未拉取')
    }
    const volumeName = `elysian-db-${randomUUID()}`
    const network = accessScope === 'localhost' ? DB_PRIVATE_NETWORK : DB_SHARED_NETWORK
    const volume = await request('POST', `${API}/volumes/create`, {
      Name: volumeName,
      Labels: { 'elysian.database': 'true', 'elysian.database.engine': engine, 'elysian.database.version': versionTag },
    })
    if (volume.status !== 201 && volume.status !== 200) throw new Error('创建数据库持久卷失败')

    const port = PORT[engine]
    const portKey = `${port}/tcp`
    const hostConfig: Record<string, unknown> = {
      Mounts: [{ Type: 'volume', Source: volumeName, Target: engine === 'Redis' ? '/data' : '/var/lib/mysql' }],
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: network,
    }
    if (accessScope !== 'container-network') {
      hostConfig.PortBindings = {
        [portKey]: [{ HostIp: accessScope === 'localhost' ? '127.0.0.1' : '0.0.0.0', HostPort: hostPort ? String(hostPort) : '' }],
      }
    }
    const redisCommand = (() => {
      const adminHash = createHash('sha256').update(input.bootstrapPassword).digest('hex')
      const userHash = createHash('sha256').update(input.ordinaryUser.password).digest('hex')
      const acl = `user default on #${adminHash} ~* &* +@all\nuser ${input.ordinaryUser.username} on #${userHash} ~* &* +@all -@dangerous -@scripting -select -move -copy -swapdb -flushdb -flushall -eval -evalsha -eval_ro -evalsha_ro -fcall -fcall_ro -function -script -config -acl -module -debug -shutdown -save -bgsave -bgrewriteaof -migrate -restore -replicaof -slaveof -cluster -monitor -sync -psync\n`
      // 启动时写入持久卷内的 ACL 文件，重启后普通账号和限制保持一致。
      const encoded = Buffer.from(acl).toString('base64')
      return ['sh', '-c', `printf '%s' '${encoded}' | base64 -d > /data/users.acl && exec redis-server --appendonly yes --aclfile /data/users.acl`]
    })()
    const createBody = {
      Image: `${REPOSITORY[engine]}:${versionTag}`,
      Labels: { 'elysian.managed': 'true', 'elysian.database': 'true', 'elysian.database.engine': engine, 'elysian.database.version': versionTag, 'elysian.database.volume': volumeName },
      HostConfig: hostConfig,
      NetworkingConfig: { EndpointsConfig: { [network]: {} } },
      ExposedPorts: { [portKey]: {} },
      ...(engine === 'Redis'
        ? { Cmd: redisCommand }
        : { Env: [`${engine === 'MySQL' ? 'MYSQL' : 'MARIADB'}_ROOT_PASSWORD=${input.bootstrapPassword}`] }),
    }
    const created = await request('POST', `${API}/containers/create?name=${encodeURIComponent(containerName)}`, createBody)
    if (created.status !== 201 || typeof obj(created.json).Id !== 'string') {
      await request('DELETE', `${API}/volumes/${encodeURIComponent(volumeName)}`).catch(() => undefined)
      throw new Error('创建数据库容器失败')
    }
    const containerId = obj(created.json).Id as string
    const started = await request('POST', `${API}/containers/${encodeURIComponent(containerId)}/start`)
    return { containerId, volumeName, started: started.status === 204 || started.status === 200 }
  }

  async function removeManaged(containerId: string, volumeName: string, engine: Exclude<DatabaseEngine, 'SQLite'>, versionTag: string): Promise<void> {
    let info: Record<string, unknown> | undefined
    try { info = await inspect(containerId) }
    catch (error) {
      if (!(error instanceof InvalidRequestError) || error.status !== 404) throw error
    }
    if (!/^elysian-db-[0-9a-f-]{36}$/.test(volumeName)) throw new InvalidRequestError(409, '数据库持久卷名称无效')
    const volume = await request('GET', `${API}/volumes/${encodeURIComponent(volumeName)}`)
    if (!info && volume.status === 404) return
    const volumeLabels = obj(obj(volume.json).Labels)
    if (volume.status !== 200 || volumeLabels['elysian.database'] !== 'true' ||
        (volumeLabels['elysian.database.engine'] && volumeLabels['elysian.database.engine'] !== engine) ||
        (volumeLabels['elysian.database.version'] && volumeLabels['elysian.database.version'] !== versionTag)) {
      throw new InvalidRequestError(409, '数据库持久卷身份核对失败')
    }
    if (!info) {
      const removedVolume = await request('DELETE', `${API}/volumes/${encodeURIComponent(volumeName)}`)
      if (removedVolume.status !== 204) throw new Error('数据库容器已不存在，但持久卷删除失败')
      return
    }
    const labels = obj(obj(info.Config).Labels)
    const imageId = String(info.Image ?? '').replace(/^sha256:/, '')
    const image = (await listImages()).find((item) => item.id.replace(/^sha256:/, '') === imageId)
    if (labels['elysian.managed'] !== 'true' || labels['elysian.database'] !== 'true' ||
        labels['elysian.database.engine'] !== engine || labels['elysian.database.version'] !== versionTag ||
        labels['elysian.database.volume'] !== volumeName || !image || !databaseImageHasTag(image, engine, versionTag)) {
      throw new InvalidRequestError(409, '容器或持久卷不属于面板管理的数据库')
    }
    const mounted = Array.isArray(info.Mounts) && info.Mounts.some((mount: unknown) => obj(mount).Type === 'volume' && obj(mount).Name === volumeName)
    if (!mounted) throw new InvalidRequestError(409, '容器没有挂载登记的数据库持久卷')
    if (obj(info.State).Running) {
      const stopped = await request('POST', `${API}/containers/${encodeURIComponent(containerId)}/stop?t=10`)
      if (stopped.status !== 204 && stopped.status !== 304) throw new Error('停止数据库容器失败')
    }
    const removed = await request('DELETE', `${API}/containers/${encodeURIComponent(containerId)}?v=false`)
    if (removed.status !== 204) throw new Error('删除数据库容器失败')
    const removedVolume = await request('DELETE', `${API}/volumes/${encodeURIComponent(volumeName)}`)
    if (removedVolume.status !== 204) throw new Error('数据库容器已删除，但持久卷删除失败')
  }

  async function memory(id: string) {
    const response = await request('GET', `${API}/containers/${encodeURIComponent(id)}/stats?stream=false`)
    if (response.status !== 200) return undefined
    const info = obj(response.json)
    const usage = Number(obj(info.memory_stats).usage)
    const limit = Number(obj(info.memory_stats).limit)
    if (!Number.isFinite(usage) || !Number.isFinite(limit) || limit <= 0) return undefined
    return { usedGb: usage / 1024 ** 3, totalGb: limit / 1024 ** 3 }
  }

  return { inspect, assertEngine, address, attach, detach, create, removeManaged, memory }
}

export function databasePort(engine: Exclude<DatabaseEngine, 'SQLite'>): number {
  return PORT[engine]
}
