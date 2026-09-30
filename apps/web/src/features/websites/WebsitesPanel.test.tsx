import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { resetWebsitesData } from '../../adapters/mock/websitesData'
import { useDependencyGuideStore } from '../../stores/dependencyGuideStore'
import { useWebsitesStore } from '../../stores/websitesStore'
import { renderApp } from '../../test/renderApp'
import { MOCK_WEBSITE_RUNTIME_REPORT } from '../../adapters/mock/websiteRuntimeCatalog'
import type { WebsitesAdapter } from '../../contracts/adapters'

beforeEach(() => {
  resetWebsitesData()
  useWebsitesStore.setState({ status: 'idle', projects: [], createDialogOpen: false, detailTarget: undefined,
    settingsTarget: undefined, removeTarget: undefined, proxyStatus: { state: 'active', detail: null }, busyProjectIds: [] })
  useDependencyGuideStore.setState({ report: undefined, status: 'idle', dismissedDocker: false, dismissedCaddy: false })
})

async function open(runtimeCatalog?: WebsitesAdapter['runtimeCatalog']) {
  const gateway = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  if (runtimeCatalog) gateway.websites.runtimeCatalog = runtimeCatalog
  renderApp('/websites', { gateway })
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
  it('官方目录首次失败可重试，获取成功后开放版本选择', async () => {
    const user = userEvent.setup()
    const runtimeCatalog = vi.fn<WebsitesAdapter['runtimeCatalog']>()
      .mockRejectedValueOnce(new Error('无法获取正式运行时版本：网络不可用'))
      .mockResolvedValueOnce(MOCK_WEBSITE_RUNTIME_REPORT)
    await open(runtimeCatalog)
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('网络不可用')
    const dialog = screen.getByRole('dialog', { name: '添加项目' })
    expect(within(dialog).getByRole('button', { name: '添加项目' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '重新获取' }))
    expect(await screen.findByRole('button', { name: '运行时版本：25.0.4.1+1' })).toBeEnabled()
    expect(runtimeCatalog).toHaveBeenCalledTimes(2)
  })

  it('使用过期缓存时提示来源，已获取版本仍可选择', async () => {
    const user = userEvent.setup()
    await open(async () => ({ ...MOCK_WEBSITE_RUNTIME_REPORT, stale: true, detail: '版本目录更新失败，正在使用上次获取的缓存' }))
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    expect(await screen.findByText('版本目录更新失败，正在使用上次获取的缓存')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '运行时版本：25.0.4.1+1' })).toBeEnabled()
  })

  it('版本目录网络故障不阻止 HTML 创建', async () => {
    const user = userEvent.setup()
    await open(async () => { throw new Error('版本目录网络不可用') })
    await createHtml(user)
    expect(useWebsitesStore.getState().projects[0]?.kind).toBe('html')
  })

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

  it.each([
    ['Java项目', '17.0.1+12', 'java -jar app.jar'],
    ['Node项目', '14.17.6', null],
    ['Go项目', '1.16.7', './app'],
    ['Python项目', '3.9.7', null],
  ])('%s 可直接搜索并创建历史正式补丁 %s', async (kind, version, command) => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    await user.click(screen.getByRole('button', { name: kind }))
    expect(screen.queryByRole('button', { name: '旧版本' })).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '搜索运行时版本' }), version)
    await user.click(screen.getByRole('button', { name: /^运行时版本：/ }))
    await user.click(screen.getByRole('menuitemradio', { name: version }))
    await user.type(screen.getByLabelText('项目名称 *'), 'historical-app')
    if (command) await user.type(screen.getByLabelText('启动命令 *'), command)
    await user.click(within(screen.getByRole('dialog', { name: '添加项目' })).getByRole('button', { name: '添加项目' }))
    await screen.findByRole('article', { name: 'historical-app' })
    expect(useWebsitesStore.getState().projects[0]?.runtimeVersion).toBe(version)
  })

  it('切换语言清空版本搜索，无匹配结果时不丢失已选版本', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    const search = screen.getByRole('textbox', { name: '搜索运行时版本' })
    await user.type(search, '不存在的版本')
    expect(screen.getByRole('button', { name: '运行时版本：25.0.4.1+1' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '运行时版本：25.0.4.1+1' }))
    expect(screen.getByText('没有匹配的正式版本')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Python项目' }))
    expect(search).toHaveValue('')
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
