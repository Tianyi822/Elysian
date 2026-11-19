import type { PanelPasswordChangeInput, PanelUsernameChangeInput, SessionAdapter, SessionListRow, SessionStatus } from '../../contracts/adapters'
import { panelUsernameError } from '../../contracts/panelAccount'

const DEMO_PASSWORD_MIN_LENGTH = 8

export class MockSessionAdapter implements SessionAdapter {
  private rows: SessionListRow[]

  constructor() {
    const nowMs = Date.now()
    this.rows = [
      {
        createdAt: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
        lastUsedAt: new Date(nowMs).toISOString(),
        current: true,
      },
      {
        createdAt: new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString(),
        lastUsedAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
        current: false,
      },
    ]
  }

  async canView(): Promise<boolean> {
    return true
  }

  // 演示模式刻意忽略回跳参数（_returnTo 只声明不使用）且不回答 returnTo：本地无后端时不存在「把浏览器送回外部 origin」这件事。
  async status(_returnTo?: string): Promise<SessionStatus> {
    return { mode: 'demo', authenticated: true, devAccount: false, username: 'admin' }
  }

  async login(): Promise<void> {}

  async logout(): Promise<void> {}

  async listSessions(): Promise<readonly SessionListRow[]> {
    // 当前行在前（其 lastUsedAt 恒为最新），与服务端「按最近活跃倒序」同一呈现。
    return [...this.rows]
  }

  async changePassword(input: PanelPasswordChangeInput): Promise<void> {
    // 与服务端同一次序校验（先一致性、后长度）；校验通过即抛演示不支持。
    if (input.newPassword !== input.confirmNewPassword) throw new Error('两次输入的密码不一致')
    if (input.newPassword.length < DEMO_PASSWORD_MIN_LENGTH) throw new Error('密码至少需要 8 位')
    throw new Error('演示模式不支持修改面板密码')
  }

  async changeUsername(input: PanelUsernameChangeInput): Promise<void> {
    const error = panelUsernameError(input.newUsername, 'admin')
    if (error) throw new Error(error)
    throw new Error('演示模式不支持修改面板用户名')
  }

  async logoutOtherSessions(): Promise<void> {
    this.rows = this.rows.filter((row) => row.current)
  }
}

/** 文件目录的 mock 实现：读手工种子的目录树；列举与统计只读，四个变更动作只改内存数据。 */
