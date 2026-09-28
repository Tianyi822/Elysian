/** 供 tsc 解析 bun:sqlite；运行时由 Bun 提供。 */
declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean; strict?: boolean })
    exec(sql: string): void
    run(sql: string): { changes: number; lastInsertRowid: number }
    query(sql: string): Statement
    prepare(sql: string): Statement
    close(throwOnError?: boolean): void
  }

  export interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number }
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    iterate(...params: unknown[]): Iterable<unknown>
    finalize(): void
    columnNames: string[]
  }
}
