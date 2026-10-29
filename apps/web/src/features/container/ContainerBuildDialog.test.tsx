import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as Tooltip from '@radix-ui/react-tooltip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContainerApp, ContainerBuildPlan, ContainerBuildSubmitInput } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useContainerAppsStore } from '../../stores/containerAppsStore'
import { useMessageStore } from '../../stores/messageStore'
import { ContainerBuildDialog } from './ContainerBuildDialog'
import type { ElysianGateway } from '../../contracts/adapters'

/**
 * 构建弹窗测试：预览 → 确认 → 提交的主流程与错误呈现。
 * adapter 走 mock 演示实现，个别接口按接口覆盖（面板先例的同款接缝）。
 */

const app: ContainerApp = {
  slug: 'demo-app',
  displayName: '演示应用',
  createdAt: '2026-10-01T00:00:00Z',
  directory: '/srv/elysian/apps/demo-app',
  files: [
    { path: 'Dockerfile', size: 20, modifiedAt: '2026-10-01T00:00:00Z', text: true },
    { path: 'compose.yml', size: 48, modifiedAt: '2026-10-01T00:00:00Z', text: true },
  ],
}

const dockerfilePlan: ContainerBuildPlan = {
  mode: 'dockerfile',
  slug: 'demo-app',
  target: 'app',
  dockerfile: 'Dockerfile',
  context: '.',
  imageRepository: 'elysian/demo-app/app',
  contextFiles: 2,
  contextBytes: 68,
  repositoryOccupied: false,
  warnings: ['第 3 行 FROM 含未解析变量，面板未校验其镜像源'],
}

async function dialogGateway(
  apply: (base: ElysianGateway) => Partial<ElysianGateway['containers']> = () => ({}),
): Promise<ElysianGateway> {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const gateway: ElysianGateway = { ...base, containers: Object.assign(Object.create(base.containers), apply(base)) }
  // 主流程用例走 mock 提交：先在工作区里备好 Dockerfile，否则 mock 会以「工作区不存在」拒绝。
  await gateway.containers.createApp({ slug: 'demo-app', displayName: '演示应用' })
  await gateway.containers.uploadAppFile('demo-app', 'Dockerfile', new Blob(['FROM alpine:3.20\n']))
  return gateway
}

function renderDialog(gateway: ElysianGateway, onClose = vi.fn()) {
  const user = userEvent.setup()
  render(
    <Tooltip.Provider><GatewayProvider gateway={gateway}>
      <ContainerBuildDialog app={app} onClose={onClose} />
    </GatewayProvider></Tooltip.Provider>,
  )
  return { user, onClose }
}

beforeEach(async () => {
  await useMessageStore.getState().clear()
  useContainerAppsStore.setState({
    status: 'idle',
    apps: [],
    errorMessage: undefined,
    refreshing: false,
    creating: false,
    createError: null,
    writing: null,
    check: null,
    buildsBySlug: {},
    buildsLoading: {},
    buildsRefreshing: {},
    buildsError: {},
    buildPreview: null,
    buildLogs: {},
  })
})

describe('构建镜像弹窗', () => {
  it('两种模式互斥切换，切到 compose 出现文件选择，切回出现目标名输入', async () => {
    const { user } = renderDialog(await dialogGateway())
    expect(screen.getByLabelText(/镜像目标名/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'compose 服务构建' }))
    expect(screen.queryByLabelText(/镜像目标名/)).toBeNull()
    expect(screen.getByLabelText(/compose 文件/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Dockerfile 构建' }))
    expect(screen.getByLabelText(/镜像目标名/)).toBeTruthy()
  })

  it('预览成功渲染统计与警告，确认弹窗逐字列出工作区、上下文与限额', async () => {
    const gateway = await dialogGateway((base) => ({
      previewAppBuild: async () => structuredClone(dockerfilePlan),
      submitAppBuild: (slug, input) => base.containers.submitAppBuild(slug, input),
    }))
    const onClose = vi.fn()
    const { user } = renderDialog(gateway, onClose)
    await user.click(screen.getByRole('button', { name: '预览构建' }))
    expect(await screen.findByText(/第 3 行 FROM 含未解析变量，面板未校验其镜像源/)).toBeTruthy()
    expect(screen.getByText(/elysian\/demo-app\/app/)).toBeTruthy()
    expect(screen.getByText(/2 个文件、68 B/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '开始构建' }))
    const confirm = await screen.findByRole('dialog', { name: '确认开始构建？' })
    expect(confirm.textContent).toContain('demo-app')
    expect(confirm.textContent).toContain('模式：Dockerfile 构建')
    expect(confirm.textContent).toContain('Dockerfile：Dockerfile')
    expect(confirm.textContent).toContain('上下文 .（2 个文件、68 B）')
    expect(confirm.textContent).toContain('elysian/demo-app/app')
    expect(confirm.textContent).toContain(
      '构建将在 Docker 引擎上执行,Dockerfile 中的指令由引擎运行(限额 2 CPU、2 GiB 内存、单镜像 20 分钟)',
    )
    // ADR-0021 要求把上下文快照语义写进确认弹窗：构建期间改文件不影响进行中的任务。
    expect(confirm.textContent).toContain(
      '上下文为任务开始时的一次性快照：构建期间对工作区文件的改动，下一次构建才会生效。',
    )

    await user.click(within(confirm).getByRole('button', { name: '确认并开始构建' }))
    // 通知 toast 不在这棵测试树里，断言落到通知 store 与弹窗关闭回调。
    await waitFor(() =>
      expect(useMessageStore.getState().messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ tone: 'success', message: '已提交构建任务' }),
      ])),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('dockerfile 输入一变旧预览即失效，重新预览后才可提交且提交值为新预览值', async () => {
    const submitted: ContainerBuildSubmitInput[] = []
    const gateway = await dialogGateway((base) => ({
      previewAppBuild: async (_slug, input) => {
        const target = input.mode === 'dockerfile' && input.target ? input.target : dockerfilePlan.target
        return { ...structuredClone(dockerfilePlan), target, imageRepository: `elysian/demo-app/${target}` }
      },
      submitAppBuild: async (slug, input) => {
        submitted.push(input)
        return base.containers.submitAppBuild(slug, input)
      },
    }))
    const { user } = renderDialog(gateway)
    await user.click(screen.getByRole('button', { name: '预览构建' }))
    await screen.findByText(/elysian\/demo-app\/app/)
    expect(screen.getByRole('button', { name: '开始构建' })).not.toHaveAttribute('disabled')
    // 修改目标名：旧预览失效，开始构建按钮禁用，旧值不会被静默提交。
    await user.clear(screen.getByLabelText(/镜像目标名/))
    await user.type(screen.getByLabelText(/镜像目标名/), 'side')
    expect(screen.getByRole('button', { name: '开始构建' })).toHaveAttribute('disabled')
    // 重新预览后按钮恢复，提交体 target 为新预览值。
    await user.click(screen.getByRole('button', { name: '预览构建' }))
    await screen.findByText(/elysian\/demo-app\/side/)
    expect(screen.getByRole('button', { name: '开始构建' })).not.toHaveAttribute('disabled')
    await user.click(screen.getByRole('button', { name: '开始构建' }))
    const confirm = await screen.findByRole('dialog', { name: '确认开始构建？' })
    await user.click(within(confirm).getByRole('button', { name: '确认并开始构建' }))
    await waitFor(() => expect(submitted.length).toBe(1))
    expect(submitted[0]).toMatchObject({ mode: 'dockerfile', target: 'side' })
  })

  it('超限警告原样显示并禁用开始按钮', async () => {
    const gateway = await dialogGateway(() => ({
      previewAppBuild: async () => ({
        ...dockerfilePlan,
        contextFiles: 600,
        warnings: ['构建上下文超过上限（≤512 个文件、128 MiB），任务将在打包阶段失败'],
      }),
    }))
    const { user } = renderDialog(gateway)
    await user.click(screen.getByRole('button', { name: '预览构建' }))
    expect(await screen.findByText(/构建上下文超过上限（≤512 个文件、128 MiB），任务将在打包阶段失败/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '开始构建' })).toHaveAttribute('disabled')
  })

  it('引擎不可用的 503 错误原样呈现在表单内', async () => {
    const gateway = await dialogGateway(() => ({
      previewAppBuild: async () => {
        throw new Error('Docker 服务未就绪')
      },
    }))
    const { user } = renderDialog(gateway)
    await user.click(screen.getByRole('button', { name: '预览构建' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Docker 服务未就绪')
  })

  it('提交阶段的服务校验错误（服务不存在）原样呈现在表单内', async () => {
    const gateway = await dialogGateway(() => ({
      previewAppBuild: async () => structuredClone(dockerfilePlan),
      submitAppBuild: async () => {
        throw new Error('服务不存在：web')
      },
    }))
    const { user } = renderDialog(gateway)
    await user.click(screen.getByRole('button', { name: '预览构建' }))
    await screen.findByText(/elysian\/demo-app\/app/)
    await user.click(screen.getByRole('button', { name: '开始构建' }))
    const confirm = await screen.findByRole('dialog', { name: '确认开始构建？' })
    await user.click(within(confirm).getByRole('button', { name: '确认并开始构建' }))
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some((alert) => alert.textContent === '服务不存在：web')).toBe(true)
    // 提交失败不关弹窗：用户改完还能再试。
    expect(screen.getByRole('dialog', { name: '构建镜像 · demo-app' })).toBeTruthy()
  })

  it('演示模式（非 Docker 运行时）顶部标注内存模拟', async () => {
    renderDialog(await dialogGateway())
    expect(screen.getByText('演示模式：构建为内存模拟,不执行真实 Docker 构建。')).toBeTruthy()
  })

  it('compose 模式渲染服务勾选并默认选中全部 build 服务', async () => {
    const gateway = await dialogGateway(() => ({
      previewAppBuild: async () =>
        ({
          mode: 'compose',
          slug: 'demo-app',
          compose: 'compose.yml',
          services: [
            {
              service: 'web',
              hasBuild: true,
              target: 'web',
              dockerfile: 'web/Dockerfile',
              context: 'web',
              imageRepository: 'elysian/demo-app/web',
              contextFiles: 1,
              contextBytes: 20,
              imageNameInCompose: 'demo-web',
              repositoryOccupied: false,
              warnings: [],
            },
            {
              service: 'db',
              hasBuild: false,
              target: '',
              dockerfile: '',
              context: '',
              imageRepository: '',
              contextFiles: 0,
              contextBytes: 0,
              imageNameInCompose: 'mariadb:11',
              repositoryOccupied: false,
              warnings: [],
            },
          ],
          warnings: ['演示模式返回固定示例,不解析 compose 文件内容'],
        }) satisfies ContainerBuildPlan,
      submitAppBuild: vi.fn(async () => {
        throw new Error('不该走到提交')
      }),
    }))
    const { user } = renderDialog(gateway)
    await user.click(screen.getByRole('button', { name: 'compose 服务构建' }))
    await user.click(screen.getByRole('button', { name: '预览构建' }))
    expect(await screen.findByText(/演示模式返回固定示例,不解析 compose 文件内容/)).toBeTruthy()
    const web = screen.getByLabelText(/web/) as HTMLInputElement
    const db = screen.getByLabelText(/db/) as HTMLInputElement
    expect(web.checked).toBe(true)
    expect(db.disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: '开始构建' }))
    const confirm = await screen.findByRole('dialog', { name: '确认开始构建？' })
    expect(confirm.textContent).toContain('模式：compose 服务构建')
    expect(confirm.textContent).toContain('elysian/demo-app/web')
    await user.click(within(confirm).getByRole('button', { name: '确认并开始构建' }))
    await waitFor(() => expect(gateway.containers.submitAppBuild).toHaveBeenCalled())
    const input = (gateway.containers.submitAppBuild as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      mode: string
      services: readonly string[]
    }
    expect(input.mode).toBe('compose')
    expect(input.services).toEqual(['web'])
  })
})
