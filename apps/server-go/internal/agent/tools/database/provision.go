package database

import (
	"errors"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domain "elysian/server/internal/database"
	"elysian/server/internal/shared"
)

// 当前聊天使用的两个数据库工具：只读的实例发现与写效应的部署。13 个退役的 database_*
// 仍留在 database.go 里供旧 Run 派发。

func (s *Service) agentDescriptors() []tools.Descriptor {
	requestID := tools.Schema{Type: tools.SchemaString, Pattern: "^[a-f0-9]{64}$", Description: "64 位小写十六进制稳定请求标识；同请求重试必须复用原值与完整参数"}
	return []tools.Descriptor{
		{
			Name:        "database_instances",
			Description: "只读列出本机数据库实例（MySQL、MariaDB、Redis 官方镜像容器）：引擎、版本、运行状态、连接地址、归属（面板创建／已接管／未接管）、资源档位，以及实例里由面板登记的数据库与用户名，不含密码。可按 engine 与 version 过滤。给出 engine 时同时返回部署决策 plan：reuse 表示有版本匹配、可直接建库的实例；adopt-first 表示只有未接管的自装容器，须先让用户在数据库页接管；instance-stopped 表示匹配的实例已停止；pull-image-first 表示本地缺镜像；insufficient 表示宿主内存放不下；create 表示将新建实例，容量读数附在 plan.capacity。部署前先用它确认，再调用 database_provision",
			SearchNames: []string{"数据库实例", "有哪些数据库", "数据库列表", "MySQL 实例", "MariaDB 实例", "Redis 实例", "database instances"},
			Parameters: tools.Schema{Type: tools.SchemaObject, Properties: map[string]tools.Schema{
				"engine":  {Type: tools.SchemaString, Enum: tools.EnumOf("MySQL", "MariaDB", "Redis"), Description: "按引擎过滤；给出时同时返回部署决策"},
				"version": {Type: tools.SchemaString, Description: "部署决策要匹配的版本，如 8.0；省略时只列实例并提示先确定版本"},
			}},
			Metadata: tools.Metadata{Domain: "database", Backend: "domain", Action: "instances", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"},
			Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
				engine, _ := tools.StringArg(args, "engine")
				version, _ := tools.StringArg(args, "version")
				value, err := s.deps.Facade.Instances(tools.Lifetime(c), engine, version)
				return value, agentBusinessError(err)
			},
		},
		{
			Name:        "database_provision",
			Description: "部署一个数据库，复用优先：有运行中、版本匹配且面板持有管理员凭据的实例时，直接在其中新建逻辑库与只授权该库的专属用户，不新建容器；没有时新建带资源档位的受管实例再建库建用户。version 匹配标签一致或其下的补丁版本（8.0 命中 8.0.36）。凭据由后端生成且只保存在面板登记，回执不含密码，提醒用户到数据库页该实例卡片复制。新建实例需要 resourceTier 与 networkScope：先经 docker_host_capacity 核对容量，再经 request_user_input 让用户选定；newInstance=true 强制新建，instance 指定容器 ID 时只复用该实例。需要用户决定的情况（先接管、先拉取镜像、确定版本、容量不足、实例已停止、库名或用户名已占用）返回未执行的原因与下一步，不创建任何资源，用 request_user_input 让用户选择后重新提交。相同参数重试复用原 requestId",
			SearchNames: []string{"部署数据库", "新建数据库", "创建数据库", "建库", "MySQL 建库", "MariaDB 建库", "数据库账号", "database provision"},
			Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"engine", "version", "database", "requestId"}, Properties: map[string]tools.Schema{
				"engine":       {Type: tools.SchemaString, Enum: tools.EnumOf("MySQL", "MariaDB", "Redis"), Description: "数据库引擎"},
				"version":      {Type: tools.SchemaString, Description: "明确的官方镜像版本标签，如 8.0；不能是 latest"},
				"database":     {Type: tools.SchemaString, Description: "逻辑库名：只能使用英文字母、数字和下划线，并须以字母开头，不超过 64 个字符；已有同名库时换一个名字"},
				"username":     {Type: tools.SchemaString, Description: "只授权该库的专属用户名，缺省为「库名_user」；不能是管理员或系统保留账号"},
				"instance":     {Type: tools.SchemaString, Pattern: "^[a-f0-9]{64}$", Description: "只复用这个实例（database_instances 返回的容器 ID）"},
				"newInstance":  {Type: tools.SchemaBoolean, Description: "强制新建独立实例，不复用现有实例"},
				"instanceName": {Type: tools.SchemaString, Description: "新实例的容器名；缺省由引擎、版本和请求编号生成"},
				"resourceTier": {Type: tools.SchemaString, Enum: tools.EnumOf("small", "medium", "large"), Description: "新建实例的资源档位：small=512MiB+0.5CPU、medium=1GiB+1CPU、large=2GiB+2CPU"},
				"networkScope": {Type: tools.SchemaString, Enum: tools.EnumOf("container-network", "localhost", "any-host"), Description: "新建实例的网络范围：仅容器网络／本机回环／任意主机"},
				"hostPort":     {Type: tools.SchemaInteger, Description: "仅 any-host 需要：1–65535 的宿主端口，不得是面板保留端口"},
				"requestId":    requestID,
			}},
			Metadata: tools.Metadata{Domain: "database", Backend: "domain", Action: "provision", Effect: "write", Exposure: "agent", ResourceType: "database", ResourceKeyArgument: "database", Version: "1", Async: true, TaskDomain: domain.ProvisionTaskDomain, TaskRequestArgument: "requestId"},
			Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
				input, err := domain.DecodeProvisionInput(args)
				if err != nil {
					return nil, &tools.BusinessError{Code: "tool-arguments-rejected", Message: err.Error() + "；本次业务操作未执行，请修正参数后重新提议", NotDispatched: true}
				}
				task, err := s.deps.Facade.SubmitProvision(tools.Lifetime(c), input)
				if err != nil {
					return nil, agentBusinessError(err)
				}
				return tools.Submission{Value: task, Task: tools.TaskReference{Domain: domain.ProvisionTaskDomain, ID: task.ID, RequestID: task.RequestID, Target: task.Target, Digest: task.Digest}}, nil
			},
		},
	}
}

// agentBusinessError 把域入口的拒绝映射为可交回模型的业务错误；其余错误原样上抛。
func agentBusinessError(err error) error {
	if err == nil {
		return nil
	}
	var rejected *domain.AgentProvisionError
	if errors.As(err, &rejected) {
		return &tools.BusinessError{Code: rejected.Code, Message: rejected.Message, NotDispatched: rejected.NotDispatched}
	}
	// 只读查询的参数类拒绝是模型可以改判的事实。
	var invalid *shared.InvalidRequestError
	if errors.As(err, &invalid) {
		return &tools.BusinessError{Code: "database-request-rejected", Message: invalid.Message}
	}
	return err
}
