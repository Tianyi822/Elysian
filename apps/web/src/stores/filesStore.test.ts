import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEntry } from '@elysian/contracts'
import { createMockGateway } from '../adapters/mock/gateway'
import { FileTransferError } from '../adapters/filesTransferError'
import { useFilesStore } from './filesStore'
import { useMessageStore } from './messageStore'

const entry = (name: string): FileEntry => ({ name, kind: 'file', sizeBytes: 3, mode: '644', owner: 'root', modifiedAt: '2026-10-11T00:00:00Z' })

beforeEach(async () => {
  useFilesStore.getState().cancelDownload()
  useFilesStore.getState().cancelUpload()
  await useMessageStore.getState().clear()
  useFilesStore.setState({ status: 'ready', path: '/tmp', entries: [], sizes: { '/tmp': 0 }, computingPaths: [], searchKeyword: '', searchResults: [], searching: false, download: undefined, upload: undefined })
})

describe('文件传输状态', () => {
  it.each(['check', 'upload'])('会话在%s阶段失效后停止后续文件，不再自动回读', async (phase) => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const expired = new FileTransferError(401, '登录状态已失效，请重新登录')
    const check = vi.spyOn(gateway.files, 'checkUpload').mockResolvedValue({ state: 'create', token: 'new' })
    const upload = vi.spyOn(gateway.files, 'uploadFile').mockRejectedValue(expired)
    const list = vi.spyOn(gateway.files, 'list')
    if (phase === 'check') check.mockRejectedValueOnce(expired)
    await useFilesStore.getState().uploadFiles(gateway, '/tmp', [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')])
    expect(check).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledTimes(phase === 'upload' ? 1 : 0)
    expect(list).not.toHaveBeenCalled()
    expect(useFilesStore.getState().upload?.items.map((item) => item.status)).toEqual(['error', 'cancelled'])
    expect(useFilesStore.getState().upload?.items[0]?.errorMessage).toContain('登录状态已失效')
  })

  it('409后重新检查并重新询问，使用新确认令牌而不自动覆盖', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    const check = vi.spyOn(gateway.files, 'checkUpload')
      .mockResolvedValueOnce({ state: 'replace', token: 'first', existing: entry('data.txt') })
      .mockResolvedValueOnce({ state: 'replace', token: 'changed', existing: entry('data.txt') })
    const upload = vi.spyOn(gateway.files, 'uploadFile')
      .mockRejectedValueOnce(new FileTransferError(409, '目标已变化'))
      .mockResolvedValueOnce(entry('data.txt'))
    const work = useFilesStore.getState().uploadFiles(gateway, '/tmp', [new File(['new'], 'data.txt')])
    await waitFor(() => expect(useFilesStore.getState().upload?.conflictIndex).toBe(0))
    useFilesStore.getState().decideUploadConflict(true)
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(useFilesStore.getState().upload?.items[0]?.errorMessage).toBe('目标已发生变化，请重新确认。'))
    expect(upload).toHaveBeenCalledTimes(1)
    useFilesStore.getState().decideUploadConflict(true)
    await work
    expect(upload.mock.calls.map((call) => [call[2].token, call[3]])).toEqual([['first', true], ['changed', true]])
    expect(useFilesStore.getState().upload?.items[0]?.status).toBe('complete')
  })

  it('网络失败不会重传，部分成功后刷新当前列表、搜索与大小缓存', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(gateway.files, 'checkUpload').mockResolvedValue({ state: 'create', token: 'new' })
    const upload = vi.spyOn(gateway.files, 'uploadFile')
      .mockResolvedValueOnce(entry('one.txt'))
      .mockRejectedValueOnce(new Error('网络连接失败，上传结果未确认'))
    const list = vi.spyOn(gateway.files, 'list').mockResolvedValue([entry('one.txt')])
    const search = vi.spyOn(gateway.files, 'search').mockResolvedValue([{ ...entry('one.txt'), path: '/tmp/one.txt' }])
    useFilesStore.setState({ searchKeyword: '.txt' })
    await useFilesStore.getState().uploadFiles(gateway, '/tmp', [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')])
    expect(upload).toHaveBeenCalledTimes(2)
    expect(useFilesStore.getState().upload?.items.map((item) => item.status)).toEqual(['complete', 'error'])
    expect(useFilesStore.getState().upload?.items[1]?.errorMessage).toContain('网络连接失败')
    expect(list).toHaveBeenCalledWith('/tmp')
    expect(search).toHaveBeenCalledWith('.txt')
    expect(useFilesStore.getState().sizes).toEqual({})
    expect(useFilesStore.getState().entries[0]?.name).toBe('one.txt')
    expect(useMessageStore.getState().messages).toEqual([
      expect.objectContaining({ tone: 'danger', message: expect.stringContaining('two.txt：网络连接失败，上传结果未确认') }),
    ])
  })

  it('检查失败仅标记该文件，不上传目录同名项，之后的文件继续', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(gateway.files, 'checkUpload')
      .mockRejectedValueOnce(new Error('目标是目录，不能覆盖'))
      .mockResolvedValueOnce({ state: 'create', token: 'new' })
    const upload = vi.spyOn(gateway.files, 'uploadFile').mockResolvedValue(entry('next.txt'))
    await useFilesStore.getState().uploadFiles(gateway, '/tmp', [new File(['bad'], 'subdir'), new File(['next'], 'next.txt')])
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]?.[1].name).toBe('next.txt')
    expect(useFilesStore.getState().upload?.items.map((item) => item.status)).toEqual(['error', 'complete'])
  })

  it('上传目标在导航后仍固定，结束时刷新新目录且旧大小计算不会回填缓存', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    let finishSize: (size: number) => void = () => {}
    vi.spyOn(gateway.files, 'size').mockImplementation(() => new Promise((resolve) => { finishSize = resolve }))
    const sizing = useFilesStore.getState().computeSize(gateway, '/etc')
    vi.spyOn(gateway.files, 'checkUpload').mockResolvedValue({ state: 'replace', token: 'same', existing: entry('data.txt') })
    const upload = vi.spyOn(gateway.files, 'uploadFile').mockResolvedValue(entry('data.txt'))
    const list = vi.spyOn(gateway.files, 'list').mockResolvedValue([])
    const work = useFilesStore.getState().uploadFiles(gateway, '/tmp', [new File(['new'], 'data.txt')])
    await waitFor(() => expect(useFilesStore.getState().upload?.conflictIndex).toBe(0))
    useFilesStore.setState({ path: '/etc' })
    useFilesStore.getState().decideUploadConflict(true)
    await work
    finishSize(12345)
    await sizing
    expect(upload.mock.calls[0]?.[0]).toBe('/tmp')
    expect(list).toHaveBeenCalledWith('/etc')
    expect(useFilesStore.getState().sizes).toEqual({})
  })

  it('冲突等待期间取消，不再发送任何文件', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(gateway.files, 'checkUpload').mockResolvedValue({ state: 'replace', token: 'same', existing: entry('data.txt') })
    const upload = vi.spyOn(gateway.files, 'uploadFile')
    const work = useFilesStore.getState().uploadFiles(gateway, '/tmp', [new File(['new'], 'data.txt'), new File(['next'], 'next.txt')])
    await waitFor(() => expect(useFilesStore.getState().upload?.conflictIndex).toBe(0))
    useFilesStore.getState().cancelUpload()
    await work
    expect(upload).not.toHaveBeenCalled()
    expect(useFilesStore.getState().upload?.items.map((item) => item.status)).toEqual(['cancelled', 'cancelled'])
    expect(useFilesStore.getState().upload?.busy).toBe(false)
    expect(useMessageStore.getState().messages).toEqual([
      expect.objectContaining({ tone: 'info', message: expect.stringContaining('上传已取消') }),
    ])
  })

  it('下载准备失败进入通知，重复的传输错误只通知一次', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    vi.spyOn(gateway.files, 'prepareDownload').mockRejectedValueOnce(new Error('归档空间不足'))
    await useFilesStore.getState().downloadEntry(gateway, '/tmp/data.txt', entry('data.txt'))
    expect(useMessageStore.getState().messages).toEqual([
      expect.objectContaining({ tone: 'danger', message: '下载失败：归档空间不足' }),
    ])

    await useMessageStore.getState().clear()
    vi.spyOn(gateway.files, 'prepareDownload').mockResolvedValue({ id: 'd1', name: 'data.txt', sizeBytes: 3, expiresAt: '2026-10-11T01:00:00Z' })
    vi.spyOn(gateway.files, 'startDownload').mockImplementation((_download, onError) => {
      onError?.(new Error('传输中断'))
      onError?.(new Error('传输中断'))
    })
    await useFilesStore.getState().downloadEntry(gateway, '/tmp/data.txt', entry('data.txt'))
    expect(useMessageStore.getState().messages.map((notice) => notice.tone)).toEqual(['info', 'danger'])
  })
})
