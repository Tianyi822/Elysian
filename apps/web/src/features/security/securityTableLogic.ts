import type { DockerPublishedPort, FirewallAddressFamily, FirewallRule } from '@elysian/contracts'

/** 地址族仅是同一条 UFW 规则的两种展示；备注与采样状态不属于规则身份。 */
export const portRuleGroup = (rule: FirewallRule): string => JSON.stringify([rule.protocol, rule.port, rule.portTo, rule.policy, rule.direction, rule.source])

export const isProtectedPanelRule = (rule: FirewallRule, frontendPort: number): boolean =>
  rule.protocol === 'tcp' && rule.port === frontendPort && rule.portTo === null
  && rule.policy === 'allow' && rule.direction === 'inbound' && ['所有IP', 'any'].includes(rule.source)

export type PortTableRow = { id: string; port: number; protocol: string; note: string | null } & (
  | { kind: 'rule'; rule: FirewallRule; published: boolean }
  | { kind: 'published'; family: FirewallAddressFamily }
)

const hostPortKey = (port: number, protocol: string) => `${port}/${protocol}`

export function portTableRows(rules: readonly FirewallRule[], ports: readonly DockerPublishedPort[]): PortTableRow[] {
  const bindings = new Map<string, { port: number; protocol: string; ipv4: Set<string>; ipv6: Set<string> }>()
  for (const { hostPort, protocol, hostIp, containerName } of ports) {
    const key = hostPortKey(hostPort, protocol)
    let binding = bindings.get(key)
    if (!binding) {
      binding = { port: hostPort, protocol, ipv4: new Set(), ipv6: new Set() }
      bindings.set(key, binding)
    }
    binding[hostIp.includes(':') ? 'ipv6' : 'ipv4'].add(containerName)
  }

  const matched = new Set<string>()
  const rows = rules.map<PortTableRow>(rule => {
    const key = hostPortKey(rule.port, rule.protocol)
    const names = rule.direction === 'inbound' && (rule.portTo === null || rule.portTo === rule.port)
      ? bindings.get(key)?.[rule.family]
      : undefined
    if (!names?.size) return { ...rule, kind: 'rule', rule, published: false }
    matched.add(`${key}/${rule.family}`)
    const namesNote = [...names].sort().join('、')
    const note = rule.note && !names.has(rule.note) ? `${rule.note} · ${namesNote}` : namesNote
    return { ...rule, kind: 'rule', rule, published: true, note }
  })

  // A matching range or opposite address family can have a different verdict.
  // Keep the concrete host port visible without inventing a firewall policy.
  for (const [key, { port, protocol, ipv4, ipv6 }] of bindings) {
    const unmatched4 = matched.has(`${key}/ipv4`) ? [] : [...ipv4]
    const unmatched6 = matched.has(`${key}/ipv6`) ? [] : [...ipv6]
    const names = [...new Set([...unmatched4, ...unmatched6])].sort()
    if (names.length > 0) rows.push({
      kind: 'published', id: `published:${key}`, port, protocol,
      family: unmatched4.length > 0 ? 'ipv4' : 'ipv6', note: names.join('、'),
    })
  }
  return rows
}
