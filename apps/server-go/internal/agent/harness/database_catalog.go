package harness

import (
	"sort"

	"elysian/server/internal/agent/tools"
)

// 普通聊天只补齐经内核审核的 database 工具；定义和处理器仍由宿主注入的 kardia 注册表提供。
// 新建、续聊与编辑重发共用；不改写会话环境，不修改已接受 Run 或工作流快照。
func ordinaryDatabaseTool(s tools.PublicSchema) bool {
	if s.Metadata.Domain != "database" || s.Metadata.Exposure != "agent" {
		return false
	}
	switch s.Name {
	case "database_list", "database_metadata", "database_metrics", "database_discover",
		"database_create", "database_reconcile", "database_remove", "database_container_remove",
		"database_start", "database_stop", "database_task_status", "database_task_logs", "database_task_cancel":
		return true
	}
	return false
}

func (m *Manager) withDatabaseTools(env Environment) Environment {
	if m.deps.Tools == nil {
		return env
	}
	var names []string
	for _, schema := range m.deps.Tools.Schemas() {
		if ordinaryDatabaseTool(schema) && !contains(env.Tools, schema.Name) {
			names = append(names, schema.Name)
		}
	}
	if len(names) == 0 {
		return env
	}
	sort.Strings(names)
	env.Tools = append(append([]string(nil), env.Tools...), names...)
	return env
}
