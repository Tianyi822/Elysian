import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ContainerImage, DatabaseContainerInstance, ImagePullProgress } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useContainersStore } from '../../stores/containersStore'
import { IMAGE_PULL_PREFERENCES_KEY } from '../../utils/imagePullPreferences'
import { RealDatabaseCreateDialog } from './RealDatabaseCreateDialog'

/**
 * 添加数据库容器弹窗：镜像源走共享预设出口、版本查询与拉取复用容器域接缝、
 * 访问范围三档与公网确认保留；逻辑库与账号收集已退役，弹窗不出现这些字段。
 */

const image: ContainerImage = {
  id: 'sha256:' + 'a'.repeat(64), name: 'mysql', tag: '8.4', digest: '', sizeMb: 100, pulledAt: null,
}
const OFFICIAL_PRESET = { id: 'official', label: '官方源 Docker Hub', url: 'https://registry-1.docker.io' }
const created: DatabaseContainerInstance = {
  id: 'ctr-elysian-mysql', engine: 'MySQL', name: 'elysian-mysql', version: '8.4', status: 'running',
  image: 'mysql:8.4', containerId: 'ctr-elysian-mysql', source: 'managed', versionTag: '8.4',
  ports: [], networks: ['elysian-db-local'], credentialUsername: 'root', credentialsVerified: true,
  needsAttention: false, updatedAt: '2026-09-28T00:00:00.000Z',
}

beforeEach(() => {
  useDatabaseStore.setState({
    status: 'ready', engine: 'MySQL',
    createOpen: true, createKind: 'container', creating: false, createError: undefined,
    databases: [], sqliteFiles: [],
  })
  useContainersStore.setState(useContainersStore.getInitialState(), true)
})

afterEach(() => {
  localStorage.removeItem(IMAGE_PULL_PREFERENCES_KEY)
})

/** 数据库域走 http adapter（jsdom 不可达），容器域方法按用例替换：Object.create 保留原型其余方法。 */
function dialogGateway(overrides: {
  presets?: typeof OFFICIAL_PRESET[]
  tags?: readonly string[]
  tagSearchable?: boolean
  images?: readonly ContainerImage[]
  pullImage?: ReturnType<typeof vi.fn>
  create?: ReturnType<typeof vi.fn>
}): ElysianGateway {
  const base = createMockGateway({ eventStream: 'memory' })
  const containers = Object.assign(Object.create(base.containers), {
    listRegistryPresets: vi.fn(async () => overrides.presets ?? [OFFICIAL_PRESET]),
    imageTags: vi.fn(async () => ({ tags: overrides.tags ?? [], searchable: overrides.tagSearchable ?? true })),
    listImages: vi.fn(async () => overrides.images ?? []),
    list: vi.fn(async () => []),
    ...(overrides.pullImage ? { pullImage: overrides.pullImage } : {}),
  })
  const databases = Object.assign(Object.create(base.databases), {
    list: vi.fn(async () => []),
    listSqlite: vi.fn(async () => []),
    ...(overrides.create ? { create: overrides.create } : {}),
  })
  return { ...base, containers, databases }
}

it('弹窗不提供逻辑库、账号与接管入口：只有镜像、容器与访问三组字段', async () => {
  const gateway = dialogGateway({})
  render(<GatewayProvider gateway={gateway}><RealDatabaseCreateDialog engine="MySQL" /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加 MySQL 数据库' })

  expect(await within(dialog).findByText('官方源 Docker Hub')).toBeInTheDocument()
  expect(within(dialog).queryByLabelText('逻辑库名')).not.toBeInTheDocument()
  expect(within(dialog).queryByLabelText('字符集')).not.toBeInTheDocument()
  expect(within(dialog).queryByLabelText('账号名')).not.toBeInTheDocument()
  expect(within(dialog).queryByLabelText('密码')).not.toBeInTheDocument()
  expect(within(dialog).queryByRole('button', { name: '使用已有容器' })).not.toBeInTheDocument()
  expect(within(dialog).queryByRole('button', { name: '验证并接管' })).not.toBeInTheDocument()
  expect(within(dialog).getByLabelText('镜像名称')).toHaveTextContent('mysql')
  // 管理员凭据由服务端生成并在卡片上复制读取，弹窗只作说明。
  expect(within(dialog).getByText(/管理员账号与密码由面板生成/)).toBeInTheDocument()
})

it('latest 被拒；拉取镜像带进度与源地址，完成后提示本地镜像已就绪', async () => {
  const user = userEvent.setup()
  let finishPull: ((image: ContainerImage) => void) | undefined
  const pullImage = vi.fn((_input: unknown, onProgress?: (progress: ImagePullProgress) => void) => {
    onProgress?.({ phase: 'downloading', layerId: 'abc123', currentBytes: 50, totalBytes: 100 })
    return new Promise<ContainerImage>((resolve) => { finishPull = resolve })
  })
  const create = vi.fn(async () => ({ instance: created, firewallPort: null }))
  // 拉取完成前本地无镜像；拉取后服务端清单出现该镜像，refresh 据此把「已就绪」点亮。
  const localImages: ContainerImage[] = []
  const gateway = dialogGateway({ tags: ['8.0', '8.4', 'latest'], images: localImages, pullImage, create })
  render(<GatewayProvider gateway={gateway}><RealDatabaseCreateDialog engine="MySQL" /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加 MySQL 数据库' })

  const version = within(dialog).getByRole('textbox', { name: /版本标签/ })
  await user.type(version, 'latest')
  expect(within(dialog).getByText('请输入明确的数字版本标签')).toBeInTheDocument()
  expect(within(dialog).queryByRole('button', { name: '拉取镜像' })).not.toBeInTheDocument()

  await user.clear(version)
  await user.type(version, '8.4')
  expect(within(dialog).getByText('registry-1.docker.io/mysql:8.4')).toBeInTheDocument()

  await user.click(within(dialog).getByRole('button', { name: '拉取镜像' }))
  expect(pullImage).toHaveBeenCalledWith({ name: 'mysql', tag: '8.4', registry: 'https://registry-1.docker.io' }, expect.any(Function))
  expect(await within(dialog).findByRole('progressbar', { name: '当前窗口镜像拉取进度' })).toHaveAttribute('aria-valuenow', '50')
  expect(within(dialog).getByText('50 B / 100 B · 50%')).toBeInTheDocument()
  // 拉取期间关闭与提交都锁住。
  expect(within(dialog).getByRole('button', { name: '关闭弹窗' })).toBeDisabled()

  localImages.push(image)
  finishPull?.(image)
  expect(await within(dialog).findByText('本地镜像已就绪：mysql:8.4')).toBeInTheDocument()
  await user.click(within(dialog).getByRole('button', { name: '创建并启动' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'container', engine: 'MySQL', versionTag: '8.4', containerName: 'elysian-mysql', imageId: image.id,
  })))
})

it('拉取失败在行内报错并可重试', async () => {
  const user = userEvent.setup()
  let attempts = 0
  const pullImage = vi.fn((_input: unknown, onProgress?: (progress: ImagePullProgress) => void) => {
    attempts += 1
    if (attempts === 1) return Promise.reject(new Error('仓库暂不可用'))
    onProgress?.({ phase: 'downloading', layerId: 'abc123', currentBytes: 50, totalBytes: 100 })
    return Promise.resolve(image)
  })
  const gateway = dialogGateway({ images: [image], pullImage })
  render(<GatewayProvider gateway={gateway}><RealDatabaseCreateDialog engine="MySQL" /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加 MySQL 数据库' })

  const version = within(dialog).getByRole('textbox', { name: /版本标签/ })
  await user.type(version, '8.4')
  await user.click(within(dialog).getByRole('button', { name: '拉取镜像' }))
  expect(await within(dialog).findByText('拉取失败：仓库暂不可用')).toBeInTheDocument()
  await user.click(within(dialog).getByRole('button', { name: '拉取镜像' }))
  expect(await within(dialog).findByText('本地镜像已就绪：mysql:8.4')).toBeInTheDocument()
  expect(attempts).toBe(2)
})

it('访问范围三档保留：任意主机需端口与公网确认，提交载荷不再有账号字段', async () => {
  const user = userEvent.setup()
  const create = vi.fn(async () => ({ instance: created, firewallPort: null }))
  const gateway = dialogGateway({ images: [image], create })
  // 弹窗的本地镜像判断读 store 的镜像清单：页面的列表刷新已把本地镜像装进 store，测试里等价播种。
  useContainersStore.setState({ images: [image] })
  render(<GatewayProvider gateway={gateway}><RealDatabaseCreateDialog engine="MySQL" /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加 MySQL 数据库' })

  await user.type(within(dialog).getByRole('textbox', { name: /版本标签/ }), '8.4')
  expect(await within(dialog).findByText('本地镜像已就绪：mysql:8.4')).toBeInTheDocument()

  const submit = within(dialog).getByRole('button', { name: '创建并启动' })
  await user.click(within(dialog).getByRole('button', { name: /访问范围/ }))
  await user.click(await screen.findByRole('menuitemradio', { name: '任意主机' }))
  expect(submit).toBeDisabled()
  await user.type(within(dialog).getByLabelText('宿主端口'), '43306')
  await user.click(within(dialog).getByRole('checkbox', { name: /确认数据库端口/ }))
  expect(within(dialog).getByText('创建成功后将自动在防火墙开放该端口。')).toBeInTheDocument()
  await user.click(submit)
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'container', engine: 'MySQL', versionTag: '8.4', containerName: 'elysian-mysql',
    imageId: image.id, accessScope: 'any-host', hostPort: 43306, confirmPublic: true,
  })))
})

it('镜像源预设来自共享目录，自定义地址经既有偏好出口持久化', async () => {
  const user = userEvent.setup()
  const gateway = dialogGateway({ presets: [OFFICIAL_PRESET] })
  render(<GatewayProvider gateway={gateway}><RealDatabaseCreateDialog engine="MySQL" /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加 MySQL 数据库' })

  await user.click(within(dialog).getByRole('button', { name: /镜像源/ }))
  await user.click(await screen.findByRole('menuitemradio', { name: '自定义地址…' }))
  const custom = within(dialog).getByLabelText('自定义镜像源地址')
  await user.type(custom, 'docker.1ms.run')
  // 偏好出口持久化最近的有效源地址。
  expect(JSON.parse(localStorage.getItem(IMAGE_PULL_PREFERENCES_KEY) ?? '{}')).toMatchObject({ version: 1, registry: 'docker.1ms.run' })
  await user.type(within(dialog).getByRole('textbox', { name: /版本标签/ }), '8.4')
  expect(await within(dialog).findByText('docker.1ms.run/mysql:8.4')).toBeInTheDocument()
})

it.each(['MariaDB', 'Redis'] as const)('%s 弹窗固定镜像名称并给出对应版本占位', async (engine) => {
  const gateway = dialogGateway({})
  render(<GatewayProvider gateway={gateway}><RealDatabaseCreateDialog engine={engine} /></GatewayProvider>)
  const dialog = screen.getByRole('dialog', { name: '添加 ' + engine + ' 数据库' })
  expect(within(dialog).getByLabelText('镜像名称')).toHaveTextContent(engine.toLowerCase())
  expect(within(dialog).getByRole('textbox', { name: /版本标签/ })).toHaveAttribute('placeholder', engine === 'MariaDB' ? '例如 11.4' : '例如 7.4')
})
