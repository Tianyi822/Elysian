package harness

import (
	"sort"

	"elysian/server/internal/agent/tools"
)

// ordinaryDatabaseTool 是当前聊天可用的数据库工具精确名单（实例发现与部署）。新建会话默认
// 带入；续聊与编辑重发经 withDatabaseTools 补齐，否则模型会被 create_service 的指引引向一个
// 搜不到的部署工具。与 Docker 工具同法：只补已审核的名字，不回写会话环境。
func ordinaryDatabaseTool(s tools.PublicSchema) bool {
	if s.Metadata.Domain != "database" || s.Metadata.Exposure != "agent" {
		return false
	}
	switch s.Name {
	case "database_instances", "database_provision":
		return true
	}
	return false
}

// withDatabaseTools 在环境副本中补齐已审核的数据库工具；保存的环境与已接受快照不变。
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

// retiredDatabaseTools 是随数据库页收敛退役的 13 个独立数据库工具：描述符与处理器保留在
// 宿主注册表供旧 Run 按固定快照派发，新聊天不再发现或继承。退役按精确名单而不是
// database_ 前缀：当前的实例发现与部署工具和它们共用前缀。
var retiredDatabaseTools = map[string]bool{
	"database_list": true, "database_metadata": true, "database_metrics": true, "database_discover": true,
	"database_create": true, "database_reconcile": true, "database_remove": true, "database_container_remove": true,
	"database_start": true, "database_stop": true,
	"database_task_status": true, "database_task_logs": true, "database_task_cancel": true,
}

func retiredDatabaseTool(name string) bool { return retiredDatabaseTools[name] }
