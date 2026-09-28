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
  const registry = createMemoryDatabaseRegistry()
  let running = true
  let version = '8.4.7'
  const docker: DatabaseDocker = {
    inspect: vi.fn(async () => ({ Id: CONTAINER_ID, State: { Running: running }, HostConfig: { PortBindings: {} }, Config: { Image: 'mysql:8.4' } })),
    assertEngine: vi.fn(async () => {
      if (!running) throw new Error('容器已停止')
      return { Id: CONTAINER_ID, State: { Running: true }, HostConfig: { PortBindings: {} }, Config: { Image: 'mysql:8.4' } }
    }),
    address: vi.fn(async () => ({ host: '172.28.0.2', port: 0 })),
    attach: vi.fn(async () => { calls.push('attach') }),
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
  const service = createDatabaseService({ registry, docker, protocol, listImages: async () => [IMAGE], listContainers: async () => [{ id: CONTAINER_ID, name: 'mysql-test' }] })
  const input = validateDatabaseCreateRequest({
    engine: 'MySQL', versionTag: '8.4', name: 'orders', user: USER,
    accessScope: 'container-network', target: { kind: 'new', imageId: IMAGE_ID, containerName: 'orders-db' },
  })
  return { service, input, registry, docker, protocol, calls, stop: () => { running = false }, setVersion: (next: string) => { version = next } }
}

describe('数据库服务', () => {
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
    const created = await f.service.create(f.input)
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
    const adopted = await f.service.create({ ...f.input, target: { kind: 'adopt', containerId: CONTAINER_ID, admin: { username: 'root', password: 'existing-secret' } } })
    expect(adopted.source).toBe('adopted')
    expect(f.calls).toContain('attach')
    expect(f.calls).not.toContain('logical-db')
    expect(f.calls).toContain('verify-user')
    await expect(f.service.removeContainer(adopted.id)).rejects.toThrow('面板创建')
  })

  it('普通删除只删除逻辑库，显式删除容器及数据才删除专属卷', async () => {
    const f = fixture()
    const created = await f.service.create(f.input)
    await f.service.remove(created.id)
    expect(f.calls).toContain('drop-db')
    expect(f.calls).not.toContain('remove-container-volume')
    expect((await f.service.list())[0]?.emptyContainer).toBe(true)
    const next = await f.service.create(f.input)
    await f.service.removeContainer(next.id)
    expect(f.calls).toContain('remove-container-volume')
  })

  it('面板创建的空容器仍可承载新逻辑库，无须重复提供管理员密码', async () => {
    const f = fixture()
    const first = await f.service.create(f.input)
    await f.service.remove(first.id)
    const second = await f.service.create({ ...f.input, name: 'new_orders', target: { kind: 'managed', containerId: CONTAINER_ID } })
    expect(second.name).toBe('new_orders')
    expect((await f.service.list()).some((row) => row.emptyContainer)).toBe(false)
  })

  it('容器内有未登记的其他逻辑库时禁止删除专属卷', async () => {
    const f = fixture()
    const created = await f.service.create(f.input)
    vi.mocked(f.protocol.hasOtherDatabases).mockResolvedValue(true)
    await expect(f.service.removeContainer(created.id)).rejects.toThrow('其他数据库')
    expect(f.calls).not.toContain('remove-container-volume')
  })

  it('外部删掉受管容器后仍可清理登记的孤儿卷', async () => {
    const f = fixture()
    const created = await f.service.create(f.input)
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
})
