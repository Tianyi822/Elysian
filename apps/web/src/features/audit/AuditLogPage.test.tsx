import type { EventStreamHandlers } from '@elysian/contracts'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockDataset } from '../../adapters/mock/dataset'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useAuditLogStore } from '../../stores/auditLogStore'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { matchesAuditQuery } from './query'
import { renderApp } from '../../test/renderApp'

const dataset = createMockDataset()
const newest = [...dataset.audit].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0]

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole('table', { name: '审计记录' })
  return within(table).getAllByRole('row').slice(1)
}

async function renderAudit(path = '/audit', gateway?: ElysianGateway) {
  const view = renderApp(path, gateway ? { gateway } : {})
  await screen.findByRole('table', { name: '审计记录' })
  return view
}

function gatewayWithControllableStream() {
  const handlersRef: { current: EventStreamHandlers | undefined } = { current: undefined }
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const gateway: ElysianGateway = {
    ...base,
    events: {
      subscribe(handlers) {
        handlersRef.current = handlers
        handlers.onStatus('live')
        return () => {
          handlersRef.current = undefined
        }
      },
    },
  }
  return { gateway, handlersRef }
}

beforeEach(() => {
  // eventStreamStore 与 auditLogStore 都是模块级单例，逐条测试之间要清干净。
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
  useAuditLogStore.setState({ status: 'idle', records: [], errorMessage: undefined })
})

describe('审计日志', () => {
  it('按时间倒序列出审计记录并给出总数', async () => {
    await renderAudit()
    expect(bodyRows()).toHaveLength(dataset.audit.length)
    expect(
      screen.getByText(`共 ${dataset.audit.length} / ${dataset.audit.length} 条`),
    ).toBeInTheDocument()
  })

  it('最新的记录排在最前', async () => {
    await renderAudit()
    expect(newest).toBeDefined()
    expect(within(bodyRows()[0] as HTMLElement).getByText(newest?.summary ?? '')).toBeInTheDocument()
  })

  it('按类型筛选，并把筛选写进地址', async () => {
    const user = userEvent.setup()
    const { router } = await renderAudit()

    await user.click(screen.getByRole('checkbox', { name: '工具调用' }))

    const expected = dataset.audit.filter((record) => record.kind === 'tool-call').length
    expect(expected).toBeGreaterThan(0)
    await waitFor(() => expect(bodyRows()).toHaveLength(expected))
    expect(router.state.location.search).toContain('kind=tool-call')
  })

  it('关键词搜索会收窄结果，命中未展示字段的记录也会保留', async () => {
    const user = userEvent.setup()
    await renderAudit()

    await user.type(screen.getByLabelText('搜索'), 'RUN-14')

    // 关键词可能在摘要、对象、详情或追踪标识里命中，这里用同一个判定函数算出期望条数。
    const expected = dataset.audit.filter((record) =>
      matchesAuditQuery(record, { kinds: [], q: 'RUN-14' }),
    )
    expect(expected.length).toBeGreaterThan(0)
    expect(expected.length).toBeLessThan(dataset.audit.length)
    await waitFor(() => expect(bodyRows()).toHaveLength(expected.length))

    // 反向断言：一条不该命中的记录，它的摘要（在数据集里唯一）不应出现在表里。
    const summaryCounts = new Map<string, number>()
    for (const record of dataset.audit) {
      summaryCounts.set(record.summary, (summaryCounts.get(record.summary) ?? 0) + 1)
    }
    const excluded = dataset.audit.find(
      (record) =>
        !matchesAuditQuery(record, { kinds: [], q: 'RUN-14' }) &&
        summaryCounts.get(record.summary) === 1,
    )
    expect(excluded).toBeDefined()
    expect(screen.queryByText(excluded?.summary ?? '')).not.toBeInTheDocument()
  })

  it('清除筛选后回到完整列表', async () => {
    const user = userEvent.setup()
    await renderAudit('/audit?kind=approval')

    await user.click(screen.getByRole('button', { name: '清除筛选' }))

    await waitFor(() => expect(bodyRows()).toHaveLength(dataset.audit.length))
  })

  it('可以查看单条记录的完整字段', async () => {
    const user = userEvent.setup()
    await renderAudit()

    await user.click(within(bodyRows()[0] as HTMLElement).getByRole('button', { name: '详情' }))

    const dialog = await screen.findByRole('dialog', { name: '审计记录详情' })
    expect(within(dialog).getByText('追踪标识')).toBeInTheDocument()
    expect(within(dialog).getByText(newest?.traceId ?? '')).toBeInTheDocument()
    expect(within(dialog).getByText(newest?.detail ?? '')).toBeInTheDocument()
  })

  it('事件流到达的新记录出现在最前并标记为实时', async () => {
    const { gateway, handlersRef } = gatewayWithControllableStream()
    await renderAudit('/audit', gateway)
    const before = bodyRows().length

    act(() => {
      handlersRef.current?.onEvent({
        id: 'evt-live-1',
        name: 'incident/updated',
        at: '2026-09-12T23:59:00.000Z',
        payload: { incidentId: 'INC-2100', status: 'mitigating' },
      })
    })

    await waitFor(() => expect(bodyRows()).toHaveLength(before + 1))
    const first = bodyRows()[0] as HTMLElement
    expect(within(first).getByText(/事故 INC-2100 状态更新/)).toBeInTheDocument()
    expect(within(first).getByText('实时')).toBeInTheDocument()
  })

  it('筛选无结果时说明是筛选导致，而不是没有记录', async () => {
    renderApp('/audit?q=不存在的关键词')
    expect(await screen.findByText('当前筛选条件下没有审计记录')).toBeInTheDocument()
    expect(screen.getByText(/筛选条件排除了全部条目/)).toBeInTheDocument()
  })

  it('读取失败时给出可重试的错误状态', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const gateway: ElysianGateway = {
      ...base,
      audit: {
        list: async () => {
          throw new Error('演示用的读取失败')
        },
      },
    }

    renderApp('/audit', { gateway })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('演示用的读取失败')
    expect(within(alert).getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})
