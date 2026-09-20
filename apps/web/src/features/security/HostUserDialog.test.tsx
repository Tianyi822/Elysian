import { screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HostUser, HostUserInput } from '@elysian/contracts'
import { SEED_HOST_USERS } from '../../adapters/mock/usersData'
import { openSshTab, resetSshPanel, userSessions } from '../../test/sshPanel'

/**
 * 主机账号弹窗的备注前置校验：逗号是 GECOS 的字段分隔符，控制字符写不进
 * usermod 的参数——判据与文案与服务端（adapters/usersHost/usersService）一致，
 * 输入时就提示，而不是提交后才被服务端拒绝。
 */

beforeEach(() => {
  resetSshPanel()
})

function usersPanel(): HTMLElement {
  return screen.getByRole('region', { name: '主机账号表' })
}

async function openUsersTab(gateway = userSessions().gateway) {
  return openSshTab(gateway, '用户管理')
}

describe('主机账号弹窗备注校验', () => {
  it('创建用户：备注含逗号或控制字符时输入即提示（与服务端同一句），提交被拦不发请求；改好后可创建', async () => {
    const creates: ({ name: string } & HostUserInput)[] = []
    const { gateway, users: base } = userSessions({
      create: (input) => {
        creates.push(input)
        return base.create(input)
      },
    })
    const user = await openUsersTab(gateway)

    await user.click(screen.getByRole('button', { name: '创建用户' }))
    const dialog = await screen.findByRole('dialog', { name: '创建用户' })
    await user.type(within(dialog).getByLabelText(/用户名/), 'chenyi')

    // 打进一个逗号：还没点创建错误就已经在——文案与服务端错误逐字一致
    const noteInput = within(dialog).getByLabelText('备注')
    await user.type(noteInput, '运维,值班')
    expect(
      within(dialog).getByText('备注不能包含逗号（GECOS 里逗号用于分字段）'),
    ).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '创建用户' }))
    expect(creates).toHaveLength(0)
    expect(screen.getByRole('dialog', { name: '创建用户' })).toBeInTheDocument()

    // 控制字符同样前置提示；逗号提示随修改消失
    await user.clear(noteInput)
    await user.type(noteInput, '值班\u0007专用')
    expect(within(dialog).queryByText(/逗号/)).not.toBeInTheDocument()
    expect(within(dialog).getByText('备注不能包含换行或控制字符')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '创建用户' }))
    expect(creates).toHaveLength(0)

    // 改成合法备注即可创建，note 以 trim 后的值透传
    await user.clear(noteInput)
    await user.type(noteInput, '运维值班')
    await user.click(within(dialog).getByRole('button', { name: '创建用户' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '创建用户' })).not.toBeInTheDocument(),
    )
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({ name: 'chenyi', note: '运维值班' })
  })

  it('修改账号：已有备注含逗号的账号打开即见原因，改好备注后其他字段照常保存', async () => {
    const updates: { userId: string; input: HostUserInput }[] = []
    const legacy: HostUser = { ...SEED_HOST_USERS[0]!, note: '部署账号,值班专用' }
    const { gateway, users: base } = userSessions({
      list: async () => [legacy],
      update: (userId, input) => {
        updates.push({ userId, input })
        return base.update(userId, input)
      },
    })
    const user = await openUsersTab(gateway)

    await user.click(within(usersPanel()).getByRole('button', { name: '修改 deploy' }))
    const dialog = await screen.findByRole('dialog', { name: '修改账号 deploy' })

    // 系统侧遗留的含逗号备注在打开时就说明是哪里挡了保存，不再提交后才被拒
    const noteInput = within(dialog).getByLabelText('备注')
    expect(noteInput).toHaveValue('部署账号,值班专用')
    expect(
      within(dialog).getByText('备注不能包含逗号（GECOS 里逗号用于分字段）'),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }))
    expect(updates).toHaveLength(0)

    // 修好备注即可保存其余字段，不被历史坏值卡死
    await user.clear(noteInput)
    await user.type(noteInput, '部署账号 值班专用')
    await user.click(within(dialog).getByRole('button', { name: '已停用' }))
    await user.click(within(dialog).getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      userId: 'user-deploy',
      input: { note: '部署账号 值班专用', status: 'disabled' },
    })
  })
})
