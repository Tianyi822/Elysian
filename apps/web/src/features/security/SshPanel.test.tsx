import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FirewallRule, FirewallRuleInput, FirewallToggles } from '@elysian/contracts'
import { SEED_LOGIN_RECORDS, SEED_SSH_PORT, SEED_SSH_STATS } from '../../adapters/mock/sshData'
import { resetFirewallData } from '../../adapters/mock/firewallData'
import type { ElysianGateway } from '../../contracts/adapters'
import { useNotificationStore } from '../../stores/notificationStore'
import { SSH_PAGE_SIZE, useSshStore } from '../../stores/sshStore'
import { renderApp } from '../../test/renderApp'
import { INITIAL_SSH_STATE, openSshTab, resetSshPanel, securityTab, sshSessions } from '../../test/sshPanel'
import { sshPortConfirmConsequences } from './SshPanel'

/**
 * SSH 管理页签的端到端行为：四张分区卡、四状态、开关与保存、弱密码检测、密钥弹窗。
 * 数据走默认 mock 数据集（种子端口 73、密码登录关闭、密钥登录开启），不另造假数据。
 * 密钥表的用例在 SshKeyCard.test.tsx 一处覆盖，不在这里重复。
 */

beforeEach(() => {
  resetSshPanel()
  // 改端口会联动写防火墙规则：演示数据集是模块级内存状态，这里一并推回种子。
  resetFirewallData()
})

/** 在 SSH 替身网关上再叠防火墙覆盖项：委托清单与防火墙面板测试同款穷举，方法在原型上不能展开。 */
function withFirewallOverrides(
  gateway: ElysianGateway,
  overrides: Partial<ElysianGateway['firewall']>,
): ElysianGateway {
  const firewall = gateway.firewall
  return {
    ...gateway,
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
      setScanConfig: (config) => firewall.setScanConfig(config),
      unblockIp: (ip) => firewall.unblockIp(ip),
      syncFromSystem: () => firewall.syncFromSystem(),
      ...overrides,
    },
  }
}

describe('SSH 管理页签', () => {
  it('切到页签后渲染四张分区卡：两列瀑布，卡片随内容取高度', async () => {
    await openSshTab()

    // 测试跑在宿主机演示态（非 Docker）：工具栏明示「演示数据」，与防火墙面板同一标识。
    const demoBadge = screen.getByText('演示数据')
    expect(demoBadge.closest('[role="status"]')).not.toBeNull()

    const service = screen.getByRole('region', { name: 'SSH 服务' })
    const root = screen.getByRole('region', { name: 'Root 设置' })
    const keys = screen.getByRole('region', { name: 'SSH 密钥' })
    const records = screen.getByRole('region', { name: 'SSH 登录记录' })
    for (const card of [service, root, keys, records]) {
      expect(card).toBeInTheDocument()
    }

    // 两列瀑布：左列设置（服务→Root）、右列数据（密钥→登录记录）；列独立堆叠，矮卡不被邻列拉高。
    // 窄屏单列时 DOM 顺序即视觉顺序：服务 → Root → 密钥 → 记录。
    const masonry = service.parentElement?.parentElement
    expect(masonry).toHaveClass('md:grid-cols-2', 'items-start')
    expect(service.parentElement).toContainElement(root)
    expect(keys.parentElement).toContainElement(records)
    expect(service.parentElement).not.toBe(keys.parentElement)

    // 卡内按区域划分：服务启停与登录方式合在「服务状态」，不再单开登录方式区。
    for (const name of ['服务状态', '登录统计', '监听端口']) {
      expect(within(service).getByText(name), name).toBeInTheDocument()
    }
    expect(within(service).queryByText('登录方式')).not.toBeInTheDocument()
    expect(within(service).queryByText(/动作在容器内真实执行/)).not.toBeInTheDocument()
    expect(within(service).queryByText(/动作只改演示内存/)).not.toBeInTheDocument()
    expect(within(service).queryByText(/停用后本机不再接受 SSH 连接/)).not.toBeInTheDocument()

    // 三个开关同一行、竖线分隔，避免纵向占位把区域撑高。
    const passwordAuth = within(service).getByRole('switch', { name: '密码登录' })
    const keyAuth = within(service).getByRole('switch', { name: '密钥登录' })
    const serviceSwitch = within(service).getByRole('switch', { name: 'SSH 服务' })
    const switchGroup = within(service).getByRole('group', { name: '服务开关' })
    expect(switchGroup).toContainElement(passwordAuth)
    expect(switchGroup).toContainElement(keyAuth)
    expect(switchGroup).toContainElement(serviceSwitch)
    expect(switchGroup).toHaveClass('flex')
    expect(switchGroup.querySelectorAll('[data-separator="switch"]').length).toBe(2)
    expect(passwordAuth.closest('label')).not.toHaveClass('justify-between')
    // 窄容器上文字下开关，宽容器（@md）左文右开关。
    expect(passwordAuth.closest('label')).toHaveClass('inline-flex', 'flex-col', '@md:flex-row')
    expect(switchGroup).toHaveClass('@container')
    // 均分单元格不得 min-w-0：否则窄卡下 justify-center 会从两侧裁掉「密码」「密钥」。
    expect(passwordAuth.closest('label')?.parentElement).not.toHaveClass('min-w-0')
    expect(keyAuth.closest('label')?.parentElement).not.toHaveClass('min-w-0')
    expect(serviceSwitch.closest('label')?.parentElement).not.toHaveClass('min-w-0')
    // 「上次变更」与「服务状态」同一行右对齐，不占开关下方的额外高度。
    const serviceTitle = within(service).getByText('服务状态')
    const lastChanged = within(service).getByText(/^上次变更：/)
    const titleRow = serviceTitle.parentElement
    expect(titleRow).toContainElement(lastChanged)
    expect(titleRow).toHaveClass('justify-between')
    expect(titleRow).not.toHaveClass('flex-col')
    expect(titleRow?.querySelector('[role="group"]')).toBeNull()
    expect(switchGroup.parentElement?.textContent).not.toMatch(/上次变更/)
    // Root 设置卡：登录策略收敛为一个开关，密码/密钥区按策略与全局登录方式联动。
    expect(within(root).getByText('Root 登录')).toBeInTheDocument()
    expect(within(root).getByText('Root 密钥')).toBeInTheDocument()
    expect(within(root).queryByText('Root 密码')).not.toBeInTheDocument()
  })

  it('登录记录卡按时间倒序列出来源、端口、结果与账号，每页 20 条', async () => {
    const user = await openSshTab()

    const records = screen.getByRole('region', { name: 'SSH 登录记录' })
    const table = within(records).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'IP 地址',
      '登录时间',
      '端口',
      '状态',
      '用户',
    ])

    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(SSH_PAGE_SIZE)
    // 最新一条在最前：时间精确到秒，来源地址、客户端端口与账号都在同一行
    expect(rows[0]?.textContent).toContain('1.204.32.143')
    expect(rows[0]?.textContent).toContain('2026-09-07 14:10:53')
    expect(rows[0]?.textContent).toContain('16999')
    expect(rows[0]?.textContent).toContain('成功')
    expect(rows[0]?.textContent).toContain('root')
    // 失败记录用危险色调，状态不靠颜色单独表达
    const failed = rows.filter((row) => row.textContent?.includes('失败'))
    expect(failed.length).toBeGreaterThan(0)
    expect(within(failed[0] as HTMLElement).getByText('失败')).toHaveClass('text-danger')
    expect(
      within(records).getByText(
        `共 ${SEED_LOGIN_RECORDS.length} 条登录记录 · 每页 ${SSH_PAGE_SIZE} 条`,
      ),
    ).toBeInTheDocument()

    // 首列钉住、其余列横向滚动：窄屏下靠它把来源地址留在视线里
    expect(rows[0]?.children[0]).toHaveClass('sticky', 'left-0')
    expect(rows[0]).toHaveClass('group')
    expect(within(records).getByRole('region', { name: 'SSH 登录记录表' })).toHaveAttribute(
      'tabindex',
      '0',
    )

    // 翻页：第二页是剩下的记录
    await user.click(within(records).getByRole('button', { name: '下一页' }))
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(
      SEED_LOGIN_RECORDS.length - SSH_PAGE_SIZE,
    )
    expect(within(records).getByRole('button', { name: '2' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('回环来源显示为本机，悬停提示保留原始地址', async () => {
    const { gateway } = sshSessions({
      listLoginRecords: async () => [
        { id: 'login-loop', ip: '::1', port: 40001, at: '2026-09-21T04:00:00.000Z', user: 'root', result: 'succeeded' },
        { id: 'login-v4loop', ip: '127.0.0.1', port: 40002, at: '2026-09-21T03:00:00.000Z', user: 'elysian', result: 'failed' },
        { id: 'login-remote', ip: '203.0.113.9', port: 40003, at: '2026-09-21T02:00:00.000Z', user: 'root', result: 'succeeded' },
      ],
    })
    await openSshTab(gateway)

    const table = within(screen.getByRole('region', { name: 'SSH 登录记录' })).getByRole('table')
    const loopCells = within(table).getAllByText('本机')
    expect(loopCells).toHaveLength(2)
    expect(loopCells[0]).toHaveAttribute('title', '::1')
    expect(loopCells[1]).toHaveAttribute('title', '127.0.0.1')
    // 非回环地址原样呈现，不被归一改写。
    expect(within(table).getByText('203.0.113.9')).not.toHaveAttribute('title')
  })

  it('没有登录记录时给空态，而不是一张空表', async () => {
    const { gateway } = sshSessions({ listLoginRecords: async () => [] })
    await openSshTab(gateway)

    const records = screen.getByRole('region', { name: 'SSH 登录记录' })
    expect(within(records).getByText('还没有登录记录')).toBeInTheDocument()
    expect(
      within(records).getByText(`共 0 条登录记录 · 每页 ${SSH_PAGE_SIZE} 条`),
    ).toBeInTheDocument()
    // 只剩表头与承载空态的那一行，没有数据行；翻页按钮也都不可用
    const table = within(records).getByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.textContent).toContain('还没有登录记录')
    expect(within(records).getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(within(records).getByRole('button', { name: '下一页' })).toBeDisabled()
  })

  it('登录统计：三个窗口的成功与失败计数上屏，数据与 overview.stats 一致', async () => {
    await openSshTab()

    const service = screen.getByRole('region', { name: 'SSH 服务' })
    const stats = within(service).getByText('登录统计').parentElement
    expect(stats).toBeInTheDocument()

    const table = within(stats as HTMLElement).getByRole('table')
    // 表头三列：窗口、成功、失败（列名取契约标签表）
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '时间窗口',
      '成功',
      '失败',
    ])
    // 三行窗口按契约 SSH_LOGIN_WINDOWS 的顺序渲染，计数用等宽数字
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('今日')
    expect(rows[0]).toHaveTextContent(`${SEED_SSH_STATS.today.succeeded}`)
    expect(rows[0]).toHaveTextContent(`${SEED_SSH_STATS.today.failed}`)
    expect(rows[1]).toHaveTextContent('昨日')
    expect(rows[1]).toHaveTextContent(`${SEED_SSH_STATS.yesterday.succeeded}`)
    expect(rows[1]).toHaveTextContent(`${SEED_SSH_STATS.yesterday.failed}`)
    expect(rows[2]).toHaveTextContent('近 7 天')
    expect(rows[2]).toHaveTextContent(`${SEED_SSH_STATS.last7Days.succeeded}`)
    expect(rows[2]).toHaveTextContent(`${SEED_SSH_STATS.last7Days.failed}`)
    // 表头与单元格全部居中：时间窗口、成功、失败三列扫视对齐，不偏左。
    expect(table).toHaveClass('text-center')
    for (const header of within(table).getAllByRole('columnheader')) {
      expect(header).toHaveClass('text-center')
    }
    const today = rows[0] as HTMLElement
    expect(within(today).getByRole('rowheader')).toHaveClass('text-center')
    const todayCells = within(today).getAllByRole('cell')
    expect(todayCells).toHaveLength(2)
    for (const cell of todayCells) {
      expect(cell).toHaveClass('text-center')
    }
    // 失败计数带危险色，成功计数不带：文字与颜色一起区分两种结果
    expect(todayCells[1]).toHaveClass('text-danger')
    expect(todayCells[0]).not.toHaveClass('text-danger')
  })

  it('服务未启用时登录统计给空态说明，不渲染零值统计', async () => {
    const { gateway } = sshSessions({
      overview: async () => ({ enabled: false, status: 'stopped', changedAt: null, stats: SEED_SSH_STATS }),
    })
    await openSshTab(gateway)

    const service = screen.getByRole('region', { name: 'SSH 服务' })
    expect(within(service).getByText('SSH 服务未启用，没有登录记录可统计。')).toBeInTheDocument()
    // 契约约定：没有服务就没有登录记录，界面不给零值统计
    expect(within(service).queryByText('今日')).not.toBeInTheDocument()
    expect(within(service).queryByText('近 7 天')).not.toBeInTheDocument()
  })

  it('种子数据上屏：服务运行中、端口 73、密码登录关闭、密钥登录开启', async () => {
    await openSshTab()

    const service = screen.getByRole('region', { name: 'SSH 服务' })
    // 状态徽标已随开关去重：开关位置即状态，不再并排文字徽标复述。
    expect(within(service).queryByText('运行中')).not.toBeInTheDocument()
    expect(within(service).getByRole('switch', { name: 'SSH 服务' })).toBeChecked()
    expect(within(service).getByLabelText('监听端口')).toHaveValue(`${SEED_SSH_PORT}`)
    const seedChanged = within(service).getByText('上次变更：—')
    const seedTitleRow = within(service).getByText('服务状态').parentElement
    expect(seedTitleRow).toContainElement(seedChanged)
    expect(seedTitleRow).toHaveClass('justify-between')
    expect(seedTitleRow).not.toHaveClass('flex-col')
    expect(within(service).getByRole('switch', { name: '密码登录' })).not.toBeChecked()
    expect(within(service).getByRole('switch', { name: '密钥登录' })).toBeChecked()
  })

  it('启停写入上次变更：mock 写路径保留，重新加载仍在标题行右侧', async () => {
    const { gateway } = sshSessions()
    const user = await openSshTab(gateway)
    const service = () => screen.getByRole('region', { name: 'SSH 服务' })

    await user.click(within(service()).getByRole('switch', { name: 'SSH 服务' }))

    const changed = await within(service()).findByText(/^上次变更：/)
    expect(changed).not.toHaveTextContent('上次变更：—')
    const titleRow = within(service()).getByText('服务状态').parentElement
    expect(titleRow).toContainElement(changed)
    expect(titleRow).toHaveClass('justify-between')
    const stamped = changed.textContent

    // 模拟刷新：丢掉界面 store，不推回 mock 种子——adapter 写路径上的运维事实应仍在。
    useSshStore.setState(INITIAL_SSH_STATE)
    await useSshStore.getState().load(gateway)

    const reloaded = await within(service()).findByText(/^上次变更：/)
    expect(reloaded).toHaveTextContent(stamped ?? '')
    const reloadedRow = within(service()).getByText('服务状态').parentElement
    expect(reloadedRow).toContainElement(reloaded)
    expect(reloadedRow).toHaveClass('justify-between')
  })

  it('停用服务：状态转已停止并留下 mock 通知，重新启用后恢复', async () => {
    const user = await openSshTab()
    const service = screen.getByRole('region', { name: 'SSH 服务' })

    await user.click(within(service).getByRole('switch', { name: 'SSH 服务' }))

    expect(within(service).queryByText('已停止')).not.toBeInTheDocument()
    expect(within(service).getByRole('switch', { name: 'SSH 服务' })).not.toBeChecked()

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      'SSH 服务已停用（mock，待接入真实执行）',
    )

    await user.click(within(service).getByRole('switch', { name: 'SSH 服务' }))
    expect(within(service).getByRole('switch', { name: 'SSH 服务' })).toBeChecked()
  })

  it('登录方式开关即改状态并发 mock 通知', async () => {
    const user = await openSshTab()
    const service = screen.getByRole('region', { name: 'SSH 服务' })

    await user.click(within(service).getByRole('switch', { name: '密码登录' }))

    expect(within(service).getByRole('switch', { name: '密码登录' })).toBeChecked()
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      'SSH 密码登录已开启（mock，待接入真实执行）',
    )
  })

  it('端口非法就在界面层挡下不发请求；合法端口先经确认对话，确认后保存并通知', async () => {
    const savedPorts: number[] = []
    const { gateway } = sshSessions({
      setPort: async (port) => {
        savedPorts.push(port)
        return { passwordAuthEnabled: false, keyAuthEnabled: true, port }
      },
    })
    const user = await openSshTab(gateway)
    const service = screen.getByRole('region', { name: 'SSH 服务' })
    const input = within(service).getByLabelText('监听端口')

    await user.clear(input)
    await user.type(input, '70000')
    await user.click(within(service).getByRole('button', { name: '保存端口' }))
    expect(within(service).getByText('端口需为 1-65535 的整数')).toBeInTheDocument()
    expect(savedPorts).toEqual([])
    expect(screen.queryByRole('dialog', { name: '确认修改 SSH 监听端口' })).not.toBeInTheDocument()

    await user.clear(input)
    await user.type(input, '2222')
    await user.click(within(service).getByRole('button', { name: '保存端口' }))

    // 确认对话先出现，讲清后果；没确认前不发请求。
    const confirm = screen.getByRole('dialog', { name: '确认修改 SSH 监听端口' })
    expect(confirm.textContent).toContain('从 73 改为 2222')
    expect(confirm.textContent).toContain('tcp 放行规则')
    // 测试跑在宿主机演示态（非 Docker）：不出现宿主 2222 映射的警示。
    expect(confirm.textContent).not.toContain('宿主机 2222')
    expect(savedPorts).toEqual([])

    await user.click(within(confirm).getByRole('button', { name: '确认保存' }))

    await waitFor(() => expect(savedPorts).toEqual([2222]))
    const notifications = await screen.findByLabelText('通知')
    // 端口变更与防火墙联动各留一条通知（种子 2222 已有限连规则），这里认端口变更那条。
    expect(
      within(notifications).getByText('SSH 端口已改为 2222（mock，待接入真实执行）'),
    ).toBeInTheDocument()
    expect(input).toHaveValue('2222')
  })

  it('确认对话里取消保存：不发请求，端口保持原值', async () => {
    const savedPorts: number[] = []
    const { gateway } = sshSessions({
      setPort: async (port) => {
        savedPorts.push(port)
        return { passwordAuthEnabled: false, keyAuthEnabled: true, port }
      },
    })
    const user = await openSshTab(gateway)
    const service = screen.getByRole('region', { name: 'SSH 服务' })
    const input = within(service).getByLabelText('监听端口')

    await user.clear(input)
    await user.type(input, '2260')
    await user.click(within(service).getByRole('button', { name: '保存端口' }))
    await user.click(within(screen.getByRole('dialog', { name: '确认修改 SSH 监听端口' })).getByRole('button', { name: '取消' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '确认修改 SSH 监听端口' })).not.toBeInTheDocument(),
    )
    expect(savedPorts).toEqual([])
    expect(input).toHaveValue('2260')
  })

  it('随机端口填进输入框后同样要经确认对话，不会绕过拦截直接保存', async () => {
    const savedPorts: number[] = []
    const { gateway } = sshSessions({
      setPort: async (port) => {
        savedPorts.push(port)
        return { passwordAuthEnabled: false, keyAuthEnabled: true, port }
      },
    })
    const user = await openSshTab(gateway)
    const service = screen.getByRole('region', { name: 'SSH 服务' })
    const input = within(service).getByLabelText('监听端口')

    await user.click(within(service).getByRole('button', { name: '随机端口' }))
    const randomPort = (input as HTMLInputElement).value
    await user.click(within(service).getByRole('button', { name: '保存端口' }))

    const confirm = screen.getByRole('dialog', { name: '确认修改 SSH 监听端口' })
    expect(confirm.textContent).toContain(`从 73 改为 ${randomPort}`)
    expect(savedPorts).toEqual([])
    await user.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(savedPorts).toEqual([])
  })

  it('确认保存后防火墙已启用则联动放行新端口；同端口已有规则则不重复添加', async () => {
    const createdRules: FirewallRuleInput[] = []
    const session = sshSessions({
      setPort: async (port) => ({ passwordAuthEnabled: false, keyAuthEnabled: true, port }),
    })
    const gateway = withFirewallOverrides(session.gateway, {
      create: async (input) => {
        createdRules.push(input)
        return {
          id: `fw-${input.protocol}-${input.port}-${input.family}`,
          protocol: input.protocol,
          port: input.port,
          portTo: null,
          family: input.family,
          status: 'unused',
          policy: input.policy,
          direction: 'inbound',
          source: input.source,
          note: input.note,
          updatedAt: null,
        } satisfies FirewallRule
      },
    })
    const user = await openSshTab(gateway)
    const service = screen.getByRole('region', { name: 'SSH 服务' })
    const input = within(service).getByLabelText('监听端口')

    // 新端口没有覆盖它的规则：自动补一条 tcp 放行，来源所有 IP、带联动备注。
    await user.clear(input)
    await user.type(input, '2260')
    await user.click(within(service).getByRole('button', { name: '保存端口' }))
    await user.click(within(screen.getByRole('dialog', { name: '确认修改 SSH 监听端口' })).getByRole('button', { name: '确认保存' }))

    await waitFor(() => expect(createdRules).toHaveLength(1))
    expect(createdRules[0]).toEqual({
      protocol: 'tcp',
      port: 2260,
      family: 'ipv4',
      policy: 'allow',
      direction: 'inbound',
      source: '所有IP',
      note: 'SSH 端口联动放行',
    } satisfies FirewallRuleInput)
    await waitFor(() =>
      expect(useNotificationStore.getState().notifications.map((item) => item.message)).toContain(
        '已为新端口 2260 添加防火墙 tcp 放行规则（mock，待接入真实执行）',
      ),
    )

    // 种子里 2222 已有限连规则（limit 即限速的放行）：不重复创建，如实提示。
    await user.clear(input)
    await user.type(input, '2222')
    await user.click(within(service).getByRole('button', { name: '保存端口' }))
    await user.click(within(screen.getByRole('dialog', { name: '确认修改 SSH 监听端口' })).getByRole('button', { name: '确认保存' }))

    await waitFor(() =>
      expect(useNotificationStore.getState().notifications.map((item) => item.message)).toContain(
        '防火墙已有 2222/tcp 的限连规则，无需重复添加',
      ),
    )
    expect(createdRules).toHaveLength(1)
  })

  it('防火墙未启用时只提示不联动，不发任何规则请求', async () => {
    const createdRules: FirewallRuleInput[] = []
    const session = sshSessions({
      setPort: async (port) => ({ passwordAuthEnabled: false, keyAuthEnabled: true, port }),
    })
    const gateway = withFirewallOverrides(session.gateway, {
      toggles: async () =>
        ({ firewallEnabled: false, pingBlocked: true, defaultIncoming: null, defaultOutgoing: null }) satisfies FirewallToggles,
      create: async (input) => {
        createdRules.push(input)
        throw new Error('不应该走到创建规则')
      },
    })
    const user = await openSshTab(gateway)
    const service = screen.getByRole('region', { name: 'SSH 服务' })
    const input = within(service).getByLabelText('监听端口')

    await user.clear(input)
    await user.type(input, '2260')
    await user.click(within(service).getByRole('button', { name: '保存端口' }))
    await user.click(within(screen.getByRole('dialog', { name: '确认修改 SSH 监听端口' })).getByRole('button', { name: '确认保存' }))

    await waitFor(() =>
      expect(useNotificationStore.getState().notifications.map((item) => item.message)).toContain(
        '防火墙当前未启用：新端口未联动放行，启用防火墙前请自行确认放行',
      ),
    )
    expect(createdRules).toEqual([])
  })

  it('端口已有拒绝规则时不覆盖创建，明确报出锁死风险', async () => {
    const denySession = sshSessions({
      setPort: async (port) => ({ passwordAuthEnabled: false, keyAuthEnabled: true, port }),
    })
    const denyGateway = withFirewallOverrides(denySession.gateway, {
      list: async () => [
        {
          id: 'fw-2260-ipv4',
          protocol: 'tcp',
          port: 2260,
          portTo: null,
          family: 'ipv4',
          status: 'unused',
          policy: 'deny',
          direction: 'inbound',
          source: '所有IP',
          note: null,
          updatedAt: null,
        } satisfies FirewallRule,
      ],
    })
    const user = await openSshTab(denyGateway)
    const service = screen.getByRole('region', { name: 'SSH 服务' })
    const input = within(service).getByLabelText('监听端口')

    await user.clear(input)
    await user.type(input, '2260')
    await user.click(within(service).getByRole('button', { name: '保存端口' }))
    await user.click(within(screen.getByRole('dialog', { name: '确认修改 SSH 监听端口' })).getByRole('button', { name: '确认保存' }))

    await waitFor(() =>
      expect(useNotificationStore.getState().notifications.map((item) => item.message)).toContain(
        '端口已改为 2260，但防火墙上该端口已有拒绝规则，未添加放行：请先到防火墙页处理，否则 SSH 无法连接',
      ),
    )
  })

  it('联动放行失败不回滚端口，给出手动放行指引', async () => {
    const failSession = sshSessions({
      setPort: async (port) => ({ passwordAuthEnabled: false, keyAuthEnabled: true, port }),
    })
    const failGateway = withFirewallOverrides(failSession.gateway, {
      create: async () => {
        throw new Error('演示用的放行失败')
      },
    })
    const user = await openSshTab(failGateway)
    const service = screen.getByRole('region', { name: 'SSH 服务' })
    const input = within(service).getByLabelText('监听端口')

    await user.clear(input)
    await user.type(input, '2261')
    await user.click(within(service).getByRole('button', { name: '保存端口' }))
    await user.click(within(screen.getByRole('dialog', { name: '确认修改 SSH 监听端口' })).getByRole('button', { name: '确认保存' }))

    await waitFor(() =>
      expect(useNotificationStore.getState().notifications.map((item) => item.message)).toContain(
        '端口已改为 2261，但防火墙放行失败：演示用的放行失败。请到防火墙页手动放行，否则 SSH 无法连接',
      ),
    )
    // 端口保存本身成功了：失败的是联动，不回滚端口。
    expect(input).toHaveValue('2261')
  })

  it('防火墙状态读不出来也只报联动失败：不把已经保存成功的端口报成「保存失败」', async () => {
    const failSession = sshSessions({
      setPort: async (port) => ({ passwordAuthEnabled: false, keyAuthEnabled: true, port }),
    })
    const failGateway = withFirewallOverrides(failSession.gateway, {
      toggles: async () => {
        throw new Error('防火墙读接口 503')
      },
    })
    const user = await openSshTab(failGateway)
    const service = screen.getByRole('region', { name: 'SSH 服务' })
    const input = within(service).getByLabelText('监听端口')

    await user.clear(input)
    await user.type(input, '2263')
    await user.click(within(service).getByRole('button', { name: '保存端口' }))
    await user.click(
      within(screen.getByRole('dialog', { name: '确认修改 SSH 监听端口' })).getByRole('button', {
        name: '确认保存',
      }),
    )

    // 联动读失败有自己的说法与指引；端口已改成功这一事实照旧报出。
    await waitFor(() =>
      expect(useNotificationStore.getState().notifications.map((item) => item.message)).toContain(
        '端口已改为 2263，但防火墙联动检查失败：防火墙读接口 503。请到防火墙页确认 2263/tcp 已放行，否则 SSH 无法连接',
      ),
    )
    const messages = useNotificationStore.getState().notifications.map((item) => item.message)
    expect(messages).toContain('SSH 端口已改为 2263（mock，待接入真实执行）')
    expect(messages.some((message) => message.startsWith('保存失败'))).toBe(false)
    // 端口确实保存成功：确认对话已关、输入框落在新端口上。
    expect(screen.queryByRole('dialog', { name: '确认修改 SSH 监听端口' })).not.toBeInTheDocument()
    expect(input).toHaveValue('2263')
  })

  it('Root 登录开关：关写 no 收起两区，开写 yes 按全局登录方式呈现，各留通知', async () => {
    const user = await openSshTab()
    const root = () => screen.getByRole('region', { name: 'Root 设置' })
    const rootSwitch = () => within(root()).getByRole('switch', { name: '允许 Root 登录' })

    // 种子策略 prohibit-password 对用户而言就是「允许 Root 登录」：开关开。
    expect(rootSwitch()).toBeChecked()

    await user.click(rootSwitch())
    expect(rootSwitch()).not.toBeChecked()
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      'Root 登录已禁止（mock，待接入真实执行）',
    )

    await waitFor(() => expect(within(notifications).getAllByRole('status').length).toBeGreaterThanOrEqual(1))
    await user.click(rootSwitch())
    expect(useNotificationStore.getState().notifications.map((item) => item.message)).toContain(
      'Root 登录已允许（mock，待接入真实执行）',
    )
  })

  it('Root 密码与密钥区随 Root 开关与全局登录方式联动，收起时给一句话说明', async () => {
    const user = await openSshTab()
    const root = () => screen.getByRole('region', { name: 'Root 设置' })
    const service = () => screen.getByRole('region', { name: 'SSH 服务' })
    const rootSwitch = () => within(root()).getByRole('switch', { name: '允许 Root 登录' })

    // 种子：策略 prohibit-password、全局密码关、密钥开——开关开；密码区隐藏，密钥区在。
    expect(rootSwitch()).toBeChecked()
    expect(within(root()).queryByLabelText('Root 密码')).not.toBeInTheDocument()
    expect(within(root()).getByRole('button', { name: '重新生成' })).toBeInTheDocument()
    expect(within(root()).getByText(/仅允许 Root 以密钥登录/)).toBeInTheDocument()

    // 关：两区全收。
    await user.click(rootSwitch())
    await waitFor(() =>
      expect(within(root()).queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument(),
    )
    expect(within(root()).getByText(/Root 登录已禁止/)).toBeInTheDocument()

    // 开（面板写 yes）：全局密码仍关——密码区隐藏并说明原因，密钥区在。
    await user.click(rootSwitch())
    await waitFor(() => expect(within(root()).getByText(/全局密码登录已关闭/)).toBeInTheDocument())
    expect(within(root()).queryByLabelText('Root 密码')).not.toBeInTheDocument()
    expect(within(root()).getByRole('button', { name: '重新生成' })).toBeInTheDocument()

    // 打开全局密码登录：密码区随之出现——登录方式唯一由全局开关决定。
    await user.click(within(service()).getByRole('switch', { name: '密码登录' }))
    expect(await within(root()).findByLabelText('Root 密码')).toBeInTheDocument()

    // 关掉全局密钥登录：密钥区随之收起并说明。
    await user.click(within(service()).getByRole('switch', { name: '密钥登录' }))
    await waitFor(() =>
      expect(within(root()).queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument(),
    )
    expect(within(root()).getByText(/全局密钥登录已关闭/)).toBeInTheDocument()

    // 策略选项按钮不复存在：策略只由这一个开关表达。
    expect(within(root()).queryByRole('group', { name: 'Root 登录策略' })).not.toBeInTheDocument()
    for (const name of ['禁止 Root 登录', '只能密钥登录', '允许密码登录']) {
      expect(within(root()).queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  it('外部档 prohibit-password 下打开全局密码登录：密码区收起但给一键重设，不需要开关两次', async () => {
    const user = await openSshTab()
    const root = () => screen.getByRole('region', { name: 'Root 设置' })
    const service = () => screen.getByRole('region', { name: 'SSH 服务' })

    // 种子策略是外部档 prohibit-password（开关显示为开）。用户只打开全局密码登录：
    // sshd 层面 root 密码登录仍被该策略挡着，密码区如实收起，但出现一步到位的重设入口。
    await user.click(within(service()).getByRole('switch', { name: '密码登录' }))
    await waitFor(() => expect(within(root()).queryByLabelText('Root 密码')).not.toBeInTheDocument())
    expect(within(root()).getByText(/仅允许 Root 以密钥登录/)).toBeInTheDocument()
    const reset = await within(root()).findByRole('button', { name: '按全局登录方式重设' })

    // 一键重设写 PermitRootLogin yes：密码区随之出现，不再要求「先关再开」的开关仪式。
    await user.click(reset)
    expect(await within(root()).findByLabelText('Root 密码')).toBeInTheDocument()
    expect(useSshStore.getState().rootAuth?.policy).toBe('yes')
  })

  it('外部配置的 forced-commands-only 仍如实呈现：开关开、无密码密钥区并给该配置说明', async () => {
    const { gateway } = sshSessions({
      rootAuth: async () => ({ policy: 'forced-commands-only', key: null, passwordResetAt: null }),
    })
    await openSshTab(gateway)
    const root = screen.getByRole('region', { name: 'Root 设置' })

    expect(within(root).getByRole('switch', { name: '允许 Root 登录' })).toBeChecked()
    expect(within(root).getByText(/command=/)).toBeInTheDocument()
    expect(within(root).queryByText('Root 密码')).not.toBeInTheDocument()
    expect(within(root).queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument()
  })

  it('Root 密码：明暗可切换，强度走三级彩条并联动输入框描边，弱密码被拒、达标后弹窗提醒新密码', async () => {
    const user = await openSshTab()
    const root = screen.getByRole('region', { name: 'Root 设置' })

    // 密码区需要「允许 Root 登录」开（面板写 yes）且全局密码登录开：种子两处都不满足，先真实切换。
    await user.click(
      within(screen.getByRole('region', { name: 'SSH 服务' })).getByRole('switch', { name: '密码登录' }),
    )
    await user.click(within(root).getByRole('switch', { name: '允许 Root 登录' }))
    await waitFor(() =>
      expect(within(root).getByRole('switch', { name: '允许 Root 登录' })).not.toBeChecked(),
    )
    await user.click(within(root).getByRole('switch', { name: '允许 Root 登录' }))
    const input = await within(root).findByLabelText('Root 密码')

    // 明暗切换：默认掩码，点眼睛变明文，再点回去。图标表达当前状态：掩码闭眼、明文睁眼。
    expect(input).toHaveAttribute('type', 'password')
    const eyeButton = within(root).getByRole('button', { name: '显示密码' })
    expect(eyeButton.querySelector('.lucide-eye-off')).not.toBeNull()
    await user.click(eyeButton)
    expect(input).toHaveAttribute('type', 'text')
    const hideButton = within(root).getByRole('button', { name: '隐藏密码' })
    expect(hideButton.querySelector('.lucide-eye')).not.toBeNull()
    await user.click(hideButton)
    expect(input).toHaveAttribute('type', 'password')

    expect(within(root).getByText('上次重置：—')).toBeInTheDocument()

    await user.type(input, 'abcdefgh')    // 强度不再单独一行文字：三段彩条 + 条旁等级字，输入框描边同色联动。
    // 聚焦态也由强度色接管（描边+同色光环），空输入仍走浏览器默认聚焦效果。
    expect(within(root).getByRole('meter', { name: '密码强度：弱' })).toHaveAttribute('aria-valuenow', '1')
    expect(within(root).getByText('弱')).toBeInTheDocument()
    expect(input.className).toContain('border-danger')
    expect(input.className).toContain('focus:border-danger')
    expect(input.className).toContain('focus:ring-danger')
    expect(within(root).queryByText('强度：弱')).not.toBeInTheDocument()

    await user.click(within(root).getByRole('button', { name: '重置密码' }))
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('alert')).toHaveTextContent('重置失败：密码强度不足')
    expect(within(root).getByText('上次重置：—')).toBeInTheDocument()
    expect(input).toHaveValue('abcdefgh')

    await user.clear(input)
    await user.type(input, 'Elysian2026')
    expect(within(root).getByRole('meter', { name: '密码强度：中' })).toHaveAttribute('aria-valuenow', '2')
    expect(input.className).toContain('border-warning')
    expect(input.className).toContain('focus:ring-warning')

    await user.clear(input)
    await user.type(input, 'Elysian#2026Root')
    expect(within(root).getByRole('meter', { name: '密码强度：强' })).toHaveAttribute('aria-valuenow', '3')
    expect(input.className).toContain('border-success')
    await user.click(within(root).getByRole('button', { name: '重置密码' }))

    await waitFor(() => expect(input).toHaveValue(''))
    expect(within(root).queryByText('上次重置：—')).not.toBeInTheDocument()

    // 重置成功改为弹窗提醒：下一次 SSH 登录用新密码；知道了关闭。
    const notice = await screen.findByRole('dialog', { name: 'Root 密码已重置' })
    expect(notice.textContent).toContain('下一次 SSH 登录需要使用新密码')
    await user.click(within(notice).getByRole('button', { name: '知道了' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Root 密码已重置' })).not.toBeInTheDocument(),
    )
  })

  it('上次重置在 Root 密码标题行右侧，与服务状态的上次变更同一形态', async () => {
    const { gateway } = sshSessions({
      settings: async () => ({ port: 22, passwordAuthEnabled: true, keyAuthEnabled: true }),
      rootAuth: async () => ({
        policy: 'yes',
        key: null,
        passwordResetAt: '2026-09-21T04:00:00.000Z',
      }),
    })
    await openSshTab(gateway)
    const root = screen.getByRole('region', { name: 'Root 设置' })

    // 与「服务状态」的上次变更同款：Region 标题行右侧 aside，不占密码表单下方的行。
    const lastReset = within(root).getByText(/^上次重置：/)
    expect(lastReset).toHaveTextContent('上次重置：09/21 12:00')
    const titleRow = within(root).getByText('Root 密码').parentElement
    expect(titleRow).toContainElement(lastReset)
  })

  it('查看 Root 密钥：弹窗给出指纹、算法与公钥全文，不出现私钥，关闭后回到卡片', async () => {
    const user = await openSshTab()
    const root = screen.getByRole('region', { name: 'Root 设置' })

    await user.click(within(root).getByRole('button', { name: '查看密钥' }))

    const dialog = await screen.findByRole('dialog', { name: '查看 Root 密钥' })
    expect(dialog.textContent).toContain('演示密钥 · 不对应任何真实主机')
    expect(dialog.textContent).toContain('ssh-ed25519 256')
    expect(dialog.textContent).toContain('SHA256:')
    expect(dialog.textContent).toContain('公钥内容')
    expect(within(dialog).getByRole('button', { name: '公钥' })).toBeInTheDocument()
    // 私钥不在查看弹窗里：既没有它的正文，也没有下载它的入口。
    expect(within(dialog).queryByText(/BEGIN OPENSSH PRIVATE KEY/)).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '下载私钥' })).not.toBeInTheDocument()
    expect(dialog.textContent).toContain('私钥只在创建/生成的那一次展示过')

    await user.click(within(dialog).getByRole('button', { name: '关闭弹窗' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '查看 Root 密钥' })).not.toBeInTheDocument(),
    )
  })

  it('重新生成 Root 密钥：私钥只在一次性弹窗里出现，关闭后无法再取', async () => {
    const user = await openSshTab()
    const root = screen.getByRole('region', { name: 'Root 设置' })
    const fingerprintBefore = useSshStore.getState().rootAuth?.key?.fingerprint

    // 种子里 Root 密钥已存在：按钮文案是「重新生成」。
    await user.click(within(root).getByRole('button', { name: '重新生成' }))

    const dialog = await screen.findByRole('dialog', { name: 'Root 密钥已生成' })
    expect(within(dialog).getByText('私钥仅此次可见')).toBeInTheDocument()
    expect(within(dialog).getByText(/BEGIN OPENSSH PRIVATE KEY/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '下载私钥' })).toBeInTheDocument()
    // 下载文件名以归属账号开头；它随 chmod 补救命令一并显示（root-ssh-key-<日期>.pem，可直接复制执行）。
    expect(within(dialog).getByText(/chmod 600 root-ssh-key-\d{8}\.pem/)).toBeInTheDocument()

    // 卡片上的指纹已换成新材料；入档的 rootAuth 不带私钥。
    await waitFor(() =>
      expect(useSshStore.getState().rootAuth?.key?.fingerprint).not.toBe(fingerprintBefore),
    )
    expect(useSshStore.getState().rootAuth?.key?.privateKey).toBeUndefined()

    // 关闭即清空：一次性私钥从内存状态里消失。
    await user.click(within(dialog).getByRole('button', { name: '关闭弹窗' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Root 密钥已生成' })).not.toBeInTheDocument(),
    )
    expect(useSshStore.getState().revealKey).toBeUndefined()

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      'Root 密钥已重新生成（mock，待接入真实执行）',
    )
  })

  it('一次性私钥弹窗点外部不关闭：误触不会把仅此一次的私钥丢掉', async () => {
    const user = await openSshTab()
    const root = screen.getByRole('region', { name: 'Root 设置' })

    await user.click(within(root).getByRole('button', { name: '重新生成' }))
    const dialog = await screen.findByRole('dialog', { name: 'Root 密钥已生成' })
    expect(within(dialog).getByText(/BEGIN OPENSSH PRIVATE KEY/)).toBeInTheDocument()
    // 下载文件权限开放的坑直接给补救命令：不带 chmod 提示时用户会被 ssh 客户端静默回退到密码登录。
    expect(within(dialog).getByText(/chmod 600 root-ssh-key-/)).toBeInTheDocument()

    // 遮罩与内容之外的一次误触（点在 body 上）不该关掉它，私钥仍在弹窗里。
    // Radix 的「点外部」判定在 pointerdown 之后等一次 click 才落定，所以按真实误触的顺序两步都走：
    // 没有守卫时第二步就会关掉弹窗，仅此一次的私钥随之清空。
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    expect(screen.getByRole('dialog', { name: 'Root 密钥已生成' })).toBeInTheDocument()
    expect(within(dialog).getByText(/BEGIN OPENSSH PRIVATE KEY/)).toBeInTheDocument()
    expect(useSshStore.getState().revealKey).toBeDefined()

    // 显式关闭仍然可用：守卫只拦误触，不拦主动动作。
    await user.click(within(dialog).getByRole('button', { name: '关闭弹窗' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Root 密钥已生成' })).not.toBeInTheDocument(),
    )
    expect(useSshStore.getState().revealKey).toBeUndefined()
  })

  it('Root 密钥未生成时给空态说明与「生成密钥」入口，不编造材料', async () => {
    const { gateway } = sshSessions({
      rootAuth: async () => ({ policy: 'prohibit-password', key: null, passwordResetAt: null }),
    })
    const user = await openSshTab(gateway)
    const root = screen.getByRole('region', { name: 'Root 设置' })

    expect(within(root).getByText('尚未生成：root 账号的授权文件里还没有任何公钥。')).toBeInTheDocument()
    expect(within(root).queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument()

    await user.click(within(root).getByRole('button', { name: '生成密钥' }))
    const dialog = await screen.findByRole('dialog', { name: 'Root 密钥已生成' })
    expect(within(dialog).getByText(/BEGIN OPENSSH PRIVATE KEY/)).toBeInTheDocument()
    // 通知断言读 store（与 Root 密码用例同款）：渲染提交的时序不影响判定。
    await waitFor(() =>
      expect(useNotificationStore.getState().notifications.map((item) => item.message)).toContain(
        'Root 密钥已生成（mock，待接入真实执行）',
      ),
    )
  })

  it('读取未回来时给加载态，不是空白', async () => {
    const user = userEvent.setup()
    const { gateway } = sshSessions({ overview: () => new Promise(() => {}) })
    renderApp('/security', { gateway })

    await user.click(securityTab('SSH 管理'))
    expect(await screen.findByText('正在加载 SSH 配置…')).toBeInTheDocument()
  })

  it('读取失败给错误态与重试，重试成功后内容出现', async () => {
    const user = userEvent.setup()
    let calls = 0
    const { gateway, ssh } = sshSessions({
      overview: async () => {
        calls += 1
        if (calls === 1) throw new Error('演示用的读取失败')
        return ssh.overview()
      },
    })
    renderApp('/security', { gateway })
    await user.click(securityTab('SSH 管理'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('SSH 数据加载失败')
    expect(alert).toHaveTextContent('演示用的读取失败')

    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('region', { name: 'SSH 服务' })).toBeInTheDocument()
  })
})

describe('改端口确认对话的后果文案', () => {
  it('任何运行时都讲清端口切换与防火墙联动两条后果', () => {
    for (const docker of [false, true]) {
      const consequences = sshPortConfirmConsequences(2222, docker)
      const text = consequences.map((item) => item.text).join('\n')
      expect(text).toContain('只在改后的端口接受连接')
      expect(text).toContain('tcp 放行规则')
      expect(text).toContain('旧端口的规则保留不动')
    }
  })

  it('Docker 运行时目标端口非 22 追加宿主机 2222 映射失效的警示', () => {
    const consequences = sshPortConfirmConsequences(2222, true)
    const warning = consequences.find((item) => item.tone === 'warning')
    expect(warning?.text).toContain('宿主机 2222')
    expect(warning?.text).toContain('将失效')
    expect(warning?.text).toContain('联调需保持 22')
  })

  it('Docker 运行时保持 22 不触发映射警示；宿主机演示态任何端口都不触发', () => {
    expect(sshPortConfirmConsequences(22, true).some((item) => item.text.includes('宿主机 2222'))).toBe(false)
    expect(sshPortConfirmConsequences(2222, false).some((item) => item.text.includes('宿主机 2222'))).toBe(false)
    expect(sshPortConfirmConsequences(2222, false)).toHaveLength(2)
  })
})
