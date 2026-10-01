// Package files 实现 /api/files 文件管理片：容器/VM 文件系统的列表、搜索、读写、
// 目录锚点复验与写禁区（常量与 homeDir 推导，不读 ELYSIAN_DOCKER_MOUNT_ROOT）。
// 行为权威是 .zcode/go-migration/inventories/files.md 盘点；错误文案逐字对齐。
//
// 结构与 TS 版（apps/server/src/files）一一对应：
//   - paths.go     纯路径判据（filesPaths.ts）
//   - contract.go  契约判据（@elysian/contracts 的 files/users 纯函数；contract 公共层
//     尚未提供，域内私用副本，缺口已登记 gaps 由集成阶段上提）
//   - walk.go      受限遍历原语（fileTreeWalk.ts）
//   - hostdeps.go  宿主访问注入形状与真实接线（filesHostDeps.ts + noFollowFs）
//   - service.go   服务编排（filesService.ts）
//   - routes.go    路由分发与守卫链（filesRoutes.ts）
package files
