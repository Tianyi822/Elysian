/** 供 tsc 解析 src/index.ts 的 Bun.serve；运行时由 Bun 提供，只声明本仓库用到的形状。 */
declare module 'bun' {
  export function serve(options: {
    hostname?: string
    port?: number
    fetch: (request: Request) => Response | Promise<Response>
  }): { hostname: string; port: number }
}
