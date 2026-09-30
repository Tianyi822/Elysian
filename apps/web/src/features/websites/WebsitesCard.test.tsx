import { render, screen } from '@testing-library/react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { WebsiteProject } from '@elysian/contracts'
import { WebsitesCard } from './WebsitesCard'

const project: WebsiteProject = { id: 'p', kind: 'html', name: 'docs', pid: 321, containerId: 'a'.repeat(64),
  port: 8088, runtimeVersion: null, rootDir: '/srv/wwwroot/docs', runState: 'running', accessMode: 'direct',
  domain: null, routeApplied: false, certificate: null, expiryAt: null, note: null, category: 'development',
  deployCommand: 'nginx -g daemon off;', gitUrl: null, traffic: { todayMb: 0, totalGb: 0 } }

describe('网站卡片', () => {
  it('HTML 容器展示运行状态、端口与 PID', () => {
    render(<Tooltip.Provider><MemoryRouter><WebsitesCard project={project} busy={false} onOpenDetail={vi.fn()} onToggleRunning={vi.fn()} onOpenSettings={vi.fn()} onOpenRemove={vi.fn()} /></MemoryRouter></Tooltip.Provider>)
    expect(screen.getByRole('article', { name: 'docs' })).toBeInTheDocument()
    expect(screen.getByText('321')).toBeInTheDocument()
    expect(screen.getByText('8088')).toBeInTheDocument()
    expect(screen.getByText('运行中')).toBeInTheDocument()
  })
})
