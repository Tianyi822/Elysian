import { describe, expect, it } from 'vitest'
import {
  assertSqlGrantsWithinDatabase,
  validateRedisTerminalCommand,
  validateSqlTerminalStatement,
  type SqlGrantRows,
} from './databaseProtocol.ts'
import { InvalidRequestError } from '../shared/errors.ts'
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

const grantsWithin = (patch: Partial<SqlGrantRows>): SqlGrantRows => ({
  userPrivileges: [{ PRIVILEGE_TYPE: 'USAGE', IS_GRANTABLE: 'NO' }],
  schemaPrivileges: [],
  tablePrivileges: [],
  columnPrivileges: [],
  ...patch,
})

function expectReject(action: () => void, status: number, message: RegExp): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidRequestError)
    expect((error as InvalidRequestError).status).toBe(status)
    expect((error as InvalidRequestError).message).toMatch(message)
    return
  }
  throw new Error(`预期抛出 InvalidRequestError(${status} ${message})，但调用未抛出`)
}

describe('MySQL 授权白名单核验（INFORMATION_SCHEMA）', () => {
  it('表级其他库授权（旧 SHOW GRANTS 正则漏检形态）必须拒绝', () => {
    expectReject(() => assertSqlGrantsWithinDatabase('appdb', grantsWithin({
      tablePrivileges: [{ TABLE_SCHEMA: 'otherdb', IS_GRANTABLE: 'NO' }],
    })), 403, /其他数据库/)
    expectReject(() => assertSqlGrantsWithinDatabase('appdb', grantsWithin({
      columnPrivileges: [{ TABLE_SCHEMA: 'otherdb', IS_GRANTABLE: 'NO' }],
    })), 403, /其他数据库/)
  })
  it('通配库名授权不等于目标库名，必须拒绝', () => {
    expectReject(() => assertSqlGrantsWithinDatabase('appdb', grantsWithin({
      schemaPrivileges: [{ TABLE_SCHEMA: 'app%', IS_GRANTABLE: 'NO' }],
    })), 403, /其他数据库/)
    expectReject(() => assertSqlGrantsWithinDatabase('appdb', grantsWithin({
      schemaPrivileges: [{ TABLE_SCHEMA: '%', IS_GRANTABLE: 'NO' }],
    })), 403, /其他数据库/)
  })
  it('USER_PRIVILEGES 里 USAGE 之外的全局授权（FILE/SUPER/具体权限）必须拒绝', () => {
    for (const privilege of ['FILE', 'SUPER', 'SELECT']) {
      expectReject(() => assertSqlGrantsWithinDatabase('appdb', grantsWithin({
        userPrivileges: [{ PRIVILEGE_TYPE: privilege, IS_GRANTABLE: 'NO' }],
      })), 403, /全局权限/)
    }
  })
  it('IS_GRANTABLE=YES（GRANT OPTION）必须拒绝', () => {
    expectReject(() => assertSqlGrantsWithinDatabase('appdb', grantsWithin({
      schemaPrivileges: [{ TABLE_SCHEMA: 'appdb', IS_GRANTABLE: 'YES' }],
    })), 403, /超出目标数据库/)
    expectReject(() => assertSqlGrantsWithinDatabase('appdb', grantsWithin({
      userPrivileges: [{ PRIVILEGE_TYPE: 'USAGE', IS_GRANTABLE: 'YES' }],
    })), 403, /超出目标数据库/)
  })
  it('仅目标库授权放行（面板自建账号的单库 GRANT 形态）', () => {
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'TRIGGER']
    expect(() => assertSqlGrantsWithinDatabase('appdb', grantsWithin({
      schemaPrivileges: privileges.map((privilege) => ({ PRIVILEGE_TYPE: privilege, TABLE_SCHEMA: 'appdb', IS_GRANTABLE: 'NO' })),
    }))).not.toThrow()
  })
})

describe('SQL 终端黑名单（带字符串态的注释归一）', () => {
  it('字符串里的 # 与 -- 不是注释起点，其后可执行的禁词必须照常拦截', () => {
    expectReject(() => validateSqlTerminalStatement(`select '#', load_file("/etc/passwd")`), 403, /禁止/)
    expectReject(() => validateSqlTerminalStatement(`select 'a-- ', load_file("/etc/passwd")`), 403, /禁止/)
    expectReject(() => validateSqlTerminalStatement(`select "#", load_file('/etc/passwd')`), 403, /禁止/)
  })
  it('注释分隔的禁词必须拦截', () => {
    expectReject(() => validateSqlTerminalStatement('USE/**/otherdb'), 403, /禁止/)
    expectReject(() => validateSqlTerminalStatement('SET /*x*/GLOBAL x=1'), 403, /禁止/)
    expectReject(() => validateSqlTerminalStatement('select load_file /*x*/ ("/etc/passwd")'), 403, /禁止/)
    expectReject(() => validateSqlTerminalStatement(`CREATE /*x*/FUNCTION f RETURNS int SONAME 'x.so'`), 403, /禁止/)
  })
  it('原有禁词形态保持拦截', () => {
    expectReject(() => validateSqlTerminalStatement(`LOAD DATA LOCAL INFILE '/etc/passwd' INTO t`), 403, /禁止/)
    expectReject(() => validateSqlTerminalStatement(`SELECT * FROM t INTO OUTFILE '/tmp/x'`), 403, /禁止/)
  })
  it('正常语句放行，字符串内的注释字符与转义不误伤', () => {
    for (const sql of ['SELECT 1', 'SELECT * FROM t /* 正常 */', 'SELECT "a#b", 1', `SELECT 'it''s', 'a\\'b\\''`]) {
      expect(() => validateSqlTerminalStatement(sql)).not.toThrow()
    }
  })
  it('未闭合块注释按 400 拒绝，超过 64 KiB 拒绝', () => {
    expectReject(() => validateSqlTerminalStatement('SELECT /* x'), 400, /注释未闭合/)
    expect(() => validateSqlTerminalStatement(`SELECT ${'x'.repeat(70_000)}`)).toThrow('64 KiB')
  })
})
