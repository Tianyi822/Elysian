import { describe, expect, it } from 'vitest'
import { validateRedisTerminalCommand } from './databaseProtocol.ts'
import { validDatabaseVersion, imageMatches } from './databaseDocker.ts'

describe('数据库边界', () => {
  it('版本和镜像仓库身份必须精确', () => {
    expect(validDatabaseVersion('8.4')).toBe(true)
    expect(validDatabaseVersion('latest')).toBe(false)
    expect(validDatabaseVersion('8.4;rm')).toBe(false)
    expect(imageMatches('MySQL', 'mysql')).toBe(true)
    expect(imageMatches('MySQL', 'attacker/mysql')).toBe(false)
  })
  it('Redis 终端不能使用管理、脚本、跨库和清空命令', () => {
    for (const command of ['CONFIG SET dir /tmp', 'EVAL "return 1" 0', 'EVAL_RO "return 1" 0', 'SELECT 1', 'MOVE key 1', 'COPY key dst DB 1', 'FLUSHDB', 'ACL SETUSER x', 'MODULE LOAD x', 'MIGRATE host 1 k 0 1']) {
      expect(() => validateRedisTerminalCommand(command)).toThrow()
    }
    expect(validateRedisTerminalCommand('SET "my key" value')).toEqual(['SET', 'my key', 'value'])
    expect(() => validateRedisTerminalCommand(`GET ${'x'.repeat(70_000)}`)).toThrow('64 KiB')
  })
})
