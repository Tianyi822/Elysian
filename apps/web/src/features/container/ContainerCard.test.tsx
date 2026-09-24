import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Container } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { ContainerCard } from './ContainerCard'
import { useContainersStore } from '../../stores/containersStore'

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
})
