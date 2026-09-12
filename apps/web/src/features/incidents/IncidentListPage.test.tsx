import { responsibilityModuleName } from '@elysian/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createMockDataset, toIncidentListRows } from '../../adapters/mock/dataset'
import { renderApp } from '../../test/renderApp'

/*
 * 事件中心的测试全部走适配接缝：页面用真实 mock 网关渲染，断言的是用户看得见的表格内容、
 * 地址变化与状态，不断言组件内部结构。
 */

const dataset = createMockDataset()
const allRows = toIncidentListRows(dataset)

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole('table', { name: '事件列表' })
  // 去掉表头行，只留下数据行。
  return within(table).getAllByRole('row').slice(1)
}

async function renderList(path = '/incidents') {
  const view = renderApp(path)
  await screen.findByRole('table', { name: '事件列表' })
  return view
}

describe('事件中心', () => {
  it('渲染事故、告警与待处理任务的合并列表', async () => {
    await renderList()
    expect(bodyRows()).toHaveLength(allRows.length)
    expect(screen.getByText(`共 ${allRows.length} 条`)).toBeInTheDocument()
  })

  it('按严重等级筛选后只剩该等级，并把筛选写进地址', async () => {
    const user = userEvent.setup()
    const { router } = await renderList()

    await user.click(screen.getByRole('checkbox', { name: '致命' }))

    const expected = allRows.filter((row) => row.severity === 'sev1').length
    await waitFor(() => expect(bodyRows()).toHaveLength(expected))
    expect(router.state.location.search).toContain('severity=sev1')
  })

  it('状态筛选会排除没有状态的告警与待处理任务', async () => {
    const user = userEvent.setup()
    await renderList()

    await user.click(screen.getByRole('checkbox', { name: '已恢复' }))

    const expected = allRows.filter((row) => row.status === 'resolved').length
    expect(expected).toBeGreaterThan(0)
    expect(expected).toBeLessThan(allRows.length)
    await waitFor(() => expect(bodyRows()).toHaveLength(expected))
  })

  it('多个筛选条件叠加时按交集过滤', async () => {
    const user = userEvent.setup()
    await renderList()

    await user.click(screen.getByRole('checkbox', { name: '严重' }))
    await user.click(screen.getByRole('checkbox', { name: '分析中' }))

    const expected = allRows.filter(
      (row) => row.severity === 'sev2' && row.status === 'analyzing',
    ).length
    await waitFor(() => expect(bodyRows()).toHaveLength(expected))
  })

  it('按严重等级排序时最严重的一条排在最前', async () => {
    await renderList('/incidents?sort=severity')
    const firstRow = bodyRows()[0]
    expect(firstRow).toBeDefined()
    expect(within(firstRow as HTMLElement).getByText('致命')).toBeInTheDocument()
  })

  it('筛选没有命中时说明是筛选导致的空，而不是数据为空', async () => {
    renderApp('/incidents?source=不存在的来源')
    expect(await screen.findByText('当前筛选条件下没有事件')).toBeInTheDocument()
    expect(screen.getByText(/筛选条件排除了全部条目/)).toBeInTheDocument()
  })

  it('清除筛选后回到完整列表', async () => {
    const user = userEvent.setup()
    await renderList('/incidents?severity=sev1')

    await user.click(screen.getByRole('button', { name: '清除筛选' }))

    await waitFor(() => expect(bodyRows()).toHaveLength(allRows.length))
  })

  it('地址里的筛选条件在打开时就已经生效', async () => {
    await renderList('/incidents?severity=sev1,sev2')
    const expected = allRows.filter((row) => row.severity === 'sev1' || row.severity === 'sev2')
      .length
    expect(bodyRows()).toHaveLength(expected)
    expect(screen.getByRole('checkbox', { name: '致命' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '严重' })).toBeChecked()
  })

  it('事故行可以进入事故详情', async () => {
    const user = userEvent.setup()
    await renderList()

    const incident = dataset.incidents[0]
    expect(incident).toBeDefined()
    const link = screen
      .getAllByRole('link')
      .find((candidate) => candidate.getAttribute('href') === `/incidents/${incident?.id}`)
    expect(link).toBeDefined()

    await user.click(link as HTMLElement)
    expect(
      await screen.findByRole('heading', { level: 1, name: new RegExp(incident?.id ?? '') }),
    ).toBeInTheDocument()
  })

  it('告警与待处理任务不以链接形式出现，避免点进不存在的详情', async () => {
    await renderList()
    const table = screen.getByRole('table', { name: '事件列表' })
    const hrefs = within(table)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href') ?? '')
    expect(hrefs.length).toBeGreaterThan(0)
    expect(hrefs.every((href) => href.startsWith('/incidents/INC-'))).toBe(true)
  })

  it('展示当前 Agent 的职责模块名称，而不是模块标识', async () => {
    await renderList()
    const withRun = allRows.find((row) => row.moduleId)
    expect(withRun).toBeDefined()

    const moduleLabel = responsibilityModuleName(withRun?.moduleId ?? '')
    const table = screen.getByRole('table', { name: '事件列表' })
    expect(within(table).getAllByText(moduleLabel).length).toBeGreaterThan(0)
    // 模块标识本身不应出现在表格里
    expect(screen.queryByText('incident-command')).not.toBeInTheDocument()
  })
})
