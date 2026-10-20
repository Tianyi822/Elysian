import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentExecutionProfile } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { AgentHttpError } from '../adapters/http/agent/agentShared'
import { advanceAuthGeneration } from '../adapters/http/unauthorized'
import { executionProfileInput } from '../test/agentExecutionFixtures'
import { useAgentExecutionStore as store } from './agentExecutionStore'
import { useNotificationStore } from './notificationStore'

beforeEach(() => { store.getState().reset(); useNotificationStore.getState().clear() })
const gateway = () => createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('执行配置状态与失败恢复', () => {
  it('刷新失败保留旧列表，迟到列表不能覆盖刚提交的修订', async () => {
    const g = gateway()
    const first = await g.agentExecution.createProfile(executionProfileInput)
    await store.getState().load(g, 'profiles')
    vi.spyOn(g.agentExecution, 'listProfiles').mockRejectedValueOnce(new Error('网络中断'))
    await store.getState().load(g, 'profiles')
    expect(store.getState().profiles).toMatchObject({ status: 'ready', error: '网络中断', items: [first] })
    const late = deferred<readonly AgentExecutionProfile[]>()
    vi.mocked(g.agentExecution.listProfiles).mockReturnValueOnce(late.promise)
    const reading = store.getState().load(g, 'profiles')
    expect((await store.getState().saveProfile(g, { ...executionProfileInput, expectedRevision: 1, name: '新的配置' }, first.id)).status).toBe('saved')
    late.resolve([first]); await reading
    expect(store.getState().profiles.items[0]).toMatchObject({ name: '新的配置', revision: 2 })
    expect(store.getState().profiles.refreshing).toBe(false)
  })

  it('修订冲突回读最新内容，不自动提交草稿', async () => {
    const g = gateway()
    const first = await g.agentExecution.createProfile(executionProfileInput)
    await g.agentExecution.updateProfile(first.id, { ...executionProfileInput, expectedRevision: 1, name: '其他窗口修改' })
    const update = vi.spyOn(g.agentExecution, 'updateProfile')
    const result = await store.getState().saveProfile(g, { ...executionProfileInput, expectedRevision: 1, name: '我的草稿' }, first.id)
    expect(result).toMatchObject({ status: 'error', latest: { name: '其他窗口修改', revision: 2 } })
    expect(update).toHaveBeenCalledTimes(1)
    expect(useNotificationStore.getState().notifications).toEqual([])
  })

  it('新建回执丢失只回读一次，不凭相同名称宣称成功或重建', async () => {
    const g = gateway()
    const saved = g.agentExecution.createProfile.bind(g.agentExecution)
    const create = vi.spyOn(g.agentExecution, 'createProfile').mockImplementation(async input => { await saved(input); throw new Error('连接中断') })
    const result = await store.getState().saveProfile(g, executionProfileInput)
    expect(result.status).toBe('unknown')
    expect(create).toHaveBeenCalledTimes(1)
    expect(store.getState().profiles.items).toHaveLength(1)
    expect(useNotificationStore.getState().notifications).toEqual([])
  })

  it('退出登录后迟到写入不能回灌目录或通知', async () => {
    const g = gateway(), late = deferred<AgentExecutionProfile>()
    vi.spyOn(g.agentExecution, 'createProfile').mockReturnValue(late.promise)
    const saving = store.getState().saveProfile(g, executionProfileInput)
    advanceAuthGeneration(); store.getState().reset()
    late.resolve({ ...executionProfileInput, id: 'late', revision: 1, createdAt: '2026-10-20T00:00:00Z' })
    expect((await saving).status).toBe('stale')
    expect(store.getState().profiles.items).toEqual([])
    expect(store.getState().busy).toEqual([])
    expect(useNotificationStore.getState().notifications).toEqual([])
  })

  it('重复点击提交单飞，明确校验拒绝不归为结果未知', async () => {
    const g = gateway(), late = deferred<AgentExecutionProfile>()
    const create = vi.spyOn(g.agentExecution, 'createProfile').mockReturnValue(late.promise)
    const saving = store.getState().saveProfile(g, executionProfileInput)
    expect((await store.getState().saveProfile(g, executionProfileInput)).status).toBe('error')
    expect(create).toHaveBeenCalledTimes(1)
    late.resolve({ ...executionProfileInput, id: 'one', revision: 1, createdAt: '2026-10-20T00:00:00Z' }); await saving
    create.mockRejectedValue(new AgentHttpError('镜像无效', 'execution_invalid_profile', 400))
    expect((await store.getState().saveProfile(g, executionProfileInput)).status).toBe('error')
  })
})
