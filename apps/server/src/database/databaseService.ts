import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseEngine, DatabaseInstance, ContainerImage } from '@elysian/contracts'
import { InvalidRequestError, invalidRequest } from '../shared/errors.ts'
import { databasePort, databaseImageHasTag, imageMatches, validDatabaseVersion, DB_SHARED_NETWORK, type DatabaseDocker } from './databaseDocker.ts'
import type { DatabaseProtocol, DatabaseAddress, DatabaseSession } from './databaseProtocol.ts'
import type { DatabaseRecord, DatabaseRegistry, DatabaseSecret } from './databaseRegistry.ts'

type Engine = Exclude<DatabaseEngine, 'SQLite'>
type DatabaseContainerCandidate = { id: string; name: string; accessScope: string; managed: boolean; versionTag: string }
export type DatabaseCreateRequest = {
  engine: Engine
  versionTag: string
  name: string
  charset?: string
  user: DatabaseSecret
  accessScope: 'localhost' | 'container-network' | 'any-host'
  hostPort?: number
  confirmPublic?: boolean
  target: { kind: 'new'; imageId: string; containerName: string } |
    { kind: 'managed'; containerId: string } |
    { kind: 'adopt'; containerId: string; admin: DatabaseSecret }
}

export type DatabaseService = {
  list(): Promise<DatabaseInstance[]>
  discover(engine: Engine, versionTag?: string): Promise<{ images: readonly ContainerImage[]; containers: DatabaseContainerCandidate[] }>
  create(input: DatabaseCreateRequest): Promise<DatabaseInstance>
  reveal(id: string): Promise<DatabaseSecret>
  remove(id: string): Promise<void>
  removeContainer(id: string): Promise<void>
  reconcile(id: string): Promise<DatabaseInstance>
  forget(id: string): Promise<void>
  openSession(id: string): Promise<DatabaseSession>
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function validSecret(value: unknown, minimumPasswordLength = 1): value is DatabaseSecret {
  const secret = object(value)
  return typeof secret.username === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(secret.username) &&
    typeof secret.password === 'string' && secret.password.length >= minimumPasswordLength && secret.password.length <= 256
}

export function validateDatabaseCreateRequest(input: unknown): DatabaseCreateRequest {
  const row = object(input)
  if (row.engine !== 'MariaDB' && row.engine !== 'MySQL' && row.engine !== 'Redis') throw invalidRequest('数据库引擎不受支持')
  if (typeof row.versionTag !== 'string' || !validDatabaseVersion(row.versionTag)) throw invalidRequest('必须指定明确的数据库版本标签')
  if (typeof row.name !== 'string' || (row.engine === 'Redis' ? row.name !== '0' : !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(row.name))) throw invalidRequest('数据库名无效')
  const target = object(row.target)
  if (!validSecret(row.user, target.kind === 'new' ? 12 : 1)) throw invalidRequest('普通账号或密码无效')
  if (row.user.username === (row.engine === 'Redis' ? 'default' : 'root')) throw invalidRequest('普通账号不得使用管理员账号名')
  if (row.accessScope !== 'localhost' && row.accessScope !== 'container-network' && row.accessScope !== 'any-host') throw invalidRequest('访问范围无效')
  if (target.kind === 'new') {
    if (typeof target.imageId !== 'string' || typeof target.containerName !== 'string') throw invalidRequest('创建容器参数无效')
    if (row.accessScope === 'any-host' && (!Number.isInteger(row.hostPort) || Number(row.hostPort) < 1 || Number(row.hostPort) > 65535)) throw invalidRequest('任意主机访问必须指定宿主端口')
    if (row.accessScope === 'any-host' && row.confirmPublic !== true) throw invalidRequest('任意主机访问必须再次确认')
  } else if (target.kind === 'adopt' || target.kind === 'managed') {
    if (typeof target.containerId !== 'string' || (target.kind === 'adopt' && !validSecret(target.admin))) throw invalidRequest('接管容器参数或管理员账号无效')
  } else throw invalidRequest('必须指定新建或接管容器')
  if (row.engine !== 'Redis' && row.charset !== undefined && !['utf8mb4', 'utf8', 'latin1'].includes(String(row.charset))) throw invalidRequest('字符集无效')
  return row as DatabaseCreateRequest
}

function actualVersionMatches(tag: string, version: string): boolean {
  return version === tag || version.startsWith(`${tag}.`) || version.startsWith(`${tag}-`)
}

function accessScopeFromInspect(info: Record<string, unknown>, engine: Engine): 'localhost' | 'container-network' | 'any-host' {
  const bindings = object(object(info.HostConfig).PortBindings)
  const mapping = bindings[`${databasePort(engine)}/tcp`]
  const hostIp = Array.isArray(mapping) ? object(mapping[0]).HostIp : undefined
  return hostIp === '0.0.0.0' || hostIp === '::' || hostIp === '' ? 'any-host' : hostIp === '127.0.0.1' || hostIp === '::1' ? 'localhost' : 'container-network'
}

export function createDatabaseService(deps: {
  registry: DatabaseRegistry
  docker: DatabaseDocker
  protocol: DatabaseProtocol
  listImages(): Promise<readonly ContainerImage[]>
  listContainers(): Promise<readonly { id: string; name: string }[]>
  selfContainerId?: string
}): DatabaseService {
  const { registry, docker, protocol } = deps
  const inProgress = new Set<string>()

  async function record(id: string) {
    const found = (await registry.list()).find((row) => row.id === id)
    if (!found) throw new InvalidRequestError(404, '数据库不存在')
    return found
  }

  async function address(row: DatabaseRecord): Promise<DatabaseAddress> {
    await docker.assertEngine(row.containerId, row.engine, row.versionTag)
    const result = await docker.address(row.containerId)
    return { ...result, port: databasePort(row.engine) }
  }

  async function checked(row: DatabaseRecord) {
    const endpoint = await address(row)
    const version = await protocol.version(row, endpoint, row.admin)
    if (!actualVersionMatches(row.versionTag, version)) throw new InvalidRequestError(409, '数据库实际版本与登记版本不一致')
    await protocol.verify(row, endpoint)
    return { endpoint, version }
  }

  async function projection(row: DatabaseRecord): Promise<DatabaseInstance> {
    if (row.state === 'empty') {
      let status: DatabaseInstance['status'] = 'warning'
      try { await docker.assertEngine(row.containerId, row.engine, row.versionTag) }
      catch { status = 'stopped' }
      return {
        id: row.id, engine: row.engine, name: `空容器（原 ${row.name}）`, version: row.versionTag,
        status, containerId: row.containerId, source: 'managed', versionTag: row.versionTag,
        accessScope: row.accessScope, volumeName: row.volumeName,
        hasCredentials: false, emptyContainer: true,
        metricsError: '逻辑库已删除；容器与持久卷仍保留，可在此容器新建库或显式删除容器及数据。',
        updatedAt: row.createdAt,
      }
    }
    let status: DatabaseInstance['status'] = 'running'
    let version = row.versionTag
    let metricsError: string | undefined
    let storage: DatabaseInstance['storage']
    let memory: DatabaseInstance['memory']
    let connections: DatabaseInstance['connections']
    try {
      const result = await checked(row)
      version = result.version
      const [sample, mem] = await Promise.all([protocol.metrics(row, result.endpoint), docker.memory(row.containerId)])
      if (sample.sizeGb !== undefined) storage = { usedGb: sample.sizeGb, totalGb: 0 }
      if (mem) memory = mem
      if (sample.connections) connections = sample.connections
    } catch (error) {
      status = 'stopped'
      metricsError = error instanceof Error ? error.message : '数据库无法连接'
    }
    if (row.state === 'needs-attention') status = 'warning'
    return {
      id: row.id, engine: row.engine, name: row.name, version, status,
      containerId: row.containerId, source: row.source, versionTag: row.versionTag,
      accessScope: row.accessScope, volumeName: row.volumeName,
      credentialUsername: row.user.username, hasCredentials: true,
      storage, memory, connections, metricsError, updatedAt: row.createdAt,
      needsAttention: row.state === 'needs-attention',
    }
  }

  async function discover(engine: Engine, versionTag?: string) {
    if (versionTag !== undefined && !validDatabaseVersion(versionTag)) throw invalidRequest('必须指定明确版本')
    const allImages = await deps.listImages()
    const imageTags = (image: ContainerImage): string[] => [
      `${image.name}:${image.tag}`,
      ...(image.otherTags ?? []),
    ].flatMap((ref) => {
      const colon = ref.lastIndexOf(':')
      const name = ref.slice(0, colon)
      const tag = ref.slice(colon + 1)
      return colon > 0 && imageMatches(engine, name) && validDatabaseVersion(tag) ? [tag] : []
    })
    const images = allImages.filter((image) => versionTag === undefined
      ? imageTags(image).length > 0
      : databaseImageHasTag(image, engine, versionTag))
    const containers: DatabaseContainerCandidate[] = []
    const registered = await registry.list()
    for (const container of await deps.listContainers()) {
      if (container.id === deps.selfContainerId) continue
      try {
        if (engine === 'Redis' && registered.some((row) => row.containerId === container.id && row.engine === 'Redis')) continue
        const inspected = await docker.inspect(container.id)
        if (!object(inspected.State).Running) continue
        const managedRow = registered.find((row) => row.containerId === container.id && row.source === 'managed' && row.engine === engine)
        const ref = String(object(inspected.Config).Image ?? '')
        const colon = ref.lastIndexOf(':')
        const refTag = colon > 0 && imageMatches(engine, ref.slice(0, colon)) && validDatabaseVersion(ref.slice(colon + 1))
          ? ref.slice(colon + 1) : undefined
        const matchingImages = allImages.filter((image) => image.id.replace(/^sha256:/, '') === String(inspected.Image ?? '').replace(/^sha256:/, ''))
        const tags = [...new Set(matchingImages.flatMap(imageTags))]
        const candidateTag = versionTag ?? managedRow?.versionTag ?? refTag ?? (tags.length === 1 ? tags[0] : undefined)
        if (!candidateTag || !validDatabaseVersion(candidateTag)) continue
        const info = await docker.assertEngine(container.id, engine, candidateTag)
        containers.push({ id: container.id, name: container.name, accessScope: accessScopeFromInspect(info, engine), managed: Boolean(managedRow), versionTag: candidateTag })
      } catch { /* 其他引擎或停止的容器不作为接管候选。 */ }
    }
    return { images, containers }
  }

  async function create(input: DatabaseCreateRequest): Promise<DatabaseInstance> {
    const key = `${input.engine}:${input.name}:${input.target.kind === 'new' ? input.target.containerName : input.target.containerId}`
    if (inProgress.has(key)) throw new InvalidRequestError(409, '相同数据库正在创建')
    inProgress.add(key)
    try {
      const rows = await registry.list()
      const targetContainerId = input.target.kind === 'new' ? undefined : input.target.containerId
      if (targetContainerId && rows.some((row) => row.state !== 'empty' && row.engine === input.engine &&
        row.name === input.name && row.containerId === targetContainerId)) {
        throw new InvalidRequestError(409, '数据库已登记')
      }
      if (input.engine === 'Redis' && targetContainerId && rows.some((row) => row.containerId === targetContainerId)) {
        throw new InvalidRequestError(409, 'Redis DB 0 已登记')
      }
      if (input.target.kind === 'adopt' && input.target.containerId === deps.selfContainerId) throw new InvalidRequestError(403, '不能接管面板自身容器')
      let containerId: string
      let volumeName: string | undefined
      let admin: DatabaseSecret
      let started = true
      let actualScope = input.accessScope
      if (input.target.kind === 'new') {
        admin = { username: input.engine === 'Redis' ? 'default' : 'root', password: randomBytes(32).toString('base64url') }
        const created = await docker.create({
          engine: input.engine, versionTag: input.versionTag, imageId: input.target.imageId,
          containerName: input.target.containerName, accessScope: input.accessScope,
          hostPort: input.hostPort, bootstrapPassword: admin.password,
          ordinaryUser: input.user,
        })
        containerId = created.containerId
        volumeName = created.volumeName
        started = created.started
      } else if (input.target.kind === 'managed') {
        const existing = rows.find((row) => row.containerId === targetContainerId && row.source === 'managed')
        if (!existing || existing.engine !== input.engine || existing.versionTag !== input.versionTag) throw new InvalidRequestError(409, '容器不是同版本的面板受管数据库')
        containerId = existing.containerId
        volumeName = existing.volumeName
        admin = existing.admin
        const info = await docker.assertEngine(containerId, input.engine, input.versionTag)
        actualScope = accessScopeFromInspect(info, input.engine)
      } else {
        containerId = input.target.containerId
        admin = input.target.admin
        const info = await docker.assertEngine(containerId, input.engine, input.versionTag)
        actualScope = accessScopeFromInspect(info, input.engine)
        await docker.attach(containerId, 'elysian-db-shared')
      }
      const row: DatabaseRecord = {
        id: randomUUID(), engine: input.engine, name: input.name, versionTag: input.versionTag,
        containerId, volumeName, source: input.target.kind === 'adopt' ? 'adopted' : 'managed',
        accessScope: actualScope, admin, user: input.user,
        createdAt: new Date().toISOString(), state: 'needs-attention',
      }
      // 容器已产生后先登记待处理状态，后续任何失败都能在页面找到恢复入口。
      await registry.put(row)
      try {
        if (!started) throw new Error('容器启动失败；可在容器页修复后重新核对')
        let endpoint: DatabaseAddress | undefined
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            endpoint = await address(row)
            const actual = await protocol.version(row, endpoint, row.admin)
            if (!actualVersionMatches(row.versionTag, actual)) throw new InvalidRequestError(409, '数据库实际版本与所选版本不一致')
            break
          } catch (error) {
            if (error instanceof InvalidRequestError && error.message.includes('版本')) throw error
            if (attempt === 19) throw error
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
        }
        if (!endpoint) throw new Error('数据库连接地址不可用')
        if (input.target.kind !== 'adopt') await protocol.create(row, endpoint, input.charset)
        await protocol.verify(row, endpoint)
        row.state = 'active'
        await registry.put(row)
        for (const old of rows.filter((item) => item.state === 'empty' && item.containerId === row.containerId)) await registry.remove(old.id)
        return projection(row)
      } catch (error) {
        throw new Error(`数据库创建未完成；容器 ${containerId.slice(0, 12)} 已登记为待处理：${error instanceof Error ? error.message : '未知错误'}`)
      }
    } finally { inProgress.delete(key) }
  }

  async function list() { return Promise.all((await registry.list()).map(projection)) }

  async function reveal(id: string) {
    const row = await record(id)
    if (row.state === 'empty') throw new InvalidRequestError(409, '空容器没有数据库普通账号')
    await checked(row)
    return { ...row.user }
  }

  async function remove(id: string) {
    const row = await record(id)
    if (row.state === 'empty') throw new InvalidRequestError(409, '逻辑库已删除；请使用容器及数据删除操作')
    let endpoint: DatabaseAddress
    try {
      endpoint = await address(row)
    } catch (error) {
      if (!(error instanceof InvalidRequestError) || error.status !== 404) throw error
      // 容器已被外部删除（managed 或 adopted 同理）：逻辑库无从删除，登记只剩僵尸卡片。
      // 跳过 drop，参照 forget 先例保留幂等 detach（最后一个接管登记仍尝试撤出面板网络）后直接清理登记。
      if (row.source === 'adopted' && !(await registry.list()).some((item) => item.containerId === row.containerId && item.id !== id)) {
        await docker.detach(row.containerId, DB_SHARED_NETWORK)
      }
      await registry.remove(id)
      return
    }
    const version = await protocol.version(row, endpoint, row.admin)
    if (!actualVersionMatches(row.versionTag, version)) throw new InvalidRequestError(409, '数据库实际版本与登记版本不一致')
    await protocol.drop(row, endpoint)
    if (row.engine === 'Redis') return
    const rows = await registry.list()
    const siblings = rows.filter((item) => item.containerId === row.containerId && item.id !== id && item.state !== 'empty')
    if (row.source === 'managed' && siblings.length === 0) {
      row.state = 'empty'
      await registry.put(row)
    } else {
      // 接管的容器只在其上最后一个登记被移除时才撤出面板网络；同容器还有任何登记（含空容器登记）都不撤。
      if (row.source === 'adopted' && !rows.some((item) => item.containerId === row.containerId && item.id !== id)) {
        await docker.detach(row.containerId, DB_SHARED_NETWORK)
      }
      await registry.remove(id)
    }
  }

  async function removeContainer(id: string) {
    const row = await record(id)
    if (row.source !== 'managed' || !row.volumeName) throw new InvalidRequestError(403, '只能删除面板创建的数据库容器和专属卷')
    const siblings = (await registry.list()).filter((item) => item.containerId === row.containerId && item.id !== id)
    if (siblings.length) throw new InvalidRequestError(409, '容器中还有其他已登记数据库')
    try {
      const endpoint = await address(row)
      const actualVersion = await protocol.version(row, endpoint, row.admin)
      if (!actualVersionMatches(row.versionTag, actualVersion)) throw new InvalidRequestError(409, '数据库实际版本与登记版本不一致')
      if (await protocol.hasOtherDatabases(row, endpoint)) throw new InvalidRequestError(409, '容器中还有其他数据库，不能删除容器和持久卷')
    } catch (error) {
      if (!(error instanceof InvalidRequestError) || error.status !== 404) throw error
    }
    // 外部删除容器或删除卷阶段失败后，允许再次提交以清理登记的专属孤儿卷。
    await docker.removeManaged(row.containerId, row.volumeName, row.engine, row.versionTag)
    await registry.remove(id)
  }

  async function openSession(id: string) {
    const row = await record(id)
    if (row.state === 'empty') throw new InvalidRequestError(409, '空容器没有可连接的逻辑库')
    const { endpoint } = await checked(row)
    return protocol.session(row, endpoint)
  }

  async function reconcile(id: string) {
    const row = await record(id)
    if (row.state === 'empty') throw new InvalidRequestError(409, '空容器没有可核对的逻辑库')
    await checked(row)
    row.state = 'active'
    await registry.put(row)
    return projection(row)
  }

  async function forget(id: string) {
    const row = await record(id)
    if (row.source !== 'adopted' || row.state !== 'needs-attention') {
      throw new InvalidRequestError(409, '只允许移除接管失败的待处理登记')
    }
    // 撤销接管失败留下的网络副作用；容器已被外部删除时 detach 幂等返回，移除登记不被卡死。
    await docker.detach(row.containerId, DB_SHARED_NETWORK)
    await registry.remove(id)
  }

  return { list, discover, create, reveal, remove, removeContainer, reconcile, forget, openSession }
}
