import * as Tooltip from '@radix-ui/react-tooltip'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import type { WebsiteProject } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { useWebsitesStore } from '../../stores/websitesStore'
import { WebsiteDetailSheet } from './WebsiteDetailSheet'

/*
 * 详情抽屉测试：不经过路由页面，直接把 detailTarget 与日志灌进 store 后
 * 单独渲染组件。Link 需要路由上下文，用 MemoryRouter 兜住；
 * 刷新日志按钮调用的 gateway 用确定性 mock（一分钟一拍，无事件插入）。
 */

const javaRunning: WebsiteProject = {
  id: 'website-java-order-api',
  kind: 'java',
  name: '订单中心-api',
  pid: 23180,
  port: 8080,
  runtimeVersion: null,
  rootDir: '/www/wwwroot/order-api',
  runState: 'running',
  expiryAt: '2026-12-20',
  note: '商城核心下单链路',
  cert: 'deployed',
  category: 'production',
  deployCommand: 'java -jar order-api.jar --server.port=8080',
  traffic: { todayMb: 864, totalGb: 218.4 },
}

const javaStopped: WebsiteProject = {
  ...javaRunning,
  id: 'website-java-notify-job',
  name: '消息推送-job',
  pid: null,
  runState: 'stopped',
}

const nodeProject: WebsiteProject = {
  id: 'website-node-marketing',
  kind: 'node',
  name: 'marketing-site',
  pid: 18422,
  port: 3000,
  runtimeVersion: '20.11.1',
  rootDir: '/www/wwwroot/marketing-site',
  runState: 'running',
  expiryAt: '2027-03-15',
  note: '官网与落地页',
  cert: 'expired',
  category: 'production',
  deployCommand: 'node dist/main.js',
  traffic: { todayMb: 731, totalGb: 164.9 },
}

const goProject: WebsiteProject = {
  id: 'website-go-log-collector',
  kind: 'go',
  name: 'log-collector',
  pid: null,
  port: null,
  runtimeVersion: null,
  rootDir: '/www/wwwroot/log-collector',
  runState: 'running',
  expiryAt: null,
  note: '日志采集 Agent',
  cert: 'deployed',
  category: 'production',
  deployCommand: './log-collector --config /etc/log-collector.yaml',
  traffic: { todayMb: 1284, totalGb: 402.6 },
}

const htmlProject: WebsiteProject = {
  id: 'website-html-portal',
  kind: 'html',
  name: 'company-portal',
  pid: null,
  port: null,
  runtimeVersion: null,
  rootDir: '/www/wwwroot/company-portal',
  runState: 'running',
  expiryAt: '2027-06-30',
  note: null,
  cert: 'none',
  category: 'production',
  deployCommand: null,
  traffic: { todayMb: 264, totalGb: 58.2 },
}

/** 直接打开详情：绕过面板点击，只灌抽屉消费的三个状态字段。 */
function openDetail(project: WebsiteProject, logs: readonly string[] = []): void {
  useWebsitesStore.setState({ detailTarget: project, detailLogs: logs, detailLogsLoading: false })
}

function renderSheet() {
  return render(
    <Tooltip.Provider delayDuration={0}>
      <GatewayProvider gateway={createMockGateway({ eventStream: 'memory', eventIntervalMs: 60_000 })}>
        <MemoryRouter initialEntries={['/websites']}>
          <WebsiteDetailSheet />
        </MemoryRouter>
      </GatewayProvider>
    </Tooltip.Provider>,
  )
}

beforeEach(() => {
  useWebsitesStore.setState({ detailTarget: undefined, detailLogs: undefined, detailLogsLoading: false })
})

describe('网站详情抽屉', () => {
  it('detailTarget 为 undefined 时不渲染任何内容', () => {
    const { container } = renderSheet()
    expect(container.innerHTML).toBe('')
  })

  it('头部呈现名称、运行状态、类型与分类标签和演示徽标', () => {
    openDetail(javaRunning)
    renderSheet()
    expect(screen.getByText('订单中心-api')).toBeInTheDocument()
    // 运行状态、类型与分类在头部标签与基本信息行各出现一次。
    expect(screen.getAllByText('运行中').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Java项目').length).toBeGreaterThan(0)
    expect(screen.getAllByText('生产环境').length).toBeGreaterThan(0)
    expect(screen.getByText('演示 · 待接入真实执行')).toBeInTheDocument()
  })

  it('java 项目基本信息完整：PID 与端口有值、到期时间格式化、根目录是文件页链接', () => {
    openDetail(javaRunning)
    renderSheet()
    expect(screen.getByText('23180')).toBeInTheDocument()
    expect(screen.getByText('8080')).toBeInTheDocument()
    expect(screen.getByText('2026-12-20')).toBeInTheDocument()
    expect(screen.getByText('商城核心下单链路')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: '/www/wwwroot/order-api' })
    expect(link.getAttribute('href')).toBe('/files/www/wwwroot/order-api')
    expect(screen.queryByText('Node版本')).not.toBeInTheDocument()
  })

  it('已停止项目 PID 显示 —；html 项目没有 PID 与端口行，部署命令区显示 Nginx 托管说明', () => {
    openDetail(javaStopped)
    const stopped = renderSheet()
    expect(screen.getByText('—')).toBeInTheDocument()
    stopped.unmount()

    openDetail(htmlProject)
    renderSheet()
    expect(screen.queryByText('PID')).not.toBeInTheDocument()
    expect(screen.queryByText('端口')).not.toBeInTheDocument()
    expect(screen.getByText('静态站点由 Nginx 直接托管，无部署命令')).toBeInTheDocument()
  })

  it('go 项目到期时间显示长期有效', () => {
    openDetail(goProject)
    renderSheet()
    expect(screen.getByText('长期有效')).toBeInTheDocument()
  })

  it('证书三态呈现对应文案', () => {
    const cases = [
      { project: javaRunning, label: '已部署' },
      { project: nodeProject, label: '已过期' },
      { project: htmlProject, label: '未部署' },
    ] as const
    for (const item of cases) {
      openDetail(item.project)
      const view = renderSheet()
      expect(screen.getByText(item.label)).toBeInTheDocument()
      view.unmount()
    }
  })

  it('node 项目呈现 Node版本行', () => {
    openDetail(nodeProject)
    renderSheet()
    expect(screen.getByText('Node版本')).toBeInTheDocument()
    expect(screen.getByText('20.11.1')).toBeInTheDocument()
  })

  it('部署命令展示原文且复制按钮存在', () => {
    openDetail(javaRunning)
    renderSheet()
    expect(screen.getByText('java -jar order-api.jar --server.port=8080')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '部署命令' })).toBeInTheDocument()
  })

  it('今日流量低于 1024 MB 按 MB 展示', () => {
    openDetail(javaRunning)
    renderSheet()
    expect(screen.getByText('864 MB')).toBeInTheDocument()
    expect(screen.getByText('218.4 GB')).toBeInTheDocument()
  })

  it('今日流量满 1024 MB 换算为 GB 保留一位小数', () => {
    openDetail(goProject)
    renderSheet()
    expect(screen.getByText('1.3 GB')).toBeInTheDocument()
    expect(screen.getByText('402.6 GB')).toBeInTheDocument()
  })

  it('运行日志逐行渲染', () => {
    openDetail(javaRunning, ['[订单中心-api] 启动完成', 'GET /health 200'])
    renderSheet()
    expect(screen.getByText('[订单中心-api] 启动完成')).toBeInTheDocument()
    expect(screen.getByText('GET /health 200')).toBeInTheDocument()
  })

  it('加载中显示加载文案', () => {
    useWebsitesStore.setState({ detailTarget: javaRunning, detailLogs: undefined, detailLogsLoading: true })
    renderSheet()
    expect(screen.getByRole('status')).toHaveTextContent('正在加载运行日志…')
  })

  it('日志为空数组时显示暂无日志', () => {
    openDetail(javaRunning, [])
    renderSheet()
    expect(screen.getByText('暂无日志')).toBeInTheDocument()
  })

  it('点击关闭按钮后 detailTarget 清空', async () => {
    const user = userEvent.setup()
    openDetail(javaRunning, ['[订单中心-api] 启动完成'])
    renderSheet()
    await user.click(screen.getByRole('button', { name: '关闭抽屉' }))
    expect(useWebsitesStore.getState().detailTarget).toBeUndefined()
  })

  it('点击刷新日志后重载完成、loading 回落', async () => {
    const user = userEvent.setup()
    openDetail(javaRunning, ['旧日志'])
    renderSheet()
    await user.click(screen.getByRole('button', { name: '刷新日志' }))
    await waitFor(() => {
      const state = useWebsitesStore.getState()
      expect(Array.isArray(state.detailLogs)).toBe(true)
      expect(state.detailLogsLoading).toBe(false)
    })
  })
})
