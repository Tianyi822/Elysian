import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FirewallToggles } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { useFirewallStore } from './firewallStore'
import { useNotificationStore } from './notificationStore'

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
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function gatewayWith(overrides: Partial<ElysianGateway['firewall']> = {}): ElysianGateway {
  return {
    firewall: {
      toggles: async () => ({ ...TOGGLES }),
      list: async () => [],
      listIpRules: async () => [],
      listForwards: async () => [],
      setToggles: async (next: FirewallToggles) => ({ ...next }),
      ...overrides,
    },
  } as unknown as ElysianGateway
}

beforeEach(() => {
  useFirewallStore.setState(useFirewallStore.getInitialState())
  useNotificationStore.setState({ notifications: [] })
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
    expect(useNotificationStore.getState().notifications.at(-1)).toMatchObject({ tone: 'danger' })

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
