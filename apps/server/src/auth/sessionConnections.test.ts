import { describe, expect, it, vi } from 'vitest'
import { SESSION_REVOKED_CLOSE_CODE, SESSION_REVOKED_CLOSE_REASON, createSessionConnections } from './sessionConnections.ts'

/*
 * 会话连接撤销表的单测：登记/注销/撤销的内存语义——revoke 系列逐个调 closer 且清空
 * 可重入、单个 closer 抛错不中断其余、对未登记 id 幂等。closer 的关闭码与文案由
 * 调用方（终端连接胶水）负责，这里只钉撤销表本身的行为。
 */

describe('createSessionConnections', () => {
  it('登记后 revoke 关闭全部 closer 且清空可重入', () => {
    const connections = createSessionConnections()
    const first = vi.fn()
    const second = vi.fn()
    connections.register('s1', first)
    connections.register('s1', second)

    connections.revoke('s1')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    // 清空可重入：再次 revoke 不重复关闭。
    connections.revoke('s1')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('unregister 后 revoke 不再关闭该 closer；同会话其余 closer 照常关闭', () => {
    const connections = createSessionConnections()
    const gone = vi.fn()
    const stays = vi.fn()
    connections.register('s1', gone)
    connections.register('s1', stays)
    connections.unregister('s1', gone)

    connections.revoke('s1')
    expect(gone).not.toHaveBeenCalled()
    expect(stays).toHaveBeenCalledTimes(1)
  })

  it('revokeOthers 只关闭非 keep 会话', () => {
    const connections = createSessionConnections()
    const keepA = vi.fn()
    const dropB = vi.fn()
    const dropC = vi.fn()
    connections.register('a', keepA)
    connections.register('b', dropB)
    connections.register('c', dropC)

    connections.revokeOthers('a')
    expect(keepA).not.toHaveBeenCalled()
    expect(dropB).toHaveBeenCalledTimes(1)
    expect(dropC).toHaveBeenCalledTimes(1)
  })

  it('revokeAll 关闭全部会话的全部 closer', () => {
    const connections = createSessionConnections()
    const first = vi.fn()
    const second = vi.fn()
    connections.register('s1', first)
    connections.register('s2', second)

    connections.revokeAll()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    connections.revokeAll()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('单个 closer 抛错不中断其余关闭', () => {
    const connections = createSessionConnections()
    const broken = vi.fn(() => {
      throw new Error('连接已死')
    })
    const healthy = vi.fn()
    connections.register('s1', broken)
    connections.register('s1', healthy)

    expect(() => connections.revoke('s1')).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
  })

  it('对未登记 sessionId 幂等不抛', () => {
    const connections = createSessionConnections()
    expect(() => connections.revoke('nope')).not.toThrow()
    expect(() => connections.revokeOthers('nope')).not.toThrow()
    expect(() => connections.unregister('nope', () => {})).not.toThrow()
  })

  it('撤销关闭口径常量：1008 + 中文 reason（与终端协议违规关闭同码）', () => {
    expect(SESSION_REVOKED_CLOSE_CODE).toBe(1008)
    expect(SESSION_REVOKED_CLOSE_REASON).toBe('面板会话已失效，连接已关闭')
  })
})
