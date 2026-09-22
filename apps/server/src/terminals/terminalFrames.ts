/*
 * 终端 WebSocket 客户端帧的解析与校验（纯函数，无 IO）：白名单三类
 * （input/interrupt/ping）、单帧与单条输入的字节上限、data 形状（字符串、不含
 * 换行）。违规一律以关闭码 1008 配中文 reason 由调用方关闭连接，本模块只产出
 * 判定结果。协议口径的唯一权威是 docs/specs/2026-09-22-terminal-real-implementation.md
 * 的「端点契约」一节。
 */

/** 单帧字节数上限：客户端 → 服务端的单个 WebSocket 帧载荷（UTF-8）不得超过。 */
export const TERMINAL_FRAME_MAX_BYTES = 8192

/** 单条 input 帧的 data 字段字节上限（UTF-8）。 */
export const TERMINAL_INPUT_MAX_BYTES = 4096

/** 客户端帧白名单：input（整行输入）、interrupt（Ctrl+C）、ping（保活）。 */
export type TerminalClientFrame =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'interrupt' }
  | { readonly type: 'ping' }

/** 解析结果：合法给出帧；违规给出 1008 的中文 reason（code 由调用方统一补上）。 */
export type TerminalClientFrameResult =
  | { readonly ok: true; readonly frame: TerminalClientFrame }
  | { readonly ok: false; readonly reason: string }

const utf8Encoder = new TextEncoder()

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length
}

/**
 * 解析一条客户端帧。raw 是消息事件里的原始载荷：字符串即文本帧，其余（ArrayBuffer、
 * Uint8Array、Blob 等）一律按二进制帧违规处理。校验次序：二进制/超限 →
 * 「终端消息过大」；非 JSON → 「终端消息不是有效 JSON」；非对象或 type 不在白名单 →
 * 「终端消息类型不允许」；input 的 data 非字符串/超长/含换行 → 「终端输入不合法」。
 */
export function parseTerminalClientFrame(raw: unknown): TerminalClientFrameResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: '终端消息过大' }
  }
  if (utf8ByteLength(raw) > TERMINAL_FRAME_MAX_BYTES) {
    return { ok: false, reason: '终端消息过大' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: '终端消息不是有效 JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: '终端消息类型不允许' }
  }
  const { type, data } = parsed as { type?: unknown; data?: unknown }
  if (type !== 'input' && type !== 'interrupt' && type !== 'ping') {
    return { ok: false, reason: '终端消息类型不允许' }
  }
  if (type === 'input') {
    if (typeof data !== 'string') {
      return { ok: false, reason: '终端输入不合法' }
    }
    if (data.includes('\n')) {
      return { ok: false, reason: '终端输入不合法' }
    }
    if (utf8ByteLength(data) > TERMINAL_INPUT_MAX_BYTES) {
      return { ok: false, reason: '终端输入不合法' }
    }
    return { ok: true, frame: { type: 'input', data } }
  }
  return { ok: true, frame: { type } }
}
