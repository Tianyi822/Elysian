import { beforeEach, describe, expect, it } from 'vitest'
import { resetFilesData } from './filesData'
import { MockFilesAdapter } from './mockAdapters'

beforeEach(resetFilesData)

describe('文件传输演示接缝', () => {
  it('空目录上传只改内存，重置后移除；同名需明确覆盖', async () => {
    const adapter = new MockFilesAdapter()
    const file = new File(['original'], 'backup.zip')
    const check = await adapter.checkUpload('/tmp', file.name, file.size)
    expect(check.state).toBe('create')
    expect(await adapter.uploadFile('/tmp', file, check, false)).toMatchObject({ name: 'backup.zip', sizeBytes: 8 })
    const replacement = new File(['new'], file.name)
    const conflict = await adapter.checkUpload('/tmp', file.name, replacement.size)
    expect(conflict.state).toBe('replace')
    await expect(adapter.uploadFile('/tmp', replacement, conflict, false)).rejects.toMatchObject({ status: 409 })
    const confirmed = await adapter.checkUpload('/tmp', file.name, replacement.size)
    await adapter.uploadFile('/tmp', replacement, confirmed, true)
    expect((await adapter.list('/tmp'))[0]?.sizeBytes).toBe(3)
    resetFilesData()
    expect(await adapter.list('/tmp')).toEqual([])
  })

  it('目标变化、目录冲突和取消不会写入，下载不伪造正文', async () => {
    const adapter = new MockFilesAdapter()
    const file = new File(['new'], 'hosts')
    const checked = await adapter.checkUpload('/etc', file.name, file.size)
    await adapter.chmod('/etc/hosts', { mode: '600', owner: 'root', recursive: false })
    await expect(adapter.uploadFile('/etc', file, checked, true)).rejects.toMatchObject({ status: 409 })
    await expect(adapter.checkUpload('/', 'etc', 1)).rejects.toThrow('目录')
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.checkUpload('/tmp', 'cancel', 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(adapter.prepareDownload('/etc/hosts')).rejects.toThrow('演示模式没有真实文件内容')
    expect(await adapter.list('/tmp')).toEqual([])
  })
})
