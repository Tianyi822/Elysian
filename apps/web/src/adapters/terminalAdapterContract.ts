import { describe, expect, it } from 'vitest'
import type { TerminalAdapter } from '../contracts/adapters'

/**
 * 本机终端适配器的可复用断言集合：只依赖 TerminalAdapter 接口本身。
 * 本期对 mock 实现运行，未来接入真实 PTY 时对同一套断言再跑一次。
 */
export function runTerminalAdapterContract(make: () => TerminalAdapter): void {
  describe('TerminalAdapter 契约', () => {
    it('connect 返回本机会话：用户 ops、主机名与提示符一致，标识非空', async () => {
      const adapter = make()
      const session = await adapter.connect()
      expect(session.id.length).toBeGreaterThan(0)
      expect(session.user).toBe('ops')
      expect(session.hostLabel).toBe('elysian-demo')
      expect(session.prompt).toBe('ops@elysian-demo:~$ ')
    })

    it('两次 connect 得到不同会话标识', async () => {
      const adapter = make()
      const first = await adapter.connect()
      const second = await adapter.connect()
      expect(first.id).not.toBe(second.id)
    })

    it('execMockCommand 的 help 返回可用命令说明', async () => {
      const adapter = make()
      const session = await adapter.connect()
      const result = await adapter.execMockCommand(session.id, 'help')
      expect(result.lines.join(' ')).toContain('可用命令')
    })

    it('未知命令给出中文说明', async () => {
      const adapter = make()
      const session = await adapter.connect()
      const result = await adapter.execMockCommand(session.id, 'rm -rf /')
      expect(result.lines[0]).toContain('演示终端')
    })

    it('断开后再 exec 失败', async () => {
      const adapter = make()
      const session = await adapter.connect()
      await adapter.disconnect(session.id)
      await expect(adapter.execMockCommand(session.id, 'whoami')).rejects.toThrow()
    })
  })
}
