package websites

import (
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"encoding/json"
	"errors"
)

func (s *Service) agentDescriptors() []tools.Descriptor {
	if s.deps.Facade == nil {
		return nil
	}
	text := tools.Schema{Type: tools.SchemaString}
	config := tools.Schema{Type: tools.SchemaObject, Required: []string{"candidateId", "target", "command", "skipTests"}, Properties: map[string]tools.Schema{
		"candidateId": text, "buildVersion": text, "runtimeVersion": text, "toolVersion": text, "entry": text, "artifact": text,
		"target": {Type: tools.SchemaString, Enum: tools.EnumOf("static", "service")}, "command": text, "skipTests": {Type: tools.SchemaBoolean},
		"testSteps": {Type: tools.SchemaArray, Items: &text}, "buildSteps": {Type: tools.SchemaArray, Items: &text},
	}}
	deployment := tools.Schema{Type: tools.SchemaObject, Required: []string{"sourceId", "requestId", "name", "port", "access", "config"}, Properties: map[string]tools.Schema{
		"sourceId": text, "projectId": text, "requestId": text, "name": text, "port": {Type: tools.SchemaInteger}, "note": text, "config": config,
		"access": {Type: tools.SchemaObject, Required: []string{"mode"}, Properties: map[string]tools.Schema{"mode": {Type: tools.SchemaString, Enum: tools.EnumOf("direct", "domain")}, "domain": text}},
	}}
	var descriptors []tools.Descriptor
	for _, spec := range []struct {
		name, action, description string
		write, async              bool
		required                  []string
	}{
		{"website_runtimes", "runtimes", "读取官方精确版本运行时目录", false, false, nil},
		{"website_source_get", "source", "读取已准备来源及其完整分析报告，不含来源地址或凭据", false, false, []string{"sourceId"}},
		{"website_source_analysis", "source", "读取已准备来源的候选项目、入口、测试和构建建议；不获取新来源", false, false, []string{"sourceId"}},
		{"website_deployment_submit", "deploy", "审批后提交网站部署；已有项目使用精确项目ID，新项目使用精确授权名称且仅直连；源码、构建和启动命令固定在本次审批中", true, true, []string{"id", "deployment"}},
		{"website_deployments_list", "tasks", "读取网站项目部署任务摘要", false, false, []string{"id"}},
		{"website_deployment_get", "task", "读取指定网站项目的部署任务状态", false, false, []string{"id", "taskId"}},
		{"website_deployment_cancel", "cancel", "审批后请求取消指定网站部署，回执不代表清理已经结束", true, true, []string{"id", "taskId"}},
		{"website_deployment_logs", "task_logs", "读取部署阶段、时间与测试结果的有界结构化日志，秘密风险自由输出不进入模型", false, false, []string{"id", "taskId"}},
		{"website_logs", "logs", "读取网站当前与上一版本的结构化日志状态，应用自由输出不进入模型", false, false, []string{"id"}},
		{"website_access_set", "access", "审批后切换直连或域名访问；只复用管理员已配置且适用于目标域名的证书，不接受密钥原文", true, false, []string{"id", "mode", "domain"}},
		{"website_rollback", "rollback", "审批后将指定网站回滚到精确上一成功版本，稳定请求标识防止重复回滚", true, true, []string{"id", "requestId", "releaseId"}},
		{"website_start", "start", "审批后启动已有网站项目", true, false, []string{"id"}},
		{"website_stop", "stop", "审批后停止已有网站项目", true, false, []string{"id"}},
		{"website_remove", "remove", "审批后删除已有网站及数据", true, false, []string{"id"}},
	} {
		spec := spec
		properties := map[string]tools.Schema{}
		for _, key := range spec.required {
			if key == "deployment" {
				properties[key] = deployment
			} else {
				properties[key] = text
			}
		}
		if spec.action == "logs" || spec.action == "task_logs" {
			properties["cursor"] = text
			properties["limit"] = tools.Schema{Type: tools.SchemaInteger}
		}
		effect := "read"
		if spec.write {
			effect = "write"
		}
		metadata := tools.Metadata{Domain: "website", Backend: "domain", Action: spec.action, Effect: effect, Exposure: "agent", ReadOnly: !spec.write, Async: spec.async, Version: "1", ResourceType: "website", ResourceKeyArgument: "id"}
		if spec.action == "tasks" {
			metadata.Action, metadata.TaskDomain = "task_list", "website"
		}
		if spec.action == "task" || spec.action == "task_logs" {
			metadata.Action = "task_status"
			if spec.action == "task_logs" {
				metadata.Action = "task_logs"
			}
			metadata.TaskDomain, metadata.TaskIDArgument = "website", "taskId"
		}
		if spec.async {
			metadata.TaskDomain = "website"
			if spec.action == "deploy" {
				metadata.TaskRequestArgument = "/deployment/requestId"
			} else if spec.action == "rollback" {
				metadata.TaskRequestArgument = "requestId"
			} else {
				metadata.Action = "cancel"
				metadata.TaskIDArgument = "taskId"
			}
		}
		if spec.action == "runtimes" || spec.action == "source" {
			metadata.ResourceType, metadata.ResourceKeyArgument = "", ""
			metadata.Default = true
		}
		descriptors = append(descriptors, tools.Descriptor{Name: spec.name, Description: spec.description, Parameters: tools.Schema{Type: tools.SchemaObject, Required: spec.required, Properties: properties}, Metadata: metadata, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			raw, err := json.Marshal(args)
			if err != nil {
				return nil, err
			}
			value, err := s.deps.Facade.Call(tools.Lifetime(c), spec.action, raw)
			if err != nil || !spec.async {
				return value, err
			}
			fields, ok := value.(map[string]any)
			if !ok {
				return nil, errors.New("网站任务回执无效")
			}
			id, _ := fields["id"].(string)
			requestID, _ := fields["requestId"].(string)
			return tools.Submission{Value: value, Task: tools.TaskReference{Domain: "website", ID: id, RequestID: requestID}}, nil
		}})
	}
	return descriptors
}
