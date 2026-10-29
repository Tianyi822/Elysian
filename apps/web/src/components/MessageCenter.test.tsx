import * as Tooltip from '@radix-ui/react-tooltip'
import * as Dialog from '@radix-ui/react-dialog'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { useMessageStore } from '../stores/messageStore'
import { MessageCenter } from './MessageCenter'
function renderCenter() { return render(<Tooltip.Provider delayDuration={0}><MessageCenter /></Tooltip.Provider>) }
async function openCenter() {
  await userEvent.click(screen.getByRole('button', { name: '消息' }))
  const panel = await screen.findByRole('dialog', { name: '消息' })
  await waitFor(() => expect(within(panel).queryByText('正在读取消息…')).not.toBeInTheDocument())
  return panel
}
const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 360, width: 360, height: bottom - top, x: 0, y: top, toJSON() {} })
describe('全局消息组件', () => {
  it('新消息仅提示圆点，打开后倒序显示时间并标记已读', async () => {
    renderCenter()
    act(() => {
      useMessageStore.getState().notify({ tone: 'success', message: '第一条' })
      useMessageStore.getState().notify({ tone: 'danger', message: '第二条' })
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('有未读消息')).toBeInTheDocument()
    await act(async () => { await useMessageStore.getState().flush() })
    const panel = await openCenter()
    const expected = [...useMessageStore.getState().messages].sort((a, b) => a.occurredAt !== b.occurredAt
      ? a.occurredAt < b.occurredAt ? 1 : -1
      : a.id === b.id ? 0 : a.id < b.id ? 1 : -1)
    expect(within(panel).getAllByRole('listitem').map(item => item.dataset.messageId)).toEqual(expected.map(item => item.id))
    expect(panel.querySelector('time')?.textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(screen.queryByLabelText('有未读消息')).not.toBeInTheDocument()
  })
  it('空列表禁用清空，F8 打开、Escape 关闭并返回焦点', async () => {
    renderCenter()
    fireEvent.keyDown(window, { key: 'F8' })
    const panel = await screen.findByRole('dialog', { name: '消息' })
    expect(within(panel).getByRole('button', { name: '清空全部消息' })).toBeDisabled()
    await waitFor(() => expect(within(panel).getByText('暂无消息')).toBeInTheDocument())
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: '消息' })).toHaveFocus())
  })
  it('业务弹窗内可鼠标打开消息，关闭后保留草稿与焦点', async () => {
    const user = userEvent.setup()
    render(<Tooltip.Provider><MessageCenter /><Dialog.Root><Dialog.Trigger>打开表单</Dialog.Trigger><Dialog.Portal><Dialog.Overlay /><Dialog.Content aria-describedby={undefined}><Dialog.Title>编辑项目</Dialog.Title><input aria-label="项目名称" /><button type="button" onClick={() => useMessageStore.getState().notify({ tone: 'danger', message: '保存失败' })}>保存</button></Dialog.Content></Dialog.Portal></Dialog.Root></Tooltip.Provider>)
    await user.click(screen.getByRole('button', { name: '打开表单' }))
    const input = screen.getByRole('textbox', { name: '项目名称' })
    await user.type(input, '保留草稿')
    await user.click(screen.getByRole('button', { name: '保存' }))
    const panel = await openCenter()
    expect(within(panel).getByText('保存失败')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '消息' })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: '编辑项目' })).toBeInTheDocument()
    expect(input).toHaveValue('保留草稿')
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toHaveFocus())
  })
  it('清空只等待当前可见项，包含部分可见项，不等待屏幕外历史', async () => {
    renderCenter()
    act(() => { for (let index = 0; index < 30; index++) useMessageStore.getState().notify({ tone: 'info', message: `记录 ${index}` }) })
    await act(async () => { await useMessageStore.getState().flush() })
    const panel = await openCenter()
    const list = within(panel).getByRole('list', { name: '消息记录' })
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(rect(100, 300))
    within(list).getAllByRole('listitem').forEach((item, index) => vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(rect(70 + (index - 10) * 80, 150 + (index - 10) * 80)))
    await userEvent.click(within(panel).getByRole('button', { name: '清空全部消息' }))
    await waitFor(() => expect(panel.querySelectorAll('[data-clearing]')).toHaveLength(3))
    expect([...panel.querySelectorAll<HTMLElement>('[data-clearing]')].map(item => item.style.getPropertyValue('--message-delay'))).toEqual(['0ms', '45ms', '90ms'])
    act(() => { useMessageStore.getState().notify({ tone: 'info', message: '清空之后的新消息' }) })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '消息' })).not.toBeInTheDocument())
    expect(useMessageStore.getState().messages.map(item => item.message)).toEqual(['清空之后的新消息'])
    expect(screen.getByLabelText('有未读消息')).toBeInTheDocument()
  })
  it('未捕获异常仅记录脱敏消息，连续异常不重复', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    renderCenter()
    const listener = add.mock.calls.find(([type]) => type === 'error')![1] as EventListener
    act(() => { listener(new ErrorEvent('error', { message: 'private-token' })); listener(new Event('error')) })
    expect(useMessageStore.getState().messages).toHaveLength(1)
    expect(useMessageStore.getState().messages[0]?.message).not.toContain('private-token')
  })
  it('清空在途时关闭再打开，迟到的完成结果不会关闭重新打开的列表', async () => {
    renderCenter()
    act(() => { useMessageStore.getState().notify({ tone: 'info', message: '待清空' }) })
    await act(async () => { await useMessageStore.getState().flush() })
    const panel = await openCenter()
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const clear = useMessageStore.getState().clear
    const pendingClear = vi.spyOn(useMessageStore.getState(), 'clear').mockImplementation(async () => {
      const result = await clear()
      await barrier
      return result
    })
    await userEvent.click(within(panel).getByRole('button', { name: '清空全部消息' }))
    await waitFor(() => expect(useMessageStore.getState().messages).toHaveLength(0))
    await userEvent.click(screen.getByRole('button', { name: '消息' }))
    const reopened = await openCenter()
    await act(async () => { release(); await pendingClear.mock.results[0]!.value; await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(reopened).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '消息' })).toHaveAttribute('aria-expanded', 'true')
  })
  it('减少动态效果时直接清空退出，不等待可见项错峰', async () => {
    const media = window.matchMedia
    window.matchMedia = vi.fn().mockReturnValue({ matches: true } as MediaQueryList)
    try {
      renderCenter()
      act(() => { useMessageStore.getState().notify({ tone: 'info', message: '待清空' }) })
      await act(async () => { await useMessageStore.getState().flush() })
      const panel = await openCenter()
      await userEvent.click(within(panel).getByRole('button', { name: '清空全部消息' }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '消息' })).not.toBeInTheDocument())
      expect(useMessageStore.getState().messages).toEqual([])
    } finally { window.matchMedia = media }
  })
  it('浮层进入与退出只做位移：祖先的透明度动画会让背景模糊采不到页面', () => {
    const css = readFileSync('src/components/messageCenter.css', 'utf8')
    for (const name of ['message-panel-in', 'message-panel-out']) {
      const frame = css.match(new RegExp(`@keyframes ${name} \\{[^}]*\\{([^}]*)\\}`))
      expect(frame, `缺少 @keyframes ${name}`).not.toBeNull()
      expect(frame![1], `${name} 不得动 opacity`).not.toMatch(/opacity/)
    }
  })
})
