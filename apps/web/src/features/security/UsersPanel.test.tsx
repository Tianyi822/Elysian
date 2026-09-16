import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { SEED_HOST_USERS } from '../../adapters/mock/usersData'
import { useUsersStore } from '../../stores/usersStore'
import { renderApp } from '../../test/renderApp'
import { openSshTab, resetSshPanel, securityTab, userSessions } from '../../test/sshPanel'

/**
 * 用户管理页签的端到端行为：主机账号表格、创建、修改、删除与四状态。
 * 数据走默认 mock 数据集（五个种子账号），不另造假数据。
 */

beforeEach(() => {
  resetSshPanel()
})

function usersPanel(): HTMLElement {
  return screen.getByRole('region', { name: '主机账号表' })
}

/** 表格的数据行（去掉表头）。 */
function userRows(): HTMLElement[] {
  const table = within(usersPanel()).getByRole('table')
  return within(table).getAllByRole('row').slice(1)
}

async function openUsersTab(gateway = userSessions().gateway) {
  return openSshTab(gateway, '用户管理')
}

describe('用户管理页签', () => {
  it('按创建时间倒序列出种子账号：用户名、权限组、登录方式、状态与备注', async () => {
    await openUsersTab()

    const table = within(usersPanel()).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '用户名',
      '权限组',
      '登录方式',
      '状态',
      '备注',
      '操作',
    ])

    const rows = userRows()
    expect(rows).toHaveLength(SEED_HOST_USERS.length)
    expect(rows.map((row) => row.children[0]?.textContent)).toEqual([
      'deploy',
      'monitor',
      'lisi',
      'wangwu',
      'zhangsan',
      'ops',
      'backup',
      'audit',
    ])
    // 权限组：主组与用户名同名，管理员另加标记
    expect(rows[3]?.children[1]?.textContent).toContain('wangwu')
    expect(rows[5]?.children[1]?.textContent).toContain('管理员')
    // 状态不靠颜色单独表达；备注为空显示 —
    expect(within(rows[4] as HTMLElement).getByText('已停用')).toBeInTheDocument()
    expect(rows[2]?.children[4]?.textContent).toBe('—')
    expect(
      screen.getByText(`共 ${SEED_HOST_USERS.length} 个主机账号`),
    ).toBeInTheDocument()

    // 首列钉住，窄屏下靠它把用户名留在视线里
    expect(rows[0]?.children[0]).toHaveClass('sticky', 'left-0')
  })

  it('搜索：按用户名与备注过滤，无结果给空态', async () => {
    const user = await openUsersTab()
    const input = screen.getByLabelText('搜索用户名或备注')

    await user.type(input, '运维')
    expect(userRows()).toHaveLength(1)
    expect(userRows()[0]?.children[0]?.textContent).toBe('wangwu')
    expect(screen.getByText(`匹配 1 个 · 共 ${SEED_HOST_USERS.length} 个主机账号`)).toBeInTheDocument()

    await user.clear(input)
    await user.type(input, 'BACKUP')
    expect(userRows()).toHaveLength(1)
    expect(userRows()[0]?.children[0]?.textContent).toBe('backup')

    await user.clear(input)
    await user.type(input, '不存在的人')
    expect(screen.getByText('没有匹配的账号，换个关键词或清空搜索')).toBeInTheDocument()
  })

  it('从系统同步账号：忙碌态可见，完成后刷新列表并发 mock 通知', async () => {
    const user = await openUsersTab()
    useUsersStore.setState({ users: [] })

    await user.click(screen.getByRole('button', { name: '从系统同步账号' }))

    // 同步中按钮换成忙碌态，完成后列表按同步结果重新读回来
    expect(await screen.findByRole('button', { name: '正在从系统同步账号' })).toBeInTheDocument()
    await waitFor(() => expect(userRows()).toHaveLength(SEED_HOST_USERS.length))

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      `已从系统同步账号，当前共 ${SEED_HOST_USERS.length} 个（mock，待接入真实执行）`,
    )
  })

  it('创建用户：用户名按 Linux 规则就地校验，成功后入表并发 mock 通知', async () => {
    const user = await openUsersTab()

    await user.click(screen.getByRole('button', { name: '创建用户' }))
    const dialog = await screen.findByRole('dialog', { name: '创建用户' })
    expect(dialog.textContent).toContain('演示 · 待接入真实执行')

    // 大写字母不合 Linux 取名规则；重名同样就地报错，都不发请求
    await user.type(within(dialog).getByLabelText(/用户名/), 'ChenYi')
    await user.click(within(dialog).getByRole('button', { name: '创建用户' }))
    expect(within(dialog).getByText(/用户名只能用小写字母/)).toBeInTheDocument()
    expect(useUsersStore.getState().users).toHaveLength(SEED_HOST_USERS.length)

    await user.clear(within(dialog).getByLabelText(/用户名/))
    await user.type(within(dialog).getByLabelText(/用户名/), 'lisi')
    await user.click(within(dialog).getByRole('button', { name: '创建用户' }))
    expect(within(dialog).getByText('用户名已存在：lisi')).toBeInTheDocument()

    await user.clear(within(dialog).getByLabelText(/用户名/))
    await user.type(within(dialog).getByLabelText(/用户名/), 'chenyi')
    await user.click(within(dialog).getByRole('button', { name: '创建用户' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '创建用户' })).not.toBeInTheDocument(),
    )
    // 新账号排在第一条，摘要同步
    expect(userRows()[0]?.children[0]?.textContent).toBe('chenyi')
    expect(
      screen.getByText(`共 ${SEED_HOST_USERS.length + 1} 个主机账号`),
    ).toBeInTheDocument()

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      '账号 chenyi 已创建（mock，待接入真实执行）',
    )
  })

  it('修改账号：用户名只读，登录方式与状态可改，保存后行内可见并发通知', async () => {
    const user = await openUsersTab()

    await user.click(within(usersPanel()).getByRole('button', { name: '修改 backup' }))
    const dialog = await screen.findByRole('dialog', { name: '修改账号 backup' })
    expect(within(dialog).getByLabelText(/用户名/)).toHaveAttribute('readonly')

    await user.click(within(dialog).getByRole('button', { name: '密码或密钥' }))
    await user.click(within(dialog).getByRole('button', { name: '已停用' }))
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '修改账号 backup' })).not.toBeInTheDocument(),
    )
    const backupRow = userRows().find((row) => row.children[0]?.textContent === 'backup')
    expect(backupRow?.textContent).toContain('密码或密钥')
    expect(within(backupRow as HTMLElement).getByText('已停用')).toBeInTheDocument()

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      '账号 backup 已改为「密码或密钥」· 已停用（mock，待接入真实执行）',
    )
  })

  it('删除账号：确认弹窗里取消不动数据，确认后行消失并发通知', async () => {
    const user = await openUsersTab()

    await user.click(within(usersPanel()).getByRole('button', { name: '删除 zhangsan' }))
    const dialog = await screen.findByRole('dialog', { name: '确认删除账号「zhangsan」？' })
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(userRows()).toHaveLength(SEED_HOST_USERS.length)

    await user.click(within(usersPanel()).getByRole('button', { name: '删除 zhangsan' }))
    await user.click(
      within(
        await screen.findByRole('dialog', { name: '确认删除账号「zhangsan」？' }),
      ).getByRole('button', { name: '确认删除' }),
    )

    await waitFor(() => expect(userRows()).toHaveLength(SEED_HOST_USERS.length - 1))
    expect(within(usersPanel()).queryByText('zhangsan')).not.toBeInTheDocument()

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      '账号 zhangsan 已删除（mock，待接入真实执行）',
    )
  })

  it('没有账号时给空态，而不是一张空表', async () => {
    const { gateway } = userSessions({ list: async () => [] })
    await openUsersTab(gateway)

    expect(screen.getByText('还没有主机账号，点左上角「创建用户」新建一个')).toBeInTheDocument()
    expect(screen.getByText('共 0 个主机账号')).toBeInTheDocument()
    const table = within(usersPanel()).getByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.textContent).toContain('还没有主机账号')
  })

  it('读取失败给错误态与重试，重试成功后内容出现', async () => {
    let calls = 0
    const { gateway, users } = userSessions({
      list: async () => {
        calls += 1
        if (calls === 1) throw new Error('演示用的读取失败')
        return users.list()
      },
    })
    // 错误态下面板不会渲染出表格，因此这里自己点页签，不用等在卡片上
    const user = userEvent.setup()
    renderApp('/security', { gateway })
    await user.click(securityTab('用户管理'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('账号数据加载失败')
    expect(alert).toHaveTextContent('演示用的读取失败')

    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('region', { name: '主机账号表' })).toBeInTheDocument()
    expect(userRows()).toHaveLength(SEED_HOST_USERS.length)
  })
})
