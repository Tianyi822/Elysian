import { afterEach, describe, expect, it } from 'vitest'
import { notifyFirewallPortSync } from './firewallPortNotice'
import { useNotificationStore } from './notificationStore'

afterEach(() => {
  useNotificationStore.getState().clear()
})

describe('防火墙端口开放结果通知', () => {
  it('opened 发成功提示、failed 发 danger 并指路安全页、skipped 与 null 不打扰', () => {
    notifyFirewallPortSync({ state: 'opened', port: 8080, detail: null })
    notifyFirewallPortSync({ state: 'skipped', port: 8080, detail: '防火墙已有该端口的放行规则' })
    notifyFirewallPortSync(null)
    notifyFirewallPortSync({ state: 'failed', port: 18080, detail: '端口规则已达上限（最多 200 条）' })

    const messages = useNotificationStore.getState().notifications.map((item) => `${item.tone}:${item.message}`)
    expect(messages).toEqual([
      'success:防火墙端口 8080 已开放',
      'danger:防火墙端口 18080 未能开放：端口规则已达上限（最多 200 条）。项目已创建，请到安全页手动开放端口',
    ])
  })
})
