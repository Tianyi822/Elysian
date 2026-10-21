import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import * as Tooltip from '@radix-ui/react-tooltip'
import { describe, expect, it, vi } from 'vitest'
import type { AgentMemorySpaceSelection } from '@elysian/contracts'
import { createMockGateway } from '../../adapters/mock/gateway'
import { advanceAuthGeneration } from '../../adapters/http/unauthorized'
import { ChatMemorySelection, ChatMemorySources } from './ChatMemory'

function wrapper({ children }: { children: React.ReactNode }) { return <MemoryRouter><Tooltip.Provider>{children}</Tooltip.Provider></MemoryRouter> }
const setup = () => createMockGateway({ eventStream: 'memory' }).agentMemory

describe('聊天记忆', () => {
  it('从服务端恢复每个会话的选择，保存关闭选择，重开后不复用其他会话展示', async () => {
    const api = setup(), user = userEvent.setup(), onClose = vi.fn()
    const project = await api.createSpace({ name: '项目 A', kind: 'business' })
    await api.setSelection('session-a', { spaceId: project.id, includeGlobal: true })
    await api.setSelection('session-b', { spaceId: '', includeGlobal: false })
    const save = vi.spyOn(api, 'setSelection')
    const view = render(<ChatMemorySelection sessionId="session-a" api={api} disabled={false} onClose={onClose} />, { wrapper })
    await screen.findByRole('button', { name: '记忆空间：项目 A' })
    expect(screen.getByRole('checkbox')).toBeChecked()
    await user.click(screen.getByRole('button', { name: '记忆空间：项目 A' }))
    await user.click(screen.getByRole('menuitemradio', { name: '关闭记忆' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('session-a', { spaceId: '', includeGlobal: false }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    view.rerender(<ChatMemorySelection sessionId="session-b" api={api} disabled={false} onClose={onClose} />)
    await screen.findByRole('button', { name: '记忆空间：关闭记忆' })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('鉴权切换后丢弃迟到的选择读取', async () => {
    const api = setup()
    let resolve!: (selection: AgentMemorySpaceSelection) => void
    vi.spyOn(api, 'getSelection').mockImplementationOnce(() => new Promise(done => { resolve = done }))
    render(<ChatMemorySelection sessionId="old-login" api={api} disabled={false} onClose={() => {}} />, { wrapper })
    await waitFor(() => expect(api.getSelection).toHaveBeenCalled())
    advanceAuthGeneration()
    await act(async () => { resolve({ spaceId: '', includeGlobal: false }) })
    expect(screen.queryByRole('button', { name: '记忆空间：关闭记忆' })).not.toBeInTheDocument()
  })

  it('回答引用固定修订，当前页面更新后仍读取当时内容；摘要失配不回退最新版本', async () => {
    const api = setup()
    const [space] = await api.listSpaces()
    const old = await api.createPage(space!.id, { slug: 'reference', title: '运维约定', markdown: '当时的约定' })
    await api.updatePage(space!.id, old.id, { expectedRevision: old.revision, slug: old.slug, title: old.title, markdown: '后来改过的约定' })
    const ref = { pageId: old.id, revision: old.revision, digest: old.digest }
    const read = vi.spyOn(api, 'getReference')
    const view = render(<ChatMemorySources sources={[ref]} api={api} />, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: '来源 1 · v1' }))
    await screen.findByText('当时的约定')
    expect(screen.queryByText('后来改过的约定')).not.toBeInTheDocument()
    expect(read).toHaveBeenCalledWith(ref, expect.any(AbortSignal))
    expect(screen.getByRole('link', { name: '在长期记忆中查看' })).toHaveAttribute('href', `/agent/memory?space=${space!.id}&page=${old.id}&revision=1`)
    fireEvent.click(screen.getByRole('button', { name: '关闭记忆引用' }))
    view.rerender(<ChatMemorySources sources={[{ ...ref, digest: 'wrong' }]} api={api} />)
    fireEvent.click(screen.getByRole('button', { name: '来源 1 · v1' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('后来改过的约定')).not.toBeInTheDocument()
  })

  it('来源撤回后提示失效，仍展示回答使用的原修订', async () => {
    const api = setup()
    const [space] = await api.listSpaces()
    const old = await api.createPage(space!.id, { slug: 'withdrawn-reference', title: '已撤回的约定', markdown: '当时引用的原文' })
    await api.withdrawPage(space!.id, old.id, old.revision)
    render(<ChatMemorySources sources={[{ pageId: old.id, revision: old.revision, digest: old.digest }]} api={api} />, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: '来源 1 · v1' }))
    await screen.findByText('此来源已撤回，历史内容仅供核对。')
    expect(screen.getByText('当时引用的原文')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '在长期记忆中查看' })).toHaveAttribute('href', `/agent/memory?space=${space!.id}&page=${old.id}&revision=1`)
  })
})
