// Package database 实现 /api/databases 片：服务型数据库（MariaDB/MySQL/Redis 容器
// 生命周期、协议核对与终端）与 SQLite 托管（自身二进制 `__sqlite-worker` 子命令 +
// uid 2001 降权 + stdin/stdout JSON 行 IPC，对应 cmd/elysian 的子命令分发）。
// 行为权威是 .zcode/go-migration/inventories/database.md 盘点；错误消息为逐字契约。
package database
