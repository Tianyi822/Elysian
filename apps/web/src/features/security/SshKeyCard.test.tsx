import { messageHistoryText } from '../../test/messageHistory'
import { screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SEED_LOGIN_KEYS } from '../../adapters/mock/sshData'
import { SSH_PAGE_SIZE, useSshStore } from '../../stores/sshStore'
import { openSshTab, resetSshPanel, sshSessions } from '../../test/sshPanel'

/**
 * SSH 密钥表的端到端行为：种子列表、按名称、账号与指纹搜索、创建、删除、查看密钥。
 * 数据走默认 mock 数据集（四把种子密钥），不另造假数据。
 */

beforeEach(async () => {
  await resetSshPanel()
})

function keyCard(): HTMLElement {
  return screen.getByRole('region', { name: 'SSH 密钥' })
}

/** 表格的数据行（去掉表头）。 */
function userRows(): HTMLElement[] {
  const table = within(keyCard()).getByRole('table')
  return within(table).getAllByRole('row').slice(1)
}

function showMore(): HTMLElement {
  return within(keyCard()).getByRole('button', { name: /显示更多/ })
}

describe('SSH 密钥表', () => {
  it('先显示 20 把密钥，显示更多后追加其余密钥', async () => {
    const user = await openSshTab()
    expect(userRows()).toHaveLength(SSH_PAGE_SIZE)
    await user.click(showMore())
    await waitFor(() => expect(userRows()).toHaveLength(SEED_LOGIN_KEYS.length))
    expect(within(keyCard()).queryByRole('button', { name: /显示更多/ })).not.toBeInTheDocument()
    expect(within(keyCard()).queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('改变搜索后重置展示窗口，过滤仍按原密钥判据', async () => {
    const user = await openSshTab()
    await user.click(showMore())
    const input = within(keyCard()).getByLabelText('搜索密钥')
    await user.type(input, '临时密钥')
    const count = SEED_LOGIN_KEYS.filter(key => key.name.includes('临时密钥')).length
    await waitFor(() => expect(userRows()).toHaveLength(count))
    await user.clear(input)
    await waitFor(() => expect(userRows()).toHaveLength(SSH_PAGE_SIZE))
  })

  it('搜索：名称片段、指纹能准确定位到那一行；私钥不再参与匹配', async () => {
    const user = await openSshTab()
    const input = within(keyCard()).getByLabelText('搜索密钥')

    // 名称片段
    await user.type(input, '发布')
    await waitFor(() => expect(userRows()).toHaveLength(1))
    expect(userRows()[0]?.textContent).toContain('CI 发布')

    // 粘一整份种子私钥：列表数据不带私钥（私钥只在创建那一次出现过），因此搜不到
    const deployKey = SEED_LOGIN_KEYS[0]
    await user.clear(input)
    await user.click(input)
    await user.paste(deployKey?.privateKey ?? '')
    await waitFor(() => expect(userRows()).toHaveLength(0))
    expect(within(keyCard()).getByText('没有结果')).toBeInTheDocument()

    // 粘指纹
    await user.clear(input)
    await user.type(input, SEED_LOGIN_KEYS[2]?.fingerprint ?? '')
    await waitFor(() => expect(userRows()).toHaveLength(1))
    expect(userRows()[0]?.textContent).toContain('个人笔记本')

    // 搜不到时给空态，而不是留一张空表
    await user.clear(input)
    await user.type(input, '不存在的一把密钥')
    await waitFor(() => expect(userRows()).toHaveLength(0))
    expect(within(keyCard()).getByText('没有结果')).toBeInTheDocument()
  })

  it('创建密钥：先选归属账号再填名称，名称校验就地报错，成功后入表并发 mock 通知', async () => {
    const user = await openSshTab()

    await user.click(within(keyCard()).getByRole('button', { name: '创建 SSH 密钥' }))
    const dialog = await screen.findByRole('dialog', { name: '创建 SSH 密钥' })
    expect(dialog.textContent).toContain('演示 · 待接入真实执行')
    expect(dialog.textContent).toContain('公钥会写进这个账号的 authorized_keys')

    // 归属账号是必填的第一项：没选就不往下走
    await user.click(within(dialog).getByRole('button', { name: '创建密钥' }))
    expect(within(dialog).getByText('请选择归属账号')).toBeInTheDocument()
    expect(useSshStore.getState().keys).toHaveLength(SEED_LOGIN_KEYS.length)

    await user.click(within(dialog).getByRole('button', { name: /归属账号/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'wangwu' }))

    // 空名称与重名同样就地报错，都不发请求
    await user.click(within(dialog).getByRole('button', { name: '创建密钥' }))
    expect(within(dialog).getByText('密钥名称需为 1-32 个字符')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText(/密钥名称/), '部署机')
    await user.click(within(dialog).getByRole('button', { name: '创建密钥' }))
    expect(within(dialog).getByText('密钥名称已存在：部署机')).toBeInTheDocument()

    await user.clear(within(dialog).getByLabelText(/密钥名称/))
    await user.type(within(dialog).getByLabelText(/密钥名称/), '运维笔记本')
    await user.click(within(dialog).getByRole('button', { name: '创建密钥' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '创建 SSH 密钥' })).not.toBeInTheDocument(),
    )

    // 创建成功后私钥只在一次性弹窗里展示这一次：有关闭即清空的提示与下载入口。
    const reveal = await screen.findByRole('dialog', { name: '新密钥「运维笔记本」的私钥' })
    expect(within(reveal).getByText('私钥仅此次可见')).toBeInTheDocument()
    expect(within(reveal).getByText(/BEGIN OPENSSH PRIVATE KEY/)).toBeInTheDocument()
    expect(within(reveal).getByRole('button', { name: '下载私钥' })).toBeInTheDocument()
    // 下载文件名以归属账号开头但不显示在界面上（wangwu-ssh-key-<日期>.pem，下载时生效）。
    expect(within(reveal).queryByText(/wangwu-ssh-key-\d{8}\.pem/)).not.toBeInTheDocument()
    await user.click(within(reveal).getByRole('button', { name: '关闭弹窗' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '新密钥「运维笔记本」的私钥' })).not.toBeInTheDocument(),
    )
    // 关闭后入列的条目不带私钥：列表与查看都取不到它。
    expect(useSshStore.getState().keys.at(-1)?.privateKey).toBeUndefined()

    // 新密钥排在最后一把之后，追加显示后可见。
    expect(useSshStore.getState().keys).toHaveLength(SEED_LOGIN_KEYS.length + 1)
    await user.click(showMore())
    expect(keyCard().textContent).toContain('运维笔记本')
    // 归属账号落到行里：这把密钥记在 wangwu 名下
    const created = userRows().find((row) => row.textContent?.includes('运维笔记本'))
    expect(created?.textContent).toContain('wangwu')
    expect(messageHistoryText('status')).toContain(
      'SSH 密钥「运维笔记本」已创建（mock，待接入真实执行）',
    )
  })

  it('账号清单为空时，归属账号下拉给出说明，而不是一个看不见的空盒', async () => {
    const { gateway } = sshSessions({ keyAccounts: async () => [] })
    const user = await openSshTab(gateway)

    await user.click(within(keyCard()).getByRole('button', { name: '创建 SSH 密钥' }))
    const dialog = await screen.findByRole('dialog', { name: '创建 SSH 密钥' })
    await user.click(within(dialog).getByRole('button', { name: /归属账号/ }))

    expect(await screen.findByText('还没有可选的账号，先创建一个可登录的主机账号')).toBeInTheDocument()
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
  })

  it('删除密钥：确认弹窗里取消不动数据，确认后行消失并发通知', async () => {
    const user = await openSshTab()

    await user.click(within(keyCard()).getByRole('button', { name: '删除 部署机' }))
    const dialog = await screen.findByRole('dialog', { name: '确认删除 SSH 密钥「部署机」？' })
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(useSshStore.getState().keys).toHaveLength(SEED_LOGIN_KEYS.length)

    await user.click(within(keyCard()).getByRole('button', { name: '删除 部署机' }))
    await user.click(
      within(
        await screen.findByRole('dialog', { name: '确认删除 SSH 密钥「部署机」？' }),
      ).getByRole('button', { name: '确认删除' }),
    )

    await waitFor(() => expect(useSshStore.getState().keys).toHaveLength(SEED_LOGIN_KEYS.length - 1))
    // 少了一把，后续第一把补进展示窗口，仍显示 20 行
    await waitFor(() => expect(userRows()).toHaveLength(SSH_PAGE_SIZE))
    expect(keyCard().textContent).not.toContain('部署机')
    expect(messageHistoryText('status')).toContain(
      'SSH 密钥「部署机」已删除（mock，待接入真实执行）',
    )
  })

  it('查看密钥：行内入口给出那一把的指纹与公钥全文，不出现私钥', async () => {
    const user = await openSshTab()

    await user.click(within(keyCard()).getByRole('button', { name: '查看密钥 CI 发布' }))

    const dialog = await screen.findByRole('dialog', { name: '查看密钥 · CI 发布' })
    expect(dialog.textContent).toContain('演示密钥 · 不对应任何真实主机')
    expect(dialog.textContent).toContain(SEED_LOGIN_KEYS[1]?.fingerprint ?? '指纹缺失')
    expect(dialog.textContent).toContain('公钥内容')
    expect(dialog.textContent).toContain(SEED_LOGIN_KEYS[1]?.publicKey ?? '公钥缺失')
    expect(within(dialog).getByRole('button', { name: '公钥' })).toBeInTheDocument()
    // 私钥不在查看弹窗里：既没有它的正文，也没有下载它的入口
    expect(within(dialog).queryByText(/BEGIN OPENSSH PRIVATE KEY/)).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '下载私钥' })).not.toBeInTheDocument()
    expect(dialog.textContent).toContain('私钥只在创建/生成的那一次展示过，这里不再提供')
  })

  it('密钥表的数据来自 adapter：换一份列表就换一份表格', async () => {
    const { gateway } = sshSessions({
      listKeys: async () => [
        {
          id: 'key-只有一把',
          name: '只有一把',
          userId: 'user-wangwu',
          algorithm: 'ssh-ed25519 256',
          fingerprint: 'SHA256:onlyone',
          createdAt: '2026-01-02T03:04:05',
          publicKey: 'ssh-ed25519 AAAAC3Nza 只有一把@elysian-demo',
          privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n占位\n-----END OPENSSH PRIVATE KEY-----',
        },
      ],
    })
    await openSshTab(gateway)

    await waitFor(() => expect(userRows()).toHaveLength(1))
    expect(within(keyCard()).queryByRole('button', { name: /显示更多/ })).not.toBeInTheDocument()
  })
})
