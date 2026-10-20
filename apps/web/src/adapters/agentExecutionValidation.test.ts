import { describe, expect, it, vi } from 'vitest'
import { validateExecutionGrant, validateExecutionProfile } from './agentExecutionValidation'
import { executionGrantInput, executionProfileInput } from '../test/agentExecutionFixtures'
import { executionResourceChoices } from './agentExecutionResources'
import { createMockGateway } from './mock/gateway'

describe('执行配置与授权提交边界', () => {
  it('不以镜像 ID 或可变标签替代仓库摘要，硬限额不能超出后端范围', () => {
    expect(validateExecutionProfile(executionProfileInput)).toEqual({})
    expect(validateExecutionProfile({ ...executionProfileInput, image: `sha256:${'a'.repeat(64)}` })).toHaveProperty('image')
    expect(validateExecutionProfile({ ...executionProfileInput, image: 'library/bash:latest' })).toHaveProperty('image')
    expect(validateExecutionProfile({ ...executionProfileInput, timeoutSeconds: 301, cpuMillis: 1001, memoryBytes: 513 * 1048576, pids: 129 })).toMatchObject({ timeoutSeconds: expect.any(String), cpuMillis: expect.any(String), memoryBytes: expect.any(String), pids: expect.any(String) })
  })

  it('拒绝空授权、越根路径、大小写重复网络目标与通配资源身份', () => {
    expect(validateExecutionGrant(executionGrantInput, '/srv/elysian')).toEqual({})
    expect(validateExecutionGrant({ ...executionGrantInput, directories: [], network: [], resources: [] })).toHaveProperty('scope')
    expect(validateExecutionGrant({ ...executionGrantInput, directories: [{ path: '/srv/elysian/../private', access: 'rw' }] }, '/srv/elysian')['directories.0']).toBeTruthy()
    expect(validateExecutionGrant({ ...executionGrantInput, network: [{ scheme: 'https', host: 'API.example.com', port: 443 }, ...executionGrantInput.network] })['network.1']).toBeTruthy()
    expect(validateExecutionGrant({ ...executionGrantInput, resources: [{ domain: 'website', id: '*', access: 'write' }] })['resources.0']).toBeTruthy()
  })

  it('选择器回填平台精确资源键，不把展示名称当作授权目标', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
    const containers = await gateway.containers.list()
    vi.spyOn(gateway.containers, 'list').mockResolvedValue([{ ...containers[0]!, id: 'c'.repeat(64), name: '仅用于展示的名称' }])
    expect(await executionResourceChoices(gateway, 'docker-container')).toEqual([{ value: 'c'.repeat(64), label: '仅用于展示的名称', description: 'c'.repeat(64) }])
    const images = await gateway.containers.listImages()
    vi.spyOn(gateway.containers, 'listImages').mockResolvedValue([{ ...images[0]!, id: 'd'.repeat(64), name: 'repository', tag: 'tag' }])
    expect((await executionResourceChoices(gateway, 'docker-image'))[0]?.value).toBe('d'.repeat(64))
  })
})
