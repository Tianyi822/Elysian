import { describe, expect, it } from 'vitest'
import { validateSqliteStatement } from './sqliteSqlPolicy.ts'

describe('SQLite 终端 SQL 边界', () => {
  it('允许数据库内查询、写入、DDL 与多行单语句', () => {
    for (const sql of [
      'SELECT 1;', 'WITH rows(x) AS (SELECT 1) SELECT x FROM rows',
      "INSERT INTO notes VALUES ('a;b')", 'CREATE TABLE notes (id INTEGER, value TEXT)',
      'CREATE INDEX notes_id ON notes(id)', 'ALTER TABLE notes ADD COLUMN extra TEXT',
      'BEGIN', 'ROLLBACK', 'SELECT\n  1 /* ; ATTACH */ + 2;',
    ]) expect(() => validateSqliteStatement(sql)).not.toThrow()
  })

  it('放行前端补全词表推荐的只读 PRAGMA 裸查询', () => {
    for (const sql of ['PRAGMA page_size', 'PRAGMA journal_mode'])
      expect(() => validateSqliteStatement(sql)).not.toThrow()
  })

  it('只读 PRAGMA 的赋值与调用形态仍然拒绝', () => {
    for (const sql of ['PRAGMA journal_mode=WAL', 'PRAGMA page_size=4096'])
      expect(() => validateSqliteStatement(sql)).toThrow()
  })

  it('拒绝跨文件、扩展、危险 PRAGMA、触发器及多语句', () => {
    for (const sql of [
      "ATTACH DATABASE '/etc/passwd' AS other", 'SELECT 1; DELETE FROM notes',
      "SELECT load_extension('/tmp/x')", "VACUUM INTO '/tmp/copy.db'",
      'PRAGMA writable_schema=ON', 'PRAGMA user_version(5)',
      'CREATE VIRTUAL TABLE x USING fts5(value)', 'CREATE TRIGGER x AFTER INSERT ON notes BEGIN SELECT 1; END',
      'SELECT 1; /* comment */ DELETE FROM notes',
    ]) expect(() => validateSqliteStatement(sql)).toThrow()
  })

  it('拒绝双引号、方括号包裹的禁词函数与关键字', () => {
    for (const sql of [
      'SELECT "readfile"("/etc/passwd")',
      'SELECT "load_extension"("/tmp/x.so")',
      'CREATE "VIRTUAL" TABLE x USING fts5(v)',
      "SELECT [writefile]('/tmp/x')",
      'SELECT `load_extension`("/tmp/x.so")',
    ]) expect(() => validateSqliteStatement(sql)).toThrow()
  })

  it('放行合法带引号标识符，单引号字符串内容不参与判定', () => {
    for (const sql of [
      'SELECT "value" FROM "notes"',
      "SELECT 'readfile'",
      'SELECT `value` FROM [notes]',
      "SELECT \"read\"\"file\"('/tmp/x')",
    ]) expect(() => validateSqliteStatement(sql)).not.toThrow()
  })
})
