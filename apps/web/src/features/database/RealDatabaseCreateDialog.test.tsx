import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ContainerImage, DatabaseInstance, ImagePullProgress } from '@elysian/contracts'
import type { DatabaseCreateInput } from '../../contracts/adapters'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useDatabaseStore } from '../../stores/databaseStore'
import { RealDatabaseCreateDialog } from './RealDatabaseCreateDialog'

const image: ContainerImage = {
  id: 'sha256:' + 'a'.repeat(64), name: 'mysql', tag: '8.4', digest: '', sizeMb: 100, pulledAt: null,
}
const created: DatabaseInstance = {
  id: 'real-1', engine: 'MySQL', name: 'orders', version: '8.4.1', status: 'running',
  versionTag: '8.4', source: 'managed', updatedAt: '2026-09-28T00:00:00.000Z',
}
const managed = { id: 'managed-1', name: 'mysql-managed', accessScope: 'container-network', managed: true, versionTag: '8.4' }
const external = { id: 'external-1', name: 'mysql-external', accessScope: 'localhost', managed: false, versionTag: '8.0' }

beforeEach(() => useDatabaseStore.setState({ createOpen: true, creating: false, createError: undefined, databases: [] }))

it('默认选择已有容器，版本与范围来自候选；面板容器创建逻辑库', async () => {
  const user = userEvent.setup()
  const gateway = createMockGateway({ eventStream: 'memory' })
  const create = vi.fn(async (_input: DatabaseCreateInput) => created)
  Object.assign(gateway.databases, {
    discover: vi.fn(async () => ({ images: [image], containers: [managed] })),
    create,
  })
  render(<GatewayProvider gateway={gateway}><RealDatabaseCreateDialog engine="MySQL" /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加 MySQL 数据库' })
  expect(within(dialog).getByRole('button', { name: '使用已有容器' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(await within(dialog).findByRole('button', { name: /运行中的容器：选择已有容器/ }))
  await user.click(await screen.findByRole('menuitemradio', { name: /mysql-managed · mysql:8.4/ }))
  expect(within(dialog).getByText(/版本 8.4 · 容器网络内/)).toBeInTheDocument()
  await user.type(within(dialog).getByLabelText('逻辑库名'), 'orders')
  await user.type(within(dialog).getByLabelText('账号名'), 'reader')
  await user.type(within(dialog).getByLabelText('密码'), 'secret')
  await user.click(within(dialog).getByRole('button', { name: '创建逻辑库' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
    engine: 'MySQL', versionTag: '8.4', accessScope: 'container-network',
    target: { kind: 'managed', containerId: 'managed-1' },
  })))
})

it('外部容器仅验证接管，显示已有管理员凭证字段', async () => {
  const user = userEvent.setup()
  const gateway = createMockGateway({ eventStream: 'memory' })
  const create = vi.fn(async (_input: DatabaseCreateInput) => created)
  Object.assign(gateway.databases, {
    discover: vi.fn(async () => ({ images: [], containers: [external] })),
    create,
  })
  render(<GatewayProvider gateway={gateway}><RealDatabaseCreateDialog engine="MySQL" /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加 MySQL 数据库' })
  await user.click(await within(dialog).findByRole('button', { name: /运行中的容器：选择已有容器/ }))
  await user.click(await screen.findByRole('menuitemradio', { name: /mysql-external · mysql:8.0/ }))
  expect(within(dialog).getByText(/接管不修改端口或网络范围/)).toBeInTheDocument()
  await user.type(within(dialog).getByLabelText('逻辑库名'), 'orders')
  await user.type(within(dialog).getByLabelText('账号名'), 'reader')
  await user.type(within(dialog).getByLabelText('密码'), 'existing-password')
  expect(within(dialog).getByRole('button', { name: '验证并接管' })).toBeDisabled()
  await user.type(within(dialog).getByLabelText('管理员密码'), 'admin-password')
  await user.click(within(dialog).getByRole('button', { name: '验证并接管' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
    versionTag: '8.0', accessScope: 'localhost',
    target: { kind: 'adopt', containerId: 'external-1', admin: { username: 'root', password: 'admin-password' } },
  })))
})

it('无容器时在当前弹窗拉取：自定义源、进度、失败重试和公网确认', async () => {
  const user = userEvent.setup()
  const gateway = createMockGateway({ eventStream: 'memory' })
  let pulled = false
  let finishPull: ((image: ContainerImage) => void) | undefined
  let attempts = 0
  const discover = vi.fn(async () => ({ images: pulled ? [image] : [], containers: [] }))
  const pullImage = vi.fn((_input: unknown, onProgress?: (progress: ImagePullProgress) => void) => {
    attempts += 1
    if (attempts === 1) return Promise.reject(new Error('仓库暂不可用'))
    onProgress?.({ phase: 'downloading', layerId: 'abc123', currentBytes: 50, totalBytes: 100 })
    return new Promise<ContainerImage>((resolve) => { finishPull = (result) => { pulled = true; resolve(result) } })
  })
  const create = vi.fn(async (_input: DatabaseCreateInput) => created)
  Object.assign(gateway.databases, { discover, create })
  Object.assign(gateway.containers, { pullImage })
  render(<GatewayProvider gateway={gateway}><RealDatabaseCreateDialog engine="MySQL" /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加 MySQL 数据库' })
  await user.click(await within(dialog).findByRole('button', { name: '拉取镜像并新建容器' }))
  await user.type(within(dialog).getByLabelText('自定义镜像源地址'), 'docker.1ms.run')
  const version = within(dialog).getByRole('textbox', { name: /版本标签/ })
  await user.type(version, 'latest')
  expect(within(dialog).getByText('请输入明确的数字版本标签')).toBeInTheDocument()
  expect(within(dialog).queryByRole('button', { name: '拉取镜像' })).not.toBeInTheDocument()
  await user.clear(version)
  await user.type(version, '8.4')
  expect(within(dialog).getByText('docker.1ms.run/mysql:8.4')).toBeInTheDocument()
  await user.click(within(dialog).getByRole('button', { name: '拉取镜像' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('仓库暂不可用')
  await user.click(within(dialog).getByRole('button', { name: '拉取镜像' }))
  expect(await within(dialog).findByRole('progressbar', { name: '当前窗口镜像拉取进度' })).toHaveAttribute('aria-valuenow', '50')
  expect(within(dialog).getByRole('button', { name: '关闭弹窗' })).toBeDisabled()
  expect(screen.getByRole('dialog', { name: '添加 MySQL 数据库' })).toBeInTheDocument()
  finishPull?.(image)
  expect(await within(dialog).findByText('本地镜像已就绪：mysql:8.4')).toBeInTheDocument()
  expect(pullImage).toHaveBeenLastCalledWith({ name: 'mysql', tag: '8.4', registry: 'docker.1ms.run' }, expect.any(Function))
  await user.type(within(dialog).getByLabelText('逻辑库名'), 'orders')
  await user.type(within(dialog).getByLabelText('账号名'), 'reader')
  await user.type(within(dialog).getByLabelText(/密码（至少 12 位）/), 'strong-password-123')
  await user.click(within(dialog).getByRole('button', { name: /访问范围/ }))
  await user.click(await screen.findByRole('menuitemradio', { name: '任意主机' }))
  await user.type(within(dialog).getByLabelText('宿主端口'), '43306')
  const submit = within(dialog).getByRole('button', { name: '创建并启动' })
  expect(submit).toBeDisabled()
  await user.click(within(dialog).getByRole('checkbox', { name: /确认数据库端口/ }))
  await user.click(submit)
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
    engine: 'MySQL', versionTag: '8.4', name: 'orders', accessScope: 'any-host',
    hostPort: 43306, confirmPublic: true,
    target: { kind: 'new', imageId: image.id, containerName: 'elysian-mysql' },
  })))
})

it.each(['MariaDB', 'Redis'] as const)('%s 无容器时提供新建入口并固定镜像名称', async (engine) => {
  const gateway = createMockGateway({ eventStream: 'memory' })
  Object.assign(gateway.databases, { discover: vi.fn(async () => ({ images: [], containers: [] })) })
  render(<GatewayProvider gateway={gateway}><RealDatabaseCreateDialog engine={engine} /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加 ' + engine + ' 数据库' })
  const user = userEvent.setup()
  await user.click(await within(dialog).findByRole('button', { name: '拉取镜像并新建容器' }))
  expect(within(dialog).getByLabelText('镜像名称')).toHaveTextContent(engine.toLowerCase())
  if (engine === 'Redis') {
    expect(within(dialog).getByText('Redis DB 0')).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('逻辑库名')).not.toBeInTheDocument()
  }
})
