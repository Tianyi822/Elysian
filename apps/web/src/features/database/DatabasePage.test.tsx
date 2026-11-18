import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseContainerInstance, DatabaseInstance } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useContainersStore } from '../../stores/containersStore'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useMessageStore } from '../../stores/messageStore'
import { renderApp } from '../../test/renderApp'

/**
 * 数据库页 = 容器管理（按数据库镜像筛选）+ 常驻 SQLite 文件分区。
 * 服务端列表响应的内联基准行：容器行主键是容器 ID，凭据只给状态与用户名，明文只在 reveal 时读取。
 */
const MARIADB_ROW: DatabaseContainerInstance = {
  id: 'ctr-mariadb-primary',
  engine: 'MariaDB',
  name: 'mariadb-primary',
  version: '10.11.8',
  status: 'running',
  image: 'mariadb:10.11.8',
  containerId: 'ctr-mariadb-primary',
  source: 'managed',
  versionTag: '10.11.8',
  ports: [{ containerPort: 3306, hostPort: 13306, protocol: 'tcp', hostIp: '127.0.0.1' }],
  networks: ['elysian-db-local'],
  volumeName: 'elysian-db-0f0e0d0c0b0a09080706050403020100',
  address: { host: '127.0.0.1', port: 13306 },
  credentialUsername: 'root',
  credentialsVerified: true,
  memory: { usedGb: 1.5, totalGb: 4 },
  needsAttention: false,
  updatedAt: '2026-09-12T08:00:00.000Z',
}

const MYSQL_ROW: DatabaseContainerInstance = {
  id: 'ctr-mysql-orders',
  engine: 'MySQL',
  name: 'mysql-orders',
  version: '8.4.2',
  status: 'stopped',
  image: 'mysql:8.4.2',
  containerId: 'ctr-mysql-orders',
  source: 'adopted',
  versionTag: '8.4.2',
  ports: [{ containerPort: 3306, hostPort: 13307, protocol: 'tcp', hostIp: '0.0.0.0' }],
  networks: ['elysian-db-shared'],
  credentialUsername: 'root',
  credentialsVerified: true,
  needsAttention: false,
  updatedAt: '2026-09-12T08:00:00.000Z',
}

const REDIS_ROW: DatabaseContainerInstance = {
  // 外部容器（如 Agent 容器工具创建）：未登记，凭据状态恒为未核验，不摆复制与删除入口。
  id: 'ctr-redis-agent',
  engine: 'Redis',
  name: 'redis-agent',
  version: '7.4',
  status: 'running',
  image: 'redis:7.4',
  containerId: 'ctr-redis-agent',
  ports: [{ containerPort: 6379, protocol: 'tcp' }],
  networks: ['bridge'],
  credentialsVerified: false,
  needsAttention: false,
  updatedAt: '2026-09-12T08:00:00.000Z',
}

const ATTENTION_ROW: DatabaseContainerInstance = {
  id: 'ctr-mariadb-broken',
  engine: 'MariaDB',
  name: 'mariadb-broken',
  version: '10.11.8',
  status: 'stopped',
  image: 'mariadb:10.11.8',
  containerId: 'ctr-mariadb-broken',
  source: 'managed',
  versionTag: '10.11.8',
  ports: [],
  networks: ['elysian-db-local'],
  volumeName: 'elysian-db-11112222333344445555666677778888',
  credentialsVerified: true,
  needsAttention: true,
  updatedAt: '2026-09-12T08:00:00.000Z',
}

const NOTES_FILE: DatabaseInstance = {
  id: 'sqlite-notes',
  engine: 'SQLite',
  name: 'elysian-notes',
  version: '3.46.1',
  status: 'running',
  source: 'managed',
  filePath: '/root/.Elysian/data/sqlite/elysian-notes.db',
  fileSizeMb: 4.2,
  tableCount: 3,
  lastWrittenAt: '2026-09-11T15:20:00.000Z',
  updatedAt: '2026-09-12T08:00:00.000Z',
}

const PENDING_FILE: DatabaseInstance = {
  id: 'sqlite-orders',
  engine: 'SQLite',
  name: 'orders-import',
  version: '3.46.1',
  status: 'warning',
  source: 'managed',
  filePath: '/root/.Elysian/data/sqlite/orders-import.db',
  fileSizeMb: 1.5,
  needsAttention: true,
  updatedAt: '2026-09-12T08:00:00.000Z',
}

const CONTAINER_FIXTURES = [MARIADB_ROW, MYSQL_ROW, REDIS_ROW, ATTENTION_ROW]
const SQLITE_FIXTURES = [NOTES_FILE, PENDING_FILE]

beforeEach(() => {
  useDatabaseStore.setState({
    engine: 'MariaDB',
    status: 'idle',
    sqliteStatus: 'idle',
    databases: [],
    sqliteFiles: [],
    errorMessage: undefined,
    sqliteErrorMessage: undefined,
    createOpen: false,
    createKind: 'file',
    creating: false,
    removingContainerIds: [],
    removingSqliteIds: [],
  })
  useContainersStore.setState(useContainersStore.getInitialState(), true)
})

/**
 * 数据库域在测试里用自建 fake（gateway 已固定走 http adapter，jsdom 下 fetch 不可达）：
 * fake 像真实服务端一样持有行集——create 落行、删除删行、list 返回当前行集，
 * 因此界面每次 refresh 都以 fake 的状态为准；容器事实仍取 base 的 mock 容器数据集。
 */
function pageGateway(overrides: Partial<ElysianGateway['databases']> = {}): {
  gateway: ElysianGateway
  base: ElysianGateway
  containerRows: DatabaseContainerInstance[]
  sqliteRows: DatabaseInstance[]
} {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const containerRows: DatabaseContainerInstance[] = CONTAINER_FIXTURES.map((row) => structuredClone(row))
  const sqliteRows: DatabaseInstance[] = SQLITE_FIXTURES.map((row) => structuredClone(row))
  const databases: ElysianGateway['databases'] = {
    async list() {
      return containerRows.map((row) => structuredClone(row))
    },
    async listSqlite() {
      return sqliteRows.map((row) => structuredClone(row))
    },
    async create(input, _onProgress) {
      if (input.kind === 'file') {
        const created: DatabaseInstance = {
          id: `sqlite-${input.name}`,
          engine: 'SQLite',
          name: input.name,
          version: '3.46.1',
          status: 'running',
          source: 'managed',
          // 真实链路里路径与大小由服务端决定（randomUUID 命名 + stat 实测），客户端不报送。
          filePath: `/root/.Elysian/data/sqlite/${input.name}.db`,
          fileSizeMb: input.origin === 'uploaded' ? 2 : 0,
          tableCount: 0,
          updatedAt: '2026-09-12T08:00:00.000Z',
        }
        sqliteRows.push(created)
        return { instance: structuredClone(created), firewallPort: null }
      }
      const created: DatabaseContainerInstance = {
        id: `ctr-${input.containerName}`,
        engine: input.engine,
        name: input.containerName,
        version: input.versionTag,
        status: 'running',
        image: `${input.engine.toLowerCase()}:${input.versionTag}`,
        containerId: `ctr-${input.containerName}`,
        source: 'managed',
        versionTag: input.versionTag,
        ports: input.accessScope === 'any-host' && input.hostPort
          ? [{ containerPort: input.engine === 'Redis' ? 6379 : 3306, hostPort: input.hostPort, protocol: 'tcp', hostIp: '0.0.0.0' }]
          : [],
        networks: [input.accessScope === 'container-network' ? 'elysian-db-shared' : 'elysian-db-local'],
        volumeName: 'elysian-db-0f0e0d0c0b0a09080706050403020100',
        address: input.accessScope === 'any-host' && input.hostPort ? { host: '127.0.0.1', port: input.hostPort } : undefined,
        credentialUsername: input.engine === 'Redis' ? 'default' : 'root',
        credentialsVerified: true,
        needsAttention: false,
        updatedAt: '2026-09-12T08:00:00.000Z',
      }
      containerRows.push(created)
      return { instance: structuredClone(created), firewallPort: null }
    },
    async removeSqlite(fileId) {
      const index = sqliteRows.findIndex((row) => row.id === fileId)
      if (index >= 0) sqliteRows.splice(index, 1)
    },
    async removeContainer(containerId) {
      const index = containerRows.findIndex((row) => row.id === containerId)
      if (index >= 0) containerRows.splice(index, 1)
    },
    async reveal(containerId) {
      const row = containerRows.find((item) => item.id === containerId)
      if (!row?.credentialsVerified) throw new Error('该容器没有已核验的管理员凭据')
      return { username: row.credentialUsername ?? 'root', password: 'real-secret-1' }
    },
    async reconcile(containerId) {
      const row = containerRows.find((item) => item.id === containerId)
      if (row) row.needsAttention = false
      return structuredClone(row!)
    },
    async reconcileSqlite(fileId) {
      const row = sqliteRows.find((item) => item.id === fileId)
      if (row) { row.needsAttention = false; row.status = 'running' }
      return structuredClone(row!)
    },
    async forget() { /* 容器行来自 Docker 清单，fake 只作记录 */ },
    async forgetSqlite(fileId) {
      const index = sqliteRows.findIndex((row) => row.id === fileId)
      if (index >= 0) sqliteRows.splice(index, 1)
    },
    async downloadSqlite(fileId) {
      if (!sqliteRows.some((row) => row.id === fileId)) throw new Error('SQLite 文件不存在')
    },
  }
  return { base, gateway: { ...base, databases: Object.assign(databases, overrides) }, containerRows, sqliteRows }
}

describe('数据库页面', () => {
  it('容器卡渲染连接信息：地址、端口、网络、卷、凭据状态与容器内存都来自 Docker 事实', async () => {
    renderApp('/databases', { gateway: pageGateway().gateway })

    const list = await screen.findByRole('list', { name: 'MariaDB 数据库容器列表' })
    const card = within(list).getByRole('article', { name: 'MariaDB 数据库容器 mariadb-primary' })
    expect(card).toHaveTextContent('MariaDB · 10.11.8')
    expect(card).toHaveTextContent('运行中')
    expect(card).toHaveTextContent('mariadb:10.11.8')
    expect(card).toHaveTextContent('127.0.0.1:13306')
    expect(card).toHaveTextContent('容器内存1536.0 MB')
    expect(card).toHaveTextContent('管理员凭据root')
    expect(card).toHaveTextContent('127.0.0.1:13306→3306/tcp')
    expect(card).toHaveTextContent('elysian-db-local')
    expect(card).toHaveTextContent('elysian-db-0f0e0d0c0b0a09080706050403020100')
    expect(within(card).getByLabelText('MariaDB 图标')).toBeInTheDocument()
    // 退役概念不再出现：无逻辑库、无 SQL 会话入口、无「清空 DB 0」。
    expect(screen.queryByText('清空 DB 0')).not.toBeInTheDocument()
    expect(screen.queryByText(/SQL 会话/)).not.toBeInTheDocument()
    expect(screen.queryByText('逻辑库名')).not.toBeInTheDocument()
  })

  it('容器内存读不到时消隐为「不可用」，未登记容器标「未核验」且不给复制与删除入口', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway().gateway })
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Redis' }))

    const card = await screen.findByRole('article', { name: 'Redis 数据库容器 redis-agent' })
    expect(within(card).getAllByText('不可用')).toHaveLength(2)
    expect(within(card).getByText('未核验')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '复制用户名' })).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '复制密码' })).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '删除容器及数据' })).not.toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '停止' })).toBeInTheDocument()
    // 外部容器没有专属卷，如实呈现。
    expect(card).toHaveTextContent('未挂载专属卷')
  })

  it('已停止的登记容器提供启动入口；内存缺省消隐同样适用于登记行', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway().gateway })
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'MySQL' }))

    const card = await screen.findByRole('article', { name: 'MySQL 数据库容器 mysql-orders' })
    expect(within(card).getByText('已停止')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '启动' })).toBeInTheDocument()
    // adopted（接管）行不给删除入口：服务端只删面板创建的容器及专属卷，无 managed 登记恒 403。
    expect(within(card).queryByRole('button', { name: '删除容器及数据' })).not.toBeInTheDocument()
    expect(within(card).getByText('0.0.0.0:13307→3306/tcp')).toBeInTheDocument()
  })

  it('管理员凭据只在点击复制时经 reveal 按需读取，卡片不出现明文', async () => {
    const user = userEvent.setup()
    const reveal = vi.fn(async () => ({ username: 'root', password: 'real-secret-1' }))
    const { gateway } = pageGateway({ reveal })
    renderApp('/databases', { gateway })

    const card = await screen.findByRole('article', { name: 'MariaDB 数据库容器 mariadb-primary' })
    expect(card).not.toHaveTextContent('real-secret-1')
    expect(within(card).getByRole('button', { name: '复制用户名' })).toHaveAttribute(
      'title',
      '从服务端读取并复制管理员用户名',
    )

    await user.click(within(card).getByRole('button', { name: '复制密码' }))
    await expect(navigator.clipboard.readText()).resolves.toBe('real-secret-1')
    expect(reveal).toHaveBeenCalledWith('ctr-mariadb-primary')
  })

  it('启停复用容器动作：停止后列表以服务端状态为准翻成已停止', async () => {
    const user = userEvent.setup()
    const { base, gateway, containerRows } = pageGateway()
    const requestAction = vi.spyOn(base.containers, 'requestAction').mockImplementation(async (containerId, action) => {
      const row = containerRows.find((item) => item.id === containerId)
      if (row) row.status = action === 'stop' ? 'stopped' : 'running'
      return (await base.containers.list())[0]!
    })
    renderApp('/databases', { gateway })

    const card = await screen.findByRole('article', { name: 'MariaDB 数据库容器 mariadb-primary' })
    await user.click(within(card).getByRole('button', { name: '停止' }))
    expect(requestAction).toHaveBeenCalledWith('ctr-mariadb-primary', 'stop')
    expect(await within(card).findByText('已停止')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '启动' })).toBeInTheDocument()
    expect(useMessageStore.getState().messages).toContainEqual(expect.objectContaining({ tone: 'success', message: '已停止容器 mariadb-primary' }))
  })

  it('删除容器及数据需要确认：取消不删，确认后行消失且通知不带 mock 标注', async () => {
    const user = userEvent.setup()
    const { gateway } = pageGateway()
    renderApp('/databases', { gateway })
    const list = await screen.findByRole('list', { name: 'MariaDB 数据库容器列表' })
    const card = within(list).getByRole('article', { name: 'MariaDB 数据库容器 mariadb-primary' })

    await user.click(within(card).getByRole('button', { name: '删除容器及数据' }))
    const confirm = await screen.findByRole('dialog', { name: '删除容器及全部数据？' })
    expect(confirm).toHaveTextContent('将删除数据库容器 mariadb-primary 及其专属持久卷，全部数据无法恢复。')
    await user.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '删除容器及全部数据？' })).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'MariaDB 数据库容器 mariadb-primary' })).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: '删除容器及数据' }))
    await user.click(within(screen.getByRole('dialog', { name: '删除容器及全部数据？' })).getByRole('button', { name: '确认删除容器及数据' }))

    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'MariaDB 数据库容器 mariadb-primary' })).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(useMessageStore.getState().messages).toContainEqual(expect.objectContaining({ tone: 'success', message: '数据库容器 mariadb-primary 已删除' })))
    expect(screen.queryByText(/mock，待接入真实执行/)).not.toBeInTheDocument()
  })

  it('删除数据库容器后等待名单回读才释放该行，期间不重复提交', async () => {
    const { gateway } = pageGateway()
    const { load, removeContainer } = useDatabaseStore.getState()
    await load(gateway)
    const id = useDatabaseStore.getState().databases.find(row => row.name === 'mariadb-primary')!.id
    let release!: () => void
    const pendingRefresh = new Promise<void>(resolve => { release = resolve })
    const originalList = gateway.databases.list.bind(gateway.databases)
    const list = vi.spyOn(gateway.databases, 'list').mockImplementationOnce(async () => {
      await pendingRefresh
      return originalList()
    })
    const remove = vi.spyOn(gateway.databases, 'removeContainer')

    const removing = removeContainer(gateway, id)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    expect(useDatabaseStore.getState().removingContainerIds).toEqual([id])
    await removeContainer(gateway, id)
    expect(remove).toHaveBeenCalledExactlyOnceWith(id)

    release()
    await removing
    expect(useDatabaseStore.getState().removingContainerIds).toEqual([])
    expect(useDatabaseStore.getState().databases.map(row => row.id)).not.toContain(id)
  })

  it('待核对容器提供重新核对，核对通过后警告块消失', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway().gateway })

    const card = await screen.findByRole('article', { name: 'MariaDB 数据库容器 mariadb-broken' })
    expect(within(card).getByText('容器尚未核对完成。修复容器后可重新核对；不再使用时可删除容器及数据。')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '重新核对' }))
    await waitFor(() => expect(within(card).queryByRole('button', { name: '重新核对' })).not.toBeInTheDocument())
  })

  it('点击镜像行在当前页打开容器详情侧边栏，不跳转路由', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/databases', { gateway: pageGateway().gateway })
    const list = await screen.findByRole('list', { name: 'MariaDB 数据库容器列表' })
    const card = within(list).getByRole('article', { name: 'MariaDB 数据库容器 mariadb-primary' })

    await user.click(within(card).getByRole('button', { name: /镜像/ }))

    expect(router.state.location.pathname).toBe('/databases')
    expect(await screen.findByRole('dialog', { name: 'mariadb-primary' })).toBeInTheDocument()
  })

  it('数据库回读到已停止的容器时，详情显示同一状态', async () => {
    const user = userEvent.setup()
    const { gateway, containerRows } = pageGateway()
    await useContainersStore.getState().load(gateway)
    const container = useContainersStore.getState().containers.find(item => item.id === MARIADB_ROW.containerId)!
    expect(container.status).toBe('running')

    const list = gateway.containers.list.bind(gateway.containers)
    vi.spyOn(gateway.containers, 'list').mockImplementation(async () => (await list()).map(item =>
      item.id === container.id ? { ...item, status: 'stopped' } : item,
    ))
    containerRows[0]!.status = 'stopped'

    renderApp('/databases', { gateway })
    const card = await screen.findByRole('article', { name: 'MariaDB 数据库容器 mariadb-primary' })
    expect(within(card).getByText('已停止')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: /镜像/ }))

    const detail = await screen.findByRole('dialog', { name: 'mariadb-primary' })
    expect(within(detail).getByText('已停止')).toBeInTheDocument()
  })

  it('容器读取失败时仍显示 SQLite 文件，重试后恢复容器卡片', async () => {
    const user = userEvent.setup()
    let failed = true
    const { gateway } = pageGateway({
      list: async () => {
        if (failed) throw new Error('演示数据库连接失败')
        return [structuredClone(MARIADB_ROW)]
      },
    })
    renderApp('/databases', { gateway })

    const alert = await screen.findByRole('region', { name: '数据库数据加载失败' })
    expect(alert).toHaveTextContent('演示数据库连接失败')
    expect(await screen.findByRole('article', { name: `SQLite 数据库 ${NOTES_FILE.name}` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加 SQLite 文件' })).toBeEnabled()
    failed = false
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('article', { name: 'MariaDB 数据库容器 mariadb-primary' })).toBeInTheDocument()
  })

  it('丢失容器的受管登记仍可清理专属卷', async () => {
    const user = userEvent.setup()
    const { gateway, containerRows } = pageGateway()
    const row = { ...MARIADB_ROW, status: 'missing', credentialsVerified: false, needsAttention: true } as const
    containerRows.splice(0, containerRows.length, row)
    const remove = vi.spyOn(gateway.databases, 'removeContainer')
    renderApp('/databases', { gateway })

    const card = await screen.findByRole('article', { name: `MariaDB 数据库容器 ${row.name}` })
    expect(within(card).getByText('容器已不存在')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '启动' })).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '删除专属卷及登记' }))
    const dialog = await screen.findByRole('dialog', { name: '删除专属卷及登记？' })
    await user.click(within(dialog).getByRole('button', { name: '确认删除专属卷及登记' }))
    expect(remove).toHaveBeenCalledWith(row.id)
    expect(await screen.findByText('没有 MariaDB 数据库容器')).toBeInTheDocument()
  })

  it('adapter 返回空数据时显示空态', async () => {
    renderApp('/databases', { gateway: pageGateway({ list: async () => [], listSqlite: async () => [] }).gateway })
    expect(await screen.findByText('没有 MariaDB 数据库容器')).toBeInTheDocument()
    expect(await screen.findByText('没有 SQLite 文件')).toBeInTheDocument()
  })

  it('添加数据库：弹窗填版本创建容器，新卡片入列且通知不带 mock 标注', async () => {
    const user = userEvent.setup()
    const { gateway } = pageGateway()
    renderApp('/databases', { gateway })
    await screen.findByRole('list', { name: 'MariaDB 数据库容器列表' })

    await user.click(screen.getByRole('button', { name: /添加数据库/ }))
    const dialog = await screen.findByRole('dialog', { name: '添加 MariaDB 数据库' })
    expect(within(dialog).queryByText('演示')).not.toBeInTheDocument()
    // 本地已有 mariadb:10.11 镜像：填版本即就绪，无需拉取。
    await user.type(within(dialog).getByRole('textbox', { name: /版本标签/ }), '10.11')
    expect(await within(dialog).findByText('本地镜像已就绪：mariadb:10.11')).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('逻辑库名')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('账号名')).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '创建并启动' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(useMessageStore.getState().messages).toContainEqual(expect.objectContaining({ tone: 'success', message: '数据库 elysian-mariadb 已创建' })))
    expect(
      await screen.findByRole('article', { name: 'MariaDB 数据库容器 elysian-mariadb' }),
    ).toBeInTheDocument()
  })

  it('SQLite 文件分区常驻：不切页签即可管理文件，下载快照仅对运行中的受管文件出现', async () => {
    const user = userEvent.setup()
    const downloadSqlite = vi.fn()
    const { gateway } = pageGateway({ downloadSqlite })
    renderApp('/databases', { gateway })

    const section = await screen.findByRole('region', { name: 'SQLite 文件' })
    const notes = within(section).getByRole('article', { name: 'SQLite 数据库 elysian-notes' })
    expect(notes).toHaveTextContent('数据库文件')
    expect(notes).toHaveTextContent('/root/.Elysian/data/sqlite/elysian-notes.db')
    expect(notes).toHaveTextContent('4.2 MB')
    expect(notes).toHaveTextContent('3')
    expect(within(notes).getByRole('button', { name: '下载快照' })).toBeInTheDocument()

    await user.click(within(notes).getByRole('button', { name: '下载快照' }))
    expect(downloadSqlite).toHaveBeenCalledWith('sqlite-notes')
    expect(useMessageStore.getState().messages).toContainEqual(expect.objectContaining({ tone: 'success', message: '已发起数据库 elysian-notes 的快照下载' }))
  })

  it('pending 行按三值状态渲染「需要处理」覆盖标签，并可核对与清理', async () => {
    const user = userEvent.setup()
    const { gateway } = pageGateway()
    renderApp('/databases', { gateway })

    const section = await screen.findByRole('region', { name: 'SQLite 文件' })
    const pending = within(section).getByRole('article', { name: 'SQLite 数据库 orders-import' })
    expect(within(pending).getByText('需要处理')).toBeInTheDocument()
    expect(within(pending).queryByRole('button', { name: '下载快照' })).not.toBeInTheDocument()

    await user.click(within(pending).getByRole('button', { name: '重新核对' }))
    await waitFor(() => expect(within(pending).queryByRole('button', { name: '重新核对' })).not.toBeInTheDocument())
    expect(within(pending).getByRole('button', { name: '下载快照' })).toBeInTheDocument()
  })

  it('添加 SQLite：表单没有账号与容器，拖拽文件后按文件名建库并入列', async () => {
    const user = userEvent.setup()
    const { gateway } = pageGateway()
    renderApp('/databases', { gateway })
    await screen.findByRole('region', { name: 'SQLite 文件' })

    await user.click(screen.getByRole('button', { name: /添加 SQLite 文件/ }))
    const dialog = await screen.findByRole('dialog', { name: '添加 SQLite 数据库' })
    expect(within(dialog).queryByLabelText('用户名')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('密码')).not.toBeInTheDocument()
    expect(within(dialog).getByText('管理目录：~/.Elysian/data/sqlite（文件名由服务端生成）')).toBeInTheDocument()

    const dropped = new File([new Uint8Array(2 * 1024 * 1024)], 'orders-backup.db', {
      type: 'application/vnd.sqlite3',
    })
    fireEvent.drop(within(dialog).getByText('把 SQLite 数据库文件拖到这里'), {
      dataTransfer: { files: [dropped] },
    })

    expect(await within(dialog).findByText('orders-backup.db')).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/数据库名/)).toHaveValue('orders-backup')

    await user.click(within(dialog).getByRole('button', { name: '上传并创建' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const created = await screen.findByRole('article', { name: 'SQLite 数据库 orders-backup' })
    expect(created).toHaveTextContent('/root/.Elysian/data/sqlite/orders-backup.db')
    expect(created).toHaveTextContent('2.0 MB')
  })

  it('删除 SQLite 文件需要确认：确认后文件卡消失', async () => {
    const user = userEvent.setup()
    const { gateway } = pageGateway()
    renderApp('/databases', { gateway })
    const section = await screen.findByRole('region', { name: 'SQLite 文件' })
    const card = within(section).getByRole('article', { name: 'SQLite 数据库 elysian-notes' })

    await user.click(within(card).getByRole('button', { name: '删除文件' }))
    const confirm = await screen.findByRole('dialog', { name: '确认删除 SQLite 文件「elysian-notes」？' })
    expect(confirm).toHaveTextContent('将永久删除面板管理目录中的实际 SQLite 数据库文件。')
    await user.click(within(confirm).getByRole('button', { name: '确认删除' }))

    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'SQLite 数据库 elysian-notes' })).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(useMessageStore.getState().messages).toContainEqual(expect.objectContaining({ tone: 'success', message: 'SQLite 文件 elysian-notes 已删除' })))
  })

  it('点击文件路径行把路径复制到剪贴板，并给出已复制反馈', async () => {
    const user = userEvent.setup()
    const { gateway } = pageGateway()
    renderApp('/databases', { gateway })

    const section = await screen.findByRole('region', { name: 'SQLite 文件' })
    const card = within(section).getByRole('article', { name: 'SQLite 数据库 elysian-notes' })
    const row = within(card).getByRole('button', { name: /复制数据库文件路径/ })

    await user.click(row)

    await expect(navigator.clipboard.readText()).resolves.toBe(
      '/root/.Elysian/data/sqlite/elysian-notes.db',
    )
    expect(await within(card).findByText('已复制')).toBeInTheDocument()
    expect(useMessageStore.getState().messages[0]).toMatchObject({
      tone: 'success',
      message: '已复制文件路径',
    })
  })
})
