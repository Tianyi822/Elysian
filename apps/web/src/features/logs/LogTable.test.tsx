import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LogTable } from './LogTable'

const rows = [{ id: 'a', text: '服务启动' }, { id: 'b', text: '请求完成' }]
const columns = [{ key: 'text', header: '日志信息', accessor: (row: typeof rows[number]) => row.text }]
describe('共享日志表格', () => {
  it('呈现原日志并提供排序与多选', async () => {
    const user = userEvent.setup()
    render(<LogTable label="测试日志表" rows={rows} columns={columns} rowKey={row => row.id} emptyMessage="没有记录" />)
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3)
    await user.click(screen.getByRole('checkbox', { name: '全选已加载的匹配行' }))
    expect(await screen.findByText('已选 2 项')).toBeInTheDocument()
  })
  it('受控搜索交回原调用方，不本地过滤服务端结果', async () => {
    const change = vi.fn()
    render(<LogTable label="测试日志表" rows={rows} columns={columns} rowKey={row => row.id} emptyMessage="没有记录" query="历史关键词" onQueryChange={change} />)
    expect(screen.getByText('服务启动')).toBeInTheDocument()
    await userEvent.setup().type(screen.getByRole('searchbox'), '字')
    expect(change).toHaveBeenCalledWith('历史关键词字')
  })
})
