import { describe, expect, it } from 'vitest'
import { InvalidRequestError } from '../shared/errors.ts'
import { buildCreateSpec, SYMLINK_MOUNT_MESSAGE } from './createSpec.ts'

const IMAGE_HEX = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
const IMAGE_ID = `sha256:${IMAGE_HEX}`
const MOUNT_ROOT = '/srv/elysian'

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    imageId: IMAGE_ID,
    ports: [] as unknown[],
    env: [] as unknown[],
    volumes: [] as unknown[],
    restartPolicy: 'no',
    ...overrides,
  }
}

function baseContext(overrides: Partial<Parameters<typeof buildCreateSpec>[0]> = {}) {
  const existing = new Set<string>([MOUNT_ROOT, `${MOUNT_ROOT}/data`])
  return {
    images: [{ id: IMAGE_ID, name: 'redis' }],
    containers: [] as { name: string; ports: { hostPort: number; protocol: string; hostIp?: string }[] }[],
    mountRoot: MOUNT_ROOT,
    reservedPorts: [48100] as const,
    realpath: async (path: string) => {
      if (path.includes('/symlink')) {
        throw new InvalidRequestError(400, SYMLINK_MOUNT_MESSAGE)
      }
      if (path === '/etc') return '/etc'
      if (existing.has(path)) return path
      const err = new Error('ENOENT') as Error & { code: string }
      err.code = 'ENOENT'
      throw err
    },
    ...overrides,
  }
}

async function expectStatus(
  run: () => Promise<unknown>,
  status: number,
  message?: string | RegExp,
) {
  try {
    await run()
    throw new Error('expected rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidRequestError)
    const err = error as InvalidRequestError
    expect(err.status).toBe(status)
    if (message !== undefined) {
      if (typeof message === 'string') expect(err.message).toBe(message)
      else expect(err.message).toMatch(message)
    }
  }
}

describe('buildCreateSpec', () => {
  it('重名 409', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({ name: 'nginx-proxy' }),
          ...baseContext({
            containers: [{ name: 'nginx-proxy', ports: [] }],
          }),
        }),
      409,
      '容器名称已存在：nginx-proxy',
    )
  })

  it('未知镜像 400', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({ imageId: IMAGE_HEX }),
          ...baseContext({ images: [] }),
        }),
      400,
      '镜像不存在，无法创建容器',
    )
  })

  it('端口超过 32 条 400', async () => {
    const ports = Array.from({ length: 33 }, (_, index) => ({
      containerPort: 8000 + index,
      hostPort: 18000 + index,
      protocol: 'tcp',
    }))
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({ ports }),
          ...baseContext(),
        }),
      400,
      '端口映射不能超过 32 条',
    )
  })

  it('hostIp 为 10.0.0.1 时 400', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({
            ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp', hostIp: '10.0.0.1' }],
          }),
          ...baseContext(),
        }),
      400,
      'hostIp 只允许 127.0.0.1 或 0.0.0.0',
    )
  })

  it('保留端口 48100 400', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({
            ports: [{ containerPort: 48100, hostPort: 48100, protocol: 'tcp' }],
          }),
          ...baseContext(),
        }),
      400,
      '宿主端口为面板保留：48100',
    )
  })

  it('0.0.0.0:80/tcp 与已有 127.0.0.1:80/tcp 冲突', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({
            ports: [{ containerPort: 80, hostPort: 80, protocol: 'tcp', hostIp: '0.0.0.0' }],
          }),
          ...baseContext({
            containers: [
              {
                name: 'web',
                ports: [{ hostPort: 80, protocol: 'tcp', hostIp: '127.0.0.1' }],
              },
            ],
          }),
        }),
      400,
      '宿主端口已被占用：80/tcp',
    )
  })

  it('80/udp 不与 80/tcp 冲突', async () => {
    const result = await buildCreateSpec({
      body: baseBody({
        ports: [{ containerPort: 80, hostPort: 80, protocol: 'udp' }],
      }),
      ...baseContext({
        containers: [
          {
            name: 'web',
            ports: [{ hostPort: 80, protocol: 'tcp', hostIp: '127.0.0.1' }],
          },
        ],
      }),
    })
    expect(result.createBody.HostConfig).toMatchObject({
      PortBindings: { '80/udp': [{ HostPort: '80', HostIp: '127.0.0.1' }] },
    })
  })

  it('环境变量键 1BAD 400', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({ env: [{ key: '1BAD', value: 'x' }] }),
          ...baseContext(),
        }),
      400,
      '环境变量名无效',
    )
  })

  it('环境变量值含换行 400', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({ env: [{ key: 'FOO', value: 'a\nb' }] }),
          ...baseContext(),
        }),
      400,
      '环境变量值不能包含换行或控制字符',
    )
  })

  it('挂载 /etc/passwd 400', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({
            volumes: [{ hostPath: '/etc/passwd', containerPath: '/etc/passwd' }],
          }),
          ...baseContext(),
        }),
      400,
      `绑定挂载路径须位于 ${MOUNT_ROOT} 之下`,
    )
  })

  it('挂载 mountRoot 本身 400', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({
            volumes: [{ hostPath: MOUNT_ROOT, containerPath: '/mnt' }],
          }),
          ...baseContext(),
        }),
      400,
      '不能将挂载根目录挂载进容器',
    )
  })

  it('realpath 逃出根 400', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({
            volumes: [{ hostPath: `${MOUNT_ROOT}/escape`, containerPath: '/data' }],
          }),
          ...baseContext({
            realpath: async (path: string) => {
              if (path === `${MOUNT_ROOT}/escape`) return '/etc/passwd'
              if (path === MOUNT_ROOT) return MOUNT_ROOT
              const err = new Error('ENOENT') as Error & { code: string }
              err.code = 'ENOENT'
              throw err
            },
          }),
        }),
      400,
      '挂载路径超出允许范围',
    )
  })

  it('祖先是符号链接 400', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({
            volumes: [{ hostPath: `${MOUNT_ROOT}/symlink/data`, containerPath: '/data' }],
          }),
          ...baseContext(),
        }),
      400,
      SYMLINK_MOUNT_MESSAGE,
    )
  })

  it('容器路径 / 400', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({
            volumes: [{ hostPath: `${MOUNT_ROOT}/data`, containerPath: '/' }],
          }),
          ...baseContext(),
        }),
      400,
      '容器内挂载路径不能为根目录',
    )
  })

  it('命令引号不配对 400', async () => {
    await expectStatus(
      () =>
        buildCreateSpec({
          body: baseBody({ command: '"open' }),
          ...baseContext(),
        }),
      400,
      /引号/,
    )
  })

  it('合法输入组装白名单请求体', async () => {
    const result = await buildCreateSpec({
      body: baseBody({
        name: 'redis-echo',
        command: 'redis-server --appendonly yes',
        restartPolicy: 'on-failure',
        ports: [{ containerPort: 6379, hostPort: 16379, protocol: 'tcp' }],
        env: [{ key: 'TZ', value: 'UTC' }],
        volumes: [{ hostPath: `${MOUNT_ROOT}/data`, containerPath: '/data' }],
      }),
      ...baseContext(),
    })

    expect(result.name).toBe('redis-echo')
    expect(result.mkdirPaths).toEqual([])

    const roundTrip = JSON.parse(JSON.stringify(result.createBody)) as Record<string, unknown>
    expect(Object.keys(roundTrip).sort()).toEqual(['Cmd', 'Env', 'HostConfig', 'Image', 'Labels'].sort())

    const hostConfig = roundTrip.HostConfig as Record<string, unknown>
    expect(hostConfig.Privileged).toBeUndefined()
    expect(hostConfig.Binds).toBeUndefined()
    expect(hostConfig.NetworkMode).toBeUndefined()
    expect(hostConfig.RestartPolicy).toEqual({ Name: 'on-failure', MaximumRetryCount: 0 })

    const mounts = hostConfig.Mounts as { Type: string; Source: string; Target: string }[]
    expect(mounts[0]).toEqual({
      Type: 'bind',
      Source: `${MOUNT_ROOT}/data`,
      Target: '/data',
    })

    expect(roundTrip.Labels).toEqual({ 'elysian.managed': 'true' })
    expect(roundTrip.Image).toBe(IMAGE_HEX)
    expect(roundTrip.Cmd).toEqual(['redis-server', '--appendonly', 'yes'])
    expect(roundTrip.Env).toEqual(['TZ=UTC'])
  })

  it('名称留空时按镜像名自动命名', async () => {
    const result = await buildCreateSpec({
      body: baseBody(),
      ...baseContext({
        images: [{ id: IMAGE_ID, name: 'grafana/grafana' }],
      }),
    })
    expect(result.name).toBe('grafana-grafana')
  })

  it('需要创建的目录写入 mkdirPaths', async () => {
    const result = await buildCreateSpec({
      body: baseBody({
        volumes: [{ hostPath: `${MOUNT_ROOT}/new/nested`, containerPath: '/work' }],
      }),
      ...baseContext(),
    })
    expect(result.mkdirPaths).toEqual([`${MOUNT_ROOT}/new`, `${MOUNT_ROOT}/new/nested`])
  })
})
