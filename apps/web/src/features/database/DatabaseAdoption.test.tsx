import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseContainerInstance } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { DatabaseAdapter, ElysianGateway } from '../../contracts/adapters'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useMessageStore } from '../../stores/messageStore'
import { DatabaseContainerCard } from './DatabaseContainerCard'
import { projectDatabaseCard } from './projectDatabaseCard'

const UNMANAGED: DatabaseContainerInstance = {
  id: 'ctr-mysql-external',
  engine: 'MySQL',
  name: 'mysql-external',
  version: '8.0.36',
  status: 'running',
  image: 'mysql:8.0',
  containerId: 'ctr-mysql-external',
  versionTag: '8.0',
  ports: [{ containerPort: 3306, hostPort: 13308, protocol: 'tcp', hostIp: '127.0.0.1' }],
  networks: ['bridge'],
  credentialsVerified: false,
  needsAttention: false,
  updatedAt: '2026-09-12T08:00:00.000Z',
}

const ADOPTED: DatabaseContainerInstance = { ...UNMANAGED, id: 'ctr-mysql-adopted', name: 'mysql-adopted', source: 'adopted', credentialsVerified: true, credentialUsername: 'root' }

const MANAGED: DatabaseContainerInstance = { ...UNMANAGED, id: 'ctr-mysql-managed', name: 'mysql-managed', source: 'managed', credentialsVerified: true, credentialUsername: 'root' }

function renderCard(row: DatabaseContainerInstance, databases: Partial<DatabaseAdapter>) {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const gateway: ElysianGateway = { ...base, databases: { ...base.databases, ...databases } }
  render(
    <GatewayProvider gateway={gateway}>
      <DatabaseContainerCard row={row} view={projectDatabaseCard(row, new Map())} removing={false} onJump={() => {}} onRemove={() => {}} />
    </GatewayProvider>,
  )
}

beforeEach(() => {
  useMessageStore.setState(useMessageStore.getInitialState(), true)
  useDatabaseStore.setState({ status: 'ready', databases: [], sqliteFiles: [] })
})

describe('数据库页接管自装容器', () => {
  it('未登记的运行中容器显示接管入口，受管与已接管的不显示', () => {
    renderCard(UNMANAGED, {})
    expect(screen.getByRole('button', { name: '接管' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '解除接管' })).not.toBeInTheDocument()
  })

  it('已接管的容器显示解除接管而不是接管', () => {
    renderCard(ADOPTED, {})
    expect(screen.getByRole('button', { name: '解除接管' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '接管' })).not.toBeInTheDocument()
  })

  it('受管实例不显示接管或解除接管', () => {
    renderCard(MANAGED, {})
    expect(screen.queryByRole('button', { name: '接管' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '解除接管' })).not.toBeInTheDocument()
  })

  it('在弹窗里填写凭据后接管，密码只发给面板', async () => {
    const user = userEvent.setup()
    const adopt = vi.fn(async () => ADOPTED)
    renderCard(UNMANAGED, { adopt, list: async () => [], listSqlite: async () => [] })
    await user.click(screen.getByRole('button', { name: '接管' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/只保存在面板登记里/)).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('管理员用户名'), 'root')
    await user.type(within(dialog).getByLabelText('管理员密码'), 'admin-secret')
    await user.click(within(dialog).getByRole('button', { name: '核验并接管' }))
    await waitFor(() => expect(adopt).toHaveBeenCalledWith('ctr-mysql-external', { username: 'root', password: 'admin-secret' }))
    await waitFor(() => expect(useMessageStore.getState().messages.some((item) => item.message.includes('已接管容器 mysql-external'))).toBe(true))
  })

  it('Redis 容器留空用户名时按 default 核验，MySQL 仍按 root', async () => {
    const user = userEvent.setup()
    const adopt = vi.fn(async () => ADOPTED)
    renderCard({ ...UNMANAGED, engine: 'Redis', name: 'redis-external' }, { adopt, list: async () => [], listSqlite: async () => [] })
    await user.click(screen.getByRole('button', { name: '接管' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('管理员用户名')).toHaveAttribute('placeholder', 'default')
    await user.type(within(dialog).getByLabelText('管理员密码'), 'redis-secret')
    await user.click(within(dialog).getByRole('button', { name: '核验并接管' }))
    await waitFor(() => expect(adopt).toHaveBeenCalledWith('ctr-mysql-external', { username: 'default', password: 'redis-secret' }))
  })

  it('核验失败时在弹窗里说明原因且不关闭', async () => {
    const user = userEvent.setup()
    const adopt = vi.fn(async () => { throw new Error('无法用该凭据登录容器内的数据库，请确认用户名与密码后重试') })
    renderCard(UNMANAGED, { adopt })
    await user.click(screen.getByRole('button', { name: '接管' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('管理员密码'), 'wrong')
    await user.click(within(dialog).getByRole('button', { name: '核验并接管' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('无法用该凭据登录')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('解除接管需确认，确认后调用解除接口', async () => {
    const user = userEvent.setup()
    const releaseAdoption = vi.fn(async () => {})
    renderCard(ADOPTED, { releaseAdoption })
    await user.click(screen.getByRole('button', { name: '解除接管' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/容器与数据保持原样/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '确认解除接管' }))
    await waitFor(() => expect(releaseAdoption).toHaveBeenCalledWith('ctr-mysql-adopted'))
  })
})
