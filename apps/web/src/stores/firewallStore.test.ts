import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FirewallRule, FirewallToggles } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useFirewallStore } from './firewallStore'
import { useMessageStore } from './messageStore'
import { RequestTimeoutError } from '../adapters/http/requestDeadline'
import { advanceAuthGeneration } from '../utils/authGeneration'
import { useSessionStore } from './sessionStore'

/*
 * 防火墙 store 的行为测试。网关用手写 stub 注入，只依赖 adapter 接口形状；
 * 开关与加载的并发场景用手动 resolve 的 deferred 还原真实交错：
 * 第一笔请求挂起时界面再触发一次动作，断言第二笔不再下发。
 */

const TOGGLES: FirewallToggles = {
  firewallEnabled: true,
  pingBlocked: true,
  defaultIncoming: 'deny',
  defaultOutgoing: 'allow',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function gatewayWith(overrides: Partial<ElysianGateway['firewall']> = {}): ElysianGateway {
  return {
    session: { login: async () => {}, logout: async () => {} },
    firewall: {
      toggles: async () => ({ ...TOGGLES }),
      list: async () => [],
      listIpRules: async () => [],
      listForwards: async () => [],
      scanProtection: async () => useFirewallStore.getInitialState().scanProtection,
      setToggles: async (next: FirewallToggles) => ({ ...next }),
      ...overrides,
    },
  } as unknown as ElysianGateway
}

beforeEach(async () => {
  useFirewallStore.setState(useFirewallStore.getInitialState())
  useMessageStore.setState({ messages: [] })
})

it('规则视图切换与搜索、页码复位在同一次更新完成', () => {
  useFirewallStore.setState({ search: '22', page: 2 })
  const updates = vi.fn()
  const unsubscribe = useFirewallStore.subscribe(updates)
  try {
    useFirewallStore.getState().setTab('ip')
  } finally {
    unsubscribe()
  }
  expect(updates).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tab: 'ip', search: '', page: 1 }),
    expect.objectContaining({ tab: 'port', search: '22', page: 2 }),
  )
})

describe('逐端口防扫描', () => {
  it('旧会话的迟到写回执不覆盖新会话端口状态', async () => {
    const initial = useFirewallStore.getInitialState().scanProtection
    const write = deferred<typeof initial>()
    const old = gatewayWith({ setRuleScanProtection: () => write.promise })
    const pending = useFirewallStore.getState().setRuleScan(old, 'old-22', true)
    advanceAuthGeneration()
    const current = { ...initial, enabled: true, config: { ...initial.config, ports: [80] } }
    await useFirewallStore.getState().load(gatewayWith({ scanProtection: async () => current }))
    write.resolve({ ...initial, enabled: true, config: { ...initial.config, ports: [22] } })
    expect(await pending).toBe(false)
    expect(useFirewallStore.getState()).toMatchObject({ scanProtection: current, scanSaving: false })
  })

  it('读取失败不阻止规则加载，可以独立重试', async () => {
    let failing = true
    const gateway = gatewayWith({ scanProtection: async () => {
      if (failing) throw new Error('防扫描服务不可用')
      return useFirewallStore.getInitialState().scanProtection
    } })
    await useFirewallStore.getState().load(gateway)
    expect(useFirewallStore.getState()).toMatchObject({ status: 'ready', scanStatus: 'error', scanError: '防扫描服务不可用' })
    failing = false
    await useFirewallStore.getState().refreshScan(gateway)
    expect(useFirewallStore.getState()).toMatchObject({ scanStatus: 'ready', scanError: undefined })
  })

  it('写超时只回读事实，不重投或用旧状态覆盖实际结果', async () => {
    const protection = { ...useFirewallStore.getInitialState().scanProtection, enabled: true, config: { ports: [22, 80], windowSeconds: 60, hitCount: 8, banSeconds: 3600 } }
    const write = vi.fn(async () => { throw new RequestTimeoutError(true) })
    const gateway = gatewayWith({ setRuleScanProtection: write, scanProtection: async () => protection })
    expect(await useFirewallStore.getState().setRuleScan(gateway, 'rule-22', true)).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    expect(useFirewallStore.getState()).toMatchObject({ scanProtection: protection, scanSaving: false, scanStatus: 'ready' })
  })

  it('旧读取不会覆盖更新端口后的回执，保存期间不重复下发', async () => {
    const initial = useFirewallStore.getInitialState().scanProtection
    const read = deferred<typeof initial>()
    const write = deferred<typeof initial>()
    const apply = vi.fn(() => write.promise)
    const gateway = gatewayWith({ scanProtection: () => read.promise, setRuleScanProtection: apply })
    const loading = useFirewallStore.getState().refreshScan(gateway)
    const saving = useFirewallStore.getState().setRuleScan(gateway, 'rule-22', true)
    expect(await useFirewallStore.getState().setRuleScan(gateway, 'rule-80', true)).toBe(false)
    write.resolve({ ...initial, enabled: true, config: { ...initial.config, ports: [22] } })
    await saving
    read.resolve(initial)
    await loading
    expect(useFirewallStore.getState().scanProtection.config.ports).toEqual([22])
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('创建已成功但扫描失败时保留已创建身份，重试不会再创建或修改规则', async () => {
    const create = vi.fn(async () => RULE_V4)
    const update = vi.fn(async () => RULE_V4)
    const apply = vi.fn().mockRejectedValueOnce(new Error('应用失败')).mockResolvedValueOnce({ ...useFirewallStore.getInitialState().scanProtection, enabled: true })
    const gateway = gatewayWith({ create, update, setRuleScanProtection: apply })
    const input = { protocol: 'tcp', port: 22, family: 'ipv4', policy: 'allow', direction: 'inbound', source: '所有IP', note: null } as const
    useFirewallStore.getState().openCreate()
    expect(await useFirewallStore.getState().saveRule(gateway, input, true)).toBe(false)
    expect(useFirewallStore.getState().dialogRule).toEqual(RULE_V4)
    expect(useFirewallStore.getState().operationError).toContain('规则已保存')
    expect(await useFirewallStore.getState().saveRule(gateway, input, true)).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('配置失败保留已创建规则与实际扫描状态，重试使用最新监控列表且不重复创建', async () => {
    let actual = useFirewallStore.getInitialState().scanProtection
    const create = vi.fn(async () => RULE_V4)
    const update = vi.fn(async () => RULE_V4)
    const configure = vi.fn().mockRejectedValueOnce(new RequestTimeoutError(true)).mockImplementationOnce(async config => {
      actual = { ...actual, config }
      return actual
    })
    const gateway = gatewayWith({
      create, update, setScanConfig: configure,
      setRuleScanProtection: async () => {
        actual = { ...actual, enabled: true, config: { ...actual.config, ports: [22, 80] } }
        return actual
      },
      scanProtection: async () => actual,
    })
    const input = { protocol: 'tcp', port: 22, family: 'ipv4', policy: 'allow', direction: 'inbound', source: '所有IP', note: null } as const
    const settings = { windowSeconds: 120, hitCount: 6, banSeconds: 7200 }
    useFirewallStore.getState().openCreate()
    expect(await useFirewallStore.getState().saveRule(gateway, input, true, settings)).toBe(false)
    expect(configure).toHaveBeenCalledTimes(1)
    expect(configure).toHaveBeenLastCalledWith({ ...settings, ports: [22, 80] })
    expect(useFirewallStore.getState()).toMatchObject({ dialogRule: RULE_V4, saving: false, scanSaving: false, scanProtection: actual })
    expect(useFirewallStore.getState().operationError).toContain('防扫描配置保存失败')
    expect(await useFirewallStore.getState().saveRule(gateway, input, true, settings)).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
    expect(configure).toHaveBeenCalledTimes(2)
    expect(useFirewallStore.getState().scanProtection.config).toEqual({ ...settings, ports: [22, 80] })
  })

  it('配置保存中的旧会话回执不覆盖新会话状态', async () => {
    const initial = useFirewallStore.getInitialState().scanProtection
    const configured = deferred<typeof initial>()
    const configure = vi.fn(() => configured.promise)
    const gateway = gatewayWith({
      setRuleScanProtection: async () => ({ ...initial, enabled: true, config: { ...initial.config, ports: [22] } }),
      setScanConfig: configure,
    })
    const pending = useFirewallStore.getState().setRuleScan(gateway, 'rule-22', true, { windowSeconds: 120, hitCount: 6, banSeconds: 7200 })
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(1))
    advanceAuthGeneration()
    const current = { ...initial, enabled: true, config: { ...initial.config, ports: [80] } }
    await useFirewallStore.getState().load(gatewayWith({ scanProtection: async () => current }))
    configured.resolve({ ...initial, enabled: true, config: { ports: [22], windowSeconds: 120, hitCount: 6, banSeconds: 7200 } })
    expect(await pending).toBe(false)
    expect(useFirewallStore.getState()).toMatchObject({ scanProtection: current, scanSaving: false })
  })
})

describe('同步与不确定结果', () => {
  it('同步成功但列表刷新失败时解除忙碌，只显示失败', async () => {
    const gateway = gatewayWith({ syncFromSystem: async () => ({ total: 1 }), list: async () => { throw new Error('读取超时') } })
    await useFirewallStore.getState().syncFromSystem(gateway)
    expect(useFirewallStore.getState().syncing).toBe(false)
    expect(useFirewallStore.getState().operationError).toContain('读取超时')
    expect(useMessageStore.getState().messages.every((n) => n.tone === 'danger')).toBe(true)
  })
  it('开关写超时不重放，重新读取实际状态后解除忙碌', async () => {
    const setToggles = vi.fn(async () => { throw new RequestTimeoutError(true) })
    const gateway = gatewayWith({ setToggles, toggles: async () => ({ ...TOGGLES, firewallEnabled: false }) })
    await useFirewallStore.getState().toggle(gateway, { ...TOGGLES, firewallEnabled: false })
    expect(setToggles).toHaveBeenCalledTimes(1)
    expect(useFirewallStore.getState().toggles.firewallEnabled).toBe(false)
    expect(useFirewallStore.getState().toggling).toBe(false)
    expect(useFirewallStore.getState().operationError).toContain('操作结果尚未确认')
  })
})

describe('开关切换的并发保护', () => {
  it('切换进行中置忙碌标志：期间再点直接忽略，只下发第一笔', async () => {
    const first = deferred<FirewallToggles>()
    const setToggles = vi.fn(() => first.promise)
    const gateway = gatewayWith({ setToggles: setToggles as unknown as () => Promise<FirewallToggles> })

    const firstCall = useFirewallStore.getState().toggle(gateway, { ...TOGGLES, firewallEnabled: false })
    expect(useFirewallStore.getState().toggling).toBe(true)

    // 第一笔尚未确认，用户又把开关往回点：忙碌中直接忽略，不发第二笔。
    void useFirewallStore.getState().toggle(gateway, { ...TOGGLES, firewallEnabled: true })
    expect(setToggles).toHaveBeenCalledTimes(1)

    first.resolve({ ...TOGGLES, firewallEnabled: false })
    await firstCall

    const state = useFirewallStore.getState()
    expect(state.toggling).toBe(false)
    // 界面最终停在系统确认的状态上，不会被第二下的乐观值拉回相反方向。
    expect(state.toggles.firewallEnabled).toBe(false)
  })

  it('第一笔失败回滚后忙碌标志复位，可以再次切换', async () => {
    let calls = 0
    const gateway = gatewayWith({
      setToggles: vi.fn(async (next: FirewallToggles) => {
        calls += 1
        if (calls === 1) throw new Error('ufw 不可用')
        return { ...next }
      }) as unknown as () => Promise<FirewallToggles>,
    })

    await useFirewallStore.getState().toggle(gateway, { ...TOGGLES, firewallEnabled: false })
    const rolledBack = useFirewallStore.getState()
    expect(rolledBack.toggles).toEqual(TOGGLES)
    expect(rolledBack.toggling).toBe(false)
    expect(useMessageStore.getState().messages.at(-1)).toMatchObject({ tone: 'danger' })

    await useFirewallStore.getState().toggle(gateway, { ...TOGGLES, firewallEnabled: false })
    const state = useFirewallStore.getState()
    expect(state.toggles.firewallEnabled).toBe(false)
    expect(state.toggling).toBe(false)
  })
})

describe('加载去重', () => {
  it('load 进行中的重复调用直接忽略，只发一轮请求', async () => {
    const pending = deferred<FirewallToggles>()
    const toggles = vi.fn(() => pending.promise)
    const gateway = gatewayWith({ toggles: toggles as unknown as () => Promise<FirewallToggles> })

    const firstLoad = useFirewallStore.getState().load(gateway)
    void useFirewallStore.getState().load(gateway)
    expect(toggles).toHaveBeenCalledTimes(1)

    pending.resolve({ ...TOGGLES, firewallEnabled: false })
    await firstLoad
    expect(useFirewallStore.getState().status).toBe('ready')
    expect(useFirewallStore.getState().toggles.firewallEnabled).toBe(false)
  })
})

const RULE_V4 = {
  id: 'ufw-allow-in-tcp-22-any.ipv4',
  protocol: 'tcp',
  port: 22,
  portTo: null,
  family: 'ipv4',
  status: 'normal',
  policy: 'allow',
  direction: 'inbound',
  source: '所有IP',
  note: null,
  updatedAt: null,
} as const

/* 同一条 ufw 规则在系统里是 v4/v6 两行：create 的响应只带回首行，重拉才能看到双生行。 */
const RULE_V6 = { ...RULE_V4, id: 'ufw-allow-in-tcp-22-any.ipv6', family: 'ipv6' } as const

describe('防火墙登录会话隔离', () => {
  it('登出时清除旧规则、开关和弹窗；新会话读取失败也不显示旧快照', async () => {
    const scan = useFirewallStore.getInitialState().scanProtection
    const gateway = gatewayWith({
      list: async () => [RULE_V4],
      toggles: async () => ({ ...TOGGLES, firewallEnabled: false }),
      scanProtection: async () => ({ ...scan, enabled: true, config: { ...scan.config, ports: [22] } }),
    })
    const session = useSessionStore.getState()
    const firewall = useFirewallStore.getState()
    await session.login(gateway, 'admin', 'password')
    await firewall.load(gateway)
    firewall.openEdit(RULE_V4)
    expect(useFirewallStore.getState()).toMatchObject({ status: 'ready', rules: [RULE_V4], dialogRule: RULE_V4, scanStatus: 'ready' })
    await session.logout(gateway)
    expect(useFirewallStore.getState()).toMatchObject({ status: 'idle', rules: [], toggles: TOGGLES, dialogRule: undefined, scanStatus: 'idle', scanProtection: scan })
    await session.login(gateway, 'admin', 'password')
    await firewall.load(gatewayWith({ list: async () => { throw new Error('新会话读取失败') } }))
    expect(useFirewallStore.getState()).toMatchObject({ status: 'error', rules: [], errorMessage: '新会话读取失败' })
  })

  it.each(['成功', '超时'] as const)('旧开关操作%s不覆盖新开关、不释放忙碌标记、不回读', async (outcome) => {
    const old = deferred<FirewallToggles>()
    const next = deferred<FirewallToggles>()
    const readBack = vi.fn(async () => TOGGLES)
    const oldValue = { ...TOGGLES, firewallEnabled: false }
    const newValue = { ...TOGGLES, pingBlocked: false }
    const gateway = gatewayWith({ toggles: readBack, setToggles: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise) })
    const session = useSessionStore.getState()
    const { toggle } = useFirewallStore.getState()
    await session.login(gateway, 'admin', 'password')
    const previous = toggle(gateway, oldValue)
    session.expire()
    await session.login(gateway, 'admin', 'password')
    const current = toggle(gateway, newValue)
    if (outcome === '成功') old.resolve(oldValue)
    else old.reject(new RequestTimeoutError(true))
    await previous
    expect(useFirewallStore.getState()).toMatchObject({ toggles: newValue, toggling: true, operationError: undefined })
    expect(readBack).not.toHaveBeenCalled()
    expect(useMessageStore.getState().messages).toEqual([])
    next.resolve(newValue)
    await current
    expect(useFirewallStore.getState().toggling).toBe(false)
  })

  it('旧 IP 规则成功和旧端口转发失败都不干扰新会话弹窗', async () => {
    const rule = { id: 'ip-rule', source: '203.0.113.9', policy: 'deny', family: 'ipv4', note: null, updatedAt: null } as const
    const forward = { protocol: 'tcp', port: 8080, targetHost: '192.0.2.1', targetPort: 80, note: null } as const
    const oldRule = deferred<typeof rule>()
    const oldForward = deferred<never>()
    const list = vi.fn(async () => [])
    const gateway = gatewayWith({ list, createIpRule: () => oldRule.promise, createForward: () => oldForward.promise })
    const session = useSessionStore.getState()
    const firewall = useFirewallStore.getState()
    await session.login(gateway, 'admin', 'password')
    firewall.openCreateIp()
    const savingRule = firewall.saveIpRule(gateway, rule)
    session.expire()
    await session.login(gateway, 'admin', 'password')
    firewall.openCreateForward()
    const savingForward = firewall.saveForward(gateway, forward)
    oldRule.resolve(rule)
    expect(await savingRule).toBe(false)
    expect(useFirewallStore.getState()).toMatchObject({ dialogForward: 'new', saving: true })
    session.expire()
    await session.login(gateway, 'admin', 'password')
    firewall.openCreateForward()
    oldForward.reject(new Error('旧提交失败'))
    expect(await savingForward).toBe(false)
    expect(useFirewallStore.getState()).toMatchObject({ dialogForward: 'new', operationError: undefined })
    expect(list).not.toHaveBeenCalled()
    expect(useMessageStore.getState().messages).toEqual([])
  })

  it('旧系统同步结束后不发起新会话下的列表回读', async () => {
    const sync = deferred<{ total: number }>()
    const list = vi.fn(async () => [])
    const gateway = gatewayWith({ syncFromSystem: () => sync.promise, list })
    const session = useSessionStore.getState()
    await session.login(gateway, 'admin', 'password')
    const pending = useFirewallStore.getState().syncFromSystem(gateway)
    expect(useFirewallStore.getState().syncing).toBe(true)
    session.expire()
    await session.login(gateway, 'admin', 'password')
    sync.resolve({ total: 1 })
    await pending
    expect(list).not.toHaveBeenCalled()
    expect(useFirewallStore.getState().syncing).toBe(false)
  })
})

describe('变更后与系统重拉同步', () => {
  it('保存端口规则后重拉列表：v4/v6 双生行都出现，而不是只追加响应里的首行', async () => {
    const list = vi.fn(async () => [RULE_V4, RULE_V6])
    const gateway = gatewayWith({
      list: list as unknown as () => Promise<readonly FirewallRule[]>,
      create: async () => RULE_V4,
    })

    useFirewallStore.setState({ dialogRule: 'new' })
    const saved = await useFirewallStore.getState().saveRule(gateway, {
      protocol: 'tcp',
      port: 22,
      family: 'ipv4',
      policy: 'allow',
      direction: 'inbound',
      source: '',
      note: null,
    })

    expect(saved).toBe(true)
    const rules = useFirewallStore.getState().rules
    expect(rules.map((rule) => rule.id)).toEqual(['ufw-allow-in-tcp-22-any.ipv4', 'ufw-allow-in-tcp-22-any.ipv6'])
  })

  it('删除规则后重拉列表：删除的规范连同 v4/v6 双生行一起消失', async () => {
    const list = vi.fn(async () => [])
    const gateway = gatewayWith({
      list: list as unknown as () => Promise<readonly FirewallRule[]>,
      remove: async () => undefined,
    })
    useFirewallStore.setState({ rules: [RULE_V4, RULE_V6] })

    await useFirewallStore.getState().removeRule(gateway, 'port', RULE_V4.id)

    expect(useFirewallStore.getState().rules).toEqual([])
  })
})
