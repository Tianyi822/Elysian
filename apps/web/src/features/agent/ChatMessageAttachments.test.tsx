import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageAttachments } from './ChatMessageAttachments'

const attachment = { id: 'image-1', name: 'diagram.png', mimeType: 'image/png', bytes: 3, width: 1, height: 1 }
const blob = new Blob(['png'], { type: 'image/png' })
const createObjectURL = vi.fn(() => 'blob:preview')
const revokeObjectURL = vi.fn()

beforeEach(() => {
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = createObjectURL
    static override revokeObjectURL = revokeObjectURL
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('消息图片资源清理', () => {
  it('正常加载后卸载会释放图片 URL', async () => {
    const fetchBlob = vi.fn(async () => blob)
    const { unmount } = render(<ChatMessageAttachments attachments={[attachment]} fetchBlob={fetchBlob} />)
    expect(await screen.findByRole('img', { name: attachment.name })).toHaveAttribute('src', 'blob:preview')
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview')
  })

  it('卸载后才返回的图片不再创建 URL', async () => {
    let finish!: (value: Blob) => void
    const fetchBlob = vi.fn(() => new Promise<Blob>(resolve => { finish = resolve }))
    const { unmount } = render(<ChatMessageAttachments attachments={[attachment]} fetchBlob={fetchBlob} />)
    expect(fetchBlob).toHaveBeenCalledWith(attachment.id)
    unmount()
    await act(async () => { finish(blob) })
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('换图后忽略旧请求的迟到结果，当前图片仍正常显示和释放', async () => {
    let finishOld!: (value: Blob) => void
    const fetchBlob = vi.fn(async () => blob)
      .mockImplementationOnce(() => new Promise<Blob>(resolve => { finishOld = resolve }))
    const { rerender, unmount } = render(<ChatMessageAttachments attachments={[attachment]} fetchBlob={fetchBlob} />)
    const next = { ...attachment, id: 'image-2', name: 'next.png' }
    rerender(<ChatMessageAttachments attachments={[next]} fetchBlob={fetchBlob} />)
    await waitFor(() => expect(screen.getByRole('img', { name: next.name })).toHaveAttribute('src', 'blob:preview'))
    await act(async () => { finishOld(blob) })
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(screen.getByRole('img', { name: next.name })).toHaveAttribute('src', 'blob:preview')
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview')
  })
})
