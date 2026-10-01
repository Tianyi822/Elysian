/*
 * 会话连接撤销表：sessionId → 该会话名下已建立长连接的 closer 集合。登出、改密
 * （pwdEpoch 轮换）、退出其他会话三条显式失效路径在销毁服务端会话的同时，主动关闭
 * 该会话名下已建立的终端 WS 连接——否则连接层存活到自然断开，撤销只对新请求生效。
 *
 * 生命周期收口：连接 onClose 时 unregister 自己。Map 条目是强引用（closer 捕获连接
 * 对象），靠 unregister 收口；连接异常死亡且 onClose 未触发时滞留的条目受终端并发
 * 上限（5 条/进程）约束，影响极小。撤销表是纯内存结构，装配期创建一次、app.ts 把
 * 同一实例穿给 auth 片（触发端点）与 terminals 片（登记 closer）。
 */

/** 会话撤销时 WS 关闭码：1008（Policy Violation），与终端协议违规关闭同码。 */
export const SESSION_REVOKED_CLOSE_CODE = 1008

/** 会话撤销关闭时的中文 reason。 */
export const SESSION_REVOKED_CLOSE_REASON = '面板会话已失效，连接已关闭'

export type SessionConnections = {
  /** 连接建立后登记 closer；同一会话可有多条连接，closer 以集合去重。 */
  register(sessionId: string, closer: () => void): void
  /** 连接关闭后注销 closer（幂等）；集合清空后连同键一起摘除。 */
  unregister(sessionId: string, closer: () => void): void
  /** 撤销单个会话：关闭该会话全部已登记连接并清空，可重入。 */
  revoke(sessionId: string): void
  /** 撤销除 keep 外的全部会话（退出其他会话）。 */
  revokeOthers(keepSessionId: string): void
  /** 撤销全部会话（改密：pwdEpoch 轮换让所有既有会话失效）。 */
  revokeAll(): void
}

export function createSessionConnections(): SessionConnections {
  const bySession = new Map<string, Set<() => void>>()

  /** 逐个调 closer：单个异常吞掉，不中断其余关闭（一个连接死透了不该拖累别的）。 */
  function closeAll(closers: Iterable<() => void>): void {
    for (const closer of closers) {
      try {
        closer()
      } catch {
        // closer 自身异常：该连接的清理由它自己的 onClose 路径兜底。
      }
    }
  }

  return {
    register(sessionId, closer) {
      let closers = bySession.get(sessionId)
      if (closers === undefined) {
        closers = new Set()
        bySession.set(sessionId, closers)
      }
      closers.add(closer)
    },
    unregister(sessionId, closer) {
      const closers = bySession.get(sessionId)
      if (closers === undefined) return
      closers.delete(closer)
      if (closers.size === 0) bySession.delete(sessionId)
    },
    revoke(sessionId) {
      const closers = bySession.get(sessionId)
      if (closers === undefined) return
      bySession.delete(sessionId)
      closeAll(closers)
    },
    revokeOthers(keepSessionId) {
      for (const [sessionId, closers] of bySession) {
        if (sessionId === keepSessionId) continue
        bySession.delete(sessionId)
        closeAll(closers)
      }
    },
    revokeAll() {
      const groups = [...bySession.values()]
      bySession.clear()
      for (const closers of groups) closeAll(closers)
    },
  }
}
