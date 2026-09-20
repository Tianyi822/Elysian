import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FirewallScanConfig } from '@elysian/contracts'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useFirewallStore } from '../../stores/firewallStore'
import { renderApp } from '../../test/renderApp'

/**
 * 端口防扫描弹窗的监控端口前置校验：面板端口（5173）加进监控会把正常访问面板的
 * 连接也计入封禁判据，客户端与服务端同规则拒绝，两侧文案一致。
 */

beforeEach(() => {
  useFirewallStore.setState({
    status: 'idle',
    errorMessage: undefined,
    rules: [],
    ipRules: [],
    forwards: [],
    view: 'port',
    toggles: { firewallEnabled: true, pingBlocked: true, defaultIncoming: 'deny', defaultOutgoing: 'allow' },
    search: '',
    page: 1,
    dialogRule: undefined,
    dialogIpRule: undefined,
    dialogForward: undefined,
    removeTarget: undefined,
    scanDialogOpen: false,
    scanStatus: 'idle',
    scanProtection: {
      enabled: false,
      config: { ports: [], windowSeconds: 60, hitCount: 8, banSeconds: 3600 },
      stats: { totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 },
      blocked: [],
    },
    exportDialogOpen: false,
    syncing: false,
    saving: false,
    removingRuleIds: [],
  })
})

/** 委托式防火墙替身：setScanConfig 记录调用后再交回基础实现。 */
function scanSessionGateway(calls: FirewallScanConfig[]): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const firewall = base.firewall
  // 适配器方法在原型上，展开会丢；显式委托再叠加覆盖项。
  return {
    ...base,
    firewall: {
      list: () => firewall.list(),
      toggles: () => firewall.toggles(),
      setToggles: (next) => firewall.setToggles(next),
      create: (input) => firewall.create(input),
      update: (ruleId, input) => firewall.update(ruleId, input),
      remove: (ruleId) => firewall.remove(ruleId),
      importRules: (inputs) => firewall.importRules(inputs),
      listIpRules: () => firewall.listIpRules(),
      createIpRule: (input) => firewall.createIpRule(input),
      updateIpRule: (ruleId, input) => firewall.updateIpRule(ruleId, input),
      removeIpRule: (ruleId) => firewall.removeIpRule(ruleId),
      listForwards: () => firewall.listForwards(),
      createForward: (input) => firewall.createForward(input),
      updateForward: (ruleId, input) => firewall.updateForward(ruleId, input),
      removeForward: (ruleId) => firewall.removeForward(ruleId),
      scanProtection: () => firewall.scanProtection(),
      setScanProtection: (enabled) => firewall.setScanProtection(enabled),
      setScanConfig: (config) => {
        calls.push(config)
        return firewall.setScanConfig(config)
      },
      unblockIp: (ip) => firewall.unblockIp(ip),
      syncFromSystem: () => firewall.syncFromSystem(),
    },
  }
}

describe('端口防扫描监控端口校验', () => {
  it('监控端口含 5173：提示面板端口不允许加入并拦下保存，不发请求；换掉后可保存', async () => {
    const calls: FirewallScanConfig[] = []
    const gateway = scanSessionGateway(calls)
    renderApp('/security', { gateway })
    await screen.findByRole('region', { name: '端口规则表' })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '端口防扫描' }))
    const dialog = await screen.findByRole('dialog', { name: '端口防扫描' })
    const portsInput = within(dialog).getByLabelText('监控端口（逗号分隔）')

    await user.clear(portsInput)
    await user.type(portsInput, '22,5173')
    await user.click(within(dialog).getByRole('button', { name: '保存配置' }))

    // 客户端先拦：文案与服务端同规则同句，请求根本不出门
    expect(within(dialog).getByText('面板端口不允许加入防扫描监控')).toBeInTheDocument()
    expect(calls).toHaveLength(0)

    // 换成不含面板端口的列表即可保存
    await user.clear(portsInput)
    await user.type(portsInput, '22')
    await user.click(within(dialog).getByRole('button', { name: '保存配置' }))
    await waitFor(() =>
      expect(within(dialog).queryByText('面板端口不允许加入防扫描监控')).not.toBeInTheDocument(),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ ports: [22] })
  })
})
