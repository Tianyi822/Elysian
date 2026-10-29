import { memoryFixture } from '../../test/memoryFixture'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import * as Tooltip from '@radix-ui/react-tooltip'
import { describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { ChatMemorySources } from './ChatMemory'

function wrapper({ children }: { children: React.ReactNode }) { return <MemoryRouter><Tooltip.Provider>{children}</Tooltip.Provider></MemoryRouter> }
const setup = () => createMockGateway({ eventStream: 'memory' }).agentMemory

describe('聊天记忆', () => {


  it('回答引用固定修订，当前页面更新后仍读取当时内容；摘要失配不回退最新版本', async () => {
    const api = setup()
    const [space] = await api.listSpaces()
    const old = await memoryFixture(api).seedPage(space!.id, { slug: 'reference', title: '运维约定', markdown: '当时的约定' })
    await api.updatePage(space!.id, old.id, { expectedRevision: old.revision, slug: old.slug, title: old.title, markdown: '后来改过的约定' })
    const ref = { pageId: old.id, revision: old.revision, digest: old.digest }
    const read = vi.spyOn(api, 'getReference')
    const view = render(<ChatMemorySources sources={[ref]} api={api} />, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: '来源 1 · v1' }))
    await screen.findByText('当时的约定')
    expect(screen.queryByText('后来改过的约定')).not.toBeInTheDocument()
    expect(read).toHaveBeenCalledWith(ref, expect.any(AbortSignal))
    expect(screen.queryByRole('link', { name: '在长期记忆中查看' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭记忆引用' }))
    view.rerender(<ChatMemorySources sources={[{ ...ref, digest: 'wrong' }]} api={api} />)
    fireEvent.click(screen.getByRole('button', { name: '来源 1 · v1' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('后来改过的约定')).not.toBeInTheDocument()
  })

  it('来源撤回后提示失效，仍展示回答使用的原修订', async () => {
    const api = setup()
    const [space] = await api.listSpaces()
    const old = await memoryFixture(api).seedPage(space!.id, { slug: 'withdrawn-reference', title: '已撤回的约定', markdown: '当时引用的原文' })
    await memoryFixture(api).seedWithdrawal(space!.id, old.id, old.revision)
    render(<ChatMemorySources sources={[{ pageId: old.id, revision: old.revision, digest: old.digest }]} api={api} />, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: '来源 1 · v1' }))
    await screen.findByText('此来源已撤回，历史内容仅供核对。')
    expect(screen.getByText('当时引用的原文')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '在长期记忆中查看' })).not.toBeInTheDocument()
  })
})
