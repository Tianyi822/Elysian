package docker

import (
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
	domaindocker "elysian/server/internal/docker"
)

func TestImagePublicDescriptionsMatchActionsAndPolicy(t *testing.T) {
	_, registry := install(t, Deps{Views: &fakeViews{}, Agent: &domaindocker.AgentFacade{}}, Config{})
	schemas := map[string]tools.PublicSchema{}
	for _, schema := range registry.Schemas() {
		if strings.HasPrefix(schema.Name, "docker_image_") {
			schemas[schema.Name] = schema
		}
	}
	if len(schemas) != 8 {
		t.Fatalf("应公开八个镜像工具，得到 %d 个", len(schemas))
	}
	for _, test := range []struct {
		name     string
		keywords []string
		metadata tools.Metadata
	}{
		{"docker_image_inspect", []string{"只读", "本机", "完整 ID", "标签", "大小"}, tools.Metadata{Domain: "docker", Action: "inspect", Effect: "read", Exposure: "agent", Backend: "domain", ResourceType: "docker-image", ResourceKeyArgument: "id", ReadOnly: true, Default: true, Version: "1"}},
		{"docker_image_search", []string{"搜索", "镜像名称", "镜像源", "只读"}, tools.Metadata{Domain: "docker", Action: "search", Effect: "read", Exposure: "agent", Backend: "domain", ReadOnly: true, Default: true, Version: "1"}},
		{"docker_image_tags", []string{"查询", "版本标签", "镜像源", "只读"}, tools.Metadata{Domain: "docker", Action: "tags", Effect: "read", Exposure: "agent", Backend: "domain", ReadOnly: true, Default: true, Version: "1"}},
		{"docker_image_pull", []string{"拉取", "异步", "审批", "精确资源授权", "requestId"}, tools.Metadata{Domain: "docker", Action: "pull", Effect: "write", Exposure: "agent", Backend: "domain", ResourceType: "docker-image", ResourceKeyArgument: "id", Async: true, TaskDomain: "docker-image-pull", TaskRequestArgument: "requestId", Version: "1"}},
		{"docker_image_pull_get", []string{"拉取任务", "状态", "结果未知", "只读"}, tools.Metadata{Domain: "docker", Action: "task_status", Effect: "read", Exposure: "agent", Backend: "domain", ResourceType: "docker-image", ResourceKeyArgument: "id", ReadOnly: true, TaskDomain: "docker-image-pull", TaskIDArgument: "taskId", Version: "1"}},
		{"docker_image_pull_logs", []string{"分页", "拉取任务", "结构化", "日志", "只读"}, tools.Metadata{Domain: "docker", Action: "task_logs", Effect: "read", Exposure: "agent", Backend: "domain", ResourceType: "docker-image", ResourceKeyArgument: "id", ReadOnly: true, TaskDomain: "docker-image-pull", TaskIDArgument: "taskId", Version: "1"}},
		{"docker_image_pull_cancel", []string{"请求取消", "审批", "精确资源授权", "不代表任务已停止"}, tools.Metadata{Domain: "docker", Action: "cancel", Effect: "write", Exposure: "agent", Backend: "domain", ResourceType: "docker-image", ResourceKeyArgument: "id", Async: true, TaskDomain: "docker-image-pull", TaskIDArgument: "taskId", Version: "1"}},
		{"docker_image_remove", []string{"删除", "本地", "ID", "审批", "精确资源授权"}, tools.Metadata{Domain: "docker", Action: "remove", Effect: "write", Exposure: "agent", Backend: "domain", ResourceType: "docker-image", ResourceKeyArgument: "id", Version: "1"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			schema, ok := schemas[test.name]
			if !ok {
				t.Fatal("缺少公开镜像工具")
			}
			for _, keyword := range test.keywords {
				if !strings.Contains(schema.Description, keyword) {
					t.Errorf("描述缺少动作语义 %q：%s", keyword, schema.Description)
				}
			}
			if schema.Metadata != test.metadata {
				t.Errorf("工具策略元数据发生变化：得到 %+v，期望 %+v", schema.Metadata, test.metadata)
			}
			if strings.Contains(schema.Description, "Docker 镜像"+strings.TrimPrefix(test.name, "docker_image_")) {
				t.Errorf("描述不得直接拼接机器动作名：%s", schema.Description)
			}
			if schema.Metadata.ReadOnly {
				for _, forbidden := range []string{"写操作", "审批", "授权"} {
					if strings.Contains(schema.Description, forbidden) {
						t.Errorf("只读描述不得暗示写操作或审批要求：%s", schema.Description)
					}
				}
			}
		})
	}
}
