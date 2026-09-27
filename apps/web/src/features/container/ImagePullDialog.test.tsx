import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useContainersStore } from '../../stores/containersStore'
import { ImagePullDialog } from './ImagePullDialog'
import type { ElysianGateway } from '../../contracts/adapters'

vi.mock('../../app/runtime/isDockerRuntime', () => ({
  isDockerRuntime: vi.fn(() => false),
}))

import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'

function renderDialog(overrides: Partial<ElysianGateway['containers']> = {}) {
  useContainersStore.setState({ images: [], pullingImage: undefined })
  const base = createMockGateway({ eventStream: 'memory' })
  const gateway = { ...base, containers: {
    ...base.containers,
    searchImageNames: (term: string, registry?: string, signal?: AbortSignal) => base.containers.searchImageNames(term, registry, signal),
    imageTags: (name: string, registry?: string, signal?: AbortSignal) => base.containers.imageTags(name, registry, signal),
    ...overrides,
  } }
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

  it('输入至少两个字符后等待 300ms，再用方向键与回车选择仓库名', async () => {
    vi.useFakeTimers()
    try {
      const searchImageNames = vi.fn(async () => ({ names: ['redis', 'redis-stack'], searchable: true }))
      renderDialog({ searchImageNames })
      const input = screen.getByRole('combobox', { name: '镜像引用' })
      fireEvent.change(input, { target: { value: 'r' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(searchImageNames).not.toHaveBeenCalled()
      fireEvent.change(input, { target: { value: 're' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(299) })
      expect(searchImageNames).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(searchImageNames).toHaveBeenCalledWith('re', undefined, expect.any(AbortSignal))
      expect(screen.getByRole('listbox', { name: '镜像名称建议' })).toBeInTheDocument()
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(screen.getByRole('dialog', { name: '拉取镜像' })).toBeInTheDocument()
      fireEvent.change(input, { target: { value: 'red' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(input).toHaveValue('redis-stack:latest')
      fireEvent.change(input, { target: { value: 'redis-stack:7' } })
      expect(input).toHaveValue('redis-stack:7')
    } finally {
      vi.useRealTimers()
    }
  })

  it('切换镜像源取消旧查询；自定义源无目录时提示手动输入', async () => {
    vi.useFakeTimers()
    try {
      let settle!: (value: { names: string[]; searchable: boolean }) => void
      const stale = new Promise<{ names: string[]; searchable: boolean }>((resolve) => { settle = resolve })
      const searchImageNames = vi.fn()
        .mockImplementationOnce(() => stale)
        .mockResolvedValueOnce({ names: [], searchable: false })
      renderDialog({ searchImageNames })
      const input = screen.getByRole('combobox', { name: '镜像引用' })
      fireEvent.change(input, { target: { value: 'red' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      const oldSignal = searchImageNames.mock.calls[0]![2] as AbortSignal
      fireEvent.change(screen.getByLabelText('自定义镜像源地址'), { target: { value: 'mirror.example.com' } })
      expect(oldSignal.aborted).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      await act(async () => { settle({ names: ['redis'], searchable: true }); await Promise.resolve() })
      expect(searchImageNames).toHaveBeenLastCalledWith('red', 'mirror.example.com', expect.any(AbortSignal))
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(screen.getByText('无法从此镜像源搜索，请直接输入镜像引用')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('选仓库后查询版本，切换版本会更新镜像引用且仍能手动改标签', async () => {
    vi.useFakeTimers()
    try {
      const imageTags = vi.fn(async () => ({ tags: ['latest', '8-alpine', '7-alpine'], searchable: true }))
      renderDialog({ imageTags })
      const input = screen.getByRole('combobox', { name: '镜像引用' })
      const initialTrigger = screen.getByRole('button', { name: '版本标签：先输入镜像名称' })
      expect(screen.getByRole('dialog').querySelector('select')).toBeNull()
      expect(initialTrigger).toBeDisabled()
      fireEvent.change(input, { target: { value: 'redis:latest' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(299) })
      expect(imageTags).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(imageTags).toHaveBeenCalledWith('redis', undefined, expect.any(AbortSignal))
      const trigger = screen.getByRole('button', { name: '版本标签：latest' })
      expect(trigger).not.toBeDisabled()
      vi.useRealTimers()
      const user = userEvent.setup()
      await user.click(trigger)
      expect(screen.getAllByRole('menuitemradio').map((option) => option.textContent)).toEqual(['latest', '8-alpine', '7-alpine'])
      await user.click(screen.getByRole('menuitemradio', { name: '8-alpine' }))
      expect(input).toHaveValue('redis:8-alpine')
      fireEvent.change(input, { target: { value: 'redis:7.2' } })
      expect(screen.getByRole('button', { name: '版本标签：7.2（当前输入）' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('切换镜像源取消旧版本查询；无法列出时仍能手动输入', async () => {
    vi.useFakeTimers()
    try {
      let resolveOld!: (value: { tags: string[]; searchable: boolean }) => void
      const old = new Promise<{ tags: string[]; searchable: boolean }>((resolve) => { resolveOld = resolve })
      const imageTags = vi.fn().mockImplementationOnce(() => old).mockResolvedValueOnce({ tags: [], searchable: false })
      renderDialog({ imageTags })
      fireEvent.change(screen.getByRole('combobox', { name: '镜像引用' }), { target: { value: 'redis:latest' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      const oldSignal = imageTags.mock.calls[0]![2] as AbortSignal
      fireEvent.change(screen.getByLabelText('自定义镜像源地址'), { target: { value: 'mirror.example.com' } })
      expect(oldSignal.aborted).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      await act(async () => { resolveOld({ tags: ['stale'], searchable: true }); await Promise.resolve() })
      expect(imageTags).toHaveBeenLastCalledWith('redis', 'mirror.example.com', expect.any(AbortSignal))
      expect(screen.getByText('无法列出此镜像的版本，可在镜像引用中手动输入标签')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /版本标签：/ })).toBeDisabled()
      const input = screen.getByRole('combobox', { name: '镜像引用' })
      fireEvent.change(input, { target: { value: 'redis:7-alpine' } })
      expect(input).toHaveValue('redis:7-alpine')
    } finally {
      vi.useRealTimers()
    }
  })
})
