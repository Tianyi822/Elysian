import { SSH_KEY_NAME_MAX_LENGTH, isValidSshKeyName, isValidSshPort } from '@elysian/contracts'
import type {
  SshAuthMethods,
  SshAuthSettings,
  SshLoginKey,
  SshLoginRecord,
  SshOverview,
  SshPasswordResetResult,
  SshRootAuth,
  SshRootLoginPolicy,
} from '@elysian/contracts'
import type { SshAdapter, SshKeyAccount } from '../../contracts/adapters'
import { MockFirewallAdapter } from './firewallMockAdapter'
import {
  addSshLoginKey,
  findSshLoginKeyByName,
  generateSshRootKey,
  getSshAuthSettings,
  getSshLoginKeys,
  getSshLoginRecords,
  getSshOverview,
  getSshRootAuth,
  removeSshLoginKey,
  resetSshRootPassword,
  saveSshAuthSettings,
  saveSshRootLoginPolicy,
  setSshServiceEnabled,
} from './sshData'
import { findHostUserById, getHostUsers } from './usersData'

export class MockSshAdapter implements SshAdapter {
  async overview(): Promise<SshOverview> {
    return { ...getSshOverview(), runtimeMode: 'local-demo' }
  }

  async settings(): Promise<SshAuthSettings> {
    return getSshAuthSettings()
  }

  async rootAuth(): Promise<SshRootAuth> {
    return getSshRootAuth()
  }

  async setServiceEnabled(enabled: boolean): Promise<SshOverview> {
    return { ...setSshServiceEnabled(enabled, new Date().toISOString()), runtimeMode: 'local-demo' }
  }

  async setAuthMethods(methods: SshAuthMethods): Promise<SshAuthSettings> {
    return saveSshAuthSettings({ ...getSshAuthSettings(), ...methods })
  }

  async setPort(port: number): Promise<SshAuthSettings> {
    // 判据与表单共用同一函数：界面挡住一次，这里再挡一次，绕过界面也写不进演示数据集。
    if (!isValidSshPort(port)) throw new Error('SSH 端口需为 1-65535 的整数')
    const firewall = new MockFirewallAdapter()
    const toggles = await firewall.toggles()
    const rules = toggles.firewallEnabled ? await firewall.list() : []
    const existing = rules.find((rule) => rule.protocol === 'tcp' && rule.direction === 'inbound' && rule.port === port && rule.portTo === null && rule.family === 'ipv4' && rule.source === '所有IP')
    if (existing?.policy === 'deny') throw new Error('SSH 端口未修改：该端口已有拒绝规则')
    if (toggles.firewallEnabled && !existing) await firewall.create({ protocol: 'tcp', port, family: 'ipv4', policy: 'allow', direction: 'inbound', source: '所有IP', note: 'SSH 端口联动放行' })
    return { ...saveSshAuthSettings({ ...getSshAuthSettings(), port }), firewallPort: { state: toggles.firewallEnabled && !existing ? 'opened' : 'skipped', port, detail: !toggles.firewallEnabled ? '防火墙未启用，启用前请确认 SSH 端口已放行' : existing ? '防火墙已有该端口的入站放行规则' : null } }
  }

  async saveRootLoginPolicy(policy: SshRootLoginPolicy): Promise<SshRootAuth> {
    return saveSshRootLoginPolicy(policy)
  }

  async resetRootPassword(password: string): Promise<SshPasswordResetResult> {
    return resetSshRootPassword(password, new Date().toISOString())
  }

  async createRootKey(): Promise<SshRootAuth> {
    // 私钥仅随本次响应携带（生成序号进派生种子，重新生成得到不同指纹）。
    return generateSshRootKey(new Date().toISOString())
  }

  async listKeys(): Promise<readonly SshLoginKey[]> {
    return getSshLoginKeys()
  }

  async keyAccounts(): Promise<readonly SshKeyAccount[]> {
    // mock 侧的归属清单就是账号数据集：id 回传给 createKey，与真实实现回传登录名同形。
    return getHostUsers().map((user) => ({ id: user.id, name: user.name }))
  }

  async listLoginRecords(): Promise<readonly SshLoginRecord[]> {
    return getSshLoginRecords()
  }

  async createKey(input: { name: string; userId: string }): Promise<SshLoginKey> {
    // 判据与表单共用同一函数：界面挡住一次，这里再挡一次，绕过界面也写不进演示数据集。
    const name = input.name.trim()
    if (!isValidSshKeyName(name)) throw new Error(`密钥名称需为 1-${SSH_KEY_NAME_MAX_LENGTH} 个字符`)
    if (findSshLoginKeyByName(name)) throw new Error(`密钥名称已存在：${name}`)
    const owner = findHostUserById(input.userId)
    if (!owner) throw new Error(`归属账号不存在：${input.userId}`)
    return addSshLoginKey(name, owner.id, new Date().toISOString())
  }

  async removeKey(keyId: string): Promise<void> {
    removeSshLoginKey(keyId)
  }
}
