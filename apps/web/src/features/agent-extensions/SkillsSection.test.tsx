import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { ThemeProvider } from '../../app/theme/ThemeProvider'
import { resetAgentTestState } from '../../test/agentTestUtils'
import { useAgentExtensionsStore } from '../../stores/agentExtensionsStore'
import { SkillsSection } from './SkillsSection'

beforeEach(() => {
  resetAgentTestState()
  useAgentExtensionsStore.getState().reset()
})

afterEach(() => vi.unstubAllGlobals())

function archive(bytes: number[]): File {
  const file = new File([new Uint8Array(bytes)], 'same.zip', { type: 'application/zip' })
  // jsdom's File omits arrayBuffer; browsers provide it natively.
  if (file.arrayBuffer === undefined) {
    Object.defineProperty(file, 'arrayBuffer', { value: async () => Uint8Array.from(bytes).buffer })
  }
  return file
}

async function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  await screen.findByRole('region', { name: '导入技能' })
  return screen.getByRole('region', { name: '导入技能' })
}

function renderSection(gateway = createMockGateway({ eventStream: 'memory' })) {
  render(
    <ThemeProvider>
      <Tooltip.Provider delayDuration={0}>
        <GatewayProvider gateway={gateway}>
          <SkillsSection />
        </GatewayProvider>
      </Tooltip.Provider>
    </ThemeProvider>,
  )
  return gateway
}

describe('技能导入幂等核对', () => {
  it('无 SubtleCrypto 时，同名同大小但字节不同的 ZIP 不复用未确认请求，原字节可按原 ID 重试', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const randomUUID = globalThis.crypto.randomUUID?.bind(globalThis.crypto)
    vi.stubGlobal('crypto', { randomUUID })
    expect(globalThis.crypto.subtle).toBeUndefined()
    const create = vi.spyOn(gateway.agentExtensions, 'createSkillImport').mockRejectedValueOnce(new Error('连接中断'))
    renderSection(gateway)
    const panel = await openPanel()
    const picker = screen.getByLabelText('ZIP 文件（不超过 64 MiB）')
    const original = archive([1, 2, 3, 4])
    fireEvent.change(picker, { target: { files: [original] } })
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '核对并重试' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '收起' })).toBeDisabled()
    const firstInput = create.mock.calls[0]?.[0]
    expect(firstInput?.requestId).toBeTruthy()

    fireEvent.change(picker, { target: { files: [archive([5, 6, 7, 8])] } })
    fireEvent.click(screen.getByRole('button', { name: '核对并重试' }))
    await waitFor(() => expect(screen.getByText(/当前输入已变更/)).toBeInTheDocument())
    expect(create).toHaveBeenCalledTimes(1)

    fireEvent.change(picker, { target: { files: [archive([1, 2, 3, 4])] } })
    fireEvent.click(screen.getByRole('button', { name: '核对并重试' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1]?.[0]).toEqual(firstInput)
    expect(create.mock.calls[1]?.[1]).toBe(original)
    await waitFor(() => expect(screen.getByRole('button', { name: '开始导入' })).toBeEnabled())
    expect(panel).toBeInTheDocument()
  })

  it('响应丢失但服务端已受理时按 requestId 找回任务，不重复提交', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const originalCreate = gateway.agentExtensions.createSkillImport.bind(gateway.agentExtensions)
    const create = vi.spyOn(gateway.agentExtensions, 'createSkillImport').mockImplementationOnce(async (input, file) => {
      await originalCreate(input, file)
      throw new Error('响应丢失')
    })
    renderSection(gateway)
    await openPanel()
    fireEvent.change(screen.getByLabelText('ZIP 文件（不超过 64 MiB）'), { target: { files: [archive([1, 2, 3, 4])] } })
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '核对并重试' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '核对并重试' }))
    await waitFor(() => expect(screen.getByText(/上次导入已受理为任务/)).toBeInTheDocument())
    expect(create).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '开始导入' })).toBeEnabled()
  })

  it('核对列表失败时保留原请求，不盲目重发', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const create = vi.spyOn(gateway.agentExtensions, 'createSkillImport').mockRejectedValueOnce(new Error('提交响应中断'))
    renderSection(gateway)
    await openPanel()
    fireEvent.change(screen.getByLabelText('ZIP 文件（不超过 64 MiB）'), { target: { files: [archive([9, 8, 7, 6])] } })
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '核对并重试' })).toBeEnabled())
    const firstInput = create.mock.calls[0]?.[0]
    vi.spyOn(gateway.agentExtensions, 'listSkillImports').mockRejectedValueOnce(new Error('任务列表暂不可用'))
    fireEvent.click(screen.getByRole('button', { name: '核对并重试' }))
    await waitFor(() => expect(screen.getByText('任务列表暂不可用')).toBeInTheDocument())
    expect(create).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '收起' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '核对并重试' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1]?.[0]).toEqual(firstInput)
  })
})
