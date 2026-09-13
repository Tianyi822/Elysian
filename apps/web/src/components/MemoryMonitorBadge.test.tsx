import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readHeapSample } from './MemoryMonitorBadge'
import { renderApp } from '../test/renderApp'

const MB = 1024 * 1024

type MemoryPerformance = {
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
}

function stubMemory(memory: Partial<NonNullable<MemoryPerformance['memory']>> | undefined): void {
  if (memory === undefined) {
    delete (performance as MemoryPerformance).memory
    return
  }
  ;(performance as MemoryPerformance).memory = {
    usedJSHeapSize: 0,
    totalJSHeapSize: 0,
    jsHeapSizeLimit: 0,
    ...memory,
  }
}

afterEach(() => {
  stubMemory(undefined)
  vi.useRealTimers()
})

describe('readHeapSample', () => {
  it('没有 performance.memory 时返回 undefined', () => {
    stubMemory(undefined)
    expect(readHeapSample()).toBeUndefined()
  })

  it('字节数换算为 MB', () => {
    stubMemory({ usedJSHeapSize: 50 * MB, totalJSHeapSize: 60 * MB, jsHeapSizeLimit: 4 * 1024 * MB })
    expect(readHeapSample()).toEqual({ usedMb: 50, totalMb: 60, limitMb: 4096 })
  })
})

describe('内存自检图标', () => {
  it('浏览器不支持时如实说明，不伪造数据', async () => {
    stubMemory(undefined)
    renderApp('/')

    const trigger = screen.getByRole('button', { name: '工具内存自检' })
    expect(trigger).toHaveTextContent('内存自检不可用')

    const user = userEvent.setup()
    await user.click(trigger)
    const popover = await screen.findByText(/当前浏览器不提供 performance\.memory/)
    expect(popover).toBeInTheDocument()
  })

  it('支持时显示当前占用，点开详情含三项堆数值', async () => {
    stubMemory({ usedJSHeapSize: 50 * MB, totalJSHeapSize: 60 * MB, jsHeapSizeLimit: 4 * 1024 * MB })
    renderApp('/')

    const trigger = screen.getByRole('button', { name: '工具内存自检' })
    expect(within(trigger).getByText('50.0 MB')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(trigger)

    const detail = await screen.findByText('工具内存自检')
    const popover = detail.closest('[data-radix-popper-content-wrapper]') ?? detail.parentElement
    expect(popover).not.toBeNull()
    expect(popover as HTMLElement).toHaveTextContent('已用堆')
    expect(popover as HTMLElement).toHaveTextContent('50.0 MB')
    expect(popover as HTMLElement).toHaveTextContent('60.0 MB')
    expect(popover as HTMLElement).toHaveTextContent('4096.0 MB')
  })

  it('按采样间隔周期刷新数值', async () => {
    vi.useFakeTimers()
    stubMemory({ usedJSHeapSize: 50 * MB, totalJSHeapSize: 60 * MB, jsHeapSizeLimit: 4 * 1024 * MB })
    renderApp('/')

    expect(screen.getByRole('button', { name: '工具内存自检' })).toHaveTextContent('50.0 MB')

    stubMemory({ usedJSHeapSize: 80 * MB, totalJSHeapSize: 90 * MB, jsHeapSizeLimit: 4 * 1024 * MB })
    act(() => {
      vi.advanceTimersByTime(5_000)
    })

    expect(screen.getByRole('button', { name: '工具内存自检' })).toHaveTextContent('80.0 MB')
  })
})
