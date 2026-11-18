import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataTable, type Id } from './DataTable'
import { TableBatchActions } from './TableBatchActions'
import { advanceAuthGeneration } from '../utils/authGeneration'
import { scrollTablesToEnd } from '../test/tableRows'

type Row = { key: string; name: string; value: number | null }
const rows: Row[] = Array.from({ length: 25 }, (_, index) => ({ key: String(index), name: `条目${index}`, value: index === 24 ? null : 24 - index }))
const columns = [{ key: 'name', header: '名称', primary: true, accessor: (row: Row) => row.name }, { key: 'value', header: '数值', accessor: (row: Row) => row.value }]
const getRowId = (row: Row) => row.key
const getRowLabel = (row: Row) => row.name

it('首批20条无追加页脚，滚到底自动补行，全选覆盖尚未挂载行', async () => {
  const user = userEvent.setup()
  render(<DataTable rows={rows} columns={columns} getRowId={getRowId} getRowLabel={getRowLabel} />)
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(21)
  expect(screen.queryByRole('button', { name: /显示更多/ })).not.toBeInTheDocument()
  expect(screen.queryByText(/共 25 条/)).not.toBeInTheDocument()
  await user.click(screen.getByRole('checkbox', { name: '全选已加载的匹配行' }))
  expect(await screen.findByText('已选 25 项')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /^清除$/ }))
  await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus())
  await scrollTablesToEnd()
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(26)
})
it('稳定排序循环，空值始终在末尾，排序后Shift使用稳定身份', async () => {
  const user = userEvent.setup()
  render(<DataTable rows={rows.slice(0, 4)} columns={columns} getRowId={getRowId} getRowLabel={getRowLabel} />)
  await user.click(screen.getByRole('checkbox', { name: '选择 条目0' }))
  await user.click(screen.getByRole('button', { name: '数值' }))
  await user.keyboard('{Shift>}')
  await user.click(screen.getByRole('checkbox', { name: '选择 条目3' }))
  await user.keyboard('{/Shift}')
  expect(await screen.findByText('已选 2 项')).toBeInTheDocument()
  const header = screen.getByRole('columnheader', { name: '数值' })
  expect(header).toHaveAttribute('aria-sort', 'ascending')
  await user.click(within(header).getByRole('button'))
  expect(header).toHaveAttribute('aria-sort', 'descending')
  await user.click(within(header).getByRole('button'))
  expect(header).toHaveAttribute('aria-sort', 'none')
})
it('外部过滤不二次筛选，目标变化清除选择', async () => {
  const onSelectionChange = vi.fn()
  const { rerender } = render(<DataTable rows={rows} columns={columns} getRowId={getRowId} filterMode="external" query="服务端专用关键词" selected={['0']} onSelectionChange={onSelectionChange} selectionKey="a" />)
  expect(screen.getByText('条目0')).toBeInTheDocument()
  rerender(<DataTable rows={rows} columns={columns} getRowId={getRowId} filterMode="external" query="服务端专用关键词" selected={['0']} onSelectionChange={onSelectionChange} selectionKey="b" />)
  await waitFor(() => expect(onSelectionChange).toHaveBeenCalledWith([]))
})
it('文件勾选不激活，按键按显示顺序移动且输入法不打开', async () => {
  const activate = vi.fn()
  render(<DataTable rows={rows.slice(0, 3)} columns={columns} getRowId={getRowId} getRowLabel={getRowLabel} rowKeyboardNav onRowActivate={activate} />)
  const row = within(screen.getByRole('table')).getAllByRole('row')[1]!
  await userEvent.setup().click(screen.getByRole('checkbox', { name: '选择 条目0' }))
  expect(activate).not.toHaveBeenCalled()
  row.focus()
  fireEvent.keyDown(row, { key: 'ArrowDown' })
  expect(within(screen.getByRole('table')).getAllByRole('row')[2]).toHaveFocus()
  fireEvent.keyDown(row, { key: 'Enter', isComposing: true, keyCode: 229 })
  expect(activate).not.toHaveBeenCalled()
})

describe('表格使用窗口剩余高度', () => {
  const originalResizeObserver = globalThis.ResizeObserver
  const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
  let observers: { callback: ResizeObserverCallback; targets: Set<Element>; observer: ResizeObserver }[]
  beforeEach(() => {
    observers = []
    globalThis.ResizeObserver = class {
      record: (typeof observers)[number]
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: new Set(), observer: this as unknown as ResizeObserver }
        observers.push(this.record)
      }
      observe(target: Element) { this.record.targets.add(target) }
      unobserve(target: Element) { this.record.targets.delete(target) }
      disconnect() { this.record.targets.clear() }
    }
  })
  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
    if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport)
    else delete (window as { visualViewport?: VisualViewport }).visualViewport
    vi.restoreAllMocks()
  })
  const rect = (top: number, height: number) => new DOMRect(0, top, 960, height)
  const resizeElement = (element: Element) => act(() => {
    observers.filter(record => record.targets.has(element)).forEach(record => record.callback([], record.observer))
  })

  it('扣除主区留白后用满剩余高度，短表不撑高', async () => {
    render(<main style={{ paddingBottom: 24 }}><DataTable rows={rows} columns={columns} getRowId={getRowId} /></main>)
    const viewport = screen.getByRole('region', { name: '数据表格（可滚动）' })
    const main = viewport.closest('main')!
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue(rect(80, 660))
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(200, 300))
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(viewport).toHaveStyle({ maxHeight: '516px' }))
    expect(viewport.style.height).toBe('')
    expect(viewport.style.minHeight).toBe('')
  })

  it('响应可视窗口、祖先布局和外层滚动，离屏表保留可操作上限且不会向上无限增长', async () => {
    const visual = Object.assign(new EventTarget(), { offsetTop: 0, height: 700 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual })
    const { rerender } = render(<main style={{ paddingBottom: 24 }}><section><DataTable rows={rows.slice(0, 1)} columns={columns} getRowId={getRowId} /></section></main>)
    const viewport = screen.getByRole('region', { name: '数据表格（可滚动）' })
    const main = viewport.closest('main')!
    const section = viewport.closest('section')!
    const dimensions = { top: 200 }
    vi.spyOn(main, 'getBoundingClientRect').mockReturnValue(rect(80, 660))
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => rect(dimensions.top, 104))
    resizeElement(section)
    await waitFor(() => expect(viewport).toHaveStyle({ maxHeight: '476px' }))
    visual.height = 600
    visual.dispatchEvent(new Event('resize'))
    await waitFor(() => expect(viewport).toHaveStyle({ maxHeight: '376px' }))
    dimensions.top = 900
    fireEvent.scroll(main)
    await waitFor(() => expect(viewport).toHaveStyle({ maxHeight: '164px' }))
    rerender(<main style={{ paddingBottom: 24 }}><section><DataTable rows={rows.slice(0, 1)} columns={columns} getRowId={getRowId} density="compact" /></section></main>)
    expect(viewport).toHaveStyle({ maxHeight: '132px' })
    dimensions.top = -500
    fireEvent.scroll(main)
    await waitFor(() => expect(viewport).toHaveStyle({ maxHeight: '496px' }))
    expect(viewport.style.height).toBe('')
    expect(viewport.style.minHeight).toBe('')
  })

  it('显式弹窗高度保持不变，640px以下卡片交回页面滚动', async () => {
    render(<DataTable rows={rows} columns={columns} getRowId={getRowId} maxHeight={288} />)
    const viewport = screen.getByRole('region', { name: '数据表格（可滚动）' })
    const root = screen.getByRole('region', { name: '数据表格' })
    expect(viewport).toHaveStyle({ maxHeight: '288px' })
    fireEvent(window, new Event('resize'))
    expect(viewport).toHaveStyle({ maxHeight: '288px' })
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 500 })
    resizeElement(root)
    expect(screen.queryByRole('region', { name: '数据表格（可滚动）' })).not.toBeInTheDocument()
    expect(viewport.style.maxHeight).toBe('')
    expect(viewport).not.toHaveClass('overflow-auto')
  })
})

describe('批量执行', () => {
  it('删除行后仍执行下一项，首个失败停止并保留结果', async () => {
    const execute = vi.fn(async (batch: readonly Row[]) => batch[0]!.key === '1' ? { status: 'failed' as const, error: '拒绝' } : { status: 'succeeded' as const })
    function View() {
      const [data, setData] = useState(rows.slice(0, 3))
      const [selected, select] = useState<Id[]>(['0', '1', '2'])
      return <DataTable rows={data} columns={columns} getRowId={getRowId} selected={selected} onSelectionChange={select}
        bulkActions={ids => <TableBatchActions selectedRows={data.filter(row => ids.includes(row.key))} getRowId={getRowId} getRowLabel={getRowLabel} onSucceeded={ids => select(current => current.filter(id => !ids.includes(id)))} actions={[{ key: 'remove', label: '批量删除', execute: async batch => {
          const result = await execute(batch)
          if (result.status === 'succeeded') setData(current => current.filter(row => row.key !== batch[0]!.key))
          return result
        } }]} />} />
    }
    render(<View />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^批量删除$/ }))
    await user.click(screen.getByRole('button', { name: '确认批量删除' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('未执行'))
    expect(execute).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog')).toHaveTextContent('拒绝')
  })
  it('登录代次改变后不再派发后续项', async () => {
    let resolve: (value: { status: 'succeeded' }) => void = () => {}
    const execute = vi.fn(() => new Promise<{ status: 'succeeded' }>(done => { resolve = done }))
    render(<TableBatchActions selectedRows={rows.slice(0, 2)} getRowId={getRowId} getRowLabel={getRowLabel} onSucceeded={vi.fn()} actions={[{ key: 'run', label: '执行', execute }]} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^执行$/ }))
    await user.click(screen.getByRole('button', { name: '确认执行' }))
    act(() => { advanceAuthGeneration(); resolve({ status: 'succeeded' }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
