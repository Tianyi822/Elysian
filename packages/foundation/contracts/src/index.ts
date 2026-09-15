/**
 * 跨端领域协议（@elysian/contracts）。
 *
 * 本包是浏览器侧与未来服务端共享的稳定协议层，必须保持零运行时依赖：
 * 不依赖 React、DOM 或任何运行时库，只放类型、枚举、纯常量表与纯函数。
 * 「零依赖」由 `apps/web/src/contracts/shared-contracts.test.ts` 守着。
 *
 * 内部相对导入带 .ts 扩展名是有意的：这样 Node 的原生类型擦除也能直接加载本包，
 * 构建工具与 Node 走同一条解析路径，避免「打包能过、Node 报 ERR_MODULE_NOT_FOUND」。
 */

export * from './enums.ts'
export * from './domain.ts'
export * from './modules.ts'
export * from './events.ts'
export * from './context.ts'
export * from './context-services.ts'
export * from './containers.ts'
export * from './databases.ts'
