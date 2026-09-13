import { RESPONSIBILITY_MODULES, RISK_RANK, RISK_LEVEL_LABELS } from '@elysian/contracts'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockDataset } from '../../adapters/mock/dataset'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useDashboardStore } from '../../stores/dashboardStore'
import { renderApp } from '../../test/renderApp'

const dataset = createMockDataset()

beforeEach(() => {
  useDashboardStore.setState({
    status: 'idle',
    refreshing: false,
    range: '7d',
    stats: undefined,
    modules: undefined,
    distribution: undefined,
    trend: undefined,
    auditRecords: undefined,
    errorMessage: undefined,
  })
})

/** 期望值用测试里的朴素计算独立算出，不经过被测聚合函数。 */
function expectedStats() {
  const pending = dataset.approvals.filter((approval) => approval.status === 'pending')
  const highest = pending.reduce<typeof pending[number]['riskLevel'] | undefined>((worst, a) => {
    if (!worst) return a.riskLevel
    return RISK_RANK[a.riskLevel] > RISK_RANK[worst] ? a.riskLevel : worst
  }, undefined)
  const openIncidents = dataset.incidents.filter(
    (incident) => incident.status !== 'resolved' && incident.status !== 'closed',
  )
  return {
    totalIncidents: dataset.incidents.length,
    openIncidents: dataset.incidents.filter((incident) => incident.status === 'open').length,
    runningRuns: dataset.runs.filter((run) => run.status === 'running').length,
    waitingRuns: dataset.runs.filter((run) => run.status === 'waiting-approval').length,
    pendingApprovals: pending.length,
    highestRiskLabel: highest ? RISK_LEVEL_LABELS[highest] : undefined,
    todayAuditEvents: dataset.audit.filter(
      (record) => record.at.slice(0, 10) === '2026-09-12',
    ).length,
    enabledSkills: dataset.skills.filter((skill) => skill.enabled).length,
    affectedServices: new Set(openIncidents.map((incident) => incident.service)).size,
  }
}

function card(label: string): HTMLElement {
  return screen.getByRole('article', { name: `${label}指标卡` })
}

async function renderReady() {
  renderApp('/')
  await screen.findByLabelText('事故总数指标卡')
}

describe('仪表盘指标卡', () => {
  it('呈现 8 张指标卡，数值与数据集的朴素独立计算一致', async () => {
    const expected = expectedStats()
    await renderReady()

    const cases: ReadonlyArray<[string, number]> = [
      ['事故总数', expected.totalIncidents],
      ['待处理事故', expected.openIncidents],
      ['执行中运行', expected.runningRuns],
      ['等待审批运行', expected.waitingRuns],
      ['待审批动作', expected.pendingApprovals],
      ['今日审计事件', expected.todayAuditEvents],
      ['启用技能', expected.enabledSkills],
      ['受影响服务', expected.affectedServices],
    ]
    for (const [label, value] of cases) {
      expect(within(card(label)).getByText(String(value))).toBeInTheDocument()
    }
  })

  it('待审批卡带最高风险标签', async () => {
    const expected = expectedStats()
    await renderReady()

    expect(
      within(card('待审批动作')).getByText(`风险 ${expected.highestRiskLabel}`),
    ).toBeInTheDocument()
  })

  it('加载失败给出错误态与重试，重试成功后内容出现', async () => {
    const user = userEvent.setup()
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    let calls = 0
    const gateway: ElysianGateway = {
      ...base,
      incidents: {
        listRows: async (query) => {
          calls += 1
          if (calls === 1) throw new Error('演示用的读取失败')
          return base.incidents.listRows(query)
        },
        find: (incidentId) => base.incidents.find(incidentId),
      },
    }

    renderApp('/', { gateway })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('演示用的读取失败')

    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByLabelText('事故总数指标卡')).toBeInTheDocument()
  })
})

describe('仪表盘模块拆分卡', () => {
  it('恰好 13 张，模块名用中文名且与词典顺序一致', async () => {
    await renderReady()

    const section = screen.getByLabelText('按职责模块拆分')
    const cards = within(section).getAllByRole('article')
    expect(cards).toHaveLength(13)
    expect(screen.getByText('13 个模块')).toBeInTheDocument()
    expect(
      cards.map((card) => within(card).getByRole('heading').textContent),
    ).toEqual(RESPONSIBILITY_MODULES.map((module) => module.name))
  })

  it('活跃模块卡显示未归档事故数、运行状态与待审批数', async () => {
    await renderReady()

    const section = screen.getByLabelText('按职责模块拆分')
    const card = within(section).getByRole('article', { name: '事故指挥模块卡' })

    // 朴素独立计算：未归档且归属该模块的事故数。
    const expectedActive = dataset.incidents.filter((incident) => {
      if (incident.status === 'resolved' || incident.status === 'closed') return false
      const run = dataset.runs.find((candidate) => candidate.id === incident.runId)
      return run?.moduleId === 'incident-command'
    }).length
    const expectedPending = dataset.approvals.filter(
      (approval) => approval.status === 'pending' && approval.requestedBy === 'incident-command',
    ).length

    expect(within(card).getByText(String(expectedActive))).toBeInTheDocument()
    expect(within(card).getByText(String(expectedPending))).toBeInTheDocument()
    expect(within(card).getByText('执行中')).toBeInTheDocument()
  })

  it('空闲模块显示空闲与零值', async () => {
    await renderReady()

    const section = screen.getByLabelText('按职责模块拆分')
    const card = within(section).getByRole('article', { name: '故障演练模块卡' })
    expect(within(card).getByText('空闲')).toBeInTheDocument()
    expect(within(card).getAllByText('0').length).toBeGreaterThan(0)
  })
})
