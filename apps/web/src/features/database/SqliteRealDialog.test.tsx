import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DatabaseInstance } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useDatabaseStore } from '../../stores/databaseStore'
import { DatabaseCreateDialog } from './DatabaseCreateDialog'

vi.mock('../../app/runtime/isDockerRuntime', () => ({ isDockerRuntime: () => true }))

beforeEach(() => useDatabaseStore.setState({ engine: 'SQLite', createOpen: true, creating: false, databases: [], containers: [], images: [] }))

it('Docker 环境上传真实 File，不提供可编辑路径', async () => {
  const user = userEvent.setup()
  const gateway = createMockGateway({ eventStream: 'memory' })
  const created: DatabaseInstance = { id: 'sqlite-real', engine: 'SQLite', name: 'notes', version: '3.54', status: 'running', updatedAt: '2026-09-28T00:00:00.000Z', filePath: '/root/.Elysian/data/sqlite/a.db', source: 'managed' }
  const create = vi.fn(async () => created)
  Object.assign(gateway.databases, { create })
  render(<GatewayProvider gateway={gateway}><DatabaseCreateDialog /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加SQLite数据库' })
  expect(within(dialog).queryByLabelText('落点目录')).not.toBeInTheDocument()
  expect(within(dialog).getByText(/先导出快照/)).toBeInTheDocument()
  const file = new File(['SQLite format 3\0'], 'notes.db', { type: 'application/vnd.sqlite3' })
  fireEvent.drop(within(dialog).getByText('把 SQLite 数据库文件拖到这里'), { dataTransfer: { files: [file] } })
  await user.click(within(dialog).getByRole('button', { name: '上传并创建' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file', name: 'notes', file }), expect.any(Function)))
})
