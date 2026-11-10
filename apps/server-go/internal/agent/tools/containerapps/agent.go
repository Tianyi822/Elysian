package containerapps

import (
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domainapps "elysian/server/internal/containerapps"
	"encoding/json"
	"errors"
)

const (
	appWorkspaceWriteV2Description     = "审批后写入普通配置文本或删除工作区内普通文件：content 与 remove 必须且只能提供一项，内容摘要不符时拒绝；不写凭据文件"
	appWorkspaceWriteRemoveDescription = "true 表示删除该普通文件；与 content 互斥，必须且只能提供一项"
)

// parseWorkspaceWriteArgs 解析 v2 互斥参数：content 与 remove 必须且只能提供一项。
// v1 快照调用必带 content、无 remove，天然落入写入分支。
func parseWorkspaceWriteArgs(args tools.Arguments) (content string, remove bool, err error) {
	content, hasContent := tools.StringArg(args, "content")
	remove, hasRemove := tools.BoolArg(args, "remove")
	if hasContent == hasRemove {
		return "", false, errors.New("content 与 remove 必须且只能提供一项")
	}
	if hasRemove {
		if !remove {
			return "", false, errors.New("remove 仅接受 true；写入内容请改提供 content")
		}
		return "", true, nil
	}
	return content, false, nil
}

func (s *Service) agentDescriptors() []tools.Descriptor {
	if s.facade == nil {
		return nil
	}
	text := tools.Schema{Type: tools.SchemaString}
	var descriptors []tools.Descriptor
	for _, spec := range []struct {
		name, description string
		write             bool
		keys              []string
	}{
		{"app_workspace_snapshot", "读取容器应用工作区的内容摘要，供审批时固定变更范围", false, []string{"slug"}},
		{"app_build_logs", "读取构建阶段与时间的有界结构化日志，自由构建输出不进入模型", false, []string{"slug", "taskId"}},
		{"app_workspace_create", "审批后创建精确标识的容器应用工作区", true, []string{"slug", "name"}},
		{"app_workspace_remove", "审批后删除工作区及全部内容，有进行中构建或摘要变化时拒绝", true, []string{"slug", "expectedDigest"}},
	} {
		spec := spec
		properties := map[string]tools.Schema{}
		for _, key := range spec.keys {
			properties[key] = text
		}
		if spec.name == "app_build_logs" {
			properties["cursor"] = text
			properties["limit"] = tools.Schema{Type: tools.SchemaInteger}
		}
		effect := "read"
		if spec.write {
			effect = "write"
		}
		metadata := tools.Metadata{Domain: "container-app", Backend: "domain", Action: spec.name, Effect: effect, Exposure: "agent", ResourceType: "container-app", ResourceKeyArgument: "slug", ReadOnly: !spec.write, Version: "1"}
		if spec.name == "app_build_logs" {
			metadata.Action, metadata.TaskDomain, metadata.TaskIDArgument = "task_logs", "container-app-build", "taskId"
		}
		descriptors = append(descriptors, tools.Descriptor{Name: spec.name, Description: spec.description, Parameters: tools.Schema{Type: tools.SchemaObject, Required: spec.keys, Properties: properties}, Metadata: metadata, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			ctx := tools.Lifetime(c)
			slug, _ := tools.StringArg(args, "slug")
			digest, _ := tools.StringArg(args, "expectedDigest")
			switch spec.name {
			case "app_build_logs":
				id, _ := tools.StringArg(args, "taskId")
				cursor, _ := tools.StringArg(args, "cursor")
				limit, _ := tools.IntArg(args, "limit")
				return s.facade.BuildLogs(ctx, slug, id, cursor, limit)
			case "app_workspace_snapshot":
				return s.facade.Snapshot(ctx, slug)
			case "app_workspace_create":
				name, _ := tools.StringArg(args, "name")
				return s.facade.Create(ctx, slug, name)
			default:
				if err := s.facade.Remove(ctx, slug, digest); err != nil {
					return nil, err
				}
				return map[string]bool{"removed": true}, nil
			}
		}})
	}
	// 工作区写与删合并为单一入口（v2）：content 与 remove 服务端强制互斥，
	// 必须且只能提供一项；v1 形状（必带 content）经 compat 白名单照旧派发。
	descriptors = append(descriptors, tools.Descriptor{
		Name:        "app_workspace_write",
		Description: appWorkspaceWriteV2Description,
		Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"slug", "path", "expectedDigest"}, Properties: map[string]tools.Schema{
			"slug": text, "path": text, "content": text, "expectedDigest": text,
			"remove": {Type: tools.SchemaBoolean, Description: appWorkspaceWriteRemoveDescription},
		}},
		Metadata: tools.Metadata{Domain: "container-app", Backend: "domain", Action: "app_workspace_write", Effect: "write", Exposure: "agent", ResourceType: "container-app", ResourceKeyArgument: "slug", Version: "2"},
		Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			slug, _ := tools.StringArg(args, "slug")
			path, _ := tools.StringArg(args, "path")
			digest, _ := tools.StringArg(args, "expectedDigest")
			content, remove, err := parseWorkspaceWriteArgs(args)
			if err != nil {
				return nil, err
			}
			return s.facade.Write(tools.Lifetime(c), slug, path, content, digest, remove)
		},
	})
	// 已退役的删除入口保留注册仅供旧快照恢复，形状与 v1 逐字一致。
	descriptors = append(descriptors, tools.Descriptor{
		Name:        "app_workspace_remove_file",
		Description: "审批后删除工作区内普通文件，内容摘要不符时拒绝",
		Parameters:  tools.Schema{Type: tools.SchemaObject, Required: []string{"slug", "path", "expectedDigest"}, Properties: map[string]tools.Schema{"slug": text, "path": text, "expectedDigest": text}},
		Metadata:    tools.Metadata{Domain: "container-app", Backend: "domain", Action: "app_workspace_remove_file", Effect: "write", Exposure: "agent", ResourceType: "container-app", ResourceKeyArgument: "slug", Version: "1"},
		Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			slug, _ := tools.StringArg(args, "slug")
			path, _ := tools.StringArg(args, "path")
			digest, _ := tools.StringArg(args, "expectedDigest")
			return s.facade.Write(tools.Lifetime(c), slug, path, "", digest, true)
		},
	})
	properties := map[string]tools.Schema{"slug": text, "mode": {Type: tools.SchemaString, Enum: tools.EnumOf("dockerfile", "compose")}, "requestId": text, "expectedDigest": text, "target": text, "dockerfile": text, "context": text, "compose": text, "services": {Type: tools.SchemaArray, Items: &text}}
	descriptors = append(descriptors, tools.Descriptor{Name: "app_build_preview", Description: "预览Dockerfile或compose构建的目标、上下文限额和镜像命名空间占用，不启动构建", Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"slug", "mode"}, Properties: properties}, Metadata: tools.Metadata{Domain: "container-app", Backend: "domain", Action: "preview", Effect: "read", Exposure: "agent", ReadOnly: true, ResourceType: "container-app", ResourceKeyArgument: "slug", Version: "1"}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
		slug, _ := tools.StringArg(args, "slug")
		input := map[string]any{}
		for key, value := range args {
			if key != "slug" {
				input[key] = value
			}
		}
		raw, err := json.Marshal(input)
		if err != nil {
			return nil, err
		}
		var request domainapps.BuildPlanInput
		if err = json.Unmarshal(raw, &request); err != nil {
			return nil, err
		}
		return s.facade.Preview(tools.Lifetime(c), slug, request)
	}})
	descriptors = append(descriptors, tools.Descriptor{Name: "app_build_submit", Description: "审批后提交绑定工作区内容摘要的镜像构建，异步等待真实任务终态", Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"slug", "mode", "requestId", "expectedDigest"}, Properties: properties}, Metadata: tools.Metadata{Domain: "container-app", Action: "build", Effect: "write", Exposure: "agent", Async: true, TaskDomain: "container-app-build", TaskRequestArgument: "requestId", ResourceType: "container-app", ResourceKeyArgument: "slug", Version: "1"}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
		slug, _ := tools.StringArg(args, "slug")
		input := map[string]any{}
		for key, value := range args {
			if key != "slug" {
				input[key] = value
			}
		}
		raw, err := json.Marshal(input)
		if err != nil {
			return nil, err
		}
		var request domainapps.BuildPlanInput
		if err = json.Unmarshal(raw, &request); err != nil {
			return nil, err
		}
		task, err := s.facade.Submit(tools.Lifetime(c), slug, request)
		if err != nil {
			return nil, err
		}
		return tools.Submission{Value: domainapps.AgentBuildSummary(task), Task: tools.TaskReference{Domain: "container-app-build", ID: task.ID, RequestID: task.RequestID}}, nil
	}})
	return descriptors
}
