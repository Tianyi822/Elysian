import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_REQUEST_ID_PATTERN } from '../../adapters/http/agent/agentShared'
import { useInFlightSubmit } from './useInFlightSubmit'

describe('useInFlightSubmit', () => {
  it('withRequestId 生成一次后复用同一幂等键，格式满足服务端正则', async () => {
    const { result } = renderHook(() => useInFlightSubmit())
    const first = vi.fn(async (requestId: string) => requestId)
    const id1 = await act(() => result.current.withRequestId(first))
    const id2 = await act(() => result.current.withRequestId(first))
    expect(id1).toBe(id2)
    expect(AGENT_REQUEST_ID_PATTERN.test(id1 as string)).toBe(true)
  })

  it('newRequestId 作废旧键：新一轮提交拿到不同幂等键', async () => {
    const { result } = renderHook(() => useInFlightSubmit())
    const id1 = await act(() => result.current.withRequestId(vi.fn(async (r: string) => r)))
    let refreshed = ''
    act(() => {
      refreshed = result.current.newRequestId()
    })
    const id2 = await act(() => result.current.withRequestId(vi.fn(async (r: string) => r)))
    expect(id1).not.toBe(refreshed)
    expect(id2).toBe(refreshed)
  })

  it('连点单飞锁：提交进行中第二次调用直接返回 undefined，不重放', async () => {
    const { result } = renderHook(() => useInFlightSubmit())
    let release: ((value: string) => void) | undefined
    const submit = vi.fn(() => new Promise<string>((resolve) => {
      release = resolve
    }))
    let pending: Promise<string | undefined> | undefined
    let second: Promise<string | undefined> | undefined
    await act(async () => {
      pending = result.current.withRequestId(submit)
      second = result.current.withRequestId(submit)
      await Promise.resolve()
    })
    expect(result.current.submitting).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(await second).toBeUndefined()
    await act(async () => {
      release?.('done')
      await pending
    })
    expect(result.current.submitting).toBe(false)
  })

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
