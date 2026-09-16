import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { SEED_SSH_PORT } from '../../adapters/mock/sshData'
import { useNotificationStore } from '../../stores/notificationStore'
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
  it('切到页签后渲染四张分区卡，中屏起两列、行内等高', async () => {
    await openSshTab()

    const service = screen.getByRole('region', { name: 'SSH 服务' })
    const root = screen.getByRole('region', { name: 'Root 设置' })
    const keys = screen.getByRole('region', { name: 'SSH 密钥' })
    const records = screen.getByRole('region', { name: 'SSH 登录记录' })
    for (const card of [service, root, keys, records]) {
      expect(card).toBeInTheDocument()
    }

    // 等高来自网格列的默认拉伸：卡片不写 items-start，同一行的两张卡因此同高对齐。
    const grid = service.parentElement
    expect(grid).toHaveClass('md:grid-cols-2')
    expect(grid).not.toHaveClass('items-start')
    expect(grid?.contains(keys)).toBe(true)

    // 卡内按区域划分，每区自带小标题。
    for (const name of ['服务状态', '监听端口', '登录方式']) {
      expect(within(service).getByText(name), name).toBeInTheDocument()
    }
    for (const name of ['Root 登录策略', 'Root 密码', 'Root 密钥']) {
      expect(within(root).getByText(name), name).toBeInTheDocument()
    }
  })

  it('登录记录占位卡标明未实现，不假装有数据', async () => {
    await openSshTab()

    const records = screen.getByRole('region', { name: 'SSH 登录记录' })
    expect(within(records).getByText('待实现：SSH 登录记录')).toBeInTheDocument()
    expect(within(records).getByText(/本期未实现/)).toBeInTheDocument()
    expect(within(records).queryByRole('table')).not.toBeInTheDocument()
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

  it('查看密钥：弹窗给出指纹、算法与演示私钥全文，关闭后回到卡片', async () => {
    const user = await openSshTab()
    const root = screen.getByRole('region', { name: 'Root 设置' })

    await user.click(within(root).getByRole('button', { name: '查看密钥' }))

    const dialog = await screen.findByRole('dialog', { name: '查看 Root 密钥' })
    expect(dialog.textContent).toContain('演示密钥 · 不对应任何真实主机')
    expect(dialog.textContent).toContain('ssh-ed25519 256')
    expect(dialog.textContent).toContain('SHA256:')
    expect(within(dialog).getByText(/BEGIN OPENSSH PRIVATE KEY/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '复制密钥' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '下载私钥' })).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '关闭弹窗' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '查看 Root 密钥' })).not.toBeInTheDocument(),
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
