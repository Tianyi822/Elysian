import { beforeEach, describe, expect, it } from 'vitest'
import { PANEL_PENDING_KEY, readPanelPending, savePanelPending } from './panelPending'

beforeEach(() => sessionStorage.removeItem(PANEL_PENDING_KEY))
describe('维护待确认请求快照', () => {
  it.each([undefined, 'github', 'gitee'] as const)('保存并恢复精确更新目标及来源 %s，清理仅移除本记录', (source) => {
    const pending = { version: 1 as const, requestId: 'request-123', kind: 'update' as const, input: { channel: 'release' as const, ...(source ? { source } : {}), targetCommit: 'a'.repeat(40), releaseTag: 'v1.2.3' } }
    savePanelPending(pending)
    expect(readPanelPending()).toEqual(pending)
    sessionStorage.setItem('other', 'keep')
    savePanelPending(null)
    expect(readPanelPending()).toBeNull()
    expect(sessionStorage.getItem('other')).toBe('keep')
    sessionStorage.removeItem('other')
  })
  it.each([
    '{bad',
    { version: 2, requestId: 'request-123', kind: 'restart', input: null },
    { version: 1, requestId: 'invalid/id', kind: 'restart', input: null },
    { version: 1, requestId: 'request-123', kind: 'ports', input: { frontendPort: 1, backendPort: 1 } },
    { version: 1, requestId: 'request-123', kind: 'update', input: { channel: 'release', targetCommit: 'latest', releaseTag: '' } },
    { version: 1, requestId: 'request-123', kind: 'update', input: { channel: 'commit', source: 'unknown', targetCommit: 'a'.repeat(40), releaseTag: '' } },
  ])('拒绝损坏或不兼容的快照：%j', (value) => {
    sessionStorage.setItem(PANEL_PENDING_KEY, typeof value === 'string' ? value : JSON.stringify(value))
    expect(readPanelPending()).toBeNull()
  })
})
