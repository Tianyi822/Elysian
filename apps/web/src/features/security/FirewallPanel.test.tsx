import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { SEED_FORWARDS, SEED_IP_RULES, SEED_RULES } from '../../adapters/mock/firewallData'
import { useFirewallStore, FIREWALL_PAGE_SIZE } from '../../stores/firewallStore'
import { renderApp } from '../../test/renderApp'

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

/** 等规则表就绪（加载态消失、出现分页条）。 */
async function openFirewallPage(gateway: ElysianGateway = sessionGateway()) {
  renderApp('/security', { gateway })
  await screen.findByRole('region', { name: '端口规则表' })
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

describe('防火墙面板', () => {
  it('种子规则跨两页：首页 20 行，下一页看剩余，共 N 条随搜索变化', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    expect(screen.getByText(new RegExp(`共 ${SEED_RULE_COUNT} 条`))).toBeInTheDocument()
    const table = screen.getByRole('region', { name: '端口规则表' })
    expect(within(table).getAllByRole('row')).toHaveLength(FIREWALL_PAGE_SIZE + 1) // 表头 + 20 行
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '下一页' }))
    // 表头 + 剩余行数
    expect(within(table).getAllByRole('row')).toHaveLength(SEED_RULE_COUNT - FIREWALL_PAGE_SIZE + 1)
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled()
    // 页码与当前位置：第二页标记 aria-current。
    expect(screen.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page')
  })

  it('搜索按端口与备注过滤，无结果给空行提示', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    await user.type(screen.getByLabelText('搜索端口、来源或备注'), '2234')
    expect(screen.getByText(/共 2 条/)).toBeInTheDocument()
    const table = screen.getByRole('region', { name: '端口规则表' })
    expect(within(table).getAllByRole('row')).toHaveLength(3) // 表头 + v4/v6 两行

    await user.clear(screen.getByLabelText('搜索端口、来源或备注'))
    await user.type(screen.getByLabelText('搜索端口、来源或备注'), '不存在的规则')
    expect(await screen.findByText('没有匹配的端口规则，换个关键词或清空搜索')).toBeInTheDocument()
  })

  it('开关切换即改状态并发 mock 通知', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    await user.click(screen.getByRole('switch', { name: '禁ping' }))

    expect(screen.getByRole('switch', { name: '禁ping' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      '禁 ping 已关闭（mock，待接入真实执行）',
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

    await user.type(within(dialog).getByLabelText(/端口/), '8443')
    await user.type(within(dialog).getByLabelText('备注'), '演示入口')
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))

    expect(screen.queryByRole('dialog', { name: '添加端口规则' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('搜索端口、来源或备注'), '8443')
    expect(await screen.findByText(/共 1 条/)).toBeInTheDocument()
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
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
    expect(confirm.textContent).toContain('不会触碰任何真实防火墙')

    await user.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // 添加用例先运行过，种子之外多了一条 8443。
    expect(screen.getByText(new RegExp(`共 ${SEED_RULE_COUNT + 1} 条`))).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: '删除' }))
    await user.click(
      within(await screen.findByRole('dialog', { name: '确认删除端口规则「tcp 2234」？' })).getByRole(
        'button',
        { name: '确认删除' },
      ),
    )
    await waitFor(() => expect(screen.getByText(new RegExp(`共 ${SEED_RULE_COUNT} 条`))).toBeInTheDocument())
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      '端口规则 tcp 2234 已删除（mock，待接入真实执行）',
    )
  })

  it('四个工具按钮都可用：防扫描弹窗按样例呈现统计与空列表', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    for (const label of ['导入规则', '导出规则', '端口防扫描', '同步规则']) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled()
    }

    await user.click(screen.getByRole('button', { name: '端口防扫描' }))
    const dialog = await screen.findByRole('dialog', { name: '端口防扫描' })
    expect(dialog.textContent).toContain('演示 · 待接入真实执行')
    expect(within(dialog).getByRole('switch', { name: '防扫描开关' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    // 与参照样例一致的四个统计值
    expect(within(dialog).getByText('封锁的IP总数').parentElement).toHaveTextContent('340')
    expect(within(dialog).getByText('连接失败总数').parentElement).toHaveTextContent('168694')
    expect(within(dialog).getByText('当前封锁IP数').parentElement).toHaveTextContent('0')
    expect(within(dialog).getByText('当前连接失败次数').parentElement).toHaveTextContent('0')
    // 列表为空，与参照样例一致
    expect(within(dialog).getByText('暂无数据')).toBeInTheDocument()
    // 关掉开关留 mock 通知。弹窗开着时通知区被 Radix 标记 aria-hidden，role 查询要带 hidden。
    await user.click(within(dialog).getByRole('switch', { name: '防扫描开关' }))
    const notifications = await screen.findByLabelText('通知')
    expect(
      within(notifications).getByRole('status', { hidden: true }),
    ).toHaveTextContent('端口防扫描已关闭')
  })

  it('防扫描封锁列表：IP 搜索框只收 IP 格式字符并模糊过滤', async () => {
    const user = userEvent.setup()
    const blockedScan = {
      enabled: true,
      config: { ports: [22, 23, 3306], windowSeconds: 60, hitCount: 8, banSeconds: 3600 },
      stats: {
        totalBlockedIps: 2,
        totalFailedConnections: 9,
        currentBlockedIps: 2,
        currentFailedConnections: 9,
      },
      blocked: [
        { ip: '172.22.0.3', blockedAt: '2026-09-19T01:04:46.179Z' },
        { ip: '198.51.100.7', blockedAt: '2026-09-19T01:05:00.000Z' },
      ],
    }
    await openFirewallPage(
      sessionGateway({ scanProtection: async () => blockedScan }),
    )

    await user.click(screen.getByRole('button', { name: '端口防扫描' }))
    const dialog = await screen.findByRole('dialog', { name: '端口防扫描' })
    expect(within(dialog).getAllByText('解封')).toHaveLength(2)

    const input = within(dialog).getByLabelText('搜索 IP')
    // 非法字符被剥掉，只留数字与点号；按子串模糊过滤
    await user.type(input, 'abc22.0x')
    expect(input).toHaveValue('22.0')
    expect(within(dialog).getByText('172.22.0.3')).toBeInTheDocument()
    expect(within(dialog).queryByText('198.51.100.7')).not.toBeInTheDocument()

    // 清空搜索回到全量
    await user.clear(input)
    expect(within(dialog).getAllByText('解封')).toHaveLength(2)

    // 无匹配给中文空态
    await user.type(input, '99.')
    expect(within(dialog).getByText('没有匹配的 IP，换个关键字试试')).toBeInTheDocument()
  })

  it('导入规则：本地 JSON 文件解析入集，坏文件报危险通知', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).not.toBeNull()

    // 坏文件：只给危险通知（danger → alert），不加规则
    await user.upload(input, new File(['{ not json'], 'bad.json', { type: 'application/json' }))
    let notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('alert')).toHaveTextContent('导入失败：不是有效的规则 JSON')
    expect(screen.getByText(new RegExp(`共 ${SEED_RULE_COUNT} 条`))).toBeInTheDocument()

    // 好文件：1 条新增 + 1 条与现有数据重复跳过（8443 是此前添加用例建出的）。
    const payload = {
      kind: 'elysian-firewall-rules',
      direction: 'all',
      rules: [
        { protocol: 'tcp', port: 9090, family: 'ipv4', policy: 'allow', source: '所有IP', note: '演示导入' },
        { protocol: 'tcp', port: 8443, family: 'ipv4', policy: 'allow', source: '所有IP', note: '重复行' },
      ],
    }
    await user.upload(
      input,
      new File([JSON.stringify(payload)], 'rules.json', { type: 'application/json' }),
    )
    notifications = await screen.findByLabelText('通知')
    await waitFor(() =>
      expect(within(notifications).getByRole('status')).toHaveTextContent(
        '导入完成：新增 1 条，跳过重复 1 条（mock，待接入真实执行）',
      ),
    )
    // 新规则进数据集：搜端口可见
    await user.type(screen.getByLabelText('搜索端口、来源或备注'), '9090')
    expect(await screen.findByText(/共 1 条/)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '端口规则表' }).textContent).toContain('演示导入')
  })

  it('导出规则：选方向后生成包含对应规则数的本地下载', async () => {
    const user = userEvent.setup()
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock')
    vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const clicks: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download)
    })

    try {
      await openFirewallPage()
      // 数据集在用例间共享，别写死总数：读页面当前的「共 N 条」。
      const total = Number((await screen.findByText(/共 \d+ 条/)).textContent?.match(/\d+/)?.[0])
      await user.click(screen.getByRole('button', { name: '导出规则' }))
      const dialog = await screen.findByRole('dialog', { name: '导出规则' })
      expect(dialog.textContent).toContain(`的 ${total} 条规则`)

      await user.click(within(dialog).getByRole('button', { name: '入站' }))
      await user.click(within(dialog).getByRole('button', { name: '导出' }))

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(createObjectURL.mock.calls[0]![0].type).toBe('application/json')
      expect(clicks[0]).toContain('-inbound-')
      // 弹窗即关，下载动作本身经通知条留痕
      expect(screen.queryByRole('dialog', { name: '导出规则' })).not.toBeInTheDocument()
      const notifications = screen.getByLabelText('通知')
      expect(
        within(notifications).getAllByRole('status', { hidden: true }).some((item) =>
          item.textContent?.includes('已导出'),
        ),
      ).toBe(true)
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
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
      // 计数从统计条自身的文本读（容器里的第一个数字是端口规则的，不能用）。
      const chipCount = (label: string) =>
        Number(screen.getByText(`${label}：`).textContent?.match(/(\d+)/)?.[1] ?? '0')
      const expected = chipCount('端口规则') + chipCount('IP 规则') + chipCount('端口转发')

      const notifications = screen.getByLabelText('通知')
      expect(within(notifications).getByRole('status')).toHaveTextContent(
        `已从操作系统同步防火墙规则，当前共 ${expected} 条（mock，待接入真实执行）`,
      )
      expect(screen.getByRole('button', { name: '同步规则' })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('端口列钉在第一列：表头与数据行都有 sticky 定位且带右描边', async () => {
    await openFirewallPage()

    const table = screen.getByRole('region', { name: '端口规则表' })
    const headers = within(table).getAllByRole('columnheader')
    expect(headers[0]).toHaveTextContent('端口')
    expect(headers[0]).toHaveClass('sticky', 'left-0', 'border-r')
    const firstRow = within(table).getAllByRole('row')[1]!
    expect(firstRow.firstElementChild).toHaveClass('sticky', 'left-0', 'border-r')
  })

  /**
   * 横向滚动容器里不能出现 sr-only（或任何绝对定位元素）：它的包含块是容器之外的定位祖先，
   * 于是把表格远端的静态坐标泄漏给文档滚动区，整个页面（含侧边栏）都能被横向拖走。
   * 表头要名字就直接写可见文本，不要拿 sr-only 文本充数。
   */
  it('滚动容器内不出现 sr-only 元素，操作列表头是可见文字', async () => {
    await openFirewallPage()

    const region = screen.getByRole('region', { name: '端口规则表' })
    expect(region.querySelectorAll('.sr-only')).toHaveLength(0)
    const headers = within(region).getAllByRole('columnheader')
    expect(headers[headers.length - 1]).toHaveTextContent('操作')
  })

  /**
   * 每列都必须在 colgroup 里给显式宽度：没有指定宽度的那一列会独吞宽屏多出来的空间。
   * 端口列还要禁止换行——地址族后缀折行会把行高从 43px 撑到 61px。
   */
  it('每列都有显式宽度，端口列禁止换行，备注长文本截断并保留完整提示', async () => {
    await openFirewallPage()

    const region = screen.getByRole('region', { name: '端口规则表' })
    const cols = region.querySelectorAll('colgroup col')
    expect(cols).toHaveLength(9)
    for (const col of cols) expect(col.className).toMatch(/\bw-(?:\d+|\[)/)

    const headers = within(region).getAllByRole('columnheader')
    expect(headers[0]).toHaveTextContent('端口')
    const portCell = within(region).getAllByRole('row')[1]!.firstElementChild
    expect(portCell).toHaveClass('whitespace-nowrap')

    // 备注列：有备注的行截断显示且带完整内容提示；没有备注的行仍是「—」。
    const noteCell = within(region).getAllByRole('row')[1]!.children[6] as HTMLElement
    const noteText = noteCell.querySelector('.truncate')
    expect(noteText).not.toBeNull()
    expect(noteText).toHaveAttribute('title', noteText?.textContent)
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
    expect(await screen.findByText('还没有端口规则')).toBeInTheDocument()
  })

  it('IP 规则视图：统计与表格呈现种子数据，可新增一条', async () => {
    const user = userEvent.setup()
    await openFirewallPage()

    // 统计条按视图呈现三类计数
    expect(screen.getByText('IP 规则：').parentElement).toHaveTextContent(`${SEED_IP_RULES.length}`)

    await user.click(screen.getByRole('button', { name: 'IP 规则' }))
    const region = await screen.findByRole('region', { name: 'IP 规则表' })
    expect(within(region).getByText('185.220.101.7')).toBeInTheDocument()
    // IP 视图不带导入/导出（那两条只服务端口规则）
    expect(screen.queryByRole('button', { name: '导入规则' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '添加 IP 规则' }))
    const dialog = await screen.findByRole('dialog', { name: '添加 IP 规则' })
    // 来源必填：直接提交给行内错误
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))
    expect(within(dialog).getByText(/来源必填/)).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText(/来源/), '198.51.100.0/24')
    await user.type(within(dialog).getByLabelText('备注'), '压力测试段')
    await user.click(within(dialog).getByRole('button', { name: '添加规则' }))

    await waitFor(() => expect(within(region).getByText('198.51.100.0/24')).toBeInTheDocument())
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
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
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      '端口转发 tcp 9090 → 10.0.0.20:80 已添加（mock，待接入真实执行）',
    )
  })
})
