import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DockerTransport } from './dockerTransport'
import { createDockerReadService } from './dockerService'
import { resolveSelfContainerId } from './selfContainer'

const CONTAINER_ID = 'a1b2c3d4e5f6'
const IMAGE_ID = 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'

function baseContainerInspect(overrides: Record<string, unknown> = {}) {
  return {
    Id: CONTAINER_ID,
    Name: '/test-container',
    Created: '2024-06-01T10:00:00.000000000Z',
    Image: 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    Path: '/docker-entrypoint.sh',
    Args: ['nginx', '-g', 'daemon off;'],
    State: { Status: 'running', StartedAt: '2024-06-01T10:01:00.000000000Z' },
    Config: { Image: 'nginx:1.27-alpine', Env: [] as string[] },
    HostConfig: { PortBindings: {}, RestartPolicy: { Name: 'no' } },
    Mounts: [] as unknown[],
    ...overrides,
  }
}

function baseImageInspect() {
  return {
    Id: IMAGE_ID,
    RepoTags: ['myapp:1.0'],
    RepoDigests: ['myapp@sha256:digestvalue'],
    Size: 1_500_000,
    Created: '2024-05-01T08:00:00.000000000Z',
  }
}

function createRecordingTransport(
  handler: (input: { method: string; path: string }) => { status: number; json: unknown },
): DockerTransport {
  return {
    request: vi.fn(async (input) => handler(input)),
  }
}

describe('createDockerReadService', () => {
  const policyOptions = {
    mountRoot: '/srv',
    reservedPorts: [22, 48100, 48101] as const,
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('listContainers 列表后逐个 inspect 并映射', async () => {
    const transport = createRecordingTransport(({ path }) => {
      if (path === '/v1.41/containers/json?all=1') {
        return { status: 200, json: [{ Id: CONTAINER_ID }] }
      }
      if (path === `/v1.41/containers/${CONTAINER_ID}/json`) {
        return { status: 200, json: baseContainerInspect() }
      }
      throw new Error(`未录制的路径：${path}`)
    })
    const service = createDockerReadService(transport, policyOptions)
    const containers = await service.listContainers()
    expect(containers).toHaveLength(1)
    expect(containers[0]?.id).toBe(CONTAINER_ID)
    expect(containers[0]?.name).toBe('test-container')
  })

  it('listImages 列表后逐个 inspect 并映射', async () => {
    const transport = createRecordingTransport(({ path }) => {
      if (path === '/v1.41/images/json') {
        return { status: 200, json: [{ Id: IMAGE_ID }] }
      }
      if (path === `/v1.41/images/${encodeURIComponent(IMAGE_ID)}/json`) {
        return { status: 200, json: baseImageInspect() }
      }
      throw new Error(`未录制的路径：${path}`)
    })
    const service = createDockerReadService(transport, policyOptions)
    const images = await service.listImages()
    expect(images).toHaveLength(1)
    expect(images[0]?.id).toBe(IMAGE_ID.slice('sha256:'.length))
    expect(images[0]?.name).toBe('myapp')
  })

  it('列表长度 501 时抛错，消息含 500', async () => {
    const summaries = Array.from({ length: 501 }, (_, i) => ({ Id: `id-${i}` }))
    const transport = createRecordingTransport(({ path }) => {
      if (path === '/v1.41/containers/json?all=1') {
        return { status: 200, json: summaries }
      }
      throw new Error(`未录制的路径：${path}`)
    })
    const service = createDockerReadService(transport, policyOptions)
    await expect(service.listContainers()).rejects.toThrow(/500/)
  })

  it('第二个 inspect 返回 500 时整次失败，不返回第一个容器', async () => {
    const id1 = 'aaaa1111'
    const id2 = 'bbbb2222'
    const transport = createRecordingTransport(({ path }) => {
      if (path === '/v1.41/containers/json?all=1') {
        return { status: 200, json: [{ Id: id1 }, { Id: id2 }] }
      }
      if (path === `/v1.41/containers/${id1}/json`) {
        return { status: 200, json: baseContainerInspect({ Id: id1, Name: '/one' }) }
      }
      if (path === `/v1.41/containers/${id2}/json`) {
        return { status: 500, json: { message: 'boom' } }
      }
      throw new Error(`未录制的路径：${path}`)
    })
    const service = createDockerReadService(transport, policyOptions)
    await expect(service.listContainers()).rejects.toThrow()
    expect(transport.request).toHaveBeenCalled()
  })

  it('列表 GET 与 inspect 共用整次 10 秒预算（不会在两阶段各计 10 秒）', async () => {
    vi.useFakeTimers()
    const transport: DockerTransport = {
      request: vi.fn(async (input) => {
        if (input.path === '/v1.41/containers/json?all=1') {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 9_000)
          })
          return { status: 200, json: [{ Id: CONTAINER_ID }] }
        }
        if (input.path === `/v1.41/containers/${CONTAINER_ID}/json`) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 2_000)
          })
          return { status: 200, json: baseContainerInspect() }
        }
        throw new Error(`未录制的路径：${input.path}`)
      }),
    }
    const service = createDockerReadService(transport, policyOptions)
    const promise = service.listContainers()
    const rejection = expect(promise).rejects.toThrow('Docker 列表请求超时')
    await vi.advanceTimersByTimeAsync(15_000)
    await rejection
  })

  it('policy() 返回传入的 mountRoot 与 reservedPorts', async () => {
    const transport = createRecordingTransport(() => ({ status: 200, json: null }))
    const service = createDockerReadService(transport, policyOptions)
    await expect(service.policy()).resolves.toEqual({
      mountRoot: '/srv',
      reservedPorts: [22, 48100, 48101],
    })
  })
})

describe('createDockerReadService.action', () => {
  const policyOptions = {
    mountRoot: '/srv',
    reservedPorts: [22, 48100, 48101] as const,
  }

  it('start 调用 POST /v1.41/containers/<id>/start；304 仍 inspect 并返回 running', async () => {
    const calls: Array<{ method: string; path: string }> = []
    const transport = createRecordingTransport(({ method, path }) => {
      calls.push({ method, path })
      if (method === 'POST' && path === `/v1.41/containers/${encodeURIComponent(CONTAINER_ID)}/start`) {
        return { status: 304, json: null }
      }
      if (method === 'GET' && path === `/v1.41/containers/${encodeURIComponent(CONTAINER_ID)}/json`) {
        return { status: 200, json: baseContainerInspect({ State: { Status: 'running' } }) }
      }
      throw new Error(`未录制的请求：${method} ${path}`)
    })
    const service = createDockerReadService(transport, policyOptions)
    const container = await service.action(CONTAINER_ID, 'start')
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/start'))).toBe(true)
    expect(container.status).toBe('running')
  })

  it('stop 的 path 含 t=10', async () => {
    const transport = createRecordingTransport(({ method, path }) => {
      if (method === 'GET' && path === `/v1.41/containers/${encodeURIComponent(CONTAINER_ID)}/json`) {
        return { status: 200, json: baseContainerInspect({ State: { Status: 'running' } }) }
      }
      if (method === 'POST' && path.includes('/stop')) {
        expect(path).toContain('t=10')
        return { status: 204, json: null }
      }
      throw new Error(`未录制的请求：${method} ${path}`)
    })
    const service = createDockerReadService(transport, policyOptions)
    await service.action(CONTAINER_ID, 'stop')
  })

  it('同一 id 的第二个 action 在第一个未完成时 409', async () => {
    let releaseStart!: () => void
    const transport: DockerTransport = {
      request: vi.fn(async (input) => {
        if (input.method === 'GET' && input.path.endsWith('/json')) {
          return { status: 200, json: baseContainerInspect({ State: { Status: 'running' } }) }
        }
        if (input.method === 'POST' && input.path.endsWith('/start')) {
          await new Promise<void>((resolve) => {
            releaseStart = resolve
          })
          return { status: 204, json: null }
        }
        throw new Error(`未录制的请求：${input.method} ${input.path}`)
      }),
    }
    const service = createDockerReadService(transport, policyOptions)
    const first = service.action(CONTAINER_ID, 'start')
    await Promise.resolve()
    const second = service.action(CONTAINER_ID, 'stop')
    await expect(second).rejects.toMatchObject({
      status: 409,
      message: '该容器正在执行其他操作',
    })
    releaseStart()
    await first
  })

  it('inspect 状态为 paused 时不调用 Engine，409', async () => {
    const transport = createRecordingTransport(({ method, path }) => {
      if (method === 'GET' && path === `/v1.41/containers/${encodeURIComponent(CONTAINER_ID)}/json`) {
        return { status: 200, json: baseContainerInspect({ State: { Status: 'paused' } }) }
      }
      throw new Error(`未录制的请求：${method} ${path}`)
    })
    const service = createDockerReadService(transport, policyOptions)
    await expect(service.action(CONTAINER_ID, 'start')).rejects.toMatchObject({
      status: 409,
      message: '容器已暂停，面板暂不支持恢复',
    })
    expect(transport.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('resolveSelfContainerId 命中时 stop 与 restart 为 400，start 仍放行', async () => {
    const fullId = 'a'.repeat(64)
    const cgroup = `0::/docker/${fullId}`
    const selfId = resolveSelfContainerId(cgroup, [fullId])
    expect(selfId).toBe(fullId)

    const transport = createRecordingTransport(({ method, path }) => {
      if (method === 'GET' && path === `/v1.41/containers/${encodeURIComponent(fullId)}/json`) {
        return {
          status: 200,
          json: baseContainerInspect({ Id: fullId, State: { Status: 'exited' } }),
        }
      }
      if (method === 'POST' && path.endsWith('/start')) {
        return { status: 204, json: null }
      }
      throw new Error(`未录制的请求：${method} ${path}`)
    })
    const service = createDockerReadService(transport, {
      ...policyOptions,
      selfContainerId: selfId,
    })

    await expect(service.action(fullId, 'stop')).rejects.toMatchObject({
      status: 400,
      message: '不能对面板所在的容器执行该操作',
    })
    await expect(service.action(fullId, 'restart')).rejects.toMatchObject({
      status: 400,
      message: '不能对面板所在的容器执行该操作',
    })
    await expect(service.action(fullId, 'start')).resolves.toMatchObject({ id: fullId })
  })

  it('容器 404 时消息为中文', async () => {
    const transport = createRecordingTransport(({ method, path }) => {
      if (method === 'GET' && path === `/v1.41/containers/${encodeURIComponent(CONTAINER_ID)}/json`) {
        return { status: 404, json: { message: 'No such container' } }
      }
      throw new Error(`未录制的请求：${method} ${path}`)
    })
    const service = createDockerReadService(transport, policyOptions)
    await expect(service.action(CONTAINER_ID, 'start')).rejects.toMatchObject({
      status: 404,
      message: '容器不存在',
    })
  })

  it('restart 在调用 Engine 之前调用 onRestarting', async () => {
    const order: string[] = []
    const onRestarting = vi.fn((containerId: string) => {
      order.push(`onRestarting:${containerId}`)
    })
    const transport = createRecordingTransport(({ method, path }) => {
      if (method === 'GET' && path === `/v1.41/containers/${encodeURIComponent(CONTAINER_ID)}/json`) {
        order.push('inspect')
        return { status: 200, json: baseContainerInspect({ State: { Status: 'running' } }) }
      }
      if (method === 'POST' && path.endsWith('/restart')) {
        order.push('engineRestart')
        return { status: 204, json: null }
      }
      throw new Error(`未录制的请求：${method} ${path}`)
    })
    const service = createDockerReadService(transport, { ...policyOptions, onRestarting })
    await service.action(CONTAINER_ID, 'restart')
    expect(onRestarting).toHaveBeenCalledWith(CONTAINER_ID)
    const firstEngine = order.indexOf('engineRestart')
    const firstOnRestarting = order.indexOf(`onRestarting:${CONTAINER_ID}`)
    expect(firstOnRestarting).toBeGreaterThanOrEqual(0)
    expect(firstOnRestarting).toBeLessThan(firstEngine)
  })
})
