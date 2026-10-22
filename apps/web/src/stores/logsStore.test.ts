import { describe, expect, it } from 'vitest'
import { UI_PREFERENCES_KEY } from '../app/theme/themePreferences'
import { LOGS_TABS, useLogsStore } from './logsStore'

describe('日志区页签状态', () => {
  it('页签表有三项：运行日志、登录日志、操作日志依次排列', () => {
    expect(LOGS_TABS.map(({ value, label }) => [value, label])).toEqual([
      ['runtime', '运行日志'],
      ['login', '登录日志'],
      ['operation', '操作日志'],
    ])
  })

  it('默认选中运行日志，setTab 切换页签', () => {
    expect(useLogsStore.getState().tab).toBe('runtime')
    useLogsStore.getState().setTab('login')
    expect(useLogsStore.getState().tab).toBe('login')
    useLogsStore.getState().setTab('operation')
    expect(useLogsStore.getState().tab).toBe('operation')
  })

  it('setTab 只改会话内状态，不写界面偏好', () => {
    useLogsStore.getState().setTab('login')
    expect(localStorage.getItem(UI_PREFERENCES_KEY)).toBeNull()
  })
})
