import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationStore } from '../stores/notificationStore'
import { CopyButton } from './CopyButton'

beforeEach(() => {
  useNotificationStore.getState().clear()
})

describe('复制按钮', () => {
  it('点击把值写入剪贴板，并在按钮上短暂显示已复制', async () => {
    const user = userEvent.setup()
    render(<CopyButton label="复制用户名" value="ops" tooltip="复制演示用户名" />)

    await user.click(screen.getByRole('button', { name: '复制用户名' }))

    await expect(navigator.clipboard.readText()).resolves.toBe('ops')
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()
  })

  it('剪贴板被拒时发通知，不静默失败', async () => {
    const user = userEvent.setup()
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValue(new Error('denied'))
    render(<CopyButton label="复制密码" value="demo-mariadb-7f2c" tooltip="复制演示密码" />)

    await user.click(screen.getByRole('button', { name: '复制密码' }))

    expect(useNotificationStore.getState().notifications[0]?.message).toContain('复制失败')
    writeText.mockRestore()
  })
})
