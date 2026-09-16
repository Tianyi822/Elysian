import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMockGateway } from '../adapters/mock/gateway'
import { resetSshData } from '../adapters/mock/sshData'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from '../stores/notificationStore'
import { useSshStore } from '../stores/sshStore'
import { renderApp } from './renderApp'

/**
 * SSH 页签的测试脚手架：清场、网关替身、打开页签。面板用例与密钥表用例共用。
 *
 * 委托清单是穷举式的：每给 SshAdapter 加一个方法，这里必须补一行，否则类型检查会报错——
 * 这样替身不会悄悄落后于契约。
 */

export const INITIAL_SSH_STATE = {
  status: 'idle' as const,
  errorMessage: undefined,
  overview: undefined,
  settings: undefined,
  rootAuth: undefined,
  keys: [],
  portDraft: '',
  portError: undefined,
  passwordDraft: '',
  keySearch: '',
  createKeyOpen: false,
  removeKeyTarget: undefined,
  viewKey: undefined,
  togglingService: false,
  savingAuth: false,
  savingPort: false,
  savingPolicy: false,
  resettingPassword: false,
  creatingKey: false,
  removingKeyIds: [],
}

/** 演示数据集是模块级内存状态：每个用例前推回种子，并清掉上一轮的 store 与通知。 */
export function resetSshPanel(): void {
  resetSshData()
  useSshStore.setState(INITIAL_SSH_STATE)
  useNotificationStore.getState().clear()
}

/** 适配器方法在原型上，展开会丢；显式委托再叠加覆盖项。同时把基础实现交回给用例。 */
export function sshSessions(overrides: Partial<ElysianGateway['ssh']> = {}) {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const ssh = base.ssh
  const gateway: ElysianGateway = {
    ...base,
    ssh: {
      overview: () => ssh.overview(),
      settings: () => ssh.settings(),
      rootAuth: () => ssh.rootAuth(),
      setServiceEnabled: (enabled) => ssh.setServiceEnabled(enabled),
      setAuthMethods: (methods) => ssh.setAuthMethods(methods),
      setPort: (port) => ssh.setPort(port),
      saveRootLoginPolicy: (policy) => ssh.saveRootLoginPolicy(policy),
      resetRootPassword: (password) => ssh.resetRootPassword(password),
      listKeys: () => ssh.listKeys(),
      createKey: (input) => ssh.createKey(input),
      removeKey: (keyId) => ssh.removeKey(keyId),
      ...overrides,
    },
  }
  return { gateway, ssh }
}

/** 顶栏上的安全页签按钮。 */
export function securityTab(name: string): HTMLElement {
  const group = within(screen.getByRole('banner')).getByRole('group', { name: '安全页签' })
  return within(group).getByRole('button', { name })
}

/** 打开安全页并切到 SSH 管理页签，等到卡片就绪。 */
export async function openSshTab(gateway: ElysianGateway = sshSessions().gateway) {
  const user = userEvent.setup()
  renderApp('/security', { gateway })
  await user.click(securityTab('SSH 管理'))
  await screen.findByRole('region', { name: 'SSH 服务' })
  return user
}
