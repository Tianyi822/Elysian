/** 供 tsc 解析 bun:sqlite；运行时由 Bun 提供。 */
declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean })
    exec(sql: string): void
    prepare(sql: string): Statement
    close(): void
  }

  export interface Statement {
    run(...params: unknown[]): void
    all(...params: unknown[]): unknown[]
  }
}
