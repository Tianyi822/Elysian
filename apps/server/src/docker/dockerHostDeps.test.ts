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
})
