import { screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SEED_LOGIN_KEYS } from '../../adapters/mock/sshData'
import { useSshStore } from '../../stores/sshStore'
import { openSshTab, resetSshPanel, sshSessions } from '../../test/sshPanel'

/**
 * SSH 密钥表的端到端行为：种子列表、按名称与完整私钥搜索、创建、删除、查看密钥。
 * 数据走默认 mock 数据集（四把种子密钥），不另造假数据。
 */

beforeEach(() => {
  resetSshPanel()
})

function keyCard(): HTMLElement {
  return screen.getByRole('region', { name: 'SSH 密钥' })
}

/** 表格的数据行（去掉表头）。 */
function keyRows(): HTMLElement[] {
  const table = within(keyCard()).getByRole('table')
  return within(table).getAllByRole('row').slice(1)
}

describe('SSH 密钥表', () => {
  it('列出种子里四把密钥，名称与创建时间上屏', async () => {
    await openSshTab()

    const rows = keyRows()
    expect(rows).toHaveLength(SEED_LOGIN_KEYS.length)
    expect(rows[0]?.textContent).toContain('部署机')
    expect(rows[0]?.textContent).toContain('06/10 21:56')
    expect(rows[1]?.textContent).toContain('CI 发布')
    expect(within(keyCard()).getByText('共 4 把密钥')).toBeInTheDocument()
  })

  it('搜索：名称片段、完整私钥、指纹都能准确定位到那一行', async () => {
    const user = await openSshTab()
    const input = within(keyCard()).getByLabelText('搜索密钥')

    // 名称片段
    await user.type(input, '发布')
    expect(keyRows()).toHaveLength(1)
    expect(keyRows()[0]?.textContent).toContain('CI 发布')
    expect(within(keyCard()).getByText('匹配 1 把 · 共 4 把')).toBeInTheDocument()

    // 粘一整份私钥（跨多行）：只命中它自己
    const deployKey = SEED_LOGIN_KEYS[0]
    await user.clear(input)
    await user.click(input)
    await user.paste(deployKey?.privateKey ?? '')
    expect(keyRows()).toHaveLength(1)
    expect(keyRows()[0]?.textContent).toContain('部署机')

    // 粘指纹
    await user.clear(input)
    await user.type(input, SEED_LOGIN_KEYS[2]?.fingerprint ?? '')
    expect(keyRows()).toHaveLength(1)
    expect(keyRows()[0]?.textContent).toContain('个人笔记本')

    // 搜不到时给空态，而不是留一张空表
    await user.clear(input)
    await user.type(input, '不存在的一把密钥')
    expect(keyRows()).toHaveLength(1)
    expect(
      within(keyCard()).getByText('没有匹配的密钥，换个关键词或粘一整份私钥试试'),
    ).toBeInTheDocument()
  })

  it('创建密钥：空名称与重名就地报错，成功后入表并发 mock 通知', async () => {
    const user = await openSshTab()

    await user.click(within(keyCard()).getByRole('button', { name: '创建 SSH 密钥' }))
    const dialog = await screen.findByRole('dialog', { name: '创建 SSH 密钥' })
    expect(dialog.textContent).toContain('演示 · 待接入真实执行')

    // 空名称：行内报错，不发请求（弹窗打开期间页面被设为不可见，因此直接看 store）
    await user.click(within(dialog).getByRole('button', { name: '创建密钥' }))
    expect(within(dialog).getByText('密钥名称需为 1-32 个字符')).toBeInTheDocument()
    expect(useSshStore.getState().keys).toHaveLength(SEED_LOGIN_KEYS.length)

    // 与已有名称重复：同样就地报错
    await user.type(within(dialog).getByLabelText(/密钥名称/), '部署机')
    await user.click(within(dialog).getByRole('button', { name: '创建密钥' }))
    expect(within(dialog).getByText('密钥名称已存在：部署机')).toBeInTheDocument()

    await user.clear(within(dialog).getByLabelText(/密钥名称/))
    await user.type(within(dialog).getByLabelText(/密钥名称/), '运维笔记本')
    await user.click(within(dialog).getByRole('button', { name: '创建密钥' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '创建 SSH 密钥' })).not.toBeInTheDocument(),
    )
    expect(keyRows()).toHaveLength(SEED_LOGIN_KEYS.length + 1)
    expect(keyCard().textContent).toContain('运维笔记本')

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      'SSH 密钥「运维笔记本」已创建（mock，待接入真实执行）',
    )
  })

  it('删除密钥：确认弹窗里取消不动数据，确认后行消失并发通知', async () => {
    const user = await openSshTab()

    await user.click(within(keyCard()).getByRole('button', { name: '删除 部署机' }))
    const dialog = await screen.findByRole('dialog', { name: '确认删除 SSH 密钥「部署机」？' })
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(keyRows()).toHaveLength(SEED_LOGIN_KEYS.length)

    await user.click(within(keyCard()).getByRole('button', { name: '删除 部署机' }))
    await user.click(
      within(
        await screen.findByRole('dialog', { name: '确认删除 SSH 密钥「部署机」？' }),
      ).getByRole('button', { name: '确认删除' }),
    )

    await waitFor(() => expect(keyRows()).toHaveLength(SEED_LOGIN_KEYS.length - 1))
    expect(keyCard().textContent).not.toContain('部署机')

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent(
      'SSH 密钥「部署机」已删除（mock，待接入真实执行）',
    )
  })

  it('查看密钥：行内入口给出那一把的指纹与私钥全文', async () => {
    const user = await openSshTab()

    await user.click(within(keyCard()).getByRole('button', { name: '查看密钥 CI 发布' }))

    const dialog = await screen.findByRole('dialog', { name: '查看密钥 · CI 发布' })
    expect(dialog.textContent).toContain('演示密钥 · 不对应任何真实主机')
    expect(dialog.textContent).toContain(SEED_LOGIN_KEYS[1]?.fingerprint ?? '指纹缺失')
    expect(within(dialog).getByText(/BEGIN OPENSSH PRIVATE KEY/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '复制密钥' })).toBeInTheDocument()
    // 公钥留在本机、不上屏：弹窗里既没有它的正文，也没有复制它的入口
    expect(dialog.textContent).not.toContain(SEED_LOGIN_KEYS[1]?.publicKey ?? '永远不该出现')
    expect(within(dialog).queryByRole('button', { name: '复制公钥' })).not.toBeInTheDocument()
    expect(dialog.textContent).toContain('公钥在创建时已保存在本机授权文件里')
  })

  it('密钥表的数据来自 adapter：换一份列表就换一份表格', async () => {
    const { gateway } = sshSessions({
      listKeys: async () => [
        {
          id: 'key-只有一把',
          name: '只有一把',
          algorithm: 'ssh-ed25519 256',
          fingerprint: 'SHA256:onlyone',
          createdAt: '2026-01-02T03:04:05',
          publicKey: 'ssh-ed25519 AAAAC3Nza 只有一把@elysian-demo',
          privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n占位\n-----END OPENSSH PRIVATE KEY-----',
        },
      ],
    })
    await openSshTab(gateway)

    expect(keyRows()).toHaveLength(1)
    expect(within(keyCard()).getByText('共 1 把密钥')).toBeInTheDocument()
  })
})
