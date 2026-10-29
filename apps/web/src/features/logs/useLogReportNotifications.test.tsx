import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useMessageStore } from '../../stores/messageStore'
import { useLogReportNotifications } from './useLogReportNotifications'

beforeEach(() => useMessageStore.getState().clear())

describe('日志报告通知', () => {
  it('写盘、读取缺口和分页失败都进入通知，同一报告重渲染不重复', () => {
    const report = { ready: true, truncated: true, skippedLines: 2, skippedFiles: 1, failedWrites: 3, trimmedBySize: true, olderError: '分页连接中断' }
    const { rerender } = renderHook(({ value }) => useLogReportNotifications('运行日志', value), { initialProps: { value: report } })
    rerender({ value: { ...report } })
    const notices = useMessageStore.getState().messages
    expect(notices).toHaveLength(3)
    expect(notices[0]).toMatchObject({ tone: 'warning', message: expect.stringContaining('有 1 个日志文件读取失败') })
    expect(notices[1]).toMatchObject({ tone: 'danger', message: expect.stringContaining('3 条日志未能写入磁盘') })
    expect(notices[2]).toMatchObject({ tone: 'danger', message: expect.stringContaining('分页连接中断') })
    rerender({ value: { ...report, failedWrites: 4 } })
    expect(useMessageStore.getState().messages).toHaveLength(3)
    expect(useMessageStore.getState().messages[1]?.message).toContain('4 条日志未能写入磁盘')
  })

  it('无读取问题的列表截断使用普通信息通知，加载时不通报旧报告', () => {
    const report = { ready: false, truncated: true, skippedLines: 0, skippedFiles: 0 }
    const { rerender } = renderHook(({ value }) => useLogReportNotifications('登录日志', value), { initialProps: { value: report } })
    expect(useMessageStore.getState().messages).toEqual([])
    rerender({ value: { ...report, ready: true } })
    expect(useMessageStore.getState().messages).toEqual([expect.objectContaining({ tone: 'info', message: expect.stringContaining('仅显示最近') })])
  })
})
