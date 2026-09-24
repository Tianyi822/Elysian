import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContainerImage } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { ImageTable } from './ImageTable'

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
