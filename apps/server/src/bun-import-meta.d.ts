/** 供 tsc 解析 import.meta.main（Bun 直跑脚本入口的判别）；运行时由 Bun 提供，被 import 时为 undefined。 */
interface ImportMeta {
  /** Bun 以入口身份直跑本文件时为 true；被其他模块 import（含 vitest）时为 undefined/false。 */
  readonly main?: boolean
}
