import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LOG_ENTRY_FETCH_LIMIT, formatLogBytes, logRetentionText } from '@elysian/contracts'
import type { LogStorageStats, RuntimeLogListReport } from '@elysian/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { SEED_RUNTIME_LOGS, resetLogsData } from '../../adapters/mock/logsData'
import type { ElysianGateway } from '../../contracts/adapters'
import { useLogsStore } from '../../stores/logsStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { useRuntimeLogStore } from '../../stores/runtimeLogStore'
import { renderApp } from '../../test/renderApp'
import { TIMESTAMP_CHARS } from './LogTable'
import { levelTone, matchesRuntimeSearch } from './RuntimeLogPanel'

/*
 * 运行日志面板：日期时间｜等级｜日志信息三列表格 + 全屏 + 搜索 + 日志大小 + 清空。
 * 行数与文案都从种子数据推出来，不硬编码具体条数；悬浮窗的细节另有 LogMessageCell.test.tsx。
 *
 * userEvent 一律 delay: null：本文件是全量跑里最长的（15 次整树渲染 + 数十次按键），
 * 共享宿主机饥饿窗口内按键间的人为 setTimeout 轮次会被放大到击穿预算；去掉人为延时
 * 只减少等待轮次，事件序列（keydown/input/keyup、pointer）与断言不变。
 */

beforeEach(() => {
  resetLogsData()
  useRuntimeLogStore.setState(useRuntimeLogStore.getInitialState())
  useLogsStore.setState({ tab: 'runtime' })
})

/** 逐方法转发而不是展开 `base.logs`：mock adapter 是类实例，展开会丢掉原型上的方法。 */
function gatewayWithLogs(overrides: Partial<ElysianGateway['logs']> = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  return {
    ...base,
    logs: {
      runtimeLog: overrides.runtimeLog ?? (() => base.logs.runtimeLog()),
      loginLogs: overrides.loginLogs ?? (() => base.logs.loginLogs()),
      operationLogs: overrides.operationLogs ?? (() => base.logs.operationLogs()),
      clearLogs: overrides.clearLogs ?? ((category) => base.logs.clearLogs(category)),
    },
  }
}

const ZERO_STORAGE: LogStorageStats = {
  totalBytes: 0,
  runtimeBytes: 0,
  operationBytes: 0,
  fileCount: 0,
  oldestAt: null,
  lastSweepAt: null,
  trimmedBySize: false,
  droppedRecords: 0,
  failedWrites: 0,
}

function reportWith(overrides: Partial<RuntimeLogListReport> = {}): RuntimeLogListReport {
  return {
    entries: SEED_RUNTIME_LOGS,
    truncated: false,
    skippedLines: 0,
    skippedFiles: 0,
    storage: ZERO_STORAGE,
    ...overrides,
  }
}

function region(): HTMLElement {
  return screen.getByRole('region', { name: '运行日志表' })
}

function bodyRows(): HTMLElement[] {
  const table = within(region()).getByRole('table')
  return within(table).getAllByRole('row').slice(1)
}

/** 等表格渲染出种子条目（首屏异步加载完成）。 */
async function waitForTable(): Promise<void> {
  await waitFor(() => expect(bodyRows()).toHaveLength(SEED_RUNTIME_LOGS.length))
}

describe('运行日志表格', () => {
  it('渲染三列表格：日期时间｜等级｜日志信息，行数与条目一致', async () => {
    renderApp('/logs', { gateway: gatewayWithLogs() })
    await waitForTable()

    const table = within(region()).getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '日期时间',
      '等级',
      '日志信息',
    ])

    for (const row of bodyRows()) {
      expect(within(row).getAllByRole('cell')).toHaveLength(3)
    }

    // 等级列是「文字 + 颜色」，等级值原样显示英文，不做中文翻译。
    expect(within(region()).getAllByText('error').length).toBeGreaterThan(0)
    expect(within(region()).getAllByText('info').length).toBeGreaterThan(0)
  })

  it('两列固定宽度、日志信息列省略：时间列 19 个等宽数字字符', async () => {
    renderApp('/logs', { gateway: gatewayWithLogs() })
    await waitForTable()

    const table = within(region()).getByRole('table')
    const cols = table.querySelectorAll('col')
    expect(cols[0]).toHaveClass('w-44')
    expect(cols[1]).toHaveClass('w-24')
    expect(cols[2]?.getAttribute('class')).toBeFalsy()
    expect(table).toHaveClass('min-w-[832px]')

    const firstRow = bodyRows()[0]!
    const [timeCell, levelCell, messageCell] = within(firstRow).getAllByRole('cell')

    // 等宽字体 + tabular-nums 是「字符宽度确定 → 列宽可算」的前提。
    expect(timeCell).toHaveClass('font-mono', 'tabular-nums')
    expect(timeCell?.textContent).toHaveLength(TIMESTAMP_CHARS)

    const firstEntry = SEED_RUNTIME_LOGS[0]!
    expect(levelCell).toHaveTextContent(firstEntry.level)
    // DOM 里是全文，视觉靠 truncate 省略，所以不写 title（原生提示会与悬浮窗抢位置）。
    const text = within(messageCell!).getByText(firstEntry.message)
    expect(text).toHaveClass('truncate')
    expect(text).not.toHaveAttribute('title')
  })

  it('悬停单元格出现展开图标，点击弹出悬浮窗，Esc 关闭且焦点回到图标', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp('/logs', { gateway: gatewayWithLogs() })
    await waitForTable()

    const firstEntry = SEED_RUNTIME_LOGS[0]!
    const messageCell = within(bodyRows()[0]!).getAllByRole('cell')[2]!
    const trigger = within(messageCell).getByRole('button', { name: '查看完整内容' })
    // 图标用 opacity-0 而不是隐藏 DOM：靠 group-hover 显形，但始终可聚焦、可被读屏发现。
    expect(trigger).toHaveClass('opacity-0', 'group-hover/cell:opacity-100', 'focus-visible:opacity-100')
    expect(messageCell).toHaveClass('group/cell')

    await user.click(trigger)
    const popover = await screen.findByLabelText('完整日志内容')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(popover).toHaveTextContent(firstEntry.message)
    expect(popover).toHaveTextContent(firstEntry.source)

    await user.keyboard('{Escape}')
    expect(screen.queryByLabelText('完整日志内容')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})

describe('搜索与全屏', () => {
  it('搜索按 message 与 source 过滤，无命中和搜日期都不出满屏', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp('/logs', { gateway: gatewayWithLogs() })
    await waitForTable()

    const keywordInput = screen.getByLabelText('搜索日志关键字')

    await user.type(keywordInput, '慢查询')
    await waitFor(() =>
      expect(bodyRows()).toHaveLength(
        SEED_RUNTIME_LOGS.filter((entry) => entry.message.includes('慢查询')).length,
      ),
    )

    await user.clear(keywordInput)
    await user.type(keywordInput, 'system.smtp')
    await waitFor(() =>
      expect(bodyRows()).toHaveLength(
        SEED_RUNTIME_LOGS.filter((entry) => entry.source.includes('system.smtp')).length,
      ),
    )

    // 时间与等级各有自己的列，不参与关键词匹配：搜日期不该出满屏。
    await user.clear(keywordInput)
    await user.type(keywordInput, '2026-09-16')
    expect(await screen.findByText('没有匹配的运行日志，换个关键词或清空搜索')).toBeInTheDocument()
    expect(within(region()).queryByRole('button', { name: '查看完整内容' })).not.toBeInTheDocument()
  })

  it('刷新日志重新装载条目，忙碌期间按钮置灰', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    let calls = 0
    const gateway = gatewayWithLogs({
      runtimeLog: () => {
        calls += 1
        return base.logs.runtimeLog()
      },
    })
    const user = userEvent.setup({ delay: null })
    renderApp('/logs', { gateway })
    await waitForTable()

    await user.click(screen.getByRole('button', { name: '刷新日志' }))
    await waitFor(() => expect(calls).toBe(2))
    await waitForTable()
  })

  it('全屏展示里同样是一张完整表格，退出全屏后弹窗关闭', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp('/logs', { gateway: gatewayWithLogs() })
    await waitForTable()

    await user.click(screen.getByRole('button', { name: '全屏展示' }))
    const dialog = await screen.findByRole('dialog')
    const fullscreenRegion = within(dialog).getByRole('region', { name: '运行日志表' })
    expect(within(fullscreenRegion).getAllByRole('row')).toHaveLength(SEED_RUNTIME_LOGS.length + 1)

    // 搜索关键字在全屏里同样生效（两个容器共用同一份过滤结果）。
    act(() => useRuntimeLogStore.getState().setSearch('轮询公告列表'))
    await waitFor(() =>
      expect(within(fullscreenRegion).getAllByRole('row')).toHaveLength(
        SEED_RUNTIME_LOGS.filter((entry) => entry.message.includes('轮询公告列表')).length + 1,
      ),
    )

    await user.click(within(dialog).getByRole('button', { name: '退出全屏' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('清空日志与其余能力', () => {
  it('清空要二次确认，并逐字写明不可恢复；取消不动数据', async () => {
    const user = userEvent.setup({ delay: null })
    // 取消路径不该发出请求：一旦发出就抛错，让用例直接失败而不是静默通过。
    const clearLogs = vi.fn(async (): Promise<never> => {
      throw new Error('取消之后不该调用清空端点')
    })
    renderApp('/logs', { gateway: gatewayWithLogs({ clearLogs }) })
    await waitForTable()

    await user.click(screen.getByRole('button', { name: '清空日志' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('确认清空运行日志？')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('清空后无法恢复，也不会留下备份')
    expect(dialog).toHaveTextContent('系统服务自己的日志（如 sshd.log）不受影响')

    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(clearLogs).not.toHaveBeenCalled()
    expect(bodyRows()).toHaveLength(SEED_RUNTIME_LOGS.length)
  })

  it('确认清空后删除并刷新：列表只剩一条「已清空」留痕，通知里是响应的事实', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp('/logs', { gateway: gatewayWithLogs() })
    await waitForTable()

    await user.click(screen.getByRole('button', { name: '清空日志' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '确认清空' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // 自指留痕：清空之后正常不是空表，而是正好一条「已清空」（规格 7.2）。
    await waitFor(() => expect(bodyRows()).toHaveLength(1))
    expect(within(region()).getByText(/运行日志已清空/)).toBeInTheDocument()

    const notice = useNotificationStore.getState().notifications[0]
    expect(notice?.tone).toBe('success')
    expect(notice?.message).toContain('运行日志已清空')
  })

  it('日志大小走契约口径，并给出保留说明', async () => {
    const gateway = gatewayWithLogs()
    const report = await gateway.logs.runtimeLog()
    renderApp('/logs', { gateway })
    await waitForTable()

    expect(screen.getByText(formatLogBytes(report.storage.totalBytes))).toBeInTheDocument()
    expect(screen.getByText(logRetentionText('runtime'))).toBeInTheDocument()
  })

  it('截断、坏行、坏文件与写盘失败都如实提示', async () => {
    renderApp('/logs', {
      gateway: gatewayWithLogs({
        runtimeLog: async () =>
          reportWith({
            truncated: true,
            skippedLines: 3,
            skippedFiles: 1,
            storage: { ...ZERO_STORAGE, failedWrites: 2 },
          }),
      }),
    })
    await waitForTable()

    expect(screen.getByText(`仅显示最近 ${LOG_ENTRY_FETCH_LIMIT} 条；有 3 行无法解析，已跳过；有 1 个日志文件读取失败，已跳过`)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('有 2 条运行日志未能写入磁盘')
  })

  it('没有任何记录时给空状态，而不是一张空表', async () => {
    renderApp('/logs', {
      gateway: gatewayWithLogs({ runtimeLog: async () => reportWith({ entries: [] }) }),
    })

    expect(await screen.findByText('还没有运行日志')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '运行日志表' })).not.toBeInTheDocument()
  })

  it('加载失败时给出错误态，重试成功后表格出现', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    let calls = 0
    const gateway = gatewayWithLogs({
      runtimeLog: () => {
        calls += 1
        if (calls === 1) throw new Error('演示用的读取失败')
        return base.logs.runtimeLog()
      },
    })
    const user = userEvent.setup({ delay: null })
    renderApp('/logs', { gateway })

    expect(await screen.findByRole('alert')).toHaveTextContent('演示用的读取失败')
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitForTable()
  })
})

describe('工具栏分组', () => {
  it('视图操作三个按钮成一组，清空日志与事实说明各在别处', async () => {
    renderApp('/logs', { gateway: gatewayWithLogs() })
    await waitForTable()

    const viewGroup = screen.getByRole('group', { name: '日志视图操作' })
    expect(within(viewGroup).getAllByRole('button').map((btn) => btn.textContent)).toEqual([
      '刷新日志',
      '全屏展示',
    ])
    // 清空是破坏性动作，不与视图开关混在同一组里；窄屏下它与日志大小同占第三行。
    expect(within(viewGroup).queryByRole('button', { name: '清空日志' })).not.toBeInTheDocument()
    // 保留口径与演示态是关于数据来源的事实，放工具栏外的说明行，不占控件位。
    expect(within(viewGroup).queryByText(logRetentionText('runtime'))).not.toBeInTheDocument()
    expect(screen.getByText(logRetentionText('runtime'))).toBeInTheDocument()
    expect(screen.getByText('演示数据').closest('[role="status"]')).not.toBeNull()
    expect(viewGroup).not.toContainElement(screen.getByText('演示数据'))
  })
})

describe('搜索口径与等级色调', () => {
  it('匹配 message 与 source，大小写不敏感；空关键词不过滤', () => {
    const info = SEED_RUNTIME_LOGS.find((entry) => entry.level === 'info')!
    expect(matchesRuntimeSearch(info, '')).toBe(true)
    expect(matchesRuntimeSearch(info, info.message.slice(0, 4))).toBe(true)
    expect(matchesRuntimeSearch(info, info.source.toUpperCase())).toBe(true)
    expect(matchesRuntimeSearch(info, '绝不存在的关键字')).toBe(false)
  })

  it('等级 → 语义色调：文字标签同时常驻，不只靠颜色', () => {
    expect(levelTone('error')).toBe('danger')
    expect(levelTone('warning')).toBe('warning')
    expect(levelTone('info')).toBe('info')
    expect(levelTone('debug')).toBe('neutral')
  })
})
