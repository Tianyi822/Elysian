/** 供 tsc 解析 Bun.spawn；运行时由 Bun 提供，只声明本仓库用到的形状（与 bun-serve.d.ts、bun-sqlite.d.ts 同一纪律）。 */
declare module 'bun' {
  /** Bun.spawn 的管道形态返回值：stdin 是 FileSink，stdout 可异步迭代，exited 是退出码 Promise。 */
  interface BunSpawnProcess {
    stdin: { write(text: string): number; flush(): number }
    stdout: AsyncIterable<Uint8Array>
    exited: Promise<number>
    kill(signal?: number | string): void
    send(message: unknown): void
  }

  export function spawn(
    commands: readonly string[],
    options: {
      stdin: 'pipe'
      stdout: 'pipe'
      stderr: 'pipe'
      env?: Record<string, string>
      cwd?: string
    },
  ): BunSpawnProcess

  export function spawn(options: {
    cmd: readonly string[]
    uid?: number
    gid?: number
    env?: Record<string, string>
    stdin: 'ignore'
    stdout: 'ignore'
    stderr: 'ignore'
    ipc(message: unknown): void
    onExit(): void
  }): BunSpawnProcess

  export function file(path: string): { stream(): ReadableStream<Uint8Array> }
}
