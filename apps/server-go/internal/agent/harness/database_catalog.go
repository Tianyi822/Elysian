package harness

import "strings"

// 数据库处理器只供已接受的旧快照恢复；新聊天不再发现或继承独立数据库工具。
// 使用副本过滤，避免修改旧会话环境、审批或 Run 的固定目录。
func withoutRetiredDatabaseTools(env Environment) Environment {
	filter := func(names []string) []string {
		if names == nil {
			return nil
		}
		kept := make([]string, 0, len(names))
		for _, name := range names {
			if !retiredDatabaseTool(name) {
				kept = append(kept, name)
			}
		}
		return kept
	}
	env.Tools = filter(env.Tools)
	env.TrustedReadOnly = filter(env.TrustedReadOnly)
	return env
}

func retiredDatabaseTool(name string) bool { return strings.HasPrefix(name, "database_") }
