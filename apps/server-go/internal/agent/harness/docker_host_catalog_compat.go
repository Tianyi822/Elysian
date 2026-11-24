package harness

import (
	"encoding/json"

	hstate "elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/tools"
)

// restoreHostScopeSchema reverses only the audited host-scope descriptor changes.
func restoreHostScopeSchema(current tools.PublicSchema) (tools.PublicSchema, bool) {
	var beforeVersion, afterVersion, beforeDescription, afterDescription string
	switch current.Name {
	case "docker_container_logs":
		beforeVersion, afterVersion = "1", "2"
		beforeDescription = "只读读取面板纳管容器的最近日志（stdout 与 stderr 合并、带时间戳）；缺省 100 行最多 500 行、结果上限 64 KiB 保最新；需完整 64 位容器 ID，未纳管容器拒绝"
		afterDescription = "只读读取指定本机容器的最近日志，含用户自装容器；面板自身与内部容器拒绝。日志可能含应用打印的凭据；缺省 100 行，最多 500 行及 64 KiB，需完整容器 ID"
	case "docker_container_power":
		beforeVersion, afterVersion = "1", "2"
		beforeDescription = "审批后对已授权的安全容器执行 start、stop 或 restart；受管数据库与网站容器先按所属领域登记核验再路由"
		afterDescription = "按本轮授权启停或重启指定本机容器，含用户自装容器；受管数据库与网站按所属域登记路由；面板自身与内部容器拒绝"
	case "docker_container_remove":
		beforeVersion, afterVersion = "3", "4"
		beforeDescription = "审批后对已授权的安全容器执行 remove；支持停止态受管数据库容器及专属卷删除，无需先删除逻辑库；保留登记、兄弟库和容器卷身份核验"
		afterDescription = "按本轮授权删除指定本机容器；通用容器须已停止，保留卷；受管数据库经登记、兄弟库和专属卷身份核验；面板自身与内部容器拒绝"
	case "docker_container_exec":
		beforeVersion, afterVersion = "3", "4"
		beforeDescription = "在精确受管容器中执行argv命令。受管数据库容器禁止任意argv。requestId精确重试复用。异步等待由系统监视器完成。"
		afterDescription = "按本轮授权在指定本机容器中执行 argv，含用户自装容器；面板自身、内部容器、受管数据库和网站拒绝。回执标注目标风险；相同请求复用 requestId，异步等待真实终态"
	case "docker_container_inspect":
		beforeVersion, afterVersion = "4", "5"
		beforeDescription = "只读查看本机指定完整 ID 容器的状态、镜像、端口、启动时间与重启策略；不返回环境变量、启动命令或挂载内容"
		afterDescription = "只读查看指定本机容器，含用户自装容器；detail=true 返回健康、资源、网络、挂载及风险摘要。面板自身与内部容器拒绝"
	default:
		return current, false
	}
	if current.Metadata.Version != afterVersion || current.Description != afterDescription {
		return current, false
	}
	if current.Name == "docker_container_inspect" {
		// Clone before removing detail; the registry owns the input map.
		var parameters map[string]any
		raw, err := json.Marshal(current.Parameters)
		if err != nil || json.Unmarshal(raw, &parameters) != nil {
			return current, false
		}
		properties, ok := parameters["properties"].(map[string]any)
		detail := tools.Schema{Type: tools.SchemaBoolean}
		if !ok || hstate.DigestJSON(properties["detail"]) != hstate.DigestJSON(detail.JSONSchema()) {
			return current, false
		}
		delete(properties, "detail")
		current.Parameters = parameters
	}
	current.Metadata.Version, current.Description = beforeVersion, beforeDescription
	return current, true
}
