// Package accounts 把系统账号查询能力封装成 kardia 插件。
//
// 只包 seam.SystemAccounts 的两个只读查询，外加 security 域的托管 UID 判定这一个
// 纯函数。security 域的 sshAPI 与 usersAPI（改密、改 sshd_config、增删用户、管
// authorized_keys）因接口未导出、且全部是不可逆的宿主写操作，本轮不封装
// （ADR-0023 后续项）。账号通道由宿主注入——security.NewSystemAccounts() 会在
// 调用时 fork getent，本包不代为构造。
package accounts

import (
	"errors"
	"strings"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/seam"
	"elysian/server/internal/security"
)

// ServiceName 是本能力在 kardia 上的服务名。
const ServiceName = "accounts"

// Deps 是宿主注入的域对象。
type Deps struct {
	// Accounts 是系统账号通道，由宿主经 security.NewSystemAccounts() 构造后注入。
	Accounts seam.SystemAccounts
}

// Service 是系统账号能力服务。
type Service struct {
	kardia.Service

	deps Deps
}

func (d Deps) validate() error {
	if d.Accounts == nil {
		return errors.New("系统账号能力缺少 seam.SystemAccounts 实现：账号通道由宿主构造并注入")
	}
	return nil
}

// New 构造系统账号能力服务，提供服务并登记描述符。
func New(c *kardia.Context, deps Deps) (*Service, error) {
	if err := deps.validate(); err != nil {
		return nil, err
	}
	service := &Service{deps: deps}
	base, err := kardia.NewService(c, ServiceName, service, nil)
	if err != nil {
		return nil, err
	}
	service.Service = base
	if err := tools.RegisterAll(c, service.descriptors()...); err != nil {
		return nil, err
	}
	return service, nil
}

// Plugin 把本能力封成 kardia 插件。
func Plugin(deps Deps) *kardia.Plugin {
	return kardia.ServicePlugin(ServiceName, kardia.InjectMap{tools.ServiceName: nil},
		func(c *kardia.Context, _ any) (any, error) { return New(c, deps) })
}

// From 取已装载的系统账号能力服务。
func From(c *kardia.Context) (*Service, error) {
	return tools.Use[*Service](c, ServiceName)
}

// List 返回全部系统账号记录。
func (s *Service) List(access *kardia.Context) ([]seam.PasswdRecord, error) {
	return s.deps.Accounts.PasswdAll(tools.Lifetime(access))
}

// Lookup 按名查一个系统账号；查无结果返回 (nil, nil)。
func (s *Service) Lookup(access *kardia.Context, name string) (*seam.PasswdRecord, error) {
	if strings.TrimSpace(name) == "" {
		return nil, errors.New("账号名不得为空")
	}
	return s.deps.Accounts.PasswdByName(tools.Lifetime(access), name)
}

// IsManagedUID 报告 UID 是否属于面板托管区间（纯判定，不触宿主）。
func (s *Service) IsManagedUID(access *kardia.Context, uid int) bool {
	return security.IsManagedUid(uid)
}

func (s *Service) descriptors() []tools.Descriptor {
	return []tools.Descriptor{
		{
			Name:        "account_list",
			Description: "列出宿主的系统账号（等价 getent passwd）",
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Handler:     s.handleList,
		},
		{
			Name:        "account_lookup",
			Description: "按名查一个系统账号；查无结果时 found 为 false",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"name"},
				Properties: map[string]tools.Schema{
					"name": {Type: tools.SchemaString, Description: "账号名"},
				},
			},
			Handler: s.handleLookup,
		},
		{
			Name:        "managed_uid_check",
			Description: "判定一个 UID 是否落在面板托管区间",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"uid"},
				Properties: map[string]tools.Schema{
					"uid": {Type: tools.SchemaInteger, Description: "用户 ID"},
				},
			},
			Handler: s.handleManagedUID,
		},
	}
}

func (s *Service) handleList(access *kardia.Context, _ tools.Arguments) (any, error) {
	return s.List(access)
}

func (s *Service) handleLookup(access *kardia.Context, args tools.Arguments) (any, error) {
	name, _ := tools.StringArg(args, "name")
	record, err := s.Lookup(access, name)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return map[string]any{"found": false, "name": name}, nil
	}
	return map[string]any{"found": true, "record": *record}, nil
}

func (s *Service) handleManagedUID(access *kardia.Context, args tools.Arguments) (any, error) {
	uid, ok := tools.IntArg(args, "uid")
	if !ok {
		return nil, errors.New("UID 参数不是整数")
	}
	return map[string]any{"uid": uid, "managed": s.IsManagedUID(access, uid)}, nil
}
