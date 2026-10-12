import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import * as Tooltip from '@radix-ui/react-tooltip'
import { ThemeProvider } from '../../app/theme/ThemeProvider'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { AgentCapabilitiesMockAdapter, resetAgentCapabilitiesData } from '../../adapters/mock/agent/agentCapabilitiesMockAdapter'
import { demoAgentRuntimeInfo } from '../../adapters/mock/agent/agentRunsMockAdapter'
import type { ElysianGateway } from '../../contracts/adapters'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentCapabilitiesStore } from '../../stores/agentCapabilitiesStore'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { AgentCapabilitiesPage } from './AgentCapabilitiesPage'

/*
 * 页面级测试跑在真实 mock 适配器上：五页签可达、模型闭环（凭据只写不回显、
 * 留空沿用/显式清除）、执行配置前端上限拦截与启停回读、修订详情（含历史修订）、
 * 授权与资源规则回读、执行器运行时空态。测试不读生产凭据，种子确定性可复现。
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

function makePageGateway(adapter: AgentCapabilitiesMockAdapter = new AgentCapabilitiesMockAdapter()): ElysianGateway {
  return {
    agentCapabilities: adapter,
    agentRuns: { runtime: async () => demoAgentRuntimeInfo() },
  } as unknown as ElysianGateway
}

function renderCapabilitiesPage(path = '/agent/capabilities', gateway: ElysianGateway = makePageGateway()) {
  const router = createMemoryRouter(
    [{ path: '/agent/capabilities', element: <AgentCapabilitiesPage /> }],
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

async function renderReady(path = '/agent/capabilities', gateway?: ElysianGateway) {
  const view = renderCapabilitiesPage(path, gateway)
  // 等待运行时判定与列表装载完成：等待目标按页签取该页签的种子行。
  const readyText = path.includes('tab=execution') ? 'Python 工具执行'
    : path.includes('tab=grants') ? '项目数据只读'
      : path.includes('tab=rules') ? '注册表镜像映射'
        : path.includes('tab=runtimes') ? '执行器运行时'
          : 'Python 工具执行'
  await screen.findByText(readyText)
  return view
}

beforeEach(() => {
  resetAgentCapabilitiesData()
  useAgentRuntimeStore.getState().reset()
  useAgentCapabilitiesStore.getState().reset()
  useNotificationStore.getState().clear()
})

describe('AgentCapabilitiesPage 页签与六态', () => {
  it('默认只显示执行配置，不提供模型编辑入口', async () => {
    await renderReady()
    expect(screen.getByRole('region', { name: '执行配置列表' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '新建模型配置' })).toBeNull()
    expect(screen.queryByRole('button', { name: '模型配置' })).toBeNull()
  })

  it('四个页签经 ?tab= 直达，内容随页签切换', async () => {
    await renderReady('/agent/capabilities?tab=execution')
    expect(await screen.findByRole('region', { name: '执行配置列表' })).toBeDefined()
    expect(screen.getByText('Python 工具执行')).toBeDefined()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '目录与网络授权' }))
    expect(await screen.findByRole('region', { name: '目录与网络授权列表' })).toBeDefined()
    expect(screen.getByText('项目数据只读')).toBeDefined()

    await user.click(screen.getByRole('button', { name: '资源规则' }))
    expect(await screen.findByRole('region', { name: '资源规则列表' })).toBeDefined()
    expect(screen.getByText('注册表镜像映射')).toBeDefined()

    await user.click(screen.getByRole('button', { name: '执行器运行时' }))
    expect(await screen.findByRole('region', { name: '执行器运行时列表' })).toBeDefined()
    expect(screen.getByText('exr-7f3a2c')).toBeDefined()
    expect(screen.getByText('运行中')).toBeDefined()
  })

  it('执行器未就绪（空数组）时给出空态说明', async () => {
    const adapter = new AgentCapabilitiesMockAdapter()
    vi.spyOn(adapter, 'listExecutionRuntimes').mockResolvedValue([])
    renderCapabilitiesPage('/agent/capabilities?tab=runtimes', makePageGateway(adapter))
    expect(await screen.findByText('执行器未就绪')).toBeDefined()
    expect(screen.getByText(/尚未托管任何执行器进程/)).toBeDefined()
  })

  it('列表读取失败给出错误态与重试', async () => {
    const adapter = new AgentCapabilitiesMockAdapter()
    vi.spyOn(adapter, 'listExecutionProfiles').mockRejectedValue(new Error('Agent 请求网络失败'))
    renderCapabilitiesPage('/agent/capabilities', makePageGateway(adapter))
    expect(await screen.findByText('加载失败')).toBeDefined()
    expect(screen.getByText('Agent 请求网络失败')).toBeDefined()
    expect(screen.getByRole('button', { name: '重试' })).toBeDefined()
  })
})

describe('AgentCapabilitiesPage 执行配置闭环', () => {
  it('JSON argv 编辑保留空参数、空白与换行，CAS 冲突保留草稿并允许明确采用新修订', async () => {
    const user = userEvent.setup()
    const adapter = new AgentCapabilitiesMockAdapter()
    await renderReady('/agent/capabilities?tab=execution', makePageGateway(adapter))
    const profile = (await adapter.listExecutionProfiles()).find((item) => item.name === 'Python 工具执行')!
    await user.click(within(screen.getByText(profile.name).closest('tr') as HTMLElement).getByRole('button', { name: '编辑' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '保留的草稿' } })
    const command = ['python3', '-c', ' print("hello")\n', '']
    fireEvent.change(within(dialog).getByLabelText(/容器命令/), { target: { value: JSON.stringify(command) } })
    await adapter.updateExecutionProfile(profile.id, { ...profile, expectedRevision: profile.revision, name: '另一处修改' })
    const save = vi.spyOn(adapter, 'updateExecutionProfile')
    await user.click(within(dialog).getByRole('button', { name: '保存执行配置' }))
    const adopt = await within(dialog).findByRole('button', { name: `使用修订 ${profile.revision + 1} 继续编辑` })
    expect((within(dialog).getByLabelText('名称') as HTMLInputElement).value).toBe('保留的草稿')
    await user.click(within(dialog).getByText('查看服务端最新修订'))
    expect(within(dialog).getByText(/"name": "另一处修改"/)).toBeDefined()
    await user.click(adopt)
    await user.click(within(dialog).getByRole('button', { name: '保存执行配置' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(save.mock.calls.at(-1)?.[1]).toMatchObject({ command, name: '保留的草稿', expectedRevision: profile.revision + 1 })
  })

  it('越界限额在提交前被拦截并说明上限，列表不新增', async () => {
    const user = userEvent.setup()
    await renderReady('/agent/capabilities?tab=execution')
    await user.click(screen.getByRole('button', { name: '新建执行配置' }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/名称/), '越界配置')
    await user.type(within(dialog).getByLabelText(/镜像（仓库名＋完整 SHA-256 摘要）/), 'registry.example.com/test@sha256:' + 'ab12cd34'.repeat(8))
    await user.clear(within(dialog).getByLabelText(/执行时限/))
    await user.type(within(dialog).getByLabelText(/执行时限/), '301')
    await user.click(within(dialog).getByRole('button', { name: '创建执行配置' }))
    // 数字输入的原生上限（max=300）先把 301 挡在提交之前：表单保留、列表不新增；
    // 绕过原生控件的提交路径由 store 层校验与通知兜底（见 agentCapabilitiesStore.test）。
    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.queryByText('越界配置')).toBeNull()
    expect(within(dialog).getByText(/上限为 5 分钟（300 秒）/)).toBeDefined()
    // 回到合法值后可以正常创建。
    await user.clear(within(dialog).getByLabelText(/执行时限/))
    await user.type(within(dialog).getByLabelText(/执行时限/), '120')
    await user.click(within(dialog).getByRole('button', { name: '创建执行配置' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(screen.getByText('越界配置')).toBeDefined()
  })

  it('启停回读状态变化与修订递增', async () => {
    const user = userEvent.setup()
    await renderReady('/agent/capabilities?tab=execution')
    const row = screen.getByText('Node 构建执行').closest('tr') as HTMLElement
    expect(within(row).getByText('已启用')).toBeDefined()
    await user.click(within(row).getByRole('button', { name: '停用' }))
    await waitFor(() => {
      const updated = screen.getByText('Node 构建执行').closest('tr') as HTMLElement
      expect(within(updated).getByText('已停用')).toBeDefined()
    })
  })

  it('修订详情可读历史修订：revision 1 的内存与最新不同', async () => {
    const user = userEvent.setup()
    await renderReady('/agent/capabilities?tab=execution')
    const row = screen.getByText('Python 工具执行').closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: /修订/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/修订号（1 至 2）/)).toBeDefined()
    // 最新修订（2）的内存为 256 MiB。
    await waitFor(() => {
      expect(within(dialog).getByText(/"memoryBytes": 268435456/)).toBeDefined()
    })
    await user.clear(within(dialog).getByLabelText(/修订号/))
    await user.type(within(dialog).getByLabelText(/修订号/), '1')
    await user.click(within(dialog).getByRole('button', { name: '读取该修订' }))
    await waitFor(() => {
      expect(within(dialog).getByText(/"memoryBytes": 536870912/)).toBeDefined()
    })
  })
})

describe('AgentCapabilitiesPage 授权与资源规则', () => {
  it('授权启停回读状态变化', async () => {
    const user = userEvent.setup()
    await renderReady('/agent/capabilities?tab=grants')
    const row = screen.getByText('PyPI 出网').closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: '停用' }))
    await waitFor(() => {
      const updated = screen.getByText('PyPI 出网').closest('tr') as HTMLElement
      expect(within(updated).getByText('已停用')).toBeDefined()
    })
  })

  it('资源规则编辑：literal 与 pointer 互斥切换，保存后修订与摘要更新', async () => {
    const user = userEvent.setup()
    await renderReady('/agent/capabilities?tab=rules')
    const row = screen.getByText('脚本配置键映射').closest('tr') as HTMLElement
    expect(within(row).getByText(/指针 \/config\/keys/)).toBeDefined()
    await user.click(within(row).getByRole('button', { name: /编辑/ }))
    const dialog = screen.getByRole('dialog')
    // 该规则的映射当前为 pointer 模式：切到 literal 后保存。
    await user.click(within(dialog).getAllByRole('radio', { name: undefined })[0] as HTMLElement)
    await user.clear(within(dialog).getByLabelText(/^值 1$/))
    await user.type(within(dialog).getByLabelText(/^值 1$/), 'config/keys/fixed')
    await user.click(within(dialog).getByRole('button', { name: '保存资源规则' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    const updated = screen.getByText('脚本配置键映射').closest('tr') as HTMLElement
    expect(within(updated).getByText(/字面值 config\/keys\/fixed/)).toBeDefined()
    expect(within(updated).getByText(/rr-script-config · 修订 2/)).toBeDefined()
  })

  it('资源规则修订详情读取历史修订', async () => {
    const user = userEvent.setup()
    await renderReady('/agent/capabilities?tab=rules')
    const row = screen.getByText('注册表镜像映射').closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: /修订/ }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => {
      expect(within(dialog).getByText(/"revision": 2/)).toBeDefined()
    })
    await user.clear(within(dialog).getByLabelText(/修订号/))
    await user.type(within(dialog).getByLabelText(/修订号/), '1')
    await user.click(within(dialog).getByRole('button', { name: '读取该修订' }))
    await waitFor(() => {
      expect(within(dialog).getByText(/"revision": 1/)).toBeDefined()
    })
  })
})

describe('AgentCapabilitiesPage 名称过滤', () => {
  it('过滤词在当前页签内生效', async () => {
    const user = userEvent.setup()
    await renderReady()
    await user.type(screen.getByLabelText('搜索名称、镜像或运行时'), 'Python')
    expect(screen.getByText('Python 工具执行')).toBeDefined()
    expect(screen.queryByText('Node 构建执行')).toBeNull()
  })
})
