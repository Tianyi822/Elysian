import { SEVERITIES } from '@elysian/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockDataset, toIncidentListRows } from '../../adapters/mock/dataset'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useOverviewStore, loadOverview } from '../../stores/overviewStore'
import { renderApp } from '../../test/renderApp'

const dataset = createMockDataset()

beforeEach(() => {
  // overviewStore 是模块级单例，逐条测试之间要清干净，避免旧数据掩盖失败路径。
  useOverviewStore.setState({
    status: 'idle',
    data: undefined,
    errorMessage: undefined,
    refreshing: false,
  })
})

/** 期望值直接由同一份适配层数据算出，避免把数据集细节抄进断言。 */
async function expectedOverview() {
  return loadOverview(createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' }))
}

describe('总览', () => {
  it('首屏就是总览，不显示宣传页', async () => {
    renderApp('/')
    expect(await screen.findByRole('heading', { level: 1, name: '总览' })).toBeInTheDocument()
    expect(screen.queryByText(/欢迎|立即开始|了解更多/)).not.toBeInTheDocument()
  })

  it('事故数量与严重等级分布只统计事故，与事件中心总数分开说明', async () => {
    // 期望值从数据集独立算出，不复用被测函数，避免断言与实现一起错。
    const incidents = dataset.incidents
    const totalRows = toIncidentListRows(dataset).length
    const counts = {
      sev1: incidents.filter((incident) => incident.severity === 'sev1').length,
      sev2: incidents.filter((incident) => incident.severity === 'sev2').length,
      sev3: incidents.filter((incident) => incident.severity === 'sev3').length,
      sev4: incidents.filter((incident) => incident.severity === 'sev4').length,
    }

    renderApp('/')
    await screen.findByRole('heading', { level: 2, name: '事故严重等级分布' })

    const labels: Record<string, string> = { sev1: '致命', sev2: '严重', sev3: '一般', sev4: '提示' }
    for (const severity of SEVERITIES) {
      const item = screen.getByRole('link', { name: `查看${labels[severity]}的条目` }).closest('li')
      expect(item).not.toBeNull()
      expect(within(item as HTMLElement).getByText(String(counts[severity]))).toBeInTheDocument()
    }

    expect(
      screen.getByText(
        new RegExp(`事故共 ${incidents.length} 条；事件中心共 ${totalRows} 条`),
      ),
    ).toBeInTheDocument()
    // 事故数必须小于事件中心总数，否则说明把告警与待处理任务也算成了事故
    expect(incidents.length).toBeLessThan(totalRows)
  })

  it('展示 Agent 运行与待审批动作的数量', async () => {
    const runningRuns = dataset.runs.filter((run) => run.status === 'running').length
    const waitingRuns = dataset.runs.filter((run) => run.status === 'waiting-approval').length
    const pendingApprovals = dataset.approvals.filter(
      (approval) => approval.status === 'pending',
    ).length

    renderApp('/')
    await screen.findByRole('heading', { level: 2, name: '事故严重等级分布' })

    expect(
      screen.getByText(
        new RegExp(`执行中 ${runningRuns} 次运行 · 等待审批 ${waitingRuns} 次运行`),
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`^${pendingApprovals} 条`))).toBeInTheDocument()
  })

  it('待审批动作给出最高风险等级，并下钻到对应筛选', async () => {
    const expected = await expectedOverview()
    expect(expected.highestPendingRisk).toBeDefined()

    renderApp('/')
    const link = await screen.findByRole('link', { name: '处理审批队列' })
    expect(link).toHaveAttribute(
      'href',
      `/approvals?status=pending&risk=${expected.highestPendingRisk}`,
    )
    expect(screen.getAllByText(/风险/).length).toBeGreaterThan(0)
  })

  it('服务健康摘要列出未归档事故与最高严重等级，正常的服务标为正常', async () => {
    const expected = await expectedOverview()
    renderApp('/')

    const table = await screen.findByRole('table', { name: '服务健康' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(expected.serviceHealth.length)

    const healthy = expected.serviceHealth.find((service) => service.worstSeverity === undefined)
    if (healthy) {
      const row = rows.find((candidate) => within(candidate).queryByText(healthy.service) !== null)
      expect(row).toBeDefined()
      expect(within(row as HTMLElement).getByText('正常')).toBeInTheDocument()
    }

    const unhealthy = expected.serviceHealth.find((service) => service.openCount > 0)
    expect(unhealthy).toBeDefined()
    const row = rows.find((candidate) => within(candidate).queryByText(unhealthy?.service ?? '') !== null)
    expect(row).toBeDefined()
    expect(within(row as HTMLElement).getByText(String(unhealthy?.openCount))).toBeInTheDocument()
  })

  it('最近活动按时间倒序展示最新几条，并可跳到审计日志', async () => {
    const expected = await expectedOverview()
    renderApp('/')

    await screen.findByRole('heading', { level: 2, name: '最近活动' })
    expect(screen.getAllByText(expected.recentActivity[0]?.summary ?? '').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: '打开审计日志' })).toHaveAttribute('href', '/audit')
  })

  it('手动刷新给出刷新中的可见反馈', async () => {
    const user = userEvent.setup()
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })

    // 只让刷新那次读取卡住，首屏加载照常完成，这样才能观察到「正在刷新…」。
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const gateway: ElysianGateway = {
      ...base,
      incidents: {
        listRows: async (query) => {
          calls += 1
          if (calls > 1) await gate
          return base.incidents.listRows(query)
        },
        find: (incidentId) => base.incidents.find(incidentId),
      },
    }

    renderApp('/', { gateway })
    await screen.findByRole('heading', { level: 2, name: '事故严重等级分布' })

    await user.click(screen.getByRole('button', { name: '刷新' }))

    expect(await screen.findByRole('status')).toHaveTextContent('正在刷新…')

    release?.()
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '刷新' })).not.toBeDisabled()
  })

  it('聚合读取失败时给出可重试的错误状态', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const gateway: ElysianGateway = {
      ...base,
      incidents: {
        listRows: async () => {
          throw new Error('演示用的聚合失败')
        },
        find: (incidentId) => base.incidents.find(incidentId),
      },
    }

    renderApp('/', { gateway })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('演示用的聚合失败')
    expect(within(alert).getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('数据集里确实存在未归档事故，服务健康摘要才有可看内容', () => {
    const open = dataset.incidents.filter(
      (incident) => incident.status !== 'resolved' && incident.status !== 'closed',
    )
    expect(open.length).toBeGreaterThan(0)
  })
})
