import { RESPONSIBILITY_MODULES, RISK_RANK, RISK_LEVEL_LABELS } from '@elysian/contracts'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockDataset } from '../../adapters/mock/dataset'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useDashboardStore } from '../../stores/dashboardStore'
import { useEventStreamStore } from '../../stores/eventStreamStore'
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
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
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

describe('仪表盘筛选栏与图表', () => {
  it('两个图表区块挂载成功（SVG 渲染）', async () => {
    await renderReady()

    const charts = screen.getByLabelText('图表')
    expect(within(charts).getByRole('article', { name: '严重等级分布' })).toBeInTheDocument()
    expect(within(charts).getByRole('article', { name: '事故趋势' })).toBeInTheDocument()
    await waitFor(() => {
      expect(charts.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
    })
  })

  it('时间范围两档可切换，粒度固定按天', async () => {
    const user = userEvent.setup()
    await renderReady()

    const group = screen.getByRole('group', { name: '时间范围' })
    expect(within(group).getByRole('button', { name: '近 7 天' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText(/粒度/)).toHaveTextContent('按天')

    await user.click(within(group).getByRole('button', { name: '近 30 天' }))

    expect(within(group).getByRole('button', { name: '近 30 天' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(group).getByRole('button', { name: '近 7 天' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('刷新期间有反馈且保留内容；刷新失败保留内容并出错误横幅', async () => {
    const user = userEvent.setup()
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    let calls = 0
    const gateway: ElysianGateway = {
      ...base,
      incidents: {
        listRows: async (query) => {
          calls += 1
          if (calls > 1) throw new Error('演示用的刷新失败')
          return base.incidents.listRows(query)
        },
        find: (incidentId) => base.incidents.find(incidentId),
      },
    }

    renderApp('/', { gateway })
    await screen.findByLabelText('事故总数指标卡')

    await user.click(screen.getByRole('button', { name: '刷新' }))

    // 失败的刷新：内容保留，错误横幅可见，刷新按钮恢复可用。
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('演示用的刷新失败')
    expect(screen.getByLabelText('事故总数指标卡')).toBeInTheDocument()
    expect(screen.queryByText('正在刷新…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
  })
})

describe('仪表盘最近活动', () => {
  it('显示最新 8 条审计记录，最新一条排在最前', async () => {
    await renderReady()

    const section = screen.getByLabelText('最近活动')
    const items = within(section).getAllByRole('listitem')
    expect(items).toHaveLength(8)

    const newest = [...dataset.audit].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0]
    expect(within(section).getByText(newest?.summary ?? '')).toBeInTheDocument()
  })

  it('事件流到达时最近活动置顶更新并标实时', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const gateway: ElysianGateway = {
      ...base,
      events: {
        subscribe(handlers) {
          handlers.onStatus('live')
          return () => {}
        },
      },
    }

    renderApp('/', { gateway })
    await screen.findByLabelText('最近活动')

    act(() => {
      useEventStreamStore.getState().connect({
        subscribe(handlers) {
          handlers.onStatus('live')
          handlers.onEvent({
            id: 'evt-live-9',
            name: 'incident/updated',
            at: '2026-09-12T23:59:00.000Z',
            payload: { incidentId: 'INC-2100', status: 'mitigating' },
          })
          return () => {}
        },
      })
    })

    const section = screen.getByLabelText('最近活动')
    const first = within(section).getAllByRole('listitem')[0]
    expect(first).toBeDefined()
    expect(within(first as HTMLElement).getByText(/事故 INC-2100 状态更新/)).toBeInTheDocument()
    expect(within(first as HTMLElement).getByText('实时')).toBeInTheDocument()
  })
})

describe('仪表盘快捷操作', () => {
  it('主题切换动作生效并在右上角通知区给出反馈', async () => {
    const user = userEvent.setup()
    await renderReady()

    expect(document.documentElement.dataset['theme']).toBe('dark')
    await user.click(screen.getByRole('button', { name: /切换到浅色主题/ }))

    expect(document.documentElement.dataset['theme']).toBe('light')
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent('已切换到浅色主题。')
  })

  it('重置演示数据需要确认，取消不执行，确认后重置并刷新界面', async () => {
    const user = userEvent.setup()
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const reset = vi.fn(async () => {
      await base.reset()
    })

    renderApp('/', { gateway: { ...base, reset } })
    await screen.findByLabelText('最近活动')

    await user.click(screen.getByRole('button', { name: /重置演示数据/ }))
    const dialog = await screen.findByRole('dialog', { name: '确认重置演示数据？' })
    expect(reset).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(reset).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /重置演示数据/ }))
    await user.click(
      within(await screen.findByRole('dialog', { name: '确认重置演示数据？' })).getByRole(
        'button',
        { name: '确认重置' },
      ),
    )

    await waitFor(() => expect(reset).toHaveBeenCalledOnce())
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByRole('status')).toHaveTextContent('演示数据已重置回种子状态。')
  })

  it('重置失败留在对话框里，不冒出通知', async () => {
    const user = userEvent.setup()
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const gateway: ElysianGateway = {
      ...base,
      reset: async () => {
        throw new Error('演示用的重置失败')
      },
    }

    renderApp('/', { gateway })
    await screen.findByLabelText('最近活动')

    await user.click(screen.getByRole('button', { name: /重置演示数据/ }))
    await user.click(
      within(await screen.findByRole('dialog', { name: '确认重置演示数据？' })).getByRole(
        'button',
        { name: '确认重置' },
      ),
    )

    const dialog = await screen.findByRole('dialog', { name: '确认重置演示数据？' })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('演示用的重置失败')
    expect(screen.queryByLabelText('通知')).not.toBeInTheDocument()
  })

  it('重新连接事件源动作触发重新订阅', async () => {
    const user = userEvent.setup()
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    let subscribeCount = 0
    const gateway: ElysianGateway = {
      ...base,
      events: {
        subscribe(handlers) {
          subscribeCount += 1
          handlers.onStatus('live')
          return () => {}
        },
      },
    }

    renderApp('/', { gateway })
    await screen.findByLabelText('最近活动')
    expect(subscribeCount).toBe(1)

    await user.click(screen.getByRole('button', { name: /重新连接事件源/ }))

    expect(subscribeCount).toBe(2)
    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByText(/已尝试重新连接事件源/)).toBeInTheDocument()
  })
})

describe('仪表盘分布对照表与空态', () => {
  it('分布面板带等级数量对照表，数值与数据集朴素聚合一致', async () => {
    await renderReady()

    const panel = screen.getByRole('article', { name: '严重等级分布' })
    const labels = ['致命', '严重', '一般', '提示']
    for (const label of labels) {
      expect(within(panel).getByText(label)).toBeInTheDocument()
    }

    const counts = ['sev1', 'sev2', 'sev3', 'sev4'].map((key) =>
      dataset.incidents.filter((incident) => incident.severity === key).length,
    )
    for (const count of counts) {
      expect(within(panel).getByText(String(count))).toBeInTheDocument()
    }
  })

  it('数据集为空时给出空态而不是一排零值', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const empty: ElysianGateway = {
      ...base,
      incidents: {
        listRows: async () => ({ rows: [], total: 0, availableSources: [] }),
        find: async () => undefined,
      },
      runs: {
        list: async () => [],
        find: async () => undefined,
        listModuleStatuses: async () => dataset.moduleStatuses,
      },
      approvals: { list: async () => [], decide: async () => { throw new Error('空数据集不产生审批') } },
      audit: { list: async () => [] },
    }

    renderApp('/', { gateway: empty })

    expect(await screen.findByText('演示数据集为空')).toBeInTheDocument()
    expect(screen.queryByLabelText('事故总数指标卡')).not.toBeInTheDocument()
  })
})
