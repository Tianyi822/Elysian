import { messageHistoryText } from '../../test/messageHistory'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_PORT } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { SEED_FORWARDS, SEED_IP_RULES, SEED_RULES, resetFirewallData } from '../../adapters/mock/firewallData'
import { useFirewallStore, FIREWALL_PAGE_SIZE } from '../../stores/firewallStore'
import { useMessageStore } from '../../stores/messageStore'
import { renderApp } from '../../test/renderApp'
import { scrollTablesToEnd } from '../../test/tableRows'

/**
 * 防火墙面板的端到端行为：分页、搜索、开关、三类规则视图与增删改。
 * 数据走默认 mock 数据集（种子规则），计数断言直接取种子长度，避免抄数字走样。
 */

const SEED_RULE_COUNT = SEED_RULES.length

function sessionGateway(overrides: Partial<ElysianGateway['firewall']> = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const firewall = base.firewall
  return {
    ...base,
    // 适配器方法在原型上，展开会丢；显式委托再叠加覆盖项。
    firewall: {
      dockerPorts: () => firewall.dockerPorts(),
      list: () => firewall.list(),
      toggles: () => firewall.toggles(),
      setToggles: (next) => firewall.setToggles(next),
      create: (input) => firewall.create(input),
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
      ...overrides,
    },
  }
}

/** 等规则表就绪（加载态消失、出现分页条）。 */
async function openFirewallPage(gateway: ElysianGateway = sessionGateway()) {
  renderApp('/security', { gateway })
  await screen.findByRole('region', { name: '端口规则表' })
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
    toggling: false,
    removingRuleIds: [],
    unblockingIps: [],
  })
})

describe('防火墙面板', () => {
  it('Docker 发布清单与 UFW 规则独立，支持预填并标记引擎中断后的旧绑定', async () => {
    const user = userEvent.setup()
    const dockerPorts = vi.fn<ElysianGateway['firewall']['dockerPorts']>()
      .mockResolvedValueOnce({
        inventory: 'ready',
        ports: [{ containerId: 'ctr', containerName: 'derper', hostIp: '::', hostPort: 12080, containerPort: 80, protocol: 'tcp' }],
        guard: { state: 'verified', kernelVerified: true },
      })
      .mockResolvedValue({ inventory: 'unavailable', ports: [], guard: { state: 'degraded', kernelVerified: true } })
    await openFirewallPage(sessionGateway({ list: async () => [], dockerPorts }))
    const inventory = await screen.findByRole('region', { name: 'Docker 发布端口' })
    const add = await within(inventory).findByRole('button', { name: '为 derper :: 12080/tcp 添加规则' })
    expect(within(inventory).getByText('转发接管已核验')).toBeInTheDocument()
    await user.click(add)
    const dialog = await screen.findByRole('dialog', { name: '添加端口规则' })
    expect(within(dialog).getByDisplayValue('12080')).toBeInTheDocument()
    expect(within(dialog).getByText(/来源留空时覆盖所有来源/)).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(add).toHaveFocus())
    await user.click(within(inventory).getByRole('button', { name: '刷新 Docker 发布端口' }))
    expect(await within(inventory).findByText(/显示上次读取的绑定/)).toBeInTheDocument()
    expect(within(inventory).getByText('转发接管异常')).toBeInTheDocument()
    expect(add).toBeDisabled()
  })

  it('校验提示只留在表单，真实保存失败同时保留行内原因和消息', async () => {
    const user = userEvent.setup()
    const create = vi.fn().mockRejectedValue(new Error('防火墙暂不可写'))
    await openFirewallPage(sessionGateway({ create }))
    await user.click(screen.getByRole('button', { name: '添加端口规则' }))
    const dialog = await screen.findByRole('dialog', { name: '添加端口规则' })
    const previousCount = useMessageStore.getState().messages.length
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    expect(create).not.toHaveBeenCalled()
    expect(useMessageStore.getState().messages).toHaveLength(previousCount)
    await user.type(within(dialog).getByRole('textbox', { name: /^端口/ }), '3388')
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('保存失败：防火墙暂不可写')
    expect(within(dialog).getByRole('textbox', { name: /^端口/ })).toHaveValue('3388')
    expect(useMessageStore.getState().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: 'danger', message: '保存失败：防火墙暂不可写' }),
    ]))
  })

  it('先展示 20 条，滚到底补足剩余行并保留前面数据', async () => {
    await openFirewallPage()
    const table = screen.getByRole('region', { name: '端口规则表' })
    expect(within(table).getAllByRole('row')).toHaveLength(FIREWALL_PAGE_SIZE + 1)
    expect(screen.queryByRole('navigation', { name: '分页' })).not.toBeInTheDocument()
    expect(within(table).queryByRole('button', { name: /显示更多/ })).not.toBeInTheDocument()
    await scrollTablesToEnd()
    expect(within(table).getAllByRole('row')).toHaveLength(SEED_RULE_COUNT + 1)
  })

  it('搜索按端口与备注过滤，无结果给空行提示', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    await user.type(screen.getByLabelText('搜索端口、来源或备注'), '2234')
    const table = screen.getByRole('region', { name: '端口规则表' })
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3)) // 表头 + v4/v6 两行

    await user.clear(screen.getByLabelText('搜索端口、来源或备注'))
    expect(screen.getByLabelText('搜索端口、来源或备注')).toHaveValue('')
    expect(screen.getByLabelText('搜索端口、来源或备注')).toHaveFocus()
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(FIREWALL_PAGE_SIZE + 1))
    await user.type(screen.getByLabelText('搜索端口、来源或备注'), '不存在的规则')
    expect(await screen.findByText('没有结果')).toBeInTheDocument()
  })

  it('开关切换即改状态并发 mock 通知', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    await user.click(screen.getByRole('switch', { name: '禁ping' }))

    expect(screen.getByRole('switch', { name: '禁ping' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(messageHistoryText('status')).toContain(
      '禁 ping 已关闭（mock，待接入真实执行）',
    )
  })

  it('开关切换进行中两个开关都禁用：忙碌里的点击不会得到无反馈的忽略', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    const inflight = new Promise<void>((resolve) => {
      release = resolve
    })
    await openFirewallPage(
      sessionGateway({
        setToggles: async (next) => {
          await inflight
          return next
        },
      }),
    )

    const ping = screen.getByRole('switch', { name: '禁ping' })
    expect(ping).toHaveAttribute('data-easyui', 'liquid-toggle')
    // 数据集在同文件用例间共享，开关的初值按当场读到的算，通知文案才不会抄成一个方向。
    const wasChecked = ping.getAttribute('aria-checked') === 'true'
    await user.click(ping)

    // 请求在飞：两个开关都随 store 的 toggling 禁用，点击落不到被忽略的分支上。
    expect(ping).toBeDisabled()
    expect(ping).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('switch', { name: '防火墙开关' })).toBeDisabled()

    release?.()
    await waitFor(() => expect(screen.getByRole('switch', { name: '禁ping' })).toBeEnabled())
    // 那一次点击确实到了 adapter（不是被忙碌分支吞掉），并且切换完成后开关恢复可用。
    expect(messageHistoryText('status')).toContain(
      `禁 ping 已${wasChecked ? '关闭' : '开启'}（mock，待接入真实执行）`,
    )
  })

  it('添加端口规则：弹窗带演示标注，校验端口，创建后搜索可见并计入总数', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    await user.click(screen.getByRole('button', { name: '添加端口规则' }))
    const dialog = await screen.findByRole('dialog', { name: '添加端口规则' })
    expect(dialog.textContent).toContain('演示 · 待接入真实执行')

    // 空端口提交给行内错误，不发请求。label 文本带必填星号，用正则匹配。
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    expect(within(dialog).getByText(/端口需为 1-65535 的整数/)).toBeInTheDocument()

    await user.type(within(dialog).getByRole('textbox', { name: /^端口/ }), '8443')
    await user.type(within(dialog).getByLabelText('备注'), '演示入口')
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))

    expect(screen.queryByRole('dialog', { name: '添加端口规则' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('搜索端口、来源或备注'), '8443')
    await waitFor(() => expect(within(screen.getByRole('table', { name: '端口规则表' })).getAllByRole('row')).toHaveLength(2))
    expect(messageHistoryText('status')).toContain(
      '端口规则 tcp 8443 已添加（mock，待接入真实执行）',
    )
  })

  it('修改规则：改策略为拒绝后行内呈现变化', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    // v4/v6 两行的可访问名都含 2234，取第一行（v4）。
    const row = screen.getAllByRole('row', { name: /2234/ })[0]!
    await user.click(within(row).getByRole('button', { name: '修改' }))
    const dialog = await screen.findByRole('dialog', { name: /修改端口规则/ })
    await user.click(within(dialog).getByRole('button', { name: '拒绝' }))
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getAllByRole('row', { name: /2234/ })[0]).toHaveTextContent('拒绝')
  })

  it('删除规则需要确认：取消不删，确认后行消失并留 mock 通知', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    const row = screen.getAllByRole('row', { name: /2234/ })[0]!
    await user.click(within(row).getByRole('button', { name: '删除' }))
    const confirm = await screen.findByRole('dialog', { name: '确认删除端口规则「tcp 2234」？' })

    await user.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // 每个用例从原始种子独立开始；行数取表格的完整匹配数，不受分批挂载影响。
    expect(screen.getByRole('table', { name: '端口规则表' })).toHaveAttribute('aria-rowcount', String(SEED_RULE_COUNT + 1))

    await user.click(within(row).getByRole('button', { name: '删除' }))
    await user.click(
      within(await screen.findByRole('dialog', { name: '确认删除端口规则「tcp 2234」？' })).getByRole(
        'button',
        { name: '确认删除' },
      ),
    )
    await waitFor(() => expect(screen.getByRole('table', { name: '端口规则表' })).toHaveAttribute('aria-rowcount', String(SEED_RULE_COUNT)))
    expect(messageHistoryText('status')).toContain(
      '端口规则 tcp 2234 已删除（mock，待接入真实执行）',
    )
  })

  it('多选一次确认后逐项删除演示双栈行，面板保底规则在派发前跳过', async () => {
    const user = userEvent.setup()
    let rules = [
      { ...SEED_RULES[0]!, id: 'batch-v4' },
      { ...SEED_RULES[1]!, id: 'batch-v6' },
      { ...SEED_RULES[0]!, id: 'protected-panel', port: PANEL_PORT },
    ]
    const remove = vi.fn(async (id: string) => { rules = rules.filter(rule => rule.id !== id) })
    await openFirewallPage(sessionGateway({ list: async () => rules, remove }))
    const region = screen.getByRole('region', { name: '端口规则表' })
    await user.click(within(region).getByRole('checkbox', { name: '全选已加载的匹配行' }))
    expect(await within(region).findByText('已选 3 项')).toBeInTheDocument()
    const selectionActions = within(region).getByRole('group', { name: '多选操作' })
    const removeButton = within(selectionActions).getByRole('button', { name: '删除' })
    expect(removeButton.querySelector('svg')).not.toBeNull()
    expect(within(selectionActions).getByRole('button', { name: '清除' }).querySelector('svg')).not.toBeNull()
    await user.click(removeButton)
    const confirm = await screen.findByRole('dialog', { name: '确认删除？' })
    expect(confirm).toHaveTextContent('将处理 2 项，跳过 1 项')
    expect(confirm).toHaveTextContent('面板入口保底规则不允许删除')
    expect(remove).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole('button', { name: '确认删除' }))
    const result = await screen.findByRole('dialog', { name: '删除结果' })
    await waitFor(() => expect(within(result).getByRole('button', { name: '关闭' })).toBeEnabled())
    expect(remove.mock.calls.map(call => call[0])).toEqual(['batch-v4', 'batch-v6'])
    expect(rules.map(rule => rule.id)).toEqual(['protected-panel'])
    expect(result).toHaveTextContent('跳过')
  })

  it('规则工具合入表格搜索栏，保持控件尺寸和连续方向键切换', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    const table = screen.getByRole('region', { name: '端口规则表' })
    const controls = within(table).getByRole('group', { name: '规则操作' })
    const tabs = within(table).getByRole('group', { name: '规则类型' })
    const add = within(controls).getByRole('button', { name: '添加端口规则' })
    // EasyUI 工具按钮沿用原来的不收缩、不拆标签约束。
    expect(add).toHaveClass('shrink-0', 'whitespace-nowrap')
    expect(add).toHaveTextContent(/^添加规则$/)
    expect(tabs).toHaveClass('shrink-0')
    expect(within(controls).queryByRole('button', { name: '端口防扫描' })).not.toBeInTheDocument()
    expect(within(controls).getByRole('button', { name: '同步规则' })).toBeEnabled()
    expect(within(table).queryByText(/^\d+ 行$/)).not.toBeInTheDocument()

    await user.click(within(tabs).getByRole('button', { name: '端口规则' }))
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: 'IP 规则' })).toHaveFocus()
    expect(screen.getByRole('group', { name: '规则操作' })).toBe(controls)
    expect(screen.getByRole('group', { name: '规则类型' })).toBe(tabs)
    expect(screen.getByRole('button', { name: '添加 IP 规则' })).toHaveTextContent(/^添加规则$/)
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: '端口转发' })).toHaveFocus()
    expect(screen.getByRole('group', { name: '规则类型' })).toBe(tabs)
    expect(screen.getByRole('button', { name: '添加端口转发' })).toHaveTextContent(/^添加规则$/)
  })

  it('多选只替换搜索和规则动作，常驻页签可以直接切换类型并清除旧选择', async () => {
    const user = userEvent.setup()
    await openFirewallPage()
    const table = screen.getByRole('region', { name: '端口规则表' })
    const tabs = within(table).getByRole('group', { name: '规则类型' })
    const ipTab = within(tabs).getByRole('button', { name: 'IP 规则' })
    await user.click(within(table).getByRole('checkbox', { name: '全选已加载的匹配行' }))
    expect(await within(table).findByText(`已选 ${SEED_RULE_COUNT} 项`)).toBeInTheDocument()
    await waitFor(() => expect(within(table).queryByRole('searchbox')).not.toBeInTheDocument())
    expect(screen.getByRole('group', { name: '规则类型' })).toBe(tabs)
    expect(screen.getByRole('button', { name: 'IP 规则' })).toBe(ipTab)
    expect(within(table).queryByRole('button', { name: '添加端口规则' })).not.toBeInTheDocument()

    await user.click(ipTab)
    const ipTable = await screen.findByRole('region', { name: 'IP 规则表' })
    expect(screen.getByRole('group', { name: '规则类型' })).toBe(tabs)
    expect(ipTab).toHaveAttribute('aria-pressed', 'true')
    expect(await within(ipTable).findByRole('searchbox', { name: '搜索来源或备注' })).toHaveValue('')
    expect(within(ipTable).queryByText(/^已选 \d+ 项$/)).not.toBeInTheDocument()
    expect(within(ipTable).getByRole('button', { name: '添加 IP 规则' })).toBeEnabled()
    expect(within(ipTable).getByRole('checkbox', { name: '全选已加载的匹配行' })).toHaveAttribute('aria-checked', 'false')
  })

  it('清除多选恢复搜索焦点，页签元素保持不变', async () => {
    const user = userEvent.setup()
    await openFirewallPage()
    const table = screen.getByRole('region', { name: '端口规则表' })
    const tabs = within(table).getByRole('group', { name: '规则类型' })
    await user.click(within(table).getByRole('checkbox', { name: '全选已加载的匹配行' }))
    await user.click(await within(table).findByRole('button', { name: '清除' }))
    await waitFor(() => expect(within(table).getByRole('searchbox')).toHaveFocus())
    expect(screen.getByRole('group', { name: '规则类型' })).toBe(tabs)
    expect(within(table).getByRole('button', { name: '添加端口规则' })).toBeEnabled()
  })

  it('操作列只保留修改与删除，表单开启防扫描后双栈端口均显示盾牌与提示', async () => {
    const user = userEvent.setup()
    await openFirewallPage()
    const table = screen.getByRole('region', { name: '端口规则表' })
    expect(within(table).queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '端口防扫描' })).not.toBeInTheDocument()
    const rows = within(table).getAllByRole('row', { name: /选择 tcp 2234/ })
    expect(within(rows[0]!).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['修改', '删除'])
    await user.click(within(rows[0]!).getByRole('button', { name: '修改' }))
    let dialog = await screen.findByRole('dialog', { name: '修改端口规则' })
    await user.click(within(dialog).getByRole('switch', { name: '防扫描' }))
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(useFirewallStore.getState().scanProtection.config.ports).toContain(2234)
    expect(useFirewallStore.getState().scanProtection.config.ports).not.toContain(2233)
    const protectedRows = within(table).getAllByRole('row', { name: /选择 tcp 2234/ })
    for (const row of protectedRows) expect(within(row).getByRole('img', { name: '已开启防扫描' })).toBeInTheDocument()
    for (const row of within(table).getAllByRole('row', { name: /选择 tcp 2233/ })) {
      expect(within(row).queryByRole('img', { name: '已开启防扫描' })).not.toBeInTheDocument()
    }
    const shield = within(protectedRows[0]!).getByRole('img', { name: '已开启防扫描' })
    await user.hover(shield)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('已开启防扫描')
    await user.unhover(shield)
    await user.click(within(within(table).getAllByRole('row', { name: /选择 tcp 2234/ })[1]!).getByRole('button', { name: '修改' }))
    dialog = await screen.findByRole('dialog', { name: '修改端口规则' })
    expect(within(dialog).getByRole('switch', { name: '防扫描' })).toHaveAttribute('aria-checked', 'true')
  })

  it('扫描读取失败仍保留规则，编辑表单里的防扫描开关禁用', async () => {
    await openFirewallPage(sessionGateway({ scanProtection: async () => { throw new Error('扫描读取失败') } }))
    const table = screen.getByRole('region', { name: '端口规则表' })
    expect(within(table).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(table).queryByRole('img', { name: '已开启防扫描' })).not.toBeInTheDocument()
    expect(screen.getByText(/扫描读取失败/)).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(within(within(table).getAllByRole('row', { name: /选择 tcp 2234/ })[0]!).getByRole('button', { name: '修改' }))
    const dialog = await screen.findByRole('dialog', { name: '修改端口规则' })
    expect(within(dialog).getByRole('switch', { name: '防扫描' })).toBeDisabled()
  })

  it('同步规则：忙碌一拍后报从操作系统同步的 mock 通知', async () => {
    await openFirewallPage()
    const button = screen.getByRole('button', { name: '同步规则' })

    // 先渲染加载完再开假定时器：waitFor 依赖真实定时器，提前开会卡住页面等待。
    vi.useFakeTimers()
    try {
      fireEvent.click(button)
      expect(screen.getByRole('button', { name: '同步中…' })).toBeDisabled()

      await vi.advanceTimersByTimeAsync(800)
      // 同步后重拉三类列表，通知里的总数取界面统计条的三个计数之和。
      // 标签与读数同属一枚 EasyUI Badge，数字在兄弟节点上，所以读整枚标签。
      const chipCount = (label: string) =>
        Number(screen.getByText(label, { selector: '[data-easyui="badge"] > span' }).parentElement?.textContent?.match(/(\d+)/)?.[1] ?? '0')
      const expected = chipCount('端口规则') + chipCount('IP 规则') + chipCount('端口转发')
      expect(messageHistoryText('status')).toContain(
        `已从操作系统同步防火墙规则，当前共 ${expected} 条（mock，待接入真实执行）`,
      )
      expect(screen.getByRole('button', { name: '同步规则' })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('提供官方列排序与选择控件，原有备注完整值仍可读取', async () => {
    const user = userEvent.setup()
    await openFirewallPage()
    const region = screen.getByRole('region', { name: '端口规则表' })
    const headers = within(region).getAllByRole('columnheader')
    expect(headers.map(header => header.textContent)).toEqual(['', '端口', '协议', '使用状态', '策略', '方向', '来源', '备注', '时间', '操作'])
    expect(within(region).getAllByRole('checkbox')).toHaveLength(FIREWALL_PAGE_SIZE + 1)
    const notes = region.querySelectorAll('[title]')
    expect(Array.from(notes).some(note => note.getAttribute('title') === note.textContent)).toBe(true)
    const portHeader = headers[1]!
    await user.click(within(portHeader).getByRole('button'))
    expect(portHeader).toHaveAttribute('aria-sort', 'ascending')
    await user.click(within(portHeader).getByRole('button'))
    expect(portHeader).toHaveAttribute('aria-sort', 'descending')
  })

  it('加载失败给错误态与重试，数据集为空给空态', async () => {
    const user = userEvent.setup()
    let fail = true
    renderApp('/security', {
      gateway: sessionGateway({
        list: async () => {
          if (fail) throw new Error('演示连接失败')
          return []
        },
      }),
    })
    expect(await screen.findByText('防火墙数据加载失败')).toBeInTheDocument()

    fail = false
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('没有结果')).toBeInTheDocument()
  })

  it('IP 规则视图：统计与表格呈现种子数据，可新增一条', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    // 统计条按视图呈现三类计数
    expect(screen.getByText('IP 规则', { selector: '[data-easyui="badge"] > span' }).parentElement).toHaveTextContent(`${SEED_IP_RULES.length}`)

    await user.click(screen.getByRole('button', { name: 'IP 规则' }))
    const region = await screen.findByRole('region', { name: 'IP 规则表' })
    expect(within(region).getByText('185.220.101.7')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '添加 IP 规则' }))
    const dialog = await screen.findByRole('dialog', { name: '添加 IP 规则' })
    // 来源必填：直接提交给行内错误
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    expect(within(dialog).getByText(/来源必填/)).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText(/来源/), '198.51.100.0/24')
    await user.type(within(dialog).getByLabelText('备注'), '压力测试段')
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))

    await waitFor(() => expect(within(region).getByText('198.51.100.0/24')).toBeInTheDocument())
    expect(messageHistoryText('status')).toContain(
      'IP 规则 198.51.100.0/24 已添加（mock，待接入真实执行）',
    )
  })

  it('端口转发视图：表格呈现种子转发，可新增一条并校验目标地址', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    await user.click(screen.getByRole('button', { name: '端口转发' }))
    const region = await screen.findByRole('region', { name: '端口转发表' })
    expect(within(region).getByText(`${SEED_FORWARDS[0]!.targetHost}:${SEED_FORWARDS[0]!.targetPort}`)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '添加端口转发' }))
    const dialog = await screen.findByRole('dialog', { name: '添加端口转发' })

    await user.type(within(dialog).getByLabelText(/外部端口/), '9090')
    await user.type(within(dialog).getByLabelText(/目标地址/), 'not-an-ip')
    await user.type(within(dialog).getByLabelText(/目标端口/), '80')
    await user.click(within(dialog).getByRole('button', { name: '添加转发' }))
    expect(within(dialog).getByText('目标地址需为 IPv4（如 10.0.0.5）')).toBeInTheDocument()

    await user.clear(within(dialog).getByLabelText(/目标地址/))
    await user.type(within(dialog).getByLabelText(/目标地址/), '10.0.0.20')
    await user.click(within(dialog).getByRole('button', { name: '添加转发' }))

    await waitFor(() => expect(within(region).getByText('10.0.0.20:80')).toBeInTheDocument())
    expect(messageHistoryText('status')).toContain(
      '端口转发 tcp 9090 → 10.0.0.20:80 已添加（mock，待接入真实执行）',
    )
  })
})
