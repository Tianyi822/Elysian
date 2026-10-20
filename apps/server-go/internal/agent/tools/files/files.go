package files

import (
	"context"
	"errors"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domain "elysian/server/internal/files"
)

const ServiceName = "files"

type Deps struct{ Facade *domain.AgentFacade }
type Config struct{}
type Service struct {
	kardia.Service
	deps Deps
}

func New(c *kardia.Context, deps Deps, _ Config) (*Service, error) {
	if deps.Facade == nil || !deps.Facade.Available() {
		return nil, errors.New("业务文件能力缺少授权校验入口")
	}
	s := &Service{deps: deps}
	base, err := kardia.NewService(c, ServiceName, s, nil)
	if err != nil {
		return nil, err
	}
	s.Service = base
	text := tools.Schema{Type: tools.SchemaString}
	root := tools.Schema{Type: tools.SchemaString}
	if !deps.Facade.DynamicRoots() {
		root.Enum = tools.EnumOf(deps.Facade.Roots()...)
	}
	var descriptors []tools.Descriptor
	for _, spec := range []struct {
		name, action, description string
		write                     bool
	}{
		{"file_list", "list", "列出明确授权业务目录内最多 500 个安全条目", false},
		{"file_read", "read", "读取授权业务目录内 256 KiB 以下文本及内容版本；禁止链接和敏感文件路径", false},
		{"file_write", "write", "审批后在授权业务目录原子写文本；expected 为读取到的内容版本，新建用 missing", true},
		{"file_copy", "copy", "审批后同根复制一个受限文本文件；要求源内容版本，目标必须不存在，新副本权限固定 0600", true},
		{"file_move", "move", "审批后同根原子移动一个受限文本文件；要求源内容版本，目标必须不存在", true},
		{"file_delete", "delete", "审批后删除一个受限文本文件；要求精确内容版本，禁止递归和目录删除", true},
	} {
		spec := spec
		properties := map[string]tools.Schema{"root": root, "path": text}
		required := []string{"root", "path"}
		effect := "read"
		if spec.write {
			effect = "write"
			required = append(required, "expected")
			properties["expected"] = text
			if spec.action == "write" {
				required = append(required, "content")
				properties["content"] = text
			}
			if spec.action == "copy" || spec.action == "move" {
				required = append(required, "target")
				properties["target"] = text
			}
		}
		descriptors = append(descriptors, tools.Descriptor{Name: spec.name, Description: spec.description, Parameters: tools.Schema{Type: tools.SchemaObject, Required: required, Properties: properties}, Metadata: tools.Metadata{Domain: "files", Action: spec.action, Effect: effect, Exposure: "agent", ResourceType: "filesystem", ResourceKeyArgument: "root", ReadOnly: !spec.write, Version: "1"}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			root, _ := tools.StringArg(args, "root")
			path, _ := tools.StringArg(args, "path")
			switch spec.action {
			case "list":
				return deps.Facade.List(tools.Lifetime(c), root, path)
			case "read":
				return deps.Facade.Read(tools.Lifetime(c), root, path)
			case "write":
				content, _ := tools.StringArg(args, "content")
				expected, _ := tools.StringArg(args, "expected")
				return deps.Facade.Write(tools.Lifetime(c), root, path, content, expected)
			default:
				target, _ := tools.StringArg(args, "target")
				expected, _ := tools.StringArg(args, "expected")
				return deps.Facade.Change(tools.Lifetime(c), root, path, target, expected, spec.action)
			}
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
