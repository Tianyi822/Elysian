import { APPROVAL_STATUS_LABELS } from '@elysian/contracts'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createMockDataset } from '../../adapters/mock/dataset'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway, IncidentAdapter } from '../../contracts/adapters'
import { renderApp } from '../../test/renderApp'

const dataset = createMockDataset()

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name })
  const element = heading.closest('section')
  if (!element) throw new Error(`找不到区块：${name}`)
  return element
}

function firstIncident(predicate: (incident: (typeof dataset.incidents)[number]) => boolean) {
  const found = dataset.incidents.find(predicate)
  if (!found) throw new Error('数据集里找不到满足条件的事故')
  return found
}

function gatewayFailingWith(message: string): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  // 显式实现接口：对类实例做对象展开会丢掉原型上的方法。
  return {
    ...base,
    incidents: {
      listRows: (query) => base.incidents.listRows(query),
      find: async () => {
        throw new Error(message)
      },
    },
  }
}

describe('事故详情', () => {
  it('把时间线、指标、证据与判断分区块呈现，证据与判断不混在一起', async () => {
    const incident = firstIncident(() => true)
    renderApp(`/incidents/${incident.id}`)

    expect(
      await screen.findByRole('heading', { level: 1, name: new RegExp(incident.id) }),
    ).toBeInTheDocument()

    for (const name of ['指标摘要', '时间线', '证据', '判断', '建议动作与审批状态', '执行结果']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument()
    }

    const firstTimelineEntry = incident.timeline[0]
    expect(firstTimelineEntry).toBeDefined()
    expect(within(section('时间线')).getByText(firstTimelineEntry?.summary ?? '')).toBeInTheDocument()

    const firstMetric = incident.metrics[0]
    expect(firstMetric).toBeDefined()
    expect(within(section('指标摘要')).getByText(firstMetric?.label ?? '')).toBeInTheDocument()

    const firstEvidence = incident.evidence[0]
    expect(firstEvidence).toBeDefined()
    expect(
      within(section('证据')).getByText(firstEvidence?.summary ?? ''),
    ).toBeInTheDocument()
    expect(
      within(section('证据')).getByText(firstEvidence?.sourceRef ?? ''),
    ).toBeInTheDocument()

    const firstFinding = incident.findings[0]
    expect(firstFinding).toBeDefined()
    expect(
      within(section('判断')).getByText(firstFinding?.statement ?? ''),
    ).toBeInTheDocument()
    // 判断不重复出现在证据区块，两者保持分离
    expect(
      within(section('证据')).queryByText(firstFinding?.statement ?? ''),
    ).not.toBeInTheDocument()
  })

  it('高风险动作显示明确审批状态，未获批的不显示为已执行', async () => {
    const incident = firstIncident((candidate) =>
      candidate.actions.some((action) => action.approvalId !== undefined),
    )
    const action = incident.actions.find((candidate) => candidate.approvalId)
    expect(action).toBeDefined()
    const approval = dataset.approvals.find((candidate) => candidate.id === action?.approvalId)
    expect(approval).toBeDefined()

    renderApp(`/incidents/${incident.id}`)
    await screen.findByRole('heading', { level: 1, name: new RegExp(incident.id) })

    const actions = section('建议动作与审批状态')
    expect(within(actions).getByText(action?.title ?? '')).toBeInTheDocument()
    expect(
      within(actions).getAllByText(APPROVAL_STATUS_LABELS[approval?.status ?? 'pending']).length,
    ).toBeGreaterThan(0)
    // 数据集里没有任何动作被呈现为已真实执行
    expect(within(actions).queryByText('执行成功')).not.toBeInTheDocument()
  })

  it('待决策的审批给出「未获批前不会执行」的说明', async () => {
    const incident = firstIncident((candidate) =>
      candidate.actions.some(
        (action) =>
          action.approvalId !== undefined &&
          dataset.approvals.find((approval) => approval.id === action.approvalId)?.status ===
            'pending',
      ),
    )
    renderApp(`/incidents/${incident.id}`)
    await screen.findByRole('heading', { level: 1, name: new RegExp(incident.id) })

    expect(
      within(section('建议动作与审批状态')).getAllByText('未获批前不会执行').length,
    ).toBeGreaterThan(0)
  })

  it('执行结果只登记到待接入真实执行', async () => {
    const incident = firstIncident((candidate) => candidate.executionResults.length > 0)
    renderApp(`/incidents/${incident.id}`)
    await screen.findByRole('heading', { level: 1, name: new RegExp(incident.id) })

    const results = section('执行结果')
    expect(within(results).getAllByText('待接入真实执行').length).toBeGreaterThan(0)
    expect(within(results).queryByText(/已执行成功|已回滚/)).not.toBeInTheDocument()
  })

  it('可以跳到对应的审批条目与 Agent 运行', async () => {
    const incident = firstIncident(
      (candidate) => candidate.runId !== undefined && candidate.actions.some((a) => a.approvalId),
    )
    const action = incident.actions.find((candidate) => candidate.approvalId)
    renderApp(`/incidents/${incident.id}`)
    await screen.findByRole('heading', { level: 1, name: new RegExp(incident.id) })

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'))
    expect(hrefs).toContain(`/runs?focus=${incident.runId}`)
    expect(hrefs).toContain(`/approvals?focus=${action?.approvalId}`)
  })

  it('执行结果是成功或回滚时按各自状态呈现，并标明所属动作', async () => {
    // 演示数据里不出现「已成功/已回滚」（红线：绝不呈现为已执行），
    // 但界面必须真的能呈现这两种结果，因此这里注入一份带两种结果的详情来验证渲染路径。
    const incident = firstIncident((candidate) => candidate.executionResults.length > 0)
    const action = incident.actions[0]
    expect(action).toBeDefined()
    if (!action) return

    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const withResults = {
      ...incident,
      executionResults: [
        {
          id: `${incident.id}-X-rollback`,
          actionId: action.id,
          at: '2026-09-12T08:30:00.000Z',
          status: 'rolled-back' as const,
          summary: '演示用的回滚结果',
        },
        {
          id: `${incident.id}-X-success`,
          actionId: action.id,
          at: '2026-09-12T08:31:00.000Z',
          status: 'succeeded' as const,
          summary: '演示用的成功结果',
        },
      ],
    }
    const incidents: IncidentAdapter = {
      listRows: (query) => base.incidents.listRows(query),
      find: async () => withResults,
    }

    renderApp(`/incidents/${incident.id}`, { gateway: { ...base, incidents } })
    await screen.findByRole('heading', { level: 1, name: new RegExp(incident.id) })

    const results = section('执行结果')
    expect(within(results).getByText('已回滚')).toBeInTheDocument()
    expect(within(results).getByText('执行成功')).toBeInTheDocument()
    expect(within(results).getAllByText(`所属动作 ${action.id}`).length).toBeGreaterThan(0)

    // 色调随状态走：成功用成功色，回滚用警告色，不是一律警告色。
    expect(within(results).getByText('执行成功').className).toContain('text-success')
    expect(within(results).getByText('已回滚').className).toContain('text-warning')
  })

  it('标识不存在时给出空状态而不是空白页', async () => {
    renderApp('/incidents/INC-9999')
    expect(await screen.findByText('没有这条事故')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回事件中心' })).toBeInTheDocument()
  })

  it('读取失败时给出可重试的错误状态', async () => {
    const user = userEvent.setup()
    renderApp('/incidents/INC-2100', { gateway: gatewayFailingWith('演示用的读取失败') })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('演示用的读取失败')

    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})
