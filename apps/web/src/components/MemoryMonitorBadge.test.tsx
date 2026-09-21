import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../test/renderApp'

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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('内存自检图标', () => {
  it('采集失败时如实说明，不伪造数据', async () => {
    stubFetch({}, 503)
    renderApp('/')

    const trigger = await screen.findByRole('button', { name: '平台内存占用' })
    await waitFor(() => expect(trigger).toHaveTextContent('采集失败'))

    const user = userEvent.setup()
    await user.click(trigger)
    expect(await screen.findByText(/无法读取本机进程内存/)).toBeInTheDocument()
  })

  it('采集成功时显示常驻占用，点开详情含三项进程数值', async () => {
    stubFetch({ rssMb: 80, heapUsedMb: 40, heapTotalMb: 50 })
    renderApp('/')

    const trigger = await screen.findByRole('button', { name: '平台内存占用' })
    await waitFor(() => expect(trigger).toHaveTextContent('平台内存占用 80.0 MB'))

    const user = userEvent.setup()
    await user.click(trigger)

    const anchor = await screen.findByText('常驻内存')
    const popover = anchor.closest('[data-radix-popper-content-wrapper]')
    expect(popover).not.toBeNull()
    expect(popover as HTMLElement).toHaveTextContent('平台内存占用')
    expect(popover as HTMLElement).toHaveTextContent('80.0 MB')
    expect(popover as HTMLElement).toHaveTextContent('堆已用')
    expect(popover as HTMLElement).toHaveTextContent('40.0 MB')
    expect(popover as HTMLElement).toHaveTextContent('堆已分配')
    expect(popover as HTMLElement).toHaveTextContent('50.0 MB')
  })

  it('按采样间隔周期刷新数值', async () => {
    vi.useFakeTimers()
    let rssMb = 80
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ rssMb, heapUsedMb: 40, heapTotalMb: 50 }))),
    )

    renderApp('/')
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '平台内存占用' })).toHaveTextContent('80.0 MB')

    rssMb = 120
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '平台内存占用' })).toHaveTextContent('120.0 MB')
  })
})
