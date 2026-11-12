import { describe, expect, it } from 'vitest'
import type { HostTerminalFrame, HostTerminalHandlers, TerminalAdapter } from '../contracts/adapters'
export const collectFrames = (frames: HostTerminalFrame[]): HostTerminalHandlers => ({ onFrame: (_id, frame) => frames.push(frame), onClose: () => {} })
export function runTerminalAdapterContract(make: () => TerminalAdapter): void {
  describe('TerminalAdapter 会话契约', () => {
    it('分配独立身份并能关闭', async () => {
      const adapter = make()
      const first = await adapter.connect(collectFrames([]))
      const second = await adapter.connect(collectFrames([]))
      expect(first.id).not.toBe(second.id)
      expect(first.user).not.toBe('')
      expect(first.hostLabel).not.toBe('')
      await adapter.disconnect(first.id)
      await expect(adapter.sendInput(first.id, new TextEncoder().encode('whoami\r'))).rejects.toThrow('终端会话不存在')
      await adapter.disconnect(second.id)
    })
    it('按运行方式提供真实字节通道或确定性命令求值', async () => {
      const adapter = make()
      const session = await adapter.connect(collectFrames([]))
      if (adapter.mode === 'repl') {
        expect((await adapter.executeCommand!(session.id, 'whoami')).lines.length).toBeGreaterThan(0)
        expect(adapter.completions!(session.id, '')).toContain('whoami')
      } else {
        await adapter.resize(session.id, 90, 25)
        await adapter.sendInput(session.id, Uint8Array.of(3))
      }
      await adapter.disconnect(session.id)
    })
  })
}
