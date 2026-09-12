/**
 * 跨端领域协议（@elysian/contracts）。
 *
 * 本包是浏览器侧与未来服务端共享的稳定协议层，必须保持零运行时依赖：
 * 不依赖 React、DOM 或任何运行时库，只放类型、枚举、纯常量表与纯函数。
 * 「零依赖」由 `apps/web/src/contracts/shared-contracts.test.ts` 守着。
 */

export * from './enums'
export * from './domain'
export * from './modules'
export * from './events'
export * from './context'
export * from './context-services'
