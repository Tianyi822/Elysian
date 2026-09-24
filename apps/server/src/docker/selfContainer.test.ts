import { describe, expect, it } from 'vitest'
import { resolveSelfContainerId } from './selfContainer'

const FULL_ID =
  'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

describe('resolveSelfContainerId', () => {
  it('cgroup 中的 64 位 id 在列表中则返回该 id', () => {
    const cgroup = `0::/docker/${FULL_ID}`
    const ids = [FULL_ID, 'a'.repeat(64)]
    expect(resolveSelfContainerId(cgroup, ids)).toBe(FULL_ID)
  })

  it('大小写不一致时仍匹配列表中的 id', () => {
    const upper = FULL_ID.toUpperCase()
    const cgroup = `12:memory:/docker/${upper}`
    expect(resolveSelfContainerId(cgroup, [FULL_ID])).toBe(FULL_ID)
  })

  it('cgroup 中的 id 不在列表中则返回 null', () => {
    const cgroup = `0::/docker/${FULL_ID}`
    expect(resolveSelfContainerId(cgroup, ['b'.repeat(64)])).toBeNull()
  })

  it('短 id 不匹配', () => {
    const short = FULL_ID.slice(0, 12)
    const cgroup = `0::/docker/${short}`
    expect(resolveSelfContainerId(cgroup, [FULL_ID])).toBeNull()
    expect(resolveSelfContainerId(cgroup, [short])).toBeNull()
  })

  it('无 64 位十六进制时返回 null', () => {
    expect(resolveSelfContainerId('0::/system.slice', [FULL_ID])).toBeNull()
  })
})
