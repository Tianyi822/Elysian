import { describe, expect, it } from 'vitest'
import { parsePingBlocked, setPingBlocked } from './pingRules'

const BEFORE_RULES = `# Don't delete these required lines,
*filter
:ufw-before-input - [0:0]
:ufw-before-output - [0:0]
-A ufw-before-input -i lo -j ACCEPT
-A ufw-before-input -p icmp --icmp-type destination-unreachable -j ACCEPT
-A ufw-before-input -p icmp --icmp-type time-exceeded -j ACCEPT
-A ufw-before-input -p icmp --icmp-type parameter-problem -j ACCEPT
-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT
-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT
-A ufw-before-forward -p icmp --icmp-type echo-request -j ACCEPT
-A ufw-before-output -o lo -j ACCEPT
COMMIT`

const BEFORE_RULES_BLOCKED = BEFORE_RULES.replace(
  /(-A ufw-before-input -p icmp --icmp-type echo-request .*)-j ACCEPT/g,
  '$1-j DROP',
)

describe('parsePingBlocked', () => {
  it('input 链 echo-request 为 ACCEPT 时未禁 ping', () => {
    expect(parsePingBlocked(BEFORE_RULES)).toBe(false)
  })

  it('input 链 echo-request 为 DROP 时已禁 ping', () => {
    expect(parsePingBlocked(BEFORE_RULES_BLOCKED)).toBe(true)
  })
})

describe('setPingBlocked', () => {
  it('禁 ping 只改 input 链的 echo-request 行', () => {
    const next = setPingBlocked(BEFORE_RULES, true)
    expect(next).toBe(BEFORE_RULES_BLOCKED)
    // forward/output 链不受影响
    expect(next).toContain('-A ufw-before-forward -p icmp --icmp-type echo-request -j ACCEPT')
  })

  it('恢复放行回到原始内容', () => {
    expect(setPingBlocked(BEFORE_RULES_BLOCKED, false)).toBe(BEFORE_RULES)
  })

  it('没有 echo-request 行时原样返回', () => {
    expect(setPingBlocked('# empty\nCOMMIT\n', true)).toBe('# empty\nCOMMIT\n')
  })
})
