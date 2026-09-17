import * as Tooltip from '@radix-ui/react-tooltip'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { WebsiteProject } from '@elysian/contracts'
import { WebsitesCard } from './WebsitesCard'

/*
 * 卡片是纯展示组件：数据与回调全部由 props 注入，
 * 这里不依赖 store 与路由（只包 MemoryRouter 供 Link 渲染）。
 */

/** 基准夹具：java 运行中、带 PID 与端口、有到期时间。 */
function makeProject(overrides: Partial<WebsiteProject> = {}): WebsiteProject {
  return {
    id: 'site-order',
    kind: 'java',
    name: '订单服务',
    pid: 30241,
    port: 8080,
    runtimeVersion: null,
    rootDir: '/www/wwwroot/order-service',
    runState: 'running',
    expiryAt: '2026-12-20T00:00:00.000+08:00',
    note: null,
    cert: 'none',
    category: 'production',
    deployCommand: 'java -jar order-service.jar',
    traffic: { todayMb: 128.4, totalGb: 56.1 },
    ...overrides,
  }
}

function renderCard(
  project: WebsiteProject,
  { selected = false, busy = false }: { selected?: boolean; busy?: boolean } = {},
) {
  const callbacks = {
    onToggleSelected: vi.fn(),
    onOpenDetail: vi.fn(),
    onToggleRunning: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenRemove: vi.fn(),
  }
  render(
    <Tooltip.Provider delayDuration={0}>
      <MemoryRouter initialEntries={['/']}>
        <WebsitesCard
          project={project}
          selected={selected}
          busy={busy}
          onToggleSelected={callbacks.onToggleSelected}
          onOpenDetail={callbacks.onOpenDetail}
          onToggleRunning={callbacks.onToggleRunning}
          onOpenSettings={callbacks.onOpenSettings}
          onOpenRemove={callbacks.onOpenRemove}
        />
      </MemoryRouter>
    </Tooltip.Provider>,
  )
  return { card: screen.getByRole('article', { name: project.name }), callbacks }
}

describe('WebsitesCard', () => {
  it('呈现名称、类型标签、分类标签与运行状态标签', () => {
    const { card } = renderCard(makeProject())
    expect(within(card).getByRole('heading', { name: '订单服务' })).toBeInTheDocument()
    expect(within(card).getByText('Java项目')).toBeInTheDocument()
    expect(within(card).getByText('生产环境')).toBeInTheDocument()
    // 状态一律「文字 + 颜色」：运行中用 success 色调。
    expect(within(card).getByText('运行中')).toHaveClass('text-success')
  })

  it('java 项目显示端口（等宽数字）与 PID', () => {
    const { card } = renderCard(makeProject())
    const portCell = within(card).getByText('端口').closest('p')
    expect(portCell).not.toBeNull()
    expect(within(portCell as HTMLElement).getByText('8080')).toHaveClass('tabular-nums')
    const pidCell = within(card).getByText('PID').closest('p')
    expect(pidCell).not.toBeNull()
    expect(within(pidCell as HTMLElement).getByText('30241')).toBeInTheDocument()
  })

  it('node 项目显示 Node 版本', () => {
    const { card } = renderCard(
      makeProject({
        id: 'site-gateway',
        name: '网关服务',
        kind: 'node',
        runtimeVersion: '20.11.1',
        port: 3000,
        pid: 41002,
        rootDir: '/www/wwwroot/gateway',
        deployCommand: 'node dist/main.js',
      }),
    )
    const versionCell = within(card).getByText('Node版本').closest('p')
    expect(versionCell).not.toBeNull()
    expect(within(versionCell as HTMLElement).getByText('20.11.1')).toBeInTheDocument()
  })

  it('html 项目没有端口、PID 与版本行', () => {
    const { card } = renderCard(
      makeProject({
        id: 'site-portal',
        name: '官网门户',
        kind: 'html',
        pid: null,
        port: null,
        runtimeVersion: null,
        rootDir: '/www/wwwroot/portal',
        deployCommand: null,
      }),
    )
    expect(within(card).queryByText('端口')).not.toBeInTheDocument()
    expect(within(card).queryByText('PID')).not.toBeInTheDocument()
    expect(within(card).queryByText('Node版本')).not.toBeInTheDocument()
    // 到期时间对所有类型都呈现。
    expect(within(card).getByText('到期时间')).toBeInTheDocument()
  })

  it('没有到期时间的项目显示「长期有效」', () => {
    const { card } = renderCard(
      makeProject({
        id: 'site-sync',
        name: '同步工具',
        kind: 'go',
        pid: null,
        port: null,
        expiryAt: null,
        rootDir: '/www/wwwroot/sync-tool',
        deployCommand: './sync-tool',
      }),
    )
    expect(within(card).getByText('长期有效')).toBeInTheDocument()
  })

  it('已停止的项目保留端口、隐藏 PID，状态标签转中性色', async () => {
    const { card, callbacks } = renderCard(makeProject({ runState: 'stopped', pid: null }))
    expect(within(card).getByText('已停止')).toHaveClass('text-fg-muted')
    expect(within(card).getByText('8080')).toBeInTheDocument()
    expect(within(card).queryByText('PID')).not.toBeInTheDocument()
    // 已停止的启停按钮变为「启动」。
    await userEvent.setup().click(within(card).getByRole('button', { name: '启动' }))
    expect(callbacks.onToggleRunning).toHaveBeenCalledTimes(1)
  })

  it('点击选择框只触发 onToggleSelected，不触发卡片整体点击', async () => {
    const user = userEvent.setup()
    const { card, callbacks } = renderCard(makeProject())
    await user.click(within(card).getByRole('checkbox', { name: '选择项目 订单服务' }))
    expect(callbacks.onToggleSelected).toHaveBeenCalledTimes(1)
    expect(callbacks.onOpenDetail).not.toHaveBeenCalled()
  })

  it('根目录是指向文件管理器的链接', () => {
    const { card } = renderCard(makeProject())
    const link = within(card).getByRole('link', { name: '/www/wwwroot/order-service' })
    expect(link).toHaveAttribute('href', '/files/www/wwwroot/order-service')
  })

  it('点击卡片空白处打开详情', async () => {
    const user = userEvent.setup()
    const { card, callbacks } = renderCard(makeProject())
    await user.click(within(card).getByText('端口'))
    expect(callbacks.onOpenDetail).toHaveBeenCalledTimes(1)
  })

  it('详情按钮触发 onOpenDetail 且不因冒泡双触发', async () => {
    const user = userEvent.setup()
    const { card, callbacks } = renderCard(makeProject())
    await user.click(within(card).getByRole('button', { name: '详情' }))
    expect(callbacks.onOpenDetail).toHaveBeenCalledTimes(1)
  })

  it('启停、设置、删除分别触发对应回调且不打开详情', async () => {
    const user = userEvent.setup()
    const { card, callbacks } = renderCard(makeProject())
    await user.click(within(card).getByRole('button', { name: '停止' }))
    await user.click(within(card).getByRole('button', { name: '设置' }))
    await user.click(within(card).getByRole('button', { name: '删除' }))
    expect(callbacks.onToggleRunning).toHaveBeenCalledTimes(1)
    expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(1)
    expect(callbacks.onOpenRemove).toHaveBeenCalledTimes(1)
    expect(callbacks.onOpenDetail).not.toHaveBeenCalled()
  })

  it('busy 时全部操作按钮禁用', () => {
    const { card } = renderCard(makeProject(), { busy: true })
    expect(within(card).getByRole('button', { name: '详情' })).toBeDisabled()
    expect(within(card).getByRole('button', { name: '停止' })).toBeDisabled()
    expect(within(card).getByRole('button', { name: '设置' })).toBeDisabled()
    expect(within(card).getByRole('button', { name: '删除' })).toBeDisabled()
  })

  it('选中态由 selected prop 表达', () => {
    const { card } = renderCard(makeProject(), { selected: true })
    expect(card).toHaveClass('border-accent/50', 'bg-accent/5')
    // 选择框同步勾上。
    expect(within(card).getByRole('checkbox', { name: '选择项目 订单服务' })).toBeChecked()
  })
})
