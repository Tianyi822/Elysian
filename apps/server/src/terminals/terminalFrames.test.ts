import { describe, expect, it } from 'vitest'
import {
  TERMINAL_FRAME_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  parseTerminalClientFrame,
} from './terminalFrames.ts'

/*
 * 客户端帧解析的合法/违规矩阵：白名单三类、大小上限、data 形状（字符串/换行/超长）、
 * 二进制帧路径与中文 reason 逐字断言。协议口径见方案「端点契约」的违规总口径。
 */

describe('parseTerminalClientFrame', () => {
  describe('合法帧', () => {
    it('input 帧原样取出 data', () => {
      expect(parseTerminalClientFrame('{"type":"input","data":"echo 你好"}')).toEqual({
        ok: true,
        frame: { type: 'input', data: 'echo 你好' },
      })
    })

    it('input 允许空字符串（空命令行）', () => {
      expect(parseTerminalClientFrame('{"type":"input","data":""}')).toEqual({
        ok: true,
        frame: { type: 'input', data: '' },
      })
    })

    it('input 可携带额外字段（白名单只管已知键）', () => {
      expect(parseTerminalClientFrame('{"type":"input","data":"ls","extra":1}')).toEqual({
        ok: true,
        frame: { type: 'input', data: 'ls' },
      })
    })

    it('interrupt 与 ping 帧通过', () => {
      expect(parseTerminalClientFrame('{"type":"interrupt"}')).toEqual({
        ok: true,
        frame: { type: 'interrupt' },
      })
      expect(parseTerminalClientFrame('{"type":"ping"}')).toEqual({
        ok: true,
        frame: { type: 'ping' },
      })
    })

    it('帧字节恰为上限时通过（边界含等于）', () => {
      // `{"type":"ping","pad":"` 加尾部 `"}` 共 24 字节，补齐到恰 8192。
      const raw = `{"type":"ping","pad":"${'x'.repeat(TERMINAL_FRAME_MAX_BYTES - 24)}"}`
      expect(new TextEncoder().encode(raw).length).toBe(TERMINAL_FRAME_MAX_BYTES)
      expect(parseTerminalClientFrame(raw)).toEqual({ ok: true, frame: { type: 'ping' } })
    })

    it('data 恰为 4096 字节时通过（边界含等于）', () => {
      const raw = `{"type":"input","data":"${'y'.repeat(TERMINAL_INPUT_MAX_BYTES)}"}`
      expect(parseTerminalClientFrame(raw)).toMatchObject({ ok: true })
    })
  })

  describe('终端消息过大', () => {
    it('二进制帧（ArrayBuffer）一律违规', () => {
      expect(parseTerminalClientFrame(new ArrayBuffer(4))).toEqual({
        ok: false,
        reason: '终端消息过大',
      })
    })

    it('Uint8Array 载荷同样按二进制帧违规', () => {
      expect(parseTerminalClientFrame(new Uint8Array([123]))).toEqual({
        ok: false,
        reason: '终端消息过大',
      })
    })

    it('文本帧超 8192 UTF-8 字节违规', () => {
      const huge = 'z'.repeat(TERMINAL_FRAME_MAX_BYTES + 1)
      expect(parseTerminalClientFrame(`{"type":"ping","pad":"${huge}"}`)).toEqual({
        ok: false,
        reason: '终端消息过大',
      })
    })

    it('多字节字符按字节数而非字符数计', () => {
      // 「中」是 3 字节：2731 个字符 = 8193 字节，超过 8192。
      const payload = '中'.repeat(2731)
      expect(new TextEncoder().encode(payload).length).toBe(TERMINAL_FRAME_MAX_BYTES + 1)
      expect(parseTerminalClientFrame(`{"type":"input","data":"${payload}"}`)).toEqual({
        ok: false,
        reason: '终端消息过大',
      })
    })
  })

  describe('终端消息不是有效 JSON', () => {
    it('畸形 JSON 文本违规且不抛异常', () => {
      expect(parseTerminalClientFrame('not json')).toEqual({
        ok: false,
        reason: '终端消息不是有效 JSON',
      })
      expect(parseTerminalClientFrame('{"type":')).toEqual({
        ok: false,
        reason: '终端消息不是有效 JSON',
      })
    })
  })

  describe('终端消息类型不允许', () => {
    it('JSON 非对象违规', () => {
      for (const raw of ['5', '"text"', 'null', 'true', '[]']) {
        expect(parseTerminalClientFrame(raw)).toEqual({
          ok: false,
          reason: '终端消息类型不允许',
        })
      }
    })

    it('type 缺失或不在白名单违规', () => {
      for (const raw of ['{}', '{"data":"ls"}', '{"type":"output"}', '{"type":"resize"}', '{"type":123}']) {
        expect(parseTerminalClientFrame(raw)).toEqual({
          ok: false,
          reason: '终端消息类型不允许',
        })
      }
    })
  })

  describe('终端输入不合法', () => {
    it('data 非字符串违规', () => {
      expect(parseTerminalClientFrame('{"type":"input"}')).toEqual({
        ok: false,
        reason: '终端输入不合法',
      })
      expect(parseTerminalClientFrame('{"type":"input","data":5}')).toEqual({
        ok: false,
        reason: '终端输入不合法',
      })
      expect(parseTerminalClientFrame('{"type":"input","data":null}')).toEqual({
        ok: false,
        reason: '终端输入不合法',
      })
    })

    it('data 含换行违规', () => {
      expect(parseTerminalClientFrame('{"type":"input","data":"a\\nb"}')).toEqual({
        ok: false,
        reason: '终端输入不合法',
      })
    })

    it('data 超 4096 UTF-8 字节违规', () => {
      const tooLong = 'q'.repeat(TERMINAL_INPUT_MAX_BYTES + 1)
      expect(parseTerminalClientFrame(`{"type":"input","data":"${tooLong}"}`)).toEqual({
        ok: false,
        reason: '终端输入不合法',
      })
    })
  })
})
