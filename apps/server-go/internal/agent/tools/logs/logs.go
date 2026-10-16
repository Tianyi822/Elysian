// Package logs 把日志写入能力封装成 kardia 插件。
//
// 只包 seam.Logs 的两个写方法。读侧三个查询需通过域的 Parse*ListQuery 取得
// 私有查询类型，RunSweep 的参数也未导出，均列为后续项。宿主的 logs.OpenService
// 会打开 sqlite 句柄且没有导出 Close，本包不代为构造。
package logs

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domain "elysian/server/internal/logs"
	"elysian/server/internal/seam"
)

// ServiceName 是本能力在 kardia 上的服务名。
const ServiceName = "logs"

// DefaultSource 是运行日志的缺省来源标签。
const DefaultSource = "agent"

// RuntimeLevels 是 seam.Logs.Runtime 接受的级别。
var RuntimeLevels = []string{"debug", "info", "warning", "error"}

// OperationCategories 是 seam.OperationRecord.Category 的取值。
var OperationCategories = []string{"security", "files", "database", "terminals", "logs", "containers", "websites", "auth"}

// OperationResults 是 seam.OperationRecord.Result 的取值。
var OperationResults = []string{"success", "failure"}

var minLengthOne = 1

// Deps 是宿主注入的域对象。本包不构造其中任何一项。
type Deps struct {
	// Logs 是日志服务接缝，由宿主经 logs.OpenService 构造后注入。
	Logs   seam.Logs
	Facade *domain.AgentFacade
}

// Config 是本能力自身的开关。
type Config struct {
	// Source 是运行日志缺省来源标签，空则取 DefaultSource。
	Source string
}

// Service 是日志能力服务。
type Service struct {
	kardia.Service

	deps Deps
	cfg  Config
}

// validate 在装载前裁决依赖是否齐备，缺项即失败（失败闭合）。
func (d Deps) validate() error {
	if tools.IsNil(d.Logs) && (d.Facade == nil || !d.Facade.Available()) {
		return errors.New("日志能力缺少 seam.Logs 实现：日志服务由宿主构造并注入")
	}
	return nil
}

// New 构造日志能力服务，提供服务并登记描述符。
func New(c *kardia.Context, deps Deps, cfg Config) (*Service, error) {
	if err := deps.validate(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(cfg.Source) == "" {
		cfg.Source = DefaultSource
	}
	service := &Service{deps: deps, cfg: cfg}
	base, err := kardia.NewService(c, ServiceName, service, nil)
	if err != nil {
		return nil, err
	}
	service.Service = base
	if err := tools.RegisterAll(c, service.descriptors()...); err != nil {
		return nil, errors.Join(err, service.Close(context.Background()))
	}
	return service, nil
}

// Plugin 把本能力封成 kardia 插件：注入注册表，Apply 里构造服务。
func Plugin(deps Deps, cfg Config) *kardia.Plugin {
	return kardia.ServicePlugin(ServiceName, kardia.InjectMap{tools.ServiceName: nil},
		func(c *kardia.Context, _ any) (any, error) { return New(c, deps, cfg) })
}

// From 取已装载的日志能力服务。
func From(c *kardia.Context) (*Service, error) {
	return tools.Use[*Service](c, ServiceName)
}

// Source 返回生效的运行日志来源标签。
func (s *Service) Source() string { return s.cfg.Source }

// WriteRuntime 写一条运行日志。级别、来源、正文任一不合法即拒绝。
func (s *Service) WriteRuntime(access *kardia.Context, level, source, message string) error {
	if !slices.Contains(RuntimeLevels, level) {
		return fmt.Errorf("运行日志级别 %q 不合法：只接受 %s", level, strings.Join(RuntimeLevels, "|"))
	}
	if strings.TrimSpace(source) == "" {
		return errors.New("运行日志来源不得为空")
	}
	if strings.TrimSpace(message) == "" {
		return errors.New("运行日志正文不得为空")
	}
	s.deps.Logs.Runtime(level, source, message)
	return nil
}

// RecordOperation 写一条操作日志。分类、动作、结果、方法与路径缺一即拒绝。
func (s *Service) RecordOperation(access *kardia.Context, record seam.OperationRecord) error {
	if !slices.Contains(OperationCategories, record.Category) {
		return fmt.Errorf("操作日志分类 %q 不合法：只接受 %s", record.Category, strings.Join(OperationCategories, "|"))
	}
	if strings.TrimSpace(record.Action) == "" {
		return errors.New("操作日志动作不得为空")
	}
	if !slices.Contains(OperationResults, record.Result) {
		return fmt.Errorf("操作日志结果 %q 不合法：只接受 success|failure", record.Result)
	}
	if strings.TrimSpace(record.Method) == "" {
		return errors.New("操作日志方法不得为空")
	}
	if record.Method != strings.ToUpper(record.Method) {
		return fmt.Errorf("操作日志方法 %q 必须大写", record.Method)
	}
	if strings.TrimSpace(record.Path) == "" {
		return errors.New("操作日志路径不得为空")
	}
	s.deps.Logs.RecordOperation(record)
	return nil
}

func (s *Service) descriptors() []tools.Descriptor {
	if s.deps.Facade != nil {
		return s.agentDescriptors()
	}
	return []tools.Descriptor{
		{
			Name:        "log_runtime_write",
			Metadata:    tools.Metadata{Domain: "logs", Action: "runtime-write", Effect: "write", Exposure: "system", Version: "1"},
			Description: "写一条运行日志；级别取 debug|info|warning|error，来源缺省为 " + s.cfg.Source,
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"level", "message"},
				Properties: map[string]tools.Schema{
					"level":   {Type: tools.SchemaString, Enum: tools.EnumOf(RuntimeLevels...), Description: "日志级别"},
					"message": {Type: tools.SchemaString, MinLength: &minLengthOne, Description: "日志正文"},
					"source":  {Type: tools.SchemaString, MinLength: &minLengthOne, Description: "来源标签，缺省用配置值"},
				},
			},
			Handler: s.handleRuntimeWrite,
		},
		{
			Name:        "log_operation_write",
			Metadata:    tools.Metadata{Domain: "logs", Action: "operation-write", Effect: "write", Exposure: "system", Version: "1"},
			Description: "写一条操作日志，同时落运行日志镜像",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"category", "action", "result", "method", "path"},
				Properties: map[string]tools.Schema{
					"category":    {Type: tools.SchemaString, Enum: tools.EnumOf(OperationCategories...), Description: "操作分类"},
					"action":      {Type: tools.SchemaString, MinLength: &minLengthOne, Description: "动作名"},
					"result":      {Type: tools.SchemaString, Enum: tools.EnumOf(OperationResults...), Description: "结果"},
					"method":      {Type: tools.SchemaString, MinLength: &minLengthOne, Description: "大写 HTTP 方法"},
					"path":        {Type: tools.SchemaString, MinLength: &minLengthOne, Description: "请求路径"},
					"target":      {Type: tools.SchemaString, Description: "操作对象，可空"},
					"summary":     {Type: tools.SchemaString, Description: "中文摘要，可空"},
					"http_status": {Type: tools.SchemaInteger, Description: "HTTP 状态码，可空"},
				},
			},
			Handler: s.handleOperationWrite,
		},
	}
}

func (s *Service) handleRuntimeWrite(access *kardia.Context, args tools.Arguments) (any, error) {
	level, _ := tools.StringArg(args, "level")
	message, _ := tools.StringArg(args, "message")
	source := s.cfg.Source
	if given, ok := tools.StringArg(args, "source"); ok && strings.TrimSpace(given) != "" {
		source = given
	}
	if err := s.WriteRuntime(access, level, source, message); err != nil {
		return nil, err
	}
	return map[string]any{"written": true, "level": level, "source": source}, nil
}

func (s *Service) handleOperationWrite(access *kardia.Context, args tools.Arguments) (any, error) {
	record := seam.OperationRecord{}
	record.Category, _ = tools.StringArg(args, "category")
	record.Action, _ = tools.StringArg(args, "action")
	record.Result, _ = tools.StringArg(args, "result")
	record.Method, _ = tools.StringArg(args, "method")
	record.Path, _ = tools.StringArg(args, "path")
	if target, ok := tools.StringArg(args, "target"); ok {
		record.Target = &target
	}
	if summary, ok := tools.StringArg(args, "summary"); ok {
		record.Summary = &summary
	}
	if status, ok := tools.IntArg(args, "http_status"); ok {
		record.HTTPStatus = &status
	}
	if err := s.RecordOperation(access, record); err != nil {
		return nil, err
	}
	return map[string]any{"written": true, "category": record.Category, "action": record.Action}, nil
}
