// Package auth 把面板凭据与会话的只读事实封装成 kardia 插件。
//
// 只包三张存诸的只读面：会话计数、凭据状态、单点登录回跳白名单。会话 ID 是活的
// 登录凭据，密码哈希是秘密，两者都不进工具结果——因此本能力不提供「列出会话 ID」
// 或「读取凭据」这类工具，只提供计数与状态。改密、登出、撤销会话是不可逆的治理
// 动作，等审批层落地后再开（ADR-0023）。
//
// 存诸由宿主注入：文件版存诸指向 ~/.Elysian 下的真实文件，本包不代为构造。
package auth

import (
	"context"
	"errors"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domainauth "elysian/server/internal/auth"
)

// ServiceName 是本能力在 kardia 上的服务名。
const ServiceName = "auth"

// Deps 是宿主注入的域对象。
type Deps struct {
	// Sessions 是会话存诸。
	Sessions domainauth.SessionStore
	// Credentials 是面板凭据存诸。
	Credentials domainauth.CredentialsStore
	// Origins 是单点登录回跳白名单。
	Origins domainauth.ReturnOriginRegistry
}

// CredentialsStatus 是凭据的对外投影：只说「有没有设过密码、什么时候改的」，
// 绝不含哈希。
type CredentialsStatus struct {
	Initialized       bool   `json:"initialized"`
	Username          string `json:"username"`
	PasswordChangedAt string `json:"passwordChangedAt"`
}

// Service 是登录鉴权能力服务。
type Service struct {
	kardia.Service

	deps Deps
}

func (d Deps) validate() error {
	if tools.IsNil(d.Sessions) {
		return errors.New("登录鉴权能力缺少会话存诸：SessionStore 由宿主构造并注入")
	}
	if tools.IsNil(d.Credentials) {
		return errors.New("登录鉴权能力缺少凭据存诸：CredentialsStore 由宿主构造并注入")
	}
	if tools.IsNil(d.Origins) {
		return errors.New("登录鉴权能力缺少回跳白名单：ReturnOriginRegistry 由宿主构造并注入")
	}
	return nil
}

// New 构造登录鉴权能力服务，提供服务并登记描述符。
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
		return nil, errors.Join(err, service.Close(context.Background()))
	}
	return service, nil
}

// Plugin 把本能力封成 kardia 插件。
func Plugin(deps Deps) *kardia.Plugin {
	return kardia.ServicePlugin(ServiceName, kardia.InjectMap{tools.ServiceName: nil},
		func(c *kardia.Context, _ any) (any, error) { return New(c, deps) })
}

// From 取已装载的登录鉴权能力服务。
func From(c *kardia.Context) (*Service, error) {
	return tools.Use[*Service](c, ServiceName)
}

// SessionCount 返回未过期会话的数量。会话 ID 一律不外泄。
func (s *Service) SessionCount(access *kardia.Context) (int, error) {
	sessions, err := s.deps.Sessions.List()
	if err != nil {
		return 0, err
	}
	return len(sessions), nil
}

// CredentialsStatus 返回凭据状态投影。
func (s *Service) CredentialsStatus(access *kardia.Context) (CredentialsStatus, error) {
	credentials, err := s.deps.Credentials.Current()
	if err != nil {
		return CredentialsStatus{}, err
	}
	if credentials == nil {
		return CredentialsStatus{}, nil
	}
	return CredentialsStatus{
		Initialized:       credentials.PasswordHash != "",
		Username:          credentials.Username,
		PasswordChangedAt: credentials.PasswordChangedAt,
	}, nil
}

// ReturnOrigins 返回单点登录回跳白名单。
func (s *Service) ReturnOrigins(access *kardia.Context) ([]string, error) {
	return s.deps.Origins.List()
}

func (s *Service) descriptors() []tools.Descriptor {
	return []tools.Descriptor{
		{
			Name:        "session_count",
			Description: "返回当前未过期的面板会话数量；不返回会话 ID",
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Handler:     s.handleSessionCount,
		},
		{
			Name:        "credentials_status",
			Description: "返回面板凭据状态：是否已设密码、账号名与最近改密时间；不返回哈希",
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Handler:     s.handleCredentialsStatus,
		},
		{
			Name:        "return_origins_list",
			Description: "列出单点登录回跳白名单里的 origin",
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Handler:     s.handleReturnOrigins,
		},
	}
}

func (s *Service) handleSessionCount(access *kardia.Context, _ tools.Arguments) (any, error) {
	count, err := s.SessionCount(access)
	if err != nil {
		return nil, err
	}
	return map[string]any{"count": count}, nil
}

func (s *Service) handleCredentialsStatus(access *kardia.Context, _ tools.Arguments) (any, error) {
	return s.CredentialsStatus(access)
}

func (s *Service) handleReturnOrigins(access *kardia.Context, _ tools.Arguments) (any, error) {
	origins, err := s.ReturnOrigins(access)
	if err != nil {
		return nil, err
	}
	if origins == nil {
		origins = []string{}
	}
	return origins, nil
}
