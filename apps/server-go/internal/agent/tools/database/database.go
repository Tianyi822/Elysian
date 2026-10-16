package database

import (
	"context"
	"encoding/json"
	"errors"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domain "elysian/server/internal/database"
)

const ServiceName = "database"

type Deps struct{ Facade *domain.AgentFacade }
type Config struct{}
type Service struct {
	kardia.Service
	deps Deps
}

func New(c *kardia.Context, deps Deps, _ Config) (*Service, error) {
	if deps.Facade == nil || !deps.Facade.Available() {
		return nil, errors.New("数据库能力缺少共享域服务")
	}
	s := &Service{deps: deps}
	base, err := kardia.NewService(c, ServiceName, s, nil)
	if err != nil {
		return nil, err
	}
	s.Service = base
	var descriptors []tools.Descriptor
	for _, spec := range []struct {
		name, action, description string
		write                     bool
	}{
		{"database_list", "list", "读取数据库状态与登记版本，不含凭据", false},
		{"database_metadata", "metadata", "读取固定范围的数据库表名和类型，不执行任意 SQL", false},
		{"database_metrics", "metrics", "读取指定数据库的固定存储、内存和连接数指标", false},
		{"database_discover", "discover", "按精确引擎和版本读取可用官方镜像与实例", false},
		{"database_create", "create", "审批后创建逻辑库或专属实例，凭据由后端生成并仅保存在后端；新实例仅容器网络访问，id 为 new:容器名", true},
		{"database_reconcile", "reconcile", "审批后对账受管数据库，要求读取到的精确登记版本", true},
		{"database_remove", "remove", "审批后删除指定受管逻辑库，要求精确登记版本；不可恢复", true},
		{"database_container_remove", "remove-container", "审批后删除指定受管数据库容器，要求精确登记版本", true},
		{"database_start", "start", "审批后启动精确受管数据库实例，要求登记版本、容器与专属卷身份一致", true},
		{"database_stop", "stop", "审批后停止精确受管数据库实例，不允许影响同实例其他登记逻辑库", true},
	} {
		spec := spec
		properties := map[string]tools.Schema{}
		required := []string{}
		if spec.action != "list" && spec.action != "discover" {
			properties["id"] = tools.Schema{Type: tools.SchemaString}
			required = append(required, "id")
		}
		if spec.action == "discover" || spec.action == "create" {
			properties["engine"] = tools.Schema{Type: tools.SchemaString, Enum: tools.EnumOf("MySQL", "MariaDB", "Redis")}
			properties["versionTag"] = tools.Schema{Type: tools.SchemaString}
			required = append(required, "engine", "versionTag")
		}
		if spec.action == "create" {
			for _, key := range []string{"name", "imageId", "containerName", "charset"} {
				properties[key] = tools.Schema{Type: tools.SchemaString}
			}
			required = append(required, "name")
		}
		effect := "read"
		if spec.write {
			effect = "write"
			properties["expected"] = tools.Schema{Type: tools.SchemaString}
			required = append(required, "expected")
		}
		metadata := tools.Metadata{Domain: "database", Backend: "domain", Action: spec.action, Effect: effect, Exposure: "agent", ResourceType: "database", ResourceKeyArgument: "id", ReadOnly: !spec.write, Default: !spec.write, Version: "1"}
		if spec.action == "create" || spec.action == "reconcile" {
			properties["requestId"] = tools.Schema{Type: tools.SchemaString, Description: "稳定的 64 位小写十六进制请求标识；同请求重试必须复用原值与完整参数"}
			required = append(required, "requestId")
			metadata.Async, metadata.TaskDomain, metadata.TaskRequestArgument = true, "database", "requestId"
			metadata.Version = "2"
		}
		descriptors = append(descriptors, tools.Descriptor{Name: spec.name, Description: spec.description, Parameters: tools.Schema{Type: tools.SchemaObject, Properties: properties, Required: required}, Metadata: metadata, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			id, _ := tools.StringArg(args, "id")
			if spec.action == "list" {
				return deps.Facade.List(tools.Lifetime(c))
			}
			if spec.action == "metadata" {
				return deps.Facade.Metadata(tools.Lifetime(c), id)
			}
			if spec.action == "metrics" {
				return deps.Facade.Metrics(tools.Lifetime(c), id)
			}
			if spec.action == "discover" {
				engine, _ := tools.StringArg(args, "engine")
				version, _ := tools.StringArg(args, "versionTag")
				return deps.Facade.Discover(tools.Lifetime(c), engine, version)
			}
			if spec.action == "create" {
				raw, err := json.Marshal(args)
				if err != nil {
					return nil, err
				}
				var input domain.AgentCreate
				if err := json.Unmarshal(raw, &input); err != nil {
					return nil, err
				}
				requestID, _ := tools.StringArg(args, "requestId")
				task, err := deps.Facade.SubmitTask(tools.Lifetime(c), requestID, domain.AgentTaskInput{Action: "create", Create: input})
				if err != nil {
					return nil, err
				}
				return tools.Submission{Value: task, Task: tools.TaskReference{Domain: "database", ID: task.ID, RequestID: task.RequestID}}, nil
			}
			expected, _ := tools.StringArg(args, "expected")
			if spec.action == "reconcile" {
				requestID, _ := tools.StringArg(args, "requestId")
				task, err := deps.Facade.SubmitTask(tools.Lifetime(c), requestID, domain.AgentTaskInput{Action: "reconcile", ID: id, Expected: expected})
				if err != nil {
					return nil, err
				}
				return tools.Submission{Value: task, Task: tools.TaskReference{Domain: "database", ID: task.ID, RequestID: task.RequestID}}, nil
			}
			return deps.Facade.Lifecycle(tools.Lifetime(c), id, expected, spec.action)
		}})
	}
	for _, action := range []string{"status", "logs", "cancel"} {
		action := action
		properties := map[string]tools.Schema{"id": {Type: tools.SchemaString, Description: "原任务提交时使用的数据库资源标识，新建仍为 new:容器名"}, "taskId": {Type: tools.SchemaString}}
		description := "读取精确数据库任务状态与取消反馈；结果未知不代表失败或可重投"
		metadata := tools.Metadata{Domain: "database", Backend: "domain", Action: "task_" + action, Effect: "read", Exposure: "agent", ResourceType: "database", ResourceKeyArgument: "id", ReadOnly: true, Version: "1", TaskDomain: "database", TaskIDArgument: "taskId"}
		if action == "logs" {
			description = "分页读取数据库任务的固定阶段和时间；每页最多 50 条，存储最多 128 条，不读取数据库自由输出"
			properties["cursor"] = tools.Schema{Type: tools.SchemaInteger, Description: "上一页 next，首个请求为 0；缺省为 0"}
			properties["limit"] = tools.Schema{Type: tools.SchemaInteger, Description: "每页 1 至 50 条，缺省 20"}
		}
		if action == "cancel" {
			description = "审批后请求停止指定数据库任务；不回滚已发生的变更，停止后结果未知仍保留执行屏障；重启后的未知任务不可取消确认"
			metadata.Action, metadata.Effect, metadata.ReadOnly, metadata.Async = "cancel", "write", false, true
			metadata.TaskDomain, metadata.TaskIDArgument = "database", "taskId"
		}
		descriptors = append(descriptors, tools.Descriptor{Name: "database_task_" + action, Description: description, Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id", "taskId"}, Properties: properties}, Metadata: metadata, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			id, _ := tools.StringArg(args, "id")
			taskID, _ := tools.StringArg(args, "taskId")
			if action == "status" {
				return deps.Facade.TaskStatus(tools.Lifetime(c), id, taskID)
			}
			if action == "logs" {
				cursor, _ := tools.IntArg(args, "cursor")
				limit, ok := tools.IntArg(args, "limit")
				if !ok {
					limit = 20
				}
				return deps.Facade.TaskLogs(tools.Lifetime(c), id, taskID, cursor, limit)
			}
			task, err := deps.Facade.CancelTask(tools.Lifetime(c), id, taskID)
			if err != nil {
				return nil, err
			}
			return tools.Submission{Value: task, Task: tools.TaskReference{Domain: "database", ID: task.ID, RequestID: task.RequestID}}, nil
		}})
	}
	if err := tools.RegisterAll(c, descriptors...); err != nil {
		return nil, errors.Join(err, s.Close(context.Background()))
	}
	return s, nil
}
func Plugin(deps Deps, cfg Config) *kardia.Plugin {
	return kardia.ServicePlugin(ServiceName, kardia.InjectMap{tools.ServiceName: nil}, func(c *kardia.Context, _ any) (any, error) { return New(c, deps, cfg) })
}
func From(c *kardia.Context) (*Service, error) { return tools.Use[*Service](c, ServiceName) }
