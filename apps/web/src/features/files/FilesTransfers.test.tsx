import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEntry } from '@elysian/contracts'
import type { FileDownload } from '../../contracts/adapters'
import { createMockGateway } from '../../adapters/mock/gateway'
import { resetFilesData } from '../../adapters/mock/filesData'
import { renderApp } from '../../test/renderApp'
import { useFilesStore } from '../../stores/filesStore'

beforeEach(() => {
  useFilesStore.getState().cancelDownload()
  useFilesStore.getState().cancelUpload()
  resetFilesData()
  useFilesStore.setState({ status: 'idle', path: '/', entries: [], sizes: {}, computingPaths: [], clipboard: undefined, searchKeyword: '', searchResults: [], searching: false, errorMessage: undefined, download: undefined, upload: undefined })
})

function gateway() {
  return createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })
}

function row(region: HTMLElement, name: RegExp) {
  return within(region).getByRole('row', { name })
}

const uploaded = (name: string): FileEntry => ({ name, kind: 'file', sizeBytes: 3, mode: '644', owner: 'root', modifiedAt: '2026-10-11T00:00:00Z' })
const download: FileDownload = { id: 'prepared-download', name: 'auth.log', sizeBytes: 3, expiresAt: '2026-10-11T01:00:00Z' }

describe('文件上传与下载交互', () => {
  it('文件和已有压缩包只下载该条目，不调用压缩操作', async () => {
    const user = userEvent.setup()
    const api = gateway()
    await api.files.compressEntry('/var/log/auth.log')
    const prepare = vi.spyOn(api.files, 'prepareDownload').mockResolvedValue(download)
    const start = vi.spyOn(api.files, 'startDownload').mockImplementation(() => {})
    const compress = vi.spyOn(api.files, 'compressEntry')
    renderApp('/files/var/log', { gateway: api })
    const region = await screen.findByRole('region', { name: '文件列表' })
    for (const name of ['auth.log', 'auth.log.tar.gz']) {
      fireEvent.contextMenu(row(region, new RegExp(`^${name.replaceAll('.', '\\.')} `)))
      expect(screen.getAllByRole('menu')).toHaveLength(1)
      expect(screen.getByRole('menuitem', { name: '上传至当前目录' })).toBeInTheDocument()
      await user.click(screen.getByRole('menuitem', { name: '下载' }))
      expect(await screen.findByText('已开始下载，请在浏览器中查看下载进度。')).toBeInTheDocument()
      expect(prepare).toHaveBeenLastCalledWith(`/var/log/${name}`, expect.any(AbortSignal))
      await user.click(screen.getByRole('button', { name: '关闭' }))
    }
    expect(start).toHaveBeenCalledTimes(2)
    expect(compress).not.toHaveBeenCalled()
  })

  it('目录显示打包中，可取消且迟到的准备结果不会触发下载', async () => {
    const user = userEvent.setup()
    const api = gateway()
    let finish: (result: FileDownload) => void = () => {}
    const prepare = vi.spyOn(api.files, 'prepareDownload').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const start = vi.spyOn(api.files, 'startDownload').mockImplementation(() => {})
    renderApp('/files', { gateway: api })
    const region = await screen.findByRole('region', { name: '文件列表' })
    fireEvent.contextMenu(row(region, /^etc /))
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menuitem', { name: '上传至该目录' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '上传至当前目录' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: '下载' }))
    expect(await screen.findByText('正在打包为 tar.gz…')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消准备' }))
    expect(prepare.mock.calls[0]?.[1]?.aborted).toBe(true)
    await act(async () => finish({ ...download, name: 'etc.tar.gz' }))
    expect(start).not.toHaveBeenCalled()
    expect(within(screen.getByRole('dialog')).getByText('已取消准备下载。')).toBeInTheDocument()
  })

  it('目录右键上传固定到该目录，多选文件逐项展示上传结果', async () => {
    const user = userEvent.setup()
    const api = gateway()
    const check = vi.spyOn(api.files, 'checkUpload').mockResolvedValue({ state: 'create', token: 'create' })
    const upload = vi.spyOn(api.files, 'uploadFile').mockImplementation(async (_path, file, _check, _overwrite, options) => {
      options?.onProgress?.(65)
      return uploaded(file.name)
    })
    renderApp('/files', { gateway: api })
    const region = await screen.findByRole('region', { name: '文件列表' })
    fireEvent.contextMenu(row(region, /^etc /))
    await user.click(screen.getByRole('menuitem', { name: '上传至该目录' }))
    const input = screen.getByLabelText('选择上传文件')
    expect(input).toHaveAttribute('multiple')
    expect(input).not.toHaveAttribute('webkitdirectory')
    await user.upload(input, [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')])
    expect(await screen.findByLabelText('上传目标目录')).toHaveTextContent('/etc')
    expect(await screen.findByText('已上传 2 / 2 个文件')).toBeInTheDocument()
    expect(check.mock.calls.map((call) => call[0])).toEqual(['/etc', '/etc'])
    expect(upload.mock.calls.map((call) => call[1].name)).toEqual(['one.txt', 'two.txt'])
    expect(within(screen.getByLabelText('上传文件状态')).getAllByText('已上传')).toHaveLength(2)
  })

  it('空目录右键可上传到当前目录', async () => {
    const user = userEvent.setup()
    const api = gateway()
    const check = vi.spyOn(api.files, 'checkUpload').mockResolvedValue({ state: 'create', token: 'create' })
    vi.spyOn(api.files, 'uploadFile').mockResolvedValue(uploaded('new.txt'))
    renderApp('/files/tmp', { gateway: api })
    await screen.findByText('此目录为空')
    fireEvent.contextMenu(screen.getByLabelText('文件列表操作区域'))
    await user.click(screen.getByRole('menuitem', { name: '上传至当前目录' }))
    await user.upload(screen.getByLabelText('选择上传文件'), new File(['new'], 'new.txt'))
    await screen.findByText('已上传 1 / 1 个文件')
    expect(check).toHaveBeenCalledWith('/tmp', 'new.txt', 3, expect.any(AbortSignal))
  })

  it('搜索结果中的文件上传目标为当前路由目录，列表空白有同一入口', async () => {
    const user = userEvent.setup()
    const api = gateway()
    const check = vi.spyOn(api.files, 'checkUpload').mockResolvedValue({ state: 'create', token: 'create' })
    vi.spyOn(api.files, 'uploadFile').mockResolvedValue(uploaded('new.txt'))
    renderApp('/files/etc', { gateway: api })
    await screen.findByRole('region', { name: '文件列表' })
    fireEvent.contextMenu(screen.getByLabelText('文件列表操作区域'))
    expect(await screen.findByRole('menuitem', { name: '上传至当前目录' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.type(screen.getByRole('searchbox', { name: '搜索文件或目录' }), 'auth.log')
    const results = await screen.findByRole('region', { name: '搜索结果' })
    fireEvent.contextMenu(row(results, /auth\.log/))
    await user.click(screen.getByRole('menuitem', { name: '上传至当前目录' }))
    await user.upload(screen.getByLabelText('选择上传文件'), new File(['new'], 'new.txt'))
    await screen.findByText('已上传 1 / 1 个文件')
    expect(check).toHaveBeenCalledWith('/etc', 'new.txt', 3, expect.any(AbortSignal))
  })

  it('同名文件明确询问覆盖或跳过，跳过后继续后续文件', async () => {
    const user = userEvent.setup()
    const api = gateway()
    vi.spyOn(api.files, 'checkUpload')
      .mockResolvedValueOnce({ state: 'replace', token: 'existing', existing: uploaded('hosts') })
      .mockResolvedValueOnce({ state: 'create', token: 'new' })
    const upload = vi.spyOn(api.files, 'uploadFile').mockImplementation(async (_dir, file) => uploaded(file.name))
    renderApp('/files/etc', { gateway: api })
    await screen.findByRole('region', { name: '文件列表' })
    fireEvent.contextMenu(screen.getByLabelText('文件列表操作区域'))
    await user.click(screen.getByRole('menuitem', { name: '上传至当前目录' }))
    await user.upload(screen.getByLabelText('选择上传文件'), [new File(['new'], 'hosts'), new File(['new'], 'second.txt')])
    expect(await screen.findByRole('alert')).toHaveTextContent('「hosts」已存在，要覆盖吗？')
    expect(screen.getByRole('button', { name: '覆盖此文件' })).toBeInTheDocument()
    expect(upload).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '跳过此文件' }))
    await screen.findByText('已上传 1 / 2 个文件')
    expect(screen.getByText('已跳过')).toBeInTheDocument()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]?.[1].name).toBe('second.txt')
  })

  it('上传进度可见，取消当前传输后后续文件也停止', async () => {
    const user = userEvent.setup()
    const api = gateway()
    vi.spyOn(api.files, 'checkUpload').mockResolvedValue({ state: 'create', token: 'new' })
    const upload = vi.spyOn(api.files, 'uploadFile').mockImplementation((_dir, _file, _check, _overwrite, options) => new Promise((_resolve, reject) => {
      options?.onProgress?.(42)
      options?.signal?.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true })
    }))
    renderApp('/files/tmp', { gateway: api })
    await screen.findByText('此目录为空')
    fireEvent.contextMenu(screen.getByLabelText('文件列表操作区域'))
    await user.click(screen.getByRole('menuitem', { name: '上传至当前目录' }))
    await user.upload(screen.getByLabelText('选择上传文件'), [new File(['new'], 'first.txt'), new File(['new'], 'second.txt')])
    expect(await screen.findByRole('progressbar', { name: 'first.txt 上传进度' })).toHaveAttribute('value', '42')
    await user.click(screen.getByRole('button', { name: '取消上传' }))
    await waitFor(() => expect(screen.getAllByText('已取消')).toHaveLength(2))
    expect(upload).toHaveBeenCalledTimes(1)
    expect(screen.getByText('传输已取消，请刷新确认目标文件状态。')).toBeInTheDocument()
  })
})
