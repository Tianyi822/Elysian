/*
 * 规则备注的统一输入校验：所有要写进规则文件或 ufw 命令参数的备注都从这里过。备注的落点决定两类禁区：
 * - 换行/回车等控制字符任何场景都拒：转发备注以双引号包进 before.rules 的一行规则，含换行会把一行
 *   断成两行，iptables-restore 解析失败、防火墙停用；ufw 备注含换行则写入后回读解析失败、规则从面板消失。
 * - 引号按落点拒绝：转发场景 comment 由双引号包裹（iptables-restore 只认双引号），拒双引号；
 *   ufw 场景 comment 由单引号包裹（`ufw ... comment '...'`），拒单引号。
 */

/** 控制字符（C0 与 DEL）加 Unicode 行终止符（U+2028/U+2029）：后者虽非 \n，按行切分时同样断行。 */
const UNSAFE_NOTE_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/

/** 是否含换行或控制字符：规则备注与 SSH 密钥名称共用同一条禁区判据（会进命令参数或按行落盘的自由文本都从这里过）。 */
export function hasUnsafeControlChars(text: string): boolean {
  return UNSAFE_NOTE_CHARS.test(text)
}

export type NoteScene = 'forward' | 'ufw'

/** 校验备注可安全写进对应场景；不合法抛中文错误，空备注直接放行。 */
export function assertNoteSafe(note: string | null, scene: NoteScene): void {
  if (!note) return
  if (hasUnsafeControlChars(note)) {
    throw new Error('备注不能包含换行或控制字符')
  }
  if (scene === 'forward' && note.includes('"')) {
    // comment 以双引号包进规则文本，备注里的双引号会破坏规则
    throw new Error('备注不能包含双引号')
  }
  if (scene === 'ufw' && note.includes("'")) {
    // ufw comment 参数以单引号包裹，备注里的单引号会被截断
    throw new Error('备注不能包含单引号')
  }
}
