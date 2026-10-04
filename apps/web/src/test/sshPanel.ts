import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMockGateway } from '../adapters/mock/gateway'
import { resetSshData } from '../adapters/mock/sshData'
import { resetHostUsers } from '../adapters/mock/usersData'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from '../stores/notificationStore'
import { useSshStore } from '../stores/sshStore'
import { useUsersStore } from '../stores/usersStore'
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
  loginRecords: [],
  keyAccounts: [],
  portDraft: '',
  portError: undefined,
  passwordDraft: '',
  keySearch: '',
  keyPage: 1,
  recordPage: 1,
  createKeyOpen: false,
  removeKeyTarget: undefined,
  viewKey: undefined,
  revealKey: undefined,
  passwordResetNotice: false,
  togglingService: false,
  savingAuth: false,
  savingPort: false,
  savingPolicy: false,
  resettingPassword: false,
  generatingRootKey: false,
  creatingKey: false,
  removingKeyIds: [],
}

/** 演示数据集是模块级内存状态：每个用例前推回种子，并清掉上一轮的 store 与通知。 */
export function resetSshPanel(): void {
  resetSshData()
  resetHostUsers()
  useSshStore.setState(INITIAL_SSH_STATE)
  useUsersStore.setState(INITIAL_USERS_STATE)
  useNotificationStore.getState().clear()
}

export const INITIAL_USERS_STATE = {
  status: 'idle' as const,
  errorMessage: undefined,
  users: [],
  search: '',
  syncing: false,
  dialogUser: undefined,
  removeTarget: undefined,
  saving: false,
  removingUserIds: [],
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
      createRootKey: () => ssh.createRootKey(),
      listKeys: () => ssh.listKeys(),
      keyAccounts: () => ssh.keyAccounts(),
      listLoginRecords: () => ssh.listLoginRecords(),
      createKey: (input) => ssh.createKey(input),
      removeKey: (keyId) => ssh.removeKey(keyId),
      ...overrides,
    },
  }
  return { gateway, ssh }
}

/** 主机账号适配器的委托替身：委托清单同样是穷举的。 */
export function userSessions(overrides: Partial<ElysianGateway['users']> = {}) {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  const users = base.users
  const gateway: ElysianGateway = {
    ...base,
    users: {
      list: () => users.list(),
      create: (input) => users.create(input),
      update: (userId, input) => users.update(userId, input),
      remove: (userId) => users.remove(userId),
      syncFromSystem: () => users.syncFromSystem(),
      ...overrides,
    },
  }
  return { gateway, users }
}

/** 内容区的安全页签按钮。 */
export function securityTab(name: string): HTMLElement {
  const group = within(screen.getByRole('main')).getByRole('group', { name: '安全页签' })
  return within(group).getByRole('button', { name })
}

/** 打开安全页并切到指定页签，等到面板就绪。默认切到 SSH 管理。 */
export async function openSshTab(
  gateway: ElysianGateway = sshSessions().gateway,
  tabLabel = 'SSH 管理',
) {
  const user = userEvent.setup()
  renderApp('/security', { gateway })
  await user.click(securityTab(tabLabel))
  await screen.findByRole('region', {
    name: tabLabel === 'SSH 管理' ? 'SSH 服务' : '主机账号表',
  })
  return user
}
