/**
 * 终端字号的唯一口径：像素连续值，不是离散档位。
 *
 * 顶栏按钮按一档（2px）增减，滚轮按一格（1px）无级缩放，两者共用同一组边界；
 * 边界外一律夹住，不产生 9px 这类不可读的回落。
 */
export const TERMINAL_FONT_SIZE_DEFAULT = 12
export const TERMINAL_FONT_SIZE_MIN = 10
export const TERMINAL_FONT_SIZE_MAX = 24
export const TERMINAL_FONT_SIZE_STEP = 2
export const TERMINAL_FONT_SIZE_WHEEL_STEP = 1

export function clampTerminalFontSize(size: number): number {
  return Math.min(Math.max(size, TERMINAL_FONT_SIZE_MIN), TERMINAL_FONT_SIZE_MAX)
}
