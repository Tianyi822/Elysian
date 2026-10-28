import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContainerImage } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { ImageTable } from './ImageTable'
import { useContainersStore } from '../../stores/containersStore'

vi.mock('../../app/runtime/isDockerRuntime', () => ({
  isDockerRuntime: vi.fn(() => false),
}))

import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'

const SAMPLE_IMAGE: ContainerImage = {
  id: 'img-sample',
  name: 'myapp',
  tag: '1.0',
  digest: 'sha256:sample',
  sizeMb: 12,
  pulledAt: '2026-09-12T08:00:00.000Z',
  otherTags: ['myapp:latest', 'repo/myapp:1.0'],
}

beforeEach(() => {
  vi.mocked(isDockerRuntime).mockReturnValue(false)
  useContainersStore.setState({ pullingImage: undefined, imagePullError: undefined })
})

describe('ImageTable 引用与拉取状态', () => {
  function renderTable(images: ContainerImage[] = []) {
    return render(<GatewayProvider gateway={createMockGateway({ eventStream: 'memory' })}>
      <ImageTable images={images} containers={[]} />
    </GatewayProvider>)
  }

  it('名称隐藏仓库域名，聚焦可查看完整组织引用并用 Escape 关闭', async () => {
    const user = userEvent.setup()
    renderTable([{ ...SAMPLE_IMAGE, name: 'dockerproxy.net/team/app' }])
    const label = screen.getByRole('button', { name: '查看镜像引用 team/app:1.0' })
    expect(label).toHaveTextContent('team/app:1.0')
    expect(label).not.toHaveTextContent('dockerproxy.net')
    await user.tab()
    const detail = await screen.findByRole('dialog', { name: '完整镜像引用' })
    expect(detail).toHaveTextContent('dockerproxy.net/team/app:1.0')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '完整镜像引用' })).not.toBeInTheDocument()
  })

  it('进度与停止按钮不随表格滚走，触屏轻点可查看所选源', async () => {
    const user = userEvent.setup()
    useContainersStore.setState({ pullingImage: {
      name: 'redis', tag: 'latest', registry: 'https://dockerproxy.net',
      progress: { phase: 'preparing', message: '正在等待 Docker 返回镜像拉取进度' },
    } })
    renderTable()
    const table = screen.getByRole('table', { name: '镜像列表' })
    const stop = screen.getByRole('button', { name: '停止拉取' })
    expect(table).not.toContainElement(stop)
    expect(screen.getByText('正在等待 Docker 返回镜像拉取进度')).toBeInTheDocument()
    const label = screen.getByRole('button', { name: '查看镜像引用 redis:latest' })
    await user.pointer([{ keys: '[TouchA>]', target: label }, { keys: '[/TouchA]' }])
    const detail = await screen.findByRole('dialog', { name: '完整镜像引用' })
    expect(detail).toHaveTextContent('dockerproxy.net/library/redis:latest')
    expect(detail).toHaveTextContent('https://dockerproxy.net')
  })

  it('失败后保留真实原因，镜像名称保持简短', () => {
    useContainersStore.setState({ imagePullError: {
      name: 'redis', tag: 'latest', registry: 'https://dockerproxy.net', message: '仓库拒绝访问',
    } })
    renderTable()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('仓库拒绝访问')
    expect(alert).not.toHaveTextContent('dockerproxy.net')
  })
})

describe('ImageTable 删除确认', () => {
  it('Docker 运行时说明真实后果并列出全部标签', async () => {
    vi.mocked(isDockerRuntime).mockReturnValue(true)
    const user = userEvent.setup()
    const gateway = createMockGateway({ eventStream: 'memory' })
    render(
      <GatewayProvider gateway={gateway}>
        <ImageTable images={[SAMPLE_IMAGE]} containers={[]} />
      </GatewayProvider>,
    )
    await user.click(screen.getByRole('button', { name: '删除' }))
    const dialog = await screen.findByRole('dialog', { name: /确认删除镜像/ })
    expect(dialog.textContent).toContain('将移除该镜像的全部标签')
    expect(dialog.textContent).toContain('正在使用它的容器会阻止删除')
    expect(within(dialog).getByText('myapp:1.0')).toBeInTheDocument()
    expect(within(dialog).getByText('myapp:latest')).toBeInTheDocument()
    expect(within(dialog).getByText('repo/myapp:1.0')).toBeInTheDocument()
  })

  it('mock 运行时保留演示数据集说明', async () => {
    const user = userEvent.setup()
    const gateway = createMockGateway({ eventStream: 'memory' })
    render(
      <GatewayProvider gateway={gateway}>
        <ImageTable images={[SAMPLE_IMAGE]} containers={[]} />
      </GatewayProvider>,
    )
    await user.click(screen.getByRole('button', { name: '删除' }))
    const dialog = await screen.findByRole('dialog', { name: /确认删除镜像/ })
    expect(dialog.textContent).toContain('演示数据集')
    expect(dialog.textContent).not.toContain('将移除该镜像的全部标签')
  })
})
