package firewall

import (
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
)

func (s *Service) agentDescriptors() []tools.Descriptor {
	var descriptors []tools.Descriptor
	for _, spec := range []struct {
		name, action, description string
		write                     bool
	}{
		{"firewall_snapshot", "snapshot", "读取防火墙状态与规则，不含用户备注", false},
		{"firewall_rule_ensure", "rule-ensure", "审批后为一个业务 IP 和非特权端口补精确入站放行；id 格式为 tcp:8080:10.0.0.2，禁止 SSH 与面板入口", true},
		{"firewall_ip_unblock", "ip-unblock", "审批后解封一个规范业务 IP，不关闭防火墙或扫描保护", true},
	} {
		spec := spec
		properties := map[string]tools.Schema{}
		required := []string{}
		effect := "read"
		if spec.write {
			properties["id"] = tools.Schema{Type: tools.SchemaString}
			required = append(required, "id")
			effect = "write"
		}
		descriptors = append(descriptors, tools.Descriptor{Name: spec.name, Description: spec.description, Parameters: tools.Schema{Type: tools.SchemaObject, Required: required, Properties: properties}, Metadata: tools.Metadata{Domain: "firewall", Action: spec.action, Effect: effect, Exposure: "agent", ResourceType: "firewall", ResourceKeyArgument: "id", ReadOnly: !spec.write, Default: !spec.write, Version: "1"}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			id, _ := tools.StringArg(args, "id")
			switch spec.action {
			case "snapshot":
				return s.deps.Facade.Snapshot(tools.Lifetime(c))
			case "rule-ensure":
				return s.deps.Facade.EnsureRule(tools.Lifetime(c), id)
			default:
				return s.deps.Facade.UnblockIP(tools.Lifetime(c), id)
			}
		}})
	}
	return descriptors
}
