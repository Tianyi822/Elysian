import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router'
import * as Tooltip from '@radix-ui/react-tooltip'
import { createMockGateway } from '../../adapters/mock/gateway'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { AgentExtensionsMockAdapter } from '../../adapters/mock/agent/agentExtensionsMockAdapter'
import type { ElysianGateway } from '../../contracts/adapters'
import { ThemeProvider } from '../../app/theme/ThemeProvider'
import { AgentExtensionsPage } from './AgentExtensionsPage'
import { advancePoll, resetAgentTestState } from '../../test/agentTestUtils'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentExtensionsStore } from '../../stores/agentExtensionsStore'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'

/*
 * 技能与 MCP 页面测试（mock 网关 + fake timers 驱动 3 秒静默轮询）：
 * 技能目录六态、ZIP 导入闭环（受理 → 轮询 → 终态 → 目录出现新技能）、失败与取消、
 * 连点单飞与 requestId 幂等、启停/删除回读、MCP 新建/探测/固定目录与 resource-busy
 * 深链、stdio 表单 grant 回显、深链参数（?tab=mcp&serverId=&revision= 与 ?importId=）。
 * 本文件经 MemoryRouter 只挂本页模块（renderApp 会连带兄弟模块的整棵路由，并行
 * 施工期互相阻塞）；/agent/extensions 的路由接线由 app/router.test.tsx 承接。
 */

const IMPORT_POLL_MS = 3_000

beforeEach(() => {
  vi.useFakeTimers()
  resetAgentTestState()
  // 本域 store 是模块级单例：残留的弹窗状态（probe/catalog）会把 Radix 模态留在
  // 屏上，下一用例整页被 aria-hidden，role 查询全部失效。
  useAgentExtensionsStore.getState().reset()
})

afterEach(() => {
  vi.useRealTimers()
})

/** 刷微任务轮次：crypto.subtle 的别名摘要链需要多个 await 轮才落到 store。 */
async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {})
  }
}

/**
 * 轮到条件满足为止。摘要链在并行满载下要等事件轮回合，固定轮数会闪失败；
 * 条件轮询给出充足预算，超限才以断言失败显形。
 */
async function until(condition: () => boolean, rounds = 300): Promise<void> {
  for (let index = 0; index < rounds && !condition(); index += 1) {
    await act(async () => {})
  }
  expect(condition(), '等待条件超时').toBe(true)
}

let lastSearch = ''

function LocationProbe() {
  const location = useLocation()
  lastSearch = location.search
  return null
}

async function renderPage(path = '/agent/extensions', gateway?: ElysianGateway) {
  const resolved = gateway ?? createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const view = render(
    <ThemeProvider>
      <Tooltip.Provider delayDuration={0}>
        <GatewayProvider gateway={resolved}>
          <MemoryRouter initialEntries={[path]}>
            <LocationProbe />
            <AgentExtensionsPage />
          </MemoryRouter>
        </GatewayProvider>
      </Tooltip.Provider>
    </ThemeProvider>,
  )
  await flush()
  await flush()
  return view
}

async function openImportPanel(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  await flush()
}

describe('技能页签', () => {
  it('共享运行时状态恢复后自动回到技能目录', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const ready = await gateway.agentRuns.runtime()
    const runtime = vi.spyOn(gateway.agentRuns, 'runtime')
      .mockResolvedValueOnce({ ...ready, available: false, reason: '正在恢复存储' })
      .mockResolvedValue(ready)
    await renderPage('/agent/extensions', gateway)
    expect(screen.getByText('Agent 内核不可用')).toBeInTheDocument()
    await act(async () => {
      await useAgentRuntimeStore.getState().load(gateway, { silent: true, signal: new AbortController().signal })
    })
    await flush()
    expect(screen.getByRole('region', { name: '技能目录' })).toBeInTheDocument()
    expect(runtime.mock.calls[1]?.[0]).toBeInstanceOf(AbortSignal)
  })

  it('渲染种子技能目录与导入任务记录；页签切换写入 ?tab=mcp', async () => {
    await renderPage()
    expect(screen.getByRole('region', { name: '技能目录' })).toBeInTheDocument()
    expect(screen.getByText('incident-triage')).toBeInTheDocument()
    expect(screen.getByText('backup-verify')).toBeInTheDocument()
    expect(screen.getByText('import-demo-2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'MCP 服务' }))
    await flush()
    expect(lastSearch).toBe('?tab=mcp')
    expect(screen.getByRole('region', { name: 'MCP 服务列表' })).toBeInTheDocument()
    expect(screen.getByText('演示检索（HTTP）')).toBeInTheDocument()
  })

  it('ZIP 导入闭环：受理后轮询 queued→running→成功，技能目录出现新技能且启用', async () => {
    await renderPage()
    await openImportPanel()
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'demo-skill.zip', { type: 'application/zip' })
    fireEvent.change(screen.getByLabelText('ZIP 文件（不超过 64 MiB）'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await flush()
    const imports = screen.getByRole('region', { name: '导入任务' })
    expect(within(imports).getAllByText('排队中').length).toBeGreaterThan(0)

    await act(async () => { await advancePoll(IMPORT_POLL_MS) })
    expect(within(screen.getByRole('region', { name: '导入任务' })).getAllByText('执行中').length).toBeGreaterThan(0)

    await act(async () => { await advancePoll(IMPORT_POLL_MS) })
    const finished = screen.getByRole('region', { name: '导入任务' })
    expect(within(finished).getAllByText('已成功').length).toBeGreaterThan(0)
    // 导入成功的权威事实：技能目录出现新技能（uploaded-skill），默认启用。
    expect(screen.getByText('uploaded-skill')).toBeInTheDocument()
    const notifications = useNotificationStore.getState().notifications
    expect(notifications.some((item) => item.tone === 'success' && item.message.includes('技能导入完成'))).toBe(true)
  })

  it('导入失败显示中文错误，终态记录可删除', async () => {
    await renderPage()
    await openImportPanel()
    fireEvent.click(screen.getByRole('button', { name: '宿主目录' }))
    fireEvent.change(screen.getByLabelText('宿主绝对目录'), { target: { value: '/opt/skills/broken-pack' } })
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await flush()
    await act(async () => { await advancePoll(IMPORT_POLL_MS) })
    await act(async () => { await advancePoll(IMPORT_POLL_MS) })
    const imports = screen.getByRole('region', { name: '导入任务' })
    expect(within(imports).getAllByText('已失败').length).toBeGreaterThan(0)
    expect(screen.getByText('演示导入失败：包内缺少带 frontmatter 的 SKILL.md')).toBeInTheDocument()

    const row = screen.getByText('演示导入失败：包内缺少带 frontmatter 的 SKILL.md').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '删除记录' }))
    await flush()
    expect(screen.queryByText('演示导入失败：包内缺少带 frontmatter 的 SKILL.md')).not.toBeInTheDocument()
  })

  it('运行中任务取消：先「已请求取消，等待停止」，下一拍转「已取消」', async () => {
    await renderPage()
    await openImportPanel()
    fireEvent.click(screen.getByRole('button', { name: '宿主目录' }))
    fireEvent.change(screen.getByLabelText('宿主绝对目录'), { target: { value: '/opt/skills/cancel-demo' } })
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await flush()
    await act(async () => { await advancePoll(IMPORT_POLL_MS) })
    const imports = screen.getByRole('region', { name: '导入任务' })
    const cancelRow = within(imports).getByRole('button', { name: '取消导入' }).closest('tr')!
    fireEvent.click(within(cancelRow).getByRole('button', { name: '取消导入' }))
    await flush()
    expect(within(cancelRow).getByText('已请求取消，等待停止')).toBeInTheDocument()
    await act(async () => { await advancePoll(IMPORT_POLL_MS) })
    expect(within(cancelRow).getAllByText('已取消').length).toBeGreaterThan(0)
    expect(within(cancelRow).queryByText('已请求取消，等待停止')).not.toBeInTheDocument()
  })

  it('提交在途时连点不重复发起：列表里同一 requestId 只有一条任务', async () => {
    await renderPage()
    await openImportPanel()
    fireEvent.click(screen.getByRole('button', { name: '宿主目录' }))
    fireEvent.change(screen.getByLabelText('宿主绝对目录'), { target: { value: '/opt/skills/single-flight' } })
    const submit = screen.getByRole('button', { name: '开始导入' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    fireEvent.click(submit)
    await flush()
    const imports = screen.getByRole('region', { name: '导入任务' })
    const rows = within(imports).getAllByText('排队中')
    expect(rows).toHaveLength(1)
  })

  it('导入约束文案与表单校验错误齐全', async () => {
    await renderPage()
    await openImportPanel()
    expect(screen.getByText(/导入不执行技能脚本、不运行 hooks 或 submodule/)).toBeInTheDocument()
    // 未选文件直接提交：行内校验，不发请求。
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('ZIP 来源必须选择上传文件')
    fireEvent.click(screen.getByRole('button', { name: '宿主目录' }))
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('宿主目录来源必须填写以 / 开头的绝对路径')
  })

  it('技能启停回读修订变化；删除需确认并显示修订号', async () => {
    await renderPage()
    const row = screen.getByText('backup-verify').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '启用' }))
    await flush()
    expect(within(row).getByText('已启用')).toBeInTheDocument()
    expect(within(row).getAllByText(/2/).length).toBeGreaterThan(0)

    fireEvent.click(within(row).getByRole('button', { name: '删除' }))
    await flush()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/按修订 2 删除/)).toBeInTheDocument()
    expect(within(dialog).getByText(/登记容量触顶/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /确认删除/ }))
    await flush()
    expect(screen.queryByText('backup-verify')).not.toBeInTheDocument()
  })

  it('详情弹窗展示 manifest、文件清单、digest 与固定修订的正文预览', async () => {
    await renderPage()
    const row = screen.getByText('incident-triage').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '详情' }))
    await flush()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/按运维手册分流当前事故/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'SKILL.md' }))
    await flush()
    expect(within(dialog).getByText(/name: incident-triage/)).toBeInTheDocument()
    expect(within(dialog).getByText('references/runbook.md')).toBeInTheDocument()
    expect(within(dialog).getByText(/sha256-demo-skill-incident/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭技能详情' }))
    await flush()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('深链 ?importId= 高亮对应任务行', async () => {
    await renderPage('/agent/extensions?tab=skills&importId=import-demo-2')
    const highlighted = document.querySelector('tr.ring-1')
    expect(highlighted).not.toBeNull()
    expect(within(highlighted as HTMLElement).getByText('import-demo-2')).toBeInTheDocument()
  })
})

describe('MCP 页签', () => {
  async function renderMcp(path = '/agent/extensions?tab=mcp', gateway?: ElysianGateway): Promise<ReturnType<typeof renderPage>> {
    return await renderPage(path, gateway)
  }

  it('新建 HTTP 服务 → 探测显示目录投影（工具/别名/digest/抓取时间）→ 按 digest 固定读取，digest 不符透传服务端提示', async () => {
    await renderMcp()
    fireEvent.click(screen.getByRole('button', { name: '新建 MCP 服务' }))
    await flush()
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '集成测试检索' } })
    fireEvent.change(within(dialog).getByLabelText(/服务地址/), { target: { value: 'https://it.example.com/mcp' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建 MCP 服务' }))
    await flush()
    expect(screen.getByText('集成测试检索')).toBeInTheDocument()

    const row = screen.getByText('集成测试检索').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '探测' }))
    await until(() => useAgentExtensionsStore.getState().probe?.status === 'ready')
    const probeDialog = screen.getAllByRole('dialog')[0]!
    expect(within(probeDialog).getByText('协议 2025-11-25')).toBeInTheDocument()
    expect(within(probeDialog).getByText(/模型别名 mcp_/)).toBeInTheDocument()
    expect(within(probeDialog).getByText(/资源别名 resource_/)).toBeInTheDocument()
    expect(within(probeDialog).getByText(/提示别名 prompt_/)).toBeInTheDocument()
    const digest = within(probeDialog).getByText(/sha256-demo-catalog-/).textContent!
    fireEvent.click(within(probeDialog).getByRole('button', { name: '关闭探测结果' }))
    await flush()

    fireEvent.click(within(row).getByRole('button', { name: '目录' }))
    await flush()
    const catalogDialog = screen.getAllByRole('dialog')[0]!
    expect(within(catalogDialog).getByText(/固定目录/)).toBeInTheDocument()
    // 预填探测 digest 读取成功；换成不存在的 digest 报服务端 404 文案。
    const digestInput = within(catalogDialog).getByLabelText(/目录摘要/)
    fireEvent.change(digestInput, { target: { value: 'sha256:不存在' } })
    fireEvent.click(within(catalogDialog).getByRole('button', { name: '读取目录' }))
    await until(() => useAgentExtensionsStore.getState().catalog?.status === 'error')
    expect(within(catalogDialog).getByText('MCP 服务尚无匹配的已验证目录')).toBeInTheDocument()
    fireEvent.change(digestInput, { target: { value: digest } })
    fireEvent.click(within(catalogDialog).getByRole('button', { name: '读取目录' }))
    await until(() => useAgentExtensionsStore.getState().catalog?.status === 'ready')
    expect(within(catalogDialog).getAllByText(/sha256-demo-catalog-/).length).toBeGreaterThan(0)
  })

  it('探测被 resource-busy 拒绝：提示先到治理中心核实并提供深链', async () => {
    await renderMcp()
    const row = screen.getByText('演示探测被阻（租约未核实）').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '探测' }))
    await until(() => useAgentExtensionsStore.getState().probe?.status === 'error')
    const dialog = screen.getAllByRole('dialog')[0]!
    expect(within(dialog).getByText('存在冲突执行或未核实的执行结果，暂不能启动 MCP 探测')).toBeInTheDocument()
    expect(within(dialog).getByText('存在结果未知的租约，先到治理中心核实。')).toBeInTheDocument()
    const link = within(dialog).getByRole('link', { name: /前往治理中心核实资源租约/ })
    expect(link).toHaveAttribute('href', '/agent/approvals?tab=locks')
  })

  it('stdio 表单：grant 绑定可选并可回显；环境变量保存后只显示已保存徽标不回显值', async () => {
    await renderMcp()
    fireEvent.click(screen.getByRole('button', { name: '新建 MCP 服务' }))
    await flush()
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '集成 stdio' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: /容器 stdio/ }))
    fireEvent.change(within(dialog).getByLabelText('容器镜像'), { target: { value: 'registry.example.com/mcp/it:1.0' } })
    fireEvent.change(within(dialog).getByLabelText('可执行文件'), { target: { value: 'mcp-it' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '添加参数' }))
    fireEvent.change(within(dialog).getByLabelText('参数 1'), { target: { value: '--stdio' } })
    fireEvent.change(within(dialog).getByLabelText('授权编号'), { target: { value: 'grant-it' } })
    fireEvent.change(within(dialog).getByLabelText('授权修订（正整数）'), { target: { value: '2' } })
    fireEvent.change(within(dialog).getByLabelText('环境变量（KEY=VALUE，每行一个）'), { target: { value: 'IT_TOKEN=secret-value' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建 MCP 服务' }))
    await flush()
    const row = screen.getByText('集成 stdio').closest('tr')!
    expect(within(row).getByText('grant-it @ 2')).toBeInTheDocument()
    expect(within(row).getByText('环境变量已保存')).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain('secret-value')
    expect(document.body.innerHTML).not.toContain('IT_TOKEN')

    // 编辑回显 grant 绑定。
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }))
    await flush()
    const editDialog = screen.getAllByRole('dialog')[0]!
    expect(within(editDialog).getByLabelText('授权编号')).toHaveValue('grant-it')
    expect(within(editDialog).getByLabelText('授权修订（正整数）')).toHaveValue(2)
    expect(within(editDialog).getByText(/已保存环境变量（值不回显）/)).toBeInTheDocument()
  })

  it('stdio 命令逐参数编辑保留空值与空格，并可添加和移除参数', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const create = vi.spyOn(gateway.agentExtensions, 'createMcpServer')
    await renderMcp(undefined, gateway)
    fireEvent.click(screen.getByRole('button', { name: '新建 MCP 服务' }))
    await flush()
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '参数保真' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: /容器 stdio/ }))
    fireEvent.change(within(dialog).getByLabelText('容器镜像'), { target: { value: 'registry.example.com/mcp/it:1.0' } })
    expect(within(dialog).getByRole('button', { name: '移除可执行文件' })).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('可执行文件'), { target: { value: 'mcp-it' } })
    for (let index = 1; index <= 4; index += 1) {
      fireEvent.click(within(dialog).getByRole('button', { name: '添加参数' }))
    }
    fireEvent.change(within(dialog).getByLabelText('参数 2'), { target: { value: '  --flag  ' } })
    fireEvent.change(within(dialog).getByLabelText('参数 3'), { target: { value: 'x y' } })
    fireEvent.change(within(dialog).getByLabelText('参数 4'), { target: { value: '临时参数' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '移除参数 4' }))
    expect(within(dialog).queryByLabelText('参数 4')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '创建 MCP 服务' }))
    await flush()
    expect(create).toHaveBeenCalled()
    expect(create.mock.calls.at(-1)?.[0].stdio?.command).toEqual(['mcp-it', '', '  --flag  ', 'x y'])
  })

  it('深链 ?tab=mcp&serverId=&revision= 直接打开修订详情', async () => {
    await renderMcp('/agent/extensions?tab=mcp&serverId=mcp-demo-http&revision=2')
    const dialog = screen.getAllByRole('dialog')[0]!
    expect(within(dialog).getByText('MCP 服务修订详情（mcp-demo-http）')).toBeInTheDocument()
    expect(within(dialog).getByText(/"name": "演示检索（HTTP）"/)).toBeInTheDocument()
  })
})

describe('轮询降级', () => {
  it('静默轮询连续失败显示「连接中断，正在重试」，不白屏不丢任务列表', async () => {
    const base = createMockGateway({ eventStream: 'memory' })
    const flaky: ElysianGateway = {
      ...base,
      agentExtensions: new Proxy(new AgentExtensionsMockAdapter(), {
        get(target, prop, receiver) {
          if (prop === 'listSkillImports') {
            return () => Promise.reject(new Error('Agent 请求网络失败'))
          }
          return Reflect.get(target, prop, receiver)
        },
      }),
    }
    await renderPage('/agent/extensions', flaky)
    await openImportPanel()
    fireEvent.click(screen.getByRole('button', { name: '宿主目录' }))
    fireEvent.change(screen.getByLabelText('宿主绝对目录'), { target: { value: '/opt/skills/flaky' } })
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await flush()
    await act(async () => { await advancePoll(IMPORT_POLL_MS) })
    await act(async () => { await advancePoll(IMPORT_POLL_MS) })
    expect(screen.getByRole('status', { name: '' })).toBeTruthy()
    expect(screen.getByText('连接中断，正在重试')).toBeInTheDocument()
    // 旧内容仍在屏上：任务与技能目录没有白屏。
    expect(screen.getByRole('region', { name: '技能目录' })).toBeInTheDocument()
    expect(screen.getByText('incident-triage')).toBeInTheDocument()
  })
})
