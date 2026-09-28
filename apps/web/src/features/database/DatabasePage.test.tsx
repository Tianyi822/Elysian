import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
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
  credentials: { username: 'ops', password: 'demo-mariadb-7f2c' },
  storage: { usedGb: 12.5, totalGb: 32 },
  memory: { usedGb: 1.5, totalGb: 4 },
  connections: { active: 12, max: 100 },
  updatedAt: '2026-09-12T08:00:00.000Z',
}

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

function pageGateway(overrides: Partial<ElysianGateway['databases']> = {}): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const databases: ElysianGateway['databases'] = {
    // 逐方法透传而不是展开实例：类方法在原型上，展开会丢掉。
    list: () => base.databases.list(),
    execMockQuery: (id, statement) => base.databases.execMockQuery(id, statement),
    create: (input) => base.databases.create(input),
    remove: (databaseId) => base.databases.remove(databaseId),
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
    expect(card).toHaveTextContent('容量12.5 / 32 GB')
    expect(card).toHaveTextContent('内存占用1.5 / 4 GB')
    expect(card).toHaveTextContent('连接数12 / 100')
    expect(card).toHaveTextContent('运行中')
    expect(within(card).getByLabelText('MariaDB 图标')).toBeInTheDocument()

    // 地址行已删：卡片不再出现域名、IP 或端口字样。
    expect(card).not.toHaveTextContent(/\.demo|:\d{4}/)
    // 副标题说明段与「N 个实例」计数都已删，标题下直接是卡片。
    expect(screen.queryByText(/个实例/)).not.toBeInTheDocument()
  })

  it('卡片不出现凭证明文，演示声明只在复制按钮的 tooltip 上', async () => {
    renderApp('/databases', { gateway: pageGateway({ list: async () => [MARIADB] }) })

    const card = await screen.findByRole('article', { name: 'MariaDB 数据库 mariadb-test' })
    expect(card).not.toHaveTextContent(MARIADB.credentials!.password)
    expect(card).not.toHaveTextContent(MARIADB.credentials!.username)
    expect(card).toHaveTextContent('用户名')
    expect(card).toHaveTextContent('密码')
    // 卡片上不放常驻演示文案：声明收敛进 tooltip 与会话横幅。
    expect(card).not.toHaveTextContent('演示凭证')
    expect(card).not.toHaveTextContent('演示数值')
    expect(within(card).getByRole('button', { name: '用户名' })).toHaveAttribute(
      'title',
      expect.stringContaining('不对应任何真实数据库'),
    )
  })

  it('两个复制按钮把演示凭证的值写进剪贴板', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway({ list: async () => [MARIADB] }) })
    const card = await screen.findByRole('article', { name: 'MariaDB 数据库 mariadb-test' })

    await user.click(within(card).getByRole('button', { name: '用户名' }))
    await expect(navigator.clipboard.readText()).resolves.toBe(MARIADB.credentials!.username)

    await user.click(within(card).getByRole('button', { name: '密码' }))
    await expect(navigator.clipboard.readText()).resolves.toBe(MARIADB.credentials!.password)
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
    expect(sqliteCard).toHaveTextContent('/srv/elysian/data/sqlite/elysian-notes.db')
    expect(sqliteCard).toHaveTextContent('4.2 MB')
    expect(sqliteCard).not.toHaveTextContent('无账号')
    expect(sqliteCard).not.toHaveTextContent('连接数')
    expect(within(sqliteCard).queryByRole('button', { name: '用户名' })).not.toBeInTheDocument()
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
    expect(await screen.findByRole('dialog', { name: 'mariadb-primary SQL 会话' })).toBeInTheDocument()

    // 会话弹窗是模态的，真实用户点不到侧边栏；用路由导航等价浏览器后退离开本页，
    // 页面卸载应把会话清空，而不是留在全局 store 里。
    await router.navigate('/containers')
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

  it('adapter 返回空数据时显示空态', async () => {
    renderApp('/databases', { gateway: pageGateway({ list: async () => [] }) })
    expect(await screen.findByText('没有 MariaDB 数据库')).toBeInTheDocument()
  })

  it('添加数据库：弹窗带演示标注，下拉自绘，填表创建后新卡片出现', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(screen.getByRole('button', { name: /添加数据库/ }))
    const dialog = await screen.findByRole('dialog', { name: '添加MariaDB数据库' })
    // 演示标注常驻弹窗顶栏。
    expect(within(dialog).getByText('演示 · 待接入真实执行')).toBeInTheDocument()

    // 必填校验：空表直接提交要能揭示行内错误。
    await user.click(within(dialog).getByRole('button', { name: '创建' }))
    expect(await within(dialog).findByText('请填写数据库名')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('数据库名'), 'orders_replica')
    await user.type(within(dialog).getByLabelText('用户名'), 'ops')
    await user.type(within(dialog).getByLabelText('密码'), 'demo-mariadb-aaaa')

    // 下拉全部自绘：点触发器出菜单项，不用原生 select。
    expect(dialog.querySelector('select')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: /字符集/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'utf8mb3' }))

    await user.click(within(dialog).getByRole('button', { name: /访问权限/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: '容器网络内' }))

    await user.click(within(dialog).getByRole('button', { name: /添加到容器/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: /mariadb-primary（mariadb:10.11）/ }))

    await user.click(within(dialog).getByRole('button', { name: '创建' }))

    // 创建成功：弹窗关闭、通知出现、新卡片入列。
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText(/已创建/)).toBeInTheDocument()
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

  it('添加 SQLite：表单没有账号与容器，拖拽文件后按文件名建库', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'SQLite' }))
    await screen.findByRole('article', { name: 'SQLite 数据库 elysian-notes' })

    await user.click(screen.getByRole('button', { name: /添加数据库/ }))
    const dialog = await screen.findByRole('dialog', { name: '添加SQLite数据库' })

    // SQLite 没有账号体系，也没有承载容器：这两组字段在弹窗里不存在。
    expect(within(dialog).queryByLabelText('用户名')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('密码')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('添加到容器')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('访问权限')).not.toBeInTheDocument()

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

    await user.click(within(dialog).getByRole('button', { name: '创建' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const created = await screen.findByRole('article', { name: 'SQLite 数据库 orders-backup' })
    expect(created).toHaveTextContent('/srv/elysian/data/sqlite/orders-backup.db')
    expect(created).not.toHaveTextContent('无账号')
  })

  it('添加 SQLite：模拟新建时校验路径，生成 0 字节演示卡片', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'SQLite' }))
    await screen.findByRole('article', { name: 'SQLite 数据库 elysian-notes' })

    await user.click(screen.getByRole('button', { name: /添加数据库/ }))
    const dialog = await screen.findByRole('dialog', { name: '添加SQLite数据库' })

    await user.click(within(dialog).getByRole('button', { name: '模拟新建文件' }))
    await user.type(within(dialog).getByLabelText(/数据库名/), 'notes_local')
    await user.clear(within(dialog).getByLabelText('落点目录'))
    await user.type(within(dialog).getByLabelText('落点目录'), 'data/sqlite')
    await user.click(within(dialog).getByRole('button', { name: '创建' }))

    expect(await within(dialog).findByText(/绝对路径/)).toBeInTheDocument()

    await user.clear(within(dialog).getByLabelText('落点目录'))
    await user.type(within(dialog).getByLabelText('落点目录'), '/srv/elysian/data/sqlite')
    await user.click(within(dialog).getByRole('button', { name: '创建' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const created = await screen.findByRole('article', { name: 'SQLite 数据库 notes_local' })
    expect(created).toHaveTextContent('/srv/elysian/data/sqlite/notes_local.db')
    // 演示卡片的模拟大小是 0 字节，显示为 KB。
    expect(created).toHaveTextContent('0 KB')
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
      '/srv/elysian/data/sqlite/elysian-notes.db',
    )
    // 反馈与复制按钮同款：行内短暂显示「已复制」，路径不消失，并另发一条成功通知。
    expect(await within(card).findByText('已复制')).toBeInTheDocument()
    expect(card).toHaveTextContent('/srv/elysian/data/sqlite/elysian-notes.db')
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      tone: 'success',
      message: '已复制文件路径',
    })
  })

  it('删除数据库需要确认：取消不删，确认后卡片消失且通知带 mock 标注', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    const list = await screen.findByRole('list', { name: 'MariaDB 数据库列表' })
    const card = within(list).getByRole('article', { name: 'MariaDB 数据库 mariadb-primary' })

    // 取消路径：确认弹窗出现，取消后卡片仍在。
    await user.click(within(card).getByRole('button', { name: '删除' }))
    const confirm = await screen.findByRole('dialog', { name: /确认删除数据库/ })
    await user.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: /确认删除数据库/ })).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'MariaDB 数据库 mariadb-primary' })).toBeInTheDocument()

    // 确认路径：卡片移除，通知带 mock 标注。
    await user.click(within(card).getByRole('button', { name: '删除' }))
    const confirmAgain = await screen.findByRole('dialog', { name: /确认删除数据库/ })
    await user.click(within(confirmAgain).getByRole('button', { name: '确认删除' }))

    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'MariaDB 数据库 mariadb-primary' })).not.toBeInTheDocument(),
    )
    expect(await screen.findByText(/已删除（mock，待接入真实执行）/)).toBeInTheDocument()
  })
})
