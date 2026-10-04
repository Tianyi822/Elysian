import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import {
  createResourceMetrics,
  RESOURCE_METRIC_LABELS,
  RESOURCE_METRIC_UNITS,
} from '../../adapters/mock/resourceMetrics'
import type { ResourceMetricKey } from '../../adapters/mock/resourceMetrics'
import type { ElysianGateway } from '../../contracts/adapters'
import { useDashboardStore } from '../../stores/dashboardStore'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { renderApp } from '../../test/renderApp'
import { formatResourceMetricValue } from './formatMetricDisplay'

const METRIC_KEYS: ResourceMetricKey[] = ['cpu', 'memory', 'networkIo', 'diskIo']

beforeEach(() => {
  useDashboardStore.setState({
    status: 'idle',
    refreshing: false,
    range: '5m',
    resources: undefined,
    errorMessage: undefined,
  })
  useEventStreamStore.getState().disconnect()
  useEventStreamStore.setState({ status: 'connecting', recent: [], receivedCount: 0 })
  vi.restoreAllMocks()
})

async function renderReady() {
  renderApp('/')
  await screen.findByLabelText('服务器状态')
}

describe('仪表盘布局', () => {
  it('只保留服务器状态与时间筛选，不再展示事故指标、模块拆分与最近活动', async () => {
    await renderReady()

    expect(screen.getByLabelText('服务器状态')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '时间范围' })).toBeInTheDocument()

    expect(screen.queryByLabelText('关键指标')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('按职责模块拆分')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('最近活动')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('运行概览')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('事故总数指标卡')).not.toBeInTheDocument()
  })

  it('非 Docker 时在筛选栏标明演示数据', async () => {
    await renderReady()
    const filterBar = screen.getByLabelText('筛选栏')
    expect(within(filterBar).getByRole('status')).toHaveTextContent('演示数据')
  })

  it('加载失败给出错误态与重试，重试成功后服务器状态出现', async () => {
    const user = userEvent.setup()
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    let calls = 0
    const gateway: ElysianGateway = {
      ...base,
      resources: {
        list: async (range) => {
          calls += 1
          if (calls === 1) throw new Error('演示用的读取失败')
          return base.resources.list(range)
        },
      },
    }

    renderApp('/', { gateway })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('演示用的读取失败')

    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByLabelText('服务器状态')).toBeInTheDocument()
  })
})

describe('仪表盘筛选栏', () => {
  it('时间范围可切换，默认近 5 分钟', async () => {
    const user = userEvent.setup()
    await renderReady()

    const group = screen.getByRole('group', { name: '时间范围' })
    expect(within(group).getByRole('button', { name: '近 5 分钟' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.queryByText(/粒度/)).not.toBeInTheDocument()
    expect(within(group).queryByRole('button', { name: '近 10 分钟' })).not.toBeInTheDocument()
    expect(within(group).queryByRole('button', { name: '近 10 小时' })).not.toBeInTheDocument()

    await user.click(within(group).getByRole('button', { name: '近 7 天' }))

    expect(within(group).getByRole('button', { name: '近 7 天' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(group).getByRole('button', { name: '近 5 分钟' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.queryByRole('button', { name: '复位' })).not.toBeInTheDocument()
  })

  it('刷新期间有反馈且保留内容；刷新失败保留内容并出错误横幅', async () => {
    const user = userEvent.setup()
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    let calls = 0
    const gateway: ElysianGateway = {
      ...base,
      resources: {
        list: async (range) => {
          calls += 1
          if (calls > 1) throw new Error('演示用的刷新失败')
          return base.resources.list(range)
        },
      },
    }

    renderApp('/', { gateway })
    await screen.findByLabelText('服务器状态')

    await user.click(screen.getByRole('button', { name: '刷新' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('演示用的刷新失败')
    expect(screen.getByLabelText('服务器状态')).toBeInTheDocument()
    expect(screen.queryByText('正在刷新…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
  })
})

describe('仪表盘快捷操作', () => {
  it('主题切换动作生效，主题变化本身即反馈，不再发通知', async () => {
    const user = userEvent.setup()
    await renderReady()

    expect(document.documentElement.dataset['theme']).toBe('dark')
    await user.click(screen.getByRole('button', { name: /切换到浅色主题/ }))

    expect(document.documentElement.dataset['theme']).toBe('light')
    expect(screen.queryByLabelText('通知')).not.toBeInTheDocument()
  })
})

describe('仪表盘资源监控', () => {
  const latest = createResourceMetrics()[createResourceMetrics().length - 1]!

  it('四张读数卡取最后一个采样并带单位，下方四张趋势卡沿用同序数据', async () => {
    await renderReady()

    const section = screen.getByLabelText('服务器状态')
    expect(within(section).queryByRole('heading', { name: '服务器状态' })).not.toBeInTheDocument()

    for (const key of METRIC_KEYS) {
      const card = within(section).getByRole('article', { name: RESOURCE_METRIC_LABELS[key] })
      expect(screen.getByLabelText('当前资源读数')).toContainElement(card)
      expect(screen.getByLabelText('资源趋势')).toContainElement(
        within(section).getByRole('article', { name: `${RESOURCE_METRIC_LABELS[key]}趋势` }),
      )
      const unit = RESOURCE_METRIC_UNITS[key]
      expect(
        within(card).getByText(formatResourceMetricValue(latest[key], unit)),
      ).toBeInTheDocument()
    }

    await waitFor(() => {
      expect(section.querySelectorAll('svg').length).toBeGreaterThanOrEqual(4)
    })
  })

  it('占用率 ≥80% 的当前值标警告色，其余用正文色；IO 吞吐不着色', async () => {
    await renderReady()

    const section = screen.getByLabelText('服务器状态')
    for (const key of ['cpu', 'memory'] as const) {
      const card = within(section).getByRole('article', { name: RESOURCE_METRIC_LABELS[key] })
      const value = within(card).getByText(`${latest[key]}%`)
      if (latest[key] >= 80) {
        expect(value).toHaveClass('text-warning')
      } else {
        expect(value).toHaveClass('text-fg')
      }
    }
    for (const key of ['networkIo', 'diskIo'] as const) {
      const card = within(section).getByRole('article', { name: RESOURCE_METRIC_LABELS[key] })
      const value = within(card).getByText(formatResourceMetricValue(latest[key], 'MB/s'))
      expect(value).toHaveClass('text-fg')
    }
  })

  it('服务器状态有四张读数卡与四张趋势卡，不增加新的资源指标', async () => {
    await renderReady()
    const section = screen.getByLabelText('服务器状态')
    expect(within(section).queryByRole('article', { name: '运行负载' })).not.toBeInTheDocument()
    expect(within(section).queryByRole('article', { name: '磁盘占用' })).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('当前资源读数')).getAllByRole('article')).toHaveLength(4)
    expect(within(screen.getByLabelText('资源趋势')).getAllByRole('article')).toHaveLength(4)
  })

  it('新增采样后当前读数立即更新，不保留拆分前的旧值', async () => {
    await renderReady()
    const resources = useDashboardStore.getState().resources!
    act(() => {
      useDashboardStore.setState({ resources: [...resources, { ...resources.at(-1)!, ts: resources.at(-1)!.ts + 3000, cpu: 87, memory: 91 }] })
    })
    const summary = screen.getByLabelText('当前资源读数')
    expect(within(summary).getByText('87%')).toHaveClass('text-warning')
    expect(within(summary).getByText('91%')).toHaveClass('text-warning')
  })
})

describe('仪表盘空态', () => {
  it('资源序列为空时给出空态而不是空白图区', async () => {
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    const gateway: ElysianGateway = {
      ...base,
      resources: {
        list: async () => [],
      },
    }

    renderApp('/', { gateway })

    expect(await screen.findByText('演示数据集为空')).toBeInTheDocument()
    expect(screen.queryByLabelText('服务器状态')).not.toBeInTheDocument()
  })
})
