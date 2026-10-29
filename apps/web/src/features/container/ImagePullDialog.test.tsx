import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useContainersStore } from '../../stores/containersStore'
import { useMessageStore } from '../../stores/messageStore'
import { customImageRegistries, invalidImageRegistries, officialImageRegistries } from '../../test/imageRegistryCases'
import { ImagePullDialog } from './ImagePullDialog'
import { readStoredImageRegistry, writeStoredImageRegistry } from './imagePullPreferences'
import type { ElysianGateway } from '../../contracts/adapters'

vi.mock('../../app/runtime/isDockerRuntime', () => ({
  isDockerRuntime: vi.fn(() => false),
}))

import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'

const OFFICIAL_URL = 'https://registry-1.docker.io'

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
    <Tooltip.Provider delayDuration={0}>
      <GatewayProvider gateway={gateway}>
        <ImagePullDialog onClose={() => {}} />
      </GatewayProvider>
    </Tooltip.Provider>,
  )
}

/** 自定义地址收在下拉的「自定义地址…」项下；真实时钟下经菜单进入再填写。 */
async function setRegistry(value: string) {
  const user = userEvent.setup()
  if (!screen.queryByLabelText('自定义镜像源地址')) {
    await user.click(screen.getByRole('button', { name: /^镜像源：/ }))
    await user.click(screen.getByRole('menuitemradio', { name: '自定义地址…' }))
  }
  fireEvent.change(screen.getByLabelText('自定义镜像源地址'), { target: { value } })
}

async function selectPreset(label: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /^镜像源：/ }))
  await user.click(screen.getByRole('menuitemradio', { name: label }))
}

beforeEach(async () => {
  vi.mocked(isDockerRuntime).mockReturnValue(false)
  writeStoredImageRegistry('')
  await useMessageStore.getState().clear()
})

describe('ImagePullDialog', () => {
  it('名称搜索不可用仍可独立查询版本并提交拉取，不将版本成功当成名称搜索成功', async () => {
    const pullImage = vi.fn().mockResolvedValue(undefined)
    const originalPull = useContainersStore.getState().pullImage
    useContainersStore.setState({ pullImage })
    try {
      renderDialog({
        searchImageNames: vi.fn().mockResolvedValue({ names: [], searchable: false }),
        imageTags: vi.fn().mockResolvedValue({ tags: ['latest', '8.4'], searchable: true }),
      })
      await setRegistry('https://docker.1ms.run')
      vi.useFakeTimers()
      fireEvent.change(screen.getByRole('combobox', { name: '镜像引用' }), { target: { value: 'mysql' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(screen.getByText('此镜像源的名称搜索不可用，请直接输入镜像名；版本列表会单独查询。')).toBeInTheDocument()
      expect(screen.getByText('已查询到版本，可选择后拉取，也可手动修改标签。')).toBeInTheDocument()
      vi.useRealTimers()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: '版本标签：latest' }))
      await user.click(screen.getByRole('menuitemradio', { name: '8.4' }))
      await user.click(screen.getByRole('button', { name: '拉取' }))
      expect(pullImage).toHaveBeenCalledWith(expect.anything(), { name: 'mysql', tag: '8.4', registry: 'https://docker.1ms.run' })
    } finally {
      useContainersStore.setState({ pullImage: originalPull })
      vi.useRealTimers()
    }
  })

  it('填写源后即保存，关闭再打开自动填充；清空会清除记忆并回落官方预设', async () => {
    const first = renderDialog()
    await setRegistry('https://mirror.example.com')
    expect(readStoredImageRegistry()).toBe('https://mirror.example.com')
    first.unmount()

    const second = renderDialog()
    expect(screen.getByLabelText('自定义镜像源地址')).toHaveValue('https://mirror.example.com')
    fireEvent.change(screen.getByLabelText('自定义镜像源地址'), { target: { value: '' } })
    second.unmount()
    renderDialog()
    expect(screen.queryByLabelText('自定义镜像源地址')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '镜像源：官方 Docker Hub' })).toBeInTheDocument()
  })

  it.each(officialImageRegistries)('显式官方地址 %j 保留搜索建议和版本查询，并把地址传给后端', async (registry) => {
    vi.useFakeTimers()
    try {
      const adapter = createMockGateway({ eventStream: 'memory' }).containers
      const searchImageNames = vi.fn(adapter.searchImageNames.bind(adapter))
      const imageTags = vi.fn(adapter.imageTags.bind(adapter))
      renderDialog({ searchImageNames, imageTags })
      vi.useRealTimers()
      await setRegistry(registry)
      vi.useFakeTimers()
      fireEvent.change(screen.getByRole('combobox', { name: '镜像引用' }), { target: { value: 'redis:latest' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(searchImageNames).toHaveBeenCalledWith('redis', registry.trim() || undefined, expect.any(AbortSignal))
      expect(imageTags).toHaveBeenCalledWith('redis', registry.trim() || undefined, expect.any(AbortSignal))
      expect(screen.getByRole('option', { name: 'redis' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '版本标签：latest' })).not.toBeDisabled()
      expect(screen.queryByText('此镜像源的名称搜索不可用，请直接输入镜像名；版本列表会单独查询。')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(officialImageRegistries)('官方地址 %j 搜索失败时使用官方就地提示且不进入历史', async (registry) => {
    renderDialog({ searchImageNames: vi.fn().mockRejectedValue(new Error('搜索失败')) })
    await setRegistry(registry)
    vi.useFakeTimers()
    try {
      fireEvent.change(screen.getByRole('combobox', { name: '镜像引用' }), { target: { value: 'redis' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      const message = '镜像名称搜索暂不可用，请直接输入镜像名；版本列表会单独查询。'
      expect(screen.getByText(message)).toBeInTheDocument()
      expect(useMessageStore.getState().messages).toEqual([])
      expect(screen.queryByText('此镜像源的名称搜索不可用，请直接输入镜像名；版本列表会单独查询。')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(customImageRegistries)('自定义地址 %j 不可搜索时使用自定义源提示', async (registry) => {
    renderDialog()
    await setRegistry(registry)
    vi.useFakeTimers()
    try {
      fireEvent.change(screen.getByRole('combobox', { name: '镜像引用' }), { target: { value: 'redis' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      const message = '此镜像源的名称搜索不可用，请直接输入镜像名；版本列表会单独查询。'
      expect(screen.getByText(message)).toBeInTheDocument()
      expect(useMessageStore.getState().messages).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('官方地址返回 searchable=false 时仍使用官方搜索提示', async () => {
    renderDialog({ searchImageNames: vi.fn().mockResolvedValue({ names: [], searchable: false }) })
    await setRegistry('https://registry-1.docker.io')
    vi.useFakeTimers()
    try {
      fireEvent.change(screen.getByRole('combobox', { name: '镜像引用' }), { target: { value: 'redis' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(screen.getByText('镜像名称搜索暂不可用，请直接输入镜像名；版本列表会单独查询。')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(invalidImageRegistries)('非法地址 %j 不发起搜索或版本查询', async (registry) => {
    const searchImageNames = vi.fn()
    const imageTags = vi.fn()
    renderDialog({ searchImageNames, imageTags })
    await setRegistry(registry)
    vi.useFakeTimers()
    try {
      fireEvent.change(screen.getByRole('combobox', { name: '镜像引用' }), { target: { value: 'redis' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(searchImageNames).not.toHaveBeenCalled()
      expect(imageTags).not.toHaveBeenCalled()
      expect(screen.getByText(/地址须为公网主机名或 HTTPS URL/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('带尾斜杠的官方地址预览不出现双斜杠', async () => {
    renderDialog()
    await setRegistry('https://registry-1.docker.io/')
    fireEvent.change(screen.getByRole('combobox', { name: '镜像引用' }), { target: { value: 'redis:8-alpine' } })
    expect(screen.getByText('registry-1.docker.io/redis:8-alpine')).toBeInTheDocument()
  })

  it('Docker 运行时无演示徽章、中部提示与页脚都是真实拉取说明', () => {
    vi.mocked(isDockerRuntime).mockReturnValue(true)
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: '拉取镜像' })
    expect(dialog.textContent).not.toContain('演示 · 待接入真实执行')
    expect(
      within(dialog).getByText('测速下载 1 MiB 样本计时，结果只作本次参考；只支持公开镜像与公网镜像源'),
    ).toBeInTheDocument()
    expect(dialog.textContent).not.toContain('地址仅作记录')
    expect(within(dialog).getByText('从镜像仓库拉取，只支持公开镜像。')).toBeInTheDocument()
  })

  it('mock 运行时仍显示演示徽章与模拟说明', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: '拉取镜像' })
    expect(dialog.textContent).toContain('演示 · 待接入真实执行')
    expect(
      within(dialog).getByText('演示模式不访问真实镜像仓库，测速不可用；地址仅作记录，不产生真实数据流。'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('拉取由演示数据模拟，不访问真实镜像仓库。')).toBeInTheDocument()
  })

  it('输入至少两个字符后等待 300ms，再用方向键与回车选择仓库名', async () => {
    const searchImageNames = vi.fn(async () => ({ names: ['redis', 'redis-stack'], searchable: true }))
    renderDialog({ searchImageNames })
    vi.useFakeTimers()
    try {
      const input = screen.getByRole('combobox', { name: '镜像引用' })
      fireEvent.change(input, { target: { value: 'r' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(searchImageNames).not.toHaveBeenCalled()
      fireEvent.change(input, { target: { value: 're' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(299) })
      expect(searchImageNames).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(searchImageNames).toHaveBeenCalledWith('re', OFFICIAL_URL, expect.any(AbortSignal))
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
    let settle!: (value: { names: string[]; searchable: boolean }) => void
    const stale = new Promise<{ names: string[]; searchable: boolean }>((resolve) => { settle = resolve })
    const searchImageNames = vi.fn()
      .mockImplementationOnce(() => stale)
      .mockResolvedValueOnce({ names: [], searchable: false })
    renderDialog({ searchImageNames })
    vi.useFakeTimers()
    try {
      const input = screen.getByRole('combobox', { name: '镜像引用' })
      fireEvent.change(input, { target: { value: 'red' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      const oldSignal = searchImageNames.mock.calls[0]![2] as AbortSignal
      vi.useRealTimers()
      await setRegistry('mirror.example.com')
      expect(oldSignal.aborted).toBe(true)
      await waitFor(() => expect(searchImageNames).toHaveBeenLastCalledWith('red', 'mirror.example.com', expect.any(AbortSignal)))
      await act(async () => { settle({ names: ['redis'], searchable: true }); await Promise.resolve() })
      expect(searchImageNames).toHaveBeenLastCalledWith('red', 'mirror.example.com', expect.any(AbortSignal))
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(screen.getByText('此镜像源的名称搜索不可用，请直接输入镜像名；版本列表会单独查询。')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('选仓库后查询版本，切换版本会更新镜像引用且仍能手动改标签', async () => {
    const imageTags = vi.fn(async () => ({ tags: ['latest', '8-alpine', '7-alpine'], searchable: true }))
    renderDialog({ imageTags })
    vi.useFakeTimers()
    try {
      const input = screen.getByRole('combobox', { name: '镜像引用' })
      const initialTrigger = screen.getByRole('button', { name: '版本标签：先输入镜像名称' })
      expect(screen.getByRole('dialog').querySelector('select')).toBeNull()
      expect(initialTrigger).toBeDisabled()
      fireEvent.change(input, { target: { value: 'redis:latest' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(299) })
      expect(imageTags).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(imageTags).toHaveBeenCalledWith('redis', OFFICIAL_URL, expect.any(AbortSignal))
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
    let resolveOld!: (value: { tags: string[]; searchable: boolean }) => void
    const old = new Promise<{ tags: string[]; searchable: boolean }>((resolve) => { resolveOld = resolve })
    const imageTags = vi.fn().mockImplementationOnce(() => old).mockResolvedValueOnce({ tags: [], searchable: false })
    renderDialog({ imageTags })
    vi.useFakeTimers()
    try {
      fireEvent.change(screen.getByRole('combobox', { name: '镜像引用' }), { target: { value: 'redis:latest' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      const oldSignal = imageTags.mock.calls[0]![2] as AbortSignal
      vi.useRealTimers()
      await setRegistry('mirror.example.com')
      expect(oldSignal.aborted).toBe(true)
      await waitFor(() => expect(imageTags).toHaveBeenLastCalledWith('redis', 'mirror.example.com', expect.any(AbortSignal)))
      await act(async () => { resolveOld({ tags: ['stale'], searchable: true }); await Promise.resolve() })
      expect(imageTags).toHaveBeenLastCalledWith('redis', 'mirror.example.com', expect.any(AbortSignal))
      expect(screen.getByText('无法列出此镜像的版本，可换镜像源或在镜像引用中手动输入标签')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /版本标签：/ })).toBeDisabled()
      const input = screen.getByRole('combobox', { name: '镜像引用' })
      fireEvent.change(input, { target: { value: 'redis:7-alpine' } })
      expect(input).toHaveValue('redis:7-alpine')
    } finally {
      vi.useRealTimers()
    }
  })

  it('选中预设后查询与拉取都用预设地址', async () => {
    const pullImage = vi.fn().mockResolvedValue(undefined)
    const originalPull = useContainersStore.getState().pullImage
    useContainersStore.setState({ pullImage })
    const imageTags = vi.fn(async () => ({ tags: ['latest', '7-alpine'], searchable: true }))
    try {
      renderDialog({ imageTags })
      await selectPreset('dockerproxy.net')
      expect(screen.getByRole('button', { name: '镜像源：dockerproxy.net' })).toBeInTheDocument()
      vi.useFakeTimers()
      fireEvent.change(screen.getByRole('combobox', { name: '镜像引用' }), { target: { value: 'redis:7-alpine' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(imageTags).toHaveBeenCalledWith('redis', 'https://dockerproxy.net', expect.any(AbortSignal))
      vi.useRealTimers()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: '拉取' }))
      expect(pullImage).toHaveBeenCalledWith(expect.anything(), { name: 'redis', tag: '7-alpine', registry: 'https://dockerproxy.net' })
    } finally {
      useContainersStore.setState({ pullImage: originalPull })
      vi.useRealTimers()
    }
  })

  it('行内测速调用 probeRegistry 并显示耗时，不选中该项也不关菜单', async () => {
    const probeRegistry = vi.fn().mockResolvedValue({ ok: true, elapsedMs: 420, bytes: 1048576 })
    renderDialog({ probeRegistry })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^镜像源：/ }))
    const option = screen.getByRole('menuitemradio', { name: 'dockerproxy.net' })
    await user.click(within(option).getByRole('button', { name: '测速 dockerproxy.net' }))
    expect(probeRegistry).toHaveBeenCalledWith('dockerproxy.net', expect.any(AbortSignal))
    await waitFor(() => expect(screen.getByText('测速完成：dockerproxy.net 下载 1 MiB 用时 420 毫秒')).toBeInTheDocument())
    expect(within(screen.getByRole('menuitemradio', { name: 'dockerproxy.net' })).getByText('420 毫秒')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '镜像源：官方 Docker Hub' })).toBeInTheDocument()
  })

  it('测速失败在行内标不可用并给出原因', async () => {
    const probeRegistry = vi.fn().mockResolvedValue({ ok: false, reason: '测速超时：10 秒内未完成 1 MiB 样本' })
    renderDialog({ probeRegistry })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^镜像源：/ }))
    const option = screen.getByRole('menuitemradio', { name: 'docker.1ms.run' })
    await user.click(within(option).getByRole('button', { name: '测速 docker.1ms.run' }))
    await waitFor(() => expect(screen.getByText(/测速失败：docker\.1ms\.run 测速超时/)).toBeInTheDocument())
    expect(within(screen.getByRole('menuitemradio', { name: 'docker.1ms.run' })).getByText('不可用')).toBeInTheDocument()
  })

  it('自定义地址为空时测速按钮禁用', async () => {
    renderDialog()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^镜像源：/ }))
    const option = screen.getByRole('menuitemradio', { name: '自定义地址…' })
    expect(within(option).getByRole('button', { name: '测速：先填写有效地址' })).toBeDisabled()
  })
})
