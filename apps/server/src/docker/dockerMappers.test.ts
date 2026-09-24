import { describe, expect, it } from 'vitest'
import { mapContainer, mapImage } from './dockerMappers'

function baseContainerInspect(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'a1b2c3d4e5f6',
    Name: '/test-container',
    Created: '2024-06-01T10:00:00.000000000Z',
    Image: 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    Path: '/docker-entrypoint.sh',
    Args: ['nginx', '-g', 'daemon off;'],
    State: {
      Status: 'running',
      StartedAt: '2024-06-01T10:01:00.000000000Z',
    },
    Config: {
      Image: 'nginx:1.27-alpine',
      Env: [] as string[],
    },
    HostConfig: {
      PortBindings: {} as Record<string, unknown>,
      RestartPolicy: { Name: 'no' },
    },
    Mounts: [] as unknown[],
    ...overrides,
  }
}

describe('mapContainer', () => {
  it('State.Status 映射为契约状态', () => {
    expect(mapContainer(baseContainerInspect({ State: { Status: 'running' } })).status).toBe(
      'running',
    )
    expect(
      mapContainer(
        baseContainerInspect({ State: { Status: 'restarting', StartedAt: '2024-06-01T10:00:00Z' } }),
      ).status,
    ).toBe('restarting')
    expect(
      mapContainer(
        baseContainerInspect({ State: { Status: 'paused', StartedAt: '2024-06-01T10:00:00Z' } }),
      ).status,
    ).toBe('paused')
    expect(mapContainer(baseContainerInspect({ State: { Status: 'exited' } })).status).toBe(
      'stopped',
    )
    expect(mapContainer(baseContainerInspect({ State: { Status: 'dead' } })).status).toBe(
      'stopped',
    )
  })

  it('HostConfig.PortBindings 合并 0.0.0.0 与 ::，并跳过空 HostPort', () => {
    const mapped = mapContainer(
      baseContainerInspect({
        HostConfig: {
          RestartPolicy: { Name: 'no' },
          PortBindings: {
            '80/tcp': [
              { HostIp: '0.0.0.0', HostPort: '8080' },
              { HostIp: '::', HostPort: '8080' },
            ],
            '443/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
          },
        },
      }),
    )
    expect(mapped.ports).toEqual([
      {
        containerPort: 80,
        hostPort: 8080,
        protocol: 'tcp',
        hostIp: '0.0.0.0',
      },
    ])
  })

  it('Config.Env 敏感键打码，普通键保留原值', () => {
    const mapped = mapContainer(
      baseContainerInspect({
        Config: {
          Image: 'postgres:16',
          Env: ['DB_PASSWORD=secret', 'TZ=Asia/Shanghai'],
        },
      }),
    )
    expect(mapped.env).toEqual([
      { key: 'DB_PASSWORD', value: null },
      { key: 'TZ', value: 'Asia/Shanghai' },
    ])
  })

  it('Mounts 的 bind、volume、tmpfs 三种 Type', () => {
    const mapped = mapContainer(
      baseContainerInspect({
        Mounts: [
          {
            Type: 'bind',
            Source: '/srv/data',
            Destination: '/var/lib/data',
          },
          {
            Type: 'volume',
            Name: 'pgdata',
            Destination: '/var/lib/postgresql/data',
          },
          {
            Type: 'tmpfs',
            Destination: '/tmp/cache',
          },
        ],
      }),
    )
    expect(mapped.volumes).toEqual([
      { hostPath: '/srv/data', containerPath: '/var/lib/data', kind: 'bind' },
      { hostPath: 'pgdata', containerPath: '/var/lib/postgresql/data', kind: 'volume' },
      { hostPath: '', containerPath: '/tmp/cache', kind: 'tmpfs' },
    ])
  })

  it('Path 与 Args 含空格时用单引号拼接命令', () => {
    const mapped = mapContainer(
      baseContainerInspect({
        Path: '/usr/bin/my app',
        Args: ['--config', '/etc/my config.yml'],
      }),
    )
    expect(mapped.command).toBe("'/usr/bin/my app' --config '/etc/my config.yml'")
  })

  it('Name 去掉前导斜杠，Id 去掉 sha256: 前缀', () => {
    const mapped = mapContainer(
      baseContainerInspect({
        Id: 'sha256:abc123def456',
        Name: '/nginx-proxy',
      }),
    )
    expect(mapped.name).toBe('nginx-proxy')
    expect(mapped.id).toBe('abc123def456')
  })
})

function baseImageInspect(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    RepoTags: ['myapp:2.0', 'myapp:1.0'],
    RepoDigests: ['myapp@sha256:digestvalue'],
    Size: 1_500_000,
    Created: '2024-05-01T08:00:00.000000000Z',
    ...overrides,
  }
}

describe('mapImage', () => {
  it('RepoTags 按字典序，第二条进入 otherTags', () => {
    const mapped = mapImage(
      { Id: baseImageInspect().Id },
      baseImageInspect({ RepoTags: ['myapp:2.0', 'myapp:1.0'] }),
    )
    expect(mapped.name).toBe('myapp')
    expect(mapped.tag).toBe('1.0')
    expect(mapped.otherTags).toEqual(['myapp:2.0'])
  })

  it('无 RepoTags 时 name 与 tag 为 <none>', () => {
    const inspect = baseImageInspect({ RepoTags: [] as string[], RepoDigests: [] as string[] })
    const mapped = mapImage({ Id: inspect.Id }, inspect)
    expect(mapped.name).toBe('<none>')
    expect(mapped.tag).toBe('<none>')
  })

  it('Size 四舍五入为 sizeMb，零值 Created 使 pulledAt 为 null', () => {
    const inspect = baseImageInspect({
      Size: 1_500_000,
      Created: '0001-01-01T00:00:00Z',
    })
    const mapped = mapImage({ Id: inspect.Id }, inspect)
    expect(mapped.sizeMb).toBe(2)
    expect(mapped.pulledAt).toBeNull()
  })
})
