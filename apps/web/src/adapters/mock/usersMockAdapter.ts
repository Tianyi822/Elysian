import { isValidHostUserName, type HostUser, type HostUserInput } from '@elysian/contracts'
import type { UserAdapter } from '../../contracts/adapters'
import { MOCK_SYSTEM_SYNC_DELAY_MS } from './mockSyncDelay'
import {
  addHostUser,
  findHostUserByName,
  getHostUsers,
  removeHostUser,
  updateHostUser,
} from './usersData'
import { removeSshLoginKeysByUser } from './sshData'

export class MockUserAdapter implements UserAdapter {
  async list(): Promise<readonly HostUser[]> {
    return getHostUsers()
  }

  async create(input: { name: string } & HostUserInput): Promise<HostUser> {
    // 判据与表单共用同一函数：界面挡住一次，这里再挡一次，绕过界面也写不进演示数据集。
    if (!isValidHostUserName(input.name)) {
      throw new Error('用户名只能用小写字母、数字、下划线与连字符，且由字母或下划线开头')
    }
    if (findHostUserByName(input.name)) throw new Error(`用户名已存在：${input.name}`)
    // mock 不消费 password：真实实现的 chpasswd 路径在演示态不存在，字段在这里丢弃、不落数据集。
    const { name, password: _password, ...rest } = input
    return addHostUser(name, rest, new Date().toISOString())
  }

  async update(userId: string, input: HostUserInput): Promise<HostUser> {
    // 同上：password 只属于真实实现，mock 保持行为不变。
    const { password: _password, ...rest } = input
    return updateHostUser(userId, rest)
  }

  async remove(userId: string): Promise<void> {
    // 账号没了，授权它的密钥也就登不进去，一并从演示数据集里移除。
    removeSshLoginKeysByUser(userId)
    removeHostUser(userId)
  }

  async syncFromSystem(): Promise<{ total: number }> {
    // 模拟读取系统账号的耗时；演示里账号集与「系统」天然一致，只回读总数。
    await new Promise((resolve) => setTimeout(resolve, MOCK_SYSTEM_SYNC_DELAY_MS))
    return { total: getHostUsers().length }
  }
}
