import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import { renderApp } from '../../test/renderApp'
import { SETTINGS_TABS } from './settingsTabs'

describe('执行与授权改为运行时选择', () => {
  it('设置导航不再提供预建执行配置或资源授权', () => {
    expect(SETTINGS_TABS.map(item => item.value)).not.toContain('execution')
    expect(SETTINGS_TABS.map(item => item.value)).not.toContain('grants')
  })

  it.each(['execution', 'grants'])('旧 %s 链接转向聊天', async tab => {
    const gateway = createMockGateway({ eventStream: 'memory', eventIntervalMs: 60000 })
    const { router } = renderApp(`/settings?tab=${tab}`, { gateway })
    await waitFor(() => expect(router.state.location.pathname).toBe('/agent'))
    expect(screen.queryByRole('button', { name: '新建执行配置' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建资源授权' })).not.toBeInTheDocument()
  })
})
