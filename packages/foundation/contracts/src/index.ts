/**
 * 跨端领域协议（@elysian/contracts）。
 *
 * 本包是浏览器侧与未来服务端共享的稳定协议层，必须保持零运行时依赖：
 * 不依赖 React、DOM 或任何运行时库，只放类型、枚举、纯常量表与纯函数。
 * 「零依赖」由 `apps/web/src/contracts/shared-contracts.test.ts` 守着。
 *
 * 内部按页面与功能域分目录：core/ 是跨页面基座（服务容器、事件总线、枚举标签、
 * 职责模块），dashboard/ 是事故与运行域，security/ 是安全区（防火墙、SSH、主机用户），
 * 其余目录一一对应资源页面（容器、数据库、文件、日志、网站）。
 * 对外一律从本入口导入，目录结构是内部组织细节。
 *
 * 内部相对导入带 .ts 扩展名是有意的：这样 Node 的原生类型擦除也能直接加载本包，
 * 构建工具与 Node 走同一条解析路径，避免「打包能过、Node 报 ERR_MODULE_NOT_FOUND」。
 */

// 跨页面基座
export * from './core/enums.ts'
export * from './core/modules.ts'
export * from './core/events.ts'
export * from './core/context.ts'
export * from './core/context-services.ts'
// 仪表盘：事故与 Agent 运行
export * from './dashboard/domain.ts'
// 资源页面
export * from './container/containers.ts'
export * from './container/shellWords.ts'
export * from './container/containerFields.ts'
export * from './container/imageReference.ts'
export * from './database/databases.ts'
export * from './database/sqlitePolicy.ts'
export * from './files/files.ts'
export * from './logs/logs.ts'
export * from './logs/logQuery.ts'
export * from './logs/platformLogs.ts'
export * from './terminal/grid.ts'
export * from './websites/websites.ts'
// 安全区
export * from './security/firewall.ts'
export * from './security/ssh.ts'
export * from './security/users.ts'
// 平台运行域：进程内存采样、宿主依赖检测
export * from './platform/memory.ts'
export * from './platform/dependencies.ts'

export * from './platform/panel.ts'
