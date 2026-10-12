import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentExecutionGrantInput,
  AgentExecutionProfileInput,
} from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { AgentCapabilitiesMockAdapter } from '../adapters/mock/agent/agentCapabilitiesMockAdapter'
import {
  mockUpdateExecutionProfile,
  resetAgentCapabilitiesData,
} from '../adapters/mock/agent/agentCapabilitiesData'
import { useNotificationStore } from './notificationStore'
import { useAgentCapabilitiesStore, validateExecutionProfileInput } from './agentCapabilitiesStore'

/*
 * store 层测试跑在确定性 mock 适配器上：验证六态装载、前端上限拦截、
 * 编号一致性拦截、写操作单飞锁、CAS 冲突回读合并与修订详情。
 */

function makeGateway(adapter = new AgentCapabilitiesMockAdapter()): { gateway: ElysianGateway; adapter: AgentCapabilitiesMockAdapter } {
  return { gateway: { agentCapabilities: adapter } as unknown as ElysianGateway, adapter }
}

function executionInput(overrides: Partial<AgentExecutionProfileInput> = {}): AgentExecutionProfileInput {
  return {
    enabled: true,
    name: 'store 执行配置',
    image: `registry.example.com/elysian/store@sha256:${'ab12cd34'.repeat(8)}`,
    runtime: 'python',
    command: ['python3', '-'],
    timeoutSeconds: 60,
    cpuMillis: 500,
    memoryBytes: 268435456,
    pids: 64,
    expectedRevision: 0,
    ...overrides,
  }
}

function grantInput(overrides: Partial<AgentExecutionGrantInput> = {}): AgentExecutionGrantInput {
  return {
    enabled: true,
    name: 'store 授权',
    directories: [],
    network: [],
    privateCidrs: [],
    expectedRevision: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  resetAgentCapabilitiesData()
  useAgentCapabilitiesStore.getState().reset()
  useNotificationStore.getState().clear()
})

describe('agentCapabilitiesStore 装载与页签', () => {
  it('执行参数校验按 UTF-8 字节限制，保留非首位空参数与空白', () => {
    expect(validateExecutionProfileInput(executionInput({ command: ['python3', '', '  x\n'] }))).toBeUndefined()
    expect(validateExecutionProfileInput(executionInput({ command: ['', 'x'] }))).toMatch(/首个参数不能为空/)
    expect(validateExecutionProfileInput(executionInput({ command: ['python3', '\0'] }))).toMatch(/NUL/)
    expect(validateExecutionProfileInput(executionInput({ command: ['python3', '中'.repeat(1366)] }))).toMatch(/4096 字节/)
    expect(validateExecutionProfileInput(executionInput({ command: ['python3', ...Array<string>(5).fill('x'.repeat(4096))] }))).toMatch(/16 KiB/)
  })

  it('执行器静默轮询只读该域，转发取消信号并向轮询器抛出失败', async () => {
    const { gateway, adapter } = makeGateway()
    await useAgentCapabilitiesStore.getState().load(gateway)
    const models = vi.spyOn(adapter, 'listModelProfiles')
    const runtimes = vi.spyOn(adapter, 'listExecutionRuntimes').mockRejectedValue(new Error('执行器暂不可读'))
    const controller = new AbortController()
    await expect(useAgentCapabilitiesStore.getState().refreshExecutionRuntimes(gateway, controller.signal)).rejects.toThrow('执行器暂不可读')
    expect(runtimes).toHaveBeenCalledWith(controller.signal)
    expect(models).not.toHaveBeenCalled()
    expect(useAgentCapabilitiesStore.getState().domainStates.execution.status).toBe('ready')
    expect(useAgentCapabilitiesStore.getState().executionRuntimes).toHaveLength(1)
    expect(useAgentCapabilitiesStore.getState().reloading).toBe(false)
  })

  it('一次装载四域列表，进入 ready', async () => {
    const { gateway } = makeGateway()
    await useAgentCapabilitiesStore.getState().load(gateway)
    const state = useAgentCapabilitiesStore.getState()
    expect(state.status).toBe('ready')
    expect(state.domainStates.execution.status).toBe('ready')
    expect(state.executionProfiles).toHaveLength(3)
    expect(state.grants).toHaveLength(3)
    expect(state.resourceRules).toHaveLength(2)
    expect(state.executionRuntimes).toHaveLength(1)
  })

  it('单域装载失败只影响该页签，其他目录仍可用', async () => {
    const failing = new AgentCapabilitiesMockAdapter()
    vi.spyOn(failing, 'listGrants').mockRejectedValue(new Error('Agent 请求网络失败'))
    const { gateway } = makeGateway(failing)
    await useAgentCapabilitiesStore.getState().load(gateway)
    const state = useAgentCapabilitiesStore.getState()
    expect(state.status).toBe('ready')
    expect(state.domainStates.grants).toEqual({ status: 'error', errorMessage: 'Agent 请求网络失败' })
    expect(state.domainStates.execution.status).toBe('ready')
    expect(state.executionProfiles).toHaveLength(3)
  })

  it('切换页签清空过滤词', () => {
    const store = useAgentCapabilitiesStore.getState()
    store.setSearch('python')
    expect(useAgentCapabilitiesStore.getState().search).toBe('python')
    store.setTab('runtimes')
    expect(useAgentCapabilitiesStore.getState().tab).toBe('runtimes')
    expect(useAgentCapabilitiesStore.getState().search).toBe('')
  })
})

describe('agentCapabilitiesStore 前端拦截', () => {
  it('执行配置越界限额在发出请求前被拦截并通知上限', async () => {
    const { gateway, adapter } = makeGateway()
    const spy = vi.spyOn(adapter, 'createExecutionProfile')
    await useAgentCapabilitiesStore.getState().load(gateway)
    const store = useAgentCapabilitiesStore.getState()
    const timeout = await store.saveExecutionProfile(gateway, executionInput({ timeoutSeconds: 301 }))
    expect(timeout).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    const cpu = await useAgentCapabilitiesStore.getState().saveExecutionProfile(gateway, executionInput({ cpuMillis: 1001 }))
    expect(cpu).toBe(false)
    const memory = await useAgentCapabilitiesStore.getState().saveExecutionProfile(gateway, executionInput({ memoryBytes: 512 * 1024 * 1024 + 1 }))
    expect(memory).toBe(false)
    const pids = await useAgentCapabilitiesStore.getState().saveExecutionProfile(gateway, executionInput({ pids: 129 }))
    expect(pids).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    const messages = useNotificationStore.getState().notifications.map((item) => item.message)
    expect(messages.some((message) => message.includes('300 秒'))).toBe(true)
    expect(messages.some((message) => message.includes('1000 毫秒'))).toBe(true)
    expect(messages.some((message) => message.includes('512 MiB'))).toBe(true)
    expect(messages.some((message) => message.includes('128'))).toBe(true)
  })

  it('路径编号与正文编号不一致的编辑被拦截且不发出请求', async () => {
    const { gateway, adapter } = makeGateway()
    const spy = vi.spyOn(adapter, 'updateExecutionProfile')
    await useAgentCapabilitiesStore.getState().load(gateway)
    const profile = useAgentCapabilitiesStore.getState().executionProfiles[0]
    if (profile === undefined) throw new Error('执行配置种子应存在')
    const result = await useAgentCapabilitiesStore.getState().saveExecutionProfile(
      gateway,
      executionInput({ id: 'ep-other', name: profile.name, image: profile.image, runtime: profile.runtime, command: [...profile.command], timeoutSeconds: profile.timeoutSeconds, cpuMillis: profile.cpuMillis, memoryBytes: profile.memoryBytes, pids: profile.pids, enabled: profile.enabled }),
      { id: profile.id, revision: profile.revision },
    )
    expect(result).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    expect(useNotificationStore.getState().notifications[0]?.message).toContain('编号与路径不一致')
  })
})

describe('agentCapabilitiesStore 写闭环与单飞锁', () => {


  it('执行配置启停回读状态变化', async () => {
    const { gateway } = makeGateway()
    await useAgentCapabilitiesStore.getState().load(gateway)
    const profile = useAgentCapabilitiesStore.getState().executionProfiles.find((item) => item.enabled)
    if (profile === undefined) throw new Error('应存在启用中的执行配置种子')
    await useAgentCapabilitiesStore.getState().toggleExecutionProfileEnabled(gateway, profile, false)
    const after = useAgentCapabilitiesStore.getState().executionProfiles.find((item) => item.id === profile.id)
    expect(after?.enabled).toBe(false)
    expect(after?.revision).toBe(profile.revision + 1)
  })

  it('CAS 冲突：重拉列表回读服务端事实并通知，不盲目重试', async () => {
    const { gateway } = makeGateway()
    await useAgentCapabilitiesStore.getState().load(gateway)
    const profile = useAgentCapabilitiesStore.getState().executionProfiles[0]
    if (profile === undefined) throw new Error('执行配置种子应存在')
    // 另一端先改掉同一配置：store 手里的 expectedRevision 过期。
    mockUpdateExecutionProfile(profile.id, executionInput({
      id: profile.id, name: '他处修改', image: profile.image, runtime: profile.runtime,
      command: [...profile.command], timeoutSeconds: profile.timeoutSeconds, cpuMillis: profile.cpuMillis,
      memoryBytes: profile.memoryBytes, pids: profile.pids, enabled: profile.enabled,
      expectedRevision: profile.revision,
    }))
    const result = await useAgentCapabilitiesStore.getState().saveExecutionProfile(
      gateway,
      executionInput({ name: '本地修改', image: profile.image, runtime: profile.runtime, command: [...profile.command], timeoutSeconds: profile.timeoutSeconds, cpuMillis: profile.cpuMillis, memoryBytes: profile.memoryBytes, pids: profile.pids, enabled: profile.enabled }),
      { id: profile.id, revision: profile.revision },
    )
    expect(result).toBe(false)
    const reloaded = useAgentCapabilitiesStore.getState().executionProfiles.find((item) => item.id === profile.id)
    expect(reloaded?.name).toBe('他处修改')
    expect(reloaded?.revision).toBe(profile.revision + 1)
    const messages = useNotificationStore.getState().notifications.map((item) => item.message)
    expect(messages.some((message) => message.includes('已重新读取最新修订'))).toBe(true)
  })


  it('授权增改启停与资源规则 digest 更新回读', async () => {
    const { gateway } = makeGateway()
    await useAgentCapabilitiesStore.getState().load(gateway)
    const ok = await useAgentCapabilitiesStore.getState().saveGrant(gateway, grantInput({ directories: [{ path: '/srv/demo', access: 'ro' }] }))
    expect(ok).toBe(true)
    const created = useAgentCapabilitiesStore.getState().grants.find((item) => item.name === 'store 授权')
    if (created === undefined) throw new Error('授权创建后应出现在列表里')
    expect(created.revision).toBe(1)
    await useAgentCapabilitiesStore.getState().toggleGrantEnabled(gateway, created, false)
    expect(useAgentCapabilitiesStore.getState().grants.find((item) => item.id === created.id)?.enabled).toBe(false)
    const rule = useAgentCapabilitiesStore.getState().resourceRules[0]
    if (rule === undefined) throw new Error('资源规则种子应存在')
    const ruleOk = await useAgentCapabilitiesStore.getState().saveResourceRule(
      gateway,
      {
        name: '改名的规则',
        enabled: rule.enabled,
        complete: rule.complete,
        selector: rule.selector,
        mappings: rule.mappings,
      },
      { id: rule.id, revision: rule.revision },
    )
    expect(ruleOk).toBe(true)
    const updated = useAgentCapabilitiesStore.getState().resourceRules.find((item) => item.id === rule.id)
    expect(updated?.revision).toBe(rule.revision + 1)
    expect(updated?.digest).not.toBe(rule.digest)
  })
})

describe('agentCapabilitiesStore 修订详情', () => {
  it('按历史修订读取当次事实，失败保留中文错误', async () => {
    const { gateway } = makeGateway()
    await useAgentCapabilitiesStore.getState().load(gateway)
    await useAgentCapabilitiesStore.getState().loadRevisionDetail(gateway, 'execution', 'ep-python-tools', 1)
    let detail = useAgentCapabilitiesStore.getState().detail
    expect(detail?.status).toBe('ready')
    expect(detail?.execution?.revision).toBe(1)
    expect(detail?.execution?.memoryBytes).toBe(536870912)
    await useAgentCapabilitiesStore.getState().loadRevisionDetail(gateway, 'execution', 'ep-python-tools')
    detail = useAgentCapabilitiesStore.getState().detail
    expect(detail?.execution?.revision).toBe(2)
    await useAgentCapabilitiesStore.getState().loadRevisionDetail(gateway, 'grant', 'eg-missing', 1)
    detail = useAgentCapabilitiesStore.getState().detail
    expect(detail?.status).toBe('error')
    expect(detail?.errorMessage).toContain('执行授权')
    useAgentCapabilitiesStore.getState().closeRevisionDetail()
    expect(useAgentCapabilitiesStore.getState().detail).toBeUndefined()
  })
})
