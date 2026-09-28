import { describe, expect, it } from 'vitest'
import type { DockerTransport } from '../docker/dockerTransport.ts'
import { createDatabaseDocker } from './databaseDocker.ts'

const ID = 'a'.repeat(64)
const IMAGE_ID = `sha256:${'b'.repeat(64)}`

function fixture() {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const transport: DockerTransport = {
    async request(input) {
      calls.push({ method: input.method, path: input.path, body: input.body })
      if (input.path.endsWith('/volumes/create')) return { status: 201, json: {} }
      if (input.path.includes('/containers/create?')) return { status: 201, json: { Id: ID } }
      if (input.path.endsWith('/start')) return { status: 204, json: null }
      if (input.path.endsWith('/json')) return { status: 200, json: { Id: ID, State: { Running: true }, Config: { Image: 'mysql:8.4' }, NetworkSettings: { Networks: { 'elysian-db-local': { IPAddress: '172.28.0.5' } } } } }
      return { status: 204, json: null }
    },
  }
  const docker = createDatabaseDocker(transport, async () => [{ id: IMAGE_ID, name: 'mysql', tag: '8.4', digest: IMAGE_ID, sizeMb: 100, pulledAt: null }])
  return { docker, calls }
}

it('Redis 普通账号 ACL 保存在持久卷内，容器配置不含明文密码', async () => {
  const calls: { path: string; body?: unknown }[] = []
  const transport: DockerTransport = { async request(input) {
    calls.push({ path: input.path, body: input.body })
    if (input.path.endsWith('/volumes/create')) return { status: 201, json: {} }
    if (input.path.includes('/containers/create?')) return { status: 201, json: { Id: ID } }
    return { status: 204, json: null }
  } }
  const docker = createDatabaseDocker(transport, async () => [{ id: IMAGE_ID, name: 'redis', tag: '7.4', digest: IMAGE_ID, sizeMb: 100, pulledAt: null }])
  await docker.create({ engine: 'Redis', versionTag: '7.4', imageId: IMAGE_ID, containerName: 'redis-db', accessScope: 'container-network', bootstrapPassword: 'admin-secret', ordinaryUser: { username: 'reader', password: 'reader-secret-123' } })
  const body = calls.find((call) => call.path.includes('/containers/create?'))?.body as { Cmd: string[]; HostConfig: { Mounts: { Target: string }[] } }
  expect(body.Cmd.join(' ')).toContain('/data/users.acl')
  expect(body.HostConfig.Mounts[0]?.Target).toBe('/data')
  expect(JSON.stringify(body)).not.toContain('reader-secret-123')
  expect(JSON.stringify(body)).not.toContain('admin-secret')
})

describe('detach 将容器移出面板网络', () => {
  function detachFixture(options: { networks?: Record<string, unknown>; inspectStatus?: number; disconnectStatus?: number } = {}) {
    const calls: { method: string; path: string; body?: unknown }[] = []
    const transport: DockerTransport = {
      async request(input) {
        calls.push({ method: input.method, path: input.path, body: input.body })
        if (input.path.endsWith('/json')) {
          return {
            status: options.inspectStatus ?? 200,
            json: {
              Id: ID, State: { Running: true }, Config: { Image: 'mysql:8.4' },
              NetworkSettings: { Networks: options.networks ?? { 'elysian-db-local': { IPAddress: '172.28.0.5' } } },
            },
          }
        }
        if (input.path.endsWith('/disconnect')) return { status: options.disconnectStatus ?? 204, json: null }
        return { status: 204, json: null }
      },
    }
    const docker = createDatabaseDocker(transport, async () => [])
    return { docker, calls }
  }

  it('容器不在该网络上时不发起 disconnect（幂等）', async () => {
    const { docker, calls } = detachFixture()
    await expect(docker.detach(ID, 'elysian-db-shared')).resolves.toBeUndefined()
    expect(calls.some((call) => call.path.endsWith('/disconnect'))).toBe(false)
  })

  it('容器在该网络上时 POST 断开路径且 body 只含容器 ID', async () => {
    const { docker, calls } = detachFixture({ networks: { 'elysian-db-shared': { IPAddress: '172.28.0.9' } } })
    await docker.detach(ID, 'elysian-db-shared')
    const disconnect = calls.find((call) => call.path.endsWith('/disconnect'))
    expect(disconnect).toMatchObject({ method: 'POST', path: '/v1.41/networks/elysian-db-shared/disconnect', body: { Container: ID } })
  })

  it('容器已被外部删除（inspect 404）视为已离网，幂等返回且不发起 disconnect', async () => {
    const { docker, calls } = detachFixture({ inspectStatus: 404 })
    await expect(docker.detach(ID, 'elysian-db-shared')).resolves.toBeUndefined()
    expect(calls.some((call) => call.path.endsWith('/disconnect'))).toBe(false)
  })

  it('disconnect 非 2xx 时抛 409，保留登记供重试', async () => {
    const { docker } = detachFixture({ networks: { 'elysian-db-shared': { IPAddress: '172.28.0.9' } }, disconnectStatus: 500 })
    await expect(docker.detach(ID, 'elysian-db-shared')).rejects.toMatchObject({ status: 409, message: '无法将数据库容器移出面板网络' })
  })

  it('网络名不在面板白名单时抛 400 且不发起任何引擎请求', async () => {
    const { docker, calls } = detachFixture()
    await expect(docker.detach(ID, 'bridge')).rejects.toMatchObject({ status: 400, message: '数据库网络无效' })
    expect(calls).toHaveLength(0)
  })
})

describe('数据库容器资源映射', () => {
  it.each([
    ['localhost', '127.0.0.1', 'elysian-db-local'],
    ['container-network', undefined, 'elysian-db-shared'],
    ['any-host', '0.0.0.0', 'elysian-db-shared'],
  ] as const)('%s 的端口与网络范围对应真实 Docker 配置', async (scope, hostIp, network) => {
    const { docker, calls } = fixture()
    const result = await docker.create({
      engine: 'MySQL', versionTag: '8.4', imageId: IMAGE_ID, containerName: `test-${scope}`,
      accessScope: scope, hostPort: scope === 'any-host' ? 43306 : undefined,
      bootstrapPassword: 'bootstrap-secret', ordinaryUser: { username: 'reader', password: 'strong-password-123' },
    })
    expect(result).toMatchObject({ containerId: ID, started: true })
    const volume = calls.find((call) => call.path.endsWith('/volumes/create'))
    const create = calls.find((call) => call.path.includes('/containers/create?'))
    expect(volume).toBeDefined()
    const body = create?.body as { HostConfig: { NetworkMode: string; Mounts: { Source: string; Target: string }[]; PortBindings?: Record<string, { HostIp: string; HostPort: string }[]> }; Image: string }
    expect(body.Image).toBe('mysql:8.4')
    expect(body.HostConfig.NetworkMode).toBe(network)
    expect(body.HostConfig.Mounts[0]?.Target).toBe('/var/lib/mysql')
    expect(body.HostConfig.Mounts[0]?.Source).toBe(result.volumeName)
    expect(body.HostConfig.PortBindings?.['3306/tcp']?.[0]?.HostIp).toBe(hostIp)
    if (scope === 'any-host') expect(body.HostConfig.PortBindings?.['3306/tcp']?.[0]?.HostPort).toBe('43306')
  })
})
