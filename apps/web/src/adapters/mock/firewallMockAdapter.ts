import type {
  FirewallForwardInput,
  FirewallForwardRule,
  FirewallIpRule,
  FirewallIpRuleInput,
  FirewallRule,
  FirewallRuleInput,
  FirewallScanConfig,
  FirewallScanProtection,
  FirewallToggles,
} from '@elysian/contracts'
import type { Container, DockerFirewallInventory } from '@elysian/contracts'
import type { FirewallAdapter } from '../../contracts/adapters'
import {
  addFirewallForward,
  addFirewallIpRule,
  addFirewallRule,
  findDuplicateForward,
  findDuplicateFirewallRule,
  findDuplicateIpRule,
  getFirewallForwards,
  getFirewallIpRules,
  getFirewallRules,
  getFirewallToggles,
  getScanProtection,
  setRuleScanProtection,
  removeFirewallForward,
  removeFirewallIpRule,
  removeFirewallRule,
  setFirewallToggles,
  setScanConfigFirewall,
  setScanProtection,
  unblockScanIp,
  updateFirewallForward,
  updateFirewallIpRule,
  updateFirewallRule,
} from './firewallData'
import { MOCK_SYSTEM_SYNC_DELAY_MS } from './mockSyncDelay'

export class MockFirewallAdapter implements FirewallAdapter {
  constructor(private readonly containers: () => readonly Container[] = () => []) {}

  async dockerPorts(): Promise<DockerFirewallInventory> {
    const ports = this.containers().filter(container => container.status === 'running').flatMap(container =>
      container.ports.map(port => ({ ...port, hostIp: port.hostIp || '0.0.0.0', containerId: container.id, containerName: container.name })))
    return { inventory: 'ready', ports, guard: { state: 'unsupported', kernelVerified: false } }
  }

  async list(): Promise<readonly FirewallRule[]> {
    return getFirewallRules()
  }

  async toggles(): Promise<FirewallToggles> {
    return getFirewallToggles()
  }

  async setToggles(next: FirewallToggles): Promise<FirewallToggles> {
    return setFirewallToggles(next)
  }

  async create(input: FirewallRuleInput): Promise<FirewallRule> {
    if (findDuplicateFirewallRule(input)) {
      throw new Error(`端口规则已存在：${input.protocol} ${input.port}（${input.family}）`)
    }
    return addFirewallRule(input, new Date().toISOString())
  }

  async update(ruleId: string, input: FirewallRuleInput): Promise<FirewallRule> {
    if (findDuplicateFirewallRule(input, ruleId)) {
      throw new Error(`端口规则已存在：${input.protocol} ${input.port}（${input.family}）`)
    }
    return updateFirewallRule(ruleId, input, new Date().toISOString())
  }

  async remove(ruleId: string): Promise<void> {
    removeFirewallRule(ruleId)
  }

  async listIpRules(): Promise<readonly FirewallIpRule[]> {
    return getFirewallIpRules()
  }

  async createIpRule(input: FirewallIpRuleInput): Promise<FirewallIpRule> {
    if (findDuplicateIpRule(input)) {
      throw new Error(`IP 规则已存在：${input.source.trim()}`)
    }
    return addFirewallIpRule(input, new Date().toISOString())
  }

  async updateIpRule(ruleId: string, input: FirewallIpRuleInput): Promise<FirewallIpRule> {
    if (findDuplicateIpRule(input, ruleId)) {
      throw new Error(`IP 规则已存在：${input.source.trim()}`)
    }
    return updateFirewallIpRule(ruleId, input, new Date().toISOString())
  }

  async removeIpRule(ruleId: string): Promise<void> {
    removeFirewallIpRule(ruleId)
  }

  async listForwards(): Promise<readonly FirewallForwardRule[]> {
    return getFirewallForwards()
  }

  async createForward(input: FirewallForwardInput): Promise<FirewallForwardRule> {
    if (findDuplicateForward(input)) {
      throw new Error(`端口转发已存在：${input.protocol} ${input.port}`)
    }
    return addFirewallForward(input, new Date().toISOString())
  }

  async updateForward(ruleId: string, input: FirewallForwardInput): Promise<FirewallForwardRule> {
    if (findDuplicateForward(input, ruleId)) {
      throw new Error(`端口转发已存在：${input.protocol} ${input.port}`)
    }
    return updateFirewallForward(ruleId, input, new Date().toISOString())
  }

  async removeForward(ruleId: string): Promise<void> {
    removeFirewallForward(ruleId)
  }

  async scanProtection(): Promise<FirewallScanProtection> {
    return getScanProtection()
  }

  async setRuleScanProtection(ruleId: string, enabled: boolean): Promise<FirewallScanProtection> {
    return setRuleScanProtection(ruleId, enabled)
  }

  async setScanProtection(enabled: boolean): Promise<FirewallScanProtection> {
    return setScanProtection(enabled)
  }

  async setScanConfig(config: FirewallScanConfig): Promise<FirewallScanProtection> {
    return setScanConfigFirewall(config)
  }

  async unblockIp(ip: string): Promise<FirewallScanProtection> {
    return unblockScanIp(ip)
  }

  async syncFromSystem(): Promise<{ total: number }> {
    // 模拟读取操作系统防火墙的耗时；演示里规则集与「系统」天然一致，只回读总数。
    await new Promise((resolve) => setTimeout(resolve, MOCK_SYSTEM_SYNC_DELAY_MS))
    return {
      total: getFirewallRules().length + getFirewallIpRules().length + getFirewallForwards().length,
    }
  }
}
