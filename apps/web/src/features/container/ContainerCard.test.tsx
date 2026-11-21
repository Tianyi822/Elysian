import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Container } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { ContainerCard } from './ContainerCard'
import { useContainersStore } from '../../stores/containersStore'
import { CONTAINERS } from '../../adapters/mock/containersData'

function renderCard(container: Container) {
  useContainersStore.setState({
    status: 'ready',
    containers: [container],
    images: [],
    samples: {},
    busyActions: [],
  })
  return render(
    <GatewayProvider gateway={createMockGateway({ eventStream: 'memory' })}>
      <ContainerCard container={container} />
    </GatewayProvider>,
  )
}

const pausedContainer: Container = {
  id: 'ctr-paused-demo',
  name: 'paused-demo',
  status: 'paused',
  imageId: 'img-missing',
  ports: [],
  createdAt: '2024-06-01T10:00:00.000Z',
  command: '',
  env: [],
  volumes: [],
  restartPolicy: 'no',
}

const localBindContainer: Container = {
  ...pausedContainer,
  id: 'ctr-local-bind',
  name: 'local-bind',
  status: 'running',
  ports: [{ containerPort: 3000, hostPort: 13000, protocol: 'tcp', hostIp: '127.0.0.1' }],
}

describe('ContainerCard 契约展示', () => {
  it('独立显示 CPU 和内存，也显示真实的零值', () => {
    renderCard(localBindContainer)
    act(() => useContainersStore.setState({ samples: { [localBindContainer.id]: { memMb: 16 } } }))
    expect(screen.getByText('16 MB')).toBeInTheDocument()
    expect(screen.getByText('—', { selector: 'span.font-medium' })).toBeInTheDocument()
    act(() => useContainersStore.setState({ samples: { [localBindContainer.id]: { cpuPercent: 0, memMb: 0 } } }))
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(screen.getByText('0 MB')).toBeInTheDocument()
  })

  it('已暂停时除详情外操作禁用，并提示面板不支持恢复', () => {
    renderCard(pausedContainer)
    const card = screen.getByRole('article', { name: 'paused-demo' })
    expect(within(card).getByRole('button', { name: '详情' })).toBeEnabled()
    for (const name of ['终端', '停止', '重启']) {
      const button = within(card).getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', '容器已暂停，面板暂不支持恢复')
    }
  })

  it('本机绑定的端口映射显示「仅本机」徽章', () => {
    renderCard(localBindContainer)
    const card = screen.getByRole('article', { name: 'local-bind' })
    expect(card.textContent).toContain('3000')
    expect(card.textContent).toContain('13000')
    expect(card.textContent).toContain('仅本机')
  })

  it.each([
    { status: 'running', reason: '容器正在运行，请先停止再删除' },
    { status: 'paused', reason: '容器已暂停，须停止后才能删除' },
    { status: 'restarting', reason: '容器正在重启，无法删除' },
    { status: 'stopped', reason: '网站容器须在网站页处理', removeBlockedReason: '网站容器须在网站页处理' },
  ] as const)('$status：删除入口可见但不可用，说明原因', ({ status, reason, ...protection }) => {
    renderCard({ ...pausedContainer, status, ...protection })
    const button = screen.getByRole('button', { name: '删除' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(reason)
  })

  it('停止态确认默认聚焦取消；取消不删，状态变动后不可确认', async () => {
    const user = userEvent.setup()
    const gateway = createMockGateway({ eventStream: 'memory' })
    const remove = vi.spyOn(gateway.containers, 'removeContainer')
    const stopped = CONTAINERS.find((container) => container.status === 'stopped')!
    useContainersStore.setState({ containers: [stopped], busyActions: [] })
    function LiveCard() {
      const container = useContainersStore((state) => state.containers[0])
      return container ? <ContainerCard container={container} /> : null
    }
    render(<GatewayProvider gateway={gateway}><LiveCard /></GatewayProvider>)
    const open = () => user.click(screen.getByRole('button', { name: '删除' }))
    await open()
    const dialog = screen.getByRole('dialog', { name: `确认删除容器「${stopped.name}」？` })
    const cancel = within(dialog).getByRole('button', { name: '取消' })
    expect(cancel).toHaveFocus()
    expect(dialog).toHaveAccessibleDescription(/容器可写层.*镜像、挂载卷和宿主机文件会保留/)
    await user.click(cancel)
    expect(remove).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: '删除' })).toHaveFocus())

    await open()
    act(() => useContainersStore.setState({ containers: [{ ...stopped, status: 'running' }] }))
    expect(screen.getByRole('button', { name: '确认删除' })).toBeDisabled()
    expect(remove).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')

    act(() => useContainersStore.setState({ containers: [stopped] }))
    const images = await gateway.containers.listImages()
    await open()
    await user.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(screen.queryByRole('article', { name: stopped.name })).not.toBeInTheDocument())
    expect(remove).toHaveBeenCalledExactlyOnceWith(stopped.id)
    expect(await gateway.containers.list()).not.toContainEqual(expect.objectContaining({ id: stopped.id }))
    expect(await gateway.containers.listImages()).toEqual(images)
  })
})
