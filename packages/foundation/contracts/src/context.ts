/**
 * 服务容器。Cordis 里服务通过 `declare module` 把键挂到 `Context` 上，
 * 本包保持同样的扩展方式：`Context` 是开放接口，各域用
 *
 * ```ts
 * declare module '@elysian/contracts' {
 *   interface Context { myService: MyService }
 * }
 * ```
 *
 * 追加自己的键。本包已按同样方式在 `context-services.ts` 里挂载本期需要的三个服务，
 * 键名与未来的真实 Cordis 服务保持一致，替换时只换实现，不换名字。
 */
export interface Context {}
