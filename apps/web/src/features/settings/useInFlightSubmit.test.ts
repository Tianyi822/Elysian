import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useInFlightSubmit } from './useInFlightSubmit'

describe('useInFlightSubmit', () => {
  it('inFlightOnly 不向调用方提供任何 requestId，同样单飞', async () => {
    const { result } = renderHook(() => useInFlightSubmit())
    const submit = vi.fn(async () => 42)
    const value = await act(() => result.current.inFlightOnly(submit))
    expect(value).toBe(42)
    expect(submit).toHaveBeenCalledWith()
    const hanging = vi.fn(() => new Promise<void>(() => {}))
    let pending: Promise<void | undefined> | undefined
    let immediate: Promise<void | undefined> | undefined
    await act(async () => {
      pending = result.current.inFlightOnly(hanging)
      immediate = result.current.inFlightOnly(hanging)
      await Promise.resolve()
    })
    expect(hanging).toHaveBeenCalledTimes(1)
    expect(await immediate).toBeUndefined()
    void pending
  })
  it('失败抛出后单飞锁与 submitting 复位，可再次提交', async () => {
    const { result } = renderHook(() => useInFlightSubmit())
    let attempt = 0
    const submit = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('会话正忙，暂不接受新输入')
      return 'ok'
    })
    await expect(act(() => result.current.inFlightOnly(submit))).rejects.toThrow('会话正忙，暂不接受新输入')
    expect(result.current.submitting).toBe(false)
    await expect(act(() => result.current.inFlightOnly(submit))).resolves.toBe('ok')
  })
})
