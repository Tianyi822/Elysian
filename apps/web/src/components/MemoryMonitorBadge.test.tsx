import * as Tooltip from '@radix-ui/react-tooltip'
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { platformMemorySample } from '../test/platformMemorySample'
import { MemoryMonitorBadge, usePlatformMemory } from './MemoryMonitorBadge'

function renderMonitor() {
  return render(<Tooltip.Provider><MemoryMonitorBadge /></Tooltip.Provider>)
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

async function renderReady(
  sample: ReturnType<typeof platformMemorySample> = platformMemorySample(),
  status = 200,
) {
  stubFetch(sample, status)
  renderMonitor()
  return screen.findByRole('button', { name: '内存自检' })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('内存自检图标', () => {
  it('顶栏只显绝对用量，不显百分比，避免与仪表盘的内存占用率同屏混淆', async () => {
    const trigger = await renderReady()

    await waitFor(() => expect(trigger).toHaveTextContent('80.0 MiB'))
    expect(trigger).not.toHaveTextContent('%')
    expect(trigger).not.toHaveTextContent('内存占用')
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })

  it('点击展开明细，占比与它的分母一起呈现', async () => {
    const trigger = await renderReady()
    await waitFor(() => expect(trigger).toHaveTextContent('80.0 MiB'))

    const user = userEvent.setup()
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: '内存自检详情' })
    expect(within(dialog).getByText('常驻内存')).toBeInTheDocument()
    expect(within(dialog).getByText('80.0 MiB')).toBeInTheDocument()
    expect(within(dialog).getByText('1.00 GiB')).toBeInTheDocument()
    expect(within(dialog).getByText('占系统总内存')).toBeInTheDocument()

    const usage = within(dialog).getByRole('meter', { name: '后端常驻内存占系统总内存' })
    expect(usage).toHaveAttribute('aria-valuenow', '7.8125')
    expect(usage).toHaveAttribute('aria-valuetext', '80.0 MiB，占系统总内存的 7.8%')
    expect(within(dialog).getByText('7.8%')).toBeInTheDocument()
  })

  it('明细列出 Go 运行时口径，口径解释收在问号里不常驻', async () => {
    const trigger = await renderReady()
    await waitFor(() => expect(trigger).toHaveTextContent('80.0 MiB'))

    const user = userEvent.setup()
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: '内存自检详情' })
    expect(within(dialog).getByText('Go 运行时')).toBeInTheDocument()
    expect(within(dialog).getByText('堆已用')).toBeInTheDocument()
    expect(within(dialog).getByText('40.0 MiB')).toBeInTheDocument()
    expect(within(dialog).getByText('只统计 Elysian 后端进程自身占用的内存。')).toBeInTheDocument()
    expect(within(dialog).queryByText(/浏览器/)).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/不能相加/)).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '内存口径说明' }))

    const help = await screen.findByRole('dialog', { name: '内存口径说明' })
    expect(within(help).getByText(/不能相加/)).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
  })

  it('采集失败时顶栏如实说明，不伪造数据', async () => {
    const trigger = await renderReady(platformMemorySample(), 503)

    await waitFor(() => expect(trigger).toHaveTextContent('采集失败'))
    expect(trigger).not.toHaveTextContent(/MiB|%/)
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })

  it('近似读数在顶栏与明细里都明确标注', async () => {
    const trigger = await renderReady(platformMemorySample({ rssSource: 'statm' }))

    await waitFor(() => expect(trigger).toHaveTextContent('≈ 80.0 MiB'))

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '内存自检详情' })
    expect(
      within(dialog).getByRole('meter', { name: '后端常驻内存占系统总内存' }),
    ).toHaveAttribute('aria-valuetext', '≈ 80.0 MiB，占系统总内存的 7.8%')
  })

  it('无法读取实际用量时显示不可用，不用 Go 堆数据冒充', async () => {
    const trigger = await renderReady(
      platformMemorySample({ rssMb: null, rssSource: 'unavailable', gcCount: 0, heapLiveMb: 0 }),
    )

    await waitFor(() => expect(trigger).toHaveTextContent('不可用'))
    expect(trigger).not.toHaveTextContent(/MiB|%/)

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '内存自检详情' })
    expect(within(dialog).queryByRole('meter')).not.toBeInTheDocument()
    expect(within(dialog).getByText('不可用')).toBeInTheDocument()
    expect(within(dialog).getByText('—')).toBeInTheDocument()
  })

  it('参照总量不可读时保留实际大小，不伪造百分比或占用条', async () => {
    const trigger = await renderReady(platformMemorySample({ systemTotalMb: null }))

    await waitFor(() => expect(trigger).toHaveTextContent('80.0 MiB'))
    expect(trigger).not.toHaveTextContent('%')

    const user = userEvent.setup()
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '内存自检详情' })
    expect(within(dialog).queryByRole('meter')).not.toBeInTheDocument()
    expect(within(dialog).getAllByText('—')).toHaveLength(2)
    expect(within(dialog).queryByText(/NaN/)).not.toBeInTheDocument()
  })

  it('按采样间隔周期刷新数值', async () => {
    vi.useFakeTimers()
    let rssMb = 80
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(platformMemorySample({ rssMb })))),
    )

    renderMonitor()
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '内存自检' })).toHaveTextContent('80.0 MiB')

    rssMb = 120
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '内存自检' })).toHaveTextContent('120.0 MiB')
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
})
