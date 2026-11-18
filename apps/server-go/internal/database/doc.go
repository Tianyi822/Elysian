// Package database 实现 /api/databases 片：数据库容器（以 Docker 容器清单为事实源
// 的发现、创建、启停核对与删除，凭据来自 databases.json 登记行）与 SQLite 托管
// （自身二进制 `__sqlite-worker` 子命令 + uid 2001 降权 + stdin/stdout JSON 行 IPC，
// 对应 cmd/elysian 的子命令分发）。MySQL/Redis 协议层、SQL 终端与逻辑库操作已退役。
// 错误消息为逐字契约。
package database
