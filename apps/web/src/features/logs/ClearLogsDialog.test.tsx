import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatLogBytes } from '@elysian/contracts'
import type { LogStorageStats } from '@elysian/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useNotificationStore } from '../../stores/notificationStore'
import { useRuntimeLogStore } from '../../stores/runtimeLogStore'
import { ClearLogsDialog } from './ClearLogsDialog'

/*
 * 清空是不可恢复的破坏性动作：弹窗必须把「删掉什么、删多少、最早到什么时候、之后无法恢复」
 * 全部写出来，并保证初始焦点不落在「确认清空」上——误按一次回车不能删掉日志。
 */

const STORAGE: LogStorageStats = {
  totalBytes: 320 * 1024,
  runtimeBytes: 256 * 1024,
  operationBytes: 64 * 1024,
  runtimeRowCount: 12,
  operationRowCount: 0,
  rowCount: 12,
  oldestAt: '2026-09-16T11:24:54.000Z',
  lastSweepAt: null,
  trimmedBySize: false,
  droppedRecords: 0,
  failedWrites: 0,
}

/** 逐方法转发而不是展开 `base.logs`：mock adapter 是类实例，展开会丢掉原型上的方法。 */
function gatewayWith(overrides: Partial<ElysianGateway['logs']> = {}): ElysianGateway {
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

function renderDialog(gateway: ElysianGateway) {
  return render(
    <GatewayProvider gateway={gateway}>
      <ClearLogsDialog />
    </GatewayProvider>,
  )
}

beforeEach(() => {
  useRuntimeLogStore.setState({ status: 'ready', storage: STORAGE, clearTarget: 'runtime' })
})

describe('清空日志的二次确认', () => {
  it('写明清空之后不可恢复、删多少、最早时间与不动 sshd.log', async () => {
    renderDialog(gatewayWith())

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('确认清空运行日志？')).toBeInTheDocument()

    // 数字一律走契约口径，不手写「256 MB」这类会与保留说明分叉的文案。
    expect(dialog).toHaveTextContent('全部记录')
    expect(dialog).toHaveTextContent(`共 ${STORAGE.runtimeRowCount} 条、约 ${formatLogBytes(STORAGE.runtimeBytes)}`)
    expect(dialog).not.toHaveTextContent('分片')
    expect(dialog).toHaveTextContent('日志最早可追溯到')
    expect(dialog).toHaveTextContent('2026-09-16 19:24:54')
    expect(dialog).toHaveTextContent('保留 7 天')
    expect(dialog).toHaveTextContent('清空后无法恢复，也不会留下备份')
    expect(dialog).toHaveTextContent('系统服务自己的日志（如 sshd.log）不受影响')
    expect(dialog).toHaveTextContent('演示数据：只清空内存中的演示日志，不触碰任何文件')
  })

  it('打开后焦点不在「确认清空」按钮上（误按回车不能删日志）', async () => {
    renderDialog(gatewayWith())

    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: '确认清空' })
    expect(confirm).not.toHaveFocus()
    expect(document.activeElement).toBe(dialog)
  })

  it('取消不删除：弹窗关闭且没有请求发出', async () => {
    const user = userEvent.setup()
    const clearLogs = vi.fn(gatewayWith().logs.clearLogs)
    renderDialog(gatewayWith({ clearLogs }))

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(clearLogs).not.toHaveBeenCalled()
    expect(useRuntimeLogStore.getState().clearTarget).toBeNull()
  })

  it('确认后按类别删除，并用清空响应里的实际数字通知', async () => {
    const user = userEvent.setup()
    const clearLogs = vi.fn(async () => ({
      category: 'runtime' as const,
      rowCount: 12,
      totalBytes: STORAGE.runtimeBytes,
      oldestAt: STORAGE.oldestAt,
      clearedAt: '2026-09-23T03:25:10.004Z',
    }))
    renderDialog(gatewayWith({ clearLogs }))

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '确认清空' }))

    await waitFor(() => expect(clearLogs).toHaveBeenCalledWith('runtime'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const notice = useNotificationStore.getState().notifications[0]
    expect(notice?.tone).toBe('success')
    expect(notice?.message).toContain(`释放 ${formatLogBytes(STORAGE.runtimeBytes)}`)
    expect(notice?.message).toContain('条记录')
  })

  it('删除失败时保留弹窗供重试，并如实报错', async () => {
    const user = userEvent.setup()
    renderDialog(
      gatewayWith({
        clearLogs: async () => {
          throw new Error('清空端点不可用')
        },
      }),
    )

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '确认清空' }))

    await waitFor(() =>
      expect(useNotificationStore.getState().notifications[0]?.message).toContain('清空端点不可用'),
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(useRuntimeLogStore.getState().clearTarget).toBe('runtime')
  })
})
