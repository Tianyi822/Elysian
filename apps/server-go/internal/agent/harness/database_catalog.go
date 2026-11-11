package harness

import "strings"

// 数据库处理器只供已接受的旧快照恢复；新聊天不再发现或继承独立数据库工具。
func retiredDatabaseTool(name string) bool { return strings.HasPrefix(name, "database_") }
