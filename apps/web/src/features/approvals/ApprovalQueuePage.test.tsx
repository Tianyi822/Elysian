import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockDataset } from '../../adapters/mock/dataset'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ApprovalAdapter, ElysianGateway } from '../../contracts/adapters'
import { useApprovalQueueStore } from '../../stores/approvalQueueStore'
import { renderApp } from '../../test/renderApp'
import { parseApprovalQuery, sortApprovals } from './query'

const dataset = createMockDataset()

beforeEach(() => {
  useApprovalQueueStore.setState({
    status: 'idle',
    approvals: [],
    errorMessage: undefined,
    actionError: undefined,
    lastDecisionNote: undefined,
    busyApprovalId: undefined,
  })
})

function createGateway() {
  return createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
}

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole('table', { name: '审批条目' })
  return within(table).getAllByRole('row').slice(1)
}

async function renderQueue(path = '/approvals', gateway?: ElysianGateway) {
  const view = renderApp(path, gateway ? { gateway } : {})
  await screen.findByRole('table', { name: '审批条目' })
  return view
}

describe('审批队列', () => {
  it('列出审批条目，四种队列状态都能在界面看到', async () => {
    await renderQueue()
    expect(screen.getAllByText('待审批').length).toBeGreaterThan(0)
    expect(screen.getAllByText('已批准').length).toBeGreaterThan(0)
    expect(screen.getAllByText('已拒绝').length).toBeGreaterThan(0)
    expect(screen.getAllByText('已过期').length).toBeGreaterThan(0)
  })

  it('默认按风险从高到低排序，最危险的排在最前', async () => {
    await renderQueue()
    const expected = sortApprovals(dataset.approvals, 'risk-desc')
    const first = expected[0]
    expect(first).toBeDefined()
    expect(within(bodyRows()[0] as HTMLElement).getByText(first?.actionTitle ?? '')).toBeInTheDocument()
    expect(within(bodyRows()[0] as HTMLElement).getByText('风险 致命')).toBeInTheDocument()
  })

  it('每条动作都标注待接入真实执行', async () => {
    await renderQueue()
    const rows = bodyRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row).toHaveTextContent('待接入真实执行')
    }
  })

  it('按队列状态筛选，并把筛选写进地址', async () => {
    const user = userEvent.setup()
    const { router } = await renderQueue()

    await user.click(screen.getByRole('checkbox', { name: '待审批' }))

    const expected = dataset.approvals.filter((approval) => approval.status === 'pending').length
    await waitFor(() => expect(bodyRows()).toHaveLength(expected))
    expect(router.state.location.search).toContain('status=pending')
  })

  it('批准后状态变化在界面上可见，并有操作反馈', async () => {
    const user = userEvent.setup()
    const target = dataset.approvals.find((approval) => approval.status === 'pending')
    expect(target).toBeDefined()

    await renderQueue(`/approvals?focus=${target?.id}`)
    const row = bodyRows()[0] as HTMLElement
    expect(within(row).getByText('待审批')).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: '批准' }))

    await waitFor(() => expect(within(row).getByText('已批准')).toBeInTheDocument())
    expect(within(row).getByText('一次性放行')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: '批准' })).not.toBeInTheDocument()
    expect(within(row).getByText('已处理')).toBeInTheDocument()

    const feedback = await screen.findByRole('status')
    expect(feedback).toHaveTextContent(`已批准：${target?.actionTitle}`)
    expect(feedback).toHaveTextContent('待接入真实执行')
  })

  it('拒绝后状态变化在界面上可见，并有操作反馈', async () => {
    const user = userEvent.setup()
    const target = dataset.approvals.find((approval) => approval.status === 'pending')
    expect(target).toBeDefined()

    await renderQueue(`/approvals?focus=${target?.id}`)
    const row = bodyRows()[0] as HTMLElement

    await user.click(within(row).getByRole('button', { name: '拒绝' }))

    // 队列状态与决策结果都是「已拒绝」，因此用 getAllByText
    await waitFor(() => expect(within(row).getAllByText('已拒绝').length).toBeGreaterThan(0))
    expect(within(row).queryByRole('button', { name: '拒绝' })).not.toBeInTheDocument()

    const feedback = await screen.findByRole('status')
    expect(feedback).toHaveTextContent(`已拒绝：${target?.actionTitle}`)
  })

  it('按待审批筛选时，处理完的条目离开列表但仍有反馈', async () => {
    const user = userEvent.setup()
    const target = dataset.approvals.find((approval) => approval.status === 'pending')
    expect(target).toBeDefined()

    await renderQueue(`/approvals?status=pending&focus=${target?.id}`)
    const before = bodyRows().length
    await user.click(within(bodyRows()[0] as HTMLElement).getByRole('button', { name: '批准' }))

    const feedback = await screen.findByRole('status')
    expect(feedback).toHaveTextContent(`已批准：${target?.actionTitle}`)
    // 处理完的条目不再满足「待审批」筛选，因此离开列表；反馈是它唯一的确认。
    await waitFor(() => expect(bodyRows()).toHaveLength(before - 1))
  })

  it('队列状态与决策结果是两层信息，分别呈现互不覆盖', async () => {
    // 数据集里已批准的条目：队列状态列显示「已批准」，决策结果列显示「一次性放行」。
    const decided = dataset.approvals.find(
      (approval) => approval.status === 'approved' && approval.outcome === 'allowed-once',
    )
    expect(decided).toBeDefined()

    await renderQueue(`/approvals?focus=${decided?.id}`)
    const row = bodyRows()[0] as HTMLElement
    expect(within(row).getByText('已批准')).toBeInTheDocument()
    expect(within(row).getByText('一次性放行')).toBeInTheDocument()
  })

  it('有决定说明的条目把说明也显示出来', async () => {
    const withNote = dataset.approvals.find((approval) => approval.note)
    expect(withNote).toBeDefined()

    await renderQueue(`/approvals?focus=${withNote?.id}`)
    const row = bodyRows()[0] as HTMLElement
    expect(within(row).getByText(`决定说明：${withNote?.note}`)).toBeInTheDocument()
  })

  it('审批决定会产生一条审计记录', async () => {
    const user = userEvent.setup()
    const gateway = createGateway()
    const target = (await gateway.approvals.list()).find(
      (approval) => approval.status === 'pending',
    )
    expect(target).toBeDefined()

    await renderQueue(`/approvals?status=pending&focus=${target?.id}`, gateway)
    await user.click(within(bodyRows()[0] as HTMLElement).getByRole('button', { name: '批准' }))

    await waitFor(async () => {
      const audit = await gateway.audit.list()
      const record = audit.find((item) => item.id === `${target?.id}-DECISION`)
      expect(record).toBeDefined()
      expect(record?.kind).toBe('approval')
      expect(record?.summary).toContain('已批准')
    })
  })

  it('从事故详情跳过来时把目标条目钉在最前并给出提示', async () => {
    const target = dataset.approvals[dataset.approvals.length - 1]
    expect(target).toBeDefined()

    await renderQueue(`/approvals?focus=${target?.id}`)

    expect(within(bodyRows()[0] as HTMLElement).getByText(target?.actionTitle ?? '')).toBeInTheDocument()
    expect(screen.getByText(/已定位到审批条目/)).toBeInTheDocument()
    // 定位参数不被解析成筛选条件
    expect(parseApprovalQuery(new URLSearchParams(`focus=${target?.id}`)).statuses).toEqual([])
  })

  it('操作失败时给出明确反馈，且不改变条目状态', async () => {
    const user = userEvent.setup()
    const base = createGateway()
    const target = dataset.approvals.find((approval) => approval.status === 'pending')
    expect(target).toBeDefined()

    const approvals: ApprovalAdapter = {
      list: () => base.approvals.list(),
      decide: async () => {
        throw new Error('演示用的审批失败')
      },
    }

    await renderQueue(`/approvals?status=pending&focus=${target?.id}`, {
      ...base,
      approvals,
    })
    await user.click(within(bodyRows()[0] as HTMLElement).getByRole('button', { name: '批准' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('审批操作失败：演示用的审批失败')
    expect(within(bodyRows()[0] as HTMLElement).getByText('待审批')).toBeInTheDocument()
  })

  it('筛选无结果时说明是筛选导致', async () => {
    renderApp('/approvals?risk=low&status=expired')
    expect(await screen.findByText('当前筛选条件下没有审批条目')).toBeInTheDocument()
  })
})
