import { describe, expect, it, vi } from 'vitest'
import type { DockerTransport } from './dockerTransport'
import { createDockerHostDeps } from './dockerHostDeps'

const FULL_ID = 'a'.repeat(64)

function createTransport(ids: string[]): DockerTransport {
  return {
    request: vi.fn(async (input) => {
      if (input.path === '/version') {
        return { status: 200, json: { ApiVersion: '1.41' } }
      }
      if (input.path.includes('/containers/json')) {
        return { status: 200, json: ids.map((Id) => ({ Id })) }
      }
      // inspect：自我保护以解析后的完整 Id 比对，stop 前的这次 GET 读请求是机制的一部分
      if (input.path.endsWith('/json')) {
        return { status: 200, json: { Id: ids[0], State: { Status: 'running' } } }
      }
      throw new Error(`未录制的请求：${input.path}`)
    }),
  }
}

describe('createDockerHostDeps', () => {
  it('从注入的 cgroup 文本解析 selfContainerId 并传给 action service', async () => {
    const cgroup = `0::/docker/${FULL_ID}`
    const transport = createTransport([FULL_ID])
    const deps = await createDockerHostDeps({
      env: { ELYSIAN_DOCKER: '1' },
      dockerenvExists: true,
      transport,
      readCgroup: () => cgroup,
    })

    expect(deps.available).toBe(true)
    expect(deps.socketReady).toBe(true)
    expect(deps.service).toBeDefined()

    await expect(deps.service!.action(FULL_ID, 'stop')).rejects.toMatchObject({
      status: 400,
      message: '不能对面板所在的容器执行该操作',
    })
    expect(transport.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('Engine API 版本过低时 socket 未就绪且带上具体原因', async () => {
    const transport: DockerTransport = {
      request: vi.fn(async (input) => {
        if (input.path === '/version') {
          return { status: 200, json: { ApiVersion: '1.24' } }
        }
        throw new Error(`未录制的请求：${input.path}`)
      }),
    }
    const deps = await createDockerHostDeps({
      env: { ELYSIAN_DOCKER: '1' },
      dockerenvExists: true,
      transport,
      readCgroup: () => '',
    })

    expect(deps.available).toBe(true)
    expect(deps.socketReady).toBe(false)
    expect(deps.service).toBeUndefined()
    expect(deps.socketUnavailableReason).toContain('Docker Engine API 版本过低')
  })

  it('Engine 探测请求失败时原因携带底层错误消息', async () => {
    const transport: DockerTransport = {
      request: vi.fn(async () => {
        throw new Error('connect ENOENT /var/run/docker.sock')
      }),
    }
    const deps = await createDockerHostDeps({
      env: { ELYSIAN_DOCKER: '1' },
      dockerenvExists: true,
      transport,
      readCgroup: () => '',
    })

    expect(deps.socketReady).toBe(false)
    expect(deps.socketUnavailableReason).toContain('/var/run/docker.sock')
  })

  it('cgroup 文本无 id 时按注入的 hostname 在容器表唯一命中 selfContainerId', async () => {
    const hostId = '764ef645e55a5fdcbf6f8b01ce427d2fafa037bc85a40afd848384e8e850720c'
    const transport = createTransport([hostId])
    const deps = await createDockerHostDeps({
      env: { ELYSIAN_DOCKER: '1' },
      dockerenvExists: true,
      transport,
      readCgroup: () => '0::/',
      readHostname: () => '764ef645e55a',
    })

    expect(deps.available).toBe(true)
    expect(deps.socketReady).toBe(true)
    expect(deps.selfContainerId).toBe(hostId)
    await expect(deps.service!.action(hostId, 'stop')).rejects.toMatchObject({
      status: 400,
      message: '不能对面板所在的容器执行该操作',
    })
    expect(transport.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
