import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ContainerImage, DatabaseInstance } from '@elysian/contracts'
import type { DatabaseCreateInput } from '../../contracts/adapters'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useDatabaseStore } from '../../stores/databaseStore'
import { RealDatabaseCreateDialog } from './RealDatabaseCreateDialog'

const image: ContainerImage = {
  id: `sha256:${'a'.repeat(64)}`, name: 'mysql', tag: '8.4', digest: '', sizeMb: 100, pulledAt: null,
}
const created: DatabaseInstance = {
  id: 'real-1', engine: 'MySQL', name: 'orders', version: '8.4.1', status: 'running',
  source: 'managed', versionTag: '8.4', updatedAt: '2026-09-28T00:00:00.000Z',
}

beforeEach(() => useDatabaseStore.setState({ createOpen: true, creating: false, databases: [] }))

it('缺镜像先拉取；明确版本、公网端口和二次确认齐备后创建', async () => {
  const user = userEvent.setup()
  const gateway = createMockGateway({ eventStream: 'memory' })
  let pulled = false
  const discover = vi.fn(async () => ({ images: pulled ? [image] : [], containers: [] }))
  const pullImage = vi.fn(async () => { pulled = true; return image })
  const create = vi.fn(async (_input: DatabaseCreateInput) => created)
  Object.assign(gateway.databases, { discover, create })
  Object.assign(gateway.containers, { pullImage })
  render(<GatewayProvider gateway={gateway}><RealDatabaseCreateDialog engine="MySQL" /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加 MySQL 数据库' })
  const submit = within(dialog).getByRole('button', { name: '创建并启动' })
  expect(submit).toBeDisabled()
  await user.type(within(dialog).getByLabelText(/版本标签/), '8.4')
  expect(await within(dialog).findByText('当前没有 MySQL:8.4 镜像。')).toBeInTheDocument()
  await user.click(within(dialog).getByRole('button', { name: '拉取镜像' }))
  await waitFor(() => expect(pullImage).toHaveBeenCalledWith({ name: 'mysql', tag: '8.4' }, expect.any(Function)))
  await user.type(within(dialog).getByLabelText('逻辑库名'), 'orders')
  await user.type(within(dialog).getByLabelText('普通账号'), 'reader')
  await user.type(within(dialog).getByLabelText(/普通账号密码/), 'strong-password-123')
  expect(dialog.querySelector('select')).toBeNull()
  await user.click(within(dialog).getByRole('button', { name: /访问范围/ }))
  await user.click(await screen.findByRole('menuitemradio', { name: '任意主机' }))
  await user.type(within(dialog).getByLabelText('宿主端口'), '43306')
  expect(submit).toBeDisabled()
  await user.click(within(dialog).getByRole('checkbox', { name: /确认数据库端口/ }))
  expect(submit).toBeEnabled()
  await user.click(submit)
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
    engine: 'MySQL', versionTag: '8.4', name: 'orders', accessScope: 'any-host',
    hostPort: 43306, confirmPublic: true,
    target: { kind: 'new', imageId: image.id, containerName: 'elysian-mysql' },
  })))
})
