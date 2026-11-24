import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContainerStartupCommand, quoteContainerArgument } from './ContainerStartupCommand'
import { writeClipboardText } from '../utils/clipboardText'

vi.mock('../utils/clipboardText', () => ({ writeClipboardText: vi.fn(async () => {}) }))

describe('容器启动命令', () => {
  it('保留空参数、特殊字符和多行脚本并一键复制', async () => {
    const argv = ['/bin/sh', '-ec', 'echo "$VALUE"\nprintf "a b"', '', "it's here"]
    render(<ContainerStartupCommand argv={argv} fallback="" />)
    expect(screen.getByText('Shell 脚本')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '复制命令' }))
    expect(writeClipboardText).toHaveBeenCalledWith("/bin/sh -ec 'echo \"$VALUE\"\nprintf \"a b\"' '' 'it'\\''s here'")
    expect(await screen.findByRole('button', { name: '已复制' })).toBeInTheDocument()
    expect(quoteContainerArgument('ls;echo')).toBe("'ls;echo'")
  })
})
