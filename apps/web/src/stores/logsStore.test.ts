import { describe, expect, it } from 'vitest'
import { LOGS_TABS, useLogsStore } from './logsStore'

describe('日志区页签状态', () => {
  it('页签表有两项：平台运行日志在前，平台登录日志在后', () => {
    expect(LOGS_TABS.map(({ value, label }) => [value, label])).toEqual([
      ['runtime', '平台运行日志'],
      ['login', '平台登录日志'],
    ])
  })

  it('默认选中运行日志，setTab 切换页签', () => {
    expect(useLogsStore.getState().tab).toBe('runtime')
    useLogsStore.getState().setTab('login')
    expect(useLogsStore.getState().tab).toBe('login')
  })
})
