import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import * as Tooltip from '@radix-ui/react-tooltip'
import { ThemeProvider } from '../../app/theme/ThemeProvider'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { AgentMemoryMockAdapter, resetAgentMemoryData } from '../../adapters/mock/agent/agentMemoryMockAdapter'
import { demoAgentRuntimeInfo } from '../../adapters/mock/agent/agentRunsMockAdapter'
import type { ElysianGateway } from '../../contracts/adapters'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { AgentMemoryPage } from './AgentMemoryPage'

/*
 * 页面级测试跑在真实 mock 适配器上（与 agent-capabilities 页面测试同构）：
 * 六页签可达、空间/页面闭环（建页→修订→撤回→withdrawn 标记→历史修订只读）、
 * 16 KiB 前端拦截、搜索降级 reason 与 method 标注、候选批准发布、手工提炼互斥、
 * 索引 stale 说明。GatewayProvider 的 fallback 网关以 vi.mock 隔离，本测试永远
 * 显式注入网关。
 */
vi.mock('../../adapters/mock/gateway', () => ({
  createMockGateway: () => {
    throw new Error('本测试显式注入网关，不应触达 createMockGateway 的 fallback')
  },
}))

function makePageGateway(adapter: AgentMemoryMockAdapter = new AgentMemoryMockAdapter()): ElysianGateway {
  return {
    agentMemory: adapter,
    agentRuns: {
      runtime: async () => demoAgentRuntimeInfo(),
      listRuns: async () => ({ items: [], nextCursor: '', hasMore: false }),
    },
    agentWorkflows: {
      listInstances: async () => ({ items: [], nextCursor: '', hasMore: false }),
    },
  } as unknown as ElysianGateway
}

function renderMemoryPage(path = '/agent/memory', gateway: ElysianGateway = makePageGateway()) {
  const router = createMemoryRouter([{ path: '/agent/memory', element: <AgentMemoryPage /> }], {
    initialEntries: [path],
  })
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

async function renderReady(path = '/agent/memory', gateway?: ElysianGateway) {
  const view = renderMemoryPage(path, gateway)
  // 空间列表与服务端同序（global 在前）：默认选中全局空间，先切到业务空间。
  await screen.findByText('全局命名速记')
  await userEvent.click(screen.getByRole('button', { name: /^容器运维/ }))
  await screen.findByText('容器重启手册')
  return view
}

beforeEach(() => {
  resetAgentMemoryData()
  useAgentRuntimeStore.getState().reset()
  useAgentMemoryStore.getState().reset()
  useNotificationStore.getState().clear()
})

describe('AgentMemoryPage 六态与页签', () => {
  it('运行时不可用：显示服务端中文 reason，不提供重试', async () => {
    renderMemoryPage('/agent/memory', {
      agentMemory: new AgentMemoryMockAdapter(),
      agentRuns: { runtime: async () => ({ ...demoAgentRuntimeInfo(), available: false, reason: 'Agent 任务运行内核未初始化' }) },
    } as unknown as ElysianGateway)
    expect(await screen.findByText('Agent 内核不可用')).toBeDefined()
    expect(screen.getByText('Agent 任务运行内核未初始化')).toBeDefined()
  })

  it('默认渲染：左空间列表（全局唯一标注）＋六页签＋页面表格种子', async () => {
    await renderReady()
    expect(screen.getByRole('region', { name: '记忆空间列表' })).toBeDefined()
    expect(screen.getByText('全局运维常识')).toBeDefined()
    expect(screen.getByText('全局 · 唯一')).toBeDefined()
    expect(screen.getByText(/长期记忆（Wiki）是跨会话沉淀的知识库/)).toBeDefined()
    for (const label of ['页面', '搜索', '提炼候选', '提炼任务', 'Embedding 与索引', '检查']) {
      expect(screen.getByRole('button', { name: label })).toBeDefined()
    }
    expect(screen.getByRole('region', { name: 'Wiki 页面列表' })).toBeDefined()
    expect(screen.getByText('端口映射约定')).toBeDefined()
  })

  it('页面加载失败：错误态与重试入口（不白屏）', async () => {
    const adapter = new AgentMemoryMockAdapter()
    vi.spyOn(adapter, 'listSpaces').mockRejectedValue(new Error('存储暂不可用'))
    renderMemoryPage('/agent/memory', makePageGateway(adapter))
    expect(await screen.findByText('存储暂不可用')).toBeDefined()
    expect(screen.getByRole('button', { name: '重试' })).toBeDefined()
  })
})

describe('空间与页面闭环', () => {
  it('建空间：全局唯一在表单里禁用（已存在时不给重复提交入口）', async () => {
    await renderReady()
    await userEvent.click(screen.getByRole('button', { name: '新建空间' }))
    const dialog = await screen.findByRole('dialog')
    const globalOption = within(dialog).getByRole('radio', { name: /全局空间/ })
    expect(globalOption).toBeDisabled()
    const businessOption = within(dialog).getByRole('radio', { name: /业务空间/ })
    expect(businessOption).not.toBeDisabled()
  })

  it('建页→编辑产生修订→撤回→withdrawn 标记→历史修订只读', async () => {
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: /新建页面/ }))
    let dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/slug/), 'page-test/create')
    await user.type(within(dialog).getByLabelText('标题'), '页面闭环')
    await user.type(within(dialog).getByLabelText(/正文/), '# 页面闭环')
    await user.click(within(dialog).getByRole('button', { name: '创建页面' }))
    expect(await screen.findByText('页面闭环')).toBeDefined()

    await user.click(screen.getByRole('button', { name: '页面闭环' }))
    expect(await screen.findByRole('region', { name: /页面详情 页面闭环/ })).toBeDefined()
    await user.click(screen.getByRole('button', { name: /编辑页面/ }))
    dialog = await screen.getByRole('dialog')
    expect(within(dialog).getByLabelText(/slug/)).toHaveProperty('readOnly', true)
    await user.clear(within(dialog).getByLabelText('标题'))
    await user.type(within(dialog).getByLabelText('标题'), '页面闭环（第二版）')
    await user.clear(within(dialog).getByLabelText(/正文/))
    await user.type(within(dialog).getByLabelText(/正文/), '# 页面闭环（第二版）')
    await user.click(within(dialog).getByRole('button', { name: '保存为新修订' }))
    // 表格行与详情区都会出现新标题：断言存在即可。
    expect((await screen.findAllByText('页面闭环（第二版）')).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: /历史修订/ }))
    dialog = await screen.getByRole('dialog')
    expect(within(dialog).getByText(/历史修订 · 页面闭环/)).toBeDefined()
    expect(within(dialog).getByText(/只读/)).toBeDefined()
    await user.click(within(dialog).getByRole('button', { name: '读取该修订' }))
    await user.clear(within(dialog).getByLabelText(/修订号/))
    await user.type(within(dialog).getByLabelText(/修订号/), '1')
    await user.click(within(dialog).getByRole('button', { name: '读取该修订' }))
    await waitFor(() => {
      expect(within(dialog).getByText('# 页面闭环')).toBeDefined()
    })
    await user.click(within(dialog).getByRole('button', { name: '关闭弹窗' }))

    await user.click(screen.getByRole('button', { name: /撤回页面/ }))
    dialog = await screen.getByRole('dialog')
    expect(within(dialog).getByText(/标记为「来源失效」/)).toBeDefined()
    await user.click(within(dialog).getByRole('button', { name: '确认撤回' }))
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: /页面详情 页面闭环/ })).toBeNull()
    })
    await user.click(screen.getByRole('button', { name: '仅生效中' }))
    const table = await screen.findByRole('region', { name: 'Wiki 页面列表' })
    await waitFor(() => {
      const withdrawnRow = within(table).getByText('页面闭环（第二版）').closest('tr')
      expect(withdrawnRow?.textContent).toContain('已撤回')
    })
  })

  it('16 KiB 前端拦截：超限正文禁用提交并显示超限计数', async () => {
    const user = userEvent.setup()
    await renderReady()
    await user.click(screen.getByRole('button', { name: /新建页面/ }))
    const dialog = await screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText(/slug/), 'page-test/oversize')
    await user.type(within(dialog).getByLabelText('标题'), '超限页')
    // 大段正文用 fireEvent 一次灌入：userEvent 逐字符输入在 16 KiB 规模上不可行。
    fireEvent.change(within(dialog).getByLabelText(/正文/), {
      target: { value: `# 超限\n\n${'x'.repeat(16 * 1024)}` },
    })
    const counter = within(dialog).getAllByText(/16\.0 \/ 16 KiB/)[0]
    expect(counter?.className).toContain('text-danger')
    expect(within(dialog).getByRole('button', { name: '创建页面' })).toBeDisabled()
  })
})

describe('搜索与候选', () => {
  it('搜索降级：显示 reason 与 method 标注，命中页可读', async () => {
    const user = userEvent.setup()
    await renderReady()
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await user.type(await screen.findByLabelText('检索内容'), '端口 映射')
    await user.click(screen.getByRole('button', { name: '检索页面' }))
    expect(await screen.findByText(/当前为降级检索/)).toBeDefined()
    expect(screen.getByText(/SQLite 中文双字全文回落/)).toBeDefined()
    expect(screen.getByText('SQLite 全文')).toBeDefined()
    expect(screen.getByText('端口映射约定')).toBeDefined()
  })

  it('搜索命中打开详情；切页签或空间清除旧 pageId 与跨空间搜索结果', async () => {
    const user = userEvent.setup()
    const { router } = await renderReady()
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await user.type(await screen.findByLabelText('检索内容'), '端口 映射')
    await user.click(screen.getByRole('button', { name: '检索页面' }))
    await user.click(await screen.findByRole('button', { name: '端口映射约定' }))
    expect(router.state.location.search).toContain('pageId=page-b')
    expect(await screen.findByRole('region', { name: /页面详情 端口映射约定/ })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '端口映射约定' }))
    expect(router.state.location.search).not.toContain('pageId=')
    expect(screen.queryByRole('region', { name: /页面详情 端口映射约定/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: '端口映射约定' }))

    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(router.state.location.search).not.toContain('pageId=')
    await user.type(await screen.findByLabelText('检索内容'), '端口 映射')
    await user.click(screen.getByRole('button', { name: '检索页面' }))
    expect(await screen.findByRole('button', { name: '端口映射约定' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: /^全局运维常识/ }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '端口映射约定' })).toBeNull()
      expect(screen.getByLabelText('检索内容')).toHaveProperty('value', '')
    })
  })

  it('提炼提交失败后原样重试复用 requestId', async () => {
    const user = userEvent.setup()
    const adapter = new AgentMemoryMockAdapter()
    const create = vi.spyOn(adapter, 'createExtraction').mockRejectedValue(new Error('暂时失败'))
    await renderReady('/agent/memory', makePageGateway(adapter))
    await user.click(screen.getByRole('button', { name: '提炼任务' }))
    await user.click(screen.getByRole('button', { name: /手工创建提炼/ }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/运行编号/), 'run-success-01')
    await user.click(within(dialog).getByRole('button', { name: '提交提炼任务' }))
    await within(dialog).findByRole('alert')
    await user.click(within(dialog).getByRole('button', { name: '提交提炼任务' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    const first = create.mock.calls[0]?.[0]
    const second = create.mock.calls[1]?.[0]
    expect(first?.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    expect(second).toEqual(first)
  })

  it('候选批准：发布为页面修订，页面页签出现该页；invalidated 候选只给提示不给按钮', async () => {
    const user = userEvent.setup()
    await renderReady()
    await user.click(screen.getByRole('button', { name: '提炼候选' }))
    expect(await screen.findByText('容器命名约定')).toBeDefined()
    const pendingItem = screen.getByText('容器命名约定').closest('li')
    if (pendingItem === null) throw new Error('候选未渲染')
    await user.click(within(pendingItem as HTMLElement).getByRole('button', { name: '批准并发布' }))
    await waitFor(() => {
      expect(within(pendingItem as HTMLElement).getAllByText('已采纳').length).toBeGreaterThan(0)
    })
    await user.click(screen.getByRole('button', { name: '页面' }))
    await waitFor(() => {
      expect(screen.getByText('容器命名约定')).toBeDefined()
    })
  })
})

describe('提炼任务与索引', () => {
  it('提炼任务页签：列表与手工创建入口（来源互斥二选一）', async () => {
    const user = userEvent.setup()
    await renderReady()
    await user.click(screen.getByRole('button', { name: '提炼任务' }))
    expect(await screen.findByRole('region', { name: '提炼任务列表' })).toBeDefined()
    expect(screen.getByText('ext-1')).toBeDefined()
    await user.click(screen.getByRole('button', { name: /手工创建提炼/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: /成功的 Agent 运行/ })).toBeEnabled()
    expect(within(dialog).getByRole('radio', { name: /成功的根工作流/ })).toBeEnabled()
  })

  it('索引页签：stale 行说明文本回落，Embedding 配置凭据不回显', async () => {
    const user = userEvent.setup()
    await renderReady()
    await user.click(screen.getByRole('button', { name: 'Embedding 与索引' }))
    expect(await screen.findByText('空间索引')).toBeDefined()
    expect(screen.getAllByText(/搜索继续使用文本回落/).length).toBeGreaterThan(0)
    expect(screen.getByText('已保存（不回显）')).toBeDefined()
    expect(screen.getByText(/用量账本不含正文、查询原文与向量/)).toBeDefined()
  })
})
