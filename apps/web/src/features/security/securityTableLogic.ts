import type { DockerPublishedPort, FirewallAddressFamily, FirewallRule } from '@elysian/contracts'

/** 地址族仅是同一条 UFW 规则的两种展示；备注与采样状态不属于规则身份。 */
export const portRuleGroup = (rule: FirewallRule): string => JSON.stringify([rule.protocol, rule.port, rule.portTo, rule.policy, rule.direction, rule.source])

export const isProtectedPanelRule = (rule: FirewallRule, frontendPort: number): boolean =>
  rule.protocol === 'tcp' && rule.port === frontendPort && rule.portTo === null
  && rule.policy === 'allow' && rule.direction === 'inbound' && ['所有IP', 'any'].includes(rule.source)

export type PortTableRow = { id: string; port: number; protocol: string; note: string | null } & (
  | { kind: 'rule'; rule: FirewallRule; published: boolean }
  | { kind: 'published'; family: FirewallAddressFamily; addresses: string[] }
)

const hostPortKey = (port: number, protocol: string, family: FirewallAddressFamily) => `${port}/${protocol}/${family}`

export function portTableRows(rules: readonly FirewallRule[], ports: readonly DockerPublishedPort[]): PortTableRow[] {
  const bindings = new Map<string, {
    port: number; protocol: string; family: FirewallAddressFamily; names: Set<string>; addresses: Set<string>
  }>()
  for (const { hostPort, protocol, hostIp, containerName } of ports) {
    const family = hostIp.includes(':') ? 'ipv6' : 'ipv4'
    const key = hostPortKey(hostPort, protocol, family)
    let binding = bindings.get(key)
    if (!binding) {
      binding = { port: hostPort, protocol, family, names: new Set(), addresses: new Set() }
      bindings.set(key, binding)
    }
    binding.names.add(containerName)
    binding.addresses.add(hostIp)
  }

  const matched = new Set<string>()
  const rows = rules.map<PortTableRow>(rule => {
    const key = hostPortKey(rule.port, rule.protocol, rule.family)
    const names = rule.direction === 'inbound' && (rule.portTo === null || rule.portTo === rule.port)
      ? bindings.get(key)?.names
      : undefined
    if (!names?.size) return { ...rule, kind: 'rule', rule, published: false }
    matched.add(key)
    const namesNote = [...names].sort().join('、')
    const note = rule.note && !names.has(rule.note) ? `${rule.note} · ${namesNote}` : namesNote
    return { ...rule, kind: 'rule', rule, published: true, note }
  })

  // A matching range or opposite address family can have a different verdict.
  // Keep the concrete host port visible without inventing a firewall policy.
  for (const [key, { port, protocol, family, names, addresses }] of bindings) {
    if (!matched.has(key)) rows.push({
      kind: 'published', id: `published:${key}`, port, protocol,
      family, addresses: [...addresses].sort(), note: [...names].sort().join('、'),
    })
  }
  return rows
}
