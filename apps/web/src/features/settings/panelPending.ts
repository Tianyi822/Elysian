import { validatePanelPorts } from '@elysian/contracts'
import type { PanelPorts, PanelUpdateTarget } from '@elysian/contracts'
import type { PanelAdapter } from '../../contracts/adapters'

export const PANEL_PENDING_KEY = 'elysian.panel-maintenance.pending.v1'
export type PanelPending = { version: 1; requestId: string } & (
  { kind: 'ports'; input: PanelPorts } | { kind: 'update'; input: PanelUpdateTarget } | { kind: 'restart'; input: null }
)
function validResourcePlan(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const plan = value as Record<string, unknown>
  return typeof plan.preflightId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(plan.preflightId) && typeof plan.stopPanel === 'boolean'
    && Array.isArray(plan.targets) && plan.targets.length <= 256 && new Set(plan.targets).size === plan.targets.length
    && plan.targets.every(id => typeof id === 'string' && /^(?:container:[a-f0-9]{64}|service:[A-Za-z0-9_.@:-]+\.service)$/.test(id))
}
export function readPanelPending(): PanelPending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PANEL_PENDING_KEY) ?? 'null') as PanelPending | null
    if (!value || value.version !== 1 || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(value.requestId)) return null
    if (value.kind === 'restart' && value.input === null) return value
    if (value.kind === 'ports' && value.input && !validatePanelPorts(value.input)) return value
    if (value.kind === 'update' && value.input && ['commit', 'release'].includes(value.input.channel) && (value.input.source === undefined || value.input.source === 'github' || value.input.source === 'gitee') && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.input.targetCommit) && typeof value.input.releaseTag === 'string' && (value.input.channel !== 'release' || value.input.releaseTag !== '') && validResourcePlan(value.input.resourcePlan)) return value
  } catch { /* 当前页面仍可追踪；存储不可用时不抛错。 */ }
  return null
}
export function savePanelPending(value: PanelPending | null) {
  try { if (value) sessionStorage.setItem(PANEL_PENDING_KEY, JSON.stringify(value)); else sessionStorage.removeItem(PANEL_PENDING_KEY) } catch { /* 浏览器可能禁用存储。 */ }
}
export function sendPanelPending(adapter: PanelAdapter, value: PanelPending) {
  if (value.kind === 'restart') return adapter.restart(value.requestId)
  if (value.kind === 'ports') return adapter.ports(value.input, value.requestId)
  return adapter.update(value.input, value.requestId)
}
