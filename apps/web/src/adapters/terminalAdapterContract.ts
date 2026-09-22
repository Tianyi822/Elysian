import { describe, expect, it } from 'vitest'
import type {
  HostTerminalFrame,
  HostTerminalHandlers,
  TerminalAdapter,
} from '../contracts/adapters'

/**
 * 本机终端适配器的可复用断言集合（流式契约）：只依赖 TerminalAdapter 接口本身。
 * mock 与真实 WS 实现对同一套断言各跑一遍——这就是「mock 可替换」的验证方式。
 * 取值不断言具体身份（mock 答 ops、真实答 root），只锁「有输出」这类双实现共同的口径。
 */

/** 把会话的全部下行帧收进数组的 handlers。 */
export function collectFrames(frames: HostTerminalFrame[]): HostTerminalHandlers {
  return {
    onFrame: (_sessionId, frame) => {
      frames.push(frame)
    },
    onClose: () => {},
  }
}

export function runTerminalAdapterContract(make: () => TerminalAdapter): void {
  describe('TerminalAdapter 契约', () => {
    it('connect 返回非空身份：标识、用户、主机名与提示符', async () => {
      const adapter = make()
      const session = await adapter.connect(collectFrames([]))
      expect(session.id.length).toBeGreaterThan(0)
      expect(session.user.length).toBeGreaterThan(0)
      expect(session.hostLabel.length).toBeGreaterThan(0)
      expect(session.prompt.length).toBeGreaterThan(0)
    })

    it('两次 connect 得到不同会话标识', async () => {
      const adapter = make()
      const first = await adapter.connect(collectFrames([]))
      const second = await adapter.connect(collectFrames([]))
      expect(first.id).not.toBe(second.id)
    })

    it('sendInput 送 whoami 后收到含非空行的 output 帧', async () => {
      const adapter = make()
      const frames: HostTerminalFrame[] = []
      const session = await adapter.connect(collectFrames(frames))
      await adapter.sendInput(session.id, 'whoami')
      const output = frames.find((frame) => frame.type === 'output')
      expect(output).toBeDefined()
      expect(
        output !== undefined && output.type === 'output'
          ? output.lines.some((line) => line.length > 0)
          : false,
      ).toBe(true)
    })

    it('complete 返回形状合法的补全结果', async () => {
      const adapter = make()
      const session = await adapter.connect(collectFrames([]))
      const result = adapter.complete(session.id, 'who', 3)
      expect(typeof result.draft).toBe('string')
      expect(result.cursor).toBeGreaterThanOrEqual(0)
      expect(result.cursor).toBeLessThanOrEqual(result.draft.length)
      if (result.candidates) {
        expect(result.candidates.every((candidate) => typeof candidate === 'string')).toBe(true)
      }
    })

    it('interrupt 在会话存续时不抛错', async () => {
      const adapter = make()
      const session = await adapter.connect(collectFrames([]))
      await expect(adapter.interrupt(session.id)).resolves.toBeUndefined()
    })

    it('disconnect 后 sendInput 抛「终端会话不存在」', async () => {
      const adapter = make()
      const session = await adapter.connect(collectFrames([]))
      await adapter.disconnect(session.id)
      await expect(adapter.sendInput(session.id, 'whoami')).rejects.toThrow('终端会话不存在')
    })
  })
}
