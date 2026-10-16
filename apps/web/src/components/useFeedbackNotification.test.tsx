import { StrictMode } from 'react'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useNotificationStore } from '../stores/notificationStore'
import type { NotificationTone } from '../stores/notificationStore'
import { useFeedbackNotification } from './useFeedbackNotification'

beforeEach(() => {
  useNotificationStore.getState().clear()
})

describe('反馈通知', () => {
  it('反馈变更时发布通知，重复渲染与严格模式不重复发布', () => {
    const { rerender } = renderHook(
      ({ message }) => useFeedbackNotification(message),
      {
        initialProps: { message: '读取失败' },
        wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
      },
    )
    rerender({ message: '读取失败' })
    expect(useNotificationStore.getState().notifications).toHaveLength(1)

    rerender({ message: '保存失败' })
    expect(useNotificationStore.getState().notifications.map(({ message, tone }) => ({ message, tone }))).toEqual([
      { message: '读取失败', tone: 'danger' },
      { message: '保存失败', tone: 'danger' },
    ])
  })

  it('反馈清空后相同问题再次出现会重新通知', () => {
    const { rerender } = renderHook(
      ({ message }: { message: string | null | undefined }) => useFeedbackNotification(message),
      { initialProps: { message: '读取失败' as string | null | undefined } },
    )
    rerender({ message: undefined })
    rerender({ message: '读取失败' })
    rerender({ message: null })
    rerender({ message: '' })

    expect(useNotificationStore.getState().notifications.map(({ message }) => message)).toEqual([
      '读取失败',
      '读取失败',
    ])
  })

  it('同一消息切换等级会发布对应等级的通知', () => {
    const { rerender } = renderHook(
      ({ tone }: { tone: NotificationTone }) => useFeedbackNotification('请检查配置', tone),
      { initialProps: { tone: 'info' as NotificationTone } },
    )
    rerender({ tone: 'warning' })

    expect(useNotificationStore.getState().notifications.map(({ tone }) => tone)).toEqual(['info', 'warning'])
  })

  it('不同反馈独立发布，组件卸载保留已发布的通知', () => {
    const { unmount } = renderHook(() => {
      useFeedbackNotification('读取失败')
      useFeedbackNotification('保存成功', 'success')
    })
    unmount()

    expect(useNotificationStore.getState().notifications.map(({ message }) => message)).toEqual([
      '读取失败',
      '保存成功',
    ])
  })

  it('合并中的反馈更新原通知，关闭后新问题仍会通知', () => {
    const { rerender } = renderHook(({ message }) => useFeedbackNotification(message, 'danger', { replace: true }), {
      initialProps: { message: '模型读取失败' },
    })
    const id = useNotificationStore.getState().notifications[0]!.id
    rerender({ message: '模型读取失败；会话读取失败' })
    expect(useNotificationStore.getState().notifications).toEqual([
      { id, message: '模型读取失败；会话读取失败', tone: 'danger' },
    ])
    useNotificationStore.getState().dismiss(id)
    rerender({ message: '会话读取失败' })
    expect(useNotificationStore.getState().notifications).toHaveLength(1)
    expect(useNotificationStore.getState().notifications[0]!.id).not.toBe(id)
  })
})
