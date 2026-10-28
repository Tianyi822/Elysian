import * as Tooltip from '@radix-ui/react-tooltip'
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ElysianEvent } from '@elysian/contracts'
import { platformMemorySample } from '../test/platformMemorySample'
import { useEventStreamStore } from '../stores/eventStreamStore'
import type { SystemLoad } from '../adapters/mock/resourceMetrics'
import { SystemLoadBadge, usePlatformMemory } from './SystemLoadBadge'

function renderBadge() {
  return render(<Tooltip.Provider><SystemLoadBadge /></Tooltip.Provider>)
}

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/api/platform/memory')) {
        return new Response('not found', { status: 404 })
      }
      if (status !== 200) {
        return new Response('error', { status })
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

/** 经事件流的正规通路（connect → listeners）送一拍资源采样，带过去要显示的负载。 */
function emitLoad(load: SystemLoad): void {
  const event = {
    id: `rs-${Math.random().toString(36).slice(2)}`,
    name: 'resource/sample',
    at: new Date().toISOString(),
    payload: {
      cpu: 1,
      memory: 20,
      networkIo: 300,
      networkRx: 300,
      networkTx: 0,
      diskIo: 200,
      diskRead: 200,
      diskWrite: 0,
      load,
    },
  } as ElysianEvent
  useEventStreamStore.getState().connect({
    subscribe(handlers) {
      handlers.onStatus('live')
      handlers.onEvent(event)
      return () => {}
    },
  })
}

async function renderReady(
  sample: ReturnType<typeof platformMemorySample> = platformMemorySample(),
  status = 200,
) {
  stubFetch(sample, status)
  renderBadge()
  return screen.findByRole('button', { name: '系统负载' })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  useEventStreamStore.getState().disconnect()
})

describe('顶栏系统负载', () => {
  // 本文件里第一发采样之前跑：模块级最新一拍缓存还是空的。
  it('没收到事件流采样时负载显示占位，不当成 0', async () => {
    const trigger = await renderReady()

    await waitFor(() => expect(trigger).toHaveTextContent('80.0 MiB'))
    expect(trigger).toHaveTextContent('—')
    expect(trigger).not.toHaveTextContent('0.00')

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(within(dialog).getByText(/还没收到事件流的资源采样/)).toBeInTheDocument()
  })

  it('常驻 1 分钟负载与内存用量，不显示百分比', async () => {
    emitLoad({ m1: 0.42, m5: 0.18, m15: 0.07 })
    const trigger = await renderReady()

    await waitFor(() => expect(trigger).toHaveTextContent('0.42'))
    expect(trigger).toHaveTextContent('80.0 MiB')
    expect(trigger).not.toHaveTextContent('%')
    // 5/15 分钟档不进常驻读数，只出现在明细里
    expect(trigger).not.toHaveTextContent('0.18')
  })

  it('点击展开明细：三档负载与内存两套口径分节列出', async () => {
    emitLoad({ m1: 0.42, m5: 0.18, m15: 0.07 })
    const trigger = await renderReady()
    await waitFor(() => expect(trigger).toHaveTextContent('0.42'))

    const user = userEvent.setup()
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(within(dialog).getByText('机器负载（load average）')).toBeInTheDocument()
    expect(within(dialog).getByText('0.42')).toBeInTheDocument()
    expect(within(dialog).getByText('0.18')).toBeInTheDocument()
    expect(within(dialog).getByText('0.07')).toBeInTheDocument()
    expect(within(dialog).getByText('面板常驻内存（RSS）')).toBeInTheDocument()
    expect(within(dialog).getByText('1.00 GiB')).toBeInTheDocument()
    expect(within(dialog).getByText('占系统总内存')).toBeInTheDocument()
    expect(within(dialog).getByText('7.8%')).toBeInTheDocument()
    expect(within(dialog).getByText('Go 运行时')).toBeInTheDocument()
    expect(within(dialog).getByText('40.0 MiB')).toBeInTheDocument()
  })

  it('口径解释在问号浮层里，不常驻明细', async () => {
    emitLoad({ m1: 0.42, m5: 0.18, m15: 0.07 })
    const trigger = await renderReady()
    await waitFor(() => expect(trigger).toHaveTextContent('0.42'))

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(within(dialog).queryByText(/不能相加/)).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '内存口径说明' }))
    const help = await screen.findByRole('dialog', { name: '内存口径说明' })
    expect(within(help).getByText(/不能相加/)).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
  })

  it('内存采集失败时如实说明，不伪造数据', async () => {
    emitLoad({ m1: 0.42, m5: 0.18, m15: 0.07 })
    const trigger = await renderReady(platformMemorySample(), 503)

    await waitFor(() => expect(trigger).toHaveTextContent('采集失败'))
    expect(trigger).not.toHaveTextContent(/MiB|%/)
    expect(trigger).toHaveTextContent('0.42')
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })

  it('近似读数在常驻读数与明细里都明确标注', async () => {
    emitLoad({ m1: 0.42, m5: 0.18, m15: 0.07 })
    const trigger = await renderReady(platformMemorySample({ rssSource: 'statm' }))

    await waitFor(() => expect(trigger).toHaveTextContent('≈ 80.0 MiB'))

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(
      within(dialog).getByRole('meter', { name: '后端常驻内存占系统总内存' }),
    ).toHaveAttribute('aria-valuetext', '≈ 80.0 MiB，占系统总内存的 7.8%')
  })

  it('无法读取实际用量时显示不可用，不用 Go 堆数据冒充', async () => {
    emitLoad({ m1: 0.42, m5: 0.18, m15: 0.07 })
    const trigger = await renderReady(
      platformMemorySample({ rssMb: null, rssSource: 'unavailable', gcCount: 0, heapLiveMb: 0 }),
    )

    await waitFor(() => expect(trigger).toHaveTextContent('不可用'))
    expect(trigger).not.toHaveTextContent(/MiB|%/)

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(within(dialog).queryByRole('meter')).not.toBeInTheDocument()
    expect(within(dialog).getByText('不可用')).toBeInTheDocument()
    expect(within(dialog).getByText('—')).toBeInTheDocument()
  })

  it('参照总量不可读时保留实际大小，不伪造百分比或占用条', async () => {
    emitLoad({ m1: 0.42, m5: 0.18, m15: 0.07 })
    const trigger = await renderReady(platformMemorySample({ systemTotalMb: null }))

    await waitFor(() => expect(trigger).toHaveTextContent('80.0 MiB'))
    expect(trigger).not.toHaveTextContent('%')

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '系统负载明细' })
    expect(within(dialog).queryByRole('meter')).not.toBeInTheDocument()
    expect(within(dialog).getAllByText('—')).toHaveLength(2)
    expect(within(dialog).queryByText(/NaN/)).not.toBeInTheDocument()
  })

  it('按采样间隔周期刷新内存读数', async () => {
    vi.useFakeTimers()
    let rssMb = 80
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(platformMemorySample({ rssMb })))),
    )

    renderBadge()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '系统负载' })).toHaveTextContent('80.0 MiB')

    rssMb = 120
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '系统负载' })).toHaveTextContent('120.0 MiB')
  })

  it('慢请求期间不重叠采样，卸载时取消请求并停止定时器', async () => {
    vi.useFakeTimers()
    let resolve!: (sample: ReturnType<typeof platformMemorySample>) => void
    const read = vi.fn((_signal?: AbortSignal) => new Promise<ReturnType<typeof platformMemorySample>>((done) => { resolve = done }))
    const { result, unmount } = renderHook(() => usePlatformMemory(5_000, read))
    await act(async () => { vi.advanceTimersByTime(15_000) })
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(platformMemorySample()) })
    expect(result.current.status).toBe('ready')
    await act(async () => { vi.advanceTimersByTime(5_000) })
    expect(read).toHaveBeenCalledTimes(2)
    const signal = read.mock.calls[1]?.[0]
    unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { vi.advanceTimersByTime(15_000); resolve(platformMemorySample({ rssMb: 120 })) })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('后台挂载不采样，回到前台立即读取且只恢复一个定时器', async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const read = vi.fn(async () => platformMemorySample())
    const { result } = renderHook(() => usePlatformMemory(5_000, read))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(read).not.toHaveBeenCalled()

    visibility = 'visible'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('ready')
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('切到后台暂停采样，切回前台立即刷新', async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const read = vi.fn(async () => platformMemorySample())
    renderHook(() => usePlatformMemory(5_000, read))
    await act(async () => { await Promise.resolve() })
    expect(read).toHaveBeenCalledTimes(1)

    visibility = 'hidden'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(read).toHaveBeenCalledTimes(1)

    visibility = 'visible'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('切后台取消在途请求，旧结果不能覆盖恢复后的新采样', async () => {
    vi.useFakeTimers()
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    let resolveOld!: (sample: ReturnType<typeof platformMemorySample>) => void
    const read = vi.fn((_signal?: AbortSignal) => Promise.resolve(platformMemorySample({ rssMb: 120 })))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const { result } = renderHook(() => usePlatformMemory(5_000, read))
    const oldSignal = read.mock.calls[0]?.[0]

    visibility = 'hidden'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(read).toHaveBeenCalledTimes(1)

    visibility = 'visible'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(read).toHaveBeenCalledTimes(2)
    expect(result.current).toMatchObject({ status: 'ready', sample: { rssMb: 120 } })
    await act(async () => { resolveOld(platformMemorySample({ rssMb: 80 })) })
    expect(result.current).toMatchObject({ status: 'ready', sample: { rssMb: 120 } })
  })

  it('页面离开暂停采样，往返缓存恢复时立即读取', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const read = vi.fn(async () => platformMemorySample())
    renderHook(() => usePlatformMemory(5_000, read))
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'))
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => { window.dispatchEvent(new Event('pageshow')) })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('同一页面的多个徽标共享采样，最后一个卸载后才停止并清除旧值', async () => {
    vi.useFakeTimers()
    stubFetch(platformMemorySample())
    const first = renderHook(() => usePlatformMemory())
    await act(async () => { await Promise.resolve() })
    const second = renderHook(() => usePlatformMemory())
    await act(async () => { await Promise.resolve() })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(second.result.current).toEqual(first.result.current)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(fetch).toHaveBeenCalledTimes(2)

    first.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(fetch).toHaveBeenCalledTimes(3)
    second.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(fetch).toHaveBeenCalledTimes(3)

    const third = renderHook(() => usePlatformMemory())
    expect(third.result.current.status).toBe('loading')
    await act(async () => { await Promise.resolve() })
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(third.result.current.status).toBe('ready')
  })
})
