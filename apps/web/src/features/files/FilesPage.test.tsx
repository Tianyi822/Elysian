import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { MockFilesAdapter } from '../../adapters/mock/mockAdapters'
import { renderApp } from '../../test/renderApp'
import { useFilesStore } from '../../stores/filesStore'

beforeEach(() => {
  useFilesStore.setState({
    status: 'idle',
    path: '/',
    entries: [],
    sizes: {},
    computingPaths: [],
    clipboard: undefined,
    errorMessage: undefined,
  })
})

function rowOf(region: HTMLElement, name: string) {
  return within(region).getByRole('row', { name: new RegExp(name) })
}

describe('文件管理页', () => {
  it('根目录列出系统目录，文件夹在前、文件在后，大小列左对齐', async () => {
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })
    const rows = within(region).getAllByRole('row')
    const names = rows.slice(1).map((row) => within(row).getAllByRole('cell')[0]?.textContent)
    expect(names.slice(0, 5)).toEqual(['bin', 'boot', 'etc', 'home', 'opt'])
    expect(names[names.length - 1]).toBe('var')

    const etcRow = rowOf(region, 'etc')
    expect(within(etcRow).getByText('文件夹')).toBeInTheDocument()
    expect(within(etcRow).getByText('755/root')).toBeInTheDocument()
    // 目录大小不在列举里给出：目录行只有「计算」按钮，大小列不再右对齐。
    expect(
      within(etcRow).getByRole('button', { name: '计算 etc 的目录大小' }),
    ).toBeInTheDocument()
    expect(etcRow.lastElementChild).not.toHaveClass('text-right')

    // 名称列钉在左边陪滚，其余列横向滚动；列宽从 38% 缩到 32%。
    const headerRow = within(region).getAllByRole('row')[0]
    expect(headerRow?.children[0]).toHaveClass('sticky', 'left-0')
    expect(region.querySelector('colgroup')?.children[0]).toHaveClass('w-[32%]')
    expect(etcRow.children[0]).toHaveClass('sticky', 'left-0')
  })

  it('权限/所有者列按条目呈现真实主机惯例的取值', async () => {
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })

    // 行名以条目名开头锚定：所有者文本里也含「root」，裸匹配会命中所有行。
    expect(within(rowOf(region, '^bin ')).getByText('555/root')).toBeInTheDocument()
    expect(within(rowOf(region, '^root ')).getByText('700/root')).toBeInTheDocument()
  })

  it('双击目录进入子目录：路径标题与列表随之变化，上一级可用', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })

    await user.dblClick(rowOf(region, 'var'))

    expect(await screen.findByRole('heading', { level: 1, name: '/var' })).toBeInTheDocument()
    const varRegion = await screen.findByRole('region', { name: '文件列表' })
    expect(rowOf(varRegion, 'log')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上一级' })).toBeEnabled()
  })

  it('双击文件行不导航，地址与列表保持不变', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/files/var/log')
    const region = await screen.findByRole('region', { name: '文件列表' })

    await user.dblClick(rowOf(region, 'syslog'))

    expect(await screen.findByRole('heading', { level: 1, name: '/var/log' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/files/var/log')
  })

  it('上一级按钮返回父目录；根目录时禁用', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    expect(await screen.findByRole('button', { name: '上一级' })).toBeDisabled()

    const region = await screen.findByRole('region', { name: '文件列表' })
    await user.dblClick(rowOf(region, 'home'))
    expect(await screen.findByRole('heading', { level: 1, name: '/home' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '上一级' }))
    expect(await screen.findByRole('heading', { level: 1, name: '/' })).toBeInTheDocument()
  })

  it('单击选中行，Enter 打开目录：键盘与双击等价', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })

    const etcRow = rowOf(region, 'etc')
    await user.click(etcRow)
    expect(etcRow).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { level: 1, name: '/etc' })).toBeInTheDocument()
  })

  it('空目录显示空状态', async () => {
    renderApp('/files/tmp')
    expect(await screen.findByText('此目录为空')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '文件列表' })).not.toBeInTheDocument()
  })

  it('不存在的目录显示错误与返回根目录动作', async () => {
    const user = userEvent.setup()
    renderApp('/files/does-not-exist')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('目录读取失败')).toBeInTheDocument()
    expect(within(alert).getByText(/目录不存在/)).toBeInTheDocument()

    await user.click(within(alert).getByRole('button', { name: '返回根目录' }))
    expect(await screen.findByRole('heading', { level: 1, name: '/' })).toBeInTheDocument()
  })

  it('读取期间显示加载状态', async () => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    gateway.files = {
      list: () => new Promise(() => {}),
      size: () => new Promise(() => {}),
      copyEntry: () => new Promise(() => {}),
      moveEntry: () => new Promise(() => {}),
      renameEntry: () => new Promise(() => {}),
      compressEntry: () => new Promise(() => {}),
    }
    renderApp('/files', { gateway })

    expect(await screen.findByText('正在读取目录内容…')).toBeInTheDocument()
  })

  it('文件行显示格式化的大小，目录条目计数与列表一致', async () => {
    renderApp('/files/var/log/nginx')
    const region = await screen.findByRole('region', { name: '文件列表' })

    const accessRow = rowOf(region, 'access.log')
    expect(within(accessRow).getByText('7.9 MB')).toBeInTheDocument()
    expect(within(accessRow).getByText('文件')).toBeInTheDocument()
    expect(within(accessRow).getByText('644/root')).toBeInTheDocument()
    expect(screen.getByText('共 0 个文件夹 · 2 个文件')).toBeInTheDocument()
  })

  it('目录大小点「计算」后才求和，等待中显示计算中，结果按路径缓存', async () => {
    const user = userEvent.setup()
    let resolveSize: (bytes: number) => void = () => {}
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const mockFiles = new MockFilesAdapter()
    gateway.files = {
      list: (path) => mockFiles.list(path),
      size: () =>
        new Promise<number>((resolve) => {
          resolveSize = resolve
        }),
      copyEntry: (src, dest) => mockFiles.copyEntry(src, dest),
      moveEntry: (src, dest) => mockFiles.moveEntry(src, dest),
      renameEntry: (path, newName) => mockFiles.renameEntry(path, newName),
      compressEntry: (path) => mockFiles.compressEntry(path),
    }
    renderApp('/files', { gateway })
    const region = await screen.findByRole('region', { name: '文件列表' })

    // bin 目录行点了才进入等待，再出结果。
    await user.click(within(rowOf(region, '^bin ')).getByRole('button', { name: '计算 bin 的目录大小' }))
    expect(await screen.findByText('计算中')).toBeInTheDocument()

    // 4 825 294 字节 = 4.6 MB；结果落定后按钮与等待态都消失。
    resolveSize(4_825_294)
    expect(await within(rowOf(region, '^bin ')).findByText('4.6 MB')).toBeInTheDocument()
    expect(within(rowOf(region, '^bin ')).queryByRole('button')).toBeNull()
    expect(screen.queryByText('计算中')).not.toBeInTheDocument()
  })

  it('换目录再回来，算过的目录大小仍在', async () => {
    const user = userEvent.setup()
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const mockFiles = new MockFilesAdapter()
    gateway.files = {
      list: (path) => mockFiles.list(path),
      size: (path) => mockFiles.size(path),
      copyEntry: (src, dest) => mockFiles.copyEntry(src, dest),
      moveEntry: (src, dest) => mockFiles.moveEntry(src, dest),
      renameEntry: (path, newName) => mockFiles.renameEntry(path, newName),
      compressEntry: (path) => mockFiles.compressEntry(path),
    }
    renderApp('/files', { gateway })
    let region = await screen.findByRole('region', { name: '文件列表' })

    await user.click(within(rowOf(region, '^tmp ')).getByRole('button', { name: '计算 tmp 的目录大小' }))
    // tmp 是空目录：总和 0 B。
    expect(await within(rowOf(region, '^tmp ')).findByText('0 B')).toBeInTheDocument()

    await user.dblClick(rowOf(region, 'home'))
    expect(await screen.findByRole('heading', { level: 1, name: '/home' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '上一级' }))
    expect(await screen.findByRole('heading', { level: 1, name: '/' })).toBeInTheDocument()

    region = await screen.findByRole('region', { name: '文件列表' })
    expect(within(rowOf(region, '^tmp ')).getByText('0 B')).toBeInTheDocument()
    expect(
      within(rowOf(region, '^bin ')).getByRole('button', { name: '计算 bin 的目录大小' }),
    ).toBeInTheDocument()
  })

  it('目录大小统计失败时发通知，按钮回到可重试', async () => {
    const user = userEvent.setup()
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const mockFiles = new MockFilesAdapter()
    gateway.files = {
      list: (path) => mockFiles.list(path),
      size: () => Promise.reject(new Error('磁盘不可达')),
      copyEntry: (src, dest) => mockFiles.copyEntry(src, dest),
      moveEntry: (src, dest) => mockFiles.moveEntry(src, dest),
      renameEntry: (path, newName) => mockFiles.renameEntry(path, newName),
      compressEntry: (path) => mockFiles.compressEntry(path),
    }
    renderApp('/files', { gateway })
    const region = await screen.findByRole('region', { name: '文件列表' })

    await user.click(within(rowOf(region, '^bin ')).getByRole('button', { name: '计算 bin 的目录大小' }))

    const notifications = await screen.findByLabelText('通知')
    expect(within(notifications).getByText(/磁盘不可达/)).toBeInTheDocument()
    expect(
      await within(rowOf(region, '^bin ')).findByRole('button', { name: '计算 bin 的目录大小' }),
    ).toBeInTheDocument()
  })

  it('右键行弹出菜单：复制、粘贴、移动、重命名、压缩齐备，无剪贴板时粘贴禁用', async () => {
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })

    fireEvent.contextMenu(rowOf(region, '^etc '))

    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: '复制' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: '移动' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: '重命名' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: '压缩' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: '粘贴到此目录' })).toHaveAttribute(
      'data-disabled',
    )
  })

  it('复制后工具栏出现粘贴，点它粘进当前目录生成副本', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })
    expect(screen.queryByRole('button', { name: '粘贴' })).not.toBeInTheDocument()

    fireEvent.contextMenu(rowOf(region, '^bin '))
    await user.click(await screen.findByRole('menuitem', { name: '复制' }))
    expect(screen.getByLabelText('通知')).toHaveTextContent('（mock，待接入真实执行）')

    await user.click(screen.getByRole('button', { name: '粘贴' }))

    const reloaded = await screen.findByRole('region', { name: '文件列表' })
    expect(within(reloaded).getByRole('cell', { name: 'bin 副本' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '粘贴' })).not.toBeInTheDocument()
  })

  it('移动粘进指定目录：源目录不再有它，目标目录出现它', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    let region = await screen.findByRole('region', { name: '文件列表' })

    fireEvent.contextMenu(rowOf(region, '^boot '))
    await user.click(await screen.findByRole('menuitem', { name: '移动' }))

    fireEvent.contextMenu(rowOf(region, '^etc '))
    await user.click(await screen.findByRole('menuitem', { name: '粘贴到此目录' }))

    region = await screen.findByRole('region', { name: '文件列表' })
    expect(within(region).queryByRole('row', { name: /^boot / })).not.toBeInTheDocument()

    await user.dblClick(rowOf(region, '^etc '))
    expect(await screen.findByRole('heading', { level: 1, name: '/etc' })).toBeInTheDocument()
    const etcRegion = await screen.findByRole('region', { name: '文件列表' })
    expect(rowOf(etcRegion, '^boot ')).toBeInTheDocument()
  })

  it('重命名对话框：非法名与重名行内报错，成功后行内名称更新', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })

    fireEvent.contextMenu(rowOf(region, '^srv '))
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
    const input = await screen.findByRole('textbox', { name: '新名称' })
    expect(input).toHaveValue('srv')

    await user.clear(input)
    await user.type(input, 'a/b')
    await user.click(screen.getByRole('button', { name: '确认重命名' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('名称不能为空，也不能包含 /')

    await user.clear(input)
    await user.type(input, 'home')
    await user.click(screen.getByRole('button', { name: '确认重命名' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('同名条目已存在')

    await user.clear(input)
    await user.type(input, 'storage')
    await user.click(screen.getByRole('button', { name: '确认重命名' }))

    const reloaded = await screen.findByRole('region', { name: '文件列表' })
    expect(within(reloaded).getByRole('cell', { name: 'storage' })).toBeInTheDocument()
    expect(within(reloaded).queryByRole('cell', { name: 'srv' })).not.toBeInTheDocument()
  })

  it('压缩在同级生成 tar.gz 行，大小为内容总和', async () => {
    const user = userEvent.setup()
    renderApp('/files/var/log')
    const region = await screen.findByRole('region', { name: '文件列表' })

    fireEvent.contextMenu(rowOf(region, 'auth.log'))
    await user.click(await screen.findByRole('menuitem', { name: '压缩' }))

    const reloaded = await screen.findByRole('region', { name: '文件列表' })
    const archiveRow = rowOf(reloaded, 'auth.log.tar.gz')
    expect(archiveRow).toBeInTheDocument()
    expect(within(archiveRow).getByText('214.4 KB')).toBeInTheDocument()
    expect(screen.getByLabelText('通知')).toHaveTextContent('已压缩为 auth.log.tar.gz')
  })
})
