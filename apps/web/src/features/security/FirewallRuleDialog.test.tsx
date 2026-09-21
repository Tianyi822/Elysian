import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FirewallRuleInput } from '@elysian/contracts'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useFirewallStore } from '../../stores/firewallStore'
import { renderApp } from '../../test/renderApp'

/**
 * 端口规则弹窗的备注前置校验：单引号会截断 ufw 的 comment 参数、控制字符写坏规则回读，
 * 判据与文案与服务端（apps/server/src/shared/noteValidation.ts 的 ufw 场景）一致，
 * 输入时就提示，而不是提交后才被服务端拒绝。
 */

/** 等规则表就绪（加载态消失）。 */
async function openFirewallPage(gateway: ElysianGateway) {
  renderApp('/security', { gateway })
  await screen.findByRole('region', { name: '端口规则表' })
  return userEvent.setup()
}

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

describe('端口规则弹窗备注校验', () => {
  it('备注含单引号：输入即提示（与服务端同一句），提交被拦不发请求；改好后可添加', async () => {
    const creates: FirewallRuleInput[] = []
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const firewall = base.firewall
    const gateway: ElysianGateway = {
      ...base,
      // 适配器方法在原型上，展开会丢；显式委托再叠加覆盖项。
      firewall: {
        list: () => firewall.list(),
        toggles: () => firewall.toggles(),
        setToggles: (next) => firewall.setToggles(next),
        create: (input) => {
          creates.push(input)
          return firewall.create(input)
        },
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
        setScanConfig: (config) => firewall.setScanConfig(config),
        unblockIp: (ip) => firewall.unblockIp(ip),
        syncFromSystem: () => firewall.syncFromSystem(),
      },
    }
    const user = await openFirewallPage(gateway)

    await user.click(screen.getByRole('button', { name: '添加端口规则' }))
    const dialog = await screen.findByRole('dialog', { name: '添加端口规则' })
    await user.type(within(dialog).getByLabelText(/端口/), '8443')

    // 打进一个单引号：还没提交错误就已经在——文案与服务端错误逐字一致
    const noteInput = within(dialog).getByLabelText('备注')
    await user.type(noteInput, "演示'入口")
    expect(within(dialog).getByText('备注不能包含单引号')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    expect(creates).toHaveLength(0)
    expect(screen.getByRole('dialog', { name: '添加端口规则' })).toBeInTheDocument()
    // 端口本身合法：被拦的是备注，不出现端口错误
    expect(within(dialog).queryByText(/端口需为/)).not.toBeInTheDocument()

    // 控制字符同样前置提示；单引号提示随修改消失
    await user.clear(noteInput)
    await user.type(noteInput, '演示\u0007入口')
    expect(within(dialog).queryByText('备注不能包含单引号')).not.toBeInTheDocument()
    expect(within(dialog).getByText('备注不能包含换行或控制字符')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    expect(creates).toHaveLength(0)

    // 改成合法备注即可添加
    await user.clear(noteInput)
    await user.type(noteInput, '演示入口')
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({ port: 8443, note: '演示入口' })
  })
})
