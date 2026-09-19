/*
 * /etc/ufw/before.rules 的禁 ping 切换。这是 Ubuntu 下禁 ping 的标准做法：
 * 把 input 链的 echo-request 放行改成丢弃，再 ufw reload 生效。
 * 只动 `ufw-before-input`（与 v6 文件的 `ufw6-before-input`）链；forward/output 链不碰。
 */

const ECHO_REQUEST_INPUT = /^(-A\s+ufw6?-before-input\s+.*--icmp(?:v6)?-type\s+echo-request\s+.*)-j\s+(ACCEPT|DROP)\s*$/

/** 是否处于禁 ping（input 链存在 DROP 的 echo-request 规则）。 */
export function parsePingBlocked(beforeRules: string): boolean {
  return beforeRules
    .split('\n')
    .some((line) => /-A\s+ufw6?-before-input\s+.*--icmp(?:v6)?-type\s+echo-request\s+.*-j\s+DROP\s*$/.test(line))
}

/** 在 input 链的 echo-request 行上切换 ACCEPT 与 DROP；其余行原样保留。 */
export function setPingBlocked(beforeRules: string, blocked: boolean): string {
  const target = blocked ? 'DROP' : 'ACCEPT'
  return beforeRules
    .split('\n')
    .map((line) => {
      const match = ECHO_REQUEST_INPUT.exec(line)
      if (!match) return line
      return `${match[1]}-j ${target}`
    })
    .join('\n')
}
