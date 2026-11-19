import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FirewallRuleInput } from '@elysian/contracts'
import { resetFirewallData } from '../../adapters/mock/firewallData'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useFirewallStore } from '../../stores/firewallStore'
import { renderApp } from '../../test/renderApp'

/**
 * 端口规则弹窗的备注前置校验：单引号会截断 ufw 的 comment 参数、控制字符写坏规则回读，
 * 判据与文案与服务端（apps/server-go/internal/firewall/notevalidation.go 的 ufw 场景）一致，
 * 输入时就提示，而不是提交后才被服务端拒绝。
 */

/** 等规则表就绪（加载态消失）。 */
async function openFirewallPage(gateway: ElysianGateway) {
  renderApp('/security', { gateway })
  await screen.findByRole('region', { name: '端口规则表' })
  return userEvent.setup()
}

beforeEach(() => {
  resetFirewallData()
  useFirewallStore.setState({
    status: 'idle',
    errorMessage: undefined,
    rules: [],
    ipRules: [],
    forwards: [],
    tab: 'port',
    toggles: { firewallEnabled: true, pingBlocked: true, defaultIncoming: 'deny', defaultOutgoing: 'allow' },
    search: '',
    page: 1,
    dialogRule: undefined,
    dialogIpRule: undefined,
    dialogForward: undefined,
    removeTarget: undefined,
    scanSaving: false,
    scanStatus: 'idle',
    scanProtection: {
      enabled: false,
      config: { ports: [], windowSeconds: 60, hitCount: 8, banSeconds: 3600 },
      stats: { totalBlockedIps: 0, totalFailedConnections: 0, currentBlockedIps: 0, currentFailedConnections: 0 },
      blocked: [],
    },
    syncing: false,
    saving: false,
    removingRuleIds: [],
  })
})

describe('端口规则弹窗', () => {
  it('添加时保存防扫描配置，修改时回显并更新；关闭或 UDP 隐藏配置', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const user = await openFirewallPage(gateway)
    await user.click(screen.getByRole('button', { name: '添加端口规则' }))
    let dialog = await screen.findByRole('dialog', { name: '添加端口规则' })
    expect(within(dialog).getByRole('switch', { name: '防扫描' })).toBeDisabled()
    expect(within(dialog).queryByRole('group', { name: '防扫描配置' })).not.toBeInTheDocument()
    await user.type(within(dialog).getByRole('textbox', { name: /^端口/ }), '8443')
    await user.click(within(dialog).getByRole('switch', { name: '防扫描' }))
    expect(within(dialog).getByText('以下配置由所有已开启防扫描的端口共用，修改后统一生效。')).toBeInTheDocument()
    for (const [label, value] of [['判定窗口（秒）', '120'], ['触发阈值（次）', '6'], ['封禁时长（秒）', '7200']]) {
      const input = within(dialog).getByRole('spinbutton', { name: label! })
      expect(input).toBeRequired()
      await user.clear(input)
      await user.type(input, value!)
    }
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const savedConfig = (await gateway.firewall.scanProtection()).config
    expect(savedConfig).toMatchObject({ windowSeconds: 120, hitCount: 6, banSeconds: 7200 })
    expect(savedConfig.ports).toContain(8443)
    expect(savedConfig.ports).toContain(22)
    await user.type(screen.getByRole('searchbox'), '8443')
    const row = screen.getByRole('row', { name: /选择 tcp 8443/ })
    expect(within(row).queryByRole('switch')).not.toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: '修改' }))
    dialog = await screen.findByRole('dialog', { name: '修改端口规则' })
    expect(within(dialog).getByRole('switch', { name: '防扫描' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).getByRole('spinbutton', { name: '判定窗口（秒）' })).toHaveValue(120)
    expect(within(dialog).getByRole('spinbutton', { name: '触发阈值（次）' })).toHaveValue(6)
    const duration = within(dialog).getByRole('spinbutton', { name: '封禁时长（秒）' })
    expect(duration).toHaveValue(7200)
    await user.clear(duration)
    await user.type(duration, '1800')
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect((await gateway.firewall.scanProtection()).config.banSeconds).toBe(1800)
    await user.click(within(screen.getByRole('row', { name: /选择 tcp 8443/ })).getByRole('button', { name: '修改' }))
    dialog = await screen.findByRole('dialog', { name: '修改端口规则' })
    await user.click(within(dialog).getByRole('switch', { name: '防扫描' }))
    expect(within(dialog).queryByRole('group', { name: '防扫描配置' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect((await gateway.firewall.scanProtection()).config.ports).not.toContain(8443)
    await user.click(screen.getByRole('button', { name: '添加端口规则' }))
    dialog = await screen.findByRole('dialog', { name: '添加端口规则' })
    await user.type(within(dialog).getByRole('textbox', { name: /^端口/ }), '8444')
    await user.click(within(dialog).getByRole('button', { name: 'udp' }))
    expect(within(dialog).getByRole('switch', { name: '防扫描' })).toBeDisabled()
    expect(within(dialog).queryByRole('group', { name: '防扫描配置' })).not.toBeInTheDocument()
    expect(within(dialog).getByText('防扫描仅适用于 TCP 入站端口')).toBeInTheDocument()
  })

  it('开启时配置必填并校验整数范围，关闭后不校验或提交隐藏的配置', async () => {
    const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const create = vi.spyOn(gateway.firewall, 'create')
    const configure = vi.spyOn(gateway.firewall, 'setScanConfig')
    const user = await openFirewallPage(gateway)
    await user.click(screen.getByRole('button', { name: '添加端口规则' }))
    const dialog = await screen.findByRole('dialog', { name: '添加端口规则' })
    await user.type(within(dialog).getByRole('textbox', { name: /^端口/ }), '8443')
    await user.click(within(dialog).getByRole('switch', { name: '防扫描' }))
    const fields = ['判定窗口（秒）', '触发阈值（次）', '封禁时长（秒）'].map(label => within(dialog).getByRole('spinbutton', { name: label }))
    for (const input of fields) await user.clear(input)
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    expect(within(dialog).getByText('请填写判定窗口')).toBeInTheDocument()
    expect(within(dialog).getByText('请填写触发阈值')).toBeInTheDocument()
    expect(within(dialog).getByText('请填写封禁时长')).toBeInTheDocument()
    for (const [index, value] of ['9', '1001', '59'].entries()) await user.type(fields[index]!, value)
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    expect(within(dialog).getByText('判定窗口需为 10–3600 秒的整数')).toBeInTheDocument()
    expect(within(dialog).getByText('触发阈值需为 3–1000 次的整数')).toBeInTheDocument()
    expect(within(dialog).getByText('封禁时长需为 60–86400 秒的整数')).toBeInTheDocument()
    await user.clear(fields[0]!)
    await user.type(fields[0]!, '120.5')
    expect(fields[0]).toHaveAttribute('aria-invalid', 'true')
    expect(create).not.toHaveBeenCalled()
    expect(configure).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('switch', { name: '防扫描' }))
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(create).toHaveBeenCalledTimes(1)
    expect(configure).not.toHaveBeenCalled()
  })

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
        listIpRules: () => firewall.listIpRules(),
        createIpRule: (input) => firewall.createIpRule(input),
        updateIpRule: (ruleId, input) => firewall.updateIpRule(ruleId, input),
        removeIpRule: (ruleId) => firewall.removeIpRule(ruleId),
        listForwards: () => firewall.listForwards(),
        createForward: (input) => firewall.createForward(input),
        updateForward: (ruleId, input) => firewall.updateForward(ruleId, input),
        removeForward: (ruleId) => firewall.removeForward(ruleId),
        scanProtection: () => firewall.scanProtection(),
        setRuleScanProtection: (id, enabled) => firewall.setRuleScanProtection(id, enabled),
        setScanProtection: (enabled) => firewall.setScanProtection(enabled),
        setScanConfig: (config) => firewall.setScanConfig(config),
        unblockIp: (ip) => firewall.unblockIp(ip),
        syncFromSystem: () => firewall.syncFromSystem(),
      },
    }
    const user = await openFirewallPage(gateway)

    await user.click(screen.getByRole('button', { name: '添加端口规则' }))
    const dialog = await screen.findByRole('dialog', { name: '添加端口规则' })
    await user.type(within(dialog).getByRole('textbox', { name: /^端口/ }), '8443')

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
