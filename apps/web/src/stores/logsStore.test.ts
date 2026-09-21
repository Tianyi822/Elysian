import { describe, expect, it } from 'vitest'
import { readStoredViewTab } from '../app/theme/themePreferences'
import { LOGS_TABS, useLogsStore } from './logsStore'

describe('日志区页签状态', () => {
  it('页签表有两项：运行日志在前，登录日志在后', () => {
    expect(LOGS_TABS.map(({ value, label }) => [value, label])).toEqual([
      ['runtime', '运行日志'],
      ['login', '登录日志'],
    ])
  })

  it('默认选中运行日志，setTab 切换页签', () => {
    expect(useLogsStore.getState().tab).toBe('runtime')
    useLogsStore.getState().setTab('login')
    expect(useLogsStore.getState().tab).toBe('login')
  })

  it('setTab 把选中写入界面偏好', () => {
    useLogsStore.getState().setTab('login')
    expect(readStoredViewTab(window.localStorage, 'logs')).toBe('login')
  })
})
