import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import * as Tooltip from '@radix-ui/react-tooltip'
import { ThemeProvider } from '../../app/theme/ThemeProvider'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { ModelSettingsMockAdapter, resetModelSettingsData } from '../../adapters/mock/agent/modelSettingsMockAdapter'
import { demoAgentRuntimeInfo } from '../../adapters/mock/agent/agentRuntimeMock'
import type { ElysianGateway } from '../../contracts/adapters'
import { useNotificationStore } from '../../stores/notificationStore'
import { useModelSettingsStore } from '../../stores/modelSettingsStore'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { ModelSettingsSection } from './ModelSettingsSection'

/*
 * 页面级测试跑在真实 mock 适配器上：模型闭环（凭据只写不回显、
 * 留空沿用/显式清除）、预设填充、目录状态和修订冲突。
 * 测试不读生产凭据，种子确定性可复现。
 * 渲染树与 test/renderApp 同构（Theme＋Tooltip＋Gateway＋Router），但只挂本页
 * 路由并手工注入最小网关；GatewayProvider 静态引用的 mock/gateway 共享链
 * （含全部七域 HTTP 适配器）以 vi.mock 隔离——本测试永远显式传 gateway，
 * 不触发其 fallback，隔离只为不受其他模块并行施工的中间态影响。
 */
vi.mock('../../adapters/mock/gateway', () => ({
  createMockGateway: () => {
    throw new Error('本测试显式注入网关，不应触达 createMockGateway 的 fallback')
  },
}))

function makePageGateway(adapter: ModelSettingsMockAdapter = new ModelSettingsMockAdapter()): ElysianGateway {
  return {
    modelSettings: adapter,
    agentRuntime: { runtime: async () => demoAgentRuntimeInfo() },
  } as unknown as ElysianGateway
}

function renderCapabilitiesPage(path = '/settings', gateway: ElysianGateway = makePageGateway()) {
  const router = createMemoryRouter(
    [{ path: '/settings', element: <ModelSettingsSection active /> }],
    { initialEntries: [path] },
  )
  const view = render(
    <ThemeProvider>
      <Tooltip.Provider delayDuration={0}>
        <GatewayProvider gateway={gateway}>
          <RouterProvider router={router} />
        </GatewayProvider>
      </Tooltip.Provider>
    </ThemeProvider>,
  )
  return { ...view, router }
}

async function renderReady(path = '/settings', gateway?: ElysianGateway) {
  const view = renderCapabilitiesPage(path, gateway)
  // 等待运行时判定与列表装载完成：等待目标按页签取该页签的种子行。
  const readyText = 'gpt-5'
  await screen.findByText(readyText)
  return view
}

beforeEach(() => {
  resetModelSettingsData()
  useAgentRuntimeStore.getState().reset()
  useModelSettingsStore.getState().reset()
  useNotificationStore.getState().clear()
})


async function editMain(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(screen.getByText('gpt-5').closest('tr')!).getByRole('button', { name: /编辑/ }))
  return screen.getByRole('dialog')
}
const toInput = (service: Awaited<ReturnType<ModelSettingsMockAdapter['listModelServices']>>[number]) => ({ name: service.name, provider: service.provider, apiFormat: service.apiFormat, baseUrl: service.baseUrl, active: service.active, models: service.models.map(model => ({ id: model.id, model: model.model, contextTokens: model.contextTokens, outputTokens: model.outputTokens, capabilities: model.capabilities, enabled: model.enabled })) })

describe('模型服务表单', () => {
  it('模型页不显示重复说明，刷新与新建操作同排且 DeepSeek 显示官方输出上限', async () => {
    await renderReady('/settings')
    expect(screen.queryByText('配置 Ely 会话使用的模型服务。')).toBeNull()
    expect(screen.getByRole('button', { name: '刷新模型配置' })).toBeInTheDocument()
    expect(screen.getByText('384k')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '模型 ID' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: '名称 / 服务' })).toBeNull()
    expect(screen.getAllByText('gpt-5')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '编辑 主力模型' })).toBeNull()
  })

  it('新建模型列表为空，手动添加后可移除最后一项，空列表不能提交', async () => {
    const adapter = new ModelSettingsMockAdapter()
    const create = vi.spyOn(adapter, 'createModelService')
    const user = userEvent.setup()
    await renderReady('/settings', makePageGateway(adapter))
    await user.click(screen.getByRole('button', { name: '新建模型配置' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByPlaceholderText('服务名称')).toBeInTheDocument()
    expect(within(dialog).queryByRole('switch', { name: '启用服务' })).toBeNull()
    expect(within(dialog).queryByLabelText('模型 ID')).toBeNull()
    expect(within(dialog).getByText('尚未添加模型，可获取模型或手动添加。')).toBeDefined()
    await user.type(within(dialog).getByLabelText('名称'), '本机模型服务')
    await user.type(within(dialog).getByLabelText('Base URL'), 'http://127.0.0.1:9000/v1')
    await user.click(within(dialog).getByRole('button', { name: '创建模型配置' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请先添加至少一个模型')
    expect(create).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: '添加模型' }))
    expect(within(dialog).getByLabelText('模型 ID')).toHaveValue('')
    expect(within(dialog).queryByRole('alert')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: '移除模型 1' }))
    expect(within(dialog).queryByLabelText('模型 ID')).toBeNull()
    expect(within(dialog).getByText('尚未添加模型，可获取模型或手动添加。')).toBeDefined()
    expect(create).not.toHaveBeenCalled()
  })
  it('自定义服务选择 Responses 并一次创建两个模型，共用 API Key', async () => {
    const adapter = new ModelSettingsMockAdapter()
    const create = vi.spyOn(adapter, 'createModelService')
    const user = userEvent.setup()
    await renderReady('/settings', makePageGateway(adapter))
    await user.click(screen.getByRole('button', { name: '新建模型配置' }))
    const dialog = screen.getByRole('dialog')
    const key = within(dialog).getByLabelText('API Key') as HTMLInputElement
    expect(key.type).toBe('password')
    await user.type(within(dialog).getByLabelText('名称'), '测试服务')
    await user.type(within(dialog).getByLabelText('Base URL'), 'https://api.example.com/v1')
    await user.click(within(dialog).getByLabelText('API 格式'))
    await user.click(screen.getByRole('menuitemradio', { name: 'Responses (/responses)' }))
    await user.click(within(dialog).getByRole('button', { name: '添加模型' }))
    await user.type(within(dialog).getByLabelText('模型 ID'), 'custom-one')
    expect(within(dialog).queryByLabelText('模型名称')).toBeNull()
    expect(within(dialog).queryByRole('group', { name: '模型能力' })).toBeNull()
    expect(within(dialog).getByRole('group', { name: '多模态输入' })).toBeInTheDocument()
    for (const label of ['文本', 'PDF']) expect(within(dialog).queryByRole('checkbox', { name: label })).toBeNull()
    for (const label of ['工具调用', '结构化输出', '原生联网搜索', '对话中系统消息']) expect(within(dialog).queryByRole('checkbox', { name: label })).toBeNull()
    await user.type(key, 'fake-key')
    await user.click(within(dialog).getByRole('button', { name: '显示输入的 API Key' }))
    expect(key.type).toBe('text')
    await user.click(within(dialog).getByRole('button', { name: '隐藏 API Key' }))
    await user.click(within(dialog).getByRole('button', { name: '添加模型' }))
    await user.type(within(dialog).getByLabelText('模型 ID'), 'custom-two')
    await user.click(within(dialog).getByRole('switch', { name: '启用模型 2' }))
    await user.click(within(dialog).getByRole('button', { name: '创建模型配置' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ apiFormat: 'responses', credential: 'fake-key', models: [expect.objectContaining({ model: 'custom-one', enabled: true }), expect.objectContaining({ model: 'custom-two', enabled: false })] }))
    const services = await adapter.listModelServices()
    const saved = services.find(service => service.name === '测试服务')!
    expect(saved.models).toHaveLength(2)
    expect(saved.models.every(model => model.hasCredential && !('credential' in model))).toBe(true)
    for (const model of saved.models) expect(model.capabilities).toMatchObject({ text: true, tools: true, structuredOutput: true, systemMessages: true, webSearch: false, pdf: false })
    expect(within(screen.getByRole('button', { name: '编辑 custom-two' }).closest('tr')!).getByText('已停用')).toBeDefined()
  })
  it('多模态输入与推理等级可编辑，保存时保留已有的模型能力与 PDF 声明', async () => {
    const adapter = new ModelSettingsMockAdapter()
    const service = (await adapter.listModelServices()).find(row => row.models.some(model => model.model === 'gpt-5'))!
    const input = toInput(service)
    const savedCapabilities = { ...input.models[0]!.capabilities, tools: false, structuredOutput: false, webSearch: true, systemMessages: false, pdf: true }
    await adapter.updateModelService(service.id, { ...input, expectedRevision: service.revision, models: [{ ...input.models[0]!, capabilities: savedCapabilities }] })
    const update = vi.spyOn(adapter, 'updateModelService')
    const user = userEvent.setup()
    await renderReady('/settings', makePageGateway(adapter))
    let dialog = await editMain(user)
    await user.click(within(dialog).getByRole('button', { name: '编辑模型 1' }))
    for (const label of ['图片', '视频']) await user.click(within(dialog).getByRole('checkbox', { name: label }))
    await user.click(within(dialog).getByRole('button', { name: '添加推理等级' }))
    await user.type(within(dialog).getByLabelText('新的推理等级'), 'medium{Enter}')
    expect(update).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: '保存模型配置' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(update).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      models: [expect.objectContaining({ capabilities: expect.objectContaining({ ...savedCapabilities, image: true, video: true, pdf: true, reasoningLevels: ['medium'] }) })],
    }))
    dialog = await editMain(user)
    await user.click(within(dialog).getByRole('button', { name: '编辑模型 1' }))
    for (const label of ['图片', '视频']) expect(within(dialog).getByRole('checkbox', { name: label })).toBeChecked()
    await user.click(within(dialog).getByRole('checkbox', { name: '图片' }))
    await user.click(within(dialog).getByRole('button', { name: '移除推理等级 medium' }))
    await user.click(within(dialog).getByRole('button', { name: '保存模型配置' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    dialog = await editMain(user)
    await user.click(within(dialog).getByRole('button', { name: '编辑模型 1' }))
    expect(within(dialog).getByRole('checkbox', { name: '图片' })).not.toBeChecked()
    expect(within(dialog).queryByRole('button', { name: /移除推理等级/ })).toBeNull()
    expect(update).toHaveBeenLastCalledWith(service.id, expect.objectContaining({ models: [expect.objectContaining({ capabilities: expect.objectContaining({ ...savedCapabilities, image: false, video: true, pdf: true, reasoningLevels: [] }) })] }))
  })
  it('DeepSeek 手动添加为空白项，获取后选择多个模型，容量取服务返回且能力按具体模型填充', async () => {
    const adapter = new ModelSettingsMockAdapter()
    const create = vi.spyOn(adapter, 'createModelService')
    const discover = vi.spyOn(adapter, 'discoverModels')
    const user = userEvent.setup()
    await renderReady('/settings', makePageGateway(adapter))
    await user.click(screen.getByRole('button', { name: '新建模型配置' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByLabelText('配置方式'))
    await user.click(screen.getByRole('menuitemradio', { name: 'DeepSeek' }))
    expect(create).not.toHaveBeenCalled()
    expect(within(dialog).queryByPlaceholderText('服务名称')).toBeNull()
    expect(within(dialog).queryByRole('switch', { name: '启用服务' })).toBeNull()
    expect(within(dialog).queryByLabelText('模型 ID')).toBeNull()
    expect(within(dialog).getByText('尚未添加模型，可获取模型或手动添加。')).toBeDefined()
    expect(within(dialog).getByLabelText('Base URL')).toHaveValue('https://api.deepseek.com')
    await user.click(within(dialog).getByRole('button', { name: '添加模型' }))
    expect(within(dialog).getByLabelText('模型 ID')).toHaveValue('')
    expect(within(dialog).queryByLabelText('模型名称')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: '移除模型 1' }))
    await user.click(within(dialog).getByLabelText('API 格式'))
    await user.click(screen.getByRole('menuitemradio', { name: 'Anthropic Messages (/v1/messages)' }))
    expect(within(dialog).getByLabelText('Base URL')).toHaveValue('https://api.deepseek.com/anthropic')
    await user.click(within(dialog).getByLabelText('API 格式'))
    await user.click(screen.getByRole('menuitemradio', { name: 'Responses (/responses)' }))
    expect(within(dialog).getByLabelText('Base URL')).toHaveValue('https://api.deepseek.com')
    fireEvent.change(within(dialog).getByLabelText('Base URL'), { target: { value: 'https://proxy.example.com/v1' } })
    await user.click(within(dialog).getByLabelText('API 格式'))
    await user.click(screen.getByRole('menuitemradio', { name: 'Chat Completions (/chat/completions)' }))
    expect(within(dialog).getByLabelText('Base URL')).toHaveValue('https://proxy.example.com/v1')
    await user.click(within(dialog).getByRole('button', { name: '获取模型' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('获取模型前请先配置 API Key')
    expect(discover).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    await user.type(within(dialog).getByLabelText('API Key'), 'fake-deepseek-key')
    await user.click(within(dialog).getByRole('button', { name: '获取模型' }))
    const choices = within(dialog).getByRole('region', { name: '可选模型' })
    expect(within(dialog).queryByRole('button', { name: '编辑模型 1' })).toBeNull()
    await user.type(within(choices).getByLabelText('搜索可选模型'), 'pro')
    expect(within(choices).queryByLabelText('选择 deepseek-flash')).toBeNull()
    await user.click(within(choices).getByLabelText('选择 deepseek-v4-pro'))
    await user.clear(within(choices).getByLabelText('搜索可选模型'))
    await user.click(within(choices).getByLabelText('选择 deepseek-flash'))
    await user.click(within(choices).getByRole('button', { name: '添加选中模型（2）' }))
    expect(within(choices).getByLabelText('选择 deepseek-flash')).toBeDisabled()
    expect(within(choices).getByRole('button', { name: '添加选中模型' })).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: '编辑模型 1' }))
    expect(within(dialog).getByLabelText('上下文上限（token）')).toHaveValue(1048576)
    expect(within(dialog).getByLabelText('输出上限（token）')).toHaveValue(393216)
    expect(within(dialog).getByRole('checkbox', { name: '图片' })).toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: '编辑模型 2' }))
    expect(within(dialog).getByRole('checkbox', { name: '图片' })).not.toBeChecked()
    expect(within(dialog).getByRole('button', { name: '移除推理等级 max' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '创建模型配置' }))
    expect(await screen.findByRole('button', { name: '编辑 deepseek-v4-pro' })).toBeDefined()
    const capabilities = expect.objectContaining({ tools: true, structuredOutput: true, systemMessages: true, webSearch: false })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek', models: [expect.objectContaining({ model: 'deepseek-flash', capabilities }), expect.objectContaining({ model: 'deepseek-v4-pro', capabilities })] }))
    expect(screen.queryByDisplayValue('fake-deepseek-key')).toBeNull()
  })
  it('编辑沿用凭据获取，支持替换与留空沿用；空目录与读取失败保留草稿', async () => {
    const adapter = new ModelSettingsMockAdapter()
    const discover = vi.spyOn(adapter, 'discoverModels').mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('模型服务鉴权失败，请检查配置凭据')).mockResolvedValue([])
    const user = userEvent.setup()
    await renderReady('/settings', makePageGateway(adapter))
    const dialog = await editMain(user)
    const service = (await adapter.listModelServices()).find(service => service.models.some(model => model.model === 'gpt-5'))!
    await user.click(within(dialog).getByRole('button', { name: '获取模型' }))
    expect(discover.mock.calls[0]?.[0]).toEqual({ provider: service.provider, apiFormat: service.apiFormat, baseUrl: service.baseUrl, serviceId: service.id, expectedRevision: service.revision })
    expect(within(dialog).getByText('服务没有返回可用模型，可以手动添加。')).toBeDefined()
    await user.type(within(dialog).getByLabelText('API Key'), 'fake-replacement')
    await user.click(within(dialog).getByRole('button', { name: '获取模型' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('模型服务鉴权失败')
    expect(within(dialog).getByLabelText('API Key')).toHaveValue('fake-replacement')
    expect(discover.mock.calls[1]?.[0].credential).toBe('fake-replacement')
    await user.clear(within(dialog).getByLabelText('API Key'))
    await user.click(within(dialog).getByRole('button', { name: '获取模型' }))
    expect(discover.mock.calls[2]?.[0]).not.toHaveProperty('credential')
  })
  it('获取期间阻止重复请求，连接信息改变后丢弃旧结果', async () => {
    const adapter = new ModelSettingsMockAdapter()
    let resolve!: (rows: { model: string; name: string }[]) => void
    const discover = vi.spyOn(adapter, 'discoverModels').mockReturnValue(new Promise(done => { resolve = done }))
    const user = userEvent.setup()
    await renderReady('/settings', makePageGateway(adapter))
    const dialog = await editMain(user)
    await user.click(within(dialog).getByRole('button', { name: '获取模型' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '获取中…' }))
    expect(discover).toHaveBeenCalledTimes(1)
    fireEvent.change(within(dialog).getByLabelText('Base URL'), { target: { value: 'https://changed.example.com' } })
    expect(discover.mock.calls[0]?.[1]?.aborted).toBe(true)
    resolve([{ model: 'stale-model', name: '过时结果' }])
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '获取模型' })).toBeEnabled())
    expect(within(dialog).queryByRole('region', { name: '可选模型' })).toBeNull()
  })
  it('编辑服务保留与替换共用凭据，留空保存不清除，并修改 API 格式', async () => {
    const adapter = new ModelSettingsMockAdapter()
    const update = vi.spyOn(adapter, 'updateModelService')
    const user = userEvent.setup()
    await renderReady('/settings', makePageGateway(adapter))
    let dialog = await editMain(user)
    expect(within(dialog).getByLabelText('API Key')).toHaveValue('')
    await user.click(within(dialog).getByLabelText('API 格式'))
    await user.click(screen.getByRole('menuitemradio', { name: 'Anthropic Messages (/v1/messages)' }))
    await user.click(within(dialog).getByRole('button', { name: '保存模型配置' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty('credential')
    dialog = await editMain(user)
    await user.type(within(dialog).getByLabelText('API Key'), 'fake-replacement')
    await user.click(within(dialog).getByRole('button', { name: '保存模型配置' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(update.mock.calls[1]?.[1].credential).toBe('fake-replacement')
    dialog = await editMain(user)
    await user.clear(within(dialog).getByLabelText('API Key'))
    await user.click(within(dialog).getByRole('button', { name: '保存模型配置' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(update.mock.calls[2]?.[1]).not.toHaveProperty('credential')
    expect(within(screen.getByText('gpt-5').closest('tr')!).getByText('已配置 API Key')).toBeDefined()
  })
  it('CAS 冲突保留服务与模型草稿，明确采用最新修订后再保存', async () => {
    const adapter = new ModelSettingsMockAdapter()
    const user = userEvent.setup()
    await renderReady('/settings', makePageGateway(adapter))
    const service = (await adapter.listModelServices())[0]!
    await user.click(within(screen.getByText(service.models[0]!.model).closest('tr')!).getByRole('button', { name: /编辑/ }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '保留的服务草稿' } })
    await user.click(within(dialog).getByRole('button', { name: '编辑模型 1' }))
    fireEvent.change(within(dialog).getByLabelText('模型 ID'), { target: { value: 'retained-model-draft' } })
    await adapter.updateModelService(service.id, { ...toInput(service), name: '其他修改', expectedRevision: service.revision })
    await user.click(within(dialog).getByRole('button', { name: '保存模型配置' }))
    const adopt = await within(dialog).findByRole('button', { name: `使用修订 ${service.revision + 1} 继续编辑` })
    expect(within(dialog).getByLabelText('名称')).toHaveValue('保留的服务草稿')
    expect(within(dialog).getByLabelText('模型 ID')).toHaveValue('retained-model-draft')
    await user.click(adopt)
    await user.click(within(dialog).getByRole('button', { name: '保存模型配置' }))
    expect(await screen.findByRole('button', { name: '编辑 retained-model-draft' })).toBeDefined()
  })
  it('模型目录为空仍可创建，读取失败显示重试', async () => {
    const adapter = new ModelSettingsMockAdapter()
    vi.spyOn(adapter, 'listModelServices').mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('模型目录断开'))
    const user = userEvent.setup()
    renderCapabilitiesPage('/settings', makePageGateway(adapter))
    expect(await screen.findByText('还没有模型配置')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '刷新模型配置' }))
    expect(await screen.findByText('模型目录断开')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('gpt-5')).toBeDefined()
  })
})
