// Package database 实现 /api/databases 片：服务型数据库（MariaDB/MySQL/Redis 容器
// 生命周期与协议终端）与 SQLite 托管（自身二进制 worker 子命令 + uid 2001 隔离，
// 对应 cmd/elysian 的 `__sqlite-worker` 子命令分发）。
// 行为权威是 .zcode/go-migration/inventories/database.md 盘点。
//
// 骨架阶段本包只声明存在；路由、服务与测试由 database 域实现者替换本占位。
package database
