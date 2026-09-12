import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState, ErrorState, LoadingState, NoPermissionState } from './StateViews'

describe('页面级状态容器', () => {
  it('加载状态以 status 角色播报', () => {
    render(<LoadingState label="正在加载事故列表…" />)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载事故列表…')
  })

  it('空状态说明为什么是空的', () => {
    render(<EmptyState title="没有匹配的事故" description="当前筛选条件下没有结果。" />)
    expect(screen.getByText('没有匹配的事故')).toBeInTheDocument()
    expect(screen.getByText('当前筛选条件下没有结果。')).toBeInTheDocument()
  })

  it('错误状态以 alert 角色呈现并提供重试回调', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(<ErrorState description="无法读取数据。" onRetry={onRetry} />)

    expect(screen.getByRole('alert')).toHaveTextContent('无法读取数据。')
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('无权限状态给出明确说明', () => {
    render(<NoPermissionState />)
    expect(screen.getByText('无访问权限')).toBeInTheDocument()
  })
})
