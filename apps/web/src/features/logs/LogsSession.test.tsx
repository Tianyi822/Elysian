import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportUnauthorizedStatus } from '../../adapters/http/unauthorized'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useLoginLogStore } from '../../stores/loginLogStore'
import { LOGS_TABS, useLogsStore } from '../../stores/logsStore'
import { useOperationLogStore } from '../../stores/operationLogStore'
import { useRuntimeLogStore } from '../../stores/runtimeLogStore'
import { useSessionStore } from '../../stores/sessionStore'
import { platformMemorySample } from '../../test/platformMemorySample'
import { renderApp } from '../../test/renderApp'

const oldMarker = '旧会话日志标记'
const newMarker = '新会话日志标记'

function stagedRead<Report>(reportFor: (marker: string) => Report, isNewSession: () => boolean) {
  let release!: (report: Report) => void
  const pending = new Promise<Report>(resolve => { release = resolve })
  const read = vi.fn(async () => isNewSession() ? pending : reportFor(oldMarker))
  return { read, finish: () => release(reportFor(newMarker)) }
}

beforeEach(() => {
  useSessionStore.getState().expire()
  useSessionStore.setState(useSessionStore.getInitialState())
  useRuntimeLogStore.setState(useRuntimeLogStore.getInitialState())
  useOperationLogStore.setState(useOperationLogStore.getInitialState())
  useLoginLogStore.setState(useLoginLogStore.getInitialState())
})

afterEach(() => { useLogsStore.setState(useLogsStore.getInitialState()) })

describe.each(['主动登出', '当前会话收到 401'] as const)('%s 后重新登录', endSession => {
  it.each(LOGS_TABS)('$label 在新请求返回前不展示旧行', async ({ value, label }) => {
    const base = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const runtime = await base.logs.runtimeLog()
    const operation = await base.logs.operationLogs()
    const login = await base.logs.loginLogs()
    let authenticated = true
    let newSession = false
    const isNewSession = () => newSession
    const reads = {
      runtime: stagedRead(marker => ({ ...runtime, total: 1, entries: [{ ...runtime.entries[0]!, message: marker }] }), isNewSession),
      operation: stagedRead(marker => ({ ...operation, total: 1, entries: [{ ...operation.entries[0]!, action: marker, summary: '' }] }), isNewSession),
      login: stagedRead(marker => ({ ...login, total: 1, entries: [{ ...login.entries[0]!, location: marker }] }), isNewSession),
    }
    const gateway = {
      ...base,
      platformMemory: { read: async () => platformMemorySample() },
      session: {
        canView: async () => true,
        status: async () => ({ mode: 'real' as const, authenticated, devAccount: false }),
        login: async () => { authenticated = true; newSession = true },
        logout: async () => { authenticated = false },
        listSessions: async () => [],
        changeUsername: async () => {},
        changePassword: async () => {},
        logoutOtherSessions: async () => {},
      },
      logs: { runtimeLog: reads.runtime.read, operationLogs: reads.operation.read, loginLogs: reads.login.read, clearLogs: base.logs.clearLogs.bind(base.logs) },
    }

    useLogsStore.getState().setTab(value)
    const { router } = renderApp('/logs', { gateway })
    expect(await screen.findByText(oldMarker)).toBeInTheDocument()
    const firstSessionReads = reads[value].read.mock.calls.length

    if (endSession === '主动登出') {
      fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    } else {
      authenticated = false
      act(() => { reportUnauthorizedStatus(401) })
    }
    expect(await screen.findByRole('heading', { name: '登录 Elysian' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'example' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(reads[value].read.mock.calls.length).toBeGreaterThan(firstSessionReads))
    expect(router.state.location.pathname).toBe('/logs')
    expect(screen.queryByText(oldMarker)).not.toBeInTheDocument()
    expect(screen.getByText(`正在加载${label}…`)).toBeInTheDocument()

    await act(async () => { reads[value].finish() })
    expect(await screen.findByText(newMarker)).toBeInTheDocument()
    expect(screen.queryByText(oldMarker)).not.toBeInTheDocument()
  })
})
