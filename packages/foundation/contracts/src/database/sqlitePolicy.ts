/*
 * SQLite 只读 PRAGMA 白名单：数据库终端允许裸查询的 PRAGMA 名单，全大写。
 * 服务端 SQL 校验（READ_PRAGMAS）与前端 SQL 会话的 Tab 补全词表共用这一份来源，
 * 两端不得各自维护清单——否则补全推荐的语句会在服务端被 403 拒绝。
 * 裸查询只读：赋值（PRAGMA name=value）与调用（PRAGMA name(value)）形态由
 * 服务端校验另行拦截，本表只放允许读取事实的 PRAGMA。
 */

export const SQLITE_READ_PRAGMAS = [
  'TABLE_INFO',
  'TABLE_XINFO',
  'INDEX_LIST',
  'INDEX_INFO',
  'INDEX_XINFO',
  'FOREIGN_KEY_LIST',
  'DATABASE_LIST',
  'USER_VERSION',
  'PAGE_SIZE',
  'JOURNAL_MODE',
] as const satisfies readonly string[]
