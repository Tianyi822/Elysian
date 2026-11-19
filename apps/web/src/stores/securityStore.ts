import { createTabMemoryStore } from './tabMemoryStore'

/** 安全区页签取值。 */
export type SecurityTab = 'firewall' | 'ssh' | 'users'

/** 页签表：顶栏切换与页内内容共用，值保持英文标识符，中文文案只在这里维护。 */
export const SECURITY_TABS: readonly { value: SecurityTab; label: string }[] = [
  { value: 'firewall', label: '系统防火墙' },
  { value: 'ssh', label: 'SSH 管理' },
  { value: 'users', label: '用户管理' },
]

export const useSecurityStore = createTabMemoryStore<SecurityTab>('firewall')
