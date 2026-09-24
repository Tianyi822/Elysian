import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useContainersStore } from '../../stores/containersStore'
import { ContainerCreateDialog } from './ContainerCreateDialog'

vi.mock('../../app/runtime/isDockerRuntime', () => ({
  isDockerRuntime: vi.fn(() => false),
}))

import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'

function renderDialog() {
  useContainersStore.setState({ createOpen: true, containers: [], images: [] })
  const gateway = createMockGateway({ eventStream: 'memory' })
  return render(
    <GatewayProvider gateway={gateway}>
      <ContainerCreateDialog />
    </GatewayProvider>,
  )
}

beforeEach(() => {
  vi.mocked(isDockerRuntime).mockReturnValue(false)
})

describe('ContainerCreateDialog', () => {
  it('Docker 运行时无演示徽章、页脚为创建后立即启动', () => {
    vi.mocked(isDockerRuntime).mockReturnValue(true)
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: '创建容器' })
    expect(dialog.textContent).not.toContain('演示 · 待接入真实执行')
    expect(within(dialog).getByText('创建后立即启动。')).toBeInTheDocument()
  })

  it('mock 运行时仍显示演示徽章', () => {
    renderDialog()
    expect(screen.getByRole('dialog', { name: '创建容器' }).textContent).toContain('演示 · 待接入真实执行')
  })

  it('勾选对外开放时显示防火墙提示', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: '创建容器' })
    fireEvent.click(within(dialog).getByRole('button', { name: /可选设置/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: '添加端口映射' }))
    fireEvent.click(within(dialog).getByLabelText('对外开放'))
    expect(within(dialog).getByText('该端口不受防火墙规则约束')).toBeInTheDocument()
  })

  it('createPolicy 成功时卷路径 placeholder 使用 mountRoot', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    gateway.containers.createPolicy = async () => ({ mountRoot: '/mnt/elysian', reservedPorts: [48100] })
    useContainersStore.setState({ createOpen: true, containers: [], images: [] })
    render(
      <GatewayProvider gateway={gateway}>
        <ContainerCreateDialog />
      </GatewayProvider>,
    )
    const dialog = screen.getByRole('dialog', { name: '创建容器' })
    fireEvent.click(within(dialog).getByRole('button', { name: /可选设置/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: '添加卷挂载' }))
    expect(await within(dialog).findByPlaceholderText('/mnt/elysian/data')).toBeInTheDocument()
  })

  it('createPolicy 失败时卷路径 placeholder 回落 /srv/data', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    gateway.containers.createPolicy = async () => {
      throw new Error('策略不可用')
    }
    useContainersStore.setState({ createOpen: true, containers: [], images: [] })
    render(
      <GatewayProvider gateway={gateway}>
        <ContainerCreateDialog />
      </GatewayProvider>,
    )
    const dialog = screen.getByRole('dialog', { name: '创建容器' })
    fireEvent.click(within(dialog).getByRole('button', { name: /可选设置/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: '添加卷挂载' }))
    expect(await within(dialog).findByPlaceholderText('/srv/data')).toBeInTheDocument()
  })
})
