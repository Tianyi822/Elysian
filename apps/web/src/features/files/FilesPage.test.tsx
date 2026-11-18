import { messageHistoryText } from '../../test/messageHistory'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { resetFilesData } from '../../adapters/mock/filesData'
import { MockFilesAdapter } from '../../adapters/mock/mockAdapters'
import { renderApp } from '../../test/renderApp'
import { useFilesStore } from '../../stores/filesStore'

beforeEach(() => {
  // 变更类用例会改共享的 mock 目录树：每条用例都从种子重来，否则前一条留下的
  // 副本与压缩包会串进后一条的行查询。
  resetFilesData()
  useFilesStore.setState({
    status: 'idle',
    path: '/',
    entries: [],
    sizes: {},
    sizeErrors: {},
    computingPaths: [],
    clipboard: undefined,
    searchKeyword: '',
    searchResults: [],
    searching: false,
    errorMessage: undefined,
    download: undefined,
    upload: undefined,
  })
})

function rowOf(region: HTMLElement, name: string) {
  const pattern = new RegExp(name.trim())
  const row = within(region).getAllByRole('row').find((candidate) => {
    const cells = within(candidate).queryAllByRole('cell')
    return cells.length > 1 && pattern.test(cells[1]?.textContent ?? '')
  })
  if (!row) throw new Error(`没有找到文件行：${name}`)
  return row
}

describe('文件管理页', () => {
  it('根目录列出系统目录，文件夹在前、文件在后，大小列左对齐', async () => {
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })
    const rows = within(region).getAllByRole('row')
    const names = rows.slice(1).map((row) => within(row).getAllByRole('cell')[1]?.textContent)
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

    expect(within(region).getByRole('columnheader', { name: /名称/ })).toBeInTheDocument()
    expect(within(region).getByRole('checkbox', { name: /全选/ })).toBeInTheDocument()
    expect(within(etcRow).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false')
  })

  it('权限/所有者列按条目呈现真实主机惯例的取值', async () => {
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })

    // 行名以条目名开头锚定：所有者文本里也含「root」，裸匹配会命中所有行。
    expect(within(rowOf(region, '^bin ')).getByText('555/root')).toBeInTheDocument()
    expect(within(rowOf(region, '^root ')).getByText('700/root')).toBeInTheDocument()
  })

  it('搜索框右侧紧跟刷新，上一级在工具栏最右侧，不显示总行数', async () => {
    const user = userEvent.setup()
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const list = vi.spyOn(gateway.files, 'list')
    renderApp('/files/var', { gateway })
    const region = await screen.findByRole('region', { name: '文件列表' })
    const search = within(region).getByRole('searchbox', { name: '搜索文件或目录' })
    const refresh = within(region).getByRole('button', { name: '刷新' })
    const parent = within(region).getByRole('button', { name: '上一级' })
    const toolbar = search.closest<HTMLElement>('.dt-toolbar-normal')!

    expect(search.closest('label')?.nextElementSibling).toContainElement(refresh)
    expect(toolbar.lastElementChild).toContainElement(parent)
    expect(screen.getAllByRole('button', { name: '刷新' })).toEqual([refresh])
    expect(screen.getAllByRole('button', { name: '上一级' })).toEqual([parent])
    expect(within(region).queryByText(/^\d+\s*行$/)).not.toBeInTheDocument()

    list.mockRejectedValueOnce(new Error('目录暂不可读'))
    await user.click(refresh)
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('刷新失败：目录暂不可读。已保留上次读取结果。')
    expect(list.mock.calls).toEqual([['/var'], ['/var']])
    expect(rowOf(region, 'log')).toBeInTheDocument()
    expect(refresh).toBeEnabled()

    await user.click(within(banner).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(banner).not.toBeInTheDocument())
    expect(list.mock.calls).toEqual([['/var'], ['/var'], ['/var']])
    expect(rowOf(region, 'log')).toBeInTheDocument()
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

  it('单击聚焦行，Enter 打开目录，保持与批选状态独立', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })

    const etcRow = rowOf(region, 'etc')
    await user.click(etcRow)
    expect(etcRow).toHaveFocus()
    expect(within(etcRow).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false')

    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { level: 1, name: '/etc' })).toBeInTheDocument()
  })

  it('空目录显示空状态', async () => {
    renderApp('/files/tmp')
    expect(await screen.findByText('此目录为空')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '文件列表' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: '搜索文件或目录' })).toBeInTheDocument()
  })

  it('不存在的目录显示错误与返回根目录动作', async () => {
    const user = userEvent.setup()
    renderApp('/files/does-not-exist')
    const alert = await screen.findByRole('region', { name: '目录读取失败' })
    expect(within(alert).getByText('目录读取失败')).toBeInTheDocument()
    expect(within(alert).getByText(/目录不存在/)).toBeInTheDocument()
    expect(screen.queryByText(/已保留上次读取结果/)).not.toBeInTheDocument()

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
      chmod: () => new Promise(() => {}),
      search: () => new Promise(() => {}),
      prepareDownload: () => new Promise(() => {}),
      startDownload: () => {},
      checkUpload: () => new Promise(() => {}),
      uploadFile: () => new Promise(() => {}),
    }
    renderApp('/files', { gateway })

    expect(await screen.findByText('正在读取目录内容…')).toBeInTheDocument()
  })

  it('文件行显示格式化的大小', async () => {
    renderApp('/files/var/log/nginx')
    const region = await screen.findByRole('region', { name: '文件列表' })

    const accessRow = rowOf(region, 'access.log')
    expect(within(accessRow).getByText('7.9 MB')).toBeInTheDocument()
    expect(within(accessRow).getByText('文件')).toBeInTheDocument()
    expect(within(accessRow).getByText('644/root')).toBeInTheDocument()
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
      chmod: (path, input) => mockFiles.chmod(path, input),
      search: (keyword) => mockFiles.search(keyword),
      prepareDownload: (...args) => mockFiles.prepareDownload(...args),
      startDownload: (...args) => mockFiles.startDownload(...args),
      checkUpload: (...args) => mockFiles.checkUpload(...args),
      uploadFile: (...args) => mockFiles.uploadFile(...args),
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
      chmod: (path, input) => mockFiles.chmod(path, input),
      search: (keyword) => mockFiles.search(keyword),
      prepareDownload: (...args) => mockFiles.prepareDownload(...args),
      startDownload: (...args) => mockFiles.startDownload(...args),
      checkUpload: (...args) => mockFiles.checkUpload(...args),
      uploadFile: (...args) => mockFiles.uploadFile(...args),
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

  it('目录大小统计失败在大小列标红并发通知，重试成功后清除错误', async () => {
    const user = userEvent.setup()
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const size = vi.spyOn(gateway.files, 'size')
      .mockRejectedValueOnce(new Error('磁盘不可达'))
      .mockResolvedValueOnce(1024)
    renderApp('/files', { gateway })
    const region = await screen.findByRole('region', { name: '文件列表' })
    const sizeCell = within(within(rowOf(region, '^bin ')).getAllByRole('cell').at(-1)!)

    await user.click(sizeCell.getByRole('button', { name: '计算 bin 的目录大小' }))
    expect(await sizeCell.findByText('计算失败：磁盘不可达')).toHaveClass('text-danger')
    expect(messageHistoryText()).toMatch(/统计目录大小失败（\/bin）：磁盘不可达/)
    await user.click(sizeCell.getByRole('button', { name: /重试计算 bin 的目录大小/ }))
    expect(await sizeCell.findByText('1.0 KB')).toBeInTheDocument()
    expect(sizeCell.queryByText(/磁盘不可达/)).not.toBeInTheDocument()
    expect(size).toHaveBeenCalledTimes(2)
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
    expect(messageHistoryText()).toContain('（mock，待接入真实执行）')

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
    expect(await screen.findByText('名称不能为空，也不能包含 /')).toBeInTheDocument()
    expect(messageHistoryText()).not.toContain('名称不能为空，也不能包含 /')

    await user.clear(input)
    await user.type(input, 'home')
    await user.click(screen.getByRole('button', { name: '确认重命名' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('同名条目已存在')
    expect(messageHistoryText()).toContain('同名条目已存在')

    await user.clear(input)
    await user.type(input, 'storage')
    await user.click(screen.getByRole('button', { name: '确认重命名' }))

    const reloaded = await screen.findByRole('region', { name: '文件列表' })
    expect(within(reloaded).getByRole('cell', { name: 'storage' })).toBeInTheDocument()
    await waitFor(() => expect(within(reloaded).queryByRole('cell', { name: 'srv' })).not.toBeInTheDocument())
  })

  it('重命名输入框：确认回车派发于组合结束之后时不重命名，随后的人工提交才重命名', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })

    fireEvent.contextMenu(rowOf(region, '^srv '))
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
    const input = await screen.findByRole('textbox', { name: '新名称' })

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'storage' } })
    fireEvent.compositionEnd(input)
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })).toBe(false)
    // jsdom 的 keyDown 不触发隐式提交：手动补一次，验证 onSubmit 同样吞掉这枚回车。
    fireEvent.submit(input.closest('form')!)
    expect(messageHistoryText()).not.toContain('已重命名')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // 弹窗与草稿都还在：改名没有发生。
    expect(screen.getByRole('textbox', { name: '新名称' })).toHaveValue('storage')

    await user.click(screen.getByRole('button', { name: '确认重命名' }))
    const reloaded = await screen.findByRole('region', { name: '文件列表' })
    expect(within(reloaded).getByRole('cell', { name: 'storage' })).toBeInTheDocument()
    await waitFor(() => expect(within(reloaded).queryByRole('cell', { name: 'srv' })).not.toBeInTheDocument())
    expect(messageHistoryText()).toContain('已重命名为 storage')
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
    expect(messageHistoryText()).toContain('已压缩为 auth.log.tar.gz')
  })

  it('权限对话框：勾选即时改写模式值，模式值也即时回写勾选', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })

    fireEvent.contextMenu(rowOf(region, '^etc '))
    await user.click(await screen.findByRole('menuitem', { name: '权限' }))

    const modeInput = await screen.findByRole('textbox', { name: '权限位' })
    expect(modeInput).toHaveValue('755')

    // 755 的用户组本来就只读与执行：勾上写入即 775。
    await user.click(screen.getByRole('checkbox', { name: '用户组写入' }))
    expect(modeInput).toHaveValue('775')

    // 反向：模式值改写勾选。
    await user.clear(modeInput)
    await user.type(modeInput, '700')
    expect(screen.getByRole('checkbox', { name: '所有者读取' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '用户组读取' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '公共执行' })).not.toBeChecked()
  })

  it('权限应用后行内权限与所有者更新，勾了子目录就连同后代一起改', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    let region = await screen.findByRole('region', { name: '文件列表' })

    fireEvent.contextMenu(rowOf(region, '^etc '))
    await user.click(await screen.findByRole('menuitem', { name: '权限' }))
    const modeInput = await screen.findByRole('textbox', { name: '权限位' })
    await user.clear(modeInput)
    await user.type(modeInput, '750')
    await user.click(screen.getByRole('checkbox', { name: '应用到子目录' }))
    await user.click(screen.getByRole('button', { name: '应用' }))

    region = await screen.findByRole('region', { name: '文件列表' })
    expect(within(rowOf(region, '^etc ')).getByText('750/root')).toBeInTheDocument()
    expect(messageHistoryText()).toContain('已把权限改为 750、所有者改为 root（含子目录）')

    // 进 /etc 看后代：ssh 目录也被改成 750，而 /var 这类同级不受影响。
    await user.dblClick(rowOf(region, '^etc '))
    const etcRegion = await screen.findByRole('region', { name: '文件列表' })
    expect(within(rowOf(etcRegion, '^ssh ')).getByText('750/root')).toBeInTheDocument()
  })

  it('权限对话框：非法模式值行内报错，不落数据；文件条目没有「应用到子目录」', async () => {
    const user = userEvent.setup()
    renderApp('/files/var/log')
    const region = await screen.findByRole('region', { name: '文件列表' })

    fireEvent.contextMenu(rowOf(region, 'auth.log'))
    await user.click(await screen.findByRole('menuitem', { name: '权限' }))

    const modeInput = await screen.findByRole('textbox', { name: '权限位' })
    expect(modeInput).toHaveValue('640')
    // 文件没有子目录：开关不出现。
    expect(screen.queryByRole('checkbox', { name: '应用到子目录' })).not.toBeInTheDocument()

    await user.clear(modeInput)
    await user.type(modeInput, '64')
    await user.click(screen.getByRole('button', { name: '应用' }))
    expect(await screen.findByText('权限位要写三位八进制数字，例如 755')).toBeInTheDocument()
    expect(messageHistoryText()).not.toContain('权限位要写三位八进制数字，例如 755')

    // 未落盘：关掉对话框后行内权限仍是原值。
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(within(rowOf(region, 'auth.log')).getByText('640/root')).toBeInTheDocument()
  })

  it('搜索框输入即全树检索，不显示结果行数', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    await screen.findByRole('region', { name: '文件列表' })
    expect(screen.queryByText(/共 \d+ 个文件夹/)).not.toBeInTheDocument()

    const input = screen.getByRole('searchbox', { name: '搜索文件或目录' })
    await user.type(input, 'nginx')

    const region = await screen.findByRole('region', { name: '搜索结果' })
    // 两个目录都叫 nginx，位置列随行各异；access.log 因路径命中
    expect(within(region).getAllByRole('cell', { name: 'nginx' }).length).toBe(2)
    expect(
      within(region).getAllByRole('cell', { name: '/var/log/nginx' }).length,
    ).toBeGreaterThanOrEqual(2)
    expect(within(region).getByRole('row', { name: /access\.log/ })).toBeInTheDocument()
    expect(within(region).queryByText(/^\d+\s*行$/)).not.toBeInTheDocument()
  })

  it('双击搜索结果里的目录进入该目录，并清空搜索回到目录列表', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const input = await screen.findByRole('searchbox', { name: '搜索文件或目录' })
    await user.type(input, 'grub')
    const region = await screen.findByRole('region', { name: '搜索结果' })

    // 行名以目录名锚定：子文件 grub.cfg 的路径也含关键词，但行名以 grub.cfg 开头不会撞
    await user.dblClick(rowOf(region, '^grub '))

    expect(await screen.findByRole('heading', { level: 1, name: '/boot/grub' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: '搜索文件或目录' })).toHaveValue('')
    expect(await screen.findByRole('region', { name: '文件列表' })).toBeInTheDocument()
  })

  it('文件结果回车跳到所在目录', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const input = await screen.findByRole('searchbox', { name: '搜索文件或目录' })
    await user.type(input, 'auth.log')
    const region = await screen.findByRole('region', { name: '搜索结果' })

    await user.type(within(region).getByRole('row', { name: /auth\.log/ }), '{Enter}')

    expect(await screen.findByRole('heading', { level: 1, name: '/var/log' })).toBeInTheDocument()
  })

  it('搜索无匹配显示空状态', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const input = await screen.findByRole('searchbox', { name: '搜索文件或目录' })

    await user.type(input, 'zzz')

    expect(await screen.findByText('没有找到匹配的条目')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '搜索结果' })).toBeInTheDocument()
    expect(input).toHaveFocus()
  })

  it('全树搜索切换列与结果时保留同一个输入框和焦点', async () => {
    const user = userEvent.setup()
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const search = vi.spyOn(gateway.files, 'search')
    renderApp('/files', { gateway })
    const input = await screen.findByRole('searchbox', { name: '搜索文件或目录' })

    await user.type(input, 'nginx')

    const region = await screen.findByRole('region', { name: '搜索结果' })
    expect(input).toBe(screen.getByRole('searchbox', { name: '搜索文件或目录' }))
    expect(input).toHaveFocus()
    expect(input).toHaveValue('nginx')
    expect(search).toHaveBeenLastCalledWith('nginx')
    expect(within(region).getByRole('columnheader', { name: /所在位置/ })).toBeInTheDocument()
    expect(within(region).getByRole('row', { name: /access\.log/ })).toBeInTheDocument()
  })

  it('勾选文件行只开启批选工具栏，不改变原文件剪贴板', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })
    await user.click(within(rowOf(region, '^etc')).getByRole('checkbox'))
    await user.click(within(rowOf(region, '^var')).getByRole('checkbox'))

    expect(await within(region).findByText('已选 2 项')).toBeInTheDocument()
    expect(within(region).queryByRole('button', { name: /复制/ })).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/files')
    expect(useFilesStore.getState().clipboard).toBeUndefined()
  })

  it('相同名称的全树结果按完整路径独立选择', async () => {
    const user = userEvent.setup()
    renderApp('/files')
    const input = await screen.findByRole('searchbox', { name: '搜索文件或目录' })
    await user.type(input, 'nginx')
    const region = await screen.findByRole('region', { name: '搜索结果' })
    const nginxRows = within(region).getAllByRole('row').filter((row) =>
      within(row).queryByRole('cell', { name: 'nginx' }))
    expect(nginxRows).toHaveLength(2)
    const first = within(nginxRows[0]!).getByRole('checkbox')
    const second = within(nginxRows[1]!).getByRole('checkbox')
    await user.click(first)
    await user.click(second)
    expect(await within(region).findByText('已选 2 项')).toBeInTheDocument()
    await user.click(first)
    expect(first).toHaveAttribute('aria-checked', 'false')
    expect(second).toHaveAttribute('aria-checked', 'true')
  })

  it('排序之后方向键按显示顺序移动，Enter 保持打开目录', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/files')
    const region = await screen.findByRole('region', { name: '文件列表' })
    const sort = within(region).getByRole('button', { name: /名称/ })
    await user.click(sort)
    await user.click(sort)
    const varRow = rowOf(region, '^var')
    await user.click(varRow)
    await user.keyboard('{ArrowDown}')
    const usrRow = rowOf(region, '^usr')
    expect(usrRow).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe('/files/usr'))
  })

  it('静默刷新保留仍存在的勾选，导航后清除旧目录勾选', async () => {
    const user = userEvent.setup()
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    renderApp('/files', { gateway })
    const region = await screen.findByRole('region', { name: '文件列表' })
    await user.click(within(rowOf(region, '^etc')).getByRole('checkbox'))

    await act(async () => { await useFilesStore.getState().load(gateway, '/', { silent: true }) })
    expect(within(rowOf(region, '^etc')).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true')

    await user.dblClick(rowOf(region, '^var'))
    expect(await screen.findByRole('heading', { level: 1, name: '/var' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('searchbox', { name: '搜索文件或目录' })).toBeInTheDocument())
    expect(screen.queryByText('已选 1 项')).not.toBeInTheDocument()
  })

  it('全选直接并发统计未计算的目录，不弹窗，单项失败不阻塞其他目录', async () => {
    const user = userEvent.setup()
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
    const directories = ['cached', 'dir-a', 'dir-b', 'dir-c', 'dir-d', 'dir-e']
    const entry = { mode: '755', owner: 'root', modifiedAt: '2026-11-18T00:00:00Z' }
    vi.spyOn(gateway.files, 'list').mockResolvedValue([
      ...directories.map((name) => ({ ...entry, name, kind: 'directory' as const })),
      { ...entry, name: 'file.txt', kind: 'file', sizeBytes: 7 },
    ])
    useFilesStore.setState({ sizes: { '/cached': 0 } })
    const requests = new Map<string, { resolve(bytes: number): void; reject(error: Error): void }>()
    const size = vi.spyOn(gateway.files, 'size').mockImplementation((path) => new Promise((resolve, reject) => {
      requests.set(path, { resolve, reject })
    }))
    renderApp('/files', { gateway })
    const region = await screen.findByRole('region', { name: '文件列表' })
    await user.click(within(region).getByRole('checkbox', { name: /全选/ }))
    await user.click(await screen.findByRole('button', { name: '计算目录大小' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect([...requests.keys()]).toEqual(['/dir-a', '/dir-b', '/dir-c', '/dir-d'])
    expect(within(rowOf(region, '^dir-a')).getByText('计算中')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '计算目录大小' })).toBeDisabled()

    await act(async () => { requests.get('/dir-b')!.reject(new Error('没有读取权限')) })
    expect(within(rowOf(region, '^dir-b')).getByText('计算失败：没有读取权限')).toHaveClass('text-danger')
    expect(messageHistoryText()).toContain('统计目录大小失败（/dir-b）：没有读取权限')
    expect(size.mock.calls.map(([path]) => path)).toEqual(['/dir-a', '/dir-b', '/dir-c', '/dir-d', '/dir-e'])
    await act(async () => { requests.get('/dir-e')!.resolve(0) })
    expect(within(rowOf(region, '^dir-e')).getByText('0 B')).toBeInTheDocument()
    expect(within(rowOf(region, '^dir-a')).getByText('计算中')).toBeInTheDocument()

    await act(async () => {
      for (const path of ['/dir-a', '/dir-c', '/dir-d']) requests.get(path)!.resolve(1024)
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(rowOf(region, '^dir-a')).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false')
    expect(within(rowOf(region, '^dir-b')).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true')
    expect(within(rowOf(region, '^file.txt')).getByText('7 B')).toBeInTheDocument()
  })
})
