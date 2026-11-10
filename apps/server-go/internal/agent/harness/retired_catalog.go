package harness

// retiredAgentTools 是已从新接受普通聊天退役的平台工具精确名单。
//
// 退役只影响新快照：描述符与处理器保留在宿主注册表，旧 Run 按固定快照恢复时仍可
// 派发；名字保留在 confirmedPlatformRead 中，维持旧快照只读调用的免审批语义。
// 与 database_ 前缀过滤不同，这里必须用精确名单：docker_、website_、app_ 前缀都
// 有保留工具共享，前缀匹配会误伤。
//
// 每项的承接关系：
//   - docker_container_start/stop/restart：收敛为 docker_container_power 单一入口
//     （id + action 枚举，逐动作审批）。
//   - docker_policy_view/docker_self_container：两条常量事实合并为
//     docker_context_view；旧名仍注册并保留在 legacy tool-batch 契约（allowed()、
//     RUNTIME_TOOL_NAMES）中，不受本名单影响。
//   - website_start/website_stop：并入 docker_container_power，经
//     seam.AgentWebsiteContainers 接缝按登记核验后路由 websites 服务；删除保持
//     website_remove 专属入口。
//   - website_source_analysis：与 website_source_get 派发同一后端动作、同一返回体。
//   - website_deployment_logs：两条结构化事件是 website_deployment_get 任务投影的
//     真子集，任务终态另由监视器写回 Run。
//   - docker_image_pull_logs：日志页仅由 accepted/state 两条固定条目构造，拉取任务
//     回执 docker_image_pull_get 已含全部同源事实。
//   - registry_host_check：docker_registry_probe 探测前先执行同一套镜像源校验。
//   - app_build_logs：构建阶段事实已含在 build_get 的任务摘要中，自由构建输出本就
//     不进模型。
//   - app_directory：宿主目录字段已在 app_lookup 返回的登记记录中。
//   - app_workspace_remove_file：并入 app_workspace_write 升 v2（content 与 remove
//     服务端强制互斥），旧 v1 形状经 compat 白名单照旧派发。
//   - platform_memory/platform_metrics：收敛为 platform_sample（scope 枚举
//     process|host|both，缺省进程轻量路径）。
var retiredAgentTools = map[string]struct{}{
	"docker_container_start":    {},
	"docker_container_stop":     {},
	"docker_container_restart":  {},
	"docker_policy_view":        {},
	"docker_self_container":     {},
	"website_start":             {},
	"website_stop":              {},
	"website_source_analysis":   {},
	"website_deployment_logs":   {},
	"docker_image_pull_logs":    {},
	"registry_host_check":       {},
	"app_build_logs":            {},
	"app_directory":             {},
	"app_workspace_remove_file": {},
	"platform_memory":           {},
	"platform_metrics":          {},
}

// retiredFromNewChats 汇总新普通聊天不再注入的平台工具判定。
func retiredFromNewChats(name string) bool {
	if _, ok := retiredAgentTools[name]; ok {
		return true
	}
	return retiredDatabaseTool(name)
}

// withoutRetiredTools 使用副本过滤，避免修改旧会话环境、审批或 Run 的固定目录。
func withoutRetiredTools(env Environment) Environment {
	filter := func(names []string) []string {
		if names == nil {
			return nil
		}
		kept := make([]string, 0, len(names))
		for _, name := range names {
			if !retiredFromNewChats(name) {
				kept = append(kept, name)
			}
		}
		return kept
	}
	env.Tools = filter(env.Tools)
	env.TrustedReadOnly = filter(env.TrustedReadOnly)
	return env
}
