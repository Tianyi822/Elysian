import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelTask } from '@elysian/contracts'
import { advanceAuthGeneration } from '../../adapters/http/unauthorized'
import { usePanelStore } from '../../stores/panelStore'
import { useSessionStore } from '../../stores/sessionStore'
import { PanelReloadCountdown } from './PanelReloadCountdown'
import { reloadPanelPage } from './panelNavigation'
import { PANEL_RELOAD_KEY, readPanelReload, savePanelReload } from './panelReload'

vi.mock('./panelNavigation', () => ({ reloadPanelPage: vi.fn() }))
const ports = { frontendPort: 48100, backendPort: 48101 }
const task: PanelTask = { id: 'update-one', kind: 'update', state: 'succeeded', phase: 'finished', oldPorts: ports, newPorts: ports, targetCommit: 'c'.repeat(40), createdAt: '', updatedAt: '', error: '' }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z'))
  vi.clearAllMocks(); usePanelStore.getState().clearDisplay()
  useSessionStore.setState({ phase: 'authed' })
  vi.stubEnv('ELYSIAN_BUILD_COMMIT', '')
})
afterEach(() => vi.unstubAllEnvs())
const advance = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
function show() {
  usePanelStore.getState().requestReload(task)
  return render(<><input aria-label="未提交草稿" /><PanelReloadCountdown /></>)
}
describe('全局圆形重载倒计时', () => {
  it('固定 30 秒截止时间；悬停、后台及重复回调均不延后或重复重载', async () => {
    show()
    const circle = screen.getByRole('dialog', { name: '更新完成' })
    expect(within(circle).getByText('30')).toBeInTheDocument()
    const deadline = readPanelReload()!.deadline
    fireEvent.mouseOver(screen.getByRole('button', { name: '立刻重启' }))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await advance(12_000)
    expect(within(circle).getByText('18')).toBeInTheDocument()
    expect(readPanelReload()!.deadline).toBe(deadline)
    await advance(17_999)
    expect(reloadPanelPage).not.toHaveBeenCalled()
    await advance(1)
    expect(reloadPanelPage).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent(window, new Event('pageshow')); fireEvent(document, new Event('visibilitychange'))
    await advance(31_000)
    expect(reloadPanelPage).toHaveBeenCalledTimes(1)
    expect(readPanelReload()?.executed).toBe(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })
  it.each(['click', 'Enter', 'Space'] as const)('%s 立即执行，并保留当前地址', async (method) => {
    vi.useRealTimers()
    show()
    const address = window.location.href
    const button = screen.getByRole('button', { name: '立刻重启' })
    const user = userEvent.setup()
    if (method === 'click') await user.click(button)
    else { button.focus(); await user.keyboard(method === 'Enter' ? '{Enter}' : ' ') }
    expect(reloadPanelPage).toHaveBeenCalledTimes(1)
    expect(window.location.href).toBe(address)
    fireEvent(window, new Event('pageshow'))
    expect(reloadPanelPage).toHaveBeenCalledTimes(1)
  })
  it('不抢输入焦点；周围页面保持可操作', () => {
    render(<><input aria-label="未提交草稿" /><PanelReloadCountdown /></>)
    const input = screen.getByRole('textbox')
    input.focus()
    act(() => usePanelStore.getState().requestReload(task))
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: '保留输入' } })
    expect(input).toHaveValue('保留输入')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'false')
    expect(document.querySelector('[data-radix-dialog-overlay]')).toBeNull()
  })
  it('重新挂载沿用截止时间；设备休眠恢复后立即补做', async () => {
    const view = show()
    await advance(10_000)
    const record = readPanelReload()!
    view.unmount()
    usePanelStore.setState({ reload: null })
    act(() => usePanelStore.getState().requestReload(task))
    expect(usePanelStore.getState().reload).toEqual(record)
    render(<PanelReloadCountdown />)
    expect(screen.getByText('20')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '立刻重启' })).toHaveAccessibleDescription('剩余 20 秒后重新加载当前页面。')
    expect(screen.getByRole('status')).not.toHaveTextContent('30 秒')
    vi.setSystemTime(record.deadline + 15_000)
    fireEvent(window, new Event('pageshow'))
    expect(reloadPanelPage).toHaveBeenCalledTimes(1)
  })
  it('登录代次变化后旧按钮和到期回调不能重载；登出移除浮层与存储', async () => {
    show()
    advanceAuthGeneration()
    fireEvent.click(screen.getByRole('button', { name: '立刻重启' }))
    await advance(30_000)
    expect(reloadPanelPage).not.toHaveBeenCalled()
    act(() => useSessionStore.getState().expire())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(sessionStorage.getItem(PANEL_RELOAD_KEY)).toBeNull()
  })
  it('已执行记录与已加载目标版本均不重新开始', () => {
    savePanelReload({ version: 1, taskId: task.id, targetCommit: task.targetCommit, deadline: Date.now() - 10_000, executed: true })
    usePanelStore.getState().requestReload(task)
    const view = render(<PanelReloadCountdown />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    vi.stubEnv('ELYSIAN_BUILD_COMMIT', task.targetCommit)
    act(() => usePanelStore.getState().requestReload({ ...task, id: 'another' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(reloadPanelPage).not.toHaveBeenCalled()
    view.unmount()
  })
})
