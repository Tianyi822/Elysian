import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { resetWebsitesData } from '../../adapters/mock/websitesData'
import { useDependencyGuideStore } from '../../stores/dependencyGuideStore'
import { useWebsitesStore } from '../../stores/websitesStore'
import { renderApp } from '../../test/renderApp'

beforeEach(() => {
  resetWebsitesData()
  useWebsitesStore.setState({ status: 'idle', projects: [], createDialogOpen: false, detailTarget: undefined,
    settingsTarget: undefined, removeTarget: undefined, proxyStatus: { state: 'active', detail: null }, busyProjectIds: [] })
  useDependencyGuideStore.setState({ report: undefined, status: 'idle', dismissedDocker: false, dismissedCaddy: false })
})

async function open() {
  renderApp('/websites', { gateway: createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' }) })
  await screen.findByText('您的列表为空')
}

async function createHtml(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '添加项目' }))
  await user.click(screen.getByRole('button', { name: 'HTML项目' }))
  await user.type(screen.getByLabelText('项目名称 *'), 'docs')
  await user.click(within(screen.getByRole('dialog', { name: '添加项目' })).getByRole('button', { name: '添加项目' }))
  await screen.findByRole('article', { name: 'docs' })
}

describe('网站访问配置引导', () => {
  it('空项目可创建 HTML 直连容器，并显示访问方式入口', async () => {
    const user = userEvent.setup()
    await open()
    expect(screen.getByRole('button', { name: '访问配置' })).toBeInTheDocument()
    await createHtml(user)
    const project = useWebsitesStore.getState().projects[0]
    expect(project?.containerId).toMatch(/^[0-9a-f]{64}$/)
    expect(project?.accessMode).toBe('direct')
    expect(project?.runState).toBe('stopped')
  })

  it('更改端口会同步尚未编辑的 Node 默认启动命令', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    await user.click(screen.getByRole('button', { name: 'Node项目' }))
    const command = screen.getByLabelText('启动命令 *') as HTMLInputElement
    expect(command.value).toContain('.listen(8080)')
    await user.click(screen.getByRole('button', { name: '端口加一' }))
    expect(command.value).toContain('.listen(8081)')
  })

  it('先选项目再切换域名访问，上传证书后显示路由及证书核对结果', async () => {
    const user = userEvent.setup()
    await open()
    await createHtml(user)
    await user.click(screen.getByRole('button', { name: '访问配置' }))
    const dialog = screen.getByRole('dialog', { name: '访问配置' })
    await user.click(within(dialog).getByRole('button', { name: /docs/ }))
    await user.click(within(dialog).getByRole('button', { name: /域名访问/ }))
    await user.type(within(dialog).getByLabelText('访问域名 *'), 'example.com')
    const files = within(dialog).getAllByLabelText(/PEM/)
    await user.upload(files[0]!, new File(['certificate'], 'chain.pem', { type: 'application/x-pem-file' }))
    await user.upload(files[1]!, new File(['private-key'], 'key.pem', { type: 'application/x-pem-file' }))
    await user.click(within(dialog).getByRole('button', { name: '保存访问配置' }))
    await waitFor(() => expect(useWebsitesStore.getState().projects[0]?.domain).toBe('example.com'))
    expect(within(dialog).getAllByText(/路由和证书已下发，项目未运行/).length).toBeGreaterThan(0)
  })

  it('窄屏对话框与键盘焦点仍可操作', async () => {
    const user = userEvent.setup()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    await open()
    await user.click(screen.getByRole('button', { name: '访问配置' }))
    expect(screen.getByRole('dialog', { name: '访问配置' })).toHaveClass('w-[min(52rem,calc(100vw-1.5rem))]')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '访问配置' })).not.toBeInTheDocument())
  })
})
