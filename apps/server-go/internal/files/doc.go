// Package files 实现 /api/files 文件管理片：容器/VM 文件系统的列表、搜索、读写、
// 目录锚点复验与写禁区（常量与 homeDir 推导，不读 ELYSIAN_DOCKER_MOUNT_ROOT）。
// 行为权威是 .zcode/go-migration/inventories/files.md 盘点。
//
// 骨架阶段本包只声明存在；路由、服务与测试由 files 域实现者替换本占位。
package files
