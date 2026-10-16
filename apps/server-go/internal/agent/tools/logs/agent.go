package logs

import (
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
)

func (s *Service) agentDescriptors() []tools.Descriptor {
	return []tools.Descriptor{{Name: "logs_read", Description: "读取最多 100 条结构化日志事实，省略可能含凭据的正文、摘要、目标和用户代理", Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"category", "limit"}, Properties: map[string]tools.Schema{"category": {Type: tools.SchemaString, Enum: tools.EnumOf("runtime", "operation", "login")}, "limit": {Type: tools.SchemaInteger}}}, Metadata: tools.Metadata{Domain: "logs", Action: "read", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
		category, _ := tools.StringArg(args, "category")
		limit, _ := tools.IntArg(args, "limit")
		return s.deps.Facade.Read(tools.Lifetime(c), category, limit)
	}}}
}
