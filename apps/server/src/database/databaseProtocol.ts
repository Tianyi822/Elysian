import mysql from 'mysql2/promise'
import mysqlCore from 'mysql2'
import { createClient, type RedisClientType } from 'redis'
import type { DatabaseRecord, DatabaseSecret } from './databaseRegistry.ts'
import { InvalidRequestError, invalidRequest } from '../shared/errors.ts'
import { openBoundedRedisTerminal } from './redisTerminalProtocol.ts'

export type DatabaseAddress = { host: string; port: number }
export type DatabaseMetrics = { sizeGb?: number; connections?: { active: number; max: number } }
export type DatabaseSession = { execute(input: string): Promise<string[]>; close(): Promise<void> }
export type DatabaseProtocol = {
  version(record: Pick<DatabaseRecord, 'engine'>, address: DatabaseAddress, credential: DatabaseSecret): Promise<string>
  create(record: DatabaseRecord, address: DatabaseAddress, charset?: string): Promise<void>
  verify(record: DatabaseRecord, address: DatabaseAddress): Promise<void>
  drop(record: DatabaseRecord, address: DatabaseAddress): Promise<void>
  hasOtherDatabases(record: DatabaseRecord, address: DatabaseAddress): Promise<boolean>
  metrics(record: DatabaseRecord, address: DatabaseAddress): Promise<DatabaseMetrics>
  session(record: DatabaseRecord, address: DatabaseAddress): Promise<DatabaseSession>
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const CHARSETS = new Set(['utf8mb4', 'utf8', 'latin1'])
const MAX_OUTPUT = 1024 * 1024
const MAX_ROWS = 500
const QUERY_TIMEOUT = 15_000

function sqlName(name: string): string {
  if (!NAME.test(name)) throw invalidRequest('数据库名或用户名只能使用英文字母、数字和下划线，并须以字母开头')
  return `\`${name}\``
}

async function sqlConnect(address: DatabaseAddress, credential: DatabaseSecret, database?: string) {
  return mysql.createConnection({
    host: address.host,
    port: address.port,
    user: credential.username,
    password: credential.password,
    database,
    multipleStatements: false,
    flags: ['-LOCAL_FILES'],
    connectTimeout: 5000,
    enableKeepAlive: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  })
}

function redisConnect(address: DatabaseAddress, credential: DatabaseSecret): Promise<RedisClientType> {
  const client = createClient({
    socket: { host: address.host, port: address.port, connectTimeout: 5000, reconnectStrategy: false },
    username: credential.username === 'default' ? undefined : credential.username,
    password: credential.password,
    database: 0,
  })
  // 容器外部停止或网络断开会异步发出 error；会话失败由调用方处理，避免事件杀死服务进程。
  client.on('error', () => undefined)
  return client.connect() as Promise<RedisClientType>
}

function parseRedisWords(input: string): string[] {
  const words: string[] = []
  const pattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g
  for (const match of input.matchAll(pattern)) {
    const value = match[0]
    words.push(value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1).replace(/\\([\\"'])/g, '$1') : value)
  }
  return words
}

const REDIS_FORBIDDEN = new Set([
  'ACL', 'CONFIG', 'MODULE', 'EVAL', 'EVALSHA', 'FCALL', 'FUNCTION', 'SCRIPT', 'DEBUG',
  'SHUTDOWN', 'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'FLUSHALL', 'FLUSHDB', 'SELECT',
  'MIGRATE', 'RESTORE', 'MOVE', 'COPY', 'SWAPDB', 'REPLICAOF', 'SLAVEOF', 'CLUSTER', 'CLIENT', 'MONITOR',
  'SYNC', 'PSYNC', 'COMMAND', 'HELLO', 'AUTH', 'QUIT', 'LATENCY', 'SLOWLOG', 'MEMORY',
  'EVAL_RO', 'EVALSHA_RO', 'FCALL_RO', 'PUBSUB', 'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE',
])

export function validateRedisTerminalCommand(input: string): string[] {
  const args = parseRedisWords(input)
  if (!args.length) throw invalidRequest('请输入 Redis 命令')
  if (args.join(' ').length > 64 * 1024) throw invalidRequest('命令超过 64 KiB')
  if (REDIS_FORBIDDEN.has(args[0]!.toUpperCase())) throw new InvalidRequestError(403, '该 Redis 管理命令不可在数据库终端执行')
  return args
}

/** INFORMATION_SCHEMA 四张授权视图的行。普通账号自查只能看到自己的权限行，这是 MySQL/MariaDB 的保证。 */
export type SqlGrantRows = {
  userPrivileges: { PRIVILEGE_TYPE?: string; IS_GRANTABLE?: string }[]
  schemaPrivileges: { TABLE_SCHEMA?: string; IS_GRANTABLE?: string }[]
  tablePrivileges: { TABLE_SCHEMA?: string; IS_GRANTABLE?: string }[]
  columnPrivileges: { TABLE_SCHEMA?: string; IS_GRANTABLE?: string }[]
}

/**
 * 接管核验的白名单判定：普通账号的授权必须完全落在目标逻辑库内。
 * 不解析 SHOW GRANTS 文本——表级 `otherdb`.`tab` 与通配庈权限行 `app%`/`%` 都不命中「库名.*」形态的文本规则，
 * 白名单改为要求 SCHEMA/TABLE/COLUMN_PRIVILEGES 的 TABLE_SCHEMA 与目标库名全等。
 */
export function assertSqlGrantsWithinDatabase(name: string, rows: SqlGrantRows): void {
  // USER_PRIVILEGES 是全局层授权：FILE/SUPER 与任何具体全局权限都在这里有行；USAGE 是无实权的占位，沿用豁免。
  for (const row of rows.userPrivileges) {
    if (String(row.PRIVILEGE_TYPE ?? '').toUpperCase() !== 'USAGE') {
      throw new InvalidRequestError(403, '普通账号拥有全局权限')
    }
  }
  // IS_GRANTABLE='YES' 即持有 GRANT OPTION，等价于旧文本规则里的 GRANT OPTION 匹配。
  for (const row of [...rows.userPrivileges, ...rows.schemaPrivileges, ...rows.tablePrivileges, ...rows.columnPrivileges]) {
    if (String(row.IS_GRANTABLE ?? '').toUpperCase() === 'YES') {
      throw new InvalidRequestError(403, '普通账号拥有超出目标数据库的权限')
    }
  }
  for (const row of [...rows.schemaPrivileges, ...rows.tablePrivileges, ...rows.columnPrivileges]) {
    if (String(row.TABLE_SCHEMA ?? '') !== name) {
      throw new InvalidRequestError(403, '普通账号拥有其他数据库权限')
    }
  }
}

/**
 * 带字符串态的注释归一：单引号、双引号、反引号的引号区间原样保留（区间内不识别注释标记），
 * 仅在区间外把 -- 行注释、# 行注释、闭合块注释各替换为一个空格，供黑名单在归一结果上匹配。
 * 无字符串态的朴素归一会把 `select '#', load_file(...)` 里的 # 当伪注释起点，吞掉其后真实可执行的 LOAD_FILE。
 * 反斜杠转义只在单双引号字符串内生效（MySQL 默认 NO_BACKSLASH_ESCAPES 关）；三种引号都支持翻倍转义；
 * 反引号标识符内反斜杠不是转义符，不做跳过。未闭合引号保留原文，交由服务端报语法错误。
 */
function normalizeSqlComments(input: string): string {
  const findQuoteEnd = (start: number, quote: string): number => {
    let i = start + 1
    while (i < input.length) {
      const char = input[i]!
      if ((quote === "'" || quote === '"') && char === '\\') { i += 2; continue }
      if (char === quote) {
        if (input[i + 1] === quote) { i += 2; continue }
        return i + 1
      }
      i++
    }
    return -1
  }
  let out = ''
  let i = 0
  while (i < input.length) {
    const char = input[i]!
    if (char === "'" || char === '"' || char === '`') {
      const end = findQuoteEnd(i, char)
      if (end < 0) { out += input.slice(i); break }
      out += input.slice(i, end)
      i = end
      continue
    }
    if (char === '-' && input[i + 1] === '-') {
      const newline = input.indexOf('\n', i + 2)
      i = newline < 0 ? input.length : newline
      out += ' '
      continue
    }
    if (char === '#') {
      const newline = input.indexOf('\n', i + 1)
      i = newline < 0 ? input.length : newline
      out += ' '
      continue
    }
    if (char === '/' && input[i + 1] === '*') {
      const end = input.indexOf('*/', i + 2)
      if (end < 0) throw invalidRequest('SQL 注释未闭合')
      i = end + 2
      out += ' '
      continue
    }
    out += char
    i++
  }
  return out
}

const SQL_TERMINAL_FORBIDDEN = /\b(?:LOAD\s+DATA|INTO\s+(?:OUTFILE|DUMPFILE)|LOAD_FILE\s*\(|INSTALL\s+PLUGIN|CREATE\s+FUNCTION|SET\s+GLOBAL|USE\s+)/i

/** 会话黑名单判定：先做带字符串态的注释归一再匹配禁词，拦截注释分隔（如 `SET /*x*\/GLOBAL`）与字符串伪装；执行仍送原文。 */
export function validateSqlTerminalStatement(input: string): void {
  if (Buffer.byteLength(input) > 64 * 1024) throw invalidRequest('SQL 超过 64 KiB')
  if (SQL_TERMINAL_FORBIDDEN.test(normalizeSqlComments(input))) {
    throw new InvalidRequestError(403, '数据库终端禁止文件、系统管理和跨库操作')
  }
}

export function createDatabaseProtocol(): DatabaseProtocol {
  async function version(record: Pick<DatabaseRecord, 'engine'>, address: DatabaseAddress, credential: DatabaseSecret) {
    if (record.engine === 'Redis') {
      const client = await redisConnect(address, credential)
      try {
        const info = await client.info('server')
        return /^redis_version:(.+)$/m.exec(info)?.[1]?.trim() ?? ''
      } finally { await client.disconnect() }
    }
    const connection = await sqlConnect(address, credential)
    try {
      const [rows] = await connection.query('SELECT VERSION() AS version')
      return String((rows as { version: string }[])[0]?.version ?? '')
    } finally { await connection.end() }
  }

  async function create(record: DatabaseRecord, address: DatabaseAddress, charset = 'utf8mb4') {
    if (record.engine === 'Redis') {
      // 面板创建的 Redis ACL 已随容器启动写入持久卷；接管路径绝不修改现有账号。
      return
    }
    if (!CHARSETS.has(charset)) throw invalidRequest('字符集不受支持')
    const connection = await sqlConnect(address, record.admin)
    try {
      await connection.query(`CREATE DATABASE ${sqlName(record.name)} CHARACTER SET ${charset}`)
      await connection.query(`CREATE USER ?@'%' IDENTIFIED BY ?`, [record.user.username, record.user.password])
      await connection.query(`GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE VIEW, SHOW VIEW, TRIGGER ON ${sqlName(record.name)}.* TO ?@'%'`, [record.user.username])
    } finally { await connection.end() }
  }

  async function verify(record: DatabaseRecord, address: DatabaseAddress) {
    if (record.engine === 'Redis') {
      const admin = await redisConnect(address, record.admin)
      try {
        const acl = await admin.sendCommand(['ACL', 'GETUSER', record.user.username])
        const parsed = Array.isArray(acl)
          ? Object.fromEntries(Array.from({ length: Math.floor(acl.length / 2) }, (_, index) => [String(acl[index * 2]), acl[index * 2 + 1]]))
          : (acl && typeof acl === 'object' ? acl as unknown as Record<string, unknown> : {})
        const commands = String(parsed.commands ?? '')
        const allPosition = commands.lastIndexOf('+@all')
        const flags = Array.isArray(parsed.flags) ? parsed.flags.map(String) : []
        const selectors = Array.isArray(parsed.selectors) ? parsed.selectors : []
        if (!commands || flags.includes('nopass') || selectors.length > 0 ||
            /\+@(?:admin|dangerous|scripting)\b|\+(?:acl|config|module|eval|evalsha|eval_ro|evalsha_ro|fcall|fcall_ro|function|script|debug|shutdown|flushall|flushdb|select|migrate|restore|move|copy|swapdb|replicaof|slaveof|cluster|monitor|sync|psync)\b/i.test(commands) ||
            (allPosition >= 0 && (commands.lastIndexOf('-@dangerous') < allPosition || commands.lastIndexOf('-@scripting') < allPosition || commands.lastIndexOf('-select') < allPosition || commands.lastIndexOf('-move') < allPosition || commands.lastIndexOf('-copy') < allPosition))) {
          throw new InvalidRequestError(403, '普通 Redis 账号权限过大或不存在')
        }
        // ACL 规则有顺序语义；用服务端 DRYRUN 核对最终生效权限，避免接管时被规则重排绕过。
        const forbidden: string[][] = [
          ['SELECT', '1'], ['MOVE', 'elysian_acl_probe', '1'],
          ['COPY', 'elysian_acl_probe', 'elysian_acl_probe_copy', 'DB', '1'],
          ['FLUSHDB'], ['CONFIG', 'GET', 'dir'], ['ACL', 'LIST'],
          ['EVAL', 'return 1', '0'], ['EVAL_RO', 'return 1', '0'],
        ]
        for (const command of forbidden) {
          const allowed = await admin.sendCommand(['ACL', 'DRYRUN', record.user.username, ...command])
          if (String(allowed) === 'OK') throw new InvalidRequestError(403, '普通 Redis 账号拥有跨库、管理或脚本权限')
        }
      } finally { await admin.disconnect() }
      const user = await redisConnect(address, record.user)
      try { await user.ping() } finally { await user.disconnect() }
      return
    }
    const admin = await sqlConnect(address, record.admin)
    try {
      const [rows] = await admin.query('SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?', [record.name])
      if (!(rows as unknown[]).length) throw new InvalidRequestError(404, '目标逻辑库已不存在')
    } finally { await admin.end() }
    const user = await sqlConnect(address, record.user, record.name)
    try {
      // 普通账号自查 INFORMATION_SCHEMA 只能看到自己的权限行；接管失败（查询异常或越权行）即拒绝。
      // 弃用 SHOW GRANTS 文本解析：表级 `otherdb`.`tab` 与通配库名 `app%` 均不命中「库名.*」正则。
      const grantRows = async (sql: string) => (await user.query(sql))[0] as SqlGrantRows['userPrivileges']
      assertSqlGrantsWithinDatabase(record.name, {
        userPrivileges: await grantRows('SELECT PRIVILEGE_TYPE, IS_GRANTABLE FROM INFORMATION_SCHEMA.USER_PRIVILEGES'),
        schemaPrivileges: await grantRows('SELECT TABLE_SCHEMA, IS_GRANTABLE FROM INFORMATION_SCHEMA.SCHEMA_PRIVILEGES'),
        tablePrivileges: await grantRows('SELECT TABLE_SCHEMA, IS_GRANTABLE FROM INFORMATION_SCHEMA.TABLE_PRIVILEGES'),
        columnPrivileges: await grantRows('SELECT TABLE_SCHEMA, IS_GRANTABLE FROM INFORMATION_SCHEMA.COLUMN_PRIVILEGES'),
      })
    } finally { await user.end() }
  }

  async function drop(record: DatabaseRecord, address: DatabaseAddress) {
    if (record.engine === 'Redis') {
      const client = await redisConnect(address, record.admin)
      try { await client.sendCommand(['FLUSHDB', 'ASYNC']) } finally { await client.disconnect() }
      return
    }
    const connection = await sqlConnect(address, record.admin)
    try {
      await connection.query(`DROP DATABASE IF EXISTS ${sqlName(record.name)}`)
      if (record.source === 'managed') await connection.query(`DROP USER IF EXISTS ?@'%'`, [record.user.username])
    } finally { await connection.end() }
  }

  async function hasOtherDatabases(record: DatabaseRecord, address: DatabaseAddress): Promise<boolean> {
    if (record.engine === 'Redis') {
      const client = await redisConnect(address, record.admin)
      try {
        const keyspace = await client.info('keyspace')
        return /^db(?!0:)[1-9]\d*:/m.test(keyspace)
      } finally { await client.disconnect() }
    }
    const connection = await sqlConnect(address, record.admin)
    try {
      const [rows] = await connection.query(
        "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') AND SCHEMA_NAME <> ? LIMIT 1",
        [record.name],
      )
      return (rows as unknown[]).length > 0
    } finally { await connection.end() }
  }

  async function metrics(record: DatabaseRecord, address: DatabaseAddress): Promise<DatabaseMetrics> {
    if (record.engine === 'Redis') {
      const client = await redisConnect(address, record.admin)
      try {
        const [memory, clients] = await Promise.all([client.info('memory'), client.info('clients')])
        return {
          sizeGb: Number(/^used_memory:(\d+)/m.exec(memory)?.[1] ?? '0') / 1024 ** 3,
          connections: { active: Number(/^connected_clients:(\d+)/m.exec(clients)?.[1] ?? '0'), max: 0 },
        }
      } finally { await client.disconnect() }
    }
    const connection = await sqlConnect(address, record.admin)
    try {
      const [sizes] = await connection.query('SELECT COALESCE(SUM(data_length + index_length),0) AS bytes FROM information_schema.tables WHERE table_schema = ?', [record.name])
      const [counts] = await connection.query("SHOW GLOBAL STATUS LIKE 'Threads_connected'")
      const [maximum] = await connection.query("SHOW GLOBAL VARIABLES LIKE 'max_connections'")
      return {
        sizeGb: Number((sizes as { bytes: number }[])[0]?.bytes ?? 0) / 1024 ** 3,
        connections: { active: Number((counts as { Value: string }[])[0]?.Value ?? 0), max: Number((maximum as { Value: string }[])[0]?.Value ?? 0) },
      }
    } finally { await connection.end() }
  }

  async function session(record: DatabaseRecord, address: DatabaseAddress): Promise<DatabaseSession> {
    if (record.engine === 'Redis') {
      return openBoundedRedisTerminal(address, record.user, validateRedisTerminalCommand)
    }
    const connection = mysqlCore.createConnection({
      host: address.host, port: address.port, user: record.user.username,
      password: record.user.password, database: record.name,
      multipleStatements: false, connectTimeout: 5000, enableKeepAlive: false,
      flags: ['-LOCAL_FILES'],
      supportBigNumbers: true, bigNumberStrings: true,
    })
    // 驱动在连接异常或主动中断后还可能异步发出 error；保持会话进程存活。
    connection.on('error', () => undefined)
    await new Promise<void>((resolve, reject) => connection.connect((error) => error ? reject(error) : resolve()))
    return {
      async execute(input) {
        validateSqlTerminalStatement(input)
        return new Promise<string[]>((resolve, reject) => {
          const output: string[] = []
          let bytes = 0
          let rows = 0
          let settled = false
          const fail = (error: Error) => {
            if (settled) return
            settled = true
            connection.destroy()
            reject(error)
          }
          const query = connection.query({ sql: input, timeout: QUERY_TIMEOUT, rowsAsArray: true })
          query.on('fields', (fields) => {
            if (!Array.isArray(fields)) return
            const line = (fields as unknown as { name: string }[]).map((field) => field.name).join('\t')
            bytes += Buffer.byteLength(line)
            output.push(line)
          })
          query.on('result', (result) => {
            if (settled) return
            rows += 1
            if (rows > MAX_ROWS) { fail(new Error('结果超过 500 行，已中断')); return }
            const line = Array.isArray(result) ? result.map(String).join('\t') : JSON.stringify(result)
            bytes += Buffer.byteLength(line)
            if (bytes > MAX_OUTPUT) { fail(new Error('结果超过 1 MiB，已中断')); return }
            output.push(line)
          })
          query.on('error', (error) => fail(error))
          query.on('end', () => { if (!settled) { settled = true; resolve(output) } })
        })
      },
      async close() { connection.destroy() },
    }
  }

  return { version, create, verify, drop, hasOtherDatabases, metrics, session }
}
