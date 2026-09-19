import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRuleTimesStore, type FirewallRuleTimes } from './ruleTimesStore.ts'

let store: FirewallRuleTimes | undefined

afterEach(() => {
  store?.close()
  store = undefined
})

describe('ruleTimesStore', () => {
  it('set 后 get 返回时间，remove 后消失', () => {
    store = openRuleTimesStore(':memory:')
    store.set('ufw-allow-in-tcp-22-any', '2026-09-19T08:00:00.000Z')
    expect(store.get('ufw-allow-in-tcp-22-any')).toBe('2026-09-19T08:00:00.000Z')
    expect(store.get('unknown')).toBeUndefined()

    store.remove('ufw-allow-in-tcp-22-any')
    expect(store.get('ufw-allow-in-tcp-22-any')).toBeUndefined()
  })

  it('重复 set 覆盖为最新时间', () => {
    store = openRuleTimesStore(':memory:')
    store.set('ufwip-deny-from-203.0.113.9', '2026-09-19T08:00:00.000Z')
    store.set('ufwip-deny-from-203.0.113.9', '2026-09-19T09:30:00.000Z')
    expect(store.get('ufwip-deny-from-203.0.113.9')).toBe('2026-09-19T09:30:00.000Z')
  })

  it('重新打开文件库后数据仍在（持久性）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elysian-fw-'))
    const path = join(dir, 'firewall.sqlite')
    try {
      store = openRuleTimesStore(path)
      store.set('fwd-tcp-8080-10.0.0.5-80', '2026-09-19T08:00:00.000Z')
      store.close()
      store = undefined

      store = openRuleTimesStore(path)
      expect(store.get('fwd-tcp-8080-10.0.0.5-80')).toBe('2026-09-19T08:00:00.000Z')
    } finally {
      store?.close()
      store = undefined
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
