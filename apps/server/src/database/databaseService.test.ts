import { describe, expect, it, vi } from 'vitest'
import type { ContainerImage } from '@elysian/contracts'
import { createMemoryDatabaseRegistry } from './databaseRegistry.ts'
import type { DatabaseDocker } from './databaseDocker.ts'
import type { DatabaseProtocol } from './databaseProtocol.ts'
import { createDatabaseService, validateDatabaseCreateRequest } from './databaseService.ts'
import { InvalidRequestError } from '../shared/errors.ts'

const CONTAINER_ID = 'a'.repeat(64)
const IMAGE_ID = `sha256:${'b'.repeat(64)}`
const IMAGE: ContainerImage = { id: IMAGE_ID, name: 'mysql', tag: '8.4', digest: IMAGE_ID, sizeMb: 100, pulledAt: null }
const USER = { username: 'reader', password: 'strong-password-123' }

function fixture() {
  const calls: string[] = []
  const portOpens: Array<{ port: number; note: string }> = []
  const registry = createMemoryDatabaseRegistry()
  let running = true
  let version = '8.4.7'
  const docker: DatabaseDocker = {
    inspect: vi.fn(async () => ({ Id: CONTAINER_ID, Image: IMAGE_ID, State: { Running: running }, HostConfig: { PortBindings: {} }, Config: { Image: 'mysql:8.4' } })),
    assertEngine: vi.fn(async (_id, engine, tag) => {
      if (!running) throw new Error('容器已停止')
      if (engine !== 'MySQL' || tag !== '8.4') throw new Error('容器镜像与所选引擎或版本不一致')
      return { Id: CONTAINER_ID, Image: IMAGE_ID, State: { Running: true }, HostConfig: { PortBindings: {} }, Config: { Image: 'mysql:8.4' } }
    }),
    address: vi.fn(async () => ({ host: '172.28.0.2', port: 0 })),
    attach: vi.fn(async () => { calls.push('attach') }),
    detach: vi.fn(async () => { calls.push('detach') }),
    create: vi.fn(async () => { calls.push('container'); return { containerId: CONTAINER_ID, volumeName: 'elysian-db-volume', started: true } }),
    removeManaged: vi.fn(async () => { calls.push('remove-container-volume') }),
    memory: vi.fn(async () => ({ usedGb: 0.1, totalGb: 1 })),
  }
  const protocol: DatabaseProtocol = {
    version: vi.fn(async () => version),
    create: vi.fn(async () => { calls.push('logical-db') }),
    verify: vi.fn(async () => { calls.push('verify-user') }),
    drop: vi.fn(async () => { calls.push('drop-db') }),
    hasOtherDatabases: vi.fn(async () => false),
    metrics: vi.fn(async () => ({ sizeGb: 0.01, connections: { active: 1, max: 100 } })),
    session: vi.fn(async () => ({ execute: async () => ['OK'], close: async () => undefined })),
  }
  const service = createDatabaseService({ registry, docker, protocol, listImages: async () => [IMAGE], listContainers: async () => [{ id: CONTAINER_ID, name: 'mysql-test' }],
    openFirewallPort: async (port, note) => { portOpens.push({ port, note }); return { state: 'opened', port, detail: null } } })
  const input = validateDatabaseCreateRequest({
    engine: 'MySQL', versionTag: '8.4', name: 'orders', user: USER,
    accessScope: 'container-network', target: { kind: 'new', imageId: IMAGE_ID, containerName: 'orders-db' },
  })
  return { service, input, registry, docker, protocol, calls, portOpens, stop: () => { running = false }, setVersion: (next: string) => { version = next } }
}

function adoptInput() {
  return validateDatabaseCreateRequest({
    engine: 'MySQL', versionTag: '8.4', name: 'orders', user: USER,
    accessScope: 'container-network',
    target: { kind: 'adopt', containerId: CONTAINER_ID, admin: { username: 'root', password: 'existing-secret' } },
  })
}

describe('数据库服务', () => {
  it('按引擎发现运行中的明确版本容器；停止、错误引擎和不匹配版本不可选', async () => {
    const f = fixture()
    expect((await f.service.discover('MySQL')).containers).toEqual([{
      id: CONTAINER_ID, name: 'mysql-test', accessScope: 'container-network', managed: false, versionTag: '8.4',
    }])
    expect((await f.service.discover('MySQL', '8.4')).images).toHaveLength(1)
    expect((await f.service.discover('MySQL', '8.0')).containers).toHaveLength(0)
    expect((await f.service.discover('MariaDB')).containers).toHaveLength(0)
    f.stop()
    expect((await f.service.discover('MySQL')).containers).toHaveLength(0)
  })

  it('已登记的 Redis DB 0 容器不再作为添加候选', async () => {
    const f = fixture()
    const redisImage: ContainerImage = { ...IMAGE, name: 'redis', tag: '7.4' }
    const info = { Id: CONTAINER_ID, Image: IMAGE_ID, State: { Running: true }, HostConfig: { PortBindings: {} }, Config: { Image: 'redis:7.4' } }
    const docker: DatabaseDocker = {
      ...f.docker,
      inspect: vi.fn(async () => info),
      assertEngine: vi.fn(async () => info),
    }
    const service = createDatabaseService({
      registry: f.registry, docker, protocol: f.protocol,
      listImages: async () => [redisImage],
      listContainers: async () => [{ id: CONTAINER_ID, name: 'redis-test' }],
    })
    expect((await service.discover('Redis')).containers).toHaveLength(1)
    await f.registry.put({
      id: 'redis-db0', engine: 'Redis', name: '0', versionTag: '7.4', containerId: CONTAINER_ID,
      source: 'managed', accessScope: 'localhost', admin: { username: 'default', password: 'admin-secret' },
      user: USER, createdAt: '2026-09-28T00:00:00.000Z', state: 'active',
    })
    expect((await service.discover('Redis')).containers).toHaveLength(0)
  })

  it('要求明确版本和公网确认', () => {
    expect(() => validateDatabaseCreateRequest({ engine: 'MySQL', versionTag: 'latest' })).toThrow('版本')
    const base = fixture().input
    expect(() => validateDatabaseCreateRequest({ ...base, accessScope: 'any-host', hostPort: 3306 })).toThrow('再次确认')
    expect(validateDatabaseCreateRequest({ ...base, accessScope: 'any-host', hostPort: 3306, confirmPublic: true }).hostPort).toBe(3306)
    expect(() => validateDatabaseCreateRequest({ ...base, engine: 'Redis', name: '0', user: { username: 'default', password: USER.password } })).toThrow('管理员')
  })

  it('缺镜像由发现接口反映；创建后先有容器与卷再建逻辑库，列表不含密码', async () => {
    const f = fixture()
    expect((await f.service.discover('MySQL', '8.4')).images).toHaveLength(1)
    const created = (await f.service.create(f.input)).instance
    expect(f.calls.slice(0, 3)).toEqual(['container', 'logical-db', 'verify-user'])
    expect(created.source).toBe('managed')
    expect(created.volumeName).toBe('elysian-db-volume')
    const serialized = JSON.stringify(await f.service.list())
    expect(serialized).not.toContain(USER.password)
    expect(serialized).not.toContain('strong-password')
    expect(await f.service.reveal(created.id)).toEqual(USER)
  })

  it('接管已有容器先接入面板网络并验证已有普通账号，不创建账号', async () => {
    const f = fixture()
    const adopted = (await f.service.create({ ...f.input, target: { kind: 'adopt', containerId: CONTAINER_ID, admin: { username: 'root', password: 'existing-secret' } } })).instance
    expect(adopted.source).toBe('adopted')
    expect(f.calls).toContain('attach')
    expect(f.calls).not.toContain('logical-db')
    expect(f.calls).toContain('verify-user')
    await expect(f.service.removeContainer(adopted.id)).rejects.toThrow('面板创建')
  })

  it('普通删除只删除逻辑库，显式删除容器及数据才删除专属卷', async () => {
    const f = fixture()
    const created = (await f.service.create(f.input)).instance
    await f.service.remove(created.id)
    expect(f.calls).toContain('drop-db')
    expect(f.calls).not.toContain('remove-container-volume')
    expect((await f.service.list())[0]?.emptyContainer).toBe(true)
    const next = (await f.service.create(f.input)).instance
    await f.service.removeContainer(next.id)
    expect(f.calls).toContain('remove-container-volume')
  })

  it('面板创建的空容器仍可承载新逻辑库，无须重复提供管理员密码', async () => {
    const f = fixture()
    const first = (await f.service.create(f.input)).instance
    await f.service.remove(first.id)
    const second = (await f.service.create({ ...f.input, name: 'new_orders', target: { kind: 'managed', containerId: CONTAINER_ID } })).instance
    expect(second.name).toBe('new_orders')
    expect((await f.service.list()).some((row) => row.emptyContainer)).toBe(false)
  })

  it('容器内有未登记的其他逻辑库时禁止删除专属卷', async () => {
    const f = fixture()
    const created = (await f.service.create(f.input)).instance
    vi.mocked(f.protocol.hasOtherDatabases).mockResolvedValue(true)
    await expect(f.service.removeContainer(created.id)).rejects.toThrow('其他数据库')
    expect(f.calls).not.toContain('remove-container-volume')
  })

  it('外部删掉受管容器后仍可清理登记的孤儿卷', async () => {
    const f = fixture()
    const created = (await f.service.create(f.input)).instance
    vi.mocked(f.docker.assertEngine).mockRejectedValue(new InvalidRequestError(404, '数据库容器已不存在'))
    await f.service.removeContainer(created.id)
    expect(f.calls).toContain('remove-container-volume')
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('外部停机和版本漂移反映为卡片异常；失败创建留待处理登记', async () => {
    const f = fixture()
    await f.service.create(f.input)
    f.stop()
    const [stopped] = await f.service.list()
    expect(stopped?.status).toBe('stopped')
    expect(stopped?.metricsError).toContain('容器已停止')
    const g = fixture()
    g.setVersion('9.0.0')
    await expect(g.service.create(g.input)).rejects.toThrow('待处理')
    expect((await g.registry.list())[0]?.state).toBe('needs-attention')
  })

  it('接管失败后的 forget 会把容器移出面板网络并清空登记', async () => {
    const f = fixture()
    f.setVersion('9.0.0')
    await expect(f.service.create(adoptInput())).rejects.toThrow('待处理')
    const [row] = await f.registry.list()
    await f.service.forget(row!.id)
    expect(f.docker.detach).toHaveBeenCalledWith(CONTAINER_ID, 'elysian-db-shared')
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('容器已被外部删除时 forget 仍清空登记、不抛错', async () => {
    const f = fixture()
    f.setVersion('9.0.0')
    await expect(f.service.create(adoptInput())).rejects.toThrow('待处理')
    const [row] = await f.registry.list()
    // 容器已消失：真实 detach 对 inspect 404 幂等返回（见 databaseDocker.test.ts），不得堵死登记移除。
    vi.mocked(f.docker.inspect).mockRejectedValue(new InvalidRequestError(404, '数据库容器已不存在'))
    await expect(f.service.forget(row!.id)).resolves.toBeUndefined()
    expect(f.docker.detach).toHaveBeenCalledWith(CONTAINER_ID, 'elysian-db-shared')
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('接管成功后删除逻辑库时移出面板网络并移除登记', async () => {
    const f = fixture()
    const adopted = (await f.service.create(adoptInput())).instance
    await f.service.remove(adopted.id)
    expect(f.docker.detach).toHaveBeenCalledWith(CONTAINER_ID, 'elysian-db-shared')
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('接管容器被外部删除后 remove 仍清空登记、不抛错', async () => {
    const f = fixture()
    const adopted = (await f.service.create(adoptInput())).instance
    // 容器已被外部删除：address 阶段 assertEngine 抛 404，remove 不得堵死成永久僵尸登记。
    vi.mocked(f.docker.assertEngine).mockRejectedValue(new InvalidRequestError(404, '数据库容器已不存在'))
    await expect(f.service.remove(adopted.id)).resolves.toBeUndefined()
    expect(f.protocol.drop).not.toHaveBeenCalled()
    // detach 对已删容器幂等（见 databaseDocker.ts 的 forget 先例），最后一个登记仍尝试撤出面板网络。
    expect(f.docker.detach).toHaveBeenCalledWith(CONTAINER_ID, 'elysian-db-shared')
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('受管容器被外部删除后 remove 同样清空登记、不转为空容器', async () => {
    const f = fixture()
    const created = (await f.service.create(f.input)).instance
    vi.mocked(f.docker.assertEngine).mockRejectedValue(new InvalidRequestError(404, '数据库容器已不存在'))
    await expect(f.service.remove(created.id)).resolves.toBeUndefined()
    expect(f.protocol.drop).not.toHaveBeenCalled()
    expect(f.docker.detach).not.toHaveBeenCalled()
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('容器仅停止时 remove 仍按原错误上抛、保留登记', async () => {
    const f = fixture()
    const created = (await f.service.create(f.input)).instance
    f.stop()
    await expect(f.service.remove(created.id)).rejects.toThrow('容器已停止')
    expect(await f.registry.list()).toHaveLength(1)
  })

  it('同容器多接管库时仅移除最后一个登记才断开面板网络', async () => {
    const f = fixture()
    const first = (await f.service.create(adoptInput())).instance
    const second = (await f.service.create({ ...adoptInput(), name: 'reports' })).instance
    await f.service.remove(first.id)
    expect(f.docker.detach).not.toHaveBeenCalled()
    expect(await f.registry.list()).toHaveLength(1)
    await f.service.remove(second.id)
    expect(f.docker.detach).toHaveBeenCalledWith(CONTAINER_ID, 'elysian-db-shared')
    expect(await f.registry.list()).toHaveLength(0)
  })

  it('面板创建的受管库删除与删容器全程不移出面板网络', async () => {
    const f = fixture()
    const created = (await f.service.create(f.input)).instance
    await f.service.remove(created.id)
    await f.service.removeContainer((await f.registry.list())[0]!.id)
    expect(f.docker.detach).not.toHaveBeenCalled()
  })

  it('任意主机访问的新建库自动开放防火墙端口；其他范围与接管不触发', async () => {
    const f = fixture()
    const anyHost = await f.service.create({ ...f.input, accessScope: 'any-host', hostPort: 13306, confirmPublic: true })
    expect(anyHost.firewallPort).toEqual({ state: 'opened', port: 13306, detail: null })
    expect(f.portOpens).toEqual([{ port: 13306, note: 'Elysian 数据库 orders' }])

    const local = await f.service.create({ ...f.input, name: 'inner' })
    expect(local.firewallPort).toBeNull()
    expect(f.portOpens).toHaveLength(1)

    const adopted = await f.service.create({ ...f.input, name: 'taken', target: { kind: 'adopt', containerId: CONTAINER_ID, admin: { username: 'root', password: 'existing-secret' } } })
    expect(adopted.firewallPort).toBeNull()
    expect(f.portOpens).toHaveLength(1)
  })

  it('开口失败不影响数据库创建成功：结果如实带回', async () => {
    const registry = createMemoryDatabaseRegistry()
    const f = fixture()
    const service = createDatabaseService({ registry, docker: f.docker, protocol: f.protocol, listImages: async () => [IMAGE], listContainers: async () => [],
      openFirewallPort: async (port) => ({ state: 'failed', port, detail: '端口规则已达上限（最多 200 条）' }) })
    const result = await service.create({ ...f.input, accessScope: 'any-host', hostPort: 13307, confirmPublic: true })
    expect(result.instance.source).toBe('managed')
    expect(result.firewallPort).toEqual({ state: 'failed', port: 13307, detail: '端口规则已达上限（最多 200 条）' })
  })
})
