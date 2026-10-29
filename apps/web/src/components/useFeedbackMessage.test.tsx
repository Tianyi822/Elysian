import { StrictMode } from 'react'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useMessageStore } from '../stores/messageStore'
import type { MessageTone } from '../stores/messageStore'
import { useFeedbackMessage } from './useFeedbackMessage'

beforeEach(async () => {
  await useMessageStore.getState().clear()
})

describe('反馈通知', () => {
  it('反馈变更时发布通知，重复渲染与严格模式不重复发布', () => {
    const { rerender } = renderHook(
      ({ message }) => useFeedbackMessage(message),
      {
        initialProps: { message: '读取失败' },
        wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
      },
    )
    rerender({ message: '读取失败' })
    expect(useMessageStore.getState().messages).toHaveLength(1)

    rerender({ message: '保存失败' })
    expect(useMessageStore.getState().messages.map(({ message, tone }) => ({ message, tone }))).toEqual([
      { message: '读取失败', tone: 'danger' },
      { message: '保存失败', tone: 'danger' },
    ])
  })

  it('反馈清空后相同问题再次出现会重新通知', () => {
    const { rerender } = renderHook(
      ({ message }: { message: string | null | undefined }) => useFeedbackMessage(message),
      { initialProps: { message: '读取失败' as string | null | undefined } },
    )
    rerender({ message: undefined })
    rerender({ message: '读取失败' })
    rerender({ message: null })
    rerender({ message: '' })

    expect(useMessageStore.getState().messages.map(({ message }) => message)).toEqual([
      '读取失败',
      '读取失败',
    ])
  })

  it('同一消息切换等级会发布对应等级的通知', () => {
    const { rerender } = renderHook(
      ({ tone }: { tone: MessageTone }) => useFeedbackMessage('请检查配置', tone),
      { initialProps: { tone: 'info' as MessageTone } },
    )
    rerender({ tone: 'warning' })

    expect(useMessageStore.getState().messages.map(({ tone }) => tone)).toEqual(['info', 'warning'])
  })

  it('不同反馈独立发布，组件卸载保留已发布的通知', () => {
    const { unmount } = renderHook(() => {
      useFeedbackMessage('读取失败')
      useFeedbackMessage('保存成功', 'success')
    })
    unmount()

    expect(useMessageStore.getState().messages.map(({ message }) => message)).toEqual([
      '读取失败',
      '保存成功',
    ])
  })

  it('合并中的反馈更新原消息，清空后新问题仍会发布', async () => {
    const { rerender } = renderHook(({ message }) => useFeedbackMessage(message, 'danger', { replace: true }), {
      initialProps: { message: '模型读取失败' },
    })
    const id = useMessageStore.getState().messages[0]!.id
    rerender({ message: '模型读取失败；会话读取失败' })
    expect(useMessageStore.getState().messages).toEqual([
      expect.objectContaining({ id, message: '模型读取失败；会话读取失败', tone: 'danger' }),
    ])
    await useMessageStore.getState().clear()
    rerender({ message: '会话读取失败' })
    expect(useMessageStore.getState().messages).toHaveLength(1)
    expect(useMessageStore.getState().messages[0]!.id).not.toBe(id)
  })
})
