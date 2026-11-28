import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseContainerInstance } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway } from '../../contracts/adapters'
import { useMessageStore } from '../../stores/messageStore'
import { DatabaseContainerCard } from './DatabaseContainerCard'
import { projectDatabaseCard } from './projectDatabaseCard'

/**
 * 数据库卡片的逻辑库区：Agent 在实例里建的库与专属用户在这里列出，
 * 密码不随列表下发，只在用户点击复制时按「库 + 用户」读取。
 */
const ROW: DatabaseContainerInstance = {
  id: 'ctr-mysql-primary',
  engine: 'MySQL',
  name: 'mysql-primary',
  version: '8.0.36',
  status: 'running',
  image: 'mysql:8.0',
  containerId: 'ctr-mysql-primary',
  source: 'managed',
  versionTag: '8.0',
  ports: [{ containerPort: 3306, hostPort: 13306, protocol: 'tcp', hostIp: '127.0.0.1' }],
  networks: ['elysian-db-local'],
  address: { host: '127.0.0.1', port: 13306 },
  credentialUsername: 'root',
  credentialsVerified: true,
  needsAttention: false,
  updatedAt: '2026-09-12T08:00:00.000Z',
  resourceTier: 'small',
  databases: [
    { id: 'logical-shop', kind: 'database', name: 'shop', users: ['shop_user'], state: 'active', createdAt: '2026-11-26T08:00:00.000Z' },
    { id: 'logical-orders', kind: 'database', name: 'orders', users: ['orders_user', 'reporter'], state: 'pending', createdAt: '2026-11-26T09:00:00.000Z' },
  ],
}

function renderCard(row: DatabaseContainerInstance, reveal: ElysianGateway['databases']['reveal']) {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const gateway: ElysianGateway = { ...base, databases: { ...base.databases, reveal } }
  render(
    <GatewayProvider gateway={gateway}>
      <DatabaseContainerCard
        row={row}
        view={projectDatabaseCard(row, new Map())}
        removing={false}
        onJump={() => {}}
        onRemove={() => {}}
      />
    </GatewayProvider>,
  )
}

beforeEach(() => {
  useMessageStore.setState(useMessageStore.getInitialState(), true)
})

describe('数据库卡片的逻辑库区', () => {
  it('列出面板登记的数据库与用户，待确认的登记如实标注，不显示密码', () => {
    renderCard(ROW, vi.fn())
    const section = screen.getByRole('region', { name: '数据库' })
    const shop = within(section).getByRole('group', { name: '数据库 shop' })
    expect(within(shop).getByText('shop_user')).toBeInTheDocument()
    expect(within(shop).queryByText('待确认')).not.toBeInTheDocument()
    const orders = within(section).getByRole('group', { name: '数据库 orders' })
    expect(within(orders).getByText('orders_user')).toBeInTheDocument()
    expect(within(orders).getByText('reporter')).toBeInTheDocument()
    expect(within(orders).getByText('待确认')).toBeInTheDocument()
    expect(section.textContent).not.toMatch(/password|密码值/)
  })

  it('复制逻辑库用户的密码时按库与用户读取凭据，不读管理员凭据', async () => {
    const user = userEvent.setup()
    const reveal = vi.fn(async () => ({ username: 'shop_user', password: 'user-secret-value' }))
    renderCard(ROW, reveal)
    const shop = within(screen.getByRole('region', { name: '数据库' })).getByRole('group', { name: '数据库 shop' })
    await user.click(within(shop).getByRole('button', { name: '复制密码' }))
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('ctr-mysql-primary', { database: 'shop', username: 'shop_user' }))
    expect(await navigator.clipboard.readText()).toBe('user-secret-value')
    // 密码只进剪贴板，不上屏。
    expect(screen.queryByText('user-secret-value')).not.toBeInTheDocument()
  })

  it('复制逻辑库用户的用户名', async () => {
    const user = userEvent.setup()
    const reveal = vi.fn(async () => ({ username: 'orders_user', password: 'x' }))
    renderCard(ROW, reveal)
    const orders = within(screen.getByRole('region', { name: '数据库' })).getByRole('group', { name: '数据库 orders' })
    const [usernameButton] = within(orders).getAllByRole('button', { name: '复制用户名' })
    if (!usernameButton) throw new Error('缺少复制用户名按钮')
    await user.click(usernameButton)
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('ctr-mysql-primary', { database: 'orders', username: 'orders_user' }))
    expect(await navigator.clipboard.readText()).toBe('orders_user')
  })

  it('读取凭据失败时在卡片内说明原因，不写入剪贴板', async () => {
    const user = userEvent.setup()
    await navigator.clipboard.writeText('保留的文本')
    renderCard(ROW, vi.fn(async () => { throw new Error('数据库不存在') }))
    const shop = within(screen.getByRole('region', { name: '数据库' })).getByRole('group', { name: '数据库 shop' })
    await user.click(within(shop).getByRole('button', { name: '复制密码' }))
    await waitFor(() => {
      expect(useMessageStore.getState().messages.some((item) => item.message.includes('读取数据库用户凭据失败'))).toBe(true)
    })
    expect(await navigator.clipboard.readText()).toBe('保留的文本')
  })

  it('实例里没有登记的数据库时不显示该区', () => {
    const bare = { ...ROW, databases: undefined, resourceTier: undefined }
    renderCard(bare, vi.fn())
    expect(screen.queryByRole('region', { name: '数据库' })).not.toBeInTheDocument()
  })
})
