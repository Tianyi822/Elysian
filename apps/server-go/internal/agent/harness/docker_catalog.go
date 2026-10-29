package harness

import (
	"sort"

	"elysian/server/internal/agent/tools"
)

// 普通聊天只补齐经内核审核的 Docker 工具；定义和处理器仍由宿主注入的 kardia 注册表提供。
// 新建、续聊与编辑重发共用；不改写会话环境，不修改已接受 Run 或工作流快照。
func ordinaryDockerTool(s tools.PublicSchema) bool {
	if s.Metadata.Domain != "docker" || s.Metadata.Exposure != "agent" {
		return false
	}
	switch s.Name {
	case "docker_containers_list", "docker_images_list", "docker_policy_view", "docker_self_container", "registry_host_check",
		"docker_container_inspect", "docker_image_inspect", "docker_container_create_restricted",
		"docker_container_start", "docker_container_stop", "docker_container_restart", "docker_container_remove",
		"docker_image_search", "docker_image_tags", "docker_image_pull", "docker_image_pull_get", "docker_image_pull_logs", "docker_image_pull_cancel", "docker_image_remove":
		return true
	}
	return false
}

func (m *Manager) withDockerTools(env Environment) Environment {
	if m.deps.Tools == nil {
		return env
	}
	var names []string
	for _, schema := range m.deps.Tools.Schemas() {
		if ordinaryDockerTool(schema) && !contains(env.Tools, schema.Name) {
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
