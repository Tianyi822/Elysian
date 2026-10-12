import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { demoAgentRuntimeInfo } from '../../adapters/mock/agent/agentRunsMockAdapter'
import type { ElysianGateway } from '../../contracts/adapters'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { AgentRuntimeBoundary } from './AgentRuntimeBoundary'

beforeEach(() => useAgentRuntimeStore.getState().reset())

describe('AgentRuntimeBoundary', () => {
  it('内核级 503 立即移走操作，成功回读后恢复', async () => {
    const gateway = { agentRuns: { runtime: async () => demoAgentRuntimeInfo() } } as unknown as ElysianGateway
    render(<AgentRuntimeBoundary><button type="button">提交任务</button></AgentRuntimeBoundary>)
    expect(screen.getByRole('button', { name: '提交任务' })).toBeInTheDocument()
    act(() => useAgentRuntimeStore.getState().reportUnavailable('记录副本尚未恢复'))
    expect(screen.queryByRole('button', { name: '提交任务' })).not.toBeInTheDocument()
    expect(screen.getByText('记录副本尚未恢复')).toBeInTheDocument()
    await act(async () => useAgentRuntimeStore.getState().load(gateway, { silent: true }))
    expect(screen.getByRole('button', { name: '提交任务' })).toBeInTheDocument()
  })
})
