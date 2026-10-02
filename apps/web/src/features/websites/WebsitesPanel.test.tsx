import { act, screen, waitFor, within } from '@testing-library/react'
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
  return gateway
}

async function createHtml(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '添加项目' }))
  await user.click(screen.getByRole('button', { name: 'HTML项目' }))
  await user.type(screen.getByLabelText('项目名称 *'), 'docs')
  await user.click(within(screen.getByRole('dialog', { name: '添加项目' })).getByRole('button', { name: '添加项目' }))
  await screen.findByRole('article', { name: 'docs' })
}

describe('网站访问配置引导', () => {
  it.each(['missing', 'error'] as const)('Caddy %s 时隐藏访问方式区域，创建请求固定直连', async (state) => {
    const user = userEvent.setup()
    useDependencyGuideStore.setState({
      report: { docker: { state: 'ok', detail: null }, caddy: { state, detail: 'Caddy 不可用' } },
      status: 'checked', dismissedCaddy: true,
    })
    const gateway = await open()
    const create = vi.spyOn(gateway.websites, 'create')
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    const dialog = within(screen.getByRole('dialog', { name: '添加项目' }))
    expect(dialog.queryByRole('group', { name: '访问方式' })).not.toBeInTheDocument()
    expect(dialog.queryByText(/访问路径/)).not.toBeInTheDocument()
    expect(dialog.queryByText(/创建时将自动在防火墙/)).not.toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'HTML项目' }))
    await user.type(dialog.getByLabelText('项目名称 *'), 'docs')
    await user.click(dialog.getByRole('button', { name: '添加项目' }))
    await screen.findByRole('article', { name: 'docs' })
    expect(create).toHaveBeenCalledWith('html', expect.objectContaining({ access: { mode: 'direct' } }))
    expect(useWebsitesStore.getState().projects[0]?.accessMode).toBe('direct')
  })

  it('Caddy 就绪时可选域名，通道失效后隐藏区域并回落直连提交', async () => {
    const user = userEvent.setup()
    const gateway = await open()
    const create = vi.spyOn(gateway.websites, 'create')
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    const dialog = within(screen.getByRole('dialog', { name: '添加项目' }))
    await user.click(dialog.getByRole('button', { name: 'HTML项目' }))
    await user.type(dialog.getByLabelText('项目名称 *'), 'docs')
    expect(dialog.getByRole('group', { name: '访问方式' })).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: /域名访问/ }))
    expect(dialog.getByLabelText('访问域名 *')).toBeInTheDocument()
    act(() => useDependencyGuideStore.setState({
      report: { docker: { state: 'ok', detail: null }, caddy: { state: 'error', detail: '管理通道连接失败' } },
    }))
    expect(dialog.queryByRole('group', { name: '访问方式' })).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('访问域名 *')).not.toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: '添加项目' }))
    await screen.findByRole('article', { name: 'docs' })
    expect(create).toHaveBeenCalledWith('html', expect.objectContaining({ access: { mode: 'direct' } }))
  })

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

  it.each([
    ['Node项目', '如 node app.js', '如 node app.js'],
    ['Python项目', '如 python3 -m http.server 8080 --bind 0.0.0.0 --directory /app', '如 python3 -m http.server 8081 --bind 0.0.0.0 --directory /app'],
  ])('%s 启动命令只显示占位示例，切换类型与修改端口不填入实际值，留空不能创建', async (kind, placeholder, nextPlaceholder) => {
    const user = userEvent.setup()
    const gateway = await open()
    const create = vi.spyOn(gateway.websites, 'create')
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    await user.type(screen.getByLabelText('启动命令 *'), 'java -jar app.jar')
    await user.click(screen.getByRole('button', { name: kind }))
    const command = screen.getByLabelText('启动命令 *')
    expect(command).toHaveValue('')
    expect(command).toHaveAttribute('placeholder', placeholder)
    await user.click(screen.getByRole('button', { name: '端口加一' }))
    expect(command).toHaveValue('')
    expect(command).toHaveAttribute('placeholder', nextPlaceholder)
    await user.type(screen.getByLabelText('项目名称 *'), 'app')
    await user.click(within(screen.getByRole('dialog', { name: '添加项目' })).getByRole('button', { name: '添加项目' }))
    expect(screen.getByText('请填写容器启动命令')).toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    ['Java项目', '17.0.1+12', 'java -jar app.jar'],
    ['Node项目', '14.17.6', 'node app.js'],
    ['Go项目', '1.16.7', './app'],
    ['Python项目', '3.9.7', 'python3 app.py'],
  ])('%s 可直接搜索并创建历史正式补丁 %s', async (kind, version, command) => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    await user.click(screen.getByRole('button', { name: kind }))
    expect(screen.queryByRole('button', { name: '旧版本' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '搜索运行时版本' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^运行时版本：/ }))
    const menu = within(screen.getByRole('menu', { name: '运行时版本' }))
    const search = menu.getByRole('textbox', { name: '搜索运行时版本' })
    expect(search).toHaveFocus()
    await user.type(search, version)
    await waitFor(() => expect(menu.getAllByRole('menuitemradio')).toHaveLength(1))
    await user.click(menu.getByRole('menuitemradio', { name: version }))
    await user.type(screen.getByLabelText('项目名称 *'), 'historical-app')
    if (command) await user.type(screen.getByLabelText('启动命令 *'), command)
    await user.click(within(screen.getByRole('dialog', { name: '添加项目' })).getByRole('button', { name: '添加项目' }))
    await screen.findByRole('article', { name: 'historical-app' })
    expect(useWebsitesStore.getState().projects[0]?.runtimeVersion).toBe(version)
    if (command) expect(useWebsitesStore.getState().projects[0]?.deployCommand).toBe(command)
  })

  it('切换语言清空版本搜索，无匹配结果时不丢失已选版本', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: '添加项目' }))
    await user.click(screen.getByRole('button', { name: '运行时版本：25.0.4.1+1' }))
    const search = screen.getByRole('textbox', { name: '搜索运行时版本' })
    await user.type(search, '不存在的版本')
    expect(screen.getByRole('button', { name: '运行时版本：25.0.4.1+1' })).toBeInTheDocument()
    expect(await screen.findByText('没有匹配的正式版本')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: '添加项目' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Python项目' }))
    await user.click(screen.getByRole('button', { name: /^运行时版本：/ }))
    expect(screen.getByRole('textbox', { name: '搜索运行时版本' })).toHaveValue('')
    expect(screen.getAllByRole('menuitemradio').length).toBeGreaterThan(1)
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
