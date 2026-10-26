import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationStore } from '../stores/notificationStore'
import { CopyButton } from './CopyButton'

beforeEach(() => {
  useNotificationStore.getState().clear()
})

describe('复制按钮', () => {
  it('点击把值写入剪贴板，按钮短暂显示已复制，并发一条成功通知', async () => {
    const user = userEvent.setup()
    render(<CopyButton label="用户名" value="ops" tooltip="复制演示用户名" />)

    await user.click(screen.getByRole('button', { name: '用户名' }))

    await expect(navigator.clipboard.readText()).resolves.toBe('ops')
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()
    // 行内反馈在窄卡上可能只剩一枚勾，成功提示另发一条通知说清复制了什么。
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'success',
      message: '已复制用户名',
    })
  })

  it('剪贴板被拒时发通知，不静默失败', async () => {
    const user = userEvent.setup()
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValue(new Error('denied'))
    render(<CopyButton label="密码" value="demo-mariadb-7f2c" tooltip="复制演示密码" />)

    await user.click(screen.getByRole('button', { name: '密码' }))

    expect(useNotificationStore.getState().notifications[0]?.message).toContain('复制失败')
    writeText.mockRestore()
  })

  it('HTTP IP 入口没有异步剪贴板时仍能复制完整文本，并恢复焦点', async () => {
    const user = userEvent.setup()
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const command = Object.getOwnPropertyDescriptor(document, 'execCommand')
    const value = '中文 🌏\n```ts\nconst x = "内容";\n```'
    const exec = vi.fn(() => {
      expect((document.activeElement as HTMLTextAreaElement).value).toBe(value)
      return true
    })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
    try {
      render(<CopyButton label="消息" value={value} tooltip="复制消息" />)
      const trigger = screen.getByRole('button', { name: '消息' })
      await user.click(trigger)
      expect(exec).toHaveBeenCalledWith('copy')
      expect(document.querySelector('textarea')).toBeNull()
      expect(trigger).toHaveFocus()
      expect(useNotificationStore.getState().notifications.at(-1)).toMatchObject({ tone: 'success', message: '已复制消息' })
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
      if (command) Object.defineProperty(document, 'execCommand', command)
      else Reflect.deleteProperty(document, 'execCommand')
    }
  })
})
