import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useContainersStore } from '../../stores/containersStore'
import { ImagePullDialog } from './ImagePullDialog'

vi.mock('../../app/runtime/isDockerRuntime', () => ({
  isDockerRuntime: vi.fn(() => false),
}))

import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'

function renderDialog() {
  useContainersStore.setState({ images: [], pullingImage: undefined })
  const gateway = createMockGateway({ eventStream: 'memory' })
  return render(
    <GatewayProvider gateway={gateway}>
      <ImagePullDialog onClose={() => {}} />
    </GatewayProvider>,
  )
}

beforeEach(() => {
  vi.mocked(isDockerRuntime).mockReturnValue(false)
})

describe('ImagePullDialog', () => {
  it('Docker 运行时无演示徽章、中部提示与页脚都是真实拉取说明', () => {
    vi.mocked(isDockerRuntime).mockReturnValue(true)
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: '拉取镜像' })
    expect(dialog.textContent).not.toContain('演示 · 待接入真实执行')
    expect(
      within(dialog).getByText('未填写时从官方 Docker Hub 拉取；只支持公开镜像与公网镜像源'),
    ).toBeInTheDocument()
    expect(dialog.textContent).not.toContain('地址仅作记录')
    expect(within(dialog).getByText('从镜像仓库拉取，只支持公开镜像。')).toBeInTheDocument()
  })

  it('mock 运行时仍显示演示徽章与模拟说明', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: '拉取镜像' })
    expect(dialog.textContent).toContain('演示 · 待接入真实执行')
    expect(
      within(dialog).getByText('未填写时从官方 Docker Hub 地址拉取；地址仅作记录，不产生真实数据流。'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('拉取由演示数据模拟，不访问真实镜像仓库。')).toBeInTheDocument()
  })
})
