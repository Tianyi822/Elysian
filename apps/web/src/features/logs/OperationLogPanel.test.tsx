import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  LOG_ENTRY_FETCH_LIMIT,
  OPERATION_LOG_CATEGORY_LABELS,
  OPERATION_LOG_OUTCOME_LABELS,
  formatLogBytes,
  logNumericSortKey,
  logRetentionText,
  type OperationLogListQuery,
} from '@elysian/contracts'
import type { OperationLogEntry } from '@elysian/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { SEED_OPERATION_LOGS } from '../../adapters/mock/logsData'
import type { ElysianGateway } from '../../contracts/adapters'
import { useLogsStore } from '../../stores/logsStore'
import { useOperationLogStore } from '../../stores/operationLogStore'
import { renderApp } from '../../test/renderApp'
import {
  OPERATION_LOG_TABLE_MIN_PX,
  OPERATION_LOG_TABLE_MIN_WIDTH_CLASS,
} from './OperationLogPanel'

/**
 * 操作日志面板：五列固定宽表格、分类/结果/搜索三重筛选、三态与两种空状态、
 * 长文本单元格的悬浮窗。条目来自 adapter（本用例走 mock 种子），界面只做视图筛选。
 */

const INITIAL_STATE = {
  status: 'idle' as const,
  errorMessage: undefined,
  entries: [],
  total: 0,
  truncated: false,
  skippedLines: 0,
  skippedFiles: 0,
  storage: undefined,
  categoryFilter: 'all' as const,
  resultFilter: 'all' as const,
  search: '',
  refreshing: false,
  loadingOlder: false,
  olderError: undefined,
  clearing: false,
  clearTarget: null,
}

beforeEach(() => {
  useOperationLogStore.setState(INITIAL_STATE)
  useLogsStore.setState({ tab: 'operation' })
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 只替换 logs 这一个接缝，其余片保持默认实现。
 * 逐方法转发而不是展开 `base.logs`：mock adapter 是类实例，展开只复制自有属性，
 * 原型上的方法会整份丢掉。
 */
function gatewayWithLogs(overrides: Partial<ElysianGateway['logs']>): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  return {
    ...base,
    logs: {
      runtimeLog: overrides.runtimeLog ?? ((query) => base.logs.runtimeLog(query)),
      loginLogs: overrides.loginLogs ?? ((query) => base.logs.loginLogs(query)),
      operationLogs: overrides.operationLogs ?? ((query) => base.logs.operationLogs(query)),
      clearLogs: overrides.clearLogs ?? ((category) => base.logs.clearLogs(category)),
    },
  }
}

/** 空报告：与契约同形（截断与坏行计数为 0，存储统计齐全）。 */
function emptyReport() {
  return {
    entries: [] as readonly OperationLogEntry[],
    total: 0,
    truncated: false,
    skippedLines: 0,
    skippedFiles: 0,
    storage: {
      totalBytes: 0,
      runtimeBytes: 0,
      operationBytes: 0,
      runtimeRowCount: 0,
      operationRowCount: 0,
      rowCount: 0,
      oldestAt: null,
      lastSweepAt: null,
      trimmedBySize: false,
      droppedRecords: 0,
      failedWrites: 0,
    },
  }
}

/** 报告：以空报告为底，只覆盖本用例关心的字段。 */
function reportWith(
  entries: readonly OperationLogEntry[],
  overrides: Partial<ReturnType<typeof emptyReport>> = {},
) {
  return {
    ...emptyReport(),
    entries,
    total: entries.length,
    storage: {
      ...emptyReport().storage,
      totalBytes: 13_713,
      rowCount: entries.length,
      ...(overrides.storage ?? {}),
    },
    ...overrides,
  }
}

/** 种子条目的一条长文本变体：动作与摘要都远超单元格宽度，用于验证省略与展开。 */
const LONG_ENTRY: OperationLogEntry = {
  id: '2026-09-23T04:00:00.000Z#99',
  at: '2026-09-23T04:00:00.000Z',
  category: 'files',
  action: '批量修改目录权限（递归）并同步访问控制列表到全部子项，路径很长的场景下这一格必定被省略',
  target: '账号 deploy-operator',
  summary: 'deploy.sh 755 root（递归）——参数摘要同样写得很长，长到一屏放不下',
  result: 'failure',
  method: 'POST',
  path: '/api/files/chmod',
  httpStatus: 400,
}

/** 表格里的数据行（第 0 行是表头）。 */
function dataRows(): HTMLElement[] {
  const region = screen.getByRole('region', { name: '操作日志表' })
  return within(region)
    .getAllByRole('row')
    .filter((row) => within(row).queryAllByRole('columnheader').length === 0)
}

describe('平台操作日志面板', () => {
  it('渲染五列表格，列头、条目与日志大小都来自 adapter', async () => {
    const gateway = gatewayWithLogs({})
    const report = await gateway.logs.operationLogs()
    renderApp('/logs', { gateway })

    // 表头给全，表格本身为可滚动区域（窄屏整表横向滚动）。
    const region = await screen.findByRole('region', { name: '操作日志表' })
    for (const label of ['日期时间', '分类', '操作对象', '操作内容', '结果']) {
      expect(within(region).getByRole('columnheader', { name: label })).toBeInTheDocument()
    }

    const rows = dataRows()
    expect(rows).toHaveLength(SEED_OPERATION_LOGS.length)

    // 首行：时间是本地格式，分类与结果走契约标签表。
    const first = SEED_OPERATION_LOGS[0]!
    expect(rows[0]).toHaveTextContent(first.action)
    expect(rows[0]).toHaveTextContent(OPERATION_LOG_CATEGORY_LABELS[first.category])
    expect(rows[0]).toHaveTextContent(OPERATION_LOG_OUTCOME_LABELS[first.result])
    expect(rows[0]).toHaveTextContent(first.summary)

    expect(screen.getByText(formatLogBytes(report.storage.totalBytes))).toBeInTheDocument()
    // 测试跑在宿主机演示态（非 Docker）：条目是内存演示，工具栏明示「演示数据」。
    expect(screen.getByText('演示数据').closest('[role="status"]')).not.toBeNull()
  })

  it('工具栏只放控件：两个筛选下拉成一组，保留口径与计数分行', async () => {
    renderApp('/logs', { gateway: gatewayWithLogs({}) })
    await screen.findByRole('region', { name: '操作日志表' })

    const filterGroup = screen.getByRole('group', { name: '操作日志筛选' })
    // 这一组里只有两个下拉，chip 平铺时代的「两组全部并排」不再出现。
    expect(within(filterGroup).getAllByRole('button')).toHaveLength(2)
    // 触发器自带字段名前缀，不点开也看得出各自在筛什么。
    expect(within(filterGroup).getByRole('button', { name: /^操作分类筛选/ })).toHaveTextContent('分类')
    expect(within(filterGroup).getByRole('button', { name: /^操作结果筛选/ })).toHaveTextContent('结果')

    // 保留口径是事实说明、不是控件，与计数分处两块（同块时窄屏会一起被挤进一行）。
    const retention = screen.getByText(logRetentionText('operation'))
    expect(within(filterGroup).queryByText(logRetentionText('operation'))).not.toBeInTheDocument()
    expect(retention.parentElement).not.toBe(screen.getByText(/条操作记录/).parentElement)
  })

  it('列宽固定且表格最小宽度等于五列之和（窄屏整表横向滚动，不压缩列）', async () => {
    renderApp('/logs', { gateway: gatewayWithLogs({}) })

    const region = await screen.findByRole('region', { name: '操作日志表' })
    expect(within(region).getAllByRole('columnheader')).toHaveLength(5)
    expect(within(region).getByRole('table')).toHaveClass(OPERATION_LOG_TABLE_MIN_WIDTH_CLASS)
    // 类名与算式同一处口径：改列宽时两处必须一起改，写死数字或漏改都会被这条拦下。
    expect(OPERATION_LOG_TABLE_MIN_WIDTH_CLASS).toContain(`[${OPERATION_LOG_TABLE_MIN_PX}px]`)
  })

  it('按分类筛选：下拉选某一类时其余类别消失，选回「全部」恢复', async () => {
    const user = userEvent.setup()
    renderApp('/logs', { gateway: gatewayWithLogs({}) })
    await screen.findByRole('region', { name: '操作日志表' })

    const terminals = SEED_OPERATION_LOGS.filter((entry) => entry.category === 'terminals')
    expect(terminals.length).toBeGreaterThan(0)

    const trigger = screen.getByRole('button', { name: '操作分类筛选：全部' })
    await user.click(trigger)
    await user.click(
      await screen.findByRole('menuitemradio', {
        name: OPERATION_LOG_CATEGORY_LABELS.terminals,
      }),
    )

    await waitFor(() => expect(dataRows()).toHaveLength(terminals.length))
    expect(dataRows()[0]).toHaveTextContent(terminals[0]!.action)
    // 筛选生效要在触发器上看得见：当前值回到可访问名，accent 态标出「这里筛过了」。
    expect(trigger).toHaveAccessibleName(`操作分类筛选：${OPERATION_LOG_CATEGORY_LABELS.terminals}`)
    expect(trigger).toHaveClass('border-accent/50', 'bg-accent/10', 'text-accent-fg')

    await user.click(trigger)
    await user.click(await screen.findByRole('menuitemradio', { name: '全部' }))
    await waitFor(() => expect(dataRows()).toHaveLength(SEED_OPERATION_LOGS.length))
    expect(trigger).not.toHaveClass('bg-accent/10')
  })

  it('按结果筛选：失败条目只剩结果标签为「失败」的行', async () => {
    const user = userEvent.setup()
    renderApp('/logs', { gateway: gatewayWithLogs({}) })
    await screen.findByRole('region', { name: '操作日志表' })

    const failures = SEED_OPERATION_LOGS.filter((entry) => entry.result === 'failure')
    expect(failures.length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '操作结果筛选：全部' }))
    await user.click(
      await screen.findByRole('menuitemradio', { name: OPERATION_LOG_OUTCOME_LABELS.failure }),
    )

    await waitFor(() => expect(dataRows()).toHaveLength(failures.length))
    for (const row of dataRows()) {
      expect(row).toHaveTextContent(OPERATION_LOG_OUTCOME_LABELS.failure)
    }
  })

  it('关键字搜索匹配动作、摘要与对象，大小写不敏感', async () => {
    const user = userEvent.setup()
    renderApp('/logs', { gateway: gatewayWithLogs({}) })
    await screen.findByRole('region', { name: '操作日志表' })

    const search = screen.getByLabelText('搜索操作日志')

    // 命中 target（「账号 wangwu」）
    await user.type(search, 'WANGWU')
    await waitFor(() => expect(dataRows()[0]).toHaveTextContent('修改系统账号'))
    expect(dataRows()).toHaveLength(1)

    // 命中 action 与 summary（「修改 SSH 监听端口」的摘要「端口 2222」）
    await user.clear(search)
    await user.type(search, '2222')
    await waitFor(() => expect(dataRows()[0]).toHaveTextContent('修改 SSH 监听端口'))
    expect(dataRows()).toHaveLength(1)

    // 没命中：表格内给提示行，而不是整页空状态（数据本来就有，只是筛掉了）。
    await user.clear(search)
    await user.type(search, '不存在的关键字')
    await waitFor(() =>
      expect(screen.getByText('没有匹配的操作记录，换个关键词或清空筛选')).toBeInTheDocument(),
    )
  })

  it('没有任何记录时给空状态与说明', async () => {
    renderApp('/logs', { gateway: gatewayWithLogs({ operationLogs: async () => emptyReport() }) })

    expect(await screen.findByText('还没有操作日志')).toBeInTheDocument()
    expect(
      screen.getByText('通过面板按钮改动系统或数据库的动作都会记录在这里。'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '操作日志表' })).not.toBeInTheDocument()
  })

  it('筛选「数据库」没有命中时解释这个空槽位', async () => {
    const user = userEvent.setup()
    renderApp('/logs', { gateway: gatewayWithLogs({}) })
    await screen.findByRole('region', { name: '操作日志表' })

    await user.click(screen.getByRole('button', { name: '操作分类筛选：全部' }))
    await user.click(
      await screen.findByRole('menuitemradio', {
        name: OPERATION_LOG_CATEGORY_LABELS.database,
      }),
    )

    await waitFor(() =>
      expect(
        screen.getByText('还没有数据库类操作记录；通过面板按钮改动数据库的动作会记录在这里。'),
      ).toBeInTheDocument(),
    )
  })

  it('加载失败时给出错误态，重试成功后条目出现', async () => {
    let calls = 0
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const gateway: ElysianGateway = {
      ...base,
      logs: {
        ...base.logs,
        operationLogs: () => {
          calls += 1
          if (calls === 1) throw new Error('演示用的读取失败')
          return base.logs.operationLogs()
        },
      },
    }
    const user = userEvent.setup()
    renderApp('/logs', { gateway })

    expect(await screen.findByRole('alert')).toHaveTextContent('演示用的读取失败')
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('region', { name: '操作日志表' })).toBeInTheDocument()
  })

  it('截断、坏行与审计写入失败都在列表上方如实标注', async () => {
    renderApp('/logs', {
      gateway: gatewayWithLogs({
        operationLogs: async () =>
          reportWith(SEED_OPERATION_LOGS, {
            truncated: true,
            skippedLines: 2,
            skippedFiles: 1,
            storage: {
              ...emptyReport().storage,
              trimmedBySize: true,
              failedWrites: 3,
            },
          }),
      }),
    })

    expect(await screen.findByText(`仅显示最近 ${LOG_ENTRY_FETCH_LIMIT} 条`)).toBeInTheDocument()
    expect(screen.getAllByText(/行无法解析，已跳过/).some(element => element.textContent?.includes('2'))).toBe(true)
    expect(screen.getAllByText(/个日志文件读取失败，已跳过/).some(element => element.textContent?.includes('1'))).toBe(true)
    expect(screen.getByText('日志已超出量上限，较早的记录被自动清理')).toBeInTheDocument()
    expect(screen.getByText(/条操作未能写入审计日志/)).toHaveTextContent('3')
  })

  it('长文本单元格省略显示，展开后完整呈现动作、摘要与请求结果', async () => {
    const user = userEvent.setup()
    renderApp('/logs', {
      gateway: gatewayWithLogs({ operationLogs: async () => reportWith([LONG_ENTRY]) }),
    })

    await screen.findByRole('region', { name: '操作日志表' })
    const row = dataRows()[0]!
    // 单元格文本省略（truncate），图标常驻 DOM 因此键盘与读屏都能找到它。
    const cellText = within(row).getByText(new RegExp(LONG_ENTRY.action.slice(0, 12)))
    expect(cellText).toHaveClass('truncate')

    const trigger = within(row).getByRole('button', { name: '查看完整内容' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)
    const popover = await screen.findByLabelText('完整日志内容')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(popover).toHaveTextContent(LONG_ENTRY.action)
    expect(popover).toHaveTextContent(LONG_ENTRY.summary)
    expect(popover).toHaveTextContent('POST')
    expect(popover).toHaveTextContent('/api/files/chmod')
    expect(popover).toHaveTextContent(OPERATION_LOG_OUTCOME_LABELS.failure)
    expect(popover).toHaveTextContent('400')
  })

  it('改分类会带 category 重新请求，条数用 total', async () => {
    const calls: OperationLogListQuery[] = []
    const gateway = gatewayWithLogs({
      operationLogs: async (query) => {
        calls.push(query ?? {})
        return reportWith(SEED_OPERATION_LOGS, { total: 40, truncated: true })
      },
    })
    const user = userEvent.setup()
    renderApp('/logs', { gateway })
    await screen.findByRole('region', { name: '操作日志表' })
    await user.click(screen.getByRole('button', { name: '操作分类筛选：全部' }))
    await user.click(await screen.findByRole('menuitemradio', { name: OPERATION_LOG_CATEGORY_LABELS.security }))
    await waitFor(() => expect(calls.at(-1)?.category).toBe('security'))
    expect(screen.getByText(/共/)).toHaveTextContent('40')
    expect(screen.getByRole('button', { name: '加载更早的记录' })).toBeInTheDocument()
    expect(screen.getByText('还有更早的记录')).toBeInTheDocument()
  })

  it('搜索防抖 300 毫秒后请求带 trim 后的 q', async () => {
    const calls: OperationLogListQuery[] = []
    const gateway = gatewayWithLogs({
      operationLogs: async (query) => {
        calls.push(query ?? {})
        return reportWith(SEED_OPERATION_LOGS)
      },
    })
    renderApp('/logs', { gateway })
    await screen.findByRole('region', { name: '操作日志表' })
    const initialCalls = calls.length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    act(() => {
      useOperationLogStore.getState().setSearch('  端口  ')
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(calls.length).toBeGreaterThan(initialCalls)
    expect(calls.at(-1)?.q).toBe('端口')
  })

  it('加载更早：第二次请求带末行 before/beforeId，行数为两页之和', async () => {
    const page1 = SEED_OPERATION_LOGS.slice(0, 3)
    const page2 = SEED_OPERATION_LOGS.slice(3, 6)
    const calls: OperationLogListQuery[] = []
    const gateway = gatewayWithLogs({
      operationLogs: async (query) => {
        calls.push(query ?? {})
        if (query?.before) {
          return reportWith(page2, { total: 6, truncated: false })
        }
        return reportWith(page1, { total: 6, truncated: true })
      },
    })
    const user = userEvent.setup()
    renderApp('/logs', { gateway })
    await screen.findByRole('region', { name: '操作日志表' })
    expect(dataRows()).toHaveLength(3)
    await user.click(screen.getByRole('button', { name: '加载更早的记录' }))
    await waitFor(() => expect(dataRows()).toHaveLength(6))
    const last = page1[page1.length - 1]!
    expect(calls.at(-1)).toMatchObject({
      before: last.at,
      beforeId: logNumericSortKey(last.id),
    })
  })

  it('加载更早失败时保留第一页并提示', async () => {
    const page1 = SEED_OPERATION_LOGS.slice(0, 3)
    let calls = 0
    const gateway = gatewayWithLogs({
      operationLogs: async (query) => {
        calls += 1
        if (query?.before) throw new Error('更早页不可用')
        return reportWith(page1, { total: 6, truncated: true })
      },
    })
    const user = userEvent.setup()
    renderApp('/logs', { gateway })
    await screen.findByRole('region', { name: '操作日志表' })
    await user.click(screen.getByRole('button', { name: '加载更早的记录' }))
    await waitFor(() => expect(screen.getByText('更早的记录加载失败')).toBeInTheDocument())
    expect(dataRows()).toHaveLength(3)
    expect(calls).toBe(2)
  })

  it('无筛选且 total 为 0 时整页空状态', async () => {
    renderApp('/logs', {
      gateway: gatewayWithLogs({ operationLogs: async () => reportWith([], { total: 0 }) }),
    })
    expect(await screen.findByText('还没有操作日志')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '操作日志表' })).not.toBeInTheDocument()
  })

  it('数据库分类且 total 为 0 时保留工具栏并解释空槽', async () => {
    const calls: OperationLogListQuery[] = []
    const gateway = gatewayWithLogs({
      operationLogs: async (query) => {
        calls.push(query ?? {})
        if (query?.category === 'database') {
          return reportWith([], { total: 0, storage: { ...emptyReport().storage, totalBytes: 13_713 } })
        }
        return reportWith(SEED_OPERATION_LOGS)
      },
    })
    const user = userEvent.setup()
    renderApp('/logs', { gateway })
    await screen.findByRole('region', { name: '操作日志表' })
    await user.click(screen.getByRole('button', { name: '操作分类筛选：全部' }))
    await user.click(
      await screen.findByRole('menuitemradio', { name: OPERATION_LOG_CATEGORY_LABELS.database }),
    )
    await waitFor(() => expect(calls.at(-1)?.category).toBe('database'))
    expect(
      screen.getByText('还没有数据库类操作记录；通过面板按钮改动数据库的动作会记录在这里。'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^操作分类筛选/ })).toBeInTheDocument()
  })
})
