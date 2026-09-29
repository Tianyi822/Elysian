import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseInstance } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useContainersStore } from '../../stores/containersStore'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { renderApp } from '../../test/renderApp'

const MARIADB: DatabaseInstance = {
  id: 'test-mariadb',
  engine: 'MariaDB',
  name: 'mariadb-test',
  version: '10.11.8',
  status: 'running',
  containerId: 'ctr-mariadb-primary',
  source: 'managed',
  credentialUsername: 'ops',
  hasCredentials: true,
  storage: { usedGb: 12.5, totalGb: 32 },
  memory: { usedGb: 1.5, totalGb: 4 },
  connections: { active: 12, max: 100 },
  updatedAt: '2026-09-12T08:00:00.000Z',
}

/**
 * 服务端列表响应的内联基准行：真实链路恒带 source（managed/adopted），
 * 凭证只给 hasCredentials/credentialUsername，从不给明文。
 */
const DATABASE_FIXTURES: readonly DatabaseInstance[] = [
  {
    id: 'db-mariadb-primary',
    engine: 'MariaDB',
    name: 'mariadb-primary',
    version: '10.11.8',
    status: 'running',
    containerId: 'ctr-mariadb-primary',
    source: 'managed',
    credentialUsername: 'ops',
    hasCredentials: true,
    storage: { usedGb: 128.4, totalGb: 256 },
    memory: { usedGb: 3.2, totalGb: 8 },
    connections: { active: 86, max: 200 },
    updatedAt: '2026-09-12T08:00:00.000Z',
  },
  {
    id: 'db-mysql-orders',
    engine: 'MySQL',
    name: 'mysql-orders',
    version: '8.4.2',
    status: 'warning',
    containerId: 'ctr-mysql-orders',
    source: 'adopted',
    credentialUsername: 'ops',
    hasCredentials: true,
    storage: { usedGb: 74.8, totalGb: 128 },
    memory: { usedGb: 4.6, totalGb: 8 },
    connections: { active: 142, max: 200 },
    updatedAt: '2026-09-12T08:00:00.000Z',
  },
  {
    id: 'db-redis-cache',
    engine: 'Redis',
    name: 'redis-cache',
    version: '7.4',
    status: 'running',
    containerId: 'ctr-redis-cache',
    source: 'managed',
    credentialUsername: 'default',
    hasCredentials: true,
    storage: { usedGb: 2.4, totalGb: 16 },
    memory: { usedGb: 0.6, totalGb: 2 },
    connections: { active: 34, max: 512 },
    updatedAt: '2026-09-12T08:00:00.000Z',
  },
  {
    // 文件型：SQLite 就是一个本地 .db 文件，没有容器、没有账号、没有连接上限。
    id: 'db-sqlite-notes',
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
  },
]

beforeEach(() => {
  useDatabaseStore.setState({
    engine: 'MariaDB',
    status: 'idle',
    databases: [],
    containers: [],
    images: [],
    errorMessage: undefined,
    session: undefined,
    createOpen: false,
    creating: false,
  })
  useContainersStore.setState({ view: 'grid', detailContainerId: undefined })
})

/**
 * 数据库域在测试里用自建 fake（gateway 已固定走 http adapter，jsdom 下 fetch 不可达）：
 * fake 像真实服务端一样持有行集——create 落行、remove 删行、list 返回当前行集，
 * 因此界面每次 refresh 都以 fake 的状态为准；容器事实仍取 base 的 mock 容器数据集。
 */
function pageGateway(overrides: Partial<ElysianGateway['databases']> = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const rows: DatabaseInstance[] = DATABASE_FIXTURES.map((row) => structuredClone(row))
  const databases: ElysianGateway['databases'] = {
    async list() {
      return rows.map((row) => structuredClone(row))
    },
    async create(input) {
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
        rows.push(created)
        return structuredClone(created)
      }
      const createdContainer = input.target?.kind === 'new'
        ? await base.containers.create({
            name: input.target.containerName,
            imageId: input.target.imageId,
            ports: input.accessScope === 'any-host' && input.hostPort
              ? [{ containerPort: input.engine === 'Redis' ? 6379 : 3306, hostPort: input.hostPort, protocol: 'tcp', hostIp: '0.0.0.0' }]
              : [],
            env: [], volumes: [], restartPolicy: 'unless-stopped',
          })
        : undefined
      const containerId = createdContainer?.id ?? input.containerId
      const container = (await base.containers.list()).find((item) => item.id === containerId)
      if (!container) throw new Error(`未找到容器 ${input.containerId}`)
      const image = (await base.containers.listImages()).find((item) => item.id === container.imageId)
      const created: DatabaseInstance = {
        id: `db-${container.name}-${input.name}`,
        engine: input.engine,
        name: input.name,
        version: image?.tag ?? '0',
        status: 'running',
        containerId: container.id,
        source: 'managed',
        credentialUsername: input.username,
        hasCredentials: true,
        storage: { usedGb: 0.1, totalGb: 32 },
        memory: { usedGb: 0.2, totalGb: 4 },
        connections: { active: 1, max: 200 },
        updatedAt: '2026-09-12T08:00:00.000Z',
      }
      rows.push(created)
      return structuredClone(created)
    },
    async remove(databaseId) {
      const index = rows.findIndex((row) => row.id === databaseId)
      if (index >= 0) rows.splice(index, 1)
    },
    async discover(engine, versionTag) {
      const containers = await base.containers.list()
      const images = await base.containers.listImages()
      const matchingImages = images.filter((image) => image.name === engine.toLowerCase() && /^\d+(?:\.\d+){0,2}(?:[-.][A-Za-z0-9]+)*$/.test(image.tag))
      return {
        images: versionTag === undefined ? matchingImages : matchingImages.filter((image) => image.tag === versionTag),
        containers: containers.flatMap((container) => {
          const image = matchingImages.find((candidate) => candidate.id === container.imageId)
          if (container.status !== 'running' || !image || (versionTag !== undefined && image.tag !== versionTag)) return []
          if (engine === 'Redis' && rows.some((database) => database.engine === 'Redis' && database.containerId === container.id)) return []
          return [{ id: container.id, name: container.name, accessScope: 'localhost', managed: true, versionTag: image.tag }]
        }),
      }
    },
  }
  return { ...base, databases: Object.assign(databases, overrides) }
}

describe('数据库页面', () => {
  it('以卡片呈现 MariaDB 的状态、资源指标与来源容器', async () => {
    renderApp('/databases', { gateway: pageGateway({ list: async () => [MARIADB] }) })

    const list = await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    const card = within(list).getByRole('article', { name: 'MariaDB 数据库 mariadb-test' })
    expect(card).toHaveTextContent('MariaDB · 10.11.8')
    expect(card).toHaveTextContent('来源容器')
    expect(card).toHaveTextContent('mariadb-primary')
    expect(card).toHaveTextContent('mariadb:10.11')
    // 服务型指标是三格静态事实（服务端采集值，采集失败显示「不可用」），没有配额占比条。
    expect(card).toHaveTextContent('已用空间12800.0 MB')
    expect(card).toHaveTextContent('容器内存1536.0 MB')
    expect(card).toHaveTextContent('连接数12 / 100')
    expect(card).toHaveTextContent('运行中')
    expect(within(card).getByLabelText('MariaDB 图标')).toBeInTheDocument()

    // 地址行已删：卡片不再出现域名、IP 或端口字样。
    expect(card).not.toHaveTextContent(/\.demo|:\d{4}/)
    // 副标题说明段与「N 个实例」计数都已删，标题下直接是卡片。
    expect(screen.queryByText(/个实例/)).not.toBeInTheDocument()
  })

  it('凭证只在点击复制时经 reveal 按需读取，卡片不出现明文与演示豁免文案', async () => {
    const user = userEvent.setup()
    const reveal = vi.fn(async () => ({ username: 'ops', password: 'real-secret-1' }))
    renderApp('/databases', { gateway: pageGateway({ list: async () => [structuredClone(MARIADB)], reveal }) })

    const card = await screen.findByRole('article', { name: 'MariaDB 数据库 mariadb-test' })
    // 真实链路没有列表下发明文的渲染位：密码不出现，也不再有「演示凭证」的豁免文案。
    expect(card).not.toHaveTextContent('real-secret-1')
    expect(card).not.toHaveTextContent('演示')
    expect(within(card).getByRole('button', { name: '复制用户名' })).toHaveAttribute(
      'title',
      '从服务端读取并复制普通账号',
    )

    await user.click(within(card).getByRole('button', { name: '复制密码' }))
    await expect(navigator.clipboard.readText()).resolves.toBe('real-secret-1')
    expect(reveal).toHaveBeenCalledWith('test-mariadb')
  })

  it('切换到 MySQL 展示 MySQL 卡片；切到 SQLite 显示本地文件形态', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'MySQL' }))
    expect(await screen.findByRole('list', { name: 'MySQL 数据库列表' })).toBeInTheDocument()
    const mysqlCard = screen.getByRole('article', { name: 'MySQL 数据库 mysql-orders' })
    expect(mysqlCard).toHaveTextContent('连接偏高')
    // 品牌标按引擎映射：MySQL 卡片挂 MySQL 标，不再借用 MariaDB 海豚标。
    expect(within(mysqlCard).getByLabelText('MySQL 图标')).toBeInTheDocument()

    // SQLite 是本地单文件数据库：显示文件路径与大小，没有账号、没有来源容器、也没有连接数。
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'SQLite' }))
    const sqliteCard = await screen.findByRole('article', { name: 'SQLite 数据库 elysian-notes' })
    expect(sqliteCard).toHaveTextContent('数据库文件')
    expect(sqliteCard).toHaveTextContent('/root/.Elysian/data/sqlite/elysian-notes.db')
    expect(sqliteCard).toHaveTextContent('4.2 MB')
    expect(sqliteCard).not.toHaveTextContent('无账号')
    expect(sqliteCard).not.toHaveTextContent('连接数')
    expect(within(sqliteCard).queryByRole('button', { name: '复制用户名' })).not.toBeInTheDocument()
    expect(within(sqliteCard).getByRole('button', { name: '连接' })).toBeInTheDocument()
  })

  it('无品牌标的引擎回退通用图标，aria-label 仍以引擎命名', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Redis' }))
    const redisCard = await screen.findByRole('article', { name: 'Redis 数据库 redis-cache' })
    expect(within(redisCard).getByLabelText('Redis 图标')).toBeInTheDocument()
  })

  it('离开数据库页再回来，会话不自动重开', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/databases', { gateway: pageGateway() })
    const list = await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    const card = within(list).getByRole('article', { name: 'MariaDB 数据库 mariadb-primary' })
    await user.click(within(card).getByRole('button', { name: '连接' }))
    const sessionDialog = await screen.findByRole('dialog', { name: 'mariadb-primary SQL 会话' })
    // 会话横幅恒为「数据库协议会话」：不再有按 source 或 adapter 能力切换的演示降级文案。
    expect(within(sessionDialog).getByText('数据库协议会话')).toBeInTheDocument()
    expect(within(sessionDialog).queryByText(/演示 SQL 会话/)).not.toBeInTheDocument()

    // 会话弹窗是模态的，真实用户点不到侧边栏；用路由导航等价浏览器后退离开本页，
    // 页面卸载应把会话清空，而不是留在全局 store 里。
    await router.navigate('/docker')
    await waitFor(() => expect(useDatabaseStore.getState().session).toBeUndefined())

    await router.navigate('/databases')
    // 返回时页面先以上次的 ready 状态渲染旧列表，load() 又会翻回 loading 再 ready，
    // 因此用 waitFor 整体重试，避免断言抓到转瞬即被卸载的列表节点。
    await waitFor(() => {
      expect(screen.getByRole('list', { name: 'MariaDB 数据库列表' })).toBeInTheDocument()
      expect(screen.queryByRole('dialog', { name: 'mariadb-primary SQL 会话' })).not.toBeInTheDocument()
    })
  })

  it('点击来源容器行在当前页打开详情侧边栏，不跳转路由', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/databases', { gateway: pageGateway() })
    const list = await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(within(list).getByRole('button', { name: /来源容器/ }))

    // 不离开数据库页：路由原封不动，详情侧边栏就地打开。
    expect(router.state.location.pathname).toBe('/databases')
    expect(await screen.findByRole('dialog', { name: 'mariadb-primary' })).toBeInTheDocument()
  })

  it('来源容器不在列表时卡片显示缺失态且不可打开详情', async () => {
    const user = userEvent.setup()
    const orphan: DatabaseInstance = {
      ...MARIADB,
      id: 'orphan-mariadb',
      name: 'orphan-db',
      containerId: 'ctr-not-in-list',
    }
    const base = pageGateway({ list: async () => [orphan] })
    const gateway: ElysianGateway = {
      ...base,
      containers: {
        ...base.containers,
        list: async () => [],
        listImages: async () => [],
      },
    }
    renderApp('/databases', { gateway })

    const card = await screen.findByRole('article', { name: 'MariaDB 数据库 orphan-db' })
    expect(card).toHaveTextContent('来源容器已不存在')
    expect(card).not.toHaveTextContent('mariadb-primary')

    const row = within(card).getByRole('button', { name: /来源容器已不存在/ })
    expect(row).toBeDisabled()
    await user.click(row)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useContainersStore.getState().detailContainerId).toBeUndefined()
  })

  it('adapter 读取失败显示错误态，重试成功后恢复卡片', async () => {
    const user = userEvent.setup()
    let failed = true
    const gateway = pageGateway({
      list: async () => {
        if (failed) throw new Error('演示数据库连接失败')
        return [MARIADB]
      },
    })
    renderApp('/databases', { gateway })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('演示数据库连接失败')
    failed = false
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('article', { name: 'MariaDB 数据库 mariadb-test' })).toBeInTheDocument()
  })

  it('mock 网关依赖恒 ok：错误态与成功态都不出现安装引导弹窗', async () => {
    let failed = true
    const gateway = pageGateway({
      list: async () => {
        if (failed) throw new Error('演示数据库连接失败')
        return [MARIADB]
      },
    })
    renderApp('/databases', { gateway })
    await screen.findByRole('alert')
    expect(screen.queryByRole('dialog')).toBeNull()
    failed = false
    await userEvent.setup().click(within(screen.getByRole('alert')).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('article', { name: 'MariaDB 数据库 mariadb-test' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('adapter 返回空数据时显示空态', async () => {
    renderApp('/databases', { gateway: pageGateway({ list: async () => [] }) })
    expect(await screen.findByText('没有 MariaDB 数据库')).toBeInTheDocument()
  })

  it('添加数据库：弹窗不再带演示徽章，填表创建后新卡片出现且通知不带 mock 标注', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(screen.getByRole('button', { name: /添加数据库/ }))
    const dialog = await screen.findByRole('dialog', { name: '添加 MariaDB 数据库' })
    // 全真实操作链路的弹窗不挂「演示」徽章。
    expect(within(dialog).queryByText('演示')).not.toBeInTheDocument()
    expect(await within(dialog).findByText('先选择已有容器')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /运行中的容器/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: /mariadb-primary · mariadb:10.11/ }))
    await user.type(within(dialog).getByLabelText('逻辑库名'), 'orders_replica')
    await user.type(within(dialog).getByLabelText('账号名'), 'ops')
    await user.type(within(dialog).getByLabelText('密码'), 'demo-mariadb-aaaa')

    // 下拉全部自绘：点触发器出菜单项，不用原生 select。
    expect(dialog.querySelector('select')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: /字符集/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'latin1' }))
    await user.click(within(dialog).getByRole('button', { name: '创建逻辑库' }))

    // 创建成功：弹窗关闭、通知不带 mock/演示 标注、新卡片入列（经服务端刷新）。
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('数据库 orders_replica 已创建')).toBeInTheDocument()
    expect(screen.queryByText(/mock，待接入真实执行/)).not.toBeInTheDocument()
    expect(
      await screen.findByRole('article', { name: 'MariaDB 数据库 orders_replica' }),
    ).toBeInTheDocument()
  })

  it('添加数据库弹窗可以取消关闭', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(screen.getByRole('button', { name: /添加数据库/ }))
    await user.click(await screen.findByRole('button', { name: '取消' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Redis 无候选时在数据库弹窗拉取并创建新容器', async () => {
    const user = userEvent.setup()
    const gateway = pageGateway()
    renderApp('/databases', { gateway })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Redis' }))
    await screen.findByRole('article', { name: 'Redis 数据库 redis-cache' })
    await user.click(screen.getByRole('button', { name: /添加数据库/ }))
    const dialog = await screen.findByRole('dialog', { name: '添加 Redis 数据库' })
    await user.click(await within(dialog).findByRole('button', { name: '拉取镜像并新建容器' }))
    await user.type(within(dialog).getByRole('textbox', { name: /版本标签/ }), '8.0')
    await user.click(within(dialog).getByRole('button', { name: '拉取镜像' }))
    expect(await within(dialog).findByRole('progressbar', { name: '当前窗口镜像拉取进度' })).toBeInTheDocument()
    expect(await within(dialog).findByText('本地镜像已就绪：redis:8.0')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('账号名'), 'reader')
    await user.type(within(dialog).getByLabelText(/密码（至少 12 位）/), 'strong-password-123')
    await user.click(within(dialog).getByRole('button', { name: '创建并启动' }))
    expect(await screen.findByRole('article', { name: 'Redis 数据库 0' })).toBeInTheDocument()
    expect((await gateway.containers.list()).some((container) => container.name === 'elysian-redis')).toBe(true)
  })

  it('添加 SQLite：表单没有账号与容器，拖拽文件后按文件名建库', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'SQLite' }))
    await screen.findByRole('article', { name: 'SQLite 数据库 elysian-notes' })

    await user.click(screen.getByRole('button', { name: /添加数据库/ }))
    const dialog = await screen.findByRole('dialog', { name: '添加 SQLite 数据库' })

    // SQLite 没有账号体系，也没有承载容器：这两组字段在弹窗里不存在。
    expect(within(dialog).queryByLabelText('用户名')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('密码')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('添加到容器')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('访问权限')).not.toBeInTheDocument()
    // 弹窗恒按真实链路渲染：没有演示徽章，落点由服务端决定、不收集目录。
    expect(within(dialog).queryByText('演示')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/落点目录/)).not.toBeInTheDocument()
    expect(within(dialog).getByText('管理目录：~/.Elysian/data/sqlite（文件名由服务端生成）')).toBeInTheDocument()

    // 拖拽上传：把文件拖进拖拽区，表单读取名称与大小（不读内容）。
    const dropped = new File([new Uint8Array(2 * 1024 * 1024)], 'orders-backup.db', {
      type: 'application/vnd.sqlite3',
    })
    fireEvent.drop(within(dialog).getByText('把 SQLite 数据库文件拖到这里'), {
      dataTransfer: { files: [dropped] },
    })

    expect(await within(dialog).findByText('orders-backup.db')).toBeInTheDocument()
    expect(within(dialog).getByText('2 MB')).toBeInTheDocument()
    // 数据库名跟文件名走。
    expect(within(dialog).getByLabelText(/数据库名/)).toHaveValue('orders-backup')

    await user.click(within(dialog).getByRole('button', { name: '上传并创建' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const created = await screen.findByRole('article', { name: 'SQLite 数据库 orders-backup' })
    // 路径与大小由服务端决定并随列表返回，客户端不报送。
    expect(created).toHaveTextContent('/root/.Elysian/data/sqlite/orders-backup.db')
    expect(created).toHaveTextContent('2.0 MB')
    expect(created).not.toHaveTextContent('无账号')
  })

  it('添加 SQLite：新建空库只填名称，提交后登记服务端生成的文件', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'SQLite' }))
    await screen.findByRole('article', { name: 'SQLite 数据库 elysian-notes' })

    await user.click(screen.getByRole('button', { name: /添加数据库/ }))
    const dialog = await screen.findByRole('dialog', { name: '添加 SQLite 数据库' })

    await user.click(within(dialog).getByRole('button', { name: '新建空数据库' }))
    await user.type(within(dialog).getByLabelText(/数据库名/), 'notes_local')
    expect(within(dialog).queryByLabelText(/落点目录/)).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '创建' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const created = await screen.findByRole('article', { name: 'SQLite 数据库 notes_local' })
    expect(created).toHaveTextContent('/root/.Elysian/data/sqlite/notes_local.db')
    expect(created).not.toHaveTextContent('演示')
  })

  it('点击文件路径行把路径复制到剪贴板，并给出已复制反馈', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'SQLite' }))

    const card = await screen.findByRole('article', { name: 'SQLite 数据库 elysian-notes' })
    const row = within(card).getByRole('button', { name: /复制数据库文件路径/ })

    await user.click(row)

    await expect(navigator.clipboard.readText()).resolves.toBe(
      '/root/.Elysian/data/sqlite/elysian-notes.db',
    )
    // 反馈与复制按钮同款：行内短暂显示「已复制」，路径不消失，并另发一条成功通知。
    expect(await within(card).findByText('已复制')).toBeInTheDocument()
    expect(card).toHaveTextContent('/root/.Elysian/data/sqlite/elysian-notes.db')
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'success',
      message: '已复制文件路径',
    })
  })

  it('删除数据库需要确认：取消不删，确认后通知不带 mock 标注且向服务端核对', async () => {
    const user = userEvent.setup()
    const gateway = pageGateway()
    const listSpy = vi.spyOn(gateway.databases, 'list')
    renderApp('/databases', { gateway })
    const list = await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    const card = within(list).getByRole('article', { name: 'MariaDB 数据库 mariadb-primary' })

    // 取消路径：确认弹窗出现，取消后卡片仍在。
    await user.click(within(card).getByRole('button', { name: '删除数据库' }))
    const confirm = await screen.findByRole('dialog', { name: /确认删除数据库/ })
    expect(confirm).toHaveTextContent('将删除目标逻辑库，容器和持久卷保留。此操作无法撤销。')
    await user.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: /确认删除数据库/ })).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'MariaDB 数据库 mariadb-primary' })).toBeInTheDocument()

    // 确认路径：删除后必向服务端核对（refresh），卡片以服务端状态为准消失，
    // 通知不带「mock，待接入真实执行」之类的演示标注。
    await user.click(within(card).getByRole('button', { name: '删除数据库' }))
    const confirmAgain = await screen.findByRole('dialog', { name: /确认删除数据库/ })
    await user.click(within(confirmAgain).getByRole('button', { name: '确认删除' }))

    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'MariaDB 数据库 mariadb-primary' })).not.toBeInTheDocument(),
    )
    expect(await screen.findByText('数据库 mariadb-primary 已删除')).toBeInTheDocument()
    expect(screen.queryByText(/mock，待接入真实执行/)).not.toBeInTheDocument()
    expect(screen.queryByText(/（演示）/)).not.toBeInTheDocument()
    expect(listSpy.mock.calls.length).toBeGreaterThan(1)
  })
})
