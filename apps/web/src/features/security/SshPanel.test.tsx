import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { SEED_LOGIN_RECORDS, SEED_SSH_PORT, SEED_SSH_STATS } from '../../adapters/mock/sshData'
import { useNotificationStore } from '../../stores/notificationStore'
import { SSH_PAGE_SIZE, useSshStore } from '../../stores/sshStore'
import { renderApp } from '../../test/renderApp'
import { openSshTab, resetSshPanel, securityTab, sshSessions } from '../../test/sshPanel'

/**
 * SSH 管理页签的端到端行为：四张分区卡、四状态、开关与保存、弱密码检测、密钥弹窗。
 * 数据走默认 mock 数据集（种子端口 73、密码登录关闭、密钥登录开启），不另造假数据。
 * 密钥表的用例在 SshKeyCard.test.tsx 一处覆盖，不在这里重复。
 */

beforeEach(() => {
  resetSshPanel()
})

describe('SSH 管理页签', () => {
  it('切到页签后渲染四张分区卡：设置卡等高，两张表各自取高度', async () => {
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

    // 第一行：网格默认拉伸，两张设置卡同高对齐。
    const settingRow = service.parentElement
    expect(settingRow).toHaveClass('md:grid-cols-2')
    expect(settingRow).not.toHaveClass('items-start')
    expect(settingRow?.contains(root)).toBe(true)

    // 第二行：items-start 让两张表各自按内容取高度，不互相拉平。
    const tableRow = keys.parentElement
    expect(tableRow).toHaveClass('md:grid-cols-2', 'items-start')
    expect(tableRow?.contains(records)).toBe(true)
    expect(settingRow).not.toBe(tableRow)

    // 卡内按区域划分，每区自带小标题。
    for (const name of ['服务状态', '登录统计', '监听端口', '登录方式']) {
      expect(within(service).getByText(name), name).toBeInTheDocument()
    }
    for (const name of ['Root 登录策略', 'Root 密码', 'Root 密钥']) {
      expect(within(root).getByText(name), name).toBeInTheDocument()
    }
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
    // 失败计数带危险色，成功计数不带：文字与颜色一起区分两种结果
    expect(within(rows[0] as HTMLElement).getAllByRole('cell')[1]).toHaveClass('text-danger')
    expect(within(rows[0] as HTMLElement).getAllByRole('cell')[0]).not.toHaveClass('text-danger')
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
    expect(within(service).getByText('运行中')).toBeInTheDocument()
    expect(within(service).getByRole('switch', { name: 'SSH 服务' })).toBeChecked()
    expect(within(service).getByLabelText('监听端口')).toHaveValue(`${SEED_SSH_PORT}`)
    expect(within(service).getByText('上次变更：—')).toBeInTheDocument()
    expect(within(service).getByRole('switch', { name: '密码登录' })).not.toBeChecked()
    expect(within(service).getByRole('switch', { name: '密钥登录' })).toBeChecked()
  })

  it('停用服务：状态转已停止并留下 mock 通知，重新启用后恢复', async () => {
    const user = await openSshTab()
    const service = screen.getByRole('region', { name: 'SSH 服务' })

    await user.click(within(service).getByRole('switch', { name: 'SSH 服务' }))

    expect(within(service).getByText('已停止')).toBeInTheDocument()
    expect(within(service).getByRole('switch', { name: 'SSH 服务' })).not.toBeChecked()

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      'SSH 服务已停用（mock，待接入真实执行）',
    )

    await user.click(within(service).getByRole('switch', { name: 'SSH 服务' }))
    expect(within(service).getByText('运行中')).toBeInTheDocument()
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

  it('端口非法就在界面层挡下不发请求；合法端口保存后通知并更新卡片上的端口', async () => {
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

    await user.clear(input)
    await user.type(input, '2222')
    await user.click(within(service).getByRole('button', { name: '保存端口' }))

    await waitFor(() => expect(savedPorts).toEqual([2222]))
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      'SSH 端口已改为 2222（mock，待接入真实执行）',
    )
    expect(input).toHaveValue('2222')
  })

  it('Root 登录策略四档可选，选中态随点击移动', async () => {
    const user = await openSshTab()
    const root = screen.getByRole('region', { name: 'Root 设置' })

    expect(within(root).getByRole('button', { name: '只能密钥登录' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.click(within(root).getByRole('button', { name: '禁止 Root 登录' }))
    expect(within(root).getByRole('button', { name: '禁止 Root 登录' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(root).getByRole('button', { name: '只能密钥登录' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      'Root 登录策略已改为「禁止 Root 登录」（mock，待接入真实执行）',
    )
  })

  it('Root 密码：弱密码被拒且不留重置时间，达标密码通过并留下可见变化', async () => {
    const user = await openSshTab()
    const root = screen.getByRole('region', { name: 'Root 设置' })
    const input = within(root).getByLabelText('Root 密码')

    expect(within(root).getByText('上次重置：—')).toBeInTheDocument()

    await user.type(input, 'abcdefgh')
    // 即时强度反馈与提交时的判定同源，用户提交前就能看见。
    expect(within(root).getByText('强度：弱')).toBeInTheDocument()

    await user.click(within(root).getByRole('button', { name: '重置密码' }))
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('alert')).toHaveTextContent('重置失败：密码强度不足')
    expect(within(root).getByText('上次重置：—')).toBeInTheDocument()
    expect(input).toHaveValue('abcdefgh')

    await user.clear(input)
    await user.type(input, 'Elysian#2026Root')
    expect(within(root).getByText('强度：强')).toBeInTheDocument()
    await user.click(within(root).getByRole('button', { name: '重置密码' }))

    await waitFor(() => expect(input).toHaveValue(''))
    expect(within(root).queryByText('上次重置：—')).not.toBeInTheDocument()
    expect(useNotificationStore.getState().notifications.map((item) => item.message)).toContain(
      'Root 密码已重置（强度：强；mock，待接入真实执行）',
    )
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
