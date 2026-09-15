import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseInstance } from '@elysian/contracts'
import type { ElysianGateway } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useContainersStore } from '../../stores/containersStore'
import { useDatabaseStore } from '../../stores/databaseStore'
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
  return {
    ...base,
    databases: {
      // 逐方法透传而不是展开实例：类方法在原型上，展开会丢掉。
      list: () => base.databases.list(),
      execMockQuery: (id, statement) => base.databases.execMockQuery(id, statement),
      create: (input) => base.databases.create(input),
      ...overrides,
    },
  }
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
    expect(card).not.toHaveTextContent(MARIADB.credentials.password)
    expect(card).not.toHaveTextContent(MARIADB.credentials.username)
    expect(card).toHaveTextContent('复制用户名')
    expect(card).toHaveTextContent('复制密码')
    // 卡片上不放常驻演示文案：声明收敛进 tooltip 与会话横幅。
    expect(card).not.toHaveTextContent('演示凭证')
    expect(card).not.toHaveTextContent('演示数值')
    expect(within(card).getByRole('button', { name: '复制用户名' })).toHaveAttribute(
      'title',
      expect.stringContaining('不对应任何真实数据库'),
    )
  })

  it('两个复制按钮把演示凭证的值写进剪贴板', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway({ list: async () => [MARIADB] }) })
    const card = await screen.findByRole('article', { name: 'MariaDB 数据库 mariadb-test' })

    await user.click(within(card).getByRole('button', { name: '复制用户名' }))
    await expect(navigator.clipboard.readText()).resolves.toBe(MARIADB.credentials.username)

    await user.click(within(card).getByRole('button', { name: '复制密码' }))
    await expect(navigator.clipboard.readText()).resolves.toBe(MARIADB.credentials.password)
  })

  it('切换到 MySQL 后展示 MySQL 卡片，切换到无实例类型显示空态', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'MySQL' }))
    expect(await screen.findByRole('list', { name: 'MySQL 数据库列表' })).toBeInTheDocument()
    const mysqlCard = screen.getByRole('article', { name: 'MySQL 数据库 mysql-orders' })
    expect(mysqlCard).toHaveTextContent('连接偏高')
    // 品牌标按引擎映射：MySQL 卡片挂 MySQL 标，不再借用 MariaDB 海豚标。
    expect(within(mysqlCard).getByLabelText('MySQL 图标')).toBeInTheDocument()

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'SQLite' }))
    expect(await screen.findByText('这台机器上没有 SQLite 的数据库容器')).toBeInTheDocument()
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

  it('点击来源容器行跳到容器页并打开对应详情面板', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/databases', { gateway: pageGateway() })
    const list = await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(within(list).getByRole('button', { name: /来源容器/ }))

    expect(router.state.location.pathname).toBe('/containers')
    expect(await screen.findByRole('dialog', { name: 'mariadb-primary' })).toBeInTheDocument()
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
    expect(await screen.findByText('这台机器上没有 MariaDB 的数据库容器')).toBeInTheDocument()
  })

  it('添加数据库：弹窗带演示标注，填表创建后新卡片出现', async () => {
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
    await user.selectOptions(within(dialog).getByLabelText('添加到容器'), 'ctr-mariadb-primary')
    await user.click(within(dialog).getByRole('button', { name: '创建' }))

    // 创建成功：弹窗关闭、通知出现、新卡片入列。
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText(/已创建/)).toBeInTheDocument()
    expect(
      await screen.findByRole('article', { name: 'MariaDB 数据库 orders_replica' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'MariaDB 数据库列表' })).toHaveTextContent(
      'mariadb-primary',
    )
  })

  it('添加数据库弹窗可以取消关闭', async () => {
    const user = userEvent.setup()
    renderApp('/databases', { gateway: pageGateway() })
    await screen.findByRole('list', { name: 'MariaDB 数据库列表' })

    await user.click(screen.getByRole('button', { name: /添加数据库/ }))
    await user.click(await screen.findByRole('button', { name: '取消' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
