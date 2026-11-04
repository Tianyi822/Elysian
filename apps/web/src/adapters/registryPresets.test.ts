import { afterEach, describe, expect, it, vi } from 'vitest'
import presets from '../../../server-go/internal/docker/registry-presets.json'
import { createMockGateway } from './mock/gateway'
import { createHttpContainersAdapter } from './http/containersHttpAdapter'
import { runRegistryPresetsContract } from './registryPresetsContract'

afterEach(() => vi.unstubAllGlobals())
runRegistryPresetsContract(() => createMockGateway({ eventStream: 'memory' }).containers)
runRegistryPresetsContract(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(presets)))
  return createHttpContainersAdapter()
})

describe('镜像源 HTTP 目录', () => {
  it('透传取消信号，拒绝无效目录与重复 ID', async () => {
    const fetcher = vi.fn(async () => Response.json(presets))
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    await createHttpContainersAdapter().listRegistryPresets(signal)
    expect(fetcher).toHaveBeenCalledWith('/api/docker/registry-presets', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    for (const invalid of [{}, [{ id: 'custom', label: 'custom', url: 'http://bad' }], [presets[0], presets[0]]]) {
      fetcher.mockImplementation(async () => Response.json(invalid))
      await expect(createHttpContainersAdapter().listRegistryPresets()).rejects.toThrow('镜像源目录响应格式无效')
    }
  })
})
