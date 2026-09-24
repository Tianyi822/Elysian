import { afterEach, describe, expect, it, vi } from 'vitest'

const pullHttpMocks = vi.hoisted(() => {
  const destroy = vi.fn()
  const request = vi.fn((_opts: unknown, _cb?: unknown) => ({
    destroy,
    setTimeout: vi.fn(),
    on: vi.fn(),
    end: vi.fn(),
  }))
  return { destroy, request }
})

vi.mock('node:http', () => ({
  request: pullHttpMocks.request,
}))

import {
  assertEngineApi,
  createDockerTransport,
  type DockerTransport,
} from './dockerTransport'

describe('createDockerTransport', () => {
  it('注入的 requestImpl 被原样调用并返回结果', async () => {
    const requestImpl = vi.fn(async () => ({
      status: 200,
      json: { ApiVersion: '1.41' },
    }))
    const transport = createDockerTransport({
      socketPath: '/var/run/docker.sock',
      requestImpl,
    })
    const input = {
      method: 'GET',
      path: '/v1.41/version',
      timeoutMs: 3000,
      maxBytes: 1_048_576,
    }
    const result = await transport.request(input)
    expect(requestImpl).toHaveBeenCalledOnce()
    expect(requestImpl).toHaveBeenCalledWith(input)
    expect(result).toEqual({ status: 200, json: { ApiVersion: '1.41' } })
  })
})

describe('pullCreate', () => {
  afterEach(() => {
    pullHttpMocks.destroy.mockClear()
    pullHttpMocks.request.mockClear()
  })

  it('AbortSignal 中止时销毁 Engine 请求并拒绝拉取', async () => {
    const transport = createDockerTransport({ socketPath: '/var/run/docker.sock' })
    const controller = new AbortController()
    const promise = transport.pullCreate!({
      path: '/v1.41/images/create?fromImage=nginx%3Alatest',
      timeoutMs: 60_000,
      maxBytes: 1024,
      signal: controller.signal,
    })

    controller.abort()

    await expect(promise).rejects.toThrow('拉取已取消')
    expect(pullHttpMocks.destroy).toHaveBeenCalled()
    expect(pullHttpMocks.request).toHaveBeenCalled()
  })
})

describe('assertEngineApi', () => {
  function transportWithApiVersion(apiVersion: string): DockerTransport {
    return createDockerTransport({
      socketPath: '/var/run/docker.sock',
      requestImpl: async (input) => {
        expect(input).toEqual({
          method: 'GET',
          path: '/version',
          timeoutMs: 3000,
          maxBytes: 1_048_576,
        })
        return { status: 200, json: { ApiVersion: apiVersion } }
      },
    })
  }

  it('ApiVersion 1.41 通过', async () => {
    await expect(assertEngineApi(transportWithApiVersion('1.41'))).resolves.toBeUndefined()
  })

  it('ApiVersion 1.44 通过', async () => {
    await expect(assertEngineApi(transportWithApiVersion('1.44'))).resolves.toBeUndefined()
  })

  it('ApiVersion 低于 1.41 时拒绝', async () => {
    await expect(assertEngineApi(transportWithApiVersion('1.40'))).rejects.toThrow(
      'Docker Engine API 版本过低，需要 1.41 及以上',
    )
  })

  it('按主次版本数字比较，而非字符串', async () => {
    await expect(assertEngineApi(transportWithApiVersion('1.9'))).rejects.toThrow(
      'Docker Engine API 版本过低，需要 1.41 及以上',
    )
    await expect(assertEngineApi(transportWithApiVersion('1.41'))).resolves.toBeUndefined()
  })
})
