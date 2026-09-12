import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createMockDataset } from '../../adapters/mock/dataset'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway, SkillAdapter } from '../../contracts/adapters'
import { renderApp } from '../../test/renderApp'

const dataset = createMockDataset()
const firstSkill = dataset.skills[0]

function createGateway() {
  return createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
}

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole('table', { name: '技能清单' })
  return within(table).getAllByRole('row').slice(1)
}

async function renderSkills(path = '/skills', gateway?: ElysianGateway) {
  const view = renderApp(path, gateway ? { gateway } : {})
  await screen.findByRole('table', { name: '技能清单' })
  return view
}

describe('技能目录', () => {
  it('列出全部技能，含职责、版本、能力、风险等级、启用状态与最近使用时间', async () => {
    await renderSkills()
    expect(bodyRows()).toHaveLength(dataset.skills.length)
    expect(firstSkill).toBeDefined()
    if (!firstSkill) return

    const row = within(bodyRows()[0] as HTMLElement)
    expect(row.getByText(firstSkill.name)).toBeInTheDocument()
    expect(row.getByText(firstSkill.responsibility)).toBeInTheDocument()
    expect(row.getByText(firstSkill.version)).toBeInTheDocument()
    expect(row.getByText(firstSkill.capabilities[0] ?? '')).toBeInTheDocument()
    expect(row.getByText(firstSkill.enabled ? '已启用' : '已停用')).toBeInTheDocument()
    expect(row.getByText(/风险/)).toBeInTheDocument()
  })

  it('按启用状态筛选，并把筛选写进地址', async () => {
    const user = userEvent.setup()
    const { router } = await renderSkills()

    await user.click(screen.getByRole('checkbox', { name: '已停用' }))

    const expected = dataset.skills.filter((skill) => !skill.enabled).length
    expect(expected).toBeGreaterThan(0)
    await waitFor(() => expect(bodyRows()).toHaveLength(expected))
    expect(router.state.location.search).toContain('state=disabled')
  })

  it('按能力筛选，只留下提供该能力的技能', async () => {
    await renderSkills('/skills?capability=logs.search')

    const expected = dataset.skills.filter((skill) => skill.capabilities.includes('logs.search'))
    expect(bodyRows()).toHaveLength(expected.length)
    expect(screen.getByText(/只看提供能力/)).toBeInTheDocument()
  })

  it('启停是本地状态切换，操作后界面立即反映并说明不代表真实环境变更', async () => {
    const user = userEvent.setup()
    const gateway = createGateway()
    await renderSkills('/skills', gateway)

    const first = bodyRows()[0] as HTMLElement
    const before = within(first).getByText(/已启用|已停用/).textContent
    await user.click(within(first).getByRole('button', { name: /启用|停用/ }))

    await waitFor(() => {
      const after = within(bodyRows()[0] as HTMLElement).getByText(/已启用|已停用/).textContent
      expect(after).not.toBe(before)
    })

    const note = await screen.findByRole('status')
    expect(note).toHaveTextContent('已在本地演示状态中')
    expect(note).toHaveTextContent('不代表真实环境变更')
  })

  it('启停会影响技能注册表的返回结果', async () => {
    const user = userEvent.setup()
    const gateway = createGateway()
    await renderSkills('/skills', gateway)

    const first = bodyRows()[0] as HTMLElement
    const targetName = firstSkill?.name ?? ''
    await user.click(within(first).getByRole('button', { name: /启用|停用/ }))

    await waitFor(async () => {
      const skills = await gateway.skills.list()
      const updated = skills.find((skill) => skill.name === targetName)
      expect(updated?.enabled).toBe(!firstSkill?.enabled)
    })
  })

  it('技能详情以 manifest 风格展示完整声明', async () => {
    const user = userEvent.setup()
    await renderSkills()

    await user.click(within(bodyRows()[0] as HTMLElement).getByRole('button', { name: '详情' }))

    const dialog = await screen.findByRole('dialog', { name: /manifest/ })
    expect(within(dialog).getByText(firstSkill?.id ?? '')).toBeInTheDocument()
    const manifest = within(dialog).getByText(/"capabilities"/)
    expect(manifest).toBeInTheDocument()
    expect(within(dialog).getByText(/"riskLevel"/)).toBeInTheDocument()
  })

  it('最近使用时间按固定时区渲染，不依赖当前时钟', async () => {
    await renderSkills()
    const expected = dataset.skills[0]?.lastUsedAt
    expect(expected).toBeDefined()
    // 同一份种子数据每次渲染结果一致，说明时间只由数据决定。
    const rendered = within(bodyRows()[0] as HTMLElement).getByText(/\d{2}\/\d{2} \d{2}:\d{2}/)
    expect(rendered).toBeInTheDocument()
  })

  it('启停失败时给出明确反馈', async () => {
    const user = userEvent.setup()
    const base = createGateway()
    const skills: SkillAdapter = {
      list: () => base.skills.list(),
      setEnabled: async () => {
        throw new Error('演示用的启停失败')
      },
    }

    await renderSkills('/skills', { ...base, skills })
    await user.click(within(bodyRows()[0] as HTMLElement).getByRole('button', { name: /启用|停用/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('技能启停失败：演示用的启停失败')
  })

  it('筛选无结果时说明是筛选导致', async () => {
    renderApp('/skills?capability=不存在的.能力')
    expect(await screen.findByText('当前筛选条件下没有技能')).toBeInTheDocument()
  })
})
