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

  describe('hostname 通道（cgroup v2 私有命名空间下 cgroup 文本无 id 时的回落）', () => {
    const HOST_ID = '764ef645e55a5fdcbf6f8b01ce427d2fafa037bc85a40afd848384e8e850720c'

    it('cgroup 无 id 且 hostname 为 12 位十六进制时按前缀唯一命中完整 id', () => {
      expect(resolveSelfContainerId('0::/', [HOST_ID], '764ef645e55a')).toBe(HOST_ID)
    })

    it('hostname 前缀命中多个完整 id 时返回 null（宁可不保护，不保护错容器）', () => {
      const idA = '764ef645e55a' + 'a'.repeat(52)
      const idB = '764ef645e55a' + 'b'.repeat(52)
      expect(resolveSelfContainerId('0::/', [idA, idB], '764ef645e55a')).toBeNull()
    })

    it('hostname 非 12 位十六进制时不启用 hostname 通道', () => {
      expect(resolveSelfContainerId('0::/', [HOST_ID], 'elysian-web')).toBeNull()
      expect(resolveSelfContainerId('0::/', [HOST_ID], 'zz4ef645e55a')).toBeNull()
      expect(resolveSelfContainerId('0::/', [HOST_ID], '764ef645e55')).toBeNull()
    })

    it('hostname 前缀在容器表中无命中时返回 null', () => {
      expect(resolveSelfContainerId('0::/', ['a'.repeat(64)], '764ef645e55a')).toBeNull()
    })

    it('cgroup 通道命中时优先于 hostname 通道', () => {
      const cgroupId = 'c'.repeat(64)
      const hostId = '764ef645e55a' + 'd'.repeat(52)
      expect(
        resolveSelfContainerId(`0::/docker/${cgroupId}`, [cgroupId, hostId], '764ef645e55a'),
      ).toBe(cgroupId)
    })

    it('hostname 为 undefined 时保持原行为只走 cgroup 通道', () => {
      expect(resolveSelfContainerId('0::/', [HOST_ID])).toBeNull()
    })
  })
})
